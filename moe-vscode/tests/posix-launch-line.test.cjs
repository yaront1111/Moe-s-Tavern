'use strict';

// V12: on POSIX the agent and Accounts terminals type into the user's own shell (no shellPath: windows-terminal-shell W1
// and W2), so the line must not need sh syntax. fish, tcsh and pwsh reject a leading `KEY=value` assignment, and pwsh
// reads a leading quoted word as a string, so both lines start with `env` and quote every other free-form word. X1 pins
// that shape on any host; X2 types the real lines into every shell this host has, against stub programs that print what
// they got. The launcher harness is copied from windows-terminal-shell.test.cjs: tests share no helper module.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

const src = file => path.join(__dirname, '..', 'src', file);
const transpile = file => ts.transpileModule(fs.readFileSync(src(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const onPlatform = platform => Object.create(process, { platform: { value: platform } });

function run(source, filename, vscode, deps, globals) {
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({
        exports: module.exports, module, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : deps[name] || require(name), ...globals
    }), { filename });
    return module.exports;
}

class Emitter {
    constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose() {} }; }; }
    fire(value) { this.listeners.slice().forEach(listener => listener(value)); }
}

function StubWebSocket() { throw new Error('these tests never open a real socket'); }
const clientVscode = {
    EventEmitter: Emitter,
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: () => Promise.resolve(undefined) },
    workspace: { getConfiguration: () => ({ get: () => false }) }
};
const loadClient = () => run(transpile('services/MoeDaemonClient.ts'), 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket }, {});

/** The launcher over a fake terminal API, on `platform` whatever the host is. */
function loadLauncher(workspace, platform) {
    const [terminals, errors] = [[], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); }, showWarningMessage() {} } };
    const launcher = run(transpile('util/AgentLauncher.ts'), 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { process: onPlatform(platform), Error });
    return { launcher, terminals, errors };
}

/** AccountsTreeProvider.accountsCommandLine, loaded under the provider's closed require map. */
function accountsCommandLine(...args) {
    const load = (file, requireFn) => {
        const module = { exports: {} };
        vm.runInThisContext(`(function (exports, module, require) {${transpile(file)}\n})`, { filename: src(file) })(module.exports, module, requireFn);
        return module.exports;
    };
    const presentation = load('util/AccountPresentation.ts', name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });
    const provider = load('providers/AccountsTreeProvider.ts', name => {
        if (name === 'vscode') return {};
        if (name === '../util/AccountPresentation') return presentation;
        throw new Error(`AccountsTreeProvider.ts must not require ${name}`);
    });
    return provider.accountsCommandLine(...args);
}

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-pll-'))));
    return made[made.length - 1];
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

// The stub wrapper prints the three variables the launcher can set, then one line per argument.
const STUB_WRAPPER = [
    'printf \'env %s\\n\' "${MOE_DAEMON_PATH-unset}" "${MOE_PROXY_PATH-unset}" "${MOE_RUNTIME_PROTECTED-unset}"',
    'for arg in "$@"; do printf \'arg %s\\n\' "$arg"; done',
    ''
].join('\n');

/** An extension dir whose bundled/ holds the stub wrapper (both names), a daemon and a proxy. */
function extension() {
    const dir = tempDir();
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1']) { write(path.join(dir, 'bundled', file), STUB_WRAPPER); }
    for (const file of ['daemon/index.js', 'proxy/index.js']) { write(path.join(dir, 'bundled', file), '// installed'); }
    return dir;
}

/** A project folder named `name`; `profile` declares an execution profile in .moe/project.json. */
function project(name, profile) {
    const dir = path.join(tempDir(), name);
    fs.mkdirSync(dir);
    if (profile) { write(path.join(dir, '.moe', 'project.json'), JSON.stringify({ settings: { executionProfile: profile } })); }
    return dir;
}

/** The one line the one terminal got. */
function sentLine(f) {
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.terminals.map(terminal => terminal.texts.length), [1]);
    return f.terminals[0].texts[0];
}

// A word as a POSIX shell splits these lines: a single-quoted word (with the '\'' escape) or a bare one.
const WORDS = /'(?:[^']|'\\'')*'|\S+/g;
const quoted = word => /^'.*'$/s.test(word);

test('X1 the POSIX agent and Accounts lines start with env, quote every free-form word, and assign nothing bare', async () => {
    const dir = project('app');
    const ext = extension();
    const f = loadLauncher(dir, 'linux');
    await f.launcher.launchAgent('worker', 'claude', ext, { teamName: 'my team' });
    const words = sentLine(f).match(WORDS);
    assert.deepEqual(words.filter(word => !quoted(word)), ['env', 'bash', '--role', 'worker', '--project', '--worker-id', '--command', '--team'],
        'agent line: env is the command word, and only the fixed words are bare');
    assert.deepEqual(words.slice(1, 3), [`'MOE_DAEMON_PATH=${path.join(ext, 'bundled', 'daemon', 'index.js')}'`,
        `'MOE_PROXY_PATH=${path.join(ext, 'bundled', 'proxy', 'index.js')}'`], 'agent line: each assignment is one quoted env argument');
    const accounts = accountsCommandLine({ node: '/opt/node/bin/node', script: '/opt/moe/cli.js' }, '/home/dev/.moe/claude-accounts.json', ['login', 'acct-2'], false);
    const accountWords = accounts.match(WORDS);
    assert.deepEqual([accountWords[0], accountWords.slice(1).every(quoted)], ['env', true], 'Accounts line: env, then quoted words only');
});

/** The first executable called `name` on PATH, or undefined. */
function onPath(name) {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const file = path.join(dir, name);
        try {
            fs.accessSync(file, fs.constants.X_OK);
            if (fs.statSync(file).isFile()) { return file; }
        } catch { /* not here */ }
    }
    return undefined;
}

// Each shell types the line the way a terminal would hand it a typed command. tcsh and csh skip their rc files (-f);
// pwsh reads no profile. Only the sh family, fish and csh get names with quote characters: shQuote's '\'' escape is
// not pwsh syntax, and pwsh releases before 7.3 also drop a double quote inside a native argument.
const SHELLS = [
    ['sh', ['-c']], ['bash', ['-c']], ['dash', ['-c']], ['zsh', ['-c']], ['ksh', ['-c']], ['mksh', ['-c']],
    ['fish', ['-c']], ['tcsh', ['-f', '-c']], ['csh', ['-f', '-c']], ['pwsh', ['-NoProfile', '-NonInteractive', '-Command']]
];
const NAMES = {
    quotes: { folder: 'it\'s "q" $HOME `x` ~ dir', team: 'team \'a\' "b" $USER' },
    plain: { folder: 'a $HOME `x` ~ dir', team: 'team a $USER' }
};

function typeInto(shell, flags, line, cwd, home) {
    const result = spawnSync(shell, [...flags, line], { cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${path.basename(shell)} exited ${result.status} (${result.error?.message ?? ''}): ${result.stderr}`);
    return result.stdout;
}

test('X2 every shell on this host runs the typed agent and Accounts lines with the exact environment and arguments', { skip: process.platform === 'win32' && 'POSIX host only' }, async t => {
    const home = tempDir();
    const ext = extension();
    const bundled = path.join(ext, 'bundled');
    const cli = write(path.join(tempDir(), 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    for (const [name, flags] of SHELLS) {
        const shell = onPath(name);
        await t.test(name, { skip: !shell && `${name} is not installed here` }, async () => {
            const names = NAMES[name === 'pwsh' ? 'plain' : 'quotes'];
            for (const profile of [undefined, 'verified-local']) {
                const dir = project(names.folder, profile);
                const f = loadLauncher(dir, process.platform);
                const readiness = async () => ({ answered: { profile: 'verified-local', ready: true, missingCapabilities: [], evaluatedAt: null } });
                await f.launcher.launchAgent('worker', 'claude', ext, { teamName: names.team, readiness });
                const got = typeInto(shell, flags, sentLine(f), dir, home).replace(/worker-[0-9a-f]{8}/, 'worker-ID');
                const expected = [path.join(bundled, 'daemon', 'index.js'), path.join(bundled, 'proxy', 'index.js'), profile ? '1' : 'unset']
                    .map(value => `env ${value}`)
                    .concat(['--role', 'worker', '--project', dir, '--worker-id', 'worker-ID', '--command', 'claude', '--team', names.team].map(arg => `arg ${arg}`));
                assert.deepEqual(got.split('\n').filter(Boolean), expected, `${name}: ${profile ?? 'legacy'} launch`);
            }
            const registry = path.join(project(names.folder), 'claude accounts.json');
            const line = accountsCommandLine({ node: process.execPath, script: cli }, registry, ['login', names.team], false);
            assert.deepEqual(JSON.parse(typeInto(shell, flags, line, home, home)), ['--accounts-file', registry, 'login', names.team], `${name}: Accounts line`);
        });
    }
});

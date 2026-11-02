'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// task-26a3dacde03c: AgentLauncher refuses every C0 control and DEL on the bash AND the PowerShell path, before any
// terminal opens. sendText types each character into the shell's line editor, where Ctrl-U or Ctrl-W erase the
// quoting typed before them. The PRODUCTION launcher runs transpiled in a vm with a stubbed vscode and an overridden
// process.platform, so both builders run on every host. The harness is copied from agent-seats.test.cjs: tests share
// no helper module.
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const transpile = file => ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const clientSource = transpile('services/MoeDaemonClient.ts');
const launcherSource = transpile('util/AgentLauncher.ts');

function run(source, filename, vscode, deps = {}, globals = {}) {
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
    dispose() { this.listeners = []; }
}

function StubWebSocket() { throw new Error('these tests never open a real socket'); }
StubWebSocket.OPEN = 1;

const clientVscode = {
    EventEmitter: Emitter,
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: () => Promise.resolve(undefined) },
    workspace: { getConfiguration: () => ({ get: () => false }) }
};

const loadClient = () => run(clientSource, 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket });

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ctl26-'))));
    return made[made.length - 1];
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** A project dir with no .moe/project.json: a legacy launch. */
const project = () => tempDir();

/** An extension dir whose bundled/ holds the installed wrapper, daemon and proxy; `name` is its own directory name. */
function extension(name = 'ext') {
    const dir = path.join(tempDir(), name);
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js']) {
        write(path.join(dir, 'bundled', file), '// installed');
    }
    return dir;
}

/** The command a terminal was sent, with the Windows -EncodedCommand body decoded. */
const decode = text => text.replace(/-EncodedCommand (\S+)$/,
    (_, b64) => `-EncodedCommand [${Buffer.from(b64, 'base64').toString('utf16le')}]`);

/** The launcher over a fake terminal API, on `platform` whatever the host is. */
function loadLauncher(dir, platform) {
    const [terminals, errors, warnings] = [[], [], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); }, showWarningMessage: message => { warnings.push(message); } } };
    // Error is this realm's, so `err instanceof Error` in the launcher recognises the Errors it throws.
    const launcher = run(launcherSource, 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { process: Object.create(process, { platform: { value: platform } }), Error });
    return { launcher, terminals, errors, warnings };
}

const CODES = [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x15, 0x17, 0x1b, 0x1f, 0x7f];
const hex = code => `0x${code.toString(16).padStart(2, '0')}`;
const refusal = label => [`Failed to launch architect agent: Invalid ${label}: contains control characters`];

/** Launches an architect and asserts one refusal naming `label`, no terminal and no onLaunched call. */
async function assertRefused(platform, label, dir, provider, extensionPath, options, what) {
    const f = loadLauncher(dir, platform);
    const launched = [];
    await f.launcher.launchAgent('architect', provider, extensionPath, { ...options, onLaunched: id => launched.push(id) });
    assert.deepEqual([f.terminals.length, launched.length, f.warnings], [0, 0, []], what);
    assert.deepEqual(f.errors, refusal(label), what);
}

async function refusesEveryCarrier(platform) {
    const ext = extension();
    const missing = path.join(os.tmpdir(), `moe-ctl26-missing-${process.pid}`);
    for (const code of CODES) {
        const c = String.fromCharCode(code);
        const rows = [['team name', project(), 'claude', { teamName: `a${c}b` }], ['command', project(), 'custom', { customCommand: `my-cli${c}x` }]];
        // Node's fs refuses a NUL path: the profile would read untrusted and the protected-runtime refusal would win.
        if (code !== 0) { rows.push(['workspace path', path.join(missing, `a${c}b`), 'claude', {}]); }
        for (const [label, dir, provider, options] of rows) {
            await assertRefused(platform, label, dir, provider, ext, options, `${platform} ${hex(code)} ${label}`);
        }
    }
}

test('B1 the bash path refuses every C0 control and DEL in the team name, the command and the workspace path', () =>
    refusesEveryCarrier('linux'));

test('P1 the PowerShell path refuses every C0 control and DEL in the team name, the command and the workspace path', () =>
    refusesEveryCarrier('win32'));

test('E1 an extension directory holding Ctrl-U or DEL is refused as the script path on both platforms', async t => {
    if (process.platform === 'win32') { t.skip('NTFS refuses control characters in a directory name'); return; }
    for (const code of [0x15, 0x7f]) {
        let ext;
        try {
            ext = extension(`ext${String.fromCharCode(code)}x`);
        } catch (err) {
            t.skip(`this filesystem refuses a ${hex(code)} directory name: ${err.code}`);
            return;
        }
        for (const platform of ['linux', 'win32']) {
            await assertRefused(platform, 'script path', project(), 'claude', ext, {}, `${platform} ${hex(code)}`);
        }
    }
});

test('OK1 space, tilde and a non-ASCII letter still launch on both platforms, with the team typed verbatim', async () => {
    const ext = extension();
    const team = 'a ~é';
    for (const [platform, flag] of [['linux', `--team '${team}'`], ['win32', `-Team '${team}'`]]) {
        const f = loadLauncher(project(), platform);
        const launched = [];
        await f.launcher.launchAgent('architect', 'claude', ext, { teamName: team, onLaunched: id => launched.push(id) });
        assert.deepEqual([f.terminals.length, launched.length, f.errors, f.warnings], [1, 1, [], []], platform);
        const sent = decode(f.terminals[0].texts[0]);
        assert.ok(sent.includes(flag), sent);
    }
});

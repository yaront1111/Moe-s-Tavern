'use strict';

// VSC-27: on win32 both terminals the extension creates carry a PowerShell line (the agent launch line and the Accounts
// CLI line), so they must start powershell.exe themselves instead of typing into the user's default profile (Command
// Prompt, Git Bash, WSL). Every other platform, Remote-WSL included (process.platform is linux there), creates its
// terminals exactly as before: no shellPath key at all. The launcher harness is copied from powershell-quoting.test.cjs
// and the provider harness from accounts-actions.test.cjs: tests share no helper module. The corpus and the bundle are
// read here, never edited. W4-W10 (task-a6227f4e): under the protected profile the Accounts terminal starts and types
// only validated absolute interpreters (AgentLauncher.protectedAccountsTerminal), and a refusal opens nothing. The selection
// also carries the project it checked, and the protected line passes it as --protected-project right after the registry (task-55710898).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const src = file => path.join(root, 'src', file);
const SHELL = 'powershell.exe';
const read = file => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
    }
};
const transpile = file => ts.transpileModule(read(src(file)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const onPlatform = platform => Object.create(process, { platform: { value: platform } });

const bundle = new Map([...read(path.join(root, '../moe-jetbrains/src/main/resources/messages/MoeBundle.properties'))
    .matchAll(/^(moe\.[A-Za-z.]+)=(.*?)\r?$/gm)].map(m => [m[1], m[2].replace(/\\n/g, '\n')]));
const t = (key, ...args) => {
    assert.ok(bundle.has(key), `${key} is missing from MoeBundle.properties`);
    return bundle.get(key).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));
};
const corpus = JSON.parse(read(path.join(root, '../moe-jetbrains/src/test/resources/client-accounts.json')));
const rowOf = id => {
    const found = corpus.rows.find(r => r.id === id);
    assert.ok(found, `corpus row ${id} is missing`);
    return found;
};

// An options object built inside a vm context has that context's Object.prototype, so compare plain copies.
const plain = options => JSON.parse(JSON.stringify(options));
const hasShell = options => Object.hasOwn(options, 'shellPath');

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
    dispose() { this.listeners = []; }
}

function StubWebSocket() { throw new Error('these tests never open a real socket'); }
StubWebSocket.OPEN = 1;

const clientVscode = {
    EventEmitter: Emitter,
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: () => Promise.resolve(undefined) },
    workspace: { getConfiguration: () => ({ get: () => false }) }
};
const loadClient = () => run(transpile('services/MoeDaemonClient.ts'), 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket }, {});

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-wts-'))));
    return made[made.length - 1];
}

/** An extension dir whose bundled/ holds the installed wrapper, daemon and proxy. */
function extension() {
    const dir = path.join(tempDir(), 'ext');
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js']) {
        fs.mkdirSync(path.dirname(path.join(dir, 'bundled', file)), { recursive: true });
        fs.writeFileSync(path.join(dir, 'bundled', file), '// installed');
    }
    return dir;
}

/**
 * The launcher over a fake terminal API, on `platform` whatever the host is. `refuse` makes createTerminal throw; `client`
 * overrides MoeDaemonClient exports (protected-runtime.test.cjs's clientOverrides). A fresh client each call: no session pin leaks.
 */
function loadLauncher(platform, { refuse = false, client = {} } = {}) {
    const workspace = tempDir();
    const [terminals, errors] = [[], []];
    const createTerminal = options => {
        if (refuse) throw new Error('no terminal here');
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); }, showWarningMessage() {} } };
    // Error is this realm's, so `err instanceof Error` in the launcher recognises the Errors it throws.
    const launcher = run(transpile('util/AgentLauncher.ts'), 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': { ...loadClient(), ...client } },
        { process: onPlatform(platform), Error });
    return { launcher, terminals, errors, workspace };
}

/** Declares the verified-local execution profile in `workspace`, so runtimeProfile answers 'protected'. */
function protect(workspace) {
    fs.mkdirSync(path.join(workspace, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.moe', 'project.json'), JSON.stringify({ settings: { executionProfile: 'verified-local' } }));
}

/** A module with a closed require map, as accounts-actions.test.cjs loads the provider; `proc` shadows the global process. */
function load(file, requireFn, proc = process) {
    const module = { exports: {} };
    vm.runInThisContext(`(function (exports, module, require, process) {${transpile(file)}\n})`, { filename: src(file) })(module.exports, module, requireFn, proc);
    return module.exports;
}

/**
 * The Accounts provider on `platform`, over a rotation and a connection state, with recording terminal, clipboard and error
 * fakes. `select`, when given, is the constructor's third argument (the protected terminal selector).
 */
function loadProvider(platform, rotation, { connected, refuse = false, select }) {
    const rec = { terminals: [], clipboard: [], warnings: [], errors: [], commands: new Map() };
    const vscode = {
        EventEmitter: Emitter,
        TreeItem: class { constructor(label) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0 },
        window: {
            showInputBox: async () => undefined,
            showWarningMessage: async (...args) => { rec.warnings.push(args); return undefined; },
            showErrorMessage: async message => { rec.errors.push(message); return undefined; },
            createTerminal: options => {
                if (refuse) throw new Error('no terminal here');
                const terminal = { options, sent: [], shown: 0, sendText(line) { this.sent.push(line); }, show() { this.shown += 1; } };
                rec.terminals.push(terminal);
                return terminal;
            }
        },
        commands: { registerCommand: (id, callback) => { rec.commands.set(id, callback); return { dispose() {} }; }, executeCommand: async () => undefined },
        env: { clipboard: { writeText: async line => { rec.clipboard.push(line); } } }
    };
    const presentation = load('util/AccountPresentation.ts', name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });
    const mod = load('providers/AccountsTreeProvider.ts', name => {
        if (name === 'vscode') return vscode;
        if (name === '../util/AccountPresentation') return presentation;
        throw new Error(`AccountsTreeProvider.ts must not require ${name}`);
    }, onPlatform(platform));
    const events = ['accounts', 'connection', 'state', 'added'].map(() => new Emitter());
    const client = {
        connectionState: connected ? 'connected' : 'disconnected', isStateReady: true, accountRotation: rotation,
        onAccountsChanged: events[0].event, onConnectionChanged: events[1].event, onStateChanged: events[2].event, onAccountAdded: events[3].event
    };
    const clock = { now: () => Date.parse(corpus.now), zone: () => corpus.zone };
    const provider = select === undefined ? new mod.AccountsTreeProvider(client, clock) : new mod.AccountsTreeProvider(client, clock, select);
    provider.registerCommands();
    const signIn = id => rec.commands.get('moe.accounts.signIn')(provider.getChildren().find(n => n.id === id));
    return { mod, rec, signIn, line: (windows, args) => mod.accountsCommandLine(rotation.cli, rotation.registryFile, args, windows) };
}

const roles = { architect: 'Moe Planner', worker: 'Moe Coder' };

test('W1 launchAgent starts powershell.exe on win32 and no explicit shell anywhere else, Remote-WSL (linux) included', async () => {
    for (const [role, name] of Object.entries(roles)) {
        const win = loadLauncher('win32');
        await win.launcher.launchAgent(role, 'claude', extension());
        assert.deepEqual([win.terminals.length, win.errors], [1, []], `win32 ${role}: one terminal, no error`);
        const [terminal] = win.terminals;
        assert.deepEqual(plain(terminal.options), { name, cwd: win.workspace, shellPath: SHELL }, `win32 ${role}: createTerminal options`);
        assert.deepEqual(Object.keys(terminal.options).sort(), ['cwd', 'name', 'shellPath'], `win32 ${role}: no shellArgs or other key`);
        assert.equal(terminal.texts.length, 1);
        assert.match(terminal.texts[0], /^\$env:MOE_DAEMON_PATH=.* -EncodedCommand [A-Za-z0-9+/]+=*$/, `win32 ${role}: the PowerShell line keeps its -EncodedCommand framing`);

        for (const platform of ['linux', 'darwin']) {
            const other = loadLauncher(platform);
            await other.launcher.launchAgent(role, 'claude', extension());
            assert.deepEqual([other.terminals.length, other.errors], [1, []], `${platform} ${role}: one terminal, no error`);
            const [created] = other.terminals;
            assert.equal(hasShell(created.options), false, `${platform} ${role}: createTerminal options must have no shellPath key`);
            assert.deepEqual(plain(created.options), { name, cwd: other.workspace }, `${platform} ${role}: createTerminal options`);
            assert.ok(created.texts[0].includes('moe-agent.sh') && !created.texts[0].includes('-EncodedCommand'), `${platform} ${role}: the bash line`);
        }
    }
});

test('W2 Accounts sign-in starts powershell.exe on win32, connected (C05) and disconnected (C09), and no explicit shell elsewhere', async () => {
    for (const [id, connected] of [['C05', true], ['C09', false]]) {
        const row = rowOf(id);
        const args = ['login', row.selectedId];
        for (const platform of ['win32', 'linux', 'darwin']) {
            const windows = platform === 'win32';
            const where = `${id} ${connected ? 'connected' : 'disconnected'} on ${platform}`;
            const s = loadProvider(platform, row.rotation, { connected });
            await s.signIn(row.selectedId);
            assert.equal(s.rec.terminals.length, 1, `${where}: one terminal`);
            const [terminal] = s.rec.terminals;
            assert.deepEqual(plain(terminal.options), windows ? { name: t('moe.accounts.terminal.tab'), shellPath: SHELL } : { name: t('moe.accounts.terminal.tab') }, `${where}: createTerminal options`);
            assert.equal(hasShell(terminal.options), windows, `${where}: shellPath key presence`);
            assert.deepEqual([terminal.sent, terminal.shown], [[s.line(windows, args)], 1], `${where}: sent line`);
            assert.equal(terminal.sent[0].startsWith('powershell '), windows, `${where}: PowerShell line only on win32`);
        }
    }
});

test('W3 when no terminal can be created the line still goes to the clipboard, on win32 and elsewhere', async () => {
    const row = rowOf('C05');
    for (const platform of ['win32', 'linux']) {
        const s = loadProvider(platform, row.rotation, { connected: true, refuse: true });
        await s.signIn(row.selectedId);
        const line = s.line(platform === 'win32', ['login', row.selectedId]);
        assert.deepEqual([s.rec.terminals.length, s.rec.clipboard, s.rec.warnings], [0, [line], [[t('moe.accounts.terminal.unavailable', line)]]], `${platform}: clipboard fallback`);
        const l = loadLauncher(platform, { refuse: true });
        await l.launcher.launchAgent('architect', 'claude', extension());
        assert.deepEqual(l.errors, ['Failed to launch architect agent: no terminal here'], `${platform}: the launcher reports the refused terminal`);
    }
});

const PS_LABEL = 'Accounts terminal interpreter %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const NODE_LABEL = 'Accounts node executable';

test('W4 protectedAccountsTerminal: legacy answers null, a protected bare node is refused, and win32 checks the interpreter first', () => {
    for (const windows of [true, false]) {
        const legacy = loadLauncher(windows ? 'win32' : 'linux');
        assert.equal(legacy.launcher.protectedAccountsTerminal('node', windows, {}), null, `legacy windows=${windows}: the legacy route`);
    }
    const posix = loadLauncher('linux');
    protect(posix.workspace);
    assert.deepEqual(plain(posix.launcher.protectedAccountsTerminal('node', false, {})), { refused: `${NODE_LABEL} is not an absolute path` });
    const win = loadLauncher('win32');
    protect(win.workspace);
    assert.deepEqual(plain(win.launcher.protectedAccountsTerminal('node', true, {})), { refused: `${PS_LABEL} not found` });
});

test('W5 protectedAccountsTerminal checks the win32 interpreter, then the node, and returns only the accepted paths', () => {
    const psPath = path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const node = '/opt/node/bin/node';
    const env = { SystemRoot: 'C:\\Windows' };
    /** A launcher whose installedExecutable records (path, basePath, label) and answers `answer(path)`; accepted values differ from inputs. */
    const stubbed = (platform, answer = p => ({ accepted: `${p}.real` })) => {
        const calls = [];
        const l = loadLauncher(platform, { client: { installedExecutable: (p, basePath, _foldCase, label) => { calls.push([p, basePath, label]); return answer(p); } } });
        return { ...l, calls, select: windows => plain(l.launcher.protectedAccountsTerminal(node, windows, env)) };
    };
    for (const windows of [true, false]) {
        const legacy = stubbed(windows ? 'win32' : 'linux');
        assert.deepEqual([legacy.launcher.protectedAccountsTerminal(node, windows, env), legacy.calls], [null, []], `legacy windows=${windows}: no check`);
    }
    const win = stubbed('win32');
    protect(win.workspace);
    assert.deepEqual(win.select(true), { node: `${node}.real`, shellPath: `${psPath}.real`, project: win.workspace }, 'win32: the accepted values');
    assert.deepEqual(win.calls, [[psPath, win.workspace, PS_LABEL], [node, win.workspace, NODE_LABEL]], 'win32: interpreter first, then node');
    const posix = stubbed('linux');
    protect(posix.workspace);
    const accepted = posix.select(false);
    assert.deepEqual([accepted, Object.hasOwn(accepted, 'shellPath')], [{ node: `${node}.real`, project: posix.workspace }, false], 'POSIX: the node only, no shellPath key');
    assert.deepEqual(posix.calls, [[node, posix.workspace, NODE_LABEL]], 'POSIX: only the node is checked');
    const badShell = stubbed('win32', p => (p === psPath ? { rejected: 'interpreter refused' } : { accepted: `${p}.real` }));
    protect(badShell.workspace);
    assert.deepEqual([badShell.select(true), badShell.calls.length], [{ refused: 'interpreter refused' }, 1], 'a rejected interpreter never checks the node');
    for (const windows of [true, false]) {
        const badNode = stubbed(windows ? 'win32' : 'linux', p => (p === node ? { rejected: 'node refused' } : { accepted: `${p}.real` }));
        protect(badNode.workspace);
        assert.deepEqual(badNode.select(windows), { refused: 'node refused' }, `windows=${windows}: a rejected node`);
    }
});

test('W6 on POSIX the protected Accounts node is the real path of an absolute regular file outside the project', { skip: process.platform === 'win32' && 'POSIX host only' }, () => {
    const l = loadLauncher('linux');
    protect(l.workspace);
    const select = node => plain(l.launcher.protectedAccountsTerminal(node, false, {}));
    const real = fs.realpathSync.native(process.execPath);
    const outside = tempDir();
    fs.symlinkSync(process.execPath, path.join(outside, 'node-link'));
    assert.deepEqual(select(real), { node: real, project: l.workspace }, 'the real node');
    assert.deepEqual(select(path.join(outside, 'node-link')), { node: real, project: l.workspace }, 'an outside link answers its real path');
    const planted = path.join(l.workspace, 'node');
    fs.writeFileSync(planted, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(planted, path.join(outside, 'planted-link'));
    const inside = { refused: `${NODE_LABEL} resolves inside the project` };
    assert.deepEqual([select(planted), select(path.join(outside, 'planted-link'))], [inside, inside], 'a project node, directly or through an outside link');
    assert.deepEqual(select('/nonexistent/node'), { refused: `${NODE_LABEL} not found` });
    assert.deepEqual(select(outside), { refused: `${NODE_LABEL} is not a regular file` });
});

test('W7 on Windows the protected Accounts terminal pins the SystemRoot PowerShell and an outside node', { skip: process.platform !== 'win32' && 'Windows host only' }, () => {
    const l = loadLauncher('win32');
    protect(l.workspace);
    const select = (node, env) => plain(l.launcher.protectedAccountsTerminal(node, true, env));
    const systemRoot = { SystemRoot: process.env.SystemRoot };
    const powershell = fs.realpathSync.native(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(select(process.execPath, systemRoot), { node: fs.realpathSync.native(process.execPath), shellPath: powershell, project: l.workspace });
    assert.deepEqual(select(process.execPath, {}), { refused: `${PS_LABEL} not found` });
    const fake = path.join(l.workspace, 'System32', 'WindowsPowerShell', 'v1.0');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'powershell.exe'), '');
    assert.deepEqual(select(process.execPath, { SystemRoot: l.workspace }), { refused: `${PS_LABEL} resolves inside the project` });
    fs.writeFileSync(path.join(l.workspace, 'node.exe'), '');
    assert.deepEqual(select(path.join(l.workspace, 'node.exe'), systemRoot), { refused: `${NODE_LABEL} resolves inside the project` });
    assert.deepEqual(select('node', systemRoot), { refused: `${NODE_LABEL} is not an absolute path` });
});

const W_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const W_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const PROJECT = '/home/dev/app';
const ACCOUNT_WORDS = "'/opt/moe/daemon/dist/accounts/cli.js' '--accounts-file' '/home/dev/.moe/claude-accounts.json' '--protected-project' '/home/dev/app' 'login' 'acct-2'";
const W_DECODED = `& '${W_NODE}' ${ACCOUNT_WORDS}`;
const W_LINE = `& '${W_POWERSHELL}' -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(W_DECODED, 'utf16le').toString('base64')}`;
const P_LINE = `env '/opt/node/bin/node' ${ACCOUNT_WORDS}`;
/** A selector answering `answer` and recording its (node, windows) calls. */
const recording = answer => { const calls = []; const select = (node, windows) => { calls.push([node, windows]); return answer; }; return { calls, select }; };

test('W8 a protected C05 sign-in types and starts only the selected interpreters, and the clipboard gets the same line', async () => {
    const row = rowOf('C05');
    for (const platform of ['win32', 'linux', 'darwin']) {
        const windows = platform === 'win32';
        const answer = windows ? { node: W_NODE, shellPath: W_POWERSHELL, project: PROJECT } : { node: '/opt/node/bin/node', project: PROJECT };
        const line = windows ? W_LINE : P_LINE;
        const r = recording(answer);
        const s = loadProvider(platform, row.rotation, { connected: true, select: r.select });
        await s.signIn(row.selectedId);
        assert.deepEqual(r.calls, [[row.rotation.cli.node, windows]], `${platform}: one selection, of the daemon's node`);
        assert.equal(s.rec.terminals.length, 1, `${platform}: one terminal`);
        const [terminal] = s.rec.terminals;
        assert.deepEqual(plain(terminal.options), windows ? { name: t('moe.accounts.terminal.tab'), shellPath: W_POWERSHELL } : { name: t('moe.accounts.terminal.tab') }, `${platform}: options`);
        assert.equal(hasShell(terminal.options), windows, `${platform}: shellPath key presence`);
        assert.deepEqual([terminal.sent, s.rec.errors], [[line], []], `${platform}: the protected line`);
        if (windows) {
            const b64 = terminal.sent[0].split(' ').pop();
            assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), W_DECODED, 'win32: the encoded script runs the selected node');
        }
        const offline = loadProvider(platform, row.rotation, { connected: true, refuse: true, select: recording(answer).select });
        await offline.signIn(row.selectedId);
        assert.deepEqual([offline.rec.terminals.length, offline.rec.clipboard], [0, [line]], `${platform}: the clipboard gets the protected line`);
    }
});

test('W9 a selector answering null keeps the legacy Accounts line and terminal options byte-identical', async () => {
    const row = rowOf('C05');
    for (const platform of ['win32', 'linux']) {
        const r = recording(null);
        const pinned = loadProvider(platform, row.rotation, { connected: true, select: r.select });
        const legacy = loadProvider(platform, row.rotation, { connected: true });
        await pinned.signIn(row.selectedId);
        await legacy.signIn(row.selectedId);
        assert.equal(r.calls.length, 1, `${platform}: the selector ran`);
        const [a, b] = [pinned.rec.terminals[0], legacy.rec.terminals[0]];
        assert.equal(JSON.stringify(a.options), JSON.stringify(b.options), `${platform}: options, keys and order`);
        assert.deepEqual(a.sent, b.sent, `${platform}: the sent line`);
    }
});

test('W10 a protected refusal shows exactly one error and opens no terminal, and so does an unsafe interpreter', async () => {
    const row = rowOf('C05');
    const refused = 'Account action failed: Protected execution profile: Accounts node executable resolves inside the project. ' +
        'Moe runs account commands only with an interpreter outside the project, so nothing was started.';
    for (const platform of ['win32', 'linux']) {
        for (const refuse of [false, true]) {
            const where = `${platform}${refuse ? ' without a terminal API' : ''}`;
            const s = loadProvider(platform, row.rotation, { connected: true, refuse, select: recording({ refused: `${NODE_LABEL} resolves inside the project` }).select });
            await s.signIn(row.selectedId);
            assert.deepEqual([s.rec.terminals.length, s.rec.clipboard, s.rec.warnings, s.rec.errors], [0, [], [], [refused]], where);
        }
    }
    for (const refuse of [false, true]) {
        const s = loadProvider('win32', row.rotation, { connected: true, refuse, select: recording({ node: W_NODE, shellPath: `${W_POWERSHELL}\n`, project: PROJECT }).select });
        await s.signIn(row.selectedId);
        assert.deepEqual([s.rec.terminals.length, s.rec.clipboard, s.rec.warnings, s.rec.errors],
            [0, [], [], ['Account action failed: Invalid interpreter: contains control characters']], `win32 newline interpreter, refuse=${refuse}`);
    }
    for (const platform of ['win32', 'linux']) {
        const s = loadProvider(platform, row.rotation, { connected: true, refuse: true, select: recording({ node: W_NODE, project: `${PROJECT}\n` }).select });
        await s.signIn(row.selectedId);
        assert.deepEqual([s.rec.terminals.length, s.rec.clipboard, s.rec.warnings, s.rec.errors],
            [0, [], [], ['Account action failed: Invalid accounts command word: contains control characters']], `${platform} newline project`);
    }
});

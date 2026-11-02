'use strict';

// VSC-27: on win32 both terminals the extension creates carry a PowerShell line (the agent launch line and the Accounts
// CLI line), so they must start powershell.exe themselves instead of typing into the user's default profile (Command
// Prompt, Git Bash, WSL). Every other platform, Remote-WSL included (process.platform is linux there), creates its
// terminals exactly as before: no shellPath key at all. The launcher harness is copied from powershell-quoting.test.cjs
// and the provider harness from accounts-actions.test.cjs: tests share no helper module. The corpus and the bundle are
// read here, never edited.
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

/** The launcher over a fake terminal API, on `platform` whatever the host is. `refuse` makes createTerminal throw. */
function loadLauncher(platform, { refuse = false } = {}) {
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
    const launcher = run(transpile('util/AgentLauncher.ts'), 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { process: onPlatform(platform), Error });
    return { launcher, terminals, errors, workspace };
}

/** A module with a closed require map, as accounts-actions.test.cjs loads the provider; `proc` shadows the global process. */
function load(file, requireFn, proc = process) {
    const module = { exports: {} };
    vm.runInThisContext(`(function (exports, module, require, process) {${transpile(file)}\n})`, { filename: src(file) })(module.exports, module, requireFn, proc);
    return module.exports;
}

/** The Accounts provider on `platform`, over a rotation and a connection state, with recording terminal and clipboard fakes. */
function loadProvider(platform, rotation, { connected, refuse = false }) {
    const rec = { terminals: [], clipboard: [], warnings: [], commands: new Map() };
    const vscode = {
        EventEmitter: Emitter,
        TreeItem: class { constructor(label) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0 },
        window: {
            showInputBox: async () => undefined,
            showWarningMessage: async (...args) => { rec.warnings.push(args); return undefined; },
            showErrorMessage: async () => undefined,
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
    const provider = new mod.AccountsTreeProvider(client, { now: () => Date.parse(corpus.now), zone: () => corpus.zone });
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

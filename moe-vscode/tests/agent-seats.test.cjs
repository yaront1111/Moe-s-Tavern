'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// VSC-21: deregister agent seats whose terminal closed, matching JetBrains. The PRODUCTION client and launcher run
// transpiled in a vm with a stubbed vscode (vm-realm values are compared through JSON or primitives); extension.ts
// is read as text because it needs the whole editor API (DoD 3 asks for it). The harness is copied from
// verified-local-launch.test.cjs: tests share no helper module.
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const transpile = file => ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const clientSource = transpile('services/MoeDaemonClient.ts');
const launcherSource = transpile('util/AgentLauncher.ts');
const WS_OPEN = 1;
const plain = value => JSON.parse(JSON.stringify(value));

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
StubWebSocket.OPEN = WS_OPEN;

const clientVscode = {
    EventEmitter: Emitter,
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: () => Promise.resolve(undefined) },
    // autoConnect=false: a disconnect never arms a real reconnect timer.
    workspace: { getConfiguration: () => ({ get: () => false }) }
};

const loadClient = () => run(clientSource, 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket });

function clientHarness() {
    const exports = loadClient();
    const client = new exports.MoeDaemonClient('extension');
    const [errors, sent, acked] = [[], [], []];
    client.onError(error => errors.push(error));
    client.onWorkerDeregistered(workerId => acked.push(workerId));
    const socket = { readyState: WS_OPEN, send: frame => sent.push(JSON.parse(frame)), close() {} };
    const connect = () => { client['ws'] = socket; client['_connectionState'] = 'connected'; };
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    return { exports, client, errors, sent, acked, socket, connect, deliver };
}

// ---- Part 1 (DoD 1): the client ----

test('D1 connected: deregisterWorker sends exactly one DEREGISTER_WORKER frame and returns true', () => {
    const h = clientHarness();
    h.connect();
    assert.equal(h.client.deregisterWorker('worker-1', 'terminal_closed'), true);
    assert.deepEqual(h.sent, [{ type: 'DEREGISTER_WORKER', payload: { workerId: 'worker-1', reason: 'terminal_closed' } }]);
    assert.deepEqual(h.errors, []);
    h.client.dispose();
});

test('D2 not connected: it returns false, sends nothing and fires no onError', () => {
    const h = clientHarness();
    assert.equal(h.client.deregisterWorker('worker-1', 'terminal_closed'), false);
    h.connect();
    h.client['_connectionState'] = 'disconnected';
    assert.equal(h.client.deregisterWorker('worker-1', 'terminal_closed'), false);
    h.client['_connectionState'] = 'connected';
    h.socket.readyState = WS_OPEN + 1;
    assert.equal(h.client.deregisterWorker('worker-1', 'terminal_closed'), false, 'a socket that is not OPEN is not connected');
    assert.deepEqual([h.sent, h.errors], [[], []]);
    h.client.dispose();
});

test('D3 a WORKER_DEREGISTERED frame fires onWorkerDeregistered once with the worker id', () => {
    const h = clientHarness();
    h.deliver({ type: 'WORKER_DEREGISTERED', payload: { workerId: 'worker-1', alreadyDead: false, releasedTaskIds: ['task-1'] } });
    assert.deepEqual(h.acked, ['worker-1']);
    assert.deepEqual(h.errors, []);
    h.client.dispose();
});

test('D4 a malformed WORKER_DEREGISTERED fires nothing and never throws', () => {
    const h = clientHarness();
    for (const payload of [undefined, null, 'worker-1', 7, [], {}, { workerId: 7 }, { workerId: '' }, { workerId: null }, { workerId: ['worker-1'] }]) {
        assert.doesNotThrow(() => h.deliver({ type: 'WORKER_DEREGISTERED', payload }), JSON.stringify(payload));
    }
    assert.doesNotThrow(() => h.client['handleMessage']('not json'));
    assert.deepEqual([h.acked, h.errors], [[], []]);
    h.deliver({ type: 'WORKER_DEREGISTERED', payload: { workerId: 'worker-2' } });
    assert.deepEqual(h.acked, ['worker-2'], 'a good frame still fires after the bad ones');
    h.client.dispose();
});

test('D5 the reply leaves cached state alone, and dispose() disposes the new emitter', () => {
    const h = clientHarness();
    const workers = [{ id: 'worker-1' }];
    h.deliver({ type: 'STATE_SNAPSHOT', payload: { workers, tasks: [], epics: [] } });
    const state = [];
    h.client.onStateChanged(value => state.push(value));
    h.deliver({ type: 'WORKER_DEREGISTERED', payload: { workerId: 'worker-1' } });
    assert.deepEqual([state.length, plain(h.client.currentState.workers)], [0, workers]);
    h.client.dispose();
    h.deliver({ type: 'WORKER_DEREGISTERED', payload: { workerId: 'worker-1' } });
    assert.deepEqual(h.acked, ['worker-1'], 'only the frame before dispose() reached the listener');
});

// ---- Part 2 (DoD 2): the launcher, over a fake terminal API ----

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-vsc21-'))));
    return made[made.length - 1];
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** A project dir; `projectJson` undefined writes no .moe/project.json. */
function project(projectJson) {
    const dir = tempDir();
    if (projectJson !== undefined) { write(path.join(dir, '.moe', 'project.json'), projectJson); }
    return dir;
}
const declare = value => JSON.stringify({ settings: { executionProfile: value } });

/** An extension dir whose bundled/ holds the installed wrapper, daemon and proxy. */
function extension() {
    const dir = tempDir();
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js']) {
        write(path.join(dir, 'bundled', file), '// installed');
    }
    return dir;
}

/** The command a terminal was sent, with the Windows -EncodedCommand body decoded. */
const decode = text => text.replace(/-EncodedCommand (\S+)$/,
    (_, b64) => `-EncodedCommand [${Buffer.from(b64, 'base64').toString('utf16le')}]`);

/** The launcher over a fake terminal API; setTimeout only records, so a test fires the staggers itself. */
function loadLauncher(dir) {
    const [terminals, errors, warnings, timers] = [[], [], [], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], shown: 0, sendText: text => terminal.texts.push(text), show() { terminal.shown++; } };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); }, showWarningMessage: message => { warnings.push(message); } } };
    // Error is this realm's, so `err instanceof Error` in the launcher recognises the Errors a test throws.
    const launcher = run(launcherSource, 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { setTimeout: (fire, ms) => timers.push([ms, fire]), Error });
    return { launcher, terminals, errors, warnings, timers };
}

/** An onLaunched recorder: each call keeps its ids, its terminal and how much text that terminal had been sent. */
function recorder(throwing) {
    const calls = [];
    const onLaunched = (workerId, terminal) => {
        calls.push({ workerId, terminal, textsAtCall: terminal.texts.length });
        if (throwing !== undefined) { throw throwing; }
    };
    return { calls, onLaunched };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const NAMES = { architect: 'Moe Planner', worker: 'Moe Coder', qa: 'Moe QA', governor: 'Moe Governor' };
const ROLES = Object.keys(NAMES);

test('L1 launchAgent calls onLaunched once, with the generated worker id and the created terminal, before the command', () => {
    const [f, r, ext] = [loadLauncher(project()), recorder(), extension()];
    f.launcher.launchAgent('worker', 'claude', ext, { onLaunched: r.onLaunched });
    assert.equal(f.terminals.length, 1);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].terminal, f.terminals[0], 'the very object createTerminal returned');
    assert.match(r.calls[0].workerId, /^worker-[0-9a-f]{8}$/);
    assert.equal(r.calls[0].textsAtCall, 0, 'the terminal had no text sent yet');
    assert.equal(f.terminals[0].texts.length, 1);
    assert.ok(decode(f.terminals[0].texts[0]).includes(r.calls[0].workerId), 'the id is the one in the sent command');
    assert.deepEqual([f.errors, f.warnings], [[], []]);
});

test('L1c a team seat on a custom CLI is reported too, with its team in the sent command', () => {
    const [f, r] = [loadLauncher(project()), recorder()];
    f.launcher.launchAgent('governor', 'custom', extension(), { customCommand: 'my-cli', teamName: 'team-a', onLaunched: r.onLaunched });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].terminal, f.terminals[0]);
    const sent = decode(f.terminals[0].texts[0]);
    assert.ok(sent.includes('team-a') && sent.includes(r.calls[0].workerId), sent);
});

test('L1b a launch without onLaunched is unchanged: one terminal, one command, no warning', () => {
    const f = loadLauncher(project());
    f.launcher.launchAgent('qa', 'claude', extension());
    assert.deepEqual([f.terminals.map(t => [t.options.name, t.texts.length, t.shown]), f.errors, f.warnings], [[[NAMES.qa, 1, 1]], [], []]);
});

test('L2 launchAllAgents calls onLaunched once per launched role, in order, after the staggers fire', async () => {
    const [f, r, ext] = [loadLauncher(project()), recorder(), extension()];
    f.launcher.launchAllAgents('claude', ext, { onLaunched: r.onLaunched });
    assert.deepEqual(f.timers.map(([ms]) => ms), [1500, 3000, 4500]);
    assert.equal(r.calls.length, 1, 'only the architect starts before the staggers');
    for (const [, fire] of f.timers) { fire(); await flush(); }
    assert.deepEqual(r.calls.map(c => c.workerId.replace(/-[0-9a-f]{8}$/, '')), ROLES);
    assert.equal(r.calls.length, 4);
    r.calls.forEach((call, i) => {
        assert.equal(call.terminal, f.terminals[i], `${ROLES[i]} reports its own terminal`);
        assert.equal(call.textsAtCall, 0, `${ROLES[i]} is reported before its command`);
        assert.ok(decode(f.terminals[i].texts[0]).includes(call.workerId), `${ROLES[i]} id is in its command`);
    });
    assert.equal(new Set(r.calls.map(c => c.workerId)).size, 4, 'four distinct seats');
});

test('L3 a refused verified-local seat creates no terminal and never calls onLaunched', async () => {
    const notReady = { answered: { profile: 'verified-local', ready: false, missingCapabilities: ['host.multipass'], evaluatedAt: null } };
    const [f, r] = [loadLauncher(project(declare('verified-local'))), recorder()];
    await f.launcher.launchAgent('worker', 'claude', extension(), { readiness: async () => notReady, onLaunched: r.onLaunched });
    assert.deepEqual([f.terminals.length, r.calls.length, f.errors.length, f.warnings], [0, 0, 1, []]);
    await f.launcher.launchAgent('qa', 'gemini', extension(), { readiness: async () => notReady, onLaunched: r.onLaunched });
    assert.deepEqual([f.terminals.length, r.calls.length, f.errors.length], [0, 0, 2], 'a refused CLI is not tracked either');
});

for (const [name, thrown, shown] of [['an Error', new Error('storage is full'), 'storage is full'], ['a string', 'plain failure', 'plain failure']]) {
    test(`L4 when onLaunched throws ${name}, the command is still sent once and the user gets one warning`, () => {
        const [f, r] = [loadLauncher(project()), recorder(thrown)];
        f.launcher.launchAgent('worker', 'claude', extension(), { onLaunched: r.onLaunched });
        assert.equal(r.calls.length, 1);
        assert.deepEqual([f.terminals.length, f.terminals[0].texts.length, f.terminals[0].shown], [1, 1, 1]);
        assert.deepEqual(f.warnings, [`Moe started the worker agent, but could not track its terminal: ${shown}`]);
        assert.deepEqual(f.errors, [], 'a tracking failure is not a launch failure');
    });
}

// ---- Part 3 (DoD 3): extension.ts wiring, read from the source ----

const extensionText = read('extension.ts');
const norm = text => text.replace(/\s+/g, ' ');
const flat = norm(extensionText);
const indexOfText = needle => {
    const at = extensionText.indexOf(needle);
    assert.notEqual(at, -1, `extension.ts contains ${needle}`);
    return at;
};

test('X1 the tracker and pids are built over their workspaceState keys, and deregister with terminal_closed', () => {
    assert.ok(flat.includes("import { AgentSeatTracker, wireAgentSeats } from './util/AgentSeatTracker';"));
    assert.ok(flat.includes("import { SeatPids, isProcessAlive } from './util/SeatSurvival';"));
    const tracker = /new AgentSeatTracker\( (.*?) \); \/\//.exec(flat);
    assert.ok(tracker, 'new AgentSeatTracker( is built');
    assert.ok(tracker[1].includes("context.workspaceState.get<string[]>('moe.agentSeats', [])"), 'load reads moe.agentSeats');
    assert.ok(tracker[1].includes("persist('moe.agentSeats', ids); seatPids.keep(ids);"), 'save writes moe.agentSeats, then prunes the pids');
    assert.ok(tracker[1].includes("daemonClient?.deregisterWorker(workerId, 'terminal_closed')"), 'deregisters with terminal_closed');
    assert.ok(flat.includes("new SeatPids( () => context.workspaceState.get('moe.agentSeatPids'), pids => persist('moe.agentSeatPids', pids) )"));
    assert.equal(extensionText.split("'moe.agentSeats'").length - 1, 3, 'moe.agentSeats appears in load, save and the survivor read only');
});

test('X2 wireAgentSeats is the argument of context.subscriptions.push and gets the three event sources', () => {
    const wired = /context\.subscriptions\.push\(wireAgentSeats\(\{ (.*?),? \}\)\);/.exec(flat);
    assert.ok(wired, 'context.subscriptions.push(wireAgentSeats({ ... }))');
    for (const part of ['tracker: seatTracker', 'onDidCloseTerminal: vscode.window.onDidCloseTerminal',
        'workerIdOf: terminal => seatTerminals.get(terminal)', 'onConnected: daemonClient.onConnectionChanged',
        'onAcked: daemonClient.onWorkerDeregistered']) {
        assert.ok(wired[1].includes(part), part);
    }
    assert.equal(flat.split('wireAgentSeats(').length - 1, 1, 'wired exactly once');
});

test('X3 all three launch calls pass onLaunched in their option object', () => {
    const calls = [...flat.matchAll(/\b(launchAgent|launchAllAgents)\(([^;]*?)\}\);/g)].filter(m => !m[0].includes('import'));
    assert.equal(calls.length, 3);
    for (const call of calls) { assert.ok(/\{[^{}]*\bonLaunched,[^{}]*\}/.test(call[2] + '}'), call[0]); }
    assert.ok(flat.includes('const onLaunched = (workerId: string, terminal: vscode.Terminal): void => { seatTerminals.set(terminal, workerId); seatTracker.launched(workerId);'));
});

test('X4 the survivors are marked launched before wireAgentSeats subscribes, and both come before autoConnect', () => {
    const [survivors, subscribe, connect] = [indexOfText('seatPids.surviving('), indexOfText('wireAgentSeats({'), indexOfText("config.get<boolean>('autoConnect'")];
    assert.ok(survivors < subscribe && subscribe < connect, `${survivors} < ${subscribe} < ${connect}`);
    assert.ok(flat.includes('seatPids.surviving(context.workspaceState.get<string[]>(\'moe.agentSeats\', []), isProcessAlive)) { seatTracker.launched(workerId); }'));
    assert.ok(indexOfText('const onLaunched =') < indexOfText('registerCommand(\'moe.startAgent\''), 'onLaunched exists before any launch command');
});

test('X5 reconnected terminals are mapped, and a rejected save is handled', () => {
    assert.ok(flat.includes('vscode.window.terminals.forEach(mapSurvivor);'));
    assert.ok(flat.includes('context.subscriptions.push(vscode.window.onDidOpenTerminal(mapSurvivor));'));
    assert.ok(/context\.workspaceState\.update\(key, value\)\.then\(undefined, err => outputChannel\.appendLine\(`Moe could not save \$\{key\}: /.test(flat),
        'persist logs a rejected save to the Moe output channel');
    assert.ok(flat.includes('terminal.processId.then(pid => seatPids.record(workerId, pid), () => undefined);'), 'a rejected processId records nothing');
    assert.ok(flat.includes('if (workerId && !seatTerminals.has(terminal)) { seatTerminals.set(terminal, workerId); } }, () => undefined);'),
        'a launched terminal is never remapped, and a rejected processId maps nothing');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// CQ-M07p: VS Code parity with JetBrains CQ-M07o/M07o1. The PRODUCTION sources run transpiled in a vm with a
// stubbed vscode; vm-realm values are compared through JSON (cross-realm prototypes).
const transpile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
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

/** A fresh client module; `connect()` injects a fake open socket whose frames land in `sent`. */
const loadClient = () => run(clientSource, 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket });

function clientHarness() {
    const exports = loadClient();
    const client = new exports.MoeDaemonClient('extension');
    const [errors, sent] = [[], []];
    client.onError(error => errors.push(error));
    const socket = { readyState: WS_OPEN, send: frame => sent.push(JSON.parse(frame)), close() {} };
    const connect = () => { client['ws'] = socket; client['_connectionState'] = 'connected'; };
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    return { exports, client, errors, sent, socket, connect, deliver };
}

const READINESS_REQUEST = { type: 'GET_EXECUTION_READINESS', payload: { refresh: true } };
const NOT_READY = { profile: 'verified-local', ready: false, missingCapabilities: ['host.multipass', 'vm.image'], evaluatedAt: '2026-11-01T00:00:00.000Z' };
const READY = { profile: 'verified-local', ready: true, missingCapabilities: [], evaluatedAt: null };

test('C1 handleSocketOpen sends CLIENT_HELLO as frame 0, ahead of listener frames and GET_STATE', () => {
    const h = clientHarness();
    h.client.onConnectionChanged(state => { if (state === 'connected') { h.client.sendMessage('PING'); } });
    h.client['ws'] = h.socket;
    h.client['handleSocketOpen'](h.socket);
    assert.deepEqual(h.sent, [
        { type: 'CLIENT_HELLO', payload: { protocolVersion: 1, capabilities: { planRevisions: true, verifiedLocal: true } } },
        { type: 'PING', payload: {} },
        { type: 'GET_STATE', payload: {} }
    ]);
    assert.equal(h.client.connectionState, 'connected');
    h.client.dispose();
});

test('C2 a readiness round trip: one request frame, and one reply answers every waiter', async () => {
    const h = clientHarness();
    h.connect();
    const [first, second] = [h.client.requestExecutionReadiness(), h.client.requestExecutionReadiness()];
    assert.deepEqual(h.sent, [READINESS_REQUEST, READINESS_REQUEST]);
    h.deliver({ type: 'EXECUTION_READINESS', payload: { ...NOT_READY, extra: 'ignored' } });
    assert.deepEqual(plain(await first), { answered: NOT_READY });
    assert.deepEqual(plain(await second), { answered: NOT_READY });
    const third = h.client.requestExecutionReadiness();
    h.deliver({ type: 'EXECUTION_READINESS', payload: READY });
    assert.deepEqual(plain(await third), { answered: READY });
    assert.equal(h.client['readinessWaiters'].size, 0);
    h.client.dispose();
});

const MALFORMED = [
    ['a null payload', null], ['an array payload', []], ['a string payload', 'ready'],
    ['an unknown profile', { ...READY, profile: 'strong' }], ['no profile', { ready: true, missingCapabilities: [], evaluatedAt: null }],
    ['a string ready', { ...READY, ready: 'true' }], ['no ready', { profile: 'verified-local', missingCapabilities: [], evaluatedAt: null }],
    ['ids not an array', { ...NOT_READY, missingCapabilities: 'host.multipass' }], ['65 ids', { ...NOT_READY, missingCapabilities: Array(65).fill('x') }],
    ['an empty id', { ...NOT_READY, missingCapabilities: [''] }], ['a 129-character id', { ...NOT_READY, missingCapabilities: ['x'.repeat(129)] }],
    ['a numeric id', { ...NOT_READY, missingCapabilities: [5] }], ['no evaluatedAt', { profile: 'legacy', ready: true, missingCapabilities: [] }],
    ['a numeric evaluatedAt', { ...READY, evaluatedAt: 5 }], ['ready with ids', { ...READY, missingCapabilities: ['vm.image'] }]
];

test('C3 every malformed or contradictory readiness answer fails MALFORMED, never ready', async () => {
    const h = clientHarness();
    h.connect();
    for (const [name, payload] of MALFORMED) {
        const pending = h.client.requestExecutionReadiness();
        h.deliver({ type: 'EXECUTION_READINESS', payload });
        assert.deepEqual(plain(await pending), { failed: 'MALFORMED' }, name);
        assert.equal(h.exports.parseExecutionReadiness(payload), null, name);
    }
    const edges = { ...NOT_READY, missingCapabilities: [...Array(63).fill('x'), 'y'.repeat(128)] };
    assert.deepEqual(plain(h.exports.parseExecutionReadiness(edges)), edges, '64 ids of up to 128 characters are kept');
    h.client.dispose();
});

test('C4 a readiness ERROR fails DAEMON_ERROR without reaching onError; other errors still do', async () => {
    const h = clientHarness();
    h.connect();
    for (const frame of [
        { type: 'ERROR', operation: 'GET_EXECUTION_READINESS', message: 'readiness holder unavailable' },
        { type: 'ERROR', payload: { operation: 'GET_EXECUTION_READINESS', message: 'refused' } },
        { type: 'ERROR', message: 'Unknown message type: GET_EXECUTION_READINESS' }
    ]) {
        const pending = h.client.requestExecutionReadiness();
        h.deliver(frame);
        assert.deepEqual(plain(await pending), { failed: 'DAEMON_ERROR' });
    }
    assert.deepEqual(h.errors, []);
    h.deliver({ type: 'ERROR', operation: 'APPROVE_TASK', message: 'stale' });
    assert.deepEqual(plain(h.errors), [{ operation: 'APPROVE_TASK', message: 'stale' }]);
    h.client.dispose();
});

test('C5 timeout, disconnect, dispose and no connection each fail by name', async () => {
    const h = clientHarness();
    assert.deepEqual(plain(await h.client.requestExecutionReadiness()), { failed: 'NOT_CONNECTED' });
    assert.deepEqual(h.sent, [], 'nothing is sent while not connected');
    h.connect();
    assert.deepEqual(plain(await h.client.requestExecutionReadiness(50)), { failed: 'TIMEOUT' });
    h.deliver({ type: 'EXECUTION_READINESS', payload: READY });
    const cut = h.client.requestExecutionReadiness();
    h.client.disconnect();
    assert.deepEqual(plain(await cut), { failed: 'DISCONNECTED' });
    h.connect();
    const disposed = h.client.requestExecutionReadiness();
    h.client.dispose();
    assert.deepEqual(plain(await disposed), { failed: 'DISCONNECTED' });
    assert.equal(h.client['readinessWaiters'].size, 0);
});

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-m07p-'))));
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

test('C6 declaredProfile is a fresh strict read that never pins and never throws', () => {
    const { declaredProfile, runtimeProfile } = clientHarness().exports;
    for (const [text, declared] of [[undefined, 'legacy-like'], [declare('legacy'), 'legacy-like'], [declare('observe'), 'legacy-like'],
        [declare('verified-local'), 'verified-local'], [declare('strong'), 'untrusted'], ['{', 'untrusted']]) {
        assert.equal(declaredProfile(project(text)), declared, String(text));
    }
    assert.equal(declaredProfile(''), 'legacy-like');
    const dir = project(declare('verified-local'));
    assert.equal(declaredProfile(dir), 'verified-local');
    fs.writeFileSync(path.join(dir, '.moe', 'project.json'), declare('legacy'));
    assert.equal(declaredProfile(dir), 'legacy-like', 'declaredProfile never pins');
    assert.equal(runtimeProfile(dir), 'legacy', 'nor does it pin runtimeProfile');
});

// ---- Part 2: the launcher, over a fake terminal API (protected-runtime.test.cjs's loadLauncher) ----
const WIN = process.platform === 'win32';
const WRAPPER = WIN ? 'scripts/moe-agent.ps1' : 'scripts/moe-agent.sh';
const NAMES = { architect: 'Moe Planner', worker: 'Moe Coder', qa: 'Moe QA', governor: 'Moe Governor' };
const ROLES = Object.keys(NAMES);

/** An extension dir whose bundled/ holds the installed wrapper, daemon and proxy. */
function extension() {
    const dir = tempDir();
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js']) {
        write(path.join(dir, 'bundled', file), '// installed');
    }
    return dir;
}
const bundledEnv = (ext, marker) => ({ MOE_DAEMON_PATH: path.join(ext, 'bundled', 'daemon', 'index.js'),
    MOE_PROXY_PATH: path.join(ext, 'bundled', 'proxy', 'index.js'), ...(marker && { MOE_RUNTIME_PROTECTED: '1' }) });

const shQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const psQuote = value => `'${value.replace(/'/g, "''")}'`;

/** Today's command shape for the bundled wrapper, -EncodedCommand decoded and the random worker id fixed. */
function expectedCommand(role, ext, dir, marker, command = 'claude') {
    const [env, wrapper] = [Object.entries(bundledEnv(ext, marker)), path.join(ext, 'bundled', WRAPPER)];
    if (WIN) {
        return env.map(([key, value]) => `$env:${key}=${psQuote(value)}; `).join('') +
            `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand [& ${psQuote(wrapper)} -Role ${role} ` +
            `-Project ${psQuote(dir)} -WorkerId '${role}-ID' -Command '${command}']`;
    }
    return env.map(([key, value]) => `${key}=${shQuote(value)} `).join('') +
        `bash ${shQuote(wrapper)} --role ${role} --project ${shQuote(dir)} --worker-id '${role}-ID' --command '${command}'`;
}

const decode = text => text
    .replace(/-EncodedCommand (\S+)$/, (_, b64) => `-EncodedCommand [${Buffer.from(b64, 'base64').toString('utf16le')}]`)
    .replace(/(architect|worker|qa|governor)-[0-9a-f]{8}/, '$1-ID');

/** The launcher over a fake terminal API; setTimeout only records, so a test fires the staggers itself. */
function loadLauncher(dir) {
    const [terminals, errors, timers] = [[], [], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); } } };
    const launcher = run(launcherSource, 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { setTimeout: (fire, ms) => timers.push([ms, fire]) });
    const launched = () => terminals.map(t => [t.options.name, t.options.cwd, t.texts.length === 1 && decode(t.texts[0])]);
    return { launcher, terminals, errors, timers, launched };
}

/** A readiness source that counts its calls; an Error reply rejects. */
function source(reply) {
    const ask = async () => { ask.calls++; if (reply instanceof Error) { throw reply; } return reply; };
    ask.calls = 0;
    return ask;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const refusedWith = text => `Moe did not start the ${text} Nothing was started, and Moe never runs these agents on this machine instead.`;
const MISSING = 'verified-local is not ready on this machine. Missing: host.multipass, vm.image.';
const CLI_REFUSAL = shown => 'Verified-local runs worker and QA agents only in a Moe VM, which has claude and codex. ' +
    `'${shown}' cannot run there, so no agent was started. Pick Claude or Codex.`;

test('V1 absent, legacy and observe launch every role synchronously with today\'s command, never asking readiness', () => {
    const ext = extension();
    for (const text of [undefined, declare('legacy'), declare('observe')]) {
        const dir = project(text);
        for (const role of ROLES) {
            const [f, ask] = [loadLauncher(dir), source({ answered: READY })];
            f.launcher.launchAgent(role, 'gemini', ext, { readiness: ask });
            assert.deepEqual(f.launched(), [[NAMES[role], dir, expectedCommand(role, ext, dir, false, 'gemini')]], `${text} ${role}`);
            assert.deepEqual([f.errors, ask.calls], [[], 0]);
        }
    }
});

test('V2 under verified-local, architect and governor launch as today, synchronously, without readiness', () => {
    const [ext, dir] = [extension(), project(declare('verified-local'))];
    for (const role of ['architect', 'governor']) {
        const [f, ask] = [loadLauncher(dir), source({ failed: 'NOT_CONNECTED' })];
        f.launcher.launchAgent(role, 'gemini', ext, { readiness: ask });
        assert.deepEqual(f.launched(), [[NAMES[role], dir, expectedCommand(role, ext, dir, true, 'gemini')]]);
        assert.deepEqual([f.errors, ask.calls], [[], 0]);
    }
});

for (const [name, reply, reason] of [
    ['not ready', { answered: NOT_READY }, MISSING],
    ['unsafe ids', { answered: { ...NOT_READY, missingCapabilities: ['a b<c>'] } }, 'verified-local is not ready on this machine. Missing: a?b?c?.'],
    ['another profile', { answered: { ...READY, profile: 'observe' } },
        'the daemon reports the \'observe\' execution profile, while .moe/project.json asks for verified-local or could not be read strictly.'],
    ['NOT_CONNECTED', { failed: 'NOT_CONNECTED' }, 'the Moe daemon is not connected.'],
    ['DISCONNECTED', { failed: 'DISCONNECTED' }, 'the Moe daemon\'s connection closed before it answered.'],
    ['TIMEOUT', { failed: 'TIMEOUT' }, 'the Moe daemon did not answer within 20 seconds.'],
    ['DAEMON_ERROR', { failed: 'DAEMON_ERROR' }, 'the Moe daemon could not report its readiness.'],
    ['MALFORMED', { failed: 'MALFORMED' }, 'the Moe daemon\'s readiness answer could not be read.'],
    ['a rejecting source', new Error('boom'), 'the Moe daemon could not report its readiness.'],
    ['no readiness source', undefined, 'the Moe daemon is not connected.']
]) {
    test(`V3 a verified-local worker, ${name}: one error naming the reason and no terminal`, async () => {
        const f = loadLauncher(project(declare('verified-local')));
        await f.launcher.launchAgent('worker', 'claude', extension(), reply === undefined ? {} : { readiness: source(reply) });
        assert.deepEqual([f.errors, f.terminals.length], [[refusedWith(`worker agent: ${reason}`)], 0]);
    });
}

test('V3 an untrusted declaration fails closed: a QA seat is refused the same way', async () => {
    const f = loadLauncher(project(declare('strong')));
    await f.launcher.launchAgent('qa', 'claude', extension(), { readiness: source({ answered: NOT_READY }) });
    assert.deepEqual([f.errors, f.terminals.length], [[refusedWith(`QA agent: ${MISSING}`)], 0]);
});

test('V4 a ready reply launches worker and QA with the installed platform wrapper and the marker', async () => {
    const [ext, dir] = [extension(), project(declare('verified-local'))];
    for (const role of ['worker', 'qa']) {
        const [f, ask] = [loadLauncher(dir), source({ answered: READY })];
        await f.launcher.launchAgent(role, 'codex', ext, { readiness: ask });
        assert.deepEqual(f.launched(), [[NAMES[role], dir, expectedCommand(role, ext, dir, true, 'codex')]]);
        assert.deepEqual([f.errors, ask.calls], [[], 1]);
    }
});

test('V5 gemini, grok and custom CLIs are refused by name before any readiness request', async () => {
    const [ext, dir] = [extension(), project(declare('verified-local'))];
    for (const [provider, customCommand, shown] of [['gemini', undefined, 'gemini'], ['grok', undefined, 'grok'],
        ['custom', ' my-cli ', 'my-cli'], ['custom', `x${String.fromCharCode(7)}y`, 'x?y'], ['custom', 'z'.repeat(250), 'z'.repeat(200)]]) {
        const [f, ask] = [loadLauncher(dir), source({ answered: READY })];
        await f.launcher.launchAgent('worker', provider, ext, { customCommand, readiness: ask });
        assert.deepEqual([f.errors, f.terminals.length, ask.calls], [[CLI_REFUSAL(shown)], 0, 0]);
    }
});

test('V6 a refusal shows at most 32 ids of at most 64 characters; only ready verified-local launches', () => {
    const { verifiedLocalDecision } = loadLauncher(project()).launcher;
    const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(70, 'x'));
    assert.deepEqual(plain(verifiedLocalDecision('worker', { answered: { ...NOT_READY, missingCapabilities: ids } })), {
        refused: refusedWith(`worker agent: verified-local is not ready on this machine. Missing: ${ids.slice(0, 32).map(id => id.slice(0, 64)).join(', ')}, and 8 more.`)
    });
    assert.deepEqual(plain(verifiedLocalDecision('worker and QA', { answered: READY })), { launch: true });
    assert.deepEqual(plain(verifiedLocalDecision('QA', { answered: { ...READY, missingCapabilities: ['vm.image'] } })),
        { refused: refusedWith('QA agent: verified-local is not ready on this machine. Missing: vm.image.') });
});

for (const [name, text, reply, calls, names, errors] of [
    ['legacy', declare('legacy'), { answered: READY }, 0, ROLES.map(role => NAMES[role]), []],
    ['verified-local and ready', declare('verified-local'), { answered: READY }, 1, ROLES.map(role => NAMES[role]), []],
    ['verified-local and not ready', declare('verified-local'), { answered: NOT_READY }, 1, [NAMES.architect, NAMES.governor],
        [refusedWith(`worker and QA agents: ${MISSING}`)]]
]) {
    test(`A1 launchAllAgents, ${name}: worker and QA share one readiness decision and at most one error`, async () => {
        const [f, ask] = [loadLauncher(project(text)), source(reply)];
        f.launcher.launchAllAgents('claude', extension(), { readiness: ask });
        assert.deepEqual(f.timers.map(([ms]) => ms), [1500, 3000, 4500]);
        for (const [, fire] of f.timers) { fire(); await flush(); }
        assert.deepEqual([f.terminals.map(t => t.options.name), f.errors, ask.calls], [names, errors, calls]);
    });
}

test('A2 a shared refusal holds even if the project turns legacy before the worker and QA staggers fire', async () => {
    const dir = project(declare('verified-local'));
    const f = loadLauncher(dir);
    f.launcher.launchAllAgents('claude', extension(), { readiness: source({ failed: 'TIMEOUT' }) });
    write(path.join(dir, '.moe', 'project.json'), declare('legacy'));
    for (const [, fire] of f.timers) { fire(); await flush(); }
    assert.deepEqual([f.terminals.map(t => t.options.name), f.errors.length], [[NAMES.architect, NAMES.governor], 1]);
});

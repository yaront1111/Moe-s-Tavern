const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// VSC-12: the Claude account wire, mirroring JetBrains' MoeCommandSender (envelopes
// pinned by MoeCommandSenderAccountsTest.kt) and MoeMessageDispatcher (pinned by
// MoeMessageDispatcherAccountsTest.kt). The PRODUCTION client runs under vm.
const sourcePath = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const WS_OPEN = 1;
const j = value => JSON.stringify(value);

class RecordingEventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(payload) { for (const listener of this.listeners.slice()) { listener(payload); } }
    dispose() { this.listeners = []; }
}

function createHarness() {
    const module = { exports: {} };
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = WS_OPEN;
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showErrorMessage: () => Promise.resolve(undefined)
        },
        // autoConnect=false: no reconnect timer can hold the node:test child open.
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    const context = vm.createContext({
        exports: module.exports, module, console, process,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => {
            switch (name) {
                case 'vscode': return vscode;
                case 'ws': return StubWebSocket;
                case 'child_process': return { spawn: () => { throw new Error('unexpected spawn'); } };
                case 'fs': return fs;
                case 'path': return path;
                case 'net': return net;
                default: throw new Error('unexpected require from MoeDaemonClient.ts: ' + name);
            }
        }
    });
    vm.runInContext(compiled, context, { filename: sourcePath });
    // The client throws the vm realm's RangeError; a test-realm class never matches instanceof.
    const VmRangeError = vm.runInContext('RangeError', context);
    const client = new module.exports.MoeDaemonClient('extension');
    const changed = [];
    const added = [];
    const stateEvents = [];
    client.onAccountsChanged(p => changed.push(p));
    client.onAccountAdded(id => added.push(id));
    client.onStateChanged(s => stateEvents.push(s));

    /** Inject a fake socket and return the frames it is handed (recorded before anything else). */
    function connectSocket(connectionState = 'connected') {
        const sent = [];
        client['ws'] = { readyState: WS_OPEN, send: frame => sent.push(frame), close() {} };
        client['_connectionState'] = connectionState;
        return sent;
    }
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    /** Deliver a snapshot, then forget the events it fired. */
    function snapshot(extra = {}) {
        deliver({
            type: 'STATE_SNAPSHOT',
            payload: { project: { id: 'proj-1', name: 'Moe' }, epics: [{ id: 'epic-1' }], tasks: [{ id: 'task-1' }], workers: [{ id: 'worker-a' }], ...extra }
        });
        changed.length = 0;
        stateEvents.length = 0;
    }
    return { client, changed, added, stateEvents, VmRangeError, connectSocket, deliver, snapshot };
}

function withHarness(body) {
    const h = createHarness();
    try { body(h); } finally { h.client.dispose(); }
}

const rotation = (switchAtPercent, id) => ({
    registryFile: '/home/dev/.moe/claude-accounts.json', switchAtPercent, error: null,
    cli: { node: '/usr/bin/node', script: '/opt/moe/daemon/accounts/cli.js' },
    accounts: [{
        id, label: 'Work', signIn: 'subscription', signInCheckedAt: null,
        windows: {}, peakPercent: null, blockedUntil: null, active: true, seats: []
    }]
});

// =============================================================================
// A — the five senders
// =============================================================================

const SENDS = [
    [c => c.addAccount('  Work Max  '), 'ADD_ACCOUNT', { label: 'Work Max' }],
    [c => c.addAccount('   '), 'ADD_ACCOUNT', {}],
    [c => c.addAccount(undefined), 'ADD_ACCOUNT', {}],
    [c => c.removeAccount('acct-1'), 'REMOVE_ACCOUNT', { accountId: 'acct-1' }],
    [c => c.moveAccount('acct-2', -1), 'MOVE_ACCOUNT', { accountId: 'acct-2', offset: -1 }],
    [c => c.moveAccount('acct-2', 1), 'MOVE_ACCOUNT', { accountId: 'acct-2', offset: 1 }],
    [c => c.renameAccount('acct-3', ' Personal '), 'RENAME_ACCOUNT', { accountId: 'acct-3', label: 'Personal' }],
    [c => c.setAccountSwitchPercent(85), 'SET_ACCOUNT_SWITCH_PERCENT', { switchAtPercent: 85 }]
];

test('A1: the 8 JetBrains sender calls put the 8 JetBrains envelopes on the wire', () => withHarness(h => {
    const sent = h.connectSocket();
    for (const [call] of SENDS) { assert.equal(call(h.client), true); }
    assert.deepEqual(sent.map(f => JSON.parse(f)), SENDS.map(([, type, payload]) => ({ type, payload })));
}));

test('A2: disconnected, each sender returns false and sends nothing', () => withHarness(h => {
    const sent = h.connectSocket('disconnected');
    for (const [call] of SENDS) { assert.equal(call(h.client), false); }
    assert.deepEqual(sent, []);
}));

test('A3: an invalid offset or percent throws a RangeError before anything is sent, connected or not', () => withHarness(h => {
    for (const connectionState of ['connected', 'disconnected']) {
        const sent = h.connectSocket(connectionState);
        const isRangeError = e => e instanceof h.VmRangeError;
        for (const offset of [0, 2, -2, 1.5]) {
            assert.throws(() => h.client.moveAccount('acct-1', offset), isRangeError, `offset ${offset}`);
        }
        for (const percent of [0, 101, -5, 85.5]) {
            assert.throws(() => h.client.setAccountSwitchPercent(percent), isRangeError, `percent ${percent}`);
        }
        assert.deepEqual(sent, [], connectionState);
    }
}));

// =============================================================================
// B — ACCOUNTS_UPDATED and the snapshot's accountRotation
// =============================================================================

test('B1: ACCOUNTS_UPDATED after a snapshot stores the rotation, fires once, keeps the rest of the state', () => withHarness(h => {
    h.snapshot();
    const before = j(h.client.currentState);
    const next = rotation(75, 'acct-2');
    h.deliver({ type: 'ACCOUNTS_UPDATED', payload: next });
    assert.equal(j(h.client.accountRotation), j(next));
    assert.equal(h.changed.length, 1);
    assert.equal(j(h.changed[0]), j(next));
    assert.equal(j(h.client.currentState), before);
}));

test('B2: ACCOUNTS_UPDATED before the first snapshot is ignored', () => withHarness(h => {
    h.deliver({ type: 'ACCOUNTS_UPDATED', payload: rotation(75, 'acct-2') });
    assert.equal(h.client.accountRotation, undefined);
    assert.deepEqual(h.changed, []);
}));

test('B3: a malformed ACCOUNTS_UPDATED keeps the last good rotation and fires nothing', () => withHarness(h => {
    h.snapshot();
    const good = rotation(90, 'acct-1');
    h.deliver({ type: 'ACCOUNTS_UPDATED', payload: good });
    h.changed.length = 0;
    for (const payload of [{}, { accounts: [] }, { registryFile: 42 }, { registryFile: '  ' }, [], null, 'x', undefined]) {
        h.deliver({ type: 'ACCOUNTS_UPDATED', payload });
        assert.equal(j(h.client.accountRotation), j(good), `payload ${j(payload)}`);
    }
    assert.deepEqual(h.changed, []);
}));

test('B4: every snapshot sets accountRotation to its valid view or to undefined, and fires once', () => withHarness(h => {
    const first = rotation(90, 'acct-1');
    h.deliver({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p' }, epics: [], tasks: [], workers: [], accountRotation: first } });
    assert.equal(j(h.client.accountRotation), j(first));
    assert.equal(h.changed.length, 1);
    assert.equal(j(h.changed[0]), j(first));
    h.changed.length = 0;
    for (const accountRotation of [undefined, { registryFile: '  ' }]) {
        h.deliver({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p' }, epics: [], tasks: [], workers: [], accountRotation } });
        assert.equal(h.client.accountRotation, undefined);
        assert.equal(h.changed.length, 1);
        assert.equal(h.changed[0], undefined);
        h.changed.length = 0;
        h.deliver({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p' }, epics: [], tasks: [], workers: [], accountRotation: first } });
        h.changed.length = 0;
    }
}));

// =============================================================================
// C — ACCOUNT_ADDED
// =============================================================================

test('C1: ACCOUNT_ADDED fires onAccountAdded once and touches no state', () => withHarness(h => {
    h.snapshot({ accountRotation: rotation(90, 'acct-1') });
    const before = j(h.client.currentState);
    const rotationBefore = j(h.client.accountRotation);
    h.deliver({ type: 'ACCOUNT_ADDED', payload: { accountId: 'acct-7' } });
    assert.deepEqual(h.added, ['acct-7']);
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.stateEvents, []);
    assert.equal(j(h.client.currentState), before);
    assert.equal(j(h.client.accountRotation), rotationBefore);
}));

test('C2: ACCOUNT_ADDED without a non-blank string id fires nothing', () => withHarness(h => {
    for (const payload of [{}, { accountId: '' }, { accountId: '  ' }, { accountId: 7 }, { accountId: null }, { accountId: {} }, [], undefined]) {
        h.deliver({ type: 'ACCOUNT_ADDED', payload });
    }
    assert.deepEqual(h.added, []);
    assert.deepEqual(h.changed, []);
}));

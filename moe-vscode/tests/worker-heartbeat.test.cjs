'use strict';

// A worker heartbeat (daemon touchWorker) rewrites only lastActivityAt and still arrives as
// WORKER_UPDATED. The client takes the frame into its cache but fires onStateChanged only when
// something else changed, so the board webview, the account and VM trees and every open panel
// are not handed the whole board once per seat per heartbeat.
// Runs the PRODUCTION MoeDaemonClient under node:vm, the way tests/task-notifier.test.cjs does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const CLIENT_PATH = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const CLIENT_CODE = ts.transpileModule(fs.readFileSync(CLIENT_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

class RecordingEventEmitter {
    constructor() {
        this.listeners = [];
        this.event = listener => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(payload) { for (const listener of this.listeners.slice()) { listener(payload); } }
    dispose() { this.listeners = []; }
}

function realClient() {
    const module = { exports: {} };
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showErrorMessage: () => Promise.resolve(undefined) },
        // autoConnect=false keeps a failed send from arming a real reconnect timer that would hold node:test open.
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    const context = vm.createContext({
        exports: module.exports, module, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
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
    vm.runInContext(CLIENT_CODE, context, { filename: CLIENT_PATH });
    const client = new module.exports.MoeDaemonClient('extension');
    return { client, deliver: frame => client['handleMessage'](JSON.stringify(frame)) };
}

const worker = (overrides = {}) => ({
    id: 'worker-1', type: 'CLAUDE', projectId: 'p', epicId: '', currentTaskId: null, status: 'IDLE', branch: 'main',
    modifiedFiles: [], startedAt: '2026-11-04T10:00:00.000Z', lastActivityAt: '2026-11-04T10:00:00.000Z',
    lastError: null, errorCount: 0, teamId: null, ...overrides
});

test('a heartbeat-only WORKER_UPDATED refreshes the cache without firing onStateChanged', () => {
    const { client, deliver } = realClient();
    try {
        let fired = 0;
        client.onStateChanged(() => { fired += 1; });
        deliver({ type: 'STATE_SNAPSHOT', payload: { tasks: [], epics: [], workers: [worker()], proposals: [], teams: [] } });
        assert.equal(fired, 1, 'the snapshot fires');

        deliver({ type: 'WORKER_UPDATED', payload: worker({ lastActivityAt: '2026-11-04T10:01:00.000Z' }) });
        assert.equal(fired, 1, 'a heartbeat does not fire');
        assert.equal(client.currentState.workers[0].lastActivityAt, '2026-11-04T10:01:00.000Z', 'but the cache took the frame');

        deliver({ type: 'WORKER_UPDATED', payload: worker({ lastActivityAt: '2026-11-04T10:02:00.000Z', status: 'WORKING', currentTaskId: 'task-1' }) });
        assert.equal(fired, 2, 'a real change fires');
        assert.equal(client.currentState.workers[0].status, 'WORKING');

        deliver({ type: 'WORKER_UPDATED', payload: worker({ lastActivityAt: '2026-11-04T10:03:00.000Z', status: 'WORKING', currentTaskId: 'task-1' }) });
        assert.equal(fired, 2, 'the next heartbeat on the changed record is quiet again');

        deliver({ type: 'WORKER_CREATED', payload: worker({ id: 'worker-2' }) });
        assert.equal(fired, 3, 'a new worker fires');
        assert.equal(client.currentState.workers.length, 2);

        deliver({ type: 'WORKER_DELETED', payload: { id: 'worker-2' } });
        assert.equal(fired, 4, 'a deletion still fires');
        assert.equal(client.currentState.workers.length, 1);
    } finally {
        client.dispose();
    }
});

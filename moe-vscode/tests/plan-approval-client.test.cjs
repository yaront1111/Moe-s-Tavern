const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// These tests execute the PRODUCTION client (transpiled + run under vm), never a
// copy of its serialization logic — the whole point is to pin the exact bytes
// APPROVE_TASK puts on the wire.
const sourcePath = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

// The `ws` default export's numeric OPEN constant, which sendMessage compares
// the injected socket's readyState against.
const WS_OPEN = 1;

/** vscode.EventEmitter stand-in that records listeners so `fire` is observable. */
class RecordingEventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(payload) {
        for (const listener of this.listeners.slice()) { listener(payload); }
    }
    dispose() { this.listeners = []; }
}

function createHarness() {
    const logs = [];
    const errors = [];
    const module = { exports: {} };

    function StubWebSocket() {
        throw new Error('these tests never open a real socket');
    }
    StubWebSocket.OPEN = WS_OPEN;

    const vscode = {
        EventEmitter: RecordingEventEmitter,
        window: {
            createOutputChannel: () => ({ appendLine: line => logs.push(line), dispose() {} }),
            showErrorMessage: () => Promise.resolve(undefined)
        },
        workspace: {
            // autoConnect=false keeps a failed send from arming a real 5s reconnect
            // timer that would hold the node:test child open.
            getConfiguration: () => ({ get: () => false })
        }
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

    // The client's `err instanceof Error` check compares against the vm realm's
    // Error, so a test-realm throw would silently take the String(err) branch.
    const VmError = vm.runInContext('Error', context);

    const client = new module.exports.MoeDaemonClient('extension');
    client.onError(payload => errors.push(payload));

    /** Inject a connected fake socket and return the array of frames it is handed. */
    function connectSocket(sendImpl) {
        const sent = [];
        client['ws'] = {
            readyState: WS_OPEN,
            // Record first, so `sent` always reflects what actually reached the
            // socket even when the send itself blows up afterwards.
            send: (frame) => { sent.push(frame); if (sendImpl) { sendImpl(frame); } },
            close: () => {}
        };
        client['_connectionState'] = 'connected';
        return sent;
    }

    function deliver(frame) {
        client['handleMessage'](JSON.stringify(frame));
    }

    return { client, logs, errors, VmError, connectSocket, deliver, dispose: () => client.dispose() };
}

function onlyFrame(sent) {
    assert.equal(sent.length, 1, `expected exactly one outbound frame, got ${sent.length}`);
    return JSON.parse(sent[0]);
}

function withHarness(body) {
    const h = createHarness();
    try { body(h); } finally { h.dispose(); }
}

// =============================================================================
// A / B — a supplied token survives serialization unchanged
// =============================================================================

test('an explicit revision 0 reaches the wire instead of being dropped as falsy', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.approveTask('task-1', 0), true);
        assert.deepEqual(onlyFrame(sent), {
            type: 'APPROVE_TASK',
            payload: { taskId: 'task-1', expectedPlanRevision: 0 }
        });
    });
});

test('a normal revision is forwarded unchanged', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.approveTask('task-1', 7), true);
        assert.deepEqual(onlyFrame(sent), {
            type: 'APPROVE_TASK',
            payload: { taskId: 'task-1', expectedPlanRevision: 7 }
        });
    });
});

test('the largest safe revision is forwarded unchanged', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.approveTask('task-1', Number.MAX_SAFE_INTEGER), true);
        assert.deepEqual(onlyFrame(sent), {
            type: 'APPROVE_TASK',
            payload: { taskId: 'task-1', expectedPlanRevision: Number.MAX_SAFE_INTEGER }
        });
    });
});

// =============================================================================
// C / D / E — an omitted token keeps the exact legacy frame
// =============================================================================

test('a legacy one-argument approval omits the property entirely', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.approveTask('task-1'), true);
        const frame = onlyFrame(sent);
        assert.deepEqual(frame, { type: 'APPROVE_TASK', payload: { taskId: 'task-1' } });
        // Key absence, not an undefined comparison: a serialized null would pass the latter.
        assert.deepEqual(Object.keys(frame.payload), ['taskId']);
        assert.equal(Object.prototype.hasOwnProperty.call(frame.payload, 'expectedPlanRevision'), false);
    });
});

test('an omitted token is never inferred from the cached revision of that task', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        h.client['state'] = { tasks: [{ id: 'task-1', title: 'cached', planRevision: 9 }] };
        assert.equal(h.client.approveTask('task-1'), true);
        const frame = onlyFrame(sent);
        assert.deepEqual(Object.keys(frame.payload), ['taskId']);
        assert.equal(Object.prototype.hasOwnProperty.call(frame.payload, 'expectedPlanRevision'), false);
    });
});

test('a supplied token wins over a newer cached revision', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        h.client['state'] = { tasks: [{ id: 'task-1', title: 'cached', planRevision: 9 }] };
        assert.equal(h.client.approveTask('task-1', 4), true);
        assert.deepEqual(onlyFrame(sent), {
            type: 'APPROVE_TASK',
            payload: { taskId: 'task-1', expectedPlanRevision: 4 }
        });
    });
});

test('an explicit undefined token behaves exactly like an omitted argument', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.approveTask('task-1', undefined), true);
        const frame = onlyFrame(sent);
        assert.deepEqual(frame, { type: 'APPROVE_TASK', payload: { taskId: 'task-1' } });
        assert.deepEqual(Object.keys(frame.payload), ['taskId']);
    });
});

// =============================================================================
// F — a malformed token is refused locally with NO outbound frame
// =============================================================================

const MALFORMED_TOKENS = [
    ['null', null],
    ['a numeric string', '3'],
    ['a boolean', true],
    ['a fraction', 3.5],
    ['a negative revision', -1],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', NaN],
    ['Infinity', Infinity]
];

for (const [label, token] of MALFORMED_TOKENS) {
    test(`${label} is refused without sending any frame, including the legacy one`, () => {
        withHarness(h => {
            const sent = h.connectSocket();
            assert.equal(h.client.approveTask('task-1', token), false);
            // No legacy fallback: a token-free frame here would approve a plan nobody reviewed.
            assert.deepEqual(sent, []);
            assert.equal(h.errors.length, 1, 'the refusal must be reported once');
            assert.equal(h.errors[0].operation, 'APPROVE_TASK');
            assert.match(h.errors[0].message, /expectedPlanRevision/);
            assert.ok(
                h.errors[0].message.includes(String(token)),
                `the refusal must name the rejected value, got: ${h.errors[0].message}`
            );
            assert.ok(
                h.errors[0].message.includes(typeof token),
                `the refusal must name the rejected type, got: ${h.errors[0].message}`
            );
            assert.ok(h.logs.some(line => line.includes('APPROVE_TASK')), 'the refusal must be logged');
        });
    });
}

// =============================================================================
// G — no path reports false success
// =============================================================================

test('a valid approval while disconnected returns false and sends nothing', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        h.client['_connectionState'] = 'disconnected';
        assert.equal(h.client.approveTask('task-1', 4), false);
        assert.deepEqual(sent, []);
        // Legacy behavior: a disconnected send is silent, not an error event.
        assert.deepEqual(h.errors, []);
    });
});

test('a valid approval with no socket at all returns false and sends nothing', () => {
    withHarness(h => {
        const sent = h.connectSocket();
        h.client['ws'] = undefined;
        assert.equal(h.client.approveTask('task-1', 4), false);
        assert.deepEqual(sent, []);
    });
});

test('a throwing socket returns false and reports the failed APPROVE_TASK', () => {
    withHarness(h => {
        const sent = h.connectSocket(() => { throw new h.VmError('socket is gone'); });
        assert.equal(h.client.approveTask('task-1', 4), false);
        // The frame did reach the socket — the false came from the send, not
        // from a local refusal, so the token must still be on it.
        assert.deepEqual(onlyFrame(sent), {
            type: 'APPROVE_TASK',
            payload: { taskId: 'task-1', expectedPlanRevision: 4 }
        });
        assert.equal(h.errors.length, 1);
        assert.equal(h.errors[0].operation, 'APPROVE_TASK');
        assert.equal(h.errors[0].message, 'socket is gone');
    });
});

// =============================================================================
// H / I — refusal feedback is correlated to the command that caused it
// =============================================================================

const MISMATCH_MESSAGE = '[PLAN_REVISION_MISMATCH] Task task-1 was approved at plan revision 4 but is now at 9';

function assertMismatchPayload(payload) {
    assert.equal(payload.operation, 'APPROVE_TASK');
    assert.equal(payload.message, MISMATCH_MESSAGE);
    assert.equal(payload.code, -32002);
    assert.equal(payload.codeName, 'PLAN_REVISION_MISMATCH');
    assert.deepEqual(
        Object.keys(payload.context).sort(),
        ['currentPlanRevision', 'expectedPlanRevision', 'taskId']
    );
    assert.equal(payload.context.taskId, 'task-1');
    assert.equal(payload.context.expectedPlanRevision, 4);
    assert.equal(payload.context.currentPlanRevision, 9);
}

test('a modern top-level ERROR frame reaches the error event fully correlated', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: MISMATCH_MESSAGE,
            operation: 'APPROVE_TASK',
            code: -32002,
            codeName: 'PLAN_REVISION_MISMATCH',
            context: { taskId: 'task-1', epicId: 'epic-1', expectedPlanRevision: 4, currentPlanRevision: 9 }
        });
        assert.equal(h.errors.length, 1);
        assertMismatchPayload(h.errors[0]);
        // epicId is deliberately not promoted.
        assert.equal(Object.prototype.hasOwnProperty.call(h.errors[0].context, 'epicId'), false);
    });
});

test('a legacy payload-nested ERROR frame is promoted the same way', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: MISMATCH_MESSAGE,
            payload: {
                operation: 'APPROVE_TASK',
                code: -32002,
                codeName: 'PLAN_REVISION_MISMATCH',
                context: { taskId: 'task-1', expectedPlanRevision: 4, currentPlanRevision: 9 }
            }
        });
        assert.equal(h.errors.length, 1);
        assertMismatchPayload(h.errors[0]);
    });
});

test('a legacy ERROR frame with only a nested message still resolves that message', () => {
    withHarness(h => {
        h.deliver({ type: 'ERROR', payload: { operation: 'REJECT_TASK', message: 'nested only' } });
        assert.equal(h.errors.length, 1);
        assert.equal(h.errors[0].operation, 'REJECT_TASK');
        assert.equal(h.errors[0].message, 'nested only');
    });
});

// =============================================================================
// J — the context allowlist cannot leak
// =============================================================================

test('unrelated daemon context keys are never promoted into the public payload', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: 'boom',
            operation: 'APPROVE_TASK',
            context: {
                taskId: 'task-1',
                expectedPlanRevision: 4,
                currentPlanRevision: 9,
                epicId: 'epic-1',
                field: 'expectedPlanRevision',
                reason: 'not a non-negative safe integer',
                projectRoot: 'D:\\projexts\\moes',
                paths: ['.moe/tasks/task-1.json']
            }
        });
        assert.deepEqual(
            Object.keys(h.errors[0].context).sort(),
            ['currentPlanRevision', 'expectedPlanRevision', 'taskId']
        );
    });
});

test('a context carrying only unlisted keys yields no context property at all', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: 'boom',
            operation: 'CREATE_TASK',
            context: { field: 'title', reason: 'required', projectRoot: 'D:\\projexts\\moes' }
        });
        assert.equal(h.errors.length, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(h.errors[0], 'context'), false);
    });
});

test('wrongly typed allowlisted values are dropped rather than forwarded', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: 'boom',
            operation: 'APPROVE_TASK',
            context: { taskId: 42, expectedPlanRevision: '4', currentPlanRevision: null }
        });
        assert.equal(h.errors.length, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(h.errors[0], 'context'), false);
    });
});

test('an ERROR frame with none of the new fields produces exactly the legacy payload', () => {
    withHarness(h => {
        h.deliver({ type: 'ERROR', message: 'Missing taskId' });
        assert.equal(h.errors.length, 1);
        assert.equal(h.errors[0].message, 'Missing taskId');
        assert.equal(h.errors[0].operation, undefined);
        assert.deepEqual(Object.keys(h.errors[0]).sort(), ['message', 'operation']);
    });
});

test('a non-numeric code and an empty codeName are not promoted', () => {
    withHarness(h => {
        h.deliver({
            type: 'ERROR',
            message: 'boom',
            operation: 'APPROVE_TASK',
            code: 'STATE_CONFLICT',
            codeName: ''
        });
        assert.equal(h.errors.length, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(h.errors[0], 'code'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(h.errors[0], 'codeName'), false);
    });
});

// =============================================================================
// K — planRevision survives the cached-task update path
// =============================================================================

test('a TASK_UPDATED frame carrying planRevision leaves it readable on the cached task', () => {
    withHarness(h => {
        h.client['state'] = { tasks: [{ id: 'task-1', title: 'old', planRevision: 3 }] };
        h.deliver({ type: 'TASK_UPDATED', payload: { id: 'task-1', title: 'new', planRevision: 4 } });
        const cached = h.client.currentState.tasks.find(t => t.id === 'task-1');
        assert.equal(cached.planRevision, 4);
        assert.equal(cached.title, 'new');
    });
});

test('a TASK_UPDATED frame without planRevision leaves the property absent, not zero', () => {
    withHarness(h => {
        h.client['state'] = { tasks: [] };
        h.deliver({ type: 'TASK_UPDATED', payload: { id: 'task-2', title: 'legacy row' } });
        const cached = h.client.currentState.tasks.find(t => t.id === 'task-2');
        assert.equal(Object.prototype.hasOwnProperty.call(cached, 'planRevision'), false);
        assert.equal(cached.planRevision, undefined);
    });
});

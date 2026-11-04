'use strict';

// VSC-1: VS Code tells the human when a task needs them, using JetBrains' rule
// (MoeMessageDispatcher.kt 'TASK_UPDATED'/'TASK_CREATED' branch + MoeNotificationService.kt texts).
// TaskNotifier.ts must stay free of runtime imports (type-only), so ANY require from it throws here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const COMPILER_OPTIONS = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true };
const NOTIFIER_SOURCE = path.join(__dirname, '../src/util/TaskNotifier.ts');
const CLIENT_SOURCE = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const transpile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: COMPILER_OPTIONS }).outputText;

// runInThisContext keeps what the module returns in THIS realm, so strict deepEqual works on it.
const N = (() => {
    const module = { exports: {} };
    vm.runInThisContext(`(function (exports, module, require) {${transpile(NOTIFIER_SOURCE)}\n})`, { filename: NOTIFIER_SOURCE })(
        module.exports, module, name => { throw new Error(`TaskNotifier.ts must not require ${name}`); });
    return module.exports;
})();

const task = (status, more = {}) => ({ id: 'task-1', title: 'Ship it', status, ...more });
const VIEW = { label: 'View Task', command: 'moe.openTaskDetail', taskId: 'task-1' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const REVIEW_LINE = 'Task Ready for Review: Task "Ship it" is ready for code review';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A client that fires onTaskUpdated FIRST and writes the frame into currentState AFTER, exactly like
 * MoeDaemonClient.handleMessage case 'TASK_UPDATED'. `snapshot` replaces the cache and fires no
 * onTaskUpdated (a STATE_SNAPSHOT only fires onStateChanged). `tasks` undefined = before the first snapshot.
 */
function fakeClient(tasks) {
    let listeners = [];
    const client = {
        currentState: tasks === undefined ? undefined : { tasks: tasks.slice() },
        onTaskUpdated(listener) {
            listeners.push(listener);
            return { dispose() { listeners = listeners.filter(l => l !== listener); } };
        },
        frame(t) {
            for (const listener of listeners.slice()) { listener(t); }
            const state = client.currentState;
            if (!state) { return; }
            state.tasks = state.tasks.filter(x => x.id !== t.id);
            if (t.status !== 'ARCHIVED') { state.tasks.push(t); }
        },
        snapshot(next) { client.currentState = { tasks: next.slice() }; },
        get listenerCount() { return listeners.length; }
    };
    return client;
}

/** Recorder for the vscode window/commands surface the notifier is handed. */
function recorder() {
    const rec = {
        shown: [],
        commands: [],
        answer: undefined,
        commandResult: () => Promise.resolve(undefined)
    };
    const show = kind => (line, ...items) => { rec.shown.push({ kind, line, items }); return Promise.resolve(rec.answer); };
    rec.window = { showInformationMessage: show('info'), showWarningMessage: show('warning') };
    rec.commandsApi = { executeCommand: (...args) => { rec.commands.push(args); return rec.commandResult(); } };
    return rec;
}

function armed(tasks) {
    const client = fakeClient(tasks);
    const rec = recorder();
    const disposable = N.registerTaskNotifier(client, rec.window, rec.commandsApi);
    return { client, rec, disposable };
}

// ---------------------------------------------------------------------------
// A: the pure decision (DoD 1): exact kind, title, message and action
// ---------------------------------------------------------------------------

test('A1: AWAITING_APPROVAL is an info notice with a View Task action', () => {
    assert.deepEqual(N.taskNotification('PLANNING', task('AWAITING_APPROVAL')), {
        kind: 'info', title: 'Plan Awaiting Approval', message: 'Task "Ship it" has a plan ready for review', action: VIEW
    });
});

test('A2: BLOCKED is a warning notice with a View Task action', () => {
    assert.deepEqual(N.taskNotification('WORKING', task('BLOCKED')), {
        kind: 'warning', title: 'Task Blocked', message: 'Task "Ship it" is blocked and needs attention', action: VIEW
    });
});

test('A3: REVIEW is an info notice with a View Task action', () => {
    assert.deepEqual(N.taskNotification('WORKING', task('REVIEW')), {
        kind: 'info', title: 'Task Ready for Review', message: 'Task "Ship it" is ready for code review', action: VIEW
    });
});

test('A4: DONE is an info notice with NO action key at all', () => {
    const done = N.taskNotification('REVIEW', task('DONE'));
    // Strict deepEqual tells a missing key from `action: undefined`.
    assert.deepEqual(done, { kind: 'info', title: 'Task Completed', message: 'Task "Ship it" has been marked as done' });
    assert.equal(Object.prototype.hasOwnProperty.call(done, 'action'), false);
});

test('A5: an uncached task (no previous status) counts as different', () => {
    assert.deepEqual(N.taskNotification(undefined, task('REVIEW')), N.taskNotification('WORKING', task('REVIEW')));
    assert.equal(N.taskNotification(undefined, task('DONE')).title, 'Task Completed');
});

test('A6: the action carries the id of the task in the frame', () => {
    assert.deepEqual(N.taskNotification('WORKING', task('REVIEW', { id: 'task-77' })).action,
        { label: 'View Task', command: 'moe.openTaskDetail', taskId: 'task-77' });
});

// ---------------------------------------------------------------------------
// B: the pure decision never notifies (DoD 2)
// ---------------------------------------------------------------------------

test('B: same-status frames and statuses outside the four notifying ones return undefined', () => {
    const never = [
        ['REVIEW', 'REVIEW'], ['BLOCKED', 'BLOCKED'], ['DONE', 'DONE'], ['AWAITING_APPROVAL', 'AWAITING_APPROVAL'],
        ['BACKLOG', 'PLANNING'], ['AWAITING_APPROVAL', 'WORKING'], ['REVIEW', 'WORKING'],
        [undefined, 'BACKLOG'], [undefined, 'PLANNING'], [undefined, 'WORKING'],
        ['DONE', 'ARCHIVED'], [undefined, 'ARCHIVED'], ['WORKING', 'SOMETHING_NEW']
    ];
    for (const [previous, next] of never) {
        assert.equal(N.taskNotification(previous, task(next)), undefined, `${previous} -> ${next}`);
    }
});

test('B2: an empty title is passed through, not dropped', () => {
    assert.equal(N.taskNotification('WORKING', task('REVIEW', { title: '' })).message, 'Task "" is ready for code review');
});

// ---------------------------------------------------------------------------
// C: the listener on a client that fires BEFORE it caches (DoD 2 + 3)
// ---------------------------------------------------------------------------

test('C1: WORKING -> REVIEW shows exactly one notice, a repeat none, and a disposed notifier none', () => {
    const { client, rec, disposable } = armed([task('WORKING')]);

    client.frame(task('REVIEW'));
    assert.deepEqual(rec.shown, [{ kind: 'info', line: REVIEW_LINE, items: ['View Task'] }]);

    client.frame(task('REVIEW'));
    client.frame(task('WORKING'));
    assert.equal(rec.shown.length, 1, 'a repeated REVIEW frame and a move to WORKING show nothing');

    client.snapshot([task('DONE')]);
    client.snapshot([task('WORKING')]);
    assert.equal(rec.shown.length, 1, 'a STATE_SNAPSHOT never notifies');

    disposable.dispose();
    assert.equal(client.listenerCount, 0, 'disposing unsubscribes from the client');
    client.frame(task('DONE')); // would notify were the notifier still armed
    assert.equal(rec.shown.length, 1, 'after dispose no frame notifies');
});

test('C2: BLOCKED is a warning notice with View Task, DONE an info notice with no button', () => {
    const { client, rec } = armed([task('WORKING')]);
    client.frame(task('BLOCKED'));
    client.frame(task('DONE'));
    assert.deepEqual(rec.shown, [
        { kind: 'warning', line: 'Task Blocked: Task "Ship it" is blocked and needs attention', items: ['View Task'] },
        { kind: 'info', line: 'Task Completed: Task "Ship it" has been marked as done', items: [] }
    ]);
});

test('C3: AWAITING_APPROVAL is an info notice with View Task', () => {
    const { client, rec } = armed([task('PLANNING')]);
    client.frame(task('AWAITING_APPROVAL'));
    assert.deepEqual(rec.shown, [
        { kind: 'info', line: 'Plan Awaiting Approval: Task "Ship it" has a plan ready for review', items: ['View Task'] }
    ]);
});

test('C4: PLANNING and WORKING moves, an uncached BACKLOG task and an ARCHIVED frame stay silent', () => {
    const { client, rec } = armed([task('BACKLOG'), task('REVIEW', { id: 'task-2' })]);
    client.frame(task('PLANNING'));
    client.frame(task('WORKING'));
    client.frame(task('BACKLOG', { id: 'task-3' })); // TASK_CREATED, uncached
    client.frame(task('ARCHIVED', { id: 'task-2' }));
    assert.deepEqual(rec.shown, []);
});

test('C5: before the first STATE_SNAPSHOT (no currentState) a frame notifies nobody', () => {
    const { client, rec } = armed(undefined);
    client.frame(task('REVIEW'));
    assert.deepEqual(rec.shown, []);
    client.snapshot([]);
    client.frame(task('REVIEW'));
    assert.equal(rec.shown.length, 1, 'once the cache exists the same frame notifies');
});

test('C6: a burst is decided frame by frame from the cache, one notice per changing frame', () => {
    const { client, rec } = armed([task('WORKING')]);
    for (const status of ['REVIEW', 'REVIEW', 'BLOCKED', 'BLOCKED', 'REVIEW', 'DONE', 'DONE']) { client.frame(task(status)); }
    assert.deepEqual(rec.shown.map(s => s.line), [
        REVIEW_LINE,
        'Task Blocked: Task "Ship it" is blocked and needs attention',
        REVIEW_LINE,
        'Task Completed: Task "Ship it" has been marked as done'
    ]);
});

test('C7: a different task with the same status does not mask a transition (cache is per task id)', () => {
    const { client, rec } = armed([task('REVIEW', { id: 'task-2' }), task('WORKING')]);
    client.frame(task('REVIEW'));
    assert.equal(rec.shown.length, 1);
});

test('C8: the notifier never writes the cache it reads', () => {
    // Capture the listener and call it alone, without the cache write frame() performs afterwards.
    const state = { tasks: [task('WORKING')] };
    const before = JSON.stringify(state);
    let listener;
    const client = { currentState: state, onTaskUpdated: l => { listener = l; return { dispose() {} }; } };
    const rec = recorder();
    N.registerTaskNotifier(client, rec.window, rec.commandsApi);
    listener(task('REVIEW'));
    assert.equal(rec.shown.length, 1);
    assert.equal(client.currentState, state);
    assert.equal(JSON.stringify(state), before);
});

// ---------------------------------------------------------------------------
// D: the View Task action
// ---------------------------------------------------------------------------

test('D1: picking View Task runs moe.openTaskDetail with the task id', async () => {
    const { client, rec } = armed([task('WORKING')]);
    rec.answer = 'View Task';
    client.frame(task('REVIEW'));
    await flush();
    assert.deepEqual(rec.commands, [['moe.openTaskDetail', 'task-1']]);
    assert.equal(rec.shown.length, 1, 'a successful open shows nothing more');
});

test('D2: dismissing the notice runs no command', async () => {
    const { client, rec } = armed([task('WORKING')]);
    rec.answer = undefined;
    client.frame(task('REVIEW'));
    await flush();
    assert.deepEqual(rec.commands, []);
});

test('D3: a DONE notice has no button, so no answer can open anything', async () => {
    const { client, rec } = armed([task('REVIEW')]);
    rec.answer = 'View Task'; // a stray answer must still not run a command
    client.frame(task('DONE'));
    await flush();
    assert.deepEqual(rec.commands, []);
});

test('D4: a failed open reaches the human as a warning, not an unhandled rejection', async () => {
    const { client, rec } = armed([task('WORKING')]);
    rec.answer = 'View Task';
    rec.commandResult = () => Promise.reject(new Error('boom'));
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        client.frame(task('REVIEW'));
        await flush();
        await flush();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(rec.shown.slice(1), [{ kind: 'warning', line: 'Moe: could not open task task-1: boom', items: [] }]);
    assert.deepEqual(unhandled, []);
});

test('D5: a non-Error rejection is stringified into the warning', async () => {
    const { client, rec } = armed([task('WORKING')]);
    rec.answer = 'View Task';
    rec.commandResult = () => Promise.reject('gone');
    client.frame(task('BLOCKED'));
    await flush();
    await flush();
    assert.equal(rec.shown[1].line, 'Moe: could not open task task-1: gone');
});

// ---------------------------------------------------------------------------
// E: a title cannot plant a clickable command link
// ---------------------------------------------------------------------------

// VS Code parses [label](http(s)://|command:|file:...) in notification text and opens it with
// allowCommands: true. Copied from microsoft/vscode src/vs/base/common/linkedText.ts LINK_REGEX, minus the g flag.
const LINK_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/i;

test('E1: "](" in a title becomes "] (" so the notice text carries no link', () => {
    const title = '[Approve](command:workbench.action.terminal.sendSequence?%7B%7D)';
    assert.match(title, LINK_REGEX); // the fixture is live: unsanitised it WOULD be a link
    assert.match(`Task "${title}" is ready for code review`, LINK_REGEX);

    const { client, rec } = armed([task('WORKING', { title })]);
    client.frame(task('REVIEW', { title }));
    assert.equal(rec.shown[0].line,
        'Task Ready for Review: Task "[Approve] (command:workbench.action.terminal.sendSequence?%7B%7D)" is ready for code review');
    assert.doesNotMatch(rec.shown[0].line, LINK_REGEX);
});

test('E2: every "](" in a title is rewritten, and a title without one is untouched', () => {
    const many = '[a](http://x.test)[b](file:///y)';
    const msg = N.taskNotification('WORKING', task('REVIEW', { title: many })).message;
    assert.equal(msg, 'Task "[a] (http://x.test)[b] (file:///y)" is ready for code review');
    assert.doesNotMatch(msg, LINK_REGEX);
    assert.equal(N.taskNotification('WORKING', task('REVIEW', { title: 'Fix [WT-11] (wrappers)' })).message,
        'Task "Fix [WT-11] (wrappers)" is ready for code review');
});

// ---------------------------------------------------------------------------
// F: the real MoeDaemonClient seam (it must fire onTaskUpdated BEFORE it caches the frame)
// ---------------------------------------------------------------------------

/** vscode.EventEmitter stand-in; copied from tests/plan-approval-client.test.cjs (requiring that file would register its tests). */
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

const CLIENT_CODE = transpile(CLIENT_SOURCE);

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
    vm.runInContext(CLIENT_CODE, context, { filename: CLIENT_SOURCE });
    const client = new module.exports.MoeDaemonClient('extension');
    return { client, deliver: frame => client['handleMessage'](JSON.stringify(frame)) };
}

test('F: against the real client, frames notify from the status cached BEFORE the frame', () => {
    const { client, deliver } = realClient();
    try {
        const rec = recorder();
        const disposable = N.registerTaskNotifier(client, rec.window, rec.commandsApi);
        const count = () => rec.shown.length;

        deliver({ type: 'STATE_SNAPSHOT', payload: { tasks: [task('WORKING')], epics: [] } });
        assert.equal(count(), 0, 'a STATE_SNAPSHOT never notifies');

        deliver({ type: 'TASK_UPDATED', payload: task('REVIEW') });
        assert.equal(count(), 1, 'WORKING -> REVIEW notifies once');
        assert.equal(rec.shown[0].line, REVIEW_LINE);

        deliver({ type: 'TASK_UPDATED', payload: task('REVIEW') });
        assert.equal(count(), 1, 'the same frame again is same-status: the cache already holds REVIEW');

        deliver({ type: 'TASK_DELETED', payload: { id: 'task-1' } });
        assert.equal(count(), 1, 'TASK_DELETED never notifies');

        deliver({ type: 'TASK_CREATED', payload: task('BACKLOG', { id: 'task-2' }) });
        assert.equal(count(), 1, 'an uncached BACKLOG task is silent');

        deliver({ type: 'STATE_SNAPSHOT', payload: { tasks: [task('DONE', { id: 'task-2' })], epics: [] } });
        assert.equal(count(), 1, 'a STATE_SNAPSHOT holding a DONE task is silent');

        deliver({ type: 'TASK_UPDATED', payload: task('AWAITING_APPROVAL', { id: 'task-2' }) });
        assert.equal(count(), 2, 'DONE -> AWAITING_APPROVAL notifies');
        assert.equal(rec.shown[1].line, 'Plan Awaiting Approval: Task "Ship it" has a plan ready for review');

        disposable.dispose();
        deliver({ type: 'TASK_UPDATED', payload: task('REVIEW', { id: 'task-2' }) });
        assert.equal(count(), 2, 'after dispose the real client notifies nobody');
    } finally {
        client.dispose();
    }
});

test('F2: a frame before the first STATE_SNAPSHOT notifies nobody on the real client', () => {
    const { client, deliver } = realClient();
    try {
        const rec = recorder();
        N.registerTaskNotifier(client, rec.window, rec.commandsApi);
        deliver({ type: 'TASK_UPDATED', payload: task('REVIEW') });
        assert.deepEqual(rec.shown, []);
    } finally {
        client.dispose();
    }
});

'use strict';

// What the extension tells the user about a daemon frame that never left, or came back refused. F1-F3 (audit V1): every
// create, save, delete, comment and archive wrapper says whether its frame reached the socket, the forms stay open when
// it did not, and an unsent comment goes back into the comment box. F4 (V2): a daemon refusal reaches the user unless
// the surface that sent it shows it itself, or it answers a read. F5 (V2b): a Reject clicked after the plan moved on
// sends nothing. F6-F9 cover the minor items and V5, V11: activity-log replies, archived epics, one output channel and
// forms that keep their input while hidden. Runs the real MoeDaemonClient with a fake connected socket, the real panels
// over a fake panel API, and the raw media scripts against a minimal DOM. The harness is approval-paths.test.cjs's
// (tests share no helper module).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const file = relative => path.join(__dirname, '..', relative);
const transpile = relative => ts.transpileModule(fs.readFileSync(file(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

const SOURCES = {
    client: transpile('src/services/MoeDaemonClient.ts'),
    planReview: transpile('src/panels/PlanReviewPanel.ts'),
    taskDetail: transpile('src/panels/TaskDetailPanel.ts'),
    taskCreate: transpile('src/panels/TaskCreatePanel.ts'),
    epicDetail: transpile('src/panels/EpicDetailPanel.ts'),
    settings: transpile('src/panels/SettingsPanel.ts'),
};
const DETAIL_SCRIPT = fs.readFileSync(file('media/taskDetail.js'), 'utf8');
const REVIEW_SCRIPT = fs.readFileSync(file('media/planReview.js'), 'utf8');
const NOT_SENT = what => `Not connected to Moe daemon — ${what}.`;
const plain = value => JSON.parse(JSON.stringify(value));

const task = (overrides = {}) => ({
    id: 'task-1', epicId: 'epic-1', title: 'Plan me', description: '', definitionOfDone: [],
    status: 'AWAITING_APPROVAL', implementationPlan: [], comments: [], ...overrides
});
const epic = (overrides = {}) => ({ id: 'epic-1', title: 'Epic', description: '', status: 'ACTIVE', ...overrides });

/** vscode.EventEmitter stand-in whose listeners are observable and really removable. */
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

function runModule(name, source, dependencies, globals = {}) {
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
        ...globals,
        require: dep => {
            if (Object.prototype.hasOwnProperty.call(dependencies, dep)) { return dependencies[dep]; }
            throw new Error(`unexpected require from ${name}: ${dep}`);
        }
    });
    vm.runInContext(source, context, { filename: name });
    return module.exports;
}

/** The real client (on a fake socket) and panels; `h.drop()` and `h.connect()` take the socket away and back. */
function createHost() {
    const h = { frames: [], info: [], warnings: [], errors: [], channels: [], panels: [], warnChoice: undefined };
    h.inputBox = () => Promise.resolve(undefined);
    const fakeTimers = { setTimeout: () => 0, clearTimeout: () => {} }; // the panels' debounced refreshes never run
    const makePanel = (viewType, options) => {
        const panel = {
            viewType, options, handler: undefined, posted: [], disposed: 0, page: undefined,
            webview: {
                html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
                onDidReceiveMessage: fn => { panel.handler = fn; return { dispose() {} }; },
                postMessage: message => {
                    panel.posted.push(plain(message));
                    // Like the real webview bridge, delivery is asynchronous: the page's own handler finishes first.
                    if (panel.page) { setImmediate(() => panel.page.deliver(message)); }
                    return Promise.resolve(true);
                }
            },
            onDidDispose: () => ({ dispose() {} }),
            onDidChangeVisibility: () => ({ dispose() {} }),
            reveal() {},
            dispose() { panel.disposed++; }
        };
        h.panels.push(panel);
        return panel;
    };
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        window: {
            createOutputChannel: name => { h.channels.push(name); return { appendLine() {}, dispose() {} }; },
            createWebviewPanel: (viewType, _title, _column, options) => makePanel(viewType, options),
            showInformationMessage: message => { h.info.push(message); return Promise.resolve(undefined); },
            showWarningMessage: message => { h.warnings.push(message); return Promise.resolve(h.warnChoice); },
            showErrorMessage: message => { h.errors.push(message); return Promise.resolve(undefined); },
            showInputBox: () => h.inputBox()
        },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };

    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    h.clientModule = runModule('MoeDaemonClient.ts', SOURCES.client, {
        vscode, ws: StubWebSocket, fs, path, net,
        child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    });
    h.client = new h.clientModule.MoeDaemonClient('extension');
    h.connect = () => {
        h.client['ws'] = { readyState: 1, send: frame => h.frames.push(JSON.parse(frame)), close() {} };
        h.client['_connectionState'] = 'connected';
    };
    h.drop = () => { h.client['ws'] = undefined; h.client['_connectionState'] = 'disconnected'; };
    h.connect();
    h.deliver = frame => h.client['handleMessage'](JSON.stringify(frame));
    h.cache = (tasks, epics = [epic()]) => { h.client['state'] = { tasks, epics }; };
    h.settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); } };
    h.send = async (panel, message) => { await panel.handler(message); await h.settle(); };

    h.planReview = runModule('PlanReviewPanel.ts', SOURCES.planReview, { vscode }, fakeTimers);
    h.taskDetail = runModule('TaskDetailPanel.ts', SOURCES.taskDetail, { vscode, './PlanReviewPanel': h.planReview }, fakeTimers);
    h.taskCreate = runModule('TaskCreatePanel.ts', SOURCES.taskCreate, { vscode });
    h.epicDetail = runModule('EpicDetailPanel.ts', SOURCES.epicDetail, { vscode });
    h.settings = runModule('SettingsPanel.ts', SOURCES.settings, { vscode });
    h.openDetail = () => { h.taskDetail.TaskDetailPanel.createOrShow({ path: '/ext' }, h.client, 'task-1'); return h.panels.at(-1); };
    h.openReview = () => {
        h.planReview.PlanReviewPanel.createOrShow({ path: '/ext' }, h.client, 'task-1', h.client.currentState);
        return h.panels.at(-1);
    };
    return h;
}

// ===========================================================================
// F1-F3 (V1): a frame that never left is reported, and nothing typed is lost
// ===========================================================================

test('F1 the create, save, delete, comment, archive and activity-log wrappers say whether their frame left', () => {
    const calls = [
        ['updateTaskStatus', ['task-1', 'WORKING'], 'UPDATE_TASK'],
        ['createTask', ['epic-1', 'T', 'D', ['done'], 'HIGH'], 'CREATE_TASK'],
        ['updateTaskDetails', ['task-1', { title: 'T2' }], 'UPDATE_TASK'],
        ['deleteTask', ['task-1'], 'DELETE_TASK'],
        ['addTaskComment', ['task-1', 'hello'], 'ADD_TASK_COMMENT'],
        ['createEpic', ['E', 'D'], 'CREATE_EPIC'],
        ['deleteEpic', ['epic-1'], 'DELETE_EPIC'],
        ['archiveDoneTasks', ['epic-1'], 'ARCHIVE_DONE_TASKS'],
        ['requestActivityLog', [50], 'GET_ACTIVITY_LOG'],
    ];
    const h = createHost();
    for (const [method, args] of calls) { assert.equal(h.client[method](...args), true, `${method} while connected`); }
    assert.deepEqual(h.frames.map(frame => frame.type), calls.map(([, , type]) => type));
    h.frames.length = 0;
    h.drop();
    for (const [method, args] of calls) { assert.equal(h.client[method](...args), false, `${method} while disconnected`); }
    assert.deepEqual(h.frames, []);
});

test('F2 Create Task and Create Epic stay open with what was typed when nothing was sent, and close once it is', async () => {
    const h = createHost();
    h.cache([]);
    h.taskCreate.TaskCreatePanel.createOrShow({ path: '/ext' }, h.client, h.client.currentState);
    const createTask = h.panels.at(-1);
    h.epicDetail.EpicDetailPanel.createOrShow({ path: '/ext' }, h.client);
    const createEpic = h.panels.at(-1);
    const submit = { type: 'submit', epicId: 'epic-1', title: 'T', description: 'D', definitionOfDone: ['x'], priority: 'HIGH' };
    const create = { type: 'create', title: 'E', description: 'D' };

    h.drop();
    await h.send(createTask, submit);
    await h.send(createEpic, create);
    assert.deepEqual(h.warnings, [NOT_SENT('task was not created'), NOT_SENT('epic was not created')]);
    assert.deepEqual([h.info, h.frames, createTask.disposed, createEpic.disposed], [[], [], 0, 0]);
    assert.ok(h.taskCreate.TaskCreatePanel.currentPanel, 'Create Task is still the open form');

    h.connect();
    await h.send(createTask, submit);
    await h.send(createEpic, create);
    assert.deepEqual(h.frames.map(frame => frame.type), ['CREATE_TASK', 'CREATE_EPIC']);
    assert.deepEqual(h.info, ['Task "T" created.', 'Epic "E" created.']);
    assert.deepEqual([createTask.disposed, createEpic.disposed], [1, 1]);
});

test('F2 epic Delete, and task Save, Delete and Add Comment, say nothing was sent and keep their panel', async () => {
    const h = createHost();
    h.cache([task({ status: 'WORKING' })]);
    h.epicDetail.EpicDetailPanel.createOrShow({ path: '/ext' }, h.client, 'epic-1', h.client.currentState);
    const editEpic = h.panels.at(-1);
    const detail = h.openDetail();
    h.warnChoice = 'Delete';

    h.drop();
    await h.send(editEpic, { type: 'delete', epicId: 'epic-1' });
    await h.send(detail, { type: 'save', title: 'New title' });
    await h.send(detail, { type: 'delete' });
    await h.send(detail, { type: 'addComment', content: '  keep me  ' });
    assert.deepEqual(h.warnings, [
        'Are you sure you want to delete this epic? All tasks in this epic will also be deleted.', NOT_SENT('epic was not deleted'),
        NOT_SENT('task was not saved'), 'Delete this task? This cannot be undone.', NOT_SENT('task was not deleted'),
        NOT_SENT('comment was not added')
    ]);
    assert.deepEqual([h.info, h.frames, editEpic.disposed, detail.disposed], [[], [], 0, 0]);
    assert.deepEqual(detail.posted.filter(message => message.type === 'commentNotSent'), [{ type: 'commentNotSent', content: 'keep me' }]);

    h.connect();
    await h.send(detail, { type: 'save', title: 'New title' });
    await h.send(detail, { type: 'addComment', content: 'sent' });
    await h.send(detail, { type: 'delete' });
    await h.send(editEpic, { type: 'delete', epicId: 'epic-1' });
    assert.deepEqual(h.frames.map(frame => frame.type), ['UPDATE_TASK', 'ADD_TASK_COMMENT', 'DELETE_TASK', 'DELETE_EPIC']);
    assert.deepEqual(h.info, ['Task saved', 'Task deleted', 'Epic deleted.']);
    assert.deepEqual([detail.disposed, editEpic.disposed], [1, 1]);
    assert.equal(detail.posted.filter(message => message.type === 'commentNotSent').length, 1, 'a sent comment is not handed back');
});

/** A webview page built from the panel's HTML: every element with an id, its attributes, value and data-* set. */
function loadPage(html, script, post) {
    const tags = new Map();
    for (const match of html.matchAll(/<[a-z]+\b[^>]*\sid="([^"]+)"[^>]*>/g)) { tags.set(match[1], match[0]); }
    const makeNode = (tag, id) => {
        const classes = new Set();
        const attributes = {};
        for (const [, name, value] of tag.matchAll(/\s([a-z][a-z-]*)="([^"]*)"/g)) { attributes[name] = value; }
        const dataset = {};
        for (const [name, value] of Object.entries(attributes)) {
            if (name.startsWith('data-')) { dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
        }
        const node = {
            id, dataset, style: {}, children: [], listeners: {}, className: '', text: '', innerHTML: '',
            value: attributes.value ?? '', disabled: /\sdisabled(?=[\s/>=])/.test(tag), scrollTop: 0, scrollHeight: 0,
            classList: {
                add: name => { classes.add(name); }, remove: name => { classes.delete(name); }, contains: name => classes.has(name),
                toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : !!force; if (on) { classes.add(name); } else { classes.delete(name); } return on; }
            },
            appendChild(child) { node.children.push(child); return child; },
            addEventListener(type, handler) { (node.listeners[type] = node.listeners[type] || []).push(handler); },
            getAttribute: name => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null),
            setAttribute: (name, value) => { attributes[name] = String(value); }
        };
        Object.defineProperty(node, 'textContent', {
            get: () => (node.children.length > 0 ? node.children.map(child => child.textContent).join('') : node.text),
            set: value => { node.children = []; node.text = String(value); }
        });
        return node;
    };
    const nodes = new Map();
    const element = id => {
        if (!tags.has(id)) { return null; }
        if (!nodes.has(id)) { nodes.set(id, makeNode(tags.get(id), id)); }
        return nodes.get(id);
    };
    let onMessage;
    const context = vm.createContext({
        console,
        acquireVsCodeApi: () => ({ postMessage: message => post(plain(message)), getState: () => undefined, setState() {} }),
        document: {
            getElementById: element,
            createElement: tag => makeNode(`<${tag}>`, null),
            createTextNode: value => { const text = makeNode('<#text>', null); text.textContent = value; return text; },
            addEventListener() {}, body: { addEventListener() {} }
        },
        window: { addEventListener: (type, handler) => { if (type === 'message') { onMessage = handler; } } },
        setTimeout: () => 0, clearTimeout() {}
    });
    vm.runInContext(script, context);
    return {
        element,
        click: id => { for (const handler of element(id).listeners.click || []) { handler({ preventDefault() {}, stopPropagation() {} }); } },
        deliver: message => onMessage({ data: message })
    };
}

for (const [kind, script] of [['detail', DETAIL_SCRIPT], ['review', REVIEW_SCRIPT]]) {
    test(`F3 ${kind} page: a comment that never left goes back into an empty comment box, never over newer text`, async () => {
        const h = createHost();
        h.cache([task()]);
        const panel = kind === 'detail' ? h.openDetail() : h.openReview();
        const page = panel.page = loadPage(panel.webview.html, script, message => { setImmediate(() => panel.handler(message)); });
        const input = page.element('commentInput');
        h.drop();
        input.value = '  first thought  ';
        page.click('askBtn');
        await h.settle();
        assert.deepEqual(h.warnings, [NOT_SENT('comment was not added')]);
        assert.equal(input.value, 'first thought', 'the unsent comment is back in the box');

        input.value = 'typed since';
        page.deliver({ type: 'commentNotSent', content: 'first thought' });
        assert.equal(input.value, 'typed since', 'newer text is never overwritten');

        h.connect();
        input.value = 'sent';
        page.click('askBtn');
        await h.settle();
        assert.deepEqual(h.frames.map(frame => [frame.type, frame.payload.content]), [['ADD_TASK_COMMENT', 'sent']]);
        assert.equal(input.value, '', 'a sent comment leaves the box empty');
    });
}

// ===========================================================================
// F4 (V2): refusals reach the user
// ===========================================================================

test('F4 a daemon refusal reaches the user, unless the surface that sent it says it or it answers a read', () => {
    const h = createHost();
    const notice = h.clientModule.daemonErrorNotice;
    const table = [
        ['UPDATE_TASK', 'Column WORKING is at its WIP limit of 2', 'Moe: UPDATE_TASK failed: Column WORKING is at its WIP limit of 2'],
        ['CREATE_TASK', 'Epic is ARCHIVED', 'Moe: CREATE_TASK failed: Epic is ARCHIVED'],
        ['REJECT_TASK', 'Cannot reject task in WORKING status', 'Moe: REJECT_TASK failed: Cannot reject task in WORKING status'],
        ['APPROVE_TASK', 'stale plan', undefined], // the approving surface shows its own refusal
        ['RELEASE_TASK', 'not assigned', undefined],
        ['UPDATE_EPIC', 'archived', undefined],
        ['GET_ACTIVITY_LOG', 'unreadable', undefined], // reads change nothing; their views retry
        ['GET_EXECUTION_READINESS', 'no project', undefined],
        [undefined, 'boom', 'Moe: boom'],
        ['', 'boom', 'Moe: boom'],
        [undefined, 'Unknown message type: NEW_FRAME', undefined], // an older daemon's answer to a newer frame
    ];
    for (const [operation, message, expected] of table) { assert.equal(notice(operation, message), expected, `${operation}: ${message}`); }

    h.deliver({ type: 'ERROR', operation: 'UPDATE_TASK', message: 'Column WORKING is at its WIP limit of 2' });
    h.deliver({ type: 'ERROR', payload: { operation: 'DELETE_TASK', message: 'Task not found' } }); // the older nested shape
    h.deliver({ type: 'ERROR', operation: 'APPROVE_TASK', message: 'stale plan' });
    h.deliver({ type: 'ERROR', operation: 'GET_EXECUTION_READINESS', message: 'no project' });
    h.deliver({ type: 'ERROR', message: 'Unknown message type: NEW_FRAME' });
    assert.deepEqual(h.errors, ['Moe: UPDATE_TASK failed: Column WORKING is at its WIP limit of 2', 'Moe: DELETE_TASK failed: Task not found']);
});

// ===========================================================================
// F5 (V2b): a stale Reject sends nothing
// ===========================================================================

for (const kind of ['detail', 'review']) {
    test(`F5 ${kind}: Reject on a plan that moved on sends nothing and says so, before the prompt and while it is open`, async () => {
        const rejected = kind === 'detail' ? 'Task rejected' : 'Plan rejected';
        const open = h => (kind === 'detail' ? h.openDetail() : h.openReview());

        let h = createHost();
        h.cache([task()]);
        let panel = open(h);
        h.cache([task({ status: 'WORKING' })]); // approved elsewhere: the board, SPEED mode or the other IDE
        let prompts = 0;
        h.inputBox = () => { prompts++; return Promise.resolve('no'); };
        await h.send(panel, { type: 'promptReject' });
        assert.deepEqual([prompts, h.frames, h.warnings, h.info], [0, [], [h.planReview.STALE_REJECT], []]);

        h = createHost();
        h.cache([task()]);
        panel = open(h);
        h.inputBox = () => { h.cache([task({ status: 'WORKING' })]); return Promise.resolve('no'); };
        await h.send(panel, { type: 'promptReject' });
        assert.deepEqual([h.frames, h.warnings, h.info], [[], [h.planReview.STALE_REJECT], []]);

        h = createHost();
        h.cache([task()]);
        panel = open(h);
        h.inputBox = () => Promise.resolve('no');
        await h.send(panel, { type: 'promptReject' });
        assert.deepEqual(h.frames, [{ type: 'REJECT_TASK', payload: { taskId: 'task-1', reason: 'no' } }]);
        assert.deepEqual([h.warnings, h.info], [[], [rejected]]);
    });
}

test('F5 review: a Reject that carries its reason is judged the same way', async () => {
    const h = createHost();
    h.cache([task()]);
    const panel = h.openReview();
    h.cache([task({ status: 'WORKING' })]);
    await h.send(panel, { type: 'reject', reason: 'no' });
    assert.deepEqual([h.frames, h.warnings, h.info], [[], [h.planReview.STALE_REJECT], []]);
    h.cache([task()]);
    await h.send(panel, { type: 'reject', reason: 'no' });
    assert.deepEqual([h.frames.map(frame => frame.type), h.info], [['REJECT_TASK'], ['Plan rejected']]);
});

// ===========================================================================
// F6-F9: the minor items, V5 and V11
// ===========================================================================

test('F6 each activity-log reply answers the request it belongs to; a refusal or a dropped socket answers none', () => {
    const h = createHost();
    const board = [], mine = [], late = [], lost = [];
    h.client.onActivityLog(events => board.push(plain(events)));
    h.client.requestActivityLog(50, events => mine.push(plain(events)));
    h.client.requestActivityLog(); // a view's own request, answered through onActivityLog
    h.client.requestActivityLog(10, events => late.push(events));
    h.deliver({ type: 'ACTIVITY_LOG', payload: [{ id: 1 }] });
    h.deliver({ type: 'ACTIVITY_LOG', payload: [{ id: 2 }] });
    h.deliver({ type: 'ERROR', operation: 'GET_ACTIVITY_LOG', message: 'log unreadable' });
    assert.deepEqual([mine, board, late], [[[{ id: 1 }]], [[{ id: 2 }]], [undefined]]);
    assert.deepEqual(h.frames.map(frame => frame.payload), [{ limit: 50 }, {}, { limit: 10 }]);

    h.client.requestActivityLog(5, events => lost.push(events));
    h.client['setConnectionState']('disconnected'); // its socket closed before the reply
    h.drop();
    assert.equal(h.client.requestActivityLog(5, events => lost.push(events)), false, 'unsent, so nothing waits for it');
    h.connect();
    h.deliver({ type: 'ACTIVITY_LOG', payload: [{ id: 3 }] });
    assert.deepEqual([lost, board], [[], [[{ id: 2 }], [{ id: 3 }]]]);
    assert.deepEqual(h.errors, [], 'a refused read raises no notice');
});

test('F7 an epic archived during the session leaves the cache, as the next snapshot would leave it out', () => {
    const h = createHost();
    h.deliver({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p', rootPath: '/p', settings: {} }, tasks: [], epics: [epic({ id: 'e1' }), epic({ id: 'e2' })] } });
    h.deliver({ type: 'EPIC_UPDATED', payload: epic({ id: 'e1', status: 'ARCHIVED' }) });
    h.deliver({ type: 'EPIC_CREATED', payload: epic({ id: 'e3', status: 'ARCHIVED' }) });
    h.deliver({ type: 'EPIC_UPDATED', payload: epic({ id: 'e2', title: 'Renamed' }) });
    h.deliver({ type: 'EPIC_CREATED', payload: epic({ id: 'e4' }) });
    assert.deepEqual(plain(h.client.currentState.epics.map(e => [e.id, e.title])), [['e2', 'Renamed'], ['e4', 'Epic']]);
});

test('F8 the extension and the daemon client write to one "Moe" output channel', () => {
    const h = createHost();
    const { getOutputChannel } = h.clientModule;
    assert.equal(getOutputChannel(), getOutputChannel());
    assert.deepEqual(h.channels, ['Moe']);
    const extension = fs.readFileSync(file('src/extension.ts'), 'utf8');
    assert.doesNotMatch(extension, /createOutputChannel\(/, 'extension.ts opens no channel of its own');
    assert.match(extension, /const outputChannel = getOutputChannel\(\);/);
});

test('F9 Create Task, the epic forms and Settings keep what was typed while their tab is hidden', () => {
    const h = createHost();
    h.cache([]);
    h.taskCreate.TaskCreatePanel.createOrShow({ path: '/ext' }, h.client, h.client.currentState);
    h.epicDetail.EpicDetailPanel.createOrShow({ path: '/ext' }, h.client);
    h.epicDetail.EpicDetailPanel.createOrShow({ path: '/ext' }, h.client, 'epic-1', h.client.currentState);
    h.settings.SettingsPanel.createOrShow({ path: '/ext' }, h.client, h.client.currentState);
    assert.deepEqual(h.panels.map(panel => [panel.viewType, panel.options.retainContextWhenHidden]),
        [['moe.createTask', true], ['moe.epicDetail', true], ['moe.epicDetail', true], ['moe.settings', true]]);
});

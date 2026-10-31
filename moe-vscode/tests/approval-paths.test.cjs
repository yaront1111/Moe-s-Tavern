'use strict';

// Every VS Code approval path sends the plan revision its webview RENDERED
// (CQ-F04d). Revision-less human approval was deleted by CQ-F MODIFY_RAIL
// prop-5e7763ed, so no gesture may approve token-free, and no token may come
// from the client's cached state at click time.
//
// Everything here runs the production files: media/board.js and
// media/taskDetail.js raw under node:vm, and TaskDetailPanel, PlanReviewPanel,
// BoardViewProvider and the real MoeDaemonClient transpiled under node:vm. The
// client gets a fake connected socket, so assertions read the exact frames that
// reach the wire. The harness owns only the environment.

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
    provider: transpile('src/providers/BoardViewProvider.ts'),
};
const BOARD_SCRIPT = fs.readFileSync(file('media/board.js'), 'utf8');
const DETAIL_SCRIPT = fs.readFileSync(file('media/taskDetail.js'), 'utf8');

const OPEN_PLAN_REVIEW = 'Open Plan Review';
const MALFORMED_REVISIONS = [['a numeric string', '4'], ['null', null], ['a negative', -1], ['a fraction', 2.5]];

// A test-realm copy of a vm-realm object, so strict deep equality compares
// values rather than realms. Own keys holding undefined survive the copy.
const plain = value => ({ ...value });

const task = (overrides = {}) => ({
    id: 'task-1', epicId: 'epic-1', title: 'Plan me', description: '', definitionOfDone: [],
    status: 'AWAITING_APPROVAL', implementationPlan: [], comments: [], ...overrides
});

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

// ===========================================================================
// Extension-host harness: real client, panels and provider
// ===========================================================================

function createHost() {
    const h = { frames: [], info: [], warnings: [], errors: [], warnChoice: undefined, panels: [] };
    const timers = new Map();
    let nextTimer = 1;
    const fakeTimers = {
        setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearTimeout: id => { timers.delete(id); }
    };
    h.flushTimers = () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); };
    h.settle = () => new Promise(resolve => setImmediate(resolve));

    const makePanel = viewType => {
        const panel = {
            viewType, handler: undefined, posted: [], visible: true,
            webview: {
                html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
                onDidReceiveMessage: fn => { panel.handler = fn; return { dispose() {} }; },
                postMessage: message => { panel.posted.push(message); return Promise.resolve(true); }
            },
            onDidDispose: () => ({ dispose() {} }),
            onDidChangeVisibility: () => ({ dispose() {} }),
            reveal() {}, dispose() {}
        };
        h.panels.push(panel);
        return panel;
    };
    h.makePanel = makePanel;

    const vscode = {
        EventEmitter: RecordingEventEmitter,
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createWebviewPanel: viewType => makePanel(viewType),
            showInformationMessage: message => { h.info.push(message); return Promise.resolve(undefined); },
            showWarningMessage: (message, ...items) => { h.warnings.push({ message, items }); return Promise.resolve(h.warnChoice); },
            showErrorMessage: message => { h.errors.push(message); return Promise.resolve(undefined); }
        },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };

    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    const { MoeDaemonClient } = runModule('MoeDaemonClient.ts', SOURCES.client, {
        vscode, ws: StubWebSocket, fs, path, net,
        child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    });
    h.client = new MoeDaemonClient('extension');
    h.client['ws'] = { readyState: 1, send: frame => h.frames.push(JSON.parse(frame)), close() {} };
    h.client['_connectionState'] = 'connected';

    h.planReview = runModule('PlanReviewPanel.ts', SOURCES.planReview, { vscode }, fakeTimers);
    h.taskDetail = runModule('TaskDetailPanel.ts', SOURCES.taskDetail,
        { vscode, './PlanReviewPanel': h.planReview }, fakeTimers);
    h.provider = runModule('BoardViewProvider.ts', SOURCES.provider, {
        vscode, '../panels/PlanReviewPanel': h.planReview, '../panels/TaskDetailPanel': h.taskDetail,
        '../panels/EpicDetailPanel': {}, '../panels/TaskCreatePanel': {}
    }, fakeTimers);

    /** What the client has cached: the NEWEST state, which is not what was reviewed. */
    h.cache = tasks => { h.client['state'] = { tasks, epics: [] }; };
    h.fireState = () => h.client['_onStateChanged'].fire(h.client['state']);
    h.fireError = event => h.client['_onError'].fire(event);
    h.errorListeners = () => h.client['_onError'].listeners.length;
    h.refusals = () => h.warnings.filter(w => /^Plan approval refused/.test(w.message));
    h.openPlanReviews = () => h.panels.filter(p => p.viewType === 'moe.planReview');
    return h;
}

function openDetail(h, cached) {
    h.cache([cached]);
    const instance = h.taskDetail.TaskDetailPanel.createOrShow({ path: '/ext' }, h.client, cached.id, h.client.currentState);
    const panel = h.panels[h.panels.length - 1];
    return { instance, panel, send: message => panel.handler(message) };
}

function openBoard(h, cachedTasks) {
    h.cache(cachedTasks);
    const provider = new h.provider.BoardViewProvider({ path: '/ext' }, h.client);
    const view = h.makePanel('moe.board');
    provider.resolveWebviewView(view, {}, {});
    return { provider, send: message => view.handler(message) };
}

// ===========================================================================
// Webview harnesses: raw media scripts against a minimal DOM
// ===========================================================================

function makeNode(tagName, id) {
    const node = {
        tagName, id, className: '', value: '', text: '', scrollTop: 0, scrollHeight: 0, dataset: {}, style: {},
        children: [], listeners: {},
        appendChild(child) { node.children.push(child); return child; },
        addEventListener(type, handler) { (node.listeners[type] = node.listeners[type] || []).push(handler); },
        setAttribute() {},
        click() { (node.listeners.click || []).forEach(handler => handler({ stopPropagation() {} })); }
    };
    Object.defineProperty(node, 'textContent', {
        get: () => (node.children.length > 0 ? node.children.map(child => child.textContent).join('') : node.text),
        set: value => { node.children = []; node.text = String(value); }
    });
    return node;
}

/** The #initial-data attributes the panel actually emitted, as a DOM dataset. */
function initialDataset(html) {
    const tag = /<div id="initial-data"[^>]*>/.exec(html);
    assert.ok(tag, 'the detail markup has no #initial-data element');
    const dataset = {};
    for (const [, name, value] of tag[0].matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) {
        dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    return dataset;
}

/** Load media/taskDetail.js on a page seeded from the HTML the panel rendered. */
function loadDetailPage(html) {
    const nodes = {};
    const element = id => (nodes[id] = nodes[id] || makeNode('div', id));
    element('initial-data').dataset = initialDataset(html);
    const posted = [];
    let onMessage;
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage: message => posted.push(plain(message)) }),
        document: {
            getElementById: element,
            createElement: tag => makeNode(tag, null),
            createTextNode: value => { const n = makeNode('#text', null); n.textContent = value; return n; }
        },
        window: { addEventListener: (type, handler) => { if (type === 'message') { onMessage = handler; } } },
        console
    });
    vm.runInContext(DETAIL_SCRIPT, context, { filename: 'taskDetail.js' });
    return {
        posted,
        click: id => element(id).click(),
        update: updated => onMessage({ data: { type: 'updateTask', task: updated } })
    };
}

/** Load media/board.js and hand it the state it renders (currentState). */
function loadBoard(tasks) {
    const posted = [];
    const clears = [];
    const ignore = () => {};
    const element = () => ({ addEventListener: ignore });
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => undefined, setState: ignore, postMessage: message => posted.push(plain(message)) }),
        document: { addEventListener: ignore, body: { addEventListener: ignore }, getElementById: element },
        window: { addEventListener: ignore },
        setInterval: (fn, ms) => { const t = setInterval(fn, ms); clears.push(() => clearInterval(t)); return t; },
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); clears.push(() => clearTimeout(t)); return t; },
        clearInterval, clearTimeout, console
    });
    vm.runInContext(BOARD_SCRIPT, context, { filename: 'board.js' });
    clears.forEach(clear => clear());
    // currentState and the drag ids are script-scope bindings of board.js; set
    // them the way its own message and dragstart handlers do.
    context.renderedTasks = tasks;
    vm.runInContext('currentState = { tasks: renderedTasks, epics: [] };', context);
    posted.length = 0;
    const event = { preventDefault() {}, stopPropagation() {} };
    return {
        posted,
        next: id => context.navTask(event, id, 'next'),
        dropCard: (id, column) => { context.dragId = id; vm.runInContext('draggedTaskId = dragId; draggedEpicId = null;', context); context.onDrop(event, column); },
        dropEpic: (epicId, column) => { context.dragId = epicId; vm.runInContext('draggedEpicId = dragId; draggedTaskId = null;', context); context.onDrop(event, column); }
    };
}

const APPROVE = (taskId, expectedPlanRevision) => ({ type: 'APPROVE_TASK', payload: { taskId, expectedPlanRevision } });

// ===========================================================================
// board.js — every approving gesture carries the card's rendered revision
// ===========================================================================

test('board: Next on an awaiting card posts approveTask with its rendered revision', () => {
    const board = loadBoard([task({ planRevision: 7 })]);
    board.next('task-1');
    assert.deepEqual(board.posted, [{ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 7 }]);
});

test('board: dropping an awaiting card on Working approves instead of updating status', () => {
    const board = loadBoard([task({ planRevision: 7 })]);
    board.dropCard('task-1', 'WORKING');
    assert.deepEqual(board.posted, [{ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 7 }]);
});

test('board: an epic sweep to Working approves awaiting cards, moves the rest and skips BLOCKED', () => {
    const board = loadBoard([
        task({ id: 'a', planRevision: 3 }),
        task({ id: 'p', status: 'PLANNING' }),
        task({ id: 'b', status: 'BLOCKED' }),
        task({ id: 'w', status: 'WORKING' }),
        task({ id: 'other', epicId: 'epic-2', planRevision: 1 })
    ]);
    board.dropEpic('epic-1', 'WORKING');
    assert.deepEqual(board.posted, [
        { type: 'approveTask', taskId: 'a', expectedPlanRevision: 3 },
        { type: 'updateTaskStatus', taskId: 'p', status: 'WORKING' }
    ]);
});

test('board: an absent revision is the legacy 0, a malformed one is no token at all', () => {
    const board = loadBoard([task({ id: 'legacy' }), ...MALFORMED_REVISIONS.map(([, rev], i) => task({ id: `bad-${i}`, planRevision: rev }))]);
    board.next('legacy');
    MALFORMED_REVISIONS.forEach((_, i) => board.dropCard(`bad-${i}`, 'WORKING'));
    assert.deepEqual(board.posted[0], { type: 'approveTask', taskId: 'legacy', expectedPlanRevision: 0 });
    for (const message of board.posted.slice(1)) {
        assert.equal(message.type, 'approveTask');
        assert.ok(Object.prototype.hasOwnProperty.call(message, 'expectedPlanRevision'));
        assert.equal(message.expectedPlanRevision, undefined);
    }
    assert.equal(board.posted.length, 1 + MALFORMED_REVISIONS.length);
});

test('board: moves that are not approvals keep their plain status update', () => {
    const board = loadBoard([task({ id: 'p', status: 'PLANNING' }), task({ id: 'a', planRevision: 2 })]);
    board.next('p');
    board.dropCard('a', 'PLANNING');
    assert.deepEqual(board.posted, [
        { type: 'updateTaskStatus', taskId: 'p', status: 'AWAITING_APPROVAL' },
        { type: 'updateTaskStatus', taskId: 'a', status: 'PLANNING' }
    ]);
});

// ===========================================================================
// BoardViewProvider — forwards the rendered token, guards and correlates
// ===========================================================================

test('provider: a board approval reaches the wire with the rendered token, not the newer cached one', () => {
    const h = createHost();
    const board = loadBoard([task({ planRevision: 4 })]);
    const { provider, send } = openBoard(h, [task({ planRevision: 9 })]);
    try {
        board.next('task-1');
        send(board.posted[0]);
        assert.deepEqual(h.frames, [APPROVE('task-1', 4)]);
    } finally { provider.dispose(); }
});

test('provider: a token-free AWAITING_APPROVAL -> WORKING status update sends nothing and warns', async () => {
    const h = createHost();
    const { provider, send } = openBoard(h, [task({ planRevision: 9 })]);
    try {
        send({ type: 'updateTaskStatus', taskId: 'task-1', status: 'WORKING' });
        await h.settle();
        assert.deepEqual(h.frames, []);
        assert.equal(h.refusals().length, 1);
        assert.deepEqual(h.refusals()[0].items, [OPEN_PLAN_REVIEW]);
        send({ type: 'updateTaskStatus', taskId: 'task-1', status: 'PLANNING' });
        assert.deepEqual(h.frames, [{ type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { status: 'PLANNING' } } }]);
    } finally { provider.dispose(); }
});

test('provider: a local undefined-token refusal is visible, sends nothing and offers the review', async () => {
    const h = createHost();
    h.warnChoice = OPEN_PLAN_REVIEW;
    const { provider, send } = openBoard(h, [task({ planRevision: 9 })]);
    try {
        send({ type: 'approveTask', taskId: 'task-1' });
        await h.settle();
        assert.deepEqual(h.frames, []);
        assert.equal(h.refusals().length, 1, 'exactly one refusal warning');
        assert.equal(h.warnings.length, 1, 'no extra not-connected warning');
        assert.equal(h.openPlanReviews().length, 1, 'the action opens the plan review');
    } finally {
        provider.dispose();
        h.planReview.PlanReviewPanel['currentPanels'].get('task-1')?.dispose();
    }
});

test('provider: only refusals of its own pending approvals are toasted, once', async () => {
    const h = createHost();
    const { provider, send } = openBoard(h, [task({ planRevision: 4 }), task({ id: 'task-2', planRevision: 1 })]);
    const stale = taskId => ({ operation: 'APPROVE_TASK', message: 'stale', codeName: 'PLAN_REVISION_MISMATCH', context: { taskId } });
    try {
        h.fireError(stale('task-1'));
        send({ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 4 });
        h.fireError(stale('task-2'));
        h.fireError({ operation: 'REJECT_TASK', message: 'x', context: { taskId: 'task-1' } });
        await h.settle();
        assert.equal(h.refusals().length, 0, 'not ours: never sent, other task, other operation');
        h.fireError(stale('task-1'));
        h.fireError(stale('task-1'));
        await h.settle();
        assert.equal(h.refusals().length, 1);
        assert.match(h.refusals()[0].message, /plan changed/);
        assert.equal(provider['pendingApprovals'].size, 0);
    } finally { provider.dispose(); }
});

test('provider: a pending approval is forgotten once its task leaves AWAITING_APPROVAL', async () => {
    const h = createHost();
    const { provider, send } = openBoard(h, [task({ planRevision: 4 })]);
    try {
        send({ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 4 });
        assert.equal(provider['pendingApprovals'].size, 1);
        h.cache([task({ status: 'WORKING', planRevision: 4 })]);
        h.fireState();
        assert.equal(provider['pendingApprovals'].size, 0);
        h.fireError({ operation: 'APPROVE_TASK', message: 'late', context: { taskId: 'task-1' } });
        await h.settle();
        assert.equal(h.refusals().length, 0);
    } finally { provider.dispose(); }
});

test('provider: a refusal an open review already reports is not toasted again', async () => {
    const h = createHost();
    const { provider, send } = openBoard(h, [task({ planRevision: 4 })]);
    const review = h.planReview.PlanReviewPanel.createOrShow({ path: '/ext' }, h.client, 'task-1', h.client.currentState);
    try {
        send({ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 4 });
        h.fireError({ operation: 'APPROVE_TASK', message: 'stale', codeName: 'PLAN_REVISION_MISMATCH', context: { taskId: 'task-1' } });
        await h.settle();
        assert.equal(h.refusals().length, 0);
        assert.equal(h.errors.length, 1, 'the open review reports it once');
        assert.equal(provider['pendingApprovals'].size, 0);
    } finally { review.dispose(); provider.dispose(); }
});

test('provider: a dropped connection forgets every pending approval', () => {
    const h = createHost();
    const { provider, send } = openBoard(h, [task({ planRevision: 4 })]);
    try {
        send({ type: 'approveTask', taskId: 'task-1', expectedPlanRevision: 4 });
        assert.equal(provider['pendingApprovals'].size, 1);
        h.client['_onConnectionChanged'].fire('disconnected');
        assert.equal(provider['pendingApprovals'].size, 0);
    } finally { provider.dispose(); }
});

test('provider: dispose unsubscribes its error listener', () => {
    const h = createHost();
    const before = h.errorListeners();
    const { provider } = openBoard(h, []);
    assert.equal(h.errorListeners(), before + 1);
    provider.dispose();
    assert.equal(h.errorListeners(), before);
});

// ===========================================================================
// taskDetail.js + TaskDetailPanel — the detail page's rendered revision
// ===========================================================================

test('detail page: Approve and Next post the revision the panel rendered', () => {
    const h = createHost();
    const { instance, panel } = openDetail(h, task({ planRevision: 4 }));
    try {
        const page = loadDetailPage(panel.webview.html);
        page.click('approveBtn');
        page.click('nextBtn');
        assert.deepEqual(page.posted, [
            { type: 'approve', expectedPlanRevision: 4 },
            { type: 'next', currentStatus: 'AWAITING_APPROVAL', expectedPlanRevision: 4 }
        ]);
    } finally { instance.dispose(); }
});

test('detail page: an absent revision renders 0 and a malformed one renders no token', () => {
    for (const [cached, expected] of [[task(), 0], [task({ planRevision: '4' }), undefined]]) {
        const h = createHost();
        const { instance, panel } = openDetail(h, cached);
        try {
            const page = loadDetailPage(panel.webview.html);
            page.click('approveBtn');
            assert.equal(page.posted.length, 1);
            assert.ok(Object.prototype.hasOwnProperty.call(page.posted[0], 'expectedPlanRevision'));
            assert.equal(page.posted[0].expectedPlanRevision, expected);
        } finally { instance.dispose(); }
    }
});

test('detail page: a live update rebinds the token to the plan now on screen', () => {
    const h = createHost();
    const { instance, panel } = openDetail(h, task({ planRevision: 4 }));
    try {
        const page = loadDetailPage(panel.webview.html);
        page.update(task({ planRevision: 5 }));
        page.click('approveBtn');
        page.update(task({ status: 'WORKING', planRevision: 5 }));
        page.click('approveBtn');
        assert.deepEqual(page.posted, [
            { type: 'approve', expectedPlanRevision: 5 },
            { type: 'approve', expectedPlanRevision: undefined }
        ]);
    } finally { instance.dispose(); }
});

test('detail panel: Approve and Next forward the page token, not the newer cached one', () => {
    const h = createHost();
    const { instance, panel, send } = openDetail(h, task({ planRevision: 4 }));
    try {
        const page = loadDetailPage(panel.webview.html);
        h.cache([task({ planRevision: 9 })]);
        page.click('approveBtn');
        page.click('nextBtn');
        page.posted.forEach(send);
        assert.deepEqual(h.frames, [APPROVE('task-1', 4), APPROVE('task-1', 4)]);
        assert.ok(h.frames.every(frame => frame.type !== 'UPDATE_TASK'));
    } finally { instance.dispose(); }
});

test('detail panel: a local undefined-token refusal is visible, sends nothing and is not toasted twice', async () => {
    const h = createHost();
    const { instance, send } = openDetail(h, task({ planRevision: 9 }));
    try {
        await send({ type: 'approve' });
        await send({ type: 'next', currentStatus: 'AWAITING_APPROVAL' });
        await h.settle();
        assert.deepEqual(h.frames, []);
        assert.equal(h.refusals().length, 2, 'Approve and Next are each refused visibly');
        assert.equal(h.warnings.length, 2, 'no not-connected warning on a refusal');
        assert.deepEqual(h.info, []);

        h.warnChoice = OPEN_PLAN_REVIEW;
        await send({ type: 'approve' });
        await h.settle();
        assert.equal(h.openPlanReviews().length, 1, 'the action opens the plan review');
        await send({ type: 'approve' });
        await h.settle();
        assert.equal(h.refusals().length, 3, 'with the review open, the review reports it instead');
        assert.equal(h.errors.length, 1);
        assert.match(h.errors[0], /^Plan approval failed/);
    } finally {
        instance.dispose();
        h.planReview.PlanReviewPanel['currentPanels'].get('task-1')?.dispose();
    }
});

test('detail panel: a dropped connection forgets the pending approval', async () => {
    const h = createHost();
    const { instance, send } = openDetail(h, task({ planRevision: 4 }));
    try {
        await send({ type: 'approve', expectedPlanRevision: 4 });
        h.client['_onConnectionChanged'].fire('disconnected');
        h.fireError({ operation: 'APPROVE_TASK', message: 'late', context: { taskId: 'task-1' } });
        await h.settle();
        assert.equal(h.refusals().length, 0);
    } finally { instance.dispose(); }
});

test('detail panel: only its own pending approval is toasted, and only until the task moves on', async () => {
    const h = createHost();
    const { instance, send } = openDetail(h, task({ planRevision: 4 }));
    const refuse = taskId => h.fireError({ operation: 'APPROVE_TASK', message: 'no', context: { taskId } });
    try {
        refuse('task-1');
        await send({ type: 'approve', expectedPlanRevision: 4 });
        refuse('task-2');
        await h.settle();
        assert.equal(h.refusals().length, 0);
        refuse('task-1');
        refuse('task-1');
        await h.settle();
        assert.equal(h.refusals().length, 1);

        await send({ type: 'approve', expectedPlanRevision: 4 });
        h.cache([task({ status: 'WORKING', planRevision: 4 })]);
        h.fireState();
        h.flushTimers();
        refuse('task-1');
        await h.settle();
        assert.equal(h.refusals().length, 1, 'a task that left AWAITING_APPROVAL has nothing pending');
    } finally { instance.dispose(); }
});

test('detail panel: a disconnected approval says so and dispose unsubscribes', async () => {
    const h = createHost();
    const before = h.errorListeners();
    const { instance, send } = openDetail(h, task({ planRevision: 4 }));
    assert.equal(h.errorListeners(), before + 1);
    h.client['_connectionState'] = 'disconnected';
    await send({ type: 'approve', expectedPlanRevision: 4 });
    assert.deepEqual(h.frames, []);
    assert.deepEqual(h.warnings.map(w => w.message), ['Not connected to Moe daemon — task was not approved.']);
    instance.dispose();
    assert.equal(h.errorListeners(), before);
});

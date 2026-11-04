'use strict';

// The board's left arrow and Task Detail's Previous ask only for moves the
// daemon accepts (twin of JetBrains BoardMoves.previous, task-e44a8daf), and
// the reopen reason is asked host-side: the webview sandbox has no
// allow-modals, so a webview prompt() answers null (task-3ab5be0d).
// Production files run as in approval-paths.test.cjs: media/board.js raw under
// node:vm, and the real client, provider and panel transpiled under node:vm.

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

// packages/moe-daemon/src/tools/setTaskStatus.ts VALID_TRANSITIONS, read from the source.
const VALID = (() => {
    const src = fs.readFileSync(file('../packages/moe-daemon/src/tools/setTaskStatus.ts'), 'utf8');
    const table = /VALID_TRANSITIONS[^{]*\{([\s\S]*?)\n\};/.exec(src);
    assert.ok(table, 'VALID_TRANSITIONS not found in setTaskStatus.ts');
    const map = {};
    for (const [, from, to] of table[1].matchAll(/^\s*([A-Z_]+):\s*\[([^\]]*)\]/gm)) {
        map[from] = [...to.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
    }
    assert.ok(map.WORKING && map.WORKING.length > 0, 'VALID_TRANSITIONS parsed empty');
    return map;
})();

const STATUSES = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE', 'BLOCKED', 'ARCHIVED', 'BOGUS'];
const plain = value => JSON.parse(JSON.stringify(value));
const task = (status, overrides = {}) => ({
    id: 'task-' + status.toLowerCase(), epicId: 'epic-1', title: 'T', description: '', definitionOfDone: [],
    status, implementationPlan: [], comments: [], ...overrides
});

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
        exports: module.exports, module, console, process, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
        require: dep => {
            if (Object.prototype.hasOwnProperty.call(dependencies, dep)) { return dependencies[dep]; }
            throw new Error(`unexpected require from ${name}: ${dep}`);
        }
    });
    vm.runInContext(source, context, { filename: name });
    return module.exports;
}

function createHost() {
    const h = { frames: [], inputs: [], answers: [], warnings: [], errors: [], panels: [] };
    const noTimer = { setTimeout: () => 0, clearTimeout: () => {} };
    h.settle = () => new Promise(resolve => setImmediate(resolve));
    const makePanel = viewType => {
        const panel = {
            viewType, handler: undefined, posted: [], visible: true,
            webview: {
                html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
                onDidReceiveMessage: fn => { panel.handler = fn; return { dispose() {} }; },
                postMessage: message => { panel.posted.push(message); return Promise.resolve(true); }
            },
            onDidDispose: () => ({ dispose() {} }), onDidChangeVisibility: () => ({ dispose() {} }), reveal() {}, dispose() {}
        };
        h.panels.push(panel);
        return panel;
    };
    h.makePanel = makePanel;
    const vscode = {
        EventEmitter: RecordingEventEmitter, ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createWebviewPanel: viewType => makePanel(viewType),
            showInputBox: options => {
                h.inputs.push(options);
                return h.inputError ? Promise.reject(h.inputError) : Promise.resolve(h.answers.shift());
            },
            showInformationMessage: () => Promise.resolve(undefined),
            showWarningMessage: message => { h.warnings.push(message); return Promise.resolve(undefined); },
            showErrorMessage: message => { h.errors.push(message); return Promise.resolve(undefined); }
        },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    function StubWebSocket() { throw new Error('no real socket'); }
    StubWebSocket.OPEN = 1;
    const { MoeDaemonClient } = runModule('MoeDaemonClient.ts', SOURCES.client, {
        vscode, ws: StubWebSocket, fs, path, net, child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    });
    h.client = new MoeDaemonClient('extension');
    h.client['ws'] = { readyState: 1, send: frame => h.frames.push(JSON.parse(frame)), close() {} };
    h.client['_connectionState'] = 'connected';
    const planReview = runModule('PlanReviewPanel.ts', SOURCES.planReview, { vscode }, noTimer);
    h.taskDetail = runModule('TaskDetailPanel.ts', SOURCES.taskDetail, { vscode, './PlanReviewPanel': planReview }, noTimer);
    h.provider = runModule('BoardViewProvider.ts', SOURCES.provider, {
        vscode, '../panels/PlanReviewPanel': planReview, '../panels/TaskDetailPanel': h.taskDetail,
        '../panels/EpicDetailPanel': {}, '../panels/TaskCreatePanel': {}
    }, noTimer);
    h.cache = tasks => { h.client['state'] = { tasks, epics: [] }; };
    return h;
}

function openBoardHost(h, tasks) {
    h.cache(tasks);
    const provider = new h.provider.BoardViewProvider({ path: '/ext' }, h.client);
    const view = h.makePanel('moe.board');
    provider.resolveWebviewView(view, {}, {});
    return message => view.handler(message);
}

function openDetail(h, cached) {
    h.cache([cached]);
    h.taskDetail.TaskDetailPanel.createOrShow({ path: '/ext' }, h.client, cached.id, h.client.currentState);
    const panel = h.panels[h.panels.length - 1];
    return message => panel.handler(message);
}

function loadBoard(tasks) {
    const posted = [];
    const prompts = [];
    const ignore = () => {};
    const element = () => ({ addEventListener: ignore });
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => undefined, setState: ignore, postMessage: message => posted.push(plain(message)) }),
        document: { addEventListener: ignore, body: { addEventListener: ignore }, getElementById: element },
        window: { addEventListener: ignore, prompt: m => { prompts.push(m); return 'from a webview prompt'; } },
        prompt: m => { prompts.push(m); return 'from a webview prompt'; },
        setInterval: () => 0, setTimeout: () => 0, clearInterval: ignore, clearTimeout: ignore, console
    });
    vm.runInContext(BOARD_SCRIPT, context, { filename: 'board.js' });
    context.renderedTasks = tasks;
    vm.runInContext('currentState = { tasks: renderedTasks, epics: [] };', context);
    posted.length = 0;
    const event = { preventDefault() {}, stopPropagation() {} };
    return {
        posted, prompts,
        prev: id => context.navTask(event, id, 'prev'),
        card: t => context.renderTaskCard(t, [], t.status)
    };
}

const MOVES = { WORKING: 'PLANNING', AWAITING_APPROVAL: 'PLANNING', PLANNING: 'BACKLOG' };
const updates = frames => frames.filter(f => f.type === 'UPDATE_TASK').map(f => f.payload.updates.status);

test('PM1: the board renders a left arrow exactly on PLANNING, AWAITING_APPROVAL, WORKING, REVIEW and DONE cards', () => {
    const b = loadBoard([]);
    const withArrow = STATUSES.filter(s => /data-direction="prev"/.test(b.card(task(s))));
    assert.deepEqual(withArrow, ['PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE']);
});

test('PM2: the board left arrow sends PLANNING for WORKING and AWAITING_APPROVAL, BACKLOG for PLANNING, nothing for BACKLOG or BLOCKED', () => {
    for (const status of ['WORKING', 'AWAITING_APPROVAL', 'PLANNING', 'BACKLOG', 'BLOCKED']) {
        const t = task(status);
        const b = loadBoard([t]);
        b.prev(t.id);
        const h = createHost();
        const send = openBoardHost(h, [t]);
        b.posted.forEach(m => send(m));
        const expected = MOVES[status] ? [{ type: 'UPDATE_TASK', payload: { taskId: t.id, updates: { status: MOVES[status] } } }] : [];
        assert.deepEqual(h.frames, expected, status + ' posted ' + JSON.stringify(b.posted));
    }
});

test('PM3: the board left arrow on REVIEW and DONE posts only the reopen intent and never calls prompt()', () => {
    for (const status of ['REVIEW', 'DONE']) {
        const t = task(status);
        const b = loadBoard([t]);
        b.prev(t.id);
        assert.deepEqual({ posted: b.posted, prompts: b.prompts }, { posted: [{ type: 'reopenTask', taskId: t.id }], prompts: [] }, status);
    }
    assert.doesNotMatch(BOARD_SCRIPT, /\bprompt\s*\(/, 'media/board.js still calls prompt()');
});

test('PM4: the board host asks the reopen reason with showInputBox and sends REOPEN_TASK only for a non-blank answer', async () => {
    for (const [answer, reason] of [['  needs rework  ', 'needs rework'], ['   ', null], [undefined, null]]) {
        const h = createHost();
        const send = openBoardHost(h, [task('REVIEW')]);
        h.answers.push(answer);
        send({ type: 'reopenTask', taskId: 'task-review', reason: 'a webview-supplied reason is ignored' });
        await h.settle();
        assert.deepEqual(plain(h.inputs), [{ prompt: 'Reason for reopening', placeHolder: 'Why is this task being reopened?' }]);
        assert.deepEqual(h.frames, reason ? [{ type: 'REOPEN_TASK', payload: { taskId: 'task-review', reason } }] : [], JSON.stringify(answer));
    }
    const disconnected = createHost();
    const sendDisconnected = openBoardHost(disconnected, [task('DONE')]);
    disconnected.answers.push('fix it');
    disconnected.client['ws'].readyState = 3;
    sendDisconnected({ type: 'reopenTask', taskId: 'task-done' });
    await disconnected.settle();
    assert.deepEqual(disconnected.frames, []);
    assert.deepEqual(disconnected.warnings, ['Not connected to Moe daemon — task was not reopened.']);

    const rejected = createHost();
    rejected.inputError = 'input unavailable';
    openBoardHost(rejected, [task('REVIEW')])({ type: 'reopenTask', taskId: 'task-review' });
    await rejected.settle();
    assert.deepEqual(rejected.frames, []);
    assert.deepEqual(rejected.errors, ['Reopen failed: input unavailable']);

    const malformed = createHost();
    const sendMalformed = openBoardHost(malformed, []);
    for (const taskId of [undefined, null, 42, {}]) { sendMalformed({ type: 'reopenTask', taskId }); }
    await malformed.settle();
    assert.deepEqual(malformed.inputs, []);
    assert.deepEqual(malformed.frames, []);
});

test('PM5: Task Detail Previous sends PLANNING for WORKING and AWAITING_APPROVAL, BACKLOG for PLANNING, nothing for BACKLOG or BLOCKED', async () => {
    for (const status of ['WORKING', 'AWAITING_APPROVAL', 'PLANNING', 'BACKLOG', 'BLOCKED']) {
        const h = createHost();
        const t = task(status);
        const send = openDetail(h, t);
        await send({ type: 'prev', currentStatus: status });
        await h.settle();
        const expected = MOVES[status] ? [{ type: 'UPDATE_TASK', payload: { taskId: t.id, updates: { status: MOVES[status] } } }] : [];
        assert.deepEqual(h.frames, expected, status);
    }
});

test('PM6: Task Detail Previous on REVIEW and DONE sends REOPEN_TASK only for a non-blank answer', async () => {
    for (const status of ['REVIEW', 'DONE']) {
        for (const [answer, reason] of [[' fix it ', 'fix it'], ['  ', null], [undefined, null]]) {
            const h = createHost();
            const t = task(status);
            const send = openDetail(h, t);
            h.answers.push(answer);
            await send({ type: 'prev', currentStatus: status });
            await h.settle();
            assert.deepEqual(h.frames, reason ? [{ type: 'REOPEN_TASK', payload: { taskId: t.id, reason } }] : [], status + ' ' + JSON.stringify(answer));
        }
    }
});

test('PM7: no status move the left arrow or Previous can send falls outside setTaskStatus.ts VALID_TRANSITIONS[from]', async () => {
    const illegal = [];
    for (const status of STATUSES) {
        const t = task(status);
        const b = loadBoard([t]);
        b.prev(t.id);
        const board = createHost();
        const send = openBoardHost(board, [t]);
        b.posted.forEach(m => send(m));
        const detail = createHost();
        await openDetail(detail, t)({ type: 'prev', currentStatus: status });
        await detail.settle();
        for (const to of [...updates(board.frames), ...updates(detail.frames)]) {
            if (!(VALID[status] || []).includes(to)) { illegal.push(status + ' -> ' + to); }
        }
    }
    assert.deepEqual(illegal, []);
});

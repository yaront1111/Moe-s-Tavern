'use strict';

// The board's Delete and Done-column clear (task-8b7f9560; the JetBrains twin is 76ca84ba).
// A VS Code webview's sandbox has no allow-modals, so confirm() there returns false without
// showing anything. The page must post its intent and let the extension host ask in a modal.
// ARCHIVE_DONE_TASKS archives every DONE task in the epic filter, else on the whole board, and
// never sees the board search, so the host's count must come from the full state.
// Runs the PRODUCTION media/board.js (raw, under node:vm) and the real BoardViewProvider and
// MoeDaemonClient (transpiled under node:vm); every daemon frame is read off a fake socket.

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
    provider: transpile('src/providers/BoardViewProvider.ts')
};
const BOARD_SCRIPT = fs.readFileSync(file('media/board.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

const DELETE_TEXT = 'Delete "Ship it alpha"? This cannot be undone.';
const archiveText = n => `Archive ${n} completed task(s)? They will be hidden from the board but remain on disk.`;

const task = (id, status, epicId, title) => ({
    id, epicId, title, description: '', status, order: 1, definitionOfDone: [], implementationPlan: [], comments: []
});
// Two DONE tasks in epic-1, one in epic-2; the search "alpha" shows only the first.
const TASKS = [
    task('task-1', 'DONE', 'epic-1', 'Ship it alpha'),
    task('task-2', 'DONE', 'epic-1', 'beta two'),
    task('task-3', 'DONE', 'epic-2', 'gamma three'),
    task('task-4', 'WORKING', 'epic-1', 'alpha in flight')
];
const EPICS = [{ id: 'epic-1', title: 'E1', status: 'ACTIVE', order: 1 }, { id: 'epic-2', title: 'E2', status: 'ACTIVE', order: 2 }];

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

function runModule(name, source, deps) {
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, console, process,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
        require: dep => {
            if (Object.prototype.hasOwnProperty.call(deps, dep)) { return deps[dep]; }
            throw new Error(`unexpected require from ${name}: ${dep}`);
        }
    });
    vm.runInContext(source, context, { filename: name });
    return module.exports;
}

/** The real provider on a real client whose socket records frames; modals answer `h.answer`. */
function openHost(tasks) {
    const h = { frames: [], warnings: [], errors: [], answer: undefined };
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        commands: { executeCommand: () => Promise.resolve(undefined) },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showInformationMessage: () => Promise.resolve(undefined),
            showWarningMessage: (message, ...rest) => {
                const options = rest.length > 0 && typeof rest[0] === 'object' ? rest.shift() : undefined;
                h.warnings.push(plain({ message, options, items: rest }));
                return Promise.resolve(h.answer);
            },
            showErrorMessage: message => { h.errors.push(message); return Promise.resolve(undefined); }
        },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    const { MoeDaemonClient } = runModule('MoeDaemonClient.ts', SOURCES.client, {
        vscode, ws: StubWebSocket, fs, path, net, child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    });
    const client = new MoeDaemonClient('extension');
    client['ws'] = { readyState: 1, send: frame => h.frames.push(JSON.parse(frame)), close() {} };
    client['_connectionState'] = 'connected';
    client['state'] = { tasks: plain(tasks), epics: plain(EPICS) };
    const planReview = runModule('PlanReviewPanel.ts', SOURCES.planReview, { vscode });
    const taskDetail = runModule('TaskDetailPanel.ts', SOURCES.taskDetail, { vscode, './PlanReviewPanel': planReview });
    const { BoardViewProvider } = runModule('BoardViewProvider.ts', SOURCES.provider, {
        vscode, '../panels/PlanReviewPanel': planReview, '../panels/TaskDetailPanel': taskDetail,
        '../panels/EpicDetailPanel': {}, '../panels/TaskCreatePanel': {}
    });
    let handler;
    const view = {
        visible: true,
        webview: {
            html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
            onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; },
            postMessage: () => Promise.resolve(true)
        },
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeVisibility: () => ({ dispose() {} })
    };
    const provider = new BoardViewProvider({ path: '/ext' }, client);
    provider.resolveWebviewView(view, {}, {});
    h.frames.length = 0;
    h.send = async message => { handler(message); await new Promise(resolve => setImmediate(resolve)); };
    h.dispose = () => { provider.dispose(); client.dispose(); };
    return h;
}

/** A DOM element stand-in with enough surface for board.js to render and build its card menu. */
function element(tag) {
    const node = {
        tag, className: '', style: {}, dataset: {}, value: '', children: [], html: '', listeners: {}, ownText: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
        removeEventListener() {},
        appendChild(child) { node.children.push(child); return child; },
        insertAdjacentHTML(_where, markup) { node.html += markup; },
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0 }),
        setAttribute() {}, getAttribute: () => null, remove() {}, closest: () => null
    };
    Object.defineProperty(node, 'textContent', {
        get: () => node.ownText + node.children.map(child => child.textContent).join(''),
        set: value => { node.ownText = String(value); node.children = []; node.html = ''; }
    });
    return node;
}

/** Load media/board.js. Its confirm() and prompt() answer as the webview sandbox does. */
function loadBoard() {
    const b = { posted: [], dialogs: [] };
    const nodes = new Map();
    const byId = id => { if (!nodes.has(id)) { nodes.set(id, element('#' + id)); } return nodes.get(id); };
    const documentListeners = {};
    const body = element('body');
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => undefined, setState() {}, postMessage: message => b.posted.push(plain(message)) }),
        document: {
            getElementById: byId, createElement: element, body,
            createTextNode: text => { const n = element('#text'); n.textContent = text; return n; },
            addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); }
        },
        window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800, confirm: text => { b.dialogs.push(text); return false; } },
        prompt: text => { b.dialogs.push(text); return null; },
        setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, console
    });
    vm.runInContext(BOARD_SCRIPT, context, { filename: 'board.js' });
    b.posted.length = 0; // keep only what a gesture posts, not the page's 'ready'
    const ignore = () => {};
    /** Render the board state with an epic filter and a search, as the page's own handlers do. */
    b.render = (epic, search) => {
        context.epicChoice = epic;
        context.searchChoice = search;
        context.st = { tasks: plain(TASKS), epics: plain(EPICS), workers: [], teams: [] };
        vm.runInContext('selectedEpicFilter = epicChoice; searchQuery = searchChoice; renderBoard(st);', context);
        return byId('board').html;
    };
    /** Click the Done column's clear button: the body click delegation, with the rendered attributes. */
    b.clickClear = markup => {
        const tag = /<button[^>]*data-action="archiveDone"[^>]*>/.exec(markup);
        assert.ok(tag, 'the Done column offers its clear button');
        const attrs = Object.fromEntries([...tag[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const button = { getAttribute: name => (name in attrs ? attrs[name] : null), closest: () => null };
        const event = { target: { closest: sel => (sel === '[data-action]' ? button : null) }, stopPropagation: ignore, preventDefault: ignore };
        body.listeners.click.forEach(fn => fn(event));
    };
    /** Open the card menu on a task and click its Delete item. */
    b.deleteFromMenu = taskId => {
        const card = { getAttribute: name => (name === 'data-task-id' ? taskId : null) };
        const event = { target: { closest: sel => (sel === '.task-card' ? card : null) }, preventDefault: ignore, clientX: 5, clientY: 5 };
        documentListeners.contextmenu.forEach(fn => fn(event));
        const menu = body.children[body.children.length - 1];
        const item = menu.children.find(child => child.textContent === 'Delete');
        assert.ok(item, 'the card menu has a Delete item');
        item.listeners.click.forEach(fn => fn({ stopPropagation: ignore }));
    };
    return b;
}

// ---------------------------------------------------------------------------
// W: the webview posts its intent and never asks itself
// ---------------------------------------------------------------------------

test('board-confirm W1: the card menu Delete posts deleteTask without asking the page', () => {
    const b = loadBoard();
    b.render('', '');
    b.deleteFromMenu('task-1');
    assert.deepEqual({ posted: b.posted, dialogs: b.dialogs }, { posted: [{ type: 'deleteTask', taskId: 'task-1' }], dialogs: [] });
});

test('board-confirm W2: the Done clear posts archiveDoneTasks for the whole board while the search hides two Done cards', () => {
    const b = loadBoard();
    const markup = b.render('', 'alpha');
    assert.equal((markup.match(/data-task-id="task-[123]"/g) || []).length, 1, 'the search leaves one Done card');
    b.clickClear(markup);
    assert.deepEqual({ posted: b.posted, dialogs: b.dialogs }, { posted: [{ type: 'archiveDoneTasks' }], dialogs: [] });
});

test('board-confirm W3: with an epic selected, the Done clear posts that epic', () => {
    const b = loadBoard();
    b.clickClear(b.render('epic-1', ''));
    assert.deepEqual({ posted: b.posted, dialogs: b.dialogs }, { posted: [{ type: 'archiveDoneTasks', epicId: 'epic-1' }], dialogs: [] });
});

// ---------------------------------------------------------------------------
// H: the extension host asks in a modal and only then sends the frame
// ---------------------------------------------------------------------------

test('board-confirm H1: Delete asks in a modal and sends DELETE_TASK only for Delete', async () => {
    const h = openHost(TASKS);
    try {
        h.answer = 'Delete';
        await h.send({ type: 'deleteTask', taskId: 'task-1' });
        assert.deepEqual(h.warnings, [{ message: DELETE_TEXT, options: { modal: true }, items: ['Delete'] }]);
        assert.deepEqual(h.frames, [{ type: 'DELETE_TASK', payload: { taskId: 'task-1' } }]);
    } finally { h.dispose(); }
});

test('board-confirm H2: a dismissed Delete sends nothing', async () => {
    const h = openHost(TASKS);
    try {
        await h.send({ type: 'deleteTask', taskId: 'task-1' });
        assert.deepEqual({ modals: h.warnings.length, frames: h.frames }, { modals: 1, frames: [] });
    } finally { h.dispose(); }
});

test('board-confirm H3: the clear quotes every DONE task on the board and sends ARCHIVE_DONE_TASKS only for Archive', async () => {
    const h = openHost(TASKS);
    try {
        h.answer = 'Archive';
        await h.send({ type: 'archiveDoneTasks' });
        assert.deepEqual(h.warnings, [{ message: archiveText(3), options: { modal: true }, items: ['Archive'] }]);
        assert.deepEqual(h.frames, [{ type: 'ARCHIVE_DONE_TASKS', payload: {} }]);
    } finally { h.dispose(); }
});

test('board-confirm H4: an epic-filtered clear quotes and archives that epic only', async () => {
    const h = openHost(TASKS);
    try {
        h.answer = 'Archive';
        await h.send({ type: 'archiveDoneTasks', epicId: 'epic-1' });
        assert.deepEqual(h.warnings.map(w => w.message), [archiveText(2)]);
        assert.deepEqual(h.frames, [{ type: 'ARCHIVE_DONE_TASKS', payload: { epicId: 'epic-1' } }]);
    } finally { h.dispose(); }
});

test('board-confirm H5: a dismissed clear sends nothing', async () => {
    const h = openHost(TASKS);
    try {
        await h.send({ type: 'archiveDoneTasks' });
        assert.deepEqual({ modals: h.warnings.length, frames: h.frames }, { modals: 1, frames: [] });
    } finally { h.dispose(); }
});

test('board-confirm H6: a clear with no DONE task in scope asks nothing and sends nothing', async () => {
    const h = openHost(TASKS);
    try {
        h.answer = 'Archive';
        await h.send({ type: 'archiveDoneTasks', epicId: 'epic-9' });
        assert.deepEqual({ warnings: h.warnings, frames: h.frames }, { warnings: [], frames: [] });
    } finally { h.dispose(); }
});

// ---------------------------------------------------------------------------
// E: page to host, end to end
// ---------------------------------------------------------------------------

test('board-confirm E1: the search shows one Done card, yet the modal quotes the three ARCHIVE_DONE_TASKS archives', async () => {
    const b = loadBoard();
    b.clickClear(b.render('', 'alpha'));
    const h = openHost(TASKS);
    try {
        h.answer = 'Archive';
        assert.equal(b.posted.length, 1, 'the page posted its intent');
        await h.send(b.posted[0]);
        assert.deepEqual({ quoted: h.warnings.map(w => w.message), frames: h.frames },
            { quoted: [archiveText(3)], frames: [{ type: 'ARCHIVE_DONE_TASKS', payload: {} }] });
    } finally { h.dispose(); }
});

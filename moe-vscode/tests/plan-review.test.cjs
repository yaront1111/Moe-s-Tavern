'use strict';

// Plan-review approval binding.
//
// These tests run BOTH production artifacts and wire a real message bridge
// between them, so every assertion crosses webview script -> panel -> daemon
// client exactly as it does in the extension:
//
//   * src/panels/PlanReviewPanel.ts is transpiled and executed under node:vm.
//   * media/planReview.js is plain browser JS and is executed RAW (no transpile)
//     in its own context against a fake document.
//   * the panel's `webview.html = ...` write is treated as a page load: the HTML
//     the panel actually emitted is parsed for element ids and for the seeded
//     data attribute, then a fresh webview context is built from it.
//
// Nothing here re-implements production logic; the harness owns only the
// environment (document, vscode, client, timers).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const PANEL_PATH = path.join(__dirname, '../src/panels/PlanReviewPanel.ts');
const WEBVIEW_PATH = path.join(__dirname, '../media/planReview.js');

const COMPILED_PANEL = ts.transpileModule(fs.readFileSync(PANEL_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

const WEBVIEW_SOURCE = fs.readFileSync(WEBVIEW_PATH, 'utf8');

const TASK_ID = 'task-plan-1';

// ===========================================================================
// Harness
// ===========================================================================

/** vscode.EventEmitter stand-in whose listeners are observable and really removable. */
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

/** Minimal DOM element stand-in: only what the production renderers actually touch. */
function createElementStub(id, hooks) {
    const classes = new Set();
    return {
        id,
        disabled: false,
        textContent: '',
        value: '',
        className: '',
        scrollTop: 0,
        scrollHeight: 0,
        attributes: Object.create(null),
        children: [],
        listeners: Object.create(null),
        classList: {
            add: name => { classes.add(name); },
            remove: name => { classes.delete(name); },
            contains: name => classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !classes.has(name) : !!force;
                if (on) { classes.add(name); } else { classes.delete(name); }
                return on;
            }
        },
        classNames: () => Array.from(classes),
        addEventListener(type, handler) {
            (this.listeners[type] || (this.listeners[type] = [])).push(handler);
        },
        appendChild(child) {
            if (hooks.failingAppendIds.has(id)) {
                throw new hooks.VmError('renderer blew up while appending to ' + id);
            }
            this.children.push(child);
            return child;
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        setAttribute(name, value) { this.attributes[name] = String(value); }
    };
}

/** Every id the emitted HTML really declares — unknown ids resolve to null, as in a browser. */
function parseIds(html) {
    const ids = new Set();
    const re = /id="([^"]+)"/g;
    let match;
    while ((match = re.exec(html)) !== null) { ids.add(match[1]); }
    return ids;
}

/**
 * The raw `data-plan-revision` the panel wrote on the review root, or null when the
 * attribute was omitted entirely. Reads it out of the real HTML string so
 * "omitted" and "present but empty" stay distinguishable.
 */
function parseSeedAttribute(html) {
    const tag = /<div[^>]*\bid="reviewRoot"[^>]*>/.exec(html);
    if (!tag) { return null; }
    const attr = /\bdata-plan-revision="([^"]*)"/.exec(tag[0]);
    return attr ? attr[1] : null;
}

function createHarness(options = {}) {
    const h = {
        infoMessages: [], warnMessages: [], errorMessages: [],
        inputBoxAnswer: options.inputBoxAnswer,
        approveCalls: [], rejectCalls: [], commentCalls: [],
        approveResult: true,
        htmlWrites: [],
        panelDisposeCount: 0,
        postedToWebview: [],
        /** 'ok' | 'false' | 'throw' | 'reject' */
        deliveryMode: 'ok',
        failingAppendIds: new Set(),
        webview: undefined,
        pendingBridge: []
    };

    // ---- deterministic timers for the 200ms debounce -----------------------
    const timers = new Map();
    let nextTimerId = 1;
    const fakeSetTimeout = (fn) => { const id = nextTimerId++; timers.set(id, fn); return id; };
    const fakeClearTimeout = (id) => { timers.delete(id); };
    h.pendingTimerCount = () => timers.size;
    h.flushTimers = () => {
        const due = Array.from(timers.values());
        timers.clear();
        for (const fn of due) { fn(); }
    };

    // ---- daemon client stub -------------------------------------------------
    const stateEmitter = new RecordingEventEmitter();
    const connectionEmitter = new RecordingEventEmitter();
    const errorEmitter = new RecordingEventEmitter();
    const client = {
        currentState: { tasks: [] },
        approveTask(...args) { h.approveCalls.push(args); return h.approveResult; },
        rejectTask(...args) { h.rejectCalls.push(args); return true; },
        addTaskComment(...args) { h.commentCalls.push(args); },
        onStateChanged: stateEmitter.event,
        onConnectionChanged: connectionEmitter.event,
        onError: errorEmitter.event
    };
    h.client = client;
    h.setTasks = (...tasks) => { client.currentState = { tasks }; };
    h.emitState = () => stateEmitter.fire(client.currentState);
    h.emitConnection = (value) => connectionEmitter.fire(value);
    h.emitError = (payload) => errorEmitter.fire(payload);
    h.listenerCounts = () => ({
        state: stateEmitter.listeners.length,
        connection: connectionEmitter.listeners.length,
        error: errorEmitter.listeners.length
    });

    const moduleRef = { exports: {} };
    let VmError;
    let onDidReceiveMessageHandler;

    function deliverToPanel(msg) {
        if (typeof onDidReceiveMessageHandler !== 'function') { return Promise.resolve(); }
        return Promise.resolve().then(() => onDidReceiveMessageHandler(msg));
    }

    /** Build a fresh webview realm from the HTML the panel just emitted. */
    function loadWebview(html) {
        const ids = parseIds(html);
        const seed = parseSeedAttribute(html);
        const elements = new Map();
        const hooks = { failingAppendIds: h.failingAppendIds, VmError };
        const getElementById = (id) => {
            if (!ids.has(id)) { return null; }
            if (!elements.has(id)) { elements.set(id, createElementStub(id, hooks)); }
            return elements.get(id);
        };
        const root = getElementById('reviewRoot');
        if (root && seed !== null) { root.attributes['data-plan-revision'] = seed; }
        const approveTag = /<button[^>]*\bid="approveBtn"[^>]*>/.exec(html);
        const approveMarkedDisabled = !!approveTag && /\sdisabled(\s|>|=)/.test(approveTag[0]);
        const approveBtn = getElementById('approveBtn');
        if (approveBtn) { approveBtn.disabled = approveMarkedDisabled; }

        let messageListener;
        const posted = [];
        const context = vm.createContext({
            console,
            acquireVsCodeApi: () => ({
                postMessage: (msg) => { posted.push(msg); h.pendingBridge.push(deliverToPanel(msg)); },
                getState: () => undefined,
                setState: () => undefined
            }),
            document: {
                getElementById,
                createElement: (tag) => createElementStub('<' + tag + '>', hooks),
                addEventListener: () => {},
                body: { addEventListener: () => {} }
            },
            window: {
                addEventListener: (type, handler) => { if (type === 'message') { messageListener = handler; } }
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout
        });
        vm.runInContext(WEBVIEW_SOURCE, context, { filename: WEBVIEW_PATH });

        h.webview = {
            html, ids,
            seedAttribute: seed,
            approveMarkedDisabled,
            postedToPanel: posted,
            element: getElementById,
            approveDisabled: () => { const el = getElementById('approveBtn'); return el ? el.disabled : null; },
            rejectDisabled: () => { const el = getElementById('rejectBtn'); return el ? el.disabled : null; },
            notice: () => { const el = getElementById('reviewNotice'); return el ? el.textContent : null; },
            stepTexts: () => {
                const el = getElementById('stepsContent');
                if (!el) { return null; }
                return el.children.map(card => card.children.map(n => n.textContent).join(' | '));
            },
            click: (id) => {
                const el = getElementById(id);
                if (!el) { throw new Error('no element with id ' + id + ' in the emitted HTML'); }
                for (const handler of (el.listeners['click'] || [])) { handler.call(el, { preventDefault() {} }); }
            },
            deliver: (message) => {
                if (typeof messageListener !== 'function') {
                    throw new Error('the webview script registered no message listener');
                }
                messageListener({ data: message });
            },
            hasMessageListener: () => typeof messageListener === 'function'
        };
        return h.webview;
    }

    function createFakePanel() {
        let onDidDisposeCallback;
        let alreadyDisposed = false;
        const webviewApi = {
            cspSource: 'vscode-webview://unit-test',
            asWebviewUri: () => ({ toString: () => 'vscode-resource://media/planReview.js' }),
            set html(value) { h.htmlWrites.push(value); loadWebview(value); },
            get html() { return h.htmlWrites[h.htmlWrites.length - 1]; },
            onDidReceiveMessage: (handler) => {
                onDidReceiveMessageHandler = handler;
                return { dispose: () => { onDidReceiveMessageHandler = undefined; } };
            },
            postMessage: (message) => {
                h.postedToWebview.push(message);
                if (h.deliveryMode === 'throw') { throw new VmError('webview is gone'); }
                if (h.deliveryMode === 'reject') { return Promise.reject(new VmError('postMessage rejected')); }
                if (h.deliveryMode === 'false') { return Promise.resolve(false); }
                if (h.webview && h.webview.hasMessageListener()) { h.webview.deliver(message); }
                return Promise.resolve(true);
            }
        };
        return {
            webview: webviewApi,
            revealCount: 0,
            reveal() { this.revealCount++; },
            onDidDispose(callback, _thisArg, disposablesArray) {
                onDidDisposeCallback = callback;
                const subscription = { dispose: () => { onDidDisposeCallback = undefined; } };
                if (disposablesArray) { disposablesArray.push(subscription); }
                return subscription;
            },
            // Real WebviewPanel.dispose() is idempotent and fires onDidDispose once.
            dispose() {
                h.panelDisposeCount++;
                if (alreadyDisposed) { return; }
                alreadyDisposed = true;
                if (onDidDisposeCallback) { onDidDisposeCallback(); }
            }
        };
    }

    const vscodeStub = {
        EventEmitter: RecordingEventEmitter,
        ViewColumn: { One: 1 },
        Uri: {
            joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
            file: (fsPath) => ({ fsPath })
        },
        window: {
            createWebviewPanel: () => { h.panel = createFakePanel(); return h.panel; },
            showInformationMessage: (m) => { h.infoMessages.push(m); return Promise.resolve(undefined); },
            showWarningMessage: (m) => { h.warnMessages.push(m); return Promise.resolve(undefined); },
            showErrorMessage: (m) => { h.errorMessages.push(m); return Promise.resolve(undefined); },
            showInputBox: () => Promise.resolve(h.inputBoxAnswer),
            createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} })
        }
    };

    const panelContext = vm.createContext({
        exports: moduleRef.exports,
        module: moduleRef,
        console,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        setInterval, clearInterval,
        require: (name) => {
            if (name === 'vscode') { return vscodeStub; }
            throw new Error('unexpected require from PlanReviewPanel.ts: ' + name);
        }
    });
    vm.runInContext(COMPILED_PANEL, panelContext, { filename: PANEL_PATH });
    VmError = vm.runInContext('Error', panelContext);
    h.VmError = VmError;
    h.PlanReviewPanel = moduleRef.exports.PlanReviewPanel;

    h.open = (taskId = TASK_ID) => moduleRef.exports.PlanReviewPanel.createOrShow(
        { fsPath: 'extension' }, client, taskId, client.currentState
    );

    /** Hand the panel a raw webview message, bypassing the script's own guards. */
    h.sendToPanel = (message) => { h.pendingBridge.push(deliverToPanel(message)); };

    /** Drain every bridged webview -> panel message so assertions see settled state. */
    h.settle = async () => {
        for (let i = 0; i < 10 && h.pendingBridge.length > 0; i++) {
            const inflight = h.pendingBridge.splice(0, h.pendingBridge.length);
            await Promise.all(inflight);
        }
        await Promise.resolve();
        await Promise.resolve();
    };

    return h;
}

function makeTask(overrides = {}) {
    const task = {
        id: TASK_ID,
        title: 'Bind approval to the rendered plan',
        description: 'Send the revision the human actually read.',
        status: 'AWAITING_APPROVAL',
        priority: 'HIGH',
        definitionOfDone: ['Approve sends the rendered revision'],
        implementationPlan: [
            { stepId: 'step-1', description: 'Seed the token', status: 'PENDING', affectedFiles: ['a.ts'] }
        ],
        comments: [],
        planRevision: 4
    };
    Object.assign(task, overrides);
    if (Object.prototype.hasOwnProperty.call(overrides, 'planRevision') && overrides.planRevision === undefined) {
        delete task.planRevision;
    }
    return task;
}

/** Open a panel on one task and return the harness plus the live instance. */
function openOn(task, options) {
    const h = createHarness(options);
    h.setTasks(task);
    const panel = h.open();
    return { h, panel };
}

/** Push a new task object into the client cache and run the debounced update. */
function pushUpdate(h, task) {
    h.setTasks(task);
    h.emitState();
    h.flushTimers();
}

// ===========================================================================
// (A) the seeded token is the one the initial HTML rendered
// ===========================================================================

test('A: the initial render seeds the token from the very task that built the HTML', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 7 }));
    try {
        assert.equal(h.webview.seedAttribute, '7');
        assert.equal(h.webview.approveMarkedDisabled, true, 'markup must start disabled so an unseeded page cannot approve');
        assert.equal(h.webview.approveDisabled(), false, 'a seeded page enables Approve after the script runs');

        h.webview.click('approveBtn');
        await h.settle();

        assert.deepEqual(h.approveCalls, [[TASK_ID, 7]]);
        assert.deepEqual(h.approveCalls.map(call => call.length), [2],
            'exactly two arguments — the one-argument legacy call is the defect this closes');
    } finally { panel.dispose(); }
});

test('A: revision 0 is a real token, not a falsy one', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 0 }));
    try {
        assert.equal(h.webview.seedAttribute, '0');
        assert.equal(h.webview.approveDisabled(), false);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, [[TASK_ID, 0]]);
    } finally { panel.dispose(); }
});

test('A: a legacy task with no planRevision field seeds the effective zero', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: undefined }));
    try {
        assert.equal(h.webview.seedAttribute, '0');
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, [[TASK_ID, 0]]);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (B) the race this task exists for
// ===========================================================================

test('B: a click queued while a newer plan sits undelivered sends the rendered revision', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        // A newer plan lands in the client cache but the 200ms debounce has NOT fired,
        // so the page is still showing revision 4.
        h.setTasks(makeTask({ planRevision: 5, title: 'Rewritten plan' }));
        h.emitState();
        assert.equal(h.pendingTimerCount(), 1, 'the debounce must still be pending for this race to be real');

        h.webview.click('approveBtn');
        await h.settle();

        assert.deepEqual(h.approveCalls, [[TASK_ID, 4]]);
        assert.equal(h.approveCalls.some(call => call.includes(5)), false, 'the cached newer revision must never be sent');
    } finally { panel.dispose(); }
});

test('B: flushing the newer plan latches the page with a reopen notice', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.setTasks(makeTask({ planRevision: 5 }));
        h.emitState();
        h.webview.click('approveBtn');
        await h.settle();

        h.flushTimers();
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        assert.match(String(h.webview.notice()), /reopen/i);
        assert.equal(h.approveCalls.length, 1);

        // A further click on the latched page reaches nothing.
        h.webview.click('approveBtn');
        await h.settle();
        assert.equal(h.approveCalls.length, 1);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (C) advancing vs latching the token
// ===========================================================================

test('C: a complete re-render at the same revision keeps Approve usable', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        pushUpdate(h, makeTask({ planRevision: 4, comments: [{ author: 'qa', content: 'looks good', timestamp: '2026-09-11T00:00:00Z' }] }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), false);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, [[TASK_ID, 4]]);
    } finally { panel.dispose(); }
});

test('C: a re-render at a different revision latches instead of rebinding the click', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        pushUpdate(h, makeTask({ planRevision: 6 }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, []);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (D) nothing unseen is ever approvable
// ===========================================================================

test('D: a renderer that throws part way leaves Approve disabled', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.failingAppendIds.add('stepsContent');
        pushUpdate(h, makeTask({ planRevision: 4 }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, []);
    } finally { panel.dispose(); }
});

test('D: a removed task disables Approve and posts nothing', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.setTasks();
        h.emitState();
        h.flushTimers();
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, []);
    } finally { panel.dispose(); }
});

test('D: a task that has left AWAITING_APPROVAL disables Approve', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        pushUpdate(h, makeTask({ planRevision: 4, status: 'PLANNING' }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, []);
    } finally { panel.dispose(); }
});

test('D: a malformed revision is not treated as legacy zero', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        pushUpdate(h, makeTask({ planRevision: '5' }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), true);
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, []);
    } finally { panel.dispose(); }
});

test('D: a malformed revision on the initial task omits the seed attribute entirely', () => {
    const { h, panel } = openOn(makeTask({ planRevision: -1 }));
    try {
        assert.equal(h.webview.seedAttribute, null, 'a malformed revision must omit the attribute, not emit an empty one');
        assert.equal(h.webview.approveDisabled(), true);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (E) the panel refuses a token it cannot trust — without the legacy path
// ===========================================================================

for (const [label, message] of [
    ['missing', { type: 'approve' }],
    ['null', { type: 'approve', expectedPlanRevision: null }],
    ['a string', { type: 'approve', expectedPlanRevision: '4' }],
    ['fractional', { type: 'approve', expectedPlanRevision: 1.5 }],
    ['negative', { type: 'approve', expectedPlanRevision: -1 }],
    ['NaN', { type: 'approve', expectedPlanRevision: Number.NaN }]
]) {
    test(`E: an approve message whose revision is ${label} never reaches the client`, async () => {
        const { h, panel } = openOn(makeTask({ planRevision: 4 }));
        try {
            h.sendToPanel(message);
            await h.settle();

            assert.equal(h.approveCalls.length, 0, 'no client call at all — not even a one-argument legacy one');
            assert.deepEqual(h.approveCalls.map(call => call.length), [],
                'a one-argument legacy fallback would show up here as [1]');
            assert.equal(h.infoMessages.length, 0);
            assert.equal(h.panelDisposeCount, 0);
            assert.equal(h.errorMessages.length + h.warnMessages.length, 1, 'the refusal is reported to the human');
        } finally { panel.dispose(); }
    });
}

test('E: a valid supplied token is forwarded verbatim as the second argument', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.sendToPanel({ type: 'approve', expectedPlanRevision: 2 });
        await h.settle();

        assert.deepEqual(h.approveCalls, [[TASK_ID, 2]], 'the panel never substitutes its own cached revision');
        assert.deepEqual(h.approveCalls.map(call => call.length), [2]);
    } finally { panel.dispose(); }
});

test('E: the reject and comment routes are untouched by the token work', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }), { inputBoxAnswer: 'not good enough' });
    try {
        h.sendToPanel({ type: 'addComment', content: '  please clarify step 2  ' });
        await h.settle();
        assert.deepEqual(h.commentCalls, [[TASK_ID, 'please clarify step 2']]);

        h.sendToPanel({ type: 'promptReject' });
        await h.settle();
        assert.deepEqual(h.rejectCalls, [[TASK_ID, 'not good enough']]);
        assert.deepEqual(h.infoMessages, ['Plan rejected']);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (F) at most one send while an approval is pending
// ===========================================================================

test('F: repeated clicks while an approval is pending produce exactly one client call', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.webview.click('approveBtn');
        h.webview.click('approveBtn');
        h.webview.click('approveBtn');
        await h.settle();

        assert.deepEqual(h.approveCalls, [[TASK_ID, 4]]);
        assert.deepEqual(h.infoMessages, [], 'a pending approval is not a successful one');
    } finally { panel.dispose(); }
});

// ===========================================================================
// (G) a failed send keeps the panel open with visible feedback
// ===========================================================================

test('G: a refused send warns, keeps the panel open and claims no success', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.approveResult = false;
        h.webview.click('approveBtn');
        await h.settle();

        assert.deepEqual(h.approveCalls, [[TASK_ID, 4]]);
        assert.deepEqual(h.infoMessages, []);
        assert.equal(h.warnMessages.length, 1);
        assert.equal(h.panelDisposeCount, 0, 'a failed send must not dispose the panel');
        assert.notEqual(h.webview.notice(), '', 'the page keeps visible failure feedback');
    } finally { panel.dispose(); }
});

test('G: a later same-revision render restores Approve after a failed send', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.approveResult = false;
        h.webview.click('approveBtn');
        await h.settle();
        assert.equal(h.webview.approveDisabled(), true);

        h.approveResult = true;
        pushUpdate(h, makeTask({ planRevision: 4 }));
        await h.settle();

        assert.equal(h.webview.approveDisabled(), false, 'a transport hiccup must not force a reopen');
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, [[TASK_ID, 4], [TASK_ID, 4]]);
    } finally { panel.dispose(); }
});

test('G: a failed delivery to the page refuses every later approve message', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.deliveryMode = 'reject';
        h.setTasks(makeTask({ planRevision: 4 }));
        h.emitState();
        h.flushTimers();
        await h.settle();

        h.deliveryMode = 'ok';
        h.webview.click('approveBtn');
        await h.settle();

        assert.deepEqual(h.approveCalls, [], 'the panel knows the page was never refreshed');
    } finally { panel.dispose(); }
});

// ===========================================================================
// (H) correlated daemon refusals
// ===========================================================================

test('H: a correlated stale refusal latches the page and reports failure', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.webview.click('approveBtn');
        await h.settle();

        h.emitError({
            operation: 'APPROVE_TASK',
            message: 'plan revision mismatch',
            code: 409,
            codeName: 'PLAN_REVISION_MISMATCH',
            context: { taskId: TASK_ID, expectedPlanRevision: 4, currentPlanRevision: 5 }
        });
        await h.settle();

        assert.deepEqual(h.infoMessages, [], 'a refusal is never a success');
        assert.equal(h.panelDisposeCount, 0);
        assert.equal(h.errorMessages.length, 1);
        assert.match(String(h.webview.notice()), /reopen/i);
        assert.equal(h.webview.approveDisabled(), true);

        h.webview.click('approveBtn');
        await h.settle();
        assert.equal(h.approveCalls.length, 1, 'a latched page cannot retry');
    } finally { panel.dispose(); }
});

test('H: an error for another task or another operation changes nothing', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.webview.click('approveBtn');
        await h.settle();
        const noticeBefore = h.webview.notice();

        h.emitError({
            operation: 'APPROVE_TASK', message: 'someone else', codeName: 'PLAN_REVISION_MISMATCH',
            context: { taskId: 'task-someone-else', currentPlanRevision: 9 }
        });
        h.emitError({
            operation: 'REJECT_TASK', message: 'unrelated operation', codeName: 'PLAN_REVISION_MISMATCH',
            context: { taskId: TASK_ID }
        });
        h.emitError({ operation: 'APPROVE_TASK', message: 'no context at all' });
        await h.settle();

        assert.deepEqual(h.errorMessages, []);
        assert.equal(h.webview.notice(), noticeBefore);
        assert.equal(h.panelDisposeCount, 0);
    } finally { panel.dispose(); }
});

test('H: losing the connection while pending surfaces a transport failure', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.webview.click('approveBtn');
        await h.settle();

        h.emitConnection('disconnected');
        await h.settle();

        assert.deepEqual(h.infoMessages, []);
        assert.equal(h.warnMessages.length, 1);
        assert.equal(h.panelDisposeCount, 0);
        assert.notEqual(h.webview.notice(), '');
    } finally { panel.dispose(); }
});

// ===========================================================================
// (I) the one authoritative success path
// ===========================================================================

test('I: only the task reaching WORKING while pending reports approval, exactly once', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.infoMessages, [], 'the send alone announces nothing');

        pushUpdate(h, makeTask({ planRevision: 4, status: 'WORKING' }));
        await h.settle();

        assert.deepEqual(h.infoMessages, ['Plan approved']);
        assert.equal(h.panelDisposeCount, 1);

        // A second authoritative update must not re-announce.
        h.setTasks(makeTask({ planRevision: 4, status: 'WORKING' }));
        h.emitState();
        h.flushTimers();
        await h.settle();
        assert.deepEqual(h.infoMessages, ['Plan approved']);
    } finally { panel.dispose(); }
});

test('I: WORKING without a pending approval never announces an approval', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        pushUpdate(h, makeTask({ planRevision: 4, status: 'WORKING' }));
        await h.settle();

        assert.deepEqual(h.infoMessages, []);
        assert.equal(h.panelDisposeCount, 0);
    } finally { panel.dispose(); }
});

// ===========================================================================
// (J) disposal
// ===========================================================================

test('J: dispose clears the debounce, releases every listener and is idempotent', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    const before = h.listenerCounts();
    assert.equal(before.state, 1);
    assert.equal(before.connection, 1, 'the panel must watch connection changes');
    assert.equal(before.error, 1, 'the panel must watch client errors');

    h.setTasks(makeTask({ planRevision: 9 }));
    h.emitState();
    assert.equal(h.pendingTimerCount(), 1);

    panel.dispose();
    assert.equal(h.pendingTimerCount(), 0, 'the armed debounce must be cleared');
    assert.equal(h.panelDisposeCount, 1, 'the re-entrant onDidDispose path must not dispose twice');
    assert.deepEqual(h.listenerCounts(), { state: 0, connection: 0, error: 0 });

    panel.dispose();
    assert.equal(h.panelDisposeCount, 1, 'dispose() is idempotent');

    const postedBefore = h.postedToWebview.length;
    h.emitState();
    h.flushTimers();
    await h.settle();
    assert.equal(h.postedToWebview.length, postedBefore, 'a disposed panel posts nothing');
});

test('J: an approve message arriving after disposal does nothing', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    const view = h.webview;
    panel.dispose();

    view.click('approveBtn');
    await h.settle();
    assert.deepEqual(h.approveCalls, []);
    assert.deepEqual(h.infoMessages, []);
});

// ===========================================================================
// (K) reopening
// ===========================================================================

test('K: reopening after disposal rebuilds the panel seeded at the newer revision', async () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    panel.dispose();

    h.setTasks(makeTask({ planRevision: 11 }));
    const reopened = h.open();
    try {
        assert.equal(h.webview.seedAttribute, '11');
        assert.equal(h.webview.approveDisabled(), false);

        h.webview.click('approveBtn');
        await h.settle();
        assert.deepEqual(h.approveCalls, [[TASK_ID, 11]]);
    } finally { reopened.dispose(); }
});

test('K: a second createOrShow while the panel is open reveals it instead of rebuilding', () => {
    const { h, panel } = openOn(makeTask({ planRevision: 4 }));
    try {
        const again = h.open();
        assert.equal(again, panel);
        assert.equal(h.htmlWrites.length, 1);
    } finally { panel.dispose(); }
});

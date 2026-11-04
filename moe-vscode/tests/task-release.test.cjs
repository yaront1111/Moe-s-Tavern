'use strict';

// VS Code's task detail offers JetBrains' "Release Agent" action (VSC-11): the
// button renders only for a task with a non-blank assignedWorkerId, and only an
// explicit modal confirm sends releaseTask(taskId, 'Released from board').
//
// Everything runs production source: the HTML and the message handler come from
// the real TaskDetailPanel (transpiled under node:vm with a strict require map),
// the page wiring from the real media/taskDetail.js. The wording is NOT copied
// here: it is read from JetBrains' MoeBundle.properties, so a drift in either
// IDE's text fails this file instead of shipping.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const file = relative => path.join(__dirname, '..', relative);
const transpile = relative => ts.transpileModule(fs.readFileSync(file(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

const PANEL_SOURCE = transpile('src/panels/TaskDetailPanel.ts');
const PLAN_REVIEW_SOURCE = transpile('src/panels/PlanReviewPanel.ts');
const DETAIL_SCRIPT = fs.readFileSync(file('media/taskDetail.js'), 'utf8');
const BUNDLE_PATH = path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties');

// ===========================================================================
// The JetBrains wording, read from its bundle
// ===========================================================================

const BUNDLE_KEYS = ['moe.button.releaseAgent', 'moe.message.releaseAgent', 'moe.message.releasedInUI',
    'moe.message.releaseAgentForce', 'moe.message.releaseAgentForceTitle', 'moe.message.releaseAgentForceStale'];

function readBundle() {
    const text = fs.readFileSync(BUNDLE_PATH, 'utf8');
    const values = {};
    for (const [, key, value] of text.matchAll(/^(moe\.(?:button\.releaseAgent|message\.releaseAgent(?:Force(?:Title|Stale)?)?|message\.releasedInUI))=(.*?)\r?$/gm)) {
        values[key] = value;
    }
    for (const key of BUNDLE_KEYS) {
        assert.ok(typeof values[key] === 'string' && values[key] !== '', `MoeBundle.properties has no "${key}" line`);
    }
    return values;
}

const BUNDLE = readBundle();
const BUTTON_LABEL = BUNDLE['moe.button.releaseAgent'];
const RELEASE_REASON = BUNDLE['moe.message.releasedInUI'];
const CONFIRM_TEMPLATE = BUNDLE['moe.message.releaseAgent'];
const NOT_CONNECTED = 'Not connected to Moe daemon — agent was not released.';
const NO_AGENT = 'No agent is assigned to this task.';
const FORCE_TEMPLATE = BUNDLE['moe.message.releaseAgentForce'];
const FORCE_TITLE = BUNDLE['moe.message.releaseAgentForceTitle'];
const STALE_TEMPLATE = BUNDLE['moe.message.releaseAgentForceStale'];

function expectedText(template, ...values) {
    return template.split(/(\{\d\})/).map(part => /^\{\d\}$/.test(part) ? values[Number(part[1])] ?? part : part).join('');
}

/**
 * The bundle text with {0} = worker id and {1} = task title, built by splitting
 * on the two placeholders so each value is inserted once and never re-scanned
 * (Java MessageFormat does the same). Independent of the production substitution.
 */
function expectedConfirm(workerId, title) {
    const [head, rest] = CONFIRM_TEMPLATE.split('{0}');
    const [middle, tail] = rest.split('{1}');
    return head + workerId + middle + title + tail;
}

// ===========================================================================
// Extension-host harness: the real panel with strict stubs
// ===========================================================================

// A stub that throws on any member it does not define, so a new IDE or client
// dependency fails loudly instead of running against undefined.
function strict(name, members) {
    return new Proxy(members, {
        get(target, key) {
            if (typeof key === 'symbol' || key in target) { return Reflect.get(target, key); }
            throw new Error(`unexpected access to ${name}.${key}`);
        }
    });
}

const subscription = () => ({ dispose() {} });

// Runs a transpiled module that may require only the given dependencies.
function loadModule(source, filename, dependencies, globals = {}) {
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, console, ...globals,
        require: name => {
            if (Object.prototype.hasOwnProperty.call(dependencies, name)) { return dependencies[name]; }
            throw new Error(`unexpected require from ${path.basename(filename)}: ${name}`);
        }
    });
    vm.runInContext(source, context, { filename });
    return { exports: module.exports, context };
}

const makeTask = (overrides = {}) => ({
    id: 'task-release', epicId: 'epic-1', title: 'Ship "release" <fast> & safe', description: 'd',
    definitionOfDone: [], status: 'WORKING', priority: 'MEDIUM', assignedWorkerId: 'w1',
    implementationPlan: [], comments: [], reopenCount: 0, ...overrides
});

/**
 * Opens a fresh panel (a new module per call: the panel keeps a static map) on one
 * task. `answer` is what the modal returns; `released` is what releaseTask returns;
 * `releaseThrows` makes it throw the vm realm's own Error.
 */
function open({ task = {}, answer, released = true, releaseThrows } = {}) {
    const calls = { warnings: [], infos: [], errors: [], releases: [] };
    const state = { tasks: [makeTask(task)], epics: [] };
    let listener;
    const panel = {
        webview: {
            html: '', cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
            onDidReceiveMessage: fn => { listener = fn; return subscription(); }
        },
        onDidDispose: subscription, reveal() {}, dispose() {}
    };
    const vscode = {
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        window: strict('vscode.window', {
            createWebviewPanel: () => panel,
            showWarningMessage: (...args) => { calls.warnings.push(args); return Promise.resolve(answer); },
            showInformationMessage: (...args) => { calls.infos.push(args); return Promise.resolve(undefined); },
            showErrorMessage: (...args) => { calls.errors.push(args); return Promise.resolve(undefined); }
        })
    };
    const planReview = loadModule(PLAN_REVIEW_SOURCE, 'PlanReviewPanel.ts', { vscode });
    const loaded = loadModule(PANEL_SOURCE, 'TaskDetailPanel.ts', { vscode, './PlanReviewPanel': planReview.exports });
    const VmError = vm.runInContext('Error', loaded.context);
    const client = strict('client', {
        get currentState() { return state; },
        onStateChanged: () => subscription(),
        onError: () => subscription(),
        onConnectionChanged: () => subscription(),
        releaseTask: (...args) => {
            calls.releases.push(args);
            if (releaseThrows) { throw new VmError(releaseThrows); }
            return released;
        }
    });
    loaded.exports.TaskDetailPanel.createOrShow({ path: '/ext' }, client, 'task-release');
    assert.equal(typeof listener, 'function', 'the panel registered no message listener');
    return { html: panel.webview.html, state, calls, send: message => listener(message) };
}

const button = `<button class="btn btn-secondary" id="releaseAgentBtn">${BUTTON_LABEL}</button>`;

// ===========================================================================
// The bundle contract this file relies on
// ===========================================================================

test('the JetBrains bundle gives plain-text placeholders and a label a VS Code modal can use', () => {
    assert.equal(BUTTON_LABEL, 'Release Agent');
    assert.equal(RELEASE_REASON, 'Released from board');
    assert.equal(CONFIRM_TEMPLATE.split('{0}').length, 2, 'the confirm text holds exactly one {0}');
    assert.equal(CONFIRM_TEMPLATE.split('{1}').length, 2, 'the confirm text holds exactly one {1}');
    // MessageFormat treats a single quote as an escape and a backslash would be a
    // properties escape: with neither, a plain {0}/{1} substitution is the same text.
    assert.ok(!CONFIRM_TEMPLATE.includes("'") && !CONFIRM_TEMPLATE.includes('\\'), 'the template must stay a plain string');
});

// ===========================================================================
// 1. The button
// ===========================================================================

test('the Release Agent button renders in the actions bar for an assigned task, whatever its status', () => {
    for (const status of ['PLANNING', 'WORKING', 'BLOCKED', 'REVIEW']) {
        const { html } = open({ task: { status, assignedWorkerId: 'w1' } });
        assert.equal(html.split('id="releaseAgentBtn"').length, 2, `${status}: exactly one button`);
        const at = html.indexOf(button);
        assert.ok(at > html.indexOf('id="actionsBar"'), `${status}: the button is inside the actions bar`);
        assert.ok(at < html.indexOf('id="initial-data"'), `${status}: the button precedes the page footer`);
    }
});

test('no Release Agent button for a missing, null, empty or whitespace-only worker id', () => {
    for (const assignedWorkerId of [undefined, null, '', '   ', '\t\n']) {
        const { html } = open({ task: { assignedWorkerId } });
        assert.ok(!html.includes('releaseAgentBtn'), `${JSON.stringify(assignedWorkerId)} renders no release button`);
        assert.ok(html.includes('id="saveBtn"'), 'the rest of the actions bar is unchanged');
    }
});

// ===========================================================================
// 2. The message handler
// ===========================================================================

test('confirm: the modal carries the bundle text, and releaseTask is called once with the bundle reason', async () => {
    const { calls, send } = open({ answer: BUTTON_LABEL });
    await send({ type: 'releaseAgent' });
    assert.equal(calls.warnings.length, 1, 'the modal is the only warning');
    const [text, options, item, ...extra] = calls.warnings[0];
    // The raw title has quotes, < and &: an HTML-escaped modal would fail here.
    assert.equal(text, expectedConfirm('w1', 'Ship "release" <fast> & safe'));
    assert.equal(options.modal, true);
    assert.equal(item, BUTTON_LABEL);
    assert.equal(extra.length, 0);
    assert.equal(calls.releases.length, 1);
    assert.equal(JSON.stringify(calls.releases[0]), JSON.stringify(['task-release', RELEASE_REASON]));
    assert.equal(calls.errors.length, 0);
    assert.equal(calls.infos.length, 0, 'no success toast: the board update is the feedback');
});

test('the placeholders are substituted in one pass: a worker id or title that looks like one is never re-scanned', async () => {
    const workerId = 'w{1}$&$1';
    const title = 'T{0}';
    const { calls, send } = open({ task: { assignedWorkerId: workerId, title }, answer: BUTTON_LABEL });
    await send({ type: 'releaseAgent' });
    assert.equal(calls.warnings[0][0], expectedConfirm(workerId, title));
});

test('dismiss: releaseTask is never called and nothing else is shown', async () => {
    const { calls, send } = open({ answer: undefined });
    await send({ type: 'releaseAgent' });
    assert.equal(calls.warnings.length, 1, 'only the modal');
    assert.equal(calls.releases.length, 0);
    assert.equal(calls.infos.length + calls.errors.length, 0);
});

test('a false return from releaseTask shows the not-connected warning', async () => {
    const { calls, send } = open({ answer: BUTTON_LABEL, released: false });
    await send({ type: 'releaseAgent' });
    assert.equal(calls.releases.length, 1);
    assert.equal(calls.warnings.length, 2);
    assert.deepEqual(calls.warnings[1], [NOT_CONNECTED]);
    assert.equal(calls.errors.length, 0);
});

test('stale button: a task that lost its agent since render gets an info message, no modal and no release', async () => {
    for (const gone of [null, '', '   ']) {
        const { state, calls, send } = open({ answer: BUTTON_LABEL });
        state.tasks[0].assignedWorkerId = gone;
        await send({ type: 'releaseAgent' });
        assert.deepEqual(calls.infos, [[NO_AGENT]]);
        assert.equal(calls.warnings.length, 0, 'no modal');
        assert.equal(calls.releases.length, 0);
    }
});

test('the modal uses the CURRENT worker id and title, not the render-time ones', async () => {
    const { state, calls, send } = open({ answer: BUTTON_LABEL });
    state.tasks[0].assignedWorkerId = 'w2';
    state.tasks[0].title = 'Renamed';
    await send({ type: 'releaseAgent' });
    assert.equal(calls.warnings[0][0], expectedConfirm('w2', 'Renamed'));
    assert.equal(calls.releases.length, 1);
});

test('an exception from releaseTask lands in the handler catch as an error message', async () => {
    const { calls, send } = open({ answer: BUTTON_LABEL, releaseThrows: 'socket is gone' });
    await send({ type: 'releaseAgent' });
    assert.deepEqual(calls.errors, [['Task action failed: socket is gone']]);
});

// ===========================================================================
// 3. The page
// ===========================================================================

function makeNode(tagName, id) {
    const node = {
        tagName, id, className: '', value: '', text: '', dataset: {}, style: {}, children: [], listeners: {},
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

/**
 * Loads media/taskDetail.js on the page the panel rendered. Like a real DOM,
 * getElementById answers null for an id the HTML does not hold, so a missing null
 * guard in the script throws at load instead of being papered over by a fake node.
 */
function loadDetailPage(html) {
    const nodes = {};
    const element = id => {
        if (!html.includes(`id="${id}"`)) { return null; }
        return (nodes[id] = nodes[id] || makeNode('div', id));
    };
    element('initial-data').dataset = initialDataset(html);
    const posted = [];
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) }),
        document: {
            getElementById: element,
            createElement: tag => makeNode(tag, null),
            createTextNode: value => { const n = makeNode('#text', null); n.textContent = value; return n; }
        },
        window: { addEventListener() {} },
        console
    });
    vm.runInContext(DETAIL_SCRIPT, context, { filename: 'taskDetail.js' });
    return { posted, click: id => element(id).click() };
}

test('the page posts {type:"releaseAgent"} when the button is clicked, and nothing at load', () => {
    const { html } = open({});
    const page = loadDetailPage(html);
    assert.deepEqual(page.posted, [], 'loading the page posts nothing');
    page.click('releaseAgentBtn');
    assert.deepEqual(page.posted, [{ type: 'releaseAgent' }]);
});

test('an unassigned task page loads without throwing and has nothing to click', () => {
    const { html } = open({ task: { assignedWorkerId: null } });
    let page;
    assert.doesNotThrow(() => { page = loadDetailPage(html); }, 'the page script must guard the absent button');
    assert.deepEqual(page.posted, []);
    assert.ok(!html.includes('releaseAgentBtn'), 'there is no button to click');
});

// Real-client force-release regressions: raw frames, live cache updates and errors.
const CLIENT_SOURCE = transpile('src/services/MoeDaemonClient.ts');
const FORCE_FRAME = '{"type":"RELEASE_TASK","payload":{"taskId":"task-release","reason":"Released from board","force":true}}';
const PLAIN_FRAME = '{"type":"RELEASE_TASK","payload":{"taskId":"task-release","reason":"Released from board"}}';
const step = (stepId, status) => ({ stepId, description: stepId, status, affectedFiles: [] });
const midTask = (overrides = {}) => makeTask({ assignedWorkerId: 'w-mid', implementationPlan: [
    step('step-1', 'COMPLETED'), step('step-2', 'IN_PROGRESS'), step('step-3', 'IN_PROGRESS')
], ...overrides });

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

function liveVscode(panel, calls, answers, onWarning) {
    return {
        EventEmitter: RecordingEventEmitter, ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        workspace: { getConfiguration: () => ({ get: () => false }) },
        window: strict('vscode.window', {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createWebviewPanel: () => panel,
            showWarningMessage: (...args) => {
                const index = calls.warnings.push(args) - 1;
                onWarning?.(index, args);
                return Promise.resolve(answers[index]);
            },
            showInformationMessage: (...args) => { calls.infos.push(args); return Promise.resolve(undefined); },
            showErrorMessage: (...args) => { calls.errors.push(args); return Promise.resolve(undefined); }
        })
    };
}

function openLive({ task = midTask(), answers = [], onWarning } = {}) {
    const calls = { warnings: [], infos: [], errors: [] };
    let listener;
    const panel = {
        webview: {
            html: '', cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
            onDidReceiveMessage: fn => { listener = fn; return subscription(); },
            postMessage: () => Promise.resolve(true)
        },
        onDidDispose: subscription, reveal() {}, dispose() {}
    };
    const vscode = liveVscode(panel, calls, answers, onWarning);
    function StubWebSocket() { throw new Error('no real socket'); }
    StubWebSocket.OPEN = 1;
    const globals = { process, setTimeout, clearTimeout, setInterval, clearInterval };
    const loaded = loadModule(CLIENT_SOURCE, 'MoeDaemonClient.ts', {
        vscode, ws: StubWebSocket, fs, path, net: require('node:net'),
        child_process: { spawn() { throw new Error('unexpected spawn'); } }
    }, globals);
    const client = new loaded.exports.MoeDaemonClient('extension');
    const sent = [];
    client['ws'] = { readyState: 1, send: frame => sent.push(frame), close() {} };
    client['_connectionState'] = 'connected';
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    deliver({ type: 'STATE_SNAPSHOT', payload: {
        project: { id: 'p', name: 'p', settings: {} }, epics: [], workers: [], proposals: [], tasks: [task]
    } });
    const review = loadModule(PLAN_REVIEW_SOURCE, 'PlanReviewPanel.ts', { vscode }, globals);
    const detail = loadModule(PANEL_SOURCE, 'TaskDetailPanel.ts', { vscode, './PlanReviewPanel': review.exports }, globals);
    const instance = detail.exports.TaskDetailPanel.createOrShow({ path: '/ext' }, client, task.id);
    assert.equal(typeof listener, 'function');
    return { sent, calls, client, deliver, send: () => listener({ type: 'releaseAgent' }),
        dispose: () => { try { instance.dispose(); } finally { client.dispose(); } } };
}

test('RF1 bundle: force texts stay plain MessageFormat-compatible strings', () => {
    for (const text of [FORCE_TEMPLATE, FORCE_TITLE, STALE_TEMPLATE]) {
        assert.ok(text.length > 0 && !text.includes("'") && !text.includes('\\'));
    }
    assert.equal(FORCE_TEMPLATE.split('{0}').length, 3);
    for (const token of ['{1}', '{2}']) { assert.equal(FORCE_TEMPLATE.split(token).length, 2); }
    for (const token of ['{0}', '{1}']) { assert.equal(STALE_TEMPLATE.split(token).length, 2); }
    assert.equal(FORCE_TITLE, 'Force Release Agent');
});

test('RF2 force: two confirmations name the first leased step and send one force frame', async () => {
    for (const task of [midTask(), midTask({ assignedWorkerId: 'w{2}$&', implementationPlan: [step('s{0}', 'IN_PROGRESS')] })]) {
        const h = openLive({ task, answers: [BUTTON_LABEL, FORCE_TITLE] });
        try {
            await h.send();
            const warnings = h.calls.warnings;
            assert.equal(warnings.length, 2);
            assert.equal(warnings[0][0], expectedText(CONFIRM_TEMPLATE, task.assignedWorkerId, task.title));
            assert.equal(warnings[1].length, 3);
            const stepId = task.implementationPlan.find(s => s.status === 'IN_PROGRESS').stepId;
            assert.equal(warnings[1][0], expectedText(FORCE_TEMPLATE, task.assignedWorkerId, stepId, task.title));
            assert.equal(JSON.stringify(warnings[1][1]), '{"modal":true}');
            assert.equal(warnings[1][2], FORCE_TITLE);
            assert.deepEqual(h.sent, [FORCE_FRAME]);
            assert.deepEqual([h.calls.infos, h.calls.errors], [[], []]);
        } finally { h.dispose(); }
    }
    const h = openLive({ answers: [BUTTON_LABEL, FORCE_TITLE], onWarning: index => { if (index === 1) h.client.disconnect(); } });
    try {
        await h.send();
        assert.deepEqual(h.sent, []);
        assert.equal(h.calls.warnings.length, 3);
        assert.deepEqual(h.calls.warnings[2], [NOT_CONNECTED]);
        assert.deepEqual([h.calls.infos, h.calls.errors], [[], []]);
    } finally { h.dispose(); }
});

test('RF3 decline: dismissing either modal sends nothing', async () => {
    for (const answers of [[undefined], [BUTTON_LABEL, undefined]]) {
        const h = openLive({ answers });
        try {
            await h.send();
            assert.equal(h.calls.warnings.length, answers.length);
            assert.deepEqual(h.sent, []);
            assert.deepEqual([h.calls.infos, h.calls.errors], [[], []]);
        } finally { h.dispose(); }
    }
});

test('RF4 plain: completed or pending steps and an empty plan keep the original frame', async () => {
    for (const implementationPlan of [[step('step-1', 'COMPLETED'), step('step-2', 'PENDING')], [], undefined, null, {}, [{ stepId: 'no-status' }]]) {
        const h = openLive({ answers: [BUTTON_LABEL], onWarning: index => {
            // A newly started step must not upgrade a plain confirmation to force.
            if (index === 0) h.deliver({ type: 'TASK_UPDATED', payload: midTask() });
        } });
        try {
            // Update after initial rendering: this isolates the lease guard from
            // the renderer's separate assumptions about the plan's shape.
            h.deliver({ type: 'TASK_UPDATED', payload: midTask({ implementationPlan }) });
            await h.send();
            assert.equal(h.calls.warnings.length, 1);
            assert.deepEqual(h.sent, [PLAIN_FRAME]);
            assert.deepEqual([h.calls.infos, h.calls.errors], [[], []]);
        } finally { h.dispose(); }
    }
});

test('RF5 stale: changed or vanished leases are refused but a newer equal lease still forces', async () => {
    const updates = [
        { assignedWorkerId: 'w-new' },
        { implementationPlan: [step('step-2', 'COMPLETED'), step('step-3', 'IN_PROGRESS')] },
        { implementationPlan: [step('step-2', 'COMPLETED')] },
        { assignedWorkerId: null }, null, { title: 'Renamed while confirming' }
    ];
    for (const warningIndex of [0, 1]) for (const update of updates) {
        const equalLease = update?.title !== undefined;
        const h = openLive({ answers: [BUTTON_LABEL, FORCE_TITLE], onWarning: index => {
            if (index === warningIndex) h.deliver(update === null
                ? { type: 'TASK_DELETED', payload: { id: 'task-release' } }
                : { type: 'TASK_UPDATED', payload: midTask(update) });
        } });
        try {
            await h.send();
            assert.equal(h.calls.warnings.length, equalLease ? 2 : 3);
            assert.equal(h.calls.warnings[1][0], expectedText(FORCE_TEMPLATE, 'w-mid', 'step-2', midTask().title));
            assert.deepEqual(h.sent, equalLease ? [FORCE_FRAME] : []);
            if (!equalLease) assert.deepEqual(h.calls.warnings[2], [expectedText(STALE_TEMPLATE, 'w-mid', 'step-2')]);
            assert.deepEqual([h.calls.infos, h.calls.errors], [[], []]);
        } finally { h.dispose(); }
    }
});

test('RF6 refusal: only a RELEASE_TASK error correlated to this panel is shown once', () => {
    const h = openLive();
    const frame = { type: 'ERROR', operation: 'RELEASE_TASK', code: -32003, codeName: 'STEP_LEASE_HELD',
        message: '[STEP_LEASE_HELD] Task task-release is leased by w-mid with step step-2 IN_PROGRESS; only a governor or a human may override that lease (moe.release_task force), and only for a confirmed-dead holder',
        context: { taskId: 'task-release' } };
    try {
        h.deliver({ ...frame, context: { taskId: 'task-other' } });
        h.deliver({ ...frame, operation: 'UPDATE_TASK' });
        const { context, ...contextless } = frame;
        h.deliver(contextless);
        assert.deepEqual([h.calls.errors, h.calls.warnings, h.calls.infos], [[], [], []]);
        h.deliver(frame);
        assert.deepEqual(h.calls.errors, [['Agent was not released: ' + frame.message]]);
        assert.deepEqual([h.calls.warnings, h.calls.infos, h.sent], [[], [], []]);
    } finally { h.dispose(); }
});

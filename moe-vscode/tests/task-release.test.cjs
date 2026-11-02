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

const BUNDLE_KEYS = ['moe.button.releaseAgent', 'moe.message.releaseAgent', 'moe.message.releasedInUI'];

function readBundle() {
    const text = fs.readFileSync(BUNDLE_PATH, 'utf8');
    const values = {};
    for (const [, key, value] of text.matchAll(/^(moe\.(?:button\.releaseAgent|message\.releaseAgent|message\.releasedInUI))=(.*?)\r?$/gm)) {
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
function loadModule(source, filename, dependencies) {
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, console,
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

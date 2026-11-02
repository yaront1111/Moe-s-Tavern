'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// VSC-23: the task detail's Delivery section and Release Agent button follow
// live updates. All production source: the real TaskDetailPanel (transpiled under
// node:vm, strict require map) renders the page and posts each 'updateTask'; the
// raw media/taskDetail.js applies it to a DOM fake that answers getElementById
// like a real DOM and refuses every property write outside an allowlist, so
// daemon text can only reach the page as text.
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const transpile = relative => ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const PANEL_SOURCE = transpile('src/panels/TaskDetailPanel.ts');
const PLAN_REVIEW_SOURCE = transpile('src/panels/PlanReviewPanel.ts');
const DETAIL_SCRIPT = read('media/taskDetail.js');
const CORPUS = JSON.parse(read('../moe-jetbrains/src/test/resources/client-delivery.json'));
const RELEASE_LABEL = /^moe\.button\.releaseAgent=(.*?)\r?$/m.exec(read('../moe-jetbrains/src/main/resources/messages/MoeBundle.properties'))[1];

function loadModule(source, filename, dependencies, globals = {}) {
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({
        ...globals, exports: module.exports, module, console,
        require: name => {
            if (Object.prototype.hasOwnProperty.call(dependencies, name)) { return dependencies[name]; }
            throw new Error(`unexpected require from ${filename}: ${name}`);
        }
    }), { filename });
    return module.exports;
}

const subscription = () => ({ dispose() {} });
const makeTask = (overrides = {}) => ({
    id: 'task-live', epicId: 'epic-live', title: 'Live detail', description: 'd', definitionOfDone: [],
    status: 'WORKING', priority: 'MEDIUM', assignedWorkerId: null, implementationPlan: [], comments: [], ...overrides
});

// The real panel on `task`, a fresh module each time (the panel keeps a static
// map). update(next) swaps the task, fires onStateChanged, runs the debounce and
// returns the message as the webview receives it (serialized).
function openPanel(task) {
    const state = { tasks: [task], epics: [] };
    const posted = [];
    const timers = [];
    let changed;
    const webview = {
        html: '', cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path, onDidReceiveMessage: subscription,
        postMessage: message => { posted.push(JSON.parse(JSON.stringify(message))); return Promise.resolve(true); }
    };
    const panel = { webview, onDidDispose: subscription, reveal() {}, dispose() {} };
    const vscode = {
        ViewColumn: { One: 1 }, Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
        window: { createWebviewPanel: () => panel }
    };
    const planReview = loadModule(PLAN_REVIEW_SOURCE, 'PlanReviewPanel.ts', { vscode });
    const { TaskDetailPanel } = loadModule(PANEL_SOURCE, 'TaskDetailPanel.ts', { vscode, './PlanReviewPanel': planReview },
        { setTimeout: fn => timers.push(fn), clearTimeout: () => {} });
    const client = {
        get currentState() { return state; }, onError: subscription, onConnectionChanged: subscription,
        onStateChanged: fn => { changed = fn; return subscription(); }
    };
    TaskDetailPanel.createOrShow({ path: '/ext' }, client, task.id);
    return {
        html: webview.html,
        update(next) {
            state.tasks = [next];
            changed();
            timers.splice(0).forEach(fn => fn());
            assert.deepEqual(posted.map(message => message.type), ['updateTask'], 'one state change posts one update');
            return posted.pop();
        }
    };
}

// DOM fake: reading a member a node lacks throws, and so does writing any
// property outside WRITABLE, so the page cannot hand text to the browser as markup
// (and this file never names the property it would use).
const WRITABLE = new Set(['className', 'id', 'title', 'textContent', 'value', 'scrollTop']);
const inner = new WeakMap();
function makeNode(tagName) {
    const state = { kids: [], text: '', parent: null };
    const detach = child => {
        const of = inner.get(child);
        if (of.parent) { inner.get(of.parent).kids.splice(inner.get(of.parent).kids.indexOf(child), 1); of.parent = null; }
    };
    const target = {
        tagName, id: '', className: '', title: '', value: '', scrollTop: 0, scrollHeight: 0, dataset: {}, listeners: [],
        get children() { return state.kids.slice(); },
        get parentNode() { return state.parent; },
        get nextSibling() { const kids = state.parent ? inner.get(state.parent).kids : []; return kids[kids.indexOf(node) + 1] || null; },
        get textContent() { return state.kids.length > 0 ? state.kids.map(kid => kid.textContent).join('') : state.text; },
        set textContent(value) { state.kids.slice().forEach(detach); state.text = String(value); },
        insertBefore(child, ref) {
            const at = ref === null ? state.kids.length : state.kids.indexOf(ref);
            if (at < 0) { throw new Error(`insertBefore: the reference is not a child of ${tagName}`); }
            detach(child);
            state.kids.splice(at, 0, child);
            inner.get(child).parent = node;
            return child;
        },
        appendChild: child => target.insertBefore(child, null),
        removeChild(child) {
            if (!state.kids.includes(child)) { throw new Error(`removeChild: not a child of ${tagName}`); }
            detach(child);
            return child;
        },
        addEventListener(type, handler) { target.listeners.push([type, handler]); },
        click() { target.listeners.filter(([type]) => type === 'click').forEach(([, handler]) => handler({})); }
    };
    const node = new Proxy(target, {
        get(t, key) {
            if (typeof key === 'symbol' || key in t) { return Reflect.get(t, key); }
            throw new Error(`unexpected read of ${tagName}.${key}`);
        },
        set(t, key, value) {
            if (!WRITABLE.has(key)) { throw new Error(`refused write to ${tagName}.${String(key)}`); }
            return Reflect.set(t, key, value);
        }
    });
    inner.set(node, state);
    return node;
}

const find = (node, id) => (node.id === id ? node : node.children.reduce((hit, kid) => hit || find(kid, id), null));

// media/taskDetail.js on the page the panel rendered: every id="..." becomes an
// element, in document order, under the main content until #actionsBar and inside
// the actions bar after it; #initial-data gets its data-* attributes.
function loadPage(html) {
    const body = makeNode('body');
    const main = body.appendChild(makeNode('div'));
    let parent = main;
    for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
        const element = makeNode(id.endsWith('Btn') ? 'button' : 'div');
        element.id = id;
        (id === 'actionsBar' || id === 'initial-data' ? body : parent).appendChild(element);
        if (id === 'actionsBar') { parent = element; }
    }
    const data = /<div id="initial-data"[^>]*>/.exec(html)[0];
    for (const [, name, value] of data.matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) {
        find(body, 'initial-data').dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    const posted = [];
    let onMessage;
    vm.runInContext(DETAIL_SCRIPT, vm.createContext({
        acquireVsCodeApi: () => ({ postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) }),
        document: {
            getElementById: id => find(body, id), createElement: tag => makeNode(tag),
            createTextNode: value => { const text = makeNode('#text'); text.textContent = value; return text; }
        },
        window: { addEventListener: (type, handler) => { if (type === 'message') { onMessage = handler; } } },
        console
    }), { filename: 'taskDetail.js' });
    assert.equal(typeof onMessage, 'function', 'taskDetail.js registered no message handler');
    return { byId: id => find(body, id), main, posted, deliver: message => onMessage({ data: message }) };
}

// The Delivery section as { title, rows }, read off the initial markup and off the live DOM.
const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
function initialSection(html) {
    const title = /<div class="delivery-section" id="deliverySection"><div class="section-title">([^<]*)<\/div>/.exec(html);
    const rows = [...html.matchAll(/<div class="(delivery-row[^"]*)"><div class="field-label">([^<]*)<\/div><div class="delivery-value" title="([^"]*)">([^<]*)<\/div><\/div>/g)];
    return title && { title: unescape(title[1]), rows: rows.map(([, cls, label, full, value]) => [cls, label, full, value].map(unescape)) };
}
function liveSection(page) {
    const section = page.byId('deliverySection');
    if (!section) { return null; }
    const [heading, ...rows] = section.children;
    assert.equal(heading.className, 'section-title');
    return { title: heading.textContent, rows: rows.map(row => [row.className, row.children[0].textContent, row.children[1].title, row.children[1].textContent]) };
}

test('L0: the DOM fake refuses markup writes and unknown members, and finds only attached ids', () => {
    const page = loadPage(openPanel(makeTask()).html);
    assert.throws(() => { page.byId('blockerSection').outerHTML = '<b>x</b>'; }, /refused write/);
    assert.throws(() => page.byId('blockerSection').insertAdjacentText, /unexpected read/);
    assert.deepEqual([page.byId('deliverySection'), page.byId('releaseAgentBtn')], [null, null]);
});

test('L1: a live update renders every corpus row exactly as the initial markup does', () => {
    const failures = [];
    for (const row of CORPUS.rows) {
        const opened = openPanel(makeTask());
        const page = loadPage(opened.html);
        page.deliver(opened.update(makeTask({ delivery: row.delivery })));
        const want = initialSection(openPanel(makeTask({ delivery: row.delivery })).html);
        const got = liveSection(page);
        if (JSON.stringify(got) !== JSON.stringify(want)) { failures.push(`${row.id}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
    }
    assert.deepEqual(failures, []);
});

test('L2: #deliverySection goes right after #blockerSection, is rebuilt in place and goes with the delivery', () => {
    const first = { latestCheckRun: { command: 'npm test', exitCode: 0 } };
    const second = { latestCheckRun: { command: 'npm run lint', exitCode: 2 }, attemptPhase: 'review' };
    for (const start of [undefined, first]) {
        const opened = openPanel(makeTask({ delivery: start }));
        const page = loadPage(opened.html);
        const typed = { titleInput: 'half a tit', descriptionInput: 'mid-edit', dodInput: 'one\ntw' };
        Object.entries(typed).forEach(([id, value]) => { page.byId(id).value = value; });
        for (const delivery of [first, second]) {
            page.deliver(opened.update(makeTask({ delivery })));
            const ids = page.main.children.map(node => node.id);
            assert.equal(ids.filter(id => id === 'deliverySection').length, 1, 'one section');
            assert.equal(ids[ids.indexOf('blockerSection') + 1], 'deliverySection', 'right after #blockerSection');
            assert.deepEqual(liveSection(page), initialSection(openPanel(makeTask({ delivery })).html));
        }
        for (const gone of [makeTask({ delivery: null }), makeTask()]) {
            page.deliver(opened.update(makeTask({ delivery: first })));
            page.deliver(opened.update(gone));
            assert.equal(page.byId('deliverySection'), null, 'no delivery, no section');
        }
        Object.entries(typed).forEach(([id, value]) => assert.equal(page.byId(id).value, value, `${id} keeps its unsaved text`));
    }
});

test('L3: runner-reported text is posted unescaped and lands as a plain text value', () => {
    const hostile = '<img src=x onerror="alert(1)"> & \'quoted\'';
    const opened = openPanel(makeTask());
    const page = loadPage(opened.html);
    const message = opened.update(makeTask({ delivery: { latestCheckRun: { command: hostile }, deliveryReceipt: { target: hostile } } }));
    assert.deepEqual(message.delivery.rows.map(row => [row.value, row.fullValue]), [[hostile, hostile], [hostile, hostile]]);
    page.deliver(message);
    const values = page.byId('deliverySection').children.slice(1).map(row => row.children[1]);
    assert.deepEqual(values.map(value => [value.textContent, value.title, value.children.length]), [[hostile, hostile, 0], [hostile, hostile, 0]]);
});

test('L4: the Release Agent button follows assignedWorkerId, stays single, and posts once per click', () => {
    for (const start of [null, 'w0']) {
        const opened = openPanel(makeTask({ assignedWorkerId: start }));
        const page = loadPage(opened.html);
        for (const step of ['w1', 'w2', null, 'w3', '', 'w4', '   ', 'w5', undefined, 'w6']) {
            const message = opened.update(makeTask({ assignedWorkerId: step }));
            const shown = typeof step === 'string' && step.trim() !== '';
            assert.equal(message.releaseAgentLabel, shown ? RELEASE_LABEL : null, `label for ${JSON.stringify(step)}`);
            const before = page.byId('releaseAgentBtn');
            page.deliver(message);
            const button = page.byId('releaseAgentBtn');
            if (!shown) { assert.equal(button, null, `no button for ${JSON.stringify(step)}`); continue; }
            const ids = page.byId('actionsBar').children.map(node => node.id);
            assert.equal(ids.filter(id => id === 'releaseAgentBtn').length, 1, `one button for ${step}`);
            assert.equal(ids[ids.indexOf('releaseAgentBtn') + 1], 'prevBtn', 'just before Prev');
            if (before) { assert.equal(button, before, 'a shown button is kept, never rebuilt'); continue; }
            // Built live: the element the initial render emits for an assigned task.
            const markup = `<${button.tagName} class="${button.className}" id="releaseAgentBtn">${button.textContent}</${button.tagName}>`;
            assert.ok(openPanel(makeTask({ assignedWorkerId: step })).html.includes(markup), markup);
        }
        page.byId('releaseAgentBtn').click();
        assert.deepEqual(page.posted, [{ type: 'releaseAgent' }]);
    }
});

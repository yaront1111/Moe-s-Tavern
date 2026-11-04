'use strict';

// Amended plan steps (task-e9a25fbf; the JetBrains twin is 3b56ee35). moe.amend_plan_step keeps a
// step's `description` and appends to `amendments`, pointing `activeAmendmentId` at the entry in
// force; the plan revision every approval binds to covers that text
// (packages/moe-daemon/src/util/planAmendments.ts). Every VS Code renderer of a step must show it:
// the Plan Review and Task Detail HTML (the real panels, transpiled) and their live updates
// (media/planReview.js and media/taskDetail.js, run raw under node:vm).

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

/** Run a transpiled panel in its own context; a require outside `deps` throws. */
function runModule(relative, deps) {
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
        require: dep => {
            if (Object.prototype.hasOwnProperty.call(deps, dep)) { return deps[dep]; }
            throw new Error(`unexpected require from ${relative}: ${dep}`);
        }
    });
    vm.runInContext(transpile(relative), context, { filename: relative });
    return module.exports;
}

const planReview = runModule('src/panels/PlanReviewPanel.ts', { vscode: {}, '../services/MoeDaemonClient': {} });
const taskDetail = runModule('src/panels/TaskDetailPanel.ts', {
    vscode: {}, '../services/MoeDaemonClient': {}, './PlanReviewPanel': planReview
});

/** A DOM element stand-in: enough for the two webview scripts to load and render their steps. */
function element(tag) {
    const node = {
        tag, className: '', title: '', style: {}, dataset: {}, attributes: {}, children: [], listeners: {},
        value: '', disabled: false, parentNode: null, ownText: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
        removeEventListener() {},
        appendChild(child) { node.children.push(child); return child; },
        insertBefore(child) { node.children.push(child); return child; },
        removeChild() {}, remove() {},
        setAttribute(name, value) { node.attributes[name] = String(value); },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
        querySelector: () => null, querySelectorAll: () => []
    };
    Object.defineProperty(node, 'textContent', {
        get: () => node.ownText + node.children.map(child => child.textContent).join(''),
        set: value => { node.ownText = String(value); node.children = []; }
    });
    return node;
}

/** Load a raw webview script; the returned function renders steps and returns their container. */
function loadWebview(relative, containerId) {
    const nodes = new Map();
    const byId = id => { if (!nodes.has(id)) { nodes.set(id, element('#' + id)); } return nodes.get(id); };
    byId('initial-data').dataset = { taskId: 'task-1', taskStatus: 'AWAITING_APPROVAL', planRevision: '2' };
    const ignore = () => {};
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage: ignore, getState: () => undefined, setState: ignore }),
        document: {
            getElementById: byId,
            createElement: element,
            createTextNode: text => { const n = element('#text'); n.textContent = text; return n; },
            addEventListener: ignore,
            body: element('body')
        },
        window: { addEventListener: ignore },
        setTimeout: () => 0, clearTimeout: ignore, console
    });
    vm.runInContext(fs.readFileSync(file(relative), 'utf8'), context, { filename: relative });
    return steps => { context.renderSteps(steps); return byId(containerId); };
}

const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&amp;/g, '&');

/** The first step of panel HTML: its description text and its "Amended by" line, entities decoded. */
function fromHtml(html) {
    const description = /<div class="step-description">([\s\S]*?)<\/div>/.exec(html);
    const marker = /<div class="step-amended" title="([^"]*)">([\s\S]*?)<\/div>/.exec(html);
    return {
        description: description ? decode(description[1]) : null,
        marker: marker ? { text: decode(marker[2]), title: decode(marker[1]) } : null,
        html
    };
}

/** The first step card a webview rendered: the same two parts, read as DOM text. */
function fromDom(container) {
    const card = container.children[0];
    const part = cls => (card ? card.children : []).find(node => node.className === cls) || null;
    const description = part('step-description');
    const marker = part('step-amended');
    return {
        description: description ? description.textContent : null,
        marker: marker ? { text: marker.textContent, title: marker.title } : null,
        html: ''
    };
}

const planReviewLive = loadWebview('media/planReview.js', 'stepsContent');
const taskDetailLive = loadWebview('media/taskDetail.js', 'planContent');
const RENDERERS = [
    ['plan-review-html', steps => fromHtml(planReview.PlanReviewPanel.prototype.renderSteps.call({}, steps))],
    ['plan-review-live', steps => fromDom(planReviewLive(steps))],
    ['task-detail-html', steps => fromHtml(taskDetail.TaskDetailPanel.prototype.renderSteps.call({}, steps))],
    ['task-detail-live', steps => fromDom(taskDetailLive(steps))]
];

const ORIGINAL = 'Edit src/a.ts only';
const step = extra => ({ stepId: 'step-1', description: ORIGINAL, status: 'PENDING', affectedFiles: ['src/a.ts'], ...extra });
const amend = (amendmentId, description, extra = {}) => ({
    amendmentId, description, reason: 'scope grew', amendedBy: 'architect-7', amendedAt: '2026-11-03T17:00:00.000Z', ...extra
});
const marker = (by, original = ORIGINAL) => ({ text: 'Amended by ' + by, title: 'Original step: ' + original });

// Rows that must show an amendment. Their ids start with A: the RED re-proof counts them.
const AMENDED = [
    ['A1', 'shows the amendment activeAmendmentId names, not the latest one',
        step({ amendments: [amend('amend-1', 'First amended text'), amend('amend-2', 'Second amended text', { amendedBy: 'governor-2' })], activeAmendmentId: 'amend-1' }),
        { description: 'First amended text', marker: marker('architect-7') }],
    ['A2', 'names an unknown amender when amendedBy is blank',
        step({ amendments: [amend('amend-1', 'Amended text', { amendedBy: '  ' })], activeAmendmentId: 'amend-1' }),
        { description: 'Amended text', marker: marker('unknown') }],
    ['A3', 'renders hostile amendment, amender and original text as text',
        step({ description: 'Orig <i>x</i>', amendments: [amend('amend-1', '<img src=x onerror=alert(1)> & "q"', { amendedBy: '<b>w</b>' })], activeAmendmentId: 'amend-1' }),
        { description: '<img src=x onerror=alert(1)> & "q"', marker: marker('<b>w</b>', 'Orig <i>x</i>') }],
    ['A4', 'skips malformed entries before the named one, and a non-string amendedBy reads unknown',
        step({ amendments: [null, 'amend-1', { amendmentId: 'amend-1', description: 7 }, amend('amend-1', 'Valid amended text', { amendedBy: 42 })], activeAmendmentId: 'amend-1' }),
        { description: 'Valid amended text', marker: marker('unknown') }]
];

// Rows that must show the original text and no marker.
const UNAMENDED = [
    ['O1', 'shows the original text of a step that was never amended', step({})],
    ['O2', 'ignores a dangling activeAmendmentId', step({ amendments: [amend('amend-1', 'Not in force')], activeAmendmentId: 'amend-9' })],
    ['O3', 'ignores a blank activeAmendmentId', step({ amendments: [amend('amend-1', 'Not in force')], activeAmendmentId: '' })],
    ['O4', 'ignores amendments that are not an array', step({ amendments: { 0: amend('amend-1', 'Not in force') }, activeAmendmentId: 'amend-1' })],
    ['O5', 'ignores a named entry whose description is not a string', step({ amendments: [amend('amend-1', ['Not', 'text'])], activeAmendmentId: 'amend-1' })],
    ['O6', 'ignores a non-string activeAmendmentId', step({ amendments: [amend('amend-1', 'Not in force')], activeAmendmentId: 1 })]
];

for (const [id, label, input, expected] of AMENDED) {
    for (const [name, render] of RENDERERS) {
        test(`${id} ${name}: ${label}`, () => {
            const got = render([input]);
            assert.deepEqual({ description: got.description, marker: got.marker }, expected);
            assert.doesNotMatch(got.html, /<(img|b|i)\b/, 'step text reached the HTML unescaped');
        });
    }
}

for (const [id, label, input] of UNAMENDED) {
    for (const [name, render] of RENDERERS) {
        test(`${id} ${name}: ${label}`, () => {
            const got = render([input]);
            assert.deepEqual({ description: got.description, marker: got.marker }, { description: ORIGINAL, marker: null });
            assert.doesNotMatch(got.html, /step-amended/);
        });
    }
}

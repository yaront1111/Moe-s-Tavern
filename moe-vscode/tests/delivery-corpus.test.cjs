const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// The task detail's Delivery section is the VS Code copy of JetBrains'
// DeliveryPresentation.rows (moe-jetbrains/src/main/kotlin/com/moe/toolwindow).
// Both clients replay ONE held-out corpus, landed by VSC-3 (task-a5f39d55):
// wire JSON in, display rows out. This file only reads it: a row VS Code cannot
// meet because JetBrains is wrong is filed against JetBrains, never edited here.
const corpusPath = path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-delivery.json');
const bundlePath = path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties');
const panelPath = path.join(__dirname, '../src/panels/TaskDetailPanel.ts');
const planReviewPath = path.join(__dirname, '../src/panels/PlanReviewPanel.ts');

function readText(file, what) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`cannot read the ${what} at ${file}: ${error.message}`);
    }
}

function readCorpus() {
    const text = readText(corpusPath, 'delivery corpus');
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`the delivery corpus at ${corpusPath} is not valid JSON: ${error.message}`);
    }
}

function transpile(sourcePath) {
    return ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText;
}

const panelSource = transpile(panelPath);
const planReviewSource = transpile(planReviewPath);

// A stub that throws on any member it does not define, so a new IDE or
// transport dependency fails loudly instead of rendering against undefined.
function strict(name, members) {
    return new Proxy(members, {
        get(target, key) {
            if (typeof key === 'symbol' || key in target) { return Reflect.get(target, key); }
            throw new Error(`unexpected access to ${name}.${key}`);
        }
    });
}

const subscription = () => strict('Disposable', { dispose() {} });
const fakeUri = (base, ...segments) => ({ path: [base.path, ...segments].join('/') });
const fakeWebview = members => ({
    cspSource: 'vscode-webview://moe-test', asWebviewUri: uri => `vscode-webview://moe-test${uri.path}`, ...members
});

// Runs a transpiled extension module that may require only the given
// dependencies; any other require() throws.
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
    return module.exports;
}

const fakeVscode = panel => ({
    ViewColumn: strict('vscode.ViewColumn', { One: 1 }), Uri: strict('vscode.Uri', { joinPath: fakeUri }),
    window: strict('vscode.window', { createWebviewPanel: () => panel })
});

// TaskDetailPanel seeds its plan revision with PlanReviewPanel's real helper.
const panelDependencies = vscode => ({
    vscode, './PlanReviewPanel': loadModule(planReviewSource, planReviewPath, { vscode })
});

const panelModule = loadModule(panelSource, panelPath, panelDependencies(fakeVscode(null)));

// Opens the real TaskDetailPanel through createOrShow and returns the webview
// HTML it generated; the panel is disposed even when rendering throws.
function renderDetail(task) {
    const webview = fakeWebview({ html: '', onDidReceiveMessage: subscription });
    const panel = strict('WebviewPanel', { webview: strict('Webview', webview), onDidDispose: subscription, dispose() {} });
    const { TaskDetailPanel } = loadModule(panelSource, panelPath, panelDependencies(fakeVscode(panel)));
    const state = { tasks: [task], epics: [] };
    const client = strict('MoeDaemonClient', { currentState: state, onStateChanged: subscription, onError: subscription, onConnectionChanged: subscription });
    let opened;
    try {
        opened = TaskDetailPanel.createOrShow({ path: '/extension' }, client, task.id, state);
        return webview.html;
    } finally {
        if (opened) { opened.dispose(); }
    }
}

function makeTask(overrides = {}) {
    return {
        id: 'task-delivery-fixture', epicId: 'epic-delivery-fixture', title: 'Show delivery evidence in VS Code', status: 'REVIEW',
        priority: 'MEDIUM', description: 'Show the runner-reported delivery.', definitionOfDone: ['Delivery is shown'],
        implementationPlan: [], assignedWorkerId: null, prLink: null, reopenCount: 0, reopenReason: null, order: 1,
        comments: [], ...overrides
    };
}

// The panel's own five replacements. A local copy on purpose: the test must
// not call the code under test to compute what it expects.
const escapeHtml = text => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

// A value built inside the vm realm carries the vm's prototypes, and an
// undefined member would compare equal to a missing one. Round-tripping through
// JSON removes the first and drops the second, so only null passes for null.
const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));
const rowsOf = delivery => plain(panelModule.deliveryRows(delivery));

// ---------------------------------------------------------------------------
// The shared corpus
// ---------------------------------------------------------------------------

test('every corpus row renders through deliveryRows', () => {
    const corpus = readCorpus();
    assert.equal(corpus.version, 1, 'the corpus version changed: re-read the row contract before replaying it');
    assert.ok(Array.isArray(corpus.rows) && corpus.rows.length >= 12, `the corpus at ${corpusPath} holds too few rows`);
    const failures = [];
    for (const row of corpus.rows) {
        let got;
        try {
            got = rowsOf(row.delivery);
        } catch (error) {
            failures.push(`${row.id}: deliveryRows threw ${error.message}`);
            continue;
        }
        if (!util.isDeepStrictEqual(got, row.expect)) {
            failures.push(`${row.id}: expected ${JSON.stringify(row.expect)}, got ${JSON.stringify(got)}`);
        }
    }
    assert.deepStrictEqual(failures, []);
});

test("DELIVERY_LABELS equals the bundle's moe.delivery.* entries", () => {
    const bundle = readText(bundlePath, 'MoeBundle.properties');
    const parsed = {};
    for (const match of bundle.matchAll(/^(moe\.delivery\.[A-Za-z]+)=(.*?)\r?$/gm)) {
        parsed[match[1]] = match[2];
    }
    const keys = Object.keys(parsed);
    assert.ok(keys.length >= 14, `expected the title plus 13 row labels in ${bundlePath}, parsed ${keys.length}`);
    // The bundle is a .properties file: a backslash is an escape this parser does not decode.
    const escaped = keys.filter(key => parsed[key].includes('\\'));
    assert.deepStrictEqual(escaped, [], 'a bundle value uses a properties escape; teach this parser before trusting the comparison');
    assert.equal(panelModule.DELIVERY_TITLE_KEY, 'moe.delivery.title');
    assert.deepStrictEqual(plain(panelModule.DELIVERY_LABELS), parsed);
    const labels = plain(panelModule.DELIVERY_LABELS);
    const unlabelled = [];
    for (const row of readCorpus().rows) {
        for (const entry of row.expect) {
            if (!(entry.labelKey in labels)) { unlabelled.push(`${row.id}: ${entry.labelKey}`); }
        }
    }
    assert.deepStrictEqual(unlabelled, [], 'every corpus labelKey needs an English label');
});

// ---------------------------------------------------------------------------
// The rendered task detail
// ---------------------------------------------------------------------------

const ROW_PATTERN = /<div class="delivery-row(?: delivery-(pass|fail))?"><div class="field-label">([^<]*)<\/div><div class="delivery-value" title="([^"]*)">([^<]*)<\/div><\/div>/g;
const TITLE_MARKUP = '<div class="section-title">Delivery</div>';

function checkRendered(row, labels) {
    const problems = [];
    const html = renderDetail(makeTask({ delivery: row.delivery }));
    const matches = [...html.matchAll(ROW_PATTERN)];
    const rowOpenings = (html.match(/class="delivery-row/g) || []).length;
    if (rowOpenings !== row.expect.length || matches.length !== row.expect.length) {
        problems.push(`${row.id}: expected ${row.expect.length} delivery rows, found ${rowOpenings} openings and ${matches.length} well-formed rows`);
        return problems;
    }
    row.expect.forEach((entry, index) => {
        const [, outcome, label, title, value] = matches[index];
        const wanted = [
            entry.outcome === null ? undefined : entry.outcome.toLowerCase(),
            escapeHtml(labels[entry.labelKey]), escapeHtml(entry.fullValue), escapeHtml(entry.value)
        ];
        if (!util.isDeepStrictEqual([outcome, label, title, value], wanted)) {
            problems.push(`${row.id}[${index}] ${entry.labelKey}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify([outcome, label, title, value])}`);
        }
    });
    if (row.expect.length === 0) {
        if (html.includes('id="deliverySection"') || html.includes(TITLE_MARKUP)) {
            problems.push(`${row.id}: an empty delivery must render no Delivery section`);
        }
        return problems;
    }
    const sectionAt = html.indexOf('id="deliverySection"');
    const titleCount = html.split(TITLE_MARKUP).length - 1;
    if (sectionAt === -1 || titleCount !== 1 || html.indexOf(TITLE_MARKUP) < sectionAt) {
        problems.push(`${row.id}: the Delivery title must appear once, inside #deliverySection (found ${titleCount})`);
    }
    // The order JetBrains' TaskDetailDialog uses: blocker, then delivery, then the editable fields.
    const blockerAt = html.indexOf('id="blockerSection"');
    const priorityAt = html.indexOf('id="prioritySelect"');
    if (!(blockerAt !== -1 && blockerAt < sectionAt && sectionAt < priorityAt)) {
        problems.push(`${row.id}: #deliverySection must sit after #blockerSection and before the editable fields`);
    }
    return problems;
}

test('the task detail renders one escaped delivery row per expected entry', () => {
    const labels = plain(panelModule.DELIVERY_LABELS);
    const failures = readCorpus().rows.flatMap(row => checkRendered(row, labels));
    assert.deepStrictEqual(failures, []);
});

test('runner-reported text reaches the page escaped, in the value and in the title attribute', () => {
    const hostile = '<b>npm test</b> "quoted" & \'single\'';
    const html = renderDetail(makeTask({
        delivery: { latestCheckRun: { command: hostile, exitCode: 0 }, deliveryReceipt: { target: hostile } }
    }));
    assert.equal(html.includes('<b>npm test</b>'), false, 'the raw reported markup must not reach the page');
    const escaped = escapeHtml(hostile);
    const matches = [...html.matchAll(ROW_PATTERN)].filter(match => match[3] === escaped && match[4] === escaped);
    assert.equal(matches.length, 2, 'the command and the target each carry the escaped text twice');
});

test('PASS and FAIL rows are styled, and the page defines both selectors', () => {
    const html = renderDetail(makeTask({
        delivery: { latestCheckRun: { command: 'npm test', exitCode: 1 }, requiredCheckSatisfied: true }
    }));
    assert.match(html, /\.delivery-pass\b[^{]*\{/);
    assert.match(html, /\.delivery-fail\b[^{]*\{/);
    const classes = [...html.matchAll(ROW_PATTERN)].map(match => match[1]);
    assert.deepStrictEqual(classes, [undefined, 'fail', 'pass']);
});

test('a task with no delivery member renders exactly like one with a null delivery', () => {
    const absent = renderDetail(makeTask());
    assert.equal(absent.includes('deliverySection'), false);
    assert.equal(absent, renderDetail(makeTask({ delivery: null })));
});

// ---------------------------------------------------------------------------
// Raw wire JSON: the daemon's shapes are corpus rows, these are not
// ---------------------------------------------------------------------------

const labelKeys = rows => rows.map(row => row.labelKey);

test('malformed delivery input never throws and never invents a row', () => {
    for (const bad of [undefined, null, 7, 'delivery', true, [], [{ attemptPhase: 'running' }]]) {
        assert.deepStrictEqual(rowsOf(bad), [], `deliveryRows(${JSON.stringify(bad)})`);
    }
    assert.deepStrictEqual(rowsOf({
        currentCandidate: [], latestCheckRun: 'npm test', deliveryReceipt: 7, attemptPhase: 7, requiredCheckSatisfied: 'true'
    }), []);
    assert.deepStrictEqual(rowsOf({
        currentCandidate: { treeSha: 7, shortSha: null, baseRevision: {} },
        latestCheckRun: { command: 7, exitCode: '0', source: 'other', outcome: 1 },
        deliveryReceipt: { target: [], landedRevision: false }
    }), []);
});

test('only a safe-integer exit code renders a verdict, and a string is never coerced', () => {
    for (const code of ['0', '1', 1.5, Number.MAX_SAFE_INTEGER + 2, null, true, {}, []]) {
        assert.deepStrictEqual(rowsOf({ latestCheckRun: { exitCode: code } }), [], `exitCode ${JSON.stringify(code)}`);
    }
    // The daemon stores any safe integer (checkRunStore), so a code outside Int32 is not dropped here.
    assert.deepStrictEqual(rowsOf({ latestCheckRun: { exitCode: 3221225477 } }), [
        { labelKey: 'moe.delivery.checkFailed', value: '3221225477', fullValue: '3221225477', outcome: 'FAIL' }
    ]);
});

test('an unknown check source is dropped and an unknown outcome is shown verbatim', () => {
    const rows = rowsOf({ latestCheckRun: { source: 'someone-else', outcome: 'cancelled' } });
    assert.deepStrictEqual(labelKeys(rows), ['moe.delivery.checkOutcome']);
});

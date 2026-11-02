'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// Held-out guard: every row of the client-neutral blocker corpus that JetBrains
// owns (VSC-4) is replayed through all three VS Code copies of the blocker
// rule - TaskDetailPanel.ts, media/board.js and media/taskDetail.js - each
// executed from its production source. The corpus is never edited here and no
// row gets a VS Code-only expectation (mem:decision-vscode-plugin-reuse).
const corpusPath = path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-blocker.json');
const boardScriptPath = path.join(__dirname, '../media/board.js');
const detailScriptPath = path.join(__dirname, '../media/taskDetail.js');
const panelPath = path.join(__dirname, '../src/panels/TaskDetailPanel.ts');
const planReviewPath = path.join(__dirname, '../src/panels/PlanReviewPanel.ts');

const transpile = sourcePath => ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

// Runs a transpiled extension module that may require only the given
// dependencies. The vscode stub is a plain object: a strict Proxy breaks the
// esModuleInterop import helper, which reads the module marker.
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

const vscodeStub = {};
const panelModule = loadModule(transpile(panelPath), panelPath, {
    vscode: vscodeStub,
    './PlanReviewPanel': loadModule(transpile(planReviewPath), planReviewPath, { vscode: vscodeStub })
});

const noop = () => {};

// media/board.js raw, in its own context. The timers it arms at load are
// stubbed so nothing outlives the test.
function loadBoard() {
    const element = { addEventListener: noop };
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => undefined, setState: noop, postMessage: noop }),
        document: { addEventListener: noop, body: { addEventListener: noop }, getElementById: () => element },
        window: { addEventListener: noop },
        setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop, console
    });
    vm.runInContext(fs.readFileSync(boardScriptPath, 'utf8'), context, { filename: boardScriptPath });
    return context;
}

// media/taskDetail.js raw, in its own context: a DOM just big enough to load.
function loadDetail() {
    const node = () => ({ dataset: { taskId: 'task-corpus', taskStatus: 'WORKING' }, addEventListener: noop, appendChild: noop });
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage: noop }),
        document: { getElementById: node, createElement: node, createTextNode: node },
        window: { addEventListener: noop },
        console
    });
    vm.runInContext(fs.readFileSync(detailScriptPath, 'utf8'), context, { filename: detailScriptPath });
    return context;
}

function readCorpus() {
    try {
        return JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read the blocker corpus at ${corpusPath}: ${error.message}`);
    }
}

const corpus = readCorpus();
const board = loadBoard();
const detail = loadDetail();
const SURFACES = [['TaskDetailPanel.ts', panelModule], ['board.js', board], ['taskDetail.js', detail]];

const BASE = {
    title: 'Corpus card', priority: 'MEDIUM', description: 'Replay one corpus row.',
    definitionOfDone: [], implementationPlan: [], comments: [], order: 1
};

// An independent probe of one rendered card: its chips as { cls, label }.
function chipsOf(card) {
    const chips = [];
    const pattern = /<span class="chip ([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
    let match;
    while ((match = pattern.exec(card)) !== null) { chips.push({ cls: match[1], label: match[2] }); }
    return chips;
}

test('C0: the corpus is version 1 with unique rows', () => {
    assert.equal(corpus.version, 1, `unexpected corpus version in ${corpusPath}`);
    assert.ok(Array.isArray(corpus.rows) && corpus.rows.length >= 14, `too few rows in ${corpusPath}`);
    const ids = corpus.rows.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length, 'row ids must be unique');
    assert.deepEqual(['blockCause', 'blockedPrerequisiteIds'].filter(name =>
        SURFACES.some(([, surface]) => typeof surface[name] !== 'function')), [], 'every surface needs both functions');
});

test('C1: every row has the expected cause and prerequisite ids on every surface', () => {
    const failures = [];
    for (const row of corpus.rows) {
        for (const [surface, impl] of SURFACES) {
            try {
                const cause = impl.blockCause(row.task);
                if (cause !== row.cause) {
                    failures.push(`${row.id} ${surface}: expected cause ${JSON.stringify(row.cause)}, got ${JSON.stringify(cause)}`);
                }
                // JSON compare: a vm-realm array never deep-equals a host array.
                const ids = JSON.stringify(Array.from(impl.blockedPrerequisiteIds(row.task)));
                if (ids !== JSON.stringify(row.prerequisiteIds)) {
                    failures.push(`${row.id} ${surface}: expected ids ${JSON.stringify(row.prerequisiteIds)}, got ${ids}`);
                }
            } catch (error) {
                failures.push(`${row.id} ${surface}: threw ${error && error.message}`);
            }
        }
    }
    assert.deepEqual(failures, []);
});

test('C2: every row has the expected needs-human-review flag and card chips', () => {
    const failures = [];
    for (const row of corpus.rows) {
        try {
            const expected = row.needsHumanReview;
            const field = row.task.needsHumanReview === true;
            if (field !== expected) { failures.push(`${row.id} field: expected needsHumanReview ${expected}, got ${field}`); }
            const attention = panelModule.needsHumanAttention(row.task);
            if (attention !== expected) { failures.push(`${row.id} needsHumanAttention: expected ${expected}, got ${attention}`); }

            const column = row.task.status === 'BLOCKED' ? 'WORKING' : row.task.status;
            const chips = chipsOf(board.renderTaskCard({ ...BASE, ...row.task }, [], column));
            const attentionChip = chips.some(chip => chip.cls === 'chip-question');
            if (attentionChip !== expected) { failures.push(`${row.id} board.js: expected attention chip ${expected}, got ${attentionChip}`); }
            const labels = chips.filter(chip => chip.cls === 'chip-blocked').map(chip => chip.label);
            const wantLabels = row.cause === null ? [] : [panelModule.BLOCK_CAUSE_LABEL[row.cause]];
            if (JSON.stringify(labels) !== JSON.stringify(wantLabels)) {
                failures.push(`${row.id} board.js: expected cause chip ${JSON.stringify(wantLabels)}, got ${JSON.stringify(labels)}`);
            }
        } catch (error) {
            failures.push(`${row.id} card: threw ${error && error.message}`);
        }
    }
    assert.deepEqual(failures, []);
});

// Every moe.blocker.* string of JetBrains' bundle, pinned on each VS Code copy
// that carries it: the cause and clearance labels on all three, the attention
// pair on all three, the detail captions on the panel and taskDetail.js.
const BUNDLE_PATH = path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties');
const CAUSE_KEYS = { RESOURCE_WAIT: 'resourceWait', DEPENDENCY_WAIT: 'dependencyWait', EXTERNAL_BLOCK: 'externalBlock' };
const CONSTANT_KEYS = {
    'attention.badge': 'ATTENTION_LABEL', 'attention.clears': 'ATTENTION_CLEARS', 'section.title': 'BLOCKER_SECTION_TITLE',
    reason: 'BLOCKER_REASON_LABEL', 'reason.missing': 'BLOCKER_REASON_MISSING', prerequisites: 'BLOCKER_PREREQUISITES_LABEL',
    resourceId: 'BLOCKER_RESOURCE_LABEL', fromStatus: 'BLOCKER_FROM_STATUS_LABEL', blockedAt: 'BLOCKER_BLOCKED_AT_LABEL'
};

test('C3: every surface\'s blocker labels equal moe.blocker.* in MoeBundle.properties', () => {
    const bundle = {};
    for (const [, key, value] of fs.readFileSync(BUNDLE_PATH, 'utf8').matchAll(/^moe\.blocker\.([A-Za-z.]+)=(.*?)\r?$/gm)) {
        bundle[key] = value;
    }
    assert.deepEqual(Object.keys(bundle).filter(key => bundle[key].includes('\\')), [], 'a properties escape this parser does not decode');
    const pinned = [...Object.values(CAUSE_KEYS).flatMap(k => [`cause.${k}`, `clears.${k}`]), ...Object.keys(CONSTANT_KEYS)];
    assert.deepEqual(Object.keys(bundle).sort(), pinned.sort(), 'pin a new moe.blocker.* key here, on every copy that shows it');
    // board.js declares its copies with const, so they are read inside its context.
    const inScript = context => name => JSON.parse(vm.runInContext(`JSON.stringify(typeof ${name} === 'undefined' ? null : ${name})`, context));
    const failures = [];
    for (const [surface, get] of [['TaskDetailPanel.ts', name => panelModule[name]], ['board.js', inScript(board)], ['taskDetail.js', inScript(detail)]]) {
        const expect = (key, got) => {
            if (got !== bundle[key]) { failures.push(`${surface} moe.blocker.${key}: expected ${JSON.stringify(bundle[key])}, got ${JSON.stringify(got)}`); }
        };
        const labels = get('BLOCK_CAUSE_LABEL') || {};
        const clears = get('BLOCK_CAUSE_CLEARS') || {};
        for (const map of [labels, clears]) { assert.deepEqual(Object.keys(map).sort(), Object.keys(CAUSE_KEYS).sort(), `${surface} names exactly the three causes`); }
        for (const [cause, k] of Object.entries(CAUSE_KEYS)) { expect(`cause.${k}`, labels[cause]); expect(`clears.${k}`, clears[cause]); }
        for (const [key, name] of Object.entries(CONSTANT_KEYS)) {
            if (surface !== 'board.js' || key.startsWith('attention.')) { expect(key, get(name)); }
        }
    }
    assert.deepEqual(failures, []);
});

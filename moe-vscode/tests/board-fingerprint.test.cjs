'use strict';

// Audit V4: the board skips a render when its fingerprint is unchanged, so the fingerprint must cover every task field a
// card shows. Each row changes one such field and nothing else, then checks that both render paths show it: the full
// rebuild (the first render, or a board without columns) and the incremental one (a column re-rendered in place). Runs
// the raw media/board.js under node:vm; the element stand-in is board-confirmations.test.cjs's (tests share no helper
// module).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const BOARD_SCRIPT = fs.readFileSync(path.join(__dirname, '../media/board.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

const EPICS = [{ id: 'epic-1', title: 'First epic', status: 'ACTIVE', order: 1 }, { id: 'epic-2', title: 'Second epic', status: 'ACTIVE', order: 2 }];
const CLAIMED = '2026-11-01T10:00:00.000Z';
const task = overrides => ({
    id: 'task-1', epicId: 'epic-1', title: 'Card', description: 'old words', status: 'WORKING', order: 1, priority: 'MEDIUM',
    definitionOfDone: [], implementationPlan: [], comments: [], ...overrides
});

/** A DOM element stand-in with enough surface for board.js to render. */
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

/** media/board.js on a fresh page; `render` hands it a state as its own message handler does. */
function loadBoard() {
    const nodes = new Map();
    const byId = id => { if (!nodes.has(id)) { nodes.set(id, element('#' + id)); } return nodes.get(id); };
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => undefined, setState() {}, postMessage() {} }),
        document: {
            getElementById: byId, createElement: element, body: element('body'),
            createTextNode: text => { const n = element('#text'); n.textContent = text; return n; },
            addEventListener() {}
        },
        window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800 },
        setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, console
    });
    vm.runInContext(BOARD_SCRIPT, context, { filename: 'board.js' });
    return {
        byId,
        render: tasks => {
            context.st = { tasks: plain(tasks), epics: plain(EPICS), workers: [], teams: [] };
            vm.runInContext('renderBoard(st);', context);
        }
    };
}

// [what changed, the card before, the card after, what the card shows after]. A BLOCKED card sits in the Working column.
const ROWS = [
    ['description', {}, { description: 'new words' }, 'new words'],
    ['epicId', {}, { epicId: 'epic-2' }, 'Second epic'],
    ['needsHumanReview', {}, { needsHumanReview: true }, 'Awaiting human review'],
    ['priorHandoffs', {}, { priorHandoffs: [{}, {}] }, '2 prior hand-off(s)'],
    ['planCritiqueResult.verdict', { planCritiqueResult: { verdict: 'pass' } }, { planCritiqueResult: { verdict: 'block', concerns: ['scope'] } }, 'critique blocked'],
    ['planCritiqueResult.concerns', { planCritiqueResult: { verdict: 'block', concerns: ['scope'] } }, { planCritiqueResult: { verdict: 'block', concerns: ['tests'] } }, 'title="tests"'],
    ['blockedResourceId', { status: 'BLOCKED', blockedOnTaskIds: ['task-9'] }, { status: 'BLOCKED', blockedOnTaskIds: ['task-9'], blockedResourceId: 'db' }, 'Resource wait'],
    ['blockedOnTaskIds', { status: 'BLOCKED' }, { status: 'BLOCKED', blockedOnTaskIds: ['task-9'] }, 'Dependency wait'],
    ['reopenCount', {}, { reopenCount: 2 }, 'Reopened 2 time(s)'],
    ['metrics.reopenCount', { metrics: { reopenCount: 1 } }, { metrics: { reopenCount: 3 } }, 'Reopened 3 time(s)'],
    ['metrics.firstClaimAt', {}, { metrics: { firstClaimAt: CLAIMED, wallClockMs: 60000 } }, '[1m]'],
    ['metrics.wallClockMs', { metrics: { firstClaimAt: CLAIMED, wallClockMs: 60000 } }, { metrics: { firstClaimAt: CLAIMED, wallClockMs: 7200000 } }, '[2h]'],
    ['metrics.doneAt', { status: 'DONE', metrics: { firstClaimAt: CLAIMED, doneAt: '2026-11-01T10:01:00.000Z' } },
        { status: 'DONE', metrics: { firstClaimAt: CLAIMED, doneAt: '2026-11-01T12:00:00.000Z' } }, '[2h]'],
];
const column = card => (card.status === 'BLOCKED' ? 'WORKING' : card.status || 'WORKING');

for (const [field, before, after, shown] of ROWS) {
    test(`V4 ${field}: a change re-renders the card on the full and the incremental path`, () => {
        const [from, to] = [task(before), task(after)];
        const full = loadBoard();
        full.render([from]);
        assert.ok(!full.byId('board').html.includes(shown), `the first render does not already show ${shown}`);
        full.render([to]);
        assert.ok(full.byId('board').html.includes(shown), `the rebuilt board shows ${shown}`);

        const incremental = loadBoard();
        incremental.render([from]);
        const board = incremental.byId('board');
        board.querySelector = selector => (selector === '.column' ? incremental.byId('column-WORKING') : null); // columns exist now
        incremental.render([to]);
        assert.ok(incremental.byId(`column-${column(to)}`).html.includes(shown), `the re-rendered ${column(to)} column shows ${shown}`);
    });
}

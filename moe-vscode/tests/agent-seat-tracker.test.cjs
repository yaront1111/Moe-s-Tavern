'use strict';

// VSC-20: the TypeScript port of JetBrains' AgentSeatTracker replays the shared corpus
// (moe-jetbrains/src/test/resources/client-seat-tracker.json, replayed by SeatTrackerCorpusTest.kt) unchanged, and
// wireAgentSeats connects a tracker to three injected event sources. AgentSeatTracker.ts must stay pure: any require
// from it throws here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const SOURCE_PATH = path.join(__dirname, '../src/util/AgentSeatTracker.ts');
const CORPUS_PATH = path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-seat-tracker.json');
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, 'utf8');
const A = (() => {
    const module = { exports: {} };
    const code = ts.transpileModule(SOURCE_TEXT, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInThisContext(`(function (exports, module, require) {${code}\n})`, { filename: SOURCE_PATH })(module.exports, module, name => { throw new Error(`AgentSeatTracker.ts must not require ${name}`); });
    return module.exports;
})();

const SEAT_ID = 'worker-aaaa1111';
const QA_ID = 'qa-bbbb2222';
const SEAT = { name: 'seat terminal' };
const SHELL = { name: 'user shell' };

/** A tracker over a store that save overwrites; every deregistration lands in one log. */
const realTracker = (persisted = []) => {
    const run = { store: [...persisted], saves: [], log: [] };
    run.make = () => new A.AgentSeatTracker(() => run.store, ids => { run.saves.push(ids); run.store = ids; }, id => run.log.push(id));
    run.tracker = run.make();
    return run;
};

/** An event source that counts subscriptions and disposals. `leaky` keeps the listener after dispose(); `throws` fails the subscribe. */
const eventSource = ({ leaky = false, throws } = {}) => {
    const s = { listeners: new Set(), subscriptions: 0, disposals: 0 };
    s.event = listener => {
        if (throws) throw throws;
        s.subscriptions += 1;
        s.listeners.add(listener);
        return { dispose: () => { s.disposals += 1; if (!leaky) s.listeners.delete(listener); } };
    };
    s.fire = value => { for (const listener of [...s.listeners]) listener(value); };
    return s;
};
const recordingTracker = () => {
    const calls = [];
    return { calls, closed: id => calls.push(['closed', id]), resendGone: () => calls.push(['resendGone']), acked: id => calls.push(['acked', id]) };
};
/** Three sources (close, connect, ack) wired to `tracker`; workerIdOf maps the seat terminal and nothing else. */
const wire = (tracker, options = {}) => {
    const close = eventSource(options.close);
    const connect = eventSource(options.connect);
    const ack = eventSource(options.ack);
    const seen = [];
    const workerIdOf = terminal => { seen.push(terminal); return terminal === SEAT ? SEAT_ID : undefined; };
    const wiring = () => A.wireAgentSeats({ tracker, onDidCloseTerminal: close.event, workerIdOf, onConnected: connect.event, onAcked: ack.event });
    return { close, connect, ack, seen, wiring };
};
const idle = source => ({ subscriptions: source.subscriptions, disposals: source.disposals, listeners: source.listeners.size });

test('P1: the source is pure and exports exactly the tracker and the wiring', () => {
    assert.equal(/vscode/i.test(SOURCE_TEXT), false, 'the source names the editor');
    assert.equal(/^\s*import\b/m.test(SOURCE_TEXT), false, 'the source has an import');
    assert.equal(/\brequire\s*\(/.test(SOURCE_TEXT), false, 'the source calls require');
    assert.deepEqual(Object.keys(A).sort(), ['AgentSeatTracker', 'wireAgentSeats']);
    assert.equal(typeof A.AgentSeatTracker, 'function');
    assert.equal(typeof A.wireAgentSeats, 'function');
});

// The corpus is the spec. Replay semantics are SeatTrackerCorpusTest.kt's: the store starts as `persisted`, save overwrites it,
// `restart` builds a new tracker over the current store, `connect` calls resendGone(), and the deregistration log spans restarts.
const OPS = ['launched', 'closed', 'connect', 'acked', 'restart'];
const NEEDS_WORKER = ['launched', 'closed', 'acked'];
const eventProblem = event => {
    if (typeof event.op !== 'string') return `event without op: ${JSON.stringify(event)}`;
    if (!OPS.includes(event.op)) return `unknown op ${event.op}`;
    const needsWorker = NEEDS_WORKER.includes(event.op);
    const hasWorker = typeof event.workerId === 'string' && event.workerId !== '';
    if (needsWorker && !hasWorker) return `${event.op} without workerId`;
    if (!needsWorker && 'workerId' in event) return `${event.op} with a workerId`;
    return null;
};
const replayMismatch = row => {
    const run = realTracker(row.persisted);
    for (const event of row.events) {
        const problem = eventProblem(event);
        if (problem) return problem;
        if (event.op === 'launched') run.tracker.launched(event.workerId);
        else if (event.op === 'closed') run.tracker.closed(event.workerId);
        else if (event.op === 'acked') run.tracker.acked(event.workerId);
        else if (event.op === 'connect') run.tracker.resendGone();
        else run.tracker = run.make();
    }
    if (!util.isDeepStrictEqual(run.log, row.expectDeregistered)) return `expected deregistered ${JSON.stringify(row.expectDeregistered)}, got ${JSON.stringify(run.log)}`;
    if (!util.isDeepStrictEqual(run.store, row.expectPersisted)) return `expected persisted ${JSON.stringify(row.expectPersisted)}, got ${JSON.stringify(run.store)}`;
    return null;
};

test('C1: every row of the shared seat corpus replays to its deregistrations and saved list', () => {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
    assert.equal(corpus.version, 1);
    assert.ok(corpus.rows.length >= 10, `rows: ${corpus.rows.length}`);
    const ids = corpus.rows.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate corpus ids');
    const failures = corpus.rows.flatMap(row => {
        let problem;
        try { problem = replayMismatch(row); } catch (error) { problem = `threw ${error}`; }
        return problem ? [`${row.id}: ${problem}`] : [];
    });
    assert.deepEqual(failures, []);
});

test('L1: load keeps only the non-blank string entries of an array, once each, and anything else loads no seat', () => {
    const gone = stored => {
        const log = [];
        const saves = [];
        new A.AgentSeatTracker(() => stored, ids => saves.push(ids), id => log.push(id)).resendGone();
        assert.deepEqual(saves, []);
        return log;
    };
    assert.deepEqual(gone([SEAT_ID, '', '  ', 7, null, {}, QA_ID, SEAT_ID]), [SEAT_ID, QA_ID]);
    for (const stored of [undefined, null, SEAT_ID, 42, { 0: SEAT_ID, length: 1 }]) {
        assert.deepEqual(gone(stored), [], `stored ${util.inspect(stored)}`);
    }
});

test('T1: an acked seat that is launched again moves to the end, as in an insertion-ordered set', () => {
    const run = realTracker();
    run.tracker.launched(SEAT_ID);
    run.tracker.launched(QA_ID);
    run.tracker.acked(SEAT_ID);
    run.tracker.launched(SEAT_ID);
    assert.deepEqual(run.saves, [[SEAT_ID], [SEAT_ID, QA_ID], [QA_ID], [QA_ID, SEAT_ID]]);
});

test('T2: save receives a copy, so a caller that mutates it cannot change the tracker', () => {
    const run = realTracker();
    run.tracker.launched(SEAT_ID);
    run.saves[0].push('worker-intruder');
    run.tracker.launched(QA_ID);
    assert.deepEqual(run.saves[1], [SEAT_ID, QA_ID]);
    assert.notEqual(run.saves[0], run.saves[1]);
});

test('T3: resendGone fixes the gone ids first, so a deregister that re-enters the tracker cannot change the pass', () => {
    const log = [];
    let tracker;
    tracker = new A.AgentSeatTracker(() => ['a', 'b', 'c'], () => {}, id => {
        log.push(id);
        if (id === 'a') { tracker.acked('b'); tracker.launched('c'); }
    });
    tracker.resendGone();
    assert.deepEqual(log, ['a', 'b', 'c']);
});

test('T4: launched() and acked() save only when the list changes, and closed() and resendGone() never save', () => {
    const run = realTracker([QA_ID]);
    run.tracker.launched(SEAT_ID);
    run.tracker.launched(SEAT_ID);
    run.tracker.launched(QA_ID);
    run.tracker.closed(SEAT_ID);
    run.tracker.resendGone();
    assert.deepEqual(run.saves, [[QA_ID, SEAT_ID]]);
    assert.deepEqual(run.log, [SEAT_ID, SEAT_ID]);
    run.tracker.acked('worker-zzzz9999');
    assert.deepEqual(run.saves, [[QA_ID, SEAT_ID]]);
    run.tracker.acked(QA_ID);
    assert.deepEqual(run.saves, [[QA_ID, SEAT_ID], [SEAT_ID]]);
});

test('W1: a closed terminal reaches closed() only when it maps to a worker id', () => {
    const tracker = recordingTracker();
    const w = wire(tracker);
    w.wiring();
    w.close.fire(SHELL);
    assert.deepEqual(tracker.calls, []);
    w.close.fire(SEAT);
    assert.deepEqual(tracker.calls, [['closed', SEAT_ID]]);
    assert.deepEqual(w.seen, [SHELL, SEAT]);
});

test('W2: resendGone() runs once per connected state and for nothing else', () => {
    const tracker = recordingTracker();
    const w = wire(tracker);
    w.wiring();
    for (const state of ['connecting', 'connected', 'disconnected', 'connecting', 'connected', undefined]) w.connect.fire(state);
    assert.deepEqual(tracker.calls, [['resendGone'], ['resendGone']]);
});

test('W3: every ack reaches acked() with its worker id, in order', () => {
    const tracker = recordingTracker();
    const w = wire(tracker);
    w.wiring();
    w.ack.fire(SEAT_ID);
    w.ack.fire(QA_ID);
    assert.deepEqual(tracker.calls, [['acked', SEAT_ID], ['acked', QA_ID]]);
});

test('W4: dispose() is idempotent, unsubscribes each source exactly once and silences every event', () => {
    const tracker = recordingTracker();
    const w = wire(tracker);
    const wiring = w.wiring();
    wiring.dispose();
    wiring.dispose();
    for (const source of [w.close, w.connect, w.ack]) assert.deepEqual(idle(source), { subscriptions: 1, disposals: 1, listeners: 0 });
    w.close.fire(SEAT);
    w.connect.fire('connected');
    w.ack.fire(SEAT_ID);
    assert.deepEqual(tracker.calls, []);
    assert.deepEqual(w.seen, []);
});

test('W5: a source that keeps calling after dispose() reaches neither workerIdOf nor the tracker', () => {
    const tracker = recordingTracker();
    const w = wire(tracker, { close: { leaky: true }, connect: { leaky: true }, ack: { leaky: true } });
    w.wiring().dispose();
    for (const source of [w.close, w.connect, w.ack]) assert.deepEqual(idle(source), { subscriptions: 1, disposals: 1, listeners: 1 });
    w.close.fire(SEAT);
    w.connect.fire('connected');
    w.ack.fire(SEAT_ID);
    assert.deepEqual(tracker.calls, []);
    assert.deepEqual(w.seen, []);
});

test('W6: a subscription that throws disposes the ones already made and rethrows its error', () => {
    const boom = new Error('subscribe failed');
    const ackFails = wire(recordingTracker(), { ack: { throws: boom } });
    assert.throws(() => ackFails.wiring(), error => error === boom);
    assert.deepEqual(idle(ackFails.close), { subscriptions: 1, disposals: 1, listeners: 0 });
    assert.deepEqual(idle(ackFails.connect), { subscriptions: 1, disposals: 1, listeners: 0 });
    assert.deepEqual(idle(ackFails.ack), { subscriptions: 0, disposals: 0, listeners: 0 });
    const connectFails = wire(recordingTracker(), { connect: { throws: boom } });
    assert.throws(() => connectFails.wiring(), error => error === boom);
    assert.deepEqual(idle(connectFails.close), { subscriptions: 1, disposals: 1, listeners: 0 });
    assert.deepEqual(idle(connectFails.ack), { subscriptions: 0, disposals: 0, listeners: 0 });
});

test('W7: wired to a real tracker, a seat is deregistered on close and on connect until its ack, then never again', () => {
    const run = realTracker();
    const w = wire(run.tracker);
    w.wiring();
    run.tracker.launched(SEAT_ID);
    w.close.fire(SEAT);
    w.close.fire(SHELL);
    w.connect.fire('connected');
    w.ack.fire(SEAT_ID);
    w.connect.fire('connected');
    assert.deepEqual(run.log, [SEAT_ID, SEAT_ID]);
    assert.deepEqual(run.store, []);
});

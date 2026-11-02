'use strict';

// VSC-21a: SeatSurvival remembers each seat's shell pid so a reload or extension restart never deregisters a live seat.
// It stays pure, so any require from it throws here. Every stub records its call before it acts (no vacuous log check).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const SOURCE_PATH = path.join(__dirname, '../src/util/SeatSurvival.ts');
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, 'utf8');
const S = (() => {
    const module = { exports: {} };
    const code = ts.transpileModule(SOURCE_TEXT, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInThisContext(`(function (exports, module, require) {${code}\n})`, { filename: SOURCE_PATH })(module.exports, module, name => { throw new Error(`SeatSurvival.ts must not require ${name}`); });
    return module.exports;
})();

/** A kill stub that logs [pid, signal] first and only then returns or throws what `behavior` says. */
const killStub = (behavior = () => true) => {
    const calls = [];
    return { calls, kill: (pid, signal) => { calls.push([pid, signal]); return behavior(); } };
};
const throwing = value => () => { throw value; };
const errorWithCode = code => Object.assign(new Error(`probe failed: ${code}`), { code });

/** A SeatPids over `initial` (the untyped stored JSON). Every save lands in `saves`; every load is counted. */
const seats = (initial = {}) => {
    const run = { saves: [], loads: 0 };
    run.pids = new S.SeatPids(() => { run.loads += 1; return initial; }, pids => run.saves.push(pids));
    return run;
};
/** The ids `pids` believes alive when every recorded pid is alive, probed with exactly the given ids. */
const everyRecorded = (pids, ids) => pids.surviving(ids, () => true);
/** isAlive that logs the whole argument list first, then answers from a pid table. */
const aliveTable = table => {
    const calls = [];
    return { calls, isAlive: (...args) => { calls.push(args); return table[args[0]]; } };
};

test('S1: the source is pure and exports exactly isProcessAlive and SeatPids', () => {
    assert.equal(/vscode/i.test(SOURCE_TEXT), false, 'the source names the editor');
    assert.equal(/^\s*import\b/m.test(SOURCE_TEXT), false, 'the source has an import');
    assert.equal(/\brequire\s*\(/.test(SOURCE_TEXT), false, 'the source calls require');
    assert.deepEqual(Object.keys(S).sort(), ['SeatPids', 'isProcessAlive']);
    assert.equal(typeof S.isProcessAlive, 'function');
    assert.equal(typeof S.SeatPids, 'function');
});

test('S2a: isProcessAlive probes a positive safe-integer pid with signal 0 and reads the outcome', () => {
    for (const [label, behavior, expected] of [
        ['a probe that returns true', () => true, true],
        ['a probe that returns nothing', () => undefined, true],
        ['EPERM: the process exists but belongs to another user', throwing(errorWithCode('EPERM')), true],
        ['EPERM read from a thrown plain object', throwing({ code: 'EPERM' }), true],
        ['ESRCH', throwing(errorWithCode('ESRCH')), false],
        ['EINVAL', throwing(errorWithCode('EINVAL')), false],
        ['an error without a code', throwing(new Error('no code')), false],
        ['a thrown string', throwing('EPERM'), false],
        ['a thrown null', throwing(null), false],
        ['a thrown undefined', throwing(undefined), false],
        ['a thrown number', throwing(1), false],
    ]) {
        for (const pid of [4242, 1, Number.MAX_SAFE_INTEGER]) {
            const stub = killStub(behavior);
            assert.equal(S.isProcessAlive(pid, stub.kill), expected, `${label}, pid ${pid}`);
            assert.deepEqual(stub.calls, [[pid, 0]], `${label}, pid ${pid}`);
        }
    }
});

test('S2b: isProcessAlive never probes a pid that is not a positive safe integer', () => {
    // process.kill(0) and process.kill(-n) address process groups, so these must not reach the probe at all.
    const invalid = [0, -1, -4242, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '42', undefined, null, true, {}, [], 42n];
    for (const pid of invalid) {
        const stub = killStub();
        assert.equal(S.isProcessAlive(pid, stub.kill), false, `pid ${String(pid)}`);
        assert.deepEqual(stub.calls, [], `pid ${String(pid)} was probed`);
    }
});

test('S2c: the default probe is a real signal 0: alive for this process, dead for one that exited', () => {
    assert.equal(S.isProcessAlive(process.pid), true);
    const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(exited.status, 0);
    assert.equal(Number.isSafeInteger(exited.pid) && exited.pid > 0, true);
    assert.equal(S.isProcessAlive(exited.pid), false, 'ESRCH from the real kill');
    const run = seats();
    run.pids.record('live', process.pid);
    run.pids.record('gone', exited.pid);
    assert.deepEqual(run.pids.surviving(['gone', 'live'], S.isProcessAlive), ['live'], 'passed straight in, it gets the pid alone');
});

test('S3a: SeatPids loads nothing from anything but a plain object, and construction never saves', () => {
    for (const stored of [[11, 12], [['w1', 11]], 'w1', '{"w1":11}', 7, true, null, undefined, new Map([['w1', 11]])]) {
        const run = seats(stored);
        assert.equal(run.loads, 1, 'load runs exactly once');
        assert.equal(run.pids.seatOf(11), undefined, `stored ${String(stored)}`);
        assert.deepEqual(everyRecorded(run.pids, ['w1', '0', '1']), []);
        assert.deepEqual(run.saves, [], 'construction saved');
    }
});

test('S3b: SeatPids loads only positive safe-integer pids under non-blank worker ids', () => {
    const run = seats({ w1: 11, '  ': 12, w2: 0, w3: 1.5, w4: '13', w5: 14, w6: -2, w7: null, w8: NaN, '': 15 });
    assert.equal(run.pids.seatOf(11), 'w1');
    assert.equal(run.pids.seatOf(14), 'w5');
    for (const dropped of [12, 13, 15, 0, -2, 1.5]) assert.equal(run.pids.seatOf(dropped), undefined, `pid ${dropped}`);
    assert.deepEqual(everyRecorded(run.pids, ['w1', '  ', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', '']), ['w1', 'w5']);
    assert.deepEqual(run.saves, [], 'construction saved although entries were dropped');
    run.pids.record('w9', 99);
    assert.deepEqual(run.saves, [{ w1: 11, w5: 14, w9: 99 }], 'the whole map, nothing else');
});

test('S3c: load applies one worker per pid, so a pid stored twice belongs to the later entry', () => {
    const run = seats({ a: 5, b: 5, c: 6 });
    assert.equal(run.pids.seatOf(5), 'b');
    assert.equal(run.pids.seatOf(6), 'c');
    assert.deepEqual(everyRecorded(run.pids, ['a', 'b', 'c']), ['b', 'c']);
    assert.deepEqual(run.saves, []);
});

test('S3d: prototype-named worker ids are plain data', () => {
    const run = seats(JSON.parse('{"constructor": 21, "hasOwnProperty": 22}'));
    assert.equal(run.pids.seatOf(21), 'constructor');
    assert.equal(run.pids.seatOf(22), 'hasOwnProperty');
    // An object keyed by worker id would answer these from its prototype.
    assert.deepEqual(everyRecorded(run.pids, ['toString', 'valueOf', 'constructor', 'hasOwnProperty']), ['constructor', 'hasOwnProperty']);
    run.pids.record('w1', 31);
    assert.deepEqual(run.saves, [{ constructor: 21, hasOwnProperty: 22, w1: 31 }]);
    run.pids.record('toString', 32);
    assert.equal(run.pids.seatOf(32), 'toString');
    assert.deepEqual(run.saves[1], { constructor: 21, hasOwnProperty: 22, w1: 31, toString: 32 });
});

test('S3e: an error thrown by load or save propagates unchanged', () => {
    const loadError = new Error('load failed');
    assert.throws(() => new S.SeatPids(() => { throw loadError; }, () => undefined), error => error === loadError);
    const saveError = new Error('save failed');
    const pids = new S.SeatPids(() => ({}), () => { throw saveError; });
    assert.throws(() => pids.record('w1', 11), error => error === saveError);
    assert.throws(() => pids.keep([]), error => error === saveError, 'keep drops the pid that record kept');
});

test('S4a: record saves the whole map once, and the same pair again saves nothing', () => {
    const run = seats();
    run.pids.record('w1', 11);
    assert.deepEqual(run.saves, [{ w1: 11 }]);
    run.pids.record('w1', 11);
    assert.equal(run.saves.length, 1, 'an unchanged pair saved again');
    run.pids.record('w2', 12);
    assert.deepEqual(run.saves, [{ w1: 11 }, { w1: 11, w2: 12 }]);
    for (const [pid, seat] of [[11, 'w1'], [12, 'w2'], [undefined, undefined], [13, undefined]]) assert.equal(run.pids.seatOf(pid), seat, `pid ${pid}`);
});

test('S4b: an invalid pid or worker id records nothing, saves nothing and displaces nothing', () => {
    const run = seats();
    run.pids.record('w1', 11);
    assert.equal(run.saves.length, 1);
    for (const pid of [undefined, null, 0, -3, 2.5, NaN, Infinity, '11', '12', Number.MAX_SAFE_INTEGER + 1]) run.pids.record('w1', pid);
    for (const pid of [undefined, null, 0, -3, 2.5, NaN, '12']) run.pids.record('w2', pid);
    // 11 is held by w1: a blank or non-string worker id must not take it away.
    for (const worker of ['', '  ', '\t\n', undefined, null, 5, {}, ['w1']]) run.pids.record(worker, 11);
    for (const worker of ['', '  ', undefined, null, 5]) run.pids.record(worker, 12);
    assert.equal(run.saves.length, 1, 'something saved');
    assert.equal(run.pids.seatOf(11), 'w1');
    assert.equal(run.pids.seatOf(12), undefined);
    assert.deepEqual(everyRecorded(run.pids, ['w1', 'w2', '', '  ', '5']), ['w1']);
});

test('S4c: a reused pid moves to the new worker, and a re-recorded worker drops its old pid', () => {
    const run = seats();
    run.pids.record('w1', 11);
    run.pids.record('w2', 11);
    assert.equal(run.pids.seatOf(11), 'w2');
    assert.deepEqual(run.saves, [{ w1: 11 }, { w2: 11 }], 'the second save no longer holds w1');
    assert.deepEqual(everyRecorded(run.pids, ['w1', 'w2']), ['w2']);

    run.pids.record('w2', 12);
    assert.equal(run.pids.seatOf(11), undefined, 'the old pid');
    assert.equal(run.pids.seatOf(12), 'w2');
    assert.deepEqual(run.saves[2], { w2: 12 });

    run.pids.record('w3', 13);
    run.pids.record('w4', 12);
    assert.deepEqual(run.saves[4], { w3: 13, w4: 12 }, 'w2 lost 12 to w4 while w3 stayed');
    assert.equal(run.saves.length, 5);
});

test('S4d: every save is a fresh object that SeatPids never reads back', () => {
    const run = seats();
    run.pids.record('w1', 11);
    run.pids.record('w2', 12);
    assert.notEqual(run.saves[0], run.saves[1]);
    run.saves[1].w1 = 999;
    run.saves[1].w9 = 9;
    delete run.saves[1].w2;
    for (const [pid, seat] of [[11, 'w1'], [12, 'w2'], [999, undefined]]) assert.equal(run.pids.seatOf(pid), seat, `pid ${pid}`);
    run.pids.record('w3', 13);
    assert.deepEqual(run.saves[2], { w1: 11, w2: 12, w3: 13 });
    const stored = { w1: 11 };
    const loaded = seats(stored);
    loaded.pids.record('w2', 12);
    assert.deepEqual(stored, { w1: 11 }, 'the loaded object was written through');
    assert.notEqual(loaded.saves[0], stored);
});

test('S5a: keep drops every worker not listed, with exactly one save, and saves nothing when nothing drops', () => {
    const run = seats();
    run.pids.record('w1', 11);
    run.pids.record('w2', 12);
    run.pids.record('w3', 13);
    assert.equal(run.saves.length, 3);
    run.pids.keep(['w1']);
    assert.equal(run.saves.length, 4, 'exactly one save');
    assert.deepEqual(run.saves[3], { w1: 11 });
    for (const [pid, seat] of [[12, undefined], [13, undefined], [11, 'w1']]) assert.equal(run.pids.seatOf(pid), seat, `pid ${pid}`);

    run.pids.keep(['w1']);
    run.pids.keep(['w1', 'w2', 'constructor']);
    run.pids.keep(['w1', 'w1']);
    run.pids.keep([null, 'w1', 11, {}]);
    assert.equal(run.saves.length, 4, 'a keep that drops nothing saved');
    assert.equal(run.pids.seatOf(11), 'w1');
    run.pids.keep([]);
    assert.deepEqual(run.saves[4], {}, 'an empty list clears everything');
    run.pids.record('w3', 13);
    assert.deepEqual(run.saves[5], { w3: 13 }, 'a later record starts clean');
});

test('S5b: keep with anything but an array keeps no worker', () => {
    for (const notAList of [undefined, 'w1', null, {}, { 0: 'w1', length: 1 }, 1, new Set(['w1'])]) {
        const run = seats({ w1: 11 });
        run.pids.record('w2', 12);
        run.pids.keep(notAList);
        assert.equal(run.saves.length, 2, `${String(notAList)}: one save for the record, one for the clear`);
        assert.deepEqual(run.saves[1], {});
        assert.equal(run.pids.seatOf(11), undefined);
        assert.equal(run.pids.seatOf(12), undefined);
    }
    const empty = seats();
    empty.pids.keep(undefined);
    empty.pids.keep([]);
    assert.deepEqual(empty.saves, [], 'nothing was recorded, so nothing dropped');
});

test('S6a: surviving returns the confirmed ids in the order given and once each, probing recorded ids only', () => {
    const run = seats({ w1: 11, w2: 12 });
    const probe = aliveTable({ 11: true, 12: false });
    assert.deepEqual(run.pids.surviving(['w2', 'w1', 'w3', 'w1'], probe.isAlive), ['w1']);
    // Neither w3 (no pid) nor the second w1 (a duplicate) is probed, and each probe gets the pid alone.
    assert.deepEqual(probe.calls, [[12], [11]]);
    assert.deepEqual(run.saves, [], 'surviving is read-only');
});

test('S6b: surviving keeps the given order, not the recorded order, and probes a dead duplicate once', () => {
    const run = seats({ w1: 11, w4: 14, w2: 12 });
    const probe = aliveTable({ 11: true, 12: false, 14: true });
    assert.deepEqual(run.pids.surviving(['w4', 'w2', 'w2', 'w1', 'w4'], probe.isAlive), ['w4', 'w1']);
    assert.deepEqual(probe.calls, [[14], [12], [11]]);
    assert.deepEqual(run.pids.surviving([], probe.isAlive), []);
    assert.equal(probe.calls.length, 3, 'an empty list probed something');
});

test('S6c: only a strict true confirms a seat', () => {
    const run = seats({ w1: 11, w2: 12, w3: 13, w4: 14, w5: 15 });
    const probe = aliveTable({ 11: 1, 12: 'yes', 13: {}, 14: undefined, 15: true });
    assert.deepEqual(run.pids.surviving(['w1', 'w2', 'w3', 'w4', 'w5'], probe.isAlive), ['w5']);
    assert.deepEqual(probe.calls, [[11], [12], [13], [14], [15]]);
});

test('S6d: surviving of anything but an array returns [] without probing', () => {
    const run = seats({ w1: 11 });
    for (const notAList of [undefined, null, 'w1', {}, { 0: 'w1', length: 1 }, 1, true, new Set(['w1'])]) {
        const probe = aliveTable({ 11: true });
        assert.deepEqual(run.pids.surviving(notAList, probe.isAlive), [], String(notAList));
        assert.deepEqual(probe.calls, [], `${String(notAList)} probed`);
    }
    const probe = aliveTable({ 11: true });
    assert.deepEqual(run.pids.surviving([null, 11, {}, 'w1', ['w1']], probe.isAlive), ['w1'], 'non-string members are never workers');
    assert.deepEqual(probe.calls, [[11]]);
});

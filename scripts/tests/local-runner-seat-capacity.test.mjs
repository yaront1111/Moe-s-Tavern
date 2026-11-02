// CQ-M07h host-wide agent seat VM cap: the formula, the cross-project count and the host lock around admission.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createLedger } from '../local-runner/lifecycle.mjs';
import { acquireSeatLock, admitSeatVm, countSeatVms, hostAgentVmCap, seatAdmissionFor } from '../local-runner/seat-capacity.mjs';
import { localRunnerHost } from '../local-runner/vm-control.mjs';

const GIB = 1024 ** 3;
const seat = id => ({ workerId: `worker-${id}`, runner: `4242@tok-${id}`, host: 'host-a' });
const ATTEMPT = { taskId: 'task-a1', attemptId: 'attempt-a1', generation: 1 };
const code = expected => error => error?.code === expected;

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-seat-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A record of `owner` in `phase` in the ledger at <root>/<project>/vms. */
async function recordIn(root, project, owner, phase) {
  const ledger = createLedger(path.join(root, project, 'vms'));
  const record = await ledger.reserve(owner);
  return phase === 'reserved' ? record : ledger.update(record, { phase, launchTries: phase === 'collision' ? 0 : 1 });
}

test('SC0 the CI local-runner step runs this file once', () => {
  const [, run] = /\n *- name: Test local runner prerequisite bundles\n *(run: [^\n]*)/.exec(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(run.split(' ').filter(file => file === 'scripts/tests/local-runner-seat-capacity.test.mjs').length, 1);
});

test('SC1 hostAgentVmCap is max(1, min(floor(CPUs / 2), floor((RAM - 8 GiB) / 4 GiB))) and refuses non-numeric input', () => {
  for (const [cpus, gib, cap] of [[2, 8, 1], [16, 64, 8], [8, 12, 1], [0, 0, 1], [64, 32, 6], [5, 20, 2], [9, 15.99, 1], [9, 16, 2]]) {
    assert.equal(hostAgentVmCap({ cpus, totalmem: gib * GIB }), cap, `${cpus} CPUs, ${gib} GiB`);
  }
  for (const input of [{ cpus: -1 }, { cpus: 1.5 }, { cpus: NaN }, { cpus: '4' }, { totalmem: -1 }, { totalmem: Infinity }, { totalmem: NaN }, { totalmem: '64' }]) {
    assert.throws(() => hostAgentVmCap({ cpus: 4, totalmem: 64 * GIB, ...input }), code('SEAT_CAPACITY_INPUT_INVALID'), JSON.stringify(input));
  }
  const cap = hostAgentVmCap();
  assert.ok(Number.isSafeInteger(cap) && cap >= 1, String(cap));
});

test('SC2 every project counts its live seat records; check, deleted, collision, foreign dirs and links do not', async t => {
  const root = scratch(t);
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)];
  for (const [project, owner, phase] of [[a, seat('1'), 'reserved'], [a, seat('2'), 'owned'], [a, seat('3'), 'deleted'], [a, ATTEMPT, 'owned'],
    [b, seat('4'), 'launching'], [b, seat('5'), 'collision'], ['notes', seat('6'), 'owned'], ['C'.repeat(32), seat('7'), 'owned']]) {
    await recordIn(root, project, owner, phase);
  }
  writeFileSync(path.join(root, a, 'vms', 'junk.json'), '{');
  symlinkSync(path.join(root, a), path.join(root, 'd'.repeat(32)), 'junction');
  writeFileSync(path.join(root, 'e'.repeat(32)), 'a file, not a project dir');
  assert.deepEqual(await countSeatVms(root), { count: 4, invalid: 1 });
  assert.deepEqual(await countSeatVms(path.join(root, 'missing')), { count: 0, invalid: 0 });
  await assert.rejects(countSeatVms(path.join(root, 'e'.repeat(32))), code('SEAT_CAPACITY_UNKNOWN'));
  mkdirSync(path.join(root, 'f'.repeat(32), 'vms', 'moe-vm-0.json'), { recursive: true });
  assert.deepEqual(await countSeatVms(root), { count: 5, invalid: 2 }, 'a non-file record entry is occupied');
  await assert.rejects(countSeatVms('relative/root'), code('SEAT_CAPACITY_INPUT_INVALID'));
});

test('SC2 seatAdmissionFor reserves into a ledger its root count walks', async t => {
  const state = scratch(t);
  const saved = process.env.MOE_RUNNER_STATE_DIR;
  t.after(() => { if (saved === undefined) delete process.env.MOE_RUNNER_STATE_DIR; else process.env.MOE_RUNNER_STATE_DIR = saved; });
  process.env.MOE_RUNNER_STATE_DIR = state;
  const { root, ledger } = seatAdmissionFor(path.join(state, 'project'));
  assert.equal(root, state);
  await ledger.reserve(seat('1'));
  assert.deepEqual(await countSeatVms(root), { count: 1, invalid: 0 });
  assert.throws(() => seatAdmissionFor(''), code('SEAT_CAPACITY_INPUT_INVALID'));
});

const LOCK = root => path.join(root, 'seat-capacity.lock');
const debris = root => readdirSync(root).filter(name => !/^[0-9a-f]{32}$/.test(name));
const holder = (pid, extra = {}) => `${JSON.stringify({ runner: `${pid}@deadbeefdeadbeef`, host: localRunnerHost(), platform: process.platform,
  acquiredAt: '2026-11-01T00:00:00.000Z', ...extra })}\n`;
const ledgerIn = root => createLedger(path.join(root, 'a'.repeat(32), 'vms'));

test('SC3 two concurrent admissions at cap minus one admit exactly one', async t => {
  const root = scratch(t);
  await recordIn(root, 'c'.repeat(32), seat('0'), 'owned');
  const ledger = ledgerIn(root);
  // The delay sits inside the critical section: without the lock both would count 1 and both reserve.
  const slow = { reserve: async owner => { await delay(50); return ledger.reserve(owner); } };
  const results = await Promise.allSettled(['x', 'y'].map(id => admitSeatVm({ root, ledger: slow, owner: seat(id), cap: 2 })));
  const admitted = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['SEAT_CAPACITY_FULL']);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].phase, 'reserved');
  assert.ok(['worker-x', 'worker-y'].includes(admitted[0].workerId));
  assert.deepEqual(await countSeatVms(root), { count: 2, invalid: 0 });
  assert.deepEqual(debris(root), []);
});

test('SC4 a dead holder\'s lock is recovered within the bound; a live, unknown or unparseable holder\'s never is', async t => {
  const root = scratch(t);
  const ledger = ledgerIn(root);
  const probed = [];
  writeFileSync(LOCK(root), holder(999999));
  let started = Date.now();
  await admitSeatVm({ root, ledger, owner: seat('1'), cap: 9, waitMs: 5000, probe: found => { probed.push(found.runner); return false; } });
  assert.deepEqual(probed, ['999999@deadbeefdeadbeef']);
  const { pid: dead } = spawnSync(process.execPath, ['-e', '']); // exited: the default probe's signal 0 answers ESRCH
  writeFileSync(LOCK(root), holder(dead));
  await admitSeatVm({ root, ledger, owner: seat('2'), cap: 9, waitMs: 5000 });
  assert.ok(Date.now() - started < 2000, 'recovered well inside waitMs');
  assert.deepEqual(debris(root), []);
  for (const [label, bytes, probe] of [['alive', holder(1), () => true], ['unknown', holder(1), () => undefined],
    ['unparseable', '{"runner":"1@x"', () => false], ['this live process', holder(process.pid), undefined],
    ['another host', holder(dead, { host: 'elsewhere' }), undefined], ['another platform', holder(dead, { platform: 'sunos' }), undefined]]) {
    writeFileSync(LOCK(root), bytes);
    started = Date.now();
    await assert.rejects(admitSeatVm({ root, ledger, owner: seat('3'), cap: 9, waitMs: 100, pollMs: 10, probe }), code('SEAT_CAPACITY_LOCK_BUSY'), label);
    assert.ok(Date.now() - started >= 100, label);
    assert.equal(readFileSync(LOCK(root), 'utf8'), bytes, label);
  }
  // Replaced by a live holder between the read and the move: restored, never deleted.
  const live = holder(process.pid, { acquiredAt: '2026-11-01T00:00:01.000Z' });
  writeFileSync(LOCK(root), holder(dead));
  let probes = 0;
  const swap = () => { if (probes++ > 0) return true; writeFileSync(LOCK(root), live); return false; };
  await assert.rejects(admitSeatVm({ root, ledger, owner: seat('3'), cap: 9, waitMs: 100, pollMs: 10, probe: swap }), code('SEAT_CAPACITY_LOCK_BUSY'));
  assert.equal(readFileSync(LOCK(root), 'utf8'), live);
  rmSync(LOCK(root));
  if (process.platform !== 'win32') { // a linked lock is never followed, so never proven dead
    const target = path.join(scratch(t), 'dead-holder');
    writeFileSync(target, holder(dead));
    symlinkSync(target, LOCK(root));
    await assert.rejects(admitSeatVm({ root, ledger, owner: seat('3'), cap: 9, waitMs: 50, pollMs: 10, probe: () => false }), code('SEAT_CAPACITY_LOCK_BUSY'));
    rmSync(LOCK(root));
  }
  assert.deepEqual(debris(root), []);
  assert.deepEqual((await ledger.list()).records.map(record => record.workerId).sort(), ['worker-1', 'worker-2']);
});

test('SC5 every exit releases the lock, release and assertHeld touch only their own lock, and invalid input writes nothing', async t => {
  const root = scratch(t);
  const ledger = ledgerIn(root);
  await admitSeatVm({ root, ledger, owner: seat('1'), cap: 1 });
  await assert.rejects(admitSeatVm({ root, ledger, owner: seat('2'), cap: 1 }), code('SEAT_CAPACITY_FULL'));
  assert.deepEqual(debris(root), []);
  const boom = Object.assign(new Error('boom'), { code: 'BOOM' });
  await assert.rejects(admitSeatVm({ root, ledger: { reserve: async () => { throw boom; } }, owner: seat('2'), cap: 2 }), error => error === boom);
  assert.deepEqual(debris(root), []);
  assert.equal((await admitSeatVm({ root, ledger, owner: seat('2'), cap: 2, waitMs: 0 })).workerId, 'worker-2');
  const lock = await acquireSeatLock(root, { waitMs: 0 });
  writeFileSync(LOCK(root), 'another holder\n');
  await assert.rejects(lock.assertHeld(), code('SEAT_CAPACITY_LOCK_LOST'));
  await lock.release();
  assert.equal(readFileSync(LOCK(root), 'utf8'), 'another holder\n');
  rmSync(LOCK(root));
  const fresh = path.join(root, 'fresh');
  for (const input of [{ owner: { ...seat('3'), extra: 1 } }, { owner: ATTEMPT }, { root: 'relative/root' }, { root: `${fresh}\u0007` }, { cap: 0 },
    { cap: 1.5 }, { cap: NaN }, { ledger: {} }, { waitMs: -1 }, { pollMs: 0.5 }, { probe: 'runnerProbe' }]) {
    await assert.rejects(admitSeatVm({ root: fresh, ledger, owner: seat('3'), cap: 9, ...input }), code('SEAT_CAPACITY_INPUT_INVALID'), JSON.stringify(input));
  }
  assert.deepEqual(debris(root), [], 'nothing written, the fresh root included');
  assert.equal((await ledger.list()).records.length, 2);
});

test('SC6 every refusal message is fixed text with no path or holder', async t => {
  const root = scratch(t);
  writeFileSync(LOCK(root), holder(1));
  const errors = await Promise.all([admitSeatVm({ root, ledger: ledgerIn(root), owner: seat('1'), waitMs: 0, probe: () => true }),
    countSeatVms(path.join(root, 'seat-capacity.lock')), admitSeatVm({ root: 'x' })].map(run => run.then(() => assert.fail('admitted'), error => error)));
  assert.deepEqual(errors.map(error => error.code), ['SEAT_CAPACITY_LOCK_BUSY', 'SEAT_CAPACITY_UNKNOWN', 'SEAT_CAPACITY_INPUT_INVALID']);
  if (process.platform !== 'win32' && process.getuid() !== 0) { // an unwritable root is unknown, never a busy lock
    const sealed = path.join(root, 'sealed');
    mkdirSync(sealed, { mode: 0o500 });
    errors.push(await admitSeatVm({ root: sealed, ledger: ledgerIn(root), owner: seat('1'), waitMs: 0 }).then(() => assert.fail('admitted'), error => error));
    assert.equal(errors.at(-1).code, 'SEAT_CAPACITY_UNKNOWN');
  }
  for (const error of errors) assert.ok(!error.message.includes(root) && !error.message.includes('deadbeef') && !/\d/.test(error.message), error.message);
});

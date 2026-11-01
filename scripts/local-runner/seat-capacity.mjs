// Host-wide cap on agent seat VMs (CQ-M07h; mem:decision-cq-m07-verified-local-activation, decision 2). Each seat VM is
// 2 CPUs, 4 GiB RAM and 20 GB disk, so at most max(1, min(floor(CPUs / 2), floor((RAM - 8 GiB) / 4 GiB))) run on this
// host at once, across every project. Check VMs (CQ-R11) keep their own dispatch and never count. A seat over the cap
// is refused SEAT_CAPACITY_FULL before it claims anything; the caller waits and retries and never falls back to the host.
// The count walks every project's ledger under the runner-state root (vm-control.mjs ownedLedgerDir's parent):
// reserved and launched seat records count, and so does every unreadable record, which may be a seat VM (fail closed).
// Admission counts and reserves under one host lock file, published whole by link() so it is never half-written. Only a
// holder proven dead on this host and platform (runnerProbe answering exactly false) is recovered, by rename and compare;
// a live, unknown, foreign or unparseable holder is never touched. Residuals:
// - a holder that already passed assertHeld when a recovery moves its lock can still reserve: three contenders
//   interleaving inside a microsecond window during a dead-lock recovery;
// - a dead holder's pid reused by a long-lived process, or a holder's lock restored by a recovery just after that holder
//   released it, reads alive: admission answers SEAT_CAPACITY_LOCK_BUSY until that process exits. An operator may
//   then remove <root>/seat-capacity.lock;
// - an unreadable record keeps a slot until cleaned, as does a seat's own lingering absent or failed record.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLedger, isSeatRecord, renameOver, validSeatOwner } from './lifecycle.mjs';
import { localRunnerHost, ownedLedgerDir, runnerProbe } from './vm-control.mjs';

const GIB = 1024 ** 3;
const LIVE_PHASES = new Set(['reserved', 'launching', 'owned', 'absent', 'failed']);
const PROJECT_DIR = /^[0-9a-f]{32}$/;
const LOCK_NAME = 'seat-capacity.lock';
const MAX_LOCK_BYTES = 1024;
const CONTROL = /[\x00-\x1f\x7f]/;
// Windows answers EPERM, EBUSY or EACCES around a delete-pending file: retry, as for EEXIST.
const LOCK_TAKEN = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
const MESSAGES = {
  SEAT_CAPACITY_INPUT_INVALID: 'Seat VM capacity input was invalid.',
  SEAT_CAPACITY_UNKNOWN: 'Seat VM capacity could not be determined.',
  SEAT_CAPACITY_FULL: 'This host already runs its cap of agent seat VMs.',
  SEAT_CAPACITY_LOCK_BUSY: 'The host seat capacity lock stayed busy.',
  SEAT_CAPACITY_LOCK_LOST: 'The host seat capacity lock was lost.',
};

const capacityError = code => Object.assign(new Error(MESSAGES[code]), { code });
const validRoot = root => typeof root === 'string' && path.isAbsolute(root) && !CONTROL.test(root);
const validMs = value => Number.isSafeInteger(value) && value >= 0;

/** The OS-reported total sits slightly below the nominal size, so a box exactly on a 4 GiB step rounds down: conservative. */
export function hostAgentVmCap({ cpus = os.availableParallelism(), totalmem = os.totalmem() } = {}) {
  if (!Number.isSafeInteger(cpus) || cpus < 0 || typeof totalmem !== 'number' || !Number.isFinite(totalmem) || totalmem < 0) {
    throw capacityError('SEAT_CAPACITY_INPUT_INVALID');
  }
  return Math.max(1, Math.min(Math.floor(cpus / 2), Math.floor((totalmem - 8 * GIB) / (4 * GIB))));
}

/** Live seat records under <root>/<32 hex>/vms, plus every invalid record file as occupied. Only real directories with
 * ownedLedgerDir's hex names are walked: files, links and other names (this module's lock and temp files) are skipped. */
export async function countSeatVms(root) {
  if (!validRoot(root)) throw capacityError('SEAT_CAPACITY_INPUT_INVALID');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { count: 0, invalid: 0 };
    throw capacityError('SEAT_CAPACITY_UNKNOWN');
  }
  let [live, invalid] = [0, 0];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_DIR.test(entry.name)) continue;
    let listed;
    try {
      listed = await createLedger(path.join(root, entry.name, 'vms')).list();
    } catch { throw capacityError('SEAT_CAPACITY_UNKNOWN'); }
    live += listed.records.filter(record => isSeatRecord(record) && LIVE_PHASES.has(record.phase)).length;
    invalid += listed.invalid.length;
  }
  return { count: live + invalid, invalid };
}

/** The runner-state root and this project's ledger, which is one of the ledgers the root count walks. */
export function seatAdmissionFor(projectPath) {
  let dir;
  try {
    dir = ownedLedgerDir(projectPath);
  } catch (error) {
    throw capacityError(error?.code === 'VM_CONTROL_INPUT_INVALID' ? 'SEAT_CAPACITY_INPUT_INVALID' : 'SEAT_CAPACITY_UNKNOWN');
  }
  return { root: path.dirname(path.dirname(dir)), ledger: createLedger(dir) };
}

/** The lock's bytes without following a link or blocking on a FIFO: null when absent, undefined when unreadable. */
async function readLock(file) {
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stats = await handle.stat();
      return stats.isFile() && stats.size <= MAX_LOCK_BYTES ? await handle.readFile('utf8') : undefined;
    } finally { await handle.close(); }
  } catch (error) { return error?.code === 'ENOENT' ? null : undefined; }
}

const scratchFile = (root, kind) => path.join(root, `.seat-capacity.${process.pid}.${randomBytes(8).toString('hex')}.${kind}`);
const deadHolder = (bytes, probe) => {
  try { return probe(JSON.parse(bytes)) === false; } catch { return false; }
};

/** Publishes the whole lock at once (a private synced temp file hard-linked into place); false while another holds it. */
async function publish(root, file, bytes) {
  const temp = scratchFile(root, 'tmp');
  let linking = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    linking = true;
    await link(temp, file);
    return true;
  } catch (error) {
    if (linking && LOCK_TAKEN.has(error?.code)) return false;
    throw capacityError('SEAT_CAPACITY_UNKNOWN');
  } finally { await unlink(temp).catch(() => {}); }
}

/** Removes the lock only if its bytes equal `expected`: it is moved aside first and restored when they differ, as a lock
 * replaced since it was read is live. True when the lock is gone; false when it stays or could not be moved. */
async function removeIf(root, file, expected) {
  const tomb = scratchFile(root, 'stale');
  try {
    await renameOver(file, tomb);
  } catch (error) { return error?.code === 'ENOENT'; }
  if ((await readLock(tomb)) === expected) {
    await unlink(tomb).catch(() => {});
    return true;
  }
  await link(tomb, file).catch(() => {}); // EEXIST: a newer lock won, and the moved holder's assertHeld fails closed
  await unlink(tomb).catch(() => {});
  return false;
}

/** The host lock under `root`, as { assertHeld, release }. A lock is broken only when probe(holder) is exactly false. */
export async function acquireSeatLock(root, { waitMs = 10_000, pollMs = 50, probe = runnerProbe } = {}) {
  if (!validRoot(root) || !validMs(waitMs) || !validMs(pollMs) || typeof probe !== 'function') throw capacityError('SEAT_CAPACITY_INPUT_INVALID');
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch { throw capacityError('SEAT_CAPACITY_UNKNOWN'); }
  const file = path.join(root, LOCK_NAME);
  const runner = `${process.pid}@${randomBytes(8).toString('hex')}`;
  const bytes = `${JSON.stringify({ runner, host: localRunnerHost(), platform: process.platform, acquiredAt: new Date().toISOString() })}\n`;
  const deadline = Date.now() + waitMs;
  while (!(await publish(root, file, bytes))) {
    const seen = await readLock(file);
    const gone = seen === null || (seen !== undefined && deadHolder(seen, probe) && await removeIf(root, file, seen));
    if (Date.now() >= deadline) throw capacityError('SEAT_CAPACITY_LOCK_BUSY'); // also bounds a lock that keeps vanishing
    if (!gone) await delay(pollMs);
  }
  return {
    assertHeld: async () => { if ((await readLock(file)) !== bytes) throw capacityError('SEAT_CAPACITY_LOCK_LOST'); },
    release: () => removeIf(root, file, bytes),
  };
}

/** Reserves `owner` a seat record in `ledger` only while fewer than `cap` seat VMs exist host-wide, counting and
 * reserving under the host lock; else SEAT_CAPACITY_FULL. A reserve failure propagates unchanged after release. */
export async function admitSeatVm({ root, ledger, owner, cap = hostAgentVmCap(), waitMs, pollMs, probe } = {}) {
  if (typeof ledger?.reserve !== 'function' || !validSeatOwner(owner) || !Number.isSafeInteger(cap) || cap < 1) {
    throw capacityError('SEAT_CAPACITY_INPUT_INVALID');
  }
  const lock = await acquireSeatLock(root, { waitMs, pollMs, probe });
  try {
    if ((await countSeatVms(root)).count >= cap) throw capacityError('SEAT_CAPACITY_FULL');
    await lock.assertHeld();
    return await ledger.reserve(owner);
  } finally { await lock.release(); }
}

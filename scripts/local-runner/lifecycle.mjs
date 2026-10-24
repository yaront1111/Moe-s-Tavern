// Owned-instance lifecycle only: durable ownership intent, bounded launch retry, crash
// reconciliation and owned cleanup. NOT readiness, bootstrap or isolation (CQ-R07+); nothing here
// claims executionReady. Multipass v1.17.0 facts relied on (canonical/multipass tag v1.17.0):
// - src/daemon/daemon.cpp require_existing_instances_reaction: a missing name is NOT_FOUND
//   `instance "<name>" does not exist`.
// - src/client/common/client_common.cpp: stderr is `<cmd> failed: The following errors occurred:`
//   plus that line; return_code_for maps NOT_FOUND to CommandFail=2 and UNAVAILABLE to DaemonFail=3.
//   Absence is therefore exit 2 plus that exact line for this exact name; anything else is unknown.
// - src/client/cli/formatter/json_formatter.cpp: info is {errors:[], info:{<name>:{state, ...}}}.
// - format_utils.cpp status_string_for: the ten state strings in STATES.
// - delete.cpp: `delete --purge <name>` is per-name with no prompt; `delete --all` and the `purge`
//   command are global and are never used here.
// Multipass has no ownership labels, so ownership is a ledger record written before launch, a
// verified pre-launch absence check and a random 80-bit name. Residual risk: a third party creating
// that exact name after the check would be adopted as ours; the random name makes that negligible.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { classifyFailure, MAX_PROBE_BUFFER, providerError } from './multipass.mjs';

export const OWNED_NAME_PREFIX = 'moe-vm-';
export const MAX_LAUNCH_TRIES = 3;
export const QUERY_TIMEOUT_MS = 30_000;
export const DELETE_TIMEOUT_MS = 120_000;
const NAME_BYTES = 10;
const MAX_RECORD_BYTES = 4096;
const execute = promisify(execFile);
export const STATES = new Set(['Running', 'Stopped', 'Deleted', 'Starting', 'Restarting', 'Delayed Shutdown', 'Suspending', 'Suspended', 'Unavailable', 'Unknown']);
const PHASES = new Set(['reserved', 'launching', 'owned', 'absent', 'failed', 'collision', 'deleted']);
const UNLAUNCHED = new Set(['reserved', 'collision']);
const LAUNCHED = new Set(['launching', 'owned', 'absent', 'failed']);
const ACTIVE_ATTEMPT = new Set(['running', 'finalizing', 'reconciling']);
const SURFACED = new Set(['PROVIDER_NOT_FOUND', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_TIMEOUT', 'PROVIDER_OUTPUT_LIMIT']);
const RECORD_KEYS = ['schemaVersion', 'provider', 'instance', 'taskId', 'attemptId', 'generation', 'phase', 'launchTries', 'createdAt', 'updatedAt'];
const REFUSED = new Map([['launching', 'LIFECYCLE_STATE_UNKNOWN'], ['failed', 'LIFECYCLE_RETRY_EXHAUSTED'],
  ['collision', 'LIFECYCLE_NAME_COLLISION'], ['deleted', 'LIFECYCLE_PHASE_INVALID']]);
const MESSAGES = {
  LIFECYCLE_INPUT_INVALID: 'Owned instance lifecycle input was invalid.',
  LIFECYCLE_STATE_UNKNOWN: 'Owned instance state is unknown; reconcile before acting on it.',
  LIFECYCLE_NAME_COLLISION: 'The reserved name existed before launch; that instance is foreign and left untouched.',
  LIFECYCLE_RETRY_EXHAUSTED: 'Owned instance launch retries are exhausted.',
  LIFECYCLE_NOT_OWNER: 'The caller does not own this instance record.',
  LIFECYCLE_PHASE_INVALID: 'The owned instance record cannot be provisioned in its current phase.',
  LEDGER_INPUT_INVALID: 'Owned instance ledger input was invalid.',
  LEDGER_RECORD_INVALID: 'Owned instance ledger record is missing or invalid.',
  LEDGER_CONFLICT: 'Owned instance ledger record changed concurrently.',
  LEDGER_WRITE_FAILED: 'Owned instance ledger write failed.',
  IMAGE_IDENTITY_CHANGED: 'Owned instance image identity changed; new evidence is required, never an overwrite.',
};
const REPORTABLE = new Set([...Object.keys(MESSAGES), ...SURFACED, 'PROVIDER_INPUT_INVALID']);
const CONTROL = /[\x00-\x1f\x7f]/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export function lifecycleError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'LIFECYCLE_STATE_UNKNOWN';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

export function ownedInstanceName({ random = randomBytes } = {}) {
  const bytes = typeof random === 'function' ? random(NAME_BYTES) : undefined;
  if (!Buffer.isBuffer(bytes) || bytes.length !== NAME_BYTES) throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  return OWNED_NAME_PREFIX + bytes.toString('hex');
}

export function isOwnedInstanceName(name) {
  return typeof name === 'string' && /^moe-vm-[0-9a-f]{20}$/.test(name);
}

/** The daemon's existing resource lease for an owned instance's job is keyed by the name itself. */
export function jobLeaseResourceId(name) {
  if (!isOwnedInstanceName(name)) throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  return name;
}

/** Validates inputs, then returns a bounded execFile invoker; run is injected only for tests. */
export function invoker(name, provider) {
  if (!isOwnedInstanceName(name) || !isRecord(provider)) throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  const { executable = 'multipass', run = execute } = provider;
  if (typeof run !== 'function') throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  if (typeof executable !== 'string' || executable.trim() === '' || CONTROL.test(executable)) throw providerError('PROVIDER_INPUT_INVALID');
  return (args, timeout) => run(executable, args, {
    encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL',
  });
}

function commandError(error) {
  const code = classifyFailure(error);
  return SURFACED.has(code) ? providerError(code) : lifecycleError('LIFECYCLE_STATE_UNKNOWN');
}

function infoState(stdout, name) {
  let parsed;
  try {
    if (typeof stdout === 'string' && Buffer.byteLength(stdout, 'utf8') <= MAX_PROBE_BUFFER) parsed = JSON.parse(stdout);
  } catch { parsed = undefined; }
  const info = isRecord(parsed) && Array.isArray(parsed.errors) && parsed.errors.length === 0 && isRecord(parsed.info) ? parsed.info : {};
  const keys = Object.keys(info);
  const state = keys.length === 1 && keys[0] === name && isRecord(info[name]) ? info[name].state : undefined;
  if (!STATES.has(state)) throw lifecycleError('LIFECYCLE_STATE_UNKNOWN');
  return state;
}

export async function queryOwnedInstance(name, provider = {}) {
  const invoke = invoker(name, provider);
  let result;
  try {
    result = await invoke(['info', name, '--format', 'json'], QUERY_TIMEOUT_MS);
  } catch (error) {
    const lines = typeof error?.stderr === 'string' ? error.stderr.slice(0, MAX_PROBE_BUFFER).split(/\r?\n/) : [];
    if (error?.code === 2 && lines.includes(`instance "${name}" does not exist`)) return { present: false };
    throw commandError(error);
  }
  return { present: true, state: infoState(result?.stdout, name) };
}

export async function deleteOwnedInstance(name, provider = {}) {
  const invoke = invoker(name, provider);
  try {
    await invoke(['delete', '--purge', name], DELETE_TIMEOUT_MS);
  } catch (error) { throw commandError(error); }
}

function validOwner(owner) {
  return isRecord(owner) && typeof owner.taskId === 'string' && /^task-[A-Za-z0-9]{1,64}$/.test(owner.taskId)
    && typeof owner.attemptId === 'string' && /^attempt-[A-Za-z0-9]{1,64}$/.test(owner.attemptId)
    && Number.isSafeInteger(owner.generation) && owner.generation > 0;
}

const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const IMAGE_KEYS = ['sourceSha256', 'providerImageHash'];
const validImage = image => isRecord(image) && Object.keys(image).length === IMAGE_KEYS.length
  && IMAGE_KEYS.every(key => Object.hasOwn(image, key) && isSha256(image[key]));

/** `image` (CQ-R07) is the one optional key: absent on every R06 record, exact when present. */
function validRecord(record, name) {
  const imaged = isRecord(record) && Object.hasOwn(record, 'image');
  return isRecord(record) && Object.keys(record).length === RECORD_KEYS.length + (imaged ? 1 : 0) && RECORD_KEYS.every(key => Object.hasOwn(record, key))
    && (!imaged || validImage(record.image))
    && record.schemaVersion === 1 && record.provider === 'multipass' && record.instance === name && isOwnedInstanceName(name)
    && validOwner(record) && PHASES.has(record.phase) && Number.isInteger(record.launchTries)
    && record.launchTries >= 0 && record.launchTries <= MAX_LAUNCH_TRIES
    && (record.launchTries === 0) === UNLAUNCHED.has(record.phase) && isIso(record.createdAt) && isIso(record.updatedAt);
}

/** Exclusive create, written and fsynced before close; a partial file is removed. */
async function writeNew(file, record) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
}

/** Best effort: win32 and some filesystems refuse directory fsync; losing it reverts at most one phase. */
async function syncDir(stateDir) {
  try {
    const handle = await open(stateDir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* ignored by design */ }
}

async function readRecord(stateDir, name) {
  if (!isOwnedInstanceName(name)) throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  let record;
  try {
    // No symlink follow and no FIFO block on POSIX; both flags are 0 where unsupported.
    const handle = await open(path.join(stateDir, `${name}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stats = await handle.stat();
      if (stats.isFile() && stats.size <= MAX_RECORD_BYTES) record = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch { record = undefined; }
  if (!validRecord(record, name)) throw lifecycleError('LEDGER_RECORD_INVALID');
  return record;
}

async function listRecords(stateDir) {
  let entries;
  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], invalid: [] };
    throw lifecycleError('LEDGER_RECORD_INVALID');
  }
  const records = [];
  const invalid = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
    try {
      if (!entry.isFile()) throw lifecycleError('LEDGER_RECORD_INVALID');
      records.push(await readRecord(stateDir, entry.name.slice(0, -'.json'.length)));
    } catch { invalid.push(entry.name); }
  }
  return { records, invalid };
}

async function reserveRecord(stateDir, random, owner) {
  if (!validOwner(owner)) throw lifecycleError('LEDGER_INPUT_INVALID');
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 1, provider: 'multipass', instance: ownedInstanceName({ random }),
    taskId: owner.taskId, attemptId: owner.attemptId, generation: owner.generation,
    phase: 'reserved', launchTries: 0, createdAt: now, updatedAt: now,
  };
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
  } catch { throw lifecycleError('LEDGER_WRITE_FAILED'); }
  try {
    await writeNew(path.join(stateDir, `${record.instance}.json`), record);
  } catch (error) { throw lifecycleError(error?.code === 'EEXIST' ? 'LEDGER_CONFLICT' : 'LEDGER_WRITE_FAILED'); }
  await syncDir(stateDir);
  return record;
}

/** Compare-and-swap on phase and launchTries; replace(current) returns the next record, or current for no write. */
async function swapRecord(stateDir, expected, replace) {
  const name = expected.instance;
  const current = await readRecord(stateDir, name);
  if (current.phase !== expected.phase || current.launchTries !== expected.launchTries) throw lifecycleError('LEDGER_CONFLICT');
  const replacement = replace(current);
  if (replacement === current) return current;
  const next = { ...replacement, updatedAt: new Date().toISOString() };
  if (!validRecord(next, name)) throw lifecycleError('LEDGER_INPUT_INVALID');
  // ponytail: compare-then-rename, not a lock: two writers inside the same read/rename window can both
  // pass; the later rename wins. Lifecycle guards keep provision and cleanup on disjoint attempts; add a
  // per-record lock file if concurrent writers to one record ever become real.
  const temp = path.join(stateDir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeNew(temp, next);
    await rename(temp, path.join(stateDir, `${name}.json`));
  } catch {
    await unlink(temp).catch(() => {});
    throw lifecycleError('LEDGER_WRITE_FAILED');
  }
  await syncDir(stateDir);
  return next;
}

async function updateRecord(stateDir, expected, changes) {
  if (!isOwnedInstanceName(expected?.instance) || !isRecord(changes) || Object.keys(changes).some(key => key !== 'phase' && key !== 'launchTries')) {
    throw lifecycleError('LEDGER_INPUT_INVALID');
  }
  // Spreads the re-read record, so a recorded image survives every later phase change.
  return swapRecord(stateDir, expected, current => ({ ...current, ...changes }));
}

/** Set-once image identity on an owned record: the same identity is a no-op, a different one is refused. */
async function recordImage(stateDir, expected, image) {
  if (!isOwnedInstanceName(expected?.instance) || !validImage(image)) throw lifecycleError('LEDGER_INPUT_INVALID');
  return swapRecord(stateDir, expected, current => {
    if (current.phase !== 'owned') throw lifecycleError('LIFECYCLE_PHASE_INVALID');
    const { sourceSha256, providerImageHash } = image;
    if (!current.image) return { ...current, image: { sourceSha256, providerImageHash } };
    if (current.image.sourceSha256 === sourceSha256 && current.image.providerImageHash === providerImageHash) return current;
    throw lifecycleError('IMAGE_IDENTITY_CHANGED');
  });
}

/**
 * One record per owned instance under a caller-chosen absolute stateDir. There is deliberately no
 * environment or default location: the protected runtime picks it, never inside .moe/ (the daemon is
 * its sole writer) or the repository. Every method returns detached copies.
 */
export function createLedger(stateDir, { random } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || CONTROL.test(stateDir)) throw lifecycleError('LEDGER_INPUT_INVALID');
  return {
    read: name => readRecord(stateDir, name),
    list: () => listRecords(stateDir),
    reserve: owner => reserveRecord(stateDir, random, owner),
    update: (expected, changes) => updateRecord(stateDir, expected, changes),
    recordImage: (expected, image) => recordImage(stateDir, expected, image),
  };
}

const ownedResult = record => ({ instance: record.instance, phase: 'owned', launchTries: record.launchTries, executionReady: false });

/** launch(name) is the platform launcher (R03-R05); it must settle and bound itself. */
export async function provisionOwned({ ledger, name, owner, launch, provider = {}, sleep = delay, retryDelayMs = 5_000 } = {}) {
  if (typeof launch !== 'function' || typeof sleep !== 'function' || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw lifecycleError('LIFECYCLE_INPUT_INVALID');
  }
  let record = await ledger.read(name);
  if (owner?.taskId !== record.taskId || owner?.attemptId !== record.attemptId || owner?.generation !== record.generation) {
    throw lifecycleError('LIFECYCLE_NOT_OWNER');
  }
  if (record.phase === 'owned') return ownedResult(record);
  if (REFUSED.has(record.phase)) throw lifecycleError(REFUSED.get(record.phase));
  if (record.phase === 'reserved' && (await queryOwnedInstance(name, provider)).present) {
    // Taken before we ever launched: foreign. Never adopted, launched or deleted.
    await ledger.update(record, { phase: 'collision' });
    throw lifecycleError('LIFECYCLE_NAME_COLLISION');
  }
  for (;;) {
    if (record.launchTries >= MAX_LAUNCH_TRIES) {
      await ledger.update(record, { phase: 'failed' });
      throw lifecycleError('LIFECYCLE_RETRY_EXHAUSTED');
    }
    record = await ledger.update(record, { phase: 'launching', launchTries: record.launchTries + 1 });
    let launched = true;
    try { await launch(name); } catch { launched = false; }
    // A failed or timed-out launch may still have created the VM: query the same name before any retry.
    const present = launched || (await queryOwnedInstance(name, provider).catch(() => {
      throw lifecycleError('LIFECYCLE_STATE_UNKNOWN');
    })).present;
    if (present) return ownedResult(await ledger.update(record, { phase: 'owned' }));
    record = await ledger.update(record, { phase: 'absent' });
    if (record.launchTries < MAX_LAUNCH_TRIES) await sleep(retryDelayMs);
  }
}

/** Restart recovery: queries each launched record's own name only. Idempotent. */
export async function reconcileOwned({ ledger, provider = {} } = {}) {
  const { records, invalid } = await ledger.list();
  const reconciled = [];
  const unknown = [];
  for (const record of records.filter(entry => LAUNCHED.has(entry.phase))) {
    try {
      const { present } = await queryOwnedInstance(record.instance, provider);
      const to = present ? 'owned' : record.phase === 'failed' ? 'failed' : 'absent';
      if (to === record.phase) continue;
      await ledger.update(record, { phase: to });
      reconciled.push({ instance: record.instance, from: record.phase, to });
    } catch { unknown.push(record.instance); }
  }
  return { reconciled, unknown, invalid };
}

async function holdReason(record, attemptPhase, leaseHeld) {
  let attempt;
  try { attempt = await attemptPhase(record.attemptId); } catch { attempt = undefined; }
  if (ACTIVE_ATTEMPT.has(attempt)) return 'attempt-active';
  if (attempt !== 'closed') return 'attempt-unknown';
  let lease;
  try { lease = await leaseHeld(jobLeaseResourceId(record.instance)); } catch { lease = undefined; }
  if (lease === true) return 'job-lease-held';
  return lease === false ? null : 'lease-unknown';
}

async function purgeOwned(record, ledger, provider) {
  if ((await queryOwnedInstance(record.instance, provider)).present) {
    let failure;
    await deleteOwnedInstance(record.instance, provider).catch(error => { failure = error; });
    const after = await queryOwnedInstance(record.instance, provider).catch(() => undefined);
    if (after?.present !== false) throw failure ?? lifecycleError('LIFECYCLE_STATE_UNKNOWN');
  }
  await ledger.update(record, { phase: 'deleted' });
}

/**
 * attemptPhase(attemptId) and leaseHeld(resourceId) read the daemon's existing attempt phase and resource
 * lease; activation wires them. Only launched ledger records whose attempt is closed and whose job lease
 * is free are deleted, by exact name; anything unknown is preserved. Per-record failures never abort.
 */
export async function cleanupOwned({ ledger, provider = {}, attemptPhase, leaseHeld } = {}) {
  const { records, invalid } = await ledger.list();
  const report = { deleted: [], preserved: [], errors: [], invalid };
  for (const record of records.filter(entry => LAUNCHED.has(entry.phase))) {
    const reason = await holdReason(record, attemptPhase, leaseHeld);
    if (reason) {
      report.preserved.push({ instance: record.instance, reason });
      continue;
    }
    try {
      await purgeOwned(record, ledger, provider);
      report.deleted.push(record.instance);
    } catch (error) {
      report.errors.push({ instance: record.instance, code: REPORTABLE.has(error?.code) ? error.code : 'LIFECYCLE_STATE_UNKNOWN' });
    }
  }
  return report;
}

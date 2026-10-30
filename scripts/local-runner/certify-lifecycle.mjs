// Lifecycle certify checks (CQ-R13h), each in its own owned VM beside certify's main VM, which they never touch.
// 'cancellation': a check run aborted once its session has started must resolve without 'passed', with its VM deleted and
// its ledger record 'deleted'. 'recovery': a controller child SIGKILLed once its VM is launched leaves a real orphan, and
// reconcile plus cleanup must delete exactly that VM while a foreign record in the same ledger survives. Every wait is
// bounded by LIFECYCLE_BOUNDS, every outcome is a fixed code, and no guest byte, path or credential reaches the report.
// Natively two VMs run at once. Certification is not activation: executionReady stays false, verified-local unavailable.
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { certifySnapshot } from './certify-bridge.mjs';
import { runCheckJob } from './check-lifecycle.mjs';
import { runCheckSession } from './check-session.mjs';
import { cleanupOwned, deleteOwned, reconcileOwned } from './lifecycle.mjs';

/** Certify's lifecycle bounds; certifyCore may lower each (1 to the constant) through deps.bounds, the native entry never. */
export const LIFECYCLE_BOUNDS = Object.freeze({ cancelBudgetMs: 300_000, launchMs: 900_000, pollMs: 1_000, reapMs: 30_000 });
/** The recovery check's controller child, spawned as [process.execPath, RECOVERY_CHILD] with no shell. */
export const RECOVERY_CHILD = fileURLToPath(new URL('./certify-recovery-child.mjs', import.meta.url));
// The supervisor's hello is its first stdout frame; the job then outlives any certify budget unless the abort ends it.
const CANCEL_CHECK = Object.freeze({ id: 'certify-cancel', command: 'echo ready; exec sleep 600', protected: Object.freeze([]) });
const passed = Object.freeze({ result: 'passed', code: null });
const failed = code => Object.freeze({ result: 'failed', code });
const syntheticOwner = () => ({ taskId: 'task-certify', attemptId: `attempt-${randomBytes(16).toString('hex')}`, generation: 1 });

// context: platform (observed), ledger (the base one), cacheDir, supervisor (the real bytes), provider, bounds. deps.checkSteps
// is a test-only seam, absent natively: runCheckJob's steps, plus `job` in place of runCheckJob. A rejection keeps its own code.
async function cancellation(c) {
  const { job = runCheckJob, ...steps } = c.deps?.checkSteps ?? {};
  const controller = new AbortController();
  let started = false;
  // Only the check session's spawn is watched, never materialize's or verify's: its first stdout bytes mean the session started.
  const session = input => (steps.session ?? runCheckSession)({ ...input, provider: { ...input.provider, spawn: (...args) => {
    const child = (input.provider?.spawn ?? spawnProcess)(...args);
    child?.stdout?.once?.('data', () => { started = true; controller.abort(); });
    return child;
  } } });
  const result = await job({ platform: c.platform, ledger: c.ledger, owner: syntheticOwner(), cacheDir: c.cacheDir, supervisor: c.supervisor,
    credential: randomBytes(32), snapshot: certifySnapshot(), check: CANCEL_CHECK, budgetMs: c.bounds.cancelBudgetMs, onReady: async () => {},
    dependencies: [], provider: c.provider, signal: controller.signal }, { ...steps, session });
  if (!started) return failed('CERTIFY_CANCEL_NOT_STARTED');
  if (result?.outcome === 'passed') return failed('CERTIFY_CANCEL_PASSED');
  if (result?.outcome === 'timeout') return failed('CERTIFY_CANCEL_TIMED_OUT'); // the budget, not the abort, ended it
  if (result?.vm !== 'deleted') return failed('CERTIFY_CANCEL_VM_NOT_DELETED');
  const record = await Promise.resolve().then(() => c.ledger.read(result.instance)).catch(() => null);
  return record?.phase === 'deleted' ? passed : failed('CERTIFY_CANCEL_RECORD_LIVE');
}

// The controller child, its stdin written once and ended, with state.closed/errored and state.close (its 'close'); null if
// spawn throws. Its stdout and stderr are ignored, so 'close' follows its exit even when killed (TerminateProcess on Windows).
function spawnChild(c, who) {
  const state = { closed: false, errored: false };
  let child;
  try {
    child = (c.deps?.spawn ?? spawnProcess)(process.execPath, [RECOVERY_CHILD], { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch { return null; }
  state.close = new Promise(resolve => child.once('close', () => { state.closed = true; resolve(true); }));
  child.on('error', () => { state.errored = true; });
  child.stdin.on('error', () => {}); // a child that died first refuses the write; the watch sees its close
  child.stdin.end(`${JSON.stringify({ ledgerDir: c.ledgerDir, cacheDir: c.cacheDir, owner: who })}\n`);
  return { child, state };
}

// SIGKILL, the child alone, as a crashed controller leaves it, unless it already closed; true once it closed within ms.
async function reap({ child, state }, ms) {
  if (state.closed) return true;
  try { child.kill('SIGKILL'); } catch { /* its close is still awaited below */ }
  const timer = new AbortController();
  try { return await Promise.race([state.close, delay(ms, false, { signal: timer.signal })]); } finally { timer.abort(); }
}

const recordOf = async (ledger, who) => (await ledger.list()).records.find(record => record.attemptId === who.attemptId) ?? null;

// The child's record once it reads 'owned', polled at most ceil(launchMs / pollMs) times; else a fixed code.
async function launched({ state }, ledger, who, { launchMs, pollMs }, sleep) {
  for (let left = Math.ceil(launchMs / pollMs); left > 0; left -= 1) {
    if (state.errored) return 'CERTIFY_RECOVERY_SPAWN_FAILED';
    if (state.closed) return 'CERTIFY_RECOVERY_CHILD_EXITED';
    const record = await recordOf(ledger, who);
    if (record?.phase === 'owned') return record;
    await sleep(pollMs);
  }
  return 'CERTIFY_RECOVERY_NOT_LAUNCHED';
}

// Reconcile, then cleanup with only the child's attempt closed (every other attempt reads unknown, so its VM is preserved):
// true only when exactly the child's VM was deleted, its record reads 'deleted' and the foreign record survives.
async function recovered({ ledger, provider }, record, foreign, who) {
  try {
    await reconcileOwned({ ledger, provider });
    const report = await cleanupOwned({ ledger, provider, attemptPhase: id => (id === who.attemptId ? 'closed' : null), leaseHeld: () => false });
    const [mine, theirs] = [await ledger.read(record.instance), await ledger.read(foreign.instance)];
    return report.deleted.length === 1 && report.deleted[0] === record.instance && report.errors.length === 0 && mine.phase === 'deleted'
      && theirs.phase !== 'deleted';
  } catch { return false; }
}

// context as for cancellation, plus ledgerDir (the base ledger's directory). deps.spawn and deps.sleep are test-only seams.
async function recovery(c) {
  const { ledger, provider, bounds } = c;
  // A foreign launched record with no VM, through the ledger API as the lifecycle writes it: cleanup must preserve it.
  const reserved = await ledger.reserve(syntheticOwner());
  const foreign = await ledger.update(await ledger.update(reserved, { phase: 'launching', launchTries: 1 }), { phase: 'owned' });
  const who = syntheticOwner();
  const run = spawnChild(c, who);
  if (run === null) return failed('CERTIFY_RECOVERY_SPAWN_FAILED');
  try {
    const record = await launched(run, ledger, who, bounds, c.deps?.sleep ?? delay);
    if (typeof record === 'string') return failed(record);
    if (!(await reap(run, bounds.reapMs))) return failed('CERTIFY_RECOVERY_NOT_REAPED');
    return (await recovered(c, record, foreign, who)) ? passed : failed('CERTIFY_RECOVERY_CLEANUP_FAILED');
  } finally { // On every path: the child reaped, and no VM of its left behind. This never turns a failure into a pass.
    await reap(run, bounds.reapMs);
    const live = await recordOf(ledger, who).catch(() => null);
    if (live !== null && live.phase !== 'deleted') await deleteOwned({ ledger, name: live.instance, owner: who, provider }).catch(() => {});
  }
}

/** Spliced into certify.mjs's BODY after CONTAINMENT_CHECKS, before 'teardown'. */
export const LIFECYCLE_CHECKS = Object.freeze([['cancellation', cancellation], ['recovery', recovery]].map(([id, run]) => Object.freeze({ id, run })));

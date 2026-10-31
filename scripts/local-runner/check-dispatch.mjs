// Runner focused check dispatch (CQ-V04b): the host's trusted runner runs every check the daemon says a strong-profile task
// owes on its current candidate (get_context's approved snapshot and gate rules, never candidate bytes), one at a time, each
// through the runCheck seam (R11's runCheckJob: one fresh VM, deleted before it settles). Evidence goes out only through the
// injected /runner `call` (V04b1): a dispatch once the VM is ready in a listed environment, then an observation, 'passed' only
// with the post-run workspace 'intact'; retries reuse their ids (CQ-V03b). No isolation is claimed; verified-local stays off.
// Dependencies come only from lockfiles named in the approved definition's configs. An uncovered owed gate stops every
// check before a VM with RUNNER_DEPENDENCIES_UNDECLARED: it has no approved dependency choice.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_CHECK_TAIL_BYTES } from './check-session.mjs';
import { openRunnerChannel } from './runner-client.mjs';
import { exportSourceSnapshot } from './source-export.mjs';
import { validateImport } from './source-snapshot.mjs';

const TRANSPORT = ['RUNNER_DISCONNECTED', 'RUNNER_CALL_TIMEOUT'], ATTEMPTS = 3;
const FLAGS = ['--project', '--task', '--commit'], CONTROL = /[\x00-\x1f\x7f]/;
const CALL_TIMEOUT_MS = 15_000, CHECK_BUDGET_MS = 3_600_000; // three calls fit runCheckJob's 60 s onReady bound
const MAX_RERUNS = 10; // CQ-V05's maxInfraRetries: the daemon's repair decision is the budget, this only bounds it locally
const LOCKFILE = 'package-lock.json';
const CODE_RE = /^RUNNER_[A-Z0-9_]{1,60}$/, NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const fixed = (value, pattern) => typeof value === 'string' && pattern.test(value);
const newId = prefix => `${prefix}-${randomBytes(16).toString('hex')}`;
const under = (path, roots) => roots.some(root => path === root || path.startsWith(`${root}/`));
// Only fixed codes leave this module: never an error message, which may carry upstream text.
const stopOf = (error, extra = {}) => ({ code: fixed(error?.code, CODE_RE) ? error.code : 'RUNNER_CALL_FAILED',
  ...(fixed(error?.codeName, NAME_RE) ? { codeName: error.codeName } : {}), ...extra });
const approvedRevision = served => Number.isSafeInteger(served?.planRevision) && served.planRevision === served.approvedPlanRevision;
const VMS = ['deleted', 'not-launched', 'delete-failed', 'none'], DELETE_FAILED = 'CHECK_VM_DELETE_FAILED';
const DIAGNOSTIC = 'RUNNER_VM_DELETE_FAILED: VM cleanup was not confirmed; no further checks will be launched.';

// One source's cleanup metadata, copied: runCheckJob's vm enum and a fixed failure code, nothing else. A source that cannot
// be read counts as an unconfirmed delete.
function metaOf(source) {
  try {
    if (source === null || typeof source !== 'object') return {};
    const { vm, failure } = source;
    return { ...(VMS.includes(vm) ? { vm } : {}), ...(fixed(failure, NAME_RE) ? { failure } : {}) };
  } catch { return { failure: DELETE_FAILED }; }
}

// A run's known {vm?, failure} from the seam's cleanup reports, then its result. A failed or unconfirmed delete from any source
// wins every conflict as {vm: 'delete-failed', failure: CHECK_VM_DELETE_FAILED}; {} when no source says anything (an older seam).
function cleanupOf(sources) {
  const metas = sources.map(metaOf);
  if (metas.some(meta => meta.vm === 'delete-failed' || meta.failure === DELETE_FAILED)) return { vm: 'delete-failed', failure: DELETE_FAILED };
  const [vm, failure] = [metas.find(meta => meta.vm)?.vm, metas.find(meta => meta.failure)?.failure];
  return vm === undefined && failure === undefined ? {} : { ...(vm ? { vm } : {}), failure: failure ?? null };
}

// A stop with the run's cleanup. After a failed delete it is RUNNER_VM_DELETE_FAILED, and causeCode is what else ended the
// run: the job's own failure code when it never dispatched, else the stop's code.
function withCleanup(prior, cleanup) {
  if (cleanup.failure !== DELETE_FAILED) return { ...prior, ...cleanup };
  const cause = prior.failure ?? prior.code;
  return { ...prior, code: 'RUNNER_VM_DELETE_FAILED', ...(cause ? { causeCode: cause } : {}), ...cleanup };
}

// The recorded tail plus the fixed cleanup line, within the daemon's MAX_CHECK_TAIL_BYTES: the oldest bytes go first, and the
// kept start moves past UTF-8 continuation bytes onto a whole character, as check-session's tailOf does.
function withDiagnostic(tail) {
  const line = `${tail === '' || tail.endsWith('\n') ? '' : '\n'}${DIAGNOSTIC}`;
  const bytes = Buffer.from(tail, 'utf8');
  let start = Math.max(0, bytes.length - (MAX_CHECK_TAIL_BYTES - Buffer.byteLength(line)));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return `${bytes.subarray(start).toString('utf8')}${line}`;
}

// A named lockfile is approved with the check (definitionDigest) and pinned by requiredCheckSnapshot. Evidence from a
// candidate changing it never counts until re-approval. Directory roots never infer a lockfile, even when one exists.
function lockfileDirs(configs = []) {
  return configs.flatMap(file => file === LOCKFILE ? ['.'] : file.endsWith(`/${LOCKFILE}`) ? [file.slice(0, -LOCKFILE.length - 1)] : []);
}

/** A get_context read's owed checks, as policy.ts owedChecks: each bound approved definition {checkId, trimmed command, protected
 * entries under its configs/scripts/assertionRoots, dependencies from configs}, then the owed gate (no dependency choice);
 * none off the approved revision. V04 admission backstops drift. */
export function owedChecks(context) {
  const { task, project, servedContext } = context ?? {};
  if (!approvedRevision(servedContext)) return [];
  const snapshot = task?.requiredCheckSnapshot;
  const owed = (snapshot ? task.executionContract?.requiredChecks ?? [] : []).map(def => ({ checkId: def.id, command: def.command.trim(),
    dependencies: lockfileDirs(def.configs),
    protected: snapshot.entries.filter(({ path }) => under(path, [...def.configs ?? [], ...def.scripts ?? [], ...def.assertionRoots ?? []]))
      .map(({ path, oid }) => ({ path, oid })) }));
  const { qualityGate, qualityGateScope, autoCommit } = project?.settings ?? {};
  const gate = typeof qualityGate === 'string' ? qualityGate.trim() : '';
  if (gate !== '' && autoCommit !== false && (qualityGateScope === 'everyTask' || task?.isEpicFinal === true)
    && !owed.some(check => check.command === gate)) owed.push({ command: gate, protected: [] });
  return owed;
}

// One call, retried with the same args (so the same id) only after a lost transport, at most ATTEMPTS times in all.
async function settle(call, tool, args) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(tool, args); } catch (error) {
      if (!TRANSPORT.includes(error?.code) || attempt === ATTEMPTS) throw error;
    }
  }
}

// One run on one fresh VM: the dispatch inside onReady, the observation once runCheck settled; never one without a dispatch.
// A failed delete stops the whole dispatch, after the observation when one is owed: nothing launches a VM after it.
async function runOnce(job, check) {
  let [dispatch, stop, result, rejected] = [null, null, null, false];
  const reports = []; // this run's own, copied at once: a rejection carries none of it
  const onCleanup = report => { reports.push(metaOf(report)); };
  const onReady = async environment => {
    if (!job.environments.includes(environment)) throw Object.assign(new Error('Unlisted environment.'), stop = { code: 'RUNNER_ENVIRONMENT_NOT_APPROVED' });
    const args = { id: newId('dispatch'), ...job.binding, command: check.command, ...(check.checkId === undefined ? {} : { checkId: check.checkId }), environment };
    try { await settle(job.call, 'moe.record_check_dispatch', args); } catch (error) { stop = stopOf(error); throw error; }
    dispatch = args;
  };
  const frame = Object.freeze({ id: check.checkId ?? 'quality-gate', command: check.command, protected: check.protected });
  try {
    result = await job.runCheck({ snapshot: job.snapshot, check: frame, dependencies: check.dependencies, owner: job.owner, onReady, onCleanup, signal: job.signal });
  } catch { rejected = true; }
  const cleanup = cleanupOf(rejected ? reports : [...reports, result]), failed = cleanup.failure === DELETE_FAILED;
  if (rejected) return { stopped: withCleanup(stop ?? { code: 'RUNNER_CHECK_FAILED', ...(dispatch ? { dispatchId: dispatch.id } : {}) }, cleanup) };
  if (stop || !dispatch || result === null || typeof result !== 'object') {
    const own = metaOf(result).failure; // the job's own step code, when it stopped before the dispatch
    return { stopped: withCleanup(stop ?? { code: 'RUNNER_CHECK_FAILED', ...(own && own !== DELETE_FAILED ? { failure: own } : {}) }, cleanup) };
  }
  let ran;
  try { ran = { outcome: result.outcome, workspace: result.workspace, exitCode: result.exitCode, outputTail: result.outputTail }; } catch {
    return { stopped: withCleanup({ code: 'RUNNER_CHECK_FAILED', dispatchId: dispatch.id }, cleanup) };
  }
  const outcome = ran.outcome === 'passed' && (ran.workspace !== 'intact' || failed) ? 'inconclusive' : ran.outcome;
  const tail = typeof ran.outputTail === 'string' ? ran.outputTail : '';
  // exitCode -1: the job never reported one (timeout, infra); the daemon takes any integer for those outcomes.
  const observation = { id: newId('check'), dispatchId: dispatch.id, exitCode: Number.isSafeInteger(ran.exitCode) ? ran.exitCode : -1,
    outcome, outputTail: failed ? withDiagnostic(tail) : tail, environment: dispatch.environment };
  let answer;
  try { answer = await settle(job.call, 'moe.record_check_observation', observation); } catch (error) {
    return { stopped: withCleanup(TRANSPORT.includes(error?.code) ? { code: 'RUNNER_OBSERVATION_UNRECORDED', dispatchId: dispatch.id }
      : stopOf(error, { dispatchId: dispatch.id }), cleanup) };
  }
  const entry = { ...(check.checkId === undefined ? {} : { checkId: check.checkId }), command: check.command, dispatchId: dispatch.id, outcome, ...cleanup };
  return { result: Object.freeze(entry), ...(failed ? { stopped: withCleanup({ dispatchId: dispatch.id }, cleanup) } : {}),
    retry: answer?.repair?.action === 'retry-infra' };
}

/** Dispatches and observes every check `taskId` owes on its current candidate, which `snapshot` must be exactly. Resolves a frozen
 * {taskId, candidateId, results: [{checkId?, command, dispatchId, outcome, vm?, failure?}] (one per run), stopped?}; no VM starts
 * after a stop. vm and failure are the run's known cleanup (runCheckJob's vm, its fixed failure code or null). A failed delete
 * stops the whole set with RUNNER_VM_DELETE_FAILED, whatever the daemon's repair decision or the checks still owed.
 * RUNNER_DEPENDENCIES_UNDECLARED stops the whole set before any VM when an owed gate has no approved dependency choice. */
export async function dispatchFocusedChecks({ taskId, snapshot, call, runCheck, signal } = {}) {
  if (typeof call !== 'function' || typeof runCheck !== 'function') throw Object.assign(new Error('Invalid input.'), { code: 'RUNNER_INPUT_INVALID' });
  const results = [];
  let candidateId = null;
  const done = stopped => Object.freeze({ taskId, candidateId, results: Object.freeze(results), ...(stopped ? { stopped: Object.freeze(stopped) } : {}) });
  let context;
  try { context = await call('moe.get_context', { taskId }); } catch (error) { return done(stopOf(error)); }
  const candidate = context?.currentCandidate;
  if (typeof candidate?.id !== 'string') return done({ code: 'RUNNER_NO_CANDIDATE' });
  candidateId = candidate.id;
  // Exactly the candidate's bytes: its tree, with no checkout overlay (dirty or untracked files) on top.
  const exact = typeof candidate.treeSha === 'string' && snapshot?.tree === candidate.treeSha && snapshot.overlay?.entries?.length === 0;
  if (!exact) return done({ code: 'RUNNER_SNAPSHOT_MISMATCH' });
  const served = context.servedContext;
  if (!approvedRevision(served)) return done({ code: 'RUNNER_PLAN_NOT_APPROVED' });
  let owed;
  try { owed = owedChecks(context); } catch { return done({ code: 'RUNNER_CONTEXT_INVALID' }); }
  if (owed.length === 0) return done({ code: 'RUNNER_NOTHING_OWED' });
  // Declare the gate's command as a required check, naming its lockfiles or none, so it has an approved dependency choice.
  if (owed.some(check => !Array.isArray(check.dependencies))) return done({ code: 'RUNNER_DEPENDENCIES_UNDECLARED' });
  const listed = context.project?.settings?.checkEnvironments;
  const job = { call, runCheck, snapshot, signal, environments: Array.isArray(listed) ? listed : [],
    binding: { taskId, candidateId, planRevision: served.planRevision }, owner: { taskId, attemptId: served.attemptId, generation: served.generation } };
  for (const check of owed) {
    for (let rerun = 0; ; rerun += 1) {
      if (signal?.aborted) return done({ code: 'RUNNER_ABORTED' });
      const step = await runOnce(job, check);
      if (step.result) results.push(step.result);
      if (step.stopped) return done(step.stopped);
      if (!step.retry) break;
      if (rerun === MAX_RERUNS) return done({ code: 'RUNNER_RETRY_LIMIT', dispatchId: step.result.dispatchId });
    }
  }
  return done();
}

// Exactly `--project <absolute path> --task <task id> --commit <40- or 64-hex>`, cli.mjs style: nothing runs before this.
function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 || !argv.every((arg, index) => (index % 2 === 0 ? arg === FLAGS[index / 2]
    : typeof arg === 'string' && !CONTROL.test(arg)))) return null;
  const [, projectPath, , taskId, , commit] = argv;
  return path.isAbsolute(projectPath) && /^task-[A-Za-z0-9]{1,64}$/.test(taskId) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
    ? { projectPath, taskId, commit } : null;
}

// R11's runCheckJob behind the runCheck seam, or null when the landed orchestrator lacks a seam this needs: onReady before
// the job (runCheckJob) and the post-run workspace report (R11f's verifyWorkspace). One fresh credential per job.
export async function landedRunCheck(projectPath, steps = {}) {
  const [{ runCheckJob }, { verifyWorkspace }] = await Promise.all([import('./check-lifecycle.mjs'), import('./snapshot-transfer.mjs')]);
  if (typeof runCheckJob !== 'function' || typeof verifyWorkspace !== 'function') return null;
  const [{ platformFor }, { createLedger }, { ownedLedgerDir }] = await Promise.all([import('./cli.mjs'), import('./lifecycle.mjs'), import('./vm-control.mjs')]);
  const stateDir = ownedLedgerDir(projectPath);
  const [platform, ledger, supervisor] = [platformFor(process.platform), createLedger(stateDir), await readFile(new URL('./guest-supervisor.py', import.meta.url))];
  return ({ snapshot, check, dependencies, owner, onReady, onCleanup, signal }) => runCheckJob({ platform, ledger, owner, cacheDir: path.join(path.dirname(stateDir), 'images'),
    supervisor, credential: randomBytes(32), snapshot, check, dependencies, budgetMs: CHECK_BUDGET_MS, onReady, onCleanup, signal, timeoutMs: 60_000 }, steps);
}

// The /runner channel, reopened for the next call once it drops, so a same-id retry after RUNNER_DISCONNECTED can land.
async function connect(open, projectPath) {
  let live = await open({ projectPath, timeoutMs: CALL_TIMEOUT_MS });
  return {
    async call(tool, args) {
      const channel = live ?? (live = await open({ projectPath, timeoutMs: CALL_TIMEOUT_MS }));
      try { return await channel.call(tool, args); } catch (error) {
        if (error?.code === 'RUNNER_DISCONNECTED' && live === channel) { live = null; channel.close(); }
        throw error;
      }
    },
    close: () => live?.close(),
  };
}

async function reportFor(input, { open, exportSnapshot, loadRunCheck, signal }) {
  let channel;
  try {
    const runCheck = await loadRunCheck(input.projectPath);
    if (typeof runCheck !== 'function') return { code: 'RUNNER_SEAM_UNAVAILABLE' };
    // The candidate is the commit alone: the checkout's overlay (peers' dirty bytes) is never part of it.
    const snapshot = { ...await exportSnapshot({ repoDir: input.projectPath, commit: input.commit }), overlay: validateImport([]) };
    channel = await connect(open, input.projectPath);
    return await dispatchFocusedChecks({ taskId: input.taskId, snapshot, call: channel.call, runCheck, signal });
  } catch (error) {
    return { code: fixed(error?.code, NAME_RE) ? error.code : 'RUNNER_DISPATCH_FAILED' };
  } finally { channel?.close(); } // V04b1's close never throws
}

// Every owed check's last run (a re-run supersedes its infra failure) observed 'passed', and nothing stopped.
const allPassed = ({ results, stopped }) => !stopped && Array.isArray(results) && results.length > 0
  && [...new Map(results.map(r => [`${r.checkId ?? ''}\n${r.command}`, r.outcome])).values()].every(outcome => outcome === 'passed');

/** Prints one JSON line of fixed codes, ids, commands and outcomes; exit 0 only when every owed check was observed passed. */
export async function runDispatchCli(argv, { open = openRunnerChannel, exportSnapshot = exportSourceSnapshot, loadRunCheck = landedRunCheck,
  signal, write = text => process.stdout.write(text) } = {}) {
  const input = argumentsFor(argv);
  const report = input ? await reportFor(input, { open, exportSnapshot, loadRunCheck, signal }) : { code: 'RUNNER_CLI_INPUT_INVALID' };
  write(`${JSON.stringify(report)}\n`);
  return allPassed(report) ? 0 : 2;
}

// The entry's import.meta.url is its realpath, which argv[1] may reach through a symlink (macOS's /var is /private/var).
function invokedDirectly() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}
if (invokedDirectly()) {
  const controller = new AbortController(); // an interrupt still lets runCheckJob delete its VM before the process ends
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  runDispatchCli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('Check dispatch could not emit its report.\n');
    process.exitCode = 2;
  });
}

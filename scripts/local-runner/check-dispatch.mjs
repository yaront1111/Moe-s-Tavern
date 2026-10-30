// Runner focused check dispatch (CQ-V04b): the host's trusted runner runs every check the daemon says a strong-profile task
// owes on its current candidate (get_context's approved snapshot and gate rules, never candidate bytes), one at a time, each
// through the runCheck seam (R11's runCheckJob: one fresh VM, deleted before it settles). Evidence goes out only through the
// injected /runner `call` (V04b1): a dispatch once the VM is ready in a listed environment, then an observation, 'passed' only
// with the post-run workspace 'intact'; retries reuse their ids (CQ-V03b). No isolation is claimed; verified-local stays off.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRunnerChannel } from './runner-client.mjs';
import { exportSourceSnapshot } from './source-export.mjs';
import { validateImport } from './source-snapshot.mjs';

const TRANSPORT = ['RUNNER_DISCONNECTED', 'RUNNER_CALL_TIMEOUT'], ATTEMPTS = 3;
const FLAGS = ['--project', '--task', '--commit'], CONTROL = /[\x00-\x1f\x7f]/;
const CALL_TIMEOUT_MS = 15_000, CHECK_BUDGET_MS = 3_600_000; // three calls fit runCheckJob's 60 s onReady bound
const MAX_RERUNS = 10; // CQ-V05's maxInfraRetries: the daemon's repair decision is the budget, this only bounds it locally
const CODE_RE = /^RUNNER_[A-Z0-9_]{1,60}$/, NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const fixed = (value, pattern) => typeof value === 'string' && pattern.test(value);
const newId = prefix => `${prefix}-${randomBytes(16).toString('hex')}`;
const under = (path, roots) => roots.some(root => path === root || path.startsWith(`${root}/`));
// Only fixed codes leave this module: never an error message, which may carry upstream text.
const stopOf = (error, extra = {}) => ({ code: fixed(error?.code, CODE_RE) ? error.code : 'RUNNER_CALL_FAILED',
  ...(fixed(error?.codeName, NAME_RE) ? { codeName: error.codeName } : {}), ...extra });
const approvedRevision = served => Number.isSafeInteger(served?.planRevision) && served.planRevision === served.approvedPlanRevision;

/** A get_context read's owed checks, as policy.ts owedChecks: each bound approved definition {checkId, trimmed command, protected
 * entries under its configs/scripts/assertionRoots}, then the owed gate; none off the approved revision. V04 admission backstops drift. */
export function owedChecks(context) {
  const { task, project, servedContext } = context ?? {};
  if (!approvedRevision(servedContext)) return [];
  const snapshot = task?.requiredCheckSnapshot;
  const owed = (snapshot ? task.executionContract?.requiredChecks ?? [] : []).map(def => ({ checkId: def.id, command: def.command.trim(),
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
async function runOnce(job, check) {
  let [dispatch, stop, result] = [null, null, null];
  const onReady = async environment => {
    if (!job.environments.includes(environment)) throw Object.assign(new Error('Unlisted environment.'), stop = { code: 'RUNNER_ENVIRONMENT_NOT_APPROVED' });
    const args = { id: newId('dispatch'), ...job.binding, command: check.command, ...(check.checkId === undefined ? {} : { checkId: check.checkId }), environment };
    try { await settle(job.call, 'moe.record_check_dispatch', args); } catch (error) { stop = stopOf(error); throw error; }
    dispatch = args;
  };
  const frame = Object.freeze({ id: check.checkId ?? 'quality-gate', command: check.command, protected: check.protected });
  try { result = await job.runCheck({ snapshot: job.snapshot, check: frame, owner: job.owner, onReady, signal: job.signal }); } catch {
    return { stopped: stop ?? { code: 'RUNNER_CHECK_FAILED', ...(dispatch ? { dispatchId: dispatch.id } : {}) } };
  }
  if (stop || !dispatch || result === null || typeof result !== 'object') {
    return { stopped: stop ?? { code: 'RUNNER_CHECK_FAILED', ...(fixed(result?.failure, NAME_RE) ? { failure: result.failure } : {}) } };
  }
  const outcome = result.outcome === 'passed' && result.workspace !== 'intact' ? 'inconclusive' : result.outcome;
  // exitCode -1: the job never reported one (timeout, infra); the daemon takes any integer for those outcomes.
  const observation = { id: newId('check'), dispatchId: dispatch.id, exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : -1,
    outcome, outputTail: typeof result.outputTail === 'string' ? result.outputTail : '', environment: dispatch.environment };
  let answer;
  try { answer = await settle(job.call, 'moe.record_check_observation', observation); } catch (error) {
    return { stopped: TRANSPORT.includes(error?.code) ? { code: 'RUNNER_OBSERVATION_UNRECORDED', dispatchId: dispatch.id }
      : stopOf(error, { dispatchId: dispatch.id }) };
  }
  const entry = { ...(check.checkId === undefined ? {} : { checkId: check.checkId }), command: check.command, dispatchId: dispatch.id, outcome };
  return { result: Object.freeze(entry), retry: answer?.repair?.action === 'retry-infra' };
}

/** Dispatches and observes every check `taskId` owes on its current candidate, which `snapshot` must be exactly. Resolves a frozen
 * {taskId, candidateId, results: [{checkId?, command, dispatchId, outcome}] (one per run), stopped?}; no VM starts after a stop. */
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
  const listed = context.project?.settings?.checkEnvironments;
  const job = { call, runCheck, snapshot, signal, environments: Array.isArray(listed) ? listed : [],
    binding: { taskId, candidateId, planRevision: served.planRevision }, owner: { taskId, attemptId: served.attemptId, generation: served.generation } };
  for (const check of owed) {
    for (let rerun = 0; ; rerun += 1) {
      if (signal?.aborted) return done({ code: 'RUNNER_ABORTED' });
      const step = await runOnce(job, check);
      if (step.stopped) return done(step.stopped);
      results.push(step.result);
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
async function landedRunCheck(projectPath) {
  const [{ runCheckJob }, { verifyWorkspace }] = await Promise.all([import('./check-lifecycle.mjs'), import('./snapshot-transfer.mjs')]);
  if (typeof runCheckJob !== 'function' || typeof verifyWorkspace !== 'function') return null;
  const [{ platformFor }, { createLedger }, { ownedLedgerDir }] = await Promise.all([import('./cli.mjs'), import('./lifecycle.mjs'), import('./vm-control.mjs')]);
  const stateDir = ownedLedgerDir(projectPath);
  const [platform, ledger, supervisor] = [platformFor(process.platform), createLedger(stateDir), await readFile(new URL('./guest-supervisor.py', import.meta.url))];
  return ({ snapshot, check, owner, onReady, signal }) => runCheckJob({ platform, ledger, owner, cacheDir: path.join(path.dirname(stateDir), 'images'),
    supervisor, credential: randomBytes(32), snapshot, check, budgetMs: CHECK_BUDGET_MS, onReady, signal, timeoutMs: 60_000 });
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController(); // an interrupt still lets runCheckJob delete its VM before the process ends
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  runDispatchCli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('Check dispatch could not emit its report.\n');
    process.exitCode = 2;
  });
}

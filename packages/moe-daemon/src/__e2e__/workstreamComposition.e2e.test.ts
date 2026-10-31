// =============================================================================
// Workstream composition, end to end (CQ-M06b1). Seams between landed producers:
//   A. stale revision (F×C×V): an edit after approval advances planRevision;
//      execution, review, check dispatch, plan reuse and recipe binding all see it.
//   B. check (V×C×M): qa_approve under deliveryPolicy local-branch, legacy and observe.
//   C. recipe (C×F×M): instantiation, fallback and approval under CONTROL, legacy and observe.
// CQ-M06b adds the isolation seam (D) to this file.
//
// Every call goes through the real MCP registry (createMcpCaller): `call` is /mcp,
// and `runnerCall` carries the identity authenticateRunner derives from a temp host
// key. Stores and a temp Git repo are real. Profiles change only through
// h.state.updateSettings; the strict cutover is F12's in-memory hand edit, made
// after the validated path refuses it. Nothing makes verified-local ready: no
// readiness spy and no test-only certification.
// Under legacy and observe a check run counts as declared. That is the wrapper's own
// moe.record_check_run path (docs/MCP_SERVER.md, record_check_dispatch "Limit"). So
// B3 proves the runner channel refusal, and that a self-labelled run is never
// authenticated, and keeps the compatibility outcome.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { RUNNER_KEY_HEADER, authenticateRunner, ensureRunnerKey } from '../server/runnerChannel.js';
import { createMcpCaller, type McpCaller } from '../__acceptance__/mcpCall.js';
import { deliveryEvidenceRefusal, evaluateDeliveryEvidence } from '../delivery/policy.js';
import { getCheckRun } from '../state/checkRunStore.js';
import { isAuthenticatedCheckRun } from '../state/checkObservationStore.js';
import { settlePlanReuseAssessments } from '../context/planReuseJob.js';
import { docsLiteralReplace } from '../context/recipes/docsLiteralReplace.js';
import { instantiateRecipe, readRecipeInstance, RECIPE_DEFINITIONS_PATH } from '../context/recipes/recipe.js';
import { RECIPE_ACTOR } from '../tools/submitPlan.js';
import type { ExecutionProfile, RecipeDefinition, Task } from '../types/schema.js';

const h = new ToolTestHarness();
type Call = McpCaller['call'];
type Ids = { workerId: string; attemptId: string; generation: number; sessionId: string };
type Refusal = { codeName?: string; message: string };
type Claimed = { hasNext: boolean; attemptId: string; generation: number; planReuse?: unknown };

const TASK = 'task-1';
const CHECK = 'npm run check:acc';
const DOCS_CHECK = 'npm run lint:docs';
const CFG = 'cfg/check.json';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const SUMMARY = 'verified the DoD; re-ran the check';
const RUNNER = { processStartedAt: '4242@2026-10-31T00:00:00.0000000Z', host: 'box-1' };
const PROFILES: ExecutionProfile[] = ['legacy', 'observe'];
const SEAT_ENV = ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID', 'MOE_ATTEMPT_ID', 'MOE_ATTEMPT_GENERATION',
  'MOE_RUNNER_PROCESS_STARTED_AT', 'MOE_RUNNER_HOST'];
const STEPS = [{ description: 'implement with error handling', affectedFiles: ['file.ts'] }, { description: 'test it', affectedFiles: ['file.ts'] }];
const ORIGINAL = '# Guide\nUse the old flag.\nKeep the flag set.\n';
const RECIPE: RecipeDefinition = { id: 'docs-fix', kind: docsLiteralReplace.name, version: 1,
  requiredChecks: [{ id: 'docs', command: DOCS_CHECK }], params: { allowedPaths: ['docs'] } };
const INPUTS = { path: 'docs/a.md', originalSha256: createHash('sha256').update(ORIGINAL).digest('hex'), oldText: 'old flag', newText: 'new flag' };
const DIRS = ['tasks', 'attempts', 'candidates', 'checks', 'reviews', 'receipts'];
const changed = (p: string) => `protected-check-changed:${p}`;

// git() is requiredChecks.delivery.test.ts's; commit() stages only its own files, never the daemon's .moe state.
function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function commit(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), text);
  }
  git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'fixture');
}
const head = () => ({ sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') });
const entriesAt = (tree: string, paths: string[]) => paths.map((p) => ({ path: p, oid: git('rev-parse', `${tree}:${p}`) }));

/** Every file under the evidence directories that exist, for the no-write proofs. */
function bytes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of DIRS.map((d) => path.join(h.moePath, d)).filter((d) => fs.existsSync(d))) {
    for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const file = path.join(dir, rel);
      if (fs.statSync(file).isFile()) out[path.relative(h.moePath, file)] = fs.readFileSync(file, 'utf8');
    }
  }
  return out;
}
/** Refused with exactly `codeName`, and nothing in bytes() moved. */
async function refused(attempt: () => Promise<unknown>, codeName: string): Promise<Refusal> {
  const before = bytes();
  const err = await attempt().then(() => null, (e: Refusal) => e);
  if (err === null) throw new Error(`expected ${codeName}, but the call succeeded`);
  expect(err.codeName).toBe(codeName);
  expect(bytes()).toEqual(before);
  return err;
}
const thrownCode = (fn: () => unknown) => { try { fn(); return 'returned'; } catch (e) { return (e as Refusal).codeName; } };

let call: Call;
let runnerCall: Call;
let runnerId = '';
let seq = 0;

beforeEach(async () => {
  for (const name of SEAT_ENV) vi.stubEnv(name, '');
  h.init();
  vi.stubEnv('MOE_RUNNER_KEY_DIR', path.join(h.testDir, 'runner-keys'));
  h.setupMoeFolder({ schemaVersion: 6, settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: false,
    branchPattern: '', commitPattern: '', agentCommand: 'claude', deliveryPolicy: 'local-branch' } as never });
  h.createEpic();
  h.createTask({ id: TASK, status: 'PLANNING' });
  git('init', '-q');
  commit({ 'file.ts': '', [CFG]: '{}\n', 'docs/a.md': ORIGINAL, [RECIPE_DEFINITIONS_PATH]: JSON.stringify({ version: 1, recipes: [RECIPE] }) });
  await h.state.load();
  const key = fs.readFileSync(await ensureRunnerKey(h.state.projectPath), 'utf8');
  const request = { socket: { remoteAddress: '127.0.0.1' }, headersDistinct: { [RUNNER_KEY_HEADER]: [key] } } as unknown as IncomingMessage;
  const runner = authenticateRunner(request, h.state.projectPath);
  if (!runner) throw new Error('fixture: authenticateRunner refused the temp host key');
  runnerId = runner.runnerId;
  const adapter = new McpAdapter(h.state);
  call = createMcpCaller(h.state, adapter).call;
  runnerCall = createMcpCaller(h.state, adapter, { runner }).call;
  seq = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); h.state.clearEmitter(); h.cleanup(); });

const task = (): Task => h.state.getTask(TASK)!;
const approve = (revision: unknown = task().planRevision) => h.state.runExclusive(() => h.state.approveTask(TASK, revision));
const editDoD = () => h.state.runExclusive(() => h.state.updateTask(TASK, { definitionOfDone: ['Tests pass', 'Docs updated'] }));
const instantiate = (inputs: Record<string, unknown> = INPUTS) => instantiateRecipe(h.state, { taskId: TASK, recipeId: RECIPE.id, inputs });
/** An ordinary plan whose requiredChecks protect CFG, approved by a human at its revision. */
async function approvedPlan(): Promise<void> {
  await call('moe.submit_plan', { taskId: TASK, steps: STEPS, executionContract: { requiredChecks: [{ id: 'acc', command: CHECK, configs: [CFG] }] } });
  await approve();
}
/** The validated path refuses verified-local; only then is the loaded profile flipped in memory (F12). */
async function strictInMemory(): Promise<void> {
  await refused(() => h.state.updateSettings({ executionProfile: 'verified-local' }), 'EXECUTION_PROFILE_NOT_READY');
  h.state.project!.settings.executionProfile = 'verified-local';
}
const serve = (id: Ids) => call('moe.get_context', { taskId: TASK, workerId: id.workerId, sessionId: id.sessionId });
async function claim(workerId: string, status: 'WORKING' | 'REVIEW'): Promise<Ids> {
  const r = (await call('moe.claim_next_task', { workerId, statuses: [status], taskId: TASK, ...RUNNER })) as Claimed;
  if (!r.hasNext) throw new Error(`fixture: ${workerId} could not claim ${TASK} in ${status}`);
  const ids = { workerId, attemptId: r.attemptId, generation: r.generation, sessionId: `${workerId}@session` };
  await serve(ids);
  return ids;
}
const start = (id: Partial<Ids>, stepId: string) => call('moe.start_step', { taskId: TASK, stepId, ...id });
const finish = (id: Partial<Ids>, stepId: string) => call('moe.complete_step', { taskId: TASK, stepId, modifiedFiles: ['file.ts'], ...id });
async function steps(id: Partial<Ids>): Promise<void> {
  for (const { stepId } of task().implementationPlan.filter((s) => s.status !== 'COMPLETED')) { await start(id, stepId); await finish(id, stepId); }
}
/** A runner-reported candidate of HEAD, after committing `files`, measured over `paths`. */
async function candidate(w: Ids, files: Record<string, string> = {}, paths = [CFG]): Promise<string> {
  if (Object.keys(files).length > 0) commit(files);
  const { sha, tree } = head();
  const id = `cand-${++seq}`;
  await call('moe.record_candidate', { id, taskId: TASK, attemptId: w.attemptId, generation: w.generation, workerId: w.workerId,
    baseRevision: sha, treeSha: tree, deliveryTarget: 'refs/heads/moe/work', protectedEntries: entriesAt(tree, paths) });
  return id;
}
/** complete_task presenting `identity`, then the wrapper's completion-commit record and its runner's finalize. */
async function land(w: Ids, identity: Partial<Ids> = w): Promise<void> {
  await call('moe.complete_task', { taskId: TASK, verification: { command: CHECK, exitCode: 0 }, ...identity });
  const { sha, tree } = head();
  await call('moe.record_commit', { taskId: TASK, outcome: 'committed', kind: 'completion', sha, treeId: tree, ref: 'moe/work',
    role: 'worker', sessionId: `${w.workerId}@unknown`, workerId: w.workerId, paths: ['file.ts'] });
  await call('moe.finalize_attempt', { taskId: TASK, workerId: w.workerId, runnerId: w.workerId, attemptId: w.attemptId,
    generation: w.generation, outcome: 'landed', landedRevision: sha });
}
/** The authenticated runner's dispatch at the approved revision, then its observation. */
async function observe(candidateId: string, outcome = 'passed', command = CHECK): Promise<string> {
  const id = `dispatch-${++seq}`;
  await runnerCall('moe.record_check_dispatch', { id, taskId: TASK, candidateId, planRevision: task().approvedPlanRevision, command, environment: ENV });
  await runnerCall('moe.record_check_observation', { id: `run-${id}`, dispatchId: id, exitCode: outcome === 'code-failure' ? 1 : 0, outcome, environment: ENV });
  return id;
}
const approveQa = (q: Ids, candidateId: string) => call('moe.qa_approve', { taskId: TASK, summary: SUMMARY, ...q, candidateId });
async function refusedApproval(q: Ids, candidateId: string, tokens: string[]): Promise<void> {
  const err = await refused(() => approveQa(q, candidateId), 'DELIVERY_EVIDENCE_MISSING');
  expect(err.message).toBe(deliveryEvidenceRefusal(TASK, { policy: 'local-branch', satisfied: false, missingEvidence: tokens }, true).message);
  expect(task().status).toBe('REVIEW');
}
/** Ranked architect claims, each followed by the reuse assessment it started: 1 when one returned the row, else 0. */
async function plannerCalls(): Promise<{ calls: number; planReuse?: unknown }> {
  for (let i = 0; i < 2; i++) {
    const reply = (await call('moe.claim_next_task', { workerId: 'architect-1', statuses: ['PLANNING'] })) as Claimed;
    await settlePlanReuseAssessments(h.state);
    if (reply.hasNext) return { calls: 1, planReuse: reply.planReuse };
  }
  return { calls: 0 };
}

describe('A. stale revision (F×C×V)', () => {
  /** Revision 1 approved; step-1 done; C1 recorded and passed by the runner; then a DoD edit makes revision 2. */
  async function staleAfterEvidence(): Promise<{ w: Ids; c1: string }> {
    await approvedPlan();
    const w = await claim('worker-w', 'WORKING');
    await start(w, 'step-1'); await finish(w, 'step-1');
    const c1 = await candidate(w);
    await observe(c1);
    expect(evaluateDeliveryEvidence(h.state, task()).missingEvidence).toEqual(['completion-commit']);
    await editDoD();
    expect(task()).toMatchObject({ status: 'WORKING', planRevision: 2, approvedPlanRevision: 1 });
    return { w, c1 };
  }

  it('A1: under the strict cutover the current identity can neither start a step nor complete the task', async () => {
    const { w } = await staleAfterEvidence();
    await serve(w);
    await strictInMemory();
    await refused(() => start(w, 'step-2'), 'PLAN_REVISION_NOT_APPROVED');
    await refused(() => call('moe.complete_task', { taskId: TASK, verification: { command: CHECK, exitCode: 0 }, ...w }), 'PLAN_REVISION_NOT_APPROVED');
  });

  it('A2/A3: C1 cannot be re-checked, plan reuse never resumes the row, and QA cannot approve C1 at the new revision', async () => {
    const { w, c1 } = await staleAfterEvidence();
    for (const planRevision of [1, 2]) {
      await refused(() => runnerCall('moe.record_check_dispatch', { id: `dispatch-r${planRevision}`, taskId: TASK, candidateId: c1,
        planRevision, command: CHECK, environment: ENV }), 'CHECK_DISPATCH_REVISION_MISMATCH');
    }
    // request_replan moves the plan to priorAttempt (a plan change: revision 3), so nothing is left to reuse.
    await call('moe.request_replan', { taskId: TASK, workerId: w.workerId, reason: 'The DoD changed after approval.' });
    expect([task().status, task().planRevision, task().approvedPlanRevision, task().implementationPlan]).toEqual(['PLANNING', 3, 1, []]);
    expect(await plannerCalls()).toEqual({ calls: 1, planReuse: undefined });
    expect([task().status, task().assignedWorkerId, task().approvedPlanRevision]).toEqual(['PLANNING', 'architect-1', 1]);

    await call('moe.submit_plan', { taskId: TASK, workerId: 'architect-1', steps: STEPS,
      executionContract: { requiredChecks: [{ id: 'acc', command: CHECK, configs: [CFG] }] } });
    await approve();
    expect([task().status, task().planRevision, task().approvedPlanRevision]).toEqual(['WORKING', 4, 4]);
    const w2 = await claim('worker-w', 'WORKING');
    await steps(w2);
    await land(w2);
    const q = await claim('qa-q', 'REVIEW');
    await strictInMemory();
    const err = await refused(() => approveQa(q, c1), 'CANDIDATE_REVISION_STALE');
    expect(err.message).toContain(`Candidate ${c1} of task ${TASK} was produced under plan revision 1, not the approved revision 4`);
    expect(thrownCode(() => evaluateDeliveryEvidence(h.state, task()))).toBe('EXECUTION_PROFILE_NOT_READY');
  });

  it('A3: a kept recipe plan back in PLANNING is never reused, and its binding reads null', async () => {
    await instantiate();
    await approve();
    expect(readRecipeInstance(task())).toMatchObject({ recipeId: RECIPE.id, inputs: INPUTS, planRevision: 1 });
    await editDoD();
    expect([task().planRevision, task().approvedPlanRevision, readRecipeInstance(task())]).toEqual([2, 1, null]);
    await call('moe.set_task_status', { taskId: TASK, status: 'PLANNING' });
    expect(await plannerCalls()).toEqual({ calls: 1, planReuse: { decision: 'replan', reasons: ['approval-not-current'] } });
    expect([task().status, task().assignedWorkerId, task().approvedPlanRevision, readRecipeInstance(task())]).toEqual(['PLANNING', 'architect-1', 1, null]);
  });

  it('legacy control: steps start without identity and only the delivery evidence is re-judged', async () => {
    const { w, c1 } = await staleAfterEvidence();
    await steps({ workerId: w.workerId });
    await land(w, { workerId: w.workerId });
    expect(task()).toMatchObject({ status: 'REVIEW', planRevision: 2, approvedPlanRevision: 1 });
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
    expect(await approveQa(await claim('qa-q', 'REVIEW'), c1)).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
  });
});

describe.each(PROFILES)('B. check (V×C×M) under %s', (profile) => {
  beforeEach(() => h.state.updateSettings({ executionProfile: profile }));
  /** A REVIEW row (plan, or recipe) whose candidate is built by `files`, with QA claimed and served. */
  async function toReview(files: Record<string, string> = {}, kind: 'plan' | 'recipe' = 'plan'): Promise<{ q: Ids; cand: string }> {
    if (kind === 'plan') await approvedPlan(); else { await instantiate(); await approve(); }
    expect(task().executionPolicySnapshot).toEqual({ version: 2, profile, planRevision: 1, deliveryPolicy: 'local-branch' });
    const w = await claim('worker-w', 'WORKING');
    await steps(w);
    const cand = await candidate(w, files, kind === 'plan' ? [CFG] : [RECIPE_DEFINITIONS_PATH]);
    await land(w);
    return { q: await claim('qa-q', 'REVIEW'), cand };
  }

  it('control: a passing authenticated run on the unchanged candidate approves', async () => {
    const { q, cand } = await toReview();
    await observe(cand);
    expect(await approveQa(q, cand)).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
    expect(fs.readdirSync(path.join(h.moePath, 'reviews'))).toHaveLength(1);
  });

  it('B1: no check run is refused', async () => {
    const { q, cand } = await toReview();
    await refusedApproval(q, cand, [`required-check:${CHECK}`]);
  });

  it.each(['code-failure', 'infra-failure', 'timeout', 'skipped', 'inconclusive'])('B2: a %s run is refused', async (outcome) => {
    const { q, cand } = await toReview();
    await observe(cand, outcome);
    await refusedApproval(q, cand, [`required-check:${CHECK}`]);
  });

  it('B3a: the runner-observed path without the runner channel is refused before any write', async () => {
    const { q, cand } = await toReview();
    await refused(() => call('moe.record_check_dispatch', { id: 'dispatch-x', taskId: TASK, candidateId: cand, planRevision: 1,
      command: CHECK, environment: ENV }), 'RUNNER_CHANNEL_REQUIRED');
    await refused(() => call('moe.record_check_observation', { id: 'run-x', dispatchId: 'dispatch-x', exitCode: 0, outcome: 'passed',
      environment: ENV }), 'RUNNER_CHANNEL_REQUIRED');
    await refusedApproval(q, cand, [`required-check:${CHECK}`]);
  });

  it('B3b: a self-labelled runner-observed run is recorded, never authenticated, and keeps the host-trust compatibility outcome', async () => {
    const { q, cand } = await toReview();
    const { tree } = head();
    await runnerCall('moe.record_check_dispatch', { id: 'dispatch-real', taskId: TASK, candidateId: cand, planRevision: 1, command: CHECK, environment: ENV });
    expect(await call('moe.record_check_run', { id: 'run-self', candidateId: cand, treeSha: tree, command: CHECK, exitCode: 0, outcome: 'passed',
      planRevision: 1, environment: ENV, runnerId, source: 'runner-observed', dispatchId: 'dispatch-real' })).toMatchObject({ success: true, duplicate: false });
    expect(isAuthenticatedCheckRun(h.state, getCheckRun(h.state, 'run-self')!)).toBe(false);
    expect(fs.existsSync(path.join(h.moePath, 'checks', 'observations'))).toBe(false);
    expect(await approveQa(q, cand)).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
  });

  it('B4: a candidate that changes a protected config is refused', async () => {
    const { q, cand } = await toReview({ [CFG]: '{"weaker":true}\n' });
    await observe(cand);
    await refusedApproval(q, cand, [changed(CFG)]);
  });

  it('B5: a recipe candidate that edits the recipe definitions is refused', async () => {
    const edited = JSON.stringify({ version: 1, recipes: [{ ...RECIPE, params: { allowedPaths: ['docs', 'src'] } }] });
    const { q, cand } = await toReview({ [RECIPE_DEFINITIONS_PATH]: edited }, 'recipe');
    await observe(cand, 'passed', DOCS_CHECK);
    await refusedApproval(q, cand, [changed(RECIPE_DEFINITIONS_PATH)]);
  });
});

describe.each(PROFILES)('C. recipe (C×F×M) under %s, CONTROL', (profile) => {
  beforeEach(() => h.state.updateSettings({ executionProfile: profile }));

  it.each<[string, Record<string, unknown>]>([
    ['docs-replace-path-not-allowed', { ...INPUTS, path: 'src/a.md' }],
    ['docs-replace-hash-mismatch', { ...INPUTS, originalSha256: 'f'.repeat(64) }],
    ['docs-replace-old-text-missing', { ...INPUTS, oldText: 'no such flag' }],
    ['docs-replace-old-text-ambiguous', { ...INPUTS, oldText: 'flag' }],
  ])('C1/C2: a %s instantiation falls back and leaves the row byte-identical', async (reason, inputs) => {
    const before = bytes();
    expect(await instantiate(inputs)).toEqual({ instantiated: false, fallback: 'ordinary-planning', reason });
    expect(bytes()).toEqual(before);
    expect([task().status, task().implementationPlan, task().recipeInstance, task().approvedPlanRevision]).toEqual(['PLANNING', [], undefined, undefined]);
  });

  it('C3: an eligible instantiation waits for a human, unapproved', async () => {
    expect(await instantiate()).toEqual({ instantiated: true, status: 'AWAITING_APPROVAL', planRevision: 1 });
    expect([task().status, task().approvedPlanRevision, task().executionPolicySnapshot?.profile]).toEqual(['AWAITING_APPROVAL', undefined, profile]);
    expect(readRecipeInstance(task())).toMatchObject({ recipeId: RECIPE.id, kind: RECIPE.kind, inputs: INPUTS, planRevision: 1 });
  });

  it('C4: submit_plan as the recipe actor from the wire is refused', async () => {
    const err = await refused(() => call('moe.submit_plan', { taskId: TASK, workerId: RECIPE_ACTOR, steps: STEPS }), 'NOT_ALLOWED');
    expect(err.message).toBe(`[NOT_ALLOWED] workerId ${RECIPE_ACTOR} is reserved for recipe instantiation`);
    expect([task().status, task().implementationPlan, task().planRevision ?? 0]).toEqual(['PLANNING', [], 0]);
  });

  it('C5: approving the recipe plan with a stale expectedPlanRevision is refused', async () => {
    await instantiate();
    await editDoD();
    expect([task().status, task().planRevision, readRecipeInstance(task())]).toEqual(['AWAITING_APPROVAL', 2, null]);
    await refused(() => approve(1), 'PLAN_REVISION_MISMATCH');
    expect(await approve(2)).toMatchObject({ status: 'WORKING', approvedPlanRevision: 2 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { recordCheckDispatchTool } from '../tools/recordCheckDispatch.js';
import { recordCheckObservationTool } from '../tools/recordCheckObservation.js';
import { openAttempt } from '../state/attemptStore.js';
import { recordCandidate } from '../state/candidateStore.js';
import { assertExecutionProfileReady } from './executionProfile.js';
import { MoeError } from '../util/errors.js';
import type { CheckRun } from '../types/schema.js';

// CQ-V05b: CQ-V05's decision acted on for each authenticated observation, through moe.record_check_observation.
// No readiness mock: every transition here is a backward move. Strict rows exist only as hand-edited JSON.

const h = new ToolTestHarness();
const GATE = 'npm run gate';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const RUNNER = { runner: { runnerId: 'runner-0123456789abcdef' } };
const SHA = { base: 'a1'.repeat(20), t1: 'c3'.repeat(20), t2: 'd4'.repeat(20) };
const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const STEP = { stepId: 'step-1', description: 'implement and test', status: 'COMPLETED', affectedFiles: ['file.ts'] };
const C1_HEADER = 'Required check run-1 failed on candidate cand-1: `npm run gate` code-failure (exit 1).';
const C1_LINE = 'Repair attempt 1, 2 remaining, under approved plan revision 1.';
const C1_TEXT = `${C1_HEADER}\n${C1_LINE}\nLog refs: run-1\nExcerpt:\nboom`;

type Result = { success: true; checkRun: CheckRun; duplicate: boolean; repair?: unknown; repairError?: string };
type Obs = { id: string; dispatchId: string; exitCode: number; outcome: string; outputTail: string; environment: string };
let counts: Record<string, number> = {};
let posts: ReturnType<typeof vi.spyOn>;
const next = (prefix: string) => `${prefix}-${(counts[prefix] = (counts[prefix] ?? 0) + 1)}`;
const tick = () => vi.setSystemTime(Date.now() + 1000);
const task = () => h.state.getTask('task-1')!;
/** The row without the fields a comment write touches. */
const rowOf = () => { const { comments: _c, updatedAt: _u, ...rest } = task(); return rest; };
const note = (content: string) => ({ id: expect.stringMatching(/^comment-/), author: 'moe-daemon', content, timestamp: new Date().toISOString() });
const diag = (checkRunId: string, candidateId: string, outcome: string, exitCode: number, excerpt: string, logRefs: string[]) =>
  ({ checkRunId, candidateId, command: GATE, outcome, exitCode, excerpt, logRefs });

/** A strict REVIEW row qa-1 holds, on disk, then the settings patch in memory (setupMoeFolder replaces settings). */
async function seed(row: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): Promise<void> {
  h.setupMoeFolder();
  h.createEpic();
  h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: 'qa-1', planRevision: 1, approvedPlanRevision: 1,
    executionPolicySnapshot: STRICT, implementationPlan: [STEP], stepsCompleted: ['step-1'], ...row } as never);
  h.createWorker({ id: 'qa-1', status: 'CODING', currentTaskId: 'task-1' });
  await h.state.load();
  h.state.project!.settings = { ...h.state.project!.settings, qualityGate: GATE, qualityGateScope: 'everyTask',
    checkEnvironments: [ENV], ...settings } as never;
  await openAttempt(h.state, { id: 'attempt-1', taskId: 'task-1', workerId: 'qa-1', runnerId: 'r', workspace: 'task-1' });
  posts = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
}
async function candidate(treeSha: string): Promise<string> {
  tick();
  const id = next('cand');
  await recordCandidate(h.state, { id, attemptId: 'attempt-1', taskId: 'task-1', treeSha, baseRevision: SHA.base, deliveryTarget: 'refs/heads/moe/work' });
  return id;
}
/** V04's dispatch path: admission, then the store. */
async function dispatch(candidateId: string): Promise<string> {
  tick();
  const args = { id: next('dispatch'), taskId: 'task-1', candidateId, planRevision: 1, command: GATE, environment: ENV };
  return ((await recordCheckDispatchTool(h.state).handler(args, h.state, RUNNER)) as { dispatch: { id: string } }).dispatch.id;
}
const obs = (dispatchId: string, outcome: string, exitCode: number, outputTail = 'boom'): Obs =>
  ({ id: next('run'), dispatchId, exitCode, outcome, outputTail, environment: ENV });
async function observe(args: Obs): Promise<Result> {
  tick();
  return (await recordCheckObservationTool(h.state).handler(args, h.state, RUNNER)) as Result;
}
const run = async (candidateId: string, outcome: string, exitCode: number, tail = 'boom') => observe(obs(await dispatch(candidateId), outcome, exitCode, tail));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'));
  counts = {};
  h.init();
});
afterEach(async () => {
  await h.state.flushActivityLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.state.clearEmitter();
  h.cleanup();
});

describe('repair decision activation (CQ-V05b)', () => {
  it('C1 returns a REVIEW task to WORKING under the same approved plan, with attempt, budget and diagnostics', async () => {
    await seed();
    const result = await run(await candidate(SHA.t1), 'code-failure', 1);
    expect(result.repair).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag('run-1', 'cand-1', 'code-failure', 1, 'boom', ['run-1']) });
    const t = task();
    expect([t.status, t.assignedWorkerId, t.planRevision, t.approvedPlanRevision, t.reopenCount, t.stepsCompleted, t.contextFetchedBy])
      .toStrictEqual(['WORKING', null, 1, 1, 0, [], []]);
    expect([t.implementationPlan.map((s) => s.status), t.reopenReason]).toStrictEqual([['PENDING'], `${C1_HEADER} ${C1_LINE}`]);
    expect(t.comments).toStrictEqual([note(C1_TEXT)]);
    expect([h.state.workers.get('qa-1')?.status, h.state.workers.get('qa-1')?.currentTaskId]).toStrictEqual(['IDLE', null]);
    expect(posts).not.toHaveBeenCalled();
  });

  it('C2 repairs again on a new failing candidate while WORKING, keeping status, steps and reopenReason', async () => {
    await seed();
    await run(await candidate(SHA.t1), 'code-failure', 1);
    await h.state.updateTask('task-1', { implementationPlan: [STEP] as never, stepsCompleted: ['step-1'] });
    const [before, first] = [rowOf(), task().comments![0]];
    expect(first).toStrictEqual(note(C1_TEXT));
    const result = await run(await candidate(SHA.t2), 'code-failure', 1, 'boom 2');
    const d = diag('run-2', 'cand-2', 'code-failure', 1, 'boom 2', ['run-2', 'run-1']);
    expect(result.repair).toStrictEqual({ action: 'repair', attempt: 2, remaining: 1, diagnostics: d });
    expect(rowOf()).toStrictEqual(before);
    expect(task().comments).toStrictEqual([first, note(
      'Required check run-2 failed on candidate cand-2: `npm run gate` code-failure (exit 1).\n' +
      'Repair attempt 2, 1 remaining, under approved plan revision 1.\nLog refs: run-2, run-1\nExcerpt:\nboom 2')]);
    expect(posts).not.toHaveBeenCalled();
  });

  it.each([
    ['an exhausted code budget', { repairPolicy: { maxCodeRepairs: 1 } }, SHA.t2, 'code-repair-budget-exhausted'],
    ['an unchanged candidate tree', {}, SHA.t1, 'unchanged-candidate'],
  ])('C3 escalates on %s with a comment and one #governors alert, never a loop', async (_label, settings, tree, reason) => {
    await seed({}, settings);
    await run(await candidate(SHA.t1), 'code-failure', 1);
    const before = rowOf();
    const result = await run(await candidate(tree), 'code-failure', 1, 'boom 2');
    expect(result.repair).toStrictEqual({ action: 'escalate', reason, diagnostics: diag('run-2', 'cand-2', 'code-failure', 1, 'boom 2', ['run-2', 'run-1']) });
    expect(rowOf()).toStrictEqual(before);
    expect(task().comments!.at(-1)).toStrictEqual(note('Required check run-2 failed on candidate cand-2: `npm run gate` code-failure (exit 1).\n' +
      `Escalated: ${reason}. No automatic repair follows.\nLog refs: run-2, run-1\nExcerpt:\nboom 2`));
    expect(posts.mock.calls).toStrictEqual([['governors', `⚠️ task-1 required check escalated (${reason}): \`npm run gate\` code-failure on cand-2; log refs run-2, run-1.`]]);
  });

  it('C4 leaves a REVIEW row parked for a human in REVIEW and only comments', async () => {
    await seed({ needsHumanReview: true });
    const before = rowOf();
    const result = await run(await candidate(SHA.t1), 'code-failure', 1);
    expect(result.repair).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag('run-1', 'cand-1', 'code-failure', 1, 'boom', ['run-1']) });
    expect([rowOf(), task().comments]).toStrictEqual([before, [note(C1_TEXT)]]);
    expect(posts).not.toHaveBeenCalled();
  });

  it('I1 re-dispatches infrastructure failures without a task change or a code repair, then escalates', async () => {
    await seed();
    const c1 = await candidate(SHA.t1);
    const before = task();
    expect((await run(c1, 'infra-failure', 1, 'vm lost')).repair)
      .toStrictEqual({ action: 'retry-infra', attempt: 1, remaining: 1, diagnostics: diag('run-1', 'cand-1', 'infra-failure', 1, 'vm lost', ['run-1']) });
    expect(task()).toStrictEqual(before);
    expect((await run(c1, 'timeout', 124, 'slow')).repair)
      .toStrictEqual({ action: 'retry-infra', attempt: 2, remaining: 0, diagnostics: diag('run-2', 'cand-1', 'timeout', 124, 'slow', ['run-2', 'run-1']) });
    expect([task(), posts.mock.calls]).toStrictEqual([before, []]);
    const refs = ['run-3', 'run-2', 'run-1'];
    expect((await run(c1, 'infra-failure', 1, 'vm lost')).repair)
      .toStrictEqual({ action: 'escalate', reason: 'infra-retry-budget-exhausted', diagnostics: diag('run-3', 'cand-1', 'infra-failure', 1, 'vm lost', refs) });
    expect(posts.mock.calls).toStrictEqual([['governors',
      '⚠️ task-1 required check escalated (infra-retry-budget-exhausted): `npm run gate` infra-failure on cand-1; log refs run-3, run-2, run-1.']]);
    expect((await run(c1, 'code-failure', 1)).repair)
      .toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag('run-4', 'cand-1', 'code-failure', 1, 'boom', ['run-4', ...refs]) });
    expect([task().status, task().reopenCount]).toStrictEqual(['WORKING', 0]);
  });

  it('R1 routes an unapproved plan revision to PLANNING, from the current candidate only', async () => {
    await seed();
    const stale = await dispatch(await candidate(SHA.t1));
    const live = await dispatch(await candidate(SHA.t2));
    await h.state.updateTask('task-1', { definitionOfDone: ['changed'] });
    const before = task();
    expect([before.planRevision, before.approvedPlanRevision]).toStrictEqual([2, 1]);
    const late = await observe(obs(stale, 'code-failure', 1));
    expect([late, task()]).toStrictEqual([{ success: true, checkRun: late.checkRun, duplicate: false }, before]);
    expect((await observe(obs(live, 'code-failure', 1))).repair).toStrictEqual({ action: 'replan', reason: 'plan-revision-unapproved' });
    const reason = 'Plan revision 2 is not approved (approved: 1); a required check result routed the task to PLANNING.';
    const t = task();
    expect([t.status, t.assignedWorkerId, t.implementationPlan, t.stepsCompleted, t.reopenReason]).toStrictEqual(['PLANNING', null, [], [], reason]);
    expect(t.priorAttempt).toStrictEqual({ attemptedAt: new Date().toISOString(), reason, implementationPlan: before.implementationPlan, stepsCompleted: ['step-1'] });
    expect([h.state.workers.get('qa-1')?.status, h.state.workers.get('qa-1')?.currentTaskId]).toStrictEqual(['IDLE', null]);
    const plan = '📋 New plan needed: Test Task (task-1) — claim with moe.claim_next_task {workerId, statuses:["PLANNING"]}';
    expect(posts.mock.calls).toStrictEqual([['architects', plan], ['governors', plan], ['architects', `🔁 task-1 routed to PLANNING: ${reason}`]]);
  });

  it('D returns the decision on a duplicate replay without applying it again', async () => {
    await seed();
    const args = obs(await dispatch(await candidate(SHA.t1)), 'code-failure', 1);
    const first = await observe(args);
    const after = task();
    const replay = await observe(args);
    expect([replay.duplicate, replay.repair, task(), posts.mock.calls]).toStrictEqual([true, first.repair, after, []]);
  });

  it('S answers a replay of a superseded run with no repair key once a newer run is the latest', async () => {
    await seed();
    const c1 = await candidate(SHA.t1);
    const old = obs(await dispatch(c1), 'infra-failure', 1);
    await observe(old);
    await run(c1, 'code-failure', 1);
    const after = task();
    const replay = await observe(old);
    expect([replay, task()]).toStrictEqual([{ success: true, checkRun: replay.checkRun, duplicate: true }, after]);
  });

  it.each([
    ['legacy', { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' }, { executionProfile: 'legacy', deliveryPolicy: 'legacy' }],
    ['observe', { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'local-branch' }, { executionProfile: 'observe', deliveryPolicy: 'local-branch' }],
  ])('L leaves a %s task and the CQ-V03 result shape unchanged', async (_profile, snapshot, settings) => {
    await seed({ executionPolicySnapshot: snapshot }, settings);
    const c1 = await candidate(SHA.t1);
    const before = task();
    for (const [outcome, exitCode] of [['code-failure', 1], ['infra-failure', 1]] as const) {
      const result = await run(c1, outcome, exitCode);
      expect(result).toStrictEqual({ success: true, checkRun: result.checkRun, duplicate: false });
    }
    expect([task(), posts.mock.calls]).toStrictEqual([before, []]);
  });

  it('E keeps the persisted observation when activation fails, reporting repairError', async () => {
    await seed({}, { repairPolicy: { maxCodeRepairs: 11 } });
    const c1 = await candidate(SHA.t1);
    const before = task();
    const result = await run(c1, 'code-failure', 1);
    expect(result).toStrictEqual({ success: true, checkRun: result.checkRun, duplicate: false,
      repairError: '[INVALID_INPUT] Invalid settings.repairPolicy.maxCodeRepairs: must be an integer from 0 to 10 (got 11)' });
    expect(JSON.parse(fs.readFileSync(path.join(h.moePath, 'checks', 'run-1.json'), 'utf8'))).toStrictEqual(result.checkRun);
    expect([task(), posts.mock.calls]).toStrictEqual([before, []]);
  });

  it('P keeps verified-local unavailable: the real readiness assertion still refuses it', () => {
    const error = (() => { try { assertExecutionProfileReady('verified-local'); return null; } catch (e) { return e; } })();
    expect([error instanceof MoeError, (error as MoeError | null)?.codeName]).toStrictEqual([true, 'EXECUTION_PROFILE_NOT_READY']);
  });
});

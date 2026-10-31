import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { getContextTool } from './getContext.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { getAttempt, openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeErrorCode, type MoeError } from '../util/errors.js';
import type { ExecutionAttempt, ImplementationStep, Task } from '../types/schema.js';

const STRICT = { version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' } as const;
const LEGACY = { ...STRICT, profile: 'legacy', deliveryPolicy: 'legacy' } as const;
const S1 = 'worker-s@2026-10-26T00:00:00Z';
const SB = 'worker-b@2026-10-26T00:00:00Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONE = { attemptId: undefined, generation: undefined, sessionId: undefined };
const step = (stepId: string, status: ImplementationStep['status'] = 'PENDING') =>
  ({ stepId, description: `do ${stepId}`, status, affectedFiles: [] });
const ACTIVE = [step('step-1', 'IN_PROGRESS'), step('step-2')];
const DONE = [step('step-1', 'COMPLETED'), step('step-2', 'COMPLETED')];
type Over = Record<string, unknown>;

describe('completion authorization (CQ-F08)', () => {
  const h = new ToolTestHarness();
  let attempt: ExecutionAttempt;

  beforeEach(() => {
    vi.stubEnv('MOE_WORKER_ID', ''); vi.stubEnv('MOE_TASK_ID', '');
    h.init(); h.setupMoeFolder(); h.createEpic();
    h.createWorker({ id: 'worker-s', currentTaskId: 'task-1', status: 'CODING' });
  });

  afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  const task = () => h.state.getTask('task-1')!;
  const open = () => openAttempt(h.state, { taskId: 'task-1', workerId: 'worker-s', runnerId: 'runner-s', workspace: h.testDir });
  const serve = () => getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-s', sessionId: S1 }, h.state);
  /** A raw WORKING row with an open attempt; `served` also reads get_context, recording this session's receipt. */
  async function seed(over: Partial<Task> = {}, served = true): Promise<void> {
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-s', planRevision: 3, approvedPlanRevision: 3,
      contextFetchedBy: ['worker-s'], implementationPlan: ACTIVE, executionPolicySnapshot: STRICT, ...over,
    } as Partial<Task>);
    await h.state.load();
    attempt = await open();
    if (served) await serve();
  }
  /** Close the current attempt, open and serve the next generation; returns the superseded one. */
  async function reopen(): Promise<ExecutionAttempt> {
    const old = attempt;
    await setAttemptPhase(h.state, old.id, 'closed');
    attempt = await open();
    await serve();
    return old;
  }
  /** Hand-edit a stored record, then reload: what a corrupted or out-of-band write leaves behind. */
  async function rawEdit(dir: string, id: string, patch: Over): Promise<void> {
    const file = path.join(h.moePath, dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
    await h.state.load();
  }
  const ids = () => ({ workerId: 'worker-s', attemptId: attempt.id, generation: attempt.generation, sessionId: S1 });
  const tools = {
    start: (over: Over = {}) => startStepTool(h.state).handler({ taskId: 'task-1', stepId: 'step-1', ...ids(), ...over }, h.state),
    step: (over: Over = {}) => completeStepTool(h.state).handler(
      { taskId: 'task-1', stepId: 'step-1', modifiedFiles: ['a.ts'], ...ids(), ...over }, h.state),
    task: (over: Over = {}) => completeTaskTool(h.state).handler(
      { taskId: 'task-1', verification: { command: 'npm test', exitCode: 0 }, ...ids(), ...over }, h.state),
  };
  /** Complete both steps through the real tools. */
  async function finish(over: Over = {}): Promise<void> {
    await tools.step(over);
    await tools.start({ stepId: 'step-2', ...over });
    await tools.step({ stepId: 'step-2', ...over });
  }
  const evidence = (id = attempt.id) => getAttempt(h.state, id)?.stepCompletions;
  const bytes = () => Object.fromEntries(['tasks', 'attempts', 'workers'].flatMap((dir) => {
    const full = path.join(h.moePath, dir);
    return fs.existsSync(full) ? fs.readdirSync(full).map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(full, f), 'utf8')]) : [];
  }));
  /** Refused with codeName before ANY write: no state write call, no #governors post, identical bytes. */
  async function refused(tool: 'step' | 'task', over: Over, codeName: string): Promise<MoeError> {
    const before = bytes();
    const spies = (['updateTask', 'touchWorker', 'writeEntity', 'postToRoleChannel'] as const).map((m) => vi.spyOn(h.state, m));
    const err = await tools[tool](over).then(() => null, (e: MoeError) => e);
    expect(err).toMatchObject({ codeName });
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
    expect(bytes()).toEqual(before);
    return err as MoeError;
  }

  describe('DoD1: a mid-step amendment is not completed under the old authorization', () => {
    it('refuses complete_step once amend_plan_step moves the in-progress step past its approval', async () => {
      await seed({ implementationPlan: [step('step-1'), step('step-2')] });
      await tools.start();
      await amendPlanStepTool(h.state).handler(
        { taskId: 'task-1', stepId: 'step-1', description: 'AMENDED step one', reason: 'scope', workerId: 'architect-t' }, h.state);
      expect(task()).toMatchObject({ planRevision: 4, approvedPlanRevision: 3 });
      await refused('step', {}, 'PLAN_REVISION_NOT_APPROVED');
      await serve(); // a rev-4 receipt never substitutes for approval
      await refused('step', {}, 'PLAN_REVISION_NOT_APPROVED');
      expect(task().implementationPlan[0].status).toBe('IN_PROGRESS');
      expect(evidence()).toBeUndefined();
    });

    it('refuses complete_task after a definitionOfDone edit, before the attempt is finalized', async () => {
      await seed();
      await finish();
      await h.state.updateTask('task-1', { definitionOfDone: ['A changed contract'] });
      expect(task()).toMatchObject({ planRevision: 4, approvedPlanRevision: 3 });
      await refused('task', {}, 'PLAN_REVISION_NOT_APPROVED');
      expect(getAttempt(h.state, attempt.id)?.phase).toBe('running');
    });
  });

  describe.each([['strict', STRICT], ['legacy', LEGACY]] as const)('DoD2 on a %s row', (_p, snapshot) => {
    it.each(['step', 'task'] as const)('refuses a superseded or a future attempt at complete_%s', async (tool) => {
      await seed({ executionPolicySnapshot: snapshot, implementationPlan: tool === 'task' ? DONE : ACTIVE });
      const old = await reopen();
      await refused(tool, { attemptId: old.id, generation: old.generation }, 'ATTEMPT_SUPERSEDED');
      await refused(tool, { generation: attempt.generation + 1 }, 'ATTEMPT_SUPERSEDED');
    });

    it.each([['step', '1'], ['step', 0], ['task', '1'], ['task', 0]] as const)(
      'refuses complete_%s with the malformed generation %j', async (tool, generation) => {
        await seed({ executionPolicySnapshot: snapshot, implementationPlan: tool === 'task' ? DONE : ACTIVE });
        await refused(tool, { generation }, 'INVALID_INPUT');
      });
  });

  describe.each(['step', 'task'] as const)('DoD2 strict identity at complete_%s', (tool) => {
    const plan = tool === 'task' ? DONE : ACTIVE;

    it('requires the full execution identity', async () => {
      await seed({ implementationPlan: plan });
      const err = await refused(tool, NONE, 'STEP_ENTRY_IDENTITY_REQUIRED');
      expect(err).toMatchObject({ code: MoeErrorCode.MISSING_REQUIRED });
      expect(err.context).toEqual({ taskId: 'task-1', missing: ['attemptId', 'generation', 'sessionId'] });
      expect(err.message).toContain(`moe.complete_${tool} on verified-local task task-1`);
    });

    it('refuses a finalizing attempt', async () => {
      await seed({ implementationPlan: plan });
      await setAttemptPhase(h.state, attempt.id, 'finalizing');
      await refused(tool, {}, 'ATTEMPT_NOT_RUNNING');
    });

    it("refuses another worker's attempt", async () => {
      await seed({ implementationPlan: plan, assignedWorkerId: 'worker-b', contextFetchedBy: ['worker-b'] }, false);
      await refused(tool, { workerId: 'worker-b', sessionId: SB }, 'ATTEMPT_NOT_RUNNING');
    });
  });

  describe('DoD3: evidence stays historical but is eligible only under the current binding', () => {
    it('records step evidence on the current attempt without moving the revision or reshaping the step', async () => {
      await seed();
      await expect(tools.step()).resolves.toMatchObject({ success: true, stepId: 'step-1' });
      expect(evidence()).toEqual([{ stepId: 'step-1', planRevision: 3, completedAt: expect.stringMatching(ISO) }]);
      evidence()!.length = 0; // readers get detached copies
      expect(evidence()).toHaveLength(1);
      expect(task()).toMatchObject({ planRevision: 3, approvedPlanRevision: 3 });
      expect(Object.keys(task().implementationPlan[0]).sort())
        .toEqual(['affectedFiles', 'completedAt', 'description', 'modifiedFiles', 'status', 'stepId']);
    });

    it('refuses complete_task at the readiness gate before any write, so a retry gets the same refusal', async () => {
      await seed();
      await finish();
      expect(evidence()?.map((e) => [e.stepId, e.planRevision])).toEqual([['step-1', 3], ['step-2', 3]]);
      await refused('task', {}, 'EXECUTION_PROFILE_NOT_READY');
      await refused('task', {}, 'EXECUTION_PROFILE_NOT_READY');
      expect(getAttempt(h.state, attempt.id)?.phase).toBe('running');
      expect(task()).toMatchObject({ status: 'WORKING', assignedWorkerId: 'worker-s' });
    });

    it("keeps a superseded attempt's evidence but refuses to count it", async () => {
      await seed();
      await finish();
      const old = await reopen();
      const kept = JSON.stringify(evidence(old.id));
      const err = await refused('task', {}, 'EXECUTION_EVIDENCE_INELIGIBLE');
      expect(err).toMatchObject({ code: MoeErrorCode.STATE_CONFLICT });
      expect(err.context).toEqual(
        { taskId: 'task-1', attemptId: attempt.id, generation: 2, planRevision: 3, steps: ['step-1', 'step-2'] });
      expect(err.message).toContain('moe.request_replan');
      expect(evidence(old.id)).toHaveLength(2);
      expect(JSON.stringify(evidence(old.id))).toBe(kept);
      const done = { status: 'COMPLETED', completedAt: expect.stringMatching(ISO), modifiedFiles: ['a.ts'] };
      expect(task().implementationPlan).toMatchObject([done, done]);
    });

    it('refuses evidence recorded under an earlier approved revision', async () => {
      await seed();
      await finish();
      await rawEdit('tasks', 'task-1', { planRevision: 4, approvedPlanRevision: 4 });
      await serve();
      const err = await refused('task', {}, 'EXECUTION_EVIDENCE_INELIGIBLE');
      expect(err.context).toEqual(
        { taskId: 'task-1', attemptId: attempt.id, generation: 1, planRevision: 4, steps: ['step-1', 'step-2'] });
    });

    it('refuses strict steps completed without any evidence', async () => {
      await seed({ implementationPlan: DONE });
      const err = await refused('task', {}, 'EXECUTION_EVIDENCE_INELIGIBLE');
      expect(err.context).toMatchObject({ steps: ['step-1', 'step-2'] });
    });

    it.each([
      ['an extra key', [{ stepId: 'step-1', planRevision: 3, completedAt: 'x', extra: 1 }]],
      ['a string planRevision', [{ stepId: 'step-1', planRevision: '3', completedAt: 'x' }]],
      ['a non-array', { stepId: 'step-1', planRevision: 3, completedAt: 'x' }],
    ])('fails closed on stored evidence with %s', async (_n, stored) => {
      await seed();
      await rawEdit('attempts', attempt.id, { stepCompletions: stored });
      await refused('step', {}, 'INVALID_INPUT');
      await rawEdit('tasks', 'task-1', { implementationPlan: DONE });
      await refused('task', {}, 'INVALID_INPUT');
    });
  });

  describe('legacy compatibility', () => {
    it('completes an unapproved legacy row with no identity as before, recording no evidence', async () => {
      await seed({ executionPolicySnapshot: undefined, approvedPlanRevision: undefined });
      await finish(NONE);
      await expect(tools.task(NONE)).resolves.toMatchObject({ success: true, status: 'REVIEW', attemptId: attempt.id });
      expect(getAttempt(h.state, attempt.id)).not.toHaveProperty('stepCompletions');
    });

    it('completes a legacy row that presents its current identity, recording no evidence', async () => {
      await seed({ executionPolicySnapshot: LEGACY });
      await finish();
      await expect(tools.task()).resolves.toMatchObject({ success: true, status: 'REVIEW' });
      expect(getAttempt(h.state, attempt.id)).not.toHaveProperty('stepCompletions');
    });
  });

  it('writes evidence before the task: a failed attempt write leaves the step in progress, and a retry records once', async () => {
    await seed();
    const write = vi.spyOn(h.state, 'writeEntity').mockRejectedValueOnce(new Error('disk full'));
    const update = vi.spyOn(h.state, 'updateTask');
    await expect(tools.step()).rejects.toThrow('disk full');
    expect(write.mock.calls[0][0]).toBe('attempts');
    expect(update).not.toHaveBeenCalled();
    expect(task().implementationPlan[0].status).toBe('IN_PROGRESS');
    await expect(tools.step()).resolves.toMatchObject({ success: true });
    expect(evidence()).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startStepTool } from './startStep.js';
import { getContextTool } from './getContext.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { openAttempt, recordContextReceipt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeErrorCode } from '../util/errors.js';
import type { ExecutionAttempt, ExecutionPolicySnapshot, Task } from '../types/schema.js';

const STRICT = { version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' } as const;
const LEGACY = { ...STRICT, profile: 'legacy', deliveryPolicy: 'legacy' } as const;
const S1 = 'worker-s@2026-10-26T00:00:00Z';
const SB = 'worker-b@2026-10-26T00:00:00Z';
const PACKET = `sha256:${'b'.repeat(64)}`;
const NONE = { attemptId: undefined, generation: undefined, sessionId: undefined };
const planStep = (stepId: string) => ({ stepId, description: `do ${stepId}`, status: 'PENDING' as const, affectedFiles: [] });

describe('moe.start_step entry authorization (CQ-F07)', () => {
  const h = new ToolTestHarness();
  let attempt: ExecutionAttempt;

  beforeEach(() => {
    vi.stubEnv('MOE_WORKER_ID', ''); vi.stubEnv('MOE_TASK_ID', '');
    h.init(); h.setupMoeFolder(); h.createEpic();
    h.createWorker({ id: 'worker-s', currentTaskId: 'task-1', status: 'CODING' });
  });

  afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  const task = () => h.state.getTask('task-1')!;
  const open = (workerId = 'worker-s', snapshot?: ExecutionPolicySnapshot) => openAttempt(h.state, {
    taskId: 'task-1', workerId, runnerId: `runner-${workerId}`, workspace: h.testDir,
    ...(snapshot ? { executionPolicySnapshot: snapshot } : {}),
  });
  async function seed(over: Record<string, unknown> = {}, withAttempt = true): Promise<void> {
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-s', planRevision: 3, approvedPlanRevision: 3,
      contextFetchedBy: ['worker-s'], implementationPlan: [planStep('step-1'), planStep('step-2')],
      executionPolicySnapshot: STRICT, ...over,
    } as Partial<Task>);
    await h.state.load();
    attempt = withAttempt ? await open() : ({ id: 'attempt-ghost', generation: 1 } as ExecutionAttempt);
  }
  /** Close the current attempt and open the next generation; returns the superseded one. */
  async function reopen(workerId = 'worker-s'): Promise<ExecutionAttempt> {
    const old = attempt;
    await setAttemptPhase(h.state, old.id, 'closed');
    attempt = await open(workerId);
    return old;
  }
  const serve = (workerId = 'worker-s', sessionId: string | undefined = S1) => getContextTool(h.state).handler(
    { taskId: 'task-1', workerId, ...(sessionId !== undefined ? { sessionId } : {}) }, h.state);
  const start = (over: Record<string, unknown> = {}) => startStepTool(h.state).handler({ taskId: 'task-1', stepId: 'step-1',
    workerId: 'worker-s', attemptId: attempt.id, generation: attempt.generation, sessionId: S1, ...over }, h.state);
  const receipt = (over: Record<string, unknown> = {}) => recordContextReceipt(h.state, {
    attemptId: attempt.id, workerId: 'worker-s', sessionId: S1, packetId: PACKET,
    planRevision: 3, approvedPlanRevision: 3, view: 'default', ...over,
  } as Parameters<typeof recordContextReceipt>[1]);
  const bytes = () => Object.fromEntries(['tasks', 'attempts', 'workers'].flatMap((dir) => {
    const full = path.join(h.moePath, dir);
    return fs.existsSync(full) ? fs.readdirSync(full).map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(full, f), 'utf8')]) : [];
  }));
  /** Refused with codeName before ANY write: no state call, identical bytes, step still PENDING. */
  async function refused(over: Record<string, unknown>, codeName: string): Promise<Error> {
    const before = bytes();
    const spies = [vi.spyOn(h.state, 'updateTask'), vi.spyOn(h.state, 'touchWorker'), vi.spyOn(h.state, 'writeEntity')];
    const err = await start(over).then(() => null, (e: Error) => e);
    expect(err).toMatchObject({ codeName });
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
    expect(bytes()).toEqual(before);
    expect(task().implementationPlan[0].status).toBe('PENDING');
    return err as Error;
  }

  it('permits entry with the current approved receipt, and progress never stales it', async () => {
    await seed();
    await serve();
    await expect(start()).resolves.toMatchObject({ success: true, stepId: 'step-1' });
    expect(task().implementationPlan[0]).toMatchObject({ status: 'IN_PROGRESS', startedAt: expect.any(String) });
    await expect(start({ stepId: 'step-2' })).resolves.toMatchObject({ success: true, stepId: 'step-2' });
    expect(task()).toMatchObject({ planRevision: 3, approvedPlanRevision: 3 });
  });

  it.each(['workerId', 'attemptId', 'generation', 'sessionId'])('refuses a strict entry missing %s', async (field) => {
    await seed();
    await serve();
    const err = await refused({ [field]: undefined }, 'STEP_ENTRY_IDENTITY_REQUIRED');
    expect(err).toMatchObject({ code: MoeErrorCode.MISSING_REQUIRED, context: { taskId: 'task-1', missing: [field] } });
    expect(err.message).toContain(`requires ${field}:`);
  });

  describe.each([['strict', STRICT], ['legacy', undefined]] as const)('malformed identity on a %s row', (_p, snapshot) => {
    it.each([
      ['an empty attemptId', { attemptId: '' }],
      ['a 129-char attemptId', { attemptId: 'a'.repeat(129) }],
      ['generation 0', { generation: 0 }],
      ['generation 1.5', { generation: 1.5 }],
      ["generation '1'", { generation: '1' }],
      ['a null sessionId', { sessionId: null }],
      ['a sessionId with a newline', { sessionId: 'a\nb' }],
    ])('refuses %s with INVALID_INPUT', async (_n, over) => {
      await seed({ executionPolicySnapshot: snapshot });
      await serve();
      await refused(over, 'INVALID_INPUT');
    });
  });

  it('refuses a superseded or a future generation', async () => {
    await seed();
    await serve();
    const old = await reopen();
    await serve();
    await refused({ attemptId: old.id, generation: old.generation }, 'ATTEMPT_SUPERSEDED');
    await refused({ generation: attempt.generation + 1 }, 'ATTEMPT_SUPERSEDED');
  });

  it('refuses a reassigned worker, and the new worker needs its own attempt and receipt', async () => {
    await seed();
    await serve();
    const old = attempt;
    await h.state.updateTask('task-1', { assignedWorkerId: null }); // the handback closes old; direct reassignment is refused
    await h.state.updateTask('task-1', { assignedWorkerId: 'worker-b' });
    await refused({}, 'NOT_ALLOWED');
    attempt = await open('worker-b');
    await serve('worker-b', undefined);
    await refused({ attemptId: old.id, generation: old.generation, workerId: 'worker-b', sessionId: SB }, 'ATTEMPT_SUPERSEDED');
    await refused({ workerId: 'worker-b', sessionId: SB }, 'CONTEXT_RECEIPT_STALE');
    await serve('worker-b', SB);
    await expect(start({ workerId: 'worker-b', sessionId: SB })).resolves.toMatchObject({ success: true });
  });

  it('refuses an attempt that is not running', async () => {
    await seed();
    await serve();
    await setAttemptPhase(h.state, attempt.id, 'reconciling');
    await refused({}, 'ATTEMPT_NOT_RUNNING');
  });

  it("refuses entry through another worker's open attempt", async () => {
    await seed({ assignedWorkerId: 'worker-b', contextFetchedBy: ['worker-b'] });
    await refused({ workerId: 'worker-b', sessionId: SB }, 'ATTEMPT_NOT_RUNNING');
  });

  it('refuses a strict row with no attempt record even though it presents an identity', async () => {
    await seed({}, false);
    await refused({}, 'ATTEMPT_NOT_RUNNING');
  });

  it('refuses entry once an amendment moves the plan past its approval', async () => {
    await seed();
    await serve();
    await amendPlanStepTool(h.state).handler(
      { taskId: 'task-1', stepId: 'step-2', description: 'AMENDED step two', reason: 'scope', workerId: 'architect-t' }, h.state);
    expect(task()).toMatchObject({ planRevision: 4, approvedPlanRevision: 3 });
    await refused({}, 'PLAN_REVISION_NOT_APPROVED');
  });

  it('never takes approval from a receipt', async () => {
    await seed({ approvedPlanRevision: undefined });
    await receipt();
    await refused({}, 'PLAN_REVISION_NOT_APPROVED');
  });

  it.each([
    ['no receipt', null],
    ['a receipt recorded at planRevision 2', { planRevision: 2 }],
    ['a receipt recorded without approvedPlanRevision', { approvedPlanRevision: undefined }],
    ['a receipt for another session', { sessionId: SB }],
  ])('refuses %s with CONTEXT_RECEIPT_STALE while the approval is current', async (_n, over) => {
    await seed();
    if (over) await receipt(over);
    await refused({}, 'CONTEXT_RECEIPT_STALE');
  });

  it('fails closed on a hand-edited stored receipt', async () => {
    await seed();
    await serve();
    const file = path.join(h.moePath, 'attempts', `${attempt.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, contextReceipt: { ...raw.contextReceipt, extra: 1 } }));
    await h.state.load();
    await refused({}, 'INVALID_INPUT');
  });

  it('is strict under a live verified-local setting with no task snapshot', async () => {
    await seed({ executionPolicySnapshot: undefined });
    h.state.project!.settings.executionProfile = 'verified-local';
    await refused({}, 'CONTEXT_RECEIPT_STALE');
  });

  it("is strict when the open attempt recorded a verified-local snapshot over a legacy task", async () => {
    await seed({ executionPolicySnapshot: LEGACY }, false);
    attempt = await open('worker-s', STRICT);
    await refused({}, 'CONTEXT_RECEIPT_STALE');
  });

  it('fails closed on a malformed task snapshot even when no identity is presented', async () => {
    await seed({ executionPolicySnapshot: { ...STRICT, version: 3 } }, false);
    await refused(NONE, 'INVALID_INPUT');
  });

  describe('explicit legacy compatibility', () => {
    const legacy = { executionPolicySnapshot: undefined, approvedPlanRevision: undefined };

    it.each([['the default profile', undefined], ['observe', 'observe']] as const)(
      'starts a legacy row with no identity, approval or receipt under %s', async (_n, profile) => {
        await seed(legacy);
        if (profile) await h.state.updateSettings({ executionProfile: profile });
        await expect(start(NONE)).resolves.toMatchObject({ success: true });
      });

    it('starts a legacy row presenting its current identity without a receipt or a current approval', async () => {
      await seed({ executionPolicySnapshot: undefined, approvedPlanRevision: 2 });
      await expect(start()).resolves.toMatchObject({ success: true });
    });

    it('fences a superseded generation presented on a legacy row', async () => {
      await seed(legacy);
      const old = await reopen();
      await refused({ attemptId: old.id, generation: old.generation }, 'ATTEMPT_SUPERSEDED');
    });
  });
});

// wait_for_task must honour the caller's OWN finalizing attempt exactly as
// claim_next_task does (task-4fbd3c69). (f1)/(f2) fail on the pre-fix
// waitForTask.ts; (c1)/(c2) pin the parts that were already right.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import type { ToolDefinition } from './index.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { completeTaskTool } from './completeTask.js';
import { finalizeAttemptTool } from './finalizeAttempt.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
import { listAttempts } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';

type Answer = Record<string, unknown> & { hasNext?: boolean; task?: { id: string }; nextAction?: { tool?: string; args?: Record<string, unknown> } };

describe('wait_for_task and the caller-scoped finalizing hold', () => {
  const h = new ToolTestHarness();
  const DONE_PLAN = [
    { stepId: 'step-1', description: 'Implement it', status: 'COMPLETED' as const, affectedFiles: ['file.ts'] },
  ];

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-W', status: 'WORKING', implementationPlan: DONE_PLAN, order: 1 });
    h.createTask({ id: 'task-next', status: 'WORKING', order: 2 });
    await h.state.load();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const waiter of Array.from(activeWaiters.values())) waiter.unsubscribe();
    activeWaiters.clear();
    h.state.clearEmitter();
    h.cleanup();
  });

  const call = async (tool: ToolDefinition, args: Record<string, unknown>) => (await tool.handler(args, h.state)) as Answer;

  /** worker-1 claims and completes task-W: its attempt stays finalizing, task-W goes to REVIEW unassigned. */
  async function completeLeavingFinalizing() {
    const claimed = await call(claimNextTaskTool(h.state), { statuses: ['WORKING'], taskId: 'task-W', workerId: 'worker-1' });
    await call(completeTaskTool(h.state), { taskId: 'task-W', workerId: 'worker-1', verification: { command: 'npm test', exitCode: 0 } });
    expect(listAttempts(h.state, 'task-W').map((a) => [a.workerId, a.phase])).toEqual([['worker-1', 'finalizing']]);
    return { attemptId: claimed.attemptId as string, generation: claimed.generation as number };
  }

  it('(c1) control: claim_next_task refuses worker-1 with ATTEMPT_FINALIZING while its attempt is finalizing', async () => {
    await completeLeavingFinalizing();
    const refused = await call(claimNextTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MoeError);
    expect((refused as MoeError).codeName).toBe('ATTEMPT_FINALIZING');
  });

  it('(c2) control: the hold is worker-scoped, so another worker is still woken for task-next', async () => {
    await completeLeavingFinalizing();
    const other = await call(waitForTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-2', timeoutMs: 1000 });
    expect(other.hasNext).toBe(true);
    expect(other.task?.id).toBe('task-next');
  });

  it('(f1) wait_for_task answers hasNext:false with no task while the caller\'s own attempt is finalizing', async () => {
    await completeLeavingFinalizing();
    const woke = await call(waitForTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-1', timeoutMs: 1000 });
    expect(woke.hasNext).toBe(false);
    expect(woke.task).toBeUndefined();
    expect(woke.nextAction?.tool).not.toBe('moe.claim_next_task');
  });

  it('(f2) the parked waiter wakes once finalize_attempt closes the attempt, and its claim assigns task-next', async () => {
    const { attemptId, generation } = await completeLeavingFinalizing();
    const parked = call(waitForTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-1', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(activeWaiters.has('worker-1')).toBe(true);

    await call(finalizeAttemptTool(h.state), { taskId: 'task-W', workerId: 'worker-1', attemptId, generation, outcome: 'nothing-to-commit' });
    const woke = await parked;
    expect(woke.hasNext).toBe(true);
    expect(woke.task?.id).toBe('task-next');
    expect(woke.nextAction?.tool).toBe('moe.claim_next_task');

    const claimed = await call(claimNextTaskTool(h.state), woke.nextAction!.args!);
    expect((claimed.task as { id: string }).id).toBe('task-next');
    expect(h.state.getTask('task-next')?.assignedWorkerId).toBe('worker-1');
  });
});

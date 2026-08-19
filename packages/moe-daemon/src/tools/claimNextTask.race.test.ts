import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNextTaskTool } from './claimNextTask.js';
import { releaseTaskTool } from './releaseTask.js';
import { taskSummary } from '../util/taskPayload.js';
import { ToolTestHarness } from './toolTestHarness.js';
import type { Task } from '../types/schema.js';

// =============================================================================
// task-6df8a07b — DoD 1-3.
//
// EVIDENCE BAR (governor comment-ea6f8aa2 item 2, binding): the interleaving is
// constructed, never raced. No threads, no timers, no repetition. `updateTask`
// is wrapped so caller B's claim lands BETWEEN caller A's eligibility read and
// A's own write — the exact window the incident lived in — and the outcome is
// therefore deterministic on every run. "Ran it N times, no dupes" is a
// pre-committed QA rejection and is not used here.
//
// MEASURED CONTEXT (step 1, this task): claim atomicity ALREADY holds —
// claimNextTask runs under state.runExclusive and taskStore.ts:169-176 carries
// an assignment CAS. What is missing is that the LOSER of a genuine race is
// silently handed a different row instead of being told it lost, and that a
// granted start_step is not a lease.
// =============================================================================
describe('claim_next_task — single winner, step lease, projection (task-6df8a07b)', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-hot', status: 'WORKING', order: 1 });
    h.createTask({ id: 'task-spare', status: 'WORKING', order: 2 });
    await h.state.load();
  });

  /**
   * Land `winner` on whichever row caller A picked, in the instant between A's
   * eligibility snapshot and A's write. One shot, then the wrapper is inert.
   */
  function interleaveClaimBefore(winner: string): void {
    const realUpdate = h.state.updateTask.bind(h.state);
    let fired = false;
    vi.spyOn(h.state, 'updateTask').mockImplementation(
      async (taskId: string, updates: Partial<Task>, event?: Parameters<typeof realUpdate>[2]) => {
        const assigning = (updates as { assignedWorkerId?: string | null }).assignedWorkerId;
        if (!fired && typeof assigning === 'string' && assigning !== winner) {
          fired = true;
          await realUpdate(taskId, { assignedWorkerId: winner } as Partial<Task>);
        }
        return realUpdate(taskId, updates, event);
      });
  }

  // (a) DoD 1. The loser must be TOLD it lost, by stable code, naming the
  // winner — not handed a different row as though nothing happened.
  it('refuses the loser of a constructed race with a stable code naming the winner', async () => {
    interleaveClaimBefore('worker-winner');

    const tool = claimNextTaskTool(h.state);
    let thrown: unknown;
    let result: unknown;
    try {
      result = await tool.handler({ statuses: ['WORKING'], workerId: 'worker-loser' }, h.state);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { codeName?: string; context?: Record<string, unknown> };
    expect(error.codeName).toBe('CLAIM_LOST_RACE');
    expect(error.context?.winner).toBe('worker-winner');
    expect(error.context?.caller).toBe('worker-loser');
    // NO SILENT SUBSTITUTION: the loser must not be quietly given task-spare.
    expect(result).toBeUndefined();
    // Exactly one winner holds the contested row.
    expect(h.state.getTask('task-hot')!.assignedWorkerId).toBe('worker-winner');
    // The spare row stays untouched — a lost race must not consume other work.
    expect(h.state.getTask('task-spare')!.assignedWorkerId).toBeNull();
  });

  // (b) DoD 2 — the start_step ownership guard is the current last line of
  // defense and must survive the fix. COVERED ALREADY, recorded rather than
  // duplicated: startStep.test.ts:123 'rejects when a different worker attempts
  // to start the step' (MoeError NOT_ALLOWED), and util/enforcement.test.ts
  // covers assertWorkerOwns directly. This case pins the part those do not: the
  // refusal must NAME both parties, so a reader can tell who holds the row.
  it('start_step guard names both the owner and the caller', async () => {
    const { assertWorkerOwns } = await import('../util/enforcement.js');
    const task = { id: 'task-hot', assignedWorkerId: 'worker-owner' } as Task;

    let thrown: unknown;
    try {
      assertWorkerOwns(task, 'worker-intruder', 'moe.start_step');
    } catch (err) {
      thrown = err;
    }

    const error = thrown as Error & { context?: Record<string, unknown> };
    expect(error.context?.owner).toBe('worker-owner');
    expect(error.context?.caller).toBe('worker-intruder');
  });

  // (c) DoD 2 / governor 9de7b547 item 2. THE CORE OF THE FIX: a granted
  // start_step must be a LEASE. Incident 2 was a worker losing a row whose
  // step-1 was already IN_PROGRESS, discovering it only at complete_step after
  // a 4-minute suite run.
  it('refuses replaceExisting takeover of a row whose step is IN_PROGRESS', async () => {
    h.createTask({
      id: 'task-leased', status: 'WORKING', order: 0, assignedWorkerId: 'worker-holder',
      implementationPlan: [
        { stepId: 'step-1', description: 'baseline', status: 'IN_PROGRESS', affectedFiles: [] },
      ],
    });
    h.createWorker({ id: 'worker-holder', status: 'CODING', currentTaskId: 'task-leased' });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    let thrown: unknown;
    try {
      await tool.handler({
        statuses: ['WORKING'], taskId: 'task-leased',
        workerId: 'worker-thief', replaceExisting: true,
      }, h.state);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { codeName?: string; context?: Record<string, unknown> };
    expect(error.codeName).toBe('STEP_LEASE_HELD');
    expect(error.context?.holder).toBe('worker-holder');
    expect(error.context?.stepId).toBe('step-1');
    expect(h.state.getTask('task-leased')!.assignedWorkerId).toBe('worker-holder');
  });

  it('refuses a non-forced release of a row whose step is IN_PROGRESS', async () => {
    h.createTask({
      id: 'task-leased', status: 'WORKING', order: 0, assignedWorkerId: 'worker-holder',
      implementationPlan: [
        { stepId: 'step-1', description: 'baseline', status: 'IN_PROGRESS', affectedFiles: [] },
      ],
    });
    h.createWorker({ id: 'worker-holder', status: 'CODING', currentTaskId: 'task-leased' });
    await h.state.load();

    const tool = releaseTaskTool(h.state);
    let thrown: unknown;
    try {
      // No workerId: the legacy/TUI path. It stays open for a row with no step
      // in flight (releaseTask.test.ts covers that), but a live lease outranks
      // it — otherwise the incident reproduces through the legacy door.
      await tool.handler({ taskId: 'task-leased' }, h.state);
    } catch (err) {
      thrown = err;
    }

    const error = thrown as Error & { codeName?: string; context?: Record<string, unknown> };
    expect(error?.codeName).toBe('STEP_LEASE_HELD');
    expect(error.context?.stepId).toBe('step-1');
    expect(h.state.getTask('task-leased')!.assignedWorkerId).toBe('worker-holder');
  });

  it('lets force:true through the lease — the single auditable override', async () => {
    h.createTask({
      id: 'task-leased', status: 'WORKING', order: 0, assignedWorkerId: 'worker-holder',
      implementationPlan: [
        { stepId: 'step-1', description: 'baseline', status: 'IN_PROGRESS', affectedFiles: [] },
      ],
    });
    h.createWorker({ id: 'worker-holder', status: 'CODING', currentTaskId: 'task-leased' });
    await h.state.load();

    const tool = releaseTaskTool(h.state);
    const result = await tool.handler(
      { taskId: 'task-leased', workerId: 'governor-1', force: true }, h.state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-holder');
    expect(h.state.getTask('task-leased')!.assignedWorkerId).toBeNull();
  });

  // (d) DoD 3, satisfied by its documented-bound alternative. MEASURED in
  // step 1: util/taskPayload.ts derives assignedWorkerId and hasWorker straight
  // from the task record with no cache between them, so a reader cannot see
  // null while the guard holds someone — the two read the same field. The
  // observed null was the release→next-claim window, when the row was GENUINELY
  // unassigned and every reader agreed. This pins that derivation so a future
  // cache cannot be introduced silently.
  it('projects the live assignee with no divergence window (DoD 3 bound)', async () => {
    const tool = claimNextTaskTool(h.state);
    await tool.handler({ statuses: ['WORKING'], workerId: 'worker-holder' }, h.state);

    const held = h.state.getTask('task-hot')!;
    expect(held.assignedWorkerId).toBe('worker-holder');

    const summary = taskSummary(held);
    expect(summary.assignedWorkerId).toBe('worker-holder');
    expect(summary.hasWorker).toBe(true);

    // The bound: projection is a pure function of the record, so it cannot lag.
    const unassigned = taskSummary({ ...held, assignedWorkerId: null });
    expect(unassigned.assignedWorkerId).toBeNull();
    expect(unassigned.hasWorker).toBe(false);
  });
});

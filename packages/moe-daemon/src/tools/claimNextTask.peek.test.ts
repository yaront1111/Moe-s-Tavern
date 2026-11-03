import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { claimNextTaskTool } from './claimNextTask.js';

// task-6cf09180 (hunt #11, item A): a claim_next_task that names no workerId
// assigns nothing and opens no attempt (a peek), so it must write nothing either:
// no metrics.firstClaimAt stamp (list_metrics wall-clock would start at the peek)
// and no #workers file-collision heads-up for a claim nobody made.
describe('claim_next_task peek (no workerId) writes nothing (task-6cf09180)', () => {
  const h = new ToolTestHarness();
  const events: string[] = [];

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    const step = (files: string[]) => [{ stepId: 'step-1', description: 'Edit', status: 'PENDING' as const, affectedFiles: files }];
    h.createTask({ id: 'task-a', status: 'WORKING', order: 1, implementationPlan: step(['src/shared.ts']) });
    h.createTask({ id: 'task-b', status: 'WORKING', order: 2, implementationPlan: step(['src/shared.ts']) });
    await h.state.load();
    events.length = 0;
    h.state.subscribe((e) => {
      events.push(e.type === 'MESSAGE_CREATED' ? `MESSAGE_CREATED:${(e.payload as { content?: string }).content}` : e.type);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const claim = async (args: Record<string, unknown>) =>
    await claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], ...args }, h.state) as Record<string, unknown>;

  it('(k1) a peek offers the same row and collision list but stamps nothing and posts nothing', async () => {
    const peek = await claim({});
    expect(peek).toMatchObject({ hasNext: true, task: { id: 'task-a', assignedWorkerId: null } });
    expect(peek.attemptId).toBeUndefined();
    expect(peek.fileCollision).toEqual([expect.objectContaining({ task: 'task-b' })]);
    expect(h.state.getTask('task-a')?.assignedWorkerId).toBeNull();
    expect(h.state.getTask('task-a')?.metrics?.firstClaimAt).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('(k2) a real claim still stamps firstClaimAt once and posts the collision heads-up once', async () => {
    const claimed = await claim({ workerId: 'worker-1' });
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-a', assignedWorkerId: 'worker-1' } });
    const stamped = h.state.getTask('task-a')?.metrics?.firstClaimAt;
    expect(typeof stamped).toBe('string');
    expect(events.filter((e) => e.startsWith('MESSAGE_CREATED:⚠️ file collision on task-a: task-b: `src/shared.ts`'))).toHaveLength(1);

    const resumed = await claim({ workerId: 'worker-1' });
    expect(resumed).toMatchObject({ hasNext: false });
    expect(h.state.getTask('task-a')?.metrics?.firstClaimAt).toBe(stamped);
  });
});

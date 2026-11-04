import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNextTaskTool } from './claimNextTask.js';
import { ToolTestHarness } from './toolTestHarness.js';

// task-4e2f2b45: claim_next_task's two hasNext:false wait_for_task hints must echo
// the VM-route marker exactly when the claim sent it (twin of waitForTask.ts routeArg).
describe('claim_next_task wait_for_task hints carry executionRoute', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  // What an MCP client receives: the JSON round trip, so an `executionRoute: undefined`
  // leak shows as a key mismatch under toStrictEqual.
  async function claim(params: Record<string, unknown>): Promise<{ hasNext: boolean; nextAction: { tool: string; args: unknown; reason: string } }> {
    const result = await claimNextTaskTool(h.state).handler(params, h.state);
    return JSON.parse(JSON.stringify(result));
  }

  describe('empty pool', () => {
    beforeEach(async () => {
      h.setupMoeFolder();
      h.createEpic();
      await h.state.load();
    });

    it('H1: marked claim -> hint args carry executionRoute vm', async () => {
      const r = await claim({ statuses: ['WORKING'], workerId: 'worker-a', executionRoute: 'vm' });
      expect(r.hasNext).toBe(false);
      expect(r.nextAction.tool).toBe('moe.wait_for_task');
      expect(r.nextAction.args).toStrictEqual({ statuses: ['WORKING'], workerId: 'worker-a', executionRoute: 'vm' });
    });

    it('H2: unmarked claim -> hint args have no executionRoute key', async () => {
      const r = await claim({ statuses: ['WORKING'], workerId: 'worker-a' });
      expect(r.nextAction.tool).toBe('moe.wait_for_task');
      expect(r.nextAction.args).toStrictEqual({ statuses: ['WORKING'], workerId: 'worker-a' });
    });

    it('H3: marked claim with epicId keeps epicId and adds executionRoute', async () => {
      const r = await claim({ statuses: ['WORKING'], workerId: 'worker-a', epicId: 'epic-x', executionRoute: 'vm' });
      expect(r.nextAction.args).toStrictEqual({
        statuses: ['WORKING'], workerId: 'worker-a', epicId: 'epic-x', executionRoute: 'vm'
      });
    });
  });

  describe('every candidate lost to a concurrent claim', () => {
    beforeEach(async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-free', status: 'WORKING', order: 1 });
      await h.state.load();
      // The winner is gone by the time we look again: the assignment write throws
      // without assigning anyone, so the loop continues and ends at the tail.
      const realUpdate = h.state.updateTask.bind(h.state);
      vi.spyOn(h.state, 'updateTask').mockImplementation(async (taskId, updates, event) => {
        if (taskId === 'task-free' && (updates as { assignedWorkerId?: string }).assignedWorkerId === 'worker-a') {
          throw new Error('Task already assigned to w-other');
        }
        return realUpdate(taskId, updates, event);
      });
    });

    it('H4: marked claim -> concurrent-loss hint carries executionRoute vm', async () => {
      const r = await claim({ statuses: ['WORKING'], workerId: 'worker-a', executionRoute: 'vm' });
      expect(r.hasNext).toBe(false);
      expect(r.nextAction.tool).toBe('moe.wait_for_task');
      expect(r.nextAction.reason).toContain('taken by concurrent workers');
      expect(r.nextAction.args).toStrictEqual({ statuses: ['WORKING'], workerId: 'worker-a', executionRoute: 'vm' });
    });

    it('H5: unmarked claim -> concurrent-loss hint has no executionRoute key', async () => {
      const r = await claim({ statuses: ['WORKING'], workerId: 'worker-a' });
      expect(r.hasNext).toBe(false);
      expect(r.nextAction.reason).toContain('taken by concurrent workers');
      expect(r.nextAction.args).toStrictEqual({ statuses: ['WORKING'], workerId: 'worker-a' });
    });
  });
});

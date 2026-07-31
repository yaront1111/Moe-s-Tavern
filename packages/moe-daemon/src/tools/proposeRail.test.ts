import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { proposeRailTool } from './proposeRail.js';

describe('moe.propose_rail', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: 'worker-1' });
    await h.state.load();
  });

  it('creates a rail proposal', async () => {
    const tool = proposeRailTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      proposalType: 'ADD_RAIL',
      targetScope: 'GLOBAL',
      proposedValue: 'always use async/await',
      reason: 'Improves readability',
    }, h.state) as { success: boolean; proposalId: string; status: string };

    expect(result.success).toBe(true);
    expect(result.proposalId).toMatch(/^prop-/);
    expect(result.status).toBe('PENDING');

    expect(h.state.proposals.size).toBe(1);
  });

  it('throws for non-existent task', async () => {
    const tool = proposeRailTool(h.state);
    await expect(
      tool.handler({
        taskId: 'nonexistent',
        proposalType: 'ADD_RAIL',
        targetScope: 'TASK',
        proposedValue: 'test',
        reason: 'test',
      }, h.state)
    ).rejects.toThrow('Task not found');
  });

  it('includes workerId from assigned task', async () => {
    const tool = proposeRailTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      proposalType: 'MODIFY_RAIL',
      targetScope: 'EPIC',
      currentValue: 'old value',
      proposedValue: 'new value',
      reason: 'Better approach',
    }, h.state);

    const proposal = Array.from(h.state.proposals.values())[0];
    expect(proposal.workerId).toBe('worker-1');
    expect(proposal.currentValue).toBe('old value');
  });
});


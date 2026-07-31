import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getActivityLogTool } from './getActivityLog.js';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from './submitPlan.js';

describe('moe.get_activity_log', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('returns empty array when no activity log exists', async () => {
    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({}, h.state) as { events: unknown[]; count: number };

    expect(result.events).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('returns events after task operations', async () => {
    // Creating a task generates activity log entries
    h.createTask({ id: 'task-log-1', status: 'BACKLOG' });
    await h.state.load();
    await h.state.updateTask('task-log-1', { status: 'PLANNING' });

    // Flush pending writes
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({}, h.state) as { events: Array<{ event: string }>; count: number };

    expect(result.count).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('returns epic lifecycle events newest-first when filtered by epicId', async () => {
    const epic = await h.state.createEpic({ title: 'Logged Epic', status: 'ACTIVE', order: 5 });
    await h.state.updateEpic(epic.id, { title: 'Logged Epic Updated', order: 6 });
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({
      epicId: epic.id,
      eventTypes: ['EPIC_CREATED', 'EPIC_UPDATED'],
      limit: 10,
      maxPayloadChars: 0,
    }, h.state) as {
      events: Array<{ event: string; epicId?: string; payload: Record<string, unknown> }>;
    };

    expect(result.events.map((event) => event.event)).toEqual(['EPIC_UPDATED', 'EPIC_CREATED']);
    expect(result.events.every((event) => event.epicId === epic.id)).toBe(true);
    expect(result.events[0].payload.title).toBe('Logged Epic Updated');
    expect(result.events[1].payload.status).toBe('ACTIVE');
  });

  it('filters by taskId', async () => {
    h.createTask({ id: 'task-a', status: 'BACKLOG' });
    h.createTask({ id: 'task-b', status: 'BACKLOG' });
    await h.state.load();
    await h.state.updateTask('task-a', { status: 'PLANNING' });
    await h.state.updateTask('task-b', { status: 'PLANNING' });
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({ taskId: 'task-a' }, h.state) as {
      events: Array<{ taskId?: string }>;
    };

    for (const event of result.events) {
      expect(event.taskId).toBe('task-a');
    }
  });

  it('filters by eventTypes', async () => {
    h.createTask({ id: 'task-evt', status: 'PLANNING' });
    await h.state.load();
    // Submit a plan to create PLAN_SUBMITTED event
    const submitTool = submitPlanTool(h.state);
    await submitTool.handler({
      taskId: 'task-evt',
      steps: [{ description: 'Test step' }],
    }, h.state);
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({ eventTypes: ['PLAN_SUBMITTED'] }, h.state) as {
      events: Array<{ event: string }>;
    };

    for (const event of result.events) {
      expect(event.event).toBe('PLAN_SUBMITTED');
    }
  });

  it('respects limit parameter', async () => {
    // Create multiple tasks to generate activity
    h.createTask({ id: 'task-l1', status: 'BACKLOG' });
    h.createTask({ id: 'task-l2', status: 'BACKLOG' });
    h.createTask({ id: 'task-l3', status: 'BACKLOG' });
    await h.state.load();
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({ limit: 2 }, h.state) as { events: unknown[]; count: number };

    expect(result.events.length).toBeLessThanOrEqual(2);
    expect(result.count).toBeLessThanOrEqual(2);
  });

  it('rejects invalid activity log numeric parameters', async () => {
    const tool = getActivityLogTool(h.state);

    await expect(tool.handler({ limit: Number.POSITIVE_INFINITY }, h.state)).rejects.toThrow('Invalid limit');
    await expect(tool.handler({ offset: -1 }, h.state)).rejects.toThrow('Invalid offset');
    await expect(tool.handler({ maxPayloadChars: Number.NaN }, h.state)).rejects.toThrow('Invalid maxPayloadChars');
  });

  it('caps default limit at 10 when none specified', async () => {
    // Create 15 status transitions to exceed the new default
    for (let i = 1; i <= 15; i++) {
      h.createTask({ id: `task-d${i}`, status: 'BACKLOG' });
    }
    await h.state.load();
    for (let i = 1; i <= 15; i++) {
      await h.state.updateTask(`task-d${i}`, { status: 'PLANNING' });
    }
    await h.state.flushActivityLog();

    const tool = getActivityLogTool(h.state);
    const result = await tool.handler({}, h.state) as { events: unknown[]; count: number };

    expect(result.events.length).toBeLessThanOrEqual(10);
    expect(result.count).toBeLessThanOrEqual(10);
  });

  it('throws if project not loaded', async () => {
    const freshState = new StateManager({ projectPath: h.testDir });
    const tool = getActivityLogTool(freshState);
    await expect(tool.handler({}, freshState)).rejects.toThrow('not loaded state, expected loaded');
  });
});


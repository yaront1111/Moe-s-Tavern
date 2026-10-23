import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskPriorityTool } from './setTaskPriority.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { getTools, toolsForRole } from './index.js';
import type { TeamRole } from '../types/schema.js';

interface SetPriorityResult {
  success: boolean;
  taskId: string;
  priority: string;
  previousPriority: string;
  changed: boolean;
  message: string;
}

describe('moe.set_task_priority', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function addRoleWorker(workerId: string, role: TeamRole): Promise<void> {
    await h.state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    let team = Array.from(h.state.teams.values()).find((t) => t.role === role);
    if (!team) team = await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, workerId);
  }

  async function setPriority(args: Record<string, unknown>): Promise<SetPriorityResult> {
    return await setTaskPriorityTool(h.state).handler(
      { taskId: 'task-1', workerId: 'governor-1', ...args }, h.state
    ) as SetPriorityResult;
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', order: 2 });
    h.createTask({ id: 'task-2', status: 'WORKING', order: 1 });
    await h.state.load();
    await addRoleWorker('governor-1', 'governor');
  });

  it('is registered, and only the governor sees it in tools/list', () => {
    const tools = getTools(h.state);
    expect(tools.map((t) => t.name)).toContain('moe.set_task_priority');
    const seen = (role: TeamRole) => toolsForRole(tools, role).some((t) => t.name === 'moe.set_task_priority');
    expect(seen('governor')).toBe(true);
    expect(seen('architect')).toBe(false);
    expect(seen('worker')).toBe(false);
    expect(seen('qa')).toBe(false);
  });

  it('sets the priority and reports what it replaced', async () => {
    const result = await setPriority({ priority: 'CRITICAL' });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.priority).toBe('CRITICAL');
    expect(result.previousPriority).toBe('MEDIUM');
    expect(h.state.getTask('task-1')!.priority).toBe('CRITICAL');
  });

  it('the raised task is the one the next claim takes', async () => {
    await addRoleWorker('worker-1', 'worker');
    const claim = async () => (await claimNextTaskTool(h.state).handler(
      { workerId: 'worker-1', statuses: ['WORKING'] }, h.state
    ) as { task?: { id: string } }).task?.id;

    // Equal priority: task-2 wins on order. Raised: task-1 wins.
    await setPriority({ priority: 'HIGH' });
    expect(await claim()).toBe('task-1');
  });

  it('setting the current priority again writes nothing', async () => {
    const before = h.state.getTask('task-1')!.updatedAt;
    const result = await setPriority({ priority: 'MEDIUM' });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(h.state.getTask('task-1')!.updatedAt).toBe(before);
    await h.state.flushActivityLog();
    expect(h.state.getActivityLog(100).some((e) => e.event === 'TASK_PRIORITY_SET')).toBe(false);
  });

  it('only a governor may change it; a governor-prefixed seat on a role-less team keeps its role', async () => {
    await addRoleWorker('architect-1', 'architect');
    await addRoleWorker('worker-9', 'worker');
    await expect(setPriority({ workerId: 'architect-1', priority: 'LOW' }))
      .rejects.toThrow(/governor role required/);
    await expect(setPriority({ workerId: 'worker-9', priority: 'LOW' }))
      .rejects.toThrow(/governor role required/);
    await expect(setPriority({ workerId: undefined, priority: 'LOW' }))
      .rejects.toThrow(/governor role required/);
    expect(h.state.getTask('task-1')!.priority).toBe('MEDIUM');

    await h.state.createWorker({
      id: 'governor-2', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    const roleless = await h.state.createTeam({ name: 'proj-test' });
    await h.state.addTeamMember(roleless.id, 'governor-2');
    const result = await setPriority({ workerId: 'governor-2', priority: 'LOW' });
    expect(result.priority).toBe('LOW');
  });

  it('rejects a missing or unknown priority and an unknown task, writing nothing', async () => {
    await expect(setPriority({ priority: undefined })).rejects.toThrow(/Missing required field: priority/);
    await expect(setPriority({ priority: 'URGENT' })).rejects.toThrow(/must be one of: CRITICAL, HIGH, MEDIUM, LOW/);
    await expect(setPriority({ priority: 'high' })).rejects.toThrow(/must be one of/);
    await expect(setPriority({ taskId: 'task-gone', priority: 'HIGH' })).rejects.toThrow(/not found|NOT_FOUND/i);
    expect(h.state.getTask('task-1')!.priority).toBe('MEDIUM');
  });

  it('records a TASK_PRIORITY_SET activity event naming the governor', async () => {
    await setPriority({ priority: 'LOW' });
    await h.state.flushActivityLog();
    const event = h.state.getActivityLog(100).find((e) => e.event === 'TASK_PRIORITY_SET');
    expect(event?.taskId).toBe('task-1');
    expect(event?.workerId).toBe('governor-1');
  });
});

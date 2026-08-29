import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskDependenciesTool } from './setTaskDependencies.js';
import { getTools } from './index.js';
import type { TeamRole } from '../types/schema.js';

interface SetDepsResult {
  success: boolean;
  taskId: string;
  dependsOn: string[];
  previousDependsOn: string[];
  dependsOnUnmet: number;
  message: string;
}

describe('moe.set_task_dependencies', () => {
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

  async function setDeps(args: Record<string, unknown>): Promise<SetDepsResult> {
    return await setTaskDependenciesTool(h.state).handler(
      { taskId: 'task-1', workerId: 'architect-1', ...args }, h.state
    ) as SetDepsResult;
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', dependsOn: ['task-old111'] as never });
    h.createTask({ id: 'task-old111', status: 'WORKING' });
    h.createTask({ id: 'task-dep111', status: 'WORKING' });
    h.createTask({ id: 'task-d0ne11', status: 'DONE' });
    await h.state.load();
    await addRoleWorker('architect-1', 'architect');
  });

  it('is registered in getTools()', () => {
    expect(getTools(h.state).map((t) => t.name)).toContain('moe.set_task_dependencies');
  });

  it('REPLACES the dependsOn array (not a union) and reports the unmet count', async () => {
    const result = await setDeps({ dependsOn: ['task-dep111', 'task-d0ne11', 'task-dep111'] });

    expect(result.success).toBe(true);
    expect(result.previousDependsOn).toEqual(['task-old111']);
    expect(result.dependsOn).toEqual(['task-dep111', 'task-d0ne11']);
    expect(result.dependsOnUnmet).toBe(1); // task-d0ne11 is DONE, task-dep111 is not
    expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-dep111', 'task-d0ne11']);
  });

  it('an empty array CLEARS the dependencies (the un-stick escape hatch)', async () => {
    const result = await setDeps({ dependsOn: [] });
    expect(result.dependsOn).toEqual([]);
    expect(result.dependsOnUnmet).toBe(0);
    expect(h.state.getTask('task-1')!.dependsOn).toEqual([]);
    expect(result.message).toContain('cleared');
  });

  it('governors may edit too; workers and the role-less may not', async () => {
    await addRoleWorker('governor-1', 'governor');
    await addRoleWorker('worker-9', 'worker');

    const asGovernor = await setDeps({ workerId: 'governor-1', dependsOn: ['task-dep111'] });
    expect(asGovernor.success).toBe(true);

    await expect(setDeps({ workerId: 'worker-9', dependsOn: [] }))
      .rejects.toThrow(/architect or governor role required/);
    await expect(setDeps({ workerId: undefined, dependsOn: [] }))
      .rejects.toThrow(/architect or governor role required/);
  });

  it('hard-validates ids: unknown ids and self-dependencies are errors, not silent drops', async () => {
    await expect(setDeps({ dependsOn: ['task-nope'] })).rejects.toThrow(/unknown task id: task-nope/);
    await expect(setDeps({ dependsOn: ['task-1'] })).rejects.toThrow(/cannot depend on itself/);
    await expect(setDeps({ dependsOn: 'task-dep111' })).rejects.toThrow(/must be an array/);
    await expect(setDeps({ dependsOn: [42] })).rejects.toThrow(/each entry must be a string/);
    await expect(setDeps({ taskId: 'task-gone', dependsOn: [] })).rejects.toThrow(/not found|NOT_FOUND/i);
    // Nothing landed through the failures.
    expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-old111']);
  });

  it('rejects a dependsOn that would close a cycle — through dependsOn or blockedOnTaskIds — naming the path', async () => {
    // task-1 already dependsOn [task-old111]: the reverse edge is a 2-cycle.
    await expect(setDeps({ taskId: 'task-old111', dependsOn: ['task-1'] }))
      .rejects.toThrow(/dependency cycle: task-old111 → task-1 → task-old111/);
    expect(h.state.getTask('task-old111')!.dependsOn ?? []).toEqual([]);

    // A blockedOnTaskIds edge counts too: task-dep111 is BLOCKED waiting on
    // task-1, so task-1 depending on task-dep111 would starve both forever.
    await h.state.updateTask('task-dep111', {
      status: 'BLOCKED', blockedReason: 'waits on task-1', blockedOnTaskIds: ['task-1'],
      blockedFromStatus: 'WORKING', blockedAt: new Date().toISOString(),
    });
    await expect(setDeps({ dependsOn: ['task-dep111'] }))
      .rejects.toThrow(/dependency cycle: task-1 → task-dep111 → task-1/);
    expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-old111']);

    // A longer loop is caught the same way: old111 → x → task-1 → old111.
    const x = await h.state.createTask({ epicId: 'epic-1', title: 'x', status: 'WORKING', dependsOn: ['task-1'] });
    await expect(setDeps({ taskId: 'task-old111', dependsOn: [x.id] }))
      .rejects.toThrow(`task-old111 → ${x.id} → task-1 → task-old111`);
  });

  it('a chain through a DONE/ARCHIVED node is not a live cycle (a satisfied prerequisite gates nothing)', async () => {
    // task-d0ne11 (DONE) declares dependsOn [task-1]; task-1 may still depend
    // on it — the edge is instantly satisfied, nothing can starve.
    await h.state.updateTask('task-d0ne11', { dependsOn: ['task-1'] });
    const result = await setDeps({ dependsOn: ['task-d0ne11'] });
    expect(result.success).toBe(true);
    expect(result.dependsOnUnmet).toBe(0);
  });

  it('records a TASK_DEPENDENCIES_SET activity event', async () => {
    await setDeps({ dependsOn: ['task-dep111'] });
    await h.state.flushActivityLog();
    const events = h.state.getActivityLog(100);
    expect(events.some((e) => e.event === 'TASK_DEPENDENCIES_SET' && e.taskId === 'task-1')).toBe(true);
  });
});

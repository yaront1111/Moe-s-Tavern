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
  added?: string[];
  removed?: string[];
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

  it('an architect-prefixed seat on a role-less team keeps its role (the 2026-09-04 SPIDR failure)', async () => {
    // The launcher registers every seat into a project-named team without a
    // role; the id prefix is the seat's declared kind and must still pass.
    await h.state.createWorker({
      id: 'architect-2', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    const roleless = await h.state.createTeam({ name: 'proj-test' });
    await h.state.addTeamMember(roleless.id, 'architect-2');
    expect(h.state.getTeamForWorker('architect-2')?.role ?? null).toBeNull();

    const result = await setDeps({ workerId: 'architect-2', dependsOn: ['task-dep111'] });
    expect(result.success).toBe(true);

    // A worker-prefixed seat on the same role-less team is still refused.
    await h.state.createWorker({
      id: 'worker-2', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    await h.state.addTeamMember(roleless.id, 'worker-2');
    await expect(setDeps({ workerId: 'worker-2', dependsOn: [] }))
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

  describe('addDependsOn / removeDependsOn (in-place edit)', () => {
    it('two seats registering on one row keep both ids (the read-then-replace race this mode removes)', async () => {
      // Both seats read [task-old111]. A read-then-replace by the second seat
      // would write [task-old111, task-d0ne11] and drop the first seat's id.
      const first = await setDeps({ addDependsOn: ['task-dep111'] });
      expect(first.added).toEqual(['task-dep111']);

      const second = await setDeps({ workerId: 'architect-1', addDependsOn: ['task-d0ne11'] });
      expect(second.previousDependsOn).toEqual(['task-old111', 'task-dep111']);
      expect(second.dependsOn).toEqual(['task-old111', 'task-dep111', 'task-d0ne11']);
      expect(second.added).toEqual(['task-d0ne11']);
      expect(second.removed).toEqual([]);
      expect(second.dependsOnUnmet).toBe(2);
      expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-old111', 'task-dep111', 'task-d0ne11']);
    });

    it('removeDependsOn drops listed ids and ignores ids that are not listed or not on the board', async () => {
      const result = await setDeps({ removeDependsOn: ['task-old111', 'task-gone99', 'task-dep111'] });
      expect(result.dependsOn).toEqual([]);
      expect(result.removed).toEqual(['task-old111']);
      expect(result.added).toEqual([]);
      expect(h.state.getTask('task-1')!.dependsOn).toEqual([]);
    });

    it('a prerequisite deleted from the board can still be removed', async () => {
      await h.state.updateTask('task-1', { dependsOn: ['task-old111', 'task-ghost1'] });
      const result = await setDeps({ removeDependsOn: ['task-ghost1'] });
      expect(result.dependsOn).toEqual(['task-old111']);
      expect(result.removed).toEqual(['task-ghost1']);
    });

    it('adds and removes in one call', async () => {
      const result = await setDeps({ addDependsOn: ['task-dep111'], removeDependsOn: ['task-old111'] });
      expect(result.dependsOn).toEqual(['task-dep111']);
      expect(result.added).toEqual(['task-dep111']);
      expect(result.removed).toEqual(['task-old111']);
      expect(result.message).toContain('Dependencies edited on task-1; 1 unmet (task-dep111)');
    });

    it('an edit that changes nothing writes nothing: no event, no chat line', async () => {
      const post = vi.spyOn(h.state, 'postSystemMessage');
      const update = vi.spyOn(h.state, 'updateTask');
      const result = await setDeps({ addDependsOn: ['task-old111', ' task-old111 '], removeDependsOn: ['task-dep111'] });
      expect(result.success).toBe(true);
      expect(result.dependsOn).toEqual(['task-old111']);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.dependsOnUnmet).toBe(1);
      expect(result.message).toContain('unchanged');
      expect(update).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      await h.state.flushActivityLog();
      expect(h.state.getActivityLog(100).some((e) => e.event === 'TASK_DEPENDENCIES_SET')).toBe(false);
    });

    it('records the delta in the chat line and the activity log', async () => {
      const post = vi.spyOn(h.state, 'postSystemMessage');
      await setDeps({ addDependsOn: ['task-dep111'], removeDependsOn: ['task-old111'] });
      expect(post).toHaveBeenCalledWith(
        'task-1',
        '🔗 architect-1 edited dependencies on task-1 (+[task-dep111] -[task-old111]): [task-dep111] (was [task-old111])'
      );
      await h.state.flushActivityLog();
      expect(h.state.getActivityLog(100).some((e) => e.event === 'TASK_DEPENDENCIES_SET' && e.taskId === 'task-1')).toBe(true);
    });

    it('refuses dependsOn combined with an edit, an id in both lists, and a call with neither mode', async () => {
      await expect(setDeps({ dependsOn: [], addDependsOn: ['task-dep111'] }))
        .rejects.toThrow(/either dependsOn .* or addDependsOn\/removeDependsOn/);
      await expect(setDeps({ addDependsOn: ['task-dep111'], removeDependsOn: ['task-dep111'] }))
        .rejects.toThrow(/ids in both addDependsOn and removeDependsOn: task-dep111/);
      await expect(setDeps({})).rejects.toThrow(/Missing required field: dependsOn \(or addDependsOn\/removeDependsOn\)/);
      await expect(setDeps({ addDependsOn: 'task-dep111' })).rejects.toThrow(/addDependsOn: must be an array/);
      await expect(setDeps({ removeDependsOn: [7] })).rejects.toThrow(/removeDependsOn: each entry must be a string/);
      expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-old111']);
    });

    it('added ids get the same hard validation as a replacement, and nothing is written on an error', async () => {
      await expect(setDeps({ addDependsOn: ['task-dep111', 'task-nope'] })).rejects.toThrow(/addDependsOn: unknown task id: task-nope/);
      await expect(setDeps({ addDependsOn: ['task-1'] })).rejects.toThrow(/cannot depend on itself/);
      await expect(setDeps({ taskId: 'task-old111', addDependsOn: ['task-1'] }))
        .rejects.toThrow(/dependency cycle: task-old111 → task-1 → task-old111/);
      await expect(setDeps({ workerId: undefined, addDependsOn: ['task-dep111'] }))
        .rejects.toThrow(/architect or governor role required/);
      expect(h.state.getTask('task-1')!.dependsOn).toEqual(['task-old111']);
      expect(h.state.getTask('task-old111')!.dependsOn ?? []).toEqual([]);
    });

    it('the 20-id cap applies to the edited list', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const t = await h.state.createTask({ epicId: 'epic-1', title: `dep ${i}`, status: 'WORKING' });
        ids.push(t.id);
      }
      await setDeps({ dependsOn: ids.slice(0, 19) });
      const atCap = await setDeps({ addDependsOn: [ids[19]] });
      expect(atCap.dependsOn).toHaveLength(20);
      await expect(setDeps({ addDependsOn: ['task-dep111'] })).rejects.toThrow(/too many ids \(21\); maximum 20/);
      expect(h.state.getTask('task-1')!.dependsOn).toHaveLength(20);
    });
  });
});

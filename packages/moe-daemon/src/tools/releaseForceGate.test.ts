import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { releaseTaskTool } from './releaseTask.js';
import { releaseResourceTool } from './releaseResource.js';
import { acquireResourceTool } from './acquireResource.js';
import type { ImplementationStep, StepStatus, TeamRole } from '../types/schema.js';
import type { MoeError } from '../util/errors.js';

// task-0adea941 (defect hunt #9, item a): `force` on release_task and
// release_resource is documented as the governor/human override, but neither
// handler resolved the caller's role, so any worker or QA seat could strip a
// live peer mid-step or drop every lease. A workerId-less call is the
// human/board path and keeps force.
describe('release_task / release_resource force is governor/human only', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  // The proxy injects only an absent workerId key; explicit invalid values
  // reach the handler unchanged because MCP arguments are not schema-validated.
  const malformedCallers: { label: string; workerId: unknown }[] = [
    { label: 'empty', workerId: '' },
    { label: 'null', workerId: null },
    { label: 'numeric', workerId: 123 },
    { label: 'zero', workerId: 0 },
    { label: 'false', workerId: false },
    { label: 'whitespace', workerId: ' \t ' },
    { label: 'object', workerId: {} },
    { label: 'array', workerId: [] },
  ];

  function step(stepId: string, status: StepStatus): ImplementationStep {
    return { stepId, description: stepId, status, affectedFiles: ['file.ts'] };
  }

  async function addRoleWorker(workerId: string, role: TeamRole, currentTaskId: string | null = null): Promise<void> {
    await h.state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId, status: currentTaskId ? 'CODING' : 'IDLE',
    });
    let team = Array.from(h.state.teams.values()).find((t) => t.role === role);
    if (!team) team = await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, workerId);
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-peer', status: 'WORKING', assignedWorkerId: 'worker-peer',
      implementationPlan: [step('step-1', 'IN_PROGRESS'), step('step-2', 'PENDING')],
    });
    h.createTask({
      id: 'task-idle', status: 'WORKING', assignedWorkerId: 'worker-peer2',
      implementationPlan: [step('step-1', 'COMPLETED'), step('step-2', 'PENDING')],
    });
    await h.state.load();
    await addRoleWorker('worker-peer', 'worker', 'task-peer');
    await addRoleWorker('worker-peer2', 'worker', 'task-idle');
    await addRoleWorker('worker-1', 'worker');
    await addRoleWorker('qa-1', 'qa');
    // governor-1 stays unregistered: its role comes from the id prefix.
  });

  const releaseTask = (args: Record<string, unknown>) => releaseTaskTool(h.state).handler(args, h.state);
  const releaseResource = (args: Record<string, unknown>) => releaseResourceTool(h.state).handler(args, h.state);
  const acquireGate = () => acquireResourceTool(h.state).handler(
    { resourceId: 'gate', taskId: 'task-peer', workerId: 'worker-peer' }, h.state
  );
  const holders = () => (h.state.getResource('gate')?.holders ?? []).map((l) => `${l.taskId}:${l.workerId}`);
  const snapshot = (taskId: string) => {
    const task = h.state.getTask(taskId)!;
    return [task.status, task.assignedWorkerId, task.implementationPlan[0].status];
  };
  const protectedState = () => {
    const { tasks, workers, resources } = h.state.getSnapshot();
    return structuredClone({ tasks, workers, resources });
  };

  it('(p1) documents release_task force as the governor/human override', () => {
    const schema = releaseTaskTool(h.state).inputSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.force.description).toMatch(/^Governor\/human crash-recovery override/);
  });

  it('(p2) refuses a worker seat forcing a live peer mid-step and writes nothing', async () => {
    await expect(releaseTask({ taskId: 'task-peer', force: true, workerId: 'worker-1', reason: 'mine now' }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(snapshot('task-peer')).toEqual(['WORKING', 'worker-peer', 'IN_PROGRESS']);
  });

  it('(p3) refuses a qa seat forcing a live peer mid-step', async () => {
    await expect(releaseTask({ taskId: 'task-peer', force: true, workerId: 'qa-1' }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(h.state.getTask('task-peer')!.assignedWorkerId).toBe('worker-peer');
  });

  it('(p4) refuses a qa seat forcing a peer row with no IN_PROGRESS step', async () => {
    await expect(releaseTask({ taskId: 'task-idle', force: true, workerId: 'qa-1' }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(h.state.getTask('task-idle')!.assignedWorkerId).toBe('worker-peer2');
  });

  it('(p5) lets a governor seat and a workerId-less caller force', async () => {
    const byGovernor = await releaseTask({ taskId: 'task-peer', force: true, workerId: 'governor-1' }) as { success: boolean };
    expect(byGovernor.success).toBe(true);
    expect(h.state.getTask('task-peer')!.assignedWorkerId).toBeNull();

    const byHuman = await releaseTask({ taskId: 'task-idle', force: true }) as { success: boolean };
    expect(byHuman.success).toBe(true);
    expect(h.state.getTask('task-idle')!.assignedWorkerId).toBeNull();
  });

  it('(p6) guard refusals name a governor or a human, never "pass force:true"', async () => {
    const notAssignee = await releaseTask({ taskId: 'task-peer', workerId: 'worker-1' })
      .catch((e: unknown) => e) as MoeError;
    expect(notAssignee.codeName).toBe('RELEASE_NOT_ASSIGNEE');

    const leaseHeld = await releaseTask({ taskId: 'task-peer' }).catch((e: unknown) => e) as MoeError;
    expect(leaseHeld.codeName).toBe('STEP_LEASE_HELD');

    for (const err of [notAssignee, leaseHeld]) {
      expect(err.message).not.toContain('pass force:true');
      expect(err.message).toContain('governor or a human');
    }
  });

  it.each(malformedCallers)('(p7) refuses force with a $label workerId before any task read', async ({ workerId }) => {
    await acquireGate();
    const before = protectedState();
    const read = vi.spyOn(h.state, 'getTask');
    const lock = vi.spyOn(h.state, 'runExclusive');
    const touch = vi.spyOn(h.state, 'touchWorker');
    const activity = vi.spyOn(h.state, 'appendActivity');
    for (const taskId of ['task-peer', 'task-idle', 'task-missing']) {
      await expect(releaseTask({ taskId, workerId, force: true }))
        .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    }
    expect(protectedState()).toEqual(before);
    for (const spy of [read, lock, touch, activity]) expect(spy).not.toHaveBeenCalled();
  });

  it('(r1) refuses a worker or qa seat forcing release_resource and releases nothing', async () => {
    await acquireGate();
    await expect(releaseResource({ resourceId: 'gate', workerId: 'worker-1', taskId: 'task-peer', force: true }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    await expect(releaseResource({ resourceId: 'gate', workerId: 'qa-1', force: true }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    // Args are not schema-validated and the store forces on any truthy value.
    await expect(releaseResource({ resourceId: 'gate', workerId: 'worker-1', force: 'true' }))
      .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(holders()).toEqual(['task-peer:worker-peer']);
  });

  it('(r2) lets a governor seat and a workerId-less caller force release_resource', async () => {
    await acquireGate();
    const byGovernor = await releaseResource({ resourceId: 'gate', workerId: 'governor-1', taskId: 'task-peer', force: true }) as { released: string[] };
    expect(byGovernor.released).toEqual(['task-peer']);

    await acquireGate();
    const byHuman = await releaseResource({ resourceId: 'gate', taskId: 'task-peer', force: true }) as { released: string[] };
    expect(byHuman.released).toEqual(['task-peer']);
    expect(holders()).toEqual([]);
  });

  it('(r3) keeps workerId required without force and the own-lease release unchanged', async () => {
    await expect(releaseResource({ resourceId: 'gate' }))
      .rejects.toMatchObject({ codeName: 'MISSING_REQUIRED' });

    await acquireGate();
    const own = await releaseResource({ resourceId: 'gate', workerId: 'worker-peer' }) as { released: string[] };
    expect(own.released).toEqual(['task-peer']);
  });

  it.each(malformedCallers)('(r4) refuses resource force with a $label workerId without writes', async ({ workerId }) => {
    await acquireGate();
    await acquireResourceTool(h.state).handler(
      { resourceId: 'gate', taskId: 'task-idle', workerId: 'worker-peer2' }, h.state
    );
    expect(h.state.getResource('gate')!.queue).toHaveLength(1);
    const before = protectedState();
    const read = vi.spyOn(h.state, 'getResource');
    const touch = vi.spyOn(h.state, 'touchWorker');
    const release = vi.spyOn(h.state, 'releaseResource');
    const activity = vi.spyOn(h.state, 'appendActivity');
    for (const force of [true, 'true', 1]) {
      for (const scope of [{}, { taskId: 'task-peer' }]) {
        await expect(releaseResource({ resourceId: 'gate', workerId, force, ...scope }))
          .rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
      }
    }
    expect(protectedState()).toEqual(before);
    for (const spy of [read, touch, release, activity]) expect(spy).not.toHaveBeenCalled();
  });

  it.each([{ label: 'omitted', workerId: undefined }, ...malformedCallers])(
    '(r5) requires a usable workerId without force ($label)', async ({ workerId }) => {
      const touch = vi.spyOn(h.state, 'touchWorker');
      await expect(releaseResource({ resourceId: 'gate', workerId }))
        .rejects.toMatchObject({ codeName: 'MISSING_REQUIRED' });
      expect(touch).not.toHaveBeenCalled();
    }
  );

  // task-c8d6dbd5: without force too, only an omitted workerId is the human/board
  // path. A supplied '' / null / non-string id bypassed proxy injection, so it is
  // refused before any read or write instead of being read as the human.
  it.each(malformedCallers)('(n1) refuses a $label workerId without force before any task read', async ({ workerId }) => {
    const before = protectedState();
    const read = vi.spyOn(h.state, 'getTask');
    const lock = vi.spyOn(h.state, 'runExclusive');
    const touch = vi.spyOn(h.state, 'touchWorker');
    const activity = vi.spyOn(h.state, 'appendActivity');
    for (const taskId of ['task-idle', 'task-peer', 'task-missing']) {
      await expect(releaseTask({ taskId, workerId, reason: 'not mine' }))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
    }
    expect(protectedState()).toEqual(before);
    for (const spy of [read, lock, touch, activity]) expect(spy).not.toHaveBeenCalled();
  });

  it('(n2) keeps the omitted-workerId release between steps and the holder\'s own release', async () => {
    const byHuman = await releaseTask({ taskId: 'task-idle', reason: 'board' });
    expect(byHuman).toMatchObject({ success: true, previousWorkerId: 'worker-peer2' });
    expect(h.state.getTask('task-idle')!.assignedWorkerId).toBeNull();

    const byHolder = await releaseTask({ taskId: 'task-peer', workerId: 'worker-peer' });
    expect(byHolder).toMatchObject({ success: true, previousWorkerId: 'worker-peer' });
    expect(h.state.getTask('task-peer')!.assignedWorkerId).toBeNull();
  });

  it('(n3) still refuses a well-formed non-holder id between steps (RELEASE_NOT_ASSIGNEE)', async () => {
    await expect(releaseTask({ taskId: 'task-idle', workerId: 'worker-1' }))
      .rejects.toMatchObject({ codeName: 'RELEASE_NOT_ASSIGNEE' });
    expect(snapshot('task-idle')).toEqual(['WORKING', 'worker-peer2', 'COMPLETED']);
  });
});

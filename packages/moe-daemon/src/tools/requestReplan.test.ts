import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { listAttempts } from '../state/attemptStore.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { requestReplanTool } from './requestReplan.js';
import type { TeamRole } from '../types/schema.js';

describe('moe.request_replan seat hand-back', () => {
  const h = new ToolTestHarness();
  const plan = [{ stepId: 'step-1', description: 'do it', status: 'PENDING' as const, affectedFiles: [] }];
  const reason = 'step 1 names a file that does not exist';

  beforeEach(async () => {
    vi.stubEnv('MOE_WORKER_ID', ''); vi.stubEnv('MOE_TASK_ID', '');
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createTask({ id: 'task-a', status: 'WORKING', implementationPlan: plan, order: 1 });
    h.createTask({ id: 'task-b', status: 'WORKING', implementationPlan: plan, order: 2 });
    h.createWorker({ id: 'worker-1', status: 'IDLE' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.state.clearEmitter(); vi.unstubAllEnvs();
    h.cleanup();
  });

  async function onTeam(workerId: string, role: TeamRole): Promise<void> {
    if (!h.state.getWorker(workerId)) {
      await h.state.createWorker({ id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: '', currentTaskId: null, status: 'IDLE' });
    }
    let team = Array.from(h.state.teams.values()).find((t) => t.role === role);
    if (!team) team = await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, workerId);
  }
  const replan = (args: Record<string, unknown>) =>
    requestReplanTool(h.state).handler({ taskId: 'task-a', reason, ...args }, h.state) as Promise<Record<string, unknown>>;

  it('(r1) the assignee gets END_SESSION and no claim/wait hint; the row still ends PLANNING, unassigned, attempt closed', async () => {
    await claimNextTaskTool(h.state).handler({ workerId: 'worker-1', statuses: ['WORKING'], taskId: 'task-a' }, h.state);
    const res = await replan({ workerId: 'worker-1' });

    expect(res.nextAction).toBeUndefined();
    expect(res.sessionHandoff).toMatchObject({ action: 'END_SESSION', taskId: 'task-a', workerId: 'worker-1' });
    expect((res.sessionHandoff as { reason: string }).reason).toContain('Do not call moe.claim_next_task or moe.wait_for_task');
    expect(h.state.getTask('task-a')).toMatchObject({ status: 'PLANNING', assignedWorkerId: null, priorAttempt: { reason } });
    expect(h.state.getTask('task-a')!.priorAttempt!.implementationPlan).toHaveLength(1);
    const attempts = listAttempts(h.state).filter((a) => a.taskId === 'task-a');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.phase === 'closed')).toBe(true);
    expect(h.state.getWorker('worker-1')).toMatchObject({ status: 'IDLE', currentTaskId: null });
  });

  it.each([
    ['governor-1', true],
    ['governor-2', false],
  ] as const)('(r2) a governor (%s, governor team %s) replanning an unassigned row gets no handoff and keeps GOVERNING', async (gov, team) => {
    if (team) await onTeam(gov, 'governor');
    else await h.state.createWorker({ id: gov, type: 'CLAUDE', projectId: 'proj-test', epicId: '', currentTaskId: null, status: 'IDLE' });
    await h.state.updateWorker(gov, { status: 'GOVERNING' });

    const res = await replan({ workerId: gov });

    expect(res.sessionHandoff).toBeUndefined();
    expect(res.nextAction).toBeUndefined();
    expect(h.state.getWorker(gov)).toMatchObject({ status: 'GOVERNING' });
    expect(h.state.getTask('task-a')).toMatchObject({ status: 'PLANNING', assignedWorkerId: null });
  });

  it('(r3) a dangling assignment: the seat now codes another task, so no handoff and its pointer is left alone', async () => {
    await h.state.updateTask('task-a', { assignedWorkerId: 'worker-1' });
    await h.state.updateWorker('worker-1', { currentTaskId: 'task-b', status: 'CODING' });

    const res = await replan({ workerId: 'worker-1' });

    expect(res.sessionHandoff).toBeUndefined();
    expect(h.state.getWorker('worker-1')).toMatchObject({ currentTaskId: 'task-b', status: 'CODING' });
    expect(h.state.getTask('task-a')).toMatchObject({ status: 'PLANNING', assignedWorkerId: null });
  });

  it('(r4) a non-governor seat whose own row already lost its assignment still gets END_SESSION addressed to itself', async () => {
    const res = await replan({ workerId: 'worker-1' });

    expect(res.sessionHandoff).toMatchObject({ action: 'END_SESSION', taskId: 'task-a', workerId: 'worker-1' });
    expect(res.nextAction).toBeUndefined();
  });
});

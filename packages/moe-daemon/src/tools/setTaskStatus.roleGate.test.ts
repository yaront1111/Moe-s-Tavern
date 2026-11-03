import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import type { TeamRole } from '../types/schema.js';

// set_task_status is the architect / governor / human lever (TOOL_AUDIENCE
// [A], archive_task's holder refusal, governor.md). TOOL_AUDIENCE only filters
// tools/list, so the handler itself must refuse every other seat.
describe('moe.set_task_status role gate', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => h.cleanup());

  async function seat(id: string, role: TeamRole): Promise<void> {
    await h.state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE' });
    const team = Array.from(h.state.teams.values()).find((t) => t.role === role)
      ?? await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, id);
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    // worker-1's own row, handed to QA and now under review.
    h.createTask({ id: 'task-review', status: 'REVIEW', assignedWorkerId: 'qa-reviewer' });
    // A live peer mid-step.
    h.createTask({
      id: 'task-peer', status: 'WORKING', assignedWorkerId: 'worker-peer',
      implementationPlan: [{ stepId: 'step-1', description: 'do it', status: 'IN_PROGRESS', affectedFiles: ['file.ts'] } as never],
    });
    // A row another architect holds (archive_task refuses non-holders here).
    h.createTask({ id: 'task-plan', status: 'PLANNING', assignedWorkerId: 'architect-peer' });
    await h.state.load();
    await seat('worker-1', 'worker');
    await seat('qa-1', 'qa');
    await seat('seat-arch', 'architect');
  });

  const move = (taskId: string, status: string, workerId?: unknown) =>
    setTaskStatusTool(h.state).handler(
      workerId === undefined ? { taskId, status } : { taskId, status, workerId }, h.state
    ) as Promise<{ success: boolean; status: string }>;

  it.each([
    ['(r1) a worker seat moving its own REVIEW row to DONE', 'worker-1', 'task-review', 'DONE'],
    ['(r2) a qa seat moving a peer-held WORKING row to BACKLOG', 'qa-1', 'task-peer', 'BACKLOG'],
    ['(r3) a worker seat archiving a held PLANNING row', 'worker-1', 'task-plan', 'ARCHIVED'],
    ['(r4) an empty workerId', '', 'task-review', 'DONE'],
    ['(r5) a null workerId', null, 'task-review', 'DONE'],
    ['(r6) an unregistered id that declares no role', 'seat-x', 'task-review', 'DONE'],
    ['(r7) a worker seat naming an unknown task', 'worker-1', 'task-missing', 'DONE'],
  ])('%s is refused with NOT_ALLOWED and writes nothing', async (_label, workerId, taskId, status) => {
    const before = structuredClone(h.state.getTask(taskId));
    await expect(move(taskId, status, workerId)).rejects.toMatchObject({
      codeName: 'NOT_ALLOWED',
      message: expect.stringContaining('architect or governor role required'),
    });
    expect(h.state.getTask(taskId)).toEqual(before);
  });

  it('(d1) names the audience and the refusal route in the description and the refusal', async () => {
    const { description } = setTaskStatusTool(h.state);
    expect(description.startsWith('Architect/governor/human:')).toBe(true);
    expect(description).toContain('NOT_ALLOWED');
    expect(description).toContain('ask a governor');
    await expect(move('task-review', 'DONE', 'worker-1')).rejects.toMatchObject({
      message: expect.stringContaining('ask a governor in #governors'),
    });
  });

  it('(r8) keeps the refused rows exactly where they were', async () => {
    await move('task-review', 'DONE', 'worker-1').catch(() => undefined);
    await move('task-peer', 'BACKLOG', 'qa-1').catch(() => undefined);
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-reviewer' });
    expect(h.state.getTask('task-peer')).toMatchObject({ status: 'WORKING', assignedWorkerId: 'worker-peer' });
  });

  it.each([
    ['(a1) a governor-prefixed seat', 'governor-1'],
    ['(a2) an architect-team seat', 'seat-arch'],
    ['(a3) a workerId-less (human) call', undefined],
  ])('%s moves REVIEW to DONE and PLANNING to ARCHIVED', async (_label, workerId) => {
    await expect(move('task-review', 'DONE', workerId)).resolves.toMatchObject({ success: true, status: 'DONE' });
    await expect(move('task-plan', 'ARCHIVED', workerId)).resolves.toMatchObject({ success: true, status: 'ARCHIVED' });
    expect(h.state.getTask('task-review')!.status).toBe('DONE');
    expect(h.state.getTask('task-plan')!.status).toBe('ARCHIVED');
  });
});

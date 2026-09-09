import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/schema.js';
import { getContextTool } from './getContext.js';
import { ToolTestHarness } from './toolTestHarness.js';

type NextAction = { tool: string; args: Record<string, unknown>; recommendedSkill?: unknown };

describe('get_context governance guidance', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.unstubAllEnvs(); h.cleanup(); });

  const cases: Array<{ status: Task['status']; completed: boolean }> = [
    { status: 'PLANNING', completed: false },
    { status: 'WORKING', completed: false },
    { status: 'WORKING', completed: true },
    { status: 'REVIEW', completed: true },
    { status: 'BLOCKED', completed: false },
    { status: 'DONE', completed: true },
    { status: 'BACKLOG', completed: false },
    { status: 'AWAITING_APPROVAL', completed: false },
    { status: 'ARCHIVED', completed: true },
  ];

  it.each(cases)('keeps governor in chat on $status (completed=$completed)', async ({ status, completed }) => {
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: 'architect-oversight', status: 'GOVERNING' });
    h.createWorker({ id: 'worker-owner', currentTaskId: 'task-1' });
    h.createTask({ status, assignedWorkerId: 'worker-owner', implementationPlan: [
      { stepId: 'step-1', description: 'Owned work', status: completed ? 'COMPLETED' : 'PENDING' },
    ] });
    await h.state.load();
    const team = await h.state.createTeam({ name: 'Governors', role: 'governor' });
    await h.state.addTeamMember(team.id, 'architect-oversight');
    const before = h.state.getTask('task-1')!;

    const result = await getContextTool(h.state).handler({
      taskId: 'task-1', workerId: 'architect-oversight',
    }, h.state) as { nextAction: NextAction };

    expect(result.nextAction).toMatchObject({
      tool: 'moe.chat_wait', args: { workerId: 'architect-oversight', timeoutMs: 300000 },
    });
    expect(result.nextAction.recommendedSkill).toBeUndefined();
    expect(result.nextAction.args).not.toHaveProperty('taskId');
    const channelIds = result.nextAction.args.channels as string[];
    expect(channelIds).toHaveLength(5);
    expect(h.state.getChannels().filter(c => channelIds.includes(c.id)).map(c => c.name).sort())
      .toEqual(['architects', 'general', 'governors', 'qa', 'workers']);
    const after = h.state.getTask('task-1')!;
    expect(after.assignedWorkerId).toBe(before.assignedWorkerId);
    expect(after.status).toBe(before.status);
    expect(after.implementationPlan).toEqual(before.implementationPlan);
    expect(h.state.getWorker('architect-oversight')?.status).toBe('GOVERNING');
  });

  it('guides a taskless governor and respects the existing environment caller fallback', async () => {
    h.setupMoeFolder();
    h.createWorker({ id: 'governor-context', status: 'GOVERNING' });
    await h.state.load();
    vi.stubEnv('MOE_WORKER_ID', 'governor-context');
    vi.stubEnv('MOE_TASK_ID', '');
    const result = await getContextTool(h.state).handler({}, h.state) as { task: null; nextAction: NextAction };
    expect(result.task).toBeNull();
    expect(result.nextAction).toMatchObject({ tool: 'moe.chat_wait', args: { workerId: 'governor-context' } });
  });

  it('lets an explicit QA team override a governor-shaped id without changing QA guidance', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: 'governor-now-qa' });
    h.createTask({ status: 'REVIEW', assignedWorkerId: 'governor-now-qa' });
    await h.state.load();
    const team = await h.state.createTeam({ name: 'QA', role: 'qa' });
    await h.state.addTeamMember(team.id, 'governor-now-qa');
    const result = await getContextTool(h.state).handler({
      taskId: 'task-1', workerId: 'governor-now-qa',
    }, h.state) as { nextAction: NextAction };
    expect(result.nextAction.tool).toBe('moe.qa_approve');
    expect(result.nextAction.recommendedSkill).toMatchObject({ name: 'moe-qa-loop' });
  });

  it.each([
    { workerId: 'architect-planner', status: 'PLANNING' as const, completed: false, tool: 'moe.submit_plan' },
    { workerId: 'worker-builder', status: 'WORKING' as const, completed: false, tool: 'moe.start_step' },
    { workerId: 'worker-finisher', status: 'WORKING' as const, completed: true, tool: 'moe.complete_task' },
  ])('retains $tool guidance for $workerId', async ({ workerId, status, completed, tool }) => {
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: workerId });
    h.createTask({ status, assignedWorkerId: workerId, implementationPlan: [
      { stepId: 'step-1', description: 'Owned work', status: completed ? 'COMPLETED' : 'PENDING' },
    ] });
    await h.state.load();
    const result = await getContextTool(h.state).handler({ taskId: 'task-1', workerId }, h.state) as { nextAction: NextAction };
    expect(result.nextAction).toMatchObject({ tool, args: { taskId: 'task-1', workerId } });
    expect(result.nextAction.recommendedSkill).toBeDefined();
  });

  it('omits an empty channel filter so a governor still receives messages in degraded state', async () => {
    h.setupMoeFolder();
    h.createWorker({ id: 'governor-context' });
    await h.state.load();
    h.state.channels.clear();
    const result = await getContextTool(h.state).handler({ workerId: 'governor-context' }, h.state) as { nextAction: NextAction };
    expect(result.nextAction.tool).toBe('moe.chat_wait');
    expect(result.nextAction.args.channels).toBeUndefined();
  });
});

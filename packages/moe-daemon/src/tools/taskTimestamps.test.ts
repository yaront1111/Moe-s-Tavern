import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { getContextTool } from './getContext.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { startStepTool } from './startStep.js';
import { submitPlanTool } from './submitPlan.js';
import type { Task } from '../types/schema.js';

describe('Task timestamps', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('submitPlan sets planSubmittedAt', async () => {
    h.createTask({ status: 'PLANNING' });
    await h.state.load();

    const tool = submitPlanTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      steps: [{ description: 'Step 1' }],
    }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.planSubmittedAt).toBeDefined();
    expect(new Date(task!.planSubmittedAt!).getTime()).not.toBeNaN();
  });

  it('manual approval sets planApprovedAt', async () => {
    h.createTask({ status: 'AWAITING_APPROVAL', implementationPlan: [
      { stepId: 'step-1', description: 'Step', status: 'PENDING', affectedFiles: [] }
    ]});
    await h.state.load();

    await h.state.approveTask('task-1');

    const task = h.state.getTask('task-1');
    expect(task?.planApprovedAt).toBeDefined();
    expect(task?.status).toBe('WORKING');
  });

  it('first startStep sets workStartedAt but second does not overwrite', async () => {
    h.createTask({
      status: 'WORKING',
      implementationPlan: [
        { stepId: 'step-1', description: 'First', status: 'PENDING', affectedFiles: [] },
        { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await h.state.load();

    const tool = startStepTool(h.state);
    await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, h.state);

    const taskAfterFirst = h.state.getTask('task-1');
    const firstTimestamp = taskAfterFirst?.workStartedAt;
    expect(firstTimestamp).toBeDefined();

    // Complete first step so second can start
    const completeTool = completeStepTool(h.state);
    await completeTool.handler({ taskId: 'task-1', stepId: 'step-1' }, h.state);

    // Start second step
    await tool.handler({ taskId: 'task-1', stepId: 'step-2' }, h.state);

    const taskAfterSecond = h.state.getTask('task-1');
    expect(taskAfterSecond?.workStartedAt).toBe(firstTimestamp);
  });

  it('completeTask sets reviewStartedAt but NOT completedAt (completedAt means DONE)', async () => {
    h.createTask({
      status: 'WORKING',
      implementationPlan: [
        { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: [] },
      ],
    });
    await h.state.load();

    const tool = completeTaskTool(h.state);
    await tool.handler({ taskId: 'task-1', verification: { command: 'npm test', exitCode: 0 } }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.reviewStartedAt).toBeDefined();
    // completedAt is now stamped at DONE (qa_approve), not at REVIEW entry.
    expect(task?.completedAt).toBeUndefined();
    expect(task?.status).toBe('REVIEW');
  });

  it('qaApprove sets completedAt and reviewCompletedAt at DONE', async () => {
    h.createTask({ status: 'REVIEW' });
    await h.state.load();

    const tool = qaApproveTool(h.state);
    await tool.handler({ taskId: 'task-1', summary: 'verified DoD; re-ran verification command green' }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.completedAt).toBeDefined();
    expect(task?.reviewCompletedAt).toBeDefined();
    expect(task?.status).toBe('DONE');
  });

  it('qaReject sets reviewCompletedAt', async () => {
    h.createTask({ status: 'REVIEW' });
    await h.state.load();

    const tool = qaRejectTool(h.state);
    await tool.handler({ taskId: 'task-1', reason: 'Needs work' }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.reviewCompletedAt).toBeDefined();
    expect(task?.status).toBe('WORKING');
  });

  it('getContext exposes timestamps', async () => {
    const now = new Date().toISOString();
    h.createTask({
      status: 'WORKING',
      planSubmittedAt: now,
      planApprovedAt: now,
      workStartedAt: now,
    } as Partial<Task>);
    await h.state.load();

    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      task: {
        planSubmittedAt: string | null;
        planApprovedAt: string | null;
        workStartedAt: string | null;
        completedAt: string | null;
        reviewStartedAt: string | null;
        reviewCompletedAt: string | null;
      };
    };

    expect(result.task.planSubmittedAt).toBe(now);
    expect(result.task.planApprovedAt).toBe(now);
    expect(result.task.workStartedAt).toBe(now);
    expect(result.task.completedAt).toBeNull();
    expect(result.task.reviewStartedAt).toBeNull();
    expect(result.task.reviewCompletedAt).toBeNull();
  });
});


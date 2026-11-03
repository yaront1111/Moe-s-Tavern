import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { completeStepTool } from './completeStep.js';
import { declareFilesTool } from './declareFiles.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { submitPlanTool } from './submitPlan.js';
import { sanitizeImplementationPlan } from '../state/validators.js';
import { MAX_STEP_FILES } from '../util/planSize.js';
import { MoeErrorCode } from '../util/errors.js';

// complete_step's modifiedFiles is the ASSERTED tier the wrapper commits from.
// The plan sanitizer bounds every per-step file list at MAX_STEP_FILES, so the
// tool must refuse more up front (as submit_plan and the note cap do) instead
// of storing a list the next write cuts.
describe('moe.complete_step modifiedFiles bound', () => {
  const h = new ToolTestHarness();
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/gen/file${String(i + 1).padStart(3, '0')}.ts`);

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createTask({
      id: 'task-w', status: 'WORKING', assignedWorkerId: 'worker-1', contextFetchedBy: ['worker-1'],
      implementationPlan: [{ stepId: 'step-1', description: 'regenerate fixtures', status: 'IN_PROGRESS', affectedFiles: [] }],
    });
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-w' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const complete = (modifiedFiles: string[]) => completeStepTool(h.state).handler(
    { taskId: 'task-w', stepId: 'step-1', workerId: 'worker-1', modifiedFiles }, h.state) as Promise<Record<string, unknown>>;
  const asserted = async () => (await getCommitScopeTool(h.state).handler(
    { taskId: 'task-w', workerId: 'worker-1' }, h.state) as { asserted: string[] }).asserted;

  it('the bound is 50', () => {
    expect(MAX_STEP_FILES).toBe(50);
  });

  it(`stores and asserts all ${MAX_STEP_FILES} paths at the bound, with no warning`, async () => {
    const reported = paths(MAX_STEP_FILES);
    const res = await complete(reported);
    expect(res.success).toBe(true);
    expect(res.warning).toBeUndefined();
    const step = h.state.getTask('task-w')!.implementationPlan[0];
    expect(step.status).toBe('COMPLETED');
    expect(step.modifiedFiles).toEqual(reported);
    const a = await asserted();
    expect(reported.filter((p) => !a.includes(p))).toEqual([]);
  });

  it(`refuses ${MAX_STEP_FILES + 10} paths with INVALID_INPUT before any write and names the escape`, async () => {
    const before = JSON.stringify(h.state.getTask('task-w'));
    await expect(complete(paths(MAX_STEP_FILES + 10))).rejects.toMatchObject({
      code: MoeErrorCode.INVALID_INPUT,
      message: expect.stringMatching(new RegExp(`too many paths \\(${MAX_STEP_FILES + 10}\\)[\\s\\S]*${MAX_STEP_FILES}[\\s\\S]*moe\\.declare_files`)),
    });
    expect(JSON.stringify(h.state.getTask('task-w'))).toBe(before);
    expect(h.state.getTask('task-w')!.implementationPlan[0].status).toBe('IN_PROGRESS');
  });

  it('the escape keeps every path asserted: declare_files the rest, then complete with the bound', async () => {
    const reported = paths(MAX_STEP_FILES + 10);
    await declareFilesTool(h.state).handler({ taskId: 'task-w', workerId: 'worker-1', paths: reported }, h.state);
    await complete(reported.slice(0, MAX_STEP_FILES));
    const a = await asserted();
    expect(reported.filter((p) => !a.includes(p))).toEqual([]);
  });

  it('submit_plan and the plan sanitizer use the same bound', async () => {
    h.createTask({ id: 'task-p', status: 'PLANNING', assignedWorkerId: 'architect-a1' });
    h.createWorker({ id: 'architect-a1', status: 'PLANNING', currentTaskId: 'task-p' });
    await h.state.load();
    await expect(submitPlanTool(h.state).handler({
      taskId: 'task-p', workerId: 'architect-a1',
      steps: [{ description: 'regen', affectedFiles: paths(MAX_STEP_FILES + 1) }],
    }, h.state)).rejects.toThrow(`too many affected files (max ${MAX_STEP_FILES})`);
    const [step] = sanitizeImplementationPlan([{
      stepId: 's', description: 'd', status: 'COMPLETED',
      affectedFiles: paths(MAX_STEP_FILES + 1), newFiles: paths(MAX_STEP_FILES + 1), modifiedFiles: paths(MAX_STEP_FILES + 1),
    }]);
    expect([step.affectedFiles.length, step.newFiles?.length, step.modifiedFiles?.length])
      .toEqual([MAX_STEP_FILES, MAX_STEP_FILES, MAX_STEP_FILES]);
  });
});

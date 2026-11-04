// complete_step normalizes modifiedFiles exactly as declare_files and
// submit_plan do (task-1cb559b7). (p1)-(p5) and (n1) fail on the pre-fix
// completeStep.ts; (c1)/(c2) pin today's accepted shapes and warning.
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { completeStepTool } from './completeStep.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';

describe('complete_step modifiedFiles path shape', () => {
  const h = new ToolTestHarness();
  const taskFile = () => path.join(h.moePath, 'tasks', 'task-w.json');

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createTask({
      id: 'task-w', status: 'WORKING', assignedWorkerId: 'worker-1', contextFetchedBy: ['worker-1'],
      implementationPlan: [{ stepId: 'step-1', description: 'add helper', status: 'IN_PROGRESS', affectedFiles: ['src/planned.ts'] }],
    });
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-w' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const complete = (modifiedFiles: unknown, note?: string) => completeStepTool(h.state).handler(
    { taskId: 'task-w', stepId: 'step-1', workerId: 'worker-1', modifiedFiles, ...(note ? { note } : {}) }, h.state
  ) as Promise<{ warning?: string }>;
  const asserted = async () => (await getCommitScopeTool(h.state).handler(
    { taskId: 'task-w', workerId: 'worker-1' }, h.state) as { asserted: string[] }).asserted;
  const step = () => h.state.getTask('task-w')!.implementationPlan[0];

  const refused: Array<[string, string, () => unknown]> = [
    ['p1', 'an absolute path', () => [`${h.testDir}/src/x.ts`]],
    ['p2', 'a traversing path', () => ['../x.ts']],
    ['p3', 'a drive-letter path', () => ['C:\\x.ts']],
    ['p4', 'a non-string entry', () => [{ path: 'a.ts' }]],
    ['p5', 'a bare string', () => 'src/a.ts'],
  ];
  it.each(refused)('(%s) refuses %s with INVALID_INPUT and writes nothing', async (_id, _what, value) => {
    const before = fs.readFileSync(taskFile(), 'utf8');
    const err = await complete(value(), 'should not be stored').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_INPUT);
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(before);
    expect(step().status).toBe('IN_PROGRESS');
    expect(step().note).toBeUndefined();
    expect(h.state.getTask('task-w')!.stepsCompleted ?? []).toEqual([]);
  });

  it('(n1) stores the normalized, deduplicated list, and get_commit_scope asserts both paths', async () => {
    await complete(['./src/a.ts', 'src\\b.ts', 'src/a.ts']);
    expect(step().modifiedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(await asserted()).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('(c1) control: a plain project-relative list is stored as given, with no warning', async () => {
    const out = await complete(['src/ok.ts']);
    expect(out.warning).toBeUndefined();
    expect(step().modifiedFiles).toEqual(['src/ok.ts']);
  });

  it('(c2) control: an omitted list keeps the fallback warning and stores nothing', async () => {
    const out = await complete(undefined);
    expect(out.warning).toMatch(/fell back to the step's affectedFiles \(1 path\(s\)\)/);
    expect(step().modifiedFiles).toBeUndefined();
    expect(await asserted()).toEqual(expect.arrayContaining(['src/planned.ts']));
  });
});

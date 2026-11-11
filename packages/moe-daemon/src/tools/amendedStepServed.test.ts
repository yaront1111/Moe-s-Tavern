// Every response that hands plan steps to a seat must carry the step's effective
// (amended) text as `description`, never the text moe.amend_plan_step superseded.
// Served raw, a reader of implementationPlan[].description followed the original
// while the text in force sat nested in `amendments` (seen live 2026-11-11 on
// task-ba678d95, read through moe.search_tasks detail:'full').
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImplementationStep } from '../types/schema.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { getTools } from './index.js';

type ServedStep = ImplementationStep & { originalDescription?: string };

const step = (stepId: string, description: string) =>
  ({ stepId, description, status: 'PENDING', affectedFiles: [`src/${stepId}.ts`] }) as ImplementationStep;

describe('an amended step is served with its effective text', () => {
  const h = new ToolTestHarness();
  beforeEach(() => { h.init(); h.setupMoeFolder(); h.createEpic(); });
  afterEach(() => h.cleanup());

  const original = 'Rename the cache module';
  const amended = 'Keep the cache module; add a failing test for the TTL option first';

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = getTools(h.state).find((t) => t.name === name)!;
    return await tool.handler(args, h.state) as Record<string, unknown>;
  };
  const seedAmended = async () => {
    h.createWorker({ id: 'worker-1', currentTaskId: 'task-1', status: 'CODING' });
    // contextFetchedBy: start_step refuses a worker that never read get_context.
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-1', contextFetchedBy: ['worker-1'],
      implementationPlan: [step('step-1', original), step('step-2', 'Second step')],
    });
    await h.state.load();
    await call('moe.amend_plan_step', {
      taskId: 'task-1', stepId: 'step-1', workerId: 'architect-1', description: amended, reason: 'the importer still uses it',
    });
  };
  const expectServed = (plan: ServedStep[]) => {
    expect(plan[0].description).toBe(amended);
    expect(plan[0].originalDescription).toBe(original);
    expect(plan[0].activeAmendmentId).toBe('amend-1');
    expect(plan[0].amendments?.map((a) => a.description)).toEqual([amended]);
    // An unamended step is served exactly as stored.
    expect(plan[1].description).toBe('Second step');
    expect(plan[1]).not.toHaveProperty('originalDescription');
    // Serving never rewrites the stored row.
    expect(h.state.getTask('task-1')!.implementationPlan[0].description).toBe(original);
  };

  it('moe.get_context', async () => {
    await seedAmended();
    const ctx = await call('moe.get_context', { taskId: 'task-1', workerId: 'worker-1' });
    expectServed((ctx.task as { implementationPlan: ServedStep[] }).implementationPlan);
  });

  it("moe.search_tasks detail:'full'", async () => {
    await seedAmended();
    const res = await call('moe.search_tasks', { detail: 'full' });
    const [task] = res.tasks as Array<{ id: string; implementationPlan: ServedStep[] }>;
    expect(task.id).toBe('task-1');
    expectServed(task.implementationPlan);
  });

  it("moe.start_step's skill recommendation reads the amended text", async () => {
    // The original names no test, so it would get implementation_step; the amendment does.
    await seedAmended();
    const res = await call('moe.start_step', { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
    const next = res.nextAction as { recommendedSkill?: unknown };
    expect(next.recommendedSkill).toEqual(recommendSkillFor('worker', 'test_step'));
    expect(next.recommendedSkill).not.toEqual(recommendSkillFor('worker', 'implementation_step'));
  });
});

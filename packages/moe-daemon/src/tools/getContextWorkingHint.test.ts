// get_context's nextAction on a WORKING task must name a call the daemon accepts for
// the assignee: complete_step for an IN_PROGRESS step (start_step is PENDING-only),
// request_replan for a plan-less row (complete_task and every step tool refuse it),
// and the step's effective (amended) text, never the superseded original.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImplementationStep } from '../types/schema.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { getTools } from './index.js';

type Hint = {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  recommendedSkill?: unknown;
};

const step = (stepId: string, description: string, status: ImplementationStep['status'] = 'PENDING') =>
  ({ stepId, description, status, affectedFiles: [`src/${stepId}.ts`] }) as ImplementationStep;

describe('get_context WORKING nextAction', () => {
  const h = new ToolTestHarness();
  beforeEach(() => { h.init(); h.setupMoeFolder(); h.createEpic(); });
  afterEach(() => h.cleanup());

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = getTools(h.state).find((t) => t.name === name)!;
    return await tool.handler(args, h.state) as Record<string, unknown>;
  };
  const hintFor = async (): Promise<Hint> => {
    const ctx = await call('moe.get_context', { taskId: 'task-1', workerId: 'worker-1' });
    return ctx.nextAction as Hint;
  };
  const seedWorking = async (plan: ImplementationStep[], reopenCount = 0) => {
    h.createWorker({ id: 'worker-1', currentTaskId: 'task-1', status: 'CODING' });
    // contextFetchedBy: start_step refuses a worker that never read get_context.
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: plan, reopenCount,
      contextFetchedBy: ['worker-1'],
    });
    await h.state.load();
  };
  const amend = (stepId: string, description: string) => call('moe.amend_plan_step', {
    taskId: 'task-1', stepId, workerId: 'architect-1', description, reason: 'the importer still uses it',
  });

  describe('an IN_PROGRESS step', () => {
    beforeEach(() => seedWorking([step('step-1', 'First step'), step('step-2', 'Second step')]));

    it('is hinted moe.complete_step, and following the hint verbatim completes it', async () => {
      await call('moe.start_step', { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
      expect(h.state.getTask('task-1')!.implementationPlan[0].status).toBe('IN_PROGRESS');

      const hint = await hintFor();
      expect(hint.tool).toBe('moe.complete_step');
      expect(hint.args).toEqual({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
      expect(hint.reason.startsWith('Finish in-progress step step-1: First step')).toBe(true);
      // A mid-plan step carries no phase skill.
      expect(hint.recommendedSkill).toBeUndefined();

      await call(hint.tool, hint.args);
      expect(h.state.getTask('task-1')!.implementationPlan[0].status).toBe('COMPLETED');
    });

    it('hints the first unfinished step in plan order even when a later one is the IN_PROGRESS one', async () => {
      // Started out of order: step-2 IN_PROGRESS, step-1 still PENDING. The first
      // PENDING-or-IN_PROGRESS step is step-1, so the hint is start_step for it.
      await call('moe.start_step', { taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' });
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.start_step');
      expect(hint.args).toEqual({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
    });
  });

  describe('an IN_PROGRESS last step', () => {
    it('carries the final_step skill', async () => {
      await seedWorking([step('step-1', 'First step', 'COMPLETED'), step('step-2', 'Last step')]);
      await call('moe.start_step', { taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' });
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.complete_step');
      expect(hint.recommendedSkill).toEqual(recommendSkillFor('worker', 'final_step'));
      expect(hint.recommendedSkill).toBeDefined();
    });

    it('lets the reopened skill win on a reopened row', async () => {
      await seedWorking([step('step-1', 'First step', 'COMPLETED'), step('step-2', 'Last step')], 1);
      await call('moe.start_step', { taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' });
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.complete_step');
      expect(hint.recommendedSkill).toEqual(recommendSkillFor('worker', 'reopened'));
      expect(hint.recommendedSkill).toBeDefined();
    });
  });

  describe('a plan-less WORKING row', () => {
    it('is hinted moe.request_replan, never moe.complete_task, and the hint is accepted verbatim', async () => {
      h.createTask({ status: 'BACKLOG', implementationPlan: [] });
      await h.state.load();
      // Human path (no workerId): BACKLOG -> WORKING is a legal set_task_status move.
      await call('moe.set_task_status', { taskId: 'task-1', status: 'WORKING' });
      await call('moe.claim_next_task', { statuses: ['WORKING'], workerId: 'worker-1' });
      expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-1');

      const hint = await hintFor();
      expect(hint.tool).toBe('moe.request_replan');
      expect(hint.tool).not.toBe('moe.complete_task');
      expect(hint.args).toMatchObject({ taskId: 'task-1', workerId: 'worker-1' });
      expect(typeof hint.args.reason).toBe('string');
      expect((hint.args.reason as string).trim().length).toBeGreaterThan(0);
      expect(hint.recommendedSkill).toBeUndefined();

      await call(hint.tool, hint.args);
      expect(h.state.getTask('task-1')!.status).toBe('PLANNING');
    });
  });

  describe('an amended step', () => {
    const original = 'Delete the legacy cache module';
    const amended = 'Keep the cache module; only add a TTL option';

    it('quotes the amendment in a PENDING step hint', async () => {
      await seedWorking([step('step-1', original)]);
      await amend('step-1', amended);
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.start_step');
      expect(hint.reason).toBe(`Begin step: ${amended}`);
    });

    it('quotes the amendment, not the original, in an IN_PROGRESS step hint', async () => {
      await seedWorking([step('step-1', original)]);
      await call('moe.start_step', { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
      await amend('step-1', amended);
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.complete_step');
      expect(hint.reason).toContain(amended);
      expect(hint.reason).not.toContain(original);
    });
  });

  describe('plans that keep their hints', () => {
    it('hints a fresh PENDING plan moe.start_step with the first_start_step skill', async () => {
      await seedWorking([step('step-1', 'First step'), step('step-2', 'Second step')]);
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.start_step');
      expect(hint.args).toEqual({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' });
      expect(hint.reason).toBe('Begin step: First step');
      expect(hint.recommendedSkill).toEqual(recommendSkillFor('worker', 'first_start_step'));
    });

    it('hints a later PENDING step with the implementation_step skill', async () => {
      await seedWorking([step('step-1', 'First step', 'COMPLETED'), step('step-2', 'Second step')]);
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.start_step');
      expect(hint.args).toEqual({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' });
      expect(hint.recommendedSkill).toEqual(recommendSkillFor('worker', 'implementation_step'));
    });

    it('hints an all-COMPLETED plan moe.complete_task', async () => {
      await seedWorking([step('step-1', 'First step', 'COMPLETED')]);
      const hint = await hintFor();
      expect(hint.tool).toBe('moe.complete_task');
      expect(hint.args).toEqual({ taskId: 'task-1', workerId: 'worker-1' });
      expect(hint.reason).toBe('All steps complete; hand task off to QA.');
      expect(hint.recommendedSkill).toEqual(recommendSkillFor('worker', 'before_complete_task'));
    });
  });
});

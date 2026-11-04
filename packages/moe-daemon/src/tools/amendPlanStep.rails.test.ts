// amend_plan_step applies submit_plan's rail check to the plan it would leave
// behind (task-2cc41d1a; hunt 11-03 #10 repro zzHunt49a2_amendRails, ported as
// (c1)-(a2)). Reading: an amendment is refused only for a violation it
// INTRODUCES; a violation the plan already had does not block it (a4, a5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { submitPlanTool } from './submitPlan.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { effectiveStepDescription } from '../util/planAmendments.js';
import { MoeError } from '../util/errors.js';

const msg = (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 80)}` : 'no error');

describe('amend_plan_step rails', () => {
  const h = new ToolTestHarness();
  const step = (stepId: string, description: string) =>
    ({ stepId, description, status: 'PENDING', affectedFiles: ['file.ts'] }) as never;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({
      globalRails: {
        techStack: [], forbiddenPatterns: ['rm -rf', 'drop database'], requiredPatterns: ['error handling'],
        formatting: '', testing: '', customRules: [],
      },
    });
    h.createEpic();
    h.createTask({ id: 'task-plan', status: 'PLANNING', assignedWorkerId: 'architect-1' });
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: [step('step-1', 'Build the parser with error handling')] as never });
    // Approved before the required rail existed: the plan already lacks it.
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: 'worker-2', implementationPlan: [step('step-1', 'Build the parser')] as never });
    // Already carries a forbidden pattern in another step.
    h.createTask({
      id: 'task-3', status: 'WORKING', assignedWorkerId: 'worker-3',
      implementationPlan: [step('step-1', 'Build the parser with error handling'), step('step-2', 'Clean with rm -rf build')] as never,
    });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const amend = (taskId: string, stepId: string, description: string) =>
    amendPlanStepTool(h.state).handler({ taskId, stepId, workerId: 'architect-1', description, reason: 'tighten the step' }, h.state)
      .catch((e: unknown) => e);
  const effective = (taskId: string, stepId: string) =>
    effectiveStepDescription(h.state.getTask(taskId)!.implementationPlan.find((s) => s.stepId === stepId)!);

  it('(c1) control: submit_plan refuses a step that carries a forbidden pattern', async () => {
    const err = await submitPlanTool(h.state).handler({
      taskId: 'task-plan', workerId: 'architect-1',
      steps: [{ description: 'Clean with rm -rf build, with error handling', affectedFiles: ['file.ts'] }],
    }, h.state).catch((e: unknown) => e);
    expect(msg(err)).toContain('Rail violation');
  });

  it('(a1) refuses a replacement that carries a forbidden pattern, and writes nothing', async () => {
    expect(msg(await amend('task-1', 'step-1', 'Clean with rm -rf build, with error handling'))).toContain('Rail violation');
    expect(effective('task-1', 'step-1')).toBe('Build the parser with error handling');
  });

  it('(a2) refuses a replacement that drops the plan\'s only required phrase, and writes nothing', async () => {
    expect(msg(await amend('task-1', 'step-1', 'Build the parser'))).toContain('Rail violation');
    expect(effective('task-1', 'step-1')).toBe('Build the parser with error handling');
  });

  it('(a3) a compliant replacement is accepted as before', async () => {
    const res = await amend('task-1', 'step-1', 'Build the parser faster, with error handling') as Record<string, unknown>;
    expect(res).toMatchObject({ success: true, stepId: 'step-1', effectiveDescription: 'Build the parser faster, with error handling' });
    expect(effective('task-1', 'step-1')).toBe('Build the parser faster, with error handling');
  });

  it('(a4) a required phrase the plan already lacked does not block an amendment', async () => {
    const res = await amend('task-2', 'step-1', 'Build the parser quickly') as Record<string, unknown>;
    expect(res).toMatchObject({ success: true });
    expect(effective('task-2', 'step-1')).toBe('Build the parser quickly');
  });

  it('(a5) a forbidden pattern elsewhere in the plan does not block an amendment, but a new one is refused by its own name', async () => {
    expect(await amend('task-3', 'step-1', 'Build the parser carefully, with error handling')).toMatchObject({ success: true });
    const err = await amend('task-3', 'step-1', 'Drop database tables first, with error handling');
    expect(err).toBeInstanceOf(MoeError);
    expect((err as Error).message).toContain('Rail violation: "Forbidden pattern: drop database"');
    expect((err as Error).message).not.toContain('rm -rf');
    expect(effective('task-3', 'step-1')).toBe('Build the parser carefully, with error handling');
  });

  it('(a6) the refusal is submit_plan\'s coded CONSTRAINT_VIOLATION naming amend_plan_step, and nothing is written', async () => {
    const file = path.join(h.moePath, 'tasks', 'task-1.json');
    const bytes = fs.readFileSync(file, 'utf8');
    const revision = h.state.getTask('task-1')!.planRevision;
    const events: string[] = [];
    const off = h.state.subscribe((e) => { events.push(e.type); });
    let err: unknown;
    try {
      err = await amend('task-1', 'step-1', 'Clean with rm -rf build, with error handling');
    } finally {
      off();
    }
    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).codeName).toBe('CONSTRAINT_VIOLATION');
    expect((err as Error).message).toContain(
      'Rail violation: "Forbidden pattern: rm -rf". Default action: revise the replacement text to satisfy this rail and call moe.amend_plan_step again.'
    );
    expect((err as Error).message).toContain('moe.propose_rail');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(h.state.getTask('task-1')!.planRevision).toBe(revision);
    expect(events).toEqual([]);
  });
});

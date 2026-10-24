// Held-out behavioral contracts: implementation owners may enable their groups,
// but must not weaken the assertions to match the pre-CQ revision semantics.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ImplementationStep, StepAmendment, Task } from '../types/schema.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { startStepTool } from '../tools/startStep.js';
import { completeStepTool } from '../tools/completeStep.js';
import { clearAllSpeedModeTimeouts, submitPlanTool } from '../tools/submitPlan.js';

const REVISION = 7;
const WORKER = 'worker-approval-acceptance';
const TASK = 'task-1';
const h = new ToolTestHarness();
const amendment: StepAmendment = {
  amendmentId: 'amend-1', description: 'Preserve the caller while reusing the helper',
  reason: 'Clarify compatibility', amendedBy: 'architect-original', amendedAt: '2026-10-24T00:00:00Z',
};
const steps = (): ImplementationStep[] => [
  { stepId: 'step-1', description: 'Reuse the existing helper', status: 'PENDING', affectedFiles: ['file.ts'] },
  { stepId: 'step-2', description: 'Cover the caller behavior', status: 'PENDING', affectedFiles: ['caller.test.ts'] },
];

async function boot(overrides: Partial<Task> = {}, mode: 'CONTROL' | 'SPEED' = 'CONTROL'): Promise<void> {
  h.setupMoeFolder({ settings: {
    approvalMode: mode, speedModeDelayMs: 50, autoCreateBranch: false,
    branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
  } });
  h.createEpic();
  h.createWorker({ id: WORKER, currentTaskId: TASK, status: 'CODING' });
  h.createTask({ id: TASK, status: 'WORKING', assignedWorkerId: WORKER,
    contextFetchedBy: [WORKER], planRevision: REVISION, implementationPlan: steps(), ...overrides });
  await h.state.load();
}

function task(): Task {
  const current = h.state.getTask(TASK);
  if (!current) throw new Error('Acceptance fixture task disappeared');
  return structuredClone(current);
}

function bytes(): string {
  return fs.readFileSync(path.join(h.moePath, 'tasks', `${TASK}.json`), 'utf8');
}

async function update(updates: Partial<Task>): Promise<Task> {
  return h.state.runExclusive(() => h.state.updateTask(TASK, updates));
}

async function changeFirst(change: (step: ImplementationStep) => ImplementationStep): Promise<Task> {
  const plan = task().implementationPlan;
  plan[0] = change(plan[0]);
  return update({ implementationPlan: plan });
}

function expectRevision(expected: number): void {
  expect(task().planRevision).toBe(expected);
  expect((JSON.parse(bytes()) as Task).planRevision).toBe(expected);
}

beforeEach(() => h.init());
afterEach(() => {
  clearAllSpeedModeTimeouts();
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.cleanup();
});

// Owner CQ-F02: enable after canonical approval-only revision comparison lands.
// RED against pre-CQ production: all ten cases received revision 8, expected 7.
describe('CQ-F02: execution and audit metadata preserve the approved revision', () => {
  it.each<[string, Partial<ImplementationStep>]>([
    ['step status', { status: 'IN_PROGRESS' }],
    ['start timestamp', { startedAt: '2026-10-24T00:01:00Z' }],
    ['completion timestamp', { completedAt: '2026-10-24T00:02:00Z' }],
    ['reported modified files', { modifiedFiles: ['file.ts', 'caller.test.ts'] }],
    ['progress note', { note: 'Focused behavior check passed — שלום 漢字' }],
  ])('%s does not invalidate the plan', async (_label, fields) => {
    await boot();
    await changeFirst(step => ({ ...step, ...fields }));
    expectRevision(REVISION);
    expect(task().implementationPlan[0]).toMatchObject(fields);
  });

  it('the actual start_step path preserves the approved revision', async () => {
    await boot();
    await h.state.runExclusive(() => startStepTool(h.state).handler({
      taskId: TASK, stepId: 'step-1', workerId: WORKER,
    }, h.state));
    expect(task().implementationPlan[0].status).toBe('IN_PROGRESS');
    expect(task().implementationPlan[0].startedAt).toEqual(expect.any(String));
    expectRevision(REVISION);
  });

  it('the actual complete_step path preserves revision while persisting progress', async () => {
    const plan = steps();
    plan[0] = { ...plan[0], status: 'IN_PROGRESS', startedAt: '2026-10-24T00:01:00Z' };
    await boot({ implementationPlan: plan });
    await h.state.runExclusive(() => completeStepTool(h.state).handler({
      taskId: TASK, stepId: 'step-1', workerId: WORKER,
      modifiedFiles: ['file.ts'], note: 'Caller behavior remains compatible',
    }, h.state));
    expect(task().implementationPlan[0]).toMatchObject({
      status: 'COMPLETED', modifiedFiles: ['file.ts'], note: 'Caller behavior remains compatible',
    });
    expect(task().stepsCompleted).toEqual(['step-1']);
    expectRevision(REVISION);
  });

  it('amendment audit metadata does not revise unchanged active instructions', async () => {
    const plan = steps();
    plan[0] = { ...plan[0], amendments: [{ ...amendment }], activeAmendmentId: amendment.amendmentId };
    await boot({ implementationPlan: plan });
    await changeFirst(step => ({ ...step, amendments: [{ ...amendment,
      reason: 'Corrected explanation', amendedBy: 'architect-audit', amendedAt: '2026-10-24T00:03:00Z',
    }] }));
    expectRevision(REVISION);
    expect(task().implementationPlan[0].amendments?.[0].reason).toBe('Corrected explanation');
  });

  it('inactive amendment history does not change the current behavioral contract', async () => {
    await boot();
    await changeFirst(step => ({ ...step, amendments: [{ ...amendment }] }));
    expect(task().implementationPlan[0].description).toBe('Reuse the existing helper');
    expectRevision(REVISION);
  });

  it('reopening clears execution evidence without revising unchanged instructions', async () => {
    const plan = steps().map(step => ({ ...step, status: 'COMPLETED' as const,
      completedAt: '2026-10-24T00:02:00Z', modifiedFiles: ['file.ts'], note: 'Previously checked' }));
    await boot({ status: 'REVIEW', implementationPlan: plan });
    await h.state.runExclusive(() => h.state.reopenTask(TASK, 'Rerun the approved behavior checks'));
    expect(task().implementationPlan.map(step => step.status)).toEqual(['PENDING', 'PENDING']);
    expect(task().implementationPlan[0].completedAt).toBeUndefined();
    expectRevision(REVISION);
  });
});

describe('approval-relevant material changes and legacy controls', () => {
  it.each<[string, (plan: ImplementationStep[]) => ImplementationStep[]]>([
    ['original instructions', plan => [{ ...plan[0], description: 'Preserve a different caller contract' }, plan[1]]],
    ['approved file scope', plan => [{ ...plan[0], affectedFiles: ['file.ts', 'consumer.ts'] }, plan[1]]],
    ['approved new files', plan => [{ ...plan[0], newFiles: ['new-consumer.ts'] }, plan[1]]],
    ['step identity', plan => [{ ...plan[0], stepId: 'replacement-step' }, plan[1]]],
    ['step order', plan => [plan[1], plan[0]]],
    ['effective instructions', plan => [{ ...plan[0], amendments: [{ ...amendment }],
      activeAmendmentId: amendment.amendmentId }, plan[1]]],
  ])('%s advances revision exactly once', async (_label, change) => {
    await boot();
    const changed = change(task().implementationPlan);
    await update({ implementationPlan: changed });
    expect(task().implementationPlan).toEqual(changed);
    expectRevision(REVISION + 1);
  });

  it('editing the active replacement text revises even when its amendment id stays fixed', async () => {
    const plan = steps();
    plan[0] = { ...plan[0], amendments: [{ ...amendment }], activeAmendmentId: amendment.amendmentId };
    await boot({ implementationPlan: plan });
    await changeFirst(step => ({ ...step, amendments: [{ ...amendment, description: 'A changed active requirement' }] }));
    expectRevision(REVISION + 1);
  });

  it('original instructions remain approval-relevant while an active override is unchanged', async () => {
    const plan = steps();
    plan[0] = { ...plan[0], amendments: [{ ...amendment }], activeAmendmentId: amendment.amendmentId };
    await boot({ implementationPlan: plan });
    await changeFirst(step => ({ ...step, description: 'Changed original plan instructions' }));
    expect(task().implementationPlan[0].amendments?.[0].description).toBe(amendment.description);
    expectRevision(REVISION + 1);
  });

  it('DoD and plan changes in one durable write advance exactly once', async () => {
    await boot();
    const plan = task().implementationPlan;
    plan[0].description = 'Implement the changed acceptance criteria';
    await update({ implementationPlan: plan, definitionOfDone: ['New consumer behavior is verified'] });
    expect(task().definitionOfDone).toEqual(['New consumer behavior is verified']);
    expect(task().implementationPlan).toEqual(plan);
    expectRevision(REVISION + 1);
  });

  it('metadata-only task updates do not invalidate approval', async () => {
    await boot();
    await update({ title: 'Clarified title', priority: 'HIGH', completionSummary: 'Recorded progress' });
    expectRevision(REVISION);
  });

  it('caller-supplied revisions cannot forge or reset daemon authority', async () => {
    await boot();
    await update({ planRevision: 999 });
    expectRevision(REVISION);
    await update({ planRevision: 0, definitionOfDone: ['A genuinely changed criterion'] });
    expectRevision(REVISION + 1);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '7'])(
    'malformed stored revision %j fails closed without changing durable bytes', async malformed => {
      await boot({ planRevision: malformed as unknown as number });
      const before = bytes();
      const beforeTask = task();
      await expect(update({ title: 'Must not persist' })).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
      expect(bytes()).toBe(before);
      expect(task()).toEqual(beforeTask);
    },
  );

  it('revision exhaustion refuses a material update without partial persistence', async () => {
    await boot({ planRevision: Number.MAX_SAFE_INTEGER });
    const before = bytes();
    const beforeTask = task();
    await expect(update({ definitionOfDone: ['Changed criterion'] }))
      .rejects.toMatchObject({ codeName: 'PLAN_REVISION_EXHAUSTED' });
    expect(bytes()).toBe(before);
    expect(task()).toEqual(beforeTask);
  });

  it('legacy missing revision remains effective zero for explicit approval', async () => {
    await boot({ status: 'AWAITING_APPROVAL', assignedWorkerId: null, planRevision: undefined });
    expect(task().planRevision).toBeUndefined();
    await h.state.runExclusive(() => h.state.approveTask(TASK, 0));
    expect(task().status).toBe('WORKING');
    expectRevision(0);
  });

  it('a stale explicit approval cannot approve a newer material revision', async () => {
    await boot({ status: 'AWAITING_APPROVAL', assignedWorkerId: null });
    await update({ definitionOfDone: ['Changed before the reviewer clicked'] });
    const before = bytes();
    await expect(h.state.runExclusive(() => h.state.approveTask(TASK, REVISION)))
      .rejects.toMatchObject({ codeName: 'PLAN_REVISION_MISMATCH' });
    expect(task().status).toBe('AWAITING_APPROVAL');
    expect(bytes()).toBe(before);
  });
});

async function scheduleSpeedApproval(): Promise<void> {
  await boot({ status: 'PLANNING', assignedWorkerId: null }, 'SPEED');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.state.runExclusive(() => submitPlanTool(h.state).handler({
    taskId: TASK, steps: [{ description: 'Preserve the approved caller behavior', affectedFiles: ['file.ts'] }],
  }, h.state));
  expect(task().status).toBe('AWAITING_APPROVAL');
  expectRevision(REVISION + 1);
}

async function settleSpeedApproval(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  // Timer callbacks await filesystem writes under the mutex. Waiting behind
  // that callback avoids accepting an assertion before its write settles.
  await h.state.runExclusive(async () => {});
}

// Owner CQ-F05: enable after delayed approval compares its captured revision.
// RED against pre-CQ production: received WORKING, expected AWAITING_APPROVAL.
describe.skip('CQ-F05: delayed approval is bound to the submitted revision', () => {
  it('a pending SPEED timer cannot approve criteria changed after submission', async () => {
    await scheduleSpeedApproval();
    await update({ definitionOfDone: ['A newer behavioral requirement needs approval'] });
    await settleSpeedApproval();
    expect(task().status).toBe('AWAITING_APPROVAL');
    expect(task().planApprovedAt).toBeUndefined();
    expectRevision(REVISION + 2);
  });
});

it('a SPEED timer still approves its original revision after metadata-only updates', async () => {
  await scheduleSpeedApproval();
  await update({ priority: 'HIGH' });
  await settleSpeedApproval();
  expect(task().status).toBe('WORKING');
  expect(task().planApprovedAt).toEqual(expect.any(String));
  expectRevision(REVISION + 1);
});

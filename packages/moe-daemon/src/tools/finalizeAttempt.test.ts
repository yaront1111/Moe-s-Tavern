// =============================================================================
// moe.finalize_attempt — the runner's acknowledgement of the artifact boundary
// =============================================================================
//
// complete_task hands a task to QA but leaves its attempt OPEN in `finalizing`,
// because the bytes are only landed after the session exits and the wrapper
// commits them. THIS tool is what closes that boundary, and closing it is what
// lifts the finalizing hold on both the worker's next claim and qa_approve.
//
// The qa_approve hold cases live in this file on purpose: the hold and the tool
// that releases it are one feature, and this task's verification command names
// this file.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { finalizeAttemptTool } from './finalizeAttempt.js';
import { qaApproveTool } from './qaApprove.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { getTools } from './index.js';
import { openAttempt, setAttemptPhase, listAttempts } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
import { UNLANDED_REASONS, type ExecutionWorkspaceMode } from '../types/schema.js';
import { vi } from 'vitest';
import { getContextTool } from './getContext.js';

/** A deterministic 40-hex revision; no randomness in any assertion. */
const LANDED = 'b2'.repeat(20);

/** Await a call that MUST be refused and hand back the exact MoeError. */
async function refusal(call: Promise<unknown>): Promise<MoeError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof MoeError) return err;
    throw err;
  }
  throw new Error('expected a MoeError refusal, but the call resolved');
}

describe('moe.finalize_attempt', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    // task-1 is the just-completed row (complete_task cleared its assignment on
    // the WORKING->REVIEW handoff); task-2 is the next piece of work.
    h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: null });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: null, order: 2 });
    await h.state.load();
  });

  afterEach(() => h.cleanup());

  function finalize(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return finalizeAttemptTool(h.state).handler(args, h.state) as Promise<Record<string, unknown>>;
  }

  /** The state complete_task leaves behind: one attempt held in `finalizing`. */
  async function finalizingAttempt(
    taskId = 'task-1',
    workerId = 'worker-1'
  ): Promise<{ id: string; generation: number }> {
    const opened = await openAttempt(h.state, {
      taskId, workerId, runnerId: 'runner-pilot', workspace: h.testDir,
    });
    const held = await setAttemptPhase(h.state, opened.id, 'finalizing');
    return { id: held.id, generation: held.generation };
  }

  function attemptFile(attemptId: string): string {
    return path.join(h.moePath, 'attempts', `${attemptId}.json`);
  }

  function phaseOf(attemptId: string): string {
    return h.state.attempts.get(attemptId)!.phase;
  }

  function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: 'task-1',
      workerId: 'worker-1',
      runnerId: 'runner-pilot',
      outcome: 'landed',
      landedRevision: LANDED,
      ...over,
    };
  }

  // --- registration (task rail: an unregistered tool is invisible to MCP) ----

  it('is registered in getTools() exactly once under its exact name', () => {
    const matches = getTools(h.state).filter((t) => t.name === 'moe.finalize_attempt');
    expect(matches.length).toBe(1);
  });

  it('is not marked blocking, so it never parks the shared state mutex', () => {
    expect(finalizeAttemptTool(h.state).blocking).toBeUndefined();
  });

  // --- the happy path -------------------------------------------------------

  it('moves a finalizing attempt to closed and echoes the reported landing', async () => {
    const held = await finalizingAttempt();

    const result = await finalize(payload({ attemptId: held.id, generation: held.generation }));

    expect(result.attemptId).toBe(held.id);
    expect(result.taskId).toBe('task-1');
    expect(result.generation).toBe(held.generation);
    expect(result.phase).toBe('closed');
    expect(result.outcome).toBe('landed');
    expect(result.landedRevision).toBe(LANDED);
    expect(phaseOf(held.id)).toBe('closed');
    expect(JSON.parse(fs.readFileSync(attemptFile(held.id), 'utf8')).phase).toBe('closed');
  });

  it('records no landing fields on the attempt — the receipt slice owns those', async () => {
    const held = await finalizingAttempt();

    await finalize(payload({ attemptId: held.id, generation: held.generation }));

    const stored = JSON.parse(fs.readFileSync(attemptFile(held.id), 'utf8')) as Record<string, unknown>;
    expect(stored.outcome).toBeUndefined();
    expect(stored.landedRevision).toBeUndefined();
    expect(Object.keys(stored).sort()).toEqual(
      ['generation', 'id', 'lastPhaseAt', 'phase', 'runnerId', 'startedAt', 'taskId', 'workerId', 'workspace']
    );
  });

  // --- idempotency: a retry after a lost response writes nothing -------------

  it('is a byte-identical no-op when the same call is repeated', async () => {
    const held = await finalizingAttempt();
    const args = payload({ attemptId: held.id, generation: held.generation });

    const first = await finalize({ ...args });
    const bytesAfterFirst = fs.readFileSync(attemptFile(held.id), 'utf8');
    const second = await finalize({ ...args });

    expect(fs.readFileSync(attemptFile(held.id), 'utf8')).toBe(bytesAfterFirst);
    expect(second).toEqual(first);
    expect(listAttempts(h.state, 'task-1').length).toBe(1);
    expect(fs.readdirSync(path.join(h.moePath, 'attempts'))).toEqual([`${held.id}.json`]);
  });

  // --- fencing and the refusals that protect the seat -----------------------

  it('refuses a caller presenting a superseded generation', async () => {
    const held = await finalizingAttempt();

    const err = await refusal(
      finalize(payload({ attemptId: held.id, generation: held.generation + 1 }))
    );

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_SUPERSEDED');
    expect(phaseOf(held.id)).toBe('finalizing');
  });

  it('refuses an attempt id that does not exist', async () => {
    const err = await refusal(finalize(payload({ attemptId: 'attempt-nope', generation: 1 })));

    expect(err.code).toBe(-32001);
    expect(err.codeName).toBe('ATTEMPT_NOT_FOUND');
  });

  it('refuses an attempt that belongs to a different task', async () => {
    const held = await finalizingAttempt('task-2', 'worker-1');

    const err = await refusal(
      finalize(payload({ taskId: 'task-1', attemptId: held.id, generation: held.generation }))
    );

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_ID_TASK_MISMATCH');
    expect(phaseOf(held.id)).toBe('finalizing');
  });

  it('refuses an attempt still in the running phase — the bytes are not landed', async () => {
    const opened = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-pilot', workspace: h.testDir,
    });

    const err = await refusal(
      finalize(payload({ attemptId: opened.id, generation: opened.generation }))
    );

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_NOT_FINALIZING');
    expect(phaseOf(opened.id)).toBe('running');
  });

  it('refuses a task id that does not exist', async () => {
    const held = await finalizingAttempt();

    const err = await refusal(
      finalize(payload({ taskId: 'task-nope', attemptId: held.id, generation: held.generation }))
    );

    expect(err.code).toBe(-32001);
    // The shared notFound('Task', id) helper's own name, not a new one.
    expect(err.codeName).toBe('TASK_NOT_FOUND');
    expect(phaseOf(held.id)).toBe('finalizing');
  });

  // --- input validation -----------------------------------------------------

  it('refuses a missing attempt id as invalid input', async () => {
    await finalizingAttempt();

    const err = await refusal(finalize(payload({ generation: 1 })));

    expect(err.code).toBe(-32602);
  });

  it('refuses an outcome outside the reported-landing vocabulary', async () => {
    const held = await finalizingAttempt();

    const err = await refusal(
      finalize(payload({ attemptId: held.id, generation: held.generation, outcome: 'shipped' }))
    );

    expect(err.code).toBe(-32602);
    expect(err.codeName).toBe('INVALID_INPUT');
    expect(phaseOf(held.id)).toBe('finalizing');
  });

  it('refuses outcome "landed" without a 40-hex landedRevision', async () => {
    const held = await finalizingAttempt();

    const err = await refusal(
      finalize(payload({ attemptId: held.id, generation: held.generation, landedRevision: 'HEAD' }))
    );

    expect(err.code).toBe(-32602);
    expect(err.codeName).toBe('INVALID_INPUT');
    expect(phaseOf(held.id)).toBe('finalizing');
  });

  it('accepts an uppercase 40-hex revision, like the sibling record_candidate does', async () => {
    const held = await finalizingAttempt();

    const result = await finalize(
      payload({ attemptId: held.id, generation: held.generation, landedRevision: LANDED.toUpperCase() })
    );

    expect(result.phase).toBe('closed');
    expect(result.landedRevision).toBe(LANDED.toUpperCase());
  });

  it('does not verify runnerId against the attempt', async () => {
    // Locking this in deliberately. claim_next_task currently opens attempts
    // with runnerId = workerId, so a runner presenting its OWN id would never
    // match — adding an equality check here would break the held-out acceptance
    // case, which finalizes as 'runner-pilot' against an attempt opened by
    // 'worker-W'. Runner identity belongs to the reattachment slice.
    const held = await finalizingAttempt('task-1', 'worker-1');

    const result = await finalize(
      payload({ attemptId: held.id, generation: held.generation, runnerId: 'runner-somebody-else' })
    );

    expect(result.phase).toBe('closed');
  });

  it('accepts a runner that reports no landing at all', async () => {
    const held = await finalizingAttempt();

    const result = await finalize({
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-pilot',
      attemptId: held.id, generation: held.generation, outcome: 'nothing-to-commit',
    });

    expect(result.phase).toBe('closed');
    expect(result.outcome).toBe('nothing-to-commit');
    expect(result.landedRevision).toBeNull();
  });

  // --- closing is what lifts the claim hold ---------------------------------

  it('lifts the claim hold, so the same worker may start its next task', async () => {
    const held = await finalizingAttempt();
    const claim = () => claimNextTaskTool(h.state).handler(
      { statuses: ['WORKING'], taskId: 'task-2', workerId: 'worker-1' }, h.state
    );

    const blocked = await refusal(claim());
    expect(blocked.codeName).toBe('ATTEMPT_FINALIZING');

    await finalize(payload({ attemptId: held.id, generation: held.generation }));
    const granted = await claim() as { hasNext: boolean };

    expect(granted.hasNext).toBe(true);
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBe('worker-1');
  });
});

// =============================================================================
// The other half of the hold: a fast QA must not drive a task to DONE while the
// runner has not landed a byte. Scoped by TASK, not by worker — the IDE/human
// approval path carries no workerId at all, and a worker-scoped lookup would
// leave exactly that race open.
// =============================================================================

describe('moe.qa_approve — finalizing hold', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: null });
    await h.state.load();
  });

  afterEach(() => h.cleanup());

  function approve(args: Record<string, unknown> = {}): Promise<unknown> {
    return qaApproveTool(h.state).handler(
      { taskId: 'task-1', summary: 'Re-read the diff and the DoD.', ...args }, h.state
    );
  }

  async function finalizingAttempt(): Promise<{ id: string; generation: number }> {
    const opened = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-pilot', workspace: h.testDir,
    });
    const held = await setAttemptPhase(h.state, opened.id, 'finalizing');
    return { id: held.id, generation: held.generation };
  }

  it('refuses the human path with a retryable ATTEMPT_FINALIZING state conflict', async () => {
    const held = await finalizingAttempt();

    const err = await refusal(approve());

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_FINALIZING');
    expect(err.context).toEqual({
      attemptId: held.id,
      generation: held.generation,
      taskId: 'task-1',
      workerId: 'worker-1',
      retryable: true,
    });
  });

  it('moves not one byte of the task when it refuses', async () => {
    await finalizingAttempt();
    const taskFile = path.join(h.moePath, 'tasks', 'task-1.json');
    const before = fs.readFileSync(taskFile, 'utf8');

    await refusal(approve());

    expect(fs.readFileSync(taskFile, 'utf8')).toBe(before);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  });

  it('refuses a QA caller whose own worker id is not the finalizing one', async () => {
    // Task-scoped, not worker-scoped: the attempt belongs to worker-1, the
    // approval comes from qa-9, and the race is the same one either way.
    await finalizingAttempt();

    const err = await refusal(approve({ workerId: 'qa-9' }));

    expect(err.codeName).toBe('ATTEMPT_FINALIZING');
  });

  it('tells a non-holder to wait for the runner, never to close the boundary itself', async () => {
    // The approver never owns the landing. Following the holder's advice would
    // close a live runner's boundary and approve to DONE before a byte landed.
    const held = await finalizingAttempt();

    const err = await refusal(approve());

    expect(err.message).toContain("is held by worker worker-1's attempt");
    expect(err.message).toContain(`${held.id} (generation ${held.generation})`);
    expect(err.message).toContain('approving this task');
    expect(err.message).toContain("wait for that worker's runner to call moe.finalize_attempt");
    expect(err.message).toContain('Do NOT close the boundary to get past this refusal');
    expect(err.message).not.toContain('Close the boundary with moe.finalize_attempt, then retry');
  });

  it('approves to DONE once the attempt is closed', async () => {
    const held = await finalizingAttempt();
    await setAttemptPhase(h.state, held.id, 'closed');

    const result = await approve() as { status: string };

    expect(result.status).toBe('DONE');
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  it('approves a task that never opened an attempt at all', async () => {
    const result = await approve() as { status: string };

    expect(result.status).toBe('DONE');
  });
});

describe('moe.finalize_attempt — unlanded worktree landings', () => {
  const h = new ToolTestHarness();
  const rescueRef = 'refs/moe/rescue/task-1/20261030T120000Z';
  const targetTip = 'c3'.repeat(20);
  const taskBytes = () => fs.readFileSync(path.join(h.moePath, 'tasks/task-1.json'), 'utf8');
  const task = () => h.state.getTask('task-1')!;
  const finalize = (args: Record<string, unknown>) =>
    finalizeAttemptTool(h.state).handler(args, h.state) as Promise<Record<string, unknown>>;

  beforeEach(async () => {
    h.init(); h.setupMoeFolder(); h.createEpic();
    h.createTask({ status: 'REVIEW', assignedWorkerId: null, reopenCount: 1,
      implementationPlan: ['step-1', 'step-2'].map(stepId => ({ stepId, description: stepId, status: 'COMPLETED' })),
      stepsCompleted: ['step-1', 'step-2'] });
    await h.state.load();
  });
  afterEach(() => h.cleanup());

  async function worktreeAttempt(workspaceMode: ExecutionWorkspaceMode | 'legacy' = 'worktree') {
    const opened = await openAttempt(h.state, { taskId: 'task-1', workerId: 'worker-1',
      runnerId: 'runner-pilot', workspace: path.join(h.testDir, '.worktrees/task-1'),
      ...(workspaceMode === 'legacy' ? {} : { workspaceMode }) });
    return setAttemptPhase(h.state, opened.id, 'finalizing');
  }
  function payload(attempt: { id: string; generation: number }, over: Record<string, unknown> = {}) {
    return { taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-pilot',
      attemptId: attempt.id, generation: attempt.generation, outcome: 'unlanded',
      unlandedReason: 'conflict', conflictPaths: ['src/a.ts', 'docs/b.md'], rescueRef, targetTip, ...over };
  }

  it.each([
    ['unlandedReason', 'bogus', 'INVALID_INPUT'], ['unlandedReason', undefined, 'MISSING_REQUIRED'],
    ['rescueRef', undefined, 'MISSING_REQUIRED'], ['rescueRef', 'refs/heads/main', 'INVALID_INPUT'],
    ['rescueRef', 'refs/moe/rescue/task-2/x', 'INVALID_INPUT'],
    ['rescueRef', `${rescueRef}/extra`, 'INVALID_INPUT'], ['rescueRef', `${rescueRef}${'a'.repeat(256)}`, 'INVALID_INPUT'],
    ['targetTip', 'HEAD', 'INVALID_INPUT'], ['conflictPaths', 'src/a.ts', 'INVALID_INPUT'],
    ['landedRevision', LANDED, 'INVALID_INPUT'],
  ])('refuses malformed %s=%s before any write', async (field, value, codeName) => {
    const held = await worktreeAttempt(); const before = taskBytes();
    const err = await refusal(finalize(payload(held, { [field as string]: value })));
    expect(err).toMatchObject({ code: -32602, codeName, context: { field } });
    expect(h.state.attempts.get(held.id)!.phase).toBe('finalizing');
    expect(taskBytes()).toBe(before);
  });

  it.each(['legacy', 'shared'] as const)('refuses unlanded on a %s attempt', async mode => {
    const held = await worktreeAttempt(mode);
    const before = taskBytes();
    const err = await refusal(finalize(payload(held)));
    expect(err).toMatchObject({ code: -32602, codeName: 'INVALID_INPUT', context: { field: 'outcome' } });
    expect(h.state.attempts.get(held.id)!.phase).toBe('finalizing');
    expect(taskBytes()).toBe(before);
  });

  it('advertises the unlanded input contract', () => {
    const properties = finalizeAttemptTool(h.state).inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.outcome.enum).toContain('unlanded');
    expect(properties.unlandedReason.enum).toEqual(UNLANDED_REASONS);
  });

  it('routes conflict once without resetting completed work and persists the retry', async () => {
    const held = await worktreeAttempt(); const plan = task().implementationPlan;
    const result = await finalize(payload(held));
    expect(result).toMatchObject({ phase: 'closed', taskStatus: 'WORKING', landingRetry: task().landingRetry });
    expect(task()).toMatchObject({ status: 'WORKING', assignedWorkerId: null, reopenCount: 1,
      implementationPlan: plan, stepsCompleted: ['step-1', 'step-2'] });
    expect(task().landingRetry).toEqual({ reason: 'conflict', paths: ['src/a.ts', 'docs/b.md'],
      rescueRef, targetTip, count: 1, at: expect.any(String) });
    expect(Number.isNaN(Date.parse(task().landingRetry!.at))).toBe(false);
    expect(JSON.parse(taskBytes()).landingRetry).toEqual(task().landingRetry);
    expect(task().comments).toHaveLength(1);
    expect(task().comments[0].author).toBe('moe-daemon');
    for (const text of ['conflict', 'src/a.ts', 'docs/b.md', rescueRef, held.id, String(held.generation), targetTip, 'WORKING']) {
      expect(task().comments[0].content).toContain(text);
    }
  });

  it.each(['contention', 'gate', 'remote'])('routes %s to WORKING', async unlandedReason => {
    await finalize(payload(await worktreeAttempt(), { unlandedReason }));
    expect(task()).toMatchObject({ status: 'WORKING', landingRetry: { reason: unlandedReason, count: 1 } });
  });

  it('blocks diverged immediately with WORKING unblock provenance', async () => {
    await finalize(payload(await worktreeAttempt(), { unlandedReason: 'diverged' }));
    expect(task()).toMatchObject({ status: 'BLOCKED', assignedWorkerId: null, blockedFromStatus: 'WORKING',
      blockedResourceId: null, blockedOnTaskIds: null, blockedAt: expect.any(String),
      blockedReason: expect.stringContaining('diverged'), landingRetry: { count: 1 } });
  });

  it('blocks the third consecutive landing, but not the second', async () => {
    for (const [i, unlandedReason] of ['conflict', 'contention', 'gate'].entries()) {
      if (i > 0) await h.state.updateTask('task-1', { status: 'REVIEW' });
      const held = await worktreeAttempt(); expect(held.generation).toBe(i + 1);
      await finalize(payload(held, { unlandedReason }));
      expect(task().landingRetry!.count).toBe(i + 1);
      expect(task().status).toBe(i < 2 ? 'WORKING' : 'BLOCKED');
    }
    expect(task()).toMatchObject({ blockedFromStatus: 'WORKING', blockedReason: expect.stringContaining('gate') });
  });

  it.each(['landed', 'nothing-to-commit'])('%s clears the retry and resets the next count', async outcome => {
    await finalize(payload(await worktreeAttempt()));
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    await finalize(payload(await worktreeAttempt(), { outcome, landedRevision: outcome === 'landed' ? LANDED : null }));
    expect(task().landingRetry).toBeNull(); expect(JSON.parse(taskBytes()).landingRetry).toBeNull();
    expect(task().status).toBe('REVIEW');
    await finalize(payload(await worktreeAttempt()));
    expect(task().landingRetry!.count).toBe(1);
  });

  it('concurrent and sequential replays never re-route, double-count or comment', async () => {
    const args = payload(await worktreeAttempt());
    const [first, second] = await Promise.all([finalize(args), finalize(args)]);
    expect(second).toEqual(first); const bytes = taskBytes();
    expect(await finalize(args)).toEqual(first); expect(taskBytes()).toBe(bytes);
    expect(task().landingRetry!.count).toBe(1); expect(task().comments).toHaveLength(1);
  });

  it('records but never moves a row no longer in REVIEW', async () => {
    const held = await worktreeAttempt();
    await h.state.updateTask('task-1', { status: 'PLANNING' });
    await finalize(payload(held));
    expect(task()).toMatchObject({ status: 'PLANNING', landingRetry: { count: 1 } });
    expect(task().comments).toHaveLength(1);
  });

  it('normalizes paths leniently and bounds the record and comment preview', async () => {
    const conflictPaths = ['src/a.ts', 'src/a.ts', '/etc/passwd', '../x', null, 12,
      ...Array.from({ length: 600 }, (_, i) => `src/p${i}.ts`)];
    await finalize(payload(await worktreeAttempt(), { conflictPaths }));
    expect(task().landingRetry!.paths).toEqual(['src/a.ts', ...Array.from({ length: 499 }, (_, i) => `src/p${i}.ts`)]);
    expect(task().comments[0].content).toContain('(+480 more)');
    expect(task().comments[0].content).not.toContain('src/p19.ts');
  });

  it.each([undefined, null])('defaults omitted/null optional metadata (%s)', async value => {
    await finalize(payload(await worktreeAttempt(), { targetTip: value, conflictPaths: value, landedRevision: value }));
    expect(task().landingRetry).toMatchObject({ targetTip: null, paths: [] });
    expect(task().comments[0].content).toContain('(none reported)');
    expect(task().comments[0].content).toContain('unknown');
  });

  it.each([0, -1, 1.5, 'bad', Number.MAX_SAFE_INTEGER + 1])('tolerates a garbage stored count (%s)', async count => {
    await h.state.updateTask('task-1', { landingRetry: { reason: 'conflict', paths: [], rescueRef, targetTip,
      count: count as number, at: new Date().toISOString() } });
    await finalize(payload(await worktreeAttempt()));
    expect(task().landingRetry!.count).toBe(1);
  });

  it.each(['landed', 'nothing-to-commit', 'rescued', 'failed'])('shared %s ignores unlanded-only fields without task writes', async outcome => {
    const held = await worktreeAttempt('shared'); const before = taskBytes();
    await finalize(payload(held, { outcome, landedRevision: outcome === 'landed' ? LANDED : null,
      unlandedReason: 'bogus', conflictPaths: 1, rescueRef: false, targetTip: 'HEAD' }));
    expect(taskBytes()).toBe(before);
  });

  it('accepts another runner but still refuses a superseded generation before any write', async () => {
    const held = await worktreeAttempt(); const before = taskBytes();
    const err = await refusal(finalize(payload(held, { generation: held.generation + 1, runnerId: 'runner-replay' })));
    expect(err.codeName).toBe('ATTEMPT_SUPERSEDED'); expect(taskBytes()).toBe(before);
    expect(h.state.attempts.get(held.id)!.phase).toBe('finalizing');
    expect(await finalize(payload(held, { runnerId: 'runner-replay' }))).toMatchObject({ taskStatus: 'WORKING' });
  });

  it('closes first, writes the task once and fails safe if task persistence fails', async () => {
    const held = await worktreeAttempt(); const before = taskBytes(); const args = payload(held);
    const update = vi.spyOn(h.state, 'updateTask');
    const persist = h.state.writeEntity.bind(h.state);
    const write = vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'tasks') {
        expect(h.state.attempts.get(held.id)!.phase).toBe('closed');
        throw new Error('task write failed');
      }
      return persist(kind, id, entity);
    });
    try {
      await expect(finalize(args)).rejects.toThrow('task write failed');
      expect(update).toHaveBeenCalledTimes(1); expect(taskBytes()).toBe(before);
      expect(task().status).toBe('REVIEW');
      expect(await finalize(args)).toMatchObject({ phase: 'closed', taskStatus: 'REVIEW', landingRetry: null });
      expect(update).toHaveBeenCalledTimes(1); expect(taskBytes()).toBe(before);
    } finally { write.mockRestore(); update.mockRestore(); }
  });

  it.each(['rescued', 'failed'])('%s preserves an existing retry without task writes', async outcome => {
    await finalize(payload(await worktreeAttempt()));
    const held = await worktreeAttempt(); const before = taskBytes();
    await finalize(payload(held, { outcome }));
    expect(taskBytes()).toBe(before); expect(task().landingRetry!.count).toBe(1);
  });

  it('exposes landingRetry in get_context only while it is set', async () => {
    const contextTask = async () => (await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
      task: Record<string, unknown> }).task;
    expect('landingRetry' in await contextTask()).toBe(false);
    await finalize(payload(await worktreeAttempt()));
    expect((await contextTask()).landingRetry).toEqual(task().landingRetry);
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    await finalize(payload(await worktreeAttempt(), { outcome: 'landed', landedRevision: LANDED }));
    expect('landingRetry' in await contextTask()).toBe(false);
  });
});

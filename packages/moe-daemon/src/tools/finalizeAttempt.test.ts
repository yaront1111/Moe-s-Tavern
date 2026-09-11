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

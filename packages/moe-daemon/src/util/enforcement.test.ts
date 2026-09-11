import { describe, it, expect, vi } from 'vitest';
import {
  assertWorkerOwns,
  assertContextFetched,
  assertAllStepsCompleted,
  assertAttemptCurrent,
  type AttemptIdentity,
} from './enforcement.js';
import { missingRequired, MoeError, MoeErrorCode, notAllowed, notFound } from './errors.js';
import { logger } from './logger.js';
import type { Task, ImplementationStep, ExecutionAttempt } from '../types/schema.js';
import type { StateManager } from '../state/StateManager.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    epicId: 'epic-1',
    title: '',
    description: '',
    definitionOfDone: [],
    taskRails: [],
    implementationPlan: [],
    status: 'WORKING',
    assignedWorkerId: null,
    branch: null,
    prLink: null,
    reopenCount: 0,
    reopenReason: null,
    createdBy: 'HUMAN',
    parentTaskId: null,
    priority: 'MEDIUM',
    order: 1,
    comments: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function step(status: ImplementationStep['status'], stepId = 'step-x'): ImplementationStep {
  return { stepId, description: 'd', status, affectedFiles: [] };
}

describe('assertWorkerOwns', () => {
  it('no-op when assignedWorkerId is null', () => {
    expect(() => assertWorkerOwns(makeTask({ assignedWorkerId: null }), 'worker-a')).not.toThrow();
  });

  it('no-op when workerId is undefined (legacy caller)', () => {
    expect(() => assertWorkerOwns(makeTask({ assignedWorkerId: 'worker-a' }), undefined)).not.toThrow();
  });

  it('accepts matching workerId', () => {
    expect(() => assertWorkerOwns(makeTask({ assignedWorkerId: 'worker-a' }), 'worker-a')).not.toThrow();
  });

  it('rejects when workerId does not match assignedWorkerId', () => {
    try {
      assertWorkerOwns(makeTask({ assignedWorkerId: 'worker-a' }), 'worker-b');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });
});

describe('MoeError formatting', () => {
  it('uses explicit names for duplicate JSON-RPC code values', () => {
    expect(missingRequired('taskId').message).toMatch(/^\[MISSING_REQUIRED\]/);
    expect(notFound('Task', 'task-1').message).toMatch(/^\[TASK_NOT_FOUND\]/);
    expect(notAllowed('complete_task', 'owned by another worker').message).toMatch(/^\[NOT_ALLOWED\]/);
  });
});

describe('assertContextFetched', () => {
  it('no-op when workerId is undefined', () => {
    expect(() => assertContextFetched(makeTask({ assignedWorkerId: 'worker-a' }), undefined)).not.toThrow();
  });

  it('no-op when task is unclaimed (plugin/human path)', () => {
    expect(() => assertContextFetched(makeTask({ assignedWorkerId: null }), 'worker-a')).not.toThrow();
  });

  it('accepts when workerId is in contextFetchedBy', () => {
    const task = makeTask({ assignedWorkerId: 'worker-a', contextFetchedBy: ['worker-a'] });
    expect(() => assertContextFetched(task, 'worker-a')).not.toThrow();
  });

  it('rejects when contextFetchedBy is missing', () => {
    const task = makeTask({ assignedWorkerId: 'worker-a' });
    try {
      assertContextFetched(task, 'worker-a');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).message).toContain('moe.get_context');
    }
  });

  it('rejects when contextFetchedBy has a different worker', () => {
    const task = makeTask({ assignedWorkerId: 'worker-a', contextFetchedBy: ['worker-b'] });
    expect(() => assertContextFetched(task, 'worker-a')).toThrow(MoeError);
  });
});

describe('assertAllStepsCompleted', () => {
  it('rejects when plan is empty (no verifiable work to complete)', () => {
    try {
      assertAllStepsCompleted(makeTask());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).message).toContain('no implementation plan');
    }
  });

  it('accepts when all steps are COMPLETED', () => {
    const task = makeTask({
      implementationPlan: [step('COMPLETED', 's1'), step('COMPLETED', 's2')],
    });
    expect(() => assertAllStepsCompleted(task)).not.toThrow();
  });

  it('rejects when any step is PENDING', () => {
    const task = makeTask({
      implementationPlan: [step('COMPLETED', 's1'), step('PENDING', 's2')],
    });
    try {
      assertAllStepsCompleted(task);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).message).toContain('1 step');
      expect((err as MoeError).context?.remaining).toBe(1);
    }
  });

  it('rejects when any step is IN_PROGRESS', () => {
    const task = makeTask({
      implementationPlan: [step('IN_PROGRESS', 's1')],
    });
    expect(() => assertAllStepsCompleted(task)).toThrow(MoeError);
  });
});

// =============================================================================
// assertAttemptCurrent — attempt fencing
// =============================================================================

function makeAttempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  const now = new Date().toISOString();
  return {
    id: 'attempt-1',
    taskId: 'task-1',
    workerId: 'worker-a',
    runnerId: 'runner-a',
    generation: 1,
    workspace: 'D:/wt/a',
    phase: 'running',
    startedAt: now,
    lastPhaseAt: now,
    ...overrides,
  };
}

/**
 * Minimal state stub — the guard only ever reads `state.attempts` (through
 * attemptStore), so a full StateManager would buy nothing but filesystem setup.
 * Same `as unknown as StateManager` idiom the tool tests already use.
 */
function makeState(...attempts: ExecutionAttempt[]): StateManager {
  const map = new Map<string, ExecutionAttempt>();
  for (const attempt of attempts) map.set(attempt.id, attempt);
  return { attempts: map } as unknown as StateManager;
}

/** Assert BOTH the numeric code and the codeName — several codes share a number here. */
function expectMoeError(fn: () => void, code: MoeErrorCode, codeName: string): MoeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).code).toBe(code);
    expect((err as MoeError).codeName).toBe(codeName);
    return err as MoeError;
  }
  throw new Error(`expected MoeError ${codeName}, but nothing was thrown`);
}

describe('assertAttemptCurrent', () => {
  const fencedTask = () => makeTask({ id: 'task-1', assignedWorkerId: 'worker-a' });
  /** attempt-1 gen 1 is closed; attempt-2 gen 2 is the live one. */
  const closedFirst = () => makeAttempt({ id: 'attempt-1', generation: 1, phase: 'closed' });
  const liveSecond = () => makeAttempt({ id: 'attempt-2', generation: 2, phase: 'running' });
  const fencedState = () => makeState(closedFirst(), liveSecond());

  describe('generation comparison', () => {
    it('rejects a generation one behind the current attempt', () => {
      const err = expectMoeError(
        () => assertAttemptCurrent(fencedState(), fencedTask(), { generation: 1 }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
      expect(err.context?.currentGeneration).toBe(2);
      expect(err.context?.callerGeneration).toBe(1);
    });

    it('accepts the current generation', () => {
      expect(() =>
        assertAttemptCurrent(fencedState(), fencedTask(), { generation: 2 })
      ).not.toThrow();
    });

    // A caller from the future is as wrong as one from the past: this is the case
    // an ordering comparison (generation < current) would wave through.
    it('rejects a generation ahead of the current attempt', () => {
      const err = expectMoeError(
        () => assertAttemptCurrent(fencedState(), fencedTask(), { generation: 3 }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
      expect(err.context?.currentGeneration).toBe(2);
      expect(err.context?.callerGeneration).toBe(3);
    });
  });

  describe('attempt id comparison', () => {
    it('accepts the current attempt id', () => {
      expect(() =>
        assertAttemptCurrent(fencedState(), fencedTask(), { attemptId: 'attempt-2' })
      ).not.toThrow();
    });

    it('rejects a superseded attempt id', () => {
      const err = expectMoeError(
        () => assertAttemptCurrent(fencedState(), fencedTask(), { attemptId: 'attempt-1' }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
      expect(err.context?.currentAttemptId).toBe('attempt-2');
      expect(err.context?.callerAttemptId).toBe('attempt-1');
    });

    it('rejects an attempt id that is not in the store at all', () => {
      expectMoeError(
        () => assertAttemptCurrent(fencedState(), fencedTask(), { attemptId: 'attempt-ghost' }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
    });
  });

  // Both fields are compared against the current attempt, so a pair that
  // disagrees with itself can never pass — whichever half is stale refuses it.
  // These two kill an implementation that accepts on EITHER field matching.
  describe('both fields supplied', () => {
    it('accepts a pair matching the current attempt on both fields', () => {
      expect(() =>
        assertAttemptCurrent(fencedState(), fencedTask(), { attemptId: 'attempt-2', generation: 2 })
      ).not.toThrow();
    });

    it('rejects a pair whose id is current but whose generation is stale', () => {
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            attemptId: 'attempt-2',
            generation: 1,
          }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
    });

    it('rejects a pair whose generation is current but whose id is stale', () => {
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            attemptId: 'attempt-1',
            generation: 2,
          }),
        MoeErrorCode.STATE_CONFLICT,
        'ATTEMPT_SUPERSEDED'
      );
    });
  });

  describe('legacy tolerance', () => {
    it('no-op when no identity argument is supplied at all', () => {
      expect(() => assertAttemptCurrent(fencedState(), fencedTask(), undefined)).not.toThrow();
    });

    // JSON callers serialize an omitted optional object as null; that is the same
    // absence, and grants nothing a caller could not get by omitting the field.
    it('no-op when the identity argument is JSON null', () => {
      expect(() =>
        assertAttemptCurrent(fencedState(), fencedTask(), null as unknown as AttemptIdentity)
      ).not.toThrow();
    });

    it('no-op when the identity object carries neither field', () => {
      expect(() => assertAttemptCurrent(fencedState(), fencedTask(), {})).not.toThrow();
    });

    it('no-op when the identity object carries both fields as undefined', () => {
      expect(() =>
        assertAttemptCurrent(fencedState(), fencedTask(), {
          attemptId: undefined,
          generation: undefined,
        })
      ).not.toThrow();
    });

    // A task that never opened an attempt cannot have superseded anybody, and
    // refusing here would break every task predating the attempt rollout.
    it('no-op when the task has no attempt record at all, even with an identity', () => {
      expect(() =>
        assertAttemptCurrent(makeState(), fencedTask(), { attemptId: 'attempt-9', generation: 9 })
      ).not.toThrow();
    });

    it('no-op when only OTHER tasks have attempt records', () => {
      const other = makeAttempt({ id: 'attempt-o', taskId: 'task-2', generation: 7 });
      expect(() =>
        assertAttemptCurrent(makeState(other), fencedTask(), { generation: 3 })
      ).not.toThrow();
    });
  });

  // Without an identity the comparison below would pass vacuously anyway, so the
  // throw/no-throw tests alone cannot tell whether the legacy path returned early.
  // What the early return really buys is that a pre-attempt caller never touches
  // the attempt store (tool tests stub StateManager without one) and gets the
  // same once-per-(task, tool) warning assertWorkerOwns gives an omitted workerId.
  describe('legacy path observability', () => {
    /** A state whose attempt map throws on access: proves the path returned first. */
    function untouchableState(): StateManager {
      return {
        get attempts(): never {
          throw new Error('attempt store consulted on the legacy path');
        },
      } as unknown as StateManager;
    }

    it('returns before consulting the attempt store when no identity is supplied', () => {
      expect(() => assertAttemptCurrent(untouchableState(), fencedTask(), undefined)).not.toThrow();
      expect(() => assertAttemptCurrent(untouchableState(), fencedTask(), {})).not.toThrow();
    });

    it('warns once per task and tool, and only when the task is claimed', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const claimed = makeTask({ id: 'task-warn-claimed', assignedWorkerId: 'worker-a' });
        const unclaimed = makeTask({ id: 'task-warn-unclaimed', assignedWorkerId: null });
        assertAttemptCurrent(fencedState(), claimed, undefined, 'probe_tool');
        assertAttemptCurrent(fencedState(), claimed, {}, 'probe_tool');
        assertAttemptCurrent(fencedState(), unclaimed, undefined, 'probe_tool');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toEqual({ taskId: 'task-warn-claimed', tool: 'probe_tool' });
        expect(String(warn.mock.calls[0][1])).toContain('attempt identity missing');
      } finally {
        warn.mockRestore();
      }
    });

    it('logs the no-attempt-record tolerance once so the case stays visible', () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        const legacy = makeTask({ id: 'task-unrecorded-probe', assignedWorkerId: 'worker-a' });
        assertAttemptCurrent(makeState(), legacy, { generation: 4 }, 'probe_tool');
        assertAttemptCurrent(makeState(), legacy, { generation: 4 }, 'probe_tool');
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][0]).toEqual({
          taskId: 'task-unrecorded-probe',
          tool: 'probe_tool',
          generation: 4,
        });
        expect(String(info.mock.calls[0][1])).toContain('no attempt record');
      } finally {
        info.mockRestore();
      }
    });
  });

  // The current attempt is resolved per task: another task's live generation
  // must never satisfy this task's fence.
  it('does not accept a generation that is current for a DIFFERENT task', () => {
    const other = makeAttempt({ id: 'attempt-o', taskId: 'task-2', generation: 7 });
    expectMoeError(
      () =>
        assertAttemptCurrent(makeState(closedFirst(), liveSecond(), other), fencedTask(), {
          generation: 7,
        }),
      MoeErrorCode.STATE_CONFLICT,
      'ATTEMPT_SUPERSEDED'
    );
  });

  // Records exist but every one is closed: the caller's attempt is over, so it
  // is a zombie. This is NOT the no-record tolerance.
  it('rejects an identity when every attempt for the task is closed', () => {
    const state = makeState(
      closedFirst(),
      makeAttempt({ id: 'attempt-2', generation: 2, phase: 'closed' })
    );
    const err = expectMoeError(
      () => assertAttemptCurrent(state, fencedTask(), { attemptId: 'attempt-2', generation: 2 }),
      MoeErrorCode.STATE_CONFLICT,
      'ATTEMPT_SUPERSEDED'
    );
    expect(err.context?.currentAttemptId).toBeNull();
    expect(err.context?.currentGeneration).toBeNull();
  });

  describe('malformed identity is refused, never coerced', () => {
    const badGenerations: Array<[string, unknown]> = [
      ['null', null],
      ['numeric string', '2'],
      ['boolean', true],
      ['fractional', 1.5],
      ['negative', -1],
      ['zero', 0],
      ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ];

    it.each(badGenerations)('rejects generation %s as invalid input', (_label, value) => {
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            generation: value,
          } as unknown as AttemptIdentity),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
    });

    // Falsy-but-supplied must not fall through to the legacy branch: an empty
    // attempt store is exactly where a `!identity.generation` check would pass.
    it.each(badGenerations)(
      'rejects generation %s even when the task has no attempt record',
      (_label, value) => {
        expectMoeError(
          () =>
            assertAttemptCurrent(makeState(), fencedTask(), {
              generation: value,
            } as unknown as AttemptIdentity),
          MoeErrorCode.INVALID_INPUT,
          'INVALID_INPUT'
        );
      }
    );

    const badAttemptIds: Array<[string, unknown]> = [
      ['null', null],
      ['empty string', ''],
      ['whitespace', '   '],
      ['number', 42],
    ];

    it.each(badAttemptIds)('rejects attemptId %s as invalid input', (_label, value) => {
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            attemptId: value,
          } as unknown as AttemptIdentity),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
    });

    it('rejects an identity argument that is not an object', () => {
      expectMoeError(
        () =>
          assertAttemptCurrent(
            fencedState(),
            fencedTask(),
            'attempt-2' as unknown as AttemptIdentity
          ),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
    });

    // Rendering the refused value must never throw on its own: String() on a
    // null-prototype object and JSON.stringify on a BigInt both raise TypeError,
    // which would surface as an internal error instead of INVALID_INPUT.
    it('refuses unrenderable values as invalid input rather than crashing', () => {
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            generation: Object.create(null),
          } as unknown as AttemptIdentity),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
      expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            attemptId: BigInt(10),
          } as unknown as AttemptIdentity),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
    });

    it('bounds how much of a refused value it echoes back', () => {
      const err = expectMoeError(
        () =>
          assertAttemptCurrent(fencedState(), fencedTask(), {
            generation: 'x'.repeat(10_000),
          } as unknown as AttemptIdentity),
        MoeErrorCode.INVALID_INPUT,
        'INVALID_INPUT'
      );
      expect(err.message.length).toBeLessThan(300);
      expect(String(err.context?.reason).length).toBeLessThan(300);
    });
  });

  it('leaks nothing beyond the task id and the two identities in its context', () => {
    const err = expectMoeError(
      () =>
        assertAttemptCurrent(fencedState(), fencedTask(), {
          attemptId: 'attempt-1',
          generation: 1,
        }),
      MoeErrorCode.STATE_CONFLICT,
      'ATTEMPT_SUPERSEDED'
    );
    expect(Object.keys(err.context ?? {}).sort()).toEqual([
      'callerAttemptId',
      'callerGeneration',
      'currentAttemptId',
      'currentGeneration',
      'taskId',
    ]);
    expect(err.context?.taskId).toBe('task-1');
  });

  it('names the tool in its message when one is supplied', () => {
    const err = expectMoeError(
      () => assertAttemptCurrent(fencedState(), fencedTask(), { generation: 1 }, 'complete_step'),
      MoeErrorCode.STATE_CONFLICT,
      'ATTEMPT_SUPERSEDED'
    );
    expect(err.message).toContain('moe.complete_step');
  });
});

// Control: the attempt guard is additive. The existing guards — and their own
// legacy tolerances — must behave exactly as they did before it was added.
describe('existing guards are unchanged by the attempt fence', () => {
  // The attempt fence keeps its own warning dedupe: flooding it must not evict
  // the ownership guard's entries and make that guard warn a second time.
  it('attempt-fence notices never evict the ownership guard warning dedupe', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const owned = makeTask({ id: 'task-dedupe-owner', assignedWorkerId: 'worker-a' });
      assertWorkerOwns(owned, undefined, 'dedupe_probe');
      expect(warn).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 1001; i++) {
        const claimed = makeTask({ id: `task-dedupe-flood-${i}`, assignedWorkerId: 'worker-a' });
        assertAttemptCurrent(makeState(), claimed, undefined, 'dedupe_probe');
      }
      warn.mockClear();
      assertWorkerOwns(owned, undefined, 'dedupe_probe');
      expect(warn).toHaveBeenCalledTimes(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('assertWorkerOwns still tolerates an omitted workerId on a claimed task', () => {
    expect(() =>
      assertWorkerOwns(makeTask({ assignedWorkerId: 'worker-a' }), undefined, 'complete_step')
    ).not.toThrow();
  });

  it('assertWorkerOwns still rejects a different worker with NOT_ALLOWED', () => {
    const err = expectMoeError(
      () => assertWorkerOwns(makeTask({ assignedWorkerId: 'worker-a' }), 'worker-b'),
      MoeErrorCode.NOT_ALLOWED,
      'NOT_ALLOWED'
    );
    expect(err.context?.owner).toBe('worker-a');
    expect(err.context?.caller).toBe('worker-b');
  });

  it('assertWorkerOwns still no-ops on an unassigned task', () => {
    expect(() => assertWorkerOwns(makeTask({ assignedWorkerId: null }), 'worker-b')).not.toThrow();
  });

  it('assertContextFetched still tolerates an omitted workerId', () => {
    expect(() =>
      assertContextFetched(makeTask({ assignedWorkerId: 'worker-a' }), undefined, 'complete_step')
    ).not.toThrow();
  });

  it('assertContextFetched still rejects an un-fetched owner with NOT_ALLOWED', () => {
    expectMoeError(
      () => assertContextFetched(makeTask({ assignedWorkerId: 'worker-a' }), 'worker-a'),
      MoeErrorCode.NOT_ALLOWED,
      'NOT_ALLOWED'
    );
  });
});

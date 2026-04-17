import { describe, it, expect } from 'vitest';
import {
  assertWorkerOwns,
  assertContextFetched,
  assertAllStepsCompleted,
} from './enforcement.js';
import { MoeError, MoeErrorCode } from './errors.js';
import type { Task, ImplementationStep } from '../types/schema.js';

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
  it('accepts when plan is empty', () => {
    expect(() => assertAllStepsCompleted(makeTask())).not.toThrow();
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

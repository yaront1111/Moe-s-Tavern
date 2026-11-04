import { describe, expect, it } from 'vitest';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt } from '../types/schema.js';
import { finalizingAttemptsByTask } from './claimEligibility.js';

const attempt = (id: string, taskId: string, phase: ExecutionAttempt['phase']): ExecutionAttempt => ({
  id, taskId, workerId: 'worker-1', runnerId: 'worker-1', generation: 1, workspace: 'w', phase,
  createdAt: '2026-01-01T00:00:00.000Z', lastPhaseAt: '2026-01-01T00:00:00.000Z',
} as unknown as ExecutionAttempt);

describe('finalizingAttemptsByTask memo', () => {
  it('rebuilds only when the state version or the attempt map changes', () => {
    const state = new StateManager({ projectPath: os.tmpdir() });
    state.attempts.set('a1', attempt('a1', 'task-1', 'finalizing'));
    const first = finalizingAttemptsByTask(state);
    expect([...first.keys()]).toEqual(['task-1']);
    expect(finalizingAttemptsByTask(state)).toBe(first); // same version, same map: no rebuild

    state.attempts.set('a2', attempt('a2', 'task-2', 'finalizing')); // a direct insert changes the size
    const second = finalizingAttemptsByTask(state);
    expect(second).not.toBe(first);
    expect([...second.keys()].sort()).toEqual(['task-1', 'task-2']);

    state.attempts.get('a1')!.phase = 'closed'; // an in-place edit is invisible until the version moves
    expect(finalizingAttemptsByTask(state)).toBe(second);
    state.stateVersion++;
    expect([...finalizingAttemptsByTask(state).keys()]).toEqual(['task-2']);
  });
});

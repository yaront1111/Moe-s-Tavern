import { describe, expect, it } from 'vitest';
import {
  LIVENESS_TIMEOUT_MS,
  findFreshestLiveWorkerByRole,
  isWorkerAlive,
} from './workerLiveness.js';
import type { Team, Worker } from '../types/schema.js';

// Plain literals + an injected `nowMs`: no StateManager, no tmpdir, no timers.
const NOW_MS = Date.parse('2026-07-31T12:00:00.000Z');

function team(id: string, role: Team['role']): Team {
  return {
    id,
    projectId: 'proj-test',
    name: id,
    role,
    memberIds: [],
    maxSize: 10,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  };
}

function worker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    type: 'CLAUDE',
    projectId: 'proj-test',
    epicId: 'epic-1',
    currentTaskId: null,
    status: 'IDLE',
    branch: '',
    modifiedFiles: [],
    startedAt: '2026-07-31T00:00:00.000Z',
    lastActivityAt: new Date(NOW_MS).toISOString(),
    lastError: null,
    errorCount: 0,
    teamId: 'team-architects',
    ...overrides,
  };
}

/** A worker on the architect team, last active `secondsAgo` before NOW_MS. */
function architect(id: string, secondsAgo: number, overrides: Partial<Worker> = {}): Worker {
  return worker(id, {
    lastActivityAt: new Date(NOW_MS - secondsAgo * 1000).toISOString(),
    ...overrides,
  });
}

const TEAMS: Team[] = [team('team-architects', 'architect'), team('team-workers', 'worker')];

function find(workers: Worker[], opts: Parameters<typeof findFreshestLiveWorkerByRole>[3] = {}) {
  return findFreshestLiveWorkerByRole(workers, TEAMS, 'architect', { nowMs: NOW_MS, ...opts });
}

describe('isWorkerAlive', () => {
  it('treats a worker exactly at the timeout as alive and one ms past as not', () => {
    const atBoundary = worker('worker-a', {
      lastActivityAt: new Date(NOW_MS - LIVENESS_TIMEOUT_MS).toISOString(),
    });
    const pastBoundary = worker('worker-b', {
      lastActivityAt: new Date(NOW_MS - LIVENESS_TIMEOUT_MS - 1).toISOString(),
    });

    expect(isWorkerAlive(atBoundary, NOW_MS)).toBe(true);
    expect(isWorkerAlive(pastBoundary, NOW_MS)).toBe(false);
  });

  it('is never alive when the worker is DEAD, however fresh', () => {
    expect(isWorkerAlive(worker('worker-a', { status: 'DEAD' }), NOW_MS)).toBe(false);
  });

  it('treats a malformed lastActivityAt as not alive instead of throwing', () => {
    expect(isWorkerAlive(worker('worker-a', { lastActivityAt: 'yesterday' }), NOW_MS)).toBe(false);
  });
});

describe('findFreshestLiveWorkerByRole', () => {
  it('returns the single live architect', () => {
    expect(find([architect('architect-a', 5)])?.id).toBe('architect-a');
  });

  it('returns the architect with the greatest lastActivityAt', () => {
    const found = find([
      architect('architect-a', 90),
      architect('architect-b', 3),
      architect('architect-c', 40),
    ]);
    expect(found?.id).toBe('architect-b');
  });

  it('never returns a worker whose team holds a different role', () => {
    // The freshest worker overall is on the worker team — it must lose to the
    // older architect.
    const found = find([
      architect('architect-a', 60),
      architect('worker-fresh', 0, { teamId: 'team-workers' }),
    ]);
    expect(found?.id).toBe('architect-a');
  });

  it('skips an architect older than the liveness window', () => {
    const stale = architect('architect-stale', LIVENESS_TIMEOUT_MS / 1000 + 1);
    expect(find([stale])).toBeNull();
    expect(find([stale, architect('architect-fresh', 10)])?.id).toBe('architect-fresh');
  });

  it('skips a DEAD architect that is still inside the window', () => {
    expect(find([architect('architect-dead', 1, { status: 'DEAD' })])).toBeNull();
  });

  it('skips workers with no teamId or a teamId pointing at a missing team', () => {
    expect(find([architect('architect-teamless', 1, { teamId: null })])).toBeNull();
    expect(find([architect('architect-ghost', 1, { teamId: 'team-deleted' })])).toBeNull();
  });

  it('returns null when no team carries the requested role', () => {
    const found = findFreshestLiveWorkerByRole(
      [architect('architect-a', 1)],
      [team('team-workers', 'worker')],
      'architect',
      { nowMs: NOW_MS }
    );
    expect(found).toBeNull();
  });

  it('honours excludeWorkerIds, down to null when every candidate is excluded', () => {
    const workers = [architect('architect-a', 1), architect('architect-b', 30)];
    expect(find(workers, { excludeWorkerIds: ['architect-a'] })?.id).toBe('architect-b');
    expect(find(workers, { excludeWorkerIds: ['architect-a', 'architect-b'] })).toBeNull();
  });

  it('breaks lastActivityAt ties on the lowest id, whatever the iteration order', () => {
    const a = architect('architect-a', 10);
    const b = architect('architect-b', 10);
    expect(find([a, b])?.id).toBe('architect-a');
    expect(find([b, a])?.id).toBe('architect-a');
  });

  it('treats a malformed lastActivityAt as not alive rather than throwing', () => {
    const malformed = architect('architect-broken', 0, { lastActivityAt: 'not-a-date' });
    expect(find([malformed])).toBeNull();
    expect(find([malformed, architect('architect-ok', 50)])?.id).toBe('architect-ok');
  });

  it('respects an explicit timeoutMs override', () => {
    const workers = [architect('architect-a', 300)];
    expect(find(workers)).toBeNull();
    expect(find(workers, { timeoutMs: 600_000 })?.id).toBe('architect-a');
  });

  it('returns null for empty inputs', () => {
    expect(find([])).toBeNull();
    expect(findFreshestLiveWorkerByRole([], [], 'architect', { nowMs: NOW_MS })).toBeNull();
  });
});

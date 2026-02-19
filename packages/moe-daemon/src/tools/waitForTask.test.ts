import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateManager } from '../state/StateManager.js';
import { activeWaiters, cleanupStaleWaiters } from './waitForTask.js';

describe('cleanupStaleWaiters', () => {
  afterEach(() => {
    for (const waiter of activeWaiters.values()) {
      clearTimeout(waiter.timer);
    }
    activeWaiters.clear();
    vi.restoreAllMocks();
  });

  it('removes waiters for workers no longer tracked by state', () => {
    const missingResolve = vi.fn();
    const missingUnsubscribe = vi.fn();
    const missingTimer = setTimeout(() => undefined, 60_000);
    missingTimer.unref?.();

    const activeResolve = vi.fn();
    const activeUnsubscribe = vi.fn();
    const activeTimer = setTimeout(() => undefined, 60_000);
    activeTimer.unref?.();

    activeWaiters.set('worker-missing', {
      resolve: missingResolve,
      unsubscribe: missingUnsubscribe,
      timer: missingTimer,
    });
    activeWaiters.set('worker-active', {
      resolve: activeResolve,
      unsubscribe: activeUnsubscribe,
      timer: activeTimer,
    });

    const state = {
      workers: new Map([['worker-active', { id: 'worker-active' }]]),
    } as unknown as StateManager;

    const cleaned = cleanupStaleWaiters(state);

    expect(cleaned).toBe(1);
    expect(missingUnsubscribe).toHaveBeenCalledTimes(1);
    expect(missingResolve).toHaveBeenCalledWith({ hasNext: false, cancelled: true });
    expect(activeWaiters.has('worker-missing')).toBe(false);
    expect(activeWaiters.has('worker-active')).toBe(true);
  });

  it('removes stale waiter even if callback cleanup throws', () => {
    const noisyTimer = setTimeout(() => undefined, 60_000);
    noisyTimer.unref?.();

    activeWaiters.set('worker-stale', {
      resolve: vi.fn(() => {
        throw new Error('resolve failed');
      }),
      unsubscribe: vi.fn(() => {
        throw new Error('unsubscribe failed');
      }),
      timer: noisyTimer,
    });

    const state = { workers: new Map() } as unknown as StateManager;

    const cleaned = cleanupStaleWaiters(state);

    expect(cleaned).toBe(1);
    expect(activeWaiters.has('worker-stale')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  blockedUntilMs,
  liveWindows,
  mergeSample,
  parseUsageWindows,
  peakPercent,
  validateUsage,
  type AccountUsage,
  type ParsedWindow,
} from './usageWindows.js';

// The usage math behind the 90% switch: what counts as one window, when a
// sample is worth writing, and how long a spent or refused account stays out.

const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A five_hour sample as the wrapper sends it: percent plus the reset in epoch seconds. */
function fiveHour(percent: number, nowMs: number, resetInMs = 3 * HOUR): Record<string, ParsedWindow> {
  return parseUsageWindows({ five_hour: { percent, resetsAt: Math.floor((nowMs + resetInMs) / 1000) } }, nowMs);
}

function merge(stored: AccountUsage | null, windows: Record<string, ParsedWindow>, nowMs: number, refused = false) {
  return mergeSample(stored, 'acct-1', { windows, refused }, 90, nowMs);
}

describe('parseUsageWindows', () => {
  it('reads percent, reset and status, and drops what it cannot use', () => {
    const resetSec = Math.floor((T0 + 2 * HOUR) / 1000);
    const parsed = parseUsageWindows({
      five_hour: { utilization: 0.425, resetsAt: resetSec, status: 'allowed' },
      seven_day: { percent: 63.24, resetsAt: new Date(T0 + 3 * DAY).toISOString() },
      seven_day_opus: { percent: 250 },
      monthly: { percent: 10, resetsAt: Math.floor((T0 + 30 * DAY) / 1000) },
      'Bad-Name': { percent: 5 },
      empty: { resetsAt: resetSec },
      junk: 'x',
    }, T0);
    expect(parsed).toEqual({
      five_hour: { percent: 42.5, resetsAtMs: resetSec * 1000, status: 'allowed' },
      seven_day: { percent: 63.2, resetsAtMs: T0 + 3 * DAY, status: null },
      seven_day_opus: { percent: 100, resetsAtMs: null, status: null },
      monthly: { percent: 10, resetsAtMs: null, status: null },
    });
  });
});

describe('mergeSample', () => {
  it('keeps the higher reading within a window and starts over when the window rolls', () => {
    let usage = merge(null, fiveHour(60, T0), T0).usage;
    usage = merge(usage, fiveHour(40, T0 + MIN), T0 + MIN).usage; // reset within 2 min: same window
    expect(peakPercent(usage, T0 + MIN)).toBe(60);
    usage = merge(usage, fiveHour(10, T0 + 10 * MIN, 5 * HOUR), T0 + 10 * MIN).usage; // reset moved: new window
    expect(peakPercent(usage, T0 + 10 * MIN)).toBe(10);
    usage = merge(usage, fiveHour(5, T0 + 6 * HOUR), T0 + 6 * HOUR).usage; // stored window already reset
    expect(peakPercent(usage, T0 + 6 * HOUR)).toBe(5);
  });

  it('reports a change only when a window moves materially or crosses the switch percent', () => {
    const readings = [50, 50.5, 51.2, 89.5, 90.1, 90.4];
    const jitter = [0, 30_000, -30_000, 15_000, -15_000, 30_000];
    let usage: AccountUsage | null = null;
    let writes = 0;
    readings.forEach((percent, i) => {
      const at = T0 + i * MIN;
      const result = merge(usage, parseUsageWindows({ five_hour: { percent, resetsAt: T0 + 3 * HOUR + jitter[i] } }, at), at);
      usage = result.usage;
      if (result.changed) writes++;
    });
    // 50 (new), 51.2 (+1.2), 89.5 (+38.3), 90.1 (crosses 90). 50.5 and 90.4 are noise.
    expect(writes).toBe(4);
  });

  it('re-writes a window with no reset time every 30 minutes, so it stays live while reported', () => {
    let usage: AccountUsage | null = null;
    let writes = 0;
    for (const at of [T0, T0 + 20 * MIN, T0 + 40 * MIN]) {
      const result = merge(usage, parseUsageWindows({ five_hour: { percent: 92 } }, at), at);
      usage = result.usage;
      if (result.changed) writes++;
    }
    expect(writes).toBe(2);
    expect(peakPercent(usage!, T0 + 90 * MIN)).toBe(92);
    expect(blockedUntilMs(usage!, 90, T0 + 90 * MIN)).toBe(T0 + 100 * MIN);
  });

  it('parks a refused account until its spent window resets: at least 5 minutes, an hour when nothing says when', () => {
    expect(blockedUntilMs(merge(null, {}, T0, true).usage, 90, T0)).toBe(T0 + HOUR);
    const soon = parseUsageWindows({ five_hour: { status: 'rejected', resetsAt: Math.floor((T0 + 2 * MIN) / 1000) } }, T0);
    expect(blockedUntilMs(merge(null, soon, T0, true).usage, 90, T0)).toBe(T0 + 5 * MIN);
    const later = parseUsageWindows({ five_hour: { status: 'rejected', resetsAt: Math.floor((T0 + 3 * HOUR) / 1000) } }, T0);
    expect(blockedUntilMs(merge(null, later, T0, true).usage, 90, T0)).toBe(T0 + 3 * HOUR);
  });

  it('treats a rejected or overage status as spent whatever the percent', () => {
    const reset = Math.floor((T0 + 2 * HOUR) / 1000);
    const overage = merge(null, parseUsageWindows({ five_hour: { utilization: 0.3, resetsAt: reset, status: 'overage' } }, T0), T0).usage;
    expect(blockedUntilMs(overage, 90, T0)).toBe(reset * 1000);
    const allowed = merge(null, parseUsageWindows({ five_hour: { utilization: 0.3, resetsAt: reset, status: 'allowed' } }, T0), T0).usage;
    expect(blockedUntilMs(allowed, 90, T0)).toBeNull();
  });

  it('writes nothing for an empty report', () => {
    expect(merge(null, {}, T0).changed).toBe(false);
  });
});

describe('views and files', () => {
  it('lists only live windows', () => {
    const usage = merge(null, {
      ...fiveHour(30, T0, HOUR),
      ...parseUsageWindows({ seven_day: { percent: 70, resetsAt: Math.floor((T0 + 3 * DAY) / 1000) } }, T0),
    }, T0).usage;
    expect(liveWindows(usage, T0 + 2 * HOUR)).toEqual({ seven_day: { percent: 70, resetsAt: new Date(T0 + 3 * DAY).toISOString() } });
  });

  it('reads a usage file defensively: a wrong id gives null and broken windows are dropped', () => {
    const good = { percent: 50, resetsAt: new Date(T0 + HOUR).toISOString(), status: null, sampledAt: new Date(T0).toISOString() };
    expect(validateUsage({ id: 'acct-2', windows: {} }, 'acct-1')).toBeNull();
    expect(validateUsage({ id: 'acct-1', windows: { five_hour: good, seven_day: { percent: 'x' } }, refusedUntil: 7 }, 'acct-1'))
      .toEqual({ id: 'acct-1', windows: { five_hour: good }, refusedUntil: null, updatedAt: new Date(0).toISOString() });
  });
});

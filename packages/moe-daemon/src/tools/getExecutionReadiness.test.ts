// CQ-M07d: moe.get_execution_readiness. A real StateManager on a temp .moe folder; the production evaluator is never
// reached: readinessProjectionDeps.refresh and .now are spied in every test, and values are held through the real
// holder with a fake evaluator (refreshReadiness(inputs, async () => snapshot)).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { getTools, TOOL_AUDIENCE } from './index.js';
import {
  getExecutionReadinessTool, readExecutionReadiness, readinessProjectionDeps, READINESS_REFRESH_WINDOW_MS,
  _resetReadinessRefreshForTests,
} from './getExecutionReadiness.js';
import { clearReadiness, heldReadiness, refreshReadiness } from '../delivery/readinessHolder.js';
import {
  READINESS_CAPABILITIES, type ReadinessId, type ReadinessInputs, type ReadinessSnapshot,
} from '../delivery/executionReadiness.js';
import { MoeError } from '../util/errors.js';
import type { Project } from '../types/schema.js';

type Row = Record<string, unknown>;

const TOOL = 'moe.get_execution_readiness';
const ISO = '2026-11-01T12:00:00.000Z';
const ISO_LATER = '2026-11-01T12:05:00.000Z';
const EVIDENCE = { reportSha256: 'a'.repeat(64), platform: 'linux', arch: 'x64', providerVersion: '1.17.0' };
const READY: ReadinessSnapshot = { ready: true, missingCapabilities: [], evaluatedAt: ISO, evidence: EVIDENCE };
const only = (...ids: ReadinessId[]): ReadinessSnapshot =>
  ({ ready: false, missingCapabilities: ids, evaluatedAt: ISO, evidence: null });
const NOT_READY = only('revision-bound-local-delivery', 'certification-report-missing');
const INPUTS = Object.freeze({ projectRoot: 'never-read' }) as unknown as ReadinessInputs;
const hold = (snapshot: unknown) => refreshReadiness(INPUTS, async () => snapshot);
const HARNESS_SETTINGS = {
  approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude',
};
const DEFAULT_PAYLOAD = { profile: 'legacy', ready: false, missingCapabilities: [...READINESS_CAPABILITIES], evaluatedAt: null };

const h = new ToolTestHarness();
const clock = { now: 1_000_000 };
let refresh: MockInstance<typeof readinessProjectionDeps.refresh>;

beforeEach(() => {
  for (const name of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(name, '');
  h.init();
  clock.now = 1_000_000;
  clearReadiness();
  _resetReadinessRefreshForTests();
  vi.spyOn(readinessProjectionDeps, 'now').mockImplementation(() => clock.now);
  // Replaces the production refresh in every test: a call only counts, it never evaluates for real.
  refresh = vi.spyOn(readinessProjectionDeps, 'refresh').mockImplementation(async () => undefined);
});
afterEach(async () => {
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  clearReadiness();
  _resetReadinessRefreshForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

/** Raw settings on disk, then load: the only way an unreadable executionProfile can exist. */
async function seed(settings: Row = {}): Promise<void> {
  h.setupMoeFolder({ settings: { ...HARNESS_SETTINGS, ...settings } } as unknown as Partial<Project>);
  await h.state.load();
}

async function call(args: unknown = {}): Promise<Row> {
  const [tool] = getTools(h.state).filter((t) => t.name === TOOL);
  const invoke = () => tool.handler(args, h.state);
  return (await (tool.blocking ? invoke() : h.state.runExclusive(invoke))) as Row;
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** path -> sha256 of every file under .moe, the activity log included (call after flushActivityLog). */
function digest(dir = h.moePath, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) digest(full, out);
    else out[path.relative(h.moePath, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return out;
}

describe('moe.get_execution_readiness: the held value plus the live profile (DoD 1)', () => {
  it('is registered once, with an explicit wrapper audience and no git claim in its description', async () => {
    await seed();
    const tools = getTools(h.state).filter((t) => t.name === TOOL);
    expect(tools).toHaveLength(1);
    expect(TOOL_AUDIENCE[TOOL]).toBe('wrapper');
    expect(tools[0].inputSchema).toMatchObject({ additionalProperties: false });
    expect(tools[0].description).not.toMatch(/git/i);
  });

  it('before any evaluation: legacy, not ready, every capability missing, never evaluated', async () => {
    await seed();
    expect(await call()).toEqual(DEFAULT_PAYLOAD);
  });

  it('a held READY snapshot is ready with no missing capability', async () => {
    await seed();
    await hold(READY);
    expect(await call()).toEqual({ profile: 'legacy', ready: true, missingCapabilities: [], evaluatedAt: ISO });
  });

  it('a held NOT_READY snapshot returns its exact ordered list', async () => {
    await seed();
    await hold(NOT_READY);
    expect(await call()).toEqual({
      profile: 'legacy', ready: false,
      missingCapabilities: ['revision-bound-local-delivery', 'certification-report-missing'], evaluatedAt: ISO,
    });
  });

  it('a failed evaluation holds the default: not ready, evaluatedAt null', async () => {
    await seed();
    await hold(READY);
    await refreshReadiness(INPUTS, async () => { throw new Error('probe failed'); });
    expect(await call()).toEqual(DEFAULT_PAYLOAD);
  });

  it.each([['observe'], ['verified-local']])('profile follows the live setting: %s', async (profile) => {
    await seed({ executionProfile: profile });
    await hold(READY);
    expect(await call()).toEqual({ profile, ready: true, missingCapabilities: [], evaluatedAt: ISO });
  });

  it('profile tracks a setting change on the next call', async () => {
    await seed({ executionProfile: 'observe' });
    expect((await call()).profile).toBe('observe');
    await h.state.updateSettings({ executionProfile: 'legacy' } as never);
    expect((await call()).profile).toBe('legacy');
  });

  it.each([['bogus'], ['VERIFIED-LOCAL'], [42], [null], [{}]])(
    'a malformed executionProfile (%j) gives "unreadable" and no throw', async (stored) => {
      await seed({ executionProfile: stored });
      await hold(NOT_READY);
      expect(await call()).toEqual({
        profile: 'unreadable', ready: false,
        missingCapabilities: ['revision-bound-local-delivery', 'certification-report-missing'], evaluatedAt: ISO,
      });
    });

  it('returns exactly the four fixed keys', async () => {
    await seed();
    await hold(READY);
    expect(Object.keys(await call()).sort()).toEqual(['evaluatedAt', 'missingCapabilities', 'profile', 'ready']);
    // The held evidence never crosses the projection.
    expect(JSON.stringify(await call())).not.toContain(EVIDENCE.reportSha256);
  });
});

describe('refresh: awaited, single-flight, rate-limited (DoD 3, injected clock)', () => {
  it('five concurrent refreshes make one evaluator call and all see the refreshed value', async () => {
    await seed();
    const gate = deferred();
    refresh.mockImplementation(async () => { await gate.promise; await hold(READY); });
    const calls = Array.from({ length: 5 }, () => call({ refresh: true }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    gate.resolve();
    const results = await Promise.all(calls);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({ profile: 'legacy', ready: true, missingCapabilities: [], evaluatedAt: ISO });
    }
  });

  it('passes the live state to the refresh seam', async () => {
    await seed();
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledWith(h.state);
  });

  it('a burst runs once per window: none at +10 s, one more at +31 s', async () => {
    await seed();
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.now += 10_000;
    await call({ refresh: true });
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.now += 21_000;
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(2);
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('the window edge: refused 1 ms before READINESS_REFRESH_WINDOW_MS, allowed at it', async () => {
    await seed();
    await call({ refresh: true });
    clock.now += READINESS_REFRESH_WINDOW_MS - 1;
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a clock that moved backwards still runs a refresh', async () => {
    await seed();
    await call({ refresh: true });
    clock.now -= 60_000;
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a rejecting refresh does not reject the tool, still counts as started, and returns the held value', async () => {
    await seed();
    await hold(NOT_READY);
    refresh.mockImplementation(async () => { throw new Error('boom: /secret/path'); });
    const result = await call({ refresh: true });
    expect(result).toEqual({
      profile: 'legacy', ready: false,
      missingCapabilities: ['revision-bound-local-delivery', 'certification-report-missing'], evaluatedAt: ISO,
    });
    await call({ refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a synchronously throwing refresh is swallowed too', async () => {
    await seed();
    refresh.mockImplementation(() => { throw new Error('sync boom'); });
    expect(await call({ refresh: true })).toEqual(DEFAULT_PAYLOAD);
  });

  it('refresh absent, false or the empty-arguments call never evaluates', async () => {
    await seed();
    await call();
    await call({ refresh: false });
    await call(undefined);
    await call(null);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([['yes'], [1], [0], [null], [{}], [[]]])('refresh %j is INVALID_INPUT and evaluates nothing', async (bad) => {
    await seed();
    const error = await call({ refresh: bad }).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MoeError);
    expect((error as MoeError).codeName).toBe('INVALID_INPUT');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the refresh result is the holder\'s: a later held value is read after the awaited evaluation', async () => {
    await seed();
    refresh.mockImplementation(async () => { await hold({ ...READY, evaluatedAt: ISO_LATER }); });
    expect((await call({ refresh: true })).evaluatedAt).toBe(ISO_LATER);
  });
});

describe('read-only and grants nothing (DoD 4)', () => {
  it('writes no file, appends no activity and holds no value, with or without refresh and caller fields', async () => {
    await seed();
    await hold(NOT_READY);
    await h.state.flushActivityLog();
    const files = digest();
    const activity = h.state.getActivityLog(500).length;
    const held = heldReadiness();
    const grants: Row[] = [
      {}, { refresh: true }, { refresh: false }, { workerId: 'worker-x' },
      { ready: true, missingCapabilities: [], evaluatedAt: 'x', evidence: EVIDENCE, profile: 'verified-local' },
      { refresh: true, ready: true, missingCapabilities: [], evaluatedAt: 'x' },
    ];
    for (const args of grants) await call(args);
    await h.state.flushActivityLog();
    expect(digest()).toEqual(files);
    expect(h.state.getActivityLog(500)).toHaveLength(activity);
    expect(heldReadiness()).toBe(held);
    expect(heldReadiness()).toEqual({ ...NOT_READY, evaluatedAt: ISO });
  });

  it('a caller\'s workerId is never touched: the worker record stays absent', async () => {
    await seed();
    await call({ workerId: 'worker-ghost' });
    expect(h.state.workers.has('worker-ghost')).toBe(false);
    expect(fs.readdirSync(path.join(h.moePath, 'workers'))).toEqual([]);
  });

  it('returns fresh copies: mutating a payload never changes the held value', async () => {
    await seed();
    await hold(NOT_READY);
    const before = JSON.stringify(heldReadiness());
    const first = (await call()) as { missingCapabilities: string[]; ready: boolean };
    first.missingCapabilities.push('forged');
    first.missingCapabilities.length = 0;
    first.ready = true;
    expect(JSON.stringify(heldReadiness())).toBe(before);
    const second = (await call()) as { missingCapabilities: string[]; ready: boolean };
    expect(second.ready).toBe(false);
    expect(second.missingCapabilities).toEqual(['revision-bound-local-delivery', 'certification-report-missing']);
    expect(second.missingCapabilities).not.toBe(first.missingCapabilities);
  });

  it('opts out of the fleet mutex: blocking is pinned for a bounded read-only evaluation that must not hold it', () => {
    expect(getExecutionReadinessTool(h.state).blocking).toBe(true);
  });

  it('readExecutionReadiness itself ignores unknown option fields', async () => {
    await seed();
    const options = { ready: true } as unknown as { refresh?: unknown };
    expect(await readExecutionReadiness(h.state, options)).toEqual(DEFAULT_PAYLOAD);
    expect(refresh).not.toHaveBeenCalled();
  });
});

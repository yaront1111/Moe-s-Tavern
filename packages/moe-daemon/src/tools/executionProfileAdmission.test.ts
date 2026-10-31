// =============================================================================
// CQ-M01e: one fail-closed execution-profile admission rule for every claim
// path. An explicit claim of a task whose effective profile is not ready is
// refused before any write; claim_next_task's ranked pool and wait_for_task's
// matcher SKIP it through the same predicate, so no waiter is woken into a
// claim that refuses. Real handlers, a real StateManager and real attempt
// records over a temp .moe folder; nothing is mocked.
//
// update_settings refuses verified-local on purpose, so strict settings and
// strict rows exist only as hand-edited records: these tests seed raw JSON.
// Passing admission grants nothing; no case reads a snapshot as approval.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
import { getContextTool } from './getContext.js';
import { listTasksTool } from './listTasks.js';
import { releaseTaskTool } from './releaseTask.js';
import { listAttempts } from '../state/attemptStore.js';
import { releaseWorkerTasks } from '../state/workerLifecycle.js';
import { MoeError } from '../util/errors.js';
import type { Project, Task } from '../types/schema.js';

type Row = Record<string, unknown>;

const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const STRICT_V1 = { version: 1, profile: 'verified-local', planRevision: 1 };
const LEGACY = { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' };
const OBSERVE = { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'local-branch' };
const NOT_READY = 'EXECUTION_PROFILE_NOT_READY';
const NOT_READY_CONTEXT = {
  executionProfile: 'verified-local',
  missingCapabilities: [
    'protected-host-control-plane',
    'isolated-agent-and-qa-vms',
    'isolated-check-vm',
    'authenticated-runner-evidence',
    'revision-bound-local-delivery',
  ],
};
const BASE_SETTINGS = {
  approvalMode: 'CONTROL',
  speedModeDelayMs: 2000,
  autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  agentCommand: 'claude',
};
const STARTED = '2026-10-24T12:00:00.000Z';

const h = new ToolTestHarness();

beforeEach(() => h.init());
afterEach(async () => {
  for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
  activeWaiters.clear();
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

const withSnapshot = (row: Row, snapshot: unknown): Row =>
  snapshot === undefined ? row : { ...row, executionPolicySnapshot: snapshot };

const attempt = (id: string, taskId: string, workerId: string, phase: string, extra: Row = {}): Row => ({
  id, taskId, workerId, runnerId: workerId, generation: 1, workspace: '/old/checkout',
  phase, startedAt: STARTED, lastPhaseAt: STARTED, ...extra,
});

/** Raw settings, epics, tasks, live workers and attempt records on disk, then load. */
async function seed(
  tasks: Row[],
  opts: { settings?: Row; workers?: Row[]; attempts?: Row[] } = {}
): Promise<void> {
  h.setupMoeFolder({ settings: { ...BASE_SETTINGS, ...opts.settings } } as unknown as Partial<Project>);
  h.createEpic();
  h.createEpic({ id: 'epic-2' });
  for (const task of tasks) h.createTask({ status: 'WORKING', planRevision: 1, ...task } as Partial<Task>);
  for (const worker of opts.workers ?? []) h.createWorker(worker);
  if (opts.attempts?.length) fs.mkdirSync(path.join(h.moePath, 'attempts'), { recursive: true });
  for (const record of opts.attempts ?? []) {
    fs.writeFileSync(path.join(h.moePath, 'attempts', `${String(record.id)}.json`), JSON.stringify(record, null, 2));
  }
  await h.state.load();
}

const claim = async (args: Row): Promise<Row> =>
  (await claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], ...args }, h.state)) as Row;

const wait = async (workerId: string, statuses: string[] = ['WORKING']): Promise<Row> =>
  (await waitForTaskTool(h.state).handler({ statuses, workerId, timeoutMs: 1000 }, h.state)) as Row;

const taskOf = (result: Row): Row => result.task as Row;

function dirBytes(kind: string): Record<string, string> {
  const dir = path.join(h.moePath, kind);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

function board(): string {
  return JSON.stringify({
    tasks: dirBytes('tasks'),
    attempts: dirBytes('attempts'),
    workers: dirBytes('workers'),
    workerMap: Array.from(h.state.workers.entries()),
  });
}

/** Runs `act` and requires that it wrote, published and registered nothing. */
async function unchanged(act: () => Promise<unknown>): Promise<{ result?: unknown; error?: unknown }> {
  const before = board();
  const writes = vi.spyOn(h.state, 'writeEntity');
  const events: string[] = [];
  const unsubscribe = h.state.subscribe((event) => { events.push(event.type); });
  let outcome: { result?: unknown; error?: unknown };
  try {
    outcome = { result: await act() };
  } catch (error: unknown) {
    outcome = { error };
  } finally {
    unsubscribe();
  }
  expect(events).toEqual([]);
  expect(writes).not.toHaveBeenCalled();
  writes.mockRestore();
  expect(board()).toBe(before);
  return outcome;
}

/** A refusal with this codeName, and no side effect at all. */
async function noSideEffects(act: () => Promise<unknown>, codeName: string): Promise<MoeError> {
  const { error } = await unchanged(act);
  expect(error).toBeInstanceOf(MoeError);
  const refusal = error as MoeError;
  expect(refusal.codeName).toBe(codeName);
  return refusal;
}

async function expectNotReady(act: () => Promise<unknown>): Promise<void> {
  const refusal = await noSideEffects(act, NOT_READY);
  expect(refusal.context).toEqual(NOT_READY_CONTEXT);
}

describe('E explicit claims of an unready profile are refused before any side effect', () => {
  const sources: [string, unknown, Row][] = [
    ['hand-edited verified-local settings, no snapshot', undefined, { executionProfile: 'verified-local' }],
    ['a stored STRICT snapshot under rolled-back legacy settings', STRICT, { executionProfile: 'legacy' }],
    ['a stored v1 verified-local snapshot', STRICT_V1, {}],
  ];
  const callers: [string, Row][] = [
    ['a new workerId', { workerId: 'worker-new' }],
    ['no workerId', {}],
    ['a workerId with a runner identity', { workerId: 'worker-new', processStartedAt: '41@tok', host: 'box' }],
  ];
  for (const [source, snapshot, settings] of sources) {
    it.each(callers)(`E1 ${source}: refused for %s`, async (_label, caller) => {
      await seed([withSnapshot({ id: 'task-1' }, snapshot)], { settings });

      await expectNotReady(() => claim({ taskId: 'task-1', ...caller }));
    });
  }

  it('E2 replaceExisting on a strict row a live worker holds is refused: no eviction, its attempt stays open', async () => {
    await seed([withSnapshot({ id: 'task-1', assignedWorkerId: 'worker-b' }, STRICT)], {
      workers: [{ id: 'worker-b', currentTaskId: 'task-1', status: 'CODING' }],
      attempts: [attempt('attempt-b', 'task-1', 'worker-b', 'running', { executionPolicySnapshot: STRICT })],
    });

    await expectNotReady(() => claim({ taskId: 'task-1', workerId: 'worker-a', replaceExisting: true }));

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-b');
    expect(listAttempts(h.state, 'task-1').map((a) => a.phase)).toEqual(['running']);
  });

  it('E3 a strict row with a released seat\'s leftover running attempt is refused and the leftover is not closed', async () => {
    await seed([withSnapshot({ id: 'task-1' }, STRICT)], {
      attempts: [attempt('attempt-old', 'task-1', 'worker-old', 'running')],
    });

    await expectNotReady(() => claim({ taskId: 'task-1', workerId: 'worker-a' }));

    expect(listAttempts(h.state, 'task-1').map((a) => a.phase)).toEqual(['running']);
  });

  it.each([
    ['a null snapshot', null, {}, 'executionPolicySnapshot'],
    ['a version 3 snapshot', { ...STRICT, version: 3 }, {}, 'executionPolicySnapshot.version'],
    ['a snapshot with an extra key', { ...LEGACY, ready: true }, {}, 'executionPolicySnapshot'],
    ['an upper-case executionProfile setting', undefined, { executionProfile: 'VERIFIED-LOCAL' }, 'executionProfile'],
  ])('E4 %s is refused INVALID_INPUT naming the field, with no side effects', async (_label, snapshot, settings, field) => {
    await seed([withSnapshot({ id: 'task-1' }, snapshot)], { settings });

    for (const caller of [{ workerId: 'worker-new' }, {}]) {
      const refusal = await noSideEffects(() => claim({ taskId: 'task-1', ...caller }), 'INVALID_INPUT');
      expect((refusal.context as Row).field).toBe(field);
    }
  });

  it.each([
    ['strict', STRICT],
    ['legacy (C2)', undefined],
  ])('E5/C2 a %s row held by reconciliation keeps the existing reconciliation refusal', async (_label, snapshot) => {
    await seed([withSnapshot({ id: 'task-1', assignedWorkerId: 'worker-b' }, snapshot)], {
      workers: [{ id: 'worker-b', currentTaskId: 'task-1', status: 'CODING' }],
      attempts: [attempt('attempt-b', 'task-1', 'worker-b', 'reconciling')],
    });

    await noSideEffects(() => claim({ taskId: 'task-1', workerId: 'worker-a' }), 'ATTEMPT_RECONCILING');
  });

  it.each([
    ['strict', STRICT],
    ['legacy (C2)', undefined],
  ])('E5/C2 a %s row with a foreign finalizing attempt keeps ATTEMPT_FINALIZING, and the ranked pool skips it', async (_label, snapshot) => {
    await seed([withSnapshot({ id: 'task-1', status: 'REVIEW' }, snapshot)], {
      workers: [{ id: 'worker-b' }],
      attempts: [attempt('attempt-b', 'task-1', 'worker-b', 'finalizing')],
    });

    await noSideEffects(() => claim({ statuses: ['REVIEW'], taskId: 'task-1', workerId: 'qa-1' }), 'ATTEMPT_FINALIZING');
    const { result } = await unchanged(() => claim({ statuses: ['REVIEW'], workerId: 'qa-1' }));
    expect((result as Row).hasNext).toBe(false);
  });
});

describe('R own-seat resume cannot bypass a stored strict profile', () => {
  const ownSeat = (taskSnapshot: unknown, attemptExtra: Row = {}) =>
    seed([withSnapshot({ id: 'task-1', assignedWorkerId: 'worker-a' }, taskSnapshot)], {
      workers: [{ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' }],
      attempts: [attempt('attempt-own', 'task-1', 'worker-a', 'running', attemptExtra)],
    });

  it('R1 a STRICT task snapshot under rolled-back legacy settings refuses the resume; attempt and seat are kept', async () => {
    await ownSeat(STRICT);

    await expectNotReady(() => claim({ taskId: 'task-1', workerId: 'worker-a' }));

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
    expect(listAttempts(h.state, 'task-1').map((a) => [a.id, a.phase])).toEqual([['attempt-own', 'running']]);
  });

  it('R2 a legacy task whose own open attempt recorded verified-local refuses the resume', async () => {
    await ownSeat(LEGACY, { executionPolicySnapshot: STRICT });

    await expectNotReady(() => claim({ taskId: 'task-1', workerId: 'worker-a' }));
  });

  it('R2 a malformed own-attempt snapshot refuses the resume INVALID_INPUT', async () => {
    await ownSeat(LEGACY, { executionPolicySnapshot: { ...LEGACY, version: 3 } });

    const refusal = await noSideEffects(() => claim({ taskId: 'task-1', workerId: 'worker-a' }), 'INVALID_INPUT');
    expect((refusal.context as Row).field).toBe('executionPolicySnapshot.version');
  });

  it('R2 an own attempt without a snapshot on a legacy task resumes exactly as before', async () => {
    await ownSeat(LEGACY);
    const bytes = dirBytes('attempts');

    const result = await claim({ taskId: 'task-1', workerId: 'worker-a' });

    expect(result).toMatchObject({ hasNext: true, attemptId: 'attempt-own', generation: 1 });
    expect(dirBytes('attempts')).toEqual(bytes);
  });

  it('R2 a non-own leftover attempt\'s strict snapshot is never consulted: the successor claims a legacy row', async () => {
    await seed([withSnapshot({ id: 'task-1' }, LEGACY)], {
      attempts: [attempt('attempt-old', 'task-1', 'worker-old', 'running', { executionPolicySnapshot: STRICT })],
    });

    const result = await claim({ taskId: 'task-1', workerId: 'worker-a' });

    expect(result).toMatchObject({ hasNext: true, generation: 2 });
    expect(listAttempts(h.state, 'task-1').map((a) => [a.id, a.phase])).toEqual([
      ['attempt-old', 'closed'],
      [result.attemptId, 'running'],
    ]);
  });

  it('R3 the seat\'s ranked claim while it holds a strict task returns the unchanged alreadyAssigned answer, writing nothing', async () => {
    await seed([
      withSnapshot({ id: 'task-1', assignedWorkerId: 'worker-a' }, STRICT),
      withSnapshot({ id: 'task-2', assignedWorkerId: 'worker-b', epicId: 'epic-2' }, LEGACY),
    ], {
      workers: [
        { id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' },
        { id: 'worker-b', currentTaskId: 'task-2', status: 'CODING' },
      ],
    });

    const strict = (await unchanged(() => claim({ workerId: 'worker-a' }))).result as Row;
    const legacy = (await unchanged(() => claim({ workerId: 'worker-b' }))).result as Row;

    expect(strict).toMatchObject({ hasNext: false, alreadyAssigned: { taskId: 'task-1', status: 'WORKING' } });
    expect((strict.nextAction as Row).tool).toBe('moe.get_context');
    expect(Object.keys(strict).sort()).toEqual(Object.keys(legacy).sort());
  });
});

describe('P the ranked claim and the waiter agree on eligibility', () => {
  it('P1 the waiter offers the LOW legacy row over a CRITICAL strict one, and the ranked claim takes that same row', async () => {
    await seed([
      withSnapshot({ id: 'task-strict', priority: 'CRITICAL', order: 1 }, STRICT),
      withSnapshot({ id: 'task-legacy', priority: 'LOW', order: 2 }, LEGACY),
    ], { workers: [{ id: 'worker-b' }] });

    const woke = await wait('worker-b');
    const claimed = await claim({ workerId: 'worker-b' });

    expect(woke.hasNext).toBe(true);
    expect(taskOf(woke).id).toBe('task-legacy');
    expect(claimed.hasNext).toBe(true);
    expect(taskOf(claimed).id).toBe('task-legacy');
    expect(h.state.getTask('task-strict')!.assignedWorkerId).toBeNull();
    expect(listAttempts(h.state, 'task-strict')).toEqual([]);
  });

  it('P2 with only strict or malformed candidates the ranked claim writes nothing and the waiter sleeps through their updates', async () => {
    await seed([
      withSnapshot({ id: 'task-strict', priority: 'CRITICAL' }, STRICT),
      withSnapshot({ id: 'task-bad', epicId: 'epic-2' }, { ...LEGACY, version: 3 }),
    ], { workers: [{ id: 'worker-b' }] });

    const { result } = await unchanged(() => claim({ workerId: 'worker-b' }));
    expect(result).toMatchObject({ hasNext: false, nextAction: { tool: 'moe.wait_for_task' } });

    const waiting = wait('worker-b');
    await vi.waitFor(() => expect(activeWaiters.has('worker-b')).toBe(true));
    await h.state.updateTask('task-strict', { title: 'Renamed while waiting' });
    const woke = await waiting;

    expect(woke).toMatchObject({ hasNext: false, timedOut: true, nextAction: { tool: 'moe.wait_for_task' } });
    expect(woke.task).toBeUndefined();
  });

  it('P3 verified-local settings hide every column from both tools; a rollback re-admits only the non-strict rows', async () => {
    await seed([
      withSnapshot({ id: 'task-strict', priority: 'CRITICAL' }, STRICT),
      withSnapshot({ id: 'task-plan', status: 'PLANNING', priority: 'HIGH' }, undefined),
      withSnapshot({ id: 'task-work', epicId: 'epic-2' }, LEGACY),
      withSnapshot({ id: 'task-review', status: 'REVIEW', priority: 'LOW' }, OBSERVE),
    ], { settings: { executionProfile: 'verified-local' }, workers: [{ id: 'worker-b' }, { id: 'worker-c' }] });
    const all = ['PLANNING', 'WORKING', 'REVIEW'];

    const { result } = await unchanged(() => claim({ statuses: all, workerId: 'worker-b' }));
    expect((result as Row).hasNext).toBe(false);
    expect(await wait('worker-b', all)).toMatchObject({ hasNext: false, timedOut: true });

    await h.state.updateSettings({ executionProfile: 'legacy' });
    const woke = await wait('worker-b', all);
    const claimed = await claim({ statuses: all, workerId: 'worker-b' });

    expect(taskOf(woke).id).toBe('task-plan');
    expect(taskOf(claimed).id).toBe('task-plan');
    await expectNotReady(() => claim({ statuses: all, taskId: 'task-strict', workerId: 'worker-c' }));
  });

  it('P4 a seat holding a strict row is not woken for it; holding a legacy row it still wakes at once', async () => {
    await seed([
      withSnapshot({ id: 'task-strict', assignedWorkerId: 'worker-a' }, STRICT),
      withSnapshot({ id: 'task-legacy', assignedWorkerId: 'worker-b', epicId: 'epic-2' }, LEGACY),
    ], {
      workers: [
        { id: 'worker-a', currentTaskId: 'task-strict', status: 'CODING' },
        { id: 'worker-b', currentTaskId: 'task-legacy', status: 'CODING' },
      ],
    });

    const strict = await wait('worker-a');
    const legacy = await wait('worker-b');

    expect(strict).toMatchObject({ hasNext: false, timedOut: true, alreadyAssigned: { taskId: 'task-strict' } });
    expect(strict.task).toBeUndefined();
    expect(legacy).toMatchObject({ hasNext: true, task: { id: 'task-legacy' } });
  });
});

describe('C absent, legacy and observe admission is unchanged', () => {
  const snapshots: [string, unknown][] = [['absent', undefined], ['legacy', LEGACY], ['observe', OBSERVE]];
  for (const profile of ['legacy', 'observe']) {
    it.each(snapshots)(`C1 an %s snapshot under ${profile} settings: wake, ranked claim, resume and explicit claim all admit`, async (_label, snapshot) => {
      await seed([
        withSnapshot({ id: 'task-a', order: 1 }, snapshot),
        withSnapshot({ id: 'task-b', epicId: 'epic-2', order: 2 }, snapshot),
      ], { settings: { executionProfile: profile }, workers: [{ id: 'worker-a' }, { id: 'worker-b' }] });

      const woke = await wait('worker-a');
      const ranked = await claim({ workerId: 'worker-a' });
      const resumed = await claim({ taskId: 'task-a', workerId: 'worker-a' });
      const ownWake = await wait('worker-a');
      const explicit = await claim({ taskId: 'task-b', workerId: 'worker-b' });

      expect(taskOf(woke).id).toBe('task-a');
      expect(ranked).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-a' } });
      expect(resumed).toMatchObject({ hasNext: true, attemptId: ranked.attemptId, generation: 1 });
      expect(ownWake).toMatchObject({ hasNext: true, task: { id: 'task-a' } });
      expect(explicit).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-b' } });
      expect(listAttempts(h.state).map((a) => [a.taskId, a.phase])).toEqual([['task-a', 'running'], ['task-b', 'running']]);
    });
  }
});

describe('N no fallback grants readiness; cleanup and diagnostics stay usable', () => {
  it('N1 an environment flag and injected claim arguments neither admit nor rank a strict row', async () => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    vi.stubEnv('MOE_EXECUTION_PROFILE', 'legacy');
    await seed([withSnapshot({ id: 'task-1' }, STRICT)], { workers: [{ id: 'worker-a' }] });
    const injected = { ready: true, executionProfile: 'legacy', executionPolicySnapshot: LEGACY };

    await expectNotReady(() => claim({ taskId: 'task-1', workerId: 'worker-a', ...injected }));
    const { result } = await unchanged(() => claim({ workerId: 'worker-a', ...injected }));
    expect((result as Row).hasNext).toBe(false);
  });

  const heldStrict = () => seed([withSnapshot({ id: 'task-1', assignedWorkerId: 'worker-a' }, STRICT)], {
    settings: { executionProfile: 'verified-local' },
    workers: [{ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' }],
    attempts: [attempt('attempt-a', 'task-1', 'worker-a', 'running', { executionPolicySnapshot: STRICT })],
  });

  it('N2 get_context and list_tasks read a strict row', async () => {
    await heldStrict();

    const context = (await getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-a' }, h.state)) as Row;
    const listed = (await listTasksTool(h.state).handler({}, h.state)) as { tasks: Row[] };

    expect(taskOf(context).id).toBe('task-1');
    expect(listed.tasks.map((t) => t.id)).toEqual(['task-1']);
  });

  it('N2 releaseWorkerTasks frees the seat holding a strict row', async () => {
    await heldStrict();

    await releaseWorkerTasks(h.state, 'worker-a', 'test release');

    expect(h.state.getTask('task-1')).toMatchObject({ assignedWorkerId: null, status: 'WORKING' });
  });

  it('N2 release_task by its assignee frees the strict row', async () => {
    await heldStrict();

    await releaseTaskTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-a', reason: 'cleanup' }, h.state);

    expect(h.state.getTask('task-1')).toMatchObject({ assignedWorkerId: null, status: 'WORKING' });
  });
});

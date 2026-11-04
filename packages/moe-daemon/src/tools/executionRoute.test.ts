// =============================================================================
// CQ-M07q: a verified-local WORKING or REVIEW row is claimable only by a seat
// that marks its claim `executionRoute: 'vm'`. The marker is read by the ONE
// admission predicate (util/claimEligibility.ts), AFTER readiness, and can only
// refuse: explicit claims throw EXECUTION_ROUTE_REQUIRED, the ranked pool and
// wait_for_task skip the row. Real handlers over a temp .moe folder.
//
// Readiness is mocked ready through a toggle (mem:convention-verified-local-test-
// fixture); with the toggle off the real assertion runs, which is how the tests
// show the marker never stands in for readiness. Strict rows exist only as
// hand-edited JSON (update_settings refuses verified-local), so these tests
// seed raw records.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
import { listAttempts } from '../state/attemptStore.js';
import { parseExecutionRoute } from '../util/claimEligibility.js';
import { MoeError } from '../util/errors.js';
import type { Project, Task } from '../types/schema.js';

const readiness = vi.hoisted(() => ({ mockedReady: true }));

vi.mock('../delivery/executionProfile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../delivery/executionProfile.js')>();
  return {
    ...actual,
    assertExecutionProfileReady: (profile: unknown): void => {
      if (!readiness.mockedReady) actual.assertExecutionProfileReady(profile);
    },
  };
});

type Row = Record<string, unknown>;

const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const LEGACY = { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' };
const OBSERVE = { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'local-branch' };
const ROUTE_REQUIRED = 'EXECUTION_ROUTE_REQUIRED';
const NOT_READY = 'EXECUTION_PROFILE_NOT_READY';
const BASE_SETTINGS = {
  approvalMode: 'CONTROL',
  speedModeDelayMs: 2000,
  autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  agentCommand: 'claude',
};
const STARTED = '2026-11-01T10:00:00.000Z';
const STATUSES = ['WORKING', 'REVIEW'] as const;
const SEATS = { WORKING: 'worker-a', REVIEW: 'qa-a' } as const;
const strictContext = (taskId: string, status: string): Row => ({
  taskId, status, executionProfile: 'verified-local', requiredRoute: 'vm',
});

const h = new ToolTestHarness();

beforeEach(() => {
  readiness.mockedReady = true;
  h.init();
});
afterEach(async () => {
  for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
  activeWaiters.clear();
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  vi.restoreAllMocks();
  h.cleanup();
});

const withSnapshot = (row: Row, snapshot: unknown): Row =>
  snapshot === undefined ? row : { ...row, executionPolicySnapshot: snapshot };

const attempt = (id: string, taskId: string, workerId: string, extra: Row = {}): Row => ({
  id, taskId, workerId, runnerId: workerId, generation: 1, workspace: '/old/checkout',
  phase: 'running', startedAt: STARTED, lastPhaseAt: STARTED, ...extra,
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

const waitWith = async (args: Row): Promise<Row> =>
  (await waitForTaskTool(h.state).handler({ statuses: ['WORKING'], timeoutMs: 1000, ...args }, h.state)) as Row;

const taskOf = (result: Row): Row => result.task as Row;

function dirBytes(kind: string): Record<string, string> {
  const dir = path.join(h.moePath, kind);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

function board(): string {
  return JSON.stringify({
    tasks: dirBytes('tasks'), attempts: dirBytes('attempts'), workers: dirBytes('workers'),
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
async function refused(act: () => Promise<unknown>, codeName: string): Promise<MoeError> {
  const { error } = await unchanged(act);
  expect(error).toBeInstanceOf(MoeError);
  expect((error as MoeError).codeName).toBe(codeName);
  return error as MoeError;
}

describe('S a strict WORKING or REVIEW row needs the VM route', () => {
  describe.each(STATUSES)('%s', (status) => {
    const seat = SEATS[status];
    const strictRow = (extra: Row = {}): Row => withSnapshot({ id: 'task-strict', status, ...extra }, STRICT);

    it('S1 an explicit claim with executionRoute vm succeeds: assigned, one running attempt', async () => {
      await seed([strictRow()]);

      const result = await claim({ statuses: [status], taskId: 'task-strict', workerId: seat, executionRoute: 'vm' });

      expect(result).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-strict', status } });
      expect(h.state.getTask('task-strict')!.assignedWorkerId).toBe(seat);
      expect(listAttempts(h.state, 'task-strict').map((a) => [a.workerId, a.phase])).toEqual([[seat, 'running']]);
    });

    it('S2 the same claim without the marker throws EXECUTION_ROUTE_REQUIRED and writes nothing', async () => {
      await seed([strictRow()]);

      const refusal = await refused(
        () => claim({ statuses: [status], taskId: 'task-strict', workerId: seat }), ROUTE_REQUIRED);

      expect(refusal.context).toEqual(strictContext('task-strict', status));
      expect(refusal.message).toContain('VM-route seat');
      expect(h.state.getTask('task-strict')!.assignedWorkerId).toBeNull();
      expect(listAttempts(h.state, 'task-strict')).toEqual([]);
    });

    it('S2 an explicit claim with no workerId is refused too, without a marker', async () => {
      await seed([strictRow()]);

      await refused(() => claim({ statuses: [status], taskId: 'task-strict' }), ROUTE_REQUIRED);
    });

    it('S3 with only the strict row, the unmarked ranked pool skips it and writes nothing; marked takes it', async () => {
      await seed([strictRow()], { workers: [{ id: seat }] });

      const skipped = (await unchanged(() => claim({ statuses: [status], workerId: seat }))).result as Row;
      expect(skipped).toMatchObject({ hasNext: false, nextAction: { tool: 'moe.wait_for_task' } });
      const marked = await claim({ statuses: [status], workerId: seat, executionRoute: 'vm' });

      expect(marked).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-strict', status } });
      expect(h.state.getTask('task-strict')!.assignedWorkerId).toBe(seat);
    });

    it('S3 with the marker the CRITICAL strict row outranks the LOW legacy row', async () => {
      await seed([
        strictRow({ priority: 'CRITICAL' }),
        withSnapshot({ id: 'task-legacy', status, epicId: 'epic-2', priority: 'LOW' }, LEGACY),
      ], { workers: [{ id: seat }] });

      const marked = await claim({ statuses: [status], workerId: seat, executionRoute: 'vm' });

      expect(taskOf(marked).id).toBe('task-strict');
      expect(h.state.getTask('task-legacy')!.assignedWorkerId).toBeNull();
    });

    it('S3 without the marker the pool still serves the legacy row', async () => {
      await seed([
        strictRow({ priority: 'CRITICAL' }),
        withSnapshot({ id: 'task-legacy', status, epicId: 'epic-2', priority: 'LOW' }, LEGACY),
      ], { workers: [{ id: seat }] });

      const claimed = await claim({ statuses: [status], workerId: seat });

      expect(taskOf(claimed)).toMatchObject({ id: 'task-legacy', status });
      expect(h.state.getTask('task-strict')!.assignedWorkerId).toBeNull();
    });

    it('S4 the own seat resuming its held strict row needs the marker too, and keeps its attempt', async () => {
      await seed([strictRow({ assignedWorkerId: seat })], {
        workers: [{ id: seat, currentTaskId: 'task-strict', status: 'CODING' }],
        attempts: [attempt('attempt-own', 'task-strict', seat, { executionPolicySnapshot: STRICT })],
      });

      await refused(() => claim({ statuses: [status], taskId: 'task-strict', workerId: seat }), ROUTE_REQUIRED);
      const resumed = await claim({ statuses: [status], taskId: 'task-strict', workerId: seat, executionRoute: 'vm' });

      expect(resumed).toMatchObject({ hasNext: true, attemptId: 'attempt-own', generation: 1 });
      expect(listAttempts(h.state, 'task-strict').map((a) => [a.id, a.phase])).toEqual([['attempt-own', 'running']]);
    });

    it('S4 a legacy row whose own attempt recorded verified-local is strict for that seat', async () => {
      await seed([withSnapshot({ id: 'task-legacy', status, assignedWorkerId: seat }, LEGACY)], {
        workers: [{ id: seat, currentTaskId: 'task-legacy', status: 'CODING' }],
        attempts: [attempt('attempt-own', 'task-legacy', seat, { executionPolicySnapshot: STRICT })],
      });

      await refused(() => claim({ statuses: [status], taskId: 'task-legacy', workerId: seat }), ROUTE_REQUIRED);
      const resumed = await claim({ statuses: [status], taskId: 'task-legacy', workerId: seat, executionRoute: 'vm' });

      expect(resumed).toMatchObject({ hasNext: true, attemptId: 'attempt-own' });
    });

    it('S5 hand-edited verified-local settings without a snapshot are strict too', async () => {
      await seed([{ id: 'task-plain', status }], { settings: { executionProfile: 'verified-local' } });

      const refusal = await refused(
        () => claim({ statuses: [status], taskId: 'task-plain', workerId: seat }), ROUTE_REQUIRED);
      expect(refusal.context).toEqual(strictContext('task-plain', status));
      const claimed = await claim({ statuses: [status], taskId: 'task-plain', workerId: seat, executionRoute: 'vm' });

      expect(taskOf(claimed).id).toBe('task-plain');
    });
  });

  it('S6 the marker skips no other check: unmet dependsOn and a foreign finalizing hold still refuse and skip', async () => {
    await seed([
      withSnapshot({ id: 'task-dep', status: 'WORKING', epicId: 'epic-2', dependsOn: ['task-open'] }, STRICT),
      withSnapshot({ id: 'task-open', status: 'WORKING', epicId: 'epic-2', assignedWorkerId: 'worker-x' }, LEGACY),
      withSnapshot({ id: 'task-held', status: 'REVIEW' }, STRICT),
    ], {
      workers: [
        { id: 'worker-x', currentTaskId: 'task-open', status: 'CODING' },
        { id: 'worker-a' }, { id: 'worker-b' }, { id: 'qa-a' },
      ],
      attempts: [attempt('attempt-b', 'task-held', 'worker-b', { phase: 'finalizing' })],
    });

    const dep = await refused(
      () => claim({ taskId: 'task-dep', workerId: 'worker-a', executionRoute: 'vm' }), 'NOT_ALLOWED');
    expect(dep.message).toContain('unmet dependencies');
    await refused(
      () => claim({ statuses: ['REVIEW'], taskId: 'task-held', workerId: 'qa-a', executionRoute: 'vm' }),
      'ATTEMPT_FINALIZING');
    const pool = (await unchanged(() => claim({ workerId: 'worker-a', executionRoute: 'vm' }))).result as Row;
    expect(pool.hasNext).toBe(false);
  });
});

describe('W wait_for_task reads the same predicate with the same route', () => {
  const strictHeldByPeer = () => seed([withSnapshot({ id: 'task-strict', assignedWorkerId: 'worker-x' }, STRICT)], {
    workers: [{ id: 'worker-x', currentTaskId: 'task-strict', status: 'CODING' }, { id: 'worker-b' }, { id: 'worker-c' }],
  });

  it('W1 a waiter without the marker is not offered the strict row; one with it is, and its hint carries the route', async () => {
    await seed([withSnapshot({ id: 'task-strict' }, STRICT)], { workers: [{ id: 'worker-b' }, { id: 'worker-c' }] });

    const unmarked = await waitWith({ workerId: 'worker-b' });
    const marked = await waitWith({ workerId: 'worker-c', executionRoute: 'vm' });

    expect(unmarked).toMatchObject({ hasNext: false, timedOut: true, nextAction: { tool: 'moe.wait_for_task' } });
    expect(unmarked.task).toBeUndefined();
    expect((unmarked.nextAction as Row).args).not.toHaveProperty('executionRoute');
    expect(marked).toMatchObject({
      hasNext: true,
      task: { id: 'task-strict', status: 'WORKING' },
      nextAction: { tool: 'moe.claim_next_task', args: { statuses: ['WORKING'], workerId: 'worker-c', executionRoute: 'vm' } },
    });
  });

  it('W2 a TASK_UPDATED re-match wakes the marked waiter only, and its hint claims with the same route', async () => {
    await strictHeldByPeer();

    const unmarked = waitWith({ workerId: 'worker-b' });
    const marked = waitWith({ workerId: 'worker-c', executionRoute: 'vm' });
    await vi.waitFor(() => expect([...activeWaiters.keys()].sort()).toEqual(['worker-b', 'worker-c']));
    await h.state.updateTask('task-strict', { assignedWorkerId: null });

    expect(await marked).toMatchObject({
      hasNext: true,
      task: { id: 'task-strict' },
      nextAction: { tool: 'moe.claim_next_task', args: { workerId: 'worker-c', executionRoute: 'vm' } },
    });
    expect(await unmarked).toMatchObject({ hasNext: false, timedOut: true });
  });

  it('W3 the timeout hint of a marked waiter keeps the route', async () => {
    await strictHeldByPeer();

    const result = await waitWith({ workerId: 'worker-c', executionRoute: 'vm' });

    expect(result).toMatchObject({
      hasNext: false, timedOut: true,
      nextAction: { tool: 'moe.wait_for_task', args: { workerId: 'worker-c', executionRoute: 'vm' } },
    });
  });

  it('W4 the own-held match needs the marker: the unmarked seat parks, the marked one wakes at once', async () => {
    await seed([withSnapshot({ id: 'task-strict', assignedWorkerId: 'worker-a' }, STRICT)], {
      workers: [{ id: 'worker-a', currentTaskId: 'task-strict', status: 'CODING' }],
      attempts: [attempt('attempt-own', 'task-strict', 'worker-a', { executionPolicySnapshot: STRICT })],
    });

    const unmarked = await waitWith({ workerId: 'worker-a' });
    const marked = await waitWith({ workerId: 'worker-a', executionRoute: 'vm' });

    expect(unmarked).toMatchObject({ hasNext: false, timedOut: true, alreadyAssigned: { taskId: 'task-strict' } });
    expect(unmarked.task).toBeUndefined();
    expect(marked).toMatchObject({ hasNext: true, task: { id: 'task-strict' } });
  });
});

describe('U PLANNING, legacy and observe claims are unchanged with or without the marker', () => {
  const markers: [string, string | undefined][] = [['no marker', undefined], ['marker vm', 'vm']];
  const route = (marker: string | undefined): Row => (marker ? { executionRoute: marker } : {});

  it.each(markers)('U1 a strict PLANNING row is claimed by an architect, explicit and ranked: %s', async (_label, marker) => {
    await seed([
      withSnapshot({ id: 'task-p1', status: 'PLANNING' }, STRICT),
      withSnapshot({ id: 'task-p2', status: 'PLANNING', epicId: 'epic-2' }, STRICT),
    ], { workers: [{ id: 'architect-a' }, { id: 'architect-b' }] });

    const explicit = await claim({ statuses: ['PLANNING'], taskId: 'task-p1', workerId: 'architect-a', ...route(marker) });
    const ranked = await claim({ statuses: ['PLANNING'], workerId: 'architect-b', ...route(marker) });

    expect(explicit).toMatchObject({ hasNext: true, task: { id: 'task-p1', status: 'PLANNING' } });
    expect(ranked).toMatchObject({ hasNext: true, task: { id: 'task-p2', status: 'PLANNING' } });
  });

  const kinds: [string, string, unknown][] = [
    ['legacy', 'legacy', LEGACY], ['observe', 'observe', OBSERVE], ['legacy, no snapshot', 'legacy', undefined],
  ];
  const seatsOf = { WORKING: ['worker-a', 'worker-b'], REVIEW: ['qa-a', 'qa-b'] } as const;
  for (const status of STATUSES) {
    it.each(kinds.flatMap(([kind, profile, snapshot]) => markers.map(([label, marker]) => [kind, label, profile, snapshot, marker] as const)))(
      `U2 a %s ${status} row: explicit and ranked claims admit exactly as before (%s)`,
      async (_kind, _label, profile, snapshot, marker) => {
        const [one, two] = seatsOf[status];
        await seed([
          withSnapshot({ id: 'task-a', status, order: 1 }, snapshot),
          withSnapshot({ id: 'task-b', status, epicId: 'epic-2', order: 2 }, snapshot),
        ], { settings: { executionProfile: profile }, workers: [{ id: one }, { id: two }] });

        const explicit = await claim({ statuses: [status], taskId: 'task-a', workerId: one, ...route(marker) });
        const ranked = await claim({ statuses: [status], workerId: two, ...route(marker) });

        expect(explicit).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-a', status } });
        expect(ranked).toMatchObject({ hasNext: true, generation: 1, task: { id: 'task-b', status } });
        expect(listAttempts(h.state).map((a) => [a.taskId, a.phase])).toEqual([['task-a', 'running'], ['task-b', 'running']]);
      }
    );
  }
});

describe('R the marker never stands in for readiness', () => {
  beforeEach(() => { readiness.mockedReady = false; });

  it('R1 the real assertion refuses verified-local with EXECUTION_PROFILE_NOT_READY', async () => {
    const actual = await vi.importActual<typeof import('../delivery/executionProfile.js')>('../delivery/executionProfile.js');

    expect(() => actual.assertExecutionProfileReady('verified-local')).toThrowError(
      expect.objectContaining({ codeName: NOT_READY }));
  });

  it.each(STATUSES)('R2 a marked strict %s claim is refused NOT_READY, explicit and ranked, with and without the marker', async (status) => {
    const seat = SEATS[status];
    await seed([withSnapshot({ id: 'task-strict', status }, STRICT)], { workers: [{ id: seat }] });

    for (const marker of [{ executionRoute: 'vm' }, {}]) {
      const refusal = await refused(() => claim({ statuses: [status], taskId: 'task-strict', workerId: seat, ...marker }), NOT_READY);
      expect((refusal.context as Row).executionProfile).toBe('verified-local');
      const pool = (await unchanged(() => claim({ statuses: [status], workerId: seat, ...marker }))).result as Row;
      expect(pool.hasNext).toBe(false);
    }
  });
});

describe('I any other executionRoute is INVALID_INPUT before any write', () => {
  it('I1 parseExecutionRoute: absent stays absent, vm passes', () => {
    expect(parseExecutionRoute(undefined)).toBeUndefined();
    expect(parseExecutionRoute('vm')).toBe('vm');
  });

  it.each([['host', 'host'], ['VM', 'VM'], ['empty', ''], ['null', null], ['a number', 1], ['an object', {}]])(
    'I2 %s is refused by claim_next_task (explicit and ranked) and wait_for_task',
    async (_label, bad) => {
      await seed([withSnapshot({ id: 'task-legacy' }, LEGACY)], { workers: [{ id: 'worker-b' }] });

      const explicit = await refused(
        () => claim({ taskId: 'task-legacy', workerId: 'worker-b', executionRoute: bad }), 'INVALID_INPUT');
      await refused(() => claim({ workerId: 'worker-b', executionRoute: bad }), 'INVALID_INPUT');
      await refused(() => waitWith({ workerId: 'worker-b', executionRoute: bad }), 'INVALID_INPUT');

      expect((explicit.context as Row).field).toBe('executionRoute');
      expect(activeWaiters.size).toBe(0);
      expect(h.state.getTask('task-legacy')!.assignedWorkerId).toBeNull();
    }
  );
});

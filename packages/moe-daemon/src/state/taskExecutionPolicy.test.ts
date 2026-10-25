// =============================================================================
// CQ-M01c: the daemon-owned Task.executionPolicySnapshot and the store-level
// strict-progression backstop, exercised through a real StateManager over a
// temp .moe folder and the real submit_plan handler.
//
// update_settings refuses verified-local on purpose, so strict rows and strict
// settings exist only as hand-edited records: these tests seed raw JSON. A
// snapshot is configuration identity only. Nothing here reads it as approval,
// readiness or runner trust, and no case expects one to grant anything.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { clearAllSpeedModeTimeouts, submitPlanTool } from '../tools/submitPlan.js';
import { getContextTool } from '../tools/getContext.js';
import { listTasksTool } from '../tools/listTasks.js';
import { MoeError } from '../util/errors.js';
import { StateManager } from './StateManager.js';
import { releaseWorkerTasks } from './workerLifecycle.js';
// A namespace import, so a missing export fails only the cases that call it.
import * as taskStore from './taskStore.js';
import type { ActivityEvent, ActivityEventType, ImplementationStep, Project, Task } from '../types/schema.js';

type Row = Record<string, unknown>;

const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const OBSERVE_SNAPSHOT = { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'legacy' };
const legacyAt = (planRevision: number) => ({ version: 2, profile: 'legacy', planRevision, deliveryPolicy: 'legacy' });
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
const PLAN_STEP = { description: 'Do the thing', affectedFiles: ['file.ts'] };
const COMMENT = { id: 'c-1', author: 'human', content: 'looks fine', timestamp: '2026-10-24T12:00:00.000Z' };

/** Every malformed stored value fails closed; none may be read as absent or legacy. */
const MALFORMED: [string, unknown][] = [
  ['null', null],
  ['an array', []],
  ['version 3', { version: 3, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' }],
  ['an upper-case profile', { version: 2, profile: 'VERIFIED-LOCAL', planRevision: 1, deliveryPolicy: 'local-branch' }],
  ['a string planRevision', { version: 2, profile: 'legacy', planRevision: '1', deliveryPolicy: 'legacy' }],
  ['an extra ready key', { ...STRICT, ready: true }],
  ['v2 without deliveryPolicy', { version: 2, profile: 'legacy', planRevision: 1 }],
];

function step(stepId: string, status: ImplementationStep['status'] = 'PENDING', description = `Do ${stepId}`): ImplementationStep {
  return { stepId, description, status, affectedFiles: ['file.ts'] };
}
const DONE_PLAN = [step('step-1', 'COMPLETED'), step('step-2', 'COMPLETED')];
const OPEN_PLAN = [step('step-1', 'COMPLETED'), step('step-2')];

const h = new ToolTestHarness();

beforeEach(() => h.init());
afterEach(async () => {
  clearAllSpeedModeTimeouts();
  await h.state.flushActivityLog();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

/** Write project.json settings and raw task JSON, then load: the only way strict state can exist. */
async function seed(rows: Row[] = [{}], settings: Row = {}): Promise<void> {
  h.setupMoeFolder({ settings: { ...BASE_SETTINGS, ...settings } } as unknown as Partial<Project>);
  h.createEpic();
  for (const overrides of rows) h.createTask(overrides as Partial<Task>);
  await h.state.load();
}

const withSnapshot = (overrides: Row, snapshot: unknown): Row =>
  snapshot === undefined ? overrides : { ...overrides, executionPolicySnapshot: snapshot };
const tasksDir = () => path.join(h.moePath, 'tasks');
const fileBytes = (id = 'task-1') => fs.readFileSync(path.join(tasksDir(), `${id}.json`), 'utf8');
const fileRow = (id = 'task-1') => JSON.parse(fileBytes(id)) as Row;
const hasSnapshotKey = (value: object) => Object.prototype.hasOwnProperty.call(value, 'executionPolicySnapshot');

function row(id = 'task-1'): Task {
  const task = h.state.getTask(id);
  if (!task) throw new Error(`fixture task missing: ${id}`);
  return task;
}

const upd = (updates: Row, event?: ActivityEventType) => h.state.updateTask('task-1', updates as Partial<Task>, event);

/** Approval exactly as production runs it: under the state mutex. */
const approve = (token?: number) =>
  h.state.runExclusive(() => (token === undefined ? h.state.approveTask('task-1') : h.state.approveTask('task-1', token)));

const submit = () =>
  submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [PLAN_STEP] }, h.state) as Promise<{ status: string; planRevision: number }>;

async function reloadedRow(id = 'task-1'): Promise<Task | null> {
  const fresh = new StateManager({ projectPath: h.testDir });
  await fresh.load();
  const task = fresh.getTask(id);
  fresh.clearEmitter();
  return task;
}

/** The stored snapshot in memory, on disk (byte order included) and absent means no own key at all. */
function expectStoredSnapshot(expected: unknown, id = 'task-1'): void {
  if (expected === undefined) {
    expect(hasSnapshotKey(row(id))).toBe(false);
    expect(hasSnapshotKey(fileRow(id))).toBe(false);
    return;
  }
  expect(row(id).executionPolicySnapshot).toEqual(expected);
  expect(JSON.stringify(fileRow(id).executionPolicySnapshot)).toBe(JSON.stringify(expected));
}

/**
 * A refusal must happen before the write path: no writeEntity call, no event,
 * identical task files and identical in-memory rows (updatedAt and planRevision
 * included). Direct store calls must not append activity either.
 */
async function refusedWithoutWrites(act: () => Promise<unknown>, codeName: string, direct = true): Promise<MoeError> {
  const listing = fs.readdirSync(tasksDir()).sort();
  const bytes = listing.map((name) => fs.readFileSync(path.join(tasksDir(), name), 'utf8'));
  const rows = structuredClone([...h.state.tasks.entries()]);
  const writes = vi.spyOn(h.state, 'writeEntity');
  const activity = vi.spyOn(h.state, 'appendActivity');
  const events: string[] = [];
  const stop = h.state.subscribe((event) => {
    events.push(event.type);
  });
  let caught: unknown;
  try {
    await act();
  } catch (error) {
    caught = error;
  } finally {
    stop();
  }
  try {
    expect(caught).toBeInstanceOf(MoeError);
    expect((caught as MoeError).codeName).toBe(codeName);
    expect(writes).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    if (direct) expect(activity).not.toHaveBeenCalled();
    expect(fs.readdirSync(tasksDir()).sort()).toEqual(listing);
    expect(listing.map((name) => fs.readFileSync(path.join(tasksDir(), name), 'utf8'))).toEqual(bytes);
    expect([...h.state.tasks.entries()]).toEqual(rows);
  } finally {
    writes.mockRestore();
    activity.mockRestore();
  }
  return caught as MoeError;
}

async function refusedNotReady(act: () => Promise<unknown>, direct = true): Promise<void> {
  const error = await refusedWithoutWrites(act, NOT_READY, direct);
  expect(error.context).toEqual(NOT_READY_CONTEXT);
}

async function waitForActivity(match: (event: ActivityEvent) => boolean, timeoutMs = 5000): Promise<ActivityEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await h.state.flushActivityLog();
    const found = h.state.getActivityLog(500).find(match);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('expected activity was never recorded');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('A. capture at plan submission (DoD 1)', () => {
  it('A1 the first CONTROL submission persists the legacy snapshot with planRevision 1', async () => {
    await seed([{ status: 'PLANNING' }]);

    const result = await submit();

    expect(result).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 1 });
    expect(row().planRevision).toBe(1);
    expectStoredSnapshot(legacyAt(1));
    expect((await reloadedRow())?.executionPolicySnapshot).toEqual(legacyAt(1));
    // Identity, not approval: the capture stamps no approval.
    expect(row().planApprovedAt).toBeUndefined();
  });

  it('A2 captures live settings exactly, survives a reject, and recaptures on resubmission', async () => {
    await seed([{ status: 'PLANNING' }], { executionProfile: 'observe', deliveryPolicy: 'local-branch' });
    const observed = { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'local-branch' };

    await submit();
    expectStoredSnapshot(observed);

    await h.state.runExclusive(() => h.state.rejectTask('task-1', 'rework the plan'));
    expect(row().status).toBe('PLANNING');
    expectStoredSnapshot(observed);

    // update_settings has no deliveryPolicy key, so that half is a hand edit.
    await h.state.updateSettings({ executionProfile: 'legacy' });
    h.state.project!.settings.deliveryPolicy = 'remote-push';
    const second = await submit();

    expect(second.planRevision).toBe(2);
    expectStoredSnapshot({ version: 2, profile: 'legacy', planRevision: 2, deliveryPolicy: 'remote-push' });
  });

  it('A3 the TURBO auto-approval write keeps the PLAN_SUBMITTED snapshot unchanged', async () => {
    await seed([{ status: 'PLANNING' }], { approvalMode: 'TURBO' });
    const published: unknown[] = [];
    const stop = h.state.subscribe((event) => {
      if (event.type === 'TASK_UPDATED' && event.payload.id === 'task-1') {
        published.push(structuredClone(event.payload.executionPolicySnapshot));
      }
    });

    const result = await submit();
    stop();

    expect(result.status).toBe('WORKING');
    expect(published).toEqual([legacyAt(1), legacyAt(1)]);
    expectStoredSnapshot(legacyAt(1));
  });

  it('A4 a failed submission write publishes neither the revision nor the snapshot; the retry stamps both once', async () => {
    await seed([{ status: 'PLANNING', planRevision: 3 }]);
    const bytesBefore = fileBytes();
    const rowBefore = structuredClone(row());
    const published: Task[] = [];
    const stop = h.state.subscribe((event) => {
      if (event.type === 'TASK_UPDATED' && event.payload.id === 'task-1') published.push(structuredClone(event.payload));
    });
    vi.spyOn(h.state, 'writeEntity').mockRejectedValueOnce(new Error('disk full'));

    await expect(submit()).rejects.toThrow('disk full');

    expect(published).toEqual([]);
    expect(row()).toEqual(rowBefore);
    expect(row().planRevision).toBe(3);
    expectStoredSnapshot(undefined);
    expect(fileBytes()).toBe(bytesBefore);

    const retry = await submit();
    stop();

    expect(retry.planRevision).toBe(4);
    expectStoredSnapshot(legacyAt(4));
    expect(published.map((task) => [task.planRevision, task.executionPolicySnapshot])).toEqual([[4, legacyAt(4)]]);
  });
});

describe('B. ownership: callers can never write the snapshot (DoD 2 store half, DoD 3)', () => {
  it.each([
    ['a STRICT', STRICT],
    ['a legacy', legacyAt(1)],
  ])('B1 createTask ignores %s snapshot and a caller planRevision', async (_label, forged) => {
    await seed([]);

    const created = await h.state.createTask({
      epicId: 'epic-1',
      title: 'New task',
      executionPolicySnapshot: forged,
      planRevision: 9,
    } as unknown as Partial<Task>);

    expect(created.executionPolicySnapshot).toBeUndefined();
    expect(hasSnapshotKey(created)).toBe(false);
    expect(created.planRevision).toBe(0);
    expect(hasSnapshotKey(fileRow(created.id))).toBe(false);
    expect(fileRow(created.id).planRevision).toBe(0);
  });

  const FORGERIES: [string, Row][] = [
    ['a forged STRICT snapshot', { executionPolicySnapshot: STRICT }],
    ['an explicit null', { executionPolicySnapshot: null }],
    ['an own-key undefined', { executionPolicySnapshot: undefined }],
    ['a reset to revision 0', { executionPolicySnapshot: legacyAt(0) }],
  ];

  describe.each([
    ['a legacy snapshot', legacyAt(1)],
    ['a STRICT snapshot', STRICT],
    ['no snapshot', undefined],
  ])('B2 updateTask on a row holding %s', (_label, stored) => {
    it.each(FORGERIES)('strips %s and still applies the title', async (_forgery, forged) => {
      await seed([withSnapshot({ status: 'WORKING', planRevision: 1 }, stored)]);

      const updated = await upd({ title: 'Renamed', ...forged });

      expect(updated.title).toBe('Renamed');
      expect(fileRow().title).toBe('Renamed');
      expectStoredSnapshot(stored);
    });
  });

  it.each(FORGERIES)('B3 a PLAN_SUBMITTED write carrying %s stores the daemon legacy capture', async (_forgery, forged) => {
    await seed([{ status: 'PLANNING' }]);

    const updated = await upd({ implementationPlan: [step('step-1')], status: 'AWAITING_APPROVAL', ...forged }, 'PLAN_SUBMITTED');

    expect(updated.executionPolicySnapshot).toEqual(legacyAt(1));
    expectStoredSnapshot(legacyAt(1));
  });

  const PROGRESS_AND_METADATA: [string, Row][] = [
    ['a step moving to IN_PROGRESS', { implementationPlan: [step('step-1', 'IN_PROGRESS')] }],
    ['a step moving to COMPLETED', { implementationPlan: [step('step-1', 'COMPLETED')] }],
    ['a title', { title: 'Renamed' }],
    ['comments', { comments: [COMMENT] }],
    ['contextFetchedBy', { contextFetchedBy: ['worker-9'] }],
    ['metrics', { metrics: { plannedStepCount: 1 } }],
    ['planApprovedAt', { planApprovedAt: '2026-10-24T12:00:00.000Z' }],
  ];
  const AMEND: Row = { implementationPlan: [step('step-1', 'PENDING', 'Amended instructions')] };

  describe.each([
    ['a legacy snapshot', legacyAt(1)],
    ['a STRICT snapshot', STRICT],
  ])('B4 progress and metadata writes on a row holding %s', (_label, stored) => {
    it.each(PROGRESS_AND_METADATA)('%s leaves the snapshot unchanged', async (_write, updates) => {
      await seed([{ status: 'WORKING', planRevision: 1, implementationPlan: [step('step-1')], executionPolicySnapshot: stored }]);

      await upd(updates);

      expectStoredSnapshot(stored);
    });

    it('an amend-style description change bumps planRevision but keeps the now-stale snapshot', async () => {
      await seed([{ status: 'WORKING', planRevision: 1, implementationPlan: [step('step-1')], executionPolicySnapshot: stored }]);

      const updated = await upd(AMEND);

      expect(updated.planRevision).toBe(2);
      expectStoredSnapshot(stored);
    });
  });

  it.each([...PROGRESS_AND_METADATA, ['an amend-style description change', AMEND] as [string, Row]])(
    'B5 %s on a legacy WORKING row adds no snapshot under hand-edited verified-local settings',
    async (_write, updates) => {
      await seed([{ status: 'WORKING', planRevision: 1, implementationPlan: [step('step-1')] }], { executionProfile: 'verified-local' });

      await upd(updates);

      expectStoredSnapshot(undefined);
      const reloaded = await reloadedRow();
      expect(reloaded && hasSnapshotKey(reloaded)).toBe(false);
    }
  );
});

describe('C. the strict floor across replanning and rollback (DoD 4)', () => {
  const liveObserve = { executionProfile: 'observe', deliveryPolicy: 'remote-push' };

  it.each([
    ['an absent', undefined],
    ['a legacy', legacyAt(1)],
    ['an observe', { version: 2, profile: 'observe', planRevision: 4, deliveryPolicy: 'manual-artifact' }],
    ['a v1 legacy', { version: 1, profile: 'legacy', planRevision: 2 }],
  ])('C1 %s prior captures the live settings', (_label, prior) => {
    expect(taskStore.planSubmissionSnapshot(liveObserve, prior, 7)).toEqual({
      version: 2,
      profile: 'observe',
      planRevision: 7,
      deliveryPolicy: 'remote-push',
    });
  });

  it('C1 a STRICT prior stays the floor under rolled-back legacy settings', () => {
    expect(taskStore.planSubmissionSnapshot({ executionProfile: 'legacy', deliveryPolicy: 'legacy' }, STRICT, 5)).toEqual({
      version: 2,
      profile: 'verified-local',
      planRevision: 5,
      deliveryPolicy: 'local-branch',
    });
  });

  it('C1 a STRICT prior keeps its captured policy whole under another strict live policy (no ranking)', () => {
    expect(taskStore.planSubmissionSnapshot({ executionProfile: 'legacy', deliveryPolicy: 'remote-push' }, STRICT, 2)).toEqual({
      version: 2,
      profile: 'verified-local',
      planRevision: 2,
      deliveryPolicy: 'local-branch',
    });
  });

  it('C1 a v1 verified-local prior stays v1: only planRevision advances, no deliveryPolicy is invented', () => {
    const result = taskStore.planSubmissionSnapshot(
      { executionProfile: 'observe', deliveryPolicy: 'remote-push' },
      { version: 1, profile: 'verified-local', planRevision: 1 },
      9
    );

    expect(result).toEqual({ version: 1, profile: 'verified-local', planRevision: 9 });
    expect(Object.keys(result)).toEqual(['version', 'profile', 'planRevision']);
  });

  it('C1 returns a detached object, never the stored one', () => {
    const stored = Object.freeze({ ...STRICT });

    const floor = taskStore.planSubmissionSnapshot({}, stored, 3);

    expect(floor).not.toBe(stored);
    expect(Object.isFrozen(floor)).toBe(false);
    expect(floor).toEqual({ ...STRICT, planRevision: 3 });
    expect(stored).toEqual(STRICT);
  });

  it.each(MALFORMED)('C1 a malformed stored snapshot (%s) throws INVALID_INPUT naming executionPolicySnapshot', (_label, stored) => {
    let caught: unknown;
    try {
      taskStore.planSubmissionSnapshot({}, stored, 2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MoeError);
    expect((caught as MoeError).codeName).toBe('INVALID_INPUT');
    expect((caught as MoeError).message).toContain('executionPolicySnapshot');
  });

  describe.each([
    ['an absent', undefined],
    ['a STRICT', STRICT],
  ])('C1 with %s prior', (_label, prior) => {
    it.each([
      ['an unknown executionProfile', { executionProfile: 'VERIFIED-LOCAL' }],
      ['a non-string executionProfile', { executionProfile: 7 }],
      ['an unknown deliveryPolicy', { deliveryPolicy: 'local-brnach' }],
    ])('malformed settings (%s) throw INVALID_INPUT', (_settingsLabel, settings) => {
      expect(() => taskStore.planSubmissionSnapshot(settings, prior, 2)).toThrow(MoeError);
      expect(() => taskStore.planSubmissionSnapshot(settings, prior, 2)).toThrow('[INVALID_INPUT]');
    });
  });

  it('C2 a stale STRICT row under rolled-back legacy settings refuses real submit_plan and a PLAN_SUBMITTED write', async () => {
    await seed([{ status: 'PLANNING', planRevision: 3, executionPolicySnapshot: STRICT }]);

    await refusedNotReady(() => submit(), false);
    await refusedNotReady(() => upd({ implementationPlan: [step('step-1')], status: 'AWAITING_APPROVAL' }, 'PLAN_SUBMITTED'));
  });

  it.each([
    {
      name: 'rejectTask (AWAITING_APPROVAL -> PLANNING)',
      row: { status: 'AWAITING_APPROVAL', planRevision: 2, implementationPlan: [step('step-1')] },
      act: () => h.state.runExclusive(() => h.state.rejectTask('task-1', 'rework the plan')),
      status: 'PLANNING',
    },
    {
      name: 'the request_replan shape (WORKING -> PLANNING with a cleared plan)',
      row: { status: 'WORKING', planRevision: 2, implementationPlan: [step('step-1', 'COMPLETED')] },
      act: () => upd({ status: 'PLANNING', implementationPlan: [], stepsCompleted: [] }),
      status: 'PLANNING',
    },
    {
      name: 'the qa_reject shape (REVIEW -> WORKING)',
      row: { status: 'REVIEW', planRevision: 2, implementationPlan: [step('step-1', 'COMPLETED')] },
      act: () => upd({ status: 'WORKING', reopenCount: 1, reopenReason: 'fix the edge case', implementationPlan: [step('step-1')] }),
      status: 'WORKING',
    },
    {
      name: 'reopenTask (REVIEW -> BACKLOG)',
      row: { status: 'REVIEW', planRevision: 2, implementationPlan: [step('step-1', 'COMPLETED')] },
      act: () => h.state.reopenTask('task-1', 'needs rework'),
      status: 'BACKLOG',
    },
  ])('C3 $name keeps a STRICT snapshot byte-identical', async ({ row: overrides, act, status }) => {
    await seed([{ ...overrides, executionPolicySnapshot: STRICT }]);

    await act();

    expect(row().status).toBe(status);
    expect(row().planRevision).toBeGreaterThanOrEqual(2);
    expectStoredSnapshot(STRICT);
  });

  describe.each(MALFORMED)('C4 a malformed stored snapshot (%s)', (_label, malformed) => {
    it('refuses a PLAN_SUBMITTED write and a progression with INVALID_INPUT, even under legacy settings', async () => {
      await seed([{ status: 'PLANNING', executionPolicySnapshot: malformed }]);

      const submitted = await refusedWithoutWrites(() => upd({ implementationPlan: [step('step-1')] }, 'PLAN_SUBMITTED'), 'INVALID_INPUT');
      const progressed = await refusedWithoutWrites(() => upd({ status: 'AWAITING_APPROVAL' }), 'INVALID_INPUT');

      expect(submitted.message).toContain('executionPolicySnapshot');
      expect(progressed.message).toContain('executionPolicySnapshot');
    });

    it.each([
      {
        name: 'a metadata write',
        row: { status: 'WORKING' },
        act: () => upd({ title: 'Renamed' }),
        status: 'WORKING',
      },
      {
        name: 'a release of an all-done WORKING row',
        row: { status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: DONE_PLAN },
        act: () => releaseWorkerTasks(h.state, 'worker-1', 'test release'),
        status: 'REVIEW',
      },
      {
        name: 'a park to BACKLOG',
        row: { status: 'WORKING', assignedWorkerId: 'worker-1' },
        act: () => upd({ assignedWorkerId: null, status: 'BACKLOG' }, 'WORKER_TIMEOUT'),
        status: 'BACKLOG',
      },
    ])('$name succeeds and keeps the malformed bytes exactly', async ({ row: overrides, act, status }) => {
      await seed([{ ...overrides, executionPolicySnapshot: malformed }]);

      await act();

      expect(row().status).toBe(status);
      expectStoredSnapshot(malformed);
    });
  });
});

interface Transition {
  name: string;
  row: Row;
  act: () => Promise<unknown>;
  status: string;
  assigned?: string | null;
}

const AWAITING_ROW: Row = { status: 'AWAITING_APPROVAL', planRevision: 1, implementationPlan: [step('step-1')] };

/** New progressions: each is refused under an effective verified-local profile. */
const PROGRESSIONS: Transition[] = [
  { name: 'BACKLOG -> PLANNING', row: { status: 'BACKLOG' }, act: () => upd({ status: 'PLANNING' }), status: 'PLANNING' },
  {
    name: 'PLANNING -> AWAITING_APPROVAL',
    row: { status: 'PLANNING', implementationPlan: [step('step-1')] },
    act: () => upd({ status: 'AWAITING_APPROVAL' }),
    status: 'AWAITING_APPROVAL',
  },
  {
    name: 'a PLAN_SUBMITTED write with no status change',
    row: { status: 'PLANNING' },
    act: () => upd({ implementationPlan: [step('step-1')] }, 'PLAN_SUBMITTED'),
    status: 'PLANNING',
  },
  { name: 'approveTask without a token', row: AWAITING_ROW, act: () => approve(), status: 'WORKING' },
  { name: 'approveTask with the current token', row: AWAITING_ROW, act: () => approve(1), status: 'WORKING' },
  {
    name: 'the complete_task shape (an assigned all-done WORKING row -> REVIEW, no seat in the update)',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: DONE_PLAN },
    act: () => upd({ status: 'REVIEW' }),
    status: 'REVIEW',
  },
  { name: 'REVIEW -> DONE', row: { status: 'REVIEW', implementationPlan: DONE_PLAN }, act: () => upd({ status: 'DONE' }), status: 'DONE' },
  { name: 'BACKLOG -> WORKING', row: { status: 'BACKLOG' }, act: () => upd({ status: 'WORKING' }), status: 'WORKING' },
  { name: 'BACKLOG -> REVIEW', row: { status: 'BACKLOG' }, act: () => upd({ status: 'REVIEW' }), status: 'REVIEW' },
  { name: 'ARCHIVED -> WORKING', row: { status: 'ARCHIVED' }, act: () => upd({ status: 'WORKING' }), status: 'WORKING' },
  {
    name: 'BLOCKED (from PLANNING) -> WORKING',
    row: { status: 'BLOCKED', blockedFromStatus: 'PLANNING', blockedReason: 'waiting' },
    act: () => upd({ status: 'WORKING' }),
    status: 'WORKING',
  },
  {
    name: 'a BLOCKED row with no blockedFromStatus -> WORKING',
    row: { status: 'BLOCKED', blockedReason: 'waiting' },
    act: () => upd({ status: 'WORKING' }),
    status: 'WORKING',
  },
  {
    name: "a hand-edited 'constructor' status -> WORKING",
    row: { status: 'constructor' },
    act: () => upd({ status: 'WORKING' }),
    status: 'WORKING',
  },
];

/** Seat-clearing writes that are not releases: still progressions. */
const NOT_RELEASES: Transition[] = [
  {
    name: 'an explicit null seat on an already-unassigned all-done WORKING row -> REVIEW',
    row: { status: 'WORKING', implementationPlan: DONE_PLAN },
    act: () => upd({ assignedWorkerId: null, status: 'REVIEW' }),
    status: 'REVIEW',
  },
  {
    name: 'a hand-back to REVIEW while a step is still PENDING',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: OPEN_PLAN },
    act: () => upd({ assignedWorkerId: null, status: 'REVIEW' }),
    status: 'REVIEW',
  },
];

/** Never progressions: allowed under any profile. */
const ALLOWED: Transition[] = [
  {
    name: 'a metadata write',
    row: { status: 'WORKING' },
    act: () => upd({ title: 'Renamed', comments: [COMMENT], contextFetchedBy: ['worker-9'], metrics: { plannedStepCount: 2 } }),
    status: 'WORKING',
  },
  {
    name: 'a progress write',
    row: { status: 'WORKING', implementationPlan: [step('step-1')] },
    act: () => upd({ implementationPlan: [step('step-1', 'IN_PROGRESS')] }),
    status: 'WORKING',
  },
  { name: 'an assignment with no status change', row: { status: 'WORKING' }, act: () => upd({ assignedWorkerId: 'worker-2' }), status: 'WORKING', assigned: 'worker-2' },
  {
    name: 'an unassignment with no status change',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1' },
    act: () => upd({ assignedWorkerId: null }),
    status: 'WORKING',
    assigned: null,
  },
  { name: 'WORKING -> PLANNING', row: { status: 'WORKING' }, act: () => upd({ status: 'PLANNING' }), status: 'PLANNING' },
  { name: 'AWAITING_APPROVAL -> PLANNING', row: AWAITING_ROW, act: () => upd({ status: 'PLANNING' }), status: 'PLANNING' },
  { name: 'REVIEW -> WORKING', row: { status: 'REVIEW' }, act: () => upd({ status: 'WORKING' }), status: 'WORKING' },
  { name: 'DONE -> BACKLOG', row: { status: 'DONE' }, act: () => upd({ status: 'BACKLOG' }), status: 'BACKLOG' },
  {
    name: 'entering BLOCKED',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1' },
    act: () => upd({ status: 'BLOCKED', blockedFromStatus: 'WORKING', blockedReason: 'waiting on a human', assignedWorkerId: 'worker-1' }),
    status: 'BLOCKED',
    assigned: 'worker-1',
  },
  { name: 'entering ARCHIVED', row: { status: 'REVIEW' }, act: () => upd({ status: 'ARCHIVED' }), status: 'ARCHIVED' },
  {
    name: 'BLOCKED (from WORKING) -> WORKING keeping its parked owner',
    row: { status: 'BLOCKED', blockedFromStatus: 'WORKING', blockedReason: 'waiting', assignedWorkerId: 'worker-1' },
    act: () => upd({ status: 'WORKING', assignedWorkerId: 'worker-1', blockedReason: null, blockedFromStatus: null, blockedAt: null }),
    status: 'WORKING',
    assigned: 'worker-1',
  },
  {
    name: 'releaseWorkerTasks of an assigned all-done WORKING row (lands in REVIEW)',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: DONE_PLAN },
    act: async () => {
      const released = await releaseWorkerTasks(h.state, 'worker-1', 'test release');
      expect(released).toEqual([{ taskId: 'task-1', previousStatus: 'WORKING', newStatus: 'REVIEW' }]);
    },
    status: 'REVIEW',
    assigned: null,
  },
  {
    name: 'a park to BACKLOG',
    row: { status: 'WORKING', assignedWorkerId: 'worker-1' },
    act: () => upd({ assignedWorkerId: null, status: 'BACKLOG' }, 'WORKER_TIMEOUT'),
    status: 'BACKLOG',
    assigned: null,
  },
  {
    // A prototype-key status must stand at 0 too, or the park looks like a climb.
    name: "a hand-edited 'constructor' status parked to BACKLOG",
    row: { status: 'constructor' },
    act: () => upd({ status: 'BACKLOG' }, 'WORKER_TIMEOUT'),
    status: 'BACKLOG',
  },
];

const STRICT_SETUPS = [
  { name: 'live verified-local settings with no snapshot', settings: { executionProfile: 'verified-local' }, snapshot: undefined },
  { name: 'a stored STRICT snapshot under legacy settings', settings: {}, snapshot: STRICT },
];

const RELAXED_SETUPS = [
  { name: 'legacy settings with no snapshot', settings: {}, snapshot: undefined },
  { name: 'legacy settings with a captured legacy snapshot', settings: {}, snapshot: legacyAt(1) },
  { name: 'observe settings with a captured observe snapshot', settings: { executionProfile: 'observe' }, snapshot: OBSERVE_SNAPSHOT },
];

const CREATED_STATUSES = ['PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
const createIn = (status: string) => h.state.createTask({ epicId: 'epic-1', title: 'New task', status } as Partial<Task>);

describe('D. the strict-progression readiness backstop (DoD 5)', () => {
  describe.each(STRICT_SETUPS)('under $name', ({ settings, snapshot }) => {
    it.each(PROGRESSIONS)('D1 refuses $name before any write', async ({ row: overrides, act }) => {
      await seed([withSnapshot(overrides, snapshot)], settings);

      await refusedNotReady(act);
    });

    it.each(ALLOWED)('D2 allows $name and leaves the snapshot untouched', async ({ row: overrides, act, status, assigned }) => {
      await seed([withSnapshot(overrides, snapshot)], settings);

      await act();

      expect(row().status).toBe(status);
      if (assigned !== undefined) expect(row().assignedWorkerId).toBe(assigned);
      expectStoredSnapshot(snapshot);
    });

    it.each(NOT_RELEASES)('D3 refuses $name: it is not a release', async ({ row: overrides, act }) => {
      await seed([withSnapshot(overrides, snapshot)], settings);

      await refusedNotReady(act);
    });

    it('D2 get_context and list_tasks read the row without touching it', async () => {
      vi.stubEnv('MOE_WORKER_ID', '');
      vi.stubEnv('MOE_TASK_ID', '');
      await seed([withSnapshot({ status: 'WORKING' }, snapshot)], settings);
      const before = fileBytes();

      const context = (await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state)) as { task: { id: string } };
      const listed = (await listTasksTool(h.state).handler({}, h.state)) as { tasks: { id: string }[] };

      expect(context.task.id).toBe('task-1');
      expect(listed.tasks.map((task) => task.id)).toEqual(['task-1']);
      expect(fileBytes()).toBe(before);
      expectStoredSnapshot(snapshot);
    });
  });

  it.each(MALFORMED)('D2 get_context and list_tasks read a malformed (%s) row without touching it', async (_label, malformed) => {
    vi.stubEnv('MOE_WORKER_ID', '');
    vi.stubEnv('MOE_TASK_ID', '');
    await seed([{ status: 'WORKING', executionPolicySnapshot: malformed }]);
    const before = fileBytes();

    const context = (await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state)) as { task: { id: string } };
    const listed = (await listTasksTool(h.state).handler({}, h.state)) as { tasks: { id: string }[] };

    expect(context.task.id).toBe('task-1');
    expect(listed.tasks.map((task) => task.id)).toEqual(['task-1']);
    expect(fileBytes()).toBe(before);
    expectStoredSnapshot(malformed);
  });

  it.each(CREATED_STATUSES)('D1 createTask refuses a new %s row under live verified-local settings', async (status) => {
    await seed([{}], { executionProfile: 'verified-local' });

    await refusedNotReady(() => createIn(status));
  });

  it('D2 createTask allows a new BACKLOG row under live verified-local settings, with no snapshot', async () => {
    await seed([{}], { executionProfile: 'verified-local' });

    const created = await createIn('BACKLOG');

    expect(created.status).toBe('BACKLOG');
    expectStoredSnapshot(undefined, created.id);
  });

  describe.each(RELAXED_SETUPS)('D4 under $name', ({ settings, snapshot }) => {
    it.each([...PROGRESSIONS, ...NOT_RELEASES])('$name succeeds', async ({ row: overrides, act, status }) => {
      await seed([withSnapshot(overrides, snapshot)], settings);

      await act();

      expect(row().status).toBe(status);
    });

    it.each(CREATED_STATUSES)('createTask in %s succeeds', async (status) => {
      await seed([{}], settings);

      expect((await createIn(status)).status).toBe(status);
    });
  });

  it('D4 a readiness environment flag does not lift a refusal', async () => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    vi.stubEnv('MOE_DISABLE_QUALITY_GATE', '1');
    await seed([{ ...AWAITING_ROW, executionPolicySnapshot: STRICT }]);

    await refusedNotReady(() => approve(1));
    await refusedNotReady(() => upd({ status: 'WORKING', planApprovedAt: '2026-10-24T12:00:00.000Z' }, 'PLAN_APPROVED'));
  });

  it.each([
    ['a legacy', legacyAt(1)],
    ['a STRICT', STRICT],
  ])('D5 a stale token on %s-snapshotted AWAITING_APPROVAL row still throws PLAN_REVISION_MISMATCH', async (_label, stored) => {
    await seed([{ ...AWAITING_ROW, planRevision: 2, executionPolicySnapshot: stored }]);

    await refusedWithoutWrites(() => approve(1), 'PLAN_REVISION_MISMATCH');

    expect(row().status).toBe('AWAITING_APPROVAL');
    expect(row().planApprovedAt).toBeUndefined();
  });

  it('D6 a refused approval cancels no SPEED timer, and the timer itself is refused', async () => {
    await seed([{ status: 'PLANNING' }], { approvalMode: 'SPEED', speedModeDelayMs: 400 });
    expect((await submit()).status).toBe('AWAITING_APPROVAL');
    expectStoredSnapshot(legacyAt(1));

    h.state.project!.settings.executionProfile = 'verified-local';
    await refusedNotReady(() => approve(1));
    expect(row().status).toBe('AWAITING_APPROVAL');

    const failure = await waitForActivity(
      (event) => event.event === 'TASK_BLOCKED' && event.payload.reason === 'SPEED mode auto-approval failed'
    );
    expect(String(failure.payload.error)).toContain(NOT_READY);
    expect(row().status).toBe('AWAITING_APPROVAL');
    expect(row().planApprovedAt).toBeUndefined();
    expectStoredSnapshot(legacyAt(1));
  });
});

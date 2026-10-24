// =============================================================================
// CQ-M01: cross-boundary composition of the configuration identity that
// CQ-M01b-f built: capture, serving (get_context executionPolicy), restart,
// rollback, forgery and old rows. Registered tools run as McpAdapter dispatches
// them (under the state mutex unless blocking), over a real StateManager on a
// temp .moe folder and the daemon's own startup order; nothing is mocked.
//
// update_settings refuses verified-local on purpose, so strict rows and strict
// settings exist only as hand-edited raw JSON. Configuration identity is never
// approval, readiness, runner trust or verified completion: no case expects a
// snapshot to grant anything.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { getTools } from '../tools/index.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { clearAllSpeedModeTimeouts } from '../tools/submitPlan.js';
import { StateManager } from '../state/StateManager.js';
import { deriveAttemptPolicySnapshot } from '../tools/claimNextTask.js';
import { currentAttempt, getAttempt, listAttempts, reconcileRunningAttempts } from '../state/attemptStore.js';
import { listReviewsForTask } from '../state/reviewStore.js';
import { evaluateDeliveryEvidence } from './policy.js';
import { MoeError } from '../util/errors.js';
import type { ExecutionAttempt, Project, Task } from '../types/schema.js';

type Row = Record<string, unknown>;

/** setupMoeFolder REPLACES the whole settings object when settings are overridden. */
const HARNESS_SETTINGS = {
  approvalMode: 'TURBO',
  speedModeDelayMs: 2000,
  autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  agentCommand: 'claude',
};
const LIVE_OBSERVE = { executionProfile: 'observe', deliveryPolicy: 'local-branch' };
const LIVE_LEGACY = { executionProfile: 'legacy', deliveryPolicy: 'legacy' };

const STRICT_V2 = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const LEGACY_V2 = { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' };
const OBSERVE_V2 = { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'local-branch' };

const NOT_READY = {
  code: -32003,
  codeName: 'EXECUTION_PROFILE_NOT_READY',
  context: {
    executionProfile: 'verified-local',
    missingCapabilities: [
      'protected-host-control-plane',
      'isolated-agent-and-qa-vms',
      'isolated-check-vm',
      'authenticated-runner-evidence',
      'revision-bound-local-delivery',
    ],
  },
};

const ARCHITECT = 'architect-A';
const W = 'worker-W';
const QA = 'qa-Q';
const STARTED = '2026-10-24T12:00:00.000Z';
const SUMMARY = 'Re-ran the gate and checked each DoD item against the recorded evidence.';
const PLAN_STEP = { description: 'Do the thing', affectedFiles: ['file.ts'] };
const PENDING_PLAN = ['step-1', 'step-2'].map((stepId) => ({
  stepId, description: `Do ${stepId}`, status: 'PENDING', affectedFiles: ['file.ts'],
}));

const h = new ToolTestHarness();
const retired: StateManager[] = [];

beforeEach(() => h.init());
afterEach(async () => {
  for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
  activeWaiters.clear();
  clearAllSpeedModeTimeouts();
  for (const state of [...retired.splice(0), h.state]) {
    await state.flushActivityLog();
    state.clearEmitter();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

// --- fixtures -----------------------------------------------------------------

const attemptRecord = (id: string, taskId: string, workerId: string, extra: Row = {}): Row => ({
  id, taskId, workerId, runnerId: workerId, generation: 1, workspace: '/old/checkout',
  phase: 'running', startedAt: STARTED, lastPhaseAt: STARTED, ...extra,
});

/** A WORKING row W holds, with an open attempt seeded in the given key set. */
const heldRow = (task: Row): Row => ({ id: 'task-1', status: 'WORKING', assignedWorkerId: W, planRevision: 1, ...task });
const holder = { id: W, currentTaskId: 'task-1', status: 'WORKING' };

/** Raw settings, epic, tasks, workers and attempt records on disk, then load: the only way strict state can exist. */
async function seed(tasks: Row[], opts: { settings?: Row; workers?: Row[]; attempts?: Row[] } = {}): Promise<void> {
  h.setupMoeFolder({ settings: { ...HARNESS_SETTINGS, ...opts.settings } } as unknown as Partial<Project>);
  h.createEpic();
  for (const task of tasks) h.createTask(task as Partial<Task>);
  for (const worker of opts.workers ?? []) h.createWorker(worker);
  if (opts.attempts?.length) fs.mkdirSync(path.join(h.moePath, 'attempts'), { recursive: true });
  for (const record of opts.attempts ?? []) {
    fs.writeFileSync(attemptFile(String(record.id)), JSON.stringify(record, null, 2));
  }
  await h.state.load();
}

/** Hand-edit project.json settings between daemon instances (undefined deletes a key). */
function editSettings(patch: Row): void {
  const file = path.join(h.moePath, 'project.json');
  const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Row;
  const settings: Row = { ...(project.settings as Row) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete settings[key];
    else settings[key] = value;
  }
  fs.writeFileSync(file, JSON.stringify({ ...project, settings }, null, 2));
}

/** The daemon's startup order (src/index.ts) on the same project: load, reconcile under the mutex, purge. */
async function restart(): Promise<void> {
  const previous = h.state;
  await previous.flushActivityLog();
  previous.clearEmitter();
  retired.push(previous);
  const fresh = new StateManager({ projectPath: h.testDir });
  await fresh.load();
  await fresh.mutex.runExclusive(() => reconcileRunningAttempts(fresh));
  await fresh.purgeAllWorkers();
  h.state = fresh;
}

const taskFile = (id: string) => path.join(h.moePath, 'tasks', `${id}.json`);
const attemptFile = (id: string) => path.join(h.moePath, 'attempts', `${id}.json`);
const bytes = (file: string) => fs.readFileSync(file, 'utf8');
const fileRow = (id: string) => JSON.parse(bytes(taskFile(id))) as Row;
const storedSnapshotJson = (id: string) => JSON.stringify(fileRow(id).executionPolicySnapshot);
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const live = (id: string): Task => {
  const task = h.state.getTask(id);
  if (!task) throw new Error(`fixture task missing: ${id}`);
  return task;
};
const attemptOf = (id: string): ExecutionAttempt => {
  const attempt = getAttempt(h.state, id);
  if (!attempt) throw new Error(`fixture attempt missing: ${id}`);
  return attempt;
};

// --- tools, exactly as MCP dispatch runs them ---------------------------------

async function callTool(name: string, args: Row): Promise<Row> {
  const state = h.state;
  const matches = getTools(state).filter((tool) => tool.name === name);
  if (matches.length !== 1) throw new Error(`expected exactly 1 tool registered as "${name}", found ${matches.length}`);
  const [tool] = matches;
  const invoke = () => tool.handler(args, state);
  return (await (tool.blocking ? invoke() : state.runExclusive(invoke))) as Row;
}

async function refusal(act: Promise<unknown>): Promise<MoeError> {
  const error = await act.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(MoeError);
  return error as MoeError;
}

async function expectNotReady(act: Promise<unknown>): Promise<void> {
  const { code, codeName, context } = await refusal(act);
  expect({ code, codeName, context }).toEqual(NOT_READY);
}

const claimAs = (workerId: string, taskId: string, status = 'WORKING', extra: Row = {}) =>
  callTool('moe.claim_next_task', { statuses: [status], taskId, workerId, ...extra });
const context = (taskId: string, workerId = W, extra: Row = {}) =>
  callTool('moe.get_context', { taskId, workerId, ...extra });
const policyOf = async (taskId: string, workerId = W, extra: Row = {}) =>
  (await context(taskId, workerId, extra)).executionPolicy as Row | undefined;

/** The real architect path: claim the PLANNING row by id, read its context, submit a one-step plan. */
async function plan(taskId = 'task-1', extra: Row = {}): Promise<Row> {
  expect(await claimAs(ARCHITECT, taskId, 'PLANNING')).toMatchObject({ hasNext: true });
  await context(taskId, ARCHITECT);
  const submitted = await callTool('moe.submit_plan', { taskId, workerId: ARCHITECT, steps: [PLAN_STEP], ...extra });
  expect(submitted.status).toBe('WORKING');
  return submitted;
}

/** G2's flow: plan under {observe, local-branch}, then W claims the row by id. */
async function observeFlow(): Promise<{ S: Row; attemptId: string }> {
  await seed([{ id: 'task-1', status: 'PLANNING' }], { settings: LIVE_OBSERVE });
  const submitted = await plan();
  const claimed = await claimAs(W, 'task-1');
  expect(claimed.hasNext).toBe(true);
  const S = { version: 2, profile: 'observe', planRevision: submitted.planRevision, deliveryPolicy: 'local-branch' };
  return { S, attemptId: claimed.attemptId as string };
}

// --- G: get_context serves the configuration identity -------------------------

describe('G: get_context executionPolicy', () => {
  it('G1 is omitted when no setting, task snapshot or open-attempt snapshot exists', async () => {
    await seed([heldRow({ implementationPlan: PENDING_PLAN })], {
      workers: [holder], attempts: [attemptRecord('attempt-1', 'task-1', W)],
    });
    expect(has(await context('task-1'), 'executionPolicy')).toBe(false);
    expect(has(await context('task-1', W, { view: 'full' }), 'executionPolicy')).toBe(false);
  });

  it('G2 serves the captured task and attempt identity as detached copies', async () => {
    const { S, attemptId } = await observeFlow();
    const expected = { effectiveProfile: 'observe', taskSnapshot: S, attemptSnapshot: S };
    const first = (await policyOf('task-1')) as Row;
    expect(first).toStrictEqual(expected);
    expect(Object.keys(first).sort()).toEqual(['attemptSnapshot', 'effectiveProfile', 'taskSnapshot']);

    const taskBytes = bytes(taskFile('task-1'));
    const attemptBytes = bytes(attemptFile(attemptId));
    (first.taskSnapshot as Row).profile = 'verified-local';
    (first.attemptSnapshot as Row).planRevision = 99;
    Object.assign(first, { effectiveProfile: 'verified-local', taskSnapshot: STRICT_V2, attemptSnapshot: STRICT_V2 });

    const second = (await policyOf('task-1')) as Row;
    const third = (await policyOf('task-1')) as Row;
    expect(second).toStrictEqual(expected);
    expect(third).toStrictEqual(expected);
    expect(second.taskSnapshot).not.toBe(third.taskSnapshot);
    expect(second.attemptSnapshot).not.toBe(third.attemptSnapshot);
    expect(second.taskSnapshot).not.toBe(h.state.tasks.get('task-1')?.executionPolicySnapshot);
    expect(second.attemptSnapshot).not.toBe(h.state.attempts.get(attemptId)?.executionPolicySnapshot);
    expect(live('task-1').executionPolicySnapshot).toStrictEqual(S);
    expect(currentAttempt(h.state, 'task-1')?.executionPolicySnapshot).toStrictEqual(S);
    expect(bytes(taskFile('task-1'))).toBe(taskBytes);
    expect(bytes(attemptFile(attemptId))).toBe(attemptBytes);
  });

  it('G3 serves a hand-edited strict row as verified-local without writing its snapshot', async () => {
    await seed([heldRow({ executionPolicySnapshot: STRICT_V2 })], {
      settings: LIVE_LEGACY, workers: [holder], attempts: [attemptRecord('attempt-1', 'task-1', W)],
    });
    const before = storedSnapshotJson('task-1');
    expect(await policyOf('task-1')).toStrictEqual({
      effectiveProfile: 'verified-local', taskSnapshot: STRICT_V2, attemptSnapshot: null,
    });
    expect(storedSnapshotJson('task-1')).toBe(before);
  });

  describe('G4 unreadable records are named, never echoed, never thrown', () => {
    it('a malformed task snapshot', async () => {
      await seed([{ id: 'task-1', status: 'WORKING', planRevision: 1, executionPolicySnapshot: { ...STRICT_V2, ready: true } }]);
      const ctx = await context('task-1');
      expect(ctx.executionPolicy).toStrictEqual({
        effectiveProfile: null, taskSnapshot: null, attemptSnapshot: null, unreadable: ['taskSnapshot'],
      });
      expect(JSON.stringify(ctx)).not.toContain('"ready"');
    });

    it('a malformed live executionProfile', async () => {
      await seed([{ id: 'task-1', status: 'WORKING', planRevision: 1, executionPolicySnapshot: LEGACY_V2 }], {
        settings: { executionProfile: 'VERIFIED-LOCAL' },
      });
      expect(await policyOf('task-1')).toStrictEqual({
        effectiveProfile: null, taskSnapshot: LEGACY_V2, attemptSnapshot: null, unreadable: ['settings.executionProfile'],
      });
    });

    it('a hand-edited attempt snapshot', async () => {
      await seed([heldRow({ executionPolicySnapshot: OBSERVE_V2 })], {
        settings: LIVE_OBSERVE,
        workers: [holder],
        attempts: [attemptRecord('attempt-1', 'task-1', W, { executionPolicySnapshot: { ...OBSERVE_V2, ready: true } })],
      });
      const ctx = await context('task-1');
      expect(ctx.executionPolicy).toStrictEqual({
        effectiveProfile: 'observe', taskSnapshot: OBSERVE_V2, attemptSnapshot: null, unreadable: ['attemptSnapshot'],
      });
      expect(JSON.stringify(ctx)).not.toContain('"ready"');
    });

    it('an attempt snapshot nested too deep to copy, in a project that never used profiles', async () => {
      await seed([heldRow({})], { workers: [holder], attempts: [attemptRecord('attempt-1', 'task-1', W)] });
      // JSON.parse reads this depth from disk; structuredClone (currentAttempt's copy) overflows on it.
      const depth = 20_000;
      const record = JSON.stringify(attemptRecord('attempt-1', 'task-1', W)).slice(0, -1);
      fs.writeFileSync(attemptFile('attempt-1'), `${record},"executionPolicySnapshot":${'{"n":'.repeat(depth)}0${'}'.repeat(depth)}}`);
      await h.state.load();
      expect(await policyOf('task-1')).toStrictEqual({
        effectiveProfile: 'legacy', taskSnapshot: null, attemptSnapshot: null, unreadable: ['attemptSnapshot'],
      });
    });
  });

  it('G5 every role and view:"full" get the same executionPolicy; view:"status" does not', async () => {
    await seed([{ id: 'task-1', status: 'WORKING', planRevision: 1, executionPolicySnapshot: OBSERVE_V2 }], {
      settings: LIVE_OBSERVE,
    });
    const expected = { effectiveProfile: 'observe', taskSnapshot: OBSERVE_V2, attemptSnapshot: null };
    for (const caller of [QA, W, ARCHITECT]) {
      expect(await policyOf('task-1', caller)).toStrictEqual(expected);
      expect(await policyOf('task-1', caller, { view: 'full' })).toStrictEqual(expected);
    }
    expect(has(await context('task-1', W, { view: 'status' }), 'executionPolicy')).toBe(false);
  });
});

// --- R: restart ----------------------------------------------------------------

describe('R: restart', () => {
  it('R1 keeps the task and attempt identity and serves it again', async () => {
    const { S, attemptId } = await observeFlow();
    const served = await policyOf('task-1');
    expect(served).toStrictEqual({ effectiveProfile: 'observe', taskSnapshot: S, attemptSnapshot: S });
    const taskBytes = bytes(taskFile('task-1'));
    await restart();
    expect(bytes(taskFile('task-1'))).toBe(taskBytes);
    expect(live('task-1').executionPolicySnapshot).toStrictEqual(S);
    expect(attemptOf(attemptId)).toMatchObject({ phase: 'reconciling', executionPolicySnapshot: S });
    expect(await policyOf('task-1')).toStrictEqual(served);
  });

  it('R2 a rollback between instances changes the governing profile, never the captured identity', async () => {
    const { S, attemptId } = await observeFlow();
    const { generation } = attemptOf(attemptId);
    editSettings(LIVE_LEGACY);
    await restart();
    expect(await policyOf('task-1')).toStrictEqual({ effectiveProfile: 'legacy', taskSnapshot: S, attemptSnapshot: S });
    expect(evaluateDeliveryEvidence(h.state, live('task-1')).policy).toBe('legacy');

    expect(await claimAs(W, 'task-1')).toMatchObject({ hasNext: true, attemptId, generation });
    expect(attemptOf(attemptId).executionPolicySnapshot).toStrictEqual(S);
    expect(listAttempts(h.state, 'task-1').filter((a) => a.workerId === W).map((a) => a.id)).toEqual([attemptId]);
  });
});

// --- B: rollback ---------------------------------------------------------------

describe('B: rollback', () => {
  it('B1 a non-strict rollback never refreshes the snapshot; only a replan recaptures it', async () => {
    const { S, attemptId } = await observeFlow();
    await h.state.updateSettings({ executionProfile: 'legacy' });
    expect(live('task-1').executionPolicySnapshot).toStrictEqual(S);
    editSettings({ deliveryPolicy: 'legacy' });
    await restart();
    expect(live('task-1').executionPolicySnapshot).toStrictEqual(S);
    expect((await policyOf('task-1'))?.effectiveProfile).toBe('legacy');
    expect(evaluateDeliveryEvidence(h.state, live('task-1')).policy).toBe('legacy');

    await callTool('moe.release_task', { taskId: 'task-1', workerId: W, reason: 'hand back for a replan' });
    await callTool('moe.set_task_status', { taskId: 'task-1', status: 'PLANNING', reason: 'replan' });
    const replanned = await plan();
    expect(replanned.planRevision as number).toBeGreaterThan(S.planRevision as number);
    const recaptured = { version: 2, profile: 'legacy', planRevision: replanned.planRevision, deliveryPolicy: 'legacy' };
    expect(await policyOf('task-1')).toStrictEqual({ effectiveProfile: 'legacy', taskSnapshot: recaptured, attemptSnapshot: null });
    expect(attemptOf(attemptId)).toMatchObject({ phase: 'closed', executionPolicySnapshot: S });
  });

  it('B2 the strict floor holds across every boundary, before and after a restart', async () => {
    await seed([
      { id: 'task-S', status: 'WORKING', planRevision: 1, executionPolicySnapshot: STRICT_V2, implementationPlan: PENDING_PLAN },
      { id: 'task-Q', status: 'REVIEW', planRevision: 1, executionPolicySnapshot: STRICT_V2, reviewStartedAt: STARTED },
      { id: 'task-P', status: 'DONE', planRevision: 1, executionPolicySnapshot: STRICT_V2 },
      { id: 'task-D', status: 'WORKING', planRevision: 1, executionPolicySnapshot: LEGACY_V2, dependsOn: ['task-P'] },
    ], { settings: { executionProfile: 'legacy' }, workers: [{ id: W }] });
    const ids = ['task-S', 'task-Q', 'task-P', 'task-D'];
    const snapshots = ids.map(storedSnapshotJson);

    const expectFloorHolds = async (): Promise<void> => {
      await expectNotReady(claimAs(W, 'task-S'));
      // Documented limitation: the prerequisite's refusal, which does not name task-P.
      await expectNotReady(claimAs(W, 'task-D'));
      expect(await callTool('moe.claim_next_task', { statuses: ['WORKING'], workerId: W })).toMatchObject({ hasNext: false });
      expect(await callTool('moe.wait_for_task', { statuses: ['WORKING'], workerId: W, timeoutMs: 1000 }))
        .toMatchObject({ hasNext: false, timedOut: true });
      await expectNotReady(callTool('moe.set_task_status', { taskId: 'task-Q', status: 'DONE' }));
      await expectNotReady(callTool('moe.qa_approve', { taskId: 'task-Q', workerId: QA, summary: SUMMARY }));
      expect(listReviewsForTask(h.state, 'task-Q')).toEqual([]);
      expect(((await context('task-D')).task as Row).dependsOnUnmet).toEqual(['task-P']);
      for (const id of ['task-S', 'task-Q', 'task-P']) expect((await policyOf(id))?.effectiveProfile).toBe('verified-local');
    };
    await expectFloorHolds();
    await restart();
    await expectFloorHolds();

    await callTool('moe.set_task_status', { taskId: 'task-S', status: 'PLANNING', reason: 'replan' });
    expect(live('task-S').status).toBe('PLANNING');
    await expectNotReady(claimAs(ARCHITECT, 'task-S', 'PLANNING'));
    expect(ids.map(storedSnapshotJson)).toEqual(snapshots);
  });

  it.each([
    ['observe', LIVE_OBSERVE],
    ['legacy', { executionProfile: 'legacy', deliveryPolicy: 'local-branch' }],
  ])('B3 observe never weakens: the %s profile refuses the same missing evidence', async (_label, settings) => {
    await seed([{ id: 'task-1', status: 'REVIEW', planRevision: 1, executionPolicySnapshot: OBSERVE_V2, reviewStartedAt: STARTED }], {
      settings,
    });
    const { code, codeName, context: refused } = await refusal(
      callTool('moe.qa_approve', { taskId: 'task-1', workerId: QA, summary: SUMMARY })
    );
    expect({ code, codeName, refused }).toEqual({
      code: -32003,
      codeName: 'DELIVERY_EVIDENCE_MISSING',
      refused: { taskId: 'task-1', deliveryPolicy: 'local-branch', missingEvidence: ['completion-commit'] },
    });
    expect(live('task-1').status).toBe('REVIEW');
  });
});

// --- F: forgery is ignored at every boundary -------------------------------------

describe('F: forgery', () => {
  it('F1 submit_plan stores the daemon capture, not a caller snapshot or revision', async () => {
    await seed([{ id: 'task-1', status: 'PLANNING' }], { settings: LIVE_OBSERVE });
    const submitted = await plan('task-1', { executionPolicySnapshot: STRICT_V2, planRevision: 99 });
    expect(submitted.planRevision).toBe(1);
    expect(fileRow('task-1').executionPolicySnapshot).toStrictEqual({ ...OBSERVE_V2, planRevision: 1 });
  });

  it.each([['strict', STRICT_V2], ['legacy', LEGACY_V2]])(
    'F2 claim_next_task ignores a forged %s snapshot, profile and readiness',
    async (_label, forged) => {
      await seed([
        { id: 'task-1', status: 'WORKING', planRevision: 1, executionPolicySnapshot: LEGACY_V2 },
        { id: 'task-S', status: 'WORKING', planRevision: 1, executionPolicySnapshot: STRICT_V2, epicId: 'epic-1' },
      ], { settings: LIVE_LEGACY });
      const forgery = { executionPolicySnapshot: forged, executionProfile: 'legacy', ready: true };
      await expectNotReady(claimAs(W, 'task-S', 'WORKING', forgery));
      const claimed = await claimAs(W, 'task-1', 'WORKING', forgery);
      const recorded = attemptOf(claimed.attemptId as string).executionPolicySnapshot;
      expect(recorded).toStrictEqual(deriveAttemptPolicySnapshot(h.state, live('task-1')));
      expect(recorded).toStrictEqual(LEGACY_V2);
    }
  );

  it('F3 create_task never copies a caller snapshot', async () => {
    await seed([]);
    const created = await callTool('moe.create_task', {
      epicId: 'epic-1', title: 'Forged', executionPolicySnapshot: STRICT_V2, workerId: ARCHITECT,
    });
    const id = (created.task as Row).id as string;
    expect(has(live(id), 'executionPolicySnapshot')).toBe(false);
    expect(has(fileRow(id), 'executionPolicySnapshot')).toBe(false);
  });
});

// --- O: old active rows neither gain nor lose strict trust -----------------------

describe('O: old rows', () => {
  it('O1 a pre-snapshot row keeps working, gains no snapshot, and is served only once a profile is set', async () => {
    await seed([heldRow({ implementationPlan: PENDING_PLAN })], {
      workers: [holder], attempts: [attemptRecord('attempt-1', 'task-1', W)],
    });
    expect(has(await context('task-1'), 'executionPolicy')).toBe(false);
    await callTool('moe.start_step', { taskId: 'task-1', stepId: 'step-1', workerId: W });
    await callTool('moe.complete_step', { taskId: 'task-1', stepId: 'step-1', workerId: W, modifiedFiles: ['file.ts'] });
    expect(has(fileRow('task-1'), 'executionPolicySnapshot')).toBe(false);

    expect(await claimAs(W, 'task-1')).toMatchObject({ hasNext: true, attemptId: 'attempt-1', generation: 1 });
    expect(has(attemptOf('attempt-1'), 'executionPolicySnapshot')).toBe(false);
    expect(has(await context('task-1'), 'executionPolicy')).toBe(false);

    await h.state.updateSettings({ executionProfile: 'observe' });
    expect(await policyOf('task-1')).toStrictEqual({ effectiveProfile: 'observe', taskSnapshot: null, attemptSnapshot: null });
    expect(has(fileRow('task-1'), 'executionPolicySnapshot')).toBe(false);
    expect(has(attemptOf('attempt-1'), 'executionPolicySnapshot')).toBe(false);
  });

  it('O2 a captured legacy snapshot reaches DONE unchanged and grants no trust', async () => {
    await seed([{ id: 'task-1', status: 'REVIEW', planRevision: 1, executionPolicySnapshot: LEGACY_V2, reviewStartedAt: STARTED }]);
    const keysBefore = new Set(Object.keys(fileRow('task-1')));
    expect(await callTool('moe.qa_approve', { taskId: 'task-1', workerId: QA, summary: SUMMARY })).toMatchObject({ status: 'DONE' });
    const after = fileRow('task-1');
    expect(after.executionPolicySnapshot).toStrictEqual(LEGACY_V2);
    expect(Object.keys(after).filter((key) => !keysBefore.has(key) && /ready|trust|verif/i.test(key))).toEqual([]);
    expect(has(after, 'deliveryEvidence')).toBe(false);
  });
});

// --- P: profile settings -----------------------------------------------------------

describe('P: executionProfile settings', () => {
  const projectBytes = () => bytes(path.join(h.moePath, 'project.json'));

  it.each([[null], [''], ['VERIFIED-LOCAL'], ['strict'], [1], [{}]])(
    'P1 %j is refused INVALID_INPUT and nothing is persisted',
    async (value) => {
      await seed([], { settings: LIVE_OBSERVE });
      const before = projectBytes();
      const { codeName, context: refused } = await refusal(h.state.updateSettings({ executionProfile: value as never }));
      expect(codeName).toBe('INVALID_INPUT');
      expect(refused?.field).toBe('executionProfile');
      expect(h.state.project?.settings).toMatchObject(LIVE_OBSERVE);
      expect(projectBytes()).toBe(before);
    }
  );

  it('P2 verified-local is refused NOT_READY even with a readiness env var, and nothing is persisted', async () => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    await seed([], { settings: LIVE_OBSERVE });
    const before = projectBytes();
    await expectNotReady(h.state.updateSettings({ executionProfile: 'verified-local' }));
    expect(h.state.project?.settings.executionProfile).toBe('observe');
    expect(projectBytes()).toBe(before);
  });

  it('P3 observe and legacy are accepted and leave deliveryPolicy untouched', async () => {
    await seed([], { settings: { deliveryPolicy: 'local-branch' } });
    for (const profile of ['observe', 'legacy'] as const) {
      await h.state.updateSettings({ executionProfile: profile });
      const stored = (JSON.parse(projectBytes()) as Project).settings;
      expect({ executionProfile: stored.executionProfile, deliveryPolicy: stored.deliveryPolicy })
        .toEqual({ executionProfile: profile, deliveryPolicy: 'local-branch' });
    }
  });
});

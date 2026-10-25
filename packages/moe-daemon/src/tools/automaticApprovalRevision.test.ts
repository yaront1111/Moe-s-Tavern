// CQ-F05: an automatic approval (TURBO, the SPEED timer, the restart re-arm)
// stamps the revision its plan submission committed, and never approves a newer one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityEventType, Task } from '../types/schema.js';
import { StateManager } from '../state/StateManager.js';
import { updateTask as storeUpdateTask } from '../state/taskStore.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { clearAllSpeedModeTimeouts, rearmSpeedModeApprovals, submitPlanTool } from './submitPlan.js';

const TASK = 'task-1';
const APPROVED_AT = '2026-10-25T00:00:00.000Z';
const h = new ToolTestHarness();
const file = (id = TASK): string => path.join(h.moePath, 'tasks', `${id}.json`);
const bytes = (id = TASK): string => fs.readFileSync(file(id), 'utf8');
const STEPS = [{ description: 'Bind the approval to its revision', affectedFiles: ['file.ts'] }];
type Submitted = { status: string; planRevision: number };
const submit = () => submitPlanTool(h.state).handler({ taskId: TASK, steps: STEPS }, h.state) as Promise<Submitted>;
const quiesce = () => h.state.runExclusive(async () => {});
const taskActivity = (state = h.state, id = TASK) => state.getActivityLog(500).filter((event) => event.taskId === id);
const failures = (state = h.state, id = TASK) =>
  taskActivity(state, id).filter((event) => event.payload.reason === 'SPEED mode auto-approval failed');

async function boot(row: Partial<Task>, approvalMode = 'CONTROL'): Promise<void> {
  h.setupMoeFolder({ settings: {
    approvalMode, speedModeDelayMs: 50, autoCreateBranch: false,
    branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
  } });
  h.createEpic();
  h.createTask({ id: TASK, ...row });
  await h.state.load();
}

/** A restarted daemon reading the same .moe folder. */
async function reloaded(): Promise<StateManager> {
  const fresh = new StateManager({ projectPath: h.testDir });
  await fresh.load();
  return fresh;
}

function publishedTasks(): { tasks: Task[]; types: string[]; stop: () => void } {
  const tasks: Task[] = [];
  const types: string[] = [];
  const stop = h.state.subscribe((event) => {
    types.push(event.type);
    if (event.type === 'TASK_UPDATED') tasks.push(event.payload as Task);
  });
  return { tasks, types, stop };
}

beforeEach(() => h.init());
afterEach(() => {
  clearAllSpeedModeTimeouts();
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.cleanup();
});

describe('the store gate accepts a bound revision on PLAN_AUTO_APPROVED', () => {
  const autoApprove = (extra: Partial<Task>, approvedPlanRevision: number) => h.state.runExclusive(() => storeUpdateTask(
    h.state, TASK, { status: 'WORKING', planApprovedAt: APPROVED_AT, ...extra }, 'PLAN_AUTO_APPROVED', undefined,
    { approvedPlanRevision }
  ));

  it('stamps it in the one image that records the approval', async () => {
    await boot({ status: 'AWAITING_APPROVAL', planRevision: 4 });
    const writes = vi.spyOn(h.state, 'writeEntity');
    const published = publishedTasks();

    await autoApprove({}, 4);
    published.stop();

    expect(writes.mock.calls.filter(([kind]) => kind === 'tasks')).toHaveLength(1);
    expect(published.tasks).toHaveLength(1);
    const fresh = await reloaded();
    for (const seen of [JSON.parse(bytes()), h.state.getTask(TASK), published.tasks[0], fresh.getTask(TASK)]) {
      expect(seen).toMatchObject({ status: 'WORKING', planRevision: 4, approvedPlanRevision: 4, planApprovedAt: APPROVED_AT });
    }
  });

  it.each<[string, Partial<Task>, number, string]>([
    ['a stale bound revision', {}, 3, 'PLAN_REVISION_MISMATCH'],
    ['a malformed bound revision', {}, 4.5, 'INVALID_INPUT'],
    ['an approval write that also changes the DoD', { definitionOfDone: ['Changed'] }, 4, 'PLAN_REVISION_MISMATCH'],
  ])('refuses %s before any write', async (_label, extra, approvedPlanRevision, codeName) => {
    await boot({ status: 'AWAITING_APPROVAL', planRevision: 4 });
    await h.state.flushActivityLog();
    const before = bytes();
    const entry = structuredClone(h.state.getTask(TASK));
    const activity = h.state.getActivityLog(500).length;
    const published = publishedTasks();

    await expect(autoApprove(extra, approvedPlanRevision)).rejects.toMatchObject({ codeName });
    published.stop();
    await h.state.flushActivityLog();

    expect(bytes()).toBe(before);
    expect(h.state.getTask(TASK)).toEqual(entry);
    expect(h.state.getActivityLog(500).length).toBe(activity);
    expect(published.types).toEqual([]);
  });

  it.each<[string, ActivityEventType | undefined]>([
    ['an event-less', undefined],
    ['a TASK_UPDATED', 'TASK_UPDATED'],
  ])('%s write ignores it', async (_label, event) => {
    await boot({ status: 'AWAITING_APPROVAL', planRevision: 4 });

    await h.state.runExclusive(() => storeUpdateTask(
      h.state, TASK, { title: 'Renamed' }, event, undefined, { approvedPlanRevision: 4 }
    ));

    expect(JSON.parse(bytes())).not.toHaveProperty('approvedPlanRevision');
    expect(h.state.getTask(TASK)).not.toHaveProperty('approvedPlanRevision');
  });
});

/** SPEED mode with fake timers: the plan is submitted at revision 3 and its 50ms timer is pending. */
async function bootSpeed(): Promise<void> {
  await boot({ status: 'PLANNING', planRevision: 2 }, 'SPEED');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.state.runExclusive(submit);
  expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 3 });
}

/** Fire due timers, then wait behind their callbacks' real fs writes. Never call it inside a section. */
async function settle(state = h.state): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  await state.runExclusive(async () => {});
  await state.flushActivityLog();
}

/** A daemon restart: the in-memory timers are gone, and a fresh state re-arms from disk. */
async function restart(): Promise<StateManager> {
  clearAllSpeedModeTimeouts();
  const fresh = await reloaded();
  // src/index.ts calls it unguarded at startup.
  expect(() => rearmSpeedModeApprovals(fresh)).not.toThrow();
  return fresh;
}

/** Fire the pending timer while `work` holds the mutex, so its callback queues behind that work. */
async function queueTimerBehind(work: () => Promise<void>): Promise<void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  // runExclusive takes the lock synchronously, before the timer fires.
  const held = h.state.runExclusive(async () => { await gate; await work(); });
  await vi.advanceTimersByTimeAsync(50);
  open();
  await held;
  await quiesce();
}

describe('automatic approvals stamp the revision their submission committed', () => {
  it('TURBO stamps it in the single approval write', async () => {
    await boot({ status: 'PLANNING', planRevision: 2 }, 'TURBO');
    const writes = vi.spyOn(h.state, 'writeEntity');
    const published = publishedTasks();

    const result = await h.state.runExclusive(submit);
    published.stop();
    await h.state.flushActivityLog();

    expect(result).toMatchObject({ status: 'WORKING', planRevision: 3 });
    const approvals = writes.mock.calls.filter(([kind, , row]) => kind === 'tasks' && (row as Task).status === 'WORKING');
    expect(approvals).toHaveLength(1);
    const approved = published.tasks.filter((row) => row.status === 'WORKING');
    expect(approved).toHaveLength(1);
    for (const seen of [JSON.parse(bytes()), h.state.getTask(TASK), approvals[0][2], approved[0]]) {
      expect(seen).toMatchObject({ status: 'WORKING', planRevision: 3, approvedPlanRevision: 3, planApprovedAt: expect.any(String) });
    }
    expect(taskActivity().map((event) => event.event)).toContain('PLAN_AUTO_APPROVED');
  });

  it('a SPEED timer stamps the revision it was armed with', async () => {
    await bootSpeed();
    await settle();
    expect(JSON.parse(bytes())).toMatchObject({ status: 'WORKING', planRevision: 3, approvedPlanRevision: 3 });
  });

  it('a SPEED timer withholds approval of criteria changed after submission, and the row stays approvable', async () => {
    await bootSpeed();
    await h.state.runExclusive(() => h.state.updateTask(TASK, { definitionOfDone: ['A newer requirement'] }));
    await h.state.flushActivityLog();
    const before = bytes();
    const activity = taskActivity().length;
    const published = publishedTasks();
    const notice = vi.spyOn(h.state, 'postSystemMessage');

    await settle();
    published.stop();
    await h.state.flushActivityLog();

    expect(bytes()).toBe(before);
    expect(taskActivity()).toHaveLength(activity);
    expect(failures()).toEqual([]);
    expect(published.tasks).toEqual([]);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][1]).toMatch(/revision 3\b[\s\S]*revision 4\b/);
    await h.state.runExclusive(() => h.state.approveTask(TASK, 4));
    expect(JSON.parse(bytes())).toMatchObject({ status: 'WORKING', planRevision: 4, approvedPlanRevision: 4 });
  });

  it('a queued older timer cannot approve an identical resubmission; the new timer approves it', async () => {
    await bootSpeed();
    await queueTimerBehind(async () => {
      await h.state.rejectTask(TASK, 'Resubmit');
      await submit();
    });

    const row = JSON.parse(bytes()) as Task;
    expect(row).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 4 });
    expect(row).not.toHaveProperty('planApprovedAt');
    expect(row).not.toHaveProperty('approvedPlanRevision');
    await settle();
    expect(JSON.parse(bytes())).toMatchObject({ status: 'WORKING', planRevision: 4, approvedPlanRevision: 4 });
  });

  it('a queued older timer leaves a cancelled plan in PLANNING', async () => {
    await bootSpeed();
    await queueTimerBehind(async () => { await h.state.rejectTask(TASK, 'Cancel'); });

    const row = JSON.parse(bytes()) as Task;
    expect(row).toMatchObject({ status: 'PLANNING', planRevision: 3 });
    expect(row).not.toHaveProperty('planApprovedAt');
    expect(row).not.toHaveProperty('approvedPlanRevision');
  });

  it('a failed approval write keeps the failure activity and leaves the row unapproved', async () => {
    await bootSpeed();
    const write = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, row) => {
      if (kind === 'tasks' && (row as Task).status === 'WORKING') throw new Error('injected approval write failure');
      return write(kind, id, row);
    });

    await settle();
    await h.state.flushActivityLog();

    expect(failures()).toHaveLength(1);
    expect(JSON.parse(bytes())).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 3 });
    expect(JSON.parse(bytes())).not.toHaveProperty('approvedPlanRevision');
  });
});

describe('the restart re-arm binds the revision the plan was submitted at', () => {
  const OLD = '2026-01-01T00:00:00.000Z';
  const legacyRow = (id: string, planRevision: unknown) =>
    ({ id, status: 'AWAITING_APPROVAL', planRevision, planSubmittedAt: OLD }) as Partial<Task>;

  it('an unchanged submission approves after the restart with its revision', async () => {
    await bootSpeed();
    const fresh = await restart();
    await settle(fresh);
    expect(JSON.parse(bytes())).toMatchObject({ status: 'WORKING', planRevision: 3, approvedPlanRevision: 3 });
  });

  it('criteria changed before the restart are not auto-approved', async () => {
    await bootSpeed();
    await h.state.runExclusive(() => h.state.updateTask(TASK, { definitionOfDone: ['A newer requirement'] }));
    const before = bytes();
    const fresh = await restart();
    await settle(fresh);
    expect(bytes()).toBe(before);
    expect(JSON.parse(bytes())).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 4 });
    expect(JSON.parse(bytes())).not.toHaveProperty('approvedPlanRevision');
  });

  it('a legacy row without a snapshot binds its current revision', async () => {
    await boot(legacyRow(TASK, 7), 'SPEED');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fresh = await restart();
    await settle(fresh);
    expect(JSON.parse(bytes())).toMatchObject({ status: 'WORKING', planRevision: 7, approvedPlanRevision: 7 });
  });

  it.each<[string, Partial<Task>]>([
    ['a malformed snapshot', { ...legacyRow(TASK, 4), executionPolicySnapshot: { version: 9 } } as Partial<Task>],
    ['a malformed revision on a snapshot-less row', legacyRow(TASK, 1.5)],
  ])('%s is left unarmed for a human beside a healthy row', async (_label, bad) => {
    await boot(bad, 'SPEED');
    h.createTask(legacyRow('task-2', 5));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = bytes();
    const fresh = await restart();
    await settle(fresh);
    expect(bytes()).toBe(before);
    expect(failures(fresh)).toHaveLength(1);
    expect(JSON.parse(bytes('task-2'))).toMatchObject({ status: 'WORKING', approvedPlanRevision: 5 });
  });
});

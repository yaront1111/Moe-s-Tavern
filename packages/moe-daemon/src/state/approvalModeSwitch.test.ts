// An approvalMode change reaches the in-memory SPEED auto-approval timers: a
// switch to CONTROL cancels every armed timer, a switch to SPEED arms the rows
// already awaiting approval, TURBO and unrelated settings writes leave them alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSettings, Task } from '../types/schema.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { clearAllSpeedModeTimeouts, submitPlanTool } from '../tools/submitPlan.js';

const TASK = 'task-1';
const DELAY_MS = 5000;
const h = new ToolTestHarness();
const STEPS = [{ description: 'Approve under the mode in force', affectedFiles: ['file.ts'] }];
type Submitted = { status: string; planRevision: number };

beforeEach(() => h.init());
afterEach(() => {
  clearAllSpeedModeTimeouts();
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.cleanup();
});

/** A PLANNING row, fake timers, then submit_plan under `approvalMode`: AWAITING_APPROVAL, with a timer only under SPEED. */
async function submitUnder(approvalMode: 'CONTROL' | 'SPEED'): Promise<Submitted> {
  h.setupMoeFolder({ settings: {
    approvalMode, speedModeDelayMs: DELAY_MS, autoCreateBranch: false,
    branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
  } });
  h.createEpic();
  h.createTask({ id: TASK, status: 'PLANNING', planRevision: 2 } as Partial<Task>);
  await h.state.load();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const submitted = await h.state.runExclusive(() =>
    submitPlanTool(h.state).handler({ taskId: TASK, steps: STEPS }, h.state) as Promise<Submitted>);
  expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: submitted.planRevision });
  return submitted;
}

/** The board's UPDATE_SETTINGS path: StateManager.updateSettings under the state mutex. */
const switchTo = (settings: Partial<ProjectSettings>) => h.state.runExclusive(() => h.state.updateSettings(settings));

/** Fire the timers due within `ms`, then wait behind their callbacks' real fs writes. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await h.state.runExclusive(async () => {});
  await h.state.flushActivityLog();
}

const approvals = () => h.state.getActivityLog(500)
  .filter((event) => event.taskId === TASK && event.event === 'PLAN_AUTO_APPROVED');

/** Fire the pending timer while `work` holds the mutex, queuing its callback behind that work. */
async function fireTimerBehind(work: () => Promise<unknown>): Promise<void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  // runExclusive takes the lock synchronously, before the timer fires.
  const held = h.state.runExclusive(async () => { await gate; await work(); });
  await vi.advanceTimersByTimeAsync(DELAY_MS);
  open();
  await held;
  await advance(0);
}

describe('an approvalMode switch reaches the SPEED timers', () => {
  it('SPEED then CONTROL before the timer fires: the plan stays awaiting a human', async () => {
    await submitUnder('SPEED');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await switchTo({ approvalMode: 'CONTROL' });
    await advance(DELAY_MS * 4);

    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(h.state.getTask(TASK)).not.toHaveProperty('approvedPlanRevision');
    expect(approvals()).toEqual([]);
  });

  it('a fired SPEED timer queued behind a CONTROL switch leaves the plan awaiting a human', async () => {
    await submitUnder('SPEED');

    await fireTimerBehind(() => h.state.updateSettings({ approvalMode: 'CONTROL' }));

    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(h.state.getTask(TASK)).not.toHaveProperty('approvedPlanRevision');
    expect(approvals()).toEqual([]);

    await advance(DELAY_MS * 4);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(h.state.getTask(TASK)).not.toHaveProperty('approvedPlanRevision');
    expect(approvals()).toEqual([]);
  });

  it('a fired SPEED timer queued behind a TURBO switch approves its submitted revision once', async () => {
    const submitted = await submitUnder('SPEED');

    await fireTimerBehind(() => h.state.updateSettings({ approvalMode: 'TURBO' }));

    expect(h.state.getTask(TASK)).toMatchObject({
      status: 'WORKING', approvedPlanRevision: submitted.planRevision,
    });
    expect(approvals()).toHaveLength(1);
  });

  it('CONTROL then SPEED with a pending row: it is approved after the delay, bound to its submitted revision', async () => {
    const submitted = await submitUnder('CONTROL');
    await advance(DELAY_MS * 4);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });

    await switchTo({ approvalMode: 'SPEED' });
    await advance(1000);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(approvals()).toEqual([]);

    await advance(DELAY_MS);
    expect(h.state.getTask(TASK)).toMatchObject({
      status: 'WORKING', planRevision: submitted.planRevision, approvedPlanRevision: submitted.planRevision,
    });
    expect(approvals()).toHaveLength(1);
  });

  it('a row that is already armed is not armed twice', async () => {
    await submitUnder('SPEED');
    const armed = vi.getTimerCount();

    await switchTo({ approvalMode: 'TURBO' });
    await switchTo({ approvalMode: 'SPEED' });
    expect(vi.getTimerCount()).toBe(armed);

    await advance(DELAY_MS);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'WORKING' });
    expect(approvals()).toHaveLength(1);
  });

  it('a switch to TURBO leaves the armed timer running', async () => {
    await submitUnder('SPEED');

    await switchTo({ approvalMode: 'TURBO' });
    await advance(DELAY_MS);

    expect(h.state.getTask(TASK)).toMatchObject({ status: 'WORKING' });
    expect(approvals()).toHaveLength(1);
  });

  it('a settings write that leaves the mode alone does not touch the timers', async () => {
    await submitUnder('SPEED');
    const armed = vi.getTimerCount();

    await switchTo({ chatEnabled: false });
    await switchTo({ approvalMode: 'SPEED' });
    expect(vi.getTimerCount()).toBe(armed);

    await advance(DELAY_MS);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'WORKING' });
    expect(approvals()).toHaveLength(1);
  });

  it('a refused write to CONTROL leaves the armed timer running', async () => {
    await submitUnder('SPEED');
    const armed = vi.getTimerCount();

    await expect(switchTo({ approvalMode: 'CONTROL', speedModeDelayMs: -1 })).rejects.toThrow();
    expect(h.state.project?.settings.approvalMode).toBe('SPEED');
    expect(vi.getTimerCount()).toBe(armed);

    await advance(DELAY_MS);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'WORKING' });
    expect(approvals()).toHaveLength(1);
  });

  it('a refused write to SPEED arms nothing', async () => {
    await submitUnder('CONTROL');
    const armed = vi.getTimerCount();

    await expect(switchTo({ approvalMode: 'SPEED', speedModeDelayMs: -1 })).rejects.toThrow();
    expect(h.state.project?.settings.approvalMode).toBe('CONTROL');
    expect(vi.getTimerCount()).toBe(armed);

    await advance(DELAY_MS * 4);
    expect(h.state.getTask(TASK)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(approvals()).toEqual([]);
  });
});

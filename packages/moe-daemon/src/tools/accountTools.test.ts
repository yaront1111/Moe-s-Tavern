import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { leaseAccountTool } from './leaseAccount.js';
import { reportAccountUsageTool } from './reportAccountUsage.js';
import { completeStepTool } from './completeStep.js';
import { startStepTool } from './startStep.js';
import { submitPlanTool } from './submitPlan.js';
import { chatWaitTool } from './chatWait.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import { addAccount, recordSignIn } from '../accounts/registry.js';
import type { Epic, Project, Task, Worker } from '../types/schema.js';

// The wrapper's two account tools, and the in-session switch: once a seat's
// account is spent, complete_step tells the worker to end its session and
// start_step refuses to begin another step on that account; between tasks,
// submit_plan and chat_wait tell an architect or a governor whose session can
// end itself (acceptsAccountSwitch, set by the moe-account-switch mod) to end
// its turn.

const VITEST_ACCOUNTS_FILE = process.env.MOE_ACCOUNTS_FILE;

let testDir: string;
let accountsFile: string;
let state: StateManager;

function setupProject(steps: Task['implementationPlan']): void {
  const moePath = path.join(testDir, '.moe');
  for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
    fs.mkdirSync(path.join(moePath, sub), { recursive: true });
  }
  const now = new Date().toISOString();
  const project: Partial<Project> = {
    id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: {
      approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
      branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
    } as Project['settings'],
    createdAt: now, updatedAt: now,
  };
  const epic: Epic = {
    id: 'epic-1', projectId: 'proj-test', title: '', description: '', architectureNotes: '',
    epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
  };
  const task: Task = {
    id: 'task-1', epicId: 'epic-1', title: 't', description: '', definitionOfDone: [], taskRails: [],
    implementationPlan: steps,
    status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null, contextFetchedBy: ['worker-a'],
    reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
    priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
  };
  // An architect planning task-2, and a governor that holds no task.
  const planning: Task = {
    ...task, id: 'task-2', implementationPlan: [], status: 'PLANNING', assignedWorkerId: 'architect-a', contextFetchedBy: ['architect-a'], order: 2,
  };
  const seat = (id: string, currentTaskId: string | null, status: Worker['status']): Worker => ({
    id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status,
    teamId: null, branch: 'main', modifiedFiles: [], startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0,
  });
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(moePath, 'tasks', 'task-2.json'), JSON.stringify(planning, null, 2));
  for (const worker of [seat('worker-a', 'task-1', 'CODING'), seat('architect-a', 'task-2', 'PLANNING'), seat('governor-a', null, 'IDLE')]) {
    fs.writeFileSync(path.join(moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
  }
}

const THREE_STEPS: Task['implementationPlan'] = [
  { stepId: 'step-1', description: 'first', status: 'IN_PROGRESS', affectedFiles: [] },
  { stepId: 'step-2', description: 'second', status: 'PENDING', affectedFiles: [] },
  { stepId: 'step-3', description: 'third', status: 'PENDING', affectedFiles: [] },
];

async function load(steps: Task['implementationPlan'] = THREE_STEPS): Promise<void> {
  setupProject(steps);
  state = new StateManager({ projectPath: testDir });
  await state.load();
  vi.spyOn(state, 'postToRoleChannel').mockResolvedValue();
}

/** Two subscription accounts, "One" and "Two". */
function twoAccounts(): void {
  addAccount(accountsFile, 'One');
  addAccount(accountsFile, 'Two');
  recordSignIn(accountsFile, 'acct-1', 'subscription');
  recordSignIn(accountsFile, 'acct-2', 'subscription');
}

const lease = (workerId = 'worker-a') => leaseAccountTool(state).handler({ workerId }, state) as Promise<Record<string, unknown>>;

/** The CLI's own report: utilization as a fraction, reset in epoch seconds. A null seat sends no workerId. */
function reportUsage(accountId: string, utilization: number, workerId: string | null = 'worker-a') {
  return reportAccountUsageTool(state).handler({
    ...(workerId ? { workerId } : {}),
    accountId,
    windows: { five_hour: { utilization, resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed' } },
  }, state) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-tools-'));
  accountsFile = path.join(testDir, 'machine', 'claude-accounts.json');
  process.env.MOE_ACCOUNTS_FILE = accountsFile;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (VITEST_ACCOUNTS_FILE === undefined) delete process.env.MOE_ACCOUNTS_FILE;
  else process.env.MOE_ACCOUNTS_FILE = VITEST_ACCOUNTS_FILE;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('moe.lease_account', () => {
  it('leases the first signed-in account and records it on the seat', async () => {
    await load();
    expect(await lease()).toEqual({ rotation: false, reason: null });
    twoAccounts();
    expect(await lease()).toMatchObject({ rotation: true, accountId: 'acct-1', label: 'One', switchAtPercent: 90 });
    expect(state.getWorker('worker-a')?.accountId).toBe('acct-1');
  });

  it('needs the seat', async () => {
    await load();
    await expect(leaseAccountTool(state).handler({}, state)).rejects.toThrow(/workerId/);
  });
});

describe('moe.report_account_usage', () => {
  it('records the CLI\'s utilization as a percent', async () => {
    await load();
    twoAccounts();
    expect(await reportUsage('acct-1', 0.93)).toMatchObject({ recorded: true, peakPercent: 93 });
    expect((await reportUsage('acct-1', 0.931)).recorded).toBe(false);
  });

  it('drops malformed windows instead of refusing the report', async () => {
    await load();
    twoAccounts();
    const result = await reportAccountUsageTool(state).handler({ accountId: 'acct-1', windows: 'garbage' }, state);
    expect(result).toEqual({ recorded: false, blockedUntil: null, peakPercent: null });
  });

  it('refuses a bad account id and a sign-in claim it cannot make', async () => {
    await load();
    const tool = reportAccountUsageTool(state);
    await expect(tool.handler({ accountId: '../acct-1' }, state)).rejects.toThrow(/accountId/);
    await expect(tool.handler({ accountId: 'acct-1', signIn: 'subscription' }, state)).rejects.toThrow(/signIn/);
  });
});

describe('switching accounts at a step boundary', () => {
  it('complete_step tells the worker to end the session when its account is spent', async () => {
    await load();
    twoAccounts();
    await lease();
    await reportUsage('acct-1', 0.93);
    const result = await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as Record<string, any>;
    expect(state.getTask('task-1')?.implementationPlan[0]?.status).toBe('COMPLETED');
    expect(result.accountSwitch).toEqual({
      from: 'acct-1',
      to: 'acct-2',
      fromPeakPercent: 93,
      switchAtPercent: 90,
      reason: 'usage',
      instruction: 'ACCOUNT-SWITCH: Claude account One is at 93% of its usage limit (Moe switches at 90%). Step step-1 is saved. End your session now and do not start another step: Moe relaunches this task on Two, and the new session continues with step step-2.',
    });
    expect(result.nextAction.tool).toBe('moe.start_step');
  });

  it('start_step refuses the next step on the spent account, and the relaunched session starts it', async () => {
    await load([
      { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
      { stepId: 'step-2', description: 'second', status: 'PENDING', affectedFiles: [] },
    ]);
    twoAccounts();
    await lease();
    await reportUsage('acct-1', 0.95);
    const start = () => startStepTool(state).handler({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-a' }, state);
    const error = await start().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MoeError);
    expect((error as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    expect((error as MoeError).message).toContain('ACCOUNT-SWITCH: Claude account One is at 95% of its usage limit (Moe switches at 90%). Do not start step step-2 in this session');
    expect(state.getTask('task-1')?.implementationPlan[1]?.status).toBe('PENDING');

    // The wrapper relaunches the held task, and its lease lands on the next account.
    expect(await lease()).toMatchObject({ accountId: 'acct-2' });
    await start();
    expect(state.getTask('task-1')?.implementationPlan[1]?.status).toBe('IN_PROGRESS');
  });

  it('says nothing while the account is under the switch percent, or after the last step', async () => {
    await load();
    twoAccounts();
    await lease();
    await reportUsage('acct-1', 0.5);
    const first = await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as Record<string, unknown>;
    expect(first).not.toHaveProperty('accountSwitch');

    await load([
      { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
      { stepId: 'step-2', description: 'last', status: 'IN_PROGRESS', affectedFiles: [] },
    ]);
    expect(await lease()).toMatchObject({ accountId: 'acct-1' });
    await reportUsage('acct-1', 0.99); // a switch is due, but no step is left to start
    const last =await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-a' }, state) as Record<string, unknown>;
    expect(last).not.toHaveProperty('accountSwitch');
  });

  it('a restarted daemon learns the seat\'s account back from its usage report', async () => {
    await load();
    twoAccounts();
    await lease();
    await load(); // a daemon restart forgets every lease
    await reportUsage('acct-1', 0.97);
    expect(state.getWorker('worker-a')?.accountId).toBe('acct-1');
    const result = await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as Record<string, any>;
    expect(result.accountSwitch).toMatchObject({ from: 'acct-1', to: 'acct-2', fromPeakPercent: 97, reason: 'usage' });
  });

  it('a report keeps the leased account, and one that names no seat moves nothing', async () => {
    await load();
    twoAccounts();
    await reportUsage('acct-1', 0.97, null);
    const result = await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as Record<string, unknown>;
    expect(result).not.toHaveProperty('accountSwitch');
    await startStepTool(state).handler({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-a' }, state);

    await load([
      { stepId: 'step-1', description: 'first', status: 'IN_PROGRESS', affectedFiles: [] },
      { stepId: 'step-2', description: 'second', status: 'PENDING', affectedFiles: [] },
    ]);
    expect(await lease()).toMatchObject({ accountId: 'acct-2' }); // acct-1 is spent
    await reportUsage('acct-1', 0.98); // a stale sample from the previous launch
    expect(state.getWorker('worker-a')?.accountId).toBe('acct-2');
    const kept = await completeStepTool(state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as Record<string, unknown>;
    expect(kept).not.toHaveProperty('accountSwitch');
  });
});

describe('switching accounts between tasks', () => {
  const submit = (acceptsAccountSwitch = true) => submitPlanTool(state).handler({
    taskId: 'task-2',
    workerId: 'architect-a',
    steps: [{ description: 'Do the work', affectedFiles: [] }],
    acceptsAccountSwitch,
  }, state) as Promise<Record<string, any>>;

  const chatWait = (workerId: string, timeoutMs = 1000, acceptsAccountSwitch = true) =>
    chatWaitTool(state).handler({ workerId, timeoutMs, acceptsAccountSwitch }, state) as Promise<Record<string, any>>;

  const general = () => state.getChannels().find((channel) => channel.name === 'general')!.id;

  it('submit_plan tells the architect to end its turn when its account is spent', async () => {
    await load();
    twoAccounts();
    await lease('architect-a');
    await reportUsage('acct-1', 0.93, 'architect-a');
    const result = await submit();
    expect(state.getTask('task-2')?.implementationPlan).toHaveLength(1);
    expect(result.accountSwitch).toEqual({
      from: 'acct-1',
      to: 'acct-2',
      fromPeakPercent: 93,
      switchAtPercent: 90,
      reason: 'usage',
      instruction: 'ACCOUNT-SWITCH: Claude account One is at 93% of its usage limit (Moe switches at 90%). Your submission for task-2 is recorded. End your turn now and do not claim or plan another task: Moe restarts this seat on Two, and the new session picks up the next task.',
    });
    expect(result.nextAction.tool).toBe('moe.wait_for_task');
  });

  it('submit_plan says nothing to a session that cannot end itself', async () => {
    await load();
    twoAccounts();
    await lease('architect-a');
    await reportUsage('acct-1', 0.93, 'architect-a');
    expect(await submit(false)).not.toHaveProperty('accountSwitch');
  });

  it('submit_plan says nothing under the switch percent', async () => {
    await load();
    twoAccounts();
    await lease('architect-a');
    await reportUsage('acct-1', 0.5, 'architect-a');
    expect(await submit()).not.toHaveProperty('accountSwitch');
  });

  it('submit_plan says nothing to a seat without a lease', async () => {
    await load();
    twoAccounts();
    await reportUsage('acct-1', 0.97, null);
    expect(await submit()).not.toHaveProperty('accountSwitch');
  });

  it('submit_plan says nothing when no other account is eligible', async () => {
    await load();
    twoAccounts();
    await lease('architect-a');
    await reportUsage('acct-1', 0.95, 'architect-a');
    await reportUsage('acct-2', 0.95, null);
    expect(await submit()).not.toHaveProperty('accountSwitch');
  });

  it('chat_wait returns at once for a seat without a task, and leaves the chat unread', async () => {
    await load();
    twoAccounts();
    await lease('governor-a');
    const { message } = await state.sendMessage({ channel: general(), sender: 'human', content: '@governor-a status?' });
    await reportUsage('acct-1', 0.93, 'governor-a');
    expect(await chatWait('governor-a')).toEqual({
      hasMessage: false,
      accountSwitch: {
        from: 'acct-1',
        to: 'acct-2',
        fromPeakPercent: 93,
        switchAtPercent: 90,
        reason: 'usage',
        instruction: 'ACCOUNT-SWITCH: Claude account One is at 93% of its usage limit (Moe switches at 90%). End your turn now and do not call chat_wait again: Moe restarts this seat on Two.',
      },
    });
    expect(state.getWorker('governor-a')?.chatCursors?.[general()]).toBeUndefined();

    // The wrapper's relaunch leases the next account, and the message is still unread.
    expect(await lease('governor-a')).toMatchObject({ accountId: 'acct-2' });
    const next = await chatWait('governor-a');
    expect(next.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
  });

  it('chat_wait blocks as before for a session that cannot end itself', async () => {
    await load();
    twoAccounts();
    await lease('governor-a');
    await reportUsage('acct-1', 0.93, 'governor-a');
    const waiting = chatWait('governor-a', 1000, false);
    await reportUsage('acct-1', 0.97, 'governor-a'); // a parked wait is not woken either
    expect(await waiting).toEqual({ hasMessage: false, timedOut: true });
  });

  it('chat_wait delivers as before to a seat that holds a task', async () => {
    await load();
    twoAccounts();
    await lease();
    await reportUsage('acct-1', 0.93);
    const { message } = await state.sendMessage({ channel: general(), sender: 'human', content: '@worker-a ping' });
    const result = await chatWait('worker-a');
    expect(result).not.toHaveProperty('accountSwitch');
    expect(result.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
  });

  it('a parked chat_wait ends as soon as a usage report makes the switch due', async () => {
    await load();
    twoAccounts();
    await lease('governor-a');
    const waiting = chatWait('governor-a', 4000);
    await reportUsage('acct-1', 0.95, 'governor-a');
    const result = await waiting;
    expect(result).not.toHaveProperty('timedOut');
    expect(result).toMatchObject({ hasMessage: false, accountSwitch: { from: 'acct-1', to: 'acct-2', fromPeakPercent: 95 } });
  });
});

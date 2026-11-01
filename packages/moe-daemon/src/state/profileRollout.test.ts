// =============================================================================
// CQ-M05: recorded executionProfile rollout controls. updateSettings is the only
// control: observation is recorded and grants nothing, a verified-local request
// is refused and recorded, and a rollback records what stays strict while tasks,
// attempts and evidence stay byte-identical. A real StateManager on a temp .moe
// folder; the only mock is G4's test-only readiness stand-in.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { getTools } from '../tools/index.js';
import { getActivityLogTool } from '../tools/getActivityLog.js';
import { getAttempt, openAttempt, setAttemptPhase } from './attemptStore.js';
import { decodeClientHello } from '../server/clientCapabilities.js';
import * as executionProfile from '../delivery/executionProfile.js';
import { MoeError } from '../util/errors.js';
import { activationGaps, activationUnsupported, classifyProfileTransition, type ActivationGap } from './profileRollout.js';
import type { Project, Task } from '../types/schema.js';

type Row = Record<string, unknown>;

/** setupMoeFolder REPLACES the whole settings object when settings are overridden. */
const HARNESS_SETTINGS = {
  approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude',
};
const NOT_READY = {
  code: -32003,
  codeName: 'EXECUTION_PROFILE_NOT_READY',
  context: {
    executionProfile: 'verified-local',
    missingCapabilities: [
      'protected-host-control-plane', 'isolated-agent-and-qa-vms', 'isolated-check-vm',
      'authenticated-runner-evidence', 'revision-bound-local-delivery',
    ],
  },
};
const STRICT = { version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' };
const LEGACY = { version: 2, profile: 'legacy', planRevision: 3, deliveryPolicy: 'legacy' };
/** Every gap kind activationUnsupported accepts, the client kind included. */
const GAP_KINDS: ActivationGap[] = [
  { capability: 'vm', reason: 'vm-provisioning-uncertified' },
  { capability: 'client', reason: 'client-contract-unsupported' },
  { capability: 'check', reason: 'check-runner-uncertified' },
];
/** What activationGaps() returns under the default held readiness: no client gap. */
const DEFAULT_GAPS: ActivationGap[] = [
  { capability: 'vm', reason: 'vm-provisioning-uncertified' },
  { capability: 'check', reason: 'check-runner-uncertified' },
];
const S1 = 'worker-s@2026-10-31T00:00:00Z';
const SETTING = { setting: 'executionProfile' };
const EMPTY_RETENTION = {
  retainedStrictTasks: 0, retainedStrictTaskIds: [], retainedStrictAttempts: 0, retainedStrictAttemptIds: [], unreadableSnapshots: 0,
};
const refusedRecord = (from: string, codeName: string): Row =>
  ({ ...SETTING, from, to: 'verified-local', transition: 'activate', outcome: 'refused', codeName, unsupportedCapabilities: DEFAULT_GAPS });
const rollbackRecord = (from: string, to: string, retention: Row = EMPTY_RETENTION): Row =>
  ({ ...SETTING, from, to, transition: 'rollback', outcome: 'applied', ...retention });

const h = new ToolTestHarness();
beforeEach(() => {
  for (const name of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(name, '');
  h.init();
});
afterEach(async () => {
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

/** Raw settings, epic, tasks and workers on disk, then load: the only way strict state can exist. */
async function seed(tasks: Row[] = [], opts: { settings?: Row; workers?: Row[] } = {}): Promise<void> {
  h.setupMoeFolder({ settings: { ...HARNESS_SETTINGS, ...opts.settings } } as unknown as Partial<Project>);
  h.createEpic();
  for (const task of tasks) h.createTask(task as Partial<Task>);
  for (const worker of opts.workers ?? []) h.createWorker(worker);
  await h.state.load();
}

const projectBytes = () => fs.readFileSync(path.join(h.moePath, 'project.json'), 'utf8');
const update = (settings: Row) => h.state.updateSettings(settings as never);
/** PROJECT_SETTINGS_UPDATED payloads, newest first, read synchronously from disk. */
const settingsRecords = (): Row[] =>
  h.state.getActivityLog(500).filter((e) => e.event === 'PROJECT_SETTINGS_UPDATED').map((e) => e.payload);
async function records(): Promise<Row[]> {
  await h.state.flushActivityLog();
  return settingsRecords();
}
/** Every file under .moe except project.json and the activity log, path -> bytes. */
function walk(dir = h.moePath, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name !== 'project.json' && !entry.name.startsWith('activity.log')) {
      out[path.relative(h.moePath, full)] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

async function callTool(name: string, args: Row): Promise<Row> {
  const [tool] = getTools(h.state).filter((t) => t.name === name);
  const invoke = () => tool.handler(args, h.state);
  return (await (tool.blocking ? invoke() : h.state.runExclusive(invoke))) as Row;
}
async function refusal(act: Promise<unknown>): Promise<MoeError> {
  const error = await act.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(MoeError);
  return error as MoeError;
}
const shape = ({ code, codeName, context }: MoeError) => ({ code, codeName, context });

describe('classifyProfileTransition (T1)', () => {
  it.each([
    ['legacy', 'legacy', null], ['legacy', 'observe', 'observe'], ['legacy', 'verified-local', 'activate'],
    ['observe', 'legacy', 'rollback'], ['observe', 'observe', null], ['observe', 'verified-local', 'activate'],
    ['verified-local', 'legacy', 'rollback'], ['verified-local', 'observe', 'rollback'],
    ['verified-local', 'verified-local', 'activate'], ['unreadable', 'legacy', 'rollback'],
    ['unreadable', 'observe', 'rollback'], ['unreadable', 'verified-local', 'activate'],
  ] as const)('%s -> %s is %s', (from, to, expected) => {
    expect(classifyProfileTransition(from, to)).toBe(expected);
  });
});

describe('activation capability gate', () => {
  it('G1 reads daemon-owned facts only, has no client gap, and returns fresh copies', () => {
    expect(activationGaps()).toEqual(DEFAULT_GAPS);
    for (const name of ['MOE_EXECUTION_PROFILE_READY', 'MOE_VERIFIED_LOCAL', 'MOE_VM_CERTIFIED']) vi.stubEnv(name, '1');
    const first = activationGaps();
    expect(first).toEqual(DEFAULT_GAPS);
    first[0].reason = 'certified';
    first.pop();
    expect(activationGaps()).toEqual(DEFAULT_GAPS);
    const hello = decodeClientHello({ protocolVersion: 1, capabilities: { verifiedLocal: true } });
    expect(hello.negotiatedCapabilities.verifiedLocal).toBe(true);
  });

  it.each([[[GAP_KINDS[0]]], [[GAP_KINDS[1]]], [[GAP_KINDS[2]]], [GAP_KINDS]])('G2 refuses the unsupported set %j', (gaps) => {
    const error = activationUnsupported(gaps) as MoeError;
    expect(error).toBeInstanceOf(MoeError);
    expect(shape(error)).toEqual({
      code: -32003, codeName: 'EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED',
      context: { executionProfile: 'verified-local', unsupportedCapabilities: gaps },
    });
    for (const gap of GAP_KINDS) {
      expect(error.message.includes(`${gap.capability} (${gap.reason})`)).toBe(gaps.includes(gap));
    }
  });

  it('G2 returns null only when nothing is unsupported', () => {
    expect(activationUnsupported([])).toBeNull();
  });

  it.each([['absent', undefined], ['legacy', 'legacy'], ['observe', 'observe']])(
    'G3 from a stored %s profile, activation is refused NOT_READY, persists nothing and is recorded', async (_n, stored) => {
      await seed([], { settings: stored === undefined ? {} : { executionProfile: stored } });
      const before = projectBytes();
      const settings = structuredClone(h.state.project?.settings);
      const events: string[] = [];
      h.state.subscribe((event) => events.push(event.type));
      expect(shape(await refusal(update({ executionProfile: 'verified-local' })))).toEqual(NOT_READY);
      expect(projectBytes()).toBe(before);
      expect(h.state.project?.settings).toEqual(settings);
      expect(events).not.toContain('SETTINGS_UPDATED');
      expect(await records()).toEqual([refusedRecord(stored ?? 'legacy', 'EXECUTION_PROFILE_NOT_READY')]);
    });

  it('G4 with readiness stubbed as certified, unsupported vm/check still block activation', async () => {
    await seed([], { settings: { executionProfile: 'observe' } });
    const before = projectBytes();
    // Test-only stand-in for a future certified readiness gate (planApproval.test.ts precedent).
    vi.spyOn(executionProfile, 'assertExecutionProfileReady').mockImplementation(() => {});
    expect(shape(await refusal(update({ executionProfile: 'verified-local' })))).toEqual({
      code: -32003, codeName: 'EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED',
      context: { executionProfile: 'verified-local', unsupportedCapabilities: DEFAULT_GAPS },
    });
    expect(projectBytes()).toBe(before);
    expect(h.state.project?.settings.executionProfile).toBe('observe');
    expect(await records()).toEqual([refusedRecord('observe', 'EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED')]);
  });

  it.each([{ capabilities: { vm: true, client: true, check: true } }, { executionProfileReady: true }])(
    'G5 a caller-supplied capability %j is refused before any record', async (extra) => {
      await seed();
      const before = projectBytes();
      const error = await refusal(update({ executionProfile: 'verified-local', ...extra }));
      expect(error.codeName).toBe('INVALID_INPUT');
      expect(error.context?.field).toBe(Object.keys(extra)[0]);
      expect(await records()).toEqual([]);
      expect(projectBytes()).toBe(before);
    });
});

describe('recorded transitions', () => {
  it('R1 legacy -> observe is applied and recorded before SETTINGS_UPDATED is emitted', async () => {
    await seed();
    const seen: Row[][] = [];
    h.state.subscribe((event) => { if (event.type === 'SETTINGS_UPDATED') seen.push(settingsRecords()); });
    await update({ executionProfile: 'observe' });
    expect(JSON.parse(projectBytes()).settings.executionProfile).toBe('observe');
    const observed = { ...SETTING, from: 'legacy', to: 'observe', transition: 'observe', outcome: 'applied' };
    expect(await records()).toEqual([observed]);
    expect(seen).toEqual([[observed]]);
  });

  it.each([
    ['observe -> observe', { executionProfile: 'observe' }, { executionProfile: 'observe' }, null],
    ['an unrelated update', {}, { agentCommand: 'codex' }, null],
    ['a malformed profile', {}, { executionProfile: 'VERIFIED-LOCAL' }, 'INVALID_INPUT'],
    ['an unrelated update on a stored verified-local', { executionProfile: 'verified-local' }, { agentCommand: 'codex' },
      'EXECUTION_PROFILE_NOT_READY'],
  ])('R2 %s records nothing', async (_n, settings, input, refusedAs) => {
    await seed([], { settings });
    if (refusedAs) expect((await refusal(update(input))).codeName).toBe(refusedAs);
    else await update(input);
    expect(await records()).toEqual([]);
  });

  it('R3 observe -> legacy with nothing strict records an empty retention', async () => {
    await seed([], { settings: { executionProfile: 'observe' } });
    await update({ executionProfile: 'legacy' });
    expect(await records()).toEqual([rollbackRecord('observe', 'legacy')]);
  });

  it('R4 a hand-edited unreadable stored profile rolls back from "unreadable"', async () => {
    await seed([], { settings: { executionProfile: 'VERIFIED-LOCAL' } });
    await update({ executionProfile: 'legacy' });
    expect(await records()).toEqual([rollbackRecord('unreadable', 'legacy')]);
  });

  it('R5 an observe record grants nothing: activation is still refused NOT_READY', async () => {
    await seed();
    await update({ executionProfile: 'observe' });
    expect(shape(await refusal(update({ executionProfile: 'verified-local' })))).toEqual(NOT_READY);
    expect((await records()).map((r) => [r.transition, r.outcome])).toEqual([['activate', 'refused'], ['observe', 'applied']]);
  });

  it('R6 a failed audit append never fails or reverts the change', async () => {
    await seed([], { settings: { executionProfile: 'observe' } });
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    await update({ executionProfile: 'legacy' });
    expect(JSON.parse(projectBytes()).settings.executionProfile).toBe('legacy');
    expect(h.state.project?.settings.executionProfile).toBe('legacy');
    append.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(shape(await refusal(update({ executionProfile: 'verified-local' })))).toEqual(NOT_READY);
    expect(append.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(['activity.log', 'activity.log']);
    expect(await records()).toEqual([]);
  });
});

describe('rollback retention', () => {
  const PAD = 'f'.repeat(32);
  const DONE_IDS = Array.from({ length: 11 }, (_v, i) => `task-s${String(i).padStart(2, '0')}-${PAD}`);
  const RUNNING = `task-S-${PAD}`;

  it('S1 keeps tasks, attempts and evidence byte-identical and records exactly what stays strict', async () => {
    await seed([
      ...DONE_IDS.map((id) => ({ id, status: 'DONE', planRevision: 3, executionPolicySnapshot: STRICT })),
      { id: RUNNING, status: 'WORKING', planRevision: 3, executionPolicySnapshot: STRICT },
      { id: 'task-L', status: 'WORKING', planRevision: 3, executionPolicySnapshot: LEGACY },
      { id: 'task-M', status: 'PLANNING', executionPolicySnapshot: { version: 9 } },
      { id: 'task-A', status: 'WORKING', planRevision: 3, executionPolicySnapshot: LEGACY, assignedWorkerId: 'worker-a' },
    ], {
      settings: { executionProfile: 'verified-local' },
      workers: [{ id: 'worker-a', currentTaskId: 'task-A', status: 'CODING' }, { id: 'worker-x' }],
    });
    const open = (taskId: string, workerId: string, snapshot: Row) => openAttempt(h.state,
      { taskId, workerId, runnerId: `runner-${workerId}`, workspace: h.testDir, executionPolicySnapshot: snapshot } as never);
    const strictAttempt = await open('task-A', 'worker-a', STRICT);
    await setAttemptPhase(h.state, (await open('task-L', 'worker-l', STRICT)).id, 'closed');
    await open('task-L', 'worker-l', LEGACY);
    const files = walk();
    const prior = JSON.parse(projectBytes()) as Row;

    await update({ executionProfile: 'legacy' });
    expect(walk()).toEqual(files);
    const after = JSON.parse(projectBytes()) as Row;
    expect(after).toEqual({ ...prior, settings: { ...(prior.settings as Row), executionProfile: 'legacy' }, updatedAt: after.updatedAt });
    const expected = rollbackRecord('verified-local', 'legacy', {
      retainedStrictTasks: 12, retainedStrictTaskIds: [RUNNING, ...DONE_IDS.slice(0, 9)],
      retainedStrictAttempts: 1, retainedStrictAttemptIds: [strictAttempt.id], unreadableSnapshots: 1,
    });
    expect(await records()).toEqual([expected]);
    const read = await getActivityLogTool(h.state).handler({ eventTypes: ['PROJECT_SETTINGS_UPDATED'] }, h.state) as Row;
    expect((read.events as Row[]).map((e) => e.payload)).toEqual([expected]);

    const served = await callTool('moe.get_context', { taskId: RUNNING, workerId: 'worker-x' });
    expect(served.executionPolicy).toMatchObject({ effectiveProfile: 'verified-local', taskSnapshot: STRICT });
    expect(shape(await refusal(callTool('moe.claim_next_task', { statuses: ['WORKING'], taskId: RUNNING, workerId: 'worker-x' }))))
      .toEqual(NOT_READY);
  });

  it.each([['a', STRICT], ['b', undefined]] as const)(
    'S2 row %s: a rollback never downgrades an active strict attempt', async (row, snapshot) => {
      const pending = ['step-1', 'step-2'].map((stepId) => ({ stepId, description: `do ${stepId}`, status: 'PENDING', affectedFiles: [] }));
      await seed([{
        id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-s', planRevision: 3, approvedPlanRevision: 3,
        contextFetchedBy: ['worker-s'], implementationPlan: pending, executionPolicySnapshot: LEGACY,
      }], { settings: { executionProfile: 'verified-local' }, workers: [{ id: 'worker-s', currentTaskId: 'task-1', status: 'CODING' }] });
      const attempt = await openAttempt(h.state, {
        taskId: 'task-1', workerId: 'worker-s', runnerId: 'runner-s', workspace: h.testDir,
        ...(snapshot ? { executionPolicySnapshot: snapshot } : {}),
      } as never);
      await callTool('moe.get_context', { taskId: 'task-1', workerId: 'worker-s', sessionId: S1 });
      await update({ executionProfile: 'legacy' });
      const strict = row === 'a';
      expect(await records()).toEqual([rollbackRecord('verified-local', 'legacy', {
        ...EMPTY_RETENTION, ...(strict ? { retainedStrictAttempts: 1, retainedStrictAttemptIds: [attempt.id] } : {}),
      })]);

      const ids = strict ? { attemptId: attempt.id, generation: attempt.generation, sessionId: S1 } : {};
      const call = (name: string, args: Row) => callTool(name, { taskId: 'task-1', workerId: 'worker-s', ...ids, ...args });
      if (strict) {
        expect((await refusal(callTool('moe.start_step', { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-s' }))).codeName)
          .toBe('STEP_ENTRY_IDENTITY_REQUIRED');
      }
      for (const stepId of ['step-1', 'step-2']) {
        await call('moe.start_step', { stepId });
        await call('moe.complete_step', { stepId, modifiedFiles: ['a.ts'] });
      }
      const finish = () => call('moe.complete_task', { verification: { command: 'npm test', exitCode: 0 } });
      if (!strict) {
        await expect(finish()).resolves.toMatchObject({ success: true, status: 'REVIEW' });
        return;
      }
      expect(getAttempt(h.state, attempt.id)?.stepCompletions?.map((e) => [e.stepId, e.planRevision]))
        .toEqual([['step-1', 3], ['step-2', 3]]);
      const taskFile = path.join(h.moePath, 'tasks', 'task-1.json');
      const before = fs.readFileSync(taskFile, 'utf8');
      for (let i = 0; i < 2; i++) expect(shape(await refusal(finish()))).toEqual(NOT_READY);
      expect(fs.readFileSync(taskFile, 'utf8')).toBe(before);
      expect(h.state.getTask('task-1')?.status).toBe('WORKING');
      expect(getAttempt(h.state, attempt.id)?.phase).toBe('running');
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { recordCheckDispatchTool } from '../tools/recordCheckDispatch.js';
import { recordCheckObservationTool } from '../tools/recordCheckObservation.js';
import { deleteTaskTool } from '../tools/deleteTask.js';
import { setTaskDependenciesTool } from '../tools/setTaskDependencies.js';
import { reportBlockedTool } from '../tools/reportBlocked.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { describeMissingEvidence, evaluateDeliveryEvidence } from '../delivery/policy.js';
import * as executionProfile from '../delivery/executionProfile.js';
import { dependencyShortfall, describeUnmetDependency, isDependencySatisfied, unmetDependsOn,
  unmetBlockedOnTaskIds, runDependencyUnblock, alertStaleBlocks } from './dependencyUnblock.js';
import type { CheckDispatch, ExecutionPolicySnapshot, Task } from '../types/schema.js';

// Copied from requiredChecks.strong: production readiness is never enabled by these fixtures.
vi.mock('../delivery/executionProfile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery/executionProfile.js')>()),
  assertExecutionProfileReady: () => undefined,
}));
const h = new ToolTestHarness();
const UNIT = 'npm run test:acc';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const RUNNER = { runner: { runnerId: 'runner-0123456789abcdef' } };
const STRICT: ExecutionPolicySnapshot = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const task = () => h.state.getTask('task-1')!;
const consumer = () => h.state.getTask('task-consumer')!;
const patch = (changes: Partial<Task>) => h.state.tasks.set('task-1', { ...task(), ...changes });
function settings(changes: Record<string, unknown>): void {
  h.state.project!.settings = { ...h.state.project!.settings, ...changes } as never;
}
let seq = 0;
let cand = '';
let tree = '';
function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function candidate(): string {
  const id = `cand-${String(++seq).padStart(3, '0')}`;
  h.state.candidates.set(id, { id, attemptId: 'attempt-1', taskId: 'task-1', baseRevision: tree, treeSha: tree,
    deliveryTarget: 'refs/heads/main', protectedEntries: [{ path: 'file.ts', oid: git('rev-parse', `${tree}:file.ts`) }],
    createdAt: new Date(Date.UTC(2026, 9, 30, 0, 0, seq)).toISOString() });
  return id;
}
async function pass(): Promise<void> {
  const result = await recordCheckDispatchTool(h.state).handler({ id: `dispatch-${++seq}`, taskId: 'task-1',
    candidateId: cand, planRevision: task().planRevision, command: UNIT, checkId: 'acc', environment: ENV },
  h.state, RUNNER) as { dispatch: CheckDispatch };
  await recordCheckObservationTool(h.state).handler({ id: `run-${result.dispatch.id}`, dispatchId: result.dispatch.id,
    exitCode: 0, outcome: 'passed', environment: ENV }, h.state, RUNNER);
}
function review(decision: 'approve' | 'reject' = 'approve', candidateId = cand): void {
  const id = `review-${++seq}`;
  h.state.reviews.set(id, { id, taskId: 'task-1', candidateId, reviewerId: 'qa-1', decision, summary: 'verified',
    createdAt: new Date(Date.UTC(2026, 9, 30, 0, 0, seq)).toISOString() });
}
function receipt(candidateId = cand): void {
  const id = `receipt-${++seq}`;
  h.state.receipts.set(id, { id, candidateId, target: 'refs/heads/main', targetBefore: '0'.repeat(40),
    targetAfter: 'a'.repeat(40), landedRevision: 'a'.repeat(40), pushResult: null });
}
function expectShortfall(id: string, tokens: string[], satisfied = false): void {
  expect(dependencyShortfall(h.state, id, consumer())).toEqual({ satisfied, missingEvidence: tokens });
  expect(isDependencySatisfied(h.state, id, consumer())).toBe(satisfied);
  const row = { ...consumer(), dependsOn: [id], blockedOnTaskIds: [id] };
  expect(unmetDependsOn(h.state, row)).toEqual(satisfied ? [] : [id]);
  expect(unmetBlockedOnTaskIds(h.state, row)).toEqual(satisfied ? [] : [id]);
}
beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); seq = 0;
  h.createTask({ status: 'PLANNING', commits: [{ sha: 'ab'.repeat(20), ref: 'main', kind: 'completion', role: 'worker',
    sessionId: 'worker-1@x', paths: [], recordedBy: 'worker-1', recordedAt: '2026-10-30T00:00:00.000Z' }] });
  h.createTask({ id: 'task-consumer', status: 'WORKING', dependsOn: ['task-1'], executionPolicySnapshot: STRICT });
  await h.state.load();
  settings({ executionProfile: 'verified-local', deliveryPolicy: 'local-branch', approvalMode: 'TURBO', checkEnvironments: [ENV] });
  git('init', '-q'); git('add', 'file.ts'); git('commit', '-qm', 'fixture'); tree = git('rev-parse', 'HEAD^{tree}');
  await submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }],
    executionContract: { requiredChecks: [{ id: 'acc', command: UNIT, configs: ['file.ts'] }] } }, h.state);
  cand = candidate(); await pass(); review(); patch({ status: 'DONE' });
});
afterEach(async () => { vi.restoreAllMocks(); await h.state.flushActivityLog(); h.state.clearEmitter(); h.cleanup(); });

describe('strict consumer readiness (CQ-V09)', () => {
  it('keeps the real readiness assertion unconditional', async () => {
    const actual = await vi.importActual<typeof executionProfile>('../delivery/executionProfile.js');
    expect(() => actual.assertExecutionProfileReady('verified-local')).toThrow(expect.objectContaining({ codeName: 'EXECUTION_PROFILE_NOT_READY' }));
    expect(task().executionPolicySnapshot).toEqual(STRICT);
  });
  it.each([undefined, { version: 1, profile: 'legacy', planRevision: 1 }, { version: 1, profile: 'observe', planRevision: 1 },
    { ...STRICT, profile: 'legacy' }, { ...STRICT, profile: 'observe' }] as const)('refuses legacy-captured DONE %j', (snapshot) => {
    patch({ executionPolicySnapshot: snapshot });
    expect(evaluateDeliveryEvidence(h.state, task()).missingEvidence).toEqual([]);
    expectShortfall('task-1', ['verified-local-snapshot']);
  });
  it.each(['never existed', 'deleted'])('refuses a missing prerequisite: %s', async (kind) => {
    const id = kind === 'deleted' ? 'task-1' : 'task-missing';
    if (kind === 'deleted') await deleteTaskTool(h.state).handler({ taskId: id }, h.state);
    expectShortfall(id, ['prerequisite-missing']);
    expect(describeUnmetDependency(h.state, id, consumer())).toBe(`${id} [missing, missing prerequisite-missing]`);
  });
  it.each(['DONE', 'ARCHIVED'] as const)('accepts retained verified delivery in %s', (status) => {
    patch({ status }); if (status === 'ARCHIVED') receipt();
    expectShortfall('task-1', [], true);
  });
  it.each(['no review', 'older review', 'later rejection', 'no candidate'])('refuses status-only DONE: %s', async (kind) => {
    if (kind === 'no review') h.state.reviews.clear();
    if (kind === 'older review') { cand = candidate(); await pass(); }
    if (kind === 'later rejection') review('reject');
    if (kind === 'no candidate') h.state.candidates.clear();
    expectShortfall('task-1', kind === 'no candidate' ? ['approved-review', 'protected-checks-unmeasured', `required-check:${UNIT}`] : ['approved-review']);
    if (kind !== 'no candidate') expect(describeUnmetDependency(h.state, 'task-1', consumer())).toBe('task-1 [DONE, missing approved-review]');
  });
  it.each(['no receipt', 'older receipt', 'older review', 'later rejection', 'legacy snapshot', 'missing pass'])('ARCHIVED retains each proof part: %s', async (kind) => {
    patch({ status: 'ARCHIVED' }); receipt();
    if (kind === 'no receipt') h.state.receipts.clear();
    if (kind === 'older receipt') { cand = candidate(); await pass(); review(); }
    if (kind === 'older review') { cand = candidate(); await pass(); receipt(); }
    if (kind === 'later rejection') review('reject');
    if (kind === 'legacy snapshot') patch({ executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    if (kind === 'missing pass') h.state.checkRuns.clear();
    const token = kind.includes('receipt') ? 'delivery-receipt' : kind === 'legacy snapshot' ? 'verified-local-snapshot'
      : kind === 'missing pass' ? `required-check:${UNIT}` : 'approved-review';
    expectShortfall('task-1', [token]);
    expect(describeUnmetDependency(h.state, 'task-1', consumer())).toBe(`task-1 [ARCHIVED, missing ${token}]`);
  });
  it('reports combined shortfalls in stable order', () => {
    patch({ status: 'ARCHIVED', executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    h.state.reviews.clear(); h.state.checkRuns.clear();
    expectShortfall('task-1', ['verified-local-snapshot', 'approved-review', 'delivery-receipt', `required-check:${UNIT}`]);
  });
  it.each(['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'BLOCKED'] as const)('withholds unfinished %s without evidence tokens', (status) => {
    patch({ status }); expectShortfall('task-1', []);
  });
  it.each(['legacy', 'observe'] as const)('preserves %s consumers and consumer-less calls under every deliveryPolicy', (profile) => {
    settings({ executionProfile: profile }); patch({ executionPolicySnapshot: { ...STRICT, profile } });
    for (const deliveryPolicy of ['legacy', 'local-branch', 'remote-push', 'merged-pull-request', 'manual-artifact']) {
      settings({ deliveryPolicy });
      for (const status of ['DONE', 'ARCHIVED', 'WORKING'] as const) {
        patch({ status }); const expected = status !== 'WORKING';
        for (const snapshot of [undefined, { ...STRICT, profile }]) {
          const row = { ...consumer(), executionPolicySnapshot: snapshot, dependsOn: ['task-1', 'task-missing'] };
          expect(unmetDependsOn(h.state, row)).toEqual(expected ? [] : ['task-1']);
          expect(dependencyShortfall(h.state, 'task-1')).toEqual({ satisfied: expected, missingEvidence: [] });
          expect(dependencyShortfall(h.state, 'task-missing')).toEqual({ satisfied: true, missingEvidence: [] });
        }
      }
    }
  });
  it.each(['consumer snapshot', 'prerequisite snapshot', 'live profile', 'ambiguous receipt', 'not ready'])('fails closed on %s', (kind) => {
    patch({ status: 'ARCHIVED' }); receipt();
    if (kind === 'consumer snapshot') h.state.tasks.set(consumer().id, { ...consumer(), executionPolicySnapshot: null as never });
    if (kind === 'prerequisite snapshot') patch({ executionPolicySnapshot: null as never });
    if (kind === 'live profile') settings({ executionProfile: 'unknown' });
    if (kind === 'ambiguous receipt') receipt();
    if (kind === 'not ready') vi.spyOn(executionProfile, 'assertExecutionProfileReady').mockImplementation(() => { throw new Error('NOT_READY'); });
    expect(() => dependencyShortfall(h.state, 'task-1', consumer())).toThrow();
    expect(isDependencySatisfied(h.state, 'task-1', consumer())).toBe(false);
    expect(describeUnmetDependency(h.state, 'task-1', consumer())).toContain('could not be judged');
    if (kind === 'consumer snapshot' || kind === 'live profile') expect(isDependencySatisfied(h.state, 'task-missing', consumer())).toBe(false);
  });
  it('keeps a blocked strict consumer until proof arrives, including late archived receipt', async () => {
    settings({ executionProfile: 'observe' });
    patch({ executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    h.state.tasks.set(consumer().id, { ...consumer(), status: 'BLOCKED', blockedFromStatus: 'WORKING',
      blockedOnTaskIds: ['task-1'], blockedAt: '2020-01-01T00:00:00.000Z' });
    expect(await runDependencyUnblock(h.state)).toEqual([]);
    const alert = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    expect(await alertStaleBlocks(h.state)).toBe(1);
    expect(alert.mock.calls[0][1]).toContain('task-1 [DONE, missing verified-local-snapshot]');
    patch({ executionPolicySnapshot: STRICT, status: 'ARCHIVED' });
    expect(await runDependencyUnblock(h.state)).toEqual([]);
    receipt(); expect(await runDependencyUnblock(h.state)).toEqual(['task-consumer']);
    expect(consumer().status).toBe('WORKING');
  });
  it('report_blocked retains a legacy-DONE blocker for a strict consumer', async () => {
    settings({ executionProfile: 'observe' }); patch({ executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    const result = await reportBlockedTool(h.state).handler({ taskId: consumer().id, reason: 'await verified delivery',
      blockedOnTaskIds: ['task-1'] }, h.state);
    expect(result).toMatchObject({ blockedOnTaskIds: ['task-1'] });
    expect(result).toMatchObject({ blockResolution: expect.stringContaining('task-1 [DONE, missing verified-local-snapshot]') });
    expect(consumer().status).toBe('BLOCKED');
    expect(unmetBlockedOnTaskIds(h.state, consumer())).toEqual(['task-1']);
  });
  it('explicit claim refuses DONE without approval before any write', async () => {
    h.state.reviews.clear();
    const before = fs.readFileSync(path.join(h.moePath, 'tasks', 'task-consumer.json'), 'utf8');
    const update = vi.spyOn(h.state, 'updateTask');
    const error = await claimNextTaskTool(h.state).handler({ taskId: consumer().id, statuses: ['WORKING'], workerId: 'worker-new', executionRoute: 'vm' }, h.state)
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ codeName: 'DEPENDENCY_EVIDENCE_MISSING', context: { missingEvidence: ['approved-review'] },
      message: expect.stringContaining('task-1 is DONE but lacks the retained verified delivery a verified-local task requires: approved-review (') });
    expect((error as Error).message).not.toContain('settings.deliveryPolicy requires');
    expect(update).not.toHaveBeenCalled(); expect(h.state.workers.size).toBe(0); expect(h.state.attempts.size).toBe(0);
    expect(fs.readFileSync(path.join(h.moePath, 'tasks', 'task-consumer.json'), 'utf8')).toBe(before);
  });
  it.each(['missing', 'ARCHIVED'] as const)('claim names %s proof without calling it DONE', async (status) => {
    if (status === 'missing') await deleteTaskTool(h.state).handler({ taskId: 'task-1' }, h.state);
    else patch({ status });
    const token = status === 'missing' ? 'prerequisite-missing' : 'delivery-receipt';
    const update = vi.spyOn(h.state, 'updateTask');
    const error = await claimNextTaskTool(h.state).handler({ taskId: consumer().id, statuses: ['WORKING'], executionRoute: 'vm' }, h.state)
      .catch((e: unknown) => e as { context: { reason: string } });
    expect(error).toMatchObject({ codeName: 'NOT_ALLOWED', context: { reason: expect.stringContaining(`task-1 [${status}, missing ${token}] ` +
      "(a verified-local task's dependsOn gates WORKING claims until each prerequisite has retained verified delivery, " +
      'not merely DONE/ARCHIVED, and a missing prerequisite never satisfies it).') } });
    expect(error.context.reason).not.toContain('(dependsOn gates WORKING claims until they are DONE/ARCHIVED)');
    expect(update).not.toHaveBeenCalled();
  });
  const block = (args: Record<string, unknown>) => reportBlockedTool(h.state).handler({ taskId: consumer().id, reason: 'wait', ...args }, h.state);
  it('report_blocked names an ARCHIVED prerequisite without its receipt', async () => {
    patch({ status: 'ARCHIVED' });
    const { blockResolution } = await block({ blockedOnTaskIds: ['task-1'] }) as { blockResolution: string };
    expect(blockResolution).toBe('It auto-unblocks (returning unassigned, claimable by anyone) once task-1 have retained verified delivery: ' +
      'this task runs verified-local, so DONE or ARCHIVED alone does not satisfy it, and a missing prerequisite never satisfies it. ' +
      'Still withheld: task-1 [ARCHIVED, missing delivery-receipt].');
    expect(blockResolution).not.toContain('once task-1 are DONE/ARCHIVED.');
  });
  it('report_blocked names a stored, since-deleted prerequisite', async () => {
    h.state.tasks.set(consumer().id, { ...consumer(), status: 'BLOCKED', blockedFromStatus: 'WORKING', assignedWorkerId: 'worker-x',
      blockedOnTaskIds: ['task-1', 'task-gone'], blockedAt: '2020-01-01T00:00:00.000Z' });
    const result = await block({ workerId: 'worker-x', blockedOnTaskIds: [] }) as { blockResolution: string };
    expect(result.blockResolution).toContain('once task-1, task-gone have retained verified delivery');
    expect(result.blockResolution).toMatch(/ Still withheld: task-gone \[missing, missing prerequisite-missing\]\.$/);
  });
  it('report_blocked on a satisfied prerequisite states the verified-local rule', async () => {
    expect(await block({ blockedOnTaskIds: ['task-1'] })).toMatchObject({ dependenciesSatisfied: true,
      message: expect.stringContaining('Every selected prerequisite (task-1) already has retained verified delivery — there is nothing to wait on') });
    expect(consumer().status).toBe('WORKING');
  });
  it('set_task_dependencies states the verified-local rule', async () => {
    patch({ status: 'ARCHIVED' });
    const set = async () => ((await setTaskDependenciesTool(h.state).handler({ taskId: consumer().id, workerId: 'architect-1',
      dependsOn: ['task-1'] }, h.state)) as { message: string }).message;
    expect(await set()).toBe('Dependencies replaced on task-consumer; 1 unmet (task-1) — WORKING claims stay gated until each has ' +
      'retained verified delivery (a missing prerequisite never satisfies a verified-local task).');
    receipt();
    expect(await set()).toBe('Dependencies replaced on task-consumer; all 1 already have retained verified delivery — the task is claimable now.');
  });
  it('tool descriptions state the verified-local rule', () => {
    const blockedOn = (reportBlockedTool(h.state).inputSchema.properties as Record<string, { description: string }>).blockedOnTaskIds;
    for (const text of [claimNextTaskTool(h.state).description, setTaskDependenciesTool(h.state).description,
      reportBlockedTool(h.state).description, blockedOn.description]) {
      expect(text).toContain("a verified-local task needs each one's retained verified delivery instead, and a missing id never satisfies it");
    }
  });
  it('live verified-local also floors a legacy-captured consumer', () => {
    h.state.tasks.set(consumer().id, { ...consumer(), executionPolicySnapshot: { ...STRICT, profile: 'legacy' } });
    patch({ executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    expectShortfall('task-1', ['verified-local-snapshot']);
  });
  it('role-gates and attributes removal without manufacturing evidence', async () => {
    settings({ executionProfile: 'observe' }); patch({ executionPolicySnapshot: { ...STRICT, profile: 'observe' } });
    const row = { ...consumer(), dependsOn: ['task-missing', 'task-1'] }; h.state.tasks.set(row.id, row);
    const team = await h.state.createTeam({ name: 'workers', role: 'worker' });
    await h.state.createWorker({ id: 'seat-worker', type: 'CODEX', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE' });
    await h.state.addTeamMember(team.id, 'seat-worker');
    const file = path.join(h.moePath, 'tasks', 'task-consumer.json'); const bytes = fs.readFileSync(file, 'utf8');
    const remove = (workerId: string, id: string) => setTaskDependenciesTool(h.state).handler({ taskId: row.id, workerId, removeDependsOn: [id] }, h.state);
    await expect(remove('seat-worker', 'task-missing')).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    const sizes = () => [h.state.reviews.size, h.state.receipts.size, h.state.candidates.size, h.state.checkRuns.size];
    const before = sizes(); const evidence = evaluateDeliveryEvidence(h.state, consumer());
    const shortfall = dependencyShortfall(h.state, 'task-1', consumer());
    const message = vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue(undefined);
    await remove('architect-1', 'task-missing'); await h.state.flushActivityLog();
    expect(h.state.getActivityLog().find((e) => e.event === 'TASK_DEPENDENCIES_SET')?.workerId).toBe('architect-1');
    expect(message).toHaveBeenCalledWith(row.id, expect.stringContaining('-[task-missing]'));
    expect(unmetDependsOn(h.state, consumer())).toEqual(['task-1']);
    await remove('architect-1', 'task-1');
    expect(unmetDependsOn(h.state, consumer())).toEqual([]);
    expect(sizes()).toEqual(before); expect(evaluateDeliveryEvidence(h.state, consumer())).toEqual(evidence);
    expect(dependencyShortfall(h.state, 'task-1', consumer())).toEqual(shortfall);
  });
  it.each(['prerequisite-missing', 'verified-local-snapshot', 'approved-review', 'delivery-receipt'])('explains %s', (token) => {
    expect(describeMissingEvidence(token)).not.toBe('unrecognised evidence token');
    if (token === 'prerequisite-missing') expect(describeMissingEvidence(token)).toContain('moe.set_task_dependencies');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { getContextTool } from '../tools/getContext.js';
import { recordCandidateTool } from '../tools/recordCandidate.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { waitForTaskTool } from '../tools/waitForTask.js';
import type { Task } from '../types/schema.js';
import { planReuseGit } from './planReuse.js';
import { ensurePlanReuseAssessment, settlePlanReuseAssessments } from './planReuseJob.js';

const h = new ToolTestHarness();
// GIT_* stripped, system/global config masked; identity and line endings pinned per call.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=',
  '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: h.testDir, encoding: 'utf8', env }).trim();
function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), text);
  }
  git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'change');
  return git('rev-parse', 'HEAD');
}
const row = (): Task => h.state.getTask('task-1')!;
const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const PLAN = [{ stepId: 'step-1', description: 'edit', status: 'PENDING', affectedFiles: ['src/a.ts'] }];
const CONTRACT = { sourceAssumptions: ['src/lib/b.ts exports b'] };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let release!: () => void; const opened = new Promise<void>(resolve => { release = resolve; });
  return { opened, release };
}
/** A pass-through Git spy that holds every call until the gate opens. */
function heldGit() {
  const real = planReuseGit.run; const g = gate();
  const spy = vi.spyOn(planReuseGit, 'run').mockImplementation(async (...args) => { await g.opened; return real(...args); });
  return { spy, release: g.release };
}
let basis = '';
async function seed(extra: Partial<Task> = {}): Promise<void> {
  h.createTask({ status: 'PLANNING', planRevision: 1, approvedPlanRevision: 1, implementationPlan: PLAN as never,
    executionContract: CONTRACT, planSourceBasis: { version: 1, commit: basis, planRevision: 1 },
    planningEntry: { from: 'BACKLOG', at: '2026-10-29T00:00:00.000Z', seq: 1 }, ...extra });
  await h.state.load();
}
async function run(): Promise<void> { ensurePlanReuseAssessment(h.state, row()); await settlePlanReuseAssessments(h.state); }
type Reply = { hasNext: boolean; timedOut?: boolean; planReuse?: unknown; task?: { id: string; planReuse?: unknown } };
const claim = (workerId: string, status: string) =>
  claimNextTaskTool(h.state).handler({ workerId, statuses: [status] }, h.state) as Promise<Reply>;
const wait = () => waitForTaskTool(h.state).handler({ workerId: 'architect-1', statuses: ['PLANNING'], timeoutMs: 200 },
  h.state) as Promise<Reply>;
/** Approved through the real path (TURBO submit_plan), then parked and re-queued: PLANNING entered from BACKLOG. */
async function approvedAndRequeued(beforePark?: () => Promise<void>): Promise<Task> {
  h.createTask({ status: 'PLANNING' }); await h.state.load();
  for (const [id, role] of [['architect-1', 'architect'], ['worker-1', 'worker']] as const) {
    await h.state.addTeamMember((await h.state.createTeam({ name: `${role}s`, role })).id, id);
  }
  await submitPlanTool(h.state).handler({ taskId: 'task-1', executionContract: CONTRACT,
    steps: [{ description: 'edit', affectedFiles: ['src/a.ts'] }] }, h.state);
  const approved = structuredClone(row());
  expect(approved).toMatchObject({ status: 'WORKING', approvedPlanRevision: approved.planRevision,
    planSourceBasis: { commit: basis } });
  await beforePark?.();
  await h.state.updateTask('task-1', { status: 'BACKLOG' }); await h.state.updateTask('task-1', { status: 'PLANNING' });
  return approved;
}

beforeEach(() => {
  h.init(); h.setupMoeFolder({ settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
    branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude' } as never });
  h.createEpic(); h.createWorker({ id: 'architect-1' }); h.createWorker({ id: 'worker-1' }); git('init', '-q');
  basis = commit({ 'src/a.ts': 'a\n', 'src/lib/b.ts': 'b\n', 'docs/readme.md': 'r\n' });
});
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

describe('assessment job', () => {
  it.each([
    ['source-unavailable', () => { vi.spyOn(planReuseGit, 'run').mockRejectedValue(new Error('injected')); }],
    ['assessment-failed: boom', () => { Object.defineProperty(h.state, 'projectPath', { get: () => { throw new Error('boom\nmore'); } }); }],
  ])('J1 a failed assessment records reassess (%s) and leaves nothing pending', async (reason, arrange) => {
    await seed(); arrange(); await run();
    expect(row().status).toBe('PLANNING');
    expect(row().planReuse).toMatchObject({ decision: 'reassess', planRevision: 1, entrySeq: 1, basisCommit: basis });
    expect(row().planReuse!.reasons[0].startsWith(reason)).toBe(true);
  });
  it('J2 writes nothing when the plan changed while the job ran', async () => {
    await seed(); const held = heldGit(); ensurePlanReuseAssessment(h.state, row());
    await h.state.updateTask('task-1', { implementationPlan: [{ ...PLAN[0], description: 'edited' }] as never });
    expect(row().planRevision).toBe(2);
    held.release(); await settlePlanReuseAssessments(h.state);
    expect(row().planReuse).toBeUndefined(); expect(row().status).toBe('PLANNING');
  });
  it('J3 runs one job per pending row and resumes it on reuse', async () => {
    await seed(); const held = heldGit();
    ensurePlanReuseAssessment(h.state, row()); ensurePlanReuseAssessment(h.state, row());
    held.release(); await settlePlanReuseAssessments(h.state);
    expect(held.spy.mock.calls.filter(([args]) => args.includes('HEAD^{commit}'))).toHaveLength(1);
    expect(row()).toMatchObject({ status: 'WORKING', planRevision: 1, approvedPlanRevision: 1,
      planReuse: { decision: 'reuse', reasons: [], headCommit: basis } });
  });
  it('J4 applies under the state lock, not inside the caller\'s lock context', async () => {
    await seed(); const spy = vi.spyOn(planReuseGit, 'run').mockRejectedValue(new Error('injected')); const lock = gate();
    const holder = h.state.runExclusive(async () => { ensurePlanReuseAssessment(h.state, row()); await lock.opened; });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled()); await sleep(100);
    expect(row().planReuse).toBeUndefined();
    lock.release(); await holder; await settlePlanReuseAssessments(h.state);
    expect(row().planReuse?.decision).toBe('reassess');
  });
  it('J5 a refused resume records reassess and keeps the row in PLANNING', async () => {
    await seed({ executionPolicySnapshot: STRICT as never }); await run();
    expect(row().status).toBe('PLANNING');
    expect(row().planReuse).toMatchObject({ decision: 'reassess', reasons: ['resume-refused:EXECUTION_PROFILE_NOT_READY'] });
  });
});

describe('scheduling', () => {
  it('S1 resumes valid approved work without a planner or a new submission', async () => {
    const approved = await approvedAndRequeued();
    expect(await claim('architect-1', 'PLANNING')).toMatchObject({ hasNext: false });
    await settlePlanReuseAssessments(h.state);
    const { planRevision, approvedPlanRevision, planSubmittedAt, planApprovedAt } = approved;
    expect(row()).toMatchObject({ status: 'WORKING', assignedWorkerId: null, planRevision, approvedPlanRevision,
      planSubmittedAt, planApprovedAt, planReuse: { decision: 'reuse', reasons: [], planRevision } });
    const claimed = await claim('worker-1', 'WORKING');
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-1' }, planReuse: row().planReuse });
    const context = await getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-1' }, h.state) as Reply;
    expect(context.task?.planReuse).toEqual(row().planReuse);
  });
  it('S2 hands an explicit replan straight to the architect without assessing', async () => {
    // From a row an earlier job resumed: its reuse record (older entry seq) must not mask the replan.
    await approvedAndRequeued(); await claim('architect-1', 'PLANNING'); await settlePlanReuseAssessments(h.state);
    expect(row()).toMatchObject({ status: 'WORKING', planReuse: { decision: 'reuse' } });
    await h.state.updateTask('task-1', { status: 'PLANNING' }); const spy = vi.spyOn(planReuseGit, 'run');
    expect(await claim('architect-1', 'PLANNING')).toMatchObject({ hasNext: true, task: { id: 'task-1' },
      planReuse: { decision: 'replan', reasons: ['replan-requested-from-WORKING'] } });
    expect(spy).not.toHaveBeenCalled();
  });
  it('S3 wait_for_task withholds a pending row and wakes once it is assessed', async () => {
    await approvedAndRequeued(); commit({ 'src/lib/b.ts': 'changed\n' }); const held = heldGit();
    expect(await wait()).toMatchObject({ hasNext: false, timedOut: true });
    held.release(); await settlePlanReuseAssessments(h.state);
    expect(row().planReuse).toMatchObject({ decision: 'reassess', reasons: ['assumption-changed:src/lib/b.ts'] });
    expect(await wait()).toMatchObject({ hasNext: true });
  });
});

describe('source movement', () => {
  /** The real path to a pending row, then the architect's ranked claim triggers and settles its assessment. */
  async function assessed(arrange: () => void, beforePark?: () => Promise<void>): Promise<Task> {
    const approved = await approvedAndRequeued(beforePark); arrange();
    expect(await claim('architect-1', 'PLANNING')).toMatchObject({ hasNext: false });
    await settlePlanReuseAssessments(h.state);
    return approved;
  }
  async function recordCandidate(): Promise<void> {
    const { attemptId, generation } = await claim('worker-1', 'WORKING') as Reply & { attemptId: string; generation: number };
    await recordCandidateTool(h.state).handler({ id: 'cand-1', taskId: 'task-1', attemptId, generation, workerId: 'worker-1',
      baseRevision: basis, treeSha: git('rev-parse', 'HEAD^{tree}'),
      deliveryTarget: `refs/heads/${git('symbolic-ref', '--short', 'HEAD')}` }, h.state);
  }
  it('E1 an unrelated commit resumes the approved plan without a planner', async () => {
    const approved = await assessed(() => { commit({ 'docs/readme.md': 'edited\n' }); });
    expect(row()).toMatchObject({ status: 'WORKING', planRevision: approved.planRevision,
      planReuse: { decision: 'reuse', reasons: [], basisCommit: basis, headCommit: git('rev-parse', 'HEAD') } });
    expect(row().planReuse!.headCommit).not.toBe(basis);
  });
  it.each([
    ['E2 a changed assumption anchor', () => { commit({ 'src/lib/b.ts': 'changed\n' }); }, 'assumption-changed:src/lib/b.ts'],
    ['E3 an unavailable source', () => { vi.spyOn(planReuseGit, 'run').mockRejectedValue(new Error('injected')); },
      'source-unavailable'],
  ])('%s hands the row to the architect for reassessment', async (_label, arrange, reason) => {
    await assessed(arrange);
    expect(row().status).toBe('PLANNING');
    const claimed = await claim('architect-1', 'PLANNING');
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-1' }, planReuse: { decision: 'reassess' } });
    expect((claimed.planReuse as { reasons: string[] }).reasons[0].startsWith(reason)).toBe(true);
    const context = await getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'architect-1' }, h.state) as Reply;
    expect(context.task?.planReuse).toEqual(claimed.planReuse);
  });
  it.each([
    ['moved', 'revalidate', ['target-moved']],
    ['unchanged', 'current', []],
  ])('E4 a %s delivery target marks the candidate %s and keeps reuse', async (moved, candidate, reasons) => {
    await assessed(() => { if (moved === 'moved') commit({ 'docs/other.md': 'o\n' }); }, recordCandidate);
    expect(h.state.candidates.size).toBe(1);
    expect(row()).toMatchObject({ status: 'WORKING', planReuse: { decision: 'reuse', candidate, reasons } });
  });
});

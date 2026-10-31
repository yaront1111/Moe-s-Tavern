// =============================================================================
// Planner boundaries, end to end (CQ-C11, DoD2 and DoD3).
//
// A planner call is an architect claim_next_task({statuses: ['PLANNING']}) that returns the task. Zero planner calls
// happen only on C07 reuse (and refresh, which reuses the approved plan and serves the changed paths) and on an
// eligible C09 recipe under TURBO. A changed source assumption, an explicit replan, a DoD or contract change and every
// recipe fallback reach a planner. No path re-stamps an approval or skips CONTROL/SPEED. Post-patch scope (extra edits)
// and delta incarnation boundaries are proven in contextInvalidation.e2e.test.ts (R2, D1-D7).
// =============================================================================
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planReuseGit } from '../context/planReuse.js';
import { settlePlanReuseAssessments } from '../context/planReuseJob.js';
import { docsLiteralReplace } from '../context/recipes/docsLiteralReplace.js';
import { instantiateRecipe, readRecipeInstance, RECIPE_DEFINITIONS_PATH as DEFS } from '../context/recipes/recipe.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { clearAllSpeedModeTimeouts, RECIPE_ACTOR, submitPlanTool } from '../tools/submitPlan.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { RecipeDefinition, Task, TaskStatus } from '../types/schema.js';

const h = new ToolTestHarness();
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: h.testDir, env: gitEnv, encoding: 'utf8' }).trim();
const commit = (files: Record<string, string>, add = Object.keys(files)) => {
  for (const [name, text] of Object.entries(files)) { const file = path.join(h.testDir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  git('add', ...add); git('commit', '-qm', 'c'); return git('rev-parse', 'HEAD');
};
const row = (): Task => h.state.getTask('task-1')!;
const settings = (patch: Record<string, unknown>) => { h.state.project!.settings = { ...h.state.project!.settings, ...patch } as never; };
type Reply = { hasNext: boolean; task?: { id: string }; planReuse?: { decision: string; reasons: string[]; changedPaths?: string[] } };
const claim = (workerId: string, status: TaskStatus) => claimNextTaskTool(h.state).handler({ workerId, statuses: [status] }, h.state) as Promise<Reply>;
/** Ranked architect claims, each followed by any assessment it started: how many returned the task (0 or 1), and the reply. */
async function plannerCalls(): Promise<{ calls: number; reply?: Reply }> {
  for (let i = 0; i < 2; i++) {
    const reply = await claim('architect-1', 'PLANNING'); await settlePlanReuseAssessments(h.state);
    if (reply.hasNext && reply.task?.id === 'task-1') return { calls: 1, reply };
  }
  return { calls: 0 };
}

const ORIGINAL = '# Guide\nUse the old flag.\n';
const DEF: RecipeDefinition = { id: 'docs-fix', kind: docsLiteralReplace.name, version: 1,
  requiredChecks: [{ id: 'docs', command: 'npm run lint:docs' }], params: { allowedPaths: ['docs'] } };
const INPUTS = { path: 'docs/a.md', originalSha256: createHash('sha256').update(ORIGINAL).digest('hex'), oldText: 'old flag', newText: 'new flag' };

beforeEach(async () => {
  h.init(); h.setupMoeFolder({ settings: { approvalMode: 'TURBO', speedModeDelayMs: 30, autoCreateBranch: false, branchPattern: 'moe/{epicId}/{taskId}',
    commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude' } as never });
  h.createEpic(); h.createWorker({ id: 'architect-1' }); h.createWorker({ id: 'worker-1' }); h.createTask({ status: 'PLANNING' });
  git('init', '-q');
  commit({ 'src/a.ts': 'a\n', 'src/lib/b.ts': 'b\n', 'docs/readme.md': 'r\n', 'docs/a.md': ORIGINAL, [DEFS]: JSON.stringify({ version: 1, recipes: [DEF] }) }, ['-A']);
  await h.state.load();
  for (const [id, role] of [['architect-1', 'architect'], ['worker-1', 'worker']] as const) {
    await h.state.addTeamMember((await h.state.createTeam({ name: `${role}s`, role })).id, id);
  }
});
afterEach(() => { clearAllSpeedModeTimeouts(); vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

describe('C07 approved-plan reuse (DoD2)', () => {
  /** Approved through TURBO submit_plan, then re-entered PLANNING from `from` (BACKLOG is a requeue; the rest are explicit). */
  async function approvedThenPlanning(from: TaskStatus): Promise<Task> {
    await submitPlanTool(h.state).handler({ taskId: 'task-1', executionContract: { sourceAssumptions: ['src/lib/b.ts exports b'] },
      steps: [{ description: 'Edit a with error handling and a test', affectedFiles: ['src/a.ts'] }] }, h.state);
    const approved = structuredClone(row());
    expect(approved).toMatchObject({ status: 'WORKING', approvedPlanRevision: approved.planRevision });
    if (from !== 'WORKING') await h.state.updateTask('task-1', { status: from });
    await h.state.updateTask('task-1', { status: 'PLANNING' });
    return approved;
  }
  it.each<[string, () => unknown, Record<string, unknown>]>([
    ['an unrelated commit', () => commit({ 'docs/readme.md': 'edited\n' }), { decision: 'reuse', reasons: [] }],
    ['a changed affected file', () => commit({ 'src/a.ts': 'changed\n' }), { decision: 'refresh', reasons: ['affected-file-changed:src/a.ts'], changedPaths: ['src/a.ts'] }],
  ])('Z1 %s resumes the approved plan with zero planner calls and no new approval', async (_label, arrange, planReuse) => {
    const approved = await approvedThenPlanning('BACKLOG'); arrange();
    expect(await plannerCalls()).toEqual({ calls: 0 });
    const { planRevision, approvedPlanRevision, planApprovedAt, planSubmittedAt, implementationPlan, executionContract } = approved;
    expect(row()).toMatchObject({ status: 'WORKING', planRevision, approvedPlanRevision, planApprovedAt, planSubmittedAt, implementationPlan, executionContract, planReuse });
    expect(await claim('worker-1', 'WORKING')).toMatchObject({ hasNext: true, planReuse });
  });
  it.each<[string, TaskStatus, () => unknown, string, string]>([
    ['a changed assumption anchor', 'BACKLOG', () => commit({ 'src/lib/b.ts': 'changed\n' }), 'reassess', 'assumption-changed:src/lib/b.ts'],
    ['an explicit replan from WORKING', 'WORKING', () => undefined, 'replan', 'replan-requested-from-WORKING'],
    ['an explicit replan from REVIEW', 'REVIEW', () => undefined, 'replan', 'replan-requested-from-REVIEW'],
    ['a DoD change', 'BACKLOG', () => h.state.updateTask('task-1', { definitionOfDone: ['A new criterion'] }), 'replan', 'approval-not-current'],
    ['a contract change', 'BACKLOG', () => h.state.updateTask('task-1', { executionContract: { sourceAssumptions: ['src/a.ts only'] } }), 'replan', 'approval-not-current'],
  ])('P1 %s reaches a planner with the reason, and the row stays unapproved', async (_label, from, arrange, decision, reason) => {
    const approved = await approvedThenPlanning(from); await arrange();
    const { calls, reply } = await plannerCalls();
    expect([calls, reply?.planReuse]).toEqual([1, expect.objectContaining({ decision, reasons: [reason] })]);
    expect(row()).toMatchObject({ status: 'PLANNING', assignedWorkerId: 'architect-1', planApprovedAt: approved.planApprovedAt });
    if (decision === 'replan' && from === 'BACKLOG') expect(row().planRevision).toBe(approved.planRevision! + 1);
    expect(await claim('worker-1', 'WORKING')).toMatchObject({ hasNext: false });
  });
  it('B3 a planner who explicitly claims the row while its assessment runs keeps it: the late result writes nothing', async () => {
    await approvedThenPlanning('BACKLOG'); commit({ 'docs/readme.md': 'edited\n' });
    let release!: () => void; const opened = new Promise<void>(resolve => { release = resolve; }), real = planReuseGit.run;
    vi.spyOn(planReuseGit, 'run').mockImplementation(async (...args) => { await opened; return real(...args); });
    expect(await claim('architect-1', 'PLANNING')).toMatchObject({ hasNext: false });
    expect(await claimNextTaskTool(h.state).handler({ workerId: 'architect-1', taskId: 'task-1', statuses: ['PLANNING'] }, h.state)).toMatchObject({ hasNext: true, task: { id: 'task-1' } });
    release(); await settlePlanReuseAssessments(h.state);
    expect([row().status, row().assignedWorkerId, row().planReuse]).toEqual(['PLANNING', 'architect-1', undefined]);
  });
});

describe('C08/C09 recipes (DoD2, DoD3)', () => {
  const instantiate = (inputs: Record<string, unknown> = INPUTS, recipeId = DEF.id) => instantiateRecipe(h.state, { taskId: 'task-1', recipeId, inputs });
  it('Z2 an eligible recipe under TURBO reaches WORKING with zero planner calls, inside the approved scope', async () => {
    expect(await instantiate()).toEqual({ instantiated: true, status: 'WORKING', planRevision: row().planRevision });
    expect(await plannerCalls()).toEqual({ calls: 0 });
    expect(row()).toMatchObject({ status: 'WORKING', approvedPlanRevision: row().planRevision, implementationPlan: [{ affectedFiles: ['docs/a.md'] }],
      executionContract: { approvedScope: ['docs/a.md'] } });
    expect(readRecipeInstance(row())).toMatchObject({ recipeId: DEF.id, inputs: INPUTS, planRevision: row().planRevision });
    expect(await claim('worker-1', 'WORKING')).toMatchObject({ hasNext: true, task: { id: 'task-1' } });
  });
  it.each<[string, () => unknown, Record<string, unknown>, string?]>([
    ['docs-replace-hash-mismatch', () => commit({ 'docs/a.md': '# Guide\nUse the old flag, or not.\n' }), INPUTS],
    ['docs-replace-path-not-allowed', () => undefined, { ...INPUTS, path: 'src/a.md' }],
    ['docs-replace-old-text-missing', () => undefined, { ...INPUTS, oldText: 'no such flag' }],
    ['recipe-not-found', () => undefined, INPUTS, 'other-recipe'],
    ['recipe-definitions-missing', () => { git('rm', '-q', '--cached', DEFS); git('commit', '-qm', 'untrack'); }, INPUTS],
  ])('P2 a %s fallback leaves the row untouched and reaches a planner', async (reason, arrange, inputs, recipeId) => {
    await arrange(); const posted = vi.spyOn(h.state, 'postSystemMessage');
    expect(await instantiate(inputs, recipeId)).toEqual({ instantiated: false, fallback: 'ordinary-planning', reason });
    expect(posted).toHaveBeenCalledWith('task-1', expect.stringContaining(`(${reason}): ordinary planning applies`));
    expect([row().planRevision ?? 0, row().implementationPlan, row().recipeInstance, row().approvedPlanRevision]).toEqual([0, [], undefined, undefined]);
    expect(await plannerCalls()).toMatchObject({ calls: 1 });
  });
  it('B1 CONTROL keeps a recipe plan awaiting a human; SPEED approves it only after the delay', async () => {
    settings({ approvalMode: 'CONTROL' });
    expect(await instantiate()).toMatchObject({ instantiated: true, status: 'AWAITING_APPROVAL' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect([row().status, row().approvedPlanRevision, (await claim('worker-1', 'WORKING')).hasNext, (await plannerCalls()).calls]).toEqual(['AWAITING_APPROVAL', undefined, false, 0]);
    await h.state.updateTask('task-1', { status: 'PLANNING' }); settings({ approvalMode: 'SPEED', speedModeDelayMs: 300 });
    expect(await instantiate()).toMatchObject({ instantiated: true, status: 'AWAITING_APPROVAL' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect([row().status, row().approvedPlanRevision, (await claim('worker-1', 'WORKING')).hasNext]).toEqual(['AWAITING_APPROVAL', undefined, false]);
    await vi.waitFor(() => expect([row().status, row().approvedPlanRevision]).toEqual(['WORKING', row().planRevision]));
  });
  it('B2 the recipe identity and its binding cannot be forged from the wire', async () => {
    await expect(submitPlanTool(h.state).handler({ taskId: 'task-1', workerId: RECIPE_ACTOR,
      steps: [{ description: 'Edit docs with error handling and a test', affectedFiles: ['docs/a.md'] }] }, h.state)).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    const forged = { recipeId: DEF.id, kind: DEF.kind, recipeVersion: 1, definitionDigest: 'a'.repeat(64), commit: git('rev-parse', 'HEAD'), inputs: INPUTS, inputsDigest: 'b'.repeat(64) };
    await h.state.updateTask('task-1', { recipeInstance: { version: 1, ...forged, planRevision: 0 } });
    expect([row().status, row().implementationPlan, row().recipeInstance, readRecipeInstance(row())]).toEqual(['PLANNING', [], undefined, null]);
  });
});

// =============================================================================
// Recorded rollout controls, end to end (CQ-M05, DoD1).
//
// Observation is outcome-identical to legacy. It cannot authorize verified
// completion (E1), observe-era progress is never strict evidence (E2), and it
// cannot authorize a recipe bypass of the human gate (E3). Every profile is set
// through StateManager.updateSettings, the only rollout control; the strict
// cutover is F12's in-memory hand edit, because the validated path refuses it.
// Real tool handlers and a real temp Git repository; nothing is mocked.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { clearAllSpeedModeTimeouts, RECIPE_ACTOR, submitPlanTool } from '../tools/submitPlan.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { getContextTool } from '../tools/getContext.js';
import { startStepTool } from '../tools/startStep.js';
import { completeStepTool } from '../tools/completeStep.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { finalizeAttemptTool } from '../tools/finalizeAttempt.js';
import { getAttempt } from '../state/attemptStore.js';
import { docsLiteralReplace } from '../context/recipes/docsLiteralReplace.js';
import { instantiateRecipe, readRecipeInstance, RECIPE_DEFINITIONS_PATH as DEFS } from '../context/recipes/recipe.js';
import type { MoeError } from '../util/errors.js';
import type { RecipeDefinition, Task } from '../types/schema.js';

const TASK = 'task-1';
const RUNNER = { processStartedAt: '4242@2026-10-31T00:00:00.0000000Z', host: 'box-1' };
const PROFILES = ['legacy', 'observe'] as const;
type Profile = (typeof PROFILES)[number];
type Row = Record<string, unknown>;
type Ids = { workerId: string; attemptId?: string; generation?: number; sessionId?: string };
const SUMMARY = 'Re-ran the gate and checked each DoD item against the recorded evidence.';
const SETTING = { setting: 'executionProfile' };
const OBSERVED = { ...SETTING, from: 'legacy', to: 'observe', transition: 'observe', outcome: 'applied' };
const GAPS = [
  { capability: 'vm', reason: 'vm-provisioning-uncertified' },
  { capability: 'check', reason: 'check-runner-uncertified' },
];

const h = new ToolTestHarness();
beforeEach(() => {
  for (const key of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(key, '');
  h.init();
});
afterEach(async () => {
  clearAllSpeedModeTimeouts();
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

const task = (): Task => h.state.getTask(TASK)!;
const taskBytes = () => fs.readFileSync(path.join(h.moePath, 'tasks', `${TASK}.json`), 'utf8');
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: MoeError) => e.codeName);
const evidence = (id: Ids) => getAttempt(h.state, id.attemptId!)?.stepCompletions?.map((e) => [e.stepId, e.planRevision]);
const start = (id: Ids, stepId: string) => startStepTool(h.state).handler({ taskId: TASK, stepId, ...id }, h.state);
const step = (id: Ids, stepId: string) =>
  completeStepTool(h.state).handler({ taskId: TASK, stepId, modifiedFiles: ['file.ts'], ...id }, h.state);
const done = (id: Ids) =>
  completeTaskTool(h.state).handler({ taskId: TASK, verification: { command: 'npm test', exitCode: 0 }, ...id }, h.state);

async function records(): Promise<Row[]> {
  await h.state.flushActivityLog();
  return h.state.getActivityLog(500).filter((e) => e.event === 'PROJECT_SETTINGS_UPDATED').map((e) => e.payload);
}
/** The only control; explicit legacy records nothing, observe records its transition first. */
async function setProfile(profile: Profile): Promise<void> {
  await h.state.updateSettings({ executionProfile: profile });
  expect(await records()).toEqual(profile === 'observe' ? [OBSERVED] : []);
}
/** A second project in the same test: the first one's daemon is retired and its folder removed. */
async function fresh(): Promise<void> {
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  h.cleanup();
  h.init();
}

/** Under `profile`: a two-step plan approved at revision 1, a wrapper claim and its served context. */
async function boot(profile: Profile): Promise<{ w: Required<Ids>; policy: Row }> {
  h.setupMoeFolder({ schemaVersion: 6 });
  h.createEpic();
  h.createTask({ id: TASK, status: 'PLANNING' });
  await h.state.load();
  await setProfile(profile);
  await submitPlanTool(h.state).handler({ taskId: TASK, steps: [
    { description: 'first', affectedFiles: ['file.ts'] }, { description: 'second', affectedFiles: ['file.ts'] },
  ] }, h.state);
  await h.state.runExclusive(() => h.state.approveTask(TASK, 1));
  expect(task()).toMatchObject({ status: 'WORKING', planRevision: 1, approvedPlanRevision: 1 });
  const r = (await claimNextTaskTool(h.state).handler(
    { workerId: 'worker-w', statuses: ['WORKING'], taskId: TASK, ...RUNNER }, h.state)) as Row;
  expect(r.hasNext).toBe(true);
  const w = { workerId: 'worker-w', attemptId: String(r.attemptId), generation: Number(r.generation), sessionId: 'worker-w@session-1' };
  const served = (await getContextTool(h.state).handler({ taskId: TASK, workerId: w.workerId, sessionId: w.sessionId }, h.state)) as Row;
  return { w, policy: served.executionPolicy as Row };
}

describe('rollout controls E2E (CQ-M05)', () => {
  it('E1 observation cannot authorize verified completion: observe completes and approves exactly as legacy', async () => {
    const finals: Task[] = [];
    for (const profile of PROFILES) {
      if (finals.length > 0) await fresh();
      const { w, policy } = await boot(profile);
      expect([policy.effectiveProfile, (policy.attemptSnapshot as Row).profile]).toEqual([profile, profile]);
      const bare = { workerId: w.workerId };
      for (const stepId of ['step-1', 'step-2']) {
        await start(bare, stepId);
        await step(bare, stepId);
      }
      await expect(done(bare)).resolves.toMatchObject({ success: true, status: 'REVIEW' });
      // The wrapper lands the bytes and closes the producer's attempt before QA can claim (F12 DoD3).
      await finalizeAttemptTool(h.state).handler({ taskId: TASK, workerId: w.workerId, runnerId: w.workerId,
        attemptId: w.attemptId, generation: w.generation, outcome: 'landed', landedRevision: 'c'.repeat(40) }, h.state);
      expect(await claimNextTaskTool(h.state).handler({ workerId: 'qa-q', statuses: ['REVIEW'], taskId: TASK }, h.state))
        .toMatchObject({ hasNext: true });
      await getContextTool(h.state).handler({ taskId: TASK, workerId: 'qa-q' }, h.state);
      await qaApproveTool(h.state).handler({ taskId: TASK, workerId: 'qa-q', summary: SUMMARY }, h.state);
      expect(task().status).toBe('DONE');
      expect(getAttempt(h.state, w.attemptId)).not.toHaveProperty('stepCompletions');
      expect(task().verification).toMatchObject({ source: 'agent-reported' });
      finals.push(structuredClone(task()));
    }
    const comparable = (t: Task) => {
      const { reportedAt: _reportedAt, ...verification } = t.verification as unknown as Row;
      return { keys: Object.keys(t).sort(), status: t.status, planRevision: t.planRevision,
        approvedPlanRevision: t.approvedPlanRevision, reopenCount: t.reopenCount, verification };
    };
    expect(comparable(finals[1])).toEqual(comparable(finals[0]));
  });

  it('E2 observe-era progress is never verified evidence, and a rollback to observe restores compatibility completion', async () => {
    const { w } = await boot('observe');
    const bare = { workerId: w.workerId };
    await start(bare, 'step-1');
    await step(bare, 'step-1');
    expect(getAttempt(h.state, w.attemptId)).not.toHaveProperty('stepCompletions');

    expect(await codeOf(h.state.updateSettings({ executionProfile: 'verified-local' }))).toBe('EXECUTION_PROFILE_NOT_READY');
    h.state.project!.settings.executionProfile = 'verified-local'; // F12's strictInMemory hand edit
    await start(w, 'step-2');
    await step(w, 'step-2');
    expect(evidence(w)).toEqual([['step-2', 1]]);
    const before = taskBytes();
    const err = (await done(w).then(() => null, (e: MoeError) => e))!;
    expect(err.codeName).toBe('EXECUTION_EVIDENCE_INELIGIBLE');
    expect(err.context?.steps).toEqual(['step-1']);
    expect([task().status, taskBytes()]).toEqual(['WORKING', before]);

    await h.state.updateSettings({ executionProfile: 'observe' });
    expect(await records()).toEqual([
      { ...SETTING, from: 'verified-local', to: 'observe', transition: 'rollback', outcome: 'applied', retainedStrictTasks: 0,
        retainedStrictTaskIds: [], retainedStrictAttempts: 0, retainedStrictAttemptIds: [], unreadableSnapshots: 0 },
      { ...SETTING, from: 'observe', to: 'verified-local', transition: 'activate', outcome: 'refused',
        codeName: 'EXECUTION_PROFILE_NOT_READY', unsupportedCapabilities: GAPS },
      OBSERVED,
    ]);
    await expect(done(bare)).resolves.toMatchObject({ success: true, status: 'REVIEW' });
    expect(evidence(w)).toEqual([['step-2', 1]]);
  });

  describe('E3 observation cannot authorize a recipe bypass (CONTROL)', () => {
    const gitEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test',
    };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args],
      { cwd: h.testDir, env: gitEnv, encoding: 'utf8' }).trim();
    const ORIGINAL = '# Guide\nUse the old flag.\n';
    const DEF: RecipeDefinition = { id: 'docs-fix', kind: docsLiteralReplace.name, version: 1,
      requiredChecks: [{ id: 'docs', command: 'npm run lint:docs' }], params: { allowedPaths: ['docs'] } };
    const INPUTS = { path: 'docs/a.md', originalSha256: createHash('sha256').update(ORIGINAL).digest('hex'), oldText: 'old flag', newText: 'new flag' };

    /** A committed recipe fixture under `profile`: a forged recipe submit, an ineligible request, then an eligible one. */
    async function recipeRun(profile: Profile): Promise<Row> {
      h.setupMoeFolder({ settings: { approvalMode: 'CONTROL', speedModeDelayMs: 30, autoCreateBranch: false,
        branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude' } as never });
      h.createEpic();
      h.createTask({ id: TASK, status: 'PLANNING' });
      for (const [name, text] of Object.entries({ 'docs/a.md': ORIGINAL, [DEFS]: JSON.stringify({ version: 1, recipes: [DEF] }) })) {
        fs.mkdirSync(path.dirname(path.join(h.testDir, name)), { recursive: true });
        fs.writeFileSync(path.join(h.testDir, name), text);
      }
      git('init', '-q');
      git('add', '-A');
      git('commit', '-qm', 'c');
      await h.state.load();
      await setProfile(profile);

      const before = taskBytes();
      const forged = await codeOf(submitPlanTool(h.state).handler({ taskId: TASK, workerId: RECIPE_ACTOR,
        steps: [{ description: 'Edit docs with error handling and a test', affectedFiles: ['docs/a.md'] }] }, h.state));
      const fallback = await instantiateRecipe(h.state, { taskId: TASK, recipeId: DEF.id, inputs: { ...INPUTS, oldText: 'no such flag' } });
      expect(taskBytes()).toBe(before);
      const outcome = await instantiateRecipe(h.state, { taskId: TASK, recipeId: DEF.id, inputs: INPUTS });
      const { commit, ...instance } = readRecipeInstance(task()) as unknown as Row;
      expect(commit).toBe(git('rev-parse', 'HEAD'));
      return { forged, fallback, outcome, row: [task().status, task().approvedPlanRevision], instance };
    }

    it('an eligible recipe still awaits the human under observe, and every outcome matches legacy', async () => {
      const runs: Row[] = [];
      for (const profile of PROFILES) {
        if (runs.length > 0) await fresh();
        runs.push(await recipeRun(profile));
      }
      expect(runs[0]).toEqual({
        forged: 'NOT_ALLOWED',
        fallback: { instantiated: false, fallback: 'ordinary-planning', reason: 'docs-replace-old-text-missing' },
        outcome: { instantiated: true, status: 'AWAITING_APPROVAL', planRevision: 1 },
        row: ['AWAITING_APPROVAL', undefined],
        instance: expect.objectContaining({ recipeId: DEF.id, kind: DEF.kind, inputs: INPUTS, planRevision: 1 }),
      });
      expect(runs[1]).toEqual(runs[0]);
    });
  });
});

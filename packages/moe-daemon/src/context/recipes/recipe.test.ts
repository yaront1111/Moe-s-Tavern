import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../../tools/toolTestHarness.js';
import { clearAllSpeedModeTimeouts, RECIPE_ACTOR, submitPlanTool } from '../../tools/submitPlan.js';
import { evaluateDeliveryEvidence } from '../../delivery/policy.js';
import { planSourceGit } from '../planReuseState.js';
import {
  instantiateRecipe, readRecipeInstance, recipeDefinitionDigest, recipeInputsDigest, recipeKinds,
  RECIPE_DEFINITIONS_PATH as DEFS, type RecipeKind, type RecipeRequest,
} from './recipe.js';
import type { RecipeDefinition, Task } from '../../types/schema.js';

// CQ-C08 DoD on a real temporary repo: committed definitions, submit_plan's own flow and V01's delivery predicate.
const h = new ToolTestHarness();
const DEF: RecipeDefinition = { id: 'docs-fix', kind: 'fake', version: 3,
  requiredChecks: [{ id: 'docs', command: 'npm run lint:docs' }], params: { allowedPaths: ['docs'] } };
const INPUTS = { path: 'docs/a.md', text: 'x' };
const STEP = { description: 'Replace the docs text; keep error handling and the test unchanged', affectedFiles: ['docs/a.md'] };

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: h.testDir, encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
}
/** Writes the files, then commits everything unless `stage` is false. */
function commit(files: Record<string, string>, stage = true): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), text);
  }
  if (stage) { git('add', '-A'); git('commit', '-qm', 'fixture'); }
  return git('rev-parse', 'HEAD');
}
const recipes = (...defs: unknown[]) => JSON.stringify({ version: 1, recipes: defs });
const task = () => h.state.getTask('task-1')!;
const settings = (patch: Record<string, unknown>) => { h.state.project!.settings = { ...h.state.project!.settings, ...patch } as never; };
const run = (request: Partial<RecipeRequest> = {}) => instantiateRecipe(h.state, { taskId: 'task-1', recipeId: 'docs-fix', inputs: INPUTS, ...request });
const fellBack = (reason: string) => ({ instantiated: false, fallback: 'ordinary-planning', reason });
const fakeKind = () => ({ name: 'fake', validateDefinition: vi.fn<RecipeKind['validateDefinition']>(() => null),
  validateInputs: vi.fn<RecipeKind['validateInputs']>(() => null),
  assessSource: vi.fn<RecipeKind['assessSource']>(async () => ({ ok: true, assessment: 'seen' })),
  instantiate: vi.fn<RecipeKind['instantiate']>(() => ({ ok: true, steps: [{ ...STEP }], executionContract: { approvedScope: ['docs/a.md'] } })),
}) satisfies RecipeKind;
const expectUntouched = (before: Task, t = task()) =>
  expect([t.status, t.assignedWorkerId, t.planRevision, t.implementationPlan, t.recipeInstance, t.requiredCheckSnapshot])
    .toEqual([before.status, before.assignedWorkerId, before.planRevision, [], undefined, undefined]);
let seq = 0;
/** A runner-recorded candidate reporting `oid` for the definitions file, with a passing run of the recipe's check. */
function candidate(oid: string): void {
  const id = `cand-${++seq}`; const treeSha = 'ab'.repeat(20); const createdAt = new Date(Date.UTC(2026, 9, 25, 0, 0, seq)).toISOString();
  h.state.candidates.set(id, { id, attemptId: 'attempt-1', taskId: 'task-1', baseRevision: treeSha, treeSha,
    deliveryTarget: 'refs/heads/main', protectedEntries: [{ path: DEFS, oid }], createdAt });
  h.state.checkRuns.set(`${id}-run`, { id: `${id}-run`, candidateId: id, treeSha, command: 'npm run lint:docs', exitCode: 0,
    outputTail: '', runnerId: 'runner-1', source: 'runner-observed', createdAt });
}

let kind = fakeKind(); let head = '';
beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); h.createTask({ status: 'PLANNING' }); seq = 0;
  await h.state.load(); settings({ approvalMode: 'TURBO', speedModeDelayMs: 20 });
  git('init', '-q'); head = commit({ [DEFS]: recipes(DEF), 'docs/a.md': 'old\n' });
  kind = fakeKind(); recipeKinds.set('fake', kind);
});
afterEach(() => { recipeKinds.delete('fake'); clearAllSpeedModeTimeouts(); vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

describe('instantiateRecipe', () => {
  it.each(['TURBO', 'SPEED', 'CONTROL'])('R1 submits through submit_plan as the recipe actor under %s (DoD2)', async (mode) => {
    settings({ approvalMode: mode });
    const activity = vi.spyOn(h.state, 'appendActivity');
    const outcome = await run();
    const t = task();
    expect(outcome).toEqual({ instantiated: true, status: mode === 'TURBO' ? 'WORKING' : 'AWAITING_APPROVAL', planRevision: t.planRevision });
    expect([t.status, t.assignedWorkerId, t.approvedPlanRevision])
      .toEqual(mode === 'TURBO' ? ['WORKING', null, t.planRevision] : ['AWAITING_APPROVAL', null, undefined]);
    expect(t.implementationPlan).toEqual([{ stepId: 'step-1', status: 'PENDING', ...STEP }]);
    expect(t.executionContract).toEqual({ approvedScope: ['docs/a.md'],
      requiredChecks: [{ id: 'docs', command: 'npm run lint:docs', configs: [DEFS] }] });
    expect(t.requiredCheckSnapshot?.entries).toEqual([{ path: DEFS, oid: git('rev-parse', `HEAD:${DEFS}`) }]);
    expect(t.recipeInstance).toEqual({ version: 1, recipeId: 'docs-fix', kind: 'fake', recipeVersion: 3, definitionDigest: recipeDefinitionDigest(DEF),
      commit: head, inputs: INPUTS, inputsDigest: recipeInputsDigest(DEF, INPUTS), planRevision: t.planRevision });
    expect(readRecipeInstance(t)).toEqual(t.recipeInstance);
    expect(activity.mock.calls.filter(c => c[0] === 'PLAN_SUBMITTED').map(c => c.at(-1))).toEqual([RECIPE_ACTOR]);
    if (mode === 'SPEED') await vi.waitFor(() => expect([task().status, task().approvedPlanRevision]).toEqual(['WORKING', t.planRevision]));
    // CONTROL never auto-approves, not even past the SPEED delay.
    if (mode === 'CONTROL') await new Promise(resolve => setTimeout(resolve, 40));
    if (mode === 'CONTROL') expect([task().status, task().approvedPlanRevision]).toEqual(['AWAITING_APPROVAL', undefined]);
  });

  it('R2a leaves a row a planner holds to that planner (DoD2)', async () => {
    await h.state.updateTask('task-1', { assignedWorkerId: 'architect-1' });
    const before = task();
    expect(await run()).toEqual({ ...fellBack('recipe-plan-refused:NOT_ALLOWED'), detail: expect.stringContaining('architect-1') });
    expectUntouched(before);
    expect(task().assignedWorkerId).toBe('architect-1');
  });

  it('R2b reserves the recipe identity: a wire caller cannot act as it (DoD2)', async () => {
    const before = task();
    await expect(submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ description: 'x', affectedFiles: ['docs/a.md'] }],
      workerId: RECIPE_ACTOR }, h.state)).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expectUntouched(before);
  });

  it('R2c keeps the binding daemon-owned and clears it on an ordinary resubmission', async () => {
    await run();
    const bound = task().recipeInstance!;
    await h.state.updateTask('task-1', { recipeInstance: { ...bound, recipeVersion: 9 } });
    expect(task().recipeInstance).toEqual(bound);
    await h.state.updateTask('task-1', { status: 'PLANNING' });
    await submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ ...STEP }], workerId: 'architect-2' }, h.state);
    expect([task().status, task().recipeInstance]).toEqual(['WORKING', undefined]);
  });

  it('R2d reads a binding only while it is well-formed and current', async () => {
    await run();
    const t = task(); const bound = t.recipeInstance!;
    expect(readRecipeInstance({ ...t, recipeInstance: { ...bound, extra: 1 } as never })).toBeNull();
    expect(readRecipeInstance({ ...t, recipeInstance: { ...bound, inputsDigest: 'G'.repeat(64) } })).toBeNull();
    await h.state.updateTask('task-1', { implementationPlan: [{ ...t.implementationPlan[0], description: 'Edit the docs and test' }] });
    expect(task().planRevision).toBe(t.planRevision! + 1);
    expect(readRecipeInstance(task())).toBeNull();
  });

  const none = () => undefined;
  const rows: [reason: string, arrange: () => unknown, request?: Partial<RecipeRequest>][] = [
    ['recipe-source-unavailable', () => vi.spyOn(planSourceGit, 'run').mockRejectedValue(new Error('git down'))],
    ['recipe-definitions-missing', () => { git('rm', '-q', '--cached', DEFS); git('commit', '-qm', 'untrack'); }],
    ['recipe-definitions-invalid', () => commit({ [DEFS]: '{' })],
    ['recipe-definitions-invalid', () => commit({ [DEFS]: recipes({ ...DEF, requiredChecks: [] }) })],
    ['recipe-not-found', none, { recipeId: 'nope' }],
    ['recipe-kind-unknown', () => commit({ [DEFS]: recipes({ ...DEF, kind: 'other' }) })],
    ['recipe-request-invalid', none, { inputs: { a: { b: 1 } } }],
    ['fake-inputs-bad', () => kind.validateInputs.mockReturnValue('fake-inputs-bad')],
    ['fake-source-stale', () => kind.assessSource.mockResolvedValue({ ok: false, reason: 'fake-source-stale' })],
    ['recipe-kind-failed', () => kind.assessSource.mockRejectedValue(new Error('boom'))],
    ['fake-no-plan', () => kind.instantiate.mockReturnValue({ ok: false, reason: 'fake-no-plan' })],
    ['recipe-plan-refused:CONSTRAINT_VIOLATION', () => kind.instantiate.mockReturnValue({ ok: true,
      steps: [{ description: 'rm -rf docs, then test', affectedFiles: ['docs/a.md'] }] })],
    ['recipe-plan-refused:INVALID_STATE', () => h.state.updateTask('task-1', { status: 'BACKLOG' })],
  ];
  it.each(rows)('R3 falls back to ordinary planning with %s before any planner (DoD3)', async (reason, arrange, request) => {
    await arrange();
    const before = task();
    const posted = vi.spyOn(h.state, 'postSystemMessage');
    expect({ ...await run(request), detail: undefined }).toEqual(fellBack(reason));
    expectUntouched(before);
    expect(posted).toHaveBeenCalledWith('task-1', expect.stringContaining(`(${reason})`));
    if (reason === 'fake-source-stale') expect(kind.instantiate).not.toHaveBeenCalled();
  });

  it('R4 binds committed definitions only and holds a candidate that changes them (DoD1)', async () => {
    settings({ deliveryPolicy: 'local-branch' });
    commit({ [DEFS]: recipes({ ...DEF, version: 4 }) }, false);
    await run();
    expect(task().recipeInstance?.recipeVersion).toBe(3);
    const changed = `protected-check-changed:${DEFS}`;
    candidate('e5'.repeat(20));
    expect(evaluateDeliveryEvidence(h.state, task()).missingEvidence).toContain(changed);
    candidate(git('rev-parse', `HEAD:${DEFS}`));
    expect(evaluateDeliveryEvidence(h.state, task()).missingEvidence).not.toContain(changed);
  });
});

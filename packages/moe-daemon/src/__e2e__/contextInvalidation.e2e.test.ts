// =============================================================================
// Context invalidation across the CQ-C providers and roles, end to end (CQ-C11, DoD1).
//
// Real temporary Git repositories, the landed R09b snapshot export and real tool handlers. Positive (C04) and negative
// (C05) answers share one SourceCache and move only with content; an absent analyzer (C03) is never evidence of
// absence; a delta (C06) reaches only the session that acknowledged its base on this incarnation; a recipe (C08/C09)
// binds committed bytes and refuses a changed source, definition, input or protected check. Per-module matrices live
// beside each module; this file proves the pieces compose.
// =============================================================================
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDelta, type ContextDelta } from '../context/contextDelta.js';
import { lookupNegative, recordNegative, repositoryScopeGeneration, snapshotScopeGeneration, type NegativeQuery } from '../context/negativeSearch.js';
import { docsLiteralReplace } from '../context/recipes/docsLiteralReplace.js';
import { instantiateRecipe, readRecipeInstance, RECIPE_DEFINITIONS_PATH as DEFS } from '../context/recipes/recipe.js';
import type { SourceQuery } from '../context/repositorySource.js';
import { cachedRepositorySource, cachedSemanticSource, cachedSnapshotSource, SourceCache } from '../context/sourceCache.js';
import { evaluateDeliveryEvidence } from '../delivery/policy.js';
import { reconcileRunningAttempts, setAttemptPhase } from '../state/attemptStore.js';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { getContextTool } from '../tools/getContext.js';
import { reattachAttemptTool } from '../tools/reattachAttempt.js';
import { recordCandidateTool } from '../tools/recordCandidate.js';
import { clearAllSpeedModeTimeouts } from '../tools/submitPlan.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { RecipeDefinition } from '../types/schema.js';
import { MoeErrorCode } from '../util/errors.js';

// Snapshot fixtures come from the landed R09b producer, absent in the Docker context (packages/moe-daemon only).
const exporter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/local-runner/source-export.mjs');
const r09b = fs.existsSync(exporter) ? await import(pathToFileURL(exporter).href) : null;
const h = new ToolTestHarness();
const extraStates: StateManager[] = [];
// GIT_* stripped, system/global config masked, identity pinned.
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: h.testDir, env: gitEnv, encoding: 'utf8' }).trim();
const put = (files: Record<string, string | Buffer>) => {
  for (const [name, data] of Object.entries(files)) { const file = path.join(h.testDir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
};
/** Writes the files, stages `add` (default: just them) and commits. */
const commit = (files: Record<string, string>, add = Object.keys(files)) => { put(files); git('add', ...add); git('commit', '-qm', 'c'); return git('rev-parse', 'HEAD'); };
const rm = (name: string) => fs.rmSync(path.join(h.testDir, name));
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => {
  h.init(); h.setupMoeFolder(); h.createEpic(); git('init', '-q');
});
afterEach(() => {
  clearAllSpeedModeTimeouts();
  for (const state of [h.state, ...extraStates.splice(0)]) state.clearEmitter();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup();
});

const find = (literal: string): SourceQuery => ({ id: literal, purpose: 'caller', op: 'search', literal, paths: ['src'] });
const read = (name: string): SourceQuery => ({ id: name, purpose: 'source', op: 'read', path: name });

describe.skipIf(!r09b)('P/N positive and negative answers share one cache and follow content only (C04, C05)', () => {
  it('P1 a dirty edit invisible to git status re-keys only its slice; a lockfile edit only the lockfile slice', async () => {
    const base = commit({ 'src/a.ts': 'alpha0\n', 'src/b.ts': 'b\n', 'package-lock.json': '{}\n' }), c = new SourceCache();
    const take = async (files: Record<string, string>) => {
      put(files); const s = await r09b.exportSourceSnapshot({ repoDir: h.testDir, commit: base }), hits = c.stats().hits;
      const served = cachedSnapshotSource(c, s, { commit: base }, [read('src/a.ts'), read('src/b.ts'), read('package-lock.json')]);
      return [git('status', '--porcelain=v1', '-uno'), served.items.map(i => i.content), c.stats().hits - hits];
    };
    expect(await take({ 'src/a.ts': 'alpha1\n' })).toEqual(['M src/a.ts', ['alpha1\n', 'b\n', '{}\n'], 0]);
    expect(await take({ 'src/a.ts': 'bravo2\n' })).toEqual(['M src/a.ts', ['bravo2\n', 'b\n', '{}\n'], 2]);
    expect(await take({ 'package-lock.json': '{"v":2}\n' })).toEqual(['M package-lock.json\n M src/a.ts', ['bravo2\n', 'b\n', '{"v":2}\n'], 2]);
  });

  it('N1 a snapshot negative goes stale on an untracked helper or a deleted file in scope, never on other scopes; partial is unknown', async () => {
    const base = commit({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }), c = new SourceCache(), q: NegativeQuery = { namespace: 'snapshot-literal', literal: 'helperFn', paths: ['src'] };
    const snap = () => r09b.exportSourceSnapshot({ repoDir: h.testDir, commit: base }), gen = (s: unknown) => snapshotScopeGeneration(s, ['src']);
    const s0 = await snap(), zero = cachedSnapshotSource(c, s0, { commit: base }, [find('helperFn')]);
    expect([zero.items[0].matches, recordNegative(c, q, zero, gen(s0))]).toEqual([[], { ok: true }]);
    const look = async (arrange: () => void) => { arrange(); return lookupNegative(c, q, gen(await snap())); };
    expect([
      await look(() => put({ 'docs/x.md': 'helperFn\n', 'srcx/y.ts': 'helperFn\n' })),
      await look(() => put({ 'src/helper.ts': 'export const other = 1;\n' })),
      await look(() => rm('src/helper.ts')),
      await look(() => rm('src/b.ts')),
      await look(() => git('checkout', '--', 'src/b.ts')),
    ]).toEqual(['absent', 'stale', 'absent', 'stale', 'absent']);
    // The helper is there, but only as an undecodable line: zero matches served, truncated, so never recorded.
    put({ 'src/bad.ts': Buffer.from([...Buffer.from('helperFn caf'), 0xe9, 0x0a]) });
    const s1 = await snap(), partial = cachedSnapshotSource(c, s1, { commit: base }, [find('helperFn')]), fresh = new SourceCache();
    expect(partial.items.map(i => [i.status, i.reason, i.matches])).toEqual([['truncated', 'undecodable-match', []]]);
    expect([recordNegative(fresh, q, partial, gen(s1)), lookupNegative(fresh, q, gen(s1)), lookupNegative(c, q, gen(s1))])
      .toEqual([{ ok: false, reason: 'truncated:undecodable-match' }, 'unknown', 'stale']);
    expect(lookupNegative(new SourceCache(), q, gen(s0))).toBe('unknown'); // a restart loses every negative
  });
});

describe('N/S committed negatives and the analyzer (C02, C03, C04, C05)', () => {
  const q: NegativeQuery = { namespace: 'repository-literal', literal: 'helperFn', paths: ['src'] };
  const generation = (commitId: string) => repositoryScopeGeneration(h.testDir, commitId, ['src']);
  it('N2 a committed negative follows the scope entries: an unrelated commit keeps it, a committed helper or delete moves it', async () => {
    const c0 = commit({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }), c = new SourceCache();
    expect(recordNegative(c, q, await cachedRepositorySource(c, h.testDir, c0, [find('helperFn')]), await generation(c0))).toEqual({ ok: true });
    const c1 = commit({ 'docs/x.md': 'helperFn\n' }), c2 = commit({ 'src/helper.ts': 'export const other = 1;\n' });
    git('rm', '-q', 'src/helper.ts'); const c3 = commit({});
    git('rm', '-q', 'src/b.ts'); const c4 = commit({});
    const looks = [];
    for (const id of [c0, c1, c2, c3, c4, 'e'.repeat(40)]) looks.push(lookupNegative(c, q, await generation(id)));
    expect(looks).toEqual(['absent', 'absent', 'stale', 'absent', 'stale', 'unknown']);
    expect(lookupNegative(new SourceCache(), q, await generation(c0))).toBe('unknown');
  });

  it('S1 an absent analyzer is inconclusive with a literal fallback, stores nothing and is never a negative', async () => {
    const c0 = commit({ 'src/a.ts': 'export function helperOld() {}\n' }), c = new SourceCache(), gen = await generation(c0);
    const semantic = await cachedSemanticSource(c, h.testDir, c0, [{ id: 's', purpose: 'source', op: 'symbol', name: 'helperFn', path: 'src' }],
      { serenaPath: path.join(h.testDir, 'no-analyzer') });
    expect(semantic.items).toEqual([expect.objectContaining({ status: 'unavailable', reason: 'semantic-unavailable:analyzer-absent', inconclusive: true,
      fallback: expect.objectContaining({ op: 'search', status: 'served', matches: [] }) })]);
    expect([semantic.complete, semantic.limitations]).toEqual([false, expect.arrayContaining(['semantic-unavailable', 'literal-search-fallback'])]);
    expect([recordNegative(c, q, semantic as never, gen), c.stats().entries, lookupNegative(c, q, gen)]).toEqual([{ ok: false, reason: 'not-single-search' }, 0, 'unknown']);
    expect(() => lookupNegative(c, { ...q, namespace: 'semantic' } as never, gen)).toThrow(expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT }));
  });
});

describe('D context deltas across roles and incarnations (C06, real claims)', () => {
  const NOW = Date.parse('2026-10-30T10:00:00.000Z'), RUNNER = { processStartedAt: '4242@2026-10-30T09:59:00.000Z', host: 'vm-1' };
  const SESSION = 'worker-1@2026-10-30T10:00:00Z';
  type Served = Record<string, unknown> & { servedContext: { packetId: string | null; receiptStatus: string; contextDelta?: unknown }; delta?: ContextDelta };
  const body = ({ servedContext: _served, ...packet }: Served) => packet;
  const full = (reason: string) => ({ served: 'full', reason });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW }); vi.stubEnv('MOE_WORKER_ID', ''); vi.stubEnv('MOE_TASK_ID', '');
    for (const id of ['worker-1', 'qa-1', 'architect-1']) h.createWorker({ id });
    h.createTask({ status: 'WORKING', planRevision: 1, approvedPlanRevision: 1, priorBlockedReason: 'waiting on C05',
      implementationPlan: [{ stepId: 'step-1', description: 'edit', status: 'PENDING', affectedFiles: ['src/a.ts'] }] });
    await h.state.load();
  });
  const get = (args: Record<string, unknown>, state = h.state) =>
    getContextTool(state).handler({ taskId: 'task-1', workerId: 'worker-1', sessionId: SESSION, ...args }, state) as Promise<Served>;
  const claim = (state = h.state) => claimNextTaskTool(state).handler({ workerId: 'worker-1', statuses: ['WORKING'], ...RUNNER }, state) as Promise<{ attemptId: string; generation: number }>;
  const ack = async (state = h.state) => (await get({ contextEpoch: 0 }, state)).servedContext.packetId;
  const against = async (base: string | null, args: Record<string, unknown> = {}, state = h.state) => get({ basePacketId: base, contextEpoch: 0, ...args }, state);

  it('D1-D7 only the acknowledging worker session gets a delta; every other reader or incarnation gets the full packet', async () => {
    const { attemptId, generation } = await claim();
    const first = await get({ contextEpoch: 0 });
    expect(first.servedContext.contextDelta).toEqual(full('no-base'));
    await h.state.updateTask('task-1', { priorBlockedReason: undefined, reopenReason: 'round 2' });
    const second = await against(first.servedContext.packetId);
    expect([second.servedContext.contextDelta, second.delta?.removed]).toEqual([{ served: 'delta' }, ['/task/priorBlockedReason']]);
    expect(applyDelta(body(first), second.delta!)).toStrictEqual(body(await get({})));
    // QA and the architect read the same task: never a delta, always the whole packet.
    for (const workerId of ['qa-1', 'architect-1']) {
      const other = await against(second.servedContext.packetId, { workerId, sessionId: `${workerId}@2026-10-30T10:00:00Z` });
      expect([other.servedContext.contextDelta, other.delta, body(other).task]).toEqual([full('not-attempt-owner'), undefined, expect.objectContaining({ id: 'task-1' })]);
      // A legacy read (neither delta field) carries no contextDelta at all, recorded or not.
      expect((await get({ workerId, sessionId: undefined })).servedContext).not.toHaveProperty('contextDelta');
    }
    expect((await against(await ack(), { contextEpoch: 1 })).servedContext.contextDelta).toEqual(full('epoch-changed'));
    expect((await against(await ack(), { sessionId: 'worker-1@2026-10-30T11:00:00Z' })).servedContext.contextDelta).toEqual(full('session-mismatch'));
    // A restart: the attempt reconciles (no running attempt), and once reattached the in-memory base is gone.
    const base = await ack(), restarted = new StateManager({ projectPath: h.testDir }); extraStates.push(restarted);
    await restarted.load(); await restarted.runExclusive(() => reconcileRunningAttempts(restarted));
    expect((await against(base, {}, restarted)).servedContext).toMatchObject({ receiptStatus: 'no-running-attempt', contextDelta: full('no-running-attempt') });
    const reattach = () => reattachAttemptTool(restarted).handler({ taskId: 'task-1', workerId: 'worker-1', runnerId: 'worker-1', attemptId, generation, ...RUNNER }, restarted);
    await reattach();
    expect((await against(base, {}, restarted)).servedContext.contextDelta).toEqual(full('base-unavailable'));
    // An in-process reattach never acknowledges a base; a re-claim is a new attempt generation.
    const beforeReattach = await ack(restarted);
    vi.setSystemTime(NOW + 60_000); await setAttemptPhase(restarted, attemptId, 'reconciling'); await reattach();
    expect((await against(beforeReattach, {}, restarted)).servedContext.contextDelta).toEqual(full('phase-changed'));
    const beforeReclaim = await ack(restarted);
    await restarted.updateTask('task-1', { assignedWorkerId: null });
    expect(await claim(restarted)).toMatchObject({ generation: generation + 1 });
    expect((await against(beforeReclaim, {}, restarted)).servedContext.contextDelta).toEqual(full('attempt-mismatch'));
  });
});

describe('R recipe invalidation (C08, C09, real Git)', () => {
  const DEF: RecipeDefinition = { id: 'docs-fix', kind: docsLiteralReplace.name, version: 1,
    requiredChecks: [{ id: 'docs', command: 'npm run lint:docs' }], params: { allowedPaths: ['docs'] } };
  const ORIGINAL = '# Guide\nUse the old flag.\n';
  const INPUTS = { path: 'docs/a.md', originalSha256: sha256(ORIGINAL), oldText: 'old flag', newText: 'new flag' };
  const task = () => h.state.getTask('task-1')!;
  const instantiate = () => instantiateRecipe(h.state, { taskId: 'task-1', recipeId: DEF.id, inputs: INPUTS });
  beforeEach(async () => {
    h.createTask({ status: 'PLANNING' }); h.createWorker({ id: 'worker-1' }); await h.state.load();
    h.state.project!.settings = { ...h.state.project!.settings, approvalMode: 'TURBO' };
    commit({ [DEFS]: JSON.stringify({ version: 1, recipes: [DEF] }), 'docs/a.md': ORIGINAL }, ['-A']);
  });

  it('R1 a doc changed after the request falls back to ordinary planning and leaves the row untouched', async () => {
    commit({ 'docs/a.md': '# Guide\nUse the old flag, or not.\n' });
    expect(await instantiate()).toEqual({ instantiated: false, fallback: 'ordinary-planning', reason: 'docs-replace-hash-mismatch' });
    expect([task().status, task().planRevision ?? 0, task().implementationPlan, task().recipeInstance]).toEqual(['PLANNING', 0, [], undefined]);
  });

  it('R2 the post-patch check holds the bound definition and inputs: a changed definition, input or extra edit refuses', async () => {
    expect(await instantiate()).toMatchObject({ instantiated: true, status: 'WORKING' });
    const instance = readRecipeInstance(task())!;
    const post = commit({ 'docs/a.md': ORIGINAL.replace('old flag', 'new flag') }, ['docs/a.md', '.moe/tasks/task-1.json']);
    const extra = commit({ 'docs/b.md': 'b\n' });
    const check = (over: Record<string, unknown>) => docsLiteralReplace.assessPostpatch(h.testDir, { taskId: 'task-1', instance, definition: DEF, postCommit: post, ...over });
    const refusal = (reason: string, detail?: string) => ({ ok: false, reason: `docs-replace-${reason}`, ...(detail ? { detail } : {}) });
    expect(await Promise.all([check({}), check({ definition: { ...DEF, version: 2 } }), check({ definition: { ...DEF, params: { allowedPaths: ['docs', 'guides'] } } }),
      check({ instance: { ...instance, inputs: { ...instance.inputs, newText: 'other flag' } } }), check({ postCommit: extra })]))
      .toEqual([{ ok: true }, refusal('recipe-mismatch'), refusal('recipe-mismatch'), refusal('inputs-changed'), refusal('extra-edits', 'docs/b.md')]);
  });

  it('R3 under local-branch a candidate that edits the recipe definitions is held (protected-check-changed)', async () => {
    h.state.project!.settings = { ...h.state.project!.settings, deliveryPolicy: 'local-branch' };
    expect(await instantiate()).toMatchObject({ instantiated: true, status: 'WORKING' });
    const approvedOid = git('rev-parse', `HEAD:${DEFS}`);
    const { attemptId, generation } = await claimNextTaskTool(h.state).handler({ workerId: 'worker-1', statuses: ['WORKING'] }, h.state) as { attemptId: string; generation: number };
    commit({ [DEFS]: JSON.stringify({ version: 1, recipes: [{ ...DEF, requiredChecks: [{ id: 'docs', command: 'true' }] }] }) });
    const missing = async (id: string, oid: string) => {
      await recordCandidateTool(h.state).handler({ id, taskId: 'task-1', attemptId, generation, workerId: 'worker-1', baseRevision: git('rev-parse', 'HEAD~1'),
        treeSha: git('rev-parse', 'HEAD^{tree}'), deliveryTarget: 'refs/heads/main', protectedEntries: [{ path: DEFS, oid }] }, h.state);
      return evaluateDeliveryEvidence(h.state, task()).missingEvidence.filter(token => token.startsWith('protected-check'));
    };
    expect(await missing('cand-1', git('rev-parse', `HEAD:${DEFS}`))).toEqual([`protected-check-changed:${DEFS}`]);
    expect(await missing('cand-2', approvedOid)).toEqual([]);
  });
});

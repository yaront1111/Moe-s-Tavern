import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { getContextTool } from '../tools/getContext.js';
import { describeMissingEvidence, evaluateDeliveryEvidence } from './policy.js';
import { deliveryProjection } from '../state/deliveryProjection.js';
import { dependencyShortfall, unmetDependsOn } from '../state/dependencyUnblock.js';
import type { Candidate, CheckRun, ProtectedCheckDefinition, RequiredCheckSnapshot, Task } from '../types/schema.js';

// End-to-end DoD for CQ-V01: real submit_plan measurement on a temporary repo,
// runner-reported candidate entries, and the ONE shared delivery predicate.
const h = new ToolTestHarness();
const UNIT = 'npm run test:acc';
const LINT = 'npm run lint:acc';
const defs: ProtectedCheckDefinition[] = [
  { id: 'acc', command: UNIT, configs: ['cfg/vitest.json'], assertionRoots: ['tests'] },
  { id: 'lint', command: LINT, scripts: ['scripts/lint.sh'] },
];
const PROTECTED = ['cfg/vitest.json', 'scripts/lint.sh', 'tests/a.test.ts', 'tests/deep/b.test.ts'];
const changed = (p: string) => `protected-check-changed:${p}`;
const OID = 'e5'.repeat(20);

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), text);
  }
  git('add', '-A'); git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD^{tree}');
}
/** What a runner reports: ls-tree entries of the protected paths at `tree`. */
const entriesAt = (tree: string, paths = PROTECTED) => paths.map(p => ({ path: p, oid: git('rev-parse', `${tree}:${p}`) }));

const task = () => h.state.getTask('task-1')!;
const missing = (t: Task = task()) => evaluateDeliveryEvidence(h.state, t).missingEvidence;
async function approve(extra: Record<string, unknown> = {}, requiredChecks = defs): Promise<void> {
  if (task().status !== 'PLANNING') await h.state.updateTask('task-1', { status: 'PLANNING' });
  await submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }],
    executionContract: { requiredChecks }, ...extra }, h.state);
}
let seq = 0;
const pass = (command: string, run: Partial<CheckRun> = {}): Partial<CheckRun> => ({ command, ...run });
/** A runner-recorded candidate (the latest one) with its runs; passing runs of both approved commands by default. */
function candidate(treeSha: string, protectedEntries?: Candidate['protectedEntries'], runs = [pass(UNIT), pass(LINT)]): void {
  const id = `cand-${String(++seq).padStart(3, '0')}`;
  const createdAt = new Date(Date.UTC(2026, 9, 25, 0, 0, seq)).toISOString();
  h.state.candidates.set(id, { id, attemptId: 'attempt-1', taskId: 'task-1', baseRevision: treeSha, treeSha,
    deliveryTarget: 'refs/heads/main', ...(protectedEntries ? { protectedEntries } : {}), createdAt });
  runs.forEach((run, i) => h.state.checkRuns.set(`${id}-run-${i}`, { id: `${id}-run-${i}`, candidateId: id, treeSha,
    command: UNIT, exitCode: 0, outputTail: '', runnerId: 'runner-1', source: 'runner-observed', createdAt, ...run }));
}
function settings(patch: Record<string, unknown>): void {
  h.state.project!.settings = { ...h.state.project!.settings, ...patch } as never;
}

let tree1 = '';
beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); seq = 0;
  h.createTask({ status: 'PLANNING', commits: [{ sha: 'ab'.repeat(20), ref: 'main', kind: 'completion', role: 'worker',
    sessionId: 'worker-1@x', paths: [], recordedBy: 'worker-1', recordedAt: '2026-10-25T00:00:00.000Z' }] });
  await h.state.load();
  settings({ deliveryPolicy: 'local-branch' });
  git('init', '-q');
  tree1 = commit({ 'cfg/vitest.json': '{}\n', 'scripts/lint.sh': 'lint\n', 'tests/a.test.ts': 'a\n',
    'tests/deep/b.test.ts': 'b\n', 'tests-old/x.test.ts': 'x\n', 'src/app.ts': 'app\n' });
  await approve();
});
afterEach(() => { vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

describe('protected required checks in the shared delivery predicate', () => {
  it('(a) is satisfied when the candidate matches the approved snapshot and each approved command passed on it', () => {
    candidate(tree1, entriesAt(tree1));
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(true);
  });

  it('(b) holds changed and removed protected files until a NEW approval revision re-measures them (DoD 1)', async () => {
    const tree2 = commit({ 'cfg/vitest.json': '{"x":1}\n', 'tests/a.test.ts': 'a2\n', 'src/app.ts': 'app2\n' });
    candidate(tree2, entriesAt(tree2));
    expect(missing()).toEqual([changed('cfg/vitest.json'), changed('tests/a.test.ts')]);
    candidate(tree1, entriesAt(tree1).filter(e => e.path !== 'tests/deep/b.test.ts'));
    expect(missing()).toEqual([changed('tests/deep/b.test.ts')]);
    candidate(tree2, entriesAt(tree2));
    const revision = task().planRevision;
    await approve({ requiredCheckRevision: tree2 });
    expect(task().planRevision).toBe((revision ?? 0) + 1);
    expect(task().requiredCheckSnapshot?.entries).toEqual(entriesAt(tree2));
    expect(missing()).toEqual([]);
  });

  it('(c) flags a candidate-added test under an assertion root, exactly and case-sensitively (DoD 3)', () => {
    const extra = [...entriesAt(tree1), { path: 'tests-old/new.test.ts', oid: OID }, { path: 'Tests/n.test.ts', oid: OID },
      { path: 'tests/new.test.ts', oid: OID }].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    candidate(tree1, extra);
    expect(missing()).toEqual([changed('tests/new.test.ts')]);
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `tests/n${String(i).padStart(2, '0')}.test.ts`, oid: OID }));
    candidate(tree1, [...entriesAt(tree1), ...many].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))));
    expect(missing()).toEqual([...many.slice(0, 10).map(e => changed(e.path)), 'protected-check-changed:+2 more']);
  });

  it.each([
    ['a different, candidate-added command', pass('npm run test:mine')],
    ['an agent-reported run', pass(UNIT, { source: 'agent-reported' })],
    ['a run on another tree', pass(UNIT, { treeSha: 'f6'.repeat(20) })],
    ['a failing run', pass(UNIT, { exitCode: 1 })],
  ])('(c) never lets %s satisfy an approved command (DoD 3)', (_, run) => {
    candidate(tree1, entriesAt(tree1), [run, pass(` ${LINT} `)]);
    expect(missing()).toEqual([`required-check:${UNIT}`]);
  });

  it('(d) reads the overlay only from a snapshot still bound to the current definitions (DoD 2)', async () => {
    candidate(tree1, entriesAt(tree1));
    await h.state.updateTask('task-1', { executionContract: { requiredChecks: [{ ...defs[0], command: 'npm run weaker' }, defs[1]] } });
    expect(missing()).toEqual(['protected-checks-unapproved']);
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(false);
  });

  it('(d) serves requiredCheckSnapshot to worker and QA only while it is valid', async () => {
    const context = async (workerId: string) => ((await getContextTool(h.state).handler({ taskId: 'task-1', workerId }, h.state)) as
      { task: { requiredCheckSnapshot?: RequiredCheckSnapshot } }).task;
    const approved = structuredClone(task().requiredCheckSnapshot!);
    expect(approved.entries).toEqual(entriesAt(tree1));
    for (const workerId of ['worker-1', 'qa-1']) expect((await context(workerId)).requiredCheckSnapshot).toEqual(approved);
    task().requiredCheckSnapshot = { ...approved, definitionDigest: 'f'.repeat(64) };
    for (const workerId of ['worker-1', 'qa-1']) expect(Object.keys(await context(workerId))).not.toContain('requiredCheckSnapshot');
    task().requiredCheckSnapshot = approved;
    await h.state.updateTask('task-1', { executionContract: { requiredChecks: [defs[1]] } });
    expect(Object.keys(await context('qa-1'))).not.toContain('requiredCheckSnapshot');
  });

  it('(e) reports a candidate without protectedEntries, or no candidate, as unmeasured', () => {
    expect(missing()).toEqual(['protected-checks-unmeasured', `required-check:${UNIT}`, `required-check:${LINT}`]);
    candidate(tree1);
    expect(missing()).toEqual(['protected-checks-unmeasured']);
    h.state.candidates.set('cand-001', { ...h.state.candidates.get('cand-001')!, protectedEntries: 'bogus' as never });
    expect(missing()).toEqual(['protected-checks-unmeasured']);
  });

  it('(e) fails closed when the evidence lookup throws', () => {
    candidate(tree1, entriesAt(tree1));
    vi.spyOn(h.state.candidates, 'values').mockImplementation(() => { throw new Error('boom'); });
    expect(missing()).toEqual(['protected-checks-unmeasured', `required-check:${UNIT}`, `required-check:${LINT}`]);
  });

  it('owes a command shared with qualityGate once, gate first', () => {
    settings({ autoCommit: true, qualityGate: ` ${UNIT} `, qualityGateScope: 'everyTask' });
    candidate(tree1, entriesAt(tree1), []);
    expect(missing()).toEqual([`required-check:${UNIT}`, `required-check:${LINT}`]);
  });

  it('matches a padded approved command trimmed, as the gate is', async () => {
    await approve({}, [{ ...defs[0], command: ` ${UNIT} ` }, defs[1]]);
    candidate(tree1, entriesAt(tree1));
    expect(missing()).toEqual([]);
  });

  it('explains each protected token in a refusal', () => {
    for (const token of ['protected-checks-unapproved', 'protected-checks-unmeasured', changed('tests/a.test.ts')]) {
      expect(describeMissingEvidence(token)).toMatch(/approved snapshot/);
    }
  });

  it('(f) leaves the legacy policy and tasks without requiredChecks unchanged', async () => {
    candidate(tree1, entriesAt(tree1).slice(1), []);
    settings({ deliveryPolicy: undefined });
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, task())).not.toHaveProperty('requiredCheckSatisfied');
    settings({ deliveryPolicy: 'local-branch' });
    await approve({ executionContract: { checkRefs: [UNIT] } });
    expect(task().requiredCheckSnapshot).toBeUndefined();
    expect(missing()).toEqual([]);
    expect(deliveryProjection(h.state, task())).not.toHaveProperty('requiredCheckSatisfied');
  });

  it('(g) withholds dependents of a drifted DONE task and releases them on a match', () => {
    h.state.tasks.set('task-1', { ...task(), status: 'DONE' });
    candidate(tree1, [...entriesAt(tree1), { path: 'tests/new.test.ts', oid: OID }]);
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(['task-1']);
    expect(dependencyShortfall(h.state, 'task-1').missingEvidence).toEqual([changed('tests/new.test.ts')]);
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(false);
    candidate(tree1, entriesAt(tree1));
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual([]);
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(true);
  });
});

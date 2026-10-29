import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '../types/schema.js';
import { assessPlanSource, decidePlanReuse, planReuseGit, planReuseView, planSourcePaths } from './planReuse.js';
import type { PlanReuseResult, PlanSourceAssessment, PlanSourcePaths } from './planReuse.js';
import { validatePlanReuseRecord } from './planReuseState.js';

type Row = Record<string, unknown>;
const AT = '2026-10-27T10:00:00.000Z';
const step = (affectedFiles: string[] = [], newFiles?: string[]) =>
  ({ stepId: 's', description: 'd', status: 'PENDING', affectedFiles, ...(newFiles ? { newFiles } : {}) });
const planning = (over: Row = {}): Task => ({ id: 'task-1', status: 'PLANNING', implementationPlan: [step(['a.ts'])],
  planRevision: 3, approvedPlanRevision: 3, planningEntry: { from: 'BACKLOG', at: AT, seq: 2 },
  planSourceBasis: { version: 1, commit: 'a'.repeat(40), planRevision: 3 }, ...over } as unknown as Task);
const record = (over: Row = {}) => ({ version: 1, decision: 'refresh', planRevision: 3, entrySeq: 2,
  reasons: ['affected-file-changed:a.ts'], assessedAt: AT, ...over });
const answered = { decision: 'refresh', reasons: ['affected-file-changed:a.ts'] };
const pending = { decision: 'pending', reasons: [] };

describe('planReuseView', () => {
  it.each<[string, Row, unknown]>([
    ['no plan steps gives null', { implementationPlan: [] }, null],
    ['WORKING without a record gives null', { status: 'WORKING' }, null],
    ['a stale approval', { approvedPlanRevision: 2 }, { decision: 'replan', reasons: ['approval-not-current'] }],
    ['no planning entry', { planningEntry: undefined }, { decision: 'reassess', reasons: ['planning-entry-unknown'] }],
    ...['AWAITING_APPROVAL', 'WORKING', 'REVIEW'].map((from): [string, Row, unknown] => [`entry from ${from}`,
      { planningEntry: { from, at: AT, seq: 2 } }, { decision: 'replan', reasons: [`replan-requested-from-${from}`] }]),
    ...['BACKLOG', 'BLOCKED'].map((from): [string, Row, unknown] => [`entry from ${from} is pending`,
      { planningEntry: { from, at: AT, seq: 2 } }, pending]),
    ['no source basis', { planSourceBasis: undefined }, { decision: 'reassess', reasons: ['source-basis-missing'] }],
    ['a stale source basis', { planSourceBasis: { version: 1, commit: 'a'.repeat(40), planRevision: 2 } },
      { decision: 'reassess', reasons: ['source-basis-stale'] }],
    ['a matching record answers in PLANNING', { planReuse: record() }, answered],
    ['a matching record answers in WORKING', { status: 'WORKING', planReuse: record() }, answered],
    ['a record for an older entrySeq does not answer', { planReuse: record({ entrySeq: 1 }) }, pending],
    ['a record for an older planRevision does not answer', { planReuse: record({ planRevision: 2 }) }, pending],
    ['a malformed planRevision never throws', { planRevision: -1 }, { decision: 'replan', reasons: ['approval-not-current'] }],
  ])('%s', (_name, over, expected) => {
    expect(planReuseView(planning(over))).toEqual(expected);
  });
});

describe('planSourcePaths', () => {
  const paths = (steps: unknown[], executionContract?: Row) =>
    planSourcePaths({ implementationPlan: steps, executionContract } as unknown as Task);

  it('unions, sorts and dedupes affected files, and drops created files already affected', () => {
    const p = paths([step(['b.ts', 'a.ts'], ['n/y.ts', 'a.ts']), step(['a.ts', 7 as never], ['n/x.ts']), null]);
    expect(p).toEqual({ affected: ['a.ts', 'b.ts'], created: ['n/x.ts', 'n/y.ts'], anchors: [], tooMany: false });
  });

  it('anchors path-like prose tokens per entry, and a path-less entry gets an empty list', () => {
    const p = paths([], { sourceAssumptions: ['Uses `util/cachedPlanPaths.ts:106` (openProjectGit).', 'no helper exists'],
      reuse: [5, 'see src/context/ and v1.5, ./x.ts or ../y.ts'] });
    expect(p.anchors).toEqual([
      { kind: 'sourceAssumptions', index: 0, paths: ['util/cachedPlanPaths.ts'] },
      { kind: 'sourceAssumptions', index: 1, paths: [] },
      { kind: 'reuse', index: 0, paths: [] }, { kind: 'reuse', index: 1, paths: ['src/context'] },
    ]);
  });

  it('sets tooMany past 256 distinct paths', () => {
    const files = Array.from({ length: 257 }, (_, i) => `f${i}.ts`);
    expect(paths([step(files.slice(0, 256))]).tooMany).toBe(false);
    expect(paths([step(files.slice(0, 200), files.slice(150))]).tooMany).toBe(true);
  });
});

/** Every result must be recordable as-is by CQ-C07 through C07a's validator. */
function recordable(result: PlanReuseResult): PlanReuseResult {
  expect(() => validatePlanReuseRecord({ version: 1, planRevision: 1, entrySeq: 1, assessedAt: AT, ...result })).not.toThrow();
  return result;
}

describe('assessPlanSource + decidePlanReuse (real Git)', () => {
  let dir: string; let basis: string; const scratch: string[] = [];
  const tempDir = (name: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); scratch.push(d); return d; };
  const git = (...args: string[]) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: dir, encoding: 'utf8',
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim();
  };
  /** Commit file contents (null deletes) and return the new HEAD. */
  const commit = (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) { git('rm', '-q', '--', file); continue; }
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text); git('add', '--', file);
    }
    git('commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  const plan = (assumption = 'Reads `src/b.ts`.') => planSourcePaths({ implementationPlan: [step(['src/a.ts'], ['src/new.ts'])],
    executionContract: { sourceAssumptions: [assumption] } } as unknown as Task);
  const decide = async (paths = plan(), candidate?: { baseRevision: string; deliveryTarget: string }, root = dir) =>
    recordable(decidePlanReuse(paths, await assessPlanSource(root, { basisCommit: basis, paths, candidate })));

  beforeEach(() => { dir = tempDir('moe-plan-reuse-'); git('init', '-q');
    basis = commit({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'docs/c.md': 'c\n' }); });
  afterEach(() => { vi.restoreAllMocks(); for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('an unrelated commit reuses the plan', async () => {
    const head = commit({ 'docs/c.md': 'c2\n' });
    expect(await decide()).toEqual({ decision: 'reuse', reasons: [], changedPaths: [], headCommit: head });
    expect(head).not.toBe(basis);
  });
  it.each<[string, Record<string, string | null>, string, string[]]>([
    ['a changed affected file refreshes', { 'src/a.ts': 'a2\n' }, 'refresh', ['affected-file-changed:src/a.ts']],
    ['a changed assumption reassesses', { 'src/b.ts': 'b2\n' }, 'reassess', ['assumption-changed:src/b.ts']],
    ['a deleted assumption reassesses', { 'src/b.ts': null }, 'reassess', ['assumption-deleted:src/b.ts']],
    ['a deleted affected file reassesses', { 'src/a.ts': null }, 'reassess', ['affected-file-deleted:src/a.ts']],
    ['a created file present at HEAD reassesses', { 'src/new.ts': 'n\n' }, 'reassess', ['new-file-present:src/new.ts']],
  ])('%s', async (_name, files, decision, reasons) => {
    commit(files);
    const result = await decide();
    expect(result).toMatchObject({ decision, reasons });
    expect(result.changedPaths).toEqual(decision === 'refresh' ? ['src/a.ts'] : []);
  });
  it('a directory anchor that is an ancestor of other paths keeps its own tree entry', async () => {
    basis = commit({ 'src/lib/d.ts': 'd\n', 'src/lib/e.ts': 'e\n' });
    const paths = planSourcePaths({ implementationPlan: [step(['src/lib/d.ts'])],
      executionContract: { sourceAssumptions: ['Lives under src/lib/.'] } } as unknown as Task);
    commit({ 'docs/c.md': 'c2\n' });
    expect(await decide(paths)).toMatchObject({ decision: 'reuse', reasons: [] });
    commit({ 'src/lib/e.ts': 'e2\n' });
    expect(await decide(paths)).toMatchObject({ decision: 'reassess', reasons: ['assumption-changed:src/lib'] });
  });
  it('an assumption with no anchor at the basis reassesses', async () => {
    for (const prose of ['no helper exists', 'see src/missing.ts']) {
      expect(await decide(plan(prose))).toMatchObject({ decision: 'reassess', reasons: ['assumption-unanchored:sourceAssumptions:1'] });
    }
  });
  it('pathspecs are literal', async () => {
    const paths = planSourcePaths({ implementationPlan: [step([':/src/a.ts'])] } as unknown as Task);
    expect(await decide(paths)).toMatchObject({ decision: 'reassess', reasons: ['affected-file-not-in-basis::/src/a.ts'] });
  });
  it.each(['src/b.ts', 'src/a.ts'])('an unrequested or duplicate ls-tree entry (%s) is source-unavailable', async extra => {
    const real = planReuseGit.run;
    vi.spyOn(planReuseGit, 'run').mockImplementation(async (args, ...rest) => `${await real(args, ...rest)}${
      args[1] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\t${extra}\0` : ''}`);
    expect((await decide(plan('none'))).reasons).toEqual(['source-unavailable: ls-tree: malformed, unrequested or duplicate entry']);
  });

  it.each<[string, () => Promise<PlanReuseResult>]>([
    ['a non-Git root', async () => decide(plan(), undefined, tempDir('moe-plan-reuse-nogit-'))],
    ['a basis commit that does not exist', async () => { basis = 'f'.repeat(40); return decide(); }],
    ['an injected Git failure', async () => { vi.spyOn(planReuseGit, 'run').mockRejectedValue(new Error('injected')); return decide(); }],
  ])('%s is source-unavailable and never throws', async (_name, run) => {
    const result = await run();
    expect(result).toMatchObject({ decision: 'reassess', changedPaths: [] });
    expect(result.reasons).toEqual([expect.stringMatching(/^source-unavailable: \S/)]);
  });
  it('a gitlink is recorded, not followed', async () => {
    git('update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},vendor/sub`);
    basis = commit({});
    const paths = planSourcePaths({ implementationPlan: [step(['vendor/sub'])] } as unknown as Task);
    expect(await decide(paths)).toMatchObject({ decision: 'reassess', reasons: ['source-unavailable:gitlink:vendor/sub'] });
  });
  it('more than 256 paths is too-many-source-paths without spawning Git', async () => {
    const run = vi.spyOn(planReuseGit, 'run');
    const paths = planSourcePaths({ implementationPlan: [step(Array.from({ length: 257 }, (_, i) => `f${i}.ts`))] } as unknown as Task);
    expect(await decide(paths)).toEqual({ decision: 'reassess', reasons: ['too-many-source-paths'], changedPaths: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('candidate verdicts never change the decision', async () => {
    git('update-ref', 'refs/heads/target', basis);
    expect(await decide(plan(), { baseRevision: basis, deliveryTarget: 'refs/heads/target' }))
      .toEqual({ decision: 'reuse', reasons: [], changedPaths: [], headCommit: basis, candidate: 'current' });
    git('update-ref', 'refs/heads/target', git('commit-tree', `${basis}^{tree}`, '-p', basis, '-m', 'moved'));
    expect(git('rev-parse', 'HEAD')).toBe(basis);
    const verdict = async (deliveryTarget: string) => decide(plan(), { baseRevision: basis, deliveryTarget });
    expect(await verdict('refs/heads/target')).toMatchObject({ decision: 'reuse', reasons: ['target-moved'], candidate: 'revalidate' });
    for (const target of ['refs/heads/nope', '-x']) {
      expect(await verdict(target)).toMatchObject({ decision: 'reuse', reasons: ['target-unresolved'], candidate: 'revalidate' });
    }
  });
});

describe('decidePlanReuse (synthetic)', () => {
  const entry = { mode: '100644', type: 'blob', oid: 'c'.repeat(40) };
  const paths = (over: Partial<PlanSourcePaths>): PlanSourcePaths => ({ affected: [], created: [], anchors: [], tooMany: false, ...over });
  const source = (files: string[]): PlanSourceAssessment => {
    const tree = new Map(files.map(f => [f, entry]));
    return { basisCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), basis: tree, head: tree };
  };

  it('caps reasons at 31 plus more-reasons', () => {
    const created = Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, '0')}.ts`);
    const { reasons } = recordable(decidePlanReuse(paths({ created }), source(created)));
    expect(reasons).toEqual([...created.slice(0, 31).map(f => `new-file-present:${f}`), 'more-reasons:9']);
  });
  it('replaces control characters and clips a long reason to 300 chars', () => {
    const { reasons } = recordable(decidePlanReuse(paths({}), { unavailable: `a\u0007${'x'.repeat(400)}` }));
    expect(reasons).toEqual([`source-unavailable: a?${'x'.repeat(278)}`]);
  });
  it('names an invalid plan path and never lists it as changed', () => {
    expect(recordable(decidePlanReuse(paths({ affected: ['./a.ts', 'constructor'] }), source(['constructor']))))
      .toMatchObject({ decision: 'reassess', reasons: ['source-path-invalid:./a.ts'], changedPaths: [] });
  });
});

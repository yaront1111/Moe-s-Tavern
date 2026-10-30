import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCheckArchitecture } from './checkArchitecture.js';
import { checkPlanRails } from '../util/rails.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { evaluateDeliveryEvidence } from '../delivery/policy.js';

// CQ-V10: the architecture check as the frozen gate runs it — committed bytes
// of HEAD (the candidate) against HEAD^ (its base), never the worktree.
const RULE = { id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'state must not depend on tools' };
const RULES = `${JSON.stringify({ version: 1, rules: [RULE] })}\n`;
const FORBIDDEN = "import { t } from '../tools/t.js';\nexport const s = t;\n";
const BIG = `// ${'x'.repeat(70000)}\nexport {};\n`;

function git(cwd: string, args: string[], input?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd, encoding: 'utf8', input, env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function write(cwd: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
}
/** Commit `files` on top of HEAD and return the new commit id. */
function commit(cwd: string, files: Record<string, string>, remove: string[] = []): string {
  write(cwd, files);
  for (const file of remove) fs.rmSync(path.join(cwd, file));
  git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', 'fixture']);
  return git(cwd, ['rev-parse', 'HEAD']);
}

let dir = '';
let base = '';
const run = (argv: string[] = ['--rules', 'arch.json'], cwd = dir) => runCheckArchitecture(argv, cwd);
/** The exact engine report for the candidate at HEAD. */
const report = (tree: string, rest: Record<string, unknown>) => ({ base, tree, rules: 'arch.json', ...rest });
const unavailable = (reason: string, rest: Record<string, unknown> = {}) => ({ outcome: 'unavailable', reason, ...rest });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-check-arch-'));
  git(dir, ['init', '-q']);
  base = commit(dir, { 'arch.json': RULES, 'src/state/s.ts': 'export const s = 1;\n',
    'src/tools/t.ts': 'export const t = 1;\n', 'docs/a.md': '# a\n' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('check-architecture on the frozen candidate', () => {
  it('A1: fails a forbidden import even when the plan prose passes the project rails (DoD 1)', async () => {
    // Even a rail naming the forbidden directory only matches prose, never code.
    const rails = { techStack: ['TypeScript'], forbiddenPatterns: ['src/tools'],
      requiredPatterns: ['error handling', 'test'], formatting: '', testing: 'vitest', customRules: [] };
    expect(checkPlanRails('Reuse the tools helper from state, with error handling and a test.', rails, null, null)).toEqual({ ok: true });
    const tree = commit(dir, { 'src/state/s.ts': FORBIDDEN });
    expect(await run()).toEqual({ exitCode: 1, report: report(tree, { selectedRules: ['state-no-tools'], uncertain: [], outcome: 'failed',
      violations: [{ ruleId: 'state-no-tools', file: 'src/state/s.ts', line: 1, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' }] }) });
  });

  it('A1: reads every covered file across read batches, and sees a rename as an add', async () => {
    const files = Object.fromEntries(['ts', 'tsx', 'js', 'mjs', 'cjs', 'ts'].map((ext, i) => [`src/state/f${i}.${ext}`, FORBIDDEN]));
    const tree = commit(dir, { ...files, 'src/state/moved.mjs': FORBIDDEN }, ['src/state/s.ts']);
    const names = [...Object.keys(files), 'src/state/moved.mjs'].sort();
    expect(await run()).toEqual({ exitCode: 1, report: report(tree, { selectedRules: ['state-no-tools'], uncertain: [], outcome: 'failed',
      violations: names.map(file => ({ ruleId: 'state-no-tools', file, line: 1, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' })) }) });
  });

  it('A2: surfaces a dynamic import as inconclusive (exit 2), never as a pass (DoD 2)', async () => {
    const tree = commit(dir, { 'src/state/s.ts': 'export async function load(name: string) {\n  return await import(name);\n}\n' });
    expect(await run()).toEqual({ exitCode: 2, report: report(tree, { selectedRules: ['state-no-tools'], violations: [],
      uncertain: [{ file: 'src/state/s.ts', line: 2, reason: 'dynamic-import' }], outcome: 'inconclusive', reason: 'dynamic-import' }) });
  });

  it('A2: keeps the uncertainty beside a real violation instead of dropping it (DoD 2)', async () => {
    const tree = commit(dir, { 'src/state/s.ts': `${FORBIDDEN}export const r = (n: string) => require(n);\n` });
    expect(await run()).toEqual({ exitCode: 1, report: report(tree, { selectedRules: ['state-no-tools'], outcome: 'failed',
      violations: [{ ruleId: 'state-no-tools', file: 'src/state/s.ts', line: 1, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' }],
      uncertain: [{ file: 'src/state/s.ts', line: 3, reason: 'non-literal-require' }] }) });
  });

  it('A3: reads only the committed candidate, never a worktree or index edit (DoD 3)', async () => {
    const tree = commit(dir, { 'src/state/s.ts': 'export const s = 2;\n' });
    write(dir, { 'src/state/s.ts': FORBIDDEN, 'src/state/new.ts': FORBIDDEN });
    git(dir, ['add', 'src/state/new.ts']);
    expect(await run()).toEqual({ exitCode: 0, report: report(tree, { selectedRules: ['state-no-tools'], violations: [], uncertain: [], outcome: 'passed' }) });
  });

  it('A5: selects no rule for a change outside every from-prefix', async () => {
    const tree = commit(dir, { 'docs/a.md': '# b\n', 'src/other/huge.ts': BIG });
    expect(await run()).toEqual({ exitCode: 0, report: report(tree, { selectedRules: [], violations: [], uncertain: [], outcome: 'passed' }) });
  });

  it('A5: honours explicit --base and --tree revisions', async () => {
    const first = commit(dir, { 'src/state/s.ts': FORBIDDEN });
    commit(dir, { 'docs/a.md': '# c\n' });
    expect((await run(['--rules', 'arch.json', '--tree', 'HEAD'])).exitCode).toBe(0);
    expect(await run(['--rules', 'arch.json', '--base', base, '--tree', first])).toEqual({ exitCode: 1, report: report(first, {
      selectedRules: ['state-no-tools'], uncertain: [], outcome: 'failed',
      violations: [{ ruleId: 'state-no-tools', file: 'src/state/s.ts', line: 1, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' }] }) });
  });
});

describe('check-architecture fails closed with exit 2 and a named reason (A6)', () => {
  it('refuses a missing or malformed rules document at the tree', async () => {
    const tree = commit(dir, { 'src/state/s.ts': FORBIDDEN });
    expect(await run(['--rules', 'nope.json'])).toEqual({ exitCode: 2, report: unavailable('rules-unreadable',
      { base, tree, rules: 'nope.json', unreadable: [{ path: 'nope.json', status: 'missing', reason: 'not-in-manifest' }] }) });
    const bad = commit(dir, { 'arch.json': '{"version":2,"rules":[]}' });
    expect(await run()).toEqual({ exitCode: 2, report: unavailable('rules-invalid',
      { base: tree, tree: bad, rules: 'arch.json', detail: 'version: must be 1' }) });
  });

  it('refuses a covered source over the read cap, a covered symlink and a covered gitlink', async () => {
    write(dir, { 'src/state/big.ts': BIG });
    git(dir, ['add', '-A']);
    const oid = git(dir, ['hash-object', '-w', '--stdin'], '../tools/t.ts');
    git(dir, ['update-index', '--add', '--cacheinfo', `120000,${oid},src/state/link.ts`]);
    git(dir, ['update-index', '--add', '--cacheinfo', `160000,${base},src/state/sub.ts`]);
    git(dir, ['commit', '-qm', 'symlink and gitlink without worktree entries']);
    const tree = git(dir, ['rev-parse', 'HEAD']);
    expect(await run()).toEqual({ exitCode: 2, report: unavailable('source-unreadable', { base, tree, rules: 'arch.json', unreadable: [
      { path: 'src/state/big.ts', status: 'truncated', reason: 'file-byte-cap' },
      { path: 'src/state/link.ts', status: 'refused', reason: 'symlink' },
      { path: 'src/state/sub.ts', status: 'refused', reason: 'submodule' }] }) });
  });

  it('refuses unresolvable revisions, including a root candidate with no base', async () => {
    expect(await run()).toEqual({ exitCode: 2, report: unavailable('revision-unresolved', { detail: expect.any(String) }) });
    commit(dir, { 'docs/a.md': '# d\n' });
    expect(await run(['--rules', 'arch.json', '--tree', 'no-such-ref'])).toEqual({ exitCode: 2,
      report: unavailable('revision-unresolved', { detail: expect.any(String) }) });
  });

  it.each([
    [[]], [['--rules']], [['--rules', 'arch.json', '--tree']], [['--rules', '-x']], [['--rules', '../arch.json']],
    [['--rules', 'arch.json', '--base', '--upload-pack=x']], [['--rules', 'a', '--rules', 'b']], [['--rules', 'a', 'extra']],
  ])('refuses the usage %j', async argv => {
    expect(await run(argv)).toEqual({ exitCode: 2, report: unavailable('usage', { detail: expect.any(String) }) });
  });

  it('refuses a directory that is not the repository root', async () => {
    expect(await run(undefined, path.join(dir, 'src'))).toEqual({ exitCode: 2,
      report: unavailable('repository-unavailable', { detail: expect.any(String) }) });
  });
});

describe('check-architecture under protected required-check definitions (A4, DoD 3)', () => {
  const h = new ToolTestHarness();
  const CHECKER = 'packages/moe-daemon/src/commands/checkArchitecture.ts';
  const ENGINE = 'packages/moe-daemon/src/delivery/architectureRules.ts';
  const COMMAND = 'node packages/moe-daemon/dist/index.js check-architecture --rules arch.json';
  const missing = () => evaluateDeliveryEvidence(h.state, h.state.getTask('task-1')!).missingEvidence;
  /** A runner-recorded candidate whose protected entries are the ls-tree of `rev`, with a passing run of the check. */
  let seq = 0;
  function candidate(rev: string): void {
    const treeSha = git(h.testDir, ['rev-parse', `${rev}^{tree}`]);
    const protectedEntries = ['arch.json', CHECKER, ENGINE].map(p => ({ path: p, oid: git(h.testDir, ['rev-parse', `${rev}:${p}`]) }));
    const id = `cand-${++seq}`;
    const createdAt = new Date(Date.UTC(2026, 9, 30, 0, 0, seq)).toISOString();
    h.state.candidates.set(id, { id, attemptId: 'attempt-1', taskId: 'task-1', baseRevision: treeSha, treeSha,
      deliveryTarget: 'refs/heads/main', protectedEntries, createdAt });
    h.state.checkRuns.set(`${id}-run`, { id: `${id}-run`, candidateId: id, treeSha, command: COMMAND, exitCode: 0,
      outputTail: '', runnerId: 'runner-1', source: 'runner-observed', createdAt });
  }
  beforeEach(async () => {
    h.init(); h.setupMoeFolder(); h.createEpic(); seq = 0;
    h.createTask({ status: 'PLANNING', commits: [{ sha: 'ab'.repeat(20), ref: 'main', kind: 'completion', role: 'worker',
      sessionId: 'worker-1@x', paths: [], recordedBy: 'worker-1', recordedAt: '2026-10-30T00:00:00.000Z' }] });
    await h.state.load();
    h.state.project!.settings = { ...h.state.project!.settings, deliveryPolicy: 'local-branch' } as never;
    git(h.testDir, ['init', '-q']);
    commit(h.testDir, { 'arch.json': RULES, [CHECKER]: '// checker\n', [ENGINE]: '// engine\n',
      'src/state/s.ts': 'export const s = 1;\n', 'src/tools/t.ts': 'export const t = 1;\n' });
    await submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }],
      executionContract: { requiredChecks: [{ id: 'arch', command: COMMAND, configs: ['arch.json'], scripts: [CHECKER, ENGINE] }] } }, h.state);
  });
  afterEach(() => { h.state.clearEmitter(); h.cleanup(); });

  it('refuses a candidate that weakens arch.json, though the check itself reads and passes that tree', async () => {
    candidate('HEAD');
    expect(missing()).toEqual([]);
    const weakened = JSON.stringify({ version: 1, rules: [{ ...RULE, forbid: ['src/none'] }] });
    commit(h.testDir, { 'arch.json': weakened, 'src/state/s.ts': FORBIDDEN });
    expect((await run(['--rules', 'arch.json'], h.testDir)).exitCode).toBe(0);
    candidate('HEAD');
    expect(missing()).toEqual(['protected-check-changed:arch.json']);
  });

  it('refuses a candidate that edits the checker or its engine', async () => {
    commit(h.testDir, { [CHECKER]: '// always pass\n', [ENGINE]: '// gutted\n' });
    candidate('HEAD');
    expect(missing()).toEqual([`protected-check-changed:${CHECKER}`, `protected-check-changed:${ENGINE}`]);
  });
});

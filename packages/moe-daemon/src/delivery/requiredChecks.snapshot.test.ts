import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { StateManager } from '../state/StateManager.js';
import { updateTask } from '../state/taskStore.js';
import { MoeErrorCode } from '../util/errors.js';
import type { Task } from '../types/schema.js';
import * as checks from './requiredChecks.js';
import * as cachedPaths from '../util/cachedPlanPaths.js';

const h = new ToolTestHarness();
const defs = [{ id: 'unit', command: 'npm test', configs: ['cfg/check.json'],
  scripts: ['scripts/check.sh'], assertionRoots: ['tests/acc'] }];
const files = ['cfg/check.json', 'scripts/check.sh', 'tests/acc/a.test.ts', 'tests/acc/deep/b.test.ts'];
const oid = 'a'.repeat(40);
const field = 'executionContract.requiredChecks';
const invalid = (key = field) => ({ code: MoeErrorCode.INVALID_INPUT, context: expect.objectContaining({ field: key }) });
const current = () => h.state.getTask('task-1')!;
const bytes = () => fs.readFileSync(path.join(h.moePath, 'tasks/task-1.json'), 'utf8');
const submit = (extra: Record<string, unknown> = {}) => submitPlanTool(h.state).handler({ taskId: 'task-1',
  steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }], executionContract: { requiredChecks: defs }, ...extra }, h.state);
function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function repo(): void {
  git('init', '-q');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), `${file}\n`);
  }
  git('add', '--', ...files); git('commit', '-qm', 'fixture');
}
function snapshot() {
  return { version: 1 as const, revision: git('rev-parse', 'HEAD^{tree}'), definitionDigest: checks.definitionDigest(defs),
    entries: files.map(file => ({ path: file, oid: git('rev-parse', `HEAD:${file}`) })) };
}
function fakeRun(listing: string) {
  return vi.spyOn(checks.requiredCheckGit, 'run').mockImplementation(async args => {
    if (args.includes('--show-toplevel')) return h.testDir;
    if (args[0] === 'config') return '';
    if (args.includes('--verify')) return oid;
    return listing;
  });
}
async function refused(extra: Record<string, unknown> = {}, key = field): Promise<void> {
  const before = bytes(); const task = structuredClone(current());
  await expect(submit(extra)).rejects.toMatchObject(invalid(key));
  expect(bytes()).toBe(before); expect(current()).toEqual(task);
}
async function replan(): Promise<void> { await h.state.updateTask('task-1', { status: 'PLANNING' }); }
beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); h.createTask({ status: 'PLANNING', planRevision: 7 });
  await h.state.load();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

describe('daemon-measured required check snapshot', () => {
  it('persists the exact recursive blob identity with the advanced revision in one write', async () => {
    repo(); const expected = snapshot(); const write = vi.spyOn(h.state, 'writeEntity');
    expect(submitPlanTool(h.state).inputSchema).toMatchObject({ properties: {
      requiredCheckRevision: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    } });
    await submit();
    expect(current().requiredCheckSnapshot).toEqual(expected); expect(current().planRevision).toBe(8);
    const writes = write.mock.calls.filter(([kind]) => kind === 'tasks');
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toMatchObject({ requiredCheckSnapshot: expected, planRevision: 8 });
    await h.state.load(); expect(current().requiredCheckSnapshot).toEqual(expected); expect(current().planRevision).toBe(8);
  });
  it.each(['commit', 'tree'])('pins an explicitly approved older %s', async kind => {
    repo(); const expected = snapshot(); const revision = git('rev-parse', kind === 'commit' ? 'HEAD' : 'HEAD^{tree}');
    fs.writeFileSync(path.join(h.testDir, files[0]), 'changed'); git('add', files[0]); git('commit', '-qm', 'newer');
    await submit({ requiredCheckRevision: revision }); expect(current().requiredCheckSnapshot).toEqual(expected);
  });
  it('removes the snapshot key on a resubmission without checks', async () => {
    repo(); await submit(); await replan(); await submit({ executionContract: undefined });
    expect(Object.hasOwn(current(), 'requiredCheckSnapshot')).toBe(false);
    expect(Object.hasOwn(JSON.parse(bytes()), 'requiredCheckSnapshot')).toBe(false);
  });
  it.each(['configs', 'scripts'])('refuses an absent %s path without writing', async kind => {
    repo(); await refused({ executionContract: { requiredChecks: [{ ...defs[0], [kind]: ['absent'] }] } });
  });
  it('refuses an unresolvable revision without writing', async () => {
    repo(); await refused({ requiredCheckRevision: 'f'.repeat(40) }, 'requiredCheckRevision');
  });
  it('refuses a non-git project without writing', async () => { await refused(); });
  it('refuses a nested project without writing', async () => {
    repo(); const outer = h.testDir; const nested = path.join(outer, 'nested'); fs.mkdirSync(nested);
    fs.cpSync(h.moePath, path.join(nested, '.moe'), { recursive: true }); fs.writeFileSync(path.join(nested, 'file.ts'), '');
    h.state = new StateManager({ projectPath: nested }); await h.state.load();
    const before = fs.readFileSync(path.join(nested, '.moe/tasks/task-1.json'), 'utf8');
    await refused({ executionContract: { requiredChecks: [{ id: 'empty', command: 'test', assertionRoots: ['absent'] }] } });
    expect(fs.readFileSync(path.join(nested, '.moe/tasks/task-1.json'), 'utf8')).toBe(before);
  });
  it.each(['spawn', 'timeout', 'overflow'])('refuses injected %s failures without writing', async message => {
    vi.spyOn(checks.requiredCheckGit, 'run').mockRejectedValue(new Error(message)); await refused();
  });
  it('refuses 2001 entries without writing', async () => {
    fakeRun(Array.from({ length: 2001 }, (_, i) => `100644 blob ${oid}\ttests/acc/${i}\0`).join(''));
    await refused({ executionContract: { requiredChecks: [{ id: 'many', command: 'test', assertionRoots: ['tests/acc'] }] } });
  });
  it('refuses a real gitlink under a protected root without writing', async () => {
    repo(); git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},tests/acc/module`);
    git('commit', '-qm', 'gitlink'); await refused();
  });
  it.skipIf(process.platform === 'win32')('refuses lossy UTF-8 paths rather than approving a different filename', async () => {
    repo();
    fs.writeFileSync(Buffer.concat([Buffer.from(`${h.testDir}/tests/acc/`), Buffer.from([0xff])]), 'invalid name');
    git('add', 'tests/acc'); git('commit', '-qm', 'non-UTF8 path'); await refused();
  });
  it.each(['HEAD', 'A'.repeat(40), 'a'.repeat(64), 'bad', null, 1])('refuses malformed revision %j before Git', async revision => {
    const run = vi.spyOn(checks.requiredCheckGit, 'run'); await refused({ requiredCheckRevision: revision }, 'requiredCheckRevision');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses revision without checks before Git', async () => {
    const run = vi.spyOn(checks.requiredCheckGit, 'run');
    await refused({ executionContract: undefined, requiredCheckRevision: oid }, 'requiredCheckRevision');
    expect(run).not.toHaveBeenCalled();
  });
  it('allows an empty assertion root', async () => {
    repo(); const empty = [{ id: 'empty', command: 'test', assertionRoots: ['absent'] }];
    await submit({ executionContract: { requiredChecks: empty } });
    expect(current().requiredCheckSnapshot).toEqual({ version: 1, revision: git('rev-parse', 'HEAD^{tree}'),
      definitionDigest: checks.definitionDigest(empty), entries: [] });
  });
  it('never invokes Git or creates a snapshot key for a plan without checks', async () => {
    const run = vi.spyOn(checks.requiredCheckGit, 'run'); await submit({ executionContract: undefined });
    expect(run).not.toHaveBeenCalled(); expect(Object.hasOwn(current(), 'requiredCheckSnapshot')).toBe(false);
    expect(Object.hasOwn(JSON.parse(bytes()), 'requiredCheckSnapshot')).toBe(false);
  });
  it('publishes neither snapshot nor plan on a failed durable write', async () => {
    repo(); const before = bytes(); const task = structuredClone(current()); const emit = vi.spyOn(h.state, 'emit');
    vi.spyOn(h.state, 'writeEntity').mockRejectedValue(new Error('disk full'));
    await expect(submit()).rejects.toThrow('disk full');
    expect(bytes()).toBe(before); expect(current()).toEqual(task); expect(emit).not.toHaveBeenCalled();
  });
});

describe('snapshot trust boundary and decoder', () => {
  it.each([false, true])('strips caller set/alter/clear with prior snapshot=%j', async present => {
    repo(); if (present) await submit(); const stored = current().requiredCheckSnapshot;
    for (const value of [snapshot(), { ...snapshot(), revision: oid }, null, undefined]) {
      await h.state.updateTask('task-1', { requiredCheckSnapshot: value } as Partial<Task>);
      expect(current().requiredCheckSnapshot).toEqual(stored);
      expect(Object.hasOwn(current(), 'requiredCheckSnapshot')).toBe(present);
    }
  });
  it('ignores internal arguments outside PLAN_SUBMITTED and strips createTask input', async () => {
    repo(); const value = snapshot();
    await updateTask(h.state, 'task-1', {}, 'TASK_UPDATED', undefined, { requiredCheckSnapshot: value });
    expect(Object.hasOwn(current(), 'requiredCheckSnapshot')).toBe(false);
    const created = await h.state.createTask({ epicId: 'epic-1', title: 'new', requiredCheckSnapshot: value });
    expect(Object.hasOwn(created, 'requiredCheckSnapshot')).toBe(false);
  });
  it('returns a detached copy only while the current definition digest matches', async () => {
    repo(); await submit(); const decoded = checks.readRequiredCheckSnapshot(current());
    expect(decoded).toEqual(snapshot()); decoded!.entries[0].oid = oid;
    expect(current().requiredCheckSnapshot).toEqual(snapshot());
    await h.state.updateTask('task-1', { executionContract: { requiredChecks: [{ ...defs[0], command: 'changed' }] } });
    expect(checks.readRequiredCheckSnapshot(current())).toBeNull();
  });
  it.each<[string, object]>([
    ['version', { version: 2 }], ['revision', { revision: 'A'.repeat(40) }], ['digest', { definitionDigest: 'short' }],
    ['extra key', { extra: true }], ['non-array', { entries: {} }],
    ...['short', 'A'.repeat(40)].map<[string, object]>(oid => ['oid', { entries: [{ path: files[0], oid }] }]),
    ['unsorted', { entries: [{ path: 'z', oid }, { path: 'a', oid }] }],
    ['duplicate', { entries: [{ path: 'a', oid }, { path: 'a', oid }] }],
    ['entry key', { entries: [{ path: 'a', oid, extra: 1 }] }],
    ...['../a', '/abs', './a', 'a\nb', 'a\0b', 'a/\ufffd', 'a/\ud800'].map<[string, object]>(path => ['path', { entries: [{ path, oid }] }]),
    ['too many', { entries: Array.from({ length: 2001 }, (_, i) => ({ path: `${i}`.padStart(4, '0'), oid })) }],
  ])('fails closed on malformed %s', (_name, patch) => {
    const task = { ...current(), executionContract: { requiredChecks: defs }, requiredCheckSnapshot: {
      version: 1, revision: oid, definitionDigest: checks.definitionDigest(defs), entries: [], ...patch,
    } } as Task;
    expect(checks.readRequiredCheckSnapshot(task)).toBeNull();
  });
  it('rejects absent checks and malformed stored contracts', () => {
    for (const executionContract of [undefined, { requiredChecks: [] }, { requiredChecks: [null] }]) {
      expect(checks.readRequiredCheckSnapshot({ ...current(), executionContract } as Task)).toBeNull();
    }
  });
  it.each([`100644 blob ${oid}\ta`, `160000 commit ${oid}\ta\0`, `040000 tree ${oid}\ta\0`,
    `100644 blob ${oid}\ta\0\0`, `100644 blob ${oid}\t../escape\0`, `100644 blob ${oid}\ta\nb\0`])
    ('refuses malformed or unsafe listings %#', async listing => {
      fakeRun(listing); await refused({ executionContract: { requiredChecks: [{ id: 'one', command: 'test', assertionRoots: ['a'] }] } });
    });
});

describe('bounded measurement primitives', () => {
  it('measures real Git directly and masks inherited Git configuration', async () => {
    repo(); const expected = snapshot();
    vi.stubEnv('GIT_DIR', path.join(h.testDir, 'wrong')); vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree'); vi.stubEnv('GIT_CONFIG_VALUE_0', '/wrong');
    expect(await checks.measureRequiredCheckSnapshot(h.testDir, defs)).toEqual(expected);
  });
  it('sorts bytewise, accepts blob modes, deduplicates overlapping pathspecs, and sets bounded reads', async () => {
    const paths = ['a/😀', 'a/\ue000', 'a/link'];
    const run = fakeRun(paths.map((p, i) => `${['100644', '100755', '120000'][i]} blob ${oid}\t${p}\0`).join(''));
    const d = [{ id: 'one', command: 'test', configs: ['a'], scripts: ['a'], assertionRoots: ['a'] }];
    const measured = await checks.measureRequiredCheckSnapshot(h.testDir, d);
    expect(measured.entries.map(e => e.path)).toEqual(['a/link', 'a/\ue000', 'a/😀']);
    expect(checks.readRequiredCheckSnapshot({ ...current(), executionContract: { requiredChecks: d }, requiredCheckSnapshot: measured })).toEqual(measured);
    expect(run.mock.calls[3][0]).toEqual(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', oid, '--', 'a']);
    expect(run.mock.calls[3][3]).toBe(1024 * 1024);
    expect(run.mock.calls.map(c => c[2]).every(n => n > 0 && n <= 5000)).toBe(true);
  });
  it('accepts exactly 2000 blobs', async () => {
    fakeRun(Array.from({ length: 2000 }, (_, i) => `100644 blob ${oid}\ta/${i}\0`).join(''));
    expect((await checks.measureRequiredCheckSnapshot(h.testDir, [{ id: 'one', command: 'test', configs: ['a'] }])).entries).toHaveLength(2000);
  });
  it('does not list the entire tree for command-only checks', async () => {
    repo(); const run = vi.spyOn(checks.requiredCheckGit, 'run');
    expect((await checks.measureRequiredCheckSnapshot(h.testDir, [{ id: 'one', command: 'test' }])).entries).toEqual([]);
    expect(run.mock.calls.some(c => c[0].includes('ls-tree'))).toBe(false);
  });
  it.each(['a'.repeat(64), 'A'.repeat(40)])('refuses unsupported tree identity %s', async tree => {
    const run = fakeRun(''); run.mockImplementation(async args => args.includes('--show-toplevel') ? h.testDir : args[0] === 'config' ? '' : tree);
    await expect(checks.measureRequiredCheckSnapshot(h.testDir, defs)).rejects.toMatchObject(invalid('requiredCheckRevision'));
  });
});

describe('submission revalidation across asynchronous measurement', () => {
  it('reuses the measured snapshot on the cached-path retry', async () => {
    repo(); h.state.project!.settings.consolidationBranch = 'main';
    const run = vi.spyOn(checks.requiredCheckGit, 'run');
    const lookup = vi.spyOn(cachedPaths, 'findCachedPlanPaths').mockResolvedValue({
      ref: 'refs/remotes/origin/main', commit: oid, paths: ['missing.ts'], warning: 'fixture',
    });
    await submit({ steps: [{ description: 'test', affectedFiles: ['missing.ts'] }] });
    expect(lookup).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledTimes(4);
    expect(current().requiredCheckSnapshot).toEqual(snapshot());
  });
  it('leaves the mutex free and never overwrites a competing accepted plan', async () => {
    repo(); const original = checks.requiredCheckGit.run;
    let resume!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { resume = r; }); const started = new Promise<void>(r => { entered = r; });
    vi.spyOn(checks.requiredCheckGit, 'run').mockImplementationOnce(async (...args) => {
      entered(); await gate; return original(...args);
    });
    const first = submit(); await started;
    const second = [{ ...defs[0], command: 'second' }];
    await submit({ executionContract: { requiredChecks: second } }); const stored = bytes();
    resume(); await expect(first).rejects.toMatchObject({ codeName: 'INVALID_STATE' });
    expect(bytes()).toBe(stored); expect(current().requiredCheckSnapshot?.definitionDigest).toBe(checks.definitionDigest(second));
  });
  it('rejects definition mutation while Git is pending without writing', async () => {
    repo(); const input = structuredClone(defs); const before = bytes(); const original = checks.requiredCheckGit.run;
    vi.spyOn(checks.requiredCheckGit, 'run').mockImplementationOnce(async (...args) => {
      input[0].command = 'mutated'; return original(...args);
    });
    await refused({ executionContract: { requiredChecks: input } }); expect(bytes()).toBe(before);
  });
  it.each(['extensions.partialclone', 'remote.origin.promisor', 'core.worktree'])('refuses local %s before reading objects', async key => {
    repo(); git('config', key, key === 'remote.origin.promisor' ? 'true' : h.testDir);
    const run = vi.spyOn(checks.requiredCheckGit, 'run'); await refused();
    expect(run.mock.calls.some(c => c[0].includes('--verify'))).toBe(false);
  });
});

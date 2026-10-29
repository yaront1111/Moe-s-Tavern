import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { qaRejectTool } from '../tools/qaReject.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { updateTask } from '../state/taskStore.js';
import type { Task, TaskStatus } from '../types/schema.js';
import { MoeErrorCode } from '../util/errors.js';
import {
  planSourceGit, readPlanningEntry, readPlanReuseRecord, readPlanSourceBasis, validatePlanReuseRecord,
} from './planReuseState.js';

type Row = Record<string, unknown>;
const AT = '2026-10-27T10:00:00.000Z';
const basis = (): Row => ({ version: 1, commit: 'a'.repeat(40), planRevision: 3 });
const entry = (): Row => ({ from: 'WORKING', at: AT, seq: 2 });
const record = (): Row => ({ version: 1, decision: 'refresh', planRevision: 3, entrySeq: 2, reasons: ['head moved'],
  assessedAt: AT, basisCommit: 'a'.repeat(40), headCommit: 'b'.repeat(64), changedPaths: ['src/a.ts'], candidate: 'revalidate' });
const set = (base: Row, key: string, value: unknown): Row => ({ ...base, [key]: value });
const drop = (base: Row, key: string): Row => { const v = { ...base }; delete v[key]; return v; };
/** A non-enumerable required key plus an enumerable extra: assigned AFTER defineProperty (spread drops hidden keys). */
const hidden = (base: Row, key: string): Row => {
  const v = drop(base, key);
  Object.defineProperty(v, key, { value: base[key], enumerable: false });
  v.extra = 1;
  return v;
};
class Instance { version = 1; }
const shared = (base: () => Row, key: string): [string, unknown][] => [
  ['an extra key', set(base(), 'extra', 1)], ['a missing key', drop(base(), key)],
  ['a hidden required key plus an extra key', hidden(base(), key)],
  ['an array', [base()]], ['a class instance', new Instance()], ['an absent field', undefined],
];
const integers = (base: () => Row, key: string): [string, unknown][] => [
  [`${key} -1`, set(base(), key, -1)], [`${key} 2**53`, set(base(), key, 2 ** 53)],
  [`${key} NaN`, set(base(), key, NaN)], [`${key} as a string`, set(base(), key, '3')],
];
const commits = (base: () => Row, key: string): [string, unknown][] => [
  ['a 39-hex commit', set(base(), key, 'a'.repeat(39))], ['an uppercase commit', set(base(), key, 'A'.repeat(40))],
  ['a non-hex commit', set(base(), key, 'g'.repeat(40))],
];
interface Decoder { name: string; valid: () => Row; read: (v: unknown) => unknown; malformed: [string, unknown][] }
const DECODERS: Decoder[] = [
  { name: 'readPlanSourceBasis', valid: basis, read: (v: unknown) => readPlanSourceBasis({ planSourceBasis: v as never }),
    malformed: [...shared(basis, 'commit'), ...integers(basis, 'planRevision'), ...commits(basis, 'commit'),
      ['version 2', set(basis(), 'version', 2)]] },
  { name: 'readPlanningEntry', valid: entry, read: (v: unknown) => readPlanningEntry({ planningEntry: v as never }),
    malformed: [...shared(entry, 'from'), ...integers(entry, 'seq'), ['seq 0', set(entry(), 'seq', 0)],
      ['an unknown status', set(entry(), 'from', 'PAUSED')], ['a non-canonical ISO time', set(entry(), 'at', '2026-10-27T10:00:00Z')],
      ['an impossible date', set(entry(), 'at', '2026-02-30T10:00:00.000Z')]] },
  { name: 'readPlanReuseRecord', valid: record, read: (v: unknown) => readPlanReuseRecord({ planReuse: v as never }),
    malformed: [...shared(record, 'decision'), ...integers(record, 'planRevision'), ...integers(record, 'entrySeq'),
      ...commits(record, 'basisCommit'), ...commits(record, 'headCommit'),
      ['an own undefined optional key', set(record(), 'candidate', undefined)],
      ['an unknown decision', set(record(), 'decision', 'keep')], ['an unknown candidate', set(record(), 'candidate', 'stale')],
      ['33 reasons', set(record(), 'reasons', Array(33).fill('r'))], ['an empty reason', set(record(), 'reasons', [''])],
      ['a 301-char reason', set(record(), 'reasons', ['r'.repeat(301)])], ['a control-character reason', set(record(), 'reasons', ['a\nb'])],
      ['65 changedPaths', set(record(), 'changedPaths', Array.from({ length: 65 }, (_, i) => `f${i}`))],
      ...['./a', 'a\\b', '/abs', '../x', 'a\u0007'].map((p): [string, unknown] => [`changedPath ${JSON.stringify(p)}`, set(record(), 'changedPaths', [p])]),
      ['a non-canonical ISO time', set(record(), 'assessedAt', '2026-10-27')]] },
];

describe.each(DECODERS)('$name', ({ valid, read, malformed }) => {
  it('returns a detached copy of the exact shape', () => {
    const source = valid(); const out = read(source) as Row;
    expect(out).toEqual(source); expect(out).not.toBe(source);
    for (const value of Object.values(out)) if (Array.isArray(value)) value.push('mutated');
    expect(source).toEqual(valid());
  });
  it.each(malformed)('returns null for %s', (_label, value) => expect(read(value)).toBeNull());
});

describe('validatePlanReuseRecord', () => {
  it('accepts the required keys alone and an empty reasons list', () => {
    const minimal = { version: 1, decision: 'reuse', planRevision: 0, entrySeq: 0, reasons: [], assessedAt: AT };
    expect(validatePlanReuseRecord(minimal)).toEqual(minimal);
  });
  it.each(DECODERS[2].malformed)('throws INVALID_INPUT for %s', (_label, value) => {
    expect(() => validatePlanReuseRecord(value)).toThrowError(expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT }));
  });
  it('turns a throwing getter into INVALID_INPUT and the reader into null', () => {
    const value = record(); Object.defineProperty(value, 'reasons', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => validatePlanReuseRecord(value)).toThrowError(expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT }));
    expect(readPlanReuseRecord({ planReuse: value as never })).toBeNull();
  });
});

const h = new ToolTestHarness();
const row = () => h.state.getTask('task-1')!;
const disk = () => fs.readFileSync(path.join(h.moePath, 'tasks/task-1.json'), 'utf8');
const move = (status: TaskStatus, extra: Partial<Task> = {}) => h.state.updateTask('task-1', { status, ...extra });
const KEYS = ['planSourceBasis', 'planningEntry', 'planReuse'] as const;
beforeEach(async () => { h.init(); h.setupMoeFolder(); h.createEpic(); h.createTask(); await h.state.load(); });
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

describe('planningEntry stamp', () => {
  it('BACKLOG->PLANNING stamps from BACKLOG, seq 1', async () => {
    await move('PLANNING');
    expect(row().planningEntry).toEqual({ from: 'BACKLOG', at: row().updatedAt, seq: 1 });
    expect(JSON.parse(disk()).planningEntry).toEqual(row().planningEntry);
  });
  it('a later WORKING->PLANNING stamps seq 2 from WORKING', async () => {
    await move('PLANNING'); await move('WORKING'); await move('PLANNING');
    expect(row().planningEntry).toEqual({ from: 'WORKING', at: row().updatedAt, seq: 2 });
  });
  it('qa_reject escalation stamps from REVIEW', async () => {
    h.createTask({ status: 'REVIEW', reopenCount: 2, assignedWorkerId: 'qa-a', contextFetchedBy: ['qa-a'] }); await h.state.load();
    await qaRejectTool(h.state).handler({ taskId: 'task-1', reason: 'still broken', workerId: 'qa-a' }, h.state);
    expect(row()).toMatchObject({ status: 'PLANNING', planningEntry: { from: 'REVIEW', seq: 1 } });
  });
  it('BLOCKED (blockedFromStatus PLANNING)->PLANNING keeps the earlier entry', async () => {
    await move('PLANNING'); const first = row().planningEntry;
    await move('BLOCKED', { blockedFromStatus: 'PLANNING' }); await move('PLANNING', { blockedFromStatus: null });
    expect(row().planningEntry).toEqual(first);
  });
  it('BLOCKED (blockedFromStatus WORKING)->PLANNING stamps from BLOCKED', async () => {
    await move('PLANNING'); await move('WORKING');
    await move('BLOCKED', { blockedFromStatus: 'WORKING' }); await move('PLANNING', { blockedFromStatus: null });
    expect(row().planningEntry).toMatchObject({ from: 'BLOCKED', seq: 2 });
  });
  it('wraps seq to 1 instead of writing an unsafe integer', async () => {
    h.createTask({ planningEntry: { from: 'WORKING', at: AT, seq: Number.MAX_SAFE_INTEGER } }); await h.state.load();
    await move('PLANNING'); expect(row().planningEntry?.seq).toBe(1);
  });
  it('createTask never stamps', async () => {
    const created = await h.state.createTask({ epicId: 'epic-1', title: 'new', status: 'PLANNING',
      planningEntry: { from: 'BACKLOG', at: AT, seq: 1 } });
    expect(Object.hasOwn(created, 'planningEntry')).toBe(false);
  });
});

describe('plan-reuse state ownership', () => {
  async function seed() {
    await move('PLANNING');
    await updateTask(h.state, 'task-1', {}, 'PLAN_SUBMITTED', undefined,
      { planSourceBasis: { commit: 'a'.repeat(40) }, planReuse: record() as never });
    expect(row().planSourceBasis).toEqual({ version: 1, commit: 'a'.repeat(40), planRevision: row().planRevision });
    return structuredClone({ planSourceBasis: row().planSourceBasis, planningEntry: row().planningEntry, planReuse: row().planReuse });
  }
  it.each([
    ['forged values', { planSourceBasis: { ...basis(), commit: 'c'.repeat(40) }, planningEntry: entry(), planReuse: record() }],
    ['null', { planSourceBasis: null, planningEntry: null, planReuse: null }],
  ])('strips caller %s and keeps the seeded state', async (_label, values) => {
    const seeded = await seed();
    await h.state.updateTask('task-1', { title: 'Renamed', ...values } as Partial<Task>);
    const stored = JSON.parse(disk());
    expect(row().title).toBe('Renamed');
    for (const key of KEYS) { expect(row()[key]).toEqual(seeded[key]); expect(stored[key]).toEqual(seeded[key]); }
  });
  it('stores a validated detached daemonOwned record on a plain update', async () => {
    const input = record();
    await updateTask(h.state, 'task-1', {}, undefined, undefined, { planReuse: input as never });
    (input.reasons as string[]).push('later'); input.decision = 'replan';
    expect(row().planReuse).toEqual(record());
  });
  it.each([
    ['a malformed record', undefined, { planReuse: { ...record(), decision: 'keep' } }],
    ['a malformed basis commit', 'PLAN_SUBMITTED', { planSourceBasis: { commit: 'XYZ' } }],
  ] as const)('refuses %s with INVALID_INPUT before any write or emit', async (_label, event, owned) => {
    await seed(); const before = disk(); const memory = structuredClone(row()); const emit = vi.spyOn(h.state, 'emit');
    await expect(updateTask(h.state, 'task-1', { title: 'x' }, event, undefined, owned as never))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    expect(disk()).toBe(before); expect(row()).toEqual(memory); expect(emit).not.toHaveBeenCalled();
  });
});

describe('submit_plan planSourceBasis capture', () => {
  function git(...args: string[]): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
      cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
    }).trim();
  }
  const commit = (message: string) => {
    fs.appendFileSync(path.join(h.testDir, 'file.ts'), `${message}\n`); git('add', 'file.ts'); git('commit', '-qm', message);
  };
  const submit = () => submitPlanTool(h.state).handler({ taskId: 'task-1',
    steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }] }, h.state) as Promise<{ planRevision: number; warnings?: unknown[] }>;
  const stored = () => [row().planSourceBasis, JSON.parse(disk()).planSourceBasis];

  it('stores HEAD with the committed revision, and a resubmission refreshes both', async () => {
    git('init', '-q'); commit('one'); await move('PLANNING');
    const first = await submit();
    const expected = { version: 1, commit: git('rev-parse', 'HEAD'), planRevision: row().planRevision };
    expect(first.planRevision).toBe(expected.planRevision); expect(stored()).toEqual([expected, expected]);
    commit('two'); await move('PLANNING');
    const second = await submit();
    const refreshed = { version: 1, commit: git('rev-parse', 'HEAD'), planRevision: second.planRevision };
    expect(refreshed.commit).not.toBe(expected.commit); expect(refreshed.planRevision).toBeGreaterThan(expected.planRevision);
    expect(stored()).toEqual([refreshed, refreshed]);
  });
  it.each([
    ['a non-Git root', async () => {}],
    ['an injected Git failure', async () => {
      git('init', '-q'); commit('one'); await submit(); expect(row().planSourceBasis?.commit).toBe(git('rev-parse', 'HEAD'));
      await move('PLANNING'); vi.spyOn(planSourceGit, 'run').mockRejectedValue(new Error('injected'));
    }],
    ['an unborn HEAD', async () => { git('init', '-q'); }],
  ])('submits with %s, storing no basis and removing an older one', async (_label, arrange) => {
    h.createTask({ status: 'PLANNING', planSourceBasis: { version: 1, commit: 'a'.repeat(40), planRevision: 0 } });
    await h.state.load(); await arrange();
    const result = await submit();
    expect(row().status).toBe('AWAITING_APPROVAL'); expect(result.warnings ?? []).toEqual([]);
    expect(Object.hasOwn(row(), 'planSourceBasis')).toBe(false);
    expect(Object.hasOwn(JSON.parse(disk()), 'planSourceBasis')).toBe(false);
  });
});

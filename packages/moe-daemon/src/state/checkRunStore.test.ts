import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import {
  MAX_CHECK_LOG_BYTES,
  getCheckRun,
  listCheckRunsForCandidate,
  recordCheckRun,
  validateCheckRunParams,
  type RecordCheckRunParams,
} from './checkRunStore.js';
import { recordCandidate } from './candidateStore.js';
import { openAttempt } from './attemptStore.js';
import { StateManager } from './StateManager.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type CheckRun } from '../types/schema.js';

const stateDir = path.dirname(fileURLToPath(import.meta.url));
const SHA = { base: 'a1'.repeat(20), treeA: 'c3'.repeat(20), treeB: 'd4'.repeat(20), upper: 'E5'.repeat(20), short: 'abc1234' };
const GATE = 'node gate.cjs';
const MAX = MAX_CHECK_LOG_BYTES;
const T1 = '2026-09-12T03:00:00.000Z';
const T2 = '2026-09-12T03:05:00.000Z';
/** One character each of 2, 3 and 4 UTF-8 bytes, and the replacement character. */
const TWO = '\u00e9';
const THREE = '\u4e2d';
const FOUR = '\u{1F600}';
const FFFD = '\uFFFD';

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const replacementCount = (text: string): number => text.split(FFFD).length - 1;
const ids = (runs: CheckRun[]): string[] => runs.map((run) => run.id);

type Override = Partial<Record<keyof RecordCheckRunParams, unknown>>;

describe('checkRunStore', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    await h.state.load();
    await openAttempt(h.state, { id: 'attempt-1', taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt/a' });
    const candidate = { attemptId: 'attempt-1', taskId: 'task-1', baseRevision: SHA.base, deliveryTarget: 'refs/heads/wave1-pilot' };
    await recordCandidate(h.state, { ...candidate, id: 'cand-a', treeSha: SHA.treeA });
    await recordCandidate(h.state, { ...candidate, id: 'cand-b', treeSha: SHA.treeB });
    await recordCandidate(h.state, { ...candidate, id: 'cand-upper', treeSha: SHA.upper });
    await recordCandidate(h.state, { ...candidate, id: 'cand-short', treeSha: SHA.short });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  /** The held-out acceptance test's record_check_run payload, minus its id. */
  const base: RecordCheckRunParams = {
    candidateId: 'cand-a',
    treeSha: SHA.treeA,
    command: GATE,
    exitCode: 0,
    outputTail: 'gate ok',
    runnerId: 'runner-pilot',
    source: 'runner-observed',
  };

  const checksDir = (): string => path.join(h.moePath, 'checks');
  const checkFile = (id: string): string => path.join(checksDir(), `${id}.json`);
  const checkFiles = (): string[] => (fs.existsSync(checksDir()) ? fs.readdirSync(checksDir()).sort() : []);
  const readBytes = (id: string): Buffer => fs.readFileSync(checkFile(id));
  const readRecord = (id: string): CheckRun => JSON.parse(readBytes(id).toString('utf8')) as CheckRun;
  const record = (override: Override = {}): Promise<{ checkRun: CheckRun; duplicate: boolean }> =>
    recordCheckRun(h.state, { ...base, ...override } as unknown as RecordCheckRunParams);

  /** Date-only fake clock: faking timers would stall atomicWriteJsonAsync's rename retry. */
  function clockAt(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  async function refusal(promise: Promise<unknown>): Promise<MoeError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof MoeError) return error;
      throw error;
    }
    throw new Error('expected a MoeError refusal, but the call succeeded');
  }

  /** Everything a refusal must leave alone: the bytes of every check file, and the in-memory map. */
  function snapshot(): { files: Record<string, string>; map: string } {
    const files: Record<string, string> = {};
    for (const file of checkFiles()) files[file] = fs.readFileSync(path.join(checksDir(), file)).toString('hex');
    return { files, map: JSON.stringify([...h.state.checkRuns.entries()]) };
  }

  // ---------------------------------------------------------------------------
  // recording and reading back
  // ---------------------------------------------------------------------------

  it('persists one file per run carrying exactly the frozen fields plus the daemon clock', async () => {
    clockAt(T1);
    const result = await record({ id: 'check-1' });

    const expected: CheckRun = { id: 'check-1', ...base, createdAt: T1 };
    expect(result).toStrictEqual({ checkRun: expected, duplicate: false });
    expect(readRecord('check-1')).toStrictEqual(expected);
    expect(Object.keys(readRecord('check-1'))).toEqual([
      'id', 'candidateId', 'treeSha', 'command', 'exitCode', 'outputTail', 'runnerId', 'source', 'createdAt',
    ]);
    expect(getCheckRun(h.state, 'check-1')).toStrictEqual(expected);
    expect(checkFiles()).toEqual(['check-1.json']);
  });

  it('generates a fresh check- id when the caller supplies none', async () => {
    const { checkRun } = await record();
    expect(checkRun.id).toMatch(/^check-[0-9a-f]{32}$/);
    expect(checkFiles()).toEqual([`${checkRun.id}.json`]);
    expect(readRecord(checkRun.id)).toStrictEqual(checkRun);
  });

  it('stamps createdAt from the daemon clock and ignores one the caller sends', async () => {
    clockAt(T2);
    const { checkRun } = await record({ id: 'check-1', createdAt: '1999-01-01T00:00:00.000Z' } as Override);
    expect(checkRun.createdAt).toBe(T2);
    expect(readRecord('check-1').createdAt).toBe(T2);
  });

  const preserved: Array<[string, Override]> = [
    ['an agent-reported failing run', { source: 'agent-reported', exitCode: 1 }],
    ['a negative exit code', { exitCode: -1 }],
    ['the smallest safe exit code', { exitCode: Number.MIN_SAFE_INTEGER }],
    ['the largest safe exit code', { exitCode: Number.MAX_SAFE_INTEGER }],
    ['a command with inner and outer spaces', { command: '  node  gate.cjs --name "a b"  ' }],
    ['a command of exactly 500 characters', { command: 'x'.repeat(500) }],
    ['an upper-case tree token', { candidateId: 'cand-upper', treeSha: SHA.upper }],
    ['a 7-character tree token', { candidateId: 'cand-short', treeSha: SHA.short }],
  ];

  it.each(preserved)('records %s exactly as reported', async (_label, override) => {
    const { checkRun } = await record({ id: 'check-1', ...override });
    const expected = { id: 'check-1', ...base, ...override, createdAt: checkRun.createdAt };
    expect(checkRun).toStrictEqual(expected);
    expect(readRecord('check-1')).toStrictEqual(expected);
  });

  it('records a negative-zero exit code as a plain 0, in memory and on disk alike', async () => {
    const { checkRun } = await record({ id: 'check-1', exitCode: -0 });
    expect(checkRun.exitCode).toBe(0);
    expect(h.state.checkRuns.get('check-1')?.exitCode).toBe(0);
    expect(readRecord('check-1').exitCode).toBe(0);
  });

  it('lists many independent runs per candidate by createdAt, then id, never by insertion', async () => {
    clockAt(T1);
    await record({ id: 'check-z' });
    clockAt(T2);
    // m before b under one createdAt: only the id tiebreak can order them.
    await record({ id: 'check-m', exitCode: 1, outputTail: 'gate failed' });
    await record({ id: 'check-b', source: 'agent-reported' });
    await record({ id: 'check-other', candidateId: 'cand-b', treeSha: SHA.treeB });

    expect(ids(listCheckRunsForCandidate(h.state, 'cand-a'))).toEqual(['check-z', 'check-b', 'check-m']);
    expect(ids(listCheckRunsForCandidate(h.state, 'cand-b'))).toEqual(['check-other']);
    expect(listCheckRunsForCandidate(h.state, 'cand-upper')).toEqual([]);
    expect(getCheckRun(h.state, 'check-missing')).toBeNull();
    expect(checkFiles()).toEqual(['check-b.json', 'check-m.json', 'check-other.json', 'check-z.json']);
  });

  it('hands out copies, so no caller can edit a stored run in memory', async () => {
    // The fields are readonly in the type; the casts model a caller that edits anyway.
    const { checkRun } = await record({ id: 'check-1' });
    (checkRun as { exitCode: number }).exitCode = 99;
    (getCheckRun(h.state, 'check-1') as { exitCode: number }).exitCode = 99;
    (listCheckRunsForCandidate(h.state, 'cand-a')[0] as { exitCode: number }).exitCode = 99;

    expect(h.state.checkRuns.get('check-1')?.exitCode).toBe(0);
    expect(getCheckRun(h.state, 'check-1')?.exitCode).toBe(0);
  });

  it('exports no update or delete path at all', async () => {
    const store = await import('./checkRunStore.js');
    expect(Object.keys(store).sort()).toEqual([
      'MAX_CHECK_LOG_BYTES',
      'getCheckRun',
      'listCheckRunsForCandidate',
      'recordCheckRun',
      'validateCheckRunParams',
    ]);
    expect(MAX_CHECK_LOG_BYTES).toBe(16384);
  });

  it('never runs the reported command: no child process in the store', () => {
    const source = fs.readFileSync(path.join(stateDir, 'checkRunStore.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|\bfork\(/);
  });

  // ---------------------------------------------------------------------------
  // candidate binding — every refusal leaves disk and map untouched
  // ---------------------------------------------------------------------------

  it('refuses a candidate id that names no candidate, and fabricates none', async () => {
    await record({ id: 'check-keep' });
    const before = snapshot();

    const error = await refusal(record({ id: 'check-1', candidateId: 'cand-ghost' }));

    expect({ code: error.code, codeName: error.codeName, message: error.message, context: error.context }).toEqual({
      code: -32001,
      codeName: 'CANDIDATE_NOT_FOUND',
      message: '[CANDIDATE_NOT_FOUND] Candidate not found: cand-ghost',
      context: { candidateId: 'cand-ghost' },
    });
    expect(snapshot()).toEqual(before);
    expect(h.state.candidates.has('cand-ghost')).toBe(false);
  });

  const wrongTrees: Array<[string, string, string, string]> = [
    ["another candidate's tree", 'cand-a', SHA.treeA, SHA.treeB],
    ['a 7-character prefix of the tree', 'cand-a', SHA.treeA, SHA.treeA.slice(0, 7)],
    ['the tree in upper case', 'cand-a', SHA.treeA, SHA.treeA.toUpperCase()],
    ['the lower-case spelling of an upper-case tree', 'cand-upper', SHA.upper, SHA.upper.toLowerCase()],
    ['a full sha that merely starts with a short tree', 'cand-short', SHA.short, `${SHA.short}${'0'.repeat(33)}`],
  ];

  it.each(wrongTrees)('refuses %s as CHECK_RUN_TREE_MISMATCH, writing nothing', async (_label, candidateId, expected, actual) => {
    await record({ id: 'check-keep' });
    const before = snapshot();

    const error = await refusal(record({ id: 'check-1', candidateId, treeSha: actual }));

    expect({ code: error.code, codeName: error.codeName, context: error.context }).toEqual({
      code: -32002,
      codeName: 'CHECK_RUN_TREE_MISMATCH',
      context: { candidateId, expectedTreeSha: expected, actualTreeSha: actual },
    });
    expect(error.message).toBe(
      `[CHECK_RUN_TREE_MISMATCH] Check run reports tree ${actual}, but candidate ${candidateId} is tree ${expected}; ` +
        'a check run must name the exact tree of the candidate it checked'
    );
    expect(snapshot()).toEqual(before);
  });

  it('refuses in the specified order: input, then candidate, then tree, then the same-id comparison', async () => {
    await record({ id: 'check-1' });
    const before = snapshot();
    const codeNameOf = async (override: Override): Promise<string> =>
      (await refusal(record({ id: 'check-1', ...override }))).codeName;

    expect(await codeNameOf({ candidateId: 'cand-ghost', source: 'self-certified' })).toBe('INVALID_INPUT');
    expect(await codeNameOf({ candidateId: 'cand-ghost', exitCode: 1 })).toBe('CANDIDATE_NOT_FOUND');
    expect(await codeNameOf({ treeSha: SHA.treeB, exitCode: 1 })).toBe('CHECK_RUN_TREE_MISMATCH');
    expect(await codeNameOf({ candidateId: 'cand-b', treeSha: SHA.treeB })).toBe('CHECK_RUN_IMMUTABLE');
    expect(snapshot()).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // immutability and replay
  // ---------------------------------------------------------------------------

  const changed: Array<[string, Override, string[]]> = [
    ['command', { command: 'node lint.cjs' }, ['command']],
    ['exitCode', { exitCode: 1 }, ['exitCode']],
    ['outputTail', { outputTail: 'gate failed' }, ['outputTail']],
    ['outputTail (absent, so recorded as empty)', { outputTail: undefined }, ['outputTail']],
    ['runnerId', { runnerId: 'runner-other' }, ['runnerId']],
    ['source', { source: 'agent-reported' }, ['source']],
    ['candidateId and treeSha', { candidateId: 'cand-b', treeSha: SHA.treeB }, ['candidateId', 'treeSha']],
  ];

  it.each(changed)('refuses a same-id report that differs in %s, writing nothing', async (_label, override, differingFields) => {
    clockAt(T1);
    await record({ id: 'check-1' });
    const before = snapshot();
    clockAt(T2);

    const error = await refusal(record({ id: 'check-1', ...override }));

    expect({ code: error.code, codeName: error.codeName, message: error.message, context: error.context }).toEqual({
      code: -32002,
      codeName: 'CHECK_RUN_IMMUTABLE',
      message:
        `[CHECK_RUN_IMMUTABLE] Check run check-1 already exists and differs in ${differingFields.join(', ')}; ` +
        'check runs are immutable, so a different result needs a new check-run id',
      context: { checkRunId: 'check-1', differingFields },
    });
    expect(snapshot()).toEqual(before);
  });

  it('replays an identical same-id report: original record and createdAt back, nothing written', async () => {
    clockAt(T1);
    const first = await record({ id: 'check-1' });
    const bytesBefore = readBytes('check-1');
    clockAt(T2);
    const write = vi.spyOn(h.state, 'writeEntity');

    const replay = await record({ id: 'check-1' });

    expect(replay).toStrictEqual({ checkRun: first.checkRun, duplicate: true });
    expect(replay.checkRun.createdAt).toBe(T1);
    expect(write).not.toHaveBeenCalled();
    expect(readBytes('check-1').equals(bytesBefore)).toBe(true);
    (replay.checkRun as { exitCode: number }).exitCode = 7;
    expect(getCheckRun(h.state, 'check-1')).toStrictEqual(first.checkRun);
  });

  it('compares NORMALIZED reports, so two reports that store identically replay', async () => {
    const tail = 'y'.repeat(MAX);
    const long = await record({ id: 'check-1', outputTail: `first preamble ${tail}` });
    const empty = await record({ id: 'check-2', outputTail: undefined });
    expect(long.checkRun.outputTail === tail, 'the stored tail is the final 16384 bytes').toBe(true);
    const write = vi.spyOn(h.state, 'writeEntity');

    const longReplay = await record({ id: 'check-1', outputTail: `another preamble ${tail}` });
    const emptyReplay = await record({ id: 'check-2', outputTail: '' });

    expect(longReplay).toStrictEqual({ checkRun: long.checkRun, duplicate: true });
    expect(emptyReplay).toStrictEqual({ checkRun: empty.checkRun, duplicate: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('records a different result under a fresh id as a separate run and leaves the first intact', async () => {
    clockAt(T1);
    const failed = await record({ id: 'check-1', exitCode: 1, outputTail: 'gate failed' });
    const bytesBefore = readBytes('check-1');
    clockAt(T2);

    const passed = await record({ id: 'check-2' });

    expect(passed.duplicate).toBe(false);
    expect(readBytes('check-1').equals(bytesBefore)).toBe(true);
    expect(getCheckRun(h.state, 'check-1')).toStrictEqual(failed.checkRun);
    expect(listCheckRunsForCandidate(h.state, 'cand-a').map((run) => [run.id, run.exitCode])).toEqual([
      ['check-1', 1],
      ['check-2', 0],
    ]);
    expect(checkFiles()).toEqual(['check-1.json', 'check-2.json']);
  });

  // ---------------------------------------------------------------------------
  // durability, reload and historical rows
  // ---------------------------------------------------------------------------

  it('publishes nothing when the write fails, hands the caller that error, and a retry records it', async () => {
    await record({ id: 'check-keep' });
    const before = snapshot();
    const injected = new Error('Injected check write failure');
    vi.spyOn(h.state, 'writeEntity').mockImplementationOnce(async () => {
      throw injected;
    });

    await expect(record({ id: 'check-1' })).rejects.toBe(injected);

    expect(getCheckRun(h.state, 'check-1')).toBeNull();
    expect(ids(listCheckRunsForCandidate(h.state, 'cand-a'))).toEqual(['check-keep']);
    expect(snapshot()).toEqual(before);
    const retried = await record({ id: 'check-1' });
    expect(retried.duplicate).toBe(false);
    expect(readRecord('check-1')).toStrictEqual(retried.checkRun);
  });

  it('loads persisted runs into a fresh StateManager after a restart', async () => {
    clockAt(T1);
    const a = await record({ id: 'check-a' });
    clockAt(T2);
    const b = await record({ id: 'check-b', exitCode: 2, source: 'agent-reported' });
    vi.useRealTimers();
    const listed = listCheckRunsForCandidate(h.state, 'cand-a');
    expect(ids(listed)).toEqual(['check-a', 'check-b']);

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(restarted.checkRuns.size).toBe(2);
      expect(getCheckRun(restarted, 'check-a')).toStrictEqual(a.checkRun);
      expect(getCheckRun(restarted, 'check-b')).toStrictEqual(b.checkRun);
      expect(listCheckRunsForCandidate(restarted, 'cand-a')).toStrictEqual(listed);
      // Immutability survives the restart: the reloaded run still refuses a changed report.
      const error = await refusal(recordCheckRun(restarted, { ...base, id: 'check-b' }));
      expect([error.code, error.codeName]).toEqual([-32002, 'CHECK_RUN_IMMUTABLE']);
      expect(readRecord('check-b')).toStrictEqual(b.checkRun);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('loads an empty collection, and creates nothing, when no check run was ever recorded', async () => {
    expect(fs.existsSync(checksDir())).toBe(false);
    expect(h.state.checkRuns.size).toBe(0);

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(restarted.checkRuns.size).toBe(0);
      expect(listCheckRunsForCandidate(restarted, 'cand-a')).toEqual([]);
      expect(fs.existsSync(checksDir())).toBe(false);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('loads historical rows verbatim, even ones recording would refuse, listing timestamp-less rows first', async () => {
    // Shaped like the held-out acceptance fixtures: no createdAt, and two rows no gate should ever
    // count (a tree the candidate does not have; a command that is not the gate).
    const row = { candidateId: 'cand-a', treeSha: SHA.treeA, command: GATE, runnerId: 'runner-pilot', source: 'runner-observed' as const };
    const historical: CheckRun[] = [
      { ...row, id: 'check-old-fail', exitCode: 1, outputTail: 'gate failed' },
      { ...row, id: 'check-old-other-tree', treeSha: SHA.treeB, exitCode: 0, outputTail: 'gate ok' },
      { ...row, id: 'check-old-other-command', command: 'node lint.cjs', exitCode: 0, outputTail: 'lint ok' },
      { ...row, id: 'check-old-dated', exitCode: 0, outputTail: 'gate ok', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    fs.mkdirSync(checksDir(), { recursive: true });
    for (const stored of historical) fs.writeFileSync(checkFile(stored.id), JSON.stringify(stored, null, 2));
    const bytesBefore = historical.map((stored) => readBytes(stored.id));
    clockAt(T1);
    await record({ id: 'check-new' });
    vi.useRealTimers();

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      for (const stored of historical) expect(getCheckRun(restarted, stored.id)).toStrictEqual(stored);
      expect(ids(listCheckRunsForCandidate(restarted, 'cand-a'))).toEqual([
        'check-old-fail',
        'check-old-other-command',
        'check-old-other-tree',
        'check-old-dated',
        'check-new',
      ]);
      historical.forEach((stored, index) => expect(readBytes(stored.id).equals(bytesBefore[index])).toBe(true));
      // Loading is not recording, and recording is not eligibility. The wrong-tree row loads as the
      // raw record a later policy must reject — this store has no eligibility API at all (see the
      // export list) — while the very same report is refused the moment anyone tries to RECORD it.
      const { id: _historicalId, ...otherTree } = historical[1];
      const error = await refusal(recordCheckRun(restarted, { ...otherTree, id: 'check-new-other-tree' }));
      expect([error.code, error.codeName]).toEqual([-32002, 'CHECK_RUN_TREE_MISMATCH']);
      expect(restarted.checkRuns.has('check-new-other-tree')).toBe(false);
    } finally {
      restarted.clearEmitter();
    }
  });

  // ---------------------------------------------------------------------------
  // output tail — bounded in UTF-8 BYTES, cut on a whole character
  // ---------------------------------------------------------------------------

  /** [label, raw tail, stored tail, U+FFFD count the stored tail may carry — only ever from malformed input] */
  const tails: Array<[string, () => string | undefined, () => string, number]> = [
    ['an absent tail', () => undefined, () => '', 0],
    ['an empty tail', () => '', () => '', 0],
    ['an ASCII tail exactly at the cap', () => 'a'.repeat(MAX), () => 'a'.repeat(MAX), 0],
    ['an ASCII tail one byte over the cap', () => `X${'a'.repeat(MAX)}`, () => 'a'.repeat(MAX), 0],
    ['a two-byte character cut in half', () => `${TWO}${'b'.repeat(MAX - 1)}`, () => 'b'.repeat(MAX - 1), 0],
    ['a three-byte character cut after its first byte', () => `${THREE}${'c'.repeat(MAX - 2)}`, () => 'c'.repeat(MAX - 2), 0],
    ['a three-byte character cut after its second byte', () => `${THREE}${'c'.repeat(MAX - 1)}`, () => 'c'.repeat(MAX - 1), 0],
    ['an emoji cut after its first byte', () => `${FOUR}${'d'.repeat(MAX - 3)}`, () => 'd'.repeat(MAX - 3), 0],
    ['an emoji cut after its third byte', () => `${FOUR}${'d'.repeat(MAX - 1)}`, () => 'd'.repeat(MAX - 1), 0],
    ['a log that fits the cap in characters but not in bytes', () => THREE.repeat(MAX / 2), () => THREE.repeat(5461), 0],
    ['an emoji log cut mid-emoji', () => `${FOUR.repeat(5000)}z`, () => `${FOUR.repeat(4095)}z`, 0],
    ['a lone high surrogate', () => '\uD800ok', () => `${FFFD}ok`, 1],
    ['a lone low surrogate inside a log', () => 'a\uDC00b', () => `a${FFFD}b`, 1],
    ['reversed surrogates', () => '\uDE00\uD83D', () => `${FFFD}${FFFD}`, 2],
    ['a malformed over-cap log cut through its replacement character', () => `\uD800${'e'.repeat(MAX - 1)}`, () => 'e'.repeat(MAX - 1), 0],
    ['a huge multibyte log', () => `${TWO.repeat(4_000_000)}!`, () => `${TWO.repeat(8191)}!`, 0],
  ];

  it.each(tails)('stores %s as its final UTF-8 bytes, starting on a whole character', async (_label, raw, stored, replacements) => {
    const expected = stored();
    const { checkRun } = await record({ id: 'check-1', outputTail: raw() });
    const persisted = readRecord('check-1').outputTail;

    expect(bytesOf(checkRun.outputTail)).toBe(bytesOf(expected));
    expect(bytesOf(persisted)).toBeLessThanOrEqual(MAX_CHECK_LOG_BYTES);
    expect(replacementCount(persisted)).toBe(replacements);
    expect(checkRun.outputTail === expected, 'the returned tail is not the expected suffix').toBe(true);
    expect(persisted === expected, 'the persisted tail is not the expected suffix').toBe(true);
    expect(validateCheckRunParams({ ...base, outputTail: raw() }).outputTail === expected).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // input refusals — validated, never coerced, never written
  // ---------------------------------------------------------------------------

  /** [label, override, codeName, the refusal text after its "[CODENAME] " prefix, up to any rendered value] */
  const malformed: Array<[string, Override, string, string]> = [
    ['an id with a path separator', { id: '../../escaped' }, 'INVALID_INPUT', 'Invalid id: must contain only alphanumeric characters, hyphens, and underscores'],
    ['a null id', { id: null }, 'INVALID_INPUT', 'Invalid id: must be a non-blank string when supplied (got null)'],
    ['a blank id', { id: '   ' }, 'INVALID_INPUT', 'Invalid id: must be a non-blank string when supplied'],
    ['an over-long id', { id: 'c'.repeat(129) }, 'INVALID_INPUT', 'Invalid id: must be 128 characters or fewer'],
    ['a missing candidateId', { candidateId: undefined }, 'MISSING_REQUIRED', 'Missing required field: candidateId'],
    ['a numeric candidateId', { candidateId: 42 }, 'INVALID_INPUT', 'Invalid candidateId: must be a string (got 42)'],
    ['a candidateId with a space', { candidateId: 'cand a' }, 'INVALID_INPUT', 'Invalid candidateId: must contain only alphanumeric characters, hyphens, and underscores'],
    ['a blank runnerId', { runnerId: '' }, 'INVALID_INPUT', 'Invalid runnerId: must be a non-blank string'],
    ['a null runnerId', { runnerId: null }, 'MISSING_REQUIRED', 'Missing required field: runnerId'],
    ['an over-long runnerId', { runnerId: 'r'.repeat(129) }, 'INVALID_INPUT', 'Invalid runnerId: must be 128 characters or fewer'],
    ['a missing treeSha', { treeSha: undefined }, 'MISSING_REQUIRED', 'Missing required field: treeSha'],
    ['a numeric treeSha', { treeSha: 1234567 }, 'INVALID_INPUT', 'Invalid treeSha: must be a string (got 1234567)'],
    ['a 6-character treeSha', { treeSha: 'abc123' }, 'INVALID_INPUT', 'Invalid treeSha: must be 7-40 hexadecimal characters'],
    ['a 41-character treeSha', { treeSha: 'a'.repeat(41) }, 'INVALID_INPUT', 'Invalid treeSha: must be 7-40 hexadecimal characters'],
    ['a non-hex treeSha', { treeSha: 'g'.repeat(40) }, 'INVALID_INPUT', 'Invalid treeSha: must be 7-40 hexadecimal characters'],
    ['a padded treeSha', { treeSha: ` ${SHA.treeA}` }, 'INVALID_INPUT', 'Invalid treeSha: must be 7-40 hexadecimal characters'],
    ['a missing command', { command: undefined }, 'MISSING_REQUIRED', 'Missing required field: command'],
    ['a non-string command', { command: ['node', 'gate.cjs'] }, 'INVALID_INPUT', 'Invalid command: must be a string (got a value of type object)'],
    ['a blank command', { command: ' \t\n' }, 'INVALID_INPUT', 'Invalid command: must be a non-blank string'],
    ['a 501-character command', { command: 'x'.repeat(501) }, 'INVALID_INPUT', 'Invalid command: must be 500 characters or fewer (got 501)'],
    ['a missing exitCode', { exitCode: undefined }, 'MISSING_REQUIRED', 'Missing required field: exitCode'],
    ['a string exitCode', { exitCode: '0' }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got "0")'],
    ['a fractional exitCode', { exitCode: 1.5 }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got 1.5)'],
    ['an unsafe exitCode', { exitCode: 2 ** 53 }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got 9007199254740992)'],
    ['a NaN exitCode', { exitCode: Number.NaN }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got NaN)'],
    ['an infinite exitCode', { exitCode: -Infinity }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got -Infinity)'],
    ['a boolean exitCode', { exitCode: false }, 'INVALID_INPUT', 'Invalid exitCode: must be a safe integer (got false)'],
    ['a missing source', { source: undefined }, 'MISSING_REQUIRED', 'Missing required field: source'],
    ['an unknown source', { source: 'self-certified' }, 'INVALID_INPUT', 'Invalid source: must be one of runner-observed, agent-reported (got "self-certified")'],
    ['a source in another case', { source: 'Runner-Observed' }, 'INVALID_INPUT', 'Invalid source: must be one of runner-observed, agent-reported (got "Runner-Observed")'],
    ['a padded source', { source: 'agent-reported ' }, 'INVALID_INPUT', 'Invalid source: must be one of runner-observed, agent-reported (got "agent-reported ")'],
    ['a numeric outputTail', { outputTail: 42 }, 'INVALID_INPUT', 'Invalid outputTail: must be a string when supplied (got 42)'],
    ['a null outputTail', { outputTail: null }, 'INVALID_INPUT', 'Invalid outputTail: must be a string when supplied (got null)'],
  ];

  it.each(malformed)('refuses %s without writing', async (_label, override, codeName, text) => {
    const params = { ...base, id: 'check-1', ...override };
    const error = await refusal(recordCheckRun(h.state, params as unknown as RecordCheckRunParams));

    expect([error.code, error.codeName]).toEqual([-32602, codeName]);
    expect(error.message.startsWith(`[${codeName}] ${text}`), error.message).toBe(true);
    expect(() => validateCheckRunParams(params)).toThrow(error.message);
    expect(h.state.checkRuns.size).toBe(0);
    expect(checkFiles()).toEqual([]);
    expect(fs.existsSync(path.join(h.testDir, 'escaped.json'))).toBe(false);
  });

  it.each([
    ['a string', 'check'],
    ['null', null],
    ['an array', [base]],
  ])('refuses %s in place of a report object', async (_label, raw) => {
    const error = await refusal(recordCheckRun(h.state, raw as unknown as RecordCheckRunParams));
    expect([error.code, error.codeName]).toEqual([-32602, 'INVALID_INPUT']);
    expect(error.message.startsWith('[INVALID_INPUT] Invalid checkRun: must be an object'), error.message).toBe(true);
    expect(checkFiles()).toEqual([]);
  });
});

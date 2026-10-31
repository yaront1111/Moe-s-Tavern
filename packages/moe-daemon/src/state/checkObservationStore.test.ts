import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { recordCheckRunTool } from '../tools/recordCheckRun.js';
import { getCheckDispatch, getCheckObservation, isAuthenticatedCheckRun, recordCheckDispatch, recordCheckObservation } from './checkObservationStore.js';
import type { RecordCheckDispatchParams, RecordCheckObservationParams } from './checkObservationStore.js';
import { getCheckRun } from './checkRunStore.js';
import { recordCandidate } from './candidateStore.js';
import { openAttempt } from './attemptStore.js';
import { StateManager } from './StateManager.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type CheckRun } from '../types/schema.js';
import type { RunnerIdentity } from '../server/runnerChannel.js';

const SHA = { base: 'a1'.repeat(20), k1: 'c3'.repeat(20), k2: 'd4'.repeat(20), other: 'e5'.repeat(20) };
const [RUNNER, OTHER] = [{ runnerId: 'runner-0123456789abcdef' }, { runnerId: 'runner-fedcba9876543210' }];
const ENV = ' ubuntu-24.04/node-24 '; // verbatim: the spaces are part of the identity
const CMD = 'cd packages/moe-daemon && npm test';
const FOUR = '\u{1F600}'; // one character, two UTF-16 units
const [T1, T2] = ['2099-01-01T01:00:00.000Z', '2099-01-01T02:00:00.000Z']; // after every fixture candidate: currency follows createdAt
type Row = [string, Record<string, unknown>, unknown, string, string?];

describe('checkObservationStore', () => {
  const h = new ToolTestHarness();
  const restarted: StateManager[] = [];
  const cand = (id: string, taskId: string, treeSha: string) =>
    recordCandidate(h.state, { id, attemptId: `attempt-${taskId}`, taskId, treeSha, baseRevision: SHA.base, deliveryTarget: 'refs/heads/moe/work' });

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    for (const id of ['task-1', 'task-2']) h.createTask({ id, status: 'WORKING', assignedWorkerId: 'w', planRevision: 1, approvedPlanRevision: 1 });
    await h.state.load();
    for (const taskId of ['task-1', 'task-2']) await openAttempt(h.state, { id: `attempt-${taskId}`, taskId, workerId: 'w', runnerId: 'r', workspace: taskId });
    await cand('cand-k1', 'task-1', SHA.k1);
    await cand('cand-other', 'task-2', SHA.other);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const state of [h.state, ...restarted.splice(0)]) state.clearEmitter();
    h.cleanup();
  });

  const supersede = () => cand('cand-k2', 'task-1', SHA.k2);
  const setRevisions = (planRevision: number | undefined, approvedPlanRevision: number | undefined) =>
    h.state.tasks.set('task-1', { ...h.state.tasks.get('task-1')!, planRevision, approvedPlanRevision });
  const dispatch = (o: Record<string, unknown> = {}, runner: unknown = RUNNER) => recordCheckDispatch(h.state, runner as RunnerIdentity,
    { id: 'dispatch-1', taskId: 'task-1', candidateId: 'cand-k1', planRevision: 1, command: CMD, environment: ENV, ...o } as RecordCheckDispatchParams);
  const observe = (o: Record<string, unknown> = {}, runner: unknown = RUNNER, state = h.state) => recordCheckObservation(state, runner as RunnerIdentity,
    { id: 'check-obs-1', dispatchId: 'dispatch-1', exitCode: 0, outcome: 'passed', outputTail: 'all green', environment: ENV, ...o } as RecordCheckObservationParams);
  const observed = async (): Promise<CheckRun> => (await dispatch(), (await observe()).checkRun);
  const observedRun = (createdAt: string): CheckRun => ({ id: 'check-obs-1', candidateId: 'cand-k1', treeSha: SHA.k1, command: CMD, exitCode: 0,
    outputTail: 'all green', runnerId: RUNNER.runnerId, source: 'runner-observed', outcome: 'passed', planRevision: 1, environment: ENV, dispatchId: 'dispatch-1', createdAt });
  const checks = (...parts: string[]) => path.join(h.moePath, 'checks', ...parts);
  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(checks(file), 'utf8'));
  /** What a refusal must leave alone: every file under .moe/checks with its bytes, and the check-run ids. */
  const snapshot = () => ({ runs: [...h.state.checkRuns.keys()], files: !fs.existsSync(checks()) ? {} : Object.fromEntries(fs.readdirSync(checks(), { recursive: true, encoding: 'utf8' })
    .filter((f) => fs.statSync(checks(f)).isFile()).map((f) => [f.replaceAll('\\', '/'), fs.readFileSync(checks(f), 'hex')])) });
  const clockAt = (iso: string) => (vi.useFakeTimers({ toFake: ['Date'] }), vi.setSystemTime(new Date(iso)));
  /** [codeName, context.field, context] of the MoeError the call is refused with. */
  async function refused(promise: Promise<unknown>): Promise<[string, unknown, unknown]> {
    const error = await promise.then(() => null, (e: unknown) => e);
    if (!(error instanceof MoeError)) throw new Error(`expected a MoeError refusal, got ${String(error)}`);
    return [error.codeName, (error.context as { field?: unknown } | undefined)?.field, error.context];
  }
  async function restart(): Promise<StateManager> {
    restarted.push(new StateManager({ projectPath: h.testDir }));
    await restarted[restarted.length - 1].load();
    return restarted[restarted.length - 1];
  }

  it('pins the current candidate, its tree, the approved revision and the channel runner, never params', async () => {
    clockAt(T1);
    const result = await dispatch({ checkId: 'daemon.tests', runnerId: OTHER.runnerId, treeSha: SHA.k2 });
    const expected = { id: 'dispatch-1', taskId: 'task-1', candidateId: 'cand-k1', treeSha: SHA.k1, planRevision: 1, command: CMD,
      checkId: 'daemon.tests', environment: ENV, runnerId: RUNNER.runnerId, createdAt: T1 };
    expect([result, Object.keys(result.dispatch)]).toStrictEqual([{ dispatch: expected, duplicate: false }, Object.keys(expected)]);
    expect([readJson('dispatches/dispatch-1.json'), getCheckDispatch(h.state, 'dispatch-1')]).toStrictEqual([expected, expected]);
    const { dispatch: generated } = await dispatch({ id: undefined });
    expect([/^dispatch-[0-9a-f]{32}$/.test(generated.id), 'checkId' in generated]).toEqual([true, false]);
  });

  it.each<Row>([
    ['an unknown task', { taskId: 'task-404' }, RUNNER, 'TASK_NOT_FOUND'],
    ['an unknown candidate', { candidateId: 'cand-ghost' }, RUNNER, 'CANDIDATE_NOT_FOUND'],
    ["another task's candidate", { candidateId: 'cand-other' }, RUNNER, 'CHECK_DISPATCH_TASK_MISMATCH'],
    ['a missing taskId', { taskId: undefined }, RUNNER, 'MISSING_REQUIRED', 'taskId'],
    ['a non-integer revision', { planRevision: 1.5 }, RUNNER, 'INVALID_INPUT', 'planRevision'],
    ['a blank command', { command: ' ' }, RUNNER, 'INVALID_INPUT', 'command'],
    ['a 1001-unit command', { command: 'x'.repeat(1001) }, RUNNER, 'INVALID_INPUT', 'command'],
    ['500 supplementary characters plus one unit', { command: `${FOUR.repeat(500)}x` }, RUNNER, 'INVALID_INPUT', 'command'],
    ['a 1001-unit command padded with whitespace', { command: ` ${'x'.repeat(999)} ` }, RUNNER, 'INVALID_INPUT', 'command'],
    ['a bad checkId', { checkId: '.tests' }, RUNNER, 'INVALID_INPUT', 'checkId'],
    ['a 256-character environment', { environment: 'e'.repeat(256) }, RUNNER, 'INVALID_INPUT', 'environment'],
    ['a control character in the environment', { environment: 'a\tb' }, RUNNER, 'INVALID_INPUT', 'environment'],
    ['a malformed runner', {}, { runnerId: 'runner 1' }, 'INVALID_INPUT', 'runner'],
  ])('dispatch refuses %s and writes nothing', async (_name, override, runner, codeName, field) => {
    const before = snapshot();
    expect((await refused(dispatch(override, runner))).slice(0, 2)).toEqual([codeName, field]);
    expect([snapshot(), getCheckDispatch(h.state, 'dispatch-1')]).toStrictEqual([before, null]);
  });

  it('names the 1000-unit limit when it refuses an over-long command, and writes nothing', async () => {
    const before = snapshot();
    const [, field, context] = await refused(dispatch({ command: 'x'.repeat(1001) }));
    expect([field, (context as { reason: string }).reason]).toEqual(['command', 'must be non-blank and at most 1000 characters']);
    expect(snapshot()).toStrictEqual(before);
  });

  it.each<[string, string, number]>([
    ['500 units', 'x'.repeat(500), 500],
    ['501 units', 'x'.repeat(501), 501],
    ['1000 units', 'x'.repeat(1000), 1000],
    ['1000 units with outer whitespace', ` \t${'x'.repeat(996)}\n `, 1000],
    ['500 supplementary characters (1000 UTF-16 units)', FOUR.repeat(500), 1000],
  ])('records a %s command verbatim and authenticates its observed run', async (_name, command, units) => {
    expect(command.length).toBe(units);
    clockAt(T1);
    const { dispatch: recorded } = await dispatch({ command });
    const { checkRun } = await observe();
    expect([recorded.command, checkRun]).toStrictEqual([command, { ...observedRun(T1), command }]);
    expect([(readJson('dispatches/dispatch-1.json') as { command: string }).command, (readJson('check-obs-1.json') as { command: string }).command])
      .toEqual([command, command]);
    expect([getCheckRun(h.state, 'check-obs-1')?.command, isAuthenticatedCheckRun(h.state, checkRun)]).toEqual([command, true]);
  });

  it('keeps a 1000-unit command exact through replay, a changed-command retry and a fresh StateManager', async () => {
    const command = `  ${FOUR.repeat(498)}x `;
    expect(command.length).toBe(1000);
    clockAt(T1);
    const genuine = (await dispatch({ command }), (await observe()).checkRun);
    const before = snapshot();
    clockAt(T2);
    expect([await dispatch({ command }), await observe(), snapshot()]).toStrictEqual([
      { dispatch: { ...getCheckDispatch(h.state, 'dispatch-1')! }, duplicate: true }, { checkRun: genuine, duplicate: true }, before]);
    expect(await refused(dispatch({ command: command.trimEnd() }))).toEqual(['CHECK_DISPATCH_IMMUTABLE', undefined,
      { dispatchId: 'dispatch-1', differingFields: ['command'] }]);
    expect(snapshot()).toStrictEqual(before);
    const state = await restart();
    expect([getCheckDispatch(state, 'dispatch-1')?.command, getCheckRun(state, genuine.id)?.command, isAuthenticatedCheckRun(state, genuine)])
      .toEqual([command, command, true]);
  });

  it.each([[2, 1, 1], [0, 0, 0], [2, 2, 1], [1, 1, undefined]])('dispatch refuses revision %s at task revision %s approved %s', async (rev, task, approved) => {
    setRevisions(task, approved);
    expect(await refused(dispatch({ planRevision: rev }))).toEqual(['CHECK_DISPATCH_REVISION_MISMATCH', undefined,
      { taskId: 'task-1', planRevision: rev, taskPlanRevision: task, approvedPlanRevision: approved ?? null }]);
    expect(snapshot().files).toEqual({});
  });

  it('refuses a superseded candidate (CHECK_DISPATCH_NOT_CURRENT), replays its identical dispatch, refuses a differing one', async () => {
    clockAt(T1);
    const first = await dispatch();
    const before = snapshot();
    await supersede();
    setRevisions(2, 2);
    clockAt(T2);
    expect([await dispatch(), snapshot()]).toStrictEqual([{ dispatch: first.dispatch, duplicate: true }, before]);
    const differing: Array<[string, Record<string, unknown>, unknown]> = [['command', { command: 'npm run x' }, RUNNER],
      ['environment', { environment: ENV.trim() }, RUNNER], ['checkId', { checkId: 'daemon.tests' }, RUNNER], ['runnerId', {}, OTHER]];
    for (const [field, override, runner] of differing) {
      expect(await refused(dispatch(override, runner))).toEqual(['CHECK_DISPATCH_IMMUTABLE', undefined, { dispatchId: 'dispatch-1', differingFields: [field] }]);
    }
    expect((await refused(dispatch({ id: 'Dispatch-1' })))[0]).toBe('CHECK_DISPATCH_ID_CASE_COLLISION');
    expect(await refused(dispatch({ id: 'dispatch-2', planRevision: 2 }))).toEqual(['CHECK_DISPATCH_NOT_CURRENT', undefined,
      { taskId: 'task-1', candidateId: 'cand-k1', currentCandidateId: 'cand-k2' }]);
    expect(snapshot()).toStrictEqual(before);
    expect((await dispatch({ id: 'dispatch-2', candidateId: 'cand-k2', planRevision: 2 })).dispatch.treeSha).toBe(SHA.k2);
  });

  it('binds the observed run to the dispatch and the channel runner whatever params claim, then writes the marker', async () => {
    await dispatch();
    clockAt(T2);
    const result = await observe({ candidateId: 'cand-other', treeSha: SHA.other, command: 'true', planRevision: 9, runnerId: OTHER.runnerId, source: 'agent-reported' });
    const marker = { id: 'dispatch-1', checkRunId: 'check-obs-1', runnerId: RUNNER.runnerId, createdAt: T2 };
    expect(result).toStrictEqual({ checkRun: observedRun(T2), duplicate: false });
    expect([readJson('check-obs-1.json'), readJson('observations/dispatch-1.json'), getCheckObservation(h.state, 'dispatch-1')]).toStrictEqual([observedRun(T2), marker, marker]);
    expect(isAuthenticatedCheckRun(h.state, result.checkRun)).toBe(true);
  });

  it.each(['runner-observed', 'agent-reported'])('never authenticates a record_check_run run (source %s) copying the runner, dispatch and binding', async (source) => {
    await dispatch();
    const tool = recordCheckRunTool(h.state);
    const { createdAt: _createdAt, ...args } = observedRun(T1);
    const forged = (await h.state.runExclusive(() => tool.handler({ ...args, id: 'check-forged', source }, h.state)) as { checkRun: CheckRun }).checkRun;
    expect(isAuthenticatedCheckRun(h.state, forged)).toBe(false);
    const genuine = (await observe()).checkRun;
    expect([isAuthenticatedCheckRun(h.state, genuine), isAuthenticatedCheckRun(h.state, getCheckRun(h.state, 'check-forged')!)]).toEqual([true, false]);
  });

  it('judges the STORED run: a changed caller-built copy, an unstored run or malformed input fails closed', async () => {
    const genuine = await observed();
    for (const change of [{ outputTail: 'forged' }, { exitCode: 7, outcome: 'code-failure' }, { attemptId: 'attempt-task-1' }, { id: 'check-absent' }]) {
      expect(isAuthenticatedCheckRun(h.state, { ...genuine, ...change } as CheckRun)).toBe(false);
    }
    const hostile = Object.defineProperty({}, 'id', { get: () => { throw new Error('boom'); } });
    for (const input of [null, 42, 'check-obs-1', {}, hostile]) expect(isAuthenticatedCheckRun(h.state, input as unknown as CheckRun)).toBe(false);
    expect(isAuthenticatedCheckRun(h.state, { ...genuine })).toBe(true);
    h.state.checkRuns.delete(genuine.id);
    expect(isAuthenticatedCheckRun(h.state, genuine)).toBe(false);
  });

  it.each(Object.entries({ candidateId: 'cand-other', treeSha: SHA.other, command: 'true', planRevision: 2, environment: ENV.trim(),
    runnerId: OTHER.runnerId, source: 'agent-reported', dispatchId: 'dispatch-2' }))('fails closed when the stored run\'s %s leaves its dispatch', async (field, value) => {
    const altered = { ...(await observed()), [field]: value } as CheckRun;
    h.state.checkRuns.set(altered.id, altered);
    expect(isAuthenticatedCheckRun(h.state, altered)).toBe(false);
  });

  it.each(['dispatches', 'observations'])('fails closed after a restart that finds no %s record', async (kind) => {
    const genuine = await observed();
    fs.rmSync(checks(kind, 'dispatch-1.json'));
    const state = await restart();
    expect([getCheckRun(state, genuine.id), isAuthenticatedCheckRun(state, genuine)]).toStrictEqual([genuine, false]);
  });

  it('replays an identical observation, refuses a differing one (CHECK_RUN_IMMUTABLE) and a second one per dispatch', async () => {
    clockAt(T1);
    await observed();
    const before = snapshot();
    clockAt(T2);
    expect([await observe(), snapshot()]).toStrictEqual([{ checkRun: observedRun(T1), duplicate: true }, before]);
    const differing: Array<[Record<string, unknown>, string[]]> = [[{ exitCode: 1, outcome: 'code-failure' }, ['exitCode', 'outcome']], [{ outputTail: 'x' }, ['outputTail']]];
    for (const [override, differingFields] of differing) {
      expect(await refused(observe(override))).toEqual(['CHECK_RUN_IMMUTABLE', undefined, { checkRunId: 'check-obs-1', differingFields }]);
    }
    expect(await refused(observe({ id: 'check-obs-2', exitCode: 1, outcome: 'code-failure' }))).toEqual(['CHECK_DISPATCH_ALREADY_OBSERVED', undefined,
      { dispatchId: 'dispatch-1', checkRunId: 'check-obs-1', requestedId: 'check-obs-2' }]);
    expect(snapshot()).toStrictEqual(before);
  });

  it.each<Row>([
    ['an unrecorded dispatch', { dispatchId: 'dispatch-ghost' }, RUNNER, 'CHECK_DISPATCH_NOT_FOUND'],
    ['another runner', {}, OTHER, 'CHECK_RUNNER_MISMATCH'],
    ['another environment', { environment: ENV.trim() }, RUNNER, 'CHECK_ENVIRONMENT_MISMATCH'],
    ['a missing outcome', { outcome: undefined }, RUNNER, 'MISSING_REQUIRED', 'outcome'],
    ['passed with exit 1', { exitCode: 1 }, RUNNER, 'INVALID_INPUT', 'outcome'],
    ['a missing id', { id: undefined }, RUNNER, 'MISSING_REQUIRED', 'id'],
    ['a null runner', {}, null, 'INVALID_INPUT', 'runner'],
  ])('observation refuses %s and writes nothing', async (_name, override, runner, codeName, field) => {
    await dispatch();
    const before = snapshot();
    expect((await refused(observe(override, runner))).slice(0, 2)).toEqual([codeName, field]);
    expect([snapshot(), getCheckObservation(h.state, 'dispatch-1')]).toStrictEqual([before, null]);
  });

  it('answers a superseded dispatch against its own candidate and revision, never the current ones', async () => {
    await dispatch();
    await supersede();
    setRevisions(2, 2);
    const { checkRun } = await observe();
    expect([checkRun.candidateId, checkRun.treeSha, checkRun.planRevision, isAuthenticatedCheckRun(h.state, checkRun)]).toEqual(['cand-k1', SHA.k1, 1, true]);
  });

  it('reloads dispatches and markers in a fresh StateManager, never as check runs, with their rules intact', async () => {
    const genuine = await observed();
    await dispatch({ id: 'dispatch-open' });
    const state = await restart();
    expect([state.checkRuns.size, getCheckDispatch(state, 'dispatch-open'), getCheckObservation(state, 'dispatch-1'), isAuthenticatedCheckRun(state, genuine)])
      .toStrictEqual([1, getCheckDispatch(h.state, 'dispatch-open'), getCheckObservation(h.state, 'dispatch-1'), true]);
    expect((await refused(observe({ id: 'check-obs-2' }, RUNNER, state)))[0]).toBe('CHECK_DISPATCH_ALREADY_OBSERVED');
    expect(isAuthenticatedCheckRun(state, (await observe({ id: 'check-open', dispatchId: 'dispatch-open' }, RUNNER, state)).checkRun)).toBe(true);
  });

  it('a failed write publishes nothing, and the identical retry after a crash before the marker completes it', async () => {
    const realWrite = h.state.writeEntity.bind(h.state);
    const failOnce = new Set(['checks/dispatches', 'checks/observations']);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (!failOnce.delete(args[0])) return realWrite(...args);
      throw new Error(`EIO: ${args[0]}`);
    });
    await expect(dispatch()).rejects.toThrow('EIO: checks/dispatches');
    expect(getCheckDispatch(h.state, 'dispatch-1')).toBeNull();
    await dispatch();
    await expect(observe()).rejects.toThrow('EIO: checks/observations');
    const run = getCheckRun(h.state, 'check-obs-1')!;
    expect([run.dispatchId, getCheckObservation(h.state, 'dispatch-1'), isAuthenticatedCheckRun(h.state, run)]).toEqual(['dispatch-1', null, false]);
    expect(await observe()).toStrictEqual({ checkRun: run, duplicate: true });
    expect([readJson('observations/dispatch-1.json'), isAuthenticatedCheckRun(h.state, run)]).toEqual([getCheckObservation(h.state, 'dispatch-1'), true]);
  });
});

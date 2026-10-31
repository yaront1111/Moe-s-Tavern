import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { getTools, TOOL_AUDIENCE, type ToolCallContext } from './index.js';
import { recordCheckDispatchTool } from './recordCheckDispatch.js';
import { recordCheckObservationTool } from './recordCheckObservation.js';
import { recordCheckRunTool } from './recordCheckRun.js';
import { getCheckDispatch, isAuthenticatedCheckRun } from '../state/checkObservationStore.js';
import { recordCandidate } from '../state/candidateStore.js';
import { openAttempt } from '../state/attemptStore.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { MoeWebSocketServer } from '../server/WebSocketServer.js';
import { RUNNER_KEY_HEADER, ensureRunnerKey } from '../server/runnerChannel.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { CURRENT_SCHEMA_VERSION, type CheckDispatch, type CheckRun } from '../types/schema.js';

const SHA = { base: 'a1'.repeat(20), k1: 'c3'.repeat(20), k2: 'd4'.repeat(20) };
const RUNNER = { runnerId: 'runner-0123456789abcdef' };
const ENV = 'ubuntu-24.04/node-24';
const CMD = 'cd packages/moe-daemon && npm test';
const DISPATCH = { id: 'dispatch-1', taskId: 'task-1', candidateId: 'cand-k1', planRevision: 1, command: CMD, environment: ENV };
const OBSERVATION = { id: 'check-obs-1', dispatchId: 'dispatch-1', exitCode: 0, outcome: 'passed', outputTail: 'all green', environment: ENV };
type Ctx = ToolCallContext | undefined;

describe('moe.record_check_dispatch and moe.record_check_observation', () => {
  const h = new ToolTestHarness();
  let keyDir: string;
  let previousKeyDir: string | undefined;

  beforeEach(async () => {
    previousKeyDir = process.env.MOE_RUNNER_KEY_DIR;
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-runner-keys-'));
    process.env.MOE_RUNNER_KEY_DIR = keyDir;
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'w', planRevision: 1, approvedPlanRevision: 1 });
    await h.state.load();
    await openAttempt(h.state, { id: 'attempt-1', taskId: 'task-1', workerId: 'w', runnerId: 'r', workspace: 'task-1' });
    await cand('cand-k1', SHA.k1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
    if (previousKeyDir === undefined) delete process.env.MOE_RUNNER_KEY_DIR;
    else process.env.MOE_RUNNER_KEY_DIR = previousKeyDir;
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  const cand = (id: string, treeSha: string) =>
    recordCandidate(h.state, { id, attemptId: 'attempt-1', taskId: 'task-1', treeSha, baseRevision: SHA.base, deliveryTarget: 'refs/heads/moe/work' });
  /** The /runner context unless one is passed; an explicit undefined stays undefined (the /mcp path). */
  const contextOf = (context: [Ctx?]): Ctx => (context.length > 0 ? context[0] : { runner: RUNNER });
  const dispatch = (args: unknown = DISPATCH, ...context: [Ctx?]) =>
    recordCheckDispatchTool(h.state).handler(args, h.state, contextOf(context)) as Promise<{ success: true; dispatch: CheckDispatch; duplicate: boolean }>;
  const observe = (args: unknown = OBSERVATION, ...context: [Ctx?]) =>
    recordCheckObservationTool(h.state).handler(args, h.state, contextOf(context)) as Promise<{ success: true; checkRun: CheckRun; duplicate: boolean }>;
  const checks = (...parts: string[]) => path.join(h.moePath, 'checks', ...parts);
  /** Every file under .moe/checks with its bytes, plus the check-run ids: what a refusal must leave alone. */
  const snapshot = () => ({ runs: [...h.state.checkRuns.keys()], files: !fs.existsSync(checks()) ? {} : Object.fromEntries(
    fs.readdirSync(checks(), { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(checks(f)).isFile())
      .map((f) => [f.replaceAll('\\', '/'), fs.readFileSync(checks(f), 'hex')])) });
  /** [code, codeName, context.field] of the MoeError the call is refused with. */
  async function refused(promise: Promise<unknown>): Promise<[number, string, unknown]> {
    const error = await promise.then(() => null, (e: unknown) => e);
    if (!(error instanceof MoeError)) throw new Error(`expected a MoeError refusal, got ${String(error)}`);
    return [error.code, error.codeName, (error.context as { field?: unknown } | undefined)?.field];
  }
  const CHANNEL_REQUIRED = [MoeErrorCode.NOT_ALLOWED, 'RUNNER_CHANNEL_REQUIRED', undefined];

  describe('T1 runner channel', () => {
    it.each([['no context', undefined], ['a context without runner', {}]])('refuses both tools with %s, writing nothing', async (_label, context) => {
      await dispatch();
      const before = snapshot();
      const forged = { ...OBSERVATION, runnerId: RUNNER.runnerId, source: 'runner-observed' };
      expect(await refused(dispatch({ ...DISPATCH, id: 'dispatch-2', runnerId: RUNNER.runnerId }, context))).toEqual(CHANNEL_REQUIRED);
      expect(await refused(observe(forged, context))).toEqual(CHANNEL_REQUIRED);
      expect(await refused(observe(OBSERVATION, context))).toEqual(CHANNEL_REQUIRED);
      expect(snapshot()).toStrictEqual(before);
    });

    it('checks the channel before validating anything', async () => {
      expect(await refused(dispatch(null, undefined))).toEqual(CHANNEL_REQUIRED);
      expect(await refused(observe('not-an-object', undefined))).toEqual(CHANNEL_REQUIRED);
      expect(fs.existsSync(checks())).toBe(false);
    });
  });

  describe('T2 forged identity and binding arguments', () => {
    it.each([['runnerId', RUNNER.runnerId], ['source', 'runner-observed'], ['treeSha', SHA.k1]])('refuses a dispatch carrying %s by name', async (key, value) => {
      expect(await refused(dispatch({ ...DISPATCH, [key]: value }))).toEqual([MoeErrorCode.INVALID_INPUT, 'INVALID_INPUT', key]);
      expect(fs.existsSync(checks())).toBe(false);
    });

    it.each([['runnerId', RUNNER.runnerId], ['source', 'runner-observed'], ['candidateId', 'cand-k1'], ['treeSha', SHA.k1],
      ['command', CMD], ['planRevision', 1]])('refuses an observation carrying %s by name', async (key, value) => {
      await dispatch();
      const before = snapshot();
      expect(await refused(observe({ ...OBSERVATION, [key]: value }))).toEqual([MoeErrorCode.INVALID_INPUT, 'INVALID_INPUT', key]);
      expect(snapshot()).toStrictEqual(before);
    });

    it.each([[null], [[]], ['text']])('refuses non-object arguments %j', async (args) => {
      expect((await refused(dispatch(args)))[1]).toBe('INVALID_INPUT');
      expect((await refused(observe(args)))[1]).toBe('INVALID_INPUT');
    });

    it('accepts and ignores workerId, which is not evidence', async () => {
      const { dispatch: stored } = await dispatch({ ...DISPATCH, workerId: 'worker-x' });
      const { checkRun } = await observe({ ...OBSERVATION, workerId: 'worker-x' });
      expect([JSON.stringify(stored).includes('worker-x'), JSON.stringify(checkRun).includes('worker-x')]).toEqual([false, false]);
    });
  });

  describe('T3 record_check_run stays diagnostic', () => {
    it('never authenticates a reported run, even one naming the channel runner and a recorded dispatch', async () => {
      const { dispatch: stored } = await dispatch();
      expect(stored.runnerId).toBe(RUNNER.runnerId);
      const { checkRun: reported } = await recordCheckRunTool(h.state).handler({ id: 'check-reported', candidateId: 'cand-k1', treeSha: SHA.k1,
        command: CMD, exitCode: 0, outcome: 'passed', runnerId: RUNNER.runnerId, source: 'runner-observed', planRevision: 1, environment: ENV,
        dispatchId: 'dispatch-1' }, h.state, { runner: RUNNER }) as { checkRun: CheckRun };
      expect(isAuthenticatedCheckRun(h.state, reported)).toBe(false);
      const { checkRun, duplicate } = await observe();
      expect([checkRun.runnerId, checkRun.source, checkRun.candidateId, checkRun.treeSha, checkRun.command, checkRun.planRevision,
        checkRun.environment, checkRun.dispatchId, duplicate])
        .toEqual([RUNNER.runnerId, 'runner-observed', 'cand-k1', SHA.k1, CMD, 1, ENV, 'dispatch-1', false]);
      expect([isAuthenticatedCheckRun(h.state, checkRun), isAuthenticatedCheckRun(h.state, reported)]).toEqual([true, false]);
    });
  });

  describe('T4 duplicates', () => {
    it('replays an identical observation without a write and refuses a conflicting or second one', async () => {
      await dispatch();
      const first = await observe();
      const before = snapshot();
      expect(await observe()).toStrictEqual({ ...first, duplicate: true });
      expect(snapshot()).toStrictEqual(before);
      expect((await refused(observe({ ...OBSERVATION, exitCode: 1, outcome: 'code-failure' })))[1]).toBe('CHECK_RUN_IMMUTABLE');
      expect((await refused(observe({ ...OBSERVATION, id: 'check-obs-2' })))[1]).toBe('CHECK_DISPATCH_ALREADY_OBSERVED');
      expect(snapshot()).toStrictEqual(before);
    });

    it('replays an identical dispatch and refuses a differing one with the same id', async () => {
      const first = await dispatch();
      const before = snapshot();
      expect(await dispatch()).toStrictEqual({ ...first, duplicate: true });
      expect((await refused(dispatch({ ...DISPATCH, command: 'npm run lint' })))[1]).toBe('CHECK_DISPATCH_IMMUTABLE');
      expect(snapshot()).toStrictEqual(before);
    });
  });

  describe('T5 superseded and unrecorded dispatches', () => {
    it('answers a superseded dispatch against its own binding and never retargets it', async () => {
      await dispatch();
      await cand('cand-k2', SHA.k2);
      h.state.tasks.set('task-1', { ...h.state.tasks.get('task-1')!, planRevision: 2, approvedPlanRevision: 2 });
      const { checkRun } = await observe();
      expect([checkRun.candidateId, checkRun.treeSha, checkRun.planRevision, isAuthenticatedCheckRun(h.state, checkRun)])
        .toEqual(['cand-k1', SHA.k1, 1, true]);
      expect((await refused(dispatch({ ...DISPATCH, id: 'dispatch-2', planRevision: 2 })))[1]).toBe('CHECK_DISPATCH_NOT_CURRENT');
      expect(getCheckDispatch(h.state, 'dispatch-2')).toBeNull();
    });

    it('refuses an observation for an unrecorded dispatch', async () => {
      expect((await refused(observe({ ...OBSERVATION, dispatchId: 'dispatch-unknown' })))[1]).toBe('CHECK_DISPATCH_NOT_FOUND');
      expect(fs.existsSync(checks())).toBe(false);
    });
  });

  describe('T6 over a real WebSocket', () => {
    type Rpc = { result?: { content: { text: string }[] }; error?: { code: number; data?: { codeName?: string } } };
    let httpServer: Server;
    let wsServer: MoeWebSocketServer;
    let port: number;
    let key: string;
    let sockets: WebSocket[];

    beforeEach(async () => {
      sockets = [];
      for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(logger, level).mockImplementation(() => undefined);
      key = fs.readFileSync(await ensureRunnerKey(h.state.projectPath), 'utf8');
      httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      port = (httpServer.address() as { port: number }).port;
      wsServer = new MoeWebSocketServer(httpServer, h.state, new McpAdapter(h.state));
    });

    afterEach(async () => {
      for (const ws of sockets) ws.terminate();
      await wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const within = <T>(promise: Promise<T>, what: string) => Promise.race([promise, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 3000))]);
    async function connect(endpoint: string, headers?: Record<string, string>) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, headers ? { headers } : undefined);
      sockets.push(ws);
      await within(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), `${endpoint} open`);
      let id = 0;
      return (name: string, args: unknown) => within(new Promise<Rpc>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString()) as Rpc));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }));
      }), name);
    }
    const resultOf = <T>(rpc: Rpc) => JSON.parse(rpc.result!.content[0].text) as T;
    const channelRefusal = (rpc: Rpc) => [rpc.result, rpc.error?.code, rpc.error?.data?.codeName];

    it('records an authenticated run over /runner with the key-derived runner identity', async () => {
      const call = await connect('/runner', { [RUNNER_KEY_HEADER]: key });
      const runnerId = `runner-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
      const { dispatch: stored } = resultOf<{ dispatch: CheckDispatch }>(await call('moe.record_check_dispatch', DISPATCH));
      const { checkRun } = resultOf<{ checkRun: CheckRun }>(await call('moe.record_check_observation', OBSERVATION));
      expect([stored.runnerId, checkRun.runnerId, checkRun.treeSha]).toEqual([runnerId, runnerId, SHA.k1]);
      expect(isAuthenticatedCheckRun(h.state, h.state.checkRuns.get('check-obs-1')!)).toBe(true);
    });

    it('refuses the same calls over /mcp, even with the key header, and writes nothing', async () => {
      const call = await connect('/mcp', { [RUNNER_KEY_HEADER]: key });
      const refusal = [undefined, MoeErrorCode.NOT_ALLOWED, 'RUNNER_CHANNEL_REQUIRED'];
      expect(channelRefusal(await call('moe.record_check_dispatch', DISPATCH))).toEqual(refusal);
      expect(channelRefusal(await call('moe.record_check_observation', { ...OBSERVATION, runnerId: 'runner-forged' }))).toEqual(refusal);
      expect([fs.existsSync(checks()), h.state.checkRuns.size]).toEqual([false, 0]);
    });
  });

  it('T7 registers both tools, non-blocking and hidden from agent roles', () => {
    const tools = new Map(getTools(h.state).map((tool) => [tool.name, tool]));
    for (const name of ['moe.record_check_dispatch', 'moe.record_check_observation']) {
      expect([tools.get(name)?.name, tools.get(name)?.blocking, TOOL_AUDIENCE[name]]).toEqual([name, undefined, 'wrapper']);
      expect(tools.get(name)?.inputSchema.additionalProperties).toBe(false);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';
import { injectWorkerType, resolveToolCallName } from './utils.js';

type Frame = Record<string, unknown>;
type Reply = { id: number; error?: { code: number; data?: unknown } };

/** A tools/call frame; `args` omitted means no `arguments` key at all. */
const toolCall = (name: unknown, ...args: [unknown?]): Frame => ({
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: args.length > 0 ? { name, arguments: args[0] } : { name },
});
const argsOf = (frame: Frame) => (frame.params as { arguments: Frame }).arguments;

/** Assert the helper leaves `frame` exactly as it was and says so. */
function expectUntouched(frame: unknown, ...env: [string?]) {
  const before = structuredClone(frame);
  expect(injectWorkerType(frame, env.length > 0 ? env[0] : 'CODEX')).toBe(false);
  expect(frame).toEqual(before);
}

const registrationNames = [
  'moe.claim_next_task', 'moe_claim_next_task', 'claim_next_task', 'moe.join_team', 'moe_join_team', 'join_team',
];

describe('injectWorkerType', () => {
  it.each(registrationNames)('adds workerType to %s, with and without a workerId', (name) => {
    const named = toolCall(name, { workerId: 'worker-w', teamId: 'team-1' });
    expect(injectWorkerType(named, 'CODEX')).toBe(true);
    expect(named).toEqual({ ...toolCall(name), params: { name, arguments: { workerId: 'worker-w', teamId: 'team-1', workerType: 'CODEX' } } });
    const anonymous = toolCall(name, { statuses: ['WORKING'] });
    expect(injectWorkerType(anonymous, 'GROK')).toBe(true);
    expect(argsOf(anonymous)).toEqual({ statuses: ['WORKING'], workerType: 'GROK' });
  });

  it.each(['moe_claim_next_task', 'moe_join_team'])('still adds workerType to %s once alias resolution renames it', (name) => {
    const frame = toolCall(name, { workerId: 'worker-w' });
    expect(resolveToolCallName(frame, new Map())).toBe(true);
    const dotted = name.replace('moe_', 'moe.');
    expect(injectWorkerType(frame, 'CODEX')).toBe(true);
    expect(frame.params).toEqual({ name: dotted, arguments: { workerId: 'worker-w', workerType: 'CODEX' } });
  });

  it.each(['GEMINI', 'codex', '', null, 0, undefined])('leaves a caller-owned workerType %j alone', (own) => {
    const frame = toolCall('moe.claim_next_task', { workerId: 'w', workerType: own });
    expectUntouched(frame);
    expect('workerType' in argsOf(frame)).toBe(true);
  });

  it.each([undefined, '', ' ', '\t\n', 42 as unknown as string])('adds nothing for the blank or non-string env %j', (env) => {
    expectUntouched(toolCall('moe.claim_next_task', { workerId: 'w' }), env);
  });

  it.each(['codex', ' Codex ', 'CURSOR', 'claude-code', ' CODEX', 'CODEX\n'])('sends %j verbatim, with no trim, re-case or allowlist', (env) => {
    const frame = toolCall('moe.join_team', { teamId: 't', workerId: 'w' });
    expect(injectWorkerType(frame, env)).toBe(true);
    expect(argsOf(frame).workerType).toBe(env);
  });

  it.each([undefined, {}, { workerId: 'w' }])('never touches tools/list (params %j)', (params) => {
    const frame: Frame = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    if (params !== undefined) frame.params = params;
    expectUntouched(frame);
    expect('params' in frame).toBe(params !== undefined);
  });

  it.each([
    'moe.get_context', 'moe.start_step', 'moe.complete_task', 'moe.wait_for_task', 'moe.chat_who', 'moe.list_workers',
    'moe.heartbeat', 'moe.reattach_attempt', 'serena_find_symbol', 'moe.claim_next_task_extra', 'MOE.JOIN_TEAM', 'join_teams',
  ])('never touches %s', (name) => expectUntouched(toolCall(name, { workerId: 'w' })));

  it.each([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { name: 'moe.claim_next_task', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ])('never touches %j', (frame) => expectUntouched(frame));

  // Rows are wrapped: it.each spreads an array row into separate arguments.
  it.each([null, undefined, 42, 'str', true, [], [toolCall('moe.claim_next_task', { workerId: 'w' })]].map((message) => [message]))(
    'returns false for the message %j, a batch included', (message) => expectUntouched(message));

  it.each([
    { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'bad' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: { workerId: 'w' } } },
    toolCall(42, { workerId: 'w' }),
    toolCall('moe.claim_next_task'),
    toolCall('moe.claim_next_task', null),
    toolCall('moe.claim_next_task', []),
    toolCall('moe.join_team', 'x'),
  ])('returns false and changes nothing for the malformed call %j', (frame) => expectUntouched(frame));

  it('returns false instead of throwing for frozen arguments and a hostile message', () => {
    const frozen = toolCall('moe.claim_next_task', Object.freeze({ workerId: 'w' }));
    expectUntouched(frozen);
    expect(injectWorkerType(new Proxy({}, { get() { throw new Error('boom'); } }), 'CODEX')).toBe(false);
  });
});

// --- Real proxy against an ephemeral WebSocket "daemon" -----------------------

/** Python json.dumps spacing, as scripts/moe-agent.sh's moe_rpc writes its frames. */
const pyJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${pyJson(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
};
const wire = (id: number, name: string, args: unknown) => pyJson({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const paramsOf = (frame: string | undefined) => (JSON.parse(frame ?? 'null') as { params: unknown }).params;

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

/** True if `done` settles within `ms`; the timer never outlives the wait. */
async function settlesWithin(ms: number, done: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([done.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A proxy whose server vanished keeps reconnecting for minutes, so end stdin, then SIGKILL. */
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  if (await settlesWithin(3000, exited)) return;
  child.kill('SIGKILL');
  await settlesWithin(2000, exited);
}

/** Resolve on the daemon-side connection; reject on an early child exit or after 5 s. */
function connected(server: WebSocketServer, child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      server.off('connection', onConnect);
      if (error) reject(error); else resolve();
    };
    const onExit = (code: number | null, signal: string | null) => settle(new Error(`proxy exited early (code ${code}, signal ${signal}): ${stderr()}`));
    const onConnect = () => settle();
    const timer = setTimeout(() => settle(new Error(`proxy never connected: ${stderr()}`)), 5000);
    child.once('exit', onExit);
    server.once('connection', onConnect);
  });
}

async function startProxy(env: Record<string, string>) {
  const cleanups: Array<() => unknown> = [];
  const close = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch { /* keep draining */ }
    }
  };
  open.push(close);
  const frames: string[] = [];
  const lines: string[] = [];
  let stderr = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-worker-type-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on('connection', (ws) => ws.on('message', (data) => {
    const text = data.toString();
    frames.push(text);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(text) as { id: number }).id, result: { content: [{ type: 'text', text: 'ok' }] } }));
  }));
  await once(server, 'listening');
  fs.mkdirSync(path.join(dir, '.moe'));
  fs.writeFileSync(path.join(dir, '.moe', 'daemon.json'), JSON.stringify({
    port: (server.address() as AddressInfo).port, pid: process.pid, startedAt: new Date().toISOString(), projectPath: dir,
  }));
  const child = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
    env: { ...process.env, MOE_PROJECT_PATH: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanups.push(() => stopChild(child));
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdout.setEncoding('utf8');
  let pending = '';
  child.stdout.on('data', (chunk: string) => {
    const parts = (pending + chunk).split('\n');
    pending = parts.pop() ?? '';
    lines.push(...parts);
  });
  await connected(server, child, () => stderr);
  return {
    frames,
    send: (...requests: string[]) => child.stdin.write(requests.map((request) => `${request}\n`).join('')),
    waitForFrames: (count: number) => vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(count), { timeout: 5000 }),
    reply: (id: number) => vi.waitFor(() => {
      const replies = lines.map((line) => JSON.parse(line) as Reply);
      expect(replies.some((reply) => reply.id === id)).toBe(true);
      return replies.find((reply) => reply.id === id) as Reply;
    }, { timeout: 5000 }),
  };
}

describe('worker type on the wire', () => {
  it('type-only mutation reaches the wire', async () => {
    const run = await startProxy({ MOE_WORKER_ID: 'worker-w', MOE_WORKER_TYPE: 'CODEX' });
    const sent = [
      wire(1, 'moe.join_team', { teamId: 'team-1', workerId: 'worker-w' }),
      wire(2, 'moe.claim_next_task', { statuses: ['WORKING'], workerId: 'worker-w' }),
      wire(3, 'moe.claim_next_task', { statuses: ['WORKING'], workerId: 'worker-w', workerType: 'GEMINI' }),
      wire(4, 'moe.list_workers', { workerId: 'worker-w' }),
    ];
    run.send(...sent);
    await run.waitForFrames(4);
    expect(paramsOf(run.frames[0])).toEqual({ name: 'moe.join_team', arguments: { teamId: 'team-1', workerId: 'worker-w', workerType: 'CODEX' } });
    expect(paramsOf(run.frames[1])).toEqual({ name: 'moe.claim_next_task', arguments: { statuses: ['WORKING'], workerId: 'worker-w', workerType: 'CODEX' } });
    expect(run.frames.slice(2)).toEqual(sent.slice(2));
  }, 20000);

  it('keeps workerId, runner and execution identity semantics', async () => {
    const run = await startProxy({
      MOE_WORKER_ID: 'architect-t', MOE_WORKER_TYPE: 'GROK', MOE_RUNNER_PROCESS_STARTED_AT: '4242@1337', MOE_RUNNER_HOST: 'build-box',
      MOE_SESSION_ID: 'architect-t@2026-10-27T00:00:00Z', MOE_ATTEMPT_ID: 'attempt-0123', MOE_ATTEMPT_GENERATION: '3', MOE_TOOL_NAME_STYLE: 'underscore',
    });
    run.send(
      wire(1, 'moe_claim_next_task', { statuses: ['PLANNING'] }),
      wire(2, 'moe_join_team', { teamId: 'team-1' }),
      wire(3, 'moe.get_context', { taskId: 'task-1' }),
      wire(4, 'moe.start_step', { taskId: 'task-1', stepId: 'step-1', attemptId: 'attempt-other' }),
      pyJson({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    );
    await run.waitForFrames(4);
    expect(run.frames.map((frame) => { const { method, params } = JSON.parse(frame) as Frame; return { method, params }; })).toEqual([
      { method: 'tools/call', params: { name: 'moe.claim_next_task', arguments: { statuses: ['PLANNING'], workerId: 'architect-t', processStartedAt: '4242@1337', host: 'build-box', workerType: 'GROK' } } },
      { method: 'tools/call', params: { name: 'moe.join_team', arguments: { teamId: 'team-1', workerId: 'architect-t', workerType: 'GROK' } } },
      { method: 'tools/call', params: { name: 'moe.get_context', arguments: { taskId: 'task-1', workerId: 'architect-t', sessionId: 'architect-t@2026-10-27T00:00:00Z' } } },
      { method: 'tools/list', params: { workerId: 'architect-t' } },
    ]);
    expect((await run.reply(4)).error).toMatchObject({ code: -32003, data: { tool: 'moe.start_step', codeName: 'EXECUTION_IDENTITY_SUBSTITUTED' } });
  }, 20000);

  it('forwards a nonblank value verbatim', async () => {
    const run = await startProxy({ MOE_WORKER_TYPE: ' codex ' });
    run.send(wire(1, 'moe.claim_next_task', { workerId: 'w' }));
    await run.waitForFrames(1);
    expect(paramsOf(run.frames[0])).toEqual({ name: 'moe.claim_next_task', arguments: { workerId: 'w', workerType: ' codex ' } });
  }, 20000);

  it.each(['', ' \t '])('treats the blank value %j as unset', async (blank) => {
    const run = await startProxy({ MOE_WORKER_TYPE: blank });
    const line = wire(1, 'moe.claim_next_task', { workerId: 'w' });
    run.send(line);
    await run.waitForFrames(1);
    expect(run.frames).toEqual([line]);
  }, 20000);
});

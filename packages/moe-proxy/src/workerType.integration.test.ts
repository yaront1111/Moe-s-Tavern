import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import type { AddressInfo } from 'net';
import path from 'path';
import { pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';

// End to end: a launcher's MOE_WORKER_TYPE -> the built proxy -> the daemon's
// real McpAdapter and StateManager on a temp project. vitest.config.ts blanks
// every inherited MOE_* identity, so each launch carries only its seat's env.
type Json = Record<string, unknown>;
type Seat = { type: string; currentTaskId: string | null; teamId: string | null };
interface DaemonState {
  load(): Promise<void>;
  createTeam(input: { name: string }): Promise<{ id: string }>;
  getWorker(id: string): Seat | undefined;
  tasks: Map<string, { assignedWorkerId: string | null }>;
}
interface Harness {
  testDir: string; moePath: string; state: DaemonState;
  init(): void; cleanup(): void; setupMoeFolder(): unknown; createEpic(): unknown; createTask(overrides: Json): unknown;
}
type Reply = { id: number; result?: { content?: Array<{ text?: string }> }; error?: unknown };

const TYPES = ['CLAUDE', 'CODEX', 'GEMINI', 'GROK'];
const SEAT = 'worker-seat';
const daemonSrc = path.resolve(__dirname, '../../moe-daemon/src');
// A computed specifier: a literal one would pull daemon source into this package's tsc build.
const daemon = async (file: string) => (await import(pathToFileURL(path.join(daemonSrc, file)).href)) as Json;

let ToolTestHarness: new () => Harness;
let McpAdapter: new (state: DaemonState) => { handle(request: unknown): Promise<unknown> };
const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL, MOE_ACCOUNTS_FILE: process.env.MOE_ACCOUNTS_FILE };
let h: Harness | undefined;
let server: WebSocketServer | undefined;
let teamId = '';

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.MOE_ACCOUNTS_FILE = path.join(__dirname, 'no-such-accounts.json'); // never the developer's list
  ToolTestHarness = (await daemon('tools/toolTestHarness.ts')).ToolTestHarness as typeof ToolTestHarness;
  McpAdapter = (await daemon('server/McpAdapter.ts')).McpAdapter as typeof McpAdapter;
}, 60000);
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeEach(async () => {
  h = new ToolTestHarness();
  h.init();
  h.setupMoeFolder();
  h.createEpic();
  h.createTask({ status: 'PLANNING' });
  await h.state.load();
  teamId = (await h.state.createTeam({ name: 'Workers' })).id;
  const adapter = new McpAdapter(h.state);
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (ws) => {
    let queue = Promise.resolve(); // one connection's frames in arrival order, as the daemon serves them
    ws.on('message', (data) => {
      queue = queue.then(async () => {
        const response = await adapter.handle(JSON.parse(data.toString()));
        if (response) ws.send(JSON.stringify(response));
      }).catch((error: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error) } })));
    });
  });
  await once(server, 'listening');
  fs.writeFileSync(path.join(h.moePath, 'daemon.json'), JSON.stringify({
    port: (server.address() as AddressInfo).port, pid: process.pid, startedAt: new Date().toISOString(), projectPath: h.testDir,
  }));
});
afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) {
    for (const client of closing.clients) client.terminate();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  h?.cleanup();
  h = undefined;
});

/** End stdin like the wrapper's one-shot RPC; SIGKILL if the proxy outlives 3 s. */
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited.finally(() => clearTimeout(timer));
}

/** One seat launch: the given calls through a fresh proxy; any error or malformed reply fails the test. */
async function launch(env: Record<string, string>, calls: Array<[string, Json]>): Promise<Json[]> {
  const child = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
    env: { ...process.env, MOE_PROJECT_PATH: h!.testDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  try {
    child.stdin.write(calls.map(([name, args], i) =>
      `${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } })}\n`).join(''));
    const lines = await vi.waitFor(() => {
      const done = stdout.split('\n').filter(Boolean);
      expect(done.length, `proxy exit ${child.exitCode}; stderr: ${stderr}`).toBe(calls.length);
      return done;
    }, { timeout: 10000 });
    const replies = new Map(lines.map((line) => { const reply = JSON.parse(line) as Reply; return [reply.id, reply]; }));
    return calls.map(([name], i) => {
      const reply = replies.get(i + 1);
      expect(reply?.error, name).toBeUndefined();
      const text = reply?.result?.content?.[0]?.text;
      expect(typeof text, `${name} reply text`).toBe('string');
      return JSON.parse(text as string) as Json;
    });
  } finally {
    await stopChild(child);
  }
}

// The wrapper's pre-flight calls name their workerId and never a workerType.
const join = (prefix = 'moe.'): [string, Json] => [`${prefix}join_team`, { teamId, workerId: SEAT }];
const claim = (prefix = 'moe.'): [string, Json] => [`${prefix}claim_next_task`, { statuses: ['PLANNING'], workerId: SEAT }];
const recorded = (type: string) => {
  const seat = h!.state.getWorker(SEAT);
  const disk = JSON.parse(fs.readFileSync(path.join(h!.moePath, 'workers', `${SEAT}.json`), 'utf8')) as Seat;
  expect({ type: seat?.type, disk: disk.type, task: seat?.currentTaskId, team: seat?.teamId })
    .toEqual({ type, disk: type, task: 'task-1', team: teamId });
  expect(h!.state.tasks.get('task-1')?.assignedWorkerId).toBe(SEAT);
};

describe('launcher worker type through the proxy into the daemon', () => {
  it.each(TYPES)('a %s seat registers its type, and list_workers and chat_who show it', async (type) => {
    // Grok's config pins the underscore tool names; the proxy maps them back.
    const prefix = type === 'GROK' ? 'moe_' : 'moe.';
    const env: Record<string, string> = type === 'GROK' ? { MOE_WORKER_TYPE: type, MOE_TOOL_NAME_STYLE: 'underscore' } : { MOE_WORKER_TYPE: type };
    const [joined, claimed] = await launch(env, [join(prefix), claim(prefix)]);
    expect(joined).toMatchObject({ team: { memberIds: [SEAT] } });
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-1' } });
    recorded(type);
    const [listed, who] = await launch({}, [['moe.list_workers', {}], ['moe.chat_who', {}]]);
    expect(listed.workers).toEqual([expect.objectContaining({ workerId: SEAT, type })]);
    expect(who.online).toEqual([expect.objectContaining({ workerId: SEAT, type })]);
  }, 30000);

  it('a relaunch under another CLI refreshes the type and keeps the task and the team', async () => {
    await launch({ MOE_WORKER_TYPE: 'CODEX' }, [join(), claim()]);
    recorded('CODEX');
    const [held] = await launch({ MOE_WORKER_TYPE: 'GEMINI' }, [claim()]);
    expect(held).toMatchObject({ hasNext: false, alreadyAssigned: { taskId: 'task-1' } });
    recorded('GEMINI');
    const [rejoined] = await launch({ MOE_WORKER_TYPE: 'GROK' }, [join()]);
    expect(rejoined).toMatchObject({ team: { memberIds: [SEAT] } });
    recorded('GROK');
    // A launcher that reports no type (an older wrapper) leaves the recorded one alone.
    await launch({}, [join(), claim()]);
    recorded('GROK');
  }, 30000);

  it.each([
    ['absent', {}],
    ['lowercase', { MOE_WORKER_TYPE: 'codex' }],
    ['unknown', { MOE_WORKER_TYPE: 'OPENAI' }],
  ])('a new seat whose launcher type is %s registers as CLAUDE and still claims', async (_label, env: Record<string, string>) => {
    const [joined, claimed] = await launch(env, [join(), claim()]);
    expect(joined).toMatchObject({ team: { memberIds: [SEAT] } });
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-1' } });
    recorded('CLAUDE');
  }, 30000);
});

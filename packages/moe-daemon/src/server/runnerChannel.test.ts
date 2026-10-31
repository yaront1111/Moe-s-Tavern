import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import { createHash } from 'crypto';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RUNNER_KEY_HEADER, authenticateRunner, ensureRunnerKey, runnerKeyPath } from './runnerChannel.js';
import { McpAdapter } from './McpAdapter.js';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { logger } from '../util/logger.js';
import type { ToolCallContext } from '../tools/index.js';

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PROJECT = '/projects/runner-channel-test';
const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');
const keyFile = (projectPath: string) => `${sha256hex(projectPath).slice(0, 32)}.key`;
const posixIt = process.platform === 'win32' ? it.skip : it;

let keyDir: string;
let previousKeyDir: string | undefined;

beforeEach(() => {
  previousKeyDir = process.env.MOE_RUNNER_KEY_DIR;
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-runner-keys-'));
  process.env.MOE_RUNNER_KEY_DIR = keyDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousKeyDir === undefined) delete process.env.MOE_RUNNER_KEY_DIR;
  else process.env.MOE_RUNNER_KEY_DIR = previousKeyDir;
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe('K1 runnerKeyPath', () => {
  it('names the project hash inside MOE_RUNNER_KEY_DIR', () => {
    expect(runnerKeyPath(PROJECT)).toBe(path.join(keyDir, keyFile(PROJECT)));
  });

  it('resolves a relative MOE_RUNNER_KEY_DIR to an absolute directory', () => {
    process.env.MOE_RUNNER_KEY_DIR = 'rel/keys';
    expect(runnerKeyPath(PROJECT)).toBe(path.join(path.resolve('rel/keys'), keyFile(PROJECT)));
  });

  it.each([undefined, '', '   '])('defaults to ~/.moe/runner-keys when the env is %j', (value) => {
    if (value === undefined) delete process.env.MOE_RUNNER_KEY_DIR;
    else process.env.MOE_RUNNER_KEY_DIR = value;
    expect(runnerKeyPath(PROJECT)).toBe(path.join(os.homedir(), '.moe', 'runner-keys', keyFile(PROJECT)));
  });
});

describe('K2 ensureRunnerKey', () => {
  const tmpFiles = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

  it('creates a 43-character base64url key with no newline and leaves no temp file', async () => {
    const file = await ensureRunnerKey(PROJECT);
    expect(file).toBe(runnerKeyPath(PROJECT));
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toMatch(KEY_RE);
    expect(content.length).toBe(43);
    expect(tmpFiles(keyDir)).toEqual([]);
  });

  posixIt('writes the key 0600 inside a 0700 directory it creates or tightens', async () => {
    process.env.MOE_RUNNER_KEY_DIR = path.join(keyDir, 'nested');
    const file = await ensureRunnerKey(PROJECT);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    fs.chmodSync(path.dirname(file), 0o755);
    fs.chmodSync(file, 0o644);
    await ensureRunnerKey(PROJECT);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('reuses a valid key byte for byte', async () => {
    const file = await ensureRunnerKey(PROJECT);
    const first = fs.readFileSync(file, 'utf8');
    expect(await ensureRunnerKey(PROJECT)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('replaces a malformed key file with a valid key', async () => {
    const file = runnerKeyPath(PROJECT);
    fs.writeFileSync(file, 'short\n');
    await ensureRunnerKey(PROJECT);
    expect(fs.readFileSync(file, 'utf8')).toMatch(KEY_RE);
    expect(tmpFiles(keyDir)).toEqual([]);
  });

  // POSIX only: win32 rename over a file another call is renaming can fail EPERM.
  posixIt('leaves one valid key when two calls race', async () => {
    const [a, b] = await Promise.all([ensureRunnerKey(PROJECT), ensureRunnerKey(PROJECT)]);
    expect(a).toBe(b);
    expect(fs.readFileSync(a, 'utf8')).toMatch(KEY_RE);
    expect(tmpFiles(keyDir)).toEqual([]);
  });

  it('removes a partially written temp file and rethrows the write error', async () => {
    const realWrite = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (target) => {
      await realWrite(target as string, 'partial', { mode: 0o600 });
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    await expect(ensureRunnerKey(PROJECT)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fs.readdirSync(keyDir)).toEqual([]);
  });

  it('removes the temp file and rethrows when the rename fails', async () => {
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(ensureRunnerKey(PROJECT)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.readdirSync(keyDir)).toEqual([]);
  });
});

describe('A1 authenticateRunner', () => {
  let key: string;
  const request = (remoteAddress: string | undefined, values?: string[]) => ({
    socket: { remoteAddress },
    headersDistinct: values === undefined ? {} : { [RUNNER_KEY_HEADER]: values },
  }) as unknown as IncomingMessage;

  beforeEach(async () => {
    key = fs.readFileSync(await ensureRunnerKey(PROJECT), 'utf8');
  });

  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])(
    'returns the key-derived identity from loopback %s', (remote) => {
      expect(authenticateRunner(request(remote, [key]), PROJECT)).toEqual({ runnerId: `runner-${sha256hex(key).slice(0, 16)}` });
    });

  it('refuses an absent header', () => {
    expect(authenticateRunner(request('127.0.0.1'), PROJECT)).toBeNull();
  });
  it('refuses a different well-formed key', () => {
    const other = `${key[0] === 'A' ? 'B' : 'A'}${key.slice(1)}`;
    expect(authenticateRunner(request('127.0.0.1', [other]), PROJECT)).toBeNull();
  });
  it.each([
    ['a 42-character key', (k: string) => k.slice(0, 42)],
    ['= padding', (k: string) => `${k.slice(0, 42)}=`],
    ['inner whitespace', (k: string) => `${k.slice(0, 20)} ${k.slice(21)}`],
  ])('refuses %s', (_name, malform) => {
    expect(authenticateRunner(request('127.0.0.1', [malform(key)]), PROJECT)).toBeNull();
  });
  it('refuses two header values even when both are the key', () => {
    expect(authenticateRunner(request('127.0.0.1', [key, key]), PROJECT)).toBeNull();
  });
  it.each(['10.0.0.5', '::ffff:10.0.0.5', '128.0.0.1', undefined])('refuses remote address %j', (remote) => {
    expect(authenticateRunner(request(remote, [key]), PROJECT)).toBeNull();
  });
  it('refuses when the key file is missing', () => {
    fs.rmSync(runnerKeyPath(PROJECT));
    expect(authenticateRunner(request('127.0.0.1', [key]), PROJECT)).toBeNull();
  });
  it('refuses when the key file is malformed', () => {
    fs.writeFileSync(runnerKeyPath(PROJECT), `${key}\n`);
    expect(authenticateRunner(request('127.0.0.1', [key]), PROJECT)).toBeNull();
  });
  it('returns null without throwing for a request with no socket', () => {
    const bare = { headersDistinct: { [RUNNER_KEY_HEADER]: [key] } } as unknown as IncomingMessage;
    expect(authenticateRunner(bare, PROJECT)).toBeNull();
  });
});

describe('runner identity over McpAdapter and /runner', () => {
  let projectDir: string;
  let state: StateManager;
  let adapter: McpAdapter;
  let probe: ReturnType<typeof vi.fn>;

  const probeCall = (args: Record<string, unknown> = {}) =>
    ({ jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'moe.runner_probe', arguments: args } });
  const probeResult = (response: unknown) =>
    JSON.parse((response as { result: { content: { text: string }[] } }).result.content[0].text) as { runner: unknown };

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-runner-project-'));
    for (const dir of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(projectDir, '.moe', dir), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.moe', 'project.json'), JSON.stringify({
      id: 'proj-runner', name: 'Runner', rootPath: projectDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    state = new StateManager({ projectPath: projectDir });
    await state.load();
    adapter = new McpAdapter(state);
    probe = vi.fn(async (_args: unknown, _state: unknown, context?: ToolCallContext) => ({ runner: context?.runner ?? null }));
    (adapter as unknown as { tools: Map<string, unknown> }).tools.set('moe.runner_probe', {
      name: 'moe.runner_probe', description: 'test probe', inputSchema: { type: 'object' }, handler: probe,
    });
  });

  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  describe('M1 McpAdapter', () => {
    it('forwards options.runner unchanged into the tool context', async () => {
      const response = await adapter.handle(probeCall(), { runner: { runnerId: 'runner-x' } });
      expect(probeResult(response)).toEqual({ runner: { runnerId: 'runner-x' } });
    });

    it('never reads a runner identity from arguments', async () => {
      const response = await adapter.handle(probeCall({ runnerId: 'forged', source: 'runner-observed', runner: { runnerId: 'forged' } }));
      expect(probeResult(response)).toEqual({ runner: null });
    });
  });

  describe('W1 WebSocketServer /runner', () => {
    let httpServer: Server;
    let wsServer: MoeWebSocketServer;
    let port: number;
    let key: string;
    let sockets: WebSocket[];
    let logSpies: ReturnType<typeof vi.spyOn>[];

    beforeEach(async () => {
      sockets = [];
      logSpies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)
        .map((level) => vi.spyOn(logger, level).mockImplementation(() => undefined));
      key = fs.readFileSync(await ensureRunnerKey(projectDir), 'utf8');
      httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      port = (httpServer.address() as { port: number }).port;
      wsServer = new MoeWebSocketServer(httpServer, state, adapter);
    });

    afterEach(async () => {
      for (const ws of sockets) ws.terminate();
      await wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      expect(JSON.stringify(logSpies.map((spy) => spy.mock.calls))).not.toContain(key);
      vi.restoreAllMocks();
    });

    const open = (endpoint: string, headers?: Record<string, string | string[]>) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, headers ? { headers } : undefined);
      sockets.push(ws);
      return ws;
    };
    const within = <T>(promise: Promise<T>, what: string) => Promise.race([promise, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 3000))]);
    const refused = (ws: WebSocket) => within(new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('open', () => { try { ws.send(JSON.stringify(probeCall())); } catch { /* closing */ } });
      ws.on('error', () => undefined);
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    }), 'close');
    const firstMessage = (ws: WebSocket, payload?: unknown) => within(new Promise<string>((resolve) => {
      if (payload !== undefined) ws.on('open', () => ws.send(JSON.stringify(payload)));
      ws.on('message', (data) => resolve(data.toString()));
    }), 'message');
    const expectRefused = async (ws: WebSocket) => {
      expect(await refused(ws)).toEqual({ code: 1008, reason: 'runner authentication failed' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(probe).not.toHaveBeenCalled();
    };

    it('closes a connection with no key header', async () => {
      await expectRefused(open('/runner'));
      expect(logger.warn).toHaveBeenCalledWith({ endpoint: 'runner', remoteAddress: '127.0.0.1' }, 'Runner channel authentication failed');
    });
    it('closes a connection with a wrong key', async () => {
      await expectRefused(open('/runner', { [RUNNER_KEY_HEADER]: `${key[0] === 'A' ? 'B' : 'A'}${key.slice(1)}` }));
    });
    it('closes a connection with a malformed key', async () => {
      await expectRefused(open('/runner', { [RUNNER_KEY_HEADER]: key.slice(0, 42) }));
    });
    it('closes a connection that repeats the key header', async () => {
      await expectRefused(open('/runner', { [RUNNER_KEY_HEADER]: [key, key] }));
    });
    it('closes a connection from a non-loopback address', async () => {
      httpServer.prependListener('upgrade', (req: IncomingMessage) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '10.0.0.5', configurable: true });
      });
      await expectRefused(open('/runner', { [RUNNER_KEY_HEADER]: key }));
    });
    it('closes a connection when the key file is missing', async () => {
      fs.rmSync(runnerKeyPath(projectDir));
      await expectRefused(open('/runner', { [RUNNER_KEY_HEADER]: key }));
    });

    it('serves MCP with the key-derived runner identity', async () => {
      const ws = open('/runner?client=test', { [RUNNER_KEY_HEADER]: key });
      const text = await firstMessage(ws, probeCall({ runnerId: 'forged' }));
      expect(probeResult(JSON.parse(text))).toEqual({ runner: { runnerId: `runner-${sha256hex(key).slice(0, 16)}` } });
      expect(text).not.toContain(key);
    });
    it('never gives /mcp a runner identity, even with the header and identity arguments', async () => {
      const ws = open('/mcp', { [RUNNER_KEY_HEADER]: key });
      const text = await firstMessage(ws, probeCall({ runnerId: 'forged', source: 'runner-observed' }));
      expect(probeResult(JSON.parse(text))).toEqual({ runner: null });
    });
    it('treats /runnerx as a plugin connection, not a runner', async () => {
      const ws = open('/runnerx', { [RUNNER_KEY_HEADER]: key });
      expect(JSON.parse(await firstMessage(ws)).type).toBe('STATE_SNAPSHOT');
    });
  });
});

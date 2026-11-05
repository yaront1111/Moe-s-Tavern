import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';

import net, { type AddressInfo } from 'node:net';
import { callTool, postEvent, findDaemonInfo, DaemonError } from '../src/daemonClient.js';

function makeProjectWithDaemon(port: number): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-test-'));
  const moeDir = path.join(tmp, '.moe');
  fs.mkdirSync(moeDir, { recursive: true });
  fs.writeFileSync(
    path.join(moeDir, 'daemon.json'),
    JSON.stringify({
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: tmp,
    })
  );
  return tmp;
}

// moe-agent exports MOE_DAEMON_HOST (the Windows host address) to WSL seats.
// Clear it so the loopback fixtures never dial that address.
beforeEach(() => { vi.stubEnv('MOE_DAEMON_HOST', undefined); });
afterEach(() => { vi.unstubAllEnvs(); });

function makeProjectWithDaemonFields(port: number, extra: Record<string, unknown>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-host-'));
  fs.mkdirSync(path.join(tmp, '.moe'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.moe', 'daemon.json'), JSON.stringify({
    port, pid: process.pid, startedAt: new Date().toISOString(), projectPath: tmp, ...extra,
  }));
  return tmp;
}

describe('connect host', () => {
  it('uses a non-blank MOE_DAEMON_HOST instead of loopback', () => {
    vi.stubEnv('MOE_DAEMON_HOST', '172.26.208.1');
    const projectPath = makeProjectWithDaemonFields(54321, { bindHost: 'wsl' });
    expect(findDaemonInfo({ projectPath }).host).toBe('172.26.208.1');
    vi.stubEnv('MOE_DAEMON_HOST', ' 172.26.208.1 ');
    expect(findDaemonInfo({ projectPath }).host).toBe('172.26.208.1');
    vi.stubEnv('MOE_DAEMON_HOST', '   ');
    const paddedHost = makeProjectWithDaemonFields(54321, { host: ' 10.1.2.3 ' });
    expect(findDaemonInfo({ projectPath: paddedHost }).host).toBe('10.1.2.3');
    const blankHost = makeProjectWithDaemonFields(54321, { host: '   ', bindHost: 'wsl' });
    expect(findDaemonInfo({ projectPath: blankHost }).host).toBe('127.0.0.1');
  });

  it('puts MOE_DAEMON_HOST ahead of the legacy host', () => {
    vi.stubEnv('MOE_DAEMON_HOST', '172.26.208.1');
    const projectPath = makeProjectWithDaemonFields(54321, { host: '10.1.2.3' });
    expect(findDaemonInfo({ projectPath }).host).toBe('172.26.208.1');
  });

  it('falls back to the legacy host with an unset or whitespace env', () => {
    const projectPath = makeProjectWithDaemonFields(54321, { host: '10.1.2.3' });
    expect(findDaemonInfo({ projectPath }).host).toBe('10.1.2.3');
    vi.stubEnv('MOE_DAEMON_HOST', '   ');
    expect(findDaemonInfo({ projectPath }).host).toBe('10.1.2.3');
  });

  it('never dials bindHost, even when it looks like an address', () => {
    vi.stubEnv('MOE_DAEMON_HOST', '');
    for (const bindHost of ['wsl', '192.0.2.7']) {
      const projectPath = makeProjectWithDaemonFields(54321, { bindHost });
      expect(findDaemonInfo({ projectPath }).host).toBe('127.0.0.1');
    }
  });
});

const ALT_LOOPBACK = '127.0.0.2';

async function canListenOn(host: string): Promise<boolean> {
  const probe = net.createServer();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      probe.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRNOTAVAIL') resolve(false);
        else reject(err);
      });
      probe.listen(0, host, () => resolve(true));
    });
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

const altLoopbackBindable = await canListenOn(ALT_LOOPBACK);

describe.skipIf(!altLoopbackBindable)('MOE_DAEMON_HOST end to end (WSL agent mode)', () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  let frames: Array<{ url: string | undefined; text: string }>;

  beforeEach(async () => {
    frames = [];
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      ws.on('message', (data) => {
        const text = data.toString();
        frames.push({ url: req.url, text });
        if (req.url === '/mcp') {
          const request = JSON.parse(text) as { id: number };
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, ALT_LOOPBACK, resolve);
    });
    port = (server.address() as AddressInfo).port;
    vi.stubEnv('MOE_DAEMON_HOST', ALT_LOOPBACK);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('routes callTool and postEvent to the WSL host override', async () => {
    const projectPath = makeProjectWithDaemonFields(port, { bindHost: 'wsl' });
    await expect(callTool('moe.list_tasks', {}, { projectPath, timeoutMs: 2000 }))
      .resolves.toEqual({ ok: true });
    const event = { type: 'AGENT_TOOL_EVENT', payload: { tool: 'moe.list_tasks' } };
    await postEvent(event, { projectPath, timeoutMs: 2000 });
    await vi.waitFor(() => expect(frames.some((f) => f.url === '/ws')).toBe(true), { timeout: 1000 });
    expect(frames.filter((f) => f.url === '/mcp')).toHaveLength(1);
    expect(JSON.parse(frames.find((f) => f.url === '/ws')!.text)).toEqual(event);
  });
});

describe('findDaemonInfo', () => {
  it('throws DAEMON_NOT_FOUND when no daemon.json exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-empty-'));
    expect(() => findDaemonInfo({ projectPath: tmp })).toThrow(DaemonError);
    try {
      findDaemonInfo({ projectPath: tmp });
    } catch (err) {
      expect((err as DaemonError).code).toBe('DAEMON_NOT_FOUND');
      expect((err as DaemonError).message).toMatch(/daemon not running/i);
    }
  });

  it('returns parsed info when daemon.json exists', () => {
    const project = makeProjectWithDaemon(54321);
    const info = findDaemonInfo({ projectPath: project });
    expect(info.port).toBe(54321);
    expect(info.projectPath).toBe(project);
  });

  it('rejects daemon.json with invalid port', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-bad-'));
    const moeDir = path.join(tmp, '.moe');
    fs.mkdirSync(moeDir, { recursive: true });
    fs.writeFileSync(
      path.join(moeDir, 'daemon.json'),
      JSON.stringify({ port: 'nope', projectPath: tmp, startedAt: 'x' })
    );
    expect(() => findDaemonInfo({ projectPath: tmp })).toThrow(/not running/i);
  });

  function errorCode(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonError);
      return (err as DaemonError).code;
    }
    return undefined;
  }

  it('throws DAEMON_PROJECT_MISMATCH for a daemon.json naming another project, never walking on to a parent', () => {
    const parent = makeProjectWithDaemon(54321);
    const child = path.join(parent, 'sub');
    fs.mkdirSync(path.join(child, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(child, '.moe', 'daemon.json'), JSON.stringify({
      port: 54322, pid: 1, startedAt: 'now', projectPath: path.join(os.tmpdir(), 'another-moe-project'),
    }));
    expect(errorCode(() => findDaemonInfo({ projectPath: child }))).toBe('DAEMON_PROJECT_MISMATCH');
  });

  it('accepts a daemon.json naming its own directory in another spelling', () => {
    const project = makeProjectWithDaemonFields(54321, {});
    const file = path.join(project, '.moe', 'daemon.json');
    const respelled = `${project}${path.sep}.${path.sep}`;
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), projectPath: respelled }));
    expect(findDaemonInfo({ projectPath: project })).toMatchObject({ port: 54321, projectPath: respelled });
  });
});

describe('daemon identity on send', () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  let served: string | undefined;
  let frames: string[];

  beforeEach(async () => {
    frames = [];
    served = undefined;
    // Like the daemon: /health names the served project, any other GET is 426.
    server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(426);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', projectPath: served }));
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        frames.push(data.toString());
        const request = JSON.parse(data.toString()) as { id?: number };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses callTool and postEvent when /health names another project, sending nothing', async () => {
    const project = makeProjectWithDaemon(port);
    served = path.join(os.tmpdir(), 'another-moe-project');
    await expect(callTool('moe.list_tasks', {}, { projectPath: project }))
      .rejects.toMatchObject({ code: 'DAEMON_PROJECT_MISMATCH' });
    await expect(postEvent({ type: 'AGENT_TOOL_EVENT', payload: {} }, { projectPath: project }))
      .rejects.toMatchObject({ code: 'DAEMON_PROJECT_MISMATCH' });
    expect(frames).toEqual([]);
  });

  it.each([
    ['names this project', (project: string) => project],
    ['names no project (an older daemon)', () => undefined],
  ])('sends when /health %s', async (_label, servedFor) => {
    const project = makeProjectWithDaemon(port);
    served = servedFor(project);
    await expect(callTool('moe.list_tasks', {}, { projectPath: project })).resolves.toEqual({ ok: true });
    expect(frames).toHaveLength(1);
  });
});

describe('daemon.json size cap', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Valid daemon.json JSON padded with trailing spaces to an exact byte length.
  function makeProjectWithDaemonBytes(bytes: number): { project: string; file: string } {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-cap-'));
    tmpDirs.push(project);
    const moeDir = path.join(project, '.moe');
    fs.mkdirSync(moeDir, { recursive: true });
    const json = JSON.stringify({ port: 4321, pid: 7, startedAt: 'now', projectPath: project });
    const text = json + ' '.repeat(bytes - Buffer.byteLength(json));
    expect(Buffer.byteLength(text)).toBe(bytes);
    const file = path.join(moeDir, 'daemon.json');
    fs.writeFileSync(file, text);
    return { project, file };
  }

  function notFoundCode(project: string): string | undefined {
    try {
      findDaemonInfo({ projectPath: project });
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonError);
      return (err as DaemonError).code;
    }
    return undefined;
  }

  it('accepts a 65536-byte daemon.json', () => {
    const { project } = makeProjectWithDaemonBytes(65536);
    expect(findDaemonInfo({ projectPath: project })).toEqual({
      port: 4321,
      pid: 7,
      startedAt: 'now',
      projectPath: project,
      host: '127.0.0.1',
    });
  });

  it('treats a 65537-byte daemon.json as not found', () => {
    const { project } = makeProjectWithDaemonBytes(65537);
    expect(notFoundCode(project)).toBe('DAEMON_NOT_FOUND');
  });

  it('reads exactly 65537 bytes of an 8 MiB daemon.json through one closed descriptor', () => {
    const { project, file } = makeProjectWithDaemonBytes(8 * 1024 * 1024);
    const readFile = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');
    const read = vi.spyOn(fs, 'readSync');
    const close = vi.spyOn(fs, 'closeSync');

    expect(notFoundCode(project)).toBe('DAEMON_NOT_FOUND');

    expect(readFile.mock.calls.filter((c) => c[0] === file)).toHaveLength(0);
    const opened = open.mock.calls.map((c, i) => ({ c, fd: open.mock.results[i].value as number }))
      .filter((o) => o.c[0] === file);
    expect(opened).toHaveLength(1);
    const fd = opened[0].fd;
    const total = read.mock.calls.reduce(
      (sum, c, i) => (c[0] === fd ? sum + (read.mock.results[i].value as number) : sum),
      0
    );
    expect(total).toBe(65537);
    expect(close.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
  });

  it('closes the descriptor and stays not-found when the read throws', () => {
    const { project, file } = makeProjectWithDaemonBytes(200);
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });

    expect(notFoundCode(project)).toBe('DAEMON_NOT_FOUND');

    const fds = open.mock.calls
      .map((c, i) => ({ c, fd: open.mock.results[i].value as number }))
      .filter((o) => o.c[0] === file)
      .map((o) => o.fd);
    expect(fds).toHaveLength(1);
    expect(close.mock.calls.filter((c) => c[0] === fds[0])).toHaveLength(1);
  });
});

describe('callTool', () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  let lastRequest: unknown;

  beforeEach(async () => {
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const raw = data.toString();
        try {
          const req = JSON.parse(raw) as { id?: number; method?: string };
          lastRequest = req;
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id ?? null,
              result: { ok: true, echoed: req.method },
            })
          );
        } catch {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad json' } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('forwards a tools/call request and returns the result', async () => {
    const project = makeProjectWithDaemon(port);
    const result = await callTool('moe.list_tasks', { status: ['WORKING'] }, { projectPath: project });
    expect(result).toEqual({ ok: true, echoed: 'tools/call' });
    expect((lastRequest as { method?: string } | undefined)?.method).toBe('tools/call');
    expect(
      (lastRequest as { params?: { name?: string } } | undefined)?.params?.name
    ).toBe('moe.list_tasks');
  });

  it('times out cleanly when the port has no listener', async () => {
    // 1 is reserved/never listens.
    const project = makeProjectWithDaemon(1);
    await expect(
      callTool('moe.list_tasks', {}, { projectPath: project, timeoutMs: 250 })
    ).rejects.toMatchObject({ name: 'DaemonError' });
  });

  it('surfaces a clear error when daemon.json is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-none-'));
    await expect(callTool('moe.list_tasks', {}, { projectPath: tmp })).rejects.toThrow(/daemon not running/i);
  });
});

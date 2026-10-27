import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';

import { callTool, findDaemonInfo, DaemonError } from '../src/daemonClient.js';

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

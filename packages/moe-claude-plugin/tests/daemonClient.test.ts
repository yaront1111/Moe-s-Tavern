import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

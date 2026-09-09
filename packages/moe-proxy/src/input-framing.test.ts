import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';

interface RpcResponse {
  id: number | null;
  result?: { ok: boolean };
  error?: { message: string };
}

describe('moe-proxy stdin framing', () => {
  let testDir: string;
  let server: WebSocketServer;
  let proxy: ChildProcessWithoutNullStreams;
  let responses: RpcResponse[];
  let receivedIds: number[];

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-framing-'));
    fs.mkdirSync(path.join(testDir, '.moe'));
    server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify({
      port: (server.address() as { port: number }).port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: testDir,
    }));
    responses = [];
    receivedIds = [];
    server.on('connection', ws => ws.on('message', data => {
      const request = JSON.parse(data.toString()) as { id: number };
      receivedIds.push(request.id);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));
    }));
    const connected = once(server, 'connection');
    proxy = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        responses.push(JSON.parse(stdout.slice(0, newline)) as RpcResponse);
        stdout = stdout.slice(newline + 1);
      }
    });
    proxy.stderr.resume();
    await connected;
  });

  afterEach(async () => {
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
      const exited = once(proxy, 'exit');
      proxy.kill();
      await exited;
    }
    if (server) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const request = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });

  it('discards the rest of an overflowing frame through its newline', async () => {
    const prefix = '{"jsonrpc":"2.0","id":1,"blob":"';
    // Exactly one byte over the limit ensures overflow happens in the last
    // input chunk, leaving the following write as the rejected frame's tail.
    proxy.stdin.write(prefix + 'x'.repeat(2 * 1024 * 1024 + 1 - prefix.length));
    await vi.waitFor(() => expect(responses.find(r => r.id === 1)?.error?.message ?? '')
      .toContain('overflow'), { timeout: 5000 });

    proxy.stdin.write(request(2) + '\n' + request(3) + '\n');
    await vi.waitFor(() => expect(responses.find(r => r.id === 3)?.result).toEqual({ ok: true }));

    expect(receivedIds).toEqual([3]);
    expect(responses.map(r => r.id)).toEqual([1, 3]);
  });

  it('enforces the line limit in UTF-8 bytes for non-ASCII requests', async () => {
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping', blob: '漢'.repeat(400000) });
    expect(oversized.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(1024 * 1024);
    proxy.stdin.write(oversized + '\n' + request(5) + '\n');
    await vi.waitFor(() => expect(responses.find(r => r.id === 5)?.result).toEqual({ ok: true }));

    expect(responses.find(r => r.id === 4)?.error?.message ?? '').toContain('too large');
    expect(receivedIds).toEqual([5]);
  });

  it('bounds an unterminated non-ASCII frame in UTF-8 bytes', async () => {
    const prefix = '{"jsonrpc":"2.0","id":6,"blob":"';
    const partial = prefix + '漢'.repeat(700000);
    expect(partial.length).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(partial, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
    proxy.stdin.write(partial);

    await vi.waitFor(() => expect(responses.find(r => r.id === 6)?.error?.message ?? '')
      .toContain('overflow'), { timeout: 3000 });
    proxy.stdin.write('\n' + request(7) + '\n');
    await vi.waitFor(() => expect(responses.find(r => r.id === 7)?.result).toEqual({ ok: true }));
    expect(receivedIds).toEqual([7]);
    expect(responses.map(r => r.id)).toEqual([6, 7]);
  });
});

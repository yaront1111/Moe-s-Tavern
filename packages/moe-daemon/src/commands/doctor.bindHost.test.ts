// Rows B1-B5 for doctor's daemon.json bindHost mapping (task-576e3005).
// doctor must dial the address the daemon's own daemon.json probes dial, and name it in every message.
// Imports only runDoctor, so the file runs unchanged against a tree that predates the fix (the RED run).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import dns from 'dns';
import { runDoctor } from './doctor.js';

function scaffoldMoe(projectPath: string): string {
  const moePath = path.join(projectPath, '.moe');
  fs.mkdirSync(path.join(moePath, 'roles'), { recursive: true });
  for (const f of ['architect.md', 'worker.md', 'qa.md', 'governor.md']) fs.writeFileSync(path.join(moePath, 'roles', f), '# role');
  fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
  for (const name of ['general', 'workers', 'architects', 'qa', 'governors']) {
    fs.writeFileSync(path.join(moePath, 'channels', `${name}.json`), JSON.stringify({ name }));
  }
  return moePath;
}

// A daemon started with --host ::1 listens there only. Probe once whether this machine has IPv6 loopback.
async function canListen(host: string): Promise<boolean> {
  const probe = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, resolve); });
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
const HAS_V6_LOOPBACK = await canListen('::1');

const OFF = '192.0.2.10'; // RFC 5737 TEST-NET-1: never an address of this machine
const V6_NAME = 'moe-doctor-v6.test';
const NO_NAME = 'moe-doctor-unresolvable.test';

describe('doctor bindHost', () => {
  let testDir: string;
  let moePath: string;
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  let request: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-doctor-bindhost-'));
    moePath = scaffoldMoe(testDir);
    request = vi.spyOn(http, 'request');
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (name: string) => {
      if (name === V6_NAME) return { address: '::1', family: 6 };
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    }) as unknown as typeof dns.promises.lookup);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // As doctor.test.ts does: destroy every server-side socket first, or close() waits on a lingering one.
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function listen(server: net.Server, host: string): Promise<number> {
    servers.push(server);
    server.on('connection', (sock: net.Socket) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return (server.address() as net.AddressInfo).port;
  }
  const healthy = (host: string) => listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', projectPath: testDir, pid: process.pid }));
  }), host);
  const rawTcp = (host: string) => listen(net.createServer((sock) => {
    sock.on('error', () => { /* ignore */ });
    sock.end('not-http\r\n');
  }), host);
  const writeDaemonJson = (port: number, bindHost: unknown) => fs.writeFileSync(path.join(moePath, 'daemon.json'),
    JSON.stringify({ port, pid: process.pid, projectPath: testDir, startedAt: new Date().toISOString(), bindHost }));
  const reach = (output: string[]) => output.find((l) => l.includes('daemon health reachability'));

  it.skipIf(!HAS_V6_LOOPBACK).each([['the literal ::1', '::1'], ['a name resolving to ::1', V6_NAME]])(
    'B1: a healthy daemon bound to %s is dialed at [::1] and passes', async (_kind, bindHost) => {
      const port = await healthy('::1');
      writeDaemonJson(port, bindHost);
      const result = await runDoctor(testDir);
      expect(reach(result.output)).toMatch(new RegExp(`^\\[OK\\] .*\\[::1\\]:${port}`));
      expect(result.exitCode).toBe(0);
    });

  it.skipIf(!HAS_V6_LOOPBACK)('B2: the TCP fallback dials the bindHost address too', async () => {
    const port = await rawTcp('::1');
    writeDaemonJson(port, '::1');
    const result = await runDoctor(testDir);
    expect(reach(result.output)).toMatch(new RegExp(`^\\[WARN\\] .*\\[::1\\]:${port} accepts TCP`));
    expect(result.exitCode).toBe(0);
  });

  it.each(['0.0.0.0', '::', 'wsl'])('B3: the wildcard bindHost %s is probed on 127.0.0.1', async (bindHost) => {
    const port = await healthy('127.0.0.1');
    writeDaemonJson(port, bindHost);
    const result = await runDoctor(testDir);
    expect(reach(result.output)).toMatch(new RegExp(`^\\[OK\\] .*127\\.0\\.0\\.1:${port}`));
    expect(result.exitCode).toBe(0);
  });

  it('B4: a bindHost that is not an address of this machine fails without being dialed', async () => {
    const port = await healthy('127.0.0.1'); // a fallback to 127.0.0.1 would pass here
    writeDaemonJson(port, OFF);
    const result = await runDoctor(testDir);
    expect(reach(result.output)).toMatch(/^\[FAIL\] .*192\.0\.2\.10.*not an address of this machine.*not dialed/);
    expect(request).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it.each([['a name that does not resolve', NO_NAME], ['a non-string value', ['::1']]])(
    'B5: a bindHost that is %s fails without being dialed', async (_kind, bindHost) => {
      const port = await healthy('127.0.0.1');
      writeDaemonJson(port, bindHost);
      const result = await runDoctor(testDir);
      expect(reach(result.output)).toMatch(/^\[FAIL\] .*not dialed/);
      expect(request).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
    });
});

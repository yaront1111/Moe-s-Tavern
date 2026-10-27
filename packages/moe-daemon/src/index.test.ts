import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import type { DaemonInfo } from './types/schema.js';
import {
  acquireLock,
  isPortAvailable,
  readDaemonInfo,
  readLockInfo,
  releaseLock,
  stopDaemon,
  validateDaemonInfoForProject,
} from './index.js';

describe('daemon lifecycle validation', () => {
  let testDir: string;
  const servers: http.Server[] = [];

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-daemon-lifecycle-'));
    fs.mkdirSync(path.join(testDir, '.moe'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    servers.length = 0;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function healthServer(projectPath: string, pid = process.pid): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', projectPath, pid }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  async function unusedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }

  function daemonInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
    return {
      port: 12345,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: testDir,
      ...overrides,
    };
  }

  it('accepts valid daemon info only when health matches the requested project', async () => {
    const port = await healthServer(testDir);
    const result = await validateDaemonInfoForProject(testDir, daemonInfo({ port }));

    expect(result.valid).toBe(true);
    expect(result.info?.port).toBe(port);
  });

  it('rejects live pid with closed port as stale', async () => {
    const result = await validateDaemonInfoForProject(testDir, daemonInfo({ port: await unusedPort() }));

    expect(result).toMatchObject({ valid: false, reason: 'health check failed' });
  });

  it('rejects daemon info for another project', async () => {
    const result = await validateDaemonInfoForProject(testDir, daemonInfo({
      projectPath: path.join(os.tmpdir(), 'other-moe-project'),
    }));

    expect(result).toMatchObject({ valid: false, reason: 'projectPath mismatch' });
  });

  it('rejects malformed daemon info', async () => {
    const result = await validateDaemonInfoForProject(testDir, {
      ...daemonInfo(),
      port: 0,
      pid: -1,
    } as DaemonInfo);

    expect(result).toMatchObject({ valid: false, reason: 'malformed' });
  });

  it('stopDaemon refuses to signal when liveness is not tied to a healthy Moe daemon', async () => {
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify(daemonInfo({
      port: await unusedPort(),
    })));
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.lock'), 'not-json');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    await stopDaemon(testDir);

    expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(fs.existsSync(path.join(testDir, '.moe', 'daemon.json'))).toBe(false);
    expect(fs.existsSync(path.join(testDir, '.moe', 'daemon.lock'))).toBe(false);
  });

  it('stopDaemon refuses to signal a live daemon.json PID when the healthy port reports a different PID', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.pid).toBeDefined();
    const childPid = child.pid!;
    const port = await healthServer(testDir, process.pid);
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify(daemonInfo({
      port,
      pid: childPid,
    })));

    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) {
        return realKill(pid, 0);
      }
      return true;
    }) as typeof process.kill);

    try {
      await stopDaemon(testDir);

      expect(killSpy).not.toHaveBeenCalledWith(childPid, 'SIGTERM');
      expect(fs.existsSync(path.join(testDir, '.moe', 'daemon.json'))).toBe(false);
    } finally {
      killSpy.mockRestore();
      try {
        realKill(childPid, 'SIGTERM');
      } catch { /* child may have exited */ }
    }
  });

  it('stopDaemon writes a stop sentinel when no daemon.json exists (supervisor may be mid-backoff)', async () => {
    // No daemon.json: a `stop` during the supervisor's crash-restart backoff has
    // no live child to signal, so it must leave a sentinel so the deferred
    // respawn aborts instead of resurrecting the daemon.
    const sentinel = path.join(testDir, '.moe', 'daemon.stop');
    expect(fs.existsSync(sentinel)).toBe(false);

    await stopDaemon(testDir);

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('stopDaemon writes a stop sentinel when daemon.json is stale', async () => {
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify(daemonInfo({
      port: await unusedPort(),
    })));
    const sentinel = path.join(testDir, '.moe', 'daemon.stop');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    await stopDaemon(testDir);

    expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(fs.existsSync(sentinel)).toBe(true);
    // Stale daemon.json is still cleaned up.
    expect(fs.existsSync(path.join(testDir, '.moe', 'daemon.json'))).toBe(false);
  });

  it('acquireLock removes stale PID-reuse-ambiguous locks after timeout', () => {
    const lockPath = path.join(testDir, '.moe', 'daemon.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    expect(acquireLock(testDir)).toBe(true);
    expect(readLockInfo(testDir)?.pid).toBe(process.pid);
    releaseLock(testDir);
  });
});

describe('port probing', () => {
  const held: net.Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(held.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    held.length = 0;
  });

  async function holdPort(host: string): Promise<number> {
    const server = net.createServer();
    held.push(server);
    await new Promise<void>(resolve => server.listen({ port: 0, host }, resolve));
    return (server.address() as net.AddressInfo).port;
  }

  // Windows without SO_EXCLUSIVEADDRUSE lets a second process bind a port that a
  // 0.0.0.0 or 127.0.0.1 listener already holds, so the bind probe succeeds on a
  // taken port. Reproduce that on every OS by moving the probe's bind to a free port.
  function bindProbeAlwaysSucceeds(): void {
    const createServer = net.createServer as (...args: unknown[]) => net.Server;
    vi.spyOn(net, 'createServer').mockImplementation(((...args: unknown[]) => {
      const server = createServer.apply(net, args);
      const listen = server.listen.bind(server) as (options: net.ListenOptions, callback?: () => void) => net.Server;
      server.listen = ((options: net.ListenOptions, callback?: () => void) =>
        listen({ ...options, port: 0 }, callback)) as typeof server.listen;
      return server;
    }) as unknown as typeof net.createServer);
  }

  it.each(['127.0.0.1', '0.0.0.0'])('treats a port held by a %s listener as taken even when the bind probe succeeds', async (heldHost) => {
    const port = await holdPort(heldHost);
    bindProbeAlwaysSucceeds();

    expect(await isPortAvailable(port, '0.0.0.0')).toBe(false);
    expect(await isPortAvailable(port, '127.0.0.1')).toBe(false);
  });

  it('treats a port nothing listens on as free', async () => {
    const port = await holdPort('127.0.0.1');
    await new Promise<void>(resolve => held.pop()!.close(() => resolve()));

    expect(await isPortAvailable(port, '127.0.0.1')).toBe(true);
  });
});

describe('daemon.json size cap', () => {
  let testDir: string;
  let daemonJson: string;

  // The 64 KiB cap is shared with the JetBrains reader and the other clients,
  // so the boundary is pinned as literals: a silent constant change must fail.
  const CAP = 65536;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-daemon-sizecap-'));
    fs.mkdirSync(path.join(testDir, '.moe'));
    daemonJson = path.join(testDir, '.moe', 'daemon.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function info(): DaemonInfo {
    return { port: 12345, pid: process.pid, startedAt: '2026-10-27T00:00:00.000Z', projectPath: testDir };
  }

  // Valid JSON padded with trailing spaces (legal whitespace) to an exact byte length.
  function paddedJson(bytes: number): string {
    const body = JSON.stringify(info());
    return body + ' '.repeat(bytes - Buffer.byteLength(body));
  }

  it('readDaemonInfo parses a 65536-byte daemon.json and refuses a 65537-byte one', () => {
    fs.writeFileSync(daemonJson, paddedJson(CAP));
    expect(fs.statSync(daemonJson).size).toBe(65536);
    expect(readDaemonInfo(testDir)).toEqual(info());

    fs.writeFileSync(daemonJson, paddedJson(CAP + 1));
    expect(fs.statSync(daemonJson).size).toBe(65537);
    expect(readDaemonInfo(testDir)).toBeNull();
  });

  it('reads at most 65537 bytes and never loads the whole file', () => {
    fs.writeFileSync(daemonJson, paddedJson(8 * 1024 * 1024));
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    const readSyncSpy = vi.spyOn(fs, 'readSync');

    expect(readDaemonInfo(testDir)).toBeNull();

    expect(readFileSpy.mock.calls.some(([target]) => String(target) === daemonJson)).toBe(false);
    const total = readSyncSpy.mock.results.reduce(
      (sum, r) => sum + (r.type === 'return' ? (r.value as number) : 0),
      0,
    );
    expect(readSyncSpy).toHaveBeenCalled();
    expect(total).toBeLessThanOrEqual(65537);
  });

  // A symlink to a device reports size 0, so only a bounded read can stop it.
  it.skipIf(process.platform === 'win32')('returns null promptly for a daemon.json symlinked to /dev/zero', () => {
    fs.symlinkSync('/dev/zero', daemonJson);
    const started = Date.now();
    expect(readDaemonInfo(testDir)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stopDaemon treats an oversize daemon.json as no daemon info and does not delete or signal', async () => {
    fs.writeFileSync(daemonJson, paddedJson(CAP + 1));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    await stopDaemon(testDir);

    expect(killSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.moe', 'daemon.stop'))).toBe(true);
    expect(fs.existsSync(daemonJson)).toBe(true);
  });
});

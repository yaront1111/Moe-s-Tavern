import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import dns from 'dns';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import type { DaemonInfo } from './types/schema.js';
import { logger } from './util/logger.js';
import {
  acquireLock,
  existingDaemonBlocksStart,
  isForeignDaemonInfo,
  isPortAvailable,
  isSameProjectPath,
  probeDaemonHealth,
  readDaemonInfo,
  readLockInfo,
  releaseLock,
  staleLockReason,
  statusDaemon,
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

  it('a young empty daemon.lock is a live owner mid-write, so a contender neither judges it stale nor replaces it', () => {
    const lockPath = path.join(testDir, '.moe', 'daemon.lock');
    fs.writeFileSync(lockPath, '');

    expect([staleLockReason(testDir), acquireLock(testDir), fs.readFileSync(lockPath, 'utf-8')])
      .toEqual([null, false, '']);
    fs.writeFileSync(lockPath, 'not-json');
    expect(staleLockReason(testDir)).toBe('malformed lock');
  });

  it('an empty daemon.lock older than the stale timeout is still reclaimed', () => {
    const lockPath = path.join(testDir, '.moe', 'daemon.lock');
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    expect(staleLockReason(testDir)).toBe('malformed lock');
    expect(acquireLock(testDir)).toBe(true);
    expect(readLockInfo(testDir)?.pid).toBe(process.pid);
    releaseLock(testDir);
  });

  it('a lock write that fails after the O_EXCL create leaves no empty lock behind', () => {
    const lockPath = path.join(testDir, '.moe', 'daemon.lock');
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });

    expect.soft([acquireLock(testDir), fs.existsSync(lockPath)]).toEqual([false, false]);
    expect(close).toHaveBeenCalledWith(open.mock.results[0].value);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // A daemon.json written on the other side of the WSL/Windows boundary names a
  // pid from another pid namespace. Flipping process.platform makes testDir's
  // own path form look like the other side's, so this runs on every CI OS.
  describe('daemon.json across the WSL boundary', () => {
    const DEAD_PID = 2147483646;
    let savedExitCode: typeof process.exitCode;
    const jsonPath = () => path.join(testDir, '.moe', 'daemon.json');
    const lockPath = () => path.join(testDir, '.moe', 'daemon.lock');
    const stopPath = () => path.join(testDir, '.moe', 'daemon.stop');

    beforeEach(() => {
      savedExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = savedExitCode;
    });

    async function otherSide<T>(fn: () => Promise<T>): Promise<T> {
      const saved = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const flipped = process.platform === 'win32' ? 'linux' : 'win32';
      Object.defineProperty(process, 'platform', { ...saved, value: flipped });
      try {
        return await fn();
      } finally {
        Object.defineProperty(process, 'platform', saved);
      }
    }

    function writeDaemonFiles(port: number, pid = DEAD_PID, projectPath = testDir, extra: Partial<DaemonInfo> = {}): string {
      const raw = JSON.stringify(daemonInfo({ port, pid, projectPath, ...extra }));
      fs.writeFileSync(jsonPath(), raw);
      fs.writeFileSync(lockPath(), JSON.stringify({
        pid, projectPath, createdAt: new Date().toISOString(),
      }));
      return raw;
    }

    function killSpyWithoutSignals() {
      const realKill = process.kill.bind(process);
      return vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) =>
        signal === 0 || signal === undefined ? realKill(pid, 0) : true) as typeof process.kill);
    }

    it('DEAD_PID is not a live pid here', () => {
      let code: string | undefined;
      try { process.kill(DEAD_PID, 0); } catch (err) { code = (err as NodeJS.ErrnoException).code; }
      expect(code).toBe('ESRCH');
    });

    it('X1 isSameProjectPath matches /mnt/<d>/x and <D>:/x in both orders', () => {
      const equal: Array<[string, string]> = [
        ['/mnt/d/projexts/app', 'D:\\projexts\\app'],
        ['/mnt/d/projexts/app', 'd:/projexts/app/'],
        ['/mnt/D/projexts/app', 'D:/projexts/app'],
        ['/mnt/d/', 'D:\\'],
        ['/tmp/a', '/tmp/a/'],
        ['\\\\srv\\share\\proj', '//SRV/SHARE/PROJ/'],
        ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', '/home/u/proj'],
        ['//wsl$/Ubuntu/mnt/d/proj', 'D:\\proj'],
      ];
      const unequal: Array<[string, string]> = [
        ['/mnt/d/x', 'E:/x'],
        ['/mnt/d/x', 'D:/y'],
        ['/mnt/dd/x', 'D:/x'],
        ['/mnt/d/x/y', 'D:/x'],
        ['/home/qa/OtherProject', '/home/qa/otherproject'],
        ['/home/u/p', 'C:\\home\\u\\p'],
        ['//srv/share/p', '/srv/share/p'],
      ];
      for (const [a, b] of equal) {
        expect([a, b, isSameProjectPath(a, b), isSameProjectPath(b, a)]).toEqual([a, b, true, true]);
      }
      for (const [a, b] of unequal) {
        expect([a, b, isSameProjectPath(a, b), isSameProjectPath(b, a)]).toEqual([a, b, false, false]);
      }
      expect(isSameProjectPath('/tmp/A', '/tmp/a')).toBe(false);
    });

    it('X2 isForeignDaemonInfo judges the writer by its projectPath form', () => {
      const foreign = (projectPath: string, platform: NodeJS.Platform) =>
        isForeignDaemonInfo(daemonInfo({ projectPath }), platform);
      for (const p of ['D:\\p', 'd:/p', '\\\\srv\\share\\p']) {
        expect([p, foreign(p, 'linux'), foreign(p, 'darwin'), foreign(p, 'win32')]).toEqual([p, true, true, false]);
      }
      for (const p of ['/mnt/d/p', '/home/u/p']) {
        expect([p, foreign(p, 'win32'), foreign(p, 'linux'), foreign(p, 'darwin')]).toEqual([p, true, false, false]);
      }
      // A daemon before task-78fa7110 recorded a relative --project as given: it names no side.
      for (const p of ['.', 'proj', 'sub/proj', 'sub\\proj']) {
        expect([p, foreign(p, 'win32'), foreign(p, 'linux'), foreign(p, 'darwin')]).toEqual([p, false, false, false]);
      }
    });

    it('X3 a foreign daemon.json skips the pid check and is judged by /health alone', async () => {
      const port = await healthServer(testDir, DEAD_PID);
      const info = daemonInfo({ port, pid: DEAD_PID });
      expect(await validateDaemonInfoForProject(testDir, info))
        .toMatchObject({ valid: false, reason: 'pid not alive' });

      expect(await otherSide(() => validateDaemonInfoForProject(testDir, info)))
        .toMatchObject({ valid: true, foreign: true, info: { port, pid: DEAD_PID } });
      const unreachable = daemonInfo({ port: await unusedPort(), pid: DEAD_PID });
      expect(await otherSide(() => validateDaemonInfoForProject(testDir, unreachable)))
        .toEqual({ valid: false, reason: 'foreign daemon unreachable', foreign: true });
    });

    it.each(['healthy', 'unreachable'])('X4 statusDaemon leaves a %s foreign daemon.json and its lock in place and exits 0', async (kind) => {
      const port = kind === 'healthy' ? await healthServer(testDir, DEAD_PID) : await unusedPort();
      const raw = writeDaemonFiles(port);

      await otherSide(() => statusDaemon(testDir));

      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(raw);
      expect(fs.existsSync(lockPath())).toBe(true);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('X5a statusDaemon natively removes a daemon.json whose pid is dead', async () => {
      writeDaemonFiles(await healthServer(testDir, DEAD_PID));

      await statusDaemon(testDir);

      expect(fs.existsSync(jsonPath())).toBe(false);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('X5b statusDaemon natively keeps a live-pid daemon.json whose /health fails', async () => {
      const raw = writeDaemonFiles(await unusedPort(), process.pid);

      await statusDaemon(testDir);

      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(raw);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it.each(['healthy', 'unreachable'])('X6 stopDaemon never signals, deletes or sentinels a %s foreign daemon', async (kind) => {
      const port = kind === 'healthy' ? await healthServer(testDir, DEAD_PID) : await unusedPort();
      const raw = writeDaemonFiles(port);
      const killSpy = killSpyWithoutSignals();

      await otherSide(() => stopDaemon(testDir));

      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(raw);
      expect(fs.existsSync(lockPath())).toBe(true);
      expect(fs.existsSync(stopPath())).toBe(false);
    });

    it('X7 existingDaemonBlocksStart refuses over a foreign daemon.json and keeps native stale recovery', async () => {
      const healthyRaw = writeDaemonFiles(await healthServer(testDir, DEAD_PID));
      expect(await otherSide(() => existingDaemonBlocksStart(testDir))).toBe(true);
      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(healthyRaw);
      expect(process.exitCode ?? 0).toBe(0);

      const unreachableRaw = writeDaemonFiles(await unusedPort());
      expect(await otherSide(() => existingDaemonBlocksStart(testDir))).toBe(true);
      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(unreachableRaw);
      expect(fs.existsSync(lockPath())).toBe(true);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      writeDaemonFiles(await healthServer(testDir, DEAD_PID));
      expect(await existingDaemonBlocksStart(testDir)).toBe(false);
      expect(fs.existsSync(jsonPath())).toBe(false);

      expect(await existingDaemonBlocksStart(testDir)).toBe(false);
    });

    it('X8 never removes a foreign daemon.lock, nor a foreign daemon.json naming another path', async () => {
      const old = new Date(Date.now() - 60_000).toISOString();
      const lockRaw = JSON.stringify({ pid: DEAD_PID, projectPath: testDir, createdAt: old });
      fs.writeFileSync(lockPath(), lockRaw);
      expect(await otherSide(async () => acquireLock(testDir))).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf-8')).toBe(lockRaw);

      const raw = JSON.stringify(daemonInfo({ port: await unusedPort(), pid: DEAD_PID, projectPath: path.join(testDir, 'moved') }));
      fs.writeFileSync(jsonPath(), raw);
      const killSpy = killSpyWithoutSignals();
      await otherSide(() => statusDaemon(testDir));
      await otherSide(() => stopDaemon(testDir));
      expect(await otherSide(() => existingDaemonBlocksStart(testDir))).toBe(true);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
      expect(fs.readFileSync(jsonPath(), 'utf-8')).toBe(raw);
      expect(fs.readFileSync(lockPath(), 'utf-8')).toBe(lockRaw);
      expect(fs.existsSync(stopPath())).toBe(false);

      killSpy.mockRestore();
      expect(acquireLock(testDir)).toBe(true);
      releaseLock(testDir);
    });

    // The /mnt/<d> mapping must see the resolved path: a relative or
    // non-normalized --project has to keep matching a native daemon recorded
    // absolute. POSIX path.resolve reads process.cwd(), so a spy stands in for WSL.
    it.skipIf(process.platform === 'win32')('X9 isSameProjectPath maps /mnt/<d> after resolving relative and non-normalized paths', () => {
      vi.spyOn(process, 'cwd').mockReturnValue('/mnt/d/projexts/app');
      const equal: Array<[string, string]> = [
        ['.', '/mnt/d/projexts/app'],
        ['.', 'D:\\projexts\\app'],
        ['sub/..', 'd:/projexts/app/'],
        ['/mnt/d/projexts/app/sub/..', 'D:/projexts/app'],
        ['/mnt/d/projexts/app/./', '/mnt/d/projexts/app'],
        ['/mnt/d//projexts/app', '/mnt/d/projexts/app'],
      ];
      const unequal: Array<[string, string]> = [['sub', '/mnt/d/projexts/app'], ['..', 'D:/projexts/app']];
      for (const [a, b] of equal) {
        expect([a, b, isSameProjectPath(a, b), isSameProjectPath(b, a)]).toEqual([a, b, true, true]);
      }
      for (const [a, b] of unequal) {
        expect([a, b, isSameProjectPath(a, b), isSameProjectPath(b, a)]).toEqual([a, b, false, false]);
      }
    });

    it('X10 on win32 a raw /mnt/<d> path is posix-normalized before it is mapped', async () => {
      const onWin32 = async <T>(fn: () => T): Promise<T> => {
        if (process.platform === 'win32') return fn();
        // Off Windows, also stand in win32 path.resolve, which prefixes the cwd drive.
        const resolve = vi.spyOn(path, 'resolve').mockImplementation((...parts: string[]) => path.win32.resolve('C:\\work', ...parts));
        try { return await otherSide(async () => fn()); } finally { resolve.mockRestore(); }
      };
      const same = (a: string, b: string) => onWin32(() => [isSameProjectPath(a, b), isSameProjectPath(b, a)]);
      expect(await same('/mnt/d/projexts/app/sub/..', 'D:/projexts/app')).toEqual([true, true]);
      expect(await same('/mnt/d/projexts/app/./', 'd:\\projexts\\app')).toEqual([true, true]);
      expect(await same('/mnt/d/projexts/app/sub/../..', 'D:/projexts/app')).toEqual([false, false]);
      expect(await same('/home/qa/OtherProject', '/home/qa/otherproject')).toEqual([false, false]);
      expect(await same('\\\\srv\\share\\proj', '//SRV/SHARE/PROJ/')).toEqual([true, true]);
      expect(await same('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', '/home/u/proj')).toEqual([true, true]);
    });

    it.skipIf(process.platform === 'win32')('X11 validateDaemonInfoForProject accepts a relative --project naming a live native daemon recorded under /mnt/<d>', async () => {
      const recorded = '/mnt/d/projexts/app';
      const info = daemonInfo({ port: await healthServer(recorded), projectPath: recorded });
      vi.spyOn(process, 'cwd').mockReturnValue(recorded);

      expect(await validateDaemonInfoForProject('.', info)).toEqual({ valid: true, info });
    });

    // A native alias spells testDir's own directory differently: //tmp/x is /tmp/x on
    // POSIX, and /Users/x is C:\Users\x on Windows from a cwd on C:. Only the caller's own
    // --project is resolved that way. Recorded and reported paths are compared as written,
    // except native paths may also name testDir on disk (symlinks, junctions and 8.3 names).
    describe('native aliases of --project', () => {
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const source = new URL('./index.ts', import.meta.url).href;
      const owners: ChildProcess[] = [];
      let cwd: string;
      let alias: string;
      const spelling = (kind: string) => (kind === 'alias' ? alias : testDir);
      const files = () => [jsonPath(), lockPath()].map((file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null));

      beforeEach(() => {
        cwd = process.cwd();
        process.chdir(path.dirname(testDir));
        alias = process.platform === 'win32' ? testDir.slice(2).replace(/\\/g, '/') : `/${testDir}`;
        expect([path.relative(testDir, path.resolve(alias)), isSameProjectPath(alias, testDir)]).toEqual(['', false]);
      });

      afterEach(async () => {
        await Promise.all(owners.splice(0).map(stopChild));
        process.chdir(cwd);
      });

      async function stopChild(child: ChildProcess): Promise<void> {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(force);
      }

      // A second process takes the lock, running this source through tsx from testDir's drive.
      async function lockOwner(projectPath: string): Promise<ChildProcess> {
        const code = `const { acquireLock } = await import(${JSON.stringify(source)});
process.stdout.write(acquireLock(${JSON.stringify(projectPath)}) ? 'locked\\n' : 'refused\\n');
setInterval(() => {}, 60000);`;
        const child = spawn(process.execPath, ['--import', tsx, '--input-type=module', '--eval', code], {
          cwd: path.dirname(testDir), env: { ...process.env, LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
        });
        owners.push(child);
        const line = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('lock owner not ready within 30s')), 30_000);
          const settle = (fn: () => void) => { clearTimeout(timer); fn(); };
          let out = '';
          child.stdout!.on('data', (chunk) => { out += chunk; if (out.includes('\n')) settle(() => resolve(out.split('\n')[0])); });
          child.once('error', (error) => settle(() => reject(error)));
          child.once('exit', (exitCode) => settle(() => reject(new Error(`lock owner exited early (${exitCode})`))));
        });
        expect(line).toBe('locked');
        return child;
      }

      it.each(['canonical', 'alias'])('X12 a healthy native daemon named by its %s spelling blocks start, reports running and is stopped by pid', async (kind) => {
        let probes = 0;
        const port = await healthServer(testDir);
        servers.at(-1)!.on('request', () => { probes += 1; });
        writeDaemonFiles(port, process.pid);
        const kept = files();
        const info = vi.spyOn(logger, 'info');

        expect([await existingDaemonBlocksStart(spelling(kind)), probes, ...files()]).toEqual([true, 1, ...kept]);
        await statusDaemon(spelling(kind));
        expect(info.mock.calls.filter(([, msg]) => msg === 'Daemon status').map(([fields]) => fields))
          .toMatchObject([{ status: 'running', owner: 'local', pid: process.pid }]);
        const killSpy = killSpyWithoutSignals();
        await stopDaemon(spelling(kind));
        expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([[process.pid, 'SIGTERM']]);
        expect([probes, ...files(), fs.existsSync(stopPath())]).toEqual([3, ...kept, true]);
      });

      it('X13 probeDaemonHealth resolves the caller\'s own path, never a recorded or reported one', async () => {
        const info = daemonInfo({ port: await healthServer(testDir) });
        const reportsAlias = daemonInfo({ port: await healthServer(alias) });
        expect([
          await probeDaemonHealth(info, testDir),
          await probeDaemonHealth(info, alias),
          await probeDaemonHealth({ ...info, projectPath: alias }, testDir),
          await probeDaemonHealth(reportsAlias, alias),
        ]).toEqual([true, true, false, false]);
      });

      it.each([['canonical', 'alias'], ['alias', 'alias']])('X14 a live lock taken with the %s spelling refuses a contender using the %s one', async (ownerKind, contenderKind) => {
        const owner = await lockOwner(spelling(ownerKind));
        const lock = fs.readFileSync(lockPath(), 'utf-8');
        const recorded = JSON.parse(lock) as { pid: number; projectPath: string };
        expect([recorded.pid, isSameProjectPath(recorded.projectPath, testDir)]).toEqual([owner.pid, true]);

        expect(acquireLock(spelling(contenderKind))).toBe(false);
        expect([fs.readFileSync(lockPath(), 'utf-8'), process.kill(owner.pid!, 0), owner.exitCode]).toEqual([lock, true, null]);
      }, 60_000);

      it('X15 lock reasons agree across native, relative and dotted project spellings', () => {
        const base = path.basename(testDir);
        const spellings = [testDir, alias, base, `./${base}/`];
        for (const writer of spellings) {
          expect(acquireLock(writer)).toBe(true);
          expect.soft(spellings.map(reader => [writer, reader, staleLockReason(reader)]))
            .toEqual(spellings.map(reader => [writer, reader, null]));

          const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf-8')) as {
            pid: number; projectPath: string; createdAt: string;
          };
          fs.writeFileSync(lockPath(), JSON.stringify({ ...lock, pid: DEAD_PID }));
          expect.soft(spellings.map(reader => [writer, reader, staleLockReason(reader)]))
            .toEqual(spellings.map(reader => [writer, reader, 'lock owner not alive']));
          fs.rmSync(lockPath());
        }

        const moved = path.join(testDir, 'moved');
        fs.writeFileSync(lockPath(), JSON.stringify({
          pid: process.pid, projectPath: moved, createdAt: new Date().toISOString(),
        }));
        expect(spellings.map(reader => [moved, reader, staleLockReason(reader)]))
          .toEqual(spellings.map(reader => [moved, reader, 'projectPath mismatch']));
        fs.rmSync(lockPath());
      });

      describe('on-disk aliases of --project', () => {
        let link: string;
        const links: string[] = [];
        const otherDirs: string[] = [];
        const diskSpelling = (kind: string) => kind === 'link' ? link : testDir;

        beforeEach(() => {
          link = testDir + '-link';
          fs.symlinkSync(testDir, link, 'junction');
          links.push(link);
          expect([isSameProjectPath(link, testDir), fs.realpathSync.native(link) === fs.realpathSync.native(testDir)])
            .toEqual([false, true]);
        });

        afterEach(() => {
          for (const created of links.splice(0)) fs.unlinkSync(created);
          for (const dir of otherDirs.splice(0)) fs.rmSync(dir, { recursive: true });
        });

        async function blocksAndStops(recorded: string, caller: string): Promise<void> {
          let probes = 0;
          const port = await healthServer(recorded);
          servers.at(-1)!.on('request', () => { probes += 1; });
          writeDaemonFiles(port, process.pid, recorded);
          const kept = files();
          const info = vi.spyOn(logger, 'info');

          expect([await existingDaemonBlocksStart(caller), probes, ...files()]).toEqual([true, 1, ...kept]);
          await statusDaemon(caller);
          expect(info.mock.calls.filter(([, msg]) => msg === 'Daemon status').map(([fields]) => fields))
            .toMatchObject([{ status: 'running', owner: 'local', pid: process.pid }]);
          const killSpy = killSpyWithoutSignals();
          await stopDaemon(caller);
          expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined))
            .toEqual([[process.pid, 'SIGTERM']]);
          expect([probes, ...files(), fs.existsSync(stopPath())]).toEqual([3, ...kept, true]);
        }

        it.each([['canonical', 'link'], ['link', 'canonical']])('X16 a daemon recorded as %s is preserved and stopped through %s', async (recorded, caller) => {
          await blocksAndStops(diskSpelling(recorded), diskSpelling(caller));
        });

        it.runIf(process.platform === 'win32')('X16 a daemon is preserved and stopped through its 8.3 spelling', async (ctx) => {
          if (/["%]/.test(testDir)) ctx.skip();
          const short = execSync('for %I in ("' + testDir + '") do @echo %~sI', {
            encoding: 'utf8', shell: 'cmd.exe', windowsHide: true,
          }).trim();
          if (short === testDir) ctx.skip();
          await blocksAndStops(testDir, short);
        });

        it.each([['canonical', 'link'], ['link', 'canonical']])('X17 a live %s lock refuses a %s contender', async (ownerKind, contenderKind) => {
          const owner = await lockOwner(diskSpelling(ownerKind));
          const lock = fs.readFileSync(lockPath(), 'utf-8');
          const recorded = JSON.parse(lock) as { pid: number; projectPath: string };
          expect([recorded.pid, fs.realpathSync.native(recorded.projectPath)])
            .toEqual([owner.pid, fs.realpathSync.native(testDir)]);

          expect(acquireLock(diskSpelling(contenderKind))).toBe(false);
          expect([fs.readFileSync(lockPath(), 'utf-8'), process.kill(owner.pid!, 0), owner.exitCode]).toEqual([lock, true, null]);
        }, 60_000);

        it.each(['directory', 'link to it'])('X18 a daemon recorded for another %s is cleaned up without probing', async (kind) => {
          const other = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-daemon-other-'));
          otherDirs.push(other);
          const recorded = kind === 'directory' ? other : other + '-link';
          if (kind !== 'directory') {
            fs.symlinkSync(other, recorded, 'junction');
            links.push(recorded);
          }
          let probes = 0;
          const port = await healthServer(recorded);
          servers.at(-1)!.on('request', () => { probes += 1; });
          writeDaemonFiles(port, process.pid, recorded);

          expect([await existingDaemonBlocksStart(testDir), probes, fs.existsSync(jsonPath()), fs.existsSync(lockPath())])
            .toEqual([false, 0, false, false]);
        });
      });
    });

    // daemon.json is repository content, and a /health answer from another host could name any pid. So its
    // bindHost is dialed only when the literal it resolves to is loopback or held by a local interface.
    describe('a daemon.json bindHost is dialed only when it names this machine (task-d6ebe4ab)', () => {
      const OFF = '192.0.2.10'; // RFC 5737 TEST-NET-1
      const NAME = 'moe-bindhost.test';
      const lo = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' };
      const eth0 = { address: OFF, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${OFF}/24` };
      const v6 = (address: string, scopeid: number) =>
        ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/64`, scopeid });
      type Interfaces = ReturnType<typeof os.networkInterfaces>;
      const loopbackOnly = { lo: [lo] } as Interfaces;
      const withOff = { lo: [lo], eth0: [eth0] } as Interfaces;
      // eth0's subnets hold OFF and 2001:db8::10, but eth0 itself holds .11 and ::11.
      const neighbors = { lo: [lo], eth0: [{ ...eth0, address: '192.0.2.11', cidr: '192.0.2.11/24' }, v6('2001:db8::11', 2)] } as Interfaces;
      // Two links with their own link-local addresses; eth0 is interface index 2.
      const linkLocal = { lo: [lo], eth0: [v6('fe80::a', 2)], docker0: [v6('fe80::b', 3)] } as Interfaces;
      const unreadable = () => vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
        throw new Error('uv_interface_addresses EPERM');
      });
      const parsed = (raw: string) => JSON.parse(raw) as DaemonInfo;
      const signals = (spy: ReturnType<typeof killSpyWithoutSignals>) =>
        spy.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined);
      let dialed: string[];
      let lookup: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        dialed = [];
        // Every address answers like the healthy fake daemon, so only the bindHost rule can withhold a signal.
        const realRequest = http.request;
        vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
          dialed.push(String(options.hostname));
          return realRequest({ ...options, hostname: '127.0.0.1' }, callback);
        }) as typeof http.request);
        lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation((async (name: string) => {
          if (name === NAME) return { address: OFF, family: 4 };
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
        }) as unknown as typeof dns.promises.lookup);
      });

      // The whole refusal: nothing dialed, signalled, written or removed, exit 1, and status reports the reason.
      async function expectRefused(bindHost: string, interfaces: Interfaces): Promise<void> {
        vi.spyOn(os, 'networkInterfaces').mockReturnValue(interfaces);
        const raw = writeDaemonFiles(await healthServer(testDir), process.pid, testDir, { bindHost });
        const info = parsed(raw);
        const lock = fs.readFileSync(lockPath(), 'utf-8');
        const logged = vi.spyOn(logger, 'info');
        const errors = vi.spyOn(logger, 'error');
        const killSpy = killSpyWithoutSignals();

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: false, reason: 'bindHost not local' });
        expect(await probeDaemonHealth(info, testDir, 2000)).toBe(false);
        await statusDaemon(testDir);
        await stopDaemon(testDir);

        expect(dialed).toEqual([]);
        expect(signals(killSpy)).toEqual([]);
        expect([fs.readFileSync(jsonPath(), 'utf-8'), fs.readFileSync(lockPath(), 'utf-8'), fs.existsSync(stopPath())])
          .toEqual([raw, lock, false]);
        expect(process.exitCode).toBe(1);
        expect(logged.mock.calls.filter(([, msg]) => msg === 'Daemon status').map(([fields]) => fields))
          .toMatchObject([{ status: 'stopped', reason: 'bindHost not local', pid: process.pid }]);
        expect(errors.mock.calls.map(([fields]) => fields)).toEqual([{ pid: process.pid, bindHost }]);
      }

      it.each([['an IP literal', OFF], ['a name that resolves', NAME]])('B1 %s off this machine is never dialed, signalled or removed', (_kind, bindHost) =>
        expectRefused(bindHost, loopbackOnly));

      // Exact addresses, never subnets: a neighbor on a local interface's subnet is another machine.
      it.each([OFF, '2001:db8::10'])('B7 %s, on the subnet of a local interface but not held by one, is refused', (bindHost) =>
        expectRefused(bindHost, neighbors));

      // BlockList.check drops a %zone, but the zone picks the link that is dialed: with eth0 holding fe80::a,
      // fe80::a%docker0 leaves on docker0's link to a peer. A Moe daemon's /health refuses a zoned Host, so no zone counts.
      it.each(['fe80::a%docker0', 'fe80::a%eth0', 'fe80::a%2'])('B8 the zoned literal %s is refused', (bindHost) =>
        expectRefused(bindHost, linkLocal));

      it('B8 unzoned, a link-local address a local interface holds still stops: the OS delivers it locally', async () => {
        vi.spyOn(os, 'networkInterfaces').mockReturnValue(linkLocal);
        const info = parsed(writeDaemonFiles(await healthServer(testDir), process.pid, testDir, { bindHost: 'fe80::a' }));
        const killSpy = killSpyWithoutSignals();

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: true, info });
        await stopDaemon(testDir);

        expect(signals(killSpy)).toEqual([[process.pid, 'SIGTERM']]);
        expect(dialed).toEqual(['fe80::a', 'fe80::a']);
      });

      it.each([['an IP literal', OFF], ['a name that resolves', NAME]])('B2 %s to a local interface still stops, dialing the resolved literal', async (_kind, bindHost) => {
        vi.spyOn(os, 'networkInterfaces').mockReturnValue(withOff);
        const info = parsed(writeDaemonFiles(await healthServer(testDir), process.pid, testDir, { bindHost }));
        const killSpy = killSpyWithoutSignals();

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: true, info });
        await stopDaemon(testDir);

        expect(signals(killSpy)).toEqual([[process.pid, 'SIGTERM']]);
        expect(fs.existsSync(stopPath())).toBe(true);
        // One resolution per validation, and the literal it gave is the one dialed.
        expect(dialed).toEqual([OFF, OFF]);
        expect(lookup).toHaveBeenCalledTimes(bindHost === NAME ? 2 : 0);
        expect(process.exitCode ?? 0).toBe(0);
      });

      it.each([[undefined], ['127.0.1.1'], ['::1'], ['::ffff:127.0.0.1'], ['0.0.0.0'], ['::'], ['wsl']])('B3 loopback bindHost %s stops as before even when the interfaces cannot be read', async (bindHost) => {
        unreadable();
        const info = parsed(writeDaemonFiles(await healthServer(testDir), process.pid, testDir, bindHost === undefined ? {} : { bindHost }));
        const probed = bindHost === undefined || ['0.0.0.0', '::', 'wsl'].includes(bindHost) ? '127.0.0.1' : bindHost;
        const killSpy = killSpyWithoutSignals();

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: true, info });
        await stopDaemon(testDir);

        expect(signals(killSpy)).toEqual([[process.pid, 'SIGTERM']]);
        expect(dialed).toEqual([probed, probed]);
      });

      it('B4 unreadable interfaces leave loopback only, so a non-loopback bindHost is refused', async () => {
        unreadable();
        const info = daemonInfo({ port: await healthServer(testDir), bindHost: OFF });

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: false, reason: 'bindHost not local' });
        expect(dialed).toEqual([]);
      });

      // net.isIP coerces its argument, so a one-element array passes as an IP literal unless the type is checked.
      it.each([[[OFF]], [['127.0.0.1']], [5]])('B6 a non-string bindHost %j is never dialed and never throws', async (bindHost) => {
        vi.spyOn(os, 'networkInterfaces').mockReturnValue(withOff);
        const info = daemonInfo({ port: await healthServer(testDir), bindHost: bindHost as unknown as string });

        expect(await validateDaemonInfoForProject(testDir, info)).toEqual({ valid: false, reason: 'health check failed' });
        expect(await probeDaemonHealth(info, testDir, 2000)).toBe(false);
        expect(dialed).toEqual([]);
      });

      it('B5 a foreign daemon.json bindHost is dialed only when a local interface holds it', async () => {
        const info = daemonInfo({ port: await healthServer(testDir, DEAD_PID), pid: DEAD_PID, bindHost: OFF });
        const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue(loopbackOnly);

        expect(await otherSide(() => validateDaemonInfoForProject(testDir, info)))
          .toEqual({ valid: false, reason: 'foreign daemon unreachable', foreign: true });
        expect(dialed).toEqual([]);

        interfaces.mockReturnValue(withOff);
        expect(await otherSide(() => validateDaemonInfoForProject(testDir, info))).toEqual({ valid: true, info, foreign: true });
        expect(dialed).toEqual([OFF]);

        // The zone rule covers it too: eth0 holds fe80::a, but %docker0 would dial docker0's link.
        interfaces.mockReturnValue(linkLocal);
        expect(await otherSide(() => validateDaemonInfoForProject(testDir, { ...info, bindHost: 'fe80::a%docker0' })))
          .toEqual({ valid: false, reason: 'foreign daemon unreachable', foreign: true });
        expect(dialed).toEqual([OFF]);
      });
    });
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

// A start over a project with no .moe/ is refused before any lock or spawn, and a
// lock wait that ends with no daemon running exits non-zero (task-88673297). The
// children run this source through tsx with a scrubbed env: no seat MOE_* variable,
// a scratch HOME (a started _run writes ~/.moe/config.json) and a 100 ms lock wait.
describe('no-moe start', () => {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  let scratch: string;
  let project: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-no-moe-start-'));
    project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(scratch, 'home'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }

  /** Run the CLI; returns its exit status, the msg of every JSON log line, and the wall time. */
  async function daemon(...args: string[]): Promise<{ status: number | null; msgs: string[]; ms: number }> {
    const home = path.join(scratch, 'home');
    // NODE_OPTIONS hands tsx to the _run child that `start`'s supervisor spawns with
    // process.execPath alone; without it that child dies on the .ts import, not on the bug.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, NODE_ENV: 'production', MOE_LOCK_RETRY_DELAY_MS: '100',
      NODE_OPTIONS: `--import ${tsx}`,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
    };
    const port = String(await freePort());
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--import', tsx, entry, ...args, '--port', port], {
      env, encoding: 'utf-8', timeout: 30_000, windowsHide: true,
    });
    const msgs = `${result.stdout}${result.stderr}`.split('\n').flatMap((line) => {
      try { return [String((JSON.parse(line) as { msg?: unknown }).msg)]; } catch { return []; }
    });
    return { status: result.status, msgs, ms: Date.now() - started };
  }

  const names = (msgs: string[], text: string) => msgs.some(msg => msg.startsWith(text));

  it('N1: _run on a directory without .moe/ exits 1 naming the missing .moe/, with no lock race and nothing created', async () => {
    const run = await daemon('_run', '--project', project);
    expect({ status: run.status, missing: names(run.msgs, '.moe/ missing at '), race: names(run.msgs, 'Another process is starting the daemon') })
      .toEqual({ status: 1, missing: true, race: false });
    expect(fs.readdirSync(project)).toEqual([]);
  }, 60_000);

  it('N2: _run on a path that does not exist exits 1 and does not create it', async () => {
    const typo = path.join(scratch, 'typo');
    const run = await daemon('_run', '--project', typo);
    expect({ status: run.status, missing: names(run.msgs, '.moe/ missing at '), exists: fs.existsSync(typo) })
      .toEqual({ status: 1, missing: true, exists: false });
  }, 60_000);

  it('N3: start on a directory without .moe/ exits 1 within 10 s, spawning no daemon and no restart', async () => {
    const run = await daemon('start', '--project', project);
    expect({
      status: run.status, fast: run.ms < 10_000, missing: names(run.msgs, '.moe/ missing at '),
      spawned: names(run.msgs, 'Supervisor spawned daemon process'), restarted: names(run.msgs, 'Restarting daemon after backoff'),
    }).toEqual({ status: 1, fast: true, missing: true, spawned: false, restarted: false });
  }, 60_000);

  it('N4: _run whose lock wait ends with no daemon running exits 1', async () => {
    fs.mkdirSync(path.join(project, '.moe'));
    // A live, fresh lock held by this test process: contention, never stale.
    fs.writeFileSync(path.join(project, '.moe', 'daemon.lock'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const run = await daemon('_run', '--project', project);
    expect({
      status: run.status, waited: names(run.msgs, 'Another process is starting the daemon, waiting...'),
      failed: names(run.msgs, 'Failed to acquire lock and daemon not running'),
    }).toEqual({ status: 1, waited: true, failed: true });
  }, 60_000);

  it('N5: acquireLock throws a create error other than EEXIST instead of reporting contention', () => {
    let code: unknown = 'returned without throwing';
    try { acquireLock(project); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code).toBe('ENOENT');
  });
});

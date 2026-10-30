import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { spawn, type ChildProcess } from 'child_process';
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

    function writeDaemonFiles(port: number, pid = DEAD_PID): string {
      const raw = JSON.stringify(daemonInfo({ port, pid }));
      fs.writeFileSync(jsonPath(), raw);
      fs.writeFileSync(lockPath(), JSON.stringify({
        pid, projectPath: testDir, createdAt: new Date().toISOString(),
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
      // `--project` is recorded as given: a relative path names no side.
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
    // --project is resolved that way; recorded and reported paths are compared as written.
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

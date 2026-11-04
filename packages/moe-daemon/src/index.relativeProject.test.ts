import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, type ChildProcess } from 'child_process';
import { parseArgs } from './index.js';
import { CURRENT_SCHEMA_VERSION } from './types/schema.js';

// task-78fa7110: a relative --project or MOE_PROJECT_PATH is recorded absolute, so a start from
// another cwd still finds the live daemon. Children run this source through tsx with a scrubbed
// env (no seat MOE_* variable, a scratch HOME). Cleanup signals only the supervisors spawned here,
// then a recorded _run pid only while /health on its recorded port still answers with that pid.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
type Info = { pid: number; port: number; projectPath: string };

describe('a relative project path is recorded absolute (task-78fa7110)', () => {
  let scratch: string;
  let project: string;
  const supervisors: ChildProcess[] = [];
  const daemons: Info[] = [];

  beforeEach(() => {
    // A child's process.cwd() is the real path (the macOS tmpdir is a symlink).
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-rel-project-')));
    project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(scratch, 'home'));
  });

  afterEach(async () => {
    for (const child of supervisors.splice(0)) await settle(child);
    // On Windows the supervisor's TerminateProcess skips its signal forwarding, so its _run outlives it.
    for (const info of daemons.splice(0)) if ((await health(info.port))?.pid === info.pid) process.kill(info.pid);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  async function settle(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
    await exited;
    clearTimeout(force);
  }

  async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  function health(port: number): Promise<{ pid?: number; projectPath?: string } | null> {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  }

  /** Runs the CLI in cwd; `msgs` lists the msg of every JSON log line printed so far. */
  function cli(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    const home = path.join(scratch, 'home');
    // NODE_OPTIONS hands tsx to the _run child, which the supervisor spawns with process.execPath alone.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, NODE_ENV: 'production', NODE_OPTIONS: `--import ${tsx}`,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
      ...extraEnv,
    };
    const child = spawn(process.execPath, ['--import', tsx, entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    supervisors.push(child);
    let out = '';
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk) => { out += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const msgs = () => out.split('\n').flatMap((line) => {
      try { return [String((JSON.parse(line) as { msg?: unknown }).msg)]; } catch { return []; }
    });
    return { child, exited, msgs, out: () => out };
  }

  const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(project, '.moe', file), 'utf-8')) as T;

  /** Starts a daemon and waits until /health answers with daemon.json's pid. */
  async function liveDaemon(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<Info> {
    const run = cli(cwd, [...args, '--port', String(await freePort())], extraEnv);
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && run.child.exitCode === null;
      await new Promise((resolve) => setTimeout(resolve, 200))) {
      let info: Info;
      try { info = readJson<Info>('daemon.json'); } catch { continue; }
      if ((await health(info.port))?.pid === info.pid) { daemons.push(info); return info; }
    }
    throw new Error(`no healthy daemon; output:\n${run.out().slice(-3000)}`);
  }

  async function expectRecorded(info: Info, expected = path.resolve(project)): Promise<void> {
    expect({ daemonJson: info.projectPath, health: (await health(info.port))?.projectPath, rootPath: readJson<{ rootPath: string }>('project.json').rootPath })
      .toEqual({ daemonJson: expected, health: expected, rootPath: expected });
  }

  it('(r1) init --project . records path.resolve(cwd) in daemon.json, /health and project.json', async () => {
    await expectRecorded(await liveDaemon(project, ['init', '--project', '.']));
  }, 120_000);

  it('(r2) init with MOE_PROJECT_PATH=. and no --project records path.resolve(cwd), healing an older rootPath "."', async () => {
    // What a daemon before task-78fa7110 left after `init --project .`.
    fs.mkdirSync(path.join(project, '.moe'));
    fs.writeFileSync(path.join(project, '.moe', 'project.json'), JSON.stringify({ id: 'proj-legacy1', schemaVersion: CURRENT_SCHEMA_VERSION, name: 'project', rootPath: '.' }));
    await expectRecorded(await liveDaemon(project, ['init'], { MOE_PROJECT_PATH: '.' }));
  }, 120_000);

  it('(r3) start --project <abs> from another cwd finds the daemon init --project . started', async () => {
    const first = await liveDaemon(project, ['init', '--project', '.']);
    const port = await freePort();
    // Load margin only: the guard's /health probe defaults to 200 ms. At base it fails on 'projectPath mismatch' first.
    const second = cli(scratch, ['start', '--project', project, '--port', String(port)], { MOE_SOCKET_TIMEOUT_MS: '5000' });
    const code = await Promise.race([second.exited, new Promise((resolve) => setTimeout(() => resolve('still running after 30 s'), 30_000))]);
    const now = readJson<Info>('daemon.json');
    expect({
      code, running: second.msgs().includes('Moe daemon already running'),
      spawned: second.msgs().includes('Supervisor spawned daemon process'),
      cleaned: second.msgs().includes('Cleaning up stale daemon lifecycle files'),
      pid: now.pid, port: now.port, healthPid: (await health(first.port))?.pid, secondPort: await health(port),
    }).toEqual({ code: 0, running: true, spawned: false, cleaned: false, pid: first.pid, port: first.port, healthPid: first.pid, secondPort: null });
  }, 120_000);

  it('(r4) an absolute --project is recorded exactly as spelled', async () => {
    const spelled = process.platform === 'win32' ? project.replace(/\\/g, '/') : `${project}/`;
    await expectRecorded(await liveDaemon(scratch, ['init', '--project', spelled]), spelled);
  }, 120_000);

  it('(r5) parseArgs resolves a relative project path only; absolute POSIX, drive and UNC values stay as given', () => {
    const rows: Array<[string[], NodeJS.ProcessEnv, string]> = [
      [['init', '--project', '.'], {}, path.resolve('.')],
      [['start', '--project', 'sub/../proj/'], { MOE_PROJECT_PATH: '/elsewhere' }, path.resolve('proj')],
      [['start'], { MOE_PROJECT_PATH: '.' }, path.resolve('.')],
      [['start'], { MOE_PROJECT_PATH: 'proj' }, path.resolve('proj')],
      [['start'], { MOE_PROJECT_PATH: '' }, process.cwd()],
      [['start', '--project', '/srv/moe/p/'], { MOE_PROJECT_PATH: '.' }, '/srv/moe/p/'],
      [['start', '--project', '/srv//moe/./p'], {}, '/srv//moe/./p'],
      [['start'], { MOE_PROJECT_PATH: '/srv/moe/p/' }, '/srv/moe/p/'],
      [['start', '--project', 'D:\\projexts\\app'], {}, 'D:\\projexts\\app'],
      [['start', '--project', 'd:/projexts/app/'], {}, 'd:/projexts/app/'],
      [['start', '--project', '\\\\srv\\share\\app'], {}, '\\\\srv\\share\\app'],
      [['start', '--project', '//srv/share/app'], {}, '//srv/share/app'],
    ];
    for (const [args, env, expected] of rows) {
      expect([args, env, parseArgs(args, env).projectPath]).toEqual([args, env, expected]);
    }
  });
});

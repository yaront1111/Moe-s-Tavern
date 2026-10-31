import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { execFileSync } from 'child_process';
import { runDoctor } from './doctor.js';
import type { PlanPathGitRunner } from '../util/cachedPlanPaths.js';

// Minimal .moe scaffold so the role-doc / channel probes don't short-circuit
// before we reach the daemon health probe under test.
function scaffoldMoe(projectPath: string): string {
  const moePath = path.join(projectPath, '.moe');
  fs.mkdirSync(path.join(moePath, 'roles'), { recursive: true });
  for (const f of ['architect.md', 'worker.md', 'qa.md', 'governor.md']) {
    fs.writeFileSync(path.join(moePath, 'roles', f), '# role');
  }
  fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
  for (const name of ['general', 'workers', 'architects', 'qa', 'governors']) {
    fs.writeFileSync(path.join(moePath, 'channels', `${name}.json`), JSON.stringify({ name }));
  }
  return moePath;
}

function line(output: string[], label: string): string | undefined {
  return output.find((l) => l.includes(label));
}

describe('runDoctor — daemon health reachability', () => {
  let testDir: string;
  let moePath: string;
  const servers: Array<http.Server | net.Server> = [];
  const openSockets = new Set<net.Socket>();

  function track(server: http.Server | net.Server): void {
    server.on('connection', (sock: net.Socket) => {
      openSockets.add(sock);
      sock.on('close', () => openSockets.delete(sock));
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-doctor-'));
    moePath = scaffoldMoe(testDir);
  });

  afterEach(async () => {
    // Forcibly drop any lingering keep-alive sockets so server.close() resolves.
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers.length = 0;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function startHealthServer(body: unknown, statusCode = 200): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    track(server);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  async function startRawTcpServer(): Promise<number> {
    const server = net.createServer((sock) => {
      sock.on('error', () => { /* ignore */ });
      // Accept the connection, then emit non-HTTP bytes and hang up — mimics an
      // unrelated process that grabbed the reused port. The HTTP client treats
      // this as a parse error and bails fast (no long /health timeout wait), and
      // closing the socket lets server.close() complete in afterEach.
      sock.write('not-http\r\n');
      sock.end();
    });
    track(server);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  function writeDaemonJson(port: number, pid = process.pid): void {
    fs.writeFileSync(
      path.join(moePath, 'daemon.json'),
      JSON.stringify({ port, pid, projectPath: testDir, startedAt: new Date().toISOString() }),
    );
  }

  it('passes when /health confirms a healthy daemon for this project', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toBeDefined();
    expect(reach).toContain('[OK]');
    expect(result.exitCode).toBe(0);
  });

  it('does NOT report green when pid is alive and TCP listens but /health never answers (pid/port reuse)', async () => {
    // Raw socket: pid is alive (our own pid) and the port accepts TCP, but it is
    // not a Moe daemon. The old code reported [OK]; now this must be a warning.
    const port = await startRawTcpServer();
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toBeDefined();
    expect(reach).not.toContain('[OK]');
    expect(reach).toContain('[WARN]');
    // A warning must not flip exit code to non-zero on its own.
    expect(result.exitCode).toBe(0);
  });

  it('fails when /health reports a different project (port reused by another daemon)', async () => {
    const otherProject = path.join(os.tmpdir(), 'some-other-project');
    const port = await startHealthServer({ status: 'healthy', projectPath: otherProject, pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toContain('[FAIL]');
    expect(result.exitCode).toBe(1);
  });

  it('fails when /health reports a different pid than daemon.json (pid reuse)', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid + 1 });
    writeDaemonJson(port, process.pid);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toContain('[FAIL]');
    expect(result.exitCode).toBe(1);
  });

  it('passes when /health reports this project in a spelling only the shared path contract equates', async () => {
    // VS Code lowercases the drive letter; a WSL daemon may be named through its share.
    const flipped = testDir[0] === testDir[0].toLowerCase() ? testDir[0].toUpperCase() : testDir[0].toLowerCase();
    const reported = process.platform === 'win32' ? flipped + testDir.slice(1) : `//wsl$/Ubuntu${testDir}`;
    const port = await startHealthServer({ status: 'healthy', projectPath: reported, pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    expect(line(result.output, 'daemon health reachability')).toContain('[OK]');
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('still fails when /health reports the POSIX path in another case', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir.toUpperCase(), pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    expect(line(result.output, 'daemon health reachability')).toContain('[FAIL]');
    expect(result.exitCode).toBe(1);
  });

  it('passes for a native alias of --project', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid });
    writeDaemonJson(port);
    const cwd = process.cwd();
    try {
      // A drive-less Windows alias resolves against the cwd's drive.
      process.chdir(path.dirname(testDir));
      const alias = process.platform === 'win32' ? testDir.slice(2).replace(/\\/g, '/') : `/${testDir}`;

      const result = await runDoctor(alias);

      expect(line(result.output, 'daemon health reachability')).toContain('[OK]');
      expect(result.exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  // daemon.json is repository content; the cap (64 KiB = 65536 bytes) is shared
  // with the other clients, so the boundary is pinned as literals.
  function writePaddedDaemonJson(port: number, bytes: number, startedAt: string): void {
    const body = JSON.stringify({ port, pid: process.pid, projectPath: testDir, startedAt });
    fs.writeFileSync(path.join(moePath, 'daemon.json'), body + ' '.repeat(bytes - Buffer.byteLength(body)));
  }

  it('fails a 65537-byte daemon.json naming the 64 KiB limit and echoing none of its content', async () => {
    const marker = 'SECRET-MARKER-5f3a9c';
    writePaddedDaemonJson(1, 65537, marker);

    const result = await runDoctor(testDir);

    const probe = line(result.output, 'daemon.json:');
    expect(probe).toContain('[FAIL]');
    expect(probe).toContain('64 KiB');
    expect(result.output.join('\n')).not.toContain(marker);
    expect(result.exitCode).toBe(1);
  });

  it('still passes a valid 65536-byte daemon.json', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid });
    writePaddedDaemonJson(port, 65536, new Date().toISOString());

    const result = await runDoctor(testDir);

    expect(line(result.output, 'daemon.json:')).toContain('[OK]');
    expect(result.exitCode).toBe(0);
  });
});

// Worktree readiness probes (epic-dce3a64f §7.3): a stubbed read-only Git runner drives each
// condition; a real throwaway repository covers the listing and proves doctor writes nothing.
type GitCall = 'version' | 'toplevel' | 'head' | 'target' | 'list';
const gitError = (code: number | string, stderr = '') => Object.assign(new Error(`git: ${stderr}`), { code, stderr });
const callOf = (args: string[]): GitCall => {
  const kind = ({ version: 'version', 'symbolic-ref': 'head', worktree: 'list' } as Record<string, GitCall>)[args[0]]
    ?? (args[1] === '--show-toplevel' ? 'toplevel' : args[1] === '--verify' ? 'target' : undefined);
  if (!kind) throw new Error(`unexpected git call: ${args.join(' ')}`);
  return kind;
};
const listing = (...records: Array<[string, string?]>) =>
  records.map(([p, branch]) => `worktree ${p}\0HEAD ${'a'.repeat(40)}\0${branch ? `branch ${branch}` : 'detached'}\0\0`).join('');
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ID = 'task-0123456789abcdef0123456789abcdef';
const ON = { worktreeMode: 'on', qualityGate: 'npm test' };
const LABELS = ['worktree git version', 'worktree project root', 'worktree control branch', 'worktree target', 'worktree quality gate'];
const STALE = 'worktree stale task worktrees:';
type Overrides = Partial<Record<GitCall, string | Error>>;

describe('runDoctor — worktree readiness probes', () => {
  let testDir: string;
  let root: string;
  let moePath: string;
  let calls: string[][];

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-doctor-wt-'));
    root = fs.realpathSync.native(testDir);
    moePath = scaffoldMoe(testDir);
    calls = [];
  });

  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }));

  const writeSettings = (settings?: Record<string, unknown>) =>
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({ id: 'proj-1', settings }));
  function writeTask(id: string, task: Record<string, unknown> | string): void {
    fs.mkdirSync(path.join(moePath, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), typeof task === 'string' ? task : JSON.stringify(task));
  }

  function stubGit(overrides: Overrides = {}): PlanPathGitRunner {
    const ready: Record<GitCall, string> = { version: 'git version 2.43.0\n', toplevel: `${root}\n`,
      head: 'refs/heads/moe/control\n', target: 'b'.repeat(40), list: listing([root, 'refs/heads/moe/control']) };
    return async (args, cwd, timeout, maxBuffer) => {
      calls.push(args);
      expect([cwd, timeout <= 2000, (maxBuffer ?? Infinity) <= 128 * 1024]).toEqual([root, true, true]);
      const value = overrides[callOf(args)] ?? ready[callOf(args)];
      if (value instanceof Error) throw value;
      return value;
    };
  }
  const withWorktrees = (...paths: string[]) => stubGit({ list: listing([root, 'refs/heads/moe/control'],
    ...paths.map((p): [string, string] => [p, `refs/heads/moe/task/${path.basename(p)}`])) });
  const doctor = (git: PlanPathGitRunner) => runDoctor(testDir, { git, now: NOW });

  it('passes every probe and exits 0 when the project is ready and worktreeMode is on', async () => {
    writeSettings(ON);
    const result = await doctor(stubGit());
    for (const label of ['worktree mode', ...LABELS]) expect(line(result.output, `${label}:`)).toContain('[OK]');
    expect(result.exitCode).toBe(0);
  });

  const failing: Array<[string, Record<string, unknown>, () => Overrides]> = [
    ['worktree git version', ON, () => ({ version: 'git version 2.37.9\n' })],
    ['worktree git version', ON, () => ({ version: gitError('ENOENT') })],
    ['worktree project root', ON, () => ({ toplevel: `${path.dirname(root)}\n` })],
    ['worktree project root', ON, () => ({ toplevel: gitError(128, 'fatal: not a git repository') })],
    ['worktree control branch', ON, () => ({ head: 'refs/heads/main\n' })],
    ['worktree control branch', ON, () => ({ head: gitError(1) })],
    ['worktree target', ON, () => ({ target: gitError(1) })],
    ['worktree target', ON, () => ({ list: listing([root, 'refs/heads/moe/control'], [path.join(root, '..', 'other'), 'refs/heads/main']) })],
    ['worktree target', ON, () => ({ list: listing([root, 'refs/heads/main']) })],
    ['worktree target', ON, () => ({ list: `worktree ${root}\0HEAD ${'a'.repeat(40)}` })],
    ['worktree target', ON, () => ({ list: gitError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER') })],
    ['worktree target', { ...ON, consolidationBranch: 'main~1' }, () => ({})],
    ['worktree quality gate', { worktreeMode: 'on' }, () => ({})],
    ['worktree quality gate', { worktreeMode: 'on', qualityGate: '   ' }, () => ({})],
  ];

  it.each(failing)('with worktreeMode on, a failing %s exits 1 naming the probe (case %#)', async (label, settings, overrides) => {
    writeSettings(settings);
    const result = await doctor(stubGit(overrides()));
    expect(line(result.output, `${label}:`)).toContain('[FAIL]');
    for (const other of LABELS.filter((l) => l !== label)) expect(line(result.output, `${other}:`)).toContain('[OK]');
    expect(result.exitCode).toBe(1);
  });

  it.each([['explicitly off', { worktreeMode: 'off' }], ['absent', {}], ['without settings', undefined]])(
    'with worktreeMode %s, every failing condition is info and the exit code is unaffected', async (_name, settings) => {
      writeSettings(settings);
      writeTask(ID, { id: ID, status: 'DONE', updatedAt: ago(48 * HOUR) });
      const result = await doctor(stubGit({ version: 'git version 2.30.1\n', toplevel: `${path.dirname(root)}\n`,
        head: 'refs/heads/main\n', list: listing([root, 'refs/heads/main'], [path.join(root, '.worktrees', ID)]) }));
      expect(line(result.output, 'worktree mode:')).toContain('[INFO]');
      for (const label of LABELS) expect(line(result.output, `${label}:`)).toMatch(/^\[INFO\] /);
      expect(line(result.output, STALE)).toMatch(/^\[INFO\] .*1 task worktree /);
      expect(result.output.filter((l) => /^\[(FAIL|WARN)\] worktree/.test(l))).toEqual([]);
      expect(result.exitCode).toBe(0);
    });

  it('does not let off-mode worktree probes hide an existing health failure', async () => {
    writeSettings({ worktreeMode: 'off' });
    fs.rmSync(path.join(moePath, 'roles', 'qa.md'));
    expect((await doctor(stubGit())).exitCode).toBe(1);
  });

  it.each([
    ['an invalid worktreeMode', JSON.stringify({ settings: { worktreeMode: 'yes' } })],
    ['malformed project.json', '{"settings": {"worktreeMode": "on", SECRET-7c1'],
    ['non-object settings', JSON.stringify({ settings: 'on' })],
  ])('fails the worktree mode probe on %s instead of defaulting it', async (_name, text) => {
    fs.writeFileSync(path.join(moePath, 'project.json'), text);
    const result = await doctor(stubGit());
    expect(line(result.output, 'worktree mode:')).toContain('[FAIL]');
    expect(result.output.join('\n')).not.toContain('SECRET-7c1');
    expect(result.exitCode).toBe(1);
  });

  it.each([['2.38.0', true], ['2.39.3 (Apple Git-146)', true], ['2.45.1.windows.1', true], ['3.0.0', true],
    ['2.37.99', false], ['1.99.0', false], ['two', false]])('judges git version %s as ready=%s', async (version, ok) => {
    writeSettings(ON);
    const result = await doctor(stubGit({ version: `git version ${version}\n` }));
    expect(line(result.output, 'worktree git version:')).toContain(ok ? '[OK]' : '[FAIL]');
  });

  it.each([['release/2026', 'release/2026'], ['  main  ', 'main'], ['moe/work-*', 'main'], [undefined, 'main']])(
    'resolves consolidationBranch %j to target %s', async (consolidationBranch, target) => {
      writeSettings({ ...ON, consolidationBranch });
      await doctor(stubGit());
      expect(calls.find((c) => callOf(c) === 'target')).toEqual(['rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`]);
    });

  it('runs only bounded read-only Git commands, never the quality gate', async () => {
    writeSettings({ ...ON, qualityGate: 'echo SHOULD-NOT-RUN' });
    const result = await doctor(stubGit());
    expect(calls).toEqual([['version'], ['rev-parse', '--show-toplevel'], ['symbolic-ref', '-q', 'HEAD'],
      ['worktree', 'list', '--porcelain', '-z'], ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']]);
    expect(result.output.join('\n')).not.toContain('SHOULD-NOT-RUN');
  });

  it.each([
    ['DONE for 25h', 'stale', { id: ID, status: 'DONE', updatedAt: ago(25 * HOUR) }],
    ['ARCHIVED for 25h', 'stale', { id: ID, status: 'ARCHIVED', updatedAt: ago(25 * HOUR) }],
    ['DONE for 24h and 1ms', 'stale', { id: ID, status: 'DONE', updatedAt: ago(24 * HOUR + 1) }],
    ['DONE for exactly 24h', 'not', { id: ID, status: 'DONE', updatedAt: ago(24 * HOUR) }],
    ['DONE for 1h', 'not', { id: ID, status: 'DONE', updatedAt: ago(HOUR) }],
    ['DONE in the future', 'not', { id: ID, status: 'DONE', updatedAt: ago(-HOUR) }],
    ['WORKING for 72h', 'not', { id: ID, status: 'WORKING', updatedAt: ago(72 * HOUR) }],
    ['without a task record', 'unknown', null],
    ['with a malformed task record', 'unknown', '{"id": "task-'],
    ['with a mismatched record id', 'unknown', { id: 'task-other', status: 'DONE', updatedAt: ago(48 * HOUR) }],
    ['without updatedAt', 'unknown', { id: ID, status: 'DONE' }],
    ['with an unparseable updatedAt', 'unknown', { id: ID, status: 'DONE', updatedAt: 'yesterday' }],
  ] as const)('a registered .worktrees/<id> whose task is %s is judged %s, never a failure', async (_name, expected, task) => {
    writeSettings(ON);
    if (task !== null) writeTask(ID, task);
    const result = await doctor(withWorktrees(path.join(root, '.worktrees', ID)));
    const want = { stale: /^\[WARN\] .*: 1 task worktree DONE.*task-0123/, not: /^\[OK\] /, unknown: /^\[INFO\] .*age unknown: task-0123/ };
    expect(line(result.output, STALE)).toMatch(want[expected]);
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['nested below .worktrees', () => path.join(root, '.worktrees', 'nested', ID)],
    ['in another project', () => path.join(path.dirname(root), 'elsewhere', '.worktrees', ID)],
    ['in a lookalike directory', () => path.join(root, '.worktrees-old', ID)],
    ['named like a human worktree', () => path.join(root, '.worktrees', 'feature-x')],
    ['the control checkout itself', () => root],
  ])('ignores a registered worktree %s', async (_name, where) => {
    writeSettings(ON);
    for (const id of [ID, 'feature-x']) writeTask(id, { id, status: 'DONE', updatedAt: ago(48 * HOUR) });
    expect(line((await doctor(withWorktrees(where()))).output, STALE)).toMatch(/^\[OK\] /);
  });

  it.skipIf(process.platform === 'win32')('ignores a .worktrees/<id> symlink that escapes the project', async () => {
    writeSettings(ON);
    writeTask(ID, { id: ID, status: 'DONE', updatedAt: ago(48 * HOUR) });
    fs.mkdirSync(path.join(root, '.worktrees', 'out'), { recursive: true });
    fs.symlinkSync(path.join(root, '.worktrees', 'out'), path.join(root, '.worktrees', ID));
    expect(line((await doctor(withWorktrees(path.join(root, '.worktrees', ID)))).output, STALE)).toMatch(/^\[OK\] /);
  });

  it('matches a task worktree listed in another spelling of the project path', async () => {
    writeSettings(ON);
    writeTask(ID, { id: ID, status: 'DONE', updatedAt: ago(48 * HOUR) });
    // Windows git prints forward slashes in either drive case; a WSL path may arrive through its share.
    const flipped = root[0] === root[0].toLowerCase() ? root[0].toUpperCase() : root[0].toLowerCase();
    const listed = process.platform === 'win32' ? `${flipped}${root.slice(1).replace(/\\/g, '/')}/.worktrees/${ID}` : `//wsl$/Ubuntu${root}/.worktrees/${ID}`;
    expect(line((await doctor(withWorktrees(listed))).output, STALE)).toMatch(/^\[WARN\] .*: 1 task worktree DONE/);
  });

  it('skips the stale-worktree probe as info when the listing is unavailable', async () => {
    writeSettings(ON);
    const result = await doctor(stubGit({ list: gitError(129, 'error: unknown switch `z`') }));
    expect(line(result.output, STALE)).toMatch(/^\[INFO\] .*unknown switch/);
  });
});

describe('runDoctor — worktree probes against a real repository', () => {
  let base: string;
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'moe doctor wt ')); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  // The fixture's own Git commands must not inherit a seat's repository, index or config.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const git = (cwd: string, ...args: string[]) => execFileSync('git',
    ['-c', 'user.name=Moe Test', '-c', 'user.email=moe@test.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf-8' });
  const snapshot = (project: string) => [
    ...['.moe/project.json', `.moe/tasks/${ID}.json`, '.git/index', '.git/HEAD'].map((f) =>
      `${f} ${fs.readFileSync(path.join(project, f)).toString('base64')} ${fs.statSync(path.join(project, f)).mtimeMs}`),
    git(project, 'for-each-ref', '--format=%(refname) %(objectname)'), git(project, 'worktree', 'list', '--porcelain')];

  it('finds the target checkout and a stale task worktree without writing anything', async () => {
    const project = path.join(base, 'my project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'init');
    git(project, 'switch', '-q', '-c', 'moe/control');
    git(project, 'worktree', 'add', '-q', '-b', `moe/task/${ID}`, path.join(project, '.worktrees', ID), 'main');
    git(project, 'worktree', 'add', '-q', path.join(base, 'target checkout'), 'main');
    const moe = scaffoldMoe(project);
    fs.writeFileSync(path.join(moe, 'project.json'), JSON.stringify({ settings: ON }));
    fs.mkdirSync(path.join(moe, 'tasks'));
    fs.writeFileSync(path.join(moe, 'tasks', `${ID}.json`), JSON.stringify({ id: ID, status: 'DONE', updatedAt: new Date(Date.now() - 48 * HOUR).toISOString() }));
    const before = snapshot(project);

    const blocked = await runDoctor(project);

    expect(line(blocked.output, 'worktree target:')).toMatch(/^\[FAIL\] .*target main is checked out at .*target checkout/);
    expect(line(blocked.output, STALE)).toMatch(new RegExp(`^\\[WARN\\] .*${ID}`));
    for (const label of LABELS.filter((l) => l !== 'worktree target')) expect(line(blocked.output, `${label}:`)).toContain('[OK]');
    expect(blocked.exitCode).toBe(1);
    expect(snapshot(project)).toEqual(before);

    git(project, 'worktree', 'remove', path.join(base, 'target checkout'));
    const ready = await runDoctor(project);
    expect([line(ready.output, 'worktree target:')?.slice(0, 4), ready.exitCode]).toEqual(['[OK]', 0]);
  });
});

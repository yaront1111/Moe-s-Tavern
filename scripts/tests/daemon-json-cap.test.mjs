import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// .moe/daemon.json is repository content, so both launchers read at most
// 64 KiB + 1 byte of it and treat a larger file like unparseable JSON (the
// same cap as the daemon, proxy, hook and IDE plugins). These run the REAL
// pre-flight daemon-check blocks of moe-agent.sh and moe-agent.ps1 against
// boundary fixtures in a temp directory. The blocks end before the daemon
// start, so no daemon is ever launched. The 'identity:' rows add a fake
// daemon /health: a launcher must never adopt a daemon serving another project.
const launcher = (ext) => fileURLToPath(new URL(`../moe-agent.${ext}`, import.meta.url));
const read = (ext) => readFileSync(launcher(ext), 'utf8').replaceAll('\r\n', '\n');
const sh = read('sh');
const ps = read('ps1');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
// A launcher without the helper fails on behavior, not on a missing anchor;
// the static test requires the helpers.
const optional = (source, start, end) => (source.includes(start) ? between(source, start, end) : '');
// Each boundary carries its leading newline and exact indentation: the same
// text recurs deeper-indented (the FOREIGN branch, the start wait loop).
const SEGMENTS = {
  sh: {
    probe: () => between(sh, '\nprobe_daemon_health() {', '\n# daemon.json is repository content'),
    helper: () => optional(sh, '\ndaemon_json_field() {', '\n# Start daemon if needed'),
    check: () => between(sh, '\n    if [ -f "$DAEMON_INFO" ]; then', '\n    if [ "$RUNNING" = false ]; then'),
  },
  ps1: {
    helper: () => optional(ps, '\nfunction Read-MoeDaemonJsonText(', '\nif (-not $NoStartDaemon) {'),
    check: () => between(ps, '\n    if (Test-Path $daemonInfoPath) {', '\n    if (-not $running) {'),
  },
};
const windows = process.platform === 'win32';
const PYTHON = windows ? 'python' : 'python3';
const fwd = (p) => p.replaceAll('\\', '/');
const shq = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const psq = (v) => `'${String(v).replaceAll("'", "''")}'`;
const OVERSIZE = 'daemon.json is larger than 64 KiB';
const MALFORMED = '{not json';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function probe(exe) {
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
const ENGINES = [
  { name: windows ? 'Git Bash' : 'bash', ext: 'sh', exe: windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', skip: false },
  { name: 'PowerShell 5.1', ext: 'ps1', exe: 'powershell.exe', skip: windows ? (!probe('powershell.exe') && 'powershell.exe not found') : `PowerShell 5.1 is Windows-only; not available on ${process.platform}` },
  { name: 'PowerShell 7', ext: 'ps1', exe: windows ? 'pwsh.exe' : 'pwsh' },
];
ENGINES[2].skip = !probe(ENGINES[2].exe) && `${ENGINES[2].exe} is not available on ${process.platform}`;

// The project each generated script runs as. Git Bash spells PROJECT /c/...
// (the launcher's `cd && pwd`), which cygpath -m turns into C:/...
const PROJECT = { sh: windows ? '/c/moe-id/proj' : '/mnt/c/moe-id/proj', ps1: 'D:\\x\\y' };
// Git Bash's kill -0 cannot see a Windows PID, so the sh fixture has no pid;
// Get-Process finds the test runner's own pid on every OS. The ps1 port is
// reserved and closed (closedPort), never 9876: a live daemon there would be
// judged, while a closed port is 'unknown' and keeps today's verdict.
const INFO = {
  sh: () => ({ port: 9876, startedAt: 'x', projectPath: '/moe-cap/fixture' }),
  ps1: (port) => ({ pid: process.pid, port, startedAt: 'x', projectPath: '/moe-cap/fixture' }),
};
// JSON padded with trailing whitespace to an exact byte length.
function padded(info, bytes) {
  const json = JSON.stringify(info);
  const text = json + ' '.repeat(bytes - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

// The sh PID branch needs a pid kill -0 can see: the generated script writes
// its own $$ over the __PID__ token before the check block runs.
const SHELL_PID = '__PID__';
function shScript(file, project, withPid) {
  return `set -e
RED=''; GREEN=''; YELLOW=''; NC=''
PYTHON_CMD=${PYTHON}; DAEMON_INFO=${shq(fwd(file))}; RUNNING=false; FOREIGN_DAEMON=false
PROJECT=${shq(project)}
is_wsl() { return 1; }
trap 'echo "@@ exit host=[\${MOE_DAEMON_HOST:-}]"' EXIT
${SEGMENTS.sh.probe()}
${SEGMENTS.sh.helper()}
${withPid ? `content=$(cat "$DAEMON_INFO"); printf '%s' "\${content//${SHELL_PID}/$$}" > "$DAEMON_INFO"` : ''}
${SEGMENTS.sh.check()}
echo "@@ port=[$DAEMON_PORT] project=[$DAEMON_PROJECT] running=$RUNNING"
`;
}
// Resolve-Path makes a UNC project's path provider-qualified; Get-Content
// accepted that form, so the bounded read must too.
const PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem::';
function psScript(infoPath, project) {
  return `$ErrorActionPreference = 'Stop'
$daemonInfoPath = ${psq(infoPath)}
$projectPath = ${psq(project)}
$running = $false
${SEGMENTS.ps1.helper()}
${SEGMENTS.ps1.check()}
Write-Output "@@ running=$running port=$($info.port) err=$(if ($Error.Count) { $Error[0].Exception.Message })"
`;
}

// The launcher must never inherit an operator's host override.
const ENV = { ...process.env };
delete ENV.MOE_DAEMON_HOST;
// spawn, not spawnSync: the identity rows answer /health from this process, and
// a blocked event loop would leave every probe to time out as 'unknown'.
function spawnAsync(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: ENV, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
}

// Runs one engine's real block against a daemon.json holding `content`.
async function runCheck(engine, content, { qualified = false, project = PROJECT[engine.ext] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-cap-'));
  try {
    const file = path.join(dir, 'daemon.json');
    writeFileSync(file, content);
    const infoPath = engine.ext === 'sh' ? fwd(file) : (qualified ? PROVIDER + file : file);
    const script = path.join(dir, engine.ext === 'sh' ? 'check.sh' : 'check.ps1');
    writeFileSync(script, engine.ext === 'sh'
      ? shScript(file, project, content.includes(SHELL_PID))
      : `\ufeff${psScript(infoPath, project)}`);
    const args = engine.ext === 'sh'
      ? ['--noprofile', '--norc', fwd(script)]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    const r = await spawnAsync(engine.exe, args);
    const out = r.out.replaceAll('\r\n', '\n').replace(ANSI, '');
    const after = existsSync(file) ? readFileSync(file, 'utf8') : null;
    return { status: r.status, out, lines: out.split('\n'), size: existsSync(file) ? statSync(file).size : -1, after, infoPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
// A port that answers nothing: reserved, then released.
async function closedPort() {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
// A fake daemon /health answering `statusCode` + `body`, recording each request
// so a row proves the launcher asked (and asked nothing else).
async function withHealth(statusCode, body, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await listen(server);
  try {
    return await fn(server.address().port, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
const healthy = (projectPath) => ({ status: 'healthy', version: 'x', pid: 1, uptime: 1, projectPath });
const unhealthy = (projectPath) => ({ status: 'unhealthy', version: 'x', pid: 1, uptime: 1, projectPath });

// The refusal both launchers print, byte for byte.
const REFUSAL_FIXED = [
  'MOE_DAEMON_FOREIGN_PROJECT: the daemon at ',
  ', not this project (',
  " is stale: this project's daemon is not running. Start it (the IDE's Restart Daemon, or moe-daemon start --project ",
  '); it takes the next free port.',
  "Refusing to register, claim or bridge to another project's daemon.",
];
function refusal(port, served, project, infoPath) {
  return [
    `[ERROR] ${REFUSAL_FIXED[0]}127.0.0.1:${port} serves ${served}${REFUSAL_FIXED[1]}${project}).`,
    `${infoPath}${REFUSAL_FIXED[2]}${project}${REFUSAL_FIXED[3]}`,
    REFUSAL_FIXED[4],
  ];
}
function assertRefused(r, port, served, project) {
  assert.equal(r.status, 1, r.out);
  const expected = refusal(port, served, project, r.infoPath);
  assert.deepEqual(r.lines.filter((l) => l.includes('MOE_DAEMON_FOREIGN_PROJECT')), [expected[0]], r.out);
  const at = r.lines.indexOf(expected[0]);
  assert.deepEqual(r.lines.slice(at, at + 3), expected, r.out);
}
const OTHER = 'D:\\projexts\\moes';

test('both launchers bound every daemon.json read and share the oversize message', () => {
  const shHelper = SEGMENTS.sh.helper();
  const psHelper = SEGMENTS.ps1.helper();
  assert.ok(shHelper.includes('read(65537)') && shHelper.includes('>65536'), `sh helper: ${shHelper}`);
  assert.ok(psHelper.includes('byte[] 65537') && psHelper.includes('-gt 65536') && psHelper.includes('Convert-Path -LiteralPath'), `ps1 helper: ${psHelper}`);
  const shRaw = sh.split('\n').filter((l) => l.includes('$PYTHON_CMD -c') && l.includes('DAEMON_INFO'));
  assert.deepEqual(shRaw, [], 'moe-agent.sh still parses daemon.json inline');
  const psRaw = ps.split('\n').filter((l) => l.includes('Get-Content') && l.includes('$daemonInfoPath'));
  assert.deepEqual(psRaw, [], 'moe-agent.ps1 still reads daemon.json with Get-Content');
  assert.ok(sh.includes(OVERSIZE) && ps.includes(OVERSIZE), `both launchers carry '${OVERSIZE}'`);
});

test('identity: both launchers carry the same MOE_DAEMON_FOREIGN_PROJECT refusal', () => {
  for (const [name, source] of [['moe-agent.sh', sh], ['moe-agent.ps1', ps]]) {
    for (const fixed of REFUSAL_FIXED) assert.ok(source.includes(fixed), `${name} lacks: ${fixed}`);
  }
});

for (const engine of ENGINES) {
  const t = (name, fn, skip = engine.skip) => test(`${engine.name}: ${name}`, { skip }, fn);
  if (engine.ext === 'sh') {
    const info = INFO.sh();
    t('a 65536-byte daemon.json is read', async () => {
      const r = await runCheck(engine, padded(info, 65536));
      assert.equal(r.status, 0, r.out);
      assert.ok(!r.out.includes('Failed to parse daemon.json'), r.out);
      assert.ok(r.lines.includes('@@ port=[9876] project=[/moe-cap/fixture] running=false'), r.out);
    });
    t('a 65537-byte daemon.json takes the unparseable path and is kept', async () => {
      const r = await runCheck(engine, padded(info, 65537));
      assert.equal(r.status, 0, r.out);
      assert.ok(r.lines.includes(`[WARN] Failed to parse daemon.json: ${OVERSIZE}`), r.out);
      assert.ok(r.lines.includes('[WARN] Will attempt to start a new daemon'), r.out);
      assert.ok(r.lines.includes('@@ port=[] project=[] running=false'), r.out);
      assert.equal(r.size, 65537);
    });
    t('a malformed daemon.json warns instead of aborting under set -e', async () => {
      const r = await runCheck(engine, MALFORMED);
      assert.equal(r.status, 0, r.out);
      assert.ok(r.out.includes('[WARN] Failed to parse daemon.json: '), r.out);
      assert.ok(!r.out.includes(OVERSIZE), r.out);
      assert.ok(r.lines.includes('@@ port=[] project=[] running=false'), r.out);
    });

    // The Windows-owned daemon.json branch (a drive projectPath read under
    // WSL/Linux) probes candidates over HTTP. Git Bash is OSTYPE msys: never there.
    const foreignSkip = engine.skip || (windows && 'the Windows-owned daemon.json branch never runs under Git Bash (OSTYPE msys)');
    const PX4 = '/mnt/d/projexts/px4swarm';
    const px4Info = (port) => JSON.stringify({ pid: 26004, port, startedAt: 'x', projectPath: 'D:\\projexts\\px4swarm', bindHost: '0.0.0.0' });
    t('identity: a Windows-owned daemon.json whose daemon serves another project is refused, untouched', () =>
      withHealth(200, healthy(OTHER), async (port, requests) => {
        const content = px4Info(port);
        const r = await runCheck(engine, content, { project: PX4 });
        assertRefused(r, port, OTHER, PX4);
        assert.ok(r.lines.includes('@@ exit host=[]'), `MOE_DAEMON_HOST must stay unset:\n${r.out}`);
        assert.ok(!r.out.includes('reachable at'), r.out);
        assert.equal(r.after, content);
        assert.deepEqual(requests, ['GET /health']);
      }), foreignSkip);
    t('identity: a Windows-owned daemon.json whose daemon serves this project in another spelling is adopted', () =>
      withHealth(200, healthy('d:/projexts/px4swarm/'), async (port, requests) => {
        const r = await runCheck(engine, px4Info(port), { project: PX4 });
        assert.equal(r.status, 0, r.out);
        assert.ok(r.lines.includes(`@@ port=[${port}] project=[D:\\projexts\\px4swarm] running=true`), r.out);
        assert.ok(r.lines.includes('@@ exit host=[127.0.0.1]'), r.out);
        assert.deepEqual(requests, ['GET /health']);
      }), foreignSkip);
    t('identity: a Windows-owned daemon.json whose daemon names a relative project is adopted (unknown)', () =>
      withHealth(200, healthy('.'), async (port) => {
        const r = await runCheck(engine, px4Info(port), { project: PX4 });
        assert.equal(r.status, 0, r.out);
        assert.ok(r.lines.includes(`@@ port=[${port}] project=[D:\\projexts\\px4swarm] running=true`), r.out);
      }), foreignSkip);

    // The PID branch: kill -0 proves a process, not which project it serves.
    const pidInfo = (port) => `{"pid":${SHELL_PID},"port":${port},"startedAt":"x","projectPath":"/mnt/c/moe-id/proj"}`;
    const running = (port) => `@@ port=[${port}] project=[/mnt/c/moe-id/proj] running=true`;
    t('identity: a live pid whose daemon serves another project is refused', () =>
      withHealth(200, healthy(OTHER), async (port, requests) => {
        const r = await runCheck(engine, pidInfo(port));
        assertRefused(r, port, OTHER, PROJECT.sh);
        assert.deepEqual(requests, ['GET /health']);
      }));
    t('identity: a live pid whose 503 unhealthy daemon serves another project is refused', () =>
      withHealth(503, unhealthy(OTHER), async (port) => {
        assertRefused(await runCheck(engine, pidInfo(port)), port, OTHER, PROJECT.sh);
      }));
    t('identity: a live pid whose daemon serves this project is adopted', () =>
      withHealth(200, healthy('C:\\moe-id\\proj'), async (port, requests) => {
        const r = await runCheck(engine, pidInfo(port));
        assert.equal(r.status, 0, r.out);
        assert.ok(r.lines.includes(running(port)), r.out);
        assert.deepEqual(requests, ['GET /health']);
      }));
    t('identity: a live pid with an unreachable /health is adopted as today', async () => {
      const port = await closedPort();
      const r = await runCheck(engine, pidInfo(port));
      assert.equal(r.status, 0, r.out);
      assert.ok(r.lines.includes(running(port)), r.out);
    });
    continue;
  }
  t('moe-agent.ps1 parses', () => {
    const r = spawnSync(engine.exe, ['-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psq(launcher('ps1'))}, [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`],
    { encoding: 'utf8', timeout: 60_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  t('a 65536-byte daemon.json is read', async () => {
    const port = await closedPort();
    const r = await runCheck(engine, padded(INFO.ps1(port), 65536));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
  });
  t('a provider-qualified daemon.json path (a UNC project) is read', async () => {
    const port = await closedPort();
    const r = await runCheck(engine, padded(INFO.ps1(port), 65536), { qualified: true });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
  });
  t('a 65537-byte daemon.json takes the unparseable path and is kept', async () => {
    const r = await runCheck(engine, padded(INFO.ps1(await closedPort()), 65537));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes(`@@ running=False port= err=${OVERSIZE}`), r.out);
    assert.equal(r.size, 65537);
  });
  t('a malformed daemon.json takes the unparseable path', async () => {
    const r = await runCheck(engine, MALFORMED);
    assert.equal(r.status, 0, r.out);
    const line = r.lines.find((l) => l.startsWith('@@ running='));
    assert.ok(line?.startsWith('@@ running=False port= err='), r.out);
    assert.ok(!line.includes('larger than'), r.out);
  });

  const psInfo = (port) => JSON.stringify({ pid: process.pid, port, startedAt: 'x', projectPath: PROJECT.ps1 });
  t('identity: a live pid whose daemon serves another project is refused, untouched', () =>
    withHealth(200, healthy(OTHER), async (port, requests) => {
      const content = psInfo(port);
      const r = await runCheck(engine, content);
      assertRefused(r, port, OTHER, PROJECT.ps1);
      assert.ok(!r.out.includes('@@ running='), r.out);
      assert.equal(r.after, content);
      assert.deepEqual(requests, ['GET /health']);
    }));
  t('identity: a live pid whose 503 unhealthy daemon serves another project is refused', () =>
    withHealth(503, unhealthy(OTHER), async (port) => {
      assertRefused(await runCheck(engine, psInfo(port)), port, OTHER, PROJECT.ps1);
    }));
  for (const served of ['D:\\x\\.\\y', 'D:/x/y/', '/mnt/d/x/y', 'd:\\X\\y']) {
    t(`identity: a live pid whose daemon serves this project as ${served} is adopted`, () =>
      withHealth(200, healthy(served), async (port, requests) => {
        const r = await runCheck(engine, psInfo(port));
        assert.equal(r.status, 0, r.out);
        assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
        assert.deepEqual(requests, ['GET /health']);
      }));
  }
  t('identity: a live pid whose daemon names a relative project is adopted (unknown)', () =>
    withHealth(200, healthy('.'), async (port) => {
      const r = await runCheck(engine, psInfo(port));
      assert.equal(r.status, 0, r.out);
      assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
    }));
  t('identity: a live pid with an unreachable /health is adopted as today', async () => {
    const port = await closedPort();
    const r = await runCheck(engine, psInfo(port));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
  });
  // Resolve-Path gives a UNC project provider-qualified; the probe judges the bare path.
  const unc = `${PROVIDER}\\\\srv\\share\\proj`;
  t('identity: a UNC project whose daemon serves another project is refused', () =>
    withHealth(200, healthy(OTHER), async (port) => {
      assertRefused(await runCheck(engine, psInfo(port), { project: unc }), port, OTHER, unc);
    }));
  t('identity: a UNC project whose daemon serves it as //srv/share/proj/ is adopted', () =>
    withHealth(200, healthy('//srv/share/proj/'), async (port, requests) => {
      const r = await runCheck(engine, psInfo(port), { project: unc });
      assert.equal(r.status, 0, r.out);
      assert.ok(r.lines.includes(`@@ running=True port=${port} err=`), r.out);
      assert.deepEqual(requests, ['GET /health']);
    }));
}

test('CI runs this suite on Linux and Windows', () => {
  const file = 'scripts/tests/daemon-json-cap.test.mjs';
  const lines = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const token = new RegExp(`^\\s*run:\\s+node --test\\b.*\\s${file.replace(/[.]/g, '\\.')}(?:\\s|$)`);
  const run = lines.findIndex((line) => token.test(line));
  assert.ok(run >= 0, `ci.yml has no \`run: node --test\` step listing ${file}`);
  let name = run;
  while (name >= 0 && !/^\s*-\s+name:/.test(lines[name])) name--;
  assert.ok(name >= 0, `the ${file} step has no \`- name:\` line`);
  const guards = lines.slice(name, run).filter((line) => /^\s+if:/.test(line));
  assert.ok(guards.length <= 1, `the ${file} step has several if: lines`);
  assert.ok(guards.length === 0 || guards[0].trim() === "if: runner.os != 'macOS'",
    `the ${file} step must run on Linux and Windows, got: ${guards[0]}`);
  let job = run;
  while (job >= 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[job])) job--;
  assert.equal(lines[job]?.trim(), 'build-all-platforms:', `the ${file} step must sit in build-all-platforms`);
});

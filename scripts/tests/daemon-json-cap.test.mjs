import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// .moe/daemon.json is repository content, so both launchers read at most
// 64 KiB + 1 byte of it and treat a larger file like unparseable JSON (the
// same cap as the daemon, proxy, hook and IDE plugins). These run the REAL
// pre-flight daemon-check blocks of moe-agent.sh and moe-agent.ps1 against
// boundary fixtures in a temp directory. The blocks end before the daemon
// start, so no daemon is ever launched.
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

// Git Bash's kill -0 cannot see a Windows PID, so the sh fixture has no pid;
// Get-Process finds the test runner's own pid on every OS.
const INFO = {
  sh: { port: 9876, startedAt: 'x', projectPath: '/moe-cap/fixture' },
  ps1: { pid: process.pid, port: 9876, startedAt: 'x', projectPath: '/moe-cap/fixture' },
};
// JSON padded with trailing whitespace to an exact byte length.
function padded(info, bytes) {
  const json = JSON.stringify(info);
  const text = json + ' '.repeat(bytes - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

function shScript(file) {
  return `set -e
RED=''; GREEN=''; YELLOW=''; NC=''
PYTHON_CMD=${PYTHON}; DAEMON_INFO=${shq(fwd(file))}; RUNNING=false; FOREIGN_DAEMON=false
${SEGMENTS.sh.helper()}
${SEGMENTS.sh.check()}
echo "@@ port=[$DAEMON_PORT] project=[$DAEMON_PROJECT] running=$RUNNING"
`;
}
// Resolve-Path makes a UNC project's path provider-qualified; Get-Content
// accepted that form, so the bounded read must too.
const PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem::';
function psScript(file, qualified) {
  return `$ErrorActionPreference = 'Stop'
$daemonInfoPath = ${psq(qualified ? PROVIDER + file : file)}
$running = $false
${SEGMENTS.ps1.helper()}
${SEGMENTS.ps1.check()}
Write-Output "@@ running=$running port=$($info.port) err=$(if ($Error.Count) { $Error[0].Exception.Message })"
`;
}
// Runs one engine's real block against a daemon.json holding `content`.
function runCheck(engine, content, qualified = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-cap-'));
  try {
    const file = path.join(dir, 'daemon.json');
    writeFileSync(file, content);
    const script = path.join(dir, engine.ext === 'sh' ? 'check.sh' : 'check.ps1');
    writeFileSync(script, engine.ext === 'sh' ? shScript(file) : `\ufeff${psScript(file, qualified)}`);
    const args = engine.ext === 'sh'
      ? ['--noprofile', '--norc', fwd(script)]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    const r = spawnSync(engine.exe, args, { encoding: 'utf8', timeout: 60_000 });
    assert.ifError(r.error);
    const out = `${r.stdout}${r.stderr}`.replaceAll('\r\n', '\n');
    return { status: r.status, out, lines: out.split('\n'), size: existsSync(file) ? statSync(file).size : -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

for (const engine of ENGINES) {
  const t = (name, fn) => test(`${engine.name}: ${name}`, { skip: engine.skip }, fn);
  const info = INFO[engine.ext];
  if (engine.ext === 'sh') {
    t('a 65536-byte daemon.json is read', () => {
      const r = runCheck(engine, padded(info, 65536));
      assert.equal(r.status, 0, r.out);
      assert.ok(!r.out.includes('Failed to parse daemon.json'), r.out);
      assert.ok(r.lines.includes('@@ port=[9876] project=[/moe-cap/fixture] running=false'), r.out);
    });
    t('a 65537-byte daemon.json takes the unparseable path and is kept', () => {
      const r = runCheck(engine, padded(info, 65537));
      assert.equal(r.status, 0, r.out);
      assert.ok(r.lines.includes(`[WARN] Failed to parse daemon.json: ${OVERSIZE}`), r.out);
      assert.ok(r.lines.includes('[WARN] Will attempt to start a new daemon'), r.out);
      assert.ok(r.lines.includes('@@ port=[] project=[] running=false'), r.out);
      assert.equal(r.size, 65537);
    });
    t('a malformed daemon.json warns instead of aborting under set -e', () => {
      const r = runCheck(engine, MALFORMED);
      assert.equal(r.status, 0, r.out);
      assert.ok(r.out.includes('[WARN] Failed to parse daemon.json: '), r.out);
      assert.ok(!r.out.includes(OVERSIZE), r.out);
      assert.ok(r.lines.includes('@@ port=[] project=[] running=false'), r.out);
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
  t('a 65536-byte daemon.json is read', () => {
    const r = runCheck(engine, padded(info, 65536));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes('@@ running=True port=9876 err='), r.out);
  });
  t('a provider-qualified daemon.json path (a UNC project) is read', () => {
    const r = runCheck(engine, padded(info, 65536), true);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes('@@ running=True port=9876 err='), r.out);
  });
  t('a 65537-byte daemon.json takes the unparseable path and is kept', () => {
    const r = runCheck(engine, padded(info, 65537));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.lines.includes(`@@ running=False port= err=${OVERSIZE}`), r.out);
    assert.equal(r.size, 65537);
  });
  t('a malformed daemon.json takes the unparseable path', () => {
    const r = runCheck(engine, MALFORMED);
    assert.equal(r.status, 0, r.out);
    const line = r.lines.find((l) => l.startsWith('@@ running='));
    assert.ok(line?.startsWith('@@ running=False port= err='), r.out);
    assert.ok(!line.includes('larger than'), r.out);
  });
}

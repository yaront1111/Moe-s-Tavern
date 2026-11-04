import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercise the real pre-flight blocks, not a replica or the task-worktree mirror.
const windows = process.platform === 'win32';
const fwd = (p) => p.replaceAll('\\', '/');
const shq = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
const psq = (v) => "'" + String(v).replaceAll("'", "''") + "'";
// pwsh 7's ConciseView colours an error record and wraps it at the console width
// behind a "     | " gutter (CI run 41830422144 split "...one.md' is" / "| denied."),
// and Windows PowerShell 5.1 wraps before a long path: match error text on plain().
const ANSI = /\x1B\[[0-9;?]*[A-Za-z]/g;
const plain = (out) => out.replace(ANSI, '').replace(/\r?\n[ \t]*\|?[ \t]*/g, ' ').replace(/\s+/g, ' ');
const DENIED = { sh: /Permission denied/, ps1: /Access to the path '.+' is denied\./ };
const wrapper = (ext) => fileURLToPath(new URL('../moe-agent.' + ext, import.meta.url));
const read = (ext) => readFileSync(wrapper(ext), 'utf8').replace(/^\ufeff/, '').replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'missing boundaries: ' + start + ' / ' + end);
  assert.equal(source.indexOf(start, from + start.length), -1, 'unique start anchor');
  return source.slice(from, to);
}
const anchor = "# Mirror .moe/agents/<name>.md to .claude/agents/<name>.md so Claude Code's";
const slices = {
  sh: between(read('sh'), anchor, '\nLOOP_ENABLED=false'),
  ps1: between(read('ps1'), anchor, '# Normalize Command + CommandArgs'),
};
assert.ok(slices.sh.includes('cp "$src"'), 'bash slice must contain the copy');
assert.ok(slices.ps1.includes('Copy-Item'), 'PowerShell slice must contain the copy');

function probe(exe) {
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
const ENGINES = [
  { name: windows ? 'Git Bash' : 'bash', ext: 'sh', exe: windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', skip: false },
  { name: 'PowerShell 5.1', ext: 'ps1', exe: 'powershell.exe', skip: windows ? (!probe('powershell.exe') && 'powershell.exe not found') : 'PowerShell 5.1 is Windows-only; not available on ' + process.platform },
  { name: 'PowerShell 7', ext: 'ps1', exe: windows ? 'pwsh.exe' : 'pwsh' },
];
ENGINES[2].skip = !probe(ENGINES[2].exe) && ENGINES[2].exe + ' is not available on ' + process.platform;

function withFixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-mirror-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
function seed(project, names = ['one', 'two']) {
  const dir = path.join(project, '.moe', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(path.join(dir, name + '.md'), (name + ': agent instructions\n').repeat(256));
}
function assertCopies(project, names = ['one', 'two']) {
  for (const name of names) {
    assert.deepEqual(readFileSync(path.join(project, '.claude', 'agents', name + '.md')),
      readFileSync(path.join(project, '.moe', 'agents', name + '.md')), name + ': mirrored bytes');
  }
}
function childEnv(log) {
  const env = { ...process.env, MIRROR_RACE_LOG: fwd(log) };
  delete env.MOE_WORKER_ID; delete env.MOE_PROJECT_PATH; delete env.MOE_SESSION_ID;
  return env;
}
function execute(engine, script, log, timeout = 60_000) {
  const args = engine.ext === 'sh' ? ['--noprofile', '--norc', fwd(script)]
    : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  const r = spawnSync(engine.exe, args, { encoding: 'utf8', timeout, env: childEnv(log) });
  assert.ifError(r.error);
  return { ...r, out: (r.stdout + r.stderr).replaceAll('\r\n', '\n') };
}
function shInjection(race) {
  return [
    'cp() {',
    '  if [ "$#" -eq 2 ] && [[ "$2" == */one.md ]]; then',
    race ? '    command cp "$1" "$2" || return $?; printf "race\\n" >> "$MIRROR_RACE_LOG"' : '    :',
    '    printf "cp: cannot create regular file \'%s\': ' + (race ? 'File exists' : 'Permission denied') + '\\n" "$2" >&2',
    '    return 1',
    '  fi',
    '  command cp "$@"',
    '}',
  ].join('\n');
}
function psInjection(race) {
  return [
    'function Copy-Item {',
    '  param([string]$Path, [string]$LiteralPath, [string]$Destination, [switch]$Force)',
    '  $source = if ($LiteralPath) { $LiteralPath } else { $Path }',
    "  if ((Split-Path -Leaf $source) -eq 'one.md') {",
    race ? '    Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $source -Destination $Destination -Force\n    Add-Content -LiteralPath $env:MIRROR_RACE_LOG -Value race' : '',
    race ? '    throw [System.IO.IOException]::new("The process cannot access the file \'$Destination\' because it is being used by another process.")'
      : '    throw [System.UnauthorizedAccessException]::new("Access to the path \'$Destination\' is denied.")',
    '  }',
    '  Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $source -Destination $Destination -Force',
    '}',
  ].join('\n');
}
function shScript(project, injection = '') {
  return [
    'set -e',
    "GREEN=''; NC=''; RED=''; YELLOW=''; ENABLE_AGENT_TEAMS=true",
    'PROJECT=' + project + '; MOE_DIR="$PROJECT/.moe"',
    injection, slices.sh, "echo '@@ after mirror'", '',
  ].join('\n');
}
function psScript(project, injection) {
  return [
    "\ufeff$ErrorActionPreference = 'Stop'",
    '$enableAgentTeams = $true; $projectPath = ' + psq(project) + "; $moeDir = Join-Path $projectPath '.moe'",
    injection, slices.ps1, "Write-Output '@@ after mirror'", '',
  ].join('\n');
}
function injectedRun(engine, dir, race) {
  const project = path.join(dir, 'project');
  const script = path.join(dir, 'seat.' + engine.ext);
  const log = path.join(dir, 'race.log');
  seed(project);
  writeFileSync(log, '');
  writeFileSync(script, engine.ext === 'sh'
    ? shScript(shq(fwd(project)), shInjection(race)) : psScript(project, psInjection(race)));
  return { ...execute(engine, script, log), project, log };
}

// The parent only ever signals the two PIDs it launched. Every ready/go/done
// spin has a ten-second deadline; the node driver also has a 120-second timeout.
const barrier = [
  'trap \'rc=$?; printf "%s\\n" "$rc" > "$4"\' EXIT',
  ': > "$2"',
  'deadline=$((SECONDS + 10))',
  'until [ -e "$3" ]; do',
  '  if [ "$SECONDS" -ge "$deadline" ]; then echo "go barrier timeout" >&2; exit 1; fi',
  '  sleep 0.01',
  'done',
].join('\n');
function concurrencyDriver(dir, seat) {
  return [
    'set -e', 'cd ' + shq(fwd(dir)), "p1=''; p2=''",
    'cleanup() {',
    '  if [ -n "$p1" ]; then kill "$p1" 2>/dev/null || :; wait "$p1" 2>/dev/null || :; fi',
    '  if [ -n "$p2" ]; then kill "$p2" 2>/dev/null || :; wait "$p2" 2>/dev/null || :; fi',
    '}', 'trap cleanup EXIT', "trap 'exit 1' TERM INT",
    'await_pair() {',
    '  deadline=$((SECONDS + 10))',
    '  until [ -e "$1" ] && [ -e "$2" ]; do',
    '    if [ "$SECONDS" -ge "$deadline" ]; then echo "pair barrier timeout" >&2; exit 1; fi',
    '    sleep 0.01',
    '  done',
    '}',
    'failed=0',
    'for round in {1..30}; do',
    '  project="$PWD/round-$round"',
    '  bash --noprofile --norc ' + shq(fwd(seat)) + ' "$project" "$project/ready-1" "$project/go" "$project/done-1" > "$project/out-1" 2>&1 & p1=$!',
    '  bash --noprofile --norc ' + shq(fwd(seat)) + ' "$project" "$project/ready-2" "$project/go" "$project/done-2" > "$project/out-2" 2>&1 & p2=$!',
    '  await_pair "$project/ready-1" "$project/ready-2"',
    '  : > "$project/go"',
    '  await_pair "$project/done-1" "$project/done-2"',
    '  if wait "$p1"; then :; else failed=1; fi; p1=\'\'',
    '  if wait "$p2"; then :; else failed=1; fi; p2=\'\'',
    '  for n in 1 2; do',
    '    echo "round=$round seat=$n exit=$(cat "$project/done-$n")"',
    '    cat "$project/out-$n"',
    '    grep -q "Subagents: mirrored " "$project/out-$n" || failed=1',
    '    grep -q "@@ after mirror" "$project/out-$n" || failed=1',
    '  done',
    'done',
    'exit "$failed"', '',
  ].join('\n');
}
function concurrentRun(engine, dir) {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let round = 1; round <= 30; round++) seed(path.join(dir, 'round-' + round), names);
  const seat = path.join(dir, 'seat.sh');
  const driver = path.join(dir, 'driver.sh');
  writeFileSync(seat, shScript('"$1"', barrier));
  writeFileSync(driver, concurrencyDriver(dir, seat));
  const r = execute(engine, driver, path.join(dir, 'unused.log'), 120_000);
  assert.equal(r.status, 0, r.out);
  assert.equal([...r.out.matchAll(/round=\d+ seat=[12] exit=0/g)].length, 60, r.out);
  for (let round = 1; round <= 30; round++) assertCopies(path.join(dir, 'round-' + round), names);
}

for (const engine of ENGINES) {
  const t = (name, fn) => test(engine.name + ': ' + name, { skip: engine.skip }, fn);
  t('A: a copy that loses the race to another seat counts as kept', () => withFixture((dir) => {
    const r = injectedRun(engine, dir, true);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('Subagents: mirrored 1, kept 1 existing (.moe/agents/ -> .claude/agents/)'), r.out);
    assert.match(r.out, /@@ after mirror/);
    assert.deepEqual(readFileSync(r.log, 'utf8').trim().split(/\r?\n/), ['race']);
    assertCopies(r.project);
  }));
  t('B: any other copy failure still stops the pre-flight', () => withFixture((dir) => {
    const r = injectedRun(engine, dir, false);
    assert.notEqual(r.status, 0, r.out);
    const text = plain(r.out);
    assert.match(text, DENIED[engine.ext]);
    assert.doesNotMatch(text, /@@ after mirror/);
    assert.equal(existsSync(path.join(r.project, '.claude', 'agents', 'one.md')), false);
  }));
  if (engine.ext === 'sh') {
    t('C: two seats mirroring at the same moment both pass', () => withFixture((dir) => concurrentRun(engine, dir)));
  }
  t('D: the wrapper parses', () => {
    const args = engine.ext === 'sh' ? ['-n', fwd(wrapper('sh'))]
      : ['-NoProfile', '-NonInteractive', '-Command',
        '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(' + psq(wrapper('ps1')) + ', [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count'];
    const r = spawnSync(engine.exe, args, { encoding: 'utf8', timeout: 60_000, env: childEnv('') });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}

// Verbatim from CI run 41830422144 (windows-latest, pwsh 7): the input B's old /is denied/ failed on.
const CI_PWSH7 = '\x1B[31;1mGet-ChildItem: \x1B[0mC:\\Users\\runneradmin\\AppData\\Local\\Temp\\moe-mirror-vTPP70\\seat.ps1:25\x1B[0m\n'
  + '\x1B[31;1m\x1B[0m\x1B[36;1mLine |\x1B[0m\n'
  + '\x1B[31;1m\x1B[0m\x1B[36;1m\x1B[36;1m  25 | \x1B[0m         \x1B[36;1mGet-ChildItem -LiteralPath $moeAgentsDir -File -Filter "*.md"\x1B[0m \u2026\x1B[0m\n'
  + '\x1B[31;1m\x1B[0m\x1B[36;1m\x1B[36;1m\x1B[0m\x1B[36;1m\x1B[0m\x1B[36;1m     | \x1B[31;1m         ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\x1B[0m\n'
  + "\x1B[31;1m\x1B[0m\x1B[36;1m\x1B[36;1m\x1B[0m\x1B[36;1m\x1B[0m\x1B[36;1m\x1B[31;1m\x1B[31;1m\x1B[36;1m     | \x1B[31;1mAccess to the path 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\moe-mirror-vTPP70\\project\\.claude\\agents\\one.md' is\x1B[0m\n"
  + '\x1B[31;1m\x1B[0m\x1B[36;1m\x1B[36;1m\x1B[0m\x1B[36;1m\x1B[0m\x1B[36;1m\x1B[31;1m\x1B[31;1m\x1B[36;1m\x1B[31;1m\x1B[36;1m     | \x1B[31;1mdenied.\x1B[0m\n';
test('PowerShell 7 ConciseView: the wrapped CI error matches B only after plain()', () => {
  assert.doesNotMatch(CI_PWSH7, /is denied/);
  assert.doesNotMatch(CI_PWSH7, DENIED.ps1);
  const text = plain(CI_PWSH7);
  assert.match(text, DENIED.ps1);
  assert.ok(text.includes("Access to the path 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\moe-mirror-vTPP70\\project\\.claude\\agents\\one.md' is denied."), text);
});

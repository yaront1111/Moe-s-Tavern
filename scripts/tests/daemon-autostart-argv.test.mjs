import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Start-Process -ArgumentList (PowerShell 5.1 and 7) joins its entries with
// single spaces and quotes none of them, so moe-agent.ps1's daemon autostart
// split the project "control é [x] $;'" into --project <root>\control, é, [x],
// $;' and the launcher timed out with 'Daemon failed to start within 10s'
// (task-8c875cc8). Row A runs the autostart's Start-Process statement, lifted
// from moe-agent.ps1 by the PowerShell AST, on the literal fixture name; row B
// runs the real launcher under spaced project and daemon-script paths. Each
// fake daemon records the argv node gave it. Row C runs row A's driver on
// copies of moe-agent.ps1 with that statement removed and duplicated.
const windows = process.platform === 'win32';
const PS1 = fileURLToPath(new URL('../moe-agent.ps1', import.meta.url));
const LITERAL = "control é [x] $;'";
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const DRIVER_CAP_MS = 60_000;
const RECORD_WAIT_MS = 20_000;
const LAUNCHER_CAP_MS = 90_000;

function pwshPath() {
  const r = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}
const ENGINES = [];
if (!windows) {
  const skip = 'Start-Process builds a native Windows command line; run this file with Windows node (node.exe from WSL)';
  ENGINES.push({ name: 'PowerShell 5.1', skip }, { name: 'PowerShell 7', skip });
} else {
  ENGINES.push({ name: 'PowerShell 5.1', exe: path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') });
  const pwsh = pwshPath();
  ENGINES.push(pwsh ? { name: 'PowerShell 7', exe: pwsh } : { name: 'PowerShell 7', skip: 'pwsh.exe not found' });
}

const FAKE_DAEMON = `const fs = require('fs'), path = require('path');
fs.writeFileSync(process.env.FAKE_DAEMON_RECORD, JSON.stringify(process.argv.slice(1)));
const project = process.argv[process.argv.indexOf('--project') + 1];
// process.ppid is the launcher, which outlives the start poll that probes this pid.
if (project && fs.existsSync(path.join(project, '.moe'))) fs.writeFileSync(path.join(project, '.moe', 'daemon.json'), JSON.stringify({ pid: process.ppid, port: 1, projectPath: project }));
`;

// Finds the one daemon-autostart Start-Process: the call that runs
// $daemonScript with the literals start and --project. --project alone is not
// enough, since the CQ-M07s check dispatch passes it too (task-e5211efd).
// Defines the wrapper functions that statement calls, then runs the statement
// once per case with that case's $daemonScript and $projectPath.
const AUTOSTART_COUNT = 'expected exactly one daemon-autostart Start-Process in moe-agent.ps1, found';
const DRIVER = `param([string]$Wrapper, [string]$Cases)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Wrapper, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "moe-agent.ps1 does not parse: $($errors[0].Message)" }
$calls = @($ast.FindAll({ param($n)
    if (-not ($n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Start-Process')) { return $false }
    $vars = @($n.FindAll({ param($x) $x -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object { $_.VariablePath.UserPath })
    $strs = @($n.FindAll({ param($x) $x -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
    ($vars -contains 'daemonScript') -and ($strs -contains 'start') -and ($strs -contains '--project')
}, $true))
if ($calls.Count -ne 1) { throw "${AUTOSTART_COUNT} $($calls.Count)" }
$call = $calls[0]
$names = @($call.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
foreach ($f in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true))) {
    . ([scriptblock]::Create($f.Extent.Text))
}
foreach ($case in ([IO.File]::ReadAllText($Cases) | ConvertFrom-Json)) {
    $env:FAKE_DAEMON_RECORD = $case.record
    $daemonScript = $case.script
    $projectPath = $case.project
    . ([scriptblock]::Create($call.Extent.Text))
}
`;

function fixtureRoot(t) {
  // Native realpath expands 8.3 names (RUNNER~1), so argv compares exactly.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-autostart-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  for (const d of ['home', 'tmp']) fs.mkdirSync(path.join(root, d));
  return root;
}
function writeFakeDaemon(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fake-daemon.cjs');
  fs.writeFileSync(file, FAKE_DAEMON);
  return file;
}
// No agent CLI, git or other engine's modules reachable; node stays on PATH so
// `Start-Process -FilePath "node"` resolves.
function childEnv(root, extra = {}) {
  const drop = /^(MOE_|FAKE_|CLAUDE|CODEX|GEMINI|GROK|XAI|GIT_)/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k) && !/^(PATH|PSModulePath)$/i.test(k)));
  env.PATH = [path.dirname(process.execPath), path.join(SYSROOT, 'System32'), SYSROOT].join(';');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  return Object.assign(env, { HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp }, extra);
}
function killTree(child) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
// Runs one engine process; stops its tree (that recorded PID only) when the
// output shows a stop marker or at the cap. A spawn error resolves, not hangs.
function run(exe, args, { cwd, env, capMs, stopOn = [] }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', stopped = false, spawnError = null;
    const child = spawn(exe, args, { cwd, env, windowsHide: true });
    const stop = () => { if (!stopped) { stopped = true; killTree(child); } };
    const timer = setTimeout(stop, capMs);
    const seen = () => { if (stopOn.some((m) => (stdout + stderr).includes(m))) stop(); };
    child.on('error', (e) => { spawnError = e; });
    child.stdout.on('data', (d) => { stdout += d; seen(); });
    child.stderr.on('data', (d) => { stderr += d; seen(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stopped, spawnError, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') });
    });
  });
}
// pwsh 7's ConciseView colours an error and wraps it at the console width
// behind a "     | " gutter; match error text after plain() (subagent-mirror.test.mjs).
const plain = (out) => out.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n[ \t]*\|?[ \t]*/g, ' ').replace(/\s+/g, ' ');
const show = (r) => `exit ${r.code}${r.stopped ? ' (stopped)' : ''}${r.spawnError ? ` spawn error: ${r.spawnError.message}` : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
async function waitForFiles(files, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !files.every((f) => fs.existsSync(f))) await new Promise((r) => setTimeout(r, 200));
}
const readRecord = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

for (const engine of ENGINES) {
  const opts = { skip: engine.skip };

  test(`${engine.name}: the daemon-autostart Start-Process passes literal-name paths as whole arguments`, opts, async (t) => {
    const root = fixtureRoot(t);
    const cases = [
      // The literal fixture name in both the daemon-script path and the project.
      { script: writeFakeDaemon(path.join(root, LITERAL)), project: path.join(root, LITERAL), record: path.join(root, 'record-1.json') },
      // Spaces, double quotes and a trailing backslash (a drive root such as C:\ is a real project path).
      { script: writeFakeDaemon(path.join(root, 'plain')), project: path.join(root, 'a "b" c') + path.sep, record: path.join(root, 'record-2.json') },
    ];
    const casesFile = path.join(root, 'cases.json');
    fs.writeFileSync(casesFile, JSON.stringify(cases), 'utf8');
    const driver = path.join(root, 'driver.ps1');
    fs.writeFileSync(driver, '\ufeff' + DRIVER, 'utf8');
    const r = await run(engine.exe, [...PS_ARGS, driver, '-Wrapper', PS1, '-Cases', casesFile], { cwd: root, env: childEnv(root), capMs: DRIVER_CAP_MS });
    assert.equal(r.spawnError, null, show(r));
    assert.equal(r.code, 0, `the driver failed\n${show(r)}`);
    await waitForFiles(cases.map((c) => c.record), RECORD_WAIT_MS);
    // One comparison over every case, so a failure shows each case's argv.
    const actual = cases.map((c) => (fs.existsSync(c.record) ? readRecord(c.record) : `node never ran the daemon script: its path was split (${c.script})`));
    assert.deepEqual(actual, cases.map((c) => [c.script, 'start', '--project', c.project]), 'a daemon-script or project argument was split');
  });

  test(`${engine.name}: the launcher autostarts the daemon under spaced project and daemon-script paths`, opts, async (t) => {
    const root = fixtureRoot(t);
    // Bracket-free: the target's path cmdlets read [x] as a wildcard until task-3ad573a7 lands.
    const project = path.join(root, "control é $;'");
    fs.mkdirSync(path.join(project, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(project, '.moe', 'project.json'), '{"id":"proj-argv","name":"argv","settings":{"autoCommit":false}}');
    const script = writeFakeDaemon(path.join(root, "daemon é $;' dir"));
    const proxyStub = path.join(root, 'proxy-stub.cjs');
    fs.writeFileSync(proxyStub, '// inert proxy: the row stops at the daemon autostart\n');
    const record = path.join(root, 'wrapper-argv.json');
    const env = childEnv(root, {
      MOE_DAEMON_PATH: script, MOE_PROXY_PATH: proxyStub, MOE_DISABLE_HEARTBEAT: '1', MOE_ACCOUNT_ROTATION: 'off',
      // The suite may run from a task worktree (task-86431c31).
      MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER: '1', FAKE_DAEMON_RECORD: record,
    });
    const args = [...PS_ARGS, PS1, '-Project', project, '-WorkerId', 'worker-autostart-argv', '-Role', 'worker', '-NoLoop'];
    const r = await run(engine.exe, args, { cwd: root, env, capMs: LAUNCHER_CAP_MS, stopOn: ['Daemon started (waited', 'Daemon failed to start within'] });
    assert.equal(r.spawnError, null, show(r));
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /Daemon started \(waited/, `the launcher did not see the daemon start\n${show(r)}`);
    assert.doesNotMatch(out, /Daemon failed to start/, show(r));
    assert.ok(fs.existsSync(record), `node never ran the daemon script: its path was split (${script})\n${show(r)}`);
    assert.deepEqual(readRecord(record), [script, 'start', '--project', project], `the project argument was split\n${show(r)}`);
  });

  // The exactly-one guard: copies of moe-agent.ps1 (BOM and line endings kept)
  // with the autostart line removed, then duplicated, must each stop the driver.
  test(`${engine.name}: the driver refuses a wrapper whose daemon autostart is missing or duplicated`, opts, async (t) => {
    const root = fixtureRoot(t);
    const lines = fs.readFileSync(PS1, 'utf8').split('\n');
    const at = lines.flatMap((l, i) => (/\bStart-Process\b.*\$daemonScript\b/.test(l) ? [i] : []));
    assert.equal(at.length, 1, `expected one daemon-autostart line in moe-agent.ps1 to mutate, found ${at.length}`);
    const casesFile = path.join(root, 'cases.json');
    fs.writeFileSync(casesFile, '[]', 'utf8');
    const driver = path.join(root, 'driver.ps1');
    fs.writeFileSync(driver, '\u{feff}' + DRIVER, 'utf8');
    for (const [name, found, mutant] of [['removed', 0, lines.toSpliced(at[0], 1)], ['duplicated', 2, lines.toSpliced(at[0], 0, lines[at[0]])]]) {
      const wrapper = path.join(root, `moe-agent-${name}.ps1`);
      fs.writeFileSync(wrapper, mutant.join('\n'), 'utf8');
      const r = await run(engine.exe, [...PS_ARGS, driver, '-Wrapper', wrapper, '-Cases', casesFile], { cwd: root, env: childEnv(root), capMs: DRIVER_CAP_MS });
      assert.equal(r.spawnError, null, show(r));
      assert.notEqual(r.code, 0, `the driver accepted a wrapper with its daemon autostart ${name}\n${show(r)}`);
      assert.ok(plain(r.stderr).includes(`${AUTOSTART_COUNT} ${found}`), `the ${name} copy did not stop at the count check\n${show(r)}`);
      t.diagnostic(`autostart ${name}: ${AUTOSTART_COUNT} ${found}`);
    }
  });
}

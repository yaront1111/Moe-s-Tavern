import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// moe-team.ps1 handed each role's command to `Start-Process powershell -Command`.
// Start-Process joins -ArgumentList with spaces and quotes nothing, and the
// child's argv parser drops embedded double quotes, so a spaced project, team or
// scripts dir was split across moe-agent.ps1's positional parameters
// (task-c4f17045: team "Moe Team" bound Team=Moe, ProjectName=Team). Each row
// runs a copy of the real moe-team.ps1 next to a fake moe-agent.ps1 (the real
// param block, lifted by the PowerShell AST, plus a recorder). The driver's
// Start-Process function shadows the cmdlet: it swaps -NoExit for -NoProfile
// -NonInteractive and adds -Wait -NoNewWindow, so no window opens and each
// child finishes before moe-team.ps1 moves on.
const windows = process.platform === 'win32';
const TEAM = fileURLToPath(new URL('../moe-team.ps1', import.meta.url));
const AGENT = fileURLToPath(new URL('../moe-agent.ps1', import.meta.url));
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const CAP_MS = 120_000;

function pwshPath() {
  const r = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}
const ENGINES = [];
if (!windows) {
  const skip = 'Windows only: moe-team.ps1 starts powershell.exe windows; run this file with Windows node (node.exe from WSL)';
  ENGINES.push({ name: 'PowerShell 5.1', skip }, { name: 'PowerShell 7', skip });
} else {
  ENGINES.push({ name: 'PowerShell 5.1', exe: path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') });
  const pwsh = pwshPath();
  ENGINES.push(pwsh ? { name: 'PowerShell 7', exe: pwsh } : { name: 'PowerShell 7', skip: 'pwsh.exe not found' });
}

// Appended to moe-agent.ps1's real param block: one JSON record per child.
const RECORDER = `
$bound = [ordered]@{}
foreach ($k in $PSBoundParameters.Keys) { $bound[$k] = $PSBoundParameters[$k] }
$record = [ordered]@{ bound = $bound; unbound = @($args); cwd = (Get-Location -PSProvider FileSystem).ProviderPath }
[IO.File]::WriteAllText([IO.Path]::Combine($env:TEAM_QUOTE_RECORDS, "record-$PID.json"), ($record | ConvertTo-Json -Depth 4))
`;

const DRIVER = `param([string]$Agent, [string]$Case)
$ErrorActionPreference = 'Stop'
$c = [IO.File]::ReadAllText($Case) | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Agent, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "moe-agent.ps1 does not parse: $($errors[0].Message)" }
if (-not $ast.ParamBlock) { throw 'moe-agent.ps1 has no param block' }
$fake = [IO.Path]::Combine([IO.Path]::GetDirectoryName($c.team), 'moe-agent.ps1')
[IO.File]::WriteAllText($fake, $ast.ParamBlock.Extent.Text + [Environment]::NewLine + $c.recorder, (New-Object System.Text.UTF8Encoding $true))
function Start-Process {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$FilePath, [Parameter(Position = 1)][string[]]$ArgumentList, [string]$WorkingDirectory)
    Write-Host "START-PROCESS FilePath=$FilePath NoExit=$($ArgumentList -ccontains '-NoExit')"
    if ($env:TEAM_QUOTE_FAIL) { Write-Error 'simulated launch failure'; return }
    $PSBoundParameters['ArgumentList'] = @('-NoProfile', '-NonInteractive') + @($ArgumentList | Where-Object { $_ -cne '-NoExit' })
    Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters -Wait -NoNewWindow
}
$params = @{}
foreach ($p in $c.params.PSObject.Properties) { $params[$p.Name] = $p.Value }
$ErrorActionPreference = 'Continue'
$Error.Clear()
$global:LASTEXITCODE = 0
& $c.team @params
$code = $LASTEXITCODE
if ($Error.Count -and -not $env:TEAM_QUOTE_FAIL) { foreach ($e in $Error) { [Console]::Error.WriteLine("ERROR: $e") }; exit 3 }
exit $code
`;

function fixture(t, dirName) {
  // Native realpath expands 8.3 names (RUNNER~1), so recorded paths compare exactly.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-team-quote-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const scripts = path.join(root, dirName, 'scripts');
  const records = path.join(root, 'records');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(records);
  const team = path.join(scripts, 'moe-team.ps1');
  fs.copyFileSync(TEAM, team);
  return { root, scripts, records, team };
}
function childEnv(extra) {
  const drop = /^(MOE_|FAKE_|TEAM_QUOTE_|CLAUDE|CODEX|GEMINI|GROK|XAI|GIT_|PSModulePath$)/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k))), ...extra };
}
function killTree(child) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
// Stops the driver's tree (that recorded PID only) at the cap. A spawn error resolves, not hangs.
function run(exe, args, { cwd, env }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', stopped = false, spawnError = null;
    const child = spawn(exe, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => { stopped = true; killTree(child); }, CAP_MS);
    child.on('error', (e) => { spawnError = e; });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stopped, spawnError, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') });
    });
  });
}
const show = (r) => `exit ${r.code}${r.stopped ? ' (stopped)' : ''}${r.spawnError ? ` spawn error: ${r.spawnError.message}` : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
function runTeam(engine, f, params, extraEnv = {}) {
  const casePath = path.join(f.root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify({ team: f.team, recorder: RECORDER, params: { DelayBetween: 0, ...params } }), 'utf8');
  const driver = path.join(f.root, 'driver.ps1');
  fs.writeFileSync(driver, '\ufeff' + DRIVER, 'utf8');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, '-Agent', AGENT, '-Case', casePath];
  // The driver runs from the fixture root, so a child that inherited the caller's location fails the cwd check.
  return run(engine.exe, args, { cwd: f.root, env: childEnv({ TEAM_QUOTE_RECORDS: f.records, ...extraEnv }) });
}
function records(f) {
  return fs.readdirSync(f.records).filter((n) => /^record-\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(f.records, n), 'utf8')))
    .sort((a, b) => String(a.bound.Role).localeCompare(String(b.bound.Role)));
}
const record = (f, bound, cwd = f.scripts) => ({ bound: { Command: 'claude', ...bound }, unbound: [], cwd });

for (const engine of ENGINES) {
  const opts = { skip: engine.skip };

  test(`${engine.name}: a spaced scripts dir, project and team reach moe-agent.ps1 whole`, opts, async (t) => {
    const f = fixture(t, 'with space');
    const project = path.join(f.root, 'proj plain');
    const r = await runTeam(engine, f, { Project: project, Team: 'Moe Team', NoQa: true, NoArchitect: true });
    assert.equal(r.code, 0, show(r));
    assert.match(r.stdout, /START-PROCESS FilePath=powershell NoExit=True/, show(r));
    assert.deepEqual(records(f), [record(f, { Role: 'worker', Project: project, Team: 'Moe Team' })], show(r));
  });

  test(`${engine.name}: $, quotes, backticks and CommandArgs reach moe-agent.ps1 byte-for-byte`, opts, async (t) => {
    const f = fixture(t, "it's $HOME dir");
    const project = path.join(f.root, "Bob's $HOME a`b \u2019q");
    const team = `q"t 'x' $(Write-Output PWNED) \u2018y\u2019 \u201Cz\u201D`;
    const commandArgs = ['--flag', "two words 'q' $env:USERNAME"];
    const r = await runTeam(engine, f, { Project: project, Team: team, CommandArgs: commandArgs, NoQa: true, NoArchitect: true });
    assert.equal(r.code, 0, show(r));
    assert.deepEqual(records(f), [record(f, { Role: 'worker', Project: project, Team: team, CommandArgs: commandArgs })], show(r));
  });

  test(`${engine.name}: no-space control launches all three roles`, opts, async (t) => {
    const f = fixture(t, 'plain');
    const project = path.join(f.root, 'projplain');
    const r = await runTeam(engine, f, { Project: project, Team: 'plainteam' });
    assert.equal(r.code, 0, show(r));
    assert.equal(r.stdout.match(/START-PROCESS FilePath=powershell NoExit=True/g)?.length, 3, show(r));
    assert.deepEqual(records(f), ['architect', 'qa', 'worker'].map((Role) => record(f, { Role, Project: project, Team: 'plainteam' })), show(r));
  });

  // A ps1 claude runs in its window's location, and the account trust step
  // accepts only a launch inside the project: the windows start in an existing
  // project, and a relative -Project reaches the agent absolute.
  test(`${engine.name}: a relative -Project reaches the agents absolute, and they start in it`, opts, async (t) => {
    const f = fixture(t, 'plain');
    const project = path.join(f.root, "proj it's $HOME");
    fs.mkdirSync(project);
    const r = await runTeam(engine, f, { Project: "proj it's $HOME", NoQa: true, NoArchitect: true });
    assert.equal(r.code, 0, show(r));
    assert.deepEqual(records(f), [record(f, { Role: 'worker', Project: project, Team: "proj it's $HOME" }, project)], show(r));
  });

  test(`${engine.name}: -ProjectName starts the agents in the registered project`, opts, async (t) => {
    const f = fixture(t, 'plain');
    const project = path.join(f.root, 'registered proj');
    const home = path.join(f.root, 'home');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(home, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(home, '.moe', 'projects.json'), JSON.stringify([{ name: 'reg', path: project }]), 'utf8');
    const r = await runTeam(engine, f, { ProjectName: 'reg', NoQa: true, NoArchitect: true }, { USERPROFILE: home });
    assert.equal(r.code, 0, show(r));
    assert.deepEqual(records(f), [record(f, { Role: 'worker', ProjectName: 'reg', Team: 'registered proj' }, project)], show(r));
  });

  // Windows PowerShell started in a directory whose path has [ or ] takes
  // $PSHOME as its location instead, so the window's command sets it again.
  test(`${engine.name}: a project whose path has [ ] is still where the agents start`, opts, async (t) => {
    const f = fixture(t, 'plain');
    const project = path.join(f.root, 'proj [1]');
    fs.mkdirSync(project);
    const r = await runTeam(engine, f, { Project: project, NoQa: true, NoArchitect: true });
    assert.equal(r.code, 0, show(r));
    assert.deepEqual(records(f), [record(f, { Role: 'worker', Project: project, Team: 'proj [1]' }, project)], show(r));
  });

  test(`${engine.name}: a failed launch is reported and exits 1`, opts, async (t) => {
    const f = fixture(t, 'plain');
    const r = await runTeam(engine, f, { Project: path.join(f.root, 'projplain'), Team: 'plainteam', NoQa: true, NoArchitect: true }, { TEAM_QUOTE_FAIL: '1' });
    assert.equal(r.code, 1, show(r));
    assert.match(r.stdout, /Failed to start the worker agent: .*simulated launch failure/, show(r));
    assert.match(r.stdout, /Launched 0 agent\(s\)/, show(r));
    assert.deepEqual(records(f), [], show(r));
  });
}

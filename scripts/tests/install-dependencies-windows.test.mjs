// Dependency bootstrap tests never invoke real npm, winget or agent CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../install-dependencies.ps1');
const options = { skip: process.platform !== 'win32' };
const quote = value => `'${value.replaceAll("'", "''")}'`;
// The helper runs a full dependency probe under PowerShell; a loaded Windows CI
// runner needs more than the original 20s. Override with MOE_INSTALLER_TEST_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.MOE_INSTALLER_TEST_TIMEOUT_MS) || 60000;

function run(t, { tools = ['node', 'npm', 'git', 'claude', 'winget'], nodeVersion = 'v24.13.0', args = '', fail = '', jdk = false, ambientJdk = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe deps test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['profile', 'appdata', 'localappdata', 'programfiles', 'bin']) mkdirSync(path.join(dir, folder));
  const ambientJava = path.join(dir, 'ambient-java');
  if (ambientJdk) {
    mkdirSync(path.join(ambientJava, 'bin'), { recursive: true });
    writeFileSync(path.join(ambientJava, 'release'), 'JAVA_VERSION="17.0.99"\n');
    for (const name of ['java.exe', 'javac.exe']) writeFileSync(path.join(ambientJava, 'bin', name), 'fixture');
  }
  const runner = path.join(dir, 'runner.ps1');
  writeFileSync(runner, `
$ErrorActionPreference = 'Stop'
$env:ProgramFiles = ${quote(path.join(dir, 'programfiles'))}
$env:JAVA_HOME = ''
${ambientJdk ? `$env:Path = ${quote(path.join(ambientJava, 'bin'))} + ';' + $env:Path` : ''}
$env:Path = ${quote(path.join(dir, 'version-manager'))} + ';' + $env:Path
$global:availableTools = @(${tools.map(quote).join(', ')})
$global:nodeVersion = ${quote(nodeVersion)}
$global:failInstall = ${quote(fail)}
$global:logFile = ${quote(path.join(dir, 'calls.txt'))}
Set-Content -LiteralPath $global:logFile -Value ''
function Get-Command {
    param([string]$Name, $ErrorAction)
    # Hosted runners can expose JDK17 through PATH even with JAVA_HOME cleared.
    if ($Name -in @('node', 'npm', 'git', 'claude', 'codex', 'gemini', 'grok', 'winget', 'javac')) {
        if ($Name -in $global:availableTools) { return [pscustomobject]@{ Name = $Name; Source = $Name } }
        return $null
    }
    Microsoft.PowerShell.Core\\Get-Command -Name $Name -ErrorAction SilentlyContinue
}
function node { $global:LASTEXITCODE = 0; $global:nodeVersion }
function git { $global:LASTEXITCODE = 0; 'git version 2.50.0' }
function claude { $global:LASTEXITCODE = 0; 'claude 2.0.0' }
function codex { $global:LASTEXITCODE = 0; 'codex 1.0.0' }
function gemini { $global:LASTEXITCODE = 0; 'gemini 1.0.0' }
function grok { $global:LASTEXITCODE = 0; 'grok 1.0.0' }
function Set-ItemProperty {
    param([string]$LiteralPath, [string]$Name, [string]$Value)
    if ($LiteralPath -ne 'HKCU:\\Environment' -or $Name -ne 'Path') { throw 'Unexpected registry write in dependency bootstrap' }
    Set-Content -LiteralPath ${quote(path.join(dir, 'user-path.txt'))} -Value $Value
}
function Install-FakeJdk {
    $jdkDir = Join-Path $env:ProgramFiles 'Eclipse Adoptium\\jdk-17.0.19'
    New-Item -ItemType Directory -Path (Join-Path $jdkDir 'bin') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $jdkDir 'release') -Value 'JAVA_VERSION="17.0.19"'
    Set-Content -LiteralPath (Join-Path $jdkDir 'bin\\java.exe') -Value 'fixture'
    Set-Content -LiteralPath (Join-Path $jdkDir 'bin\\javac.exe') -Value 'fixture'
}
function winget {
    $line = $args -join ' '
    Add-Content -LiteralPath $global:logFile -Value ('winget ' + $line)
    $global:LASTEXITCODE = if ($line -like ('*' + $global:failInstall + '*') -and $global:failInstall) { 47 } else { 0 }
    if ($global:LASTEXITCODE -ne 0) { return }
    if ($line -match 'OpenJS.NodeJS.LTS') { $global:availableTools += @('node', 'npm'); $global:nodeVersion = 'v24.13.0' }
    if ($line -match 'Git.Git') { $global:availableTools += 'git' }
    if ($line -match 'Anthropic.ClaudeCode') { $global:availableTools += 'claude' }
    if ($line -match 'EclipseAdoptium.Temurin.17.JDK') { Install-FakeJdk }
}
function npm {
    $line = $args -join ' '
    Add-Content -LiteralPath $global:logFile -Value ('npm ' + $line)
    $global:LASTEXITCODE = if ($line -like ('*' + $global:failInstall + '*') -and $global:failInstall) { 47 } else { 0 }
    if ($global:LASTEXITCODE -ne 0) { return }
    if ($line -eq 'config get prefix') { ${quote(path.join(dir, 'bin'))}; return }
    if ($line -match '@openai/codex') { $global:availableTools += 'codex' }
    if ($line -match '@google/gemini-cli') { $global:availableTools += 'gemini' }
    if ($line -match '@xai-official/grok') { $global:availableTools += 'grok' }
    if ($line -match '@anthropic-ai/claude-code') { $global:availableTools += 'claude' }
    'npm 11.0.0'
}
${jdk ? 'Install-FakeJdk' : ''}
& ${quote(helper)} ${args}
$env:JAVA_HOME | Set-Content -LiteralPath ${quote(path.join(dir, 'java-home.txt'))}
$env:Path | Set-Content -LiteralPath ${quote(path.join(dir, 'runtime-path.txt'))}
`);
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    encoding: 'utf8', timeout: TIMEOUT_MS,
    env: { ...process.env, USERPROFILE: path.join(dir, 'profile'), APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'), ProgramFiles: path.join(dir, 'programfiles'), JAVA_HOME: '', MOE_GRADLE_HOME: '', MOE_GRADLE_BIN: '' },
  });
  // Read the stub log TOLERANTLY: a child that timed out never wrote it, and an
  // unconditional read would throw ENOENT here, before pass() can report why the
  // run actually failed.
  const callsFile = path.join(dir, 'calls.txt');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '';
  return { ...result, dir, calls };
}

function pass(result) {
  // spawnSync reports a timeout as status null plus an `error` (ETIMEDOUT); name it
  // rather than leaving a bare `null !== 0`.
  const reason = result.error
    ? `child failed to run: ${result.error.code || result.error.message}`
    : result.signal
      ? `child killed by ${result.signal}`
      : `exit status ${result.status}`;
  assert.equal(result.status, 0, `${reason} (timeout ${TIMEOUT_MS}ms)
${result.stdout || ''}${result.stderr || ''}`);
}

function assertSelectedJdk(result) {
  const selected = readFileSync(path.join(result.dir, 'java-home.txt'), 'utf8').trim();
  const expected = path.join(result.dir, 'programfiles/Eclipse Adoptium/jdk-17.0.19');
  // PowerShell may return a long path when the fixture's TEMP uses an 8.3 alias.
  assert.equal(realpathSync.native(selected), realpathSync.native(expected));
}

test('Windows ready dependencies do not invoke package installation', options, t => {
  const result = run(t);
  pass(result);
  assert.doesNotMatch(result.calls, /winget |npm install/);
  assert.match(result.stdout, /claude/);
});

test('Windows npm command directory is persisted in user PATH', options, t => {
  const result = run(t);
  pass(result);
  assert.equal(existsSync(path.join(result.dir, 'user-path.txt')), true, 'future terminals must discover installed npm CLIs');
  assert.ok(readFileSync(path.join(result.dir, 'user-path.txt'), 'utf8').includes(path.join(result.dir, 'bin')));
});

test('Windows ready Node keeps the existing version manager priority', options, t => {
  const result = run(t);
  pass(result);
  const entries = readFileSync(path.join(result.dir, 'runtime-path.txt'), 'utf8').trim().split(';');
  assert.equal(entries[1], path.join(result.dir, 'version-manager'));
});

test('Windows missing Node npm Git and default Claude are provisioned', options, t => {
  const result = run(t, { tools: ['winget'] });
  pass(result);
  for (const id of ['OpenJS.NodeJS.LTS', 'Git.Git', 'Anthropic.ClaudeCode']) assert.ok(result.calls.includes(id), `${id} must be installed`);
  assert.match(result.calls, /--accept-package-agreements/);
});

test('Windows unsupported Node is upgraded before installation continues', options, t => {
  const result = run(t, { nodeVersion: 'v20.19.0' });
  pass(result);
  assert.match(result.calls, /OpenJS.NodeJS.LTS/);
});

test('Windows missing winget fails with App Installer recovery instructions', options, t => {
  const result = run(t, { tools: [] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /App Installer/);
  assert.doesNotMatch(result.calls, /winget /);
});

test('Windows package manager failure stops at the failed dependency', options, t => {
  const result = run(t, { tools: ['winget'], fail: 'OpenJS.NodeJS.LTS' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /47/);
  assert.doesNotMatch(result.calls, /Git.Git|Anthropic.ClaudeCode/);
});

for (const [agent, pkg] of [['codex', '@openai/codex'], ['gemini', '@google/gemini-cli'], ['grok', '@xai-official/grok']]) {
  test(`Windows selected ${agent} installs its official npm package`, options, t => {
    const result = run(t, { args: `-AgentCommand ${agent}` });
    pass(result);
    assert.ok(result.calls.includes(`npm install --global ${pkg}`), `${pkg} must be installed`);
    assert.doesNotMatch(result.calls, /Anthropic.ClaudeCode/);
  });
}

test('Windows npm agent installation failure is not reported as ready', options, t => {
  const result = run(t, { args: '-AgentCommand codex', fail: '@openai/codex' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /47/);
});

test('Windows none selection does not require an agent CLI', options, t => {
  const result = run(t, { tools: ['node', 'npm', 'git'], args: '-AgentCommand none' });
  pass(result);
  assert.doesNotMatch(result.calls, /winget |npm install/);
});

test('Windows plugin build installs and selects the JDK17 toolchain', options, t => {
  const result = run(t, { args: '-WithPlugin' });
  pass(result);
  assert.match(result.calls, /EclipseAdoptium.Temurin.17.JDK/);
  assertSelectedJdk(result);
});

test('Windows existing JDK17 is reused and no-plugin mode does not install Java', options, t => {
  const result = run(t, { args: '-WithPlugin', jdk: true });
  pass(result);
  assert.doesNotMatch(result.calls, /EclipseAdoptium/);
  assert.equal(existsSync(path.join(result.dir, 'java-home.txt')), true);
});

test('Windows dependency fixtures ignore an ambient JDK on the inherited PATH', options, t => {
  const result = run(t, { args: '-WithPlugin', ambientJdk: true });
  pass(result);
  assert.match(result.calls, /EclipseAdoptium.Temurin.17.JDK/);
  assertSelectedJdk(result);
});

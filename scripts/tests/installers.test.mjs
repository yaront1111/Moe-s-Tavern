// Isolated installer regressions: npm/Gradle are fake and all profile writes stay in fixtures.
// Run: node --test scripts/tests/installers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isWindows = process.platform === 'win32';
const bash = isWindows ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = value => isWindows ? value.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`) : value;
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe installer test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['scripts', 'packages/moe-daemon', 'packages/moe-proxy', 'moe-jetbrains', 'profile', 'appdata', 'temp', 'bin']) {
    mkdirSync(path.join(dir, name), { recursive: true });
  }
  for (const file of ['install-all.ps1', 'install-all.sh', 'install-mac.sh']) {
    cpSync(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
  }
  writeFileSync(path.join(dir, 'packages/moe-daemon/package.json'), JSON.stringify({ version: '9.8.7' }));
  writeFileSync(path.join(dir, 'scripts/doctor.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'scripts/install-dependencies.sh'), 'moe_install_dependencies() { :; }\n');
  writeFileSync(path.join(dir, 'scripts/install-dependencies.ps1'), "param([switch]$WithPlugin, [string]$AgentCommand)\nSet-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'dependency-args.txt') -Value ($AgentCommand + '|' + $WithPlugin.IsPresent)\n");
  writeFileSync(path.join(dir, 'bin/npm'), '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$MOE_TEST_NPM_LOG"\n', { mode: 0o755 });
  return dir;
}

function runPowerShell(dir, args = '', setup = '', failCommand = '') {
  const runner = path.join(dir, 'run.ps1');
  writeFileSync(runner, `
$ErrorActionPreference = 'Stop'
function npm {
    Add-Content -LiteralPath $env:MOE_TEST_NPM_LOG -Value ((Get-Location).Path + '|' + ($args -join ' '))
    $global:LASTEXITCODE = if (($args -join ' ') -eq ${psQuote(failCommand)}) { 37 } else { 0 }
}
${setup}
Set-Location -LiteralPath ${psQuote(dir)}
try {
    & ${psQuote(path.join(dir, 'scripts/install-all.ps1'))} ${args}
} finally {
    (Get-Location).Path | Set-Content -LiteralPath ${psQuote(path.join(dir, 'final-cwd.txt'))}
}
`);
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, USERPROFILE: path.join(dir, 'profile'), APPDATA: path.join(dir, 'appdata'), TEMP: path.join(dir, 'temp'), MOE_TEST_NPM_LOG: path.join(dir, 'npm.log') },
  });
}

function runBash(dir, script, args = []) {
  return spawnSync(bash, [shellPath(path.join(dir, 'scripts', script)), ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: shellPath(path.join(dir, 'profile')), PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, MOE_TEST_NPM_LOG: shellPath(path.join(dir, 'npm.log')) },
  });
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function samePath(actual, expected) {
  // PowerShell expands Windows 8.3 aliases in Get-Location and FullName.
  assert.equal(realpathSync.native(actual), realpathSync.native(expected));
}

test('Windows default installation succeeds without a JetBrains IDE', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir));
  assert.equal(existsSync(path.join(dir, 'profile/.moe/config.json')), true, 'default install must finish and write config without an IDE');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'profile/.moe/config.json'), 'utf8').replace(/^\uFEFF/, '')).version, '9.8.7');
});

test('Windows installer automatically bootstraps its default agent dependencies', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir));
  assert.equal(existsSync(path.join(dir, 'dependency-args.txt')), true, 'installer must invoke dependency bootstrap');
  assert.equal(readFileSync(path.join(dir, 'dependency-args.txt'), 'utf8').trim(), 'claude|False');
});

test('Windows dependency failure stops before npm builds', { skip: !isWindows }, t => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'scripts/install-dependencies.ps1'), "throw 'Dependency bootstrap failed'\n");
  const result = runPowerShell(dir);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(dir, 'npm.log')), false);
});

test('Windows plugin archive install passes agent choice and skips JDK bootstrap', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir, '-AgentCommand codex -InstallPlugin -PluginZip ./plugin.zip', pluginSetup(dir)));
  assert.equal(existsSync(path.join(dir, 'dependency-args.txt')), true, 'installer must pass dependency choices to bootstrap');
  assert.equal(readFileSync(path.join(dir, 'dependency-args.txt'), 'utf8').trim(), 'codex|False');
});

test('Windows build-only option provisions JDK and produces an archive without an IDE', { skip: !isWindows }, t => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'moe-jetbrains/gradlew.bat'), '@echo Simulated Gradle build output\r\n@exit /b 0\r\n');
  const setup = `
$payload = ${psQuote(path.join(dir, 'payload/moe-jetbrains/lib'))}
New-Item -ItemType Directory -Path $payload -Force | Out-Null
Set-Content -LiteralPath (Join-Path $payload 'plugin.jar') -Value 'fixture'
New-Item -ItemType Directory -Path ${psQuote(path.join(dir, 'moe-jetbrains/build/distributions'))} -Force | Out-Null
Compress-Archive -Path ${psQuote(path.join(dir, 'payload/moe-jetbrains'))} -DestinationPath ${psQuote(path.join(dir, 'moe-jetbrains/build/distributions/moe.zip'))}
`;
  const result = runPowerShell(dir, '-BuildPlugin -AgentCommand none', setup);
  succeeded(result);
  assert.equal(readFileSync(path.join(dir, 'dependency-args.txt'), 'utf8').trim(), 'none|True');
  const archive = result.stdout.match(/^Plugin archive: (.+)$/m);
  assert.ok(archive, result.stdout);
  samePath(archive[1].trim(), path.join(dir, 'moe-jetbrains/build/distributions/moe.zip'));
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains')), false);
});

test('Windows installation registers both CLI commands and restores caller directory', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir, '-InstallPlugin:$false'));
  const calls = readFileSync(path.join(dir, 'npm.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.filter(line => line.endsWith('|link')).length, 2, 'daemon and proxy must each be linked');
  samePath(readFileSync(path.join(dir, 'final-cwd.txt'), 'utf8').trim(), dir);
});

test('Windows installation restores caller directory', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir, '-InstallPlugin:$false'));
  samePath(readFileSync(path.join(dir, 'final-cwd.txt'), 'utf8').trim(), dir);
});

test('Windows global config is portable UTF-8 JSON without a BOM', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir));
  const configText = readFileSync(path.join(dir, 'profile/.moe/config.json'), 'utf8');
  assert.equal(configText.charCodeAt(0), '{'.charCodeAt(0), 'Node and Python JSON readers reject the PowerShell UTF-8 BOM');
  samePath(JSON.parse(configText).installPath, dir);
});

test('Windows failed CLI registration aborts with caller directory restored', { skip: !isWindows }, t => {
  const dir = fixture(t);
  const result = runPowerShell(dir, '-InstallPlugin:$false', '', 'link');
  assert.notEqual(result.status, 0, 'npm link failure must fail installation');
  samePath(readFileSync(path.join(dir, 'final-cwd.txt'), 'utf8').trim(), dir);
  assert.equal(existsSync(path.join(dir, 'profile/.moe/config.json')), false);
});

function pluginSetup(dir, ide = 'IntelliJIdea2026.2') {
  return `
$pluginDir = ${psQuote(path.join(dir, 'appdata/JetBrains', ide, 'plugins/moe-jetbrains/lib'))}
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $pluginDir 'existing.txt') -Value 'existing'
$payload = ${psQuote(path.join(dir, 'payload/moe-jetbrains/lib'))}
New-Item -ItemType Directory -Path $payload -Force | Out-Null
Set-Content -LiteralPath (Join-Path $payload 'new.txt') -Value 'new'
Compress-Archive -Path ${psQuote(path.join(dir, 'payload/moe-jetbrains'))} -DestinationPath ${psQuote(path.join(dir, 'plugin.zip'))}
`;
}

test('Windows explicit plugin install supports a detected IntelliJ IDE and relative ZIP', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir, '-InstallPlugin -PluginZip ./plugin.zip', pluginSetup(dir)));
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/IntelliJIdea2026.2/plugins/moe-jetbrains/lib/new.txt')), true);
});

test('Windows Gradle failure never installs a stale plugin ZIP', { skip: !isWindows }, t => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'moe-jetbrains/gradlew.bat'), '@exit /b 42\r\n');
  const setup = `${pluginSetup(dir, 'PyCharm2025.2')}
New-Item -ItemType Directory -Path ${psQuote(path.join(dir, 'moe-jetbrains/build/distributions'))} -Force | Out-Null
Copy-Item -LiteralPath ${psQuote(path.join(dir, 'plugin.zip'))} -Destination ${psQuote(path.join(dir, 'moe-jetbrains/build/distributions/stale.zip'))}
`;
  const result = runPowerShell(dir, '-InstallPlugin', setup);
  assert.notEqual(result.status, 0, 'failed Gradle must abort even if an old distribution exists');
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/PyCharm2025.2/plugins/moe-jetbrains/lib/existing.txt')), true);
  samePath(readFileSync(path.join(dir, 'final-cwd.txt'), 'utf8').trim(), dir);
  assert.equal(readFileSync(path.join(dir, 'dependency-args.txt'), 'utf8').trim(), 'claude|True');
});

test('Windows malformed plugin ZIP preserves the installed plugin', { skip: !isWindows }, t => {
  const dir = fixture(t);
  const setup = `${pluginSetup(dir, 'PyCharm2025.2')}
Set-Content -LiteralPath ${psQuote(path.join(dir, 'bad.txt'))} -Value 'invalid plugin'
Compress-Archive -LiteralPath ${psQuote(path.join(dir, 'bad.txt'))} -DestinationPath ${psQuote(path.join(dir, 'bad.zip'))}
`;
  const result = runPowerShell(dir, '-InstallPlugin -PluginZip ' + psQuote(path.join(dir, 'bad.zip')), setup);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/PyCharm2025.2/plugins/moe-jetbrains/lib/existing.txt')), true);
});

test('Windows replacement failure restores the previous plugin backup', { skip: !isWindows }, t => {
  const dir = fixture(t);
  const setup = `${pluginSetup(dir)}
function Move-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ($LiteralPath -like '*moe-jetbrains-install-*') { throw 'simulated replacement failure' }
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
`;
  const result = runPowerShell(dir, '-InstallPlugin -PluginZip ./plugin.zip', setup);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated replacement failure/);
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/IntelliJIdea2026.2/plugins/moe-jetbrains/lib/existing.txt')), true);
});

test('Windows legacy PyCharmVersion option still selects its IDE', { skip: !isWindows }, t => {
  const dir = fixture(t);
  succeeded(runPowerShell(dir, '-InstallPlugin -PyCharmVersion PyCharm2025.2 -PluginZip ./plugin.zip', pluginSetup(dir, 'PyCharm2025.2')));
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/PyCharm2025.2/plugins/moe-jetbrains/lib/new.txt')), true);
});

test('Windows IDE selection rejects parent traversal', { skip: !isWindows }, t => {
  const dir = fixture(t);
  const result = runPowerShell(dir, '-InstallPlugin -IdeVersion ../outside -PluginZip ./plugin.zip', pluginSetup(dir));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a JetBrains config folder name/);
  assert.equal(existsSync(path.join(dir, 'appdata/JetBrains/IntelliJIdea2026.2/plugins/moe-jetbrains/lib/existing.txt')), true);
});

for (const script of ['install-all.sh', 'install-mac.sh']) {
  test(`${script} writes the installed package version using Node only`, { skip: isWindows && !existsSync(bash) }, t => {
    const dir = fixture(t);
    writeFileSync(path.join(dir, 'bin/python3'), '#!/usr/bin/env bash\necho "Unexpected Python dependency" >&2\nexit 91\n', { mode: 0o755 });
    succeeded(runBash(dir, script, script === 'install-mac.sh' ? ['--skip-mcp'] : []));
    const config = JSON.parse(readFileSync(path.join(dir, 'profile/.moe/config.json'), 'utf8'));
    assert.equal(config.version, '9.8.7');
  });
}

test('Mac local MCP command separates executable from its path argument', { skip: isWindows && !existsSync(bash) }, t => {
  const dir = fixture(t);
  succeeded(runBash(dir, 'install-mac.sh'));
  const config = JSON.parse(readFileSync(path.join(dir, 'profile/.config/claude/mcp_servers.json'), 'utf8'));
  assert.equal(config.moe.command, 'node');
  assert.equal(config.moe.args.length, 1);
  assert.match(config.moe.args[0], /packages\/moe-proxy\/dist\/index\.js$/);
});

test('Mac explicit global installation registers both CLI commands', { skip: isWindows && !existsSync(bash) }, t => {
  const dir = fixture(t);
  succeeded(runBash(dir, 'install-mac.sh', ['--global', '--skip-mcp']));
  const calls = readFileSync(path.join(dir, 'npm.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.filter(line => line.endsWith('|link')).length, 2);
});

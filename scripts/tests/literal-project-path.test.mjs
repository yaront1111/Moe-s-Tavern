import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// PowerShell treats [ ] and backticks in -Path as wildcard syntax: the existing
// project "control é [x] $;'" is missed. PS 5.1 Start-Process also interprets an
// inherited current location as a wildcard, so its working directory needs escaping.
const pathCommands = 'Test-Path Get-Content Set-Content Add-Content Clear-Content Out-File Get-Item Get-ChildItem Copy-Item Move-Item Remove-Item Rename-Item Resolve-Path Convert-Path Push-Location Set-Location Get-Acl Set-Acl Get-FileHash'.split(' ');
const commandPattern = new RegExp(`(?:^|[({|;=]|\\breturn)\\s*(${[...pathCommands, 'Start-Process'].join('|')})\\b`, 'gmi');
const normalize = text => text.replace(/^\ufeff/, '').replaceAll('\r\n', '\n');
const mask = text => text.replace(/[^\n]/g, ' ');
function codeOnly(text) {
  // Preserve offsets/lines while excluding quoted prose, here-strings and comments.
  return text.replace(/<#[\s\S]*?#>|^[ \t]*#[^\n]*|@'\n[\s\S]*?^'@|@"\n[\s\S]*?^"@|'(?:''|[^'])*'|"(?:`[\s\S]|[^"`])*"/gm, mask);
}
function segment(code, original, start) {
  let depth = 0, top = '', rawTop = '', end = start;
  for (; end < code.length; end++) {
    const ch = code[end];
    if (!depth && /[|;\n)}]/.test(ch)) break;
    if (ch === '(' || ch === '{') depth++;
    if (!depth) { top += ch; rawTop += original[end]; }
    if (ch === ')' || ch === '}') depth--;
  }
  return { top, rawTop, full: code.slice(start, end) };
}
function scan(text, file) {
  const code = codeOnly(text), violations = [];
  let paths = 0;
  for (const match of code.matchAll(commandPattern)) {
    const command = match[1], start = match.index + match[0].length;
    const part = segment(code, text, start), line = text.slice(0, start).split('\n').length;
    const processCommand = command.toLowerCase() === 'start-process';
    if (!processCommand) paths++;
    const env = /(?:^|\s)(?:-Path\s+)?["']?Env:/i.test(part.rawTop);
    const bad = processCommand
      ? !/(?:^|\s)-WorkingDirectory\b/i.test(part.top) || !/WildcardPattern\]::Escape\(/i.test(part.full)
      : !env && !/(?:^|\s)-LiteralPath\b/i.test(part.top);
    if (bad) violations.push(`${file}:${line}: ${text.split('\n')[line - 1].trim()}`);
  }
  return { violations, paths };
}
function staticTests() {
  for (const file of ['moe-agent.ps1', 'moe-team.ps1']) {
    test(`${file}: G1 literal filesystem paths; G2 escaped process working directory`, () => {
      const result = scan(normalize(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), file);
      assert.ok(result.paths > 0, 'must inspect path cmdlets, not an empty source');
      assert.deepEqual(result.violations, [], 'G1 requires top-level -LiteralPath; G2 requires escaped -WorkingDirectory');
    });
  }
  test('scanner pins the exact flags, including nested arguments and exemptions', () => {
    const lines = [
      'if (-not (Test-Path $a)) { New-Item -ItemType Directory -Force -Path $a | Out-Null }',
      '$c = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json',
      "Get-ChildItem -Path $d -File -Filter '*.md' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $t }",
      'Test-Path (Get-Item -LiteralPath $p).FullName',
      '# Test-Path $x',
      'Write-Host "run Test-Path by hand"',
      'Remove-Item Env:MOE_X -ErrorAction SilentlyContinue',
      'return Get-Content -Path $f',
      'Start-Process -FilePath node -ArgumentList @($a)',
      'Start-Process node -WorkingDirectory ([System.Management.Automation.WildcardPattern]::Escape($d))',
      '<#\nTest-Path $comment\n#>',
      'Remove-Item -Path "Env:\\$k"',
      'Write-Host "(Test-Path $quoted)"',
    ];
    assert.deepEqual(scan(lines.join('\n'), 'sample').violations,
      [0, 2, 3, 7, 8].map(i => `sample:${i + 1}: ${lines[i]}`));
  });
}

const source = fileURLToPath(import.meta.url), scripts = path.dirname(path.dirname(source));
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MOE_|FAKE_|GIT_|CLAUDE|CODEX|GEMINI|GROK|XAI|PSMODULEPATH$)/i.test(key)));
const psquote = text => `'${text.replaceAll("'", "''")}'`;
const read = file => normalize(fs.readFileSync(file, 'utf8'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function run(command, args, cwd, env = clean) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
}
function git(project, args) {
  const result = run('git', ['-C', project, ...args], project);
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
function fakeCli() {
  const argv = process.argv.slice(3);
  if (argv.includes('--help') || argv.includes('--version')) return;
  const fixture = JSON.parse(process.env.LITERAL_FIXTURE), joined = argv.join(' ');
  const promptIndex = argv.indexOf('--append-system-prompt-file');
  const contextPaths = [...joined.matchAll(/session context file at (.+?session-context\.md)\./g)];
  write(fixture.result, JSON.stringify({ cwd: process.cwd(), projectEnv: process.env.MOE_PROJECT_PATH, argv,
    systemPrompt: promptIndex < 0 ? '' : read(argv[promptIndex + 1]),
    context: joined + contextPaths.map(match => read(match[1])).join('\n') }));
  write(path.join(fixture.project, 'owned.txt'), 'literal edit');
}
function fakeDaemon() {
  const fixture = JSON.parse(process.env.LITERAL_FIXTURE);
  const project = process.argv[process.argv.indexOf('--project') + 1];
  write(path.join(fixture.root, 'daemon-argv.json'), JSON.stringify({ project, pid: process.pid }));
  write(path.join(project, '.moe', 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1, projectPath: project }));
  setTimeout(() => {}, 8000);
}
function fixture(t, cli) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-literal-'));
  const f = { root, project: path.join(root, "control é [x] $;'"), result: path.join(root, 'result.json') };
  t.after(() => {
    try {
      const record = path.join(root, 'daemon-argv.json');
      if (fs.existsSync(record)) {
        const { pid } = JSON.parse(read(record));
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  });
  fs.mkdirSync(f.project); fs.mkdirSync(path.join(root, 'home'));
  git(f.project, ['init', '-q', '-b', 'moe/literal']);
  for (const [key, value] of [['user.name', 'Literal Test'], ['user.email', 'literal@test.invalid'], ['core.autocrlf', 'false']]) git(f.project, ['config', key, value]);
  write(path.join(f.project, 'owned.txt'), 'base');
  git(f.project, ['add', '--', 'owned.txt']); git(f.project, ['commit', '-qm', 'seed']);
  const files = {
    '.moe/project.json': JSON.stringify({ id: 'proj-literal', name: 'literal', settings: {
      commitBoardState: false, attribution: { undeclared: 'never' }, models: { worker: 'claude-literal-sentinel' } } }),
    '.moe/tasks/task-postflight.json': JSON.stringify({ id: 'task-postflight', title: 'Literal', status: 'WORKING', filesModified: ['owned.txt'], implementationPlan: [] }),
    '.moe/roles/worker.md': 'ROLE-DOC-SENTINEL', '.moe/KNOWN_ISSUES.md': 'KNOWN-ISSUES-SENTINEL',
    '.moe/agents/literal-agent.md': 'literal agent', '.serena/memories/literal-memory.md': 'literal memory',
    // PS 5.1's default Get-Content encoding needs a BOM for non-ASCII JSON.
    '.moe-agent.json': '\ufeff' + JSON.stringify({ serenaProject: f.project }),
  };
  for (const [file, body] of Object.entries(files)) write(path.join(f.project, file), body);
  const serena = path.join(root, 'serena-dummy'); write(serena, 'dummy');
  f.env = { ...clean, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    MOE_PROXY_PATH: path.join(scripts, 'tests', 'postflight-fake-proxy.js'), MOE_NODE_COMMAND: process.execPath,
    MOE_ACCOUNT_ROTATION: 'off', MOE_DISABLE_HEARTBEAT: '1', MOE_DISABLE_ARGV_PROBE: '1', MOE_SERENA_PATH: serena,
    MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER: '1', FAKE_TASK_STATUS: 'REVIEW', FAKE_SCOPE_PEERS_ACTIVE: '1',
    LITERAL_FIXTURE: JSON.stringify(f) };
  const pathKey = Object.keys(f.env).find(key => key.toLowerCase() === 'path') || 'Path';
  f.env[pathKey] = path.dirname(process.execPath) + path.delimiter + (f.env[pathKey] || '');
  if (cli === 'claude') f.env.MOE_DAEMON_PATH = source;
  f.cli = path.join(root, `${cli}.ps1`);
  write(f.cli, `\ufeff& ${psquote(process.execPath)} ${psquote(source)} cli @args\nexit $LASTEXITCODE\n`);
  return f;
}
function launch(f, cli, engine) {
  const args = [path.join(scripts, 'moe-agent.ps1'), '-Project', f.project, '-WorkerId', 'worker-literal',
    '-Role', 'worker', '-Team', 'Literal', '-NoLoop', '-Command', f.cli];
  if (cli !== 'claude') args.push('-NoStartDaemon');
  if (cli === 'codex') args.push('-CodexExec');
  if (cli === 'gemini') args.push('-GeminiExec');
  const driver = path.join(f.root, 'driver.ps1');
  // PS 5.1 itself starts in $PSHOME when its inherited cwd contains brackets.
  // Establish the promised FileSystem location before exercising the wrapper.
  write(driver, `\ufeffSet-Location -LiteralPath ${psquote(f.project)}\n$global:MoeWrapperSupervised=$true; & ` + args.map(arg => arg.startsWith('-') ? arg : psquote(arg)).join(' '));
  return run(engine, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver], f.project, f.env);
}
function assertCli(f, cli, result, output) {
  const slashProject = result.projectEnv.replaceAll('\\', '/');
  if (cli === 'claude') {
    assert.equal(result.argv[result.argv.indexOf('--model') + 1], 'claude-literal-sentinel');
    assert.match(result.systemPrompt, /ROLE-DOC-SENTINEL/); assert.match(result.systemPrompt, /KNOWN-ISSUES-SENTINEL/);
    assert.match(result.context, /literal-memory/); assert.match(output, /Daemon started/);
    assert.equal(JSON.parse(read(path.join(f.root, 'daemon-argv.json'))).project, result.projectEnv);
  } else if (cli === 'codex') {
    assert.ok(read(path.join(f.project, '.codex/config.toml')).includes(`MOE_PROJECT_PATH = "${slashProject}"`));
    assert.ok(result.argv.some(arg => arg.startsWith('mcp_servers.moe={')), 'full server override, not dotted fallback');
    assert.ok(fs.existsSync(path.join(f.project, '.codex/agent-instructions.md')));
  } else if (cli === 'gemini') {
    assert.equal(JSON.parse(read(path.join(f.project, '.gemini/settings.json'))).mcpServers.moe.env.MOE_PROJECT_PATH, result.projectEnv);
    assert.match(read(path.join(f.project, '.gemini/GEMINI.md')), /ROLE-DOC-SENTINEL/);
  } else {
    assert.ok(read(path.join(f.project, '.grok/config.toml')).includes(slashProject));
    assert.equal(result.argv[result.argv.indexOf('--cwd') + 1], result.projectEnv);
  }
}
function windowsTests() {
  const win = process.platform === 'win32';
  const pwsh = win && spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', timeout: 10000 }).status === 0;
  const cases = ['claude', 'codex', 'gemini', 'grok'].map(cli => ['powershell.exe', cli]).concat([['pwsh.exe', 'claude']]);
  for (const [engine, cli] of cases) test(`${engine} ${cli}: literal project launch and completion`, {
    skip: !win ? 'needs Windows PowerShell' : engine === 'pwsh.exe' && !pwsh ? 'pwsh not on PATH' : false,
  }, t => {
    const f = fixture(t, cli), launched = launch(f, cli, engine);
    const output = (launched.stdout || '') + (launched.stderr || '');
    assert.equal(launched.status, 0, `${launched.error || ''}\n${output}`);
    assert.doesNotMatch(output, /wildcard path|Project path not found|not initialized for Moe|Daemon failed to start/i);
    assert.ok(fs.existsSync(f.result), output);
    const result = JSON.parse(read(f.result)), real = p => fs.realpathSync.native(p).toLowerCase();
    assert.equal(real(result.projectEnv), real(f.project)); assert.equal(real(result.cwd), real(f.project));
    assert.ok(fs.existsSync(path.join(f.project, '.claude/agents/literal-agent.md')));
    assert.match(output, /\(source: \.moe-agent\.json\)/);
    assert.match(git(f.project, ['log', '-1', '--format=%s']), /^(feat|fix)\(task-postflight\)/);
    assert.equal(git(f.project, ['show', 'HEAD:owned.txt']), 'literal edit');
    assertCli(f, cli, result, output);
  });
}

if (process.argv[2] === 'cli') fakeCli();
else if (process.argv[2] === 'start') fakeDaemon();
else { staticTests(); windowsTests(); }

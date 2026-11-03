import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// With MOE_RUNTIME_PROTECTED exactly '1' (the JetBrains protected launch), the
// agent command can come from repository content (.moe/project.json
// settings.agentCommand). Both launchers then run only claude, codex, gemini or
// grok, by bare name, resolved from an absolute PATH entry outside the project.
// Each row runs the REAL launcher in a temp project. The runtime paths point at
// an inert stub that logs every call to rpc.log, and each CLI stub logs to
// ran.log, so a row proves what never ran. Without the marker nothing changes.
const windows = process.platform === 'win32';
const SH = fileURLToPath(new URL('../moe-agent.sh', import.meta.url));
const PS1 = fileURLToPath(new URL('../moe-agent.ps1', import.meta.url));
const CAP_MS = 20_000;
const refusedLine = (shown) => `[ERROR] MOE_PROTECTED_AGENT_COMMAND_REFUSED: '${shown}' is not one of claude, codex, gemini, grok; the protected runtime runs only these agent CLIs by name. Refusing to start.`;
const notFoundLine = (name) => `[ERROR] MOE_PROTECTED_AGENT_CLI_NOT_FOUND: ${name} was not found on an absolute PATH entry outside the project; refusing to start.`;
const infoLine = (name, file) => `[INFO] MOE_PROTECTED_AGENT_CLI: ${name} -> ${file}`;
const interpreterNotFound = (name) => `[ERROR] MOE_PROTECTED_INTERPRETER_NOT_FOUND: ${name} was not found on an absolute PATH entry outside the project; refusing to start.`;
const CALL = fileURLToPath(new URL('../moe-call.sh', import.meta.url));
const psq = (v) => `'${String(v).replaceAll("'", "''")}'`;

function probe(exe) {
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
// sh rows need a POSIX PATH; Git Bash rewrites PATH, so its runs are not covered here.
const ENGINES = [{ name: 'bash', kind: 'sh', exe: '/bin/bash', skip: windows && 'the sh rows run on Linux, macOS and WSL' }];
if (windows) {
  ENGINES.push({ name: 'PowerShell 5.1', kind: 'ps1', exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') });
  ENGINES.push({ name: 'PowerShell 7', kind: 'ps1', exe: 'pwsh.exe' });
} else {
  ENGINES.push({ name: 'PowerShell 7', kind: 'ps1', exe: 'pwsh' });
}
for (const e of ENGINES) if (e.kind === 'ps1') e.skip = !probe(e.exe) && `${e.exe} is not available on ${process.platform}`;
const SEP = windows ? ';' : ':';
// System dirs the launchers need (bash, python3, git; node for legacy ps1 runs).
const TAIL = windows
  ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows', path.dirname(process.execPath)]
  : ['/usr/bin', '/bin'];
const CLI_FILES = (name) => (windows ? ['.exe', '.cmd', '.bat', '.com'].map((x) => name + x) : [name]);
// Every CLI launch first runs the agent Git guard, which needs git; a Windows TAIL has none.
const GIT_DIR = windows ? (() => { const r = spawnSync('where.exe', ['git'], { encoding: 'utf8' }); const f = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : ''; return f ? path.dirname(f) : null; })() : null;
const tailHas = (name) => TAIL.some((d) => CLI_FILES(name).some((f) => existsSync(path.join(d, f))));

// A fixture root with: home, tmp, a project (.moe, ./<cli>, bin/<cli>), a trusted
// dir and a trusted dir without the CLI. Every CLI stub appends '<where> <name>'
// to ran.log; the runtime stub appends to rpc.log.
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'moe-protected-cmd-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = { root, home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), project: path.join(root, 'project'),
    trusted: path.join(root, 'trusted'), empty: path.join(root, 'empty'), custom: path.join(root, 'custom'),
    runtime: path.join(root, 'runtime.js'), ran: path.join(root, 'ran.log'), rpc: path.join(root, 'rpc.log'), mcp: path.join(root, 'mcp-snapshot.json') };
  for (const d of [fx.home, fx.tmp, path.join(fx.project, '.moe'), path.join(fx.project, 'bin'), fx.trusted, fx.empty, fx.custom]) mkdirSync(d, { recursive: true });
  // PS removes its temp config on exit; capture the actual bytes at the RPC boundary.
  // FAKE_RPC_TOOLS=1 (sh rows: every call pipes its request in) also logs each tool.
  writeFileSync(fx.runtime, `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(fx.rpc)}, 'rpc\\n');
for (const f of fs.readdirSync(${JSON.stringify(fx.tmp)})) if (/^moe-mcp-config-.*\\.json$/.test(f))
  fs.copyFileSync(require('path').join(${JSON.stringify(fx.tmp)}, f), ${JSON.stringify(fx.mcp)});
if (process.env.FAKE_RPC_TOOLS === '1') {
  let input = ''; process.stdin.on('data', (d) => { input += d; }).on('end', () =>
    fs.appendFileSync(${JSON.stringify(fx.rpc)}, 'tool ' + (/"name":"([^"]*)"/.exec(input) || ['', '?'])[1] + '\\n'));
  setTimeout(() => process.exit(0), 5000).unref();
}\n`);
  // moe-agent.sh puts its node's own dir first on PATH; a dir holding only node
  // keeps a host-wide codex next to the real node out of the rows.
  fx.node = windows ? 'node' : path.join(root, 'nodebin', 'node');
  if (!windows) { mkdirSync(path.dirname(fx.node)); symlinkSync(process.execPath, fx.node); }
  return fx;
}
function cliStub(fx, dir, name, where) {
  const file = path.join(dir, windows ? `${name}.cmd` : name);
  writeFileSync(file, windows ? `@echo ${where} ${name}>>"${fx.ran}"\r\n` : `#!/bin/sh\necho '${where} ${name}' >> '${fx.ran}'\n`);
  if (!windows) chmodSync(file, 0o755);
  return file;
}

function killTree(child) {
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}
// Runs one launcher; stops its process tree at `stopOn` or at the cap. A null
// marker leaves MOE_RUNTIME_PROTECTED unset.
function run(engine, fx, { command, commandArgs = [], marker = '1', pathEntries, stopOn, env: overrides = {}, nodeDir = true, wrapperArgs = [], role = 'worker' }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MOE_|CLAUDE|FAKE_|NoDefaultCurrentDirectoryInExePath$)/i.test(k)));
  Object.assign(env, { HOME: fx.home, USERPROFILE: fx.home, TMPDIR: fx.tmp, TEMP: fx.tmp, TMP: fx.tmp, PATH: [...pathEntries, ...(!windows && nodeDir ? [path.dirname(fx.node)] : [])].join(SEP),
    MOE_NODE_COMMAND: fx.node, MOE_PROXY_PATH: fx.runtime, MOE_DAEMON_PATH: fx.runtime, MOE_DISABLE_HEARTBEAT: '1' });
  env.MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER = '1'; // the filter above drops MOE_*: WT-13's guard refuses SH/PS1 when this suite runs from a task worktree (task-86431c31)
  if (windows) delete env.Path;
  if (marker !== null) env.MOE_RUNTIME_PROTECTED = marker;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  const common = { role, id: `${role}-protected-cmd` };
  let exe = engine.exe;
  let argv;
  if (engine.kind === 'sh') {
    argv = [SH, '--role', common.role, '--project', fx.project, '--worker-id', common.id, '--command', command, '--no-loop', '--no-start-daemon', ...wrapperArgs];
  } else {
    if (!path.isAbsolute(exe)) exe = spawnSync(windows ? 'where.exe' : 'which', [exe], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
    const extra = commandArgs.length ? ` -CommandArgs @(${commandArgs.map(psq).join(',')})` : '';
    argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ${psq(PS1)} -Role ${common.role} -Project ${psq(fx.project)} -WorkerId ${common.id} -Command ${psq(command)}${extra} -NoLoop -NoStartDaemon; exit $LASTEXITCODE`];
  }
  return launch(exe, argv, fx, env, stopOn);
}
function launch(exe, argv, fx, env, stopOn) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { cwd: fx.project, env, detached: !windows, windowsHide: true });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { if (!stopped) { stopped = true; killTree(child); } };
    const timer = setTimeout(stop, CAP_MS);
    const seen = () => { if (stopOn && (stdout + stderr).includes(stopOn)) stop(); };
    child.stdout.on('data', (d) => { stdout += d; seen(); });
    child.stderr.on('data', (d) => { stderr += d; seen(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stopped, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') });
    });
  });
}
const lines = (r) => `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
const protectedLines = (r) => lines(r).filter((l) => l.includes('MOE_PROTECTED_'));
const show = (r) => `exit ${r.code}${r.stopped ? ' (stopped)' : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
function mcpWritten(engine, fx) {
  if (engine.kind === 'sh') return existsSync(path.join(fx.project, '.mcp.json')) || existsSync(path.join(fx.home, '.config', 'claude', 'mcp_servers.json'));
  return readdirSync(fx.tmp).some((f) => f.startsWith('moe-mcp-config-'));
}

const nodeBin = (fx) => windows ? path.dirname(process.execPath) : path.dirname(fx.node);
const pinnedNode = (fx) => path.join(realpathSync(nodeBin(fx)), windows ? 'node.exe' : 'node');
const plantedEntries = [['empty', () => ''], ['dot', () => '.'], ['relative', () => 'bin'], ['absolute in-project', (fx) => path.join(fx.project, 'bin')]];
function plantInterpreters(fx, python = true) {
  for (const dir of [fx.project, path.join(fx.project, 'bin')]) {
    cliStub(fx, dir, 'node', 'project');
    if (!windows && python) cliStub(fx, dir, 'python3', 'project');
  }
}
function systemWithoutInterpreters(fx) {
  if (windows) return TAIL.filter((d) => d !== path.dirname(process.execPath));
  const sys = path.join(fx.root, 'sys');
  mkdirSync(sys);
  for (const dir of TAIL) for (const name of readdirSync(dir)) {
    if (name !== 'node' && name !== 'python3' && !existsSync(path.join(sys, name))) {
      try { symlinkSync(path.join(dir, name), path.join(sys, name)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  return [sys];
}
function assertNode(engine, fx, r, file = pinnedNode(fx)) {
  const want = `[OK] Using node: ${file}${engine.kind === 'sh' ? ` (${process.version})` : ''}`;
  assert.ok(lines(r).includes(want), `missing ${want}\n${show(r)}`);
}
function assertRuntime(fx, r) {
  assert.equal(r.stopped, false, show(r));
  assert.ok(existsSync(fx.rpc), `no runtime call\n${show(r)}`);
  assert.doesNotMatch(existsSync(fx.ran) ? readFileSync(fx.ran, 'utf8') : '', /^project /m, show(r));
}
// sh exit: moe-call.sh found a real node by name, built the request and reached the runtime.
function assertDeregistered(fx, r) {
  assert.match(readFileSync(fx.rpc, 'utf8'), /^tool moe\.deregister_worker$/m, show(r));
}
function assertMcpNode(engine, fx) {
  const file = engine.kind === 'sh' ? path.join(fx.project, '.mcp.json') : fx.mcp;
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.mcpServers.moe.command, pinnedNode(fx));
}

for (const engine of ENGINES) {
  const opts = { skip: engine.skip };
  const name = (row) => `${engine.name}: ${row}`;
  for (const [label, entry] of plantedEntries.slice(0, 3)) {
    test(name(`N1 pins interpreters past a planted ${label} entry through runtime and exit`), opts, async (t) => {
      const fx = fixture(t); plantInterpreters(fx);
      cliStub(fx, fx.trusted, 'claude', 'trusted');
      const sh1 = engine.kind === 'sh';
      // The sh exit deregister, moe-call.sh, stops at a missing daemon.json before it runs node.
      if (sh1) writeFileSync(path.join(fx.project, '.moe', 'daemon.json'), '{}');
      const r = await run(engine, fx, { command: 'claude', pathEntries: [entry(fx), fx.empty, nodeBin(fx), fx.trusted, ...TAIL], env: { MOE_NODE_COMMAND: undefined, ...(sh1 && { FAKE_RPC_TOOLS: '1' }) } });
      assertRuntime(fx, r); assertNode(engine, fx, r); assertMcpNode(engine, fx);
      if (sh1) {
        assert.ok(lines(r).includes(`[OK] Using python3: ${path.join(realpathSync('/usr/bin'), 'python3')}`), show(r));
        assertDeregistered(fx, r);
      }
    });
  }
  test(name('N2 skips direct, linked and dot-dot in-project node directories'), opts, async (t) => {
    const fx = fixture(t); plantInterpreters(fx);
    if (windows) copyFileSync(path.join(TAIL[0], 'whoami.exe'), path.join(fx.project, 'bin', 'node.exe'));
    cliStub(fx, fx.trusted, 'claude', 'trusted');
    const link = path.join(fx.root, 'link'); symlinkSync(fx.project, link, windows ? 'junction' : 'dir');
    for (const entry of [path.join(fx.project, 'bin'), path.join(link, 'bin'), `${fx.project}${path.sep}..${path.sep}project${path.sep}bin`]) {
      const r = await run(engine, fx, { command: 'claude', pathEntries: [entry, nodeBin(fx), fx.trusted, ...TAIL], stopOn: 'MOE_PROTECTED_AGENT_CLI:', env: { MOE_NODE_COMMAND: undefined } });
      assertResolved(fx, r, 'claude', path.join(fx.trusted, windows ? 'claude.cmd' : 'claude'));
      assertNode(engine, fx, r);
    }
  });
  for (const [label, entry] of plantedEntries) {
    test(name(`N4 refuses node with only a planted ${label} entry`), opts, async (t) => {
      const fx = fixture(t); plantInterpreters(fx);
      const r = await run(engine, fx, { command: 'claude', pathEntries: [entry(fx), ...systemWithoutInterpreters(fx)], nodeDir: false, env: { MOE_NODE_COMMAND: undefined } });
      assertRefused(engine, fx, r, interpreterNotFound('node'));
    });
  }
  for (const marker of [null, '01']) {
    test(name(`L2 legacy interpreter lookup with marker ${marker ?? 'unset'}`), opts, async (t) => {
      const fx = fixture(t); cliStub(fx, fx.trusted, 'claude', 'trusted');
      const r = await run(engine, fx, { command: 'claude', marker, pathEntries: [nodeBin(fx), fx.trusted, ...TAIL], env: { MOE_NODE_COMMAND: undefined } });
      assertRuntime(fx, r); assert.deepEqual(protectedLines(r), [], show(r));
      if (engine.kind === 'sh') {
        assertNode(engine, fx, r, 'node');
        assert.ok(lines(r).includes('[OK] Using python3: python3'), show(r));
      } else assert.ok(lines(r).every((l) => !l.includes('Using node:')), show(r));
    });
  }
}
const sh = ENGINES[0];
for (const arg of ['--help', '--unknown-option']) {
  test(`bash: N0 early ${arg} exit never deregisters before interpreter pinning`, { skip: sh.skip }, async (t) => {
    const fx = fixture(t); plantInterpreters(fx);
    writeFileSync(path.join(fx.project, '.moe', 'daemon.json'), '{}');
    const r = await run(sh, fx, { command: 'claude', pathEntries: ['.', nodeBin(fx), ...TAIL], wrapperArgs: [arg] });
    assert.equal(r.stopped, false, show(r));
    assert.equal(r.code, arg === '--help' ? 0 : 1, show(r));
    assert.equal(existsSync(fx.ran), false, `an interpreter ran before pinning\n${show(r)}`);
    assert.equal(existsSync(fx.rpc), false, show(r));
    assert.equal(mcpWritten(sh, fx), false, show(r));
    assert.deepEqual(readdirSync(fx.tmp), [], show(r));
  });
}
for (const override of ['node', './node', 'project', 'outside', 'managed']) {
  test(`bash: N3 accepts only trusted absolute overrides (${override})`, { skip: sh.skip }, async (t) => {
    const fx = fixture(t); plantInterpreters(fx);
    cliStub(fx, fx.trusted, 'claude', 'trusted');
    let value = override === 'project' ? path.join(fx.project, 'node') : override;
    let expected = fx.node;
    if (override === 'outside' || override === 'managed') {
      expected = override === 'outside' ? path.join(fx.root, 'altnode', 'node') : path.join(fx.home, '.local/share/moe/node/current/bin/node');
      mkdirSync(path.dirname(expected), { recursive: true }); symlinkSync(process.execPath, expected);
      value = override === 'managed' ? undefined : expected;
    }
    const r = await run(sh, fx, { command: 'claude', pathEntries: [nodeBin(fx), fx.trusted, ...TAIL], stopOn: 'MOE_PROTECTED_AGENT_CLI:', env: { MOE_NODE_COMMAND: value } });
    assertResolved(fx, r, 'claude', path.join(fx.trusted, 'claude')); assertNode(sh, fx, r, expected);
  });
}
// use_node puts only the pinned file's dir first on PATH, while moe-call.sh and env
// shebangs look up the NAME node: an override with another name must be skipped.
for (const [label, entry] of plantedEntries) {
  test(`bash: N5 skips a trusted override not named node, so a planted ${label} node never runs at exit`, { skip: sh.skip }, async (t) => {
    const fx = fixture(t); plantInterpreters(fx);
    cliStub(fx, fx.trusted, 'claude', 'trusted');
    writeFileSync(path.join(fx.project, '.moe', 'daemon.json'), '{}');
    const alt = path.join(fx.root, 'altnode', 'nodejs');
    mkdirSync(path.dirname(alt)); symlinkSync(process.execPath, alt);
    const r = await run(sh, fx, { command: 'claude', pathEntries: [entry(fx), nodeBin(fx), fx.trusted, ...TAIL], env: { MOE_NODE_COMMAND: alt, FAKE_RPC_TOOLS: '1' } });
    assertRuntime(fx, r); assertNode(sh, fx, r); assertDeregistered(fx, r);
  });
}
for (const [label, entry] of plantedEntries) {
  test(`bash: P1 refuses python3 with only a planted ${label} entry`, { skip: sh.skip }, async (t) => {
    const fx = fixture(t); plantInterpreters(fx);
    const r = await run(sh, fx, { command: 'claude', pathEntries: [entry(fx), nodeBin(fx), ...systemWithoutInterpreters(fx)] });
    assertRefused(sh, fx, r, interpreterNotFound('python3'));
  });
}
test('bash: M1 protected moe-call never probes a planted python3', { skip: sh.skip }, async (t) => {
  const fx = fixture(t); cliStub(fx, fx.project, 'python3', 'project');
  writeFileSync(path.join(fx.project, '.moe', 'daemon.json'), '{}');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MOE_|CLAUDE|FAKE_)/i.test(k)));
  Object.assign(env, { HOME: fx.home, MOE_RUNTIME_PROTECTED: '1', MOE_PROXY_PATH: fx.runtime, PATH: ['.', nodeBin(fx), ...TAIL].join(SEP) });
  const r = await launch(sh.exe, [CALL, 'get_context', '{}', '--project', fx.project], fx, env);
  assertRuntime(fx, r);
  assert.equal(r.code, 1, show(r)); // The logging-only runtime deliberately sends no reply.
  assert.equal(r.stderr, 'Error: no response from daemon\n', show(r));
});
test('S1 PowerShell non-command node launches use the protected pin', () => {
  const src = readFileSync(PS1, 'utf8').replace(/^\s*#.*$/gm, '');
  for (const bare of ['-FilePath "node"', 'command = "node"', 'command = `"node`"']) assert.ok(!src.includes(bare), bare);
  assert.match(src, /ProcessStartInfo\]::new\('node',[^\n]*\n\s*if \(\$script:MoeNode\) \{ \$psi\.FileName = \$script:MoeNode \}/);
  assert.equal(src.split('Set-Alias -Name node -Value $script:MoeNode -Scope Script').length - 1, 1);
  assert.equal(src.split('Set-Alias -Name node -Value $Pin.Node').length - 1, 1);
  for (const name of ['Codex', 'Grok']) {
    const start = src.indexOf(`function Write-Moe${name}Config`);
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    assert.ok(body.includes("$nodeForToml = if ($script:MoeNode) { $script:MoeNode.Replace('\\', '/') } else { 'node' }"), `${name} normalizes its node`);
    assert.ok(body.includes(name === 'Codex' ? 'command = "$nodeForToml"' : 'command = `"$nodeForToml`"'), `${name} emits its node`);
  }
  assert.equal(src.split("command = $(if ($script:MoeNode) { $script:MoeNode } else { 'node' })").length - 1, 2, 'both JSON writers pin node');
  assert.ok(src.includes("Start-Process -FilePath $(if ($script:MoeNode) { $script:MoeNode } else { 'node' })"));
  assert.match(src, /Node = \[string\]\$script:MoeNode/);
});
// One refusal: exit 1, exactly the wanted line on stderr and no other
// MOE_PROTECTED_ line, no CLI ran, no runtime call, no MCP config written.
function assertRefused(engine, fx, r, want) {
  assert.equal(r.code, 1, show(r));
  assert.deepEqual(protectedLines(r), [want], show(r));
  assert.ok(r.stderr.split('\n').includes(want), `refusal not on stderr\n${show(r)}`);
  assert.equal(existsSync(fx.ran), false, `a CLI ran\n${show(r)}`);
  assert.equal(existsSync(fx.rpc), false, `a runtime call was made\n${show(r)}`);
  assert.equal(mcpWritten(engine, fx), false, `an MCP config was written\n${show(r)}`);
}
// Stopped at the INFO line (taskkill /F leaves exit code 1 on Windows, so the
// code proves nothing there); a refusal exits on its own and is never stopped.
function assertResolved(fx, r, name, file) {
  assert.ok(r.stopped && (windows || r.code !== 1), `expected to reach the INFO line\n${show(r)}`);
  assert.deepEqual(protectedLines(r), [infoLine(name, file)], show(r));
  assert.equal(existsSync(fx.ran), false, `a CLI ran\n${show(r)}`);
}

for (const engine of ENGINES) {
  const opts = { skip: engine.skip };
  const name = (row) => `${engine.name}: ${row}`;
  const refusals = [['a path', (fx) => path.join(fx.custom, 'claude')], ['inline args', () => 'claude --flag'],
    ['an extension', () => 'claude.exe'], ['another case', () => 'CLAUDE'], ['an empty value', () => '']];
  for (const [label, value] of refusals) {
    test(name(`R1 refuses ${label}`), opts, async (t) => {
      const fx = fixture(t);
      cliStub(fx, fx.trusted, 'claude', 'trusted'); cliStub(fx, fx.custom, 'claude', 'custom');
      const command = value(fx);
      assertRefused(engine, fx, await run(engine, fx, { command, pathEntries: [fx.trusted, ...TAIL] }), refusedLine(command));
    });
  }
  if (engine.kind === 'ps1') {
    test(name('R1 refuses -CommandArgs'), opts, async (t) => {
      const fx = fixture(t);
      cliStub(fx, fx.trusted, 'claude', 'trusted');
      const r = await run(engine, fx, { command: 'claude', commandArgs: ['--flag'], pathEntries: [fx.trusted, ...TAIL] });
      assertRefused(engine, fx, r, refusedLine('claude --flag'));
    });
  }
  test(name('R2 shows the command with control characters replaced, cut to 200'), opts, async (t) => {
    const fx = fixture(t);
    const command = `claude\x1b]0;x\x07\nb${'y'.repeat(300)}`;
    const shown = `claude?]0;x??b${'y'.repeat(300)}`.slice(0, 200);
    assertRefused(engine, fx, await run(engine, fx, { command, pathEntries: [fx.trusted, ...TAIL] }), refusedLine(shown));
  });
  test(name('A1 resolves codex from a trusted absolute PATH entry'), opts, async (t) => {
    const fx = fixture(t);
    const file = cliStub(fx, fx.trusted, 'codex', 'trusted');
    const r = await run(engine, fx, { command: 'codex', pathEntries: [fx.empty, fx.trusted, ...TAIL], stopOn: 'MOE_PROTECTED_AGENT_CLI:' });
    assertResolved(fx, r, 'codex', file);
  });
  const notFound = [['an empty entry', () => ''], ['a dot entry', () => '.'], ['a relative entry', () => 'bin']];
  for (const [label, entry] of notFound) {
    test(name(`T1/T2 never runs a project-local claude reachable only through ${label}`), { skip: engine.skip || (tailHas('claude') && 'a system PATH dir holds claude') }, async (t) => {
      const fx = fixture(t);
      cliStub(fx, fx.project, 'claude', 'project'); cliStub(fx, path.join(fx.project, 'bin'), 'claude', 'project-bin');
      const r = await run(engine, fx, { command: 'claude', pathEntries: [entry(), fx.empty, ...TAIL] });
      assertRefused(engine, fx, r, notFoundLine('claude'));
    });
  }
  test(name('T3 skips an in-project PATH entry, spelled directly or through a link'), opts, async (t) => {
    const fx = fixture(t);
    cliStub(fx, path.join(fx.project, 'bin'), 'claude', 'project-bin');
    const file = cliStub(fx, fx.trusted, 'claude', 'trusted');
    const link = path.join(fx.root, 'link');
    symlinkSync(fx.project, link, windows ? 'junction' : 'dir');
    for (const entry of [path.join(fx.project, 'bin'), path.join(link, 'bin'), path.join(fx.project, '..', 'project', 'bin')]) {
      const r = await run(engine, fx, { command: 'claude', pathEntries: [entry, fx.trusted, ...TAIL], stopOn: 'MOE_PROTECTED_AGENT_CLI:' });
      assertResolved(fx, r, 'claude', file);
    }
  });
  for (const marker of [null, '01']) {
    test(name(`L1 legacy (marker ${marker ?? 'unset'}) keeps custom commands`), opts, async (t) => {
      const fx = fixture(t);
      cliStub(fx, fx.trusted, 'claude', 'trusted');
      const custom = cliStub(fx, fx.custom, 'claude', 'custom');
      for (const command of [custom, 'claude --flag']) {
        const r = await run(engine, fx, { command, marker, pathEntries: [fx.trusted, ...TAIL] });
        assert.deepEqual(protectedLines(r), [], show(r));
        assert.equal(r.stopped, false, `the legacy run hit the cap\n${show(r)}`);
        assert.ok(existsSync(fx.rpc), `the legacy run stopped before its first runtime call\n${show(r)}`);
        rmSync(fx.rpc, { force: true });
      }
    });
  }
}

// cmd.exe runs an npm .cmd shim (claude.cmd runs node by bare name) and looks a
// bare name up in the current directory, the project, before PATH. Under the
// marker both launchers export NoDefaultCurrentDirectoryInExePath=1, which every
// cmd.exe in the seat honours, and so does Node 22+ (libuv 1.48+) for its own
// bare-name spawns; G1 covers that. A
// governor seat launches its CLI without a claimed task, so the inert runtime
// is enough to reach the CLI; a worker row stops at MOE_TASKLESS_NO_LAUNCH.
test('bash: C1 only the marker gives the CLI NoDefaultCurrentDirectoryInExePath=1', { skip: sh.skip }, async (t) => {
  const fx = fixture(t);
  const file = path.join(fx.trusted, 'claude');
  writeFileSync(file, `#!/bin/sh\necho "env [\${NoDefaultCurrentDirectoryInExePath-unset}]" >> '${fx.ran}'\n`);
  chmodSync(file, 0o755);
  for (const [marker, want] of [['1', 'env [1]'], [null, 'env [unset]'], ['01', 'env [unset]']]) {
    rmSync(fx.ran, { force: true });
    const r = await run(sh, fx, { command: 'claude', marker, role: 'governor', pathEntries: [nodeBin(fx), fx.trusted, ...TAIL], env: { MOE_NODE_COMMAND: undefined } });
    assert.equal(r.code, 0, show(r));
    assert.equal(existsSync(fx.ran) ? readFileSync(fx.ran, 'utf8') : '', `${want}\n`, show(r));
  }
});
for (const engine of ENGINES.filter((e) => e.kind === 'ps1')) {
  const skip = engine.skip || (!windows && 'cmd.exe lookup order is Windows-only') || (!GIT_DIR && 'git is not on PATH, and the agent Git guard needs it');
  test(`${engine.name}: C2 a node.exe or .cmd helper planted at the project root never runs through the CLI's .cmd shim`, { skip }, async (t) => {
    const fx = fixture(t);
    copyFileSync(process.execPath, path.join(fx.project, 'node.exe'));
    cliStub(fx, fx.project, 'moehelper', 'project'); cliStub(fx, fx.trusted, 'moehelper', 'trusted');
    const js = path.join(fx.root, 'which-node.js');
    writeFileSync(js, `require('fs').appendFileSync(process.argv[2], 'node ' + process.execPath + '\\n');\n`);
    // npm's shim shape: node by bare name when no node.exe sits beside the shim.
    writeFileSync(path.join(fx.trusted, 'claude.cmd'), `@echo env [%NoDefaultCurrentDirectoryInExePath%]>>"${fx.ran}"\r\n@node "${js}" "${fx.ran}"\r\n@call moehelper\r\n`);
    // Legacy keeps cmd.exe's order, which also proves the planted files are reachable.
    for (const [marker, want] of [['1', ['env [1]', `node ${pinnedNode(fx)}`, 'trusted moehelper']], [null, ['env []', `node ${path.join(fx.project, 'node.exe')}`, 'project moehelper']]]) {
      rmSync(fx.ran, { force: true });
      const r = await run(engine, fx, { command: 'claude', marker, role: 'governor', pathEntries: [nodeBin(fx), fx.trusted, ...TAIL, GIT_DIR], env: { MOE_NODE_COMMAND: undefined } });
      assert.equal(r.code, 0, show(r));
      const got = (existsSync(fx.ran) ? readFileSync(fx.ran, 'utf8') : '').split(/\r?\n/).filter(Boolean);
      assert.deepEqual(got.map((l) => l.toLowerCase()), want.map((l) => l.toLowerCase()), show(r));
    }
  });
}

// The agent Git guard is a Node program. Node 22+ skips the current directory for a bare name under
// NoDefaultCurrentDirectoryInExePath, older Node does not, and no Node skips a '.', relative or
// in-project PATH entry. Under the marker the launcher passes the guard git's absolute path, from an
// absolute PATH entry outside the project, and the guard runs %SystemRoot%'s powershell.exe
// (task-52555102). The project is a Git repository, so the guard reaches its powershell.exe ACL step too.
for (const engine of ENGINES.filter((e) => e.kind === 'ps1')) {
  const skip = engine.skip || (!windows && 'the current-directory lookup is Windows-only') || (!GIT_DIR && 'git is not on PATH, and the agent Git guard needs it');
  test(`${engine.name}: G1 a git.exe or powershell.exe planted at the project root never runs in the agent Git guard`, { skip }, async (t) => {
    const fx = fixture(t);
    assert.equal(spawnSync(path.join(GIT_DIR, 'git.exe'), ['init', '-q', fx.project]).status, 0);
    for (const name of ['git.exe', 'powershell.exe']) copyFileSync(process.execPath, path.join(fx.project, name));
    // NODE_OPTIONS makes every node.exe in the seat, the planted copies included, log itself.
    const log = path.join(fx.root, 'exe.log'), js = path.join(fx.root, 'which-exe.js');
    writeFileSync(js, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, exe: process.execPath, args: process.argv.slice(1) }) + '\\n');\n`);
    cliStub(fx, fx.trusted, 'claude', 'trusted');
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    // The guard is the `node - <project> ...` program; only its children count. A '.' entry also reaches
    // the launcher's own PowerShell lookups, which this row does not cover (task-3acf7f79).
    const guardChildren = () => {
      const rows = (existsSync(log) ? readFileSync(log, 'utf8') : '').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const guards = new Set(rows.filter((e) => e.args[0] === '-' && e.args[1] && same(e.args[1], fx.project)).map((e) => e.pid));
      assert.ok(guards.size > 0, 'the agent Git guard never ran');
      return [...new Set(rows.filter((e) => guards.has(e.ppid) && same(path.dirname(e.exe), fx.project)).map((e) => path.basename(e.exe).toLowerCase()))];
    };
    // A '.' PATH entry reaches the plant through any Node; without one, only the current-directory lookup
    // could. Legacy keeps Node's lookup, which also proves the planted file is reachable.
    for (const [marker, dot, want] of [['1', true, []], ['1', false, []], [null, false, ['git.exe']]]) {
      rmSync(log, { force: true }); rmSync(fx.ran, { force: true });
      const r = await run(engine, fx, { command: 'claude', marker, role: 'governor', pathEntries: [...(dot ? ['.'] : []), nodeBin(fx), fx.trusted, ...TAIL, GIT_DIR],
        env: { MOE_NODE_COMMAND: undefined, NODE_OPTIONS: `--require "${js.replaceAll('\\', '/')}"` } });
      assert.deepEqual(guardChildren(), want, show(r));
      if (marker) {
        assert.equal(r.code, 0, show(r));
        assert.match(existsSync(fx.ran) ? readFileSync(fx.ran, 'utf8') : '', /^trusted claude/m, show(r));
      }
    }
  });
}
test('bash: G2 the agent Git guard never runs a git that only an in-project PATH entry reaches', { skip: sh.skip }, async (t) => {
  const fx = fixture(t);
  const log = path.join(fx.root, 'git.log'), planted = path.join(fx.project, 'git');
  // Logs the command line of the process that ran it (node for the guard, bash for the launcher), then runs the real git.
  writeFileSync(planted, `#!/bin/sh\nps -o args= -p "$PPID" >> '${log}'\nexec '${path.join(realpathSync('/usr/bin'), 'git')}' "$@"\n`);
  chmodSync(planted, 0o755);
  cliStub(fx, fx.trusted, 'claude', 'trusted');
  for (const [marker, guardRan] of [['1', false], [null, true]]) {
    rmSync(log, { force: true });
    const r = await run(sh, fx, { command: 'claude', marker, role: 'governor', pathEntries: [fx.project, nodeBin(fx), fx.trusted, ...TAIL], env: { MOE_NODE_COMMAND: undefined } });
    assert.equal(r.code, 0, show(r));
    const parents = (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.trim()).map((l) => path.basename(l.trim().split(/\s+/)[0]));
    assert.equal(parents.includes('node'), guardRan, `${parents.join(',')}\n${show(r)}`);
  }
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const tailHas = (name) => TAIL.some((d) => CLI_FILES(name).some((f) => existsSync(path.join(d, f))));

// A fixture root with: home, tmp, a project (.moe, ./<cli>, bin/<cli>), a trusted
// dir and a trusted dir without the CLI. Every CLI stub appends '<where> <name>'
// to ran.log; the runtime stub appends to rpc.log.
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'moe-protected-cmd-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = { root, home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), project: path.join(root, 'project'),
    trusted: path.join(root, 'trusted'), empty: path.join(root, 'empty'), custom: path.join(root, 'custom'),
    runtime: path.join(root, 'runtime.js'), ran: path.join(root, 'ran.log'), rpc: path.join(root, 'rpc.log') };
  for (const d of [fx.home, fx.tmp, path.join(fx.project, '.moe'), path.join(fx.project, 'bin'), fx.trusted, fx.empty, fx.custom]) mkdirSync(d, { recursive: true });
  writeFileSync(fx.runtime, `require('fs').appendFileSync(${JSON.stringify(fx.rpc)}, 'rpc\\n');\n`);
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
function run(engine, fx, { command, commandArgs = [], marker = '1', pathEntries, stopOn }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MOE_|CLAUDE|FAKE_)/i.test(k)));
  Object.assign(env, { HOME: fx.home, USERPROFILE: fx.home, TMPDIR: fx.tmp, TEMP: fx.tmp, TMP: fx.tmp, PATH: pathEntries.join(SEP),
    MOE_NODE_COMMAND: fx.node, MOE_PROXY_PATH: fx.runtime, MOE_DAEMON_PATH: fx.runtime, MOE_DISABLE_HEARTBEAT: '1' });
  if (windows) delete env.Path;
  if (marker !== null) env.MOE_RUNTIME_PROTECTED = marker;
  const common = { role: 'worker', id: 'worker-protected-cmd' };
  let exe = engine.exe;
  let argv;
  if (engine.kind === 'sh') {
    argv = [SH, '--role', common.role, '--project', fx.project, '--worker-id', common.id, '--command', command, '--no-loop', '--no-start-daemon'];
  } else {
    if (!path.isAbsolute(exe)) exe = spawnSync(windows ? 'where.exe' : 'which', [exe], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
    const extra = commandArgs.length ? ` -CommandArgs @(${commandArgs.map(psq).join(',')})` : '';
    argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ${psq(PS1)} -Role ${common.role} -Project ${psq(fx.project)} -WorkerId ${common.id} -Command ${psq(command)}${extra} -NoLoop -NoStartDaemon; exit $LASTEXITCODE`];
  }
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { cwd: fx.project, env, detached: !windows, windowsHide: true });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { if (!stopped) { stopped = true; killTree(child); } };
    const timer = setTimeout(stop, CAP_MS);
    const seen = () => { if (stopOn && (stdout + stderr).includes(stopOn)) stop(); };
    child.stdout.on('data', (d) => { stdout += d; seen(); });
    child.stderr.on('data', (d) => { stderr += d; seen(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stopped, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') });
    });
  });
}
const lines = (r) => `${r.stdout}\n${r.stderr}`.split('\n');
const protectedLines = (r) => lines(r).filter((l) => l.includes('MOE_PROTECTED_'));
const show = (r) => `exit ${r.code}${r.stopped ? ' (stopped)' : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
function mcpWritten(engine, fx) {
  if (engine.kind === 'sh') return existsSync(path.join(fx.project, '.mcp.json')) || existsSync(path.join(fx.home, '.config', 'claude', 'mcp_servers.json'));
  return readdirSync(fx.tmp).some((f) => f.startsWith('moe-mcp-config-'));
}
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
function assertResolved(fx, r, name, file) {
  assert.ok(r.stopped && r.code !== 1, `expected to reach the INFO line\n${show(r)}`);
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

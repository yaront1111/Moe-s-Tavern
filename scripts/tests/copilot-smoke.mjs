// Real-CLI smoke of a GitHub Copilot CLI worker seat (task-59e1d150). A scratch daemon and git project hold one
// approved one-step task, and the seat is launched the way JetBrains launches it: scripts/moe-agent.sh with
// --no-interactive (engine sh), or moe-agent.ps1 on Windows PowerShell 5.1 through `& <ps1> ... -Interactive:$false`
// (engine ps1). The seat must claim the task, read the smoke-canary memory through the serena MCP server, write
// proof.txt, complete the task through the moe server and land a completion commit.
// Run it from a snapshot whose packages/moe-daemon/dist and packages/moe-proxy/dist are built:
//   node scripts/tests/copilot-smoke.mjs <sh|ps1> [--command <cli>] [--keep]
// Verdicts: PASS exit 0; BLOCKED exit 3 (a human prerequisite: the CLI missing or signed out, an account without
// Copilot CLI, MCP servers blocked by policy, an argv rejection); FAIL exit 1; usage error exit 2. A real run spends
// Copilot requests. The driver never reads ~/.copilot or a credential file, never prints env values, and signals
// only the processes it spawned, by recorded PID. SMOKE_TIMEOUT_SEC bounds the seat (default 900).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node scripts/tests/copilot-smoke.mjs <sh|ps1> [--command <cli>] [--keep]';
const BLOCKED_RE = /MOE_COPILOT_(?:NOT_FOUND|SIGNED_OUT|NOT_ENTITLED|MCP_BLOCKED)|MOE_CLI_ARGV_REJECTED: the installed copilot/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const PREFIX = 'moe-copilot-smoke-';
const ARCHITECT = 'smoke-architect';
const SERENA_NEEDLE = "read_memory: memory_name='smoke-canary'";
const CLAUDE_MCP = path.join(os.homedir(), '.config', 'claude', 'mcp_servers.json');
const root = fileURLToPath(new URL('../../', import.meta.url));
const daemonEntry = path.join(root, 'packages/moe-daemon/dist/index.js');
const proxyEntry = path.join(root, 'packages/moe-proxy/dist/index.js');
const S = { diagnostics: '' }; // everything this run owns: scratch, daemon, proxy, board, seat, log fd
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => !child || child.exitCode !== null || child.signalCode !== null;

function usage(message) {
  console.error(`copilot-smoke: ${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const [engine, ...rest] = argv;
  const opts = { engine, cli: 'copilot', keep: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--keep') opts.keep = true;
    else if (rest[i] === '--command' && rest[i + 1]) opts.cli = rest[++i];
    else usage(`unknown argument ${JSON.stringify(rest[i])}`);
  }
  if (engine !== 'sh' && engine !== 'ps1') usage('the engine must be sh or ps1');
  if ((engine === 'ps1') !== (process.platform === 'win32')) usage(`engine ${engine} cannot run on ${process.platform}`);
  const base = path.basename(opts.cli.replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '');
  if (base !== 'copilot') usage(`--command must name a copilot CLI (its base name is ${base}), or the wrapper types the seat as claude`);
  if (!fs.existsSync(daemonEntry) || !fs.existsSync(proxyEntry)) usage('build packages/moe-daemon and packages/moe-proxy first (run from a built snapshot)');
  return opts;
}

/** The seat's env: never the live seat's identity (MOE_* except MOE_SERENA_PATH) nor its Claude settings (CLAUDE*). */
function seatEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const upper = key.toUpperCase();
    return !upper.startsWith('CLAUDE') && !(upper.startsWith('MOE_') && upper !== 'MOE_SERENA_PATH');
  }));
}

async function until(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

function capture(stream, label) {
  stream.on('data', chunk => { S.diagnostics = `${S.diagnostics}\n${label}: ${chunk}`.slice(-8000); });
}

function git(args) {
  return execFileSync('git', ['-C', S.project, '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The scratch git project: a seed commit on main and the Serena canary memory; returns the canary. */
function makeFixture() {
  S.scratch = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  S.project = path.join(S.scratch, 'project');
  S.profile = path.join(S.scratch, 'profile');
  fs.mkdirSync(path.join(S.project, '.serena', 'memories'), { recursive: true });
  fs.mkdirSync(S.profile);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Moe Copilot Smoke']);
  git(['config', 'user.email', 'copilot-smoke@moe.invalid']);
  fs.writeFileSync(path.join(S.project, '.gitignore'), '.moe/\n.mcp.json\n.serena/\n.worktrees/\n');
  fs.writeFileSync(path.join(S.project, 'README.md'), '# Copilot smoke project\n');
  git(['add', '.gitignore', 'README.md']);
  git(['commit', '-q', '-m', 'seed']);
  const canary = `CANARY-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(path.join(S.project, '.serena', 'memories', 'smoke-canary.md'), canary);
  return canary;
}

async function startDaemon(env) {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  S.daemon = spawn(process.execPath, [daemonEntry, 'init', '--project', S.project, '--port', String(port)],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  capture(S.daemon.stdout, 'daemon');
  capture(S.daemon.stderr, 'daemon stderr');
  let spawnError;
  S.daemon.once('error', error => { spawnError = error; });
  return until(async () => {
    if (spawnError) throw spawnError;
    if (exited(S.daemon)) throw new Error('the scratch daemon exited before it became healthy');
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(S.project, '.moe/daemon.json'), 'utf8')); } catch { return false; }
    if (path.resolve(info.projectPath) !== path.resolve(S.project)) throw new Error(`daemon.json names ${info.projectPath}`);
    try { return (await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1000) })).ok && info; }
    catch { return false; }
  }, 'scratch daemon health');
}

/** A stdio MCP client over the built proxy; returns call(name, args) for moe.* tools. */
function connectProxy(env) {
  S.proxy = spawn(process.execPath, [proxyEntry], { env: { ...env, MOE_PROJECT_PATH: S.project }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  capture(S.proxy.stderr, 'proxy stderr');
  const pending = new Map();
  let sequence = 0;
  let failure;
  const fail = error => { failure = error; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  S.proxy.on('error', fail);
  S.proxy.on('exit', code => fail(new Error(`the proxy exited (${code})`)));
  createInterface({ input: S.proxy.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${request.label}: ${JSON.stringify(message.error)}`));
    else request.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${params.name || method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer, label: params.name || method });
    S.proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name: `moe.${name}`, arguments: args });
    const text = result.content?.find(item => item.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(`moe.${name} refused: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return { rpc, call };
}

/** A PLANNING task planned by a scratch architect, then approved on the board; returns its id at WORKING. */
async function seedTask(call, port) {
  const { epic } = await call('create_epic', { title: 'Copilot smoke' });
  const { task } = await call('create_task', { epicId: epic.id, title: 'Copy the smoke-canary memory into proof.txt',
    definitionOfDone: ['proof.txt holds the smoke-canary memory'] });
  await call('set_task_status', { taskId: task.id, status: 'PLANNING' });
  const { team } = await call('create_team', { name: 'Smoke architect', role: 'architect' });
  await call('join_team', { teamId: team.id, workerId: ARCHITECT });
  await call('claim_next_task', { workerId: ARCHITECT, statuses: ['PLANNING'], taskId: task.id });
  await call('get_context', { taskId: task.id, workerId: ARCHITECT });
  await call('submit_plan', { taskId: task.id, workerId: ARCHITECT, steps: [{ newFiles: ['proof.txt'],
    description: "Read the memory named smoke-canary with the serena MCP server's read_memory tool (do not open files under .serena yourself), then create proof.txt in the project root whose whole content is exactly that memory's text." }] });
  let context = await call('get_context', { taskId: task.id });
  const WebSocket = createRequire(proxyEntry)('ws');
  S.board = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  S.board.on('error', error => { S.diagnostics = `${S.diagnostics}\nboard: ${error.message}`.slice(-8000); });
  await until(() => S.board.readyState === WebSocket.OPEN, 'board socket open', 15_000);
  if (context.task.status !== 'WORKING') {
    S.board.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: task.id, expectedPlanRevision: context.servedContext.planRevision } }));
    await until(async () => (context = await call('get_context', { taskId: task.id })).task.status === 'WORKING', 'board approval');
  }
  return task.id;
}

/** Records every worker type the daemon (list_workers) and the board feed (/ws) report for the seat. */
function watchSeat(call, seatId, taskId) {
  const seen = { daemon: [], board: new Set(), lastDaemon: null, pollErrors: 0, stop: false };
  const matches = w => w && (w.id ?? w.workerId) !== ARCHITECT && ((w.id ?? w.workerId) === seatId || w.currentTaskId === taskId);
  S.board.on('message', data => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    const workers = message.type === 'STATE_SNAPSHOT' ? message.payload?.workers ?? []
      : ['WORKER_CREATED', 'WORKER_UPDATED'].includes(message.type) ? [message.payload] : [];
    for (const w of workers) if (matches(w) && w.type) seen.board.add(w.type);
  });
  S.board.send(JSON.stringify({ type: 'GET_STATE' }));
  seen.done = (async () => {
    while (!seen.stop) {
      try {
        const w = ((await call('list_workers', {})).workers ?? []).find(matches);
        if (w?.type) { seen.lastDaemon = w.type; if (seen.daemon.at(-1) !== w.type) seen.daemon.push(w.type); }
      } catch { seen.pollErrors++; }
      await sleep(2000);
    }
  })();
  return seen;
}

function killSeat() {
  const child = S.seat;
  if (exited(child)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { if (!exited(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 5000).unref();
}

/** Launches the wrapper seat, tees it to wrapper.log and the console, and resolves with its exit (bounded). */
async function runSeat(o, env) {
  const seatId = `smoke-copilot-${o.engine}`;
  const q = text => `'${text.replace(/'/g, "''")}'`;
  const [command, args] = o.engine === 'sh'
    ? ['bash', [path.join(root, 'scripts', 'moe-agent.sh'), '--role', 'worker', '--project', S.project, '--worker-id', seatId,
      '--command', o.cli, '--no-loop', '--no-interactive']]
    : ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ${q(path.join(root, 'scripts', 'moe-agent.ps1'))} -Role worker -Project ${q(S.project)} -WorkerId ${seatId} -Command ${q(o.cli)} -NoLoop -Interactive:$false; exit $LASTEXITCODE`]];
  S.logFd = fs.openSync(S.log, 'a');
  S.seat = spawn(command, args, { cwd: S.project, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`copilot-smoke: seat ${seatId} pid ${S.seat.pid}`);
  for (const [stream, out] of [[S.seat.stdout, process.stdout], [S.seat.stderr, process.stderr]]) {
    stream.on('data', chunk => { fs.writeSync(S.logFd, chunk); out.write(chunk); });
  }
  const limit = Number(process.env.SMOKE_TIMEOUT_SEC) > 0 ? Number(process.env.SMOKE_TIMEOUT_SEC) : 900;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killSeat(); }, limit * 1000);
  const [code, signal] = await new Promise(resolve => {
    S.seat.once('error', error => resolve([null, `spawn error ${error.code || error.message}`]));
    S.seat.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  clearTimeout(timer);
  return { seatId, code, signal, timedOut, limit };
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Serena log of this run that names the canary read: <home>/.serena/logs/<local date>/mcp_*.txt. */
function serenaLog(launchMs) {
  const base = path.join(os.homedir(), '.serena', 'logs');
  for (const day of new Set([localDate(launchMs), localDate(Date.now())])) {
    let names = [];
    try { names = fs.readdirSync(path.join(base, day)).filter(name => /^mcp_.*\.txt$/.test(name)); } catch { continue; }
    for (const name of names) {
      const file = path.join(base, day, name);
      try {
        if (fs.statSync(file).mtimeMs >= launchMs - 1000 && fs.readFileSync(file, 'utf8').includes(SERENA_NEEDLE)) return name;
      } catch { /* rotated or unreadable: not evidence */ }
    }
  }
  return null;
}

/** The task's completion commit whose proof.txt equals the canary, on any ref. */
function completionCommit(taskId, canary) {
  const subject = new RegExp(`^(feat|fix)\\(${taskId}\\): `);
  for (const line of git(['log', '--all', '--format=%H%x09%s']).split('\n')) {
    const [sha, title] = line.split('\t');
    if (!title || !subject.test(title)) continue;
    try { if (git(['show', `${sha}:proof.txt`]).trim() === canary) return { sha, title }; } catch { /* no proof.txt */ }
  }
  return null;
}

function logLines() {
  try { return fs.readFileSync(S.log, 'utf8').replace(ANSI_RE, '').replace(/\r/g, '').split('\n'); } catch { return []; }
}

/** BLOCKED (a human prerequisite) wins, then PASS only when every check holds, else FAIL naming each failed check. */
async function judge(o, call, run, seen, taskId, canary, launchMs) {
  const tag = `copilot-smoke ${o.engine}`;
  const blocked = logLines().find(line => BLOCKED_RE.test(line));
  if (blocked) return { code: 3, line: `BLOCKED ${tag}: ${blocked.trim()}` };
  const failed = [];
  if (run.timedOut) failed.push(`the seat ran past SMOKE_TIMEOUT_SEC=${run.limit} and was stopped`);
  else if (run.code !== 0) failed.push(`the wrapper exited ${run.code ?? run.signal}`);
  let status = 'unknown', steps = [];
  try {
    const { task } = await call('get_context', { taskId });
    status = task.status;
    steps = task.implementationPlan ?? [];
  } catch (error) { failed.push(`get_context failed: ${error.message}`); }
  const done = steps.filter(step => step.status === 'COMPLETED').length;
  if (!['REVIEW', 'DONE'].includes(status)) failed.push(`the task is ${status}, not REVIEW or DONE`);
  if (steps.length === 0 || done !== steps.length) failed.push(`steps ${done}/${steps.length} COMPLETED`);
  let commit = null;
  try { commit = completionCommit(taskId, canary); } catch (error) { failed.push(`git log failed: ${error.message}`); }
  if (!commit) failed.push(`no feat/fix(${taskId}) commit whose proof.txt equals the canary`);
  if (seen.lastDaemon !== 'COPILOT') failed.push(`the daemon record's last type is ${seen.lastDaemon ?? 'never seen'} (seen ${seen.daemon.join('>') || 'none'}; ${seen.pollErrors} poll errors)`);
  if (!seen.board.has('COPILOT')) failed.push(`no /ws worker event with type COPILOT (seen ${[...seen.board].join(',') || 'none'})`);
  const serena = serenaLog(launchMs);
  if (!serena) failed.push(`no Serena log since the launch holds ${SERENA_NEEDLE}`);
  if (failed.length) return { code: 1, line: `FAIL ${tag}: ${failed.join('; ')}`, tail: logLines().slice(-60).join('\n') };
  const version = process.platform === 'win32'
    ? spawnSync(`"${o.cli}" --version`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    : spawnSync(o.cli, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const versionLine = (version.stdout || '').split(/\r?\n/)[0].trim() || 'version unknown';
  return { code: 0, line: `PASS ${tag}: copilot ${versionLine}; task ${taskId} ${status}; steps ${done}/${steps.length}; ` +
    `worker ${run.seatId} type COPILOT (daemon ${seen.daemon.join('>')}; board ${[...seen.board].join(',')}); ` +
    `commit ${commit.sha.slice(0, 7)} ${commit.title}; canary ok; serena read_memory ok (${serena}); ${Math.round((Date.now() - launchMs) / 1000)} s` };
}

/** The bash pre-flight rewrites ~/.config/claude/mcp_servers.json for its project. Put back the bytes the scratch
 *  seat replaced, only while the file still names the scratch project (a live seat's later write is kept). */
function restoreClaudeMcp() {
  if (S.claudeMcp === undefined) return;
  try {
    const now = fs.readFileSync(CLAUDE_MCP, 'utf8');
    if (!now.includes(S.project) && !now.includes(JSON.stringify(S.project).slice(1, -1))) return;
    if (S.claudeMcp === null) fs.rmSync(CLAUDE_MCP, { force: true });
    else fs.writeFileSync(CLAUDE_MCP, S.claudeMcp);
  } catch { /* absent or unreadable: nothing to put back */ }
}

let cleaning;
function cleanup(keep) {
  cleaning ??= (async () => {
    if (S.seat && !exited(S.seat)) { killSeat(); await until(() => exited(S.seat), 'seat stop', 15_000).catch(() => {}); }
    restoreClaudeMcp();
    if (S.logFd !== undefined) { try { fs.closeSync(S.logFd); } catch { /* closed */ } }
    if (S.board) { S.board.terminate(); S.board = undefined; }
    if (S.proxy && !exited(S.proxy)) { S.proxy.kill(); await until(() => exited(S.proxy), 'proxy stop', 15_000).catch(() => {}); }
    if (S.daemon && !exited(S.daemon)) {
      try { execFileSync(process.execPath, [daemonEntry, 'stop', '--project', S.project], { env: S.daemonEnv, windowsHide: true, timeout: 30_000, stdio: 'pipe' }); }
      catch (error) { console.error(`copilot-smoke: daemon stop failed: ${error.message}`); }
      await until(() => exited(S.daemon), 'daemon stop', 20_000).catch(() => { S.daemon.kill(); });
    }
    if (!S.scratch) return;
    if (keep) { console.log(`copilot-smoke: kept ${S.scratch}`); return; }
    if (path.dirname(S.scratch) !== path.resolve(os.tmpdir()) || !path.basename(S.scratch).startsWith(PREFIX)) return;
    try { fs.rmSync(S.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
    catch (error) { console.error(`copilot-smoke: could not remove ${S.scratch}: ${error.code || error.message}`); }
  })();
  return cleaning;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.error(`copilot-smoke: ${sig}; stopping the seat and the scratch daemon`); cleanup(o.keep).finally(() => process.exit(1)); });
  }
  const env = seatEnv();
  let verdict;
  try {
    const canary = makeFixture();
    S.log = path.join(S.scratch, 'wrapper.log');
    S.daemonEnv = { ...env, HOME: S.profile, USERPROFILE: S.profile, NODE_ENV: 'production', LOG_LEVEL: 'warn' };
    const info = await startDaemon(S.daemonEnv);
    const { rpc, call } = connectProxy(S.daemonEnv);
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'copilot-smoke', version: '1.0.0' } });
    const taskId = await seedTask(call, info.port);
    const seen = watchSeat(call, `smoke-copilot-${o.engine}`, taskId);
    try { S.claudeMcp = fs.readFileSync(CLAUDE_MCP, 'utf8'); } catch { S.claudeMcp = null; }
    const launchMs = Date.now();
    const run = await runSeat(o, env);
    await sleep(3000); // the deregistration and the last board events
    seen.stop = true;
    await seen.done;
    verdict = await judge(o, call, run, seen, taskId, canary, launchMs);
  } catch (error) {
    verdict = { code: 1, line: `FAIL copilot-smoke ${o.engine}: ${error.message}`, tail: `${logLines().slice(-60).join('\n')}\n--- scratch daemon/proxy diagnostics ---${S.diagnostics || ' (none)'}` };
  }
  await cleanup(o.keep);
  if (verdict.tail) console.log(`--- last lines of wrapper.log ---\n${verdict.tail}`);
  console.log(verdict.line);
  process.exit(verdict.code);
}

await main();

#!/usr/bin/env node
// =============================================================================
// Wave 1 end-to-end pilot. MANUAL and opt-in: postflight.sh and CI never run it.
// =============================================================================
//
// Runs the whole Wave 1 delivery path against a THROWAWAY project with the real
// daemon (dist, supervised `start`), the real moe-proxy and the real launcher
// (scripts/moe-agent.ps1 or .sh). Only the agent CLI is a stand-in: a fake
// `codex` that edits owned.txt and drives get_context / start_step /
// complete_step / complete_task through the real proxy, then probes the
// finalizing hold while the wrapper is still waiting for it to exit.
//
//   node scripts/tests/wave1-pilot.mjs               success path
//   node scripts/tests/wave1-pilot.mjs --gate-fails  forced gate failure
//
// Options: --wrapper pwsh|powershell|sh (default pwsh on Windows, sh elsewhere;
// sh on Windows means Git Bash), --gate-command <cmd> (settings.qualityGate,
// default "node gate.cjs"), --restart-mid-gate (kill the daemon while the first
// gate runs: after the candidate is recorded, before the check run), --no-build,
// --keep (keep the temp root).
//
// It first runs tsc in packages/moe-daemon and packages/moe-proxy of the tree it
// lives in (no clean, no generated-file refresh), because it runs their dist/.
// A daemon loads a rebuilt dist only on its next restart. On a shared checkout,
// run it from a clean export instead (git archive HEAD, then junction both
// packages' node_modules), so no peer's uncommitted source is built.
//
// Everything lives under one temp root: project, HOME, TEMP, shims and logs. The
// daemon gets a free port that every client reads from the temp project's
// daemon.json, and the calling session's MOE_* variables are stripped, so the
// pilot cannot reach the repository's own .moe/ or the live daemon. It exits
// non-zero at the first broken link and prints the wrapper and daemon log tails.
// =============================================================================

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_JS = path.join(REPO, 'packages', 'moe-daemon', 'dist', 'index.js');
const PROXY_JS = path.join(REPO, 'packages', 'moe-proxy', 'dist', 'index.js');
const TARGET = 'refs/heads/wave1-pilot';
const [TASK_A, TASK_B] = ['task-pilot-a', 'task-pilot-b'];
const [WORKER, QA, WORKER_B] = ['worker-5ca1ab1e', 'qa-c0ffee01', 'worker-b0b0b0b0'];
const MARKER = 'delivered by the wave1 pilot';
const WRAPPER_TIMEOUT_MS = 300_000;

// One MCP tools/call through the real moe-proxy. Written to disk so the fake CLI
// and this script share one implementation.
const RPC_SOURCE = `'use strict';
const { spawnSync } = require('child_process');
module.exports = function callTool(proxy, env, name, args) {
  const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\\n';
  const r = spawnSync(process.execPath, [proxy], { input, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const line = String(r.stdout || '').split(/\\r?\\n/).map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
  if (!line) throw new Error(name + ': no reply from moe-proxy (exit ' + r.status + ') ' + String(r.stderr || '').slice(-400));
  const reply = JSON.parse(line);
  if (reply.error) return { error: { code: reply.error.code, codeName: reply.error.data && reply.error.data.codeName, message: reply.error.message } };
  return { result: JSON.parse(reply.result.content[0].text) };
};
`;

// The fake codex. After complete_task it records what the daemon holds BEFORE
// the wrapper's post-flight can finalize anything.
const CLI_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
const C = JSON.parse(process.env.PILOT_CLI_CONFIG);
const callTool = require(C.rpc);
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.153.4\\n'); process.exit(0); }
if (argv.includes('--help')) { process.stdout.write('Usage: codex exec [OPTIONS] [PROMPT]\\n'); process.exit(0); }
if (!argv.includes('exec')) { process.stderr.write('wave1 pilot cli: exec mode only\\n'); process.exit(2); }
function call(name, args, workerId) {
  const env = Object.assign({}, process.env, { MOE_PROJECT_PATH: C.projectPath });
  delete env.MOE_WORKER_ID;
  if (workerId) env.MOE_WORKER_ID = workerId;
  return callTool(C.proxy, env, name, args);
}
function ok(name, args) {
  const r = call(name, args, C.worker);
  if (r.error) throw new Error(name + ' refused: ' + r.error.codeName + ' ' + r.error.message);
  return r.result;
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const task = ok('moe.get_context', { taskId: C.taskId, workerId: C.worker }).task || {};
if (task.status !== 'WORKING' || task.assignedWorkerId !== C.worker) process.exit(0);
const round = (task.reopenCount || 0) + 1;
ok('moe.start_step', { taskId: C.taskId, stepId: 'step-1', workerId: C.worker });
fs.writeFileSync(path.join(C.project, 'owned.txt'), C.marker + '\\nround ' + round + '\\n');
ok('moe.complete_step', { taskId: C.taskId, stepId: 'step-1', workerId: C.worker, modifiedFiles: ['owned.txt'] });
ok('moe.complete_task', { taskId: C.taskId, workerId: C.worker, summary: 'pilot round ' + round,
  verification: { command: C.gate, exitCode: 0, outputTail: 'pilot' } });
const attemptsDir = path.join(C.project, '.moe', 'attempts');
const attempt = fs.readdirSync(attemptsDir).map((f) => read(path.join(attemptsDir, f)))
  .filter((a) => a.taskId === C.taskId).sort((a, b) => a.generation - b.generation).pop();
const row = read(path.join(C.project, '.moe', 'tasks', C.taskId + '.json'));
const qaClaim = call('moe.claim_next_task', { statuses: ['REVIEW'], taskId: C.taskId, workerId: C.qa }, C.qa);
const humanApprove = call('moe.qa_approve', { taskId: C.taskId, summary: 'pilot probe while finalizing' }, null);
fs.appendFileSync(C.obs, JSON.stringify({ round, attempt: { id: attempt.id, generation: attempt.generation,
  phase: attempt.phase, workerId: attempt.workerId }, task: { status: row.status, assignedWorkerId: row.assignedWorkerId },
  qaClaim, humanApprove }) + '\\n');
`;

const opts = parseArgs(process.argv.slice(2));
const owned = [];
let linkNo = 0;
let ctx = null;

function parseArgs(argv) {
  const o = { gateFails: false, restart: false, gate: 'node gate.cjs', wrapper: process.platform === 'win32' ? 'pwsh' : 'sh', build: true, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--gate-fails') o.gateFails = true;
    else if (a === '--restart-mid-gate') o.restart = true;
    else if (a === '--gate-command') o.gate = argv[++i] ?? '';
    else if (a === '--wrapper') o.wrapper = argv[++i] ?? '';
    else if (a === '--no-build') o.build = false;
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!['pwsh', 'powershell', 'sh'].includes(o.wrapper)) throw new Error(`--wrapper must be pwsh, powershell or sh (got ${o.wrapper})`);
  if (!o.gate.trim()) throw new Error('--gate-command must not be blank');
  return o;
}

const link = (label, detail) => console.log(`[ok] ${++linkNo}. ${label}${detail ? ` -- ${detail}` : ''}`);
const tail = (text, lines = 60) => String(text).split(/\r?\n/).slice(-lines).join('\n');
function expect(cond, message) { if (!cond) throw new Error(message); }
function eq(actual, expected, what) {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('MOE_') || upper.startsWith('GIT_') || ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'].includes(upper)) continue;
    env[key] = value;
  }
  const home = path.join(ctx.root, 'home');
  const tmp = path.join(ctx.root, 'tmp');
  return { ...env, HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), ...extra };
}

function git(args) {
  const r = spawnSync('git', ['-C', ctx.project, ...args], { env: isolatedEnv(), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function build() {
  for (const pkg of ['moe-daemon', 'moe-proxy']) {
    const r = spawnSync('npx', ['tsc', '-p', '.'], { cwd: path.join(REPO, 'packages', pkg), encoding: 'utf8',
      shell: process.platform === 'win32', timeout: 300_000, windowsHide: true });
    if (r.status !== 0) throw new Error(`tsc failed in packages/${pkg} (exit ${r.status}):\n${tail(r.stdout + r.stderr)}`);
  }
  link('build', `tsc in packages/moe-daemon and packages/moe-proxy of ${REPO}; a running daemon loads it only after a restart`);
}

function gateSource() {
  // --restart-mid-gate: hold the first gate run until the daemon has been restarted.
  const hold = opts.restart ? [`const sentinel = ${JSON.stringify(path.join(ctx.root, 'release-gate'))};`,
    'for (const until = Date.now() + 120000; !fs.existsSync(sentinel) && Date.now() < until;)',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);'] : [];
  return ["const fs = require('fs');", ...hold, "console.log('gate cwd=' + process.cwd());",
    opts.gateFails ? "console.log('gate forced failure'); process.exit(7);" : '',
    `const ok = fs.readFileSync('owned.txt', 'utf8').includes(${JSON.stringify(MARKER)});`,
    "console.log(ok ? 'gate ok' : 'gate failed: owned.txt lacks the delivery');", 'process.exit(ok ? 0 : 1);', ''].join('\n');
}

function writeProject() {
  const moe = path.join(ctx.project, '.moe');
  for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moe, sub), { recursive: true });
  const now = new Date().toISOString();
  const json = (file, value) => fs.writeFileSync(path.join(moe, file), JSON.stringify(value, null, 2));
  json('project.json', { id: 'proj-wave1-pilot', name: 'Wave 1 pilot', rootPath: ctx.project, createdAt: now, updatedAt: now,
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, agentCommand: 'codex', autoCreateBranch: false,
      branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', deliveryPolicy: 'local-branch',
      autoCommit: true, consolidationBranch: 'wave1-pilot', qualityGate: opts.gate, qualityGateScope: 'everyTask', checkpointPush: false } });
  json('epics/epic-pilot.json', { id: 'epic-pilot', projectId: 'proj-wave1-pilot', title: 'Wave 1 pilot', description: '',
    architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now });
  const task = (id, order, extra) => ({ id, epicId: 'epic-pilot', title: `Wave 1 pilot ${id}`, description: 'Pilot fixture',
    definitionOfDone: ['the quality gate exits 0 on the delivered tree'], taskRails: [], status: 'WORKING', assignedWorkerId: null,
    implementationPlan: [{ stepId: 'step-1', description: 'Edit owned.txt', status: 'PENDING', affectedFiles: ['owned.txt'] }],
    branch: null, prLink: null, reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, priority: 'MEDIUM',
    comments: [], order, createdAt: now, updatedAt: now, ...extra });
  json(`tasks/${TASK_A}.json`, task(TASK_A, 1, {}));
  json(`tasks/${TASK_B}.json`, task(TASK_B, 2, { dependsOn: [TASK_A] }));
}

function initRepo() {
  fs.writeFileSync(path.join(ctx.project, '.gitignore'), '.moe/\n.codex/\n');
  fs.writeFileSync(path.join(ctx.project, 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(ctx.project, 'gate.cjs'), gateSource());
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', TARGET]);
  for (const [k, v] of [['user.name', 'Moe Wave1 Pilot'], ['user.email', 'wave1-pilot@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(['config', k, v]);
  git(['add', '--', '.gitignore', 'gate.cjs', 'owned.txt']);
  git(['commit', '-q', '-m', 'base']);
  return git(['rev-parse', TARGET]);
}

function writeShims() {
  const dir = path.join(ctx.root, 'shims');
  const rpc = path.join(dir, 'rpc.cjs');
  fs.writeFileSync(rpc, RPC_SOURCE);
  fs.writeFileSync(path.join(dir, 'codex-cli.cjs'), CLI_SOURCE);
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-cli.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  fs.writeFileSync(path.join(dir, 'codex'), `#!/usr/bin/env node\n${CLI_SOURCE}`, { mode: 0o755 });
  ctx.callTool = createRequire(import.meta.url)(rpc);
  ctx.cli = path.join(dir, opts.wrapper === 'sh' ? 'codex' : 'codex.cmd');
  ctx.obs = path.join(ctx.root, 'cli-observations.jsonl');
  ctx.cliConfig = JSON.stringify({ rpc, proxy: PROXY_JS, project: ctx.project, taskId: TASK_A, worker: WORKER, qa: QA,
    marker: MARKER, gate: opts.gate, obs: ctx.obs, projectPath: null });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function healthPid(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2_000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body).pid : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitFor(what, ms, probe) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function spawnLogged(label, cmd, args, options) {
  const logFile = path.join(ctx.root, `${label}.log`);
  const fd = fs.openSync(logFile, 'w'); // not 'a': Git Bash cannot write to an append-only handle
  const child = spawn(cmd, args, { ...options, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const exited = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', () => resolve(null)); });
  const handle = { label, child, logFile, exited, done: false };
  exited.then(() => { handle.done = true; });
  owned.push(handle);
  return handle;
}

function killTree(handle) {
  if (handle.done || !handle.child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
  else try { process.kill(-handle.child.pid, 'SIGKILL'); } catch { handle.child.kill('SIGKILL'); }
}

async function startDaemon() {
  const port = await freePort();
  ctx.daemon = spawnLogged('daemon', process.execPath, [DAEMON_JS, 'start', '--project', ctx.project, '--port', String(port),
    '--host', '127.0.0.1'], { env: isolatedEnv(), detached: process.platform !== 'win32' });
  const infoFile = path.join(ctx.project, '.moe', 'daemon.json');
  const info = await waitFor('the temp daemon.json and /health', 90_000, async () => {
    if (ctx.daemon.done) throw new Error('the daemon exited before it was ready');
    if (!fs.existsSync(infoFile)) return null;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
    return (await healthPid(parsed.port)) === parsed.pid ? parsed : null;
  });
  ctx.daemonInfo = info;
  ctx.projectPath = info.projectPath;
  const config = JSON.parse(ctx.cliConfig);
  ctx.cliConfig = JSON.stringify({ ...config, projectPath: info.projectPath });
  link('daemon', `pid ${info.pid}, port ${info.port}, read from the temp project's daemon.json`);
}

function call(name, args, workerId) {
  const env = isolatedEnv({ MOE_PROJECT_PATH: ctx.projectPath });
  if (workerId) env.MOE_WORKER_ID = workerId;
  return ctx.callTool(PROXY_JS, env, name, args);
}
function mustCall(name, args, workerId) {
  const r = call(name, args, workerId);
  if (r.error) throw new Error(`${name} refused: ${r.error.code} ${r.error.codeName} ${r.error.message}`);
  return r.result;
}
function mustRefuse(name, args, workerId, codeName) {
  const r = call(name, args, workerId);
  if (!r.error) throw new Error(`${name} should be refused ${codeName}, but succeeded: ${JSON.stringify(r.result).slice(0, 300)}`);
  eq(r.error.codeName, codeName, `${name} refusal codeName (message: ${r.error.message})`);
  return r.error;
}

function bash() {
  if (process.platform !== 'win32') return 'bash';
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const gitBash = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  return fs.existsSync(gitBash) ? gitBash : 'bash';
}

/** --restart-mid-gate: once the wrapper froze its candidate, kill the daemon abruptly; the supervisor restarts it. */
async function restartDuringGate() {
  const before = ctx.daemonInfo;
  const candidate = await waitFor('the frozen candidate', WRAPPER_TIMEOUT_MS, () => {
    if (ctx.lastWrapper.done) throw new Error('the wrapper exited before it recorded a candidate');
    return records('candidates').find((c) => c.taskId === TASK_A) ?? null;
  });
  process.kill(before.pid, 'SIGKILL');
  const infoFile = path.join(ctx.project, '.moe', 'daemon.json');
  ctx.daemonInfo = await waitFor('the supervisor to restart the daemon', 90_000, async () => {
    let info;
    try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
    return info.pid !== before.pid && (await healthPid(info.port)) === info.pid ? info : null;
  });
  const attempt = records('attempts').find((a) => a.id === candidate.attemptId);
  eq(attempt?.phase, 'finalizing', 'the landing attempt after the restart');
  expect(fs.existsSync(path.join(ctx.project, '.moe', 'workers', `${WORKER}.json`)), `the restart purged ${WORKER}`);
  fs.writeFileSync(path.join(ctx.root, 'release-gate'), 'go\n');
  link('daemon killed and restarted between candidate and check run',
    `pid ${before.pid} -> ${ctx.daemonInfo.pid}; ${attempt.id} still finalizing, ${WORKER} kept`);
}

async function runWrapper(label, during) {
  const sh = opts.wrapper === 'sh';
  // Git Bash drops the backslashes of a native caller's argv, so sh gets forward slashes.
  const slash = (p) => (sh ? p.replace(/\\/g, '/') : p);
  const env = isolatedEnv({ MOE_PROXY_PATH: slash(PROXY_JS), MOE_DISABLE_HEARTBEAT: '1', PILOT_CLI_CONFIG: ctx.cliConfig });
  const common = [['--project', '-Project', slash(ctx.project)], ['--worker-id', '-WorkerId', WORKER], ['--role', '-Role', 'worker'],
    ['--command', '-Command', slash(ctx.cli)], ['--codex-exec', '-CodexExec'], ['--no-start-daemon', '-NoStartDaemon'],
    ['--no-loop', '-NoLoop'], ['--poll-interval', '-PollInterval', '0']];
  const args = common.flatMap(([long, ps, value]) => [sh ? long : ps, ...(value === undefined ? [] : [value])]);
  const [cmd, argv] = sh ? [bash(), [slash(path.join(REPO, 'scripts', 'moe-agent.sh')), ...args]]
    : [opts.wrapper === 'pwsh' ? 'pwsh' : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'moe-agent.ps1'), ...args]];
  const started = Date.now();
  const handle = spawnLogged(label, cmd, argv, { cwd: ctx.project, env, detached: process.platform !== 'win32' });
  ctx.lastWrapper = handle;
  const timer = setTimeout(() => killTree(handle), WRAPPER_TIMEOUT_MS);
  if (during) await during();
  const code = await handle.exited;
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  expect(Date.now() - started < WRAPPER_TIMEOUT_MS, `${label} was killed after ${WRAPPER_TIMEOUT_MS} ms`);
  return { code, seconds };
}

const records = (kind) => {
  const dir = path.join(ctx.project, '.moe', kind);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};
const taskRecord = (id) => JSON.parse(fs.readFileSync(path.join(ctx.project, '.moe', 'tasks', `${id}.json`), 'utf8'));

/** One wrapper run of task A, checked up to the gate: claim, finalizing hold, candidate, check run. */
async function runRound(round, base) {
  const run = await runWrapper(`wrapper-run-${round}`, opts.restart && round === 1 ? restartDuringGate : undefined);
  link(`wrapper run ${round}`, `${opts.wrapper} exited ${run.code} after ${run.seconds} s`);
  const lines = fs.existsSync(ctx.obs) ? fs.readFileSync(ctx.obs, 'utf8').trim().split('\n') : [];
  const obs = lines.map((l) => JSON.parse(l)).find((o) => o.round === round);
  expect(obs, `round ${round}: the fake CLI never reached complete_task (see ${ctx.lastWrapper.logFile})`);
  eq(obs.attempt.workerId, WORKER, 'attempt owner');
  if (round === 1) eq(obs.attempt.generation, 1, 'first claim generation');
  link('claim opened an attempt', `${obs.attempt.id} generation ${obs.attempt.generation} for ${WORKER}`);
  eq(obs.attempt.phase, 'finalizing', 'attempt phase right after complete_task');
  eq(obs.task, { status: 'REVIEW', assignedWorkerId: null }, 'task row right after complete_task');
  link('complete_task held the attempt finalizing', `${TASK_A} is REVIEW and unassigned`);
  for (const [what, refusal] of [['QA claim', obs.qaClaim], ['human qa_approve', obs.humanApprove]]) {
    eq(refusal.error?.codeName, 'ATTEMPT_FINALIZING', `${what} before finalize_attempt`);
    expect(refusal.error.message.includes(obs.attempt.id), `${what} refusal does not name ${obs.attempt.id}: ${refusal.error.message}`);
  }
  link('a QA claim and a qa_approve before finalize are refused', `${obs.qaClaim.error.code} ATTEMPT_FINALIZING naming ${obs.attempt.id}`);
  const candidates = records('candidates').filter((c) => c.taskId === TASK_A && c.attemptId === obs.attempt.id);
  eq(candidates.length, 1, `candidates frozen for ${obs.attempt.id}`);
  const [candidate] = candidates;
  eq([candidate.baseRevision, candidate.deliveryTarget], [base, TARGET], 'candidate base and target');
  link('the wrapper froze a candidate', `${candidate.id} tree ${candidate.treeSha.slice(0, 12)} on base ${base.slice(0, 12)}`);
  const checks = records('checks').filter((c) => c.candidateId === candidate.id);
  eq(checks.length, 1, `check runs for ${candidate.id}`);
  const [check] = checks;
  eq([check.treeSha, check.source, check.exitCode], [candidate.treeSha, 'runner-observed', opts.gateFails ? 7 : 0], 'check run tree, source, exit code');
  const cwd = /gate cwd=(.+)/.exec(check.outputTail)?.[1]?.trim();
  expect(cwd && path.resolve(cwd) !== path.resolve(ctx.project) && !fs.existsSync(cwd), `gate cwd ${cwd} is not a removed private workspace`);
  link('the gate ran on the candidate tree in a clean workspace', `command ${JSON.stringify(check.command)}, exit ${check.exitCode}, cwd ${cwd}`);
  return { obs, candidate, check };
}

/** Landing, receipt and close for a successful round. */
function assertLanded(round, base, { obs, candidate }) {
  const tip = git(['rev-parse', TARGET]);
  eq(git(['rev-list', `${base}..${TARGET}`]).split('\n'), [tip], `commits added to ${TARGET} in round ${round}`);
  eq([git(['rev-parse', `${tip}^`]), git(['rev-parse', `${tip}^{tree}`])], [base, candidate.treeSha], 'landed parent and tree');
  link('the landing moved the target once', `${TARGET} ${base.slice(0, 12)} -> ${tip.slice(0, 12)}`);
  const receipts = records('receipts').filter((r) => r.candidateId === candidate.id);
  eq(receipts.length, 1, `receipts for ${candidate.id}`);
  const { target, targetBefore, targetAfter, landedRevision, pushResult } = receipts[0];
  eq({ target, targetBefore, targetAfter, landedRevision, pushResult },
    { target: TARGET, targetBefore: base, targetAfter: tip, landedRevision: tip, pushResult: null }, 'receipt');
  link('the receipt records that landing', `${receipts[0].id} for ${candidate.id}`);
  eq(records('attempts').find((a) => a.id === obs.attempt.id)?.phase, 'closed', 'attempt phase after the wrapper exit');
  link('finalize_attempt closed the attempt', obs.attempt.id);
  return tip;
}

/** The QA seat claims A for review and reads its context, as qa_approve requires; returns the candidate it read. */
function qaReview() {
  mustCall('moe.claim_next_task', { statuses: ['REVIEW'], taskId: TASK_A, workerId: QA }, QA);
  return mustCall('moe.get_context', { taskId: TASK_A, workerId: QA }, QA).currentCandidate?.id;
}

function assertBWithheld(when) {
  const refusal = mustRefuse('moe.claim_next_task', { statuses: ['WORKING'], taskId: TASK_B, workerId: WORKER_B }, WORKER_B, 'NOT_ALLOWED');
  expect(refusal.message.includes(TASK_A), `B's refusal does not name ${TASK_A}: ${refusal.message}`);
  eq(mustCall('moe.claim_next_task', { statuses: ['WORKING'], workerId: WORKER_B }, WORKER_B).hasNext, false, 'pool claim for B');
  link(`B is withheld ${when}`, `explicit claim NOT_ALLOWED (unmet ${TASK_A}); the pool offers nothing`);
}

async function successPath(base) {
  const round1 = await runRound(1, base);
  const landed1 = assertLanded(1, base, round1);
  assertBWithheld('while A is in REVIEW');
  eq(qaReview(), round1.candidate.id, 'candidate QA reads');
  mustCall('moe.qa_reject', { taskId: TASK_A, workerId: QA, candidateId: round1.candidate.id,
    reason: 'pilot: a second round, so the first candidate is superseded' }, QA);
  link('QA rejected round 1', `${round1.candidate.id} reviewed; ${TASK_A} back to WORKING`);
  const round2 = await runRound(2, landed1);
  assertLanded(2, landed1, round2);
  eq(qaReview(), round2.candidate.id, 'candidate QA reads');
  const stale = mustRefuse('moe.qa_approve', { taskId: TASK_A, workerId: QA, candidateId: round1.candidate.id,
    summary: 'pilot: approving the superseded candidate' }, QA, 'CANDIDATE_MISMATCH');
  link('qa_approve refused the superseded candidate', `${stale.code} CANDIDATE_MISMATCH for ${round1.candidate.id}`);
  assertBWithheld('until A is approved');
  const token = `required-check:${opts.gate.trim()}`;
  eq(token.slice('required-check:'.length), round2.check.command.trim(), 'policy token command vs the recorded check command');
  mustCall('moe.qa_approve', { taskId: TASK_A, workerId: QA, candidateId: round2.candidate.id,
    summary: 'pilot: round 2 candidate landed with a passing runner-observed gate' }, QA);
  eq(taskRecord(TASK_A).status, 'DONE', 'A after the approval');
  expect(records('reviews').some((r) => r.taskId === TASK_A && r.candidateId === round2.candidate.id && r.decision === 'approve'),
    `no approved review of ${round2.candidate.id}`);
  link('qa_approve accepted the current candidate', `${round2.candidate.id}; policy token ${JSON.stringify(token)}, recorded command ${JSON.stringify(round2.check.command)}`);
  const claimed = mustCall('moe.claim_next_task', { statuses: ['WORKING'], taskId: TASK_B, workerId: WORKER_B }, WORKER_B);
  expect(claimed.hasNext === true && claimed.task?.id === TASK_B && claimed.attemptId, `B claim: ${JSON.stringify(claimed).slice(0, 300)}`);
  link('B became claimable only now', `${WORKER_B} holds ${TASK_B}, attempt ${claimed.attemptId}`);
}

async function failurePath(base) {
  const round = await runRound(1, base);
  eq(git(['rev-parse', TARGET]), base, `${TARGET} after the failed gate`);
  link('the delivery target did not move', `${TARGET} still ${base.slice(0, 12)}`);
  const rescues = git(['for-each-ref', '--format=%(refname)', `refs/moe/rescue/${TASK_A}/`]).split('\n').filter(Boolean);
  eq(rescues.length, 1, 'rescue refs');
  eq(git(['rev-parse', `${rescues[0]}^{tree}`]), round.candidate.treeSha, 'rescue ref tree');
  expect(git(['show', `${rescues[0]}:owned.txt`]).includes(MARKER), 'the rescue ref lacks the edit');
  link('the bytes went to a rescue ref', `${rescues[0]} holds the candidate tree with the edit`);
  const row = taskRecord(TASK_A);
  const { outcome, kind, code } = row.lastCommitOutcome ?? {};
  eq({ outcome, kind, code }, { outcome: 'failed', kind: 'completion', code: 'MOE_COMMIT_FAILED_GATE' }, 'lastCommitOutcome');
  expect((row.commits ?? []).some((c) => c.kind === 'rescue' && c.ref === rescues[0] && String(c.message).includes('reason=gate-failed')),
    `no rescue ledger row for ${rescues[0]}: ${JSON.stringify(row.commits).slice(0, 300)}`);
  const blocked = (row.comments ?? []).map((c) => String(c.content).split('\n')[0]).find((l) => l.includes('PUSH-BLOCKED: qualityGate failed'));
  expect(blocked?.includes(TASK_A) && blocked.endsWith('(exit 7)'), `no PUSH-BLOCKED task comment: ${JSON.stringify(row.comments).slice(0, 300)}`);
  link('reported MOE_COMMIT_FAILED_GATE with a PUSH-BLOCKED line', blocked);
  eq(records('receipts').length, 0, 'receipts');
  eq(records('attempts').find((a) => a.id === round.obs.attempt.id)?.phase, 'closed', 'attempt phase after the wrapper exit');
  link('no receipt exists; the attempt is closed', round.obs.attempt.id);
  const token = `required-check:${opts.gate.trim()}`;
  eq(qaReview(), round.candidate.id, 'candidate QA reads');
  const refused = mustRefuse('moe.qa_approve', { taskId: TASK_A, workerId: QA, candidateId: round.candidate.id,
    summary: 'pilot: approving past a failed gate' }, QA, 'DELIVERY_EVIDENCE_MISSING');
  expect(refused.message.includes(token), `qa_approve refusal does not name ${token}: ${refused.message}`);
  link('qa_approve is refused', `${refused.code} DELIVERY_EVIDENCE_MISSING naming ${token}`);
  assertBWithheld('while A is in REVIEW');
  mustCall('moe.set_task_status', { taskId: TASK_A, status: 'DONE', reason: 'pilot: a human pushes A past its failed gate' });
  const withheld = mustRefuse('moe.claim_next_task', { statuses: ['WORKING'], taskId: TASK_B, workerId: WORKER_B }, WORKER_B, 'DEPENDENCY_EVIDENCE_MISSING');
  expect(withheld.message.includes(token), `B's refusal does not name ${token}: ${withheld.message}`);
  eq(token.slice('required-check:'.length), round.check.command.trim(), 'policy token command vs the recorded check command');
  eq(mustCall('moe.claim_next_task', { statuses: ['WORKING'], workerId: WORKER_B }, WORKER_B).hasNext, false, 'pool claim for B');
  link('B stays withheld after a human DONE', `${withheld.code} DEPENDENCY_EVIDENCE_MISSING naming ${token} = the recorded check command`);
}

async function teardown() {
  for (const h of owned) if (h !== ctx?.daemon) killTree(h);
  if (ctx?.project && fs.existsSync(DAEMON_JS)) {
    spawnSync(process.execPath, [DAEMON_JS, 'stop', '--project', ctx.project], { env: isolatedEnv(), timeout: 30_000, windowsHide: true });
  }
  if (ctx?.daemon) await Promise.race([ctx.daemon.exited, new Promise((r) => setTimeout(r, 15_000))]);
  if (ctx?.daemonInfo && (await healthPid(ctx.daemonInfo.port)) === ctx.daemonInfo.pid) process.kill(ctx.daemonInfo.pid, 'SIGKILL');
  for (const h of owned) killTree(h);
  if (ctx?.root && !opts.keep) fs.rmSync(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (ctx?.root && opts.keep) console.log(`kept ${ctx.root}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-wave1-pilot-'));
  ctx = { root, project: path.join(root, 'project') };
  for (const sub of ['home', 'tmp', 'shims', 'project']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  const mode = `${opts.gateFails ? 'forced gate failure' : 'success path'}${opts.restart ? ' with a daemon restart mid-gate' : ''}`;
  console.log(`== Wave 1 pilot: ${mode} (wrapper ${opts.wrapper}, qualityGate ${JSON.stringify(opts.gate)}) ==`);
  if (opts.build) build();
  writeProject();
  const base = initRepo();
  writeShims();
  link('throwaway project', `${ctx.project}, base ${base.slice(0, 12)} on ${TARGET}, deliveryPolicy local-branch, gate everyTask`);
  await startDaemon();
  await (opts.gateFails ? failurePath(base) : successPath(base));
  console.log(`PASS: Wave 1 pilot ${mode}, ${linkNo} links`);
}

process.once('SIGINT', () => { teardown().finally(() => process.exit(130)); });
let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.log(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  for (const h of [ctx?.lastWrapper, ctx?.daemon].filter(Boolean)) {
    console.log(`--- ${h.label} log tail (${h.logFile}) ---\n${fs.existsSync(h.logFile) ? tail(fs.readFileSync(h.logFile, 'utf8')) : '(none)'}`);
  }
} finally {
  try { await teardown(); } catch (error) { console.log(`[teardown] ${error.message}`); exitCode = exitCode || 1; }
}
process.exit(exitCode);

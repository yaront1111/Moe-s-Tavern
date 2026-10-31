/** CQ-M04b: one frozen workload, original Moe workflow, one CQ-M04 record.
 * POSIX only; observations are record-only, not trusted isolation evidence.
 * This driver makes no model calls itself. Logs and project-path.json survive
 * a driver crash; processes.json records process-group ids for orphan cleanup.
 */
import fs from 'node:fs/promises';
import { constants, openSync, writeSync, closeSync } from 'node:fs';
import WebSocket from 'ws';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssessmentSnapshot, createCodingSnapshot, digestWorkload, validateWorkload,
  WORKLOAD_CANDIDATE_ROOT_ENV, type Workload } from './workloadSnapshot.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CAP = 60 * 60 * 1000;
const OUTPUT_LIMIT = 1024 * 1024;
const ROLES = ['architect', 'worker', 'qa'] as const;
export type BaselineRole = typeof ROLES[number];
type Status = 'completed' | 'capped' | 'failed' | 'aborted';
type Json = Record<string, unknown>;
export interface RoleObservation { role: BaselineRole; cli: string; model: string | null; effort: string | null; launches: number | null }
interface Criterion { id: string; result: 'pass' | 'fail' | 'not-run' }
interface Assessment { ran: boolean; exitCode: number | null; criteria: Criterion[]; reason: string | null }
export interface OutcomeRecord {
  version: 1;
  workload: { id: string; category: Workload['category']; caseDigest: string; snapshotDigest: string; corpusVersion: number };
  run: { moeCommit: string; startedAt: string; endedAt: string; wallClockMs: number; wallClockCapMs: number; status: Status;
    repetition: 1; repetitionsPlanned: 1; platform: string; nodeVersion: string; cliVersion: string | null;
    roles: RoleObservation[]; usageTaskId: string | null; failureReason: string | null };
  moeOutcome: { finalStatus: string | null; qaApprovals: number | null; qaRejections: number | null;
    reopenCount: number | null; plannerSessions: number | null; repairAttempts: null };
  assessment: Assessment;
  latency: { firstCodeChangeMs: null; endToEndMs: number | null };
  retrieval: { sourceRetrievals: null; retrievedBytes: null };
  notes: string[];
}
export interface RunOptions {
  workload: Workload; corpusVersion: number; moeCommit: string; moeRoot?: string; capMs?: number;
  parentDir?: string; command?: string; seatEnv?: NodeJS.ProcessEnv; pollMs?: number; killGraceMs?: number;
  signal?: AbortSignal; sourceDirty?: boolean; daemonCommand?: [string, ...string[]];
}
const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const textValue = (v: unknown, max = 128): string | null => typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
const counter = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const fail = (stage: string): never => { throw new Error(stage.slice(0, 200)); };
const idsOf = (w: Workload) => w.rubric.criteria.map(c => c.id);
const unassessed = (w: Workload, reason: string): Assessment => ({ ran: false, exitCode: null, criteria: criteriaFromTap('', idsOf(w)), reason });

/** O_NOFOLLOW plus bounded reads: neither links, devices nor growing files escape the budget. */
async function readBounded(file: string, max: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return fail('observation file is not bounded regular data');
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > max) return fail('observation exceeds byte limit');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
function jsonLines(raw: string): { rows: unknown[]; malformedLines: number } {
  const rows: unknown[] = []; let malformedLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 256 * 1024) { malformedLines++; continue; }
    try { rows.push(JSON.parse(line)); } catch { malformedLines++; }
  }
  return { rows, malformedLines };
}
export async function readUsageReceipts(dir: string) {
  const rows: unknown[] = []; const notes: string[] = []; let malformedLines = 0; let bytes = 0;
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return { rows, malformedLines, notes: ['receipt directory unavailable'] };
    const files = (await fs.readdir(dir, { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length > 64) notes.push('receipt file limit reached');
    for (const file of files.slice(0, 64)) {
      try {
        const raw = await readBounded(path.join(dir, file.name), 16 * OUTPUT_LIMIT - bytes); bytes += Buffer.byteLength(raw);
        const parsed = jsonLines(raw); rows.push(...parsed.rows); malformedLines += parsed.malformedLines;
      } catch { if (!notes.includes('receipt data unavailable or over limit')) notes.push('receipt data unavailable or over limit'); }
    }
    if (malformedLines) notes.push('malformed receipt lines skipped');
  } catch { notes.push('receipt directory unavailable'); }
  return { rows, malformedLines, notes };
}
export function rolesFromReceipts(rows: readonly unknown[], taskId: string | null, cli: string) {
  const notes: string[] = [];
  const roles = ROLES.map(role => {
    const matching = rows.map(object).filter(r => taskId !== null && r.version === 1 && r.taskId === taskId && r.role === role && textValue(r.launchId));
    const models = new Set(matching.flatMap(r => Array.isArray(r.reportedModels) ? r.reportedModels.map(m => textValue(m)).filter((m): m is string => m !== null) : []));
    const efforts = new Set(matching.map(r => textValue(r.requestedEffort, 32)).filter((e): e is string => e !== null));
    if (models.size > 1 || efforts.size > 1) notes.push(`${role}: mixed model or effort observations; ambiguous values remain null`);
    return { role, cli, model: models.size === 1 ? [...models][0] : null, effort: efforts.size === 1 ? [...efforts][0] : null,
      launches: matching.length ? new Set(matching.map(r => r.launchId)).size : null };
  });
  return { roles, notes };
}
export function criteriaFromTap(output: string, rubricIds: readonly string[]): Criterion[] {
  const results = new Map<string, Criterion['result']>(rubricIds.map(id => [id, 'not-run']));
  for (const line of Buffer.from(output).subarray(0, OUTPUT_LIMIT).toString('utf8').split('\n')) {
    const match = /^\s*(not ok|ok) \d+ - ([a-z0-9-]+):(?:\s|$)/.exec(line);
    if (!match || !results.has(match[2]) || / # (?:SKIP|TODO)\b/i.test(line)) continue;
    if (match[1] === 'not ok') results.set(match[2], 'fail');
    else if (results.get(match[2]) !== 'fail') results.set(match[2], 'pass');
  }
  return rubricIds.map(id => ({ id, result: results.get(id)! }));
}
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; return fail('process group signal failed'); }
}
export async function terminateTree(child: ChildProcess, graceMs = 1000): Promise<boolean> {
  if (!child.pid || !signalGroup(child.pid, 'SIGTERM')) return false;
  const end = Date.now() + graceMs;
  while (Date.now() < end) { if (!signalGroup(child.pid, 0)) return false; await delay(20); }
  const escalated = signalGroup(child.pid, 'SIGKILL');
  // Allow our direct child to be reaped by Node, without waiting indefinitely on orphan zombies.
  for (let i = 0; i < 25 && child.exitCode === null && child.signalCode === null; i++) await delay(20);
  return escalated;
}
interface Captured { child: ChildProcess; done: Promise<number | null>; output: () => string; truncated: () => boolean }
function capture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, limit = OUTPUT_LIMIT, logFile?: string): Captured {
  let logFd = logFile ? openSync(logFile, 'wx', 0o600) : undefined;
  let child: ChildProcess;
  try { child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { if (logFd !== undefined) closeSync(logFd); return fail('process launch failed'); }
  const chunks: Buffer[] = []; let bytes = 0; let truncated = false;
  const collect = (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, limit - bytes));
    if (kept.length) {
      chunks.push(kept);
      if (logFd !== undefined) { try { writeSync(logFd, kept); } catch { truncated = true; } }
    }
    bytes += kept.length; if (kept.length < chunk.length) truncated = true;
  };
  child.stdout!.on('data', collect); child.stderr!.on('data', collect);
  child.once('close', () => { if (logFd !== undefined) { closeSync(logFd); logFd = undefined; } });
  const done = new Promise<number | null>(resolve => { child.once('error', () => resolve(null)); child.once('close', code => resolve(code)); });
  return { child, done, output: () => Buffer.concat(chunks).toString('utf8'), truncated: () => truncated };
}
async function boundedCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal) {
  const proc = capture(command, args, cwd, env); let timedOut = false;
  const stop = () => { timedOut = true; void terminateTree(proc.child, 100).catch(() => proc.child.kill('SIGKILL')); };
  const timer = setTimeout(stop, Math.max(1, timeout)); signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try { const exitCode = await proc.done; return { exitCode: timedOut ? null : exitCode, output: proc.output(), timedOut, truncated: proc.truncated() }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); await terminateTree(proc.child, 100); }
}
export async function runAssessment(workload: Workload, candidateRoot: string, { timeoutMs }: { timeoutMs: number }): Promise<Assessment> {
  let snapshot: Awaited<ReturnType<typeof createAssessmentSnapshot>> | undefined;
  try {
    snapshot = await createAssessmentSnapshot(workload);
    const tests = Object.keys(workload.assessmentFiles).filter(p => p.endsWith('.test.mjs')).sort();
    const result = await boundedCommand(process.execPath, ['--test', '--test-reporter=tap', ...tests], snapshot.root,
      { PATH: process.env.PATH, NODE_OPTIONS: '', [WORKLOAD_CANDIDATE_ROOT_ENV]: candidateRoot }, timeoutMs);
    return { ran: true, exitCode: result.exitCode, criteria: criteriaFromTap(result.output, idsOf(workload)),
      reason: result.timedOut ? 'assessment timed out' : result.truncated ? 'assessment output truncated' : result.exitCode === null ? 'assessment process failed' : null };
  } catch { return unassessed(workload, 'assessment unavailable'); }
  finally { await snapshot?.dispose(); }
}
export function decideStop(task: Json, startedAt: number, capMs: number, now: number): { status: Status; wallClockMs: number } | null {
  const elapsed = Math.max(0, now - startedAt);
  const completed = typeof task.completedAt === 'string' ? Date.parse(task.completedAt) - startedAt : NaN;
  if (task.status === 'DONE' && completed >= 0 && completed <= capMs && completed <= elapsed) return { status: 'completed', wallClockMs: completed };
  return elapsed >= capMs ? { status: 'capped', wallClockMs: elapsed } : null;
}
interface RecordInput extends RunOptions {
  startedAt: number; wallClockMs: number; status: Status; assessment: Assessment;
  roles?: RoleObservation[]; task?: Json; usageTaskId?: string; cliVersion?: string | null;
  qaApprovals?: number | null; qaRejections?: number | null; failureReason?: string | null; notes?: string[];
}
export function buildOutcomeRecord(input: RecordInput): OutcomeRecord {
  const w = input.workload; const roles = input.roles ?? rolesFromReceipts([], null, input.command ?? 'claude').roles;
  return { version: 1, workload: { id: w.id, category: w.category, caseDigest: digestWorkload(w), snapshotDigest: w.snapshotDigest, corpusVersion: input.corpusVersion },
    run: { moeCommit: input.moeCommit, startedAt: new Date(input.startedAt).toISOString(), endedAt: new Date(input.startedAt + input.wallClockMs).toISOString(),
      wallClockMs: input.wallClockMs, wallClockCapMs: input.capMs ?? CAP, status: input.status, repetition: 1, repetitionsPlanned: 1,
      platform: process.platform, nodeVersion: process.version, cliVersion: input.cliVersion ?? null, roles,
      usageTaskId: input.usageTaskId ?? null, failureReason: input.failureReason ?? null },
    moeOutcome: { finalStatus: textValue(input.task?.status, 32), reopenCount: counter(input.task?.reopenCount),
      qaApprovals: input.qaApprovals ?? null, qaRejections: input.qaRejections ?? null,
      plannerSessions: roles.find(r => r.role === 'architect')?.launches ?? null, repairAttempts: null },
    assessment: input.assessment, latency: { firstCodeChangeMs: null, endToEndMs: input.wallClockMs },
    retrieval: { sourceRetrievals: null, retrievedBytes: null }, notes: (input.notes ?? []).slice(0, 10) };
}
export async function checkPreconditions(opts: RunOptions): Promise<void> {
  if (process.platform === 'win32') return fail('baseline driver requires POSIX process groups');
  if (!/^[0-9a-f]{40}$/.test(opts.moeCommit)) return fail('moeCommit must be 40 lowercase hex');
  try { validateWorkload(opts.workload); } catch { return fail('invalid workload'); }
  if (!Number.isSafeInteger(opts.corpusVersion) || opts.corpusVersion < 1) return fail('invalid corpus version');
  for (const n of [opts.capMs ?? CAP, opts.pollMs ?? 1000, opts.killGraceMs ?? 1000]) if (!Number.isSafeInteger(n) || n < 1) return fail('invalid timing option');
  if (!textValue(opts.command ?? 'claude', 64)) return fail('invalid CLI command');
  for (const file of ['packages/moe-daemon/dist/index.js', 'packages/moe-proxy/dist/index.js', 'scripts/moe-agent.sh', 'scripts/moe-call.sh', 'scripts/baseline-report.mjs']) {
    try { if (!(await fs.stat(path.join(opts.moeRoot ?? ROOT, file))).isFile()) return fail('missing runtime artifact'); }
    catch { return fail('missing runtime artifact'); }
  }
}
export async function validateRecord(record: OutcomeRecord, moeRoot = ROOT): Promise<OutcomeRecord> {
  try {
    const contract = await import(pathToFileURL(path.join(moeRoot, 'scripts/baseline-report.mjs')).href) as { readBaselineRecord(raw: unknown): OutcomeRecord };
    return contract.readBaselineRecord(record);
  } catch { return fail('baseline outcome record validation failed'); }
}

interface RunState {
  opts: RunOptions; root: string; project: string; env: NodeJS.ProcessEnv; startedAt: number;
  daemon?: Captured; daemonPid?: number; seats: Captured[]; taskId?: string; notes: string[]; stage: string;
}
async function jsonFile(file: string): Promise<Json> { return object(JSON.parse(await readBounded(file, OUTPUT_LIMIT))); }
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
function remaining(state: RunState): number {
  if (state.opts.signal?.aborted) return fail('run aborted');
  const left = (state.opts.capMs ?? CAP) - (Date.now() - state.startedAt);
  if (left <= 0) return fail('run capped');
  return left;
}
function runEnv(root: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOE_') && !key.startsWith('GIT_')));
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'moe-baseline';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'baseline@moe.invalid';
  env.HOME = path.join(root, 'home'); env.XDG_CONFIG_HOME = env.HOME; env.TMPDIR = path.join(root, 'tmp');
  for (const key of ['MOE_ACCOUNTS_FILE', 'CLAUDE_CONFIG_DIR']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...overrides };
}
async function command(state: RunState, executable: string, args: string[], maxMs = 15_000) {
  const result = await boundedCommand(executable, args, state.project, state.env, Math.min(remaining(state), maxMs), state.opts.signal);
  if (result.exitCode !== 0 || result.truncated) return fail(`${state.stage} command failed`);
  return result.output;
}
async function setupProject(state: RunState): Promise<void> {
  state.stage = 'snapshot';
  const snapshot = await createCodingSnapshot(state.opts.workload); state.project = snapshot.root;
  await writeJson(path.join(state.root, 'project-path.json'), { root: snapshot.root });
  state.stage = 'git initialization';
  const prefix = ['-c', 'user.name=moe-baseline', '-c', 'user.email=baseline@moe.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(state.root, 'hooks')}`];
  await command(state, 'git', [...prefix, 'init']);
  await command(state, 'git', [...prefix, 'add', '--', '.']);
  await command(state, 'git', [...prefix, 'commit', '-m', 'baseline initial snapshot']);
}
async function rememberProcesses(state: RunState): Promise<void> {
  // Driver-owned audit only; not daemon state or trusted process evidence.
  await fs.writeFile(path.join(state.root, 'processes.json'), JSON.stringify({ daemon: state.daemon?.child.pid ?? null, seats: state.seats.map(p => p.child.pid) }) + '\n', { mode: 0o600 });
}
async function startDaemon(state: RunState): Promise<number> {
  state.stage = 'daemon startup'; remaining(state);
  const root = state.opts.moeRoot ?? ROOT;
  const argv = state.opts.daemonCommand ?? [process.execPath, path.join(root, 'packages/moe-daemon/dist/index.js'), 'init', '--project', state.project];
  state.daemon = capture(argv[0], argv.slice(1), state.project, state.env, 10 * OUTPUT_LIMIT, path.join(state.root, 'logs/daemon.log'));
  await rememberProcesses(state);
  const deadline = Date.now() + Math.min(remaining(state), 60_000);
  while (Date.now() < deadline) {
    remaining(state);
    if (state.daemon.child.exitCode !== null || state.daemon.child.signalCode !== null || !state.daemon.child.pid) return fail('daemon exited during startup');
    try {
      const info = await jsonFile(path.join(state.project, '.moe/daemon.json'));
      if (typeof info.port === 'number' && info.projectPath === state.project) {
        const health = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(Math.min(remaining(state), 1000)) });
        if (health.ok && typeof info.pid === 'number') { state.daemonPid = info.pid; return info.port; }
      }
    } catch { /* daemon.json is published only after listen; transient reads are expected */ }
    await delay(Math.min(50, remaining(state)));
  }
  return fail('daemon startup timed out');
}
async function configureDaemon(state: RunState, port: number): Promise<void> {
  state.stage = 'daemon configuration';
  const timeoutMs = Math.min(remaining(state), 10_000);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const abort = () => finish(false);
    function finish(ok: boolean) { clearTimeout(timer); state.opts.signal?.removeEventListener('abort', abort); ws.terminate(); if (ok) resolve(); else reject(new Error('daemon settings failed')); }
    state.opts.signal?.addEventListener('abort', abort, { once: true });
    ws.once('open', () => ws.send(JSON.stringify({ type: 'UPDATE_SETTINGS', payload: { approvalMode: 'TURBO' } })));
    ws.on('message', bytes => { try { const message = object(JSON.parse(bytes.toString())); if (message.type === 'SETTINGS_UPDATED') finish(true); else if (message.type === 'ERROR') finish(false); } catch { finish(false); } });
    ws.once('error', () => finish(false));
  });
  const settings = object((await jsonFile(path.join(state.project, '.moe/project.json'))).settings);
  if (settings.approvalMode !== 'TURBO' || Object.keys(object(settings.models)).length) return fail('unexpected effective settings');
  await writeJson(path.join(state.root, 'effective-settings.json'), settings);
  state.notes.push('Effective settings: approvalMode=TURBO; no settings.models pins; full snapshot in effective-settings.json. Architect runs headless; plan routing applies.');
}
async function callTool(state: RunState, tool: string, args: Json): Promise<Json> {
  state.stage = `daemon tool ${tool}`;
  const raw = await command(state, 'bash', [path.join(state.opts.moeRoot ?? ROOT, 'scripts/moe-call.sh'), tool, JSON.stringify(args), '--project', state.project]);
  const result = object(JSON.parse(raw));
  if (result.success !== true) return fail('daemon tool refused');
  return result;
}
async function createTask(state: RunState): Promise<void> {
  const epic = object((await callTool(state, 'create_epic', { title: 'Frozen baseline workload' })).epic);
  const w = state.opts.workload;
  const task = object((await callTool(state, 'create_task', { epicId: epic.id, title: `[baseline] ${w.id}`,
    description: w.intendedBehavior, definitionOfDone: w.rubric.criteria.map(c => c.description) })).task);
  if (typeof task.id !== 'string' || !/^task-[a-zA-Z0-9-]+$/.test(task.id)) return fail('daemon returned invalid task identity');
  state.taskId = task.id;
  await callTool(state, 'set_task_status', { taskId: task.id, status: 'PLANNING' });
}
async function startSeats(state: RunState): Promise<void> {
  state.stage = 'wrapper seats';
  for (const role of ROLES) {
    remaining(state);
    const args = [path.join(state.opts.moeRoot ?? ROOT, 'scripts/moe-agent.sh'), '--role', role, '--project', state.project,
      '--worker-id', `${role}-baseline`, '--command', state.opts.command ?? 'claude', '--no-interactive', '--no-start-daemon', '--poll-interval', '1'];
    state.seats.push(capture('bash', args, state.project, state.env, 10 * OUTPUT_LIMIT, path.join(state.root, `logs/${role}.log`)));
    await rememberProcesses(state);
  }
}
async function readTask(state: RunState): Promise<Json> {
  if (!state.taskId) return {};
  return jsonFile(path.join(state.project, '.moe/tasks', state.taskId + '.json'));
}
async function poll(state: RunState): Promise<{ status: Status; wallClockMs: number; failureReason?: string }> {
  while (true) {
    let task: Json = {};
    try { task = await readTask(state); } catch { /* retry a transient task read within the cap */ }
    const now = Date.now(); const wallClockMs = Math.max(0, now - state.startedAt);
    const stop = decideStop(task, state.startedAt, state.opts.capMs ?? CAP, now);
    if (stop) return stop;
    if (state.opts.signal?.aborted) return { status: 'aborted', wallClockMs, failureReason: 'run aborted' };
    const exited = (p: Captured) => !p.child.pid || p.child.exitCode !== null || p.child.signalCode !== null;
    let daemonChanged = false;
    try { daemonChanged = (await jsonFile(path.join(state.project, '.moe/daemon.json'))).pid !== state.daemonPid; } catch { daemonChanged = true; }
    if (daemonChanged || (state.daemon && exited(state.daemon))) return { status: 'failed', wallClockMs, failureReason: 'daemon exited' };
    if (state.seats.every(exited)) return { status: 'failed', wallClockMs, failureReason: 'all wrapper seats exited' };
    await delay(Math.min(state.opts.pollMs ?? 1000, remaining(state)));
  }
}
async function teardown(state: RunState): Promise<void> {
  const stop = async (proc: Captured) => {
    try { await terminateTree(proc.child, state.opts.killGraceMs ?? 1000); }
    catch { state.notes.push('process group termination failed; consult processes.json'); }
    if (proc.truncated()) state.notes.push('process log truncated at 10 MiB or log write failed');
  };
  await Promise.all(state.seats.map(stop));
  if (state.daemon) {
    await boundedCommand(process.execPath, [path.join(state.opts.moeRoot ?? ROOT, 'packages/moe-daemon/dist/index.js'), 'stop', '--project', state.project],
      state.project, state.env, 5000).catch(() => state.notes.push('daemon stop command failed'));
    await stop(state.daemon);
  }
}
async function observe(state: RunState) {
  let task: Json = {}; let qaApprovals: number | null = null; let qaRejections: number | null = null;
  try { task = await readTask(state); } catch { state.notes.push('final task observation unavailable'); }
  try {
    const raw = await readBounded(path.join(state.project, '.moe/activity.log'), 16 * OUTPUT_LIMIT);
    const parsed = jsonLines(raw);
    if (parsed.malformedLines) throw new Error('incomplete activity');
    const events = parsed.rows.map(object).filter(r => r.taskId === state.taskId);
    qaApprovals = events.filter(r => r.event === 'QA_APPROVED').length;
    qaRejections = events.filter(r => r.event === 'QA_REJECTED').length;
  } catch { state.notes.push('QA activity counters unavailable'); }
  const receipts = await readUsageReceipts(path.join(state.project, 'logs/moe-usage'));
  const roles = rolesFromReceipts(receipts.rows, state.taskId ?? null, state.opts.command ?? 'claude');
  state.notes.push(...receipts.notes, ...roles.notes);
  const dest = path.join(state.root, 'usage', state.opts.workload.id, 'logs/moe-usage'); await fs.mkdir(dest, { recursive: true });
  // Re-serialize only the bounded parsed rows, never follow links or copy uncontrolled trees.
  await fs.writeFile(path.join(dest, 'observed.jsonl'), receipts.rows.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600, flag: 'wx' });
  return { task, qaApprovals, qaRejections, roles: roles.roles };
}
export async function runBaselineWorkload(opts: RunOptions): Promise<{ runRoot: string; recordPath: string; record: OutcomeRecord }> {
  // Snapshot caller-owned data before the first await: validation must remain
  // true when paths are used after artifact IO. AbortSignal remains live.
  try { opts = { ...opts, workload: validateWorkload(opts.workload), seatEnv: { ...opts.seatEnv },
    daemonCommand: opts.daemonCommand ? [...opts.daemonCommand] : undefined }; } catch { return fail('invalid run options'); }
  await checkPreconditions(opts);
  const root = await fs.mkdtemp(path.join(opts.parentDir ?? os.tmpdir(), `moe-baseline-${opts.workload.id}-`));
  for (const dir of ['home', 'logs', 'records', 'usage', 'tmp', 'hooks']) await fs.mkdir(path.join(root, dir));
  const state: RunState = { opts, root, project: root, env: runEnv(root, opts.seatEnv ?? {}), startedAt: Date.now(), seats: [], notes: [], stage: 'setup' };
  const serena = path.join(os.homedir(), '.local/bin/serena');
  try { await fs.access(serena, constants.X_OK); state.env.MOE_SERENA_PATH ??= serena; } catch { /* optional */ }
  const keys = Object.keys(opts.seatEnv ?? {}).sort().map(k => k.replace(/[^A-Za-z0-9_]/g, '?')).join(',');
  if (opts.sourceDirty) state.notes.push('Moe tracked source tree was dirty; supplied commit is not an exact source-byte identity.');
  if (keys) state.notes.push(`Seat-env override keys: ${keys}`.slice(0, 300));
  let stopped: { status: Status; wallClockMs: number; failureReason?: string } = { status: 'failed', wallClockMs: 0 };
  try {
    remaining(state); await setupProject(state);
    await configureDaemon(state, await startDaemon(state)); await createTask(state); await startSeats(state);
    stopped = await poll(state);
  } catch {
    const wallClockMs = Math.max(0, Date.now() - state.startedAt);
    stopped = { status: opts.signal?.aborted ? 'aborted' : wallClockMs >= (opts.capMs ?? CAP) ? 'capped' : 'failed', wallClockMs, failureReason: `${state.stage} failed`.slice(0, 200) };
  } finally {
    // DONE is stamped before the CLI result/usage event flushes. Give that
    // completed launch a bounded drain, outside measured time; never delay a cap.
    if (stopped.status === 'completed') await delay(opts.killGraceMs ?? 1000);
    await teardown(state);
  }
  const observations = await observe(state);
  const version = await boundedCommand(opts.command ?? 'claude', ['--version'], root, state.env, 10_000);
  const assessment = state.seats.length ? await runAssessment(opts.workload, state.project, { timeoutMs: 60_000 }) : unassessed(opts.workload, 'no wrapper seat started');
  const record = buildOutcomeRecord({ ...opts, ...stopped, ...observations, startedAt: state.startedAt, usageTaskId: state.taskId,
    cliVersion: version.exitCode === 0 ? textValue(version.output.trim(), 128) : null, assessment, notes: [...new Set(state.notes)].slice(0, 10) });
  await validateRecord(record, opts.moeRoot ?? ROOT);
  const recordPath = path.join(root, 'records', opts.workload.id + '.json'); await writeJson(recordPath, record);
  return { runRoot: root, recordPath, record };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workload', '--cap-minutes', '--parent', '--moe-commit', '--command'].includes(args[i]) || !args[i + 1]) return fail('invalid CLI arguments');
    values[args[i]] = args[i + 1];
  }
  const { MATCHED_CORPUS } = await import('./matchedCorpus.js');
  const workload = MATCHED_CORPUS.cases.find(w => w.id === values['--workload'])?.workload;
  if (!workload) return fail('unknown workload id');
  const sha = values['--moe-commit'] ?? (await boundedCommand('git', ['-C', ROOT, 'rev-parse', 'HEAD'], ROOT, process.env, 5000)).output.trim();
  const dirty = await boundedCommand('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], ROOT, process.env, 5000);
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await runBaselineWorkload({ workload, corpusVersion: MATCHED_CORPUS.version, moeCommit: sha, command: values['--command'],
      capMs: values['--cap-minutes'] ? Number(values['--cap-minutes']) * 60_000 : undefined, parentDir: values['--parent'], signal: controller.signal, sourceDirty: dirty.exitCode === 0 && dirty.output.trim().length > 0 });
    console.log(JSON.stringify({ runRoot: result.runRoot, recordPath: result.recordPath }));
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('baseline driver failed before writing an outcome record'); process.exitCode = 1; });
}

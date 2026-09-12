// =============================================================================
// Wave 1 HELD-OUT ACCEPTANCE TESTS
// epic-3d096d59120542fc9fc9c7b91a713795 — "one reliable delivery path"
// Authored by task-30df41a802754b65ac29d04fa031b769 BEFORE any implementation
// task starts, so no later task can quietly redefine what "delivered" means.
//
// RULES FOR EVERY LATER OWNER
//   * Unskip ONLY your own case. Make it pass by changing production code.
//   * A diff that edits an assertion, a constant, a fixture record or a helper
//     in this file instead of the code under test is a QA reject.
//   * Six `it.skip` bodies collect green today. Skipped collection is NOT six
//     behavioural passes and is NOT red evidence. The red proof is owed by each
//     owner at unskip time, against the counterexample named on its describe.
//
// PILOT (human-confirmed 2026-09-11, recorded here so the fixtures are not
// re-guessed): ONE repository, ONE delivery target, ONE provider mode —
//   provider mode : Codex one-shot headless (-CodexExec / --codex-exec)
//   delivery      : local branch, target ref refs/heads/wave1-pilot
//   policy        : settings.deliveryPolicy = 'local-branch' (strict: cases 2, 6),
//                   settings.deliveryPolicy absent = legacy/default (cases 1, 3, 4, 5)
//
// NORMATIVE CONTRACTS FROZEN HERE (new names; they do not exist yet — the owning
// task must introduce them EXACTLY, not under a permissive alias):
//   moe.finalize_attempt   { taskId, workerId, runnerId, attemptId, generation,
//                            outcome: 'landed', landedRevision: <40-hex> }
//   moe.reattach_attempt   { taskId, workerId, runnerId, attemptId, generation,
//                            processStartedAt, host }
//   moe.record_candidate   { id, taskId, attemptId, generation, workerId,
//                            baseRevision, treeSha, deliveryTarget }
//   moe.record_check_run   { id, candidateId, treeSha, command, exitCode,
//                            outputTail, runnerId,
//                            source: 'runner-observed' | 'agent-reported' }
//   moe.record_delivery_receipt
//                          { candidateId, target, targetBefore, targetAfter,
//                            landedRevision, pushResult }
//   moe.claim_next_task    also accepts optional runnerId / workspace /
//                          processStartedAt / host, and returns TOP-LEVEL
//                          attemptId + generation
//   moe.release_task       also accepts attemptId + generation (fencing)
//   moe.qa_approve         also accepts candidateId (reviewed-candidate binding)
//   moe.get_context        projects result.currentCandidate = the exact stored
//                          Candidate record, selected by createdAt then id
//   persisted Candidate    { id, attemptId, taskId, baseRevision, treeSha,
//                            deliveryTarget, createdAt (daemon clock) }; the
//                            call's generation/workerId are fencing inputs
//                            and are not asserted on the stored record
//   persisted Review       { taskId, candidateId, reviewerId, decision, summary }
//   persisted records      .moe/<kind>/<id>.json for attempts, candidates,
//                          checks, reviews and receipts (resourceStore pattern)
//   refusal codeNames      ATTEMPT_FINALIZING, ATTEMPT_RECONCILING,
//                          ATTEMPT_IDENTITY_MISMATCH, ATTEMPT_SUPERSEDED,
//                          CANDIDATE_MISMATCH  -> MoeErrorCode -32002
//                          DEPENDENCY_EVIDENCE_MISSING -> MoeErrorCode -32003
//   over the MCP wire      refusals carry { code, message, data: { tool,
//                          codeName } } only — MoeError.context is not
//                          forwarded — so a wire refusal about a held attempt
//                          names that attempt's id in its message (case 4)
//
// UNSKIP OWNERS (one per acceptance criterion, in file order)
//   1 fast QA vs candidate prep      task-d72d8cc6a29a4181a3767f493007320e
//                                    (prereq task-5dd49fe2f31b477bbbad581dd22dd9af)
//   2 failed gate vs dependents      task-94f534924ea841af8c164191060ee4d3
//   3 reviewing A cannot approve B   task-5b85773867594a8eb0cea350f2c6008f
//   4 daemon restart keeps ownership task-58f7db9a9e44469e9351b2cdea73b47d
//   5 delayed generation N           task-b6c48bf029bf4170a603a91c12451df7
//   6 crash between effect + record  task-b1c9850824fe4437a8c70b4ee083602b
//
// OLD-BEHAVIOUR COUNTEREXAMPLE each owner must demonstrate after unskipping
// (a missing module or a compile failure is NOT the counterexample):
//   1 premature DONE       3 wrong-candidate DONE   5 stale release lands
//   2 released dependent   4 purged owner           6 repeated Git effect
// =============================================================================

import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { describe, it, expect, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { getTools, type ToolDefinition } from '../tools/index.js';
import { MoeError } from '../util/errors.js';
import { runDependencyUnblock } from '../state/dependencyUnblock.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter, type JsonRpcRequest } from '../server/McpAdapter.js';
import type { ExecutionAttempt, ImplementationStep } from '../types/schema.js';

// -----------------------------------------------------------------------------
// File-local fixture helpers. Deliberately dumb: they read and project JSON.
// None of them may implement a delivery decision, a selection rule or a
// recovery algorithm — those belong to production code and are what is on trial.
// -----------------------------------------------------------------------------

/**
 * Resolve a REGISTERED production tool by its exact MCP name.
 *
 * A tool this epic has not built yet makes the case fail loudly with a
 * diagnostic naming the contract. It must never degrade into a passing
 * fallback, and no case may statically import a module that does not exist
 * (vitest imports the module even when every case in it is skipped).
 */
function requireTool(state: StateManager, name: string): ToolDefinition {
  const matches = getTools(state).filter((t) => t.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `[WAVE1-CONTRACT-MISSING] expected exactly 1 tool registered as "${name}" in ` +
        `src/tools/index.ts, found ${matches.length}. The owning task must register it ` +
        `under this exact name; this test may not be edited to route around it.`
    );
  }
  return matches[0];
}

/** Invoke a registered tool the way MCP dispatch does: under the state mutex. */
async function callTool(
  state: StateManager,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = requireTool(state, name);
  return state.runExclusive(() => tool.handler(args, state));
}

interface CapturedRefusal {
  code: number;
  codeName: string;
  context: Record<string, unknown>;
}

/**
 * Await a call that MUST be refused and return its exact refusal identity.
 * A resolved promise, or a non-MoeError throw, fails here rather than letting
 * the caller assert on a shape it never got.
 */
async function captureRefusal(call: Promise<unknown>): Promise<CapturedRefusal> {
  let thrown: unknown;
  let resolved = false;
  try {
    await call;
    resolved = true;
  } catch (err) {
    thrown = err;
  }
  if (resolved) throw new Error('expected a MoeError refusal, but the call resolved');
  if (!(thrown instanceof MoeError)) {
    const shown = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    throw new Error(`expected a MoeError refusal, got ${shown}`);
  }
  return {
    code: thrown.code,
    codeName: thrown.codeName,
    context: (thrown.context ?? {}) as Record<string, unknown>,
  };
}

/** Raw file bytes — the byte-identical comparison used for "nothing was written". */
function readBytes(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readBytes(file)) as Record<string, unknown>;
}

/** Every *.json record in a .moe/<kind>/ directory, sorted by file name. */
function listRecords(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(dir, f)));
}

/**
 * Write a fixture record into .moe/<kind>/<id>.json BEFORE state.load(), so the
 * case exercises real tools against real persisted state. This is fixture setup
 * inside an OS-temp project owned by ToolTestHarness — never a write into the
 * live checkout's .moe/, and never a substitute for the production write path
 * that the tool under test must perform itself.
 */
function writeRecord<T extends { id: string }>(
  moePath: string,
  kind: string,
  record: T
): T {
  const dir = path.join(moePath, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  return record;
}

/** A persisted ExecutionAttempt fixture in exactly the shape attemptStore writes. */
function attemptRecord(
  fields: Pick<ExecutionAttempt, 'id' | 'taskId' | 'workerId' | 'generation' | 'phase' | 'workspace'> &
    Partial<ExecutionAttempt>
): ExecutionAttempt {
  return {
    runnerId: 'runner-pilot',
    startedAt: '2026-09-11T00:00:00.000Z',
    lastPhaseAt: '2026-09-11T00:00:00.000Z',
    ...fields,
  };
}

/** Exact-subset projection so toEqual compares the named fields and nothing else. */
function project(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = record[key];
  return out;
}

/** Deterministic 40-hex revision literals; no randomness in any assertion. */
const SHA = {
  base: 'a1'.repeat(20),
  landed: 'b2'.repeat(20),
  treeA: 'c3'.repeat(20),
  treeB: 'd4'.repeat(20),
} as const;

const PILOT_TARGET = 'refs/heads/wave1-pilot';

/** A completed plan step — complete_task refuses an empty or unfinished plan. */
function completedStep(stepId: string): ImplementationStep {
  return {
    stepId,
    description: 'Fixture step',
    status: 'COMPLETED',
    affectedFiles: ['file.ts'],
    modifiedFiles: ['file.ts'],
    completedAt: '2026-09-11T00:00:00.000Z',
  };
}

const VERIFICATION = {
  command: 'npx vitest run src/delivery/acceptance.test.ts',
  exitCode: 0,
  outputTail: 'Tests  6 skipped (6)',
} as const;

/**
 * The frozen strict pilot configuration. `setupMoeFolder` REPLACES the whole
 * settings object, so this spells out every key the strict path reads.
 * deliveryPolicy is the one new setting; the rest already exist today.
 */
const STRICT_SETTINGS = {
  approvalMode: 'CONTROL',
  speedModeDelayMs: 2000,
  agentCommand: 'claude',
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  deliveryPolicy: 'local-branch',
  autoCommit: true,
  consolidationBranch: 'wave1-pilot',
  qualityGate: 'node gate.cjs',
  qualityGateScope: 'everyTask',
  autoCreateBranch: false,
  checkpointPush: false,
} as const;

const PILOT_GATE_COMMAND = 'node gate.cjs';

// -----------------------------------------------------------------------------
// Owned-process + transport helpers (criteria 4 and 6). They start, watch and
// stop ONLY processes this file spawned, redirect HOME/USERPROFILE/TEMP and Git
// configuration into the fixture, and reach the daemon only through its real
// endpoints (daemon.json, GET /health, JSON-RPC over ws /mcp). None of them
// makes a delivery decision.
// -----------------------------------------------------------------------------

const DAEMON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(DAEMON_ROOT, '..', '..');
const TSX_CLI = path.join(DAEMON_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const DAEMON_ENTRY = path.join(DAEMON_ROOT, 'src', 'index.ts');
const OUTPUT_TAIL_CHARS = 8_000;
const POLL_INTERVAL_MS = 100;

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface OwnedProcess {
  label: string;
  child: ChildProcess;
  /** Bounded tail of combined stdout+stderr, for failure diagnostics only. */
  output(): string;
  exited: Promise<ExitStatus>;
  /** True once the child exited OR failed to spawn at all. */
  settled(): boolean;
}

function spawnOwned(label: string, command: string, args: string[], options: SpawnOptions): OwnedProcess {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  let done = false;
  const append = (chunk: Buffer | string): void => {
    tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<ExitStatus>((resolve) => {
    child.once('exit', (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
    child.once('error', (err) => {
      // A spawn failure never emits 'exit'; record it so waits abort at once.
      done = true;
      append(`\n[spawn error] ${err.message}\n`);
      resolve({ code: null, signal: null });
    });
  });
  return { label, child, output: () => tail, exited, settled: () => done };
}

function hasExited(p: OwnedProcess): boolean {
  return p.settled() || p.child.exitCode !== null || p.child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Race `promise` against a cancellable deadline; the deadline is a named failure. */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, describe: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms: ${describe()}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded wait for an owned child to exit. A timeout is a failure, never a pass. */
function awaitExit(p: OwnedProcess, timeoutMs: number): Promise<ExitStatus> {
  return withDeadline(p.exited, timeoutMs, () => `${p.label} did not exit. Output tail:\n${p.output()}`);
}

/** Stop an owned child if it is still running, and wait (bounded) for it. */
async function stopOwned(p: OwnedProcess): Promise<void> {
  if (!hasExited(p)) p.child.kill('SIGKILL');
  await awaitExit(p, 15_000);
}

/**
 * Bounded condition polling: `probe` returns null to keep waiting and throws
 * to abort at once. The deadline is a named failure carrying diagnostics.
 */
async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null> | T | null,
  diagnostics: () => string = () => ''
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${diagnostics()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** A temp root under os.tmpdir() with this file's prefix — the only kind we delete. */
const OWNED_ROOT_PREFIX = 'moe-wave1-acceptance-';

function makeOwnedRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), OWNED_ROOT_PREFIX));
}

function removeOwnedRoot(dir: string, prefix: string = OWNED_ROOT_PREFIX): void {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`refusing to remove ${resolved}: not a temp root owned by this test file`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * A child environment with HOME/USERPROFILE/TEMP redirected into the fixture,
 * Git configuration isolated, and every inherited MOE_* / GIT_* variable of the
 * live fleet removed so nothing reaches the real daemon, port or project.
 */
function isolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('MOE_') || upper.startsWith('GIT_')) continue;
    if (['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'].includes(upper)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    ...extra,
  };
}

interface DaemonHandle {
  launcher: OwnedProcess;
  pid: number;
  port: number;
  /** The exact daemon.json bytes this daemon wrote. */
  info: string;
}

function probeHealth(port: number): Promise<{ pid: number } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { pid?: unknown };
          resolve(res.statusCode === 200 && typeof parsed.pid === 'number' ? { pid: parsed.pid } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Start the REAL daemon startup path — the internal `_run` command of
 * src/index.ts through the installed tsx CLI (no supervisor, no build, no
 * default fleet port). Ready = a daemon.json whose bytes differ from the
 * previous daemon's (`staleInfo`; a killed daemon leaves its file behind, and a
 * reused pid must not pass for a new daemon) and whose /health answers 200 with
 * the same pid. The launcher is registered in `owned` before any wait, so
 * teardown can always stop it.
 */
async function startDaemonChild(
  projectDir: string,
  isolationRoot: string,
  staleInfo: string | null,
  owned: OwnedProcess[]
): Promise<DaemonHandle> {
  const requestedPort = await freePort();
  const launcher = spawnOwned(
    'daemon',
    process.execPath,
    [TSX_CLI, DAEMON_ENTRY, '_run', '--project', projectDir, '--port', String(requestedPort), '--host', '127.0.0.1'],
    { cwd: DAEMON_ROOT, env: isolatedEnv(isolationRoot) }
  );
  owned.push(launcher);
  const infoFile = path.join(projectDir, '.moe', 'daemon.json');
  return waitFor(
    'daemon.json + /health readiness',
    90_000,
    async () => {
      if (hasExited(launcher)) {
        throw new Error(`daemon exited before it was ready (exit ${launcher.child.exitCode}):\n${launcher.output()}`);
      }
      if (!fs.existsSync(infoFile)) return null;
      let raw: string;
      let info: Record<string, unknown>;
      try {
        raw = readBytes(infoFile);
        info = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null; // mid-write or just removed; poll again
      }
      if (raw === staleInfo || typeof info.pid !== 'number' || typeof info.port !== 'number') return null;
      const health = await probeHealth(info.port);
      if (health === null || health.pid !== info.pid) return null;
      return { launcher, pid: info.pid, port: info.port, info: raw };
    },
    () => launcher.output()
  );
}

/** Abruptly kill the daemon process itself (no graceful shutdown) and await it. */
async function killDaemonAbruptly(daemon: DaemonHandle): Promise<void> {
  if (isPidAlive(daemon.pid)) process.kill(daemon.pid, 'SIGKILL');
  await waitFor(`daemon pid ${daemon.pid} to die`, 15_000, () => (isPidAlive(daemon.pid) ? null : true));
  // The tsx launcher relays its child's exit; it must not outlive the daemon.
  await awaitExit(daemon.launcher, 15_000);
}

/**
 * Teardown: stop the daemon named by the fixture's own daemon.json — but only
 * when /health on that file's port answers with that same pid, so a stale file
 * whose pid was since reused by an unrelated process is never killed — then
 * stop every owned launcher.
 */
async function stopFixtureDaemons(projectDir: string, owned: OwnedProcess[]): Promise<void> {
  const infoFile = path.join(projectDir, '.moe', 'daemon.json');
  if (fs.existsSync(infoFile)) {
    const info = readJson(infoFile);
    const { pid, port } = info;
    if (typeof pid === 'number' && typeof port === 'number' && isPidAlive(pid)) {
      const health = await probeHealth(port);
      if (health !== null && health.pid === pid) {
        process.kill(pid, 'SIGKILL');
        await waitFor(`daemon pid ${pid} to die`, 15_000, () => (isPidAlive(pid) ? null : true));
      }
    }
  }
  for (const p of owned) await stopOwned(p);
}

interface JsonRpcReply {
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string; data?: { tool?: string; codeName?: string } };
}

let rpcSeq = 0;

function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 2_000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close();
  });
}

/** One JSON-RPC request over a fresh ws /mcp connection — moe-proxy's connection model. */
async function mcpRequest(
  port: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<JsonRpcReply> {
  const id = ++rpcSeq;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
  try {
    return await new Promise<JsonRpcReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no reply within ${timeoutMs}ms`)), timeoutMs);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      ws.on('error', fail);
      ws.on('close', () => fail(new Error(`${method}: socket closed before the reply`)));
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
      ws.on('message', (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as JsonRpcReply;
        if (reply.id !== id) return;
        clearTimeout(timer);
        resolve(reply);
      });
    });
  } finally {
    await closeSocket(ws);
  }
}

function daemonTool(port: number, name: string, args: Record<string, unknown>): Promise<JsonRpcReply> {
  return mcpRequest(port, 'tools/call', { name, arguments: args });
}

/** The tool's parsed result; a refusal or an unregistered tool fails here. */
function toolResult(reply: JsonRpcReply, name: string): Record<string, unknown> {
  if (reply.error) {
    const e = reply.error;
    throw new Error(`${name} was refused: ${e.code} ${String(e.data?.codeName)} ${e.message}`);
  }
  const text = reply.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`${name}: the reply carried no result text`);
  return JSON.parse(text) as Record<string, unknown>;
}

interface WireRefusal {
  code: number;
  codeName: string | undefined;
  tool: string | undefined;
  message: string;
}

/**
 * The refusal as it crosses the MCP transport. McpAdapter forwards
 * { code, message, data: { tool, codeName } } and deliberately NOT
 * MoeError.context (McpAdapter.test.ts pins data to exactly those keys), so a
 * refusal that must identify a held record names its id in the message.
 */
function toolRefusal(reply: JsonRpcReply, name: string): WireRefusal {
  if (!reply.error) throw new Error(`${name}: expected a refusal, but the call succeeded`);
  return {
    code: reply.error.code,
    codeName: reply.error.data?.codeName,
    tool: reply.error.data?.tool,
    message: reply.error.message,
  };
}

/**
 * Run `body`, then EVERY teardown step even when earlier ones fail. A teardown
 * failure surfaces only when the body passed, so it can never mask the
 * assertion that actually failed.
 */
async function withTeardown(
  body: () => Promise<void>,
  teardown: Array<() => Promise<void> | void>
): Promise<void> {
  let failure: { error: unknown } | null = null;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  const teardownErrors: unknown[] = [];
  for (const step of teardown) {
    try {
      await step();
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  if (failure) throw failure.error;
  if (teardownErrors.length > 0) throw teardownErrors[0];
}

// -----------------------------------------------------------------------------
// Criterion 6 fixture pieces: an isolated pilot repository, runtime-generated
// provider/transport shims, and a loopback transport that hands every JSON-RPC
// request to the PRODUCTION McpAdapter. The shims and the transport answer no
// business call themselves; the only thing the transport ever does besides
// forwarding is to hold the FIRST record_delivery_receipt request pending.
// -----------------------------------------------------------------------------

const PILOT_WORKER = 'worker-pilot';
const PILOT_TASK = 'task-R';
const PILOT_STEP = 'step-1';
const OWNED_MARKER = 'delivered by the wave1 pilot';

/** The tracked quality gate: passes only on a tree whose owned.txt carries the delivery. */
const GATE_SOURCE = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const text = fs.readFileSync(path.join(__dirname, 'owned.txt'), 'utf8');",
  `if (text.includes(${JSON.stringify(OWNED_MARKER)})) { console.log('gate ok'); process.exit(0); }`,
  "console.log('gate failed');",
  'process.exit(1);',
  '',
].join('\n');

function git(repo: string, env: NodeJS.ProcessEnv, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true }).trim();
}

/** One isolated repository: fixed identity, base commit on wave1-pilot, tracked gate. */
function initPilotRepo(repo: string, env: NodeJS.ProcessEnv): string {
  fs.writeFileSync(path.join(repo, '.gitignore'), '.moe/\n.codex/\n');
  fs.writeFileSync(path.join(repo, 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'gate.cjs'), GATE_SOURCE);
  git(repo, env, ['init', '-q']);
  git(repo, env, ['symbolic-ref', 'HEAD', PILOT_TARGET]);
  const config: Array<[string, string]> = [
    ['user.name', 'Moe Wave1 Fixture'],
    ['user.email', 'wave1-fixture@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ];
  for (const [key, value] of config) git(repo, env, ['config', key, value]);
  git(repo, env, ['add', '--', '.gitignore', 'gate.cjs', 'owned.txt', 'file.ts']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  return git(repo, env, ['rev-parse', PILOT_TARGET]);
}

/** MOE_PROXY_PATH stand-in: one stdin JSON-RPC request -> POST -> one stdout line. */
function transportShimSource(endpoint: string): string {
  return [
    "'use strict';",
    "const http = require('http');",
    `const ENDPOINT = ${JSON.stringify(endpoint)};`,
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const body = Buffer.concat(chunks).toString('utf8').trim();",
    '  if (!body) process.exit(0);',
    "  const headers = { 'content-type': 'application/json' };",
    "  const req = http.request(ENDPOINT, { method: 'POST', headers }, (res) => {",
    '    const out = [];',
    "    res.on('data', (c) => out.push(c));",
    "    res.on('end', () => {",
    "      const text = Buffer.concat(out).toString('utf8');",
    "      if (text) process.stdout.write(text + '\\n');",
    '      process.exit(res.statusCode === 200 ? 0 : 1);',
    '    });',
    '  });',
    "  req.on('error', (err) => { process.stderr.write('[wave1-transport] ' + err.message + '\\n'); process.exit(1); });",
    '  req.end(body);',
    '});',
    '',
  ].join('\n');
}

/**
 * The Codex stand-in. Answers the wrapper's --version / --help argv probes; on
 * the real `exec` launch it edits ONLY the declared owned.txt and drives the
 * task through the actual get_context / start_step / complete_step /
 * complete_task tools. When the task is no longer WORKING for this worker (a
 * later launch), it does nothing.
 */
function codexShimSource(endpoint: string, projectDir: string, logFile: string): string {
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const http = require('http');",
    `const ENDPOINT = ${JSON.stringify(endpoint)};`,
    `const PROJECT = ${JSON.stringify(projectDir)};`,
    `const LOG = ${JSON.stringify(logFile)};`,
    `const TASK = ${JSON.stringify(PILOT_TASK)};`,
    `const STEP = ${JSON.stringify(PILOT_STEP)};`,
    `const WORKER = ${JSON.stringify(PILOT_WORKER)};`,
    `const MARKER = ${JSON.stringify(OWNED_MARKER)};`,
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(LOG, JSON.stringify(argv) + '\\n');",
    "if (argv.includes('--version')) { process.stdout.write('codex-cli 0.153.4\\n'); process.exit(0); }",
    "if (argv.includes('--help')) { process.stdout.write('Usage: codex exec [OPTIONS] [PROMPT]\\n'); process.exit(0); }",
    "if (!argv.includes('exec')) { process.stderr.write('wave1 codex shim: exec mode only\\n'); process.exit(2); }",
    'let seq = 0;',
    'function call(name, args) {',
    '  return new Promise((resolve, reject) => {',
    "    const body = JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } });",
    "    const req = http.request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {",
    '      const out = [];',
    "      res.on('data', (c) => out.push(c));",
    "      res.on('end', () => {",
    '        try {',
    "          const reply = JSON.parse(Buffer.concat(out).toString('utf8'));",
    "          if (reply.error) throw new Error(name + ' refused: ' + reply.error.code + ' ' + reply.error.message);",
    '          resolve(JSON.parse(reply.result.content[0].text));',
    '        } catch (err) { reject(err); }',
    '      });',
    '    });',
    "    req.on('error', reject);",
    '    req.end(body);',
    '  });',
    '}',
    '(async () => {',
    '  const context = await call(\'moe.get_context\', { taskId: TASK, workerId: WORKER });',
    '  const task = context.task || {};',
    "  if (task.status !== 'WORKING' || task.assignedWorkerId !== WORKER) return;",
    "  await call('moe.start_step', { taskId: TASK, stepId: STEP, workerId: WORKER });",
    "  fs.writeFileSync(path.join(PROJECT, 'owned.txt'), MARKER + '\\n');",
    "  await call('moe.complete_step', { taskId: TASK, stepId: STEP, workerId: WORKER, modifiedFiles: ['owned.txt'] });",
    "  await call('moe.complete_task', { taskId: TASK, workerId: WORKER, summary: 'Edited owned.txt; node gate.cjs passes.',",
    "    verification: { command: 'node gate.cjs', exitCode: 0, outputTail: 'gate ok' } });",
    "})().catch((err) => { process.stderr.write('wave1 codex shim failed: ' + err.message + '\\n'); process.exit(1); });",
    '',
  ].join('\n');
}

interface PilotShims {
  transport: string;
  codexCommand: string;
  codexLog: string;
}

/** Generate both shims at test runtime, inside the owned fixture root only. */
function writePilotShims(dir: string, endpoint: string, projectDir: string): PilotShims {
  fs.mkdirSync(dir, { recursive: true });
  const transport = path.join(dir, 'moe-transport-shim.cjs');
  fs.writeFileSync(transport, transportShimSource(endpoint));
  const codexLog = path.join(dir, 'codex-shim.log');
  const source = codexShimSource(endpoint, projectDir, codexLog);
  if (process.platform === 'win32') {
    // Literally named codex.cmd: the wrapper detects the CLI by basename.
    fs.writeFileSync(path.join(dir, 'codex-shim.cjs'), source);
    const codexCommand = path.join(dir, 'codex.cmd');
    fs.writeFileSync(codexCommand, '@echo off\r\nnode "%~dp0codex-shim.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
    return { transport, codexCommand, codexLog };
  }
  const codexCommand = path.join(dir, 'codex');
  fs.writeFileSync(codexCommand, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return { transport, codexCommand, codexLog };
}

interface HeldReceipt {
  args: Record<string, unknown>;
  /** The target ref as Git reported it while the receipt call was held. */
  targetAtBarrier: string;
  /** The tree of the request's landedRevision, per Git. */
  landedTree: string;
}

interface FixtureTransport {
  endpoint: string;
  log: string[];
  barrier: Promise<HeldReceipt>;
  setAdapter(adapter: McpAdapter): void;
  stopIntercepting(): void;
  close(): Promise<void>;
}

function replySummary(response: unknown): string {
  if (response === null || typeof response !== 'object') return 'no reply';
  const error = (response as { error?: { code?: number; data?: { codeName?: string } } }).error;
  return error ? `refused ${String(error.code)} ${error.data?.codeName ?? ''}` : 'ok';
}

/**
 * Loopback JSON-RPC endpoint behind the transport shim. Every request goes to
 * the current production McpAdapter.handle, except the FIRST
 * record_delivery_receipt while intercepting: that one is inspected via
 * `onHeld`, signals the barrier and is never answered.
 */
async function startFixtureTransport(
  initial: McpAdapter,
  onHeld: (args: Record<string, unknown>) => HeldReceipt
): Promise<FixtureTransport> {
  let adapter = initial;
  let intercepting = true;
  let held = false;
  const log: string[] = [];
  const parked: http.ServerResponse[] = [];
  let signal!: (value: HeldReceipt) => void;
  let fail!: (error: unknown) => void;
  const barrier = new Promise<HeldReceipt>((resolve, reject) => {
    signal = resolve;
    fail = reject;
  });
  barrier.catch(() => undefined); // awaited by the case; never an unhandled rejection

  const serve = async (body: string, res: http.ServerResponse): Promise<void> => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = request.method === 'tools/call' ? String(params.name) : String(request.method);
    if (intercepting && !held && name === 'moe.record_delivery_receipt') {
      held = true;
      parked.push(res);
      log.push(`${name} -> HELD at the barrier`);
      try {
        signal(onHeld(params.arguments ?? {}));
      } catch (error) {
        fail(error);
      }
      return;
    }
    const response = await adapter.handle(request);
    log.push(`${name} -> ${replySummary(response)}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(response === null ? '' : JSON.stringify(response));
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      serve(Buffer.concat(chunks).toString('utf8'), res).catch((error: unknown) => {
        log.push(`transport error: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}/rpc`,
    log,
    barrier,
    setAdapter: (next) => {
      adapter = next;
    },
    stopIntercepting: () => {
      intercepting = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of parked) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Launch the REAL platform wrapper for the pilot seat (argv arrays, no shell). */
function launchPilotWrapper(label: string, projectDir: string, shims: PilotShims, env: NodeJS.ProcessEnv): OwnedProcess {
  if (process.platform === 'win32') {
    const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 60_000 });
    const shell = pwsh.error || pwsh.status !== 0 ? 'powershell.exe' : 'pwsh';
    return spawnOwned(
      label,
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(REPO_ROOT, 'scripts', 'moe-agent.ps1'),
        '-Project',
        projectDir,
        '-WorkerId',
        PILOT_WORKER,
        '-Role',
        'worker',
        '-Command',
        shims.codexCommand,
        '-CodexExec',
        '-NoStartDaemon',
        '-NoLoop',
        '-PollInterval',
        '0',
      ],
      { cwd: projectDir, env }
    );
  }
  return spawnOwned(
    label,
    'bash',
    [
      path.join(REPO_ROOT, 'scripts', 'moe-agent.sh'),
      '--project',
      projectDir,
      '--worker-id',
      PILOT_WORKER,
      '--role',
      'worker',
      '--command',
      shims.codexCommand,
      '--codex-exec',
      '--no-start-daemon',
      '--no-loop',
      '--poll-interval',
      '0',
    ],
    // Its own process group, so the crash below can take the whole tree at once.
    { cwd: projectDir, env, detached: true }
  );
}

/** Abrupt whole-tree kill of an OWNED wrapper: no trap, no graceful deregistration. */
function killWrapperTree(p: OwnedProcess): void {
  const pid = p.child.pid;
  if (hasExited(p) || pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    // The group can vanish between the exit check and the kill; that is the goal.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/** The single *.json record file in a directory; anything else is a failure. */
function onlyRecordFile(dir: string): string {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (files.length !== 1) throw new Error(`expected exactly one record in ${dir}, found ${files.length}`);
  return path.join(dir, files[0]);
}

// =============================================================================
// CRITERION 1 — fast QA cannot finish before candidate preparation
// =============================================================================
describe('Wave 1 acceptance: fast QA cannot finish before candidate preparation', () => {
  // UNSKIP OWNER: task-d72d8cc6a29a4181a3767f493007320e (moe.finalize_attempt and
  // the finalizing hold it closes). Its prerequisite
  // task-5dd49fe2f31b477bbbad581dd22dd9af lands the minimal qa_approve finalizing
  // hold; the finalization owner unskips this combined case.
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (PREMATURE DONE):
  // on today's code complete_task flips A to REVIEW and a QA that answers in the
  // same second drives it to DONE — and the same worker claims the next task —
  // while the runner has not yet landed a single byte for A.
  it('refuses qa_approve and the next claim until the attempt is finalized', async () => {
    const h = new ToolTestHarness();
    h.init();
    try {
      // Legacy/default delivery policy on purpose: this case is about the
      // attempt/finalize boundary alone, so it must not depend on the later
      // Candidate/CheckRun/Receipt slices or on strict policy evidence.
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({
        id: 'task-A',
        status: 'WORKING',
        assignedWorkerId: null,
        implementationPlan: [completedStep('step-1')],
        order: 1,
      });
      h.createTask({
        id: 'task-B',
        status: 'WORKING',
        assignedWorkerId: null,
        implementationPlan: [],
        order: 2,
      });
      h.createWorker({ id: 'worker-W', status: 'IDLE', currentTaskId: null });
      await h.state.load();

      const tasksDir = path.join(h.moePath, 'tasks');
      const attemptsDir = path.join(h.moePath, 'attempts');
      const taskAFile = path.join(tasksDir, 'task-A.json');
      const taskBFile = path.join(tasksDir, 'task-B.json');

      // --- claim A: the claim is what opens generation 1 ---------------------
      const claim = (await callTool(h.state, 'moe.claim_next_task', {
        statuses: ['WORKING'],
        taskId: 'task-A',
        workerId: 'worker-W',
        runnerId: 'runner-pilot',
        workspace: h.testDir,
      })) as { hasNext: boolean; attemptId: string; generation: number };
      expect(claim.hasNext).toBe(true);
      expect(claim.generation).toBe(1);
      const attemptId = claim.attemptId;
      expect(typeof attemptId).toBe('string');

      await callTool(h.state, 'moe.get_context', { taskId: 'task-A', workerId: 'worker-W' });

      // --- complete A: REVIEW on disk, attempt held in `finalizing` ----------
      await callTool(h.state, 'moe.complete_task', {
        taskId: 'task-A',
        workerId: 'worker-W',
        summary: 'Fixture completion for the finalizing-hold acceptance case.',
        verification: { ...VERIFICATION },
      });

      expect(readJson(taskAFile).status).toBe('REVIEW');
      const attemptsAfterComplete = listRecords(attemptsDir);
      expect(attemptsAfterComplete.length).toBe(1);
      expect(
        project(attemptsAfterComplete[0], ['id', 'taskId', 'workerId', 'generation', 'phase'])
      ).toEqual({
        id: attemptId,
        taskId: 'task-A',
        workerId: 'worker-W',
        generation: 1,
        phase: 'finalizing',
      });

      const attemptFile = path.join(attemptsDir, `${attemptId}.json`);
      const bytesBefore = {
        taskA: readBytes(taskAFile),
        taskB: readBytes(taskBFile),
        attempt: readBytes(attemptFile),
      };

      // --- the fast human QA path is refused --------------------------------
      // No workerId: the IDE/human approval path, the one with no seat to hold.
      const qaRefusal = await captureRefusal(
        callTool(h.state, 'moe.qa_approve', {
          taskId: 'task-A',
          summary: 'Re-read the diff and the DoD; approving immediately.',
        })
      );
      expect(qaRefusal.code).toBe(-32002);
      expect(qaRefusal.codeName).toBe('ATTEMPT_FINALIZING');
      expect(qaRefusal.context.attemptId).toBe(attemptId);
      expect(qaRefusal.context.retryable).toBe(true);

      // --- and so is the same worker moving on to the next task -------------
      const claimRefusal = await captureRefusal(
        callTool(h.state, 'moe.claim_next_task', {
          statuses: ['WORKING'],
          taskId: 'task-B',
          workerId: 'worker-W',
        })
      );
      expect(claimRefusal.code).toBe(-32002);
      expect(claimRefusal.codeName).toBe('ATTEMPT_FINALIZING');
      expect(claimRefusal.context.attemptId).toBe(attemptId);
      expect(claimRefusal.context.retryable).toBe(true);

      // Refusals are pure: not one byte moved.
      expect(readBytes(taskAFile)).toBe(bytesBefore.taskA);
      expect(readBytes(taskBFile)).toBe(bytesBefore.taskB);
      expect(readBytes(attemptFile)).toBe(bytesBefore.attempt);

      // --- the runner reports the landing; finalize is idempotent ------------
      const finalizePayload = {
        taskId: 'task-A',
        workerId: 'worker-W',
        runnerId: 'runner-pilot',
        attemptId,
        generation: 1,
        outcome: 'landed',
        landedRevision: SHA.landed,
      };
      await callTool(h.state, 'moe.finalize_attempt', { ...finalizePayload });

      const attemptsAfterFinalize = listRecords(attemptsDir);
      expect(attemptsAfterFinalize.length).toBe(1);
      expect(project(attemptsAfterFinalize[0], ['id', 'taskId', 'generation', 'phase'])).toEqual({
        id: attemptId,
        taskId: 'task-A',
        generation: 1,
        phase: 'closed',
      });

      const bytesAfterFirstFinalize = readBytes(attemptFile);
      await callTool(h.state, 'moe.finalize_attempt', { ...finalizePayload });
      expect(readBytes(attemptFile)).toBe(bytesAfterFirstFinalize);
      expect(listRecords(attemptsDir).length).toBe(1);

      // --- with the attempt closed, the worker may move on ------------------
      const nextClaim = (await callTool(h.state, 'moe.claim_next_task', {
        statuses: ['WORKING'],
        taskId: 'task-B',
        workerId: 'worker-W',
      })) as { hasNext: boolean };
      expect(nextClaim.hasNext).toBe(true);
      expect(readJson(taskBFile).assignedWorkerId).toBe('worker-W');

      // --- and the same human QA path now completes A -----------------------
      // Positive control: a qa_approve that refused forever would satisfy every
      // refusal above; after finalization it must land DONE (legacy policy,
      // no candidate recorded, so the pre-Wave-1 approve behaviour applies).
      await callTool(h.state, 'moe.qa_approve', {
        taskId: 'task-A',
        summary: 'Re-read the diff and the DoD after the landing was finalized.',
      });
      expect(readJson(taskAFile).status).toBe('DONE');
    } finally {
      h.state.clearEmitter();
      h.cleanup();
    }
  });
});

// =============================================================================
// CRITERION 2 — a failed required gate cannot release dependents
// =============================================================================
describe('Wave 1 acceptance: a failed required gate cannot release dependents', () => {
  // UNSKIP OWNER: task-94f534924ea841af8c164191060ee4d3 (policy-aware DONE
  // evidence gate in claimNextTask + dependencyUnblock).
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (RELEASED DEPENDENT):
  // on today's code P being DONE is the whole test. D claims cleanly and
  // runDependencyUnblock flips E straight back to WORKING even though P's only
  // authoritative gate run for its current candidate exited 1.
  it.skip('keeps D unclaimable and E blocked until an authoritative gate pass exists', async () => {
    const h = new ToolTestHarness();
    h.init();
    try {
      h.setupMoeFolder({ settings: { ...STRICT_SETTINGS } as never });
      h.createEpic();

      // P is DONE — under the legacy policy that alone released its dependents.
      h.createTask({
        id: 'task-P',
        status: 'DONE',
        assignedWorkerId: null,
        implementationPlan: [completedStep('step-1')],
        order: 1,
      });
      // D waits on P through dependsOn; E waits on P through a BLOCKED hold.
      h.createTask({
        id: 'task-D',
        status: 'WORKING',
        assignedWorkerId: null,
        implementationPlan: [],
        dependsOn: ['task-P'],
        order: 2,
      });
      h.createTask({
        id: 'task-E',
        status: 'BLOCKED',
        assignedWorkerId: null,
        implementationPlan: [],
        blockedOnTaskIds: ['task-P'],
        blockedFromStatus: 'WORKING',
        blockedReason: 'Waiting on task-P to land.',
        blockedAt: '2026-09-11T00:00:00.000Z',
        order: 3,
      });
      h.createWorker({ id: 'worker-N', status: 'IDLE', currentTaskId: null });

      // --- P's persisted delivery evidence ----------------------------------
      // Everything except the authoritative gate run is VALID, so this case
      // isolates failed/missing check evidence rather than an absent receipt or
      // an absent review.
      writeRecord(h.moePath, 'candidates', {
        id: 'cand-P-current',
        attemptId: 'attempt-P-1',
        taskId: 'task-P',
        baseRevision: SHA.base,
        treeSha: SHA.treeA,
        deliveryTarget: PILOT_TARGET,
        createdAt: '2026-09-11T02:00:00.000Z',
      });
      writeRecord(h.moePath, 'reviews', {
        id: 'review-P-current',
        taskId: 'task-P',
        candidateId: 'cand-P-current',
        reviewerId: 'qa-fixture',
        decision: 'approve',
        summary: 'Read the diff against the DoD; approving the current candidate.',
      });
      writeRecord(h.moePath, 'receipts', {
        id: 'receipt-P-current',
        candidateId: 'cand-P-current',
        target: PILOT_TARGET,
        targetBefore: SHA.base,
        targetAfter: SHA.landed,
        landedRevision: SHA.landed,
        pushResult: null,
      });
      // The one authoritative gate run for the CURRENT candidate FAILED.
      writeRecord(h.moePath, 'checks', {
        id: 'check-P-current-fail',
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: PILOT_GATE_COMMAND,
        exitCode: 1,
        outputTail: 'gate failed',
        runnerId: 'runner-pilot',
        source: 'runner-observed',
      });
      // A PASSING run for an OLDER candidate of the same task. A task-wide
      // "any pass ever" lookup would wrongly satisfy the gate on this record;
      // the gate must bind to the CURRENT candidate's tree.
      writeRecord(h.moePath, 'candidates', {
        id: 'cand-P-old',
        attemptId: 'attempt-P-1',
        taskId: 'task-P',
        baseRevision: SHA.base,
        treeSha: SHA.treeB,
        deliveryTarget: PILOT_TARGET,
        createdAt: '2026-09-11T01:00:00.000Z',
      });
      writeRecord(h.moePath, 'checks', {
        id: 'check-P-old-pass',
        candidateId: 'cand-P-old',
        treeSha: SHA.treeB,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        outputTail: 'gate ok',
        runnerId: 'runner-pilot',
        source: 'runner-observed',
      });
      // Two more passes that must NOT count: the current candidate's id on a
      // tree it does not have (a lookup keyed on candidateId alone), and the
      // right candidate/tree under a command that is not the required gate.
      writeRecord(h.moePath, 'checks', {
        id: 'check-P-current-other-tree-pass',
        candidateId: 'cand-P-current',
        treeSha: SHA.treeB,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        outputTail: 'gate ok',
        runnerId: 'runner-pilot',
        source: 'runner-observed',
      });
      writeRecord(h.moePath, 'checks', {
        id: 'check-P-current-other-command-pass',
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: 'node lint.cjs',
        exitCode: 0,
        outputTail: 'lint ok',
        runnerId: 'runner-pilot',
        source: 'runner-observed',
      });

      await h.state.load();

      const taskDFile = path.join(h.moePath, 'tasks', 'task-D.json');
      const taskEFile = path.join(h.moePath, 'tasks', 'task-E.json');
      const checksDir = path.join(h.moePath, 'checks');
      const failedCheckFile = path.join(checksDir, 'check-P-current-fail.json');
      const bytesBefore = {
        taskD: readBytes(taskDFile),
        taskE: readBytes(taskEFile),
        failedCheck: readBytes(failedCheckFile),
      };

      const claimD = (): Promise<unknown> =>
        callTool(h.state, 'moe.claim_next_task', {
          statuses: ['WORKING'],
          taskId: 'task-D',
          workerId: 'worker-N',
        });

      // Both dependency paths must refuse on the SAME missing evidence.
      const assertStillHeld = async (): Promise<void> => {
        const refusal = await captureRefusal(claimD());
        expect(refusal.code).toBe(-32003);
        expect(refusal.codeName).toBe('DEPENDENCY_EVIDENCE_MISSING');
        expect(refusal.context.prerequisiteTaskId).toBe('task-P');
        expect(refusal.context.missingEvidence).toEqual([`required-check:${PILOT_GATE_COMMAND}`]);

        const unblocked = await h.state.runExclusive(() => runDependencyUnblock(h.state, 'task-P'));
        expect(unblocked).toEqual([]);
        expect(
          project(readJson(taskEFile), ['status', 'assignedWorkerId', 'blockedOnTaskIds', 'blockedFromStatus'])
        ).toEqual({
          status: 'BLOCKED',
          assignedWorkerId: null,
          blockedOnTaskIds: ['task-P'],
          blockedFromStatus: 'WORKING',
        });
        expect(readBytes(taskDFile)).toBe(bytesBefore.taskD);
        expect(readBytes(taskEFile)).toBe(bytesBefore.taskE);
        expect(readBytes(failedCheckFile)).toBe(bytesBefore.failedCheck);
      };

      // --- 1. failed authoritative gate: D refused, E held ------------------
      await assertStillHeld();

      // --- 2. an AGENT-REPORTED pass is not authoritative evidence ----------
      // A worker's own verification.exitCode may never stand in for a CheckRun,
      // and neither may a CheckRun the agent reported about itself.
      await callTool(h.state, 'moe.record_check_run', {
        id: 'check-P-current-agent-pass',
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        outputTail: 'gate ok (reported by the coding agent)',
        runnerId: 'runner-pilot',
        source: 'agent-reported',
      });
      expect(
        project(readJson(path.join(checksDir, 'check-P-current-agent-pass.json')), [
          'candidateId',
          'treeSha',
          'command',
          'exitCode',
          'source',
        ])
      ).toEqual({
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        source: 'agent-reported',
      });
      await assertStillHeld();

      // --- 3. a RUNNER-OBSERVED pass on the same candidate/tree releases ----
      await callTool(h.state, 'moe.record_check_run', {
        id: 'check-P-current-runner-pass',
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        outputTail: 'gate ok',
        runnerId: 'runner-pilot',
        source: 'runner-observed',
      });
      expect(
        project(readJson(path.join(checksDir, 'check-P-current-runner-pass.json')), [
          'candidateId',
          'treeSha',
          'command',
          'exitCode',
          'source',
        ])
      ).toEqual({
        candidateId: 'cand-P-current',
        treeSha: SHA.treeA,
        command: PILOT_GATE_COMMAND,
        exitCode: 0,
        source: 'runner-observed',
      });

      const claimed = (await claimD()) as { hasNext: boolean };
      expect(claimed.hasNext).toBe(true);
      expect(project(readJson(taskDFile), ['status', 'assignedWorkerId'])).toEqual({
        status: 'WORKING',
        assignedWorkerId: 'worker-N',
      });

      const unblocked = await h.state.runExclusive(() => runDependencyUnblock(h.state, 'task-P'));
      expect(unblocked).toEqual(['task-E']);
      expect(project(readJson(taskEFile), ['status', 'blockedOnTaskIds', 'blockedFromStatus'])).toEqual({
        status: 'WORKING',
        blockedOnTaskIds: null,
        blockedFromStatus: null,
      });
    } finally {
      h.state.clearEmitter();
      h.cleanup();
    }
  });
});

// =============================================================================
// CRITERION 3 — reviewing candidate A cannot approve candidate B
// =============================================================================
describe('Wave 1 acceptance: reviewing candidate A cannot approve candidate B', () => {
  // UNSKIP OWNER: task-5b85773867594a8eb0cea350f2c6008f (qa_approve binds the
  // reviewed candidate, persists a Review, get_context projects currentCandidate).
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (WRONG-CANDIDATE
  // DONE): on today's code qa_approve has no notion of which bytes were
  // reviewed. QA reads candidate A, the runner then records B, and the approval
  // still drives the task to DONE — on bytes nobody reviewed.
  it('refuses an approval bound to a superseded candidate and records one against the current', async () => {
    const h = new ToolTestHarness();
    h.init();
    // Date-only fake clock so production-stamped createdAt values are exact and
    // ordered. Timers stay real: atomic writes retry renames on a real backoff.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-11T03:00:00.000Z'));
      // Legacy/default delivery policy: isolates candidate binding from the
      // strict delivery gates (those are criterion 2's subject).
      h.setupMoeFolder();
      h.createEpic();
      // The fixture begins where complete_task leaves a task: REVIEW,
      // unassigned, its generation-1 attempt still finalizing.
      h.createTask({
        id: 'task-A',
        status: 'REVIEW',
        assignedWorkerId: null,
        implementationPlan: [completedStep('step-1')],
        reviewStartedAt: '2026-09-11T02:59:00.000Z',
      });
      h.createWorker({ id: 'worker-W', status: 'IDLE', currentTaskId: null });
      h.createWorker({ id: 'qa-Q', status: 'IDLE', currentTaskId: null });
      writeRecord(
        h.moePath,
        'attempts',
        attemptRecord({
          id: 'attempt-A-1',
          taskId: 'task-A',
          workerId: 'worker-W',
          generation: 1,
          phase: 'finalizing',
          workspace: h.testDir,
        })
      );
      await h.state.load();

      const taskAFile = path.join(h.moePath, 'tasks', 'task-A.json');
      const candidatesDir = path.join(h.moePath, 'candidates');
      const reviewsDir = path.join(h.moePath, 'reviews');
      const candAFile = path.join(candidatesDir, 'cand-A.json');
      const candBFile = path.join(candidatesDir, 'cand-B.json');

      const candidateA = {
        id: 'cand-A',
        taskId: 'task-A',
        attemptId: 'attempt-A-1',
        generation: 1,
        workerId: 'worker-W',
        baseRevision: SHA.base,
        treeSha: SHA.treeA,
        deliveryTarget: PILOT_TARGET,
      };
      const candidateB = { ...candidateA, id: 'cand-B', treeSha: SHA.treeB };
      // The persisted Candidate's own fields (generation/workerId are fencing
      // inputs of the call, not part of the record).
      const candidateFields = ['id', 'attemptId', 'taskId', 'baseRevision', 'treeSha', 'deliveryTarget', 'createdAt'];
      const storedFields = (c: typeof candidateA, createdAt: string): Record<string, unknown> => ({
        id: c.id,
        attemptId: c.attemptId,
        taskId: c.taskId,
        baseRevision: c.baseRevision,
        treeSha: c.treeSha,
        deliveryTarget: c.deliveryTarget,
        createdAt,
      });

      // --- candidate A is recorded and is what QA reviews --------------------
      await callTool(h.state, 'moe.record_candidate', { ...candidateA });
      expect(project(readJson(candAFile), candidateFields)).toEqual(
        storedFields(candidateA, '2026-09-11T03:00:00.000Z')
      );

      const contextA = (await callTool(h.state, 'moe.get_context', {
        taskId: 'task-A',
        workerId: 'qa-Q',
      })) as { currentCandidate?: unknown };
      expect(contextA.currentCandidate).toEqual(readJson(candAFile));
      const reviewedCandidateId = 'cand-A';

      // --- the runner then records a different candidate B -------------------
      vi.setSystemTime(new Date('2026-09-11T03:05:00.000Z'));
      await callTool(h.state, 'moe.record_candidate', { ...candidateB });
      expect(project(readJson(candBFile), candidateFields)).toEqual(
        storedFields(candidateB, '2026-09-11T03:05:00.000Z')
      );

      const contextB = (await callTool(h.state, 'moe.get_context', {
        taskId: 'task-A',
        workerId: 'qa-Q',
      })) as { currentCandidate?: unknown };
      expect(contextB.currentCandidate).toEqual(readJson(candBFile));

      // B's landing finalizes the attempt, so the criterion-1 finalizing hold is
      // no longer the layer doing the refusing below.
      await callTool(h.state, 'moe.finalize_attempt', {
        taskId: 'task-A',
        workerId: 'worker-W',
        runnerId: 'runner-pilot',
        attemptId: 'attempt-A-1',
        generation: 1,
        outcome: 'landed',
        landedRevision: SHA.landed,
      });

      const bytesBefore = {
        task: readBytes(taskAFile),
        candA: readBytes(candAFile),
        candB: readBytes(candBFile),
      };

      // --- approving what was reviewed (A) is refused: current is B ----------
      const refusal = await captureRefusal(
        callTool(h.state, 'moe.qa_approve', {
          taskId: 'task-A',
          workerId: 'qa-Q',
          candidateId: reviewedCandidateId,
          summary: 'Reviewed candidate A against every DoD item.',
        })
      );
      expect(refusal.code).toBe(-32002);
      expect(refusal.codeName).toBe('CANDIDATE_MISMATCH');
      expect(refusal.context.expectedCandidateId).toBe('cand-A');
      expect(refusal.context.currentCandidateId).toBe('cand-B');

      expect(readBytes(taskAFile)).toBe(bytesBefore.task);
      expect(readBytes(candAFile)).toBe(bytesBefore.candA);
      expect(readBytes(candBFile)).toBe(bytesBefore.candB);
      expect(listRecords(reviewsDir)).toEqual([]);

      // --- positive control: approving the current candidate B lands DONE ----
      const approveSummary = 'Reviewed candidate B against every DoD item.';
      await callTool(h.state, 'moe.qa_approve', {
        taskId: 'task-A',
        workerId: 'qa-Q',
        candidateId: 'cand-B',
        summary: approveSummary,
      });

      expect(readJson(taskAFile).status).toBe('DONE');
      const reviews = listRecords(reviewsDir);
      expect(reviews.length).toBe(1);
      expect(project(reviews[0], ['taskId', 'candidateId', 'reviewerId', 'decision', 'summary'])).toEqual({
        taskId: 'task-A',
        candidateId: 'cand-B',
        reviewerId: 'qa-Q',
        decision: 'approve',
        summary: approveSummary,
      });
      // Candidates are immutable: A was neither rewritten nor re-pointed.
      expect(readBytes(candAFile)).toBe(bytesBefore.candA);
    } finally {
      vi.useRealTimers();
      h.state.clearEmitter();
      h.cleanup();
    }
  });
});

// =============================================================================
// CRITERION 4 — restarting only the daemon during a long build preserves ownership
// =============================================================================
describe('Wave 1 acceptance: restarting only the daemon during a long build preserves ownership', () => {
  // UNSKIP OWNER: task-58f7db9a9e44469e9351b2cdea73b47d (daemon startup moves a
  // running attempt to `reconciling` instead of purging its worker, plus the
  // runner surface moe.reattach_attempt).
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (PURGED OWNER): on
  // today's code the second daemon's startup runs purgeAllWorkers, deletes W and
  // releases task L to the pool while W's long build is still alive and about
  // to report — the next claimer starts a second execution of the same task.
  //
  // This drives the REAL startup path (src/index.ts `_run` through the installed
  // tsx CLI), never a StateManager reload. It never infers death from an old
  // lastActivityAt and never waits for a reconcile timeout: a quiet build is not
  // evidence of a dead worker.
  it(
    'holds the task for its live owner through an abrupt daemon kill and restart',
    async () => {
      const h = new ToolTestHarness();
      h.init();
      const isolationRoot = makeOwnedRoot();
      const owned: OwnedProcess[] = [];
      let build: OwnedProcess | null = null;

      await withTeardown(
        async () => {
          h.setupMoeFolder();
          h.createEpic();
          const projectDir = h.testDir;

          // --- a silent long build that outlives the daemon ------------------
          build = spawnOwned(
            'long-build',
            process.execPath,
            [
              '-e',
              [
                'const startedAt = new Date().toISOString();',
                "process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, startedAt }) + '\\n');",
                'setInterval(() => {}, 2147483647);',
              ].join('\n'),
            ],
            { cwd: isolationRoot, env: isolatedEnv(isolationRoot) }
          );
          const buildChild: OwnedProcess = build;
          const handshake = await waitFor(
            'long-build ready handshake',
            15_000,
            () => {
              if (hasExited(buildChild)) throw new Error(`long build exited early:\n${buildChild.output()}`);
              const line = buildChild.output().split('\n').find((l) => l.includes('"ready":true'));
              return line ? (JSON.parse(line) as { pid: number; startedAt: string }) : null;
            },
            () => buildChild.output()
          );
          const host = os.hostname();

          // --- persisted ownership of task L by W, attempt 1 running ---------
          h.createTask({
            id: 'task-L',
            status: 'WORKING',
            assignedWorkerId: 'worker-W',
            implementationPlan: [
              {
                stepId: 'step-1',
                description: 'Long quiet build',
                status: 'IN_PROGRESS',
                affectedFiles: ['file.ts'],
                startedAt: handshake.startedAt,
              },
            ],
          });
          // Quiet for hours: a live build emits nothing and calls no tool.
          const quietSince = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
          h.createWorker({
            id: 'worker-W',
            status: 'CODING',
            currentTaskId: 'task-L',
            lastActivityAt: quietSince,
          });
          writeRecord(
            h.moePath,
            'attempts',
            attemptRecord({
              id: 'attempt-L-1',
              taskId: 'task-L',
              workerId: 'worker-W',
              generation: 1,
              phase: 'running',
              workspace: projectDir,
              processStartedAt: handshake.startedAt,
              host,
            })
          );

          const taskLFile = path.join(h.moePath, 'tasks', 'task-L.json');
          const workerWFile = path.join(h.moePath, 'workers', 'worker-W.json');
          const attemptsDir = path.join(h.moePath, 'attempts');
          const attemptFile = path.join(attemptsDir, 'attempt-L-1.json');
          const identity = {
            taskId: 'task-L',
            workerId: 'worker-W',
            runnerId: 'runner-pilot',
            attemptId: 'attempt-L-1',
            generation: 1,
            processStartedAt: handshake.startedAt,
            host,
          };
          const attemptKeys = ['id', 'taskId', 'workerId', 'generation', 'phase'];

          // --- daemon #1 boots; the runner attaches its live attempt ---------
          const first = await startDaemonChild(projectDir, isolationRoot, null, owned);
          toolResult(await daemonTool(first.port, 'moe.reattach_attempt', { ...identity }), 'moe.reattach_attempt');
          const attached = listRecords(attemptsDir);
          expect(attached.length).toBe(1);
          expect(project(attached[0], attemptKeys)).toEqual({
            id: 'attempt-L-1',
            taskId: 'task-L',
            workerId: 'worker-W',
            generation: 1,
            phase: 'running',
          });

          // --- kill ONLY the daemon, abruptly, mid-build ---------------------
          await killDaemonAbruptly(first);
          expect(hasExited(buildChild)).toBe(false);
          expect(isPidAlive(handshake.pid)).toBe(true);

          // --- daemon #2 boots over the same fixture -------------------------
          const second = await startDaemonChild(projectDir, isolationRoot, first.info, owned);

          // The restart hold: ownership intact, attempt reconciling, no successor.
          expect(project(readJson(taskLFile), ['status', 'assignedWorkerId'])).toEqual({
            status: 'WORKING',
            assignedWorkerId: 'worker-W',
          });
          expect(readJson(workerWFile).currentTaskId).toBe('task-L');
          const held = listRecords(attemptsDir);
          expect(held.length).toBe(1);
          expect(project(held[0], attemptKeys)).toEqual({
            id: 'attempt-L-1',
            taskId: 'task-L',
            workerId: 'worker-W',
            generation: 1,
            phase: 'reconciling',
          });
          const holdBytes = {
            task: readBytes(taskLFile),
            worker: readBytes(workerWFile),
            attempt: readBytes(attemptFile),
          };
          const expectHoldUntouched = (): void => {
            expect(readBytes(taskLFile)).toBe(holdBytes.task);
            expect(readBytes(workerWFile)).toBe(holdBytes.worker);
            expect(readBytes(attemptFile)).toBe(holdBytes.attempt);
            expect(listRecords(attemptsDir).length).toBe(1);
          };

          // --- a competing coding claim is refused during the hold -----------
          const competing = toolRefusal(
            await daemonTool(second.port, 'moe.claim_next_task', {
              statuses: ['WORKING'],
              taskId: 'task-L',
              workerId: 'worker-X',
            }),
            'moe.claim_next_task'
          );
          expect(competing.code).toBe(-32002);
          expect(competing.codeName).toBe('ATTEMPT_RECONCILING');
          expect(competing.tool).toBe('moe.claim_next_task');
          expect(competing.message).toContain('attempt-L-1');
          expectHoldUntouched();

          // --- a wrong process identity cannot reattach ----------------------
          const wrongStart = new Date(Date.parse(handshake.startedAt) - 60_000).toISOString();
          const mismatch = toolRefusal(
            await daemonTool(second.port, 'moe.reattach_attempt', { ...identity, processStartedAt: wrongStart }),
            'moe.reattach_attempt'
          );
          expect(mismatch.code).toBe(-32002);
          expect(mismatch.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
          expect(mismatch.tool).toBe('moe.reattach_attempt');
          expectHoldUntouched();

          // The host is part of the identity too: same start time, other machine.
          const otherHost = toolRefusal(
            await daemonTool(second.port, 'moe.reattach_attempt', { ...identity, host: `not-${host}` }),
            'moe.reattach_attempt'
          );
          expect(otherHost.code).toBe(-32002);
          expect(otherHost.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
          expect(otherHost.tool).toBe('moe.reattach_attempt');
          expectHoldUntouched();

          // --- the matching identity reattaches: running, same generation ----
          toolResult(await daemonTool(second.port, 'moe.reattach_attempt', { ...identity }), 'moe.reattach_attempt');
          const reattached = listRecords(attemptsDir);
          expect(reattached.length).toBe(1);
          expect(project(reattached[0], attemptKeys)).toEqual({
            id: 'attempt-L-1',
            taskId: 'task-L',
            workerId: 'worker-W',
            generation: 1,
            phase: 'running',
          });
          expect(project(readJson(taskLFile), ['status', 'assignedWorkerId'])).toEqual({
            status: 'WORKING',
            assignedWorkerId: 'worker-W',
          });
          expect(readJson(workerWFile).currentTaskId).toBe('task-L');

          // The build never noticed any of it.
          expect(buildChild.child.exitCode).toBe(null);
          expect(buildChild.child.signalCode).toBe(null);
          expect(isPidAlive(handshake.pid)).toBe(true);
        },
        [
          () => stopFixtureDaemons(h.testDir, owned),
          async () => {
            if (build) await stopOwned(build);
          },
          () => h.state.clearEmitter(),
          () => removeOwnedRoot(h.testDir, 'moe-tools-test-'),
          () => removeOwnedRoot(isolationRoot),
        ]
      );
    },
    240_000
  );
});

// =============================================================================
// CRITERION 5 — a delayed generation-N call cannot alter generation N+1
// =============================================================================
describe('Wave 1 acceptance: a delayed generation-N call cannot alter generation N+1', () => {
  // UNSKIP OWNER: task-b6c48bf029bf4170a603a91c12451df7 (attempt lifecycle wired
  // into claim/release). Not the guard-only task-a135d4d63554410286a369a95e60c2a8:
  // a guard with no tool wiring cannot make this end-to-end case pass.
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (STALE RELEASE
  // LANDS): on today's code a generation-1 release_task that arrives late — after
  // the same worker already re-claimed the task as generation 2 — is accepted as
  // a fresh release by the assignee and strips the live generation-2 claim.
  //
  // Generation fencing guards DAEMON state only. Nothing here claims it stops an
  // external process from writing shared files.
  it.skip('refuses a late generation-1 release after the same worker re-claimed as generation 2', async () => {
    const h = new ToolTestHarness();
    h.init();
    try {
      h.setupMoeFolder();
      h.createEpic();
      // A pending step and no step lease, so release_task has nothing else to refuse on.
      h.createTask({
        id: 'task-G',
        status: 'WORKING',
        assignedWorkerId: null,
        implementationPlan: [
          { stepId: 'step-1', description: 'Pending fixture step', status: 'PENDING', affectedFiles: ['file.ts'] },
        ],
      });
      h.createWorker({ id: 'worker-W', status: 'IDLE', currentTaskId: null });
      await h.state.load();

      const taskFile = path.join(h.moePath, 'tasks', 'task-G.json');
      const workerFile = path.join(h.moePath, 'workers', 'worker-W.json');
      const attemptsDir = path.join(h.moePath, 'attempts');
      const claimArgs = {
        statuses: ['WORKING'],
        taskId: 'task-G',
        workerId: 'worker-W',
        runnerId: 'runner-pilot',
        workspace: h.testDir,
      };

      // --- generation 1 ---------------------------------------------------------
      const claimN = (await callTool(h.state, 'moe.claim_next_task', { ...claimArgs })) as {
        hasNext: boolean;
        attemptId: string;
        generation: number;
      };
      expect(claimN.hasNext).toBe(true);
      expect(claimN.generation).toBe(1);
      const attemptN = claimN.attemptId;

      // The deliberate, explicit handoff release — captured so it can be replayed.
      const releaseN = {
        taskId: 'task-G',
        workerId: 'worker-W',
        attemptId: attemptN,
        generation: 1,
        reason: 'Explicit handoff: runner restarting the seat on a fresh CLI.',
        handoffNote: {
          whatIsDone: 'Read the plan and the code under step-1.',
          whatRemains: 'Execute step-1.',
        },
      };
      await callTool(h.state, 'moe.release_task', { ...releaseN });

      // --- generation 2: the SAME worker claims the SAME task again -------------
      const claimN1 = (await callTool(h.state, 'moe.claim_next_task', { ...claimArgs })) as {
        hasNext: boolean;
        attemptId: string;
        generation: number;
      };
      expect(claimN1.hasNext).toBe(true);
      expect(claimN1.generation).toBe(2);
      const attemptN1 = claimN1.attemptId;
      expect(attemptN1).not.toBe(attemptN);

      const attemptNFile = path.join(attemptsDir, `${attemptN}.json`);
      const attemptN1File = path.join(attemptsDir, `${attemptN1}.json`);
      const captured = {
        task: readBytes(taskFile),
        worker: readBytes(workerFile),
        attemptN: readBytes(attemptNFile),
        attemptN1: readBytes(attemptN1File),
      };
      const handoffsBefore = (readJson(taskFile).priorHandoffs as unknown[]).length;
      expect(handoffsBefore).toBe(1);

      // --- the delayed, identical generation-1 release arrives ------------------
      const stale = await captureRefusal(callTool(h.state, 'moe.release_task', { ...releaseN }));
      expect(stale.code).toBe(-32002);
      expect(stale.codeName).toBe('ATTEMPT_SUPERSEDED');

      expect(readBytes(taskFile)).toBe(captured.task);
      expect(readBytes(workerFile)).toBe(captured.worker);
      expect(readBytes(attemptNFile)).toBe(captured.attemptN);
      expect(readBytes(attemptN1File)).toBe(captured.attemptN1);
      expect(project(readJson(taskFile), ['status', 'assignedWorkerId'])).toEqual({
        status: 'WORKING',
        assignedWorkerId: 'worker-W',
      });
      expect((readJson(taskFile).priorHandoffs as unknown[]).length).toBe(handoffsBefore);
      const attempts = listRecords(attemptsDir);
      expect(attempts.length).toBe(2);
      expect(project(readJson(attemptNFile), ['id', 'generation', 'phase'])).toEqual({
        id: attemptN,
        generation: 1,
        phase: 'closed',
      });
      expect(project(readJson(attemptN1File), ['id', 'generation', 'phase'])).toEqual({
        id: attemptN1,
        generation: 2,
        phase: 'running',
      });

      // --- positive control: the CURRENT generation still releases normally ----
      await callTool(h.state, 'moe.release_task', {
        ...releaseN,
        attemptId: attemptN1,
        generation: 2,
      });
      expect(project(readJson(attemptN1File), ['id', 'generation', 'phase'])).toEqual({
        id: attemptN1,
        generation: 2,
        phase: 'closed',
      });
      expect(project(readJson(taskFile), ['status', 'assignedWorkerId'])).toEqual({
        status: 'WORKING',
        assignedWorkerId: null,
      });
      expect(listRecords(attemptsDir).length).toBe(2);
    } finally {
      h.state.clearEmitter();
      h.cleanup();
    }
  });
});

// =============================================================================
// CRITERION 6 — a crash between an external effect and its bookkeeping does not
// repeat the effect
// =============================================================================
describe('Wave 1 acceptance: a crash between an external effect and its bookkeeping does not repeat the effect', () => {
  // UNSKIP OWNER: task-b1c9850824fe4437a8c70b4ee083602b (DeliveryReceipt store,
  // moe.record_delivery_receipt, and crash recovery in BOTH wrappers).
  //
  // OLD-BEHAVIOUR COUNTEREXAMPLE the owner must show first (REPEATED GIT
  // EFFECT): a recovery that simply re-runs delivery after a crash between the
  // ref update and the receipt lands the work a second time — a second
  // post-base movement of refs/heads/wave1-pilot — or never writes the receipt
  // for the landing that did happen.
  //
  // This executes the ACTUAL platform wrapper (scripts/moe-agent.ps1 on Windows,
  // scripts/moe-agent.sh elsewhere). The Codex and transport shims are generated
  // here at runtime; every business call reaches the production McpAdapter. The
  // crash is a whole-tree kill while the first record_delivery_receipt request
  // is held in flight; the ref move before it is the real wrapper's own.
  it.skip(
    'lands once, crashes before the receipt, and the rerun records one receipt without a second landing',
    async () => {
      const h = new ToolTestHarness();
      h.init();
      const isolationRoot = makeOwnedRoot();
      const owned: OwnedProcess[] = [];
      let transport: FixtureTransport | null = null;
      let restarted: StateManager | null = null;

      await withTeardown(
        async () => {
          const projectDir = h.testDir;
          h.setupMoeFolder({ settings: { ...STRICT_SETTINGS } as never });
          h.createEpic();
          h.createTask({
            id: PILOT_TASK,
            status: 'WORKING',
            assignedWorkerId: null,
            definitionOfDone: ['node gate.cjs exits 0 on the delivered tree'],
            implementationPlan: [
              {
                stepId: PILOT_STEP,
                description: 'Edit owned.txt so the gate passes',
                status: 'PENDING',
                affectedFiles: ['owned.txt'],
              },
            ],
          });
          const env = isolatedEnv(isolationRoot);
          const base = initPilotRepo(projectDir, env);
          await h.state.load();

          const dirs = {
            candidates: path.join(h.moePath, 'candidates'),
            checks: path.join(h.moePath, 'checks'),
            receipts: path.join(h.moePath, 'receipts'),
            attempts: path.join(h.moePath, 'attempts'),
          };
          transport = await startFixtureTransport(new McpAdapter(h.state), (args) => ({
            args,
            targetAtBarrier: git(projectDir, env, ['rev-parse', PILOT_TARGET]),
            landedTree: git(projectDir, env, ['rev-parse', `${String(args.landedRevision)}^{tree}`]),
          }));
          const fixture: FixtureTransport = transport;
          const shims = writePilotShims(path.join(isolationRoot, 'shims'), fixture.endpoint, projectDir);
          const wrapperEnv = isolatedEnv(isolationRoot, {
            MOE_PROXY_PATH: shims.transport,
            MOE_DISABLE_HEARTBEAT: '1',
          });
          const diagnostics = (p: OwnedProcess) => (): string =>
            [
              `--- ${p.label} output tail ---`,
              p.output(),
              '--- fixture RPC log (tail) ---',
              ...fixture.log.slice(-60),
              '--- codex shim argv log ---',
              fs.existsSync(shims.codexLog) ? readBytes(shims.codexLog) : '(codex shim never launched)',
            ].join('\n');

          // --- run 1: the real wrapper freezes, gates and lands -------------------
          const first = launchPilotWrapper('wrapper-run-1', projectDir, shims, wrapperEnv);
          owned.push(first);
          const exitedFirst = first.exited.then((status): never => {
            throw new Error(
              `wrapper run 1 exited (${JSON.stringify(status)}) without calling moe.record_delivery_receipt: ` +
                `the receipt barrier was never reached\n${diagnostics(first)()}`
            );
          });
          const held = await withDeadline(
            Promise.race([fixture.barrier, exitedFirst]),
            300_000,
            diagnostics(first)
          );

          // At the barrier the external effect has happened and nothing records it.
          const landed = held.targetAtBarrier;
          expect(String(held.args.landedRevision)).toBe(landed);
          expect(git(projectDir, env, ['rev-parse', `${landed}^`])).toBe(base);
          const candidateId = String(held.args.candidateId);
          const candidateFile = path.join(dirs.candidates, `${candidateId}.json`);
          expect(
            project(readJson(candidateFile), ['id', 'taskId', 'baseRevision', 'treeSha', 'deliveryTarget'])
          ).toEqual({
            id: candidateId,
            taskId: PILOT_TASK,
            baseRevision: base,
            treeSha: held.landedTree,
            deliveryTarget: PILOT_TARGET,
          });
          const checksAtBarrier = listRecords(dirs.checks).filter((c) => c.candidateId === candidateId);
          expect(
            checksAtBarrier.map((c) => project(c, ['candidateId', 'treeSha', 'command', 'exitCode', 'source']))
          ).toEqual([
            {
              candidateId,
              treeSha: held.landedTree,
              command: PILOT_GATE_COMMAND,
              exitCode: 0,
              source: 'runner-observed',
            },
          ]);
          const checkFile = path.join(dirs.checks, `${String(checksAtBarrier[0].id)}.json`);
          const boundBytes = { candidate: readBytes(candidateFile), check: readBytes(checkFile) };

          // --- the crash: whole wrapper tree, abruptly, receipt still in flight ---
          killWrapperTree(first);
          await awaitExit(first, 30_000);
          expect(listRecords(dirs.receipts)).toEqual([]);

          // --- restart the fixture daemon side from disk, stop intercepting -------
          h.state.clearEmitter();
          restarted = new StateManager({ projectPath: projectDir });
          await restarted.load();
          const restartedAdapter = new McpAdapter(restarted);
          fixture.setAdapter(restartedAdapter);
          fixture.stopIntercepting();

          // --- run 2: the SAME wrapper, worker and repository ---------------------
          const second = launchPilotWrapper('wrapper-run-2', projectDir, shims, wrapperEnv);
          owned.push(second);
          await withDeadline(second.exited, 300_000, diagnostics(second));

          // Git: exactly one post-base movement of the target, still the first one.
          expect(git(projectDir, env, ['rev-parse', PILOT_TARGET])).toBe(landed);
          expect(git(projectDir, env, ['rev-list', `${base}..${PILOT_TARGET}`]).split('\n')).toEqual([landed]);
          expect(git(projectDir, env, ['reflog', 'show', '--format=%H', PILOT_TARGET]).split('\n')).toEqual([
            landed,
            base,
          ]);

          // Bookkeeping: exactly one receipt, bound to that first landing.
          const receiptFile = onlyRecordFile(dirs.receipts);
          expect(
            project(readJson(receiptFile), [
              'candidateId',
              'target',
              'targetBefore',
              'targetAfter',
              'landedRevision',
              'pushResult',
            ])
          ).toEqual({
            candidateId,
            target: PILOT_TARGET,
            targetBefore: base,
            targetAfter: landed,
            landedRevision: landed,
            pushResult: null,
          });
          // The candidate and its required runner-observed pass still bind the same tree/base.
          expect(readBytes(candidateFile)).toBe(boundBytes.candidate);
          expect(readBytes(checkFile)).toBe(boundBytes.check);
          // The owning attempt closed; no successor generation was opened.
          expect(
            listRecords(dirs.attempts).map((a) => project(a, ['taskId', 'workerId', 'generation', 'phase']))
          ).toEqual([{ taskId: PILOT_TASK, workerId: PILOT_WORKER, generation: 1, phase: 'closed' }]);

          // Replaying the captured receipt payload changes nothing.
          const receiptBytes = readBytes(receiptFile);
          await restartedAdapter.handle({
            jsonrpc: '2.0',
            id: 'wave1-receipt-replay',
            method: 'tools/call',
            params: { name: 'moe.record_delivery_receipt', arguments: held.args },
          });
          expect(onlyRecordFile(dirs.receipts)).toBe(receiptFile);
          expect(readBytes(receiptFile)).toBe(receiptBytes);
        },
        [
          () => {
            for (const p of owned) killWrapperTree(p);
          },
          async () => {
            for (const p of owned) await awaitExit(p, 30_000);
          },
          async () => {
            if (transport) await transport.close();
          },
          () => h.state.clearEmitter(),
          () => restarted?.clearEmitter(),
          () => removeOwnedRoot(h.testDir, 'moe-tools-test-'),
          () => removeOwnedRoot(isolationRoot),
        ]
      );
    },
    720_000
  );
});

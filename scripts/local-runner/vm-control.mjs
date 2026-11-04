#!/usr/bin/env node
// Owned VM status and control, the producer contract CQ-I03 (JetBrains) and CQ-I05 (VS Code) consume.
// `vm-control.mjs <status|reconcile|cleanup> --project <absolute path>`: ONE JSON line under 64 KiB (moe-vm-*-v1),
// exit 0 for every report, VM_CONTROL_INPUT_INVALID and exit 2 on usage. Failures are fixed codes, never text.
// Ownership is R06's ledger at ownedLedgerDir() alone: no argument names, adds or adopts an instance, and an
// unrecorded provider instance is never listed or touched. Activation (R11 final, V04b) must provision through
// this ledger. executionReady and verified are always false: no isolation claim, never verified-local.
// cleanup deletes only what the daemon (loopback /mcp; Node 22+ WebSocket, else unreachable) proves closed and
// lease-free. Residual: a lease granted between list_resources and the delete is unseen; R10 pins its release.
// A seat VM (CQ-M07g) is reconciled or deleted only once the daemon proves its seat gone (moe.get_seat_liveness), its
// runner is dead on this host (signal 0) and its lease is free; status lists it apart, in seatInstances.
import { createHash } from 'node:crypto';
import { constants, mkdirSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPrerequisites, platformFor } from './cli.mjs';
import { canonicalProjectPath, loopbackDaemonHost, MAX_DAEMON_INFO_BYTES } from './guest-session.mjs';
import { cleanupOwned, createLedger, isSeatRecord, queryOwnedInstance, reconcileOwned, reconcileSeats } from './lifecycle.mjs';

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fixed = (key, value, pattern) => (typeof value === 'string' && pattern.test(value) ? { [key]: value } : {});
const controlError = (code, fallback = 'VM_CONTROL_FAILED') =>
  Object.assign(new Error('VM control refused.'), { code: typeof code === 'string' && CODE.test(code) ? code : fallback });
const unreachable = () => controlError('DAEMON_UNREACHABLE');
export { canonicalProjectPath }; // its home is guest-session.mjs, which this module imports

/** <MOE_RUNNER_STATE_DIR | ~/.moe/runner-state>/<first 32 hex of sha256(canonical project)>/vms, created 0700.
 * Mirrors runnerKeyPath (packages/moe-daemon/src/server/runnerChannel.ts); never inside the project or its .moe/. */
export function ownedLedgerDir(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '' || CONTROL.test(projectPath)) throw controlError('VM_CONTROL_INPUT_INVALID');
  const configured = process.env.MOE_RUNNER_STATE_DIR?.trim();
  const root = configured ? path.resolve(configured) : path.join(os.homedir(), '.moe', 'runner-state');
  const project = canonicalProjectPath(projectPath);
  const dir = path.join(root, createHash('sha256').update(project).digest('hex').slice(0, 32), 'vms');
  const canonical = canonicalProjectPath(dir);
  if (canonical === project || canonical.startsWith(`${project}/`)) throw controlError('VM_CONTROL_STATE_DIR_INVALID');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // every directory it creates, not only the leaf
  return dir;
}

async function providerReadiness(prerequisites) {
  try {
    const report = await prerequisites({});
    return { ready: report?.ready === true, ...fixed('code', report?.code ?? report?.providerCode, CODE), ...fixed('platform', report?.platform, /^[a-z0-9]{1,16}$/) };
  } catch { return { ready: false, code: 'PREREQUISITES_UNAVAILABLE' }; }
}

/** run()'s report under its schema; `invalid` is a count, as ledger file names are not fixed codes. Only R06's own
 * unreadable-ledger refusal becomes LEDGER_UNREADABLE: any other throw is a defect and propagates. */
async function ledgerReport(schema, run, unreadable = {}) {
  try {
    const report = await run();
    return { schema, ...report, invalid: report.invalid.length };
  } catch (error) {
    if (error?.code !== 'LEDGER_RECORD_INVALID') throw error;
    return { schema, code: 'LEDGER_UNREADABLE', ...unreadable };
  }
}

/** Ledger records only, each queried by its own name ('Unknown' on any failure); there is no provider list call. */
export const statusReport = ({ ledger, provider = {}, prerequisites = hostPrerequisites }) => ledgerReport('moe-vm-status-v1', async () => {
  const { records, invalid } = await ledger.list();
  const [instances, seatInstances] = [[], []];
  for (const record of records) {
    const { instance, phase, launchTries } = record;
    const state = await queryOwnedInstance(instance, provider).then(found => (found.present ? found.state : 'Absent'), () => 'Unknown');
    // A seat VM (CQ-M07g) goes apart: the IDE parsers need a taskId on every `instances` row and ignore unknown root keys.
    if (isSeatRecord(record)) seatInstances.push({ instance, phase, state, launchTries, ownerKind: 'seat', workerId: record.workerId });
    else instances.push({ instance, phase, state, launchTries, taskId: record.taskId });
  }
  return { provider: await providerReadiness(prerequisites), executionReady: false, verified: false, instances, seatInstances, invalid };
}, { instances: [], seatInstances: [], executionReady: false, verified: false });

/** This host's name as the wrappers spell it: win32 COMPUTERNAME lowercased (moe-agent.ps1 Get-MoeLiveMarkerHost),
 * elsewhere the hostname lowercased without whitespace (moe-agent.sh live_marker_host). */
export function localRunnerHost({ platform = process.platform, env = process.env, hostname = os.hostname } = {}) {
  return platform === 'win32' ? String(env.COMPUTERNAME ?? '').toLowerCase() : String(hostname()).toLowerCase().replace(/\s/g, '');
}

/** Whether a seat record's runner is alive: true, false, or undefined when unprovable (another host or platform, a
 * malformed runner, any other error). Signal 0 is an existence check that delivers nothing. Residual: a reused pid
 * reads alive, so its VM is preserved, never deleted. */
export function runnerProbe(record, { kill = process.kill, host = localRunnerHost(), platform = process.platform } = {}) {
  const pid = /^([1-9][0-9]{0,9})@/.exec(typeof record?.runner === 'string' ? record.runner : '')?.[1];
  if (!pid || typeof host !== 'string' || host === '' || record.host !== host || record.platform !== platform) return undefined;
  try {
    kill(Number(pid), 0);
    return true;
  } catch (error) { return error?.code === 'EPERM' ? true : error?.code === 'ESRCH' ? false : undefined; }
}

/** The seat's daemon liveness (CQ-M07g0 moe.get_seat_liveness): 'registered' (a non-DEAD worker record),
 * 'attempt-open', 'gone', or 'unknown' for a malformed reply. A failed call throws, which holds the record. */
const seatStateOf = call => async workerId => {
  const reply = await call('moe.get_seat_liveness', { workerId });
  if (!isRecord(reply) || reply.workerId !== workerId || typeof reply.registered !== 'boolean'
    || !Number.isSafeInteger(reply.openAttempts) || reply.openAttempts < 0) return 'unknown';
  if (reply.registered && reply.status !== 'DEAD') return 'registered';
  return reply.openAttempts > 0 ? 'attempt-open' : 'gone';
};

// A fresh read per decision, just before that record's delete: a cached list goes stale across slow deletes.
const leaseHeldOf = call => async resourceId => {
  try {
    const list = (await call('moe.list_resources', {}))?.resources;
    if (!list.every(entry => isRecord(entry) && typeof entry.id === 'string' && Array.isArray(entry.holders))) return true;
    return list.find(entry => entry.id === resourceId)?.holders.length > 0;
  } catch { return true; }
};

/** One listing for both: attempt records through reconcileOwned (never the daemon), seat records through
 * reconcileSeats. Each record lands in exactly one list, as the IDE parsers refuse an instance named twice. */
export const reconcileReport = ({ ledger, provider = {}, call, runnerAlive = runnerProbe }) => ledgerReport('moe-vm-reconcile-v1', async () => {
  const listed = await ledger.list();
  const once = { ...ledger, list: async () => listed };
  const owned = await reconcileOwned({ ledger: once, provider });
  const seats = await reconcileSeats({ ledger: once, provider, seatState: seatStateOf(call), runnerAlive, leaseHeld: leaseHeldOf(call) });
  return { reconciled: [...owned.reconciled, ...seats.reconciled], unknown: [...owned.unknown, ...seats.unknown], invalid: owned.invalid,
    held: seats.held, retired: seats.retired };
});

/** At most one attempt per task is open (attemptStore currentAttempt) and attempts are append-only, so an owner
 * attempt that is not the task's served open attempt is closed. A refusal, malformed reply or transport failure
 * is unknown. A resource the daemon does not list has no lease; an unreadable list counts as held. */
export const cleanupReport = ({ ledger, provider = {}, call, runnerAlive = runnerProbe }) => ledgerReport('moe-vm-cleanup-v1', async () => {
  const listed = await ledger.list();
  const owners = new Map(listed.records.filter(record => !isSeatRecord(record)).map(record => [record.attemptId, record.taskId]));
  const attemptPhase = async attemptId => {
    const taskId = owners.get(attemptId);
    const served = taskId ? (await call('moe.get_context', { taskId }))?.servedContext : undefined;
    if (!isRecord(served) || served.receiptStatus === 'identity-unreadable'
      || (served.attemptId !== null && typeof served.attemptId !== 'string')) return 'unknown';
    return served.attemptId === attemptId ? 'running' : 'closed';
  };
  return cleanupOwned({ ledger: { ...ledger, list: async () => listed }, provider, attemptPhase, leaseHeld: leaseHeldOf(call),
    seatState: seatStateOf(call), runnerAlive });
});

/** This project's own loopback daemon as {port, host}: a bounded, regular daemon.json supplies the port and can only
 * refuse; the daemon's own /health bind report (loopbackDaemonHost) admits. Anything else is DAEMON_UNREACHABLE. */
export async function readDaemonInfo(projectPath, { timeoutMs } = {}) {
  let handle;
  let info;
  try {
    // No symlink follow and no FIFO block on POSIX; both flags are 0 where unsupported.
    handle = await open(path.join(projectPath, '.moe', 'daemon.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const bytes = Buffer.alloc(MAX_DAEMON_INFO_BYTES + 1); // the extra byte detects a file past the cap
    let size = 0;
    for (let read; read !== 0 && size < bytes.length; size += read) ({ bytesRead: read } = await handle.read(bytes, size, bytes.length - size, size));
    if ((await handle.stat()).isFile() && size <= MAX_DAEMON_INFO_BYTES) info = JSON.parse(bytes.toString('utf8', 0, size));
  } catch { throw unreachable(); } finally { await handle?.close().catch(() => {}); }
  const port = info?.port;
  if (!isRecord(info) || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof info.projectPath !== 'string' || canonicalProjectPath(info.projectPath) !== canonicalProjectPath(projectPath)) throw unreachable();
  const host = await loopbackDaemonHost(info, projectPath, { timeoutMs });
  if (!host) throw unreachable();
  return { port, host };
}

/** call(tool, args) over this project's loopback /mcp: one socket per call, closed in finally. */
export function mcpCaller(projectPath, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15_000 } = {}) {
  let lastId = 0;
  return async (name, args) => {
    const { port, host } = await readDaemonInfo(projectPath);
    if (typeof WebSocketImpl !== 'function') throw unreachable();
    const [socket, id] = [new WebSocketImpl(`ws://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/mcp`), ++lastId];
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(unreachable()), timeoutMs);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })));
      socket.addEventListener('message', ({ data }) => {
        try {
          const reply = JSON.parse(data);
          if (reply?.id !== id) return;
          // Only the daemon's codeName survives: its message text never reaches a report.
          if (reply.error) reject(controlError(reply.error.data?.codeName, 'DAEMON_REFUSED'));
          else resolve(JSON.parse(reply.result.content[0].text));
        } catch { reject(unreachable()); }
      });
      socket.addEventListener('close', () => reject(unreachable()));
      socket.addEventListener('error', () => reject(unreachable()));
    }).finally(() => { clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } });
  };
}

const COMMANDS = new Set(['status', 'reconcile', 'cleanup']);
const MAX_REPORT_BYTES = 64 * 1024;

/** The CLI core: deps (ledger, provider, prerequisites, call) are injected only by tests. Returns the exit code. */
export async function runVmControl(argv, { write = text => process.stdout.write(text), provider = {}, ...deps } = {}) {
  // Exactly `<command> --project <absolute path>`: nothing is read or called before this passes.
  const [command, flag, project] = Array.isArray(argv) && argv.length === 3 ? argv : [];
  if (!COMMANDS.has(command) || flag !== '--project' || typeof project !== 'string' || !path.isAbsolute(project) || CONTROL.test(project)) {
    write('{"code":"VM_CONTROL_INPUT_INVALID"}\n');
    return 2;
  }
  let line;
  try {
    // This host's pinned client unless the caller names one, never a bare `multipass`; a host without one refuses first.
    const pinned = { ...provider, executable: provider.executable ?? platformFor(process.platform)?.executable };
    if (pinned.executable === undefined) throw controlError('VM_CONTROL_FAILED');
    const ledger = deps.ledger ?? createLedger(ownedLedgerDir(project));
    const proof = { ledger, provider: pinned, call: deps.call ?? mcpCaller(project), runnerAlive: deps.runnerAlive }; // the caller is lazy
    const report = command === 'status' ? await statusReport({ ledger, provider: pinned, prerequisites: deps.prerequisites })
      : command === 'reconcile' ? await reconcileReport(proof) : await cleanupReport(proof);
    line = JSON.stringify(report);
    if (Buffer.byteLength(line, 'utf8') >= MAX_REPORT_BYTES) line = JSON.stringify({ code: 'VM_CONTROL_REPORT_TOO_LARGE' });
  } catch { line = JSON.stringify({ code: 'VM_CONTROL_FAILED' }); } // only a fixed code: no path, stack, key or stderr
  write(`${line}\n`);
  return 0;
}

// The entry's import.meta.url is its realpath, which argv[1] may reach through a symlink (macOS's /var is /private/var).
function invokedDirectly() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}
if (invokedDirectly()) {
  runVmControl(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 2; });
}

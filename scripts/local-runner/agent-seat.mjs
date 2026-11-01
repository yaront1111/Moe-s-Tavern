#!/usr/bin/env node
// One owned VM per agent seat (CQ-M07i; mem:decision-cq-m07-verified-local-activation, decision 1), for the CQ-M07m
// (moe-agent.sh) and CQ-M07n (moe-agent.ps1) wrappers. Run directly, before the seat claims anything and when it exits:
//   agent-seat.mjs seat-start --project <abs> --worker <workerId> --runner <pid@token> --host <host>
//   agent-seat.mjs seat-stop  --project <abs> --worker <workerId> --runner <pid@token> --host <host> --instance <moe-vm-…>
// Flags in exactly this order, each value ONE argument with no control characters (the runner token may hold spaces, the
// `ps lstart` fallback). worker/runner/host are the wrapper's runner identity, the CQ-M07g seat owner. Output is ONE JSON
// line, never a path, key, credential or stderr:
//   seat-start {"ok":true,"instance":"moe-vm-…","executionReady":false}; seat-stop {"ok":true,"instance":"moe-vm-…","vm":…};
//   a refusal {"ok":false,"code":"<FIXED_CODE>","vm":…}; usage {"code":"SEAT_INPUT_INVALID"}; a defect {"ok":false,"code":"SEAT_FAILED"}.
// vm: 'deleted' (verified absent, record marked deleted), 'retired' (reserved, never launched: record removed), 'gone' (stop:
// no record), 'none' (nothing of ours: no reservation, another owner's, or a foreign collision), 'delete-failed' (the record is
// KEPT for vm-control reconcile and cleanup; never retried in a loop, never forced).
// Exit codes: 0 ok; 75 (EX_TEMPFAIL) SEAT_CAPACITY_FULL or SEAT_CAPACITY_LOCK_BUSY: wait and retry BEFORE claiming, never a host
// fallback; 1 any other refusal or failure; 2 usage.
// seat-start first reclaims this seat's own VM left by an interrupted seat-start, and a previous incarnation's (same workerId, a
// runner runnerProbe proves dead on this host and platform); then the CQ-M07h cap pre-check refuses before any reserve or provider
// call; then provisionGuest, whose one reserve is CQ-M07h's locked admission, with R07 readiness; then the pinned toolchain and
// agent CLIs. Any failure after the reserve removes exactly that VM through deleteOwned, or retires a never-launched reservation.
// seat-stop deletes only the named instance of this owner, idempotently. executionReady is always false: no isolation claim.
// Residual: two concurrent seat-starts of one owner can each miss the other's in-flight reservation; a wrapper runs one at a time.
// seatForward (CQ-M07j1) is the guest bridge's forward over this project's daemon /mcp, the moe-proxy path, never /runner: a /runner
// call carries the authenticated runner identity (McpAdapter options.runner), which record_check_dispatch trusts as runner-attested
// evidence, and a guest's calls must never carry it. The bridge's TOOLS allowlist and STAMPED identity already scope every guest
// request, and runAgentJob's acquire/release_resource go through the same forward, so the job lease stays task-keyed. It needs
// Node 22+'s global WebSocket (no headers, no Origin); without one every call refuses. Every refusal is SEAT_FORWARD_FAILED.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { platformFor } from './cli.mjs';
import { IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { createLedger, deleteOwned, isOwnedInstanceName, isSeatRecord, validSeatOwner } from './lifecycle.mjs';
import { provisionGuest } from './provision.mjs';
import { admitSeatVm, countSeatVms, hostAgentVmCap, seatAdmissionFor } from './seat-capacity.mjs';
import { installAgents, installToolchain } from './snapshot-transfer.mjs';
import { fetchNodeToolchain } from './toolchain-cache.mjs';
import { ownedLedgerDir, readDaemonInfo, runnerProbe } from './vm-control.mjs';

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const SWEPT = new Set(['reserved', 'launching', 'owned', 'absent', 'failed']);
const WAIT = new Set(['SEAT_CAPACITY_FULL', 'SEAT_CAPACITY_LOCK_BUSY']);
const SUPERVISOR = new URL('./guest-supervisor.py', import.meta.url);
const DEFAULTS = Object.freeze({ provision: provisionGuest, toolchain: fetchNodeToolchain, installToolchain, installAgents, remove: deleteOwned,
  count: countSeatVms, cap: hostAgentVmCap, admit: admitSeatVm, probe: runnerProbe, supervisor: () => readFile(SUPERVISOR) });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const seatError = code => Object.assign(new Error(`Seat VM refused: ${code}.`), { code });
// Only a fixed code survives (native-smoke's stableCode): never message text, a path or a key.
const codeOf = (error, fallback) => (typeof error?.code === 'string' && CODE.test(error.code) ? error.code : fallback);
const failed = (code, vm = 'none') => Object.freeze({ ok: false, code, vm });
const ownerOf = ({ workerId, runner, host }) => Object.freeze({ workerId, runner, host });

/** Exactly `keys`: an absolute project without control characters, a CQ-M07g seat owner and, for a stop, an owned name. */
function parse(input, keys) {
  if (!isRecord(input) || Object.keys(input).sort().join() !== [...keys].sort().join()) return null;
  const { project, owner, instance } = input;
  if (typeof project !== 'string' || !path.isAbsolute(project) || CONTROL.test(project) || !validSeatOwner(owner)) return null;
  if (keys.includes('instance') && !isOwnedInstanceName(instance)) return null;
  return { project, owner: ownerOf(owner), instance };
}

/** The steps (tests inject them) and this host's pinned client: never a bare `multipass`; steps.provider adds test seams only. */
function kit(steps) {
  const s = { ...DEFAULTS, platform: platformFor(process.platform), ...steps };
  if (!isRecord(s.platform)) throw seatError('SEAT_UNSUPPORTED_HOST');
  return { ...s, provider: Object.freeze({ ...s.provider, executable: s.platform.executable }) };
}

/** Removes one record's VM by its exact name for `owner`: 'deleted', 'retired' (reserved, never launched, so it stops counting
 * toward the cap) or 'none' (a collision stays foreign). Any failure throws and keeps the record. */
async function removeVm(ledger, name, owner, { remove, provider }) {
  const gone = await remove({ ledger, name, owner, provider });
  if (gone === 'deleted') return 'deleted';
  if (gone !== 'not-launched') throw seatError('SEAT_STOP_FAILED');
  const fresh = await ledger.read(name);
  if (fresh.phase !== 'reserved') return 'none';
  await ledger.retire(fresh);
  return 'retired';
}

/** This seat's earlier VMs: its exact owner's (an interrupted seat-start) and a previous incarnation's (same workerId, another
 * runner proven dead). Every other record is never touched. One that stays refuses: never a second VM beside a live one. */
async function sweep(o, ledger, s) {
  const { records } = await ledger.list();
  for (const record of records) {
    if (!isSeatRecord(record) || !SWEPT.has(record.phase) || record.workerId !== o.owner.workerId) continue;
    const mine = record.runner === o.owner.runner && record.host === o.owner.host;
    if (!mine && (record.runner === o.owner.runner || s.probe(record) !== false)) continue;
    try { await removeVm(ledger, record.instance, ownerOf(record), s); } catch { throw seatError('SEAT_PREVIOUS_VM_UNREMOVED'); }
  }
}

// run.stage is the fixed code of the step in progress; run.record is set only by this run's own admitted reserve.
async function provisionSeat(o, run, steps) {
  const s = run.s = kit(steps);
  const { root, ledger } = seatAdmissionFor(o.project);
  run.ledger = ledger;
  const cacheDir = path.join(path.dirname(ownedLedgerDir(o.project)), 'images'); // check-dispatch landedRunCheck's convention
  await sweep(o, ledger, s);
  run.stage = 'SEAT_CAPACITY_UNKNOWN';
  const limit = s.cap();
  if ((await s.count(root)).count >= limit) throw seatError('SEAT_CAPACITY_FULL'); // before any reserve or provider call
  run.stage = 'SEAT_SUPERVISOR_UNAVAILABLE';
  const supervisor = await s.supervisor();
  run.stage = 'SEAT_PROVISION_FAILED';
  // provisionGuest reserves once, after its prerequisites: the cap is re-checked there under the host lock with the write.
  const admitted = { ...ledger, reserve: async who => (run.record = await s.admit({ root, ledger, owner: who, cap: limit })) };
  const guest = await s.provision({ platform: s.platform, ledger: admitted, owner: o.owner, cacheDir, supervisor,
    credential: randomBytes(32), provider: s.provider });
  if (guest?.provisioned !== true) throw seatError('SEAT_PROVISION_UNAVAILABLE');
  const name = run.record?.instance;
  if (name === undefined || guest.instance !== name) throw seatError('SEAT_PROVISION_FAILED');
  // R07 readiness ran every boundary probe inside provisionGuest.
  if (guest.bootstrapReady !== true || !Array.isArray(guest.failures) || guest.failures.length !== 0) throw seatError('SEAT_GUEST_NOT_READY');
  run.stage = 'SEAT_TOOLCHAIN_FAILED';
  const arch = guest.image?.source?.arch; // the guest's verified image arch, never the host's
  if (!IMAGE_ARCHES.includes(arch)) throw seatError(run.stage);
  const toolchain = await s.toolchain({ arch, cacheDir });
  await s.installToolchain({ name, toolchain, provider: s.provider });
  run.stage = 'SEAT_AGENTS_FAILED';
  await s.installAgents({ name, arch, cacheDir, provider: s.provider });
  return Object.freeze({ ok: true, instance: name, executionReady: false });
}

/** Provisions this seat's one owned VM: input is exactly { project, owner }. Resolves the frozen result (header). */
export async function startSeat(input, steps = {}) {
  const o = parse(input, ['project', 'owner']);
  if (!o) return failed('SEAT_INPUT_INVALID');
  const run = { stage: 'SEAT_FAILED', record: null, ledger: null, s: null };
  try {
    return await provisionSeat(o, run, steps);
  } catch (error) { // the cleanup first, so nothing can skip it; the code is the original failure's, never the cleanup's
    const vm = run.record === null ? 'none' : await removeVm(run.ledger, run.record.instance, o.owner, run.s).catch(() => 'delete-failed');
    return failed(codeOf(error, run.stage), vm);
  }
}

/** Deletes this owner's named seat VM: input is exactly { project, owner, instance }. It never lists or touches another record. */
export async function stopSeat(input, steps = {}) {
  const o = parse(input, ['project', 'owner', 'instance']);
  if (!o) return failed('SEAT_INPUT_INVALID');
  try {
    const s = kit(steps);
    const dir = ownedLedgerDir(o.project);
    // No record: never reserved here, or already retired. Idempotent, with no provider call.
    const present = await lstat(path.join(dir, `${o.instance}.json`)).then(() => true, error => { if (error?.code === 'ENOENT') return false; throw error; });
    return Object.freeze({ ok: true, instance: o.instance, vm: present ? await removeVm(createLedger(dir), o.instance, o.owner, s) : 'gone' });
  } catch (error) {
    return error?.code === 'LIFECYCLE_NOT_OWNER' ? failed('LIFECYCLE_NOT_OWNER') : failed('SEAT_STOP_FAILED', 'delete-failed');
  }
}

// One fixed message and code for every refusal: never the daemon's text or codeName, a path, the args or a key.
const forwardFailed = () => Object.assign(new Error('Seat forward failed.'), { code: 'SEAT_FORWARD_FAILED' });

/** forward(tool, args, { signal }) for runAgentJob and the guest bridge: ONE socket and ONE tools/call per call to this project's
 * proven loopback daemon, resolving the daemon's RAW result object ({ content: [...] }), never the parsed inner text. The socket,
 * the timer and the abort listener are released on every path; every listener body is total (a throwing one is an uncaught exception). */
export function seatForward(projectPath, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 30_000 } = {}) {
  let lastId = 0;
  return async (tool, args, options) => {
    const id = ++lastId; // a local, taken before any await: concurrent calls each match only their own reply
    let [signal, socket, timer, onAbort] = [];
    try {
      signal = options?.signal; // inside the try: a throwing getter is one more refusal, never a raw error
      if ((signal !== undefined && !(signal instanceof AbortSignal)) || signal?.aborted || typeof WebSocketImpl !== 'function') throw forwardFailed();
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }); // refuses before any read or socket
      const { port, host } = await readDaemonInfo(projectPath); // fresh per call: the daemon may restart on a new port
      if (signal?.aborted) throw forwardFailed(); // aborted during the /health probe; nothing is opened
      return await new Promise((resolve, reject) => { // from here to the listener registration everything is synchronous
        timer = setTimeout(() => reject(forwardFailed()), timeoutMs);
        onAbort = () => reject(forwardFailed());
        signal?.addEventListener('abort', onAbort, { once: true });
        socket = new WebSocketImpl(`ws://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/mcp`); // the URL alone: no protocols, options or headers
        socket.addEventListener('open', () => { try { socket.send(frame); } catch { reject(forwardFailed()); } });
        socket.addEventListener('message', event => {
          try {
            const reply = JSON.parse(event?.data);
            if (!isRecord(reply) || reply.id !== id) return; // another call's (or no) reply: ignored
            if (Object.hasOwn(reply, 'error') || !isRecord(reply.result)) reject(forwardFailed());
            else resolve(reply.result);
          } catch { reject(forwardFailed()); }
        });
        socket.addEventListener('close', () => reject(forwardFailed()));
        socket.addEventListener('error', () => reject(forwardFailed()));
      });
    } catch { throw forwardFailed(); } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      try { socket?.close(); } catch { /* already closed */ }
    }
  };
}

const FLAGS = Object.freeze({ 'seat-start': ['--project', '--worker', '--runner', '--host'],
  'seat-stop': ['--project', '--worker', '--runner', '--host', '--instance'] });

/** Exactly `<command>` and its flags in FLAGS order, each with one value; nothing is read or run before this passes. */
function inputFor(argv) {
  const flags = Array.isArray(argv) && Object.hasOwn(FLAGS, argv[0]) ? FLAGS[argv[0]] : null;
  if (!flags || argv.length !== 1 + 2 * flags.length || flags.some((flag, at) => argv[1 + 2 * at] !== flag)) return null;
  const [project, workerId, runner, host, instance] = flags.map((_, at) => argv[2 + 2 * at]);
  const input = { project, owner: { workerId, runner, host }, ...(argv[0] === 'seat-stop' ? { instance } : {}) };
  return parse(input, Object.keys(input)) ? input : null;
}

/** The CLI core: write and the steps are injected only by tests. Returns the exit code (header). */
export async function runAgentSeat(argv, { write = text => process.stdout.write(text), ...steps } = {}) {
  const input = inputFor(argv);
  if (!input) {
    write('{"code":"SEAT_INPUT_INVALID"}\n');
    return 2;
  }
  let result;
  try {
    result = await (argv[0] === 'seat-start' ? startSeat : stopSeat)(input, steps);
  } catch { result = Object.freeze({ ok: false, code: 'SEAT_FAILED' }); } // no path, stack or stderr
  write(`${JSON.stringify(result)}\n`);
  return result.ok === true ? 0 : WAIT.has(result.code) ? 75 : 1;
}

// The entry's import.meta.url is its realpath, which argv[1] may reach through a symlink (macOS's /var is /private/var).
function invokedDirectly() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}
if (invokedDirectly()) runAgentSeat(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });

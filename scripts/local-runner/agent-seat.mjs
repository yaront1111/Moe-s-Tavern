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
// runSeatJob (CQ-M07j) runs ONE worker or QA job on the seat's VM: endAgentJobs' verified sweep, resetWorkspace (CQ-M07f), an
// exportSourceSnapshot of `commit` whose overlay is replaced by an empty one (a shared checkout's dirty bytes are peers'),
// materializeSnapshot, runAgentJob over seatForward, importCandidate, then admitCandidate for a worker; a QA candidate must be empty.
// A failure is one fixed code (a stage's own fixed code passes through) and no later stage runs; stopSeat runs only on unverified
// VM state (sweep, reset, or job termination), else the VM is kept. It never writes the checkout: admission writes git objects only,
// and CQ-M07m/n land the returned tree on `commit` through the wrapper's candidate path (CQ-V07/V08). The agent CLI never runs here.
// The export still reads the checkout's dirty files before dropping them: one it refuses (a symlink, past the size cap) fails the job.
//   agent-seat.mjs seat-job <seat-stop's flags> --role worker|qa --task <taskId> --attempt <attemptId> --generation <n>
//     --checkout <abs> --commit <full id> --cli claude|codex
// A worker passes its checkout's HEAD at job start; QA passes the task's last landed completion commit, so it reviews what landed.
// The credential comes ONLY on stdin, read to EOF (the wrapper closes it): one JSON {"name","value"} of at most 16 KiB; never a flag or env. The job CLI's stdout and
// stderr are relayed as bytes, then ONE line {"seatJob":1,...result} ends stdout, after a '\n' when the relayed bytes lack one.
// Exit 0 ok, 1 failure, 2 usage (SEAT_JOB_INPUT_INVALID). Two guest sessions on one instance never interleave (runAgentJob's
// AGENT_BUSY, and the per-VM job lease refuses another task's job); the sweep, reset and materialize before it are serialized only
// by the wrapper running one seat-job per seat at a time, as for seat-start.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitCandidate } from './admission.mjs';
import { runAgentJob } from './agent-lifecycle.mjs';
import { platformFor } from './cli.mjs';
import { IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { jobFrame, scopeRequest } from './guest-bridge.mjs';
import { endAgentJobs } from './guest-session.mjs';
import { createLedger, deleteOwned, isOwnedInstanceName, isSeatRecord, validSeatOwner } from './lifecycle.mjs';
import { provisionGuest } from './provision.mjs';
import { admitSeatVm, countSeatVms, hostAgentVmCap, seatAdmissionFor } from './seat-capacity.mjs';
import { importCandidate } from './snapshot-import.mjs';
import { installAgents, installToolchain, materializeSnapshot, resetWorkspace } from './snapshot-transfer.mjs';
import { exportGit, exportSourceSnapshot } from './source-export.mjs';
import { validateImport } from './source-snapshot.mjs';
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

const JOB_KEYS = ['project', 'owner', 'instance', 'binding', 'checkout', 'commit', 'cli', 'credential', 'onOutput'];
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const JOB_STEPS = Object.freeze({ sweep: endAgentJobs, reset: resetWorkspace, exportSnapshot: exportSourceSnapshot, materialize: materializeSnapshot,
  job: runAgentJob, importCandidate, admit: admitCandidate, stop: stopSeat });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value);
const safeCode = (error, fallback) => { try { return codeOf(error, fallback); } catch { return fallback; } };

/** Every field is checked, and the binding and credential copied once, before any step runs; null refuses. */
function parseJob(input) {
  try {
    const keys = isRecord(input) ? Object.keys(input) : [];
    if (!JOB_KEYS.every(key => keys.includes(key)) || !keys.every(key => [...JOB_KEYS, 'signal', 'timeoutMs'].includes(key))) return null;
    const { project, owner, instance, binding, checkout, commit, cli, credential, onOutput, signal, timeoutMs } = input;
    const frozen = Object.freeze({ ...binding });
    scopeRequest({ kind: 'request', id: 1, tool: 'moe.get_context', args: {} }, frozen); // validates the binding only
    const { name, value } = isRecord(credential) && Object.keys(credential).sort().join() === 'name,value' ? credential : {};
    const job = Object.freeze({ cli, credential: Object.freeze({ name, value }) }); // the one copy, for the job step alone
    jobFrame({ cli, role: frozen.role, credential: job.credential }); // a known cli and a credential name that cli takes
    if (absolute(project) && absolute(checkout) && validSeatOwner(owner) && isOwnedInstanceName(instance) && typeof commit === 'string'
      && FULL_ID.test(commit) && typeof onOutput === 'function' && (signal === undefined || signal instanceof AbortSignal)
      && (timeoutMs === undefined || (Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000))) {
      return { project, owner: ownerOf(owner), instance, binding: frozen, checkout, commit, job, onOutput, signal, timeoutMs };
    }
  } catch { /* refused below */ }
  return null;
}

// run.stage is the fixed code of the stage in progress; run.unverified marks VM state no sweep or reset has proven.
async function seatJob(o, run, steps) {
  const s = run.s = kit({ ...JOB_STEPS, ...steps });
  const [name, provider] = [o.instance, s.provider];
  run.stage = 'SEAT_JOB_SWEEP_UNVERIFIED';
  run.unverified = true;
  if ((await s.sweep(name, provider))?.verified !== true) throw seatError(run.stage);
  run.stage = 'SEAT_JOB_RESET_FAILED';
  await s.reset({ name, provider });
  run.unverified = false;
  run.stage = 'SEAT_JOB_EXPORT_FAILED';
  const git = await exportGit(o.checkout); // resolved once, for the export and the admission
  // The commit's tree alone: a shared checkout's dirty bytes are peers' or pre-existing, never this VM job's.
  const snapshot = Object.freeze({ ...(await s.exportSnapshot({ repoDir: o.checkout, commit: o.commit, git })), overlay: validateImport([]) });
  run.stage = 'SEAT_JOB_MATERIALIZE_FAILED';
  await s.materialize({ name, snapshot, provider });
  run.stage = 'SEAT_JOB_SESSION_FAILED';
  const job = await s.job({ name, binding: o.binding, job: o.job, daemonInfoPath: path.join(o.project, '.moe', 'daemon.json'),
    forward: s.forward ?? seatForward(o.project), onOutput: o.onOutput, onObservation: () => {}, signal: o.signal, provider, timeoutMs: o.timeoutMs });
  if (job?.failure !== null || job.terminationVerified !== true) { // the job's exit code is data, never a failure
    run.unverified = job?.terminationVerified !== true;
    throw seatError(job?.failure);
  }
  run.stage = 'SEAT_JOB_IMPORT_FAILED';
  const { candidate } = await s.importCandidate({ name, provider });
  if (!Array.isArray(candidate?.entries)) throw seatError(run.stage);
  const qa = o.binding.role === 'qa';
  if (qa && candidate.entries.length > 0) throw seatError('SEAT_JOB_QA_CANDIDATE_REFUSED'); // nothing is admitted or applied
  run.stage = 'SEAT_JOB_ADMISSION_FAILED';
  // Git objects only, through admitCandidate's private index: never the checkout's worktree or index.
  const { tree, digest } = qa ? { tree: snapshot.tree, digest: candidate.digest }
    : await s.admit({ repoDir: o.checkout, git, baseTree: snapshot.tree, candidate });
  const { code: exitCode = null, signal = null } = job.observation ?? {};
  return Object.freeze({ ok: true, role: o.binding.role, commit: o.commit, baseTree: snapshot.tree, tree, digest,
    paths: Object.freeze(candidate.entries.map(entry => Object.freeze({ kind: entry.kind, path: entry.path }))),
    exitCode, signal, lease: job.lease, executionReady: false });
}

/** One worker or QA job on this seat's VM. input is exactly { project, owner, instance, binding, checkout, commit, cli, credential,
 * onOutput } plus an optional signal and timeoutMs. Never writes the checkout; resolves the frozen result (header). */
export async function runSeatJob(input, steps = {}) {
  const o = parseJob(input);
  if (!o) return failed('SEAT_JOB_INPUT_INVALID', 'kept');
  const run = { stage: 'SEAT_JOB_FAILED', unverified: false, s: null };
  try {
    return await seatJob(o, run, steps);
  } catch (error) { // the stop first, then the code: a hostile error cannot skip it
    const vm = !run.unverified ? 'kept' : await Promise.resolve()
      .then(() => run.s.stop({ project: o.project, owner: o.owner, instance: o.instance }, { provider: run.s.provider }))
      .then(result => (result?.ok === true ? 'stopped' : 'stop-failed'), () => 'stop-failed');
    return failed(safeCode(error, run.stage), vm);
  }
}

const FLAGS = Object.freeze({ 'seat-start': ['--project', '--worker', '--runner', '--host'],
  'seat-stop': ['--project', '--worker', '--runner', '--host', '--instance'],
  'seat-job': ['--project', '--worker', '--runner', '--host', '--instance', '--role', '--task', '--attempt', '--generation', '--checkout', '--commit', '--cli'] });
const MAX_CREDENTIAL_BYTES = 16_384;

/** Exactly `<command>` and its flags in FLAGS order, each with one value; nothing is read or run before this passes. */
function inputFor(argv) {
  const flags = Array.isArray(argv) && Object.hasOwn(FLAGS, argv[0]) ? FLAGS[argv[0]] : null;
  if (!flags || argv.length !== 1 + 2 * flags.length || flags.some((flag, at) => argv[1 + 2 * at] !== flag)) return null;
  const [project, workerId, runner, host, instance, role, taskId, attemptId, generation, checkout, commit, cli] = flags.map((_, at) => argv[2 + 2 * at]);
  const owner = { workerId, runner, host };
  if (argv[0] === 'seat-job') { // runSeatJob checks every other field before any step
    const binding = { role, workerId, taskId, attemptId, generation: Number(generation) };
    return /^[1-9][0-9]{0,15}$/.test(generation) ? { project, owner, instance, binding, checkout, commit, cli } : null;
  }
  const input = { project, owner, ...(argv[0] === 'seat-stop' ? { instance } : {}) };
  return parse(input, Object.keys(input)) ? input : null;
}

/** stdin to EOF as JSON, at most MAX_CREDENTIAL_BYTES; null when larger. runSeatJob checks the {name, value} shape. */
async function readCredential(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_CREDENTIAL_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** seat-job: the job CLI's bytes relayed as they come, then ONE marked outcome line last on stdout (header). */
async function seatJobCli(argv, { write, writeError, stdin }, steps) {
  const fields = inputFor(argv);
  let newline = true; // whether relayed stdout so far ends in '\n' (or nothing was relayed)
  const onOutput = (stream, chunk) => {
    if (stream !== 'stdout') return writeError(chunk);
    if (chunk.length > 0) newline = chunk[chunk.length - 1] === 0x0a;
    return write(chunk);
  };
  const credential = fields ? await readCredential(stdin).catch(() => null) : null;
  const result = credential ? await runSeatJob({ ...fields, credential, onOutput }, steps).catch(() => failed('SEAT_JOB_FAILED', 'kept'))
    : failed('SEAT_JOB_INPUT_INVALID', 'kept');
  write(`${newline ? '' : '\n'}${JSON.stringify({ seatJob: 1, ...result })}\n`);
  return result.ok === true ? 0 : result.code === 'SEAT_JOB_INPUT_INVALID' ? 2 : 1;
}

/** The CLI core: write, writeError, stdin and the steps are injected only by tests. Returns the exit code (header). */
export async function runAgentSeat(argv, { write = text => process.stdout.write(text), writeError = text => process.stderr.write(text),
  stdin = process.stdin, ...steps } = {}) {
  if (Array.isArray(argv) && argv[0] === 'seat-job') return seatJobCli(argv, { write, writeError, stdin }, steps);
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

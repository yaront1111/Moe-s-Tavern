// Copy-only transfer of one SourceSnapshot (CQ-R09b's {version: 1, base, overlay} shape) into an owned guest over the
// protected supervisor's stdin (CQ-R09c). Every guest byte is untrusted. `multipass exec --no-map-working-directory`
// maps no host directory (the exec.cpp note in guest-readiness.mjs), so the only host bytes that reach the guest are
// the frames written here, and no mount or transfer subcommand is ever run. Mounts are checked before and after.
// This is local transfer logic, not isolation certification: executionReady is false and verified-local stays
// unavailable. installAgents (CQ-R10d3) streams the cache-verified agent CLIs the same way, into the 'agents' mode.
// installToolchain (CQ-R11e2) copies the pinned check toolchain the same way, still copy-only and mount-checked.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AGENT_CLIS, fetchAgentBinary } from './agent-cache.mjs';
import { GUEST_LAYOUT } from './guest-bootstrap.mjs';
import { createFrameDecoder, encodeFrame, MAX_GUEST_FRAME_BYTES } from './guest-bridge.mjs';
import { mountFailure, readGuestInfo, runGuestProbe } from './guest-readiness.mjs';
import { isOwnedInstanceName } from './lifecycle.mjs';
import { validateImport } from './source-snapshot.mjs';

// Raw bytes per data frame: base64 makes 1,398,104 characters, inside MAX_HOST_FRAME_BYTES with its JSON envelope.
export const SNAPSHOT_CHUNK_BYTES = 1_048_576;
export const MAX_TOOLCHAIN_BYTES = 134_217_728;
const MODES = ['materialize', 'export', 'verify', 'agents', 'toolchain', 'dependencies'];
const MAX_TIMEOUT_MS = 600_000;
const CONTROL = /[\x00-\x1f\x7f]/;
// Fixed text only: a message never carries a path, guest text or snapshot byte.
const MESSAGES = {
  TRANSFER_INPUT_INVALID: 'Snapshot transfer input was invalid.',
  TRANSFER_MOUNTS_PRESENT: 'The guest has a host mount or host-sharing filesystem.',
  TRANSFER_MOUNTS_UNKNOWN: 'The guest mounts could not be established.',
  TRANSFER_SPAWN_FAILED: 'The guest supervisor could not be started.',
  TRANSFER_TIMEOUT: 'The guest supervisor did not finish in time.',
  TRANSFER_EXIT_FAILED: 'The guest supervisor exited unsuccessfully.',
  TRANSFER_FRAME_INVALID: 'The guest supervisor sent a malformed or unexpected frame.',
  TRANSFER_DIGEST_MISMATCH: 'The guest materialized a different snapshot digest.',
  TRANSFER_TOOLCHAIN_MISMATCH: 'The cached toolchain no longer matches its pin.',
};
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function transferError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'TRANSFER_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

// The merged workspace view: base files, replaced or added by overlay files, minus overlay deletes, re-sealed by
// validateImport. Its digest is the materialization identity, and a collision the merge creates keeps R09a's code.
export function workspaceEntries(snapshot) {
  const sealed = part => isRecord(part) && Array.isArray(part.entries);
  if (!isRecord(snapshot) || snapshot.version !== 1 || !sealed(snapshot.base) || !sealed(snapshot.overlay)) {
    throw transferError('TRANSFER_INPUT_INVALID');
  }
  const merged = new Map();
  try {
    for (const entry of snapshot.base.entries) {
      if (entry.kind !== 'file') throw new TypeError('a base holds files only');
      merged.set(entry.path, entry);
    }
    for (const entry of snapshot.overlay.entries) {
      if (entry.kind === 'delete') merged.delete(entry.path);
      else merged.set(entry.path, entry);
    }
  } catch { throw transferError('TRANSFER_INPUT_INVALID'); }
  return validateImport([...merged.values()].map(({ path, executable, data }) => ({ kind: 'file', path, executable, data })));
}

// The one Multipass argv per direction, mirroring bridgeArgv: every element but the validated owned name is constant.
export function snapshotArgv(name, mode) {
  if (!isOwnedInstanceName(name) || !MODES.includes(mode)) throw transferError('TRANSFER_INPUT_INVALID');
  return Object.freeze(['exec', '--no-map-working-directory', name, '--', 'sudo', '-n', GUEST_LAYOUT.supervisor, mode]);
}

// Zero Multipass mounts and no host-sharing filesystem in mountinfo, by R07's rule. Provider and lifecycle failures
// propagate with their own fixed codes.
export async function assertNoMounts(name, provider = {}) {
  const info = await readGuestInfo(name, provider);
  const failure = mountFailure(await runGuestProbe(name, 'mountinfo', provider), { info });
  if (failure) throw transferError(`TRANSFER_${failure}`);
}

// Host frames for a workspaceEntries manifest: the header, then per entry in manifest order its file frame and
// ceil(size / SNAPSHOT_CHUNK_BYTES) base64 data frames, then end. Each frame is encoded only when it is pulled.
export function* hostFrames({ entries, digest }) {
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  yield encodeFrame({ kind: 'snapshot', version: 1, files: entries.length, bytes, digest });
  for (const { path, executable, size, data } of entries) {
    yield encodeFrame({ kind: 'file', path, executable, size });
    const view = Buffer.from(data.buffer, data.byteOffset, size);
    for (let at = 0; at < size; at += SNAPSHOT_CHUNK_BYTES) {
      yield encodeFrame({ kind: 'data', data: view.subarray(at, at + SNAPSHOT_CHUNK_BYTES).toString('base64') });
    }
  }
  yield encodeFrame({ kind: 'end' });
}

// Every input is checked before any provider call or spawn.
function streamOptions({ name, mode, provider = {}, timeoutMs = 120_000, input = [], onFrame }) {
  const argv = snapshotArgv(name, mode);
  const { executable = 'multipass', spawn = spawnProcess } = isRecord(provider) ? provider : { spawn: null };
  if (typeof executable !== 'string' || executable.trim() === '' || CONTROL.test(executable) || typeof spawn !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || typeof input !== 'object' || input === null || (typeof input[Symbol.asyncIterator] !== 'function' && typeof input[Symbol.iterator] !== 'function')
    || typeof onFrame !== 'function') {
    throw transferError('TRANSFER_INPUT_INVALID');
  }
  return { argv, executable, spawn, timeoutMs, input, onFrame };
}

/**
 * One supervisor session in `mode`: writes the input frame Buffers to its stdin in order with backpressure, then ends
 * it, and passes each decoded guest frame to the synchronous onFrame. Resolves only after all input was written, a
 * clean stdout EOF and provider exit 0 within timeoutMs. Any other outcome kills the provider and rejects with a fixed
 * TRANSFER_* code; an error thrown by onFrame is rejected unchanged. provider: {executable = 'multipass', spawn}.
 */
export async function runSupervisorStream(options) {
  return supervise(streamOptions(isRecord(options) ? options : {}));
}

function supervise({ argv, executable, spawn, timeoutMs, input, onFrame }) {
  let child;
  try { child = spawn(executable, argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { child = null; }
  if (typeof child?.kill !== 'function' || ![child, child.stdin, child.stdout, child.stderr].every(item => typeof item?.on === 'function')) {
    throw transferError('TRANSFER_SPAWN_FAILED');
  }
  return new Promise((resolve, reject) => {
    const state = { settled: false, ended: false, fed: false };
    const decoder = createFrameDecoder(MAX_GUEST_FRAME_BYTES);
    // Settles once. Late events find `settled` set; the no-op error listeners stay to absorb a late EPIPE.
    const finish = error => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      if (!error) return resolve();
      child.stdin.destroy();
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => finish(transferError('TRANSFER_TIMEOUT')), timeoutMs);
    child.on('error', () => finish(transferError('TRANSFER_SPAWN_FAILED')));
    child.on('close', code => {
      if (code !== 0 || !state.fed) finish(transferError('TRANSFER_EXIT_FAILED'));
      else finish(state.ended ? null : transferError('TRANSFER_FRAME_INVALID'));
    });
    child.stdin.on('error', () => {}); // a gone guest: its exit decides the outcome
    child.stdout.on('error', () => finish(transferError('TRANSFER_EXIT_FAILED')));
    child.stdout.on('data', chunk => {
      if (state.settled) return;
      let frames;
      try { frames = decoder.push(chunk); } catch { return finish(transferError('TRANSFER_FRAME_INVALID')); }
      for (const frame of frames) {
        try { onFrame(frame); } catch (error) { return finish(error); }
      }
    });
    child.stdout.on('end', () => {
      try { decoder.end(); } catch { return finish(transferError('TRANSFER_FRAME_INVALID')); }
      state.ended = true;
    });
    child.stderr.on('error', () => {}).resume(); // drained unread: stderr is never protocol data
    feed(child.stdin, input, state).catch(() => finish(transferError('TRANSFER_INPUT_INVALID')));
  });
}

// At most one frame waits in the stdin queue: a write that fills it waits for 'drain', or 'close' once torn down.
async function feed(stdin, input, state) {
  for await (const frame of input) {
    if (state.settled || stdin.destroyed) return;
    if (!Buffer.isBuffer(frame)) throw transferError('TRANSFER_INPUT_INVALID');
    if (!stdin.write(frame)) {
      await new Promise(resume => {
        const go = () => { stdin.off('drain', go).off('close', go); resume(); };
        stdin.on('drain', go).on('close', go);
      });
    }
  }
  if (state.settled || stdin.destroyed) return;
  stdin.end();
  state.fed = true;
}

// One supervisor session between two no-mount checks; delivered() says whether the guest sent the one frame expected.
async function transfer(name, provider, options, delivered) {
  await assertNoMounts(name, provider);
  await supervise(options);
  if (!delivered()) throw transferError('TRANSFER_FRAME_INVALID');
  await assertNoMounts(name, provider);
}

function materializedFrame(digest) {
  let materialized = false;
  const onFrame = frame => {
    if (materialized || frame.kind !== 'materialized' || Object.keys(frame).sort().join() !== 'digest,kind') {
      throw transferError('TRANSFER_FRAME_INVALID');
    }
    if (frame.digest !== digest) throw transferError('TRANSFER_DIGEST_MISMATCH');
    materialized = true;
  };
  return { onFrame, delivered: () => materialized };
}

/**
 * Copies one SourceSnapshot into the owned guest's workspace through the supervisor's 'materialize' mode. Refuses
 * unless the guest shows no mount before and after, and accepts only one {kind:'materialized', digest} frame whose
 * digest is workspaceEntries(snapshot).digest. Peak host memory is the snapshot, its merged copy and one frame.
 */
export async function materializeSnapshot({ name, snapshot, provider = {}, timeoutMs } = {}) {
  const manifest = workspaceEntries(snapshot);
  const { onFrame, delivered } = materializedFrame(manifest.digest);
  const options = streamOptions({ name, mode: 'materialize', provider, timeoutMs, input: hostFrames(manifest), onFrame });
  await transfer(name, provider, options, delivered);
  const bytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  return Object.freeze({ instance: name, digest: manifest.digest, files: manifest.entries.length, bytes, executionReady: false });
}

/** Copies a validateImport-sealed offline dependency tree into the root-owned guest cache between two no-mount
 * checks. The guest re-derives its digest: bytes mutated after sealing are refused (65), never installed. */
export async function installDependencies(input = {}) {
  const { name, tree, provider = {}, timeoutMs = 300_000 } = isRecord(input) ? input : {};
  let bytes = 0;
  try {
    if (!isRecord(tree) || !Array.isArray(tree.entries) || typeof tree.digest !== 'string' || !/^[0-9a-f]{64}$/.test(tree.digest)) throw new Error();
    for (const entry of tree.entries) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.executable !== 'boolean'
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || !(entry.data instanceof Uint8Array)
        || entry.data.byteLength !== entry.size) throw new Error();
      bytes += entry.size;
    }
  } catch { throw transferError('TRANSFER_INPUT_INVALID'); }
  const { onFrame, delivered } = materializedFrame(tree.digest);
  const options = streamOptions({ name, mode: 'dependencies', provider, timeoutMs, input: hostFrames(tree), onFrame });
  await transfer(name, provider, options, delivered);
  return Object.freeze({ instance: name, digest: tree.digest, files: tree.entries.length, bytes, executionReady: false });
}

/**
 * After a check session, while its VM still runs (CQ-R11f): whether the owned guest's workspace still holds every file of
 * its root-only manifest, which this run's materializeSnapshot wrote, with its bytes and exec bit. Sends no input, refuses
 * unless the guest shows no mount before and after, and accepts only one {kind:'verified', changed} frame: changed 0
 * resolves 'intact', any other count 'changed'. It sees the workspace as the job left it, never a change the job undid
 * before it exited.
 */
export async function verifyWorkspace({ name, provider = {}, timeoutMs } = {}) {
  let changed = null;
  const onFrame = frame => {
    if (changed !== null || frame.kind !== 'verified' || Object.keys(frame).sort().join() !== 'changed,kind'
      || !Number.isSafeInteger(frame.changed) || frame.changed < 0) throw transferError('TRANSFER_FRAME_INVALID');
    changed = frame.changed;
  };
  const options = streamOptions({ name, mode: 'verify', provider, timeoutMs, input: [], onFrame });
  await transfer(name, provider, options, () => changed !== null);
  return changed === 0 ? 'intact' : 'changed';
}

// Host frames for the pinned binaries ({cli, file, sha256, size}): per binary its agent header, then its file's bytes as
// base64 data frames read by position through one no-follow descriptor and re-hashed as they go, then end. A short or
// drifted file throws before that binary's last data frame is yielded, so the guest never completes a binary this host did
// not just re-verify. A fresh Buffer per chunk and one frame in flight.
async function* agentFrames(binaries) {
  for (const { cli, file, sha256, size } of binaries) {
    yield encodeFrame({ kind: 'agent', cli, size, sha256 });
    let handle;
    try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { throw transferError('TRANSFER_INPUT_INVALID'); }
    try {
      if (!(await handle.stat()).isFile()) throw transferError('TRANSFER_INPUT_INVALID');
      const hash = createHash('sha256');
      for (let at = 0; at < size; at += SNAPSHOT_CHUNK_BYTES) {
        const chunk = Buffer.alloc(Math.min(SNAPSHOT_CHUNK_BYTES, size - at));
        if ((await handle.read(chunk, 0, chunk.length, at)).bytesRead !== chunk.length) throw transferError('TRANSFER_INPUT_INVALID');
        hash.update(chunk);
        if (at + chunk.length === size && hash.digest('hex') !== sha256) throw transferError('TRANSFER_INPUT_INVALID');
        yield encodeFrame({ kind: 'data', data: chunk.toString('base64') });
      }
    } finally { await handle.close().catch(() => {}); }
  }
  yield encodeFrame({ kind: 'end' });
}

/**
 * Copies both pinned agent CLIs (AGENT_CLIS) into the owned guest through the supervisor's 'agents' mode (CQ-R10d3a).
 * Copy-only: every byte comes from fetchAgentBinary's verified cache file (pins only from the installed manifest; a caller
 * supplies arch and cacheDir, seams are test-only) and is re-hashed while it streams, and the guest shows no mount before
 * and after. Accepts one {kind: 'installed', count} frame with count equal to the binaries sent. Not an isolation claim.
 */
export async function installAgents(options, seams) {
  const { name, arch, cacheDir, provider = {}, timeoutMs = MAX_TIMEOUT_MS } = isRecord(options) ? options : {};
  const binaries = [];
  let installed = false;
  const onFrame = frame => {
    if (installed || frame.kind !== 'installed' || Object.keys(frame).sort().join() !== 'count,kind' || frame.count !== binaries.length) {
      throw transferError('TRANSFER_FRAME_INVALID');
    }
    installed = true;
  };
  // Checked first: a bad name, provider or timeout is refused before any cache read, download or provider call.
  const stream = streamOptions({ name, mode: 'agents', provider, timeoutMs, input: agentFrames(binaries), onFrame });
  for (const cli of AGENT_CLIS) binaries.push({ cli, ...await fetchAgentBinary({ cli, arch, cacheDir }, { fetch: seams?.fetch, manifest: seams?.manifest }) });
  await transfer(name, provider, stream, () => installed);
  return Object.freeze({ instance: name, agents: binaries.length, bytes: binaries.reduce((sum, { size }) => sum + size, 0), executionReady: false });
}

function toolchainRecord(value) {
  try {
    if (!isRecord(value) || Reflect.ownKeys(value).length !== 4 || Object.keys(value).sort().join() !== 'file,sha256,size,version') throw new TypeError();
    const { file, sha256, size, version } = value; // read each field once; frame only this validated copy
    if (typeof file !== 'string' || !isAbsolute(file) || CONTROL.test(file)
      || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)
      || !Number.isSafeInteger(size) || size < 1 || size > MAX_TOOLCHAIN_BYTES
      || typeof version !== 'string' || !/^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/.test(version)) throw new TypeError();
    return { file, sha256, size, version };
  } catch { throw transferError('TRANSFER_INPUT_INVALID'); }
}

async function toolchainBytes(file, size, sha256) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) throw new Error();
    const bytes = Buffer.alloc(size); // never readFile: a file growing after stat must not grow our allocation
    for (let at = 0; at < size;) {
      const { bytesRead } = await handle.read(bytes, at, size - at, at);
      if (!bytesRead) throw new Error();
      at += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error();
    return bytes;
  } finally { await handle.close(); }
}

/** Copies a cache-verified Node tarball into the root-owned guest toolchain. Rechecks size/hash before any provider
 * call, sends only that single read's bytes, and accepts one matching installed frame between two no-mount checks. */
export async function installToolchain(options = {}) {
  const { name, toolchain, provider = {}, timeoutMs } = isRecord(options) ? options : {};
  const { file, sha256, size, version } = toolchainRecord(toolchain);
  let bytes, installed = false;
  function* input() {
    yield encodeFrame({ kind: 'toolchain', version: 1, size, sha256 });
    for (let at = 0; at < size; at += SNAPSHOT_CHUNK_BYTES) {
      yield encodeFrame({ kind: 'data', data: bytes.subarray(at, at + SNAPSHOT_CHUNK_BYTES).toString('base64') });
    }
    yield encodeFrame({ kind: 'end' });
  }
  const onFrame = frame => {
    if (installed || frame.kind !== 'installed' || Object.keys(frame).sort().join() !== 'kind,sha256') {
      throw transferError('TRANSFER_FRAME_INVALID');
    }
    if (frame.sha256 !== sha256) throw transferError('TRANSFER_DIGEST_MISMATCH');
    installed = true;
  };
  const stream = streamOptions({ name, mode: 'toolchain', provider, timeoutMs, input: input(), onFrame });
  try {
    bytes = await toolchainBytes(file, size, sha256);
  } catch { throw transferError('TRANSFER_TOOLCHAIN_MISMATCH'); }
  await transfer(name, provider, stream, () => installed);
  return Object.freeze({ instance: name, sha256, version, executionReady: false });
}

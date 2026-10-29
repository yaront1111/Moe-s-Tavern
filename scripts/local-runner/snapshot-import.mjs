// Host import of one candidate overlay from an owned guest's workspace, through the protected supervisor's 'export'
// mode (CQ-R09). Every guest byte is untrusted, and frames carry no identity: each size and sha256 and the digest come
// only from validateImport over the transferred bytes. It is the ONLY admission gate, so its R09a codes surface
// unchanged. Mounts are checked before and after the stream. This is local transfer logic, not isolation
// certification: executionReady is false and verified-local stays unavailable.
import { invoker } from './lifecycle.mjs';
import { assertNoMounts, runSupervisorStream, snapshotArgv } from './snapshot-transfer.mjs';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, MAX_IMPORT_PATH_BYTES, snapshotError, validateImport } from './source-snapshot.mjs';

const MAX_TIMEOUT_MS = 600_000; // snapshot-transfer.mjs's bound
// guest-supervisor.py's OUTPUT_CHUNK_BYTES. Every data frame but a file's last is this full, so a file comes in exactly
// ceil(size / CHUNK_BYTES) frames and a stream of tiny frames cannot make the host keep one Buffer per byte.
const CHUNK_BYTES = 65_536;
// The exact sorted keys of each export frame kind, so a sha256, oid or digest key is a violation like any other.
const KEYS = {
  file: 'executable,kind,path,size', data: 'data,kind', delete: 'kind,path', symlink: 'kind,path', special: 'kind,path',
  end: 'entries,kind',
};
// Fixed text only: a message never carries a path, guest text or byte.
const MESSAGES = {
  IMPORT_INPUT_INVALID: 'Candidate import input was invalid.',
  IMPORT_PROTOCOL_VIOLATION: 'The guest supervisor sent a malformed or out-of-order export frame.',
};
// guest-bridge.mjs's rule: Node's base64 decoder is lenient, so only the round trip refuses stray characters, missing
// padding and pad bits.
const isCanonicalBase64 = data => typeof data === 'string' && data.length > 0
  && Buffer.from(data, 'base64').toString('base64') === data;

export function importError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'IMPORT_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

// The export stream as R09a entries: data only inside an open file, in full CHUNK_BYTES pieces but the last and never
// past its size, every other frame only between files, nothing after end. Bounds are checked at each header, before
// it is kept or any of its data buffered. That includes validateImport's path length rule, with its code: a header path
// can fill a 256 KiB frame, and 10,000 of them would pin gigabytes before the gate ran.
function exportReader() {
  const entries = [];
  let count = 0;
  let bytes = 0;
  let file = null;
  let ended = false;
  const violation = () => importError('IMPORT_PROTOCOL_VIOLATION');
  const close = () => {
    entries.push({ kind: 'file', path: file.path, executable: file.executable, data: Buffer.concat(file.chunks, file.size) });
    file = null;
  };
  const header = ({ kind, path, executable, size }) => {
    if (typeof path !== 'string') throw violation();
    if (Buffer.byteLength(path) > MAX_IMPORT_PATH_BYTES) throw snapshotError('SNAPSHOT_PATH_INVALID');
    if (++count > MAX_IMPORT_ENTRIES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
    if (kind !== 'file') return void entries.push({ kind, path });
    if (typeof executable !== 'boolean' || !Number.isSafeInteger(size) || size < 0) throw violation();
    bytes += size;
    if (bytes > MAX_IMPORT_BYTES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
    file = { path, executable, size, chunks: [], left: size };
    if (size === 0) close();
  };
  const push = frame => {
    const { kind } = frame;
    if (ended || typeof kind !== 'string' || !Object.hasOwn(KEYS, kind) || Object.keys(frame).sort().join() !== KEYS[kind]) {
      throw violation();
    }
    if (kind === 'data') {
      const chunk = file && isCanonicalBase64(frame.data) ? Buffer.from(frame.data, 'base64') : null;
      if (!chunk || chunk.length !== Math.min(file.left, CHUNK_BYTES)) throw violation();
      file.chunks.push(chunk);
      file.left -= chunk.length;
      if (file.left === 0) close();
    } else if (file) {
      throw violation();
    } else if (kind !== 'end') {
      header(frame);
    } else if (frame.entries !== count) {
      throw violation();
    } else {
      ended = true;
    }
  };
  const result = () => {
    if (!ended) throw violation();
    return entries;
  };
  return { push, result };
}

/**
 * Exports the owned guest's workspace changes through the supervisor's 'export' mode and admits them only through
 * validateImport, refusing unless the guest shows no mount before and after the stream. Resolves the frozen
 * { instance, candidate, executionReady: false }, candidate being validateImport's frozen result. Any refusal rejects
 * with one fixed code, never a partial candidate; one during the stream kills the provider (runSupervisorStream).
 * provider: { executable = 'multipass', run, spawn }, as for materializeSnapshot.
 */
export async function importCandidate(options) {
  const { name, provider = {}, timeoutMs } = options ?? {};
  snapshotArgv(name, 'export'); // R09c's own code for a name that is not owned
  invoker(name, provider); // R06's own codes for a bad provider record, run or executable
  if ((provider.spawn !== undefined && typeof provider.spawn !== 'function')
    || (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS))) {
    throw importError('IMPORT_INPUT_INVALID');
  }
  const reader = exportReader();
  await assertNoMounts(name, provider);
  await runSupervisorStream({ name, mode: 'export', provider, timeoutMs, input: [], onFrame: reader.push });
  const entries = reader.result();
  await assertNoMounts(name, provider);
  return Object.freeze({ instance: name, candidate: validateImport(entries), executionReady: false });
}

// Host-side import gate for candidate source bytes coming back from a guest: pure functions only, with no
// filesystem, process, network or Git access, so any transport can call it. CQ-R09 (final) and CQ-R12 consume it;
// it writes nothing and verified-local stays unavailable.
// Path rules mirror checkPortablePath in packages/moe-daemon/src/benchmarks/workloadSnapshot.ts, copied because that
// module is daemon TypeScript: FORBIDDEN_CHAR, DEVICE_NAME, wellFormed and foldCase verbatim. Facts relied on:
// - Git's verify_path refuses .git lookalikes: is_hfs_dotgit skips the HFS+-ignorable code points (U+200C-U+200F,
//   U+202A-U+202E, U+206A-U+206F, U+FEFF) and is_ntfs_dotgit matches the 8.3 short-name alias GIT~1.
// - NTFS strips a trailing dot or space from a name, so 'a.' and 'a ' alias 'a'.
// - Win32 reserves CON, PRN, AUX, NUL, COM0-9, LPT0-9 (and superscript 1-3), CONIN$ and CONOUT$, with any extension.
// - macOS may store a decomposed spelling of a name, so only NFC text is admitted; nothing is normalized.
// v1 bounds: a path is at most 1024 UTF-8 bytes and a segment 255; at most 10,000 entries and 256 MiB of file bytes.
// Digest (sha256, lowercase hex) framing: 'moe-source-snapshot-v1\0', u32be(entry count), then per entry in UTF-8
// path-byte order a kind byte (0x46 file, 0x44 delete), u32be(path byte length) and the path bytes; a file adds an
// executable byte (1 or 0), u32be(size) and the 32 raw sha256 bytes of its content.
import { createHash } from 'node:crypto';

export const MAX_IMPORT_PATH_BYTES = 1024;
export const MAX_IMPORT_SEGMENT_BYTES = 255;
export const MAX_IMPORT_ENTRIES = 10_000;
export const MAX_IMPORT_BYTES = 268_435_456;
// Operator decision 2026-10-26: refused at any depth, compared after foldCase.
export const CONTROL_SEGMENTS = Object.freeze([
  '.git', '.gitmodules', '.moe', '.mcp.json', '.claude', '.codex', '.gemini', '.grok', '.worktrees',
]);
const DIGEST_TAG = 'moe-source-snapshot-v1\0';
// Fixed text only: a message never includes a path or file bytes.
const MESSAGES = {
  SNAPSHOT_INPUT_INVALID: 'Snapshot import input was invalid.',
  SNAPSHOT_LIMIT_EXCEEDED: 'Snapshot import exceeded its entry or byte limit.',
  SNAPSHOT_ENTRY_INVALID: 'Snapshot import entry was malformed.',
  SNAPSHOT_SYMLINK_DENIED: 'Snapshot import refused a symlink entry.',
  SNAPSHOT_PATH_INVALID: 'Snapshot import path was not a portable relative path.',
  SNAPSHOT_CONTROL_PATH: 'Snapshot import path named a control directory or file.',
  SNAPSHOT_PATH_COLLISION: 'Snapshot import paths collided.',
};
// Backslash, drive/stream colon, Windows-reserved, C0/DEL/C1 control, bidi-control (ALM, LRM/RLM, LRE-RLO,
// LRI-PDI), zero-width and BOM characters. Keep them escaped: literal ones in source are Trojan Source.
const FORBIDDEN_CHAR = /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
// Like Git's is_valid_win32_path, spaces before the extension are skipped: 'CON .txt' is reserved too.
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i;
const FILE_KEYS = ['kind', 'path', 'executable', 'data'];
const DELETE_KEYS = ['kind', 'path'];
const VIEW_PROTOTYPES = [Uint8Array.prototype, Buffer.prototype];
// %TypedArray%.prototype.byteLength, captured at load, so an own byteLength property on the input cannot spoof it.
const viewLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const LEAF = Symbol('leaf');
const OWN_ERRORS = new WeakSet();

const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const utf8Length = s => Buffer.byteLength(s, 'utf8');
// True when the string has no lone surrogates.
const wellFormed = s => Buffer.from(s, 'utf8').toString('utf8') === s;
// Upper-then-lower also folds the NTFS upcase aliases plain toLowerCase misses (dotless i, long s).
const foldCase = s => s.toUpperCase().toLowerCase();
// An 8.3 short-name shape such as GIT~1 or PROGRA~1: the part before the first '.' is <= 8 chars ending in ~digits.
const isShortName = segment => {
  const base = segment.split('.', 1)[0];
  return base.length <= 8 && /~[0-9]+$/.test(base);
};
const portableSegment = segment => segment !== '' && segment !== '.' && segment !== '..'
  && utf8Length(segment) <= MAX_IMPORT_SEGMENT_BYTES
  && !segment.startsWith(' ') && !segment.endsWith(' ') && !segment.endsWith('.')
  && !DEVICE_NAME.test(foldCase(segment)) && !isShortName(segment);
const u32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

export function snapshotError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'SNAPSHOT_INPUT_INVALID';
  const error = Object.assign(new Error(MESSAGES[known]), { code: known });
  OWN_ERRORS.add(error);
  return error;
}

// Returns the path unchanged when it is a portable relative POSIX path outside every control segment.
export function validateImportPath(path) {
  if (typeof path !== 'string' || path === '' || path.length > MAX_IMPORT_PATH_BYTES
    || utf8Length(path) > MAX_IMPORT_PATH_BYTES) throw snapshotError('SNAPSHOT_PATH_INVALID');
  const segments = path.split('/');
  // Checked before portability, so '.git/CON' is refused as a control path.
  if (segments.some(segment => CONTROL_SEGMENTS.includes(foldCase(segment)))) throw snapshotError('SNAPSHOT_CONTROL_PATH');
  // A leading '/' yields an empty first segment.
  if (!wellFormed(path) || path.normalize('NFC') !== path || FORBIDDEN_CHAR.test(path)
    || !segments.every(portableSegment)) throw snapshotError('SNAPSHOT_PATH_INVALID');
  return path;
}

// Reads each property once. data is measured with the intrinsic getter, bounded, then copied with no user code
// in between, so a spoofed length or a later resize cannot change what is hashed.
function readEntry(raw, total) {
  if (!isRecord(raw)) throw snapshotError('SNAPSHOT_ENTRY_INVALID');
  const kind = raw.kind;
  if (kind === 'symlink') throw snapshotError('SNAPSHOT_SYMLINK_DENIED');
  const keys = kind === 'file' ? FILE_KEYS : kind === 'delete' ? DELETE_KEYS : [];
  const own = Reflect.ownKeys(raw);
  if (keys.length === 0 || own.length !== keys.length || !keys.every(key => own.includes(key))) {
    throw snapshotError('SNAPSHOT_ENTRY_INVALID');
  }
  const path = validateImportPath(raw.path);
  if (kind === 'delete') return { kind, path };
  const executable = raw.executable;
  const data = raw.data;
  if (typeof executable !== 'boolean' || !ArrayBuffer.isView(data) || !VIEW_PROTOTYPES.includes(Object.getPrototypeOf(data))) {
    throw snapshotError('SNAPSHOT_ENTRY_INVALID');
  }
  const size = viewLength.call(data);
  if (total + size > MAX_IMPORT_BYTES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
  const copy = new Uint8Array(data);
  if (copy.byteLength !== size) throw snapshotError('SNAPSHOT_ENTRY_INVALID');
  return { kind, path, executable, size, data: copy };
}

// A folded-segment trie finds repeated paths and ancestor/descendant pairs in time linear in total path length.
function refuseCollisions(items) {
  const root = new Map();
  for (const { path } of items) {
    let node = root;
    for (const segment of foldCase(path).split('/')) {
      if (node.has(LEAF)) throw snapshotError('SNAPSHOT_PATH_COLLISION');
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment);
    }
    if (node.size > 0) throw snapshotError('SNAPSHOT_PATH_COLLISION');
    node.set(LEAF, true);
  }
}

// Hashes only after every bound and collision check passed. A file entry's data is the private copy that was
// hashed; a TypedArray cannot be frozen, so callers must not mutate it.
function seal(items) {
  const rows = items.map(({ kind, path, executable, size, data }) => [Buffer.from(path, 'utf8'), kind === 'delete'
    ? Object.freeze({ kind, path })
    : Object.freeze({ kind, path, executable, size, sha256: createHash('sha256').update(data).digest('hex'), data })]);
  rows.sort(([a], [b]) => Buffer.compare(a, b));
  const hash = createHash('sha256').update(DIGEST_TAG).update(u32(rows.length));
  for (const [bytes, entry] of rows) {
    hash.update(Buffer.from([entry.kind === 'file' ? 0x46 : 0x44])).update(u32(bytes.length)).update(bytes);
    if (entry.kind === 'file') {
      hash.update(Buffer.from([entry.executable ? 1 : 0])).update(u32(entry.size)).update(Buffer.from(entry.sha256, 'hex'));
    }
  }
  return Object.freeze({ entries: Object.freeze(rows.map(([, entry]) => entry)), digest: hash.digest('hex') });
}

function admit(entries) {
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) throw snapshotError('SNAPSHOT_INPUT_INVALID');
  const count = entries.length;
  // A Proxy over an array passes the check above; only a real length may bound the loop below.
  if (!Number.isInteger(count) || count < 0) throw snapshotError('SNAPSHOT_INPUT_INVALID');
  if (count > MAX_IMPORT_ENTRIES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
  const items = [];
  let total = 0;
  // Each element is read once, by index, below the bounded count: no slice() or other copy that would honour the
  // caller's own constructor[Symbol.species].
  for (let index = 0; index < count; index += 1) {
    let item;
    try { item = readEntry(entries[index], total); } catch (error) {
      throw OWN_ERRORS.has(error) ? error : snapshotError('SNAPSHOT_ENTRY_INVALID');
    }
    if (item.kind === 'file') total += item.size;
    items.push(item);
  }
  refuseCollisions(items);
  return seal(items);
}

// Admits exact-key {kind:'file', path, executable, data} and {kind:'delete', path} entries. Returns a frozen
// manifest sorted by UTF-8 path bytes plus its digest, or throws one fixed-code error; never a partial result.
export function validateImport(entries) {
  try { return admit(entries); } catch (error) {
    throw OWN_ERRORS.has(error) ? error : snapshotError('SNAPSHOT_INPUT_INVALID');
  }
}

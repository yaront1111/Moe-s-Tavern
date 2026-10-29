// Daemon-side verifier for the frozen SourceSnapshot {version: 1, commit, tree, base, overlay, excluded} that
// scripts/local-runner/source-export.mjs (R09b) resolves. Pure: no filesystem, process, network or Git access. Keep it in
// sync with scripts/local-runner/source-snapshot.mjs (R09a): snapshotPathRefusal is its validateImportPath, the digest its seal.
// Digest (sha256, lowercase hex) framing: 'moe-source-snapshot-v1\0', u32be(entry count), then per entry in UTF-8
// path-byte order a kind byte (0x46 file, 0x44 delete), u32be(path byte length) and the path bytes; a file adds an
// executable byte (1 or 0), u32be(size) and the 32 raw sha256 bytes of its content.
import { createHash } from 'node:crypto';

export const SNAPSHOT_MAX_PATH_BYTES = 1024;
export const SNAPSHOT_MAX_SEGMENT_BYTES = 255;
export const SNAPSHOT_MAX_ENTRIES = 10_000;
export const SNAPSHOT_MAX_BYTES = 268_435_456;
// Refused at any depth, compared after foldCase.
export const SNAPSHOT_CONTROL_SEGMENTS: readonly string[] = Object.freeze([
  '.git', '.gitmodules', '.moe', '.mcp.json', '.claude', '.codex', '.gemini', '.grok', '.worktrees',
]);

// Backslash, drive/stream colon, Windows-reserved, C0/DEL/C1 control, bidi-control (ALM, LRM/RLM, LRE-RLO,
// LRI-PDI), zero-width and BOM characters. Keep them escaped: literal ones in source are Trojan Source.
const FORBIDDEN_CHAR = /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
// Like Git's is_valid_win32_path, spaces before the extension are skipped: 'CON .txt' is reserved too.
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i;

const utf8Length = (s: string): number => Buffer.byteLength(s, 'utf8');
// True when the string has no lone surrogates.
const wellFormed = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s;
// Upper-then-lower also folds the NTFS upcase aliases plain toLowerCase misses (dotless i, long s).
const foldCase = (s: string): string => s.toUpperCase().toLowerCase();
// An 8.3 short-name shape such as GIT~1 or PROGRA~1: the part before the first '.' is <= 8 chars ending in ~digits.
const isShortName = (segment: string): boolean => {
  const base = segment.split('.', 1)[0];
  return base.length <= 8 && /~[0-9]+$/.test(base);
};
const portableSegment = (segment: string): boolean => segment !== '' && segment !== '.' && segment !== '..'
  && utf8Length(segment) <= SNAPSHOT_MAX_SEGMENT_BYTES
  && !segment.startsWith(' ') && !segment.endsWith(' ') && !segment.endsWith('.')
  && !DEVICE_NAME.test(foldCase(segment)) && !isShortName(segment);

// Null when the path is a portable relative POSIX path outside every control segment (R09a validateImportPath).
export function snapshotPathRefusal(path: string): 'SNAPSHOT_PATH_INVALID' | 'SNAPSHOT_CONTROL_PATH' | null {
  if (typeof path !== 'string' || path === '' || path.length > SNAPSHOT_MAX_PATH_BYTES
    || utf8Length(path) > SNAPSHOT_MAX_PATH_BYTES) return 'SNAPSHOT_PATH_INVALID';
  const segments = path.split('/');
  // Checked before portability, so '.git/CON' is refused as a control path.
  if (segments.some(segment => SNAPSHOT_CONTROL_SEGMENTS.includes(foldCase(segment)))) return 'SNAPSHOT_CONTROL_PATH';
  // A leading '/' yields an empty first segment.
  if (!wellFormed(path) || path.normalize('NFC') !== path || FORBIDDEN_CHAR.test(path)
    || !segments.every(portableSegment)) return 'SNAPSHOT_PATH_INVALID';
  return null;
}

export type SnapshotRefusal = 'SNAPSHOT_INPUT_INVALID' | 'SNAPSHOT_LIMIT_EXCEEDED' | 'SNAPSHOT_ENTRY_INVALID'
  | 'SNAPSHOT_SYMLINK_DENIED' | 'SNAPSHOT_PATH_INVALID' | 'SNAPSHOT_CONTROL_PATH' | 'SNAPSHOT_PATH_COLLISION'
  | 'SNAPSHOT_HASH_MISMATCH' | 'SNAPSHOT_DIGEST_MISMATCH';
// data is the private copy sha256 was recomputed from; a TypedArray cannot be frozen, so callers must not mutate it.
export interface VerifiedSnapshotFile {
  readonly path: string; readonly executable: boolean; readonly size: number; readonly sha256: string; readonly data: Uint8Array;
}
export interface VerifiedSnapshot {
  readonly version: 1; readonly commit: string; readonly tree: string;
  readonly identity: { readonly base: string; readonly overlay: string };
  readonly base: ReadonlyMap<string, VerifiedSnapshotFile>;
  readonly overlay: ReadonlyMap<string, VerifiedSnapshotFile | { readonly kind: 'delete'; readonly path: string }>;
  readonly excluded: number;
}
type Layer = 'base' | 'overlay';
export type SnapshotVerification = { ok: true; snapshot: VerifiedSnapshot } | { ok: false; code: SnapshotRefusal; layer?: Layer };

const DIGEST_TAG = 'moe-source-snapshot-v1\0';
const FULL_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SNAPSHOT_KEYS = ['version', 'commit', 'tree', 'base', 'overlay', 'excluded'];
const LAYER_KEYS = ['entries', 'digest'];
const FILE_KEYS = ['kind', 'path', 'executable', 'size', 'sha256', 'data']; // The sealed shape R09a's seal returns.
const DELETE_KEYS = ['kind', 'path'];
const VIEW_PROTOTYPES: readonly unknown[] = [Uint8Array.prototype, Buffer.prototype];
// %TypedArray%.prototype.byteLength, captured at load, so an own byteLength property on the input cannot spoof it.
const viewLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get as () => number;
// Refusals thrown here. WeakSet.has runs no trap, so a hostile thrown Proxy can neither pose as one nor throw again.
const OWN = new WeakSet<object>();

interface Refused { readonly code: SnapshotRefusal; readonly layer?: Layer }
type FileItem = VerifiedSnapshotFile & { readonly kind: 'file'; readonly bytes: Buffer };
type Item = FileItem | { readonly kind: 'delete'; readonly path: string; readonly bytes: Buffer };
interface Trie { leaf: boolean; readonly children: Map<string, Trie> }
function refuse(code: SnapshotRefusal, layer?: Layer): never {
  const refusal: Refused = layer ? { code, layer } : { code };
  OWN.add(refusal);
  throw refusal;
}
const owned = (error: unknown): error is Refused => typeof error === 'object' && error !== null && OWN.has(error);
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Reflect.ownKeys also lists symbol and non-enumerable keys.
const exactKeys = (value: object, keys: readonly string[], own = Reflect.ownKeys(value)): boolean =>
  own.length === keys.length && keys.every(key => own.includes(key));
const u32 = (value: number): Buffer => Buffer.from([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

// Reads each property once. data is measured with the intrinsic getter and bounded, then copied with no input code
// in between, and only the copy is hashed, so a spoofed length or a later resize or write cannot change what is verified.
function readEntry(raw: unknown, total: number): Item {
  if (!plain(raw)) refuse('SNAPSHOT_ENTRY_INVALID');
  const kind = raw.kind;
  if (kind === 'symlink') refuse('SNAPSHOT_SYMLINK_DENIED');
  if ((kind !== 'file' && kind !== 'delete') || !exactKeys(raw, kind === 'file' ? FILE_KEYS : DELETE_KEYS)) refuse('SNAPSHOT_ENTRY_INVALID');
  const path = raw.path as string;
  const pathRefusal = snapshotPathRefusal(path);
  if (pathRefusal) refuse(pathRefusal);
  const bytes = Buffer.from(path, 'utf8');
  if (kind === 'delete') return { kind, path, bytes };
  const { executable, size, sha256, data } = raw;
  if (typeof executable !== 'boolean' || !ArrayBuffer.isView(data) || !VIEW_PROTOTYPES.includes(Object.getPrototypeOf(data))
    || typeof sha256 !== 'string' || !HEX64.test(sha256)) refuse('SNAPSHOT_ENTRY_INVALID');
  const length = viewLength.call(data);
  if (size !== length) refuse('SNAPSHOT_ENTRY_INVALID');
  if (total + length > SNAPSHOT_MAX_BYTES) refuse('SNAPSHOT_LIMIT_EXCEEDED');
  const copy = new Uint8Array(data as Uint8Array);
  if (copy.byteLength !== length) refuse('SNAPSHOT_ENTRY_INVALID');
  const actual = createHash('sha256').update(copy).digest('hex');
  if (actual !== sha256) refuse('SNAPSHOT_HASH_MISMATCH');
  return { kind, path, bytes, executable, size: length, sha256: actual, data: copy };
}

// A folded-segment trie finds repeated paths and ancestor/descendant pairs in time linear in total path length.
function refuseCollisions(items: Iterable<{ readonly path: string }>): void {
  const root: Trie = { leaf: false, children: new Map() };
  for (const { path } of items) {
    let node = root;
    for (const segment of foldCase(path).split('/')) {
      if (node.leaf) refuse('SNAPSHOT_PATH_COLLISION');
      let next = node.children.get(segment);
      if (!next) node.children.set(segment, next = { leaf: false, children: new Map() });
      node = next;
    }
    if (node.leaf || node.children.size > 0) refuse('SNAPSHOT_PATH_COLLISION');
    node.leaf = true;
  }
}

function layerDigest(items: readonly Item[]): string {
  const hash = createHash('sha256').update(DIGEST_TAG).update(u32(items.length));
  for (const item of items) {
    hash.update(Buffer.from([item.kind === 'file' ? 0x46 : 0x44])).update(u32(item.bytes.length)).update(item.bytes);
    if (item.kind === 'file') {
      hash.update(Buffer.from([item.executable ? 1 : 0])).update(u32(item.size)).update(Buffer.from(item.sha256, 'hex'));
    }
  }
  return hash.digest('hex');
}

// Base holds files only; an overlay delete must name a base file, as R09b only deletes committed paths.
function readLayer(raw: unknown, layer: Layer, base?: ReadonlyMap<string, Item>): { digest: string; items: Item[] } {
  try {
    if (!plain(raw) || !exactKeys(raw, LAYER_KEYS)) refuse('SNAPSHOT_INPUT_INVALID');
    const { entries, digest } = raw;
    if (typeof digest !== 'string' || !HEX64.test(digest) || !Array.isArray(entries)
      || Object.getPrototypeOf(entries) !== Array.prototype) refuse('SNAPSHOT_INPUT_INVALID');
    // Read once: a Proxy over an array passes the checks above, so only a real integer may bound the loop below.
    const count: unknown = entries.length;
    if (!Number.isInteger(count) || (count as number) < 0) refuse('SNAPSHOT_INPUT_INVALID');
    if ((count as number) > SNAPSHOT_MAX_ENTRIES) refuse('SNAPSHOT_LIMIT_EXCEEDED');
    const items: Item[] = [];
    let total = 0;
    // Each element is read once, by index: no slice() or other copy that would honour constructor[Symbol.species].
    for (let index = 0; index < (count as number); index += 1) {
      let item: Item;
      try { item = readEntry(entries[index], total); } catch (error) {
        refuse(owned(error) ? error.code : 'SNAPSHOT_ENTRY_INVALID');
      }
      const order = index === 0 ? 1 : Buffer.compare(item.bytes, items[index - 1].bytes);
      if (order === 0) refuse('SNAPSHOT_PATH_COLLISION');
      if (order < 0 || (item.kind === 'delete' && !base?.has(item.path))) refuse('SNAPSHOT_ENTRY_INVALID');
      if (item.kind === 'file') total += item.size;
      items.push(item);
    }
    refuseCollisions(items);
    if (layerDigest(items) !== digest) refuse('SNAPSHOT_DIGEST_MISMATCH');
    return { digest, items };
  } catch (error) {
    refuse(owned(error) ? error.code : 'SNAPSHOT_INPUT_INVALID', layer);
  }
}

const fileView = ({ path, executable, size, sha256, data }: FileItem): VerifiedSnapshotFile =>
  Object.freeze({ path, executable, size, sha256, data });

function verify(raw: unknown): VerifiedSnapshot {
  if (!plain(raw) || !exactKeys(raw, SNAPSHOT_KEYS)) refuse('SNAPSHOT_INPUT_INVALID');
  const { version, commit, tree, base: rawBase, overlay: rawOverlay, excluded } = raw;
  if (version !== 1 || typeof commit !== 'string' || typeof tree !== 'string' || !FULL_ID.test(commit) || !FULL_ID.test(tree)
    || commit.length !== tree.length || !Number.isSafeInteger(excluded) || (excluded as number) < 0) refuse('SNAPSHOT_INPUT_INVALID');
  const base = readLayer(rawBase, 'base');
  const merged = new Map(base.items.map(item => [item.path, item]));
  const overlay = readLayer(rawOverlay, 'overlay', merged);
  // The merged view: base files minus overlay deletes, plus overlay files (replacing a base file at the same path).
  for (const item of overlay.items) if (item.kind === 'delete') merged.delete(item.path); else merged.set(item.path, item);
  refuseCollisions(merged.values());
  return Object.freeze({
    version: 1, commit, tree, identity: Object.freeze({ base: base.digest, overlay: overlay.digest }),
    base: new Map((base.items as FileItem[]).map(item => [item.path, fileView(item)])),
    overlay: new Map(overlay.items.map(item => [item.path, item.kind === 'delete'
      ? Object.freeze({ kind: item.kind, path: item.path }) : fileView(item)])),
    excluded: excluded as number,
  });
}

// Verifies R09b's frozen SourceSnapshot from its entry bytes alone: every sha256 and both layer digests are recomputed
// and compared with the declared ones. Returns a frozen view or one fixed refusal code; never throws, never partial.
export function verifySourceSnapshot(raw: unknown): SnapshotVerification {
  try { return { ok: true, snapshot: verify(raw) }; } catch (error) {
    return owned(error) ? { ok: false, ...error } : { ok: false, code: 'SNAPSHOT_INPUT_INVALID' };
  }
}

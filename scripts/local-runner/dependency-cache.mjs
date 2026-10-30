// Admission for the offline npm cache of an isolated check VM (CQ-R11e3a): turns a candidate's package-lock.json files
// into the exact, deduplicated list of registry tarballs the host may fetch, BEFORE anything is downloaded.
// Trust model: candidate lockfiles are untrusted bytes. Every rule below fails closed with a fixed code; there is never a
// partial result, and no message carries a URL, key, path or lockfile byte. admitLockfiles is pure: no filesystem,
// network, process, npm or candidate code, so the cache builder (CQ-R11e3) can call it first.
// Rules:
// - lockfileVersion 2 or 3 only. Every packages key except '' (the root project) must be a node_modules location;
//   workspace folder keys and links (even one flagged inBundle or optional) are refused, because npm could extract a
//   tarball over a source path.
// - Skipped, never fetched: inBundle entries (they ship inside their parent's verified tarball) and optional entries
//   whose os excludes linux or whose cpu excludes the guest cpu (npm-install-checks checkList semantics). libc is
//   deliberately never filtered: an extra package is harmless, a missing one fails the offline install.
// - Every other entry needs a semver version, a resolved that EQUALS the canonical registry.npmjs.org tarball URL for
//   its name (an npm alias uses entry.name) and one canonical sha512 SRI token. Plain string equality: no URL parsing.
// The cache itself (CQ-R11e3): buildDependencyCache keeps each admitted tarball through agent-cache.mjs fetchPinnedFile in
// cacheDir, the persistent controller-private store, and resolves the per-call tree in npm's cacache layout: each
// tarball's bytes at _cacache/content-v2/sha512/<h[0:2]>/<h[2:4]>/<h[4:]> for its sha512 hex h, plus moe-dependencies.json
// = {"version":1,"dirs":[the sorted lockfile dirs]}. That is enough: pacote reads a lockfile entry that has both integrity
// and resolved by digest (cacache.get.stream.byDigest), so no index-v5 entry and no registry is needed (DC5 proves it).
// validateImport seals the tree, so CQ-R11e4 streams it with snapshot-transfer.mjs hostFrames unchanged and CQ-R11e5
// installs each listed dir. Building it never runs npm, a node script or candidate code, and only bytes re-hashed in
// memory against the lockfile's sha512 enter the tree.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fetchPinnedFile } from './agent-cache.mjs';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, validateImport, validateImportPath } from './source-snapshot.mjs';

export const MAX_LOCKFILES = 16;
export const MAX_LOCKFILE_BYTES = 16_777_216;
// One entry of the imported tree is spare: CQ-R11e3 adds the tree's own moe-dependencies.json.
export const MAX_DEPENDENCY_PACKAGES = MAX_IMPORT_ENTRIES - 1;
export const MAX_PACKAGE_BYTES = 67_108_864;
// The tree's tarball bytes, leaving room within validateImport's bound for moe-dependencies.json.
export const MAX_DEPENDENCY_BYTES = MAX_IMPORT_BYTES - 65_536;
// The caller runs `<node> <npm-cli.js> ci ...OFFLINE_INSTALL_ARGS --cache <tree root>`; CQ-R11e5 mirrors it in Python.
// --offline never fetches; --ignore-scripts runs no root or dependency lifecycle script; --no-update-notifier because the
// update notifier ignores --offline and would reach the registry; --logs-max=0 writes no _logs into the cache;
// --no-audit and --no-fund make no further registry calls.
export const OFFLINE_INSTALL_ARGS = Object.freeze(['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--logs-max=0']);
const MESSAGES = {
  DEPENDENCY_INPUT_INVALID: 'Dependency input was invalid.',
  DEPENDENCY_LOCKFILE_INVALID: 'Dependency lockfile was invalid.',
  DEPENDENCY_LOCATION_INVALID: 'Dependency lockfile entry location was not a package location.',
  DEPENDENCY_SOURCE_UNSUPPORTED: 'Dependency lockfile entry source was not a supported registry tarball.',
  DEPENDENCY_INTEGRITY_INVALID: 'Dependency lockfile entry integrity was not one canonical digest.',
  DEPENDENCY_LIMIT_EXCEEDED: 'Dependency lockfile exceeded its size or package limit.',
  DEPENDENCY_DOWNLOAD_FAILED: 'Dependency tarball could not be downloaded.',
  DEPENDENCY_CHECKSUM_MISMATCH: 'Dependency tarball did not match its lockfile integrity.',
  DEPENDENCY_TOO_LARGE: 'Dependency tarball exceeded its size bound.',
  DEPENDENCY_CACHE_FAILED: 'Dependency cache could not be read or written.',
};
// fetchPinnedFile's PINNED_<kind> refusals. Its options are all admitted values, so its INPUT_INVALID can only mean a
// cached entry that is a link or no regular file; anything else is a failed download.
const PINNED_KINDS = {
  CHECKSUM_MISMATCH: 'DEPENDENCY_CHECKSUM_MISMATCH', TOO_LARGE: 'DEPENDENCY_TOO_LARGE',
  UNREADABLE: 'DEPENDENCY_CACHE_FAILED', INPUT_INVALID: 'DEPENDENCY_CACHE_FAILED',
};
const CONTROL = /[\x00-\x1f\x7f]/;
// A name segment excludes '/', so the location regex has no ambiguous nesting and runs in linear time.
const NAME = '(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*';
const LOCATION = new RegExp(`^node_modules/(?:${NAME}/node_modules/)*(${NAME})$`);
const NAME_ONLY = new RegExp(`^${NAME}$`);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;
const VIEW_PROTOTYPES = [Uint8Array.prototype, Buffer.prototype];
// %TypedArray%.prototype.byteLength, captured at load, so an own byteLength property on the input cannot spoof it.
const viewLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const OWN_ERRORS = new WeakSet();

const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasExactKeys = (value, keys) => {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
};

export function dependencyError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'DEPENDENCY_INPUT_INVALID';
  const error = Object.assign(new Error(MESSAGES[known]), { code: known });
  OWN_ERRORS.add(error);
  return error;
}

// npm-install-checks checkList. Anything that is not a list of strings never excludes a package.
function passes(value, list) {
  const items = typeof list === 'string' ? [list] : list;
  if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) return true;
  if (items.length === 1 && items[0] === 'any') return true;
  let negated = 0;
  let matched = false;
  for (const item of items) {
    if (item.startsWith('!')) {
      if (item.slice(1) === value) return false;
      negated += 1;
    } else if (item === value) matched = true;
  }
  return matched || negated === items.length;
}

// Reads each property once, bounds the size BEFORE decoding, and parses at once so a later getter cannot change the bytes.
function readLockfile(element) {
  if (!isRecord(element) || !hasExactKeys(element, ['dir', 'bytes'])) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  const dir = element.dir;
  const bytes = element.bytes;
  if (dir !== '.' && validateImportPath(dir) !== dir) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  if (!ArrayBuffer.isView(bytes) || !VIEW_PROTOTYPES.includes(Object.getPrototypeOf(bytes))) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  if (viewLength.call(bytes) > MAX_LOCKFILE_BYTES) throw dependencyError('DEPENDENCY_LIMIT_EXCEEDED');
  let lockfile;
  try { lockfile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw dependencyError('DEPENDENCY_LOCKFILE_INVALID'); }
  if (!isRecord(lockfile) || (lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) || !isRecord(lockfile.packages)) {
    throw dependencyError('DEPENDENCY_LOCKFILE_INVALID');
  }
  return { dir, packages: lockfile.packages };
}

// Adds each admitted entry to found, keyed by sha512 and keeping the smallest url, and refuses past the package bound at once.
function admitEntries(packages, cpu, found) {
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    const location = LOCATION.exec(key);
    if (location === null) throw dependencyError('DEPENDENCY_LOCATION_INVALID');
    if (!isRecord(entry)) throw dependencyError('DEPENDENCY_LOCKFILE_INVALID');
    // Before both skips: npm 12.2.0 still creates the symlink for a link entry flagged inBundle or optional, and a later
    // node_modules/<link>/node_modules/<name> key would then extract a tarball under the link's target.
    if (entry.link === true) throw dependencyError('DEPENDENCY_SOURCE_UNSUPPORTED');
    if (entry.inBundle === true) continue;
    if (entry.optional === true && !(passes('linux', entry.os) && passes(cpu, entry.cpu))) continue;
    const name = entry.name === undefined ? location[1] : entry.name;
    const version = entry.version;
    if (typeof name !== 'string' || !NAME_ONLY.test(name) || typeof version !== 'string' || !SEMVER.test(version)
      || entry.resolved !== `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`) {
      throw dependencyError('DEPENDENCY_SOURCE_UNSUPPORTED');
    }
    const integrity = entry.integrity;
    const digest = typeof integrity === 'string' ? INTEGRITY.exec(integrity) : null;
    // Buffer's base64 decoder is lenient about padding bits; only the canonical text is one spelling of the bytes.
    if (digest === null || Buffer.from(digest[1], 'base64').toString('base64') !== digest[1]) throw dependencyError('DEPENDENCY_INTEGRITY_INVALID');
    const sha512 = Buffer.from(digest[1], 'base64').toString('hex');
    const known = found.get(sha512);
    if (known === undefined || entry.resolved < known.url) found.set(sha512, { integrity, sha512, url: entry.resolved });
    if (found.size > MAX_DEPENDENCY_PACKAGES) throw dependencyError('DEPENDENCY_LIMIT_EXCEEDED');
  }
}

function admit(input) {
  if (!isRecord(input) || !hasExactKeys(input, ['lockfiles', 'cpu'])) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  const cpu = input.cpu;
  const lockfiles = input.lockfiles;
  if (cpu !== 'x64' && cpu !== 'arm64') throw dependencyError('DEPENDENCY_INPUT_INVALID');
  if (!Array.isArray(lockfiles) || Object.getPrototypeOf(lockfiles) !== Array.prototype) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  // A Proxy over an array passes the check above; only a real length may bound the loop below.
  const count = lockfiles.length;
  if (!Number.isInteger(count) || count < 1 || count > MAX_LOCKFILES) throw dependencyError('DEPENDENCY_INPUT_INVALID');
  const dirs = new Set();
  const found = new Map();
  for (let index = 0; index < count; index += 1) {
    const { dir, packages } = readLockfile(lockfiles[index]);
    if (dirs.has(dir)) throw dependencyError('DEPENDENCY_INPUT_INVALID');
    dirs.add(dir);
    admitEntries(packages, cpu, found);
  }
  const sorted = [...dirs].map(dir => [Buffer.from(dir, 'utf8'), dir]).sort(([a], [b]) => Buffer.compare(a, b)).map(([, dir]) => dir);
  const packages = [...found.values()].sort((a, b) => (a.sha512 < b.sha512 ? -1 : 1)).map(item => Object.freeze(item));
  return Object.freeze({ dirs: Object.freeze(sorted), packages: Object.freeze(packages) });
}

// Returns a deeply frozen { dirs, packages: [{ integrity, sha512, url }] } or throws one fixed-code dependencyError.
export function admitLockfiles(input) {
  try { return admit(input); } catch (error) {
    throw OWN_ERRORS.has(error) ? error : dependencyError('DEPENDENCY_INPUT_INVALID');
  }
}

// Reads each input and option property once; a throwing getter or Proxy trap is the same refusal.
function readInput(input, options) {
  try {
    if (isRecord(input) && hasExactKeys(input, ['lockfiles', 'cpu', 'cacheDir'])) {
      const { lockfiles, cpu, cacheDir } = input;
      const { fetch = globalThis.fetch } = options ?? {};
      if (typeof cacheDir === 'string' && path.isAbsolute(cacheDir) && !CONTROL.test(cacheDir) && typeof fetch === 'function') return { lockfiles, cpu, cacheDir, fetch };
    }
  } catch { /* the refusal below */ }
  throw dependencyError('DEPENDENCY_INPUT_INVALID');
}

// The kept file, read once through a no-follow descriptor and at most MAX_PACKAGE_BYTES + 1 bytes, so an entry swapped
// for a link, a device or a larger file after the downloader's check is never followed or read unbounded.
async function readKept(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw dependencyError('DEPENDENCY_CACHE_FAILED');
    const data = Buffer.alloc(Math.min(stats.size, MAX_PACKAGE_BYTES) + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return data.subarray(0, length);
  } finally { await handle.close().catch(() => {}); }
}

// One admitted tarball's bytes: kept at <cacheDir>/<sha512>.tgz by fetchPinnedFile, then re-hashed here in memory.
async function keep({ url, sha512 }, cacheDir, fetch) {
  const file = path.join(cacheDir, `${sha512}.tgz`);
  try { await fetchPinnedFile({ url, file, size: null, maxBytes: MAX_PACKAGE_BYTES, algorithm: 'sha512', digest: sha512 }, { fetch }); } catch (error) {
    const kind = String(error?.code).replace(/^PINNED_/, '');
    throw dependencyError(Object.hasOwn(PINNED_KINDS, kind) ? PINNED_KINDS[kind] : 'DEPENDENCY_DOWNLOAD_FAILED');
  }
  let data;
  try { data = await readKept(file); } catch { throw dependencyError('DEPENDENCY_CACHE_FAILED'); }
  if (data.length > MAX_PACKAGE_BYTES || createHash('sha512').update(data).digest('hex') !== sha512) throw dependencyError('DEPENDENCY_CHECKSUM_MISMATCH');
  return data;
}

/**
 * Admits the lockfiles before any I/O, keeps each admitted tarball in cacheDir in turn, and resolves the frozen
 * { tree, digest, packages, bytes }: tree is validateImport's sealed { entries, digest }, packages the tarball count and
 * bytes the sum of the tree's file sizes. Builds sharing cacheDir are safe: fetchPinnedFile writes an exclusive .part
 * and renames it atomically, and one digest is one name with identical bytes. Rejects only with a fixed-code dependencyError.
 */
export async function buildDependencyCache(input, options) {
  const { lockfiles, cpu, cacheDir, fetch } = readInput(input, options);
  const { dirs, packages } = admitLockfiles({ lockfiles, cpu });
  try { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); } catch { throw dependencyError('DEPENDENCY_CACHE_FAILED'); }
  const entries = [];
  let total = 0;
  for (const item of packages) {
    const data = await keep(item, cacheDir, fetch);
    if ((total += data.length) > MAX_DEPENDENCY_BYTES) throw dependencyError('DEPENDENCY_LIMIT_EXCEEDED');
    const hex = item.sha512;
    entries.push({ kind: 'file', path: `_cacache/content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`, executable: false, data });
  }
  entries.push({ kind: 'file', path: 'moe-dependencies.json', executable: false, data: Buffer.from(JSON.stringify({ version: 1, dirs })) });
  let tree;
  try { tree = validateImport(entries); } catch (error) {
    throw dependencyError(error?.code === 'SNAPSHOT_LIMIT_EXCEEDED' ? 'DEPENDENCY_LIMIT_EXCEEDED' : 'DEPENDENCY_INPUT_INVALID');
  }
  return Object.freeze({ tree, digest: tree.digest, packages: packages.length, bytes: tree.entries.reduce((sum, { size }) => sum + size, 0) });
}

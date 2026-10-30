// Host cache of the pinned Linux agent CLIs (CQ-R10d2), in image-cache.mjs's pattern. The module-relative manifest pins
// each release file's fixed https URL, sha256 and size, plus the member's for a tar.gz; callers, the CLI and the
// environment cannot choose a manifest or a URL. Integrity comes from those pins: a download is verified before any
// byte is parsed, a member before its rename, and a cached file on every hit. https is defense in depth. cacheDir must
// be controller-private and is chosen by the caller. Copying into a guest is CQ-R10d3; nothing here is an isolation claim.
// The download-and-verify core is exported as fetchPinnedFile, with neutral PINNED_ codes, for the toolchain (CQ-R11e1)
// and dependency (CQ-R11e3) caches; fetchAgentBinary maps those codes to its own.
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { DOWNLOAD_TIMEOUT_MS } from './image-cache.mjs';

export const AGENT_CLIS = Object.freeze(['claude', 'codex']); // the CQ-R10b supervisor JOBS keys
export const MAX_AGENT_BINARY_BYTES = 2 ** 30;
const MANIFEST = new URL('./agent-binaries.json', import.meta.url);
const MAX_MANIFEST_BYTES = 65_536;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Decompressed bytes a tar may hold beyond its member (headers, padding, other entries); the pinned ones need ~11 KiB.
const TAR_SLACK_BYTES = 2 ** 20;
const CONTROL = /[\x00-\x1f\x7f]/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGESTS = new Map([['sha256', SHA256], ['sha512', /^[a-f0-9]{128}$/]]);
const VERSION = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/;
const TRIPLES = { x64: 'x86_64', arm64: 'aarch64' };
// The vendors' own release URLs: Anthropic's install.sh and the openai/codex GitHub releases.
const URLS = {
  claude: (version, arch) => `https://downloads.claude.ai/claude-code-releases/${version}/linux-${arch}/claude`,
  codex: (version, arch) => `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${TRIPLES[arch]}-unknown-linux-musl.tar.gz`,
};
const KEYS = { claude: ['version', 'url', 'sha256', 'size'], codex: ['version', 'url', 'sha256', 'size', 'archive', 'member', 'memberSha256', 'memberSize'] };
const MESSAGES = {
  AGENT_BINARY_INPUT_INVALID: 'The agent binary request was invalid.',
  AGENT_BINARY_MANIFEST_INVALID: 'The installed agent binary manifest is invalid or unavailable.',
  AGENT_BINARY_DOWNLOAD_FAILED: 'The pinned agent binary could not be downloaded.',
  AGENT_BINARY_CHECKSUM_MISMATCH: 'The agent binary did not match its pinned checksum.',
  AGENT_BINARY_TOO_LARGE: 'The agent binary exceeded its pinned size.',
  AGENT_BINARY_ARCHIVE_INVALID: 'The agent binary archive was malformed.',
  AGENT_BINARY_UNREADABLE: 'The cached agent binary could not be read.',
};
const PINNED_MESSAGES = {
  PINNED_INPUT_INVALID: 'The pinned download request was invalid.',
  PINNED_DOWNLOAD_FAILED: 'The pinned file could not be downloaded.',
  PINNED_CHECKSUM_MISMATCH: 'The pinned file did not match its checksum.',
  PINNED_TOO_LARGE: 'The pinned file exceeded its size bound.',
  PINNED_UNREADABLE: 'The cached pinned file could not be read.',
};

/** One of the fixed codes with its fixed text; anything else (fs, zlib, fetch errors) becomes fallback. */
function fixed(messages, code, fallback) {
  const known = typeof code === 'string' && Object.hasOwn(messages, code) ? code : fallback;
  return Object.assign(new Error(messages[known]), { code: known });
}
const pinned = (code, fallback = 'PINNED_DOWNLOAD_FAILED') => fixed(PINNED_MESSAGES, code, fallback);
/** fetchAgentBinary's refusals: a core PINNED_<kind> becomes AGENT_BINARY_<kind>. */
const refuse = (code, fallback = 'AGENT_BINARY_DOWNLOAD_FAILED') => fixed(MESSAGES, typeof code === 'string' ? code.replace(/^PINNED_/, 'AGENT_BINARY_') : code, fallback);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const validSize = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_AGENT_BINARY_BYTES;
// A plain relative tar path: no empty, '.' or '..' segment, no backslash, and short enough for the ustar name field.
const validMember = value => typeof value === 'string' && value.length <= 100 && value.split('/').every(part => /^[\w.+-]+$/.test(part) && part !== '.' && part !== '..');
function freeze(value) {
  for (const child of Object.values(value)) if (record(child)) freeze(child);
  return Object.freeze(value);
}

function validEntry(cli, arch, entry) {
  return exactKeys(entry, KEYS[cli]) && matches(entry.version, VERSION) && entry.url === URLS[cli](entry.version, arch)
    && matches(entry.sha256, SHA256) && validSize(entry.size) && (cli !== 'codex' || (entry.archive === 'tar.gz'
    && validMember(entry.member) && matches(entry.memberSha256, SHA256) && validSize(entry.memberSize)));
}

/** The exact pinned shape, checked on a copy (so getters cannot change it afterwards) that is returned deep-frozen. */
export function validateAgentManifest(value) {
  let copy;
  try { copy = structuredClone(value); } catch { throw refuse('AGENT_BINARY_MANIFEST_INVALID'); }
  if (!exactKeys(copy, ['schemaVersion', 'binaries']) || copy.schemaVersion !== 1 || !exactKeys(copy.binaries, AGENT_CLIS)
      || !AGENT_CLIS.every(cli => exactKeys(copy.binaries[cli], IMAGE_ARCHES) && IMAGE_ARCHES.every(arch => validEntry(cli, arch, copy.binaries[cli][arch])))) {
    throw refuse('AGENT_BINARY_MANIFEST_INVALID');
  }
  return freeze(copy);
}

export async function loadAgentManifest() {
  try {
    const bytes = await readFile(MANIFEST);
    if (bytes.length > MAX_MANIFEST_BYTES) throw refuse('AGENT_BINARY_MANIFEST_INVALID');
    return validateAgentManifest(JSON.parse(bytes.toString('utf8')));
  } catch { throw refuse('AGENT_BINARY_MANIFEST_INVALID'); }
}

// A pin is { url, size, maxBytes, algorithm, digest }; size null means only maxBytes bounds the bytes.
const sha256Pin = ({ url, sha256, size }) => ({ url, size, maxBytes: size, algorithm: 'sha256', digest: sha256 });

/** The verified length when file holds exactly the pinned bytes, read through one no-follow descriptor, else false; a non-regular file is refused. */
async function holdsPin(file, { size, maxBytes, algorithm, digest }) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (error) {
    throw pinned(error?.code === 'ELOOP' ? 'PINNED_INPUT_INVALID' : 'PINNED_UNREADABLE');
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw pinned('PINNED_INPUT_INVALID');
    const bound = size ?? maxBytes;
    if (size === null ? stats.size > bound : stats.size !== size) return false;
    const hash = createHash(algorithm);
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > bound) return false;
      hash.update(chunk);
    }
    return (size === null || total === size) && hash.digest('hex') === digest ? total : false;
  } catch (error) {
    throw pinned(error?.code, 'PINNED_UNREADABLE');
  } finally { await handle.close().catch(() => {}); }
}

/** The verified length of a cached entry; false when absent, or corrupt and removed (the caller then downloads once). */
async function cached(target, pin) {
  let stats;
  try { stats = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw pinned('PINNED_UNREADABLE');
  }
  if (!stats.isFile()) throw pinned('PINNED_INPUT_INVALID');
  const length = await holdsPin(target, pin);
  if (length !== false) return length;
  await unlink(target).catch(error => {
    if (error?.code !== 'ENOENT') throw pinned('PINNED_UNREADABLE');
  });
  return false;
}

const drop = response => response?.body?.cancel().catch(() => {});
const httpsUrl = (location, base) => {
  if (typeof location !== 'string') return null;
  try { const next = new URL(location, base); return next.protocol === 'https:' ? next.href : null; } catch { return null; }
};

/** The first non-redirect response for url, after at most MAX_REDIRECTS hops followed by hand so each must be https. */
async function respond(url, fetch) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if (!REDIRECTS.has(response?.status)) return response;
    await drop(response);
    url = hop < MAX_REDIRECTS ? httpsUrl(response.headers?.get?.('location'), url) : null;
    if (url === null) throw pinned('PINNED_DOWNLOAD_FAILED');
  }
}

async function writeAll(handle, chunk) {
  for (let at = 0; at < chunk.byteLength;) at += (await handle.write(chunk, at)).bytesWritten;
}

async function writeBody(handle, body, maxBytes) {
  let total = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw pinned('PINNED_DOWNLOAD_FAILED');
    total += chunk.byteLength;
    if (total > maxBytes) throw pinned('PINNED_TOO_LARGE');
    await writeAll(handle, chunk);
  }
}

/** One ustar header; its checksum must add up (bytes 148-155 count as spaces). Sizes are plain octal, never base-256. */
function parseHeader(header) {
  const field = (at, length) => {
    const raw = header.subarray(at, at + length);
    return raw.subarray(0, raw.includes(0) ? raw.indexOf(0) : length).toString('latin1');
  };
  const octal = (at, length) => {
    const digits = field(at, length).trim();
    if (!/^[0-7]{1,11}$/.test(digits)) throw refuse('AGENT_BINARY_ARCHIVE_INVALID');
    return parseInt(digits, 8);
  };
  let sum = 8 * 32;
  for (let at = 0; at < 512; at++) if (at < 148 || at >= 156) sum += header[at];
  if (octal(148, 8) !== sum) throw refuse('AGENT_BINARY_ARCHIVE_INVALID');
  const prefix = header.toString('latin1', 257, 263) === 'ustar\0' ? field(345, 155) : ''; // POSIX only; GNU puts times there
  return { name: prefix ? `${prefix}/${field(0, 100)}` : field(0, 100), type: String.fromCharCode(header[156]), size: octal(124, 12) };
}

/**
 * A minimal ustar reader over gunzipped chunks: it writes into handle only the pinned member, a regular file of at most
 * memberSize bytes, refuses a link or a duplicate there, and needs the end-of-archive block and a clean gzip end.
 */
async function untar(source, handle, { member, memberSize }) {
  const chunks = source[Symbol.asyncIterator]();
  let [pending, total, found] = [Buffer.alloc(0), 0, false];
  const take = async n => {
    if (pending.length === 0) {
      const { value, done } = await chunks.next();
      if (done) return pending;
      total += value.length;
      if (total > memberSize + TAR_SLACK_BYTES) throw refuse('AGENT_BINARY_TOO_LARGE');
      pending = value;
    }
    const piece = pending.subarray(0, n);
    pending = pending.subarray(piece.length);
    return piece;
  };
  const consume = async (n, sink) => {
    for (let left = n; left > 0;) {
      const piece = await take(left);
      if (piece.length === 0) throw refuse('AGENT_BINARY_ARCHIVE_INVALID');
      left -= piece.length;
      await sink?.(piece);
    }
  };
  for (;;) {
    const pieces = [];
    await consume(512, piece => pieces.push(piece));
    const header = Buffer.concat(pieces);
    if (header.every(byte => byte === 0)) break;
    const { name, type, size } = parseHeader(header);
    const padding = (512 - (size % 512)) % 512;
    if (name !== member) { await consume(size + padding); continue; }
    if (found || (type !== '0' && type !== '\0')) throw refuse('AGENT_BINARY_ARCHIVE_INVALID');
    if (size > memberSize) throw refuse('AGENT_BINARY_TOO_LARGE');
    found = true;
    await consume(size, piece => writeAll(handle, piece));
    await consume(padding);
  }
  if (!found) throw refuse('AGENT_BINARY_ARCHIVE_INVALID');
  // Read to the end: pipeline stalls on unread bytes, and gunzip reports a bad trailer only once it reaches it.
  while ((await take(65_536)).length > 0);
}

/** Creates file exclusively (0600) for this call, records it for cleanup, fills it with fill and syncs it. */
async function writePart(file, parts, fill) {
  const handle = await open(file, 'wx', 0o600);
  parts.push(file);
  try {
    await fill(handle);
    await handle.sync();
  } finally { await handle.close().catch(() => {}); }
  return file;
}

/** Downloads into private .part files: the download is verified before parsing, a member before the atomic rename. */
async function download(pin, target, fetch, archive, member) {
  const nonce = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const parts = [];
  let response;
  try {
    response = await respond(pin.url, fetch);
    if (response?.ok !== true || !response.body || !String(response.url).startsWith('https://')) throw pinned('PINNED_DOWNLOAD_FAILED');
    const declared = response.headers?.get?.('content-length') ?? null;
    if (declared !== null && !(Number(declared) <= pin.maxBytes)) throw pinned('PINNED_TOO_LARGE');
    const file = await writePart(path.join(path.dirname(target), `.${pin.digest}.${nonce}.part`), parts, handle => writeBody(handle, response.body, pin.maxBytes));
    let length = await holdsPin(file, pin);
    if (length === false) throw pinned('PINNED_CHECKSUM_MISMATCH');
    let verified = file;
    if (archive) {
      verified = await writePart(path.join(path.dirname(target), `.${member.digest}.${nonce}.part`), parts, async handle => {
        try { await pipeline(createReadStream(file), createGunzip(), source => untar(source, handle, archive)); } catch (error) {
          throw refuse(error?.code, 'AGENT_BINARY_ARCHIVE_INVALID');
        }
      });
      length = await holdsPin(verified, member);
      if (length === false) throw pinned('PINNED_CHECKSUM_MISMATCH');
    }
    await rename(verified, target);
    return length;
  } catch (error) {
    await drop(response); // a body already read is released, and cancelling it again is a no-op
    throw Object.hasOwn(MESSAGES, error?.code) ? error : pinned(error?.code); // the archive path's own codes pass through
  } finally {
    // An EEXIST collision is never recorded: that .part belongs to another call. A renamed one is already gone.
    for (const part of parts) await unlink(part).catch(() => {});
  }
}

/**
 * The shared download-and-verify core, every option validated before any I/O. url is https (each of at most 5 redirects
 * too); file is the absolute path the verified bytes are kept at, in a directory the caller created 0700, beside which
 * this call's .part files sit; size is the exact byte count, or null when only maxBytes (a positive integer of at most
 * MAX_AGENT_BINARY_BYTES) bounds the body; algorithm is 'sha256' or 'sha512' and digest its lowercase hex. A cached file
 * is re-verified every call, and a corrupt one removed and fetched once. Resolves the frozen { file, size } with the
 * verified length; rejects only with a fixed PINNED_ code, leaving no .part. It never creates directories, extracts or logs.
 */
export async function fetchPinnedFile(options, { fetch = globalThis.fetch } = {}) {
  const { url, file, size, maxBytes, algorithm, digest } = record(options) ? options : {};
  const pattern = DIGESTS.get(algorithm);
  if (typeof url !== 'string' || httpsUrl(url) === null || typeof file !== 'string' || !path.isAbsolute(file) || CONTROL.test(file)
      || !validSize(maxBytes) || !(size === null || (validSize(size) && size <= maxBytes)) || !pattern || !matches(digest, pattern)
      || typeof fetch !== 'function') throw pinned('PINNED_INPUT_INVALID');
  const pin = { url, size, maxBytes, algorithm, digest };
  try {
    let length = await cached(file, pin);
    if (length === false) length = await download(pin, file, fetch);
    return Object.freeze({ file, size: length });
  } catch (error) { throw pinned(error?.code); }
}

/**
 * The verified pinned binary (the member, for an archive) as a frozen { file, sha256, size } at <cacheDir>/<sha256>.bin,
 * from the cache or downloaded into it. Concurrent callers each write their own .part and rename atomically. manifest
 * is a test seam only, validated like the installed one.
 */
export async function fetchAgentBinary(input, { fetch = globalThis.fetch, manifest } = {}) {
  const { cli, arch, cacheDir } = input ?? {};
  if (!AGENT_CLIS.includes(cli) || !IMAGE_ARCHES.includes(arch) || typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)
      || CONTROL.test(cacheDir) || typeof fetch !== 'function') throw refuse('AGENT_BINARY_INPUT_INVALID');
  const pin = (manifest === undefined ? await loadAgentManifest() : validateAgentManifest(manifest)).binaries[cli][arch];
  const binary = pin.archive ? { sha256: pin.memberSha256, size: pin.memberSize } : pin;
  try { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); } catch { throw refuse('AGENT_BINARY_INPUT_INVALID'); }
  const [target, member] = [path.join(cacheDir, `${binary.sha256}.bin`), sha256Pin(binary)];
  try {
    if (!pin.archive) await fetchPinnedFile({ ...member, file: target }, { fetch });
    else if ((await cached(target, member)) === false) await download(sha256Pin(pin), target, fetch, pin, member);
  } catch (error) { throw refuse(error?.code); }
  return Object.freeze({ file: target, sha256: binary.sha256, size: binary.size });
}

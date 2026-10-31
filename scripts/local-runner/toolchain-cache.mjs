// Host cache of the pinned Node.js toolchain for the check VM (CQ-R11e1). The module-relative toolchain.json pins each
// arch's fixed nodejs.org https URL, sha256 and size; callers, the CLI and the environment cannot choose a manifest or a
// URL. Integrity comes from those pins, through agent-cache.mjs fetchPinnedFile. The tarball stays whole: CQ-R11e2
// extracts it in the guest. cacheDir must be controller-private and is chosen by the caller; nothing here is an isolation claim.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchPinnedFile } from './agent-cache.mjs';
import { IMAGE_ARCHES } from './guest-bootstrap.mjs';

export const MAX_TOOLCHAIN_BYTES = 134_217_728; // the bound CQ-R11e2's installToolchain enforces
const MANIFEST = new URL('./toolchain.json', import.meta.url);
const MAX_MANIFEST_BYTES = 65_536;
const CONTROL = /[\x00-\x1f\x7f]/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/; // agent-cache.mjs's strict x.y.z
const MESSAGES = {
  TOOLCHAIN_INPUT_INVALID: 'The toolchain request was invalid.',
  TOOLCHAIN_MANIFEST_INVALID: 'The installed toolchain manifest is invalid or unavailable.',
  TOOLCHAIN_DOWNLOAD_FAILED: 'The pinned toolchain could not be downloaded.',
  TOOLCHAIN_CHECKSUM_MISMATCH: 'The toolchain did not match its pinned checksum.',
  TOOLCHAIN_TOO_LARGE: 'The toolchain exceeded its pinned size.',
  TOOLCHAIN_UNREADABLE: 'The cached toolchain could not be read.',
};

/** One of the fixed codes with its fixed text; anything else becomes TOOLCHAIN_DOWNLOAD_FAILED. */
function refuse(code) {
  const known = Object.hasOwn(MESSAGES, code) ? code : 'TOOLCHAIN_DOWNLOAD_FAILED';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validEntry = (arch, entry, version) => exactKeys(entry, ['version', 'url', 'sha256', 'size']) && entry.version === version
  && entry.url === `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz` && typeof entry.sha256 === 'string'
  && SHA256.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MAX_TOOLCHAIN_BYTES;

/** The exact pinned shape, one version for every arch, checked on a copy that is returned deep-frozen. */
export function validateToolchainManifest(value) {
  let copy;
  try { copy = structuredClone(value); } catch { throw refuse('TOOLCHAIN_MANIFEST_INVALID'); }
  const version = copy?.node?.x64?.version;
  if (!exactKeys(copy, ['schemaVersion', 'node']) || copy.schemaVersion !== 1 || !exactKeys(copy.node, IMAGE_ARCHES) || typeof version !== 'string'
      || !VERSION.test(version) || !IMAGE_ARCHES.every(arch => validEntry(arch, copy.node[arch], version))) throw refuse('TOOLCHAIN_MANIFEST_INVALID');
  for (const arch of IMAGE_ARCHES) Object.freeze(copy.node[arch]);
  Object.freeze(copy.node);
  return Object.freeze(copy);
}

export async function loadToolchainManifest() {
  try {
    const bytes = await readFile(MANIFEST);
    if (bytes.length > MAX_MANIFEST_BYTES) throw refuse('TOOLCHAIN_MANIFEST_INVALID');
    return validateToolchainManifest(JSON.parse(bytes.toString('utf8')));
  } catch { throw refuse('TOOLCHAIN_MANIFEST_INVALID'); }
}

/**
 * The verified pinned tarball as a frozen { file, sha256, size, version } at <cacheDir>/<sha256>.tar.xz, from the cache
 * or downloaded into it; a PINNED_<kind> refusal becomes TOOLCHAIN_<kind>. manifest is a test seam only, validated like
 * the installed one.
 */
export async function fetchNodeToolchain(input, { fetch = globalThis.fetch, manifest } = {}) {
  const { arch, cacheDir } = record(input) ? input : {};
  if (!IMAGE_ARCHES.includes(arch) || typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir) || CONTROL.test(cacheDir)
      || typeof fetch !== 'function') throw refuse('TOOLCHAIN_INPUT_INVALID');
  const { version, url, sha256, size } = (manifest === undefined ? await loadToolchainManifest() : validateToolchainManifest(manifest)).node[arch];
  try { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); } catch { throw refuse('TOOLCHAIN_INPUT_INVALID'); }
  const file = path.join(cacheDir, `${sha256}.tar.xz`);
  try { await fetchPinnedFile({ url, file, size, maxBytes: size, algorithm: 'sha256', digest: sha256 }, { fetch }); } catch (error) {
    throw refuse(String(error?.code).replace(/^PINNED_/, 'TOOLCHAIN_'));
  }
  return Object.freeze({ file, sha256, size, version });
}

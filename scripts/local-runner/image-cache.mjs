// Pinned source-image cache shared by the R03-R05 provisioners. The source is always the installed
// module-relative R02 manifest: callers cannot choose a URL or a file. Integrity comes from the sha256 pin
// (R07 verifySourceImage), checked on every cache hit as well; HTTPS is defense in depth. cacheDir must be
// controller-private, because the verified image waits there until launch (R07's TOCTOU note). Callers
// choose it; there is no environment variable or default location.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadCertifiedProvider } from './doctor.mjs';
import { bootstrapError, IMAGE_ARCHES, MAX_IMAGE_BYTES, verifySourceImage } from './guest-bootstrap.mjs';
import { renameOver } from './lifecycle.mjs';

export const DOWNLOAD_TIMEOUT_MS = 3_600_000;
const CONTROL = /[\x00-\x1f\x7f]/;
const VERIFY_CODES = new Set(['IMAGE_INPUT_INVALID', 'IMAGE_UNREADABLE', 'IMAGE_CHECKSUM_MISMATCH']);

/** R07's image codes pass through; every other failure is one stable code with no URL, path or body. */
export function imageError(code) {
  if (VERIFY_CODES.has(code)) return bootstrapError(code);
  return Object.assign(new Error('The pinned source image could not be downloaded.'), { code: 'IMAGE_DOWNLOAD_FAILED' });
}

/** A verified entry, or null to download: absent, or corrupt and removed (the caller downloads once). */
async function cachedImage(target, arch, digest) {
  let stats;
  try { stats = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw imageError('IMAGE_UNREADABLE');
  }
  if (!stats.isFile()) throw imageError('IMAGE_INPUT_INVALID');
  try {
    return { file: target, sourceImage: await verifySourceImage({ file: target, arch }, { digest }) };
  } catch (error) {
    if (error?.code !== 'IMAGE_CHECKSUM_MISMATCH') throw imageError(error?.code);
  }
  await unlink(target).catch(error => {
    if (error?.code !== 'ENOENT') throw imageError('IMAGE_CHECKSUM_MISMATCH');
  });
  return null;
}

async function writeBody(handle, body, maxBytes) {
  let total = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw imageError('IMAGE_DOWNLOAD_FAILED');
    total += chunk.byteLength;
    if (total > maxBytes) throw imageError('IMAGE_INPUT_INVALID');
    for (let at = 0; at < chunk.byteLength;) at += (await handle.write(chunk, at)).bytesWritten;
  }
  await handle.sync();
}

/** Streams into a private exclusive .part, verifies it, then renames it into place atomically. */
async function downloadImage({ pin, arch, cacheDir, target, fetch, digest, maxBytes }) {
  const part = path.join(cacheDir, `.${pin.sha256}.${process.pid}.${randomBytes(4).toString('hex')}.part`);
  let response;
  let handle;
  let created = false;
  try {
    response = await fetch(pin.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
    if (response?.ok !== true || typeof response.url !== 'string' || !response.url.startsWith('https://') || !response.body) {
      throw imageError('IMAGE_DOWNLOAD_FAILED');
    }
    const declared = response.headers?.get?.('content-length') ?? null;
    if (declared !== null && !(Number(declared) <= maxBytes)) throw imageError('IMAGE_INPUT_INVALID');
    handle = await open(part, 'wx', 0o600);
    created = true;
    await writeBody(handle, response.body, maxBytes);
    await handle.close();
    handle = undefined;
    const sourceImage = await verifySourceImage({ file: part, arch }, { digest });
    await renameOver(part, target);
    return { file: target, sourceImage };
  } catch (error) {
    await handle?.close().catch(() => {});
    // Only a .part this call created: an EEXIST collision belongs to another download.
    if (created) await unlink(part).catch(() => {});
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw imageError(error?.code);
  }
}

/**
 * The verified pinned image for arch, from cacheDir or downloaded into it. Concurrent callers each write
 * their own .part, and rename is atomic, so every returned file is a verified pin. digest (R07) and
 * maxBytes (lowering the bound only) are injected for tests.
 */
export async function ensurePinnedImage(input, { fetch = globalThis.fetch, digest, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const { cacheDir, arch } = input ?? {};
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir) || CONTROL.test(cacheDir) || !IMAGE_ARCHES.includes(arch)
      || typeof fetch !== 'function' || (digest !== undefined && typeof digest !== 'function')
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_IMAGE_BYTES) throw imageError('IMAGE_INPUT_INVALID');
  const pin = (await loadCertifiedProvider()).images[arch];
  try { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); } catch { throw imageError('IMAGE_INPUT_INVALID'); }
  const target = path.join(cacheDir, `${pin.sha256}.img`);
  return (await cachedImage(target, arch, digest)) ?? downloadImage({ pin, arch, cacheDir, target, fetch, digest, maxBytes });
}

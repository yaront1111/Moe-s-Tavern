// Platform-neutral owned-VM provisioning: the platform's prerequisite gate, the pinned image, R07 user-data,
// ONE R06 reservation with its bounded same-name launch retry, then R07 bootstrap readiness. Linux and macOS
// launch the verified cached file. Windows launches `release:<pin sha256>` and must then prove that the
// instance's full image id is the pin (IMAGE_PROVIDER_HASH_MISMATCH otherwise). Platform
// modules (R03 Windows; R04/R05 add theirs) only surface prerequisites. This module never deletes (R06
// reconcile and cleanup own that), never runs `multipass set` and never mounts. executionReady is always
// false: bootstrap readiness is not isolation certification. Multipass v1.17.0 facts relied on:
// - src/client/cli/cmd/launch.cpp sends a `file://` image as "file://" + QFileInfo(rest).absoluteFilePath(), with
//   no percent-decoding (so file://C:/… on Windows), and splits `release:<x>` into remote `release` and image <x>.
//   The URL is built by hand: pathToFileURL's %-encoding would name a different file.
// - src/daemon/default_vm_image_vault.cpp fetch_image refuses a local file URL whose QUrl host is non-empty, and QUrl
//   reads `C:` as a host (canonical/multipass#5490). A local image is prepared in the instance directory, where
//   src/platform/backends/hcs/hcs_virtual_machine_factory.cpp prepare_source_image converts it in place with qemu-img
//   into a sparse VHDX that virtdisk will not resize (#5491). So no Windows host launches a local file.
// - src/image_host/ubuntu_image_host.cpp all_info_for_impl matches a non-alias query as an image-hash prefix across
//   every version src/simplestreams/simple_streams_manifest.cpp lists (id = the item sha256, verify = true,
//   uefi1.img before disk1.img), and download_and_prepare_source_image runs verify_file_hash before prepare.
// - `info` image_hash is that vault id; an http(s) image's id is the sha256 of its URL. The 20261017 release has no
//   uefi1.img, and its disk1.img sha256 is the x64 pin (stream checked 2026-10-31).
// - `--cloud-init -` reads the user-data from stdin, so Moe never writes the supervisor credential to a file
//   (Multipass keeps its own NoCloud seed in its daemon data directory; R07 probes the guest-side copies).
// - launching the configured primary instance name auto-mounts the user's home directory.
import { buildUserData, IMAGE_ARCHES, launchResourceArgs } from './guest-bootstrap.mjs';
import { readGuestInfo, waitForGuestReady } from './guest-readiness.mjs';
import { ensurePinnedImage } from './image-cache.mjs';
import { invoker, isOwnedInstanceName, provisionOwned } from './lifecycle.mjs';
import { classifyFailure, providerError } from './multipass.mjs';

export const LAUNCH_TIMEOUT_SECONDS = 900;
const CONTROL = /[\x00-\x1f\x7f]/;
const MESSAGES = {
  PROVISION_INPUT_INVALID: 'Provisioning input was invalid.',
  PROVISION_LAUNCH_FAILED: 'The provider launch could not receive its cloud-init user-data.',
  PRIMARY_NAME_CONFLICT: 'The Multipass primary instance name looks Moe-owned; Moe never changes client.primary-name.',
  IMAGE_PROVIDER_HASH_MISMATCH: 'The launched instance does not report the pinned image; it was refused before readiness.',
};
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function provisionError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'PROVISION_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

/** POSIX absolute paths only. No Windows host gets a file URL: Multipass 1.17.0+win cannot launch a local image (header). */
export function fileImageUrl(file, platform = process.platform) {
  if (platform === 'win32' || typeof file !== 'string' || CONTROL.test(file) || !file.startsWith('/')) throw provisionError('PROVISION_INPUT_INVALID');
  return `file://${file}`;
}

/** The official release-stream image whose sha256 is exactly this pin; Multipass verifies the download against it (header). */
export function releaseImage(sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw provisionError('PROVISION_INPUT_INVALID');
  return `release:${sha256}`;
}

/** The launch image argument: exactly one of a local file or a pinned release sha256, else PROVISION_INPUT_INVALID. */
function launchImage({ imageFile, imageSha256, platform = process.platform }) {
  if ((imageFile === undefined) === (imageSha256 === undefined)) throw provisionError('PROVISION_INPUT_INVALID');
  return imageSha256 === undefined ? fileImageUrl(imageFile, platform) : releaseImage(imageSha256);
}

/** One bounded launch of an owned name from a local or pinned release image; the user-data travels only on stdin. */
export async function launchInstance({
  name, imageFile, imageSha256, userData, provider = {}, platform = process.platform, timeoutSeconds = LAUNCH_TIMEOUT_SECONDS,
} = {}) {
  if (!isOwnedInstanceName(name) || typeof userData !== 'string' || userData === ''
      || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw provisionError('PROVISION_INPUT_INVALID');
  const argv = ['launch', launchImage({ imageFile, imageSha256, platform }), '--name', name, '--cloud-init', '-', '--timeout', String(timeoutSeconds), ...launchResourceArgs()];
  // Promisified execFile carries its ChildProcess as .child; the client waits for stdin to end.
  const pending = invoker(name, provider)(argv, (timeoutSeconds + 60) * 1000);
  const stdin = pending?.child?.stdin;
  if (typeof stdin?.end !== 'function' || typeof stdin.on !== 'function') {
    pending?.child?.kill?.('SIGKILL');
    Promise.resolve(pending).catch(() => {});
    throw provisionError('PROVISION_LAUNCH_FAILED');
  }
  // A client that exits before reading stdin raises EPIPE here; its exit status reports the failure.
  stdin.on('error', () => {});
  stdin.end(userData);
  try { await pending; } catch (error) { throw providerError(classifyFailure(error)); }
}

/**
 * Provisions one owned guest. Nothing is downloaded, reserved or launched until every platform prerequisite
 * holds. After the reservation any failure leaves the ledger record for R06 reconcile and cleanup.
 * fetch and digest (image cache) and sleep (R06/R07) are injected for tests.
 */
export async function provisionGuest({
  platform, ledger, owner, cacheDir, supervisor, credential, provider = {}, fetch, digest, sleep,
} = {}) {
  if (!isRecord(platform) || typeof platform.prerequisites !== 'function' || typeof ledger?.reserve !== 'function' || !isRecord(provider)
      || (sleep !== undefined && typeof sleep !== 'function')) {
    throw provisionError('PROVISION_INPUT_INVALID');
  }
  // Every Multipass call goes to the platform's certified client (Linux pins the snap's), unless overridden.
  provider = { ...provider, executable: provider.executable ?? platform.executable };
  const pre = await platform.prerequisites({ provider, cacheDir });
  // A per-host arch (macOS detects its hardware) wins over a static one; only a pinned image arch proceeds.
  const arch = pre?.arch ?? platform.arch;
  if (pre?.ready !== true || !IMAGE_ARCHES.includes(arch)) return { provisioned: false, bootstrapReady: false, executionReady: false, prerequisites: pre?.prerequisites };
  if (isOwnedInstanceName(pre.primaryName)) throw provisionError('PRIMARY_NAME_CONFLICT');
  const bootstrap = buildUserData({ supervisor, credential });
  const image = await ensurePinnedImage({ cacheDir, arch }, { fetch, digest });
  // Windows launches the installed manifest pin from the release stream, never a file (header); every other platform
  // launches the verified file in this host's path syntax. An unlaunchable image is refused before reserving.
  const source = platform.id === 'win32' ? { imageSha256: image.sourceImage.sha256 } : { imageFile: image.file };
  launchImage(source);
  // One durable name per call: every launch retry and any crash recovery reuse it (R06).
  const { instance: name } = await ledger.reserve(owner);
  const launch = target => launchInstance({ name: target, ...source, userData: bootstrap.userData, provider });
  await provisionOwned({ ledger, name, owner, launch, provider, sleep });
  // The release route proves the full image id, also after an adopted timed-out launch. A mismatch or a failed read
  // fails closed with no retry, delete or fallback; the owned record stays for R06 or caller cleanup.
  if (source.imageSha256 && (await readGuestInfo(name, provider)).providerImageHash !== source.imageSha256) {
    throw provisionError('IMAGE_PROVIDER_HASH_MISMATCH');
  }
  const ready = await waitForGuestReady({ ledger, name, owner, sourceImage: image.sourceImage, bootstrap, provider, sleep });
  return {
    provisioned: true, instance: name, bootstrapReady: ready.bootstrapReady, executionReady: false,
    prerequisites: pre.prerequisites, image: ready.image, supervisorSha256: ready.supervisorSha256, failures: ready.failures,
  };
}

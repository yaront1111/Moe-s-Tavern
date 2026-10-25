// Platform-neutral owned-VM provisioning: the platform's prerequisite gate, the pinned image, R07 user-data,
// ONE R06 reservation with its bounded same-name launch retry, then R07 bootstrap readiness. Platform
// modules (R03 Windows; R04/R05 add theirs) only surface prerequisites. This module never deletes (R06
// reconcile and cleanup own that), never runs `multipass set` and never mounts. executionReady is always
// false: bootstrap readiness is not isolation certification. Multipass v1.17.0 facts relied on
// (src/client/cli/cmd/launch.cpp):
// - a `file://` image has those 7 characters removed and the rest made absolute (QFileInfo), with no
//   percent-decoding. The URL is built by hand: pathToFileURL's %-encoding and its '/' before a drive
//   letter would name a different file.
// - `--cloud-init -` reads the user-data from stdin, so Moe never writes the supervisor credential to a file
//   (Multipass keeps its own NoCloud seed in its daemon data directory; R07 probes the guest-side copies).
// - launching the configured primary instance name auto-mounts the user's home directory.
import { buildUserData, launchResourceArgs } from './guest-bootstrap.mjs';
import { waitForGuestReady } from './guest-readiness.mjs';
import { ensurePinnedImage } from './image-cache.mjs';
import { invoker, isOwnedInstanceName, provisionOwned } from './lifecycle.mjs';
import { classifyFailure, providerError } from './multipass.mjs';

export const LAUNCH_TIMEOUT_SECONDS = 900;
const CONTROL = /[\x00-\x1f\x7f]/;
const MESSAGES = {
  PROVISION_INPUT_INVALID: 'Provisioning input was invalid.',
  PROVISION_LAUNCH_FAILED: 'The provider launch could not receive its cloud-init user-data.',
  PRIMARY_NAME_CONFLICT: 'The Multipass primary instance name looks Moe-owned; Moe never changes client.primary-name.',
};
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function provisionError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'PROVISION_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

/** Windows takes only drive-letter absolute paths (no UNC or device paths); POSIX takes absolute paths. */
export function fileImageUrl(file, platform = process.platform) {
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/ : /^\//;
  if (typeof file !== 'string' || CONTROL.test(file) || !absolute.test(file)) throw provisionError('PROVISION_INPUT_INVALID');
  return `file://${platform === 'win32' ? file.replaceAll('\\', '/') : file}`;
}

/** One bounded launch of an owned name from a local image; the user-data travels only on stdin. */
export async function launchInstance({
  name, imageFile, userData, provider = {}, platform = process.platform, timeoutSeconds = LAUNCH_TIMEOUT_SECONDS,
} = {}) {
  if (!isOwnedInstanceName(name) || typeof userData !== 'string' || userData === ''
      || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw provisionError('PROVISION_INPUT_INVALID');
  const argv = ['launch', fileImageUrl(imageFile, platform), '--name', name, '--cloud-init', '-', '--timeout', String(timeoutSeconds), ...launchResourceArgs()];
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
  const pre = await platform.prerequisites({ provider });
  if (pre?.ready !== true) return { provisioned: false, bootstrapReady: false, executionReady: false, prerequisites: pre?.prerequisites };
  if (isOwnedInstanceName(pre.primaryName)) throw provisionError('PRIMARY_NAME_CONFLICT');
  const bootstrap = buildUserData({ supervisor, credential });
  const image = await ensurePinnedImage({ cacheDir, arch: platform.arch }, { fetch, digest });
  // The image path is in this host's own path syntax; refuse an unlaunchable one before reserving.
  fileImageUrl(image.file);
  // One durable name per call: every launch retry and any crash recovery reuse it (R06).
  const { instance: name } = await ledger.reserve(owner);
  const launch = target => launchInstance({ name: target, imageFile: image.file, userData: bootstrap.userData, provider });
  await provisionOwned({ ledger, name, owner, launch, provider, sleep });
  const ready = await waitForGuestReady({ ledger, name, owner, sourceImage: image.sourceImage, bootstrap, provider, sleep });
  return {
    provisioned: true, instance: name, bootstrapReady: ready.bootstrapReady, executionReady: false,
    prerequisites: pre.prerequisites, image: ready.image, failures: ready.failures,
  };
}

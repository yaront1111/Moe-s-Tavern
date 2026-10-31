// This manifest declares prerequisite compatibility, NOT completed isolation certification.
// Image checksums: https://cloud-images.ubuntu.com/releases/noble/release-20261017/SHA256SUMS
// Released platform suffixes: canonical/multipass v1.17.0 src/cmake/versioning.cmake.
import { readFile } from 'node:fs/promises';
import { probeMultipass, providerError } from './multipass.mjs';

const MANIFEST = new URL('./certified-provider.json', import.meta.url);
const PLATFORM = { win32: ['hcs', '+win'], linux: ['qemu', ''], darwin: ['qemu', '+mac'] };
const IMAGE_ARCH = { x64: 'amd64', arm64: 'arm64' };
// Matches v1.17.0 utils::valid_hostname; command output is separately byte-bounded.
const INSTANCE_NAME = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const MESSAGES = {
  MANIFEST_INVALID: 'Installed provider manifest is invalid or unavailable.',
  HOST_UNSUPPORTED: 'Host platform/architecture is not in the declared prerequisite matrix.',
  VERSION_MISMATCH: 'Multipass client and daemon versions must match exactly.',
  VERSION_UNSUPPORTED: 'Multipass version is not an approved released build for this host.',
  DRIVER_UNSUPPORTED: 'Multipass driver is unsupported; no global driver setting was changed.',
  PROVIDER_OUTPUT_INVALID: 'Multipass prerequisite output was malformed.',
  DOCTOR_INPUT_INVALID: 'Doctor options must be an object.',
};

function refuse(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function freeze(value) {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

/** Validate the installed shape; callers cannot select a manifest through the CLI or environment. */
export function validateManifest(value) {
  if (!record(value) || value.schemaVersion !== 1 || value.provider !== 'multipass' ||
      !Array.isArray(value.versions) || value.versions.length !== 1 || value.versions[0] !== '1.17.0' ||
      !Array.isArray(value.hosts) || value.hosts.length !== 4 || !record(value.images)) throw refuse('MANIFEST_INVALID');
  const seen = new Set();
  for (const entry of value.hosts) {
    const expected = record(entry) && Object.hasOwn(PLATFORM, entry.platform) ? PLATFORM[entry.platform] : null;
    const key = `${entry?.platform}/${entry?.arch}`;
    if (!expected || entry.driver !== expected[0] || entry.versionSuffix !== expected[1] ||
        !(entry.arch === 'x64' || (entry.platform === 'darwin' && entry.arch === 'arm64')) || seen.has(key)) throw refuse('MANIFEST_INVALID');
    seen.add(key);
  }
  for (const [arch, imageArch] of Object.entries(IMAGE_ARCH)) {
    const image = value.images[arch];
    const expectedUrl = `https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-${imageArch}.img`;
    if (!record(image) || image.url !== expectedUrl || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) throw refuse('MANIFEST_INVALID');
  }
  return freeze(value);
}

export async function loadCertifiedProvider() {
  try {
    const bytes = await readFile(MANIFEST);
    if (bytes.length > 16_384) throw refuse('MANIFEST_INVALID');
    return validateManifest(JSON.parse(bytes.toString('utf8')));
  } catch { throw refuse('MANIFEST_INVALID'); }
}

function readProbe(probe) {
  let versions;
  try { versions = JSON.parse(probe.versionJson); } catch { throw refuse('PROVIDER_OUTPUT_INVALID'); }
  if (!record(versions) || typeof versions.multipass !== 'string' || typeof versions.multipassd !== 'string') throw refuse('PROVIDER_OUTPUT_INVALID');
  const driver = probe.driver.trim();
  // v1.17.0 get.cpp renders a disabled primary as <empty> without --raw.
  const primary = probe.primaryName.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(driver) || (primary !== '<empty>' && !INSTANCE_NAME.test(primary))) throw refuse('PROVIDER_OUTPUT_INVALID');
  return { client: versions.multipass, daemon: versions.multipassd, driver, primaryName: primary === '<empty>' ? null : primary };
}

function assess(manifest, entry, probe) {
  const observed = readProbe(probe);
  if (observed.client !== observed.daemon) throw refuse('VERSION_MISMATCH');
  if (!manifest.versions.some(version => observed.client === version + entry.versionSuffix)) throw refuse('VERSION_UNSUPPORTED');
  if (observed.driver !== entry.driver) throw refuse('DRIVER_UNSUPPORTED');
  return {
    provider: manifest.provider, code: 'PROVIDER_PREREQUISITES_READY',
    providerReady: true, executionReady: false, certification: 'not-established',
    version: observed.client, driver: observed.driver, primaryName: observed.primaryName,
    host: { platform: entry.platform, arch: entry.arch }, image: manifest.images[entry.arch],
  };
}

export async function runDoctor(options = {}) {
  try {
    if (!record(options)) throw refuse('DOCTOR_INPUT_INVALID');
    const manifest = await loadCertifiedProvider();
    const { host = { platform: process.platform, arch: process.arch }, executable, run } = options;
    const entry = record(host) && manifest.hosts.find(item => item.platform === host.platform && item.arch === host.arch);
    if (!entry) throw refuse('HOST_UNSUPPORTED');
    const probe = await probeMultipass({ executable, run });
    return assess(manifest, entry, probe);
  } catch (error) {
    // Only our sanitized diagnostic codes/messages can reach a machine-readable report.
    const known = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code);
    const diagnostic = known ? refuse(error.code) : providerError(error?.code);
    return { provider: 'multipass', code: diagnostic.code, providerReady: false, executionReady: false, message: diagnostic.message };
  }
}

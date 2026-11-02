// Guest bootstrap only: pinned source-image verification and the deterministic cloud-init user-data that
// installs the protected supervisor, the guest MCP shim and its tools, and the locked job identities. It makes no execution readiness or
// isolation claim; verified-local stays unavailable.
// Launch MUST use the verified LOCAL file (file://): Multipass v1.17.0 src/daemon/default_vm_image_vault.cpp
// derives an HTTP image's id from the URL string, not its content, and records compute_file_hash of the
// PREPARED (provider-converted) image for a local one. The source sha and the provider identity therefore
// differ and are recorded separately. Hash-then-launch is a TOCTOU window: R03-R05 must keep the verified
// image in a controller-private directory until launch.
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { loadCertifiedProvider } from './doctor.mjs';
import { authorizedKeyLine } from './guest-ssh.mjs';

export const GUEST_LAYOUT = Object.freeze({
  supervisor: '/opt/moe/bin/moe-supervisor',
  supervisorDirs: Object.freeze(['/opt/moe', '/opt/moe/bin']),
  shim: '/opt/moe/bin/moe-mcp-shim',
  shimTools: '/opt/moe/bin/tools.json',
  credential: '/etc/moe/supervisor.credential',
  credentialDir: '/etc/moe',
});
export const JOB_IDENTITIES = Object.freeze(['moe-agent', 'moe-check']);
export const GUEST_RESOURCES = Object.freeze({ cpus: 2, memoryBytes: 4 * 2 ** 30, diskBytes: 20 * 2 ** 30 });
export const IMAGE_ARCHES = Object.freeze(['x64', 'arm64']);
export const MAX_SUPERVISOR_BYTES = 262_144;
export const MAX_CREDENTIAL_BYTES = 4096;
export const MAX_IMAGE_BYTES = 4 * 2 ** 30;
const GiB = 2 ** 30;
const MESSAGES = {
  IMAGE_INPUT_INVALID: 'Source image input was invalid.',
  IMAGE_UNREADABLE: 'Source image could not be read.',
  IMAGE_CHECKSUM_MISMATCH: 'Source image does not match the pinned manifest checksum.',
  BOOTSTRAP_INPUT_INVALID: 'Guest bootstrap input was invalid.',
  BOOTSTRAP_ASSET_INVALID: 'A bundled guest asset was missing or invalid.',
};

export function bootstrapError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'BOOTSTRAP_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

/** Launch sizing for the R03-R05 platform launchers; Multipass memory_size.cpp parses G as GiB. */
export function launchResourceArgs() {
  const { cpus, memoryBytes, diskBytes } = GUEST_RESOURCES;
  return ['--cpus', String(cpus), '--memory', `${memoryBytes / GiB}G`, '--disk', `${diskBytes / GiB}G`];
}

async function openRegularFile(file, maxBytes) {
  let stats;
  try { stats = await lstat(file); } catch { throw bootstrapError('IMAGE_UNREADABLE'); }
  if (!stats.isFile() || stats.size > maxBytes) throw bootstrapError('IMAGE_INPUT_INVALID');
  let handle;
  try {
    // No symlink follow and no FIFO block on POSIX; both flags are 0 where unsupported.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch { throw bootstrapError('IMAGE_UNREADABLE'); }
  const opened = await handle.stat().catch(() => null);
  if (opened?.isFile()) return handle;
  await handle.close().catch(() => {});
  throw bootstrapError('IMAGE_INPUT_INVALID');
}

/** Streams the sha256 of a regular file; maxBytes bounds the bytes actually read, since the file can grow. */
export async function hashFile(input) {
  const { file, maxBytes = MAX_IMAGE_BYTES } = input ?? {};
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw bootstrapError('IMAGE_INPUT_INVALID');
  const handle = await openRegularFile(file, maxBytes);
  try {
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > maxBytes) throw bootstrapError('IMAGE_INPUT_INVALID');
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (error) {
    throw error?.code === 'IMAGE_INPUT_INVALID' ? error : bootstrapError('IMAGE_UNREADABLE');
  } finally { await handle.close().catch(() => {}); }
}

/** Pins come only from the installed manifest; digest is injected only for tests, like R02's run. */
export async function verifySourceImage(source, { digest = hashFile } = {}) {
  const arch = source?.arch;
  if (!IMAGE_ARCHES.includes(arch) || typeof digest !== 'function') throw bootstrapError('IMAGE_INPUT_INVALID');
  const pin = (await loadCertifiedProvider()).images[arch];
  if ((await digest({ file: source.file })) !== pin.sha256) throw bootstrapError('IMAGE_CHECKSUM_MISMATCH');
  return Object.freeze({ arch, url: pin.url, sha256: pin.sha256 });
}

const validPayload = (value, max) => Buffer.isBuffer(value) && value.length > 0 && value.length <= max;
// Base64 never contains a quote; quoting keeps a payload that spells a YAML boolean or number a string.
const writeFile = (file, permissions, bytes) => [
  `  - path: ${file}`, '    owner: root:root', `    permissions: '${permissions}'`, '    encoding: b64', `    content: '${bytes.toString('base64')}'`,
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// A guest asset bundled beside this module, read only when user-data is built, never at import.
function readAsset(name) {
  let bytes = null;
  try { bytes = readFileSync(new URL(`./${name}`, import.meta.url)); } catch { /* missing or unreadable */ }
  if (!validPayload(bytes, MAX_SUPERVISOR_BYTES)) throw bootstrapError('BOOTSTRAP_ASSET_INVALID');
  return bytes;
}

const TRANSPORT_KEYS = Object.freeze(['hostPrivateKey', 'hostPublicKey', 'clientPublicKey']);
// Every character is base64 or fixed text, so no value can end a YAML scalar, dedent the literal block or start a comment.
const HOST_PRIVATE_KEY = /^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,70}\n)+-----END OPENSSH PRIVATE KEY-----\n$/;
const HOST_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
// The cloud-config tail for a transport; any invalid input is BOOTSTRAP_INPUT_INVALID and no message carries a value.
function transportLines(transport) {
  const keys = transport !== null && typeof transport === 'object' && !Array.isArray(transport) ? Reflect.ownKeys(transport) : [];
  if (keys.length !== TRANSPORT_KEYS.length || !TRANSPORT_KEYS.every(key => keys.includes(key))) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  const { hostPrivateKey, hostPublicKey, clientPublicKey } = transport;
  if (typeof hostPrivateKey !== 'string' || !HOST_PRIVATE_KEY.test(hostPrivateKey)
      || typeof hostPublicKey !== 'string' || !HOST_PUBLIC_KEY.test(hostPublicKey)) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  let authorized;
  try { authorized = authorizedKeyLine(clientPublicKey); } catch { throw bootstrapError('BOOTSTRAP_INPUT_INVALID'); }
  return [
    'ssh_keys:', '  ed25519_private: |', ...hostPrivateKey.trimEnd().split('\n').map(line => `    ${line}`),
    `  ed25519_public: '${hostPublicKey}'`, 'ssh_authorized_keys:', `  - '${authorized}'`,
  ];
}

/**
 * Deterministic user-data built only from constants and base64. '- default' stays: Multipass execs as the
 * default user and injects its key through its own cloud-init data. Job identities get no groups or sudo.
 * mounts lists only cloud-init's two built-in defaults (ephemeral0 for /mnt, and swap) as fs_spec-only entries: in
 * cloud-init 26.1 cc_mounts such an entry is skipped and drops the default of the same name, and on NoCloud, which
 * Multipass seeds, neither name maps to a device anyway (DataSource.device_name_to_device returns None). As user-data
 * the list also outranks any vendor or system mounts. 26.1's schema refuses `mounts: []` (minItems 1), and that
 * warning ends boot "degraded done", which readiness reports as BOOTSTRAP_FAILED.
 * no_ssh_fingerprints: true makes cloud-init 26.1's modules-final ssh_authkey_fingerprints return before it reads any
 * user. Otherwise its handle calls ssh_util.extract_authorized_keys for every entry in users, which writes a missing
 * ~/.ssh/authorized_keys as an empty 0600 file, and readiness's keys:<id> existence probe refuses that file on a job
 * identity as IDENTITY_LOGIN_ENABLED. The module only logs key fingerprints to the console; Moe reads none of it.
 * An optional transport {hostPrivateKey, hostPublicKey, clientPublicKey} appends ssh_keys and ssh_authorized_keys after
 * write_files, so the no-transport bytes stay an exact prefix. cloud-init 26.1 facts, read in source:
 * - cc_ssh deletes the image's host keys (ssh_deletekeys, default true) and generates none when ssh_keys is present, so
 *   the guest's only host key is the pinned ed25519 pair, written 0600 and 0644;
 * - setup_user_keys keeps a key line's own options, so only the default user gets `restrict,command=...`; disable_root
 *   also copies the key to root under cloud-init's own 'login as ubuntu' command, which grants nothing.
 */
export function buildUserData(input) {
  const { supervisor, credential, transport } = input ?? {};
  if (!validPayload(supervisor, MAX_SUPERVISOR_BYTES) || !validPayload(credential, MAX_CREDENTIAL_BYTES)) {
    throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  }
  const transportBlock = transport === undefined ? [] : transportLines(transport);
  const shim = readAsset('guest-mcp-shim.py');
  const shimTools = readAsset('guest-mcp-tools.json');
  const lines = [
    '#cloud-config', 'ssh_pwauth: false', 'disable_root: true', 'no_ssh_fingerprints: true', 'mounts: [[ephemeral0], [swap]]', 'users:', '  - default',
    ...JOB_IDENTITIES.flatMap(name => [`  - name: ${name}`, '    lock_passwd: true', '    shell: /bin/bash']),
    'write_files:',
    ...writeFile(GUEST_LAYOUT.supervisor, '0500', supervisor),
    ...writeFile(GUEST_LAYOUT.shim, '0555', shim),
    ...writeFile(GUEST_LAYOUT.shimTools, '0444', shimTools),
    ...writeFile(GUEST_LAYOUT.credential, '0400', credential),
    ...transportBlock,
  ];
  return Object.freeze({ userData: `${lines.join('\n')}\n`, supervisorSha256: sha256(supervisor), shimSha256: sha256(shim), shimToolsSha256: sha256(shimTools) });
}

// Guest bootstrap readiness only: bounded waiting for cloud-init, then boundary evidence (zero mounts,
// protected supervisor and credential, locked unprivileged identities, bounded resources). bootstrapReady
// is NOT execution readiness or isolation: executionReady is always false and verified-local stays
// unavailable until certification. Facts relied on (canonical/multipass tag v1.17.0 and cloud-init):
// - src/client/cli/formatter/json_formatter.cpp generate_instance_details: image_hash is the image id,
//   cpu_count and disks.sda1.total are strings, memory.total a number; usage the guest cannot report is
//   empty or absent.
// - src/client/cli/cmd/exec.cpp: --no-map-working-directory skips the host-cwd mount mapping. ssh_client.cpp
//   quotes every argument, and exec returns the REMOTE exit code, which can collide with Multipass's own
//   2 and 3, so a denial is exactly 1, success exactly 0 and anything else unknown.
// - cloud-init cmd/status.py: exit 1 is error, 2 degraded, 0 otherwise (including running and not started).
// Probe argv are fixed constants; no caller data reaches a guest command.
import { setTimeout as delay } from 'node:timers/promises';
import { loadCertifiedProvider } from './doctor.mjs';
import { bootstrapError, GUEST_LAYOUT, GUEST_RESOURCES, IMAGE_ARCHES, JOB_IDENTITIES } from './guest-bootstrap.mjs';
import { invoker, lifecycleError, QUERY_TIMEOUT_MS, STATES } from './lifecycle.mjs';
import { classifyFailure, MAX_PROBE_BUFFER, providerError } from './multipass.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WAITING = new Set(['Starting', 'Restarting']);
const LAYOUT_PATHS = [...GUEST_LAYOUT.supervisorDirs, GUEST_LAYOUT.supervisor, GUEST_LAYOUT.credentialDir, GUEST_LAYOUT.credential];
const EXACT_MODES = new Map([[GUEST_LAYOUT.supervisor, '500:-r-x------'], [GUEST_LAYOUT.credential, '400:-r--------']]);
// A root-owned directory with no group or other write bit, as %A spells it.
const SAFE_DIR = /^d[r-][w-][xsS-][r-]-[xsS-][r-]-[xtT-]$/;
// proc(5): id parent major:minor root mount-point options [optional fields...] - fstype source super-options
const MOUNTINFO_LINE = /^\d+ \d+ \d+:\d+ \S+ \S+ \S+ (?:[^\s-]\S* )*- (\S+) \S+ \S+$/;
// Host-sharing filesystems: Multipass mounts (9p, virtiofs, sshfs over fuse) and other host or network shares.
const SHARED_FS = new Set(['9p', 'virtiofs', 'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'vboxsf', 'drvfs', 'fuse', 'fuseblk']);
const REPORTED = /^(?:PROVIDER|LEDGER|LIFECYCLE|IMAGE)_[A-Z_]+$/;
// [kind, test flag, path, failure when the identity CAN]: the credential and cloud-init's copies of it
// (raw and processed user-data, the merged cloud-config, the pickled datasource, the unredacted instance
// data, the combined config, the NoCloud seed device), then the supervisor. cloud-init's internal_files
// docs describe combined-cloud-config.json as root-readable and unredacted with user-data overrides;
// it can carry the write_files credential. Its mode on the pinned image needs R13 real-guest certification.
const DENIED = [
  ['readCredential', '-r', GUEST_LAYOUT.credential, 'CREDENTIAL_EXPOSED'],
  ['readUserData', '-r', '/var/lib/cloud/instance/user-data.txt', 'CREDENTIAL_EXPOSED'],
  ['readUserDataParts', '-r', '/var/lib/cloud/instance/user-data.txt.i', 'CREDENTIAL_EXPOSED'],
  ['readCloudConfig', '-r', '/var/lib/cloud/instance/cloud-config.txt', 'CREDENTIAL_EXPOSED'],
  ['readCachedObject', '-r', '/var/lib/cloud/instance/obj.pkl', 'CREDENTIAL_EXPOSED'],
  ['readInstanceData', '-r', '/run/cloud-init/instance-data-sensitive.json', 'CREDENTIAL_EXPOSED'],
  ['readCombinedConfig', '-r', '/run/cloud-init/combined-cloud-config.json', 'CREDENTIAL_EXPOSED'],
  ['readSeed', '-r', '/dev/sr0', 'CREDENTIAL_EXPOSED'],
  ['writeSupervisor', '-w', GUEST_LAYOUT.supervisor, 'SUPERVISOR_WRITABLE'],
  ['writeSupervisorDir', '-w', GUEST_LAYOUT.supervisorDirs[1], 'SUPERVISOR_WRITABLE'],
];

const outputLines = stdout => (stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : []);
const reported = error => (typeof error?.code === 'string' && REPORTED.test(error.code) ? error.code : 'PROBE_UNKNOWN');
// Exit 1 is the only denial; 0 means the identity CAN, and any other code is unknown.
const deny = allowed => ({ code }) => (code === 1 ? null : code === 0 ? allowed : 'PROBE_UNKNOWN');

export function mountFailure({ code, stdout }, { info }) {
  if (info.mountCount > 0) return 'MOUNTS_PRESENT';
  const lines = code === 0 ? outputLines(stdout) : [];
  const fstypes = lines.map(line => MOUNTINFO_LINE.exec(line)?.[1]);
  if (fstypes.some(fstype => fstype !== undefined && (SHARED_FS.has(fstype) || fstype.startsWith('fuse.')))) return 'MOUNTS_PRESENT';
  return lines.length === 0 || fstypes.includes(undefined) ? 'MOUNTS_UNKNOWN' : null;
}

function layoutFailure({ code, stdout }) {
  const lines = code === 0 ? outputLines(stdout) : [];
  const valid = lines.length === LAYOUT_PATHS.length && lines.every((line, at) => {
    const [user, group, mode, symbolic, file, ...extra] = line.split(':');
    if (user !== 'root' || group !== 'root' || file !== LAYOUT_PATHS[at] || extra.length > 0) return false;
    if (EXACT_MODES.has(file)) return `${mode}:${symbolic}` === EXACT_MODES.get(file);
    return /^[0-7]{3,4}$/.test(mode) && (Number.parseInt(mode, 8) & 0o022) === 0 && SAFE_DIR.test(symbolic);
  });
  return valid ? null : 'LAYOUT_INVALID';
}

const hashFailure = ({ code, stdout }, { supervisorSha256 }) =>
  (code === 0 && stdout === `${supervisorSha256}  ${GUEST_LAYOUT.supervisor}\n` ? null : 'SUPERVISOR_HASH_MISMATCH');

function lockedFailure({ code, stdout }, id) {
  const [line, ...rest] = code === 0 ? outputLines(stdout) : [];
  const [user, status] = rest.length === 0 && typeof line === 'string' ? line.split(' ') : [];
  return user === id && status === 'L' ? null : 'IDENTITY_NOT_LOCKED';
}

function identityChecks(id) {
  const as = ['sudo', '-n', '-u', id];
  return [
    // Positive control: sudo's own failure is also exit 1, so the deny probes count only if this prints id.
    [`whoami:${id}`, [...as, 'id', '--user', '--name'], ({ code, stdout }) => (code === 0 && stdout === `${id}\n` ? null : 'PROBE_UNKNOWN')],
    [`status:${id}`, ['sudo', '-n', 'passwd', '--status', id], result => lockedFailure(result, id)],
    [`groups:${id}`, ['id', '--groups', '--name', id], ({ code, stdout }) => (code === 0 && stdout === `${id}\n` ? null : 'IDENTITY_PRIVILEGED')],
    ...DENIED.map(([kind, flag, file, allowed]) => [`${kind}:${id}`, [...as, 'test', flag, file], deny(allowed)]),
    [`sudo:${id}`, [...as, 'sudo', '-n', 'true'], deny('IDENTITY_PRIVILEGED')],
    [`keys:${id}`, ['sudo', '-n', 'test', '-e', `/home/${id}/.ssh/authorized_keys`], deny('IDENTITY_LOGIN_ENABLED')],
  ];
}

// [id, fixed argv, evaluate(result, context) -> failure code or null], run once each and in this order.
const CHECKS = [
  ['mountinfo', ['cat', '/proc/self/mountinfo'], mountFailure],
  ['layout', ['sudo', '-n', 'stat', '--format=%U:%G:%a:%A:%n', ...LAYOUT_PATHS], layoutFailure],
  ['supervisorHash', ['sudo', '-n', 'sha256sum', GUEST_LAYOUT.supervisor], hashFailure],
  ...JOB_IDENTITIES.flatMap(identityChecks),
];

export const GUEST_PROBES = Object.freeze(Object.fromEntries([
  ['cloudInit', ['cloud-init', 'status', '--format', 'json']],
  ...CHECKS,
].map(([id, argv]) => [id, Object.freeze(argv)])));

function validDetail(detail) {
  if (!isRecord(detail)) return false;
  const { memory, disks, image_hash: hash, image_release: release } = detail;
  const disk = isRecord(disks) ? disks.sda1 : undefined;
  return STATES.has(detail.state) && typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash)
    && typeof release === 'string' && release.length <= 128 && !CONTROL.test(release)
    && typeof detail.cpu_count === 'string' && /^\d{0,6}$/.test(detail.cpu_count)
    && isRecord(memory) && (memory.total === undefined || (Number.isSafeInteger(memory.total) && memory.total >= 0))
    && isRecord(disk) && (disk.total === undefined || (typeof disk.total === 'string' && /^\d{1,15}$/.test(disk.total)))
    && isRecord(detail.mounts);
}

function parseInfo(stdout, name) {
  let parsed;
  try {
    if (typeof stdout === 'string' && Buffer.byteLength(stdout, 'utf8') <= MAX_PROBE_BUFFER) parsed = JSON.parse(stdout);
  } catch { parsed = undefined; }
  const info = isRecord(parsed) && Array.isArray(parsed.errors) && parsed.errors.length === 0 && isRecord(parsed.info) ? parsed.info : {};
  const keys = Object.keys(info);
  const detail = keys.length === 1 && keys[0] === name ? info[name] : undefined;
  if (!validDetail(detail)) throw Object.assign(new Error('Multipass instance info was malformed.'), { code: 'PROVIDER_INFO_INVALID' });
  return {
    state: detail.state, providerImageHash: detail.image_hash.toLowerCase(), imageRelease: detail.image_release,
    // Usage the guest cannot report yet (for example while Starting) is unknown, never zero.
    cpuCount: detail.cpu_count === '' ? null : Number(detail.cpu_count),
    memoryTotal: detail.memory.total ?? null,
    diskTotal: detail.disks.sda1.total === undefined ? null : Number(detail.disks.sda1.total),
    mountCount: Object.keys(detail.mounts).length,
  };
}

/** run is an execFile-compatible transport injected only for tests, as in R02 and R06. */
export async function readGuestInfo(name, provider = {}) {
  const invoke = invoker(name, provider);
  let result;
  try {
    result = await invoke(['info', name, '--format', 'json'], QUERY_TIMEOUT_MS);
  } catch (error) { throw providerError(classifyFailure(error)); }
  return parseInfo(result?.stdout, name);
}

/** A remote command's own exit status is a result; only Multipass or transport failures throw. */
export async function runGuestProbe(name, id, provider = {}) {
  if (typeof id !== 'string' || !Object.hasOwn(GUEST_PROBES, id)) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  const invoke = invoker(name, provider);
  let code = 0;
  let stdout;
  try {
    ({ stdout } = await invoke(['exec', '--no-map-working-directory', name, '--', ...GUEST_PROBES[id]], QUERY_TIMEOUT_MS));
  } catch (error) {
    if (!Number.isInteger(error?.code) || error.killed || typeof error.stdout !== 'string') throw providerError(classifyFailure(error));
    ({ code, stdout } = error);
  }
  if (typeof stdout !== 'string') throw providerError('PROVIDER_OUTPUT_INVALID');
  if (Buffer.byteLength(stdout, 'utf8') > MAX_PROBE_BUFFER) throw providerError('PROVIDER_OUTPUT_LIMIT');
  return { code, stdout };
}

/** cloud-init cmd/status.py: READY only for a clean exit-0 done; running or not started is still waiting. */
function cloudInitStatus({ code, stdout }) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return 'failed'; }
  if (code !== 0 || !isRecord(parsed)) return 'failed';
  const { status, extended_status: extended, errors, recoverable_errors: recoverable } = parsed;
  if ((status === 'running' || status === 'not started') && extended === status) return 'waiting';
  const clean = Array.isArray(errors) && errors.length === 0 && isRecord(recoverable) && Object.keys(recoverable).length === 0;
  return status === 'done' && extended === 'done' && clean ? 'done' : 'failed';
}

/** At most `polls` deterministic polls with sleeps only between them; Running alone is never ready. */
async function awaitCloudInit({ name, provider, sleep, pollMs, polls }) {
  let info = null;
  try {
    for (let poll = 1; ; poll += 1) {
      info = await readGuestInfo(name, provider);
      if (info.state === 'Running') {
        const status = cloudInitStatus(await runGuestProbe(name, 'cloudInit', provider));
        if (status !== 'waiting') return { info, failure: status === 'done' ? null : 'BOOTSTRAP_FAILED' };
      } else if (!WAITING.has(info.state)) return { info, failure: 'BOOTSTRAP_FAILED' };
      if (poll >= polls) return { info, failure: 'BOOTSTRAP_TIMEOUT' };
      await sleep(pollMs);
    }
  } catch (error) { return { info, failure: reported(error) }; }
}

function resourceFailure({ cpuCount, memoryTotal, diskTotal }) {
  const { cpus, memoryBytes, diskBytes } = GUEST_RESOURCES;
  const bounded = [[cpuCount, cpus], [memoryTotal, memoryBytes], [diskTotal, diskBytes]];
  if (bounded.some(([value, max]) => value !== null && value > max)) return 'RESOURCES_UNBOUNDED';
  return bounded.some(([value]) => value === null) ? 'RESOURCES_UNKNOWN' : null;
}

/** Every check runs once, in order; failures are codes only, deduplicated in first-seen order. */
async function boundaryFailures(name, provider, info, supervisorSha256) {
  const failures = new Set();
  for (const [id, , evaluate] of CHECKS) {
    let failure;
    try { failure = evaluate(await runGuestProbe(name, id, provider), { info, supervisorSha256 }); } catch (error) { failure = reported(error); }
    if (failure) failures.add(failure);
  }
  const resources = resourceFailure(info);
  if (resources) failures.add(resources);
  return [...failures];
}

/** The source image must be exactly the installed manifest pin; a caller can never mint its own. */
async function pinnedSource(sourceImage) {
  const keys = isRecord(sourceImage) ? Object.keys(sourceImage).sort().join() : '';
  if (keys !== 'arch,sha256,url' || !IMAGE_ARCHES.includes(sourceImage.arch)) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  const pin = (await loadCertifiedProvider()).images[sourceImage.arch];
  if (sourceImage.url !== pin.url || sourceImage.sha256 !== pin.sha256) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  return { arch: sourceImage.arch, url: pin.url, sha256: pin.sha256 };
}

const validInputs = ({ ledger, sleep, pollMs, maxWaitMs, bootstrap }) => isRecord(ledger)
  && typeof ledger.read === 'function' && typeof ledger.recordImage === 'function' && typeof sleep === 'function'
  && [pollMs, maxWaitMs].every(ms => Number.isSafeInteger(ms) && ms > 0)
  && typeof bootstrap?.supervisorSha256 === 'string' && /^[0-9a-f]{64}$/.test(bootstrap.supervisorSha256);

/**
 * Bootstrap readiness for an owned guest: inputs and ownership before any provider call, a bounded wait for
 * cloud-init, then every boundary probe. Only a clean run records the image identity (compare-and-swap on the
 * record read here). Probe and provider failures are reported as codes; executionReady is always false.
 */
export async function waitForGuestReady({
  ledger, name, owner, sourceImage, bootstrap, provider = {}, sleep = delay, pollMs = 5_000, maxWaitMs = 900_000,
} = {}) {
  if (!validInputs({ ledger, sleep, pollMs, maxWaitMs, bootstrap })) throw bootstrapError('BOOTSTRAP_INPUT_INVALID');
  const source = await pinnedSource(sourceImage);
  invoker(name, provider);
  const record = await ledger.read(name);
  if (owner?.taskId !== record.taskId || owner?.attemptId !== record.attemptId || owner?.generation !== record.generation) {
    throw lifecycleError('LIFECYCLE_NOT_OWNER');
  }
  if (record.phase !== 'owned') throw lifecycleError('LIFECYCLE_PHASE_INVALID');
  const { supervisorSha256 } = bootstrap;
  const { info, failure } = await awaitCloudInit({ name, provider, sleep, pollMs, polls: Math.ceil(maxWaitMs / pollMs) });
  const failures = failure ? [failure] : await boundaryFailures(name, provider, info, supervisorSha256);
  if (failures.length === 0) {
    try {
      await ledger.recordImage(record, { sourceSha256: source.sha256, providerImageHash: info.providerImageHash });
    } catch (error) { failures.push(reported(error)); }
  }
  return {
    instance: name, bootstrapReady: failures.length === 0, executionReady: false,
    image: { source, provider: info && { imageHash: info.providerImageHash, imageRelease: info.imageRelease } },
    supervisorSha256, failures,
  };
}

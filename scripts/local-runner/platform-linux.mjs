// Linux host prerequisites for owned-VM provisioning on the certified Multipass snap. Every check is read-only;
// Moe SURFACES each operator action and never runs sudo, `snap install|connect`, `multipass set|authenticate`.
// The client is pinned to /snap/bin/multipass, so another `multipass` on PATH cannot stand in for it. A missing
// or unknown capability or resource blocks: there is no emulation or host fallback. Satisfied prerequisites are
// NOT readiness or isolation certification (CQ-R13). canonical/multipass v1.17.0 snap/snapcraft.yaml: strict
// confinement; all-home is the home interface with read: all (no hidden paths); bridge/observe plugs unused.
import { execFile } from 'node:child_process';
import { stat, statfs as statFs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runDoctor } from './doctor.mjs';
import { GUEST_RESOURCES } from './guest-bootstrap.mjs';
import { MAX_PROBE_BUFFER, MAX_PROBE_TIMEOUT_MS } from './multipass.mjs';

export const HOST_DISK_HEADROOM_BYTES = 2 * 2 ** 30;
// The snap daemon's storage root, which holds the instance disks.
export const MULTIPASS_STORAGE = '/var/snap/multipass/common';
export const REQUIRED_SNAP_PLUGS = Object.freeze(['all-home', 'firewall-control', 'kvm', 'multipass-support', 'network-bind', 'network-control']);
const execute = promisify(execFile);
const SNAP = '/usr/bin/snap';
const EXECUTABLE = '/snap/bin/multipass';
// [id, requiresElevation, operator action, the doctor codes that prove it unmet]
const PROVIDER_ITEMS = [
  ['host-linux-x64', false, 'Run Moe on a Linux x64 host.', ['HOST_UNSUPPORTED']],
  ['multipass-installed', true, 'Refresh the Multipass snap so client and daemon both report 1.17.0 (requires sudo).',
    ['PROVIDER_NOT_FOUND', 'VERSION_MISMATCH', 'VERSION_UNSUPPORTED']],
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.', ['PROVIDER_ACCESS_DENIED']],
  ['driver-qemu', true, 'An administrator configures the Multipass driver to qemu; Moe never changes local.driver.', ['DRIVER_UNSUPPORTED']],
];
const SNAP_ACTION = 'Install the Multipass 1.17.0 snap from the verified Canonical publisher with strict confinement (requires sudo).';
const KVM_ACTION = 'Enable hardware virtualization in firmware and load the kvm module (requires administrator); Moe never falls back to emulation or host execution.';
const RESOURCE_ACTION = 'Free host CPU, memory or disk, or use a larger host; Moe never runs jobs on the host instead.';
const CACHE_ACTION = 'Use a non-hidden directory under your home directory for the image cache.';
const item = (id, satisfied, requiresElevation, action) => ({ id, satisfied, requiresElevation, action });
const connectAction = plugs => `Connect the required Multipass snap interfaces (requires sudo): ${plugs.map(plug => `sudo snap connect multipass:${plug}`).join('; ')}.`;
/** fn's result, or null when it throws or rejects. */
const settle = async fn => { try { return await fn(); } catch { return null; } };
/** A boolean check's answer; a throw or any other value is unknown (null). */
const known = async fn => { const answer = await settle(fn); return typeof answer === 'boolean' ? answer : null; };
// BigInt: exact for any byte count, and a non-integer, NaN or missing value throws (unknown).
const atLeast = (value, bound) => BigInt(value) >= BigInt(bound);

/** The rows of a snap CLI table under its exact header: false when snap is absent, null when unknown. */
async function snapTable(run, snapExecutable, args, header) {
  let stdout;
  try {
    ({ stdout } = await run(snapExecutable, args, {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: MAX_PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL',
    }));
  } catch (error) { return error?.code === 'ENOENT' ? false : null; }
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_PROBE_BUFFER) return null;
  const [head, ...rows] = stdout.trim().split('\n').map(line => line.trim().split(/\s+/));
  return head.join(' ') === header.join(' ') && rows.every(row => row.length === header.length) ? rows : null;
}

/** true only for one strictly confined, Canonical-verified Multipass 1.17.0 snap. */
async function probeSnap(run, snapExecutable) {
  const rows = await snapTable(run, snapExecutable, ['list', 'multipass', '--unicode=never', '--color=never'],
    ['Name', 'Version', 'Rev', 'Tracking', 'Publisher', 'Notes']);
  if (!Array.isArray(rows) || rows.length !== 1) return rows === false ? false : null;
  const [name, version, , , publisher, notes] = rows[0];
  // --unicode=never renders a verified publisher as `name**`. Any note (devmode, classic, jailmode, try,
  // disabled, broken) is weaker confinement or an inactive snap.
  return name === 'multipass' && version === '1.17.0' && publisher === 'canonical**' && notes === '-';
}

/** The required plugs with no connected slot, in sorted order; null when unknown. */
async function missingPlugs(run, snapExecutable) {
  const rows = await snapTable(run, snapExecutable, ['connections', 'multipass'], ['Interface', 'Plug', 'Slot', 'Notes']);
  if (!Array.isArray(rows)) return null;
  const connected = new Set(rows.filter(([, , slot]) => slot !== '-').map(([, plug]) => plug));
  return REQUIRED_SNAP_PLUGS.filter(plug => !connected.has(`multipass:${plug}`));
}

/** A character device at /dev/kvm; ENOENT or another file type is false, anything else unknown. */
async function kvmDevice(statDevice) {
  try { return (await statDevice('/dev/kvm')).isCharacterDevice() === true; } catch (error) { return error?.code === 'ENOENT' ? false : null; }
}

/** Strictly below home with no hidden segment ('..' also starts with '.'): the snap's home plug reads only those. */
function cacheReadable(cacheDir, home) {
  if (cacheDir === undefined || typeof home !== 'string' || !path.posix.isAbsolute(home)) return null;
  if (typeof cacheDir !== 'string' || !path.posix.isAbsolute(cacheDir)) return false;
  const relative = path.posix.relative(home, cacheDir);
  return relative !== '' && relative.split('/').every(segment => !segment.startsWith('.'));
}

/**
 * Ordered operator prerequisites, each exactly {id, satisfied, requiresElevation, action}. A failing doctor
 * code marks only its own item false; what that code cannot speak to stays null, never true.
 */
async function prerequisites({
  provider = {}, cacheDir, doctor = runDoctor, snapExecutable = SNAP, statDevice = stat, statfs = statFs,
  cpus = os.availableParallelism, freemem = os.freemem, homedir = os.homedir, host = { platform: process.platform, arch: process.arch },
} = {}) {
  const run = provider.run ?? execute;
  // Independent read-only checks run together; none can reject the batch.
  const [report, snap, missing, kvm, enoughCpus, enoughMemory, enoughDisk, cache] = await Promise.all([
    settle(() => doctor({ host, executable: provider.executable ?? EXECUTABLE, run: provider.run })),
    probeSnap(run, snapExecutable), missingPlugs(run, snapExecutable), kvmDevice(statDevice),
    known(() => atLeast(cpus(), GUEST_RESOURCES.cpus)), known(() => atLeast(freemem(), GUEST_RESOURCES.memoryBytes)),
    known(async () => {
      const { bavail, bsize } = await statfs(MULTIPASS_STORAGE);
      return atLeast(BigInt(bavail) * BigInt(bsize), GUEST_RESOURCES.diskBytes + HOST_DISK_HEADROOM_BYTES);
    }),
    known(() => cacheReadable(cacheDir, homedir())),
  ]);
  const providerReady = report?.providerReady === true;
  const code = typeof report?.code === 'string' ? report.code : null;
  const [hostItem, installed, authenticated, driver] = PROVIDER_ITEMS.map(([id, requiresElevation, action, unmet]) =>
    item(id, providerReady ? true : unmet.includes(code) ? false : null, requiresElevation, action));
  const items = [
    hostItem, item('multipass-snap', snap, true, SNAP_ACTION),
    item('snap-interfaces', missing && missing.length === 0, true, connectAction(missing?.length ? missing : REQUIRED_SNAP_PLUGS)),
    installed, authenticated, driver, item('kvm-available', kvm, true, KVM_ACTION),
    item('host-cpus', enoughCpus, false, RESOURCE_ACTION), item('host-memory', enoughMemory, false, RESOURCE_ACTION),
    item('host-disk', enoughDisk, false, RESOURCE_ACTION), item('image-cache-location', cache, false, CACHE_ACTION),
  ];
  return {
    platform: 'linux', ready: items.every(entry => entry.satisfied === true), providerCode: code, prerequisites: items,
    primaryName: providerReady ? report.primaryName ?? null : null,
  };
}

export const linuxPlatform = Object.freeze({ id: 'linux', arch: 'x64', executable: EXECUTABLE, prerequisites });

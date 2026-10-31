// macOS host prerequisites for owned-VM provisioning. Every check is read-only; Moe SURFACES each operator action and
// never runs sudo, installs, `multipass set|authenticate` or changes local.driver. The client is pinned to the symlink
// the official v1.17.0 pkg postinstall creates (packaging/macos/postinstall-multipass.sh.in). The image arch is the
// HARDWARE's: under Rosetta process.arch is x64 on Apple Silicon, but sysctl hw.optional.arm64 still reads 1 (an Intel
// Mac lacks that oid, so -i prints nothing). Satisfied prerequisites are NOT support certification (native smoke, CQ-R13).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDoctor } from './doctor.mjs';
import { MAX_PROBE_BUFFER, MAX_PROBE_TIMEOUT_MS, probeMultipass } from './multipass.mjs';

// Mirrors the darwin hosts of certified-provider.json (a test guards the drift).
export const MACOS_SUPPORT_MATRIX = Object.freeze([Object.freeze({ arch: 'x64', driver: 'qemu' }), Object.freeze({ arch: 'arm64', driver: 'qemu' })]);
const execute = promisify(execFile);
const EXECUTABLE = '/usr/local/bin/multipass';
// [id, requiresElevation, operator action, the doctor codes that prove it unmet]
const PROVIDER_ITEMS = [
  ['multipass-installed', true, 'Install Multipass 1.17.0 for macOS (+mac package) as an administrator.', ['PROVIDER_NOT_FOUND', 'VERSION_MISMATCH', 'VERSION_UNSUPPORTED']],
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.', ['PROVIDER_ACCESS_DENIED']],
];
const DRIVER_ACTION = 'An administrator configures the Multipass driver to qemu; Moe never changes local.driver.';
/** Only a short lowercase token may appear in an action; anything else is 'unknown'. */
const token = value => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : 'unknown');
const settle = async fn => { try { return await fn(); } catch { return null; } };

/** 'arm64' or 'x64' from one bounded sysctl; anything else, or a failure, is unknown (null). Never throws. */
export async function detectHostArch({ run = execute, sysctlExecutable = '/usr/sbin/sysctl', processArch = process.arch } = {}) {
  const stdout = await settle(async () => (await run(sysctlExecutable, ['-in', 'hw.optional.arm64'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: MAX_PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL',
  }))?.stdout);
  const answer = typeof stdout === 'string' && Buffer.byteLength(stdout, 'utf8') <= MAX_PROBE_BUFFER ? stdout.trim() : null;
  if (answer === '1') return 'arm64';
  return (answer === '' || answer === '0') && processArch === 'x64' ? 'x64' : null;
}

/** Ordered items, each exactly {id, satisfied, requiresElevation, action}. A failing doctor code marks only its own
 * item false; what that code cannot speak to stays null, never true. */
async function prerequisites({
  provider = {}, doctor = runDoctor, probe = probeMultipass, sysctlExecutable, host = { platform: process.platform, arch: process.arch },
} = {}) {
  const darwin = host?.platform === 'darwin';
  const arch = darwin ? await detectHostArch({ run: provider.run, sysctlExecutable, processArch: host.arch }) : null;
  const observed = `${token(host?.platform)}/${arch ?? token(host?.arch)}`;
  const [executable, hostArch] = [provider.executable ?? EXECUTABLE, arch ?? host?.arch];
  const report = await settle(() => doctor({ host: { platform: host?.platform, arch: hostArch }, executable, run: provider.run }));
  const providerReady = report?.providerReady === true;
  const code = typeof report?.code === 'string' ? report.code : null;
  // The driver token only NAMES the refused combination; the doctor already refused it.
  const driver = code === 'DRIVER_UNSUPPORTED' ? token(await settle(async () => (await probe({ executable, run: provider.run }))?.driver?.trim())) : null;
  const certified = MACOS_SUPPORT_MATRIX.filter(entry => entry.arch === hostArch).map(entry => entry.driver).join(', ') || 'none';
  const satisfied = unmet => (providerReady ? true : unmet.includes(code) ? false : null);
  const items = [
    { id: 'host-macos', satisfied: arch ? true : darwin && MACOS_SUPPORT_MATRIX.some(entry => entry.arch === host.arch) ? null : false, requiresElevation: false,
      action: `Run Moe on a certified Mac (darwin/x64 or darwin/arm64); this host is ${observed}.` },
    ...PROVIDER_ITEMS.map(([id, requiresElevation, action, unmet]) => ({ id, satisfied: satisfied(unmet), requiresElevation, action })),
    { id: 'host-provider-combination', satisfied: satisfied(['DRIVER_UNSUPPORTED']), requiresElevation: true,
      action: driver ? `${observed} + ${driver} is not a certified combination (certified: ${certified}); Moe never changes local.driver.` : DRIVER_ACTION },
  ];
  return {
    platform: 'darwin', arch, ready: items.every(item => item.satisfied === true), providerCode: code, prerequisites: items,
    primaryName: providerReady ? report.primaryName ?? null : null, certification: 'not-established',
  };
}

export const macosPlatform = Object.freeze({ id: 'darwin', arch: null, executable: EXECUTABLE, prerequisites });

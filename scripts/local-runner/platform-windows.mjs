// Windows host prerequisites for owned-VM provisioning. Moe SURFACES each operator action and never
// performs one: it never elevates, runs as another user, enables Windows features, runs `multipass set`
// or `multipass authenticate`, or changes local.driver. Every check is read-only (the R02 doctor and one
// non-elevated CIM query). HypervisorPresent can be true where only the Virtual Machine Platform is on
// (for example Home editions), and hcs launches still fail there; R06 bounds those retries. Satisfied
// prerequisites are NOT readiness or isolation certification: real-hardware evidence is CQ-R13.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { runDoctor } from './doctor.mjs';
import { MAX_PROBE_BUFFER, MAX_PROBE_TIMEOUT_MS } from './multipass.mjs';

const execute = promisify(execFile);
const HYPERVISOR_QUERY = ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent'];
// [id, requiresElevation, operator action, the doctor codes that prove it unmet]
const PROVIDER_ITEMS = [
  ['host-windows-x64', false, 'Run Moe on a Windows x64 host.', ['HOST_UNSUPPORTED']],
  ['multipass-installed', true, 'Install Multipass 1.17.0 for Windows (+win build) as an Administrator.',
    ['PROVIDER_NOT_FOUND', 'VERSION_MISMATCH', 'VERSION_UNSUPPORTED']],
  // An administrator sets local.passphrase; the user then authenticates their own client.
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.',
    ['PROVIDER_ACCESS_DENIED']],
  ['driver-hcs', true, 'An administrator configures the Multipass driver to hcs; Moe never changes local.driver.', ['DRIVER_UNSUPPORTED']],
];
const HYPER_V = { id: 'hyper-v', requiresElevation: true, action: 'Enable Hyper-V as an Administrator and reboot.' };

/** true or false only for an exact PowerShell answer; any failure or other output is unknown (null). */
export async function probeHypervisor({ run = execute } = {}) {
  const root = /^[A-Za-z]:\\/.test(process.env.SystemRoot ?? '') ? process.env.SystemRoot : 'C:\\Windows';
  const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await run(powershell, [...HYPERVISOR_QUERY], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: MAX_PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL',
    });
    const answer = typeof stdout === 'string' && Buffer.byteLength(stdout, 'utf8') <= MAX_PROBE_BUFFER ? stdout.trim() : '';
    return answer === 'True' ? true : answer === 'False' ? false : null;
  } catch { return null; }
}

/**
 * Ordered operator prerequisites, each exactly {id, satisfied, requiresElevation, action}. A failing doctor
 * code marks only its own item false; what that code cannot speak to stays null, never true.
 */
async function prerequisites({
  provider = {}, doctor = runDoctor, hypervisor = probeHypervisor, host = { platform: process.platform, arch: process.arch },
} = {}) {
  const report = await doctor({ host, executable: provider.executable, run: provider.run });
  const providerReady = report?.providerReady === true;
  const code = typeof report?.code === 'string' ? report.code : null;
  // An unsupported host never gets a PowerShell probe.
  const hv = code === 'HOST_UNSUPPORTED' ? null : await hypervisor({ run: provider.run });
  const hyperV = typeof hv === 'boolean' ? hv : null;
  const items = PROVIDER_ITEMS.map(([id, requiresElevation, action, unmet]) => ({
    id, satisfied: providerReady ? true : unmet.includes(code) ? false : null, requiresElevation, action,
  }));
  items.push({ id: HYPER_V.id, satisfied: hyperV, requiresElevation: HYPER_V.requiresElevation, action: HYPER_V.action });
  return {
    platform: 'win32', ready: providerReady && hyperV === true, providerCode: code, prerequisites: items,
    primaryName: providerReady ? report.primaryName ?? null : null,
  };
}

export const windowsPlatform = Object.freeze({ id: 'win32', arch: 'x64', prerequisites });

// Prerequisite probes only. This adapter cannot provision, mount, or run guest code.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MAX_PROBE_BUFFER = 65_536;
export const MAX_PROBE_TIMEOUT_MS = 10_000;
const execute = promisify(execFile);
const COMMANDS = [['version', '--format', 'json'], ['get', 'local.driver'], ['get', 'client.primary-name']];
const MESSAGES = {
  PROVIDER_NOT_FOUND: 'Multipass executable was not found; install the certified provider explicitly.',
  PROVIDER_ACCESS_DENIED: 'Multipass access was denied; authenticate the trusted host controller explicitly.',
  PROVIDER_TIMEOUT: 'Multipass prerequisite probe timed out.',
  PROVIDER_OUTPUT_LIMIT: 'Multipass prerequisite output exceeded the permitted size.',
  PROVIDER_COMMAND_FAILED: 'Multipass prerequisite command failed.',
  PROVIDER_OUTPUT_INVALID: 'Multipass prerequisite output was malformed.',
  PROVIDER_INPUT_INVALID: 'A nonempty executable path without control characters is required.',
};

export function providerError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'PROVIDER_COMMAND_FAILED';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

function classifyFailure(error) {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'PROVIDER_OUTPUT_LIMIT';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'PROVIDER_TIMEOUT';
  if (error?.code === 'ENOENT') return 'PROVIDER_NOT_FOUND';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'PROVIDER_ACCESS_DENIED';
  const diagnostic = typeof error?.stderr === 'string' ? error.stderr.slice(0, MAX_PROBE_BUFFER) : '';
  if (/not authenticated|permission denied|access denied|authenticate.*(?:service|passphrase)/i.test(diagnostic)) return 'PROVIDER_ACCESS_DENIED';
  return 'PROVIDER_COMMAND_FAILED';
}

function boundedText(value) {
  if (typeof value !== 'string') throw providerError('PROVIDER_OUTPUT_INVALID');
  if (Buffer.byteLength(value, 'utf8') > MAX_PROBE_BUFFER) throw providerError('PROVIDER_OUTPUT_LIMIT');
  return value;
}

/** run is an execFile-compatible promise transport, injected only for tests. */
export async function probeMultipass({ executable = 'multipass', run = execute } = {}) {
  if (typeof executable !== 'string' || executable.trim() === '' || /[\x00-\x1f\x7f]/.test(executable)) {
    throw providerError('PROVIDER_INPUT_INVALID');
  }
  const output = [];
  for (const args of COMMANDS) {
    let result;
    try {
      result = await run(executable, [...args], {
        encoding: 'utf8', shell: false, windowsHide: true,
        timeout: MAX_PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL',
      });
    } catch (error) { throw providerError(classifyFailure(error)); }
    const stdout = boundedText(result?.stdout);
    boundedText(result?.stderr);
    output.push(stdout);
  }
  return { versionJson: output[0], driver: output[1], primaryName: output[2] };
}

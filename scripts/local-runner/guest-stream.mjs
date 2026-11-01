// One supervisor stream over the pinned in-box OpenSSH client to the owned guest's forced-command supervisor (CQ-R14d1,
// DESIGN comment-350cb4d0 on task-fd196d13). Multipass 1.17.0 `exec` stdio truncates stdin on Linux (#5478), delivers
// none on Windows (#3749) and stalls Windows stdout near 2 MiB, so a stream never falls back to it, or to the host.
// Its own module because guest-ssh.mjs is a leaf and readGuestInfo's module imports modules that import guest-ssh: this
// one imports both, and nothing imports it back.
import { spawn as spawnProcess } from 'node:child_process';
import { readGuestInfo } from './guest-readiness.mjs';
import { defaultKeyDir, sshExecutable, sshStreamArgv, SUPERVISOR_MODES, transportError, transportFiles } from './guest-ssh.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * Spawns the ssh client with exactly sshStreamArgv for one supervisor `mode`, piped stdio, and returns the child. The
 * address is the guest's multipass info ipv4[0], read fresh on every call. Before any spawn it refuses with
 * TRANSPORT_INPUT_INVALID (name, mode, provider, client path, spawn or key path) or TRANSPORT_ADDRESS_UNKNOWN (info
 * failed or holds no valid IPv4). A synchronous spawn throw propagates; each caller maps it to its own *_SPAWN_FAILED.
 * provider: { executable, run } for info as in readGuestInfo, plus ssh, keyDir and spawn, each optional.
 */
export async function openGuestStream(options) {
  const { name, mode, provider = {} } = options ?? {};
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider) || !SUPERVISOR_MODES.includes(mode)) {
    throw transportError('TRANSPORT_INPUT_INVALID');
  }
  const executable = provider.ssh ?? sshExecutable(process.platform);
  const spawn = provider.spawn ?? spawnProcess;
  if (typeof executable !== 'string' || executable.trim() === '' || CONTROL.test(executable) || typeof spawn !== 'function') {
    throw transportError('TRANSPORT_INPUT_INVALID');
  }
  let files;
  try { files = transportFiles(name, provider.keyDir ?? defaultKeyDir()); } catch { throw transportError('TRANSPORT_INPUT_INVALID'); }
  let address = null;
  try { ({ address } = await readGuestInfo(name, provider)); } catch { address = null; }
  if (typeof address !== 'string') throw transportError('TRANSPORT_ADDRESS_UNKNOWN');
  const argv = sshStreamArgv({ ...files, name, address, mode });
  return spawn(executable, argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

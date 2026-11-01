// The fixed pieces of the host-guest stream channel (DESIGN comment-350cb4d0 on task-fd196d13): Multipass 1.17.0 breaks
// `multipass exec` stdio, so every supervisor stream runs over the in-box OpenSSH client straight to the guest's sshd.
// This module starts no process, calls no provider and writes no file; its callers do that with what it returns.
// LEAF rule: it imports only node built-ins. guest-bootstrap, lifecycle and guest-stream import it, and an import back
// would be an ESM cycle. So it restates the owned-name rule (lifecycle.mjs isOwnedInstanceName) and the supervisor
// path (guest-bootstrap.mjs GUEST_LAYOUT.supervisor); the bridge tests check both against the originals.
// OpenSSH facts this relies on:
// - `-F none` ignores every user and system config file;
// - IdentityFile and UserKnownHostsFile get %-token and ${ENV} expansion, and a `-o` value splits on whitespace and
//   takes backslash escapes unless double-quoted, so a path carrying any of those bytes is refused;
// - sshd un-escapes \" inside an authorized_keys command="..." option;
// - guest-supervisor.py main() accepts exactly SUPERVISOR_MODES and exits 64 for anything else, so the quoted
//   "$SSH_ORIGINAL_COMMAND" (one argv word) needs no second allowlist.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SUPERVISOR_MODES = Object.freeze(['bridge', 'check', 'materialize', 'export', 'verify', 'agents', 'toolchain', 'dependencies']);
export const AUTHORIZED_COMMAND = 'exec /usr/bin/sudo -n /opt/moe/bin/moe-supervisor "$SSH_ORIGINAL_COMMAND"';

// Fixed messages: none carries a path, key, address or caller value.
const MESSAGES = Object.freeze({
  TRANSPORT_INPUT_INVALID: 'Guest transport input was invalid.',
  TRANSPORT_ADDRESS_UNKNOWN: 'The guest transport address could not be established.',
});
const OWNED_NAME = /^moe-vm-[0-9a-f]{20}$/;
const ED25519_PUBLIC = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const SSH_UNSAFE = /[%$"'`\x00-\x1f\x7f]/;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
// A drive-absolute environment root (letter, colon, backslash), else the default: the platform-windows.mjs rule.
const driveRoot = (value, fallback) => (/^[A-Za-z]:\\/.test(value ?? '') ? value : fallback);

export function transportError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'TRANSPORT_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

const invalid = () => transportError('TRANSPORT_INPUT_INVALID');
const ownedName = name => {
  if (typeof name !== 'string' || !OWNED_NAME.test(name)) throw invalid();
  return name;
};
const ed25519Public = publicKey => {
  if (typeof publicKey !== 'string' || !ED25519_PUBLIC.test(publicKey)) throw invalid();
  return publicKey;
};

const u32 = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(n); return bytes; };
const str = value => { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); };

// One fresh pair as an unencrypted openssh-key-v1 private key (what both ssh and sshd load) and its public line.
function ed25519Pair() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const pub = Buffer.from(jwk.x, 'base64url');
  const seed = Buffer.from(jwk.d, 'base64url');
  const blob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  const plain = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str('')]);
  const padding = Buffer.from(Array.from({ length: (8 - (plain.length % 8)) % 8 }, (_, i) => i + 1));
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(blob),
    str(Buffer.concat([plain, padding]))]);
  const lines = body.toString('base64').match(/.{1,70}/g).join('\n');
  return Object.freeze({
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
  });
}

/** Two fresh ed25519 pairs: the per-VM client identity and the guest's pinned host key. */
export function createTransportKeys() {
  return Object.freeze({ client: ed25519Pair(), host: ed25519Pair() });
}

/** The guest's one authorized_keys line: no PTY or forwarding, and only the supervisor runs. */
export function authorizedKeyLine(publicKey) {
  return `restrict,command="${AUTHORIZED_COMMAND.replaceAll('"', '\\"')}" ${ed25519Public(publicKey)} moe-transport`;
}

/** The pinned known_hosts line, matched through HostKeyAlias=<name>. */
export function knownHostsLine(name, publicKey) {
  return `${ownedName(name)} ${ed25519Public(publicKey)}`;
}

/** The in-box client at a pinned path, never a PATH lookup; null where no client is certified. */
export function sshExecutable(platformId) {
  if (platformId === 'linux' || platformId === 'darwin') return '/usr/bin/ssh';
  if (platformId !== 'win32') return null;
  return path.win32.join(driveRoot(process.env.SystemRoot, 'C:\\Windows'), 'System32', 'OpenSSH', 'ssh.exe');
}

/** Never ~/.moe/runner-keys: that is the daemon's runner-channel HMAC store. */
export function defaultKeyDir() {
  return path.join(os.homedir(), '.moe', 'guest-ssh');
}

export function transportFiles(name, keyDir) {
  ownedName(name);
  if (typeof keyDir !== 'string' || !path.isAbsolute(keyDir) || CONTROL.test(keyDir)) throw invalid();
  return Object.freeze({ identityFile: path.join(keyDir, `${name}.key`), knownHostsFile: path.join(keyDir, `${name}.known_hosts`) });
}

/** A strict dotted-quad IPv4 (octets 0-255, no leading zeros), else null. */
export function guestAddress(value) {
  return typeof value === 'string' && IPV4.test(value) ? value : null;
}

// A drive-absolute path with / separators, or a POSIX-absolute path with no backslash and no UNC-shaped // start (a
// Windows client would open //host/share over SMB); nothing OpenSSH expands or splits.
function sshPath(value) {
  if (typeof value !== 'string' || SSH_UNSAFE.test(value)) throw invalid();
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replaceAll('\\', '/');
  if (!path.posix.isAbsolute(value) || value.startsWith('//') || value.includes('\\')) throw invalid();
  return value;
}

/** The hardened argv (after the client path) for one supervisor stream. */
export function sshStreamArgv(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const { name, address, identityFile, knownHostsFile, mode } = input;
  ownedName(name);
  if (guestAddress(address) === null || !SUPERVISOR_MODES.includes(mode)) throw invalid();
  const key = sshPath(identityFile);
  const kh = sshPath(knownHostsFile);
  return Object.freeze(['-F', 'none', '-T', '-e', 'none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile="${kh}"`, '-o', `GlobalKnownHostsFile="${kh}"`, '-o', `HostKeyAlias=${name}`,
    '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'CheckHostIP=no', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-i', key, '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-l', 'ubuntu', address, mode]);
}

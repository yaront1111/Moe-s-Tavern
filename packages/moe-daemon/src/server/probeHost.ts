// The address a local probe dials for a daemon's recorded bindHost. The daemon lifecycle (index.ts) and
// `moe-daemon doctor` (commands/doctor.ts) share this module, so the dial rule cannot drift between them.
// Keep the default os, dns, net and fs imports: index.test.ts spies on the first three module objects (task-d6ebe4ab),
// and doctor.test.ts stubs /proc/net/route through fs.readFileSync (task-d7b24cab).
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { logger } from '../util/logger.js';
import type { DaemonInfo } from '../types/schema.js';
import { WSL_BIND_HOST } from './bindHosts.js';

export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Address local probes (port scans, readiness checks) should connect to for a
 * given bind host. Wildcard and WSL binds include loopback; a specific address does not.
 */
export function probeHostFor(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' || bindHost === WSL_BIND_HOST ? DEFAULT_BIND_HOST : bindHost;
}

/** The host a probe of daemon.json's own bindHost dials; healthProbeAddress resolves a name to one literal. */
export function recordedProbeHost(info: Pick<DaemonInfo, 'bindHost'>): string {
  return info.bindHost ? probeHostFor(info.bindHost) : DEFAULT_BIND_HOST;
}

/**
 * True when `address`, an IP literal, is this machine: loopback (127.0.0.0/8 or ::1, IPv4-mapped forms included) or an
 * address one of its network interfaces holds. A peer on the same subnet is not, so exact addresses are added, never
 * subnets. A zoned literal never is: BlockList.check drops the %zone, but the zone picks the link that is dialed, so
 * with eth0 holding fe80::a, fe80::a%docker0 reaches a peer on docker0's link (and a Moe daemon's /health refuses a
 * zoned Host). daemon.json is repository content, and a /health answer from any other host could name any pid, so its
 * bindHost is dialed only at such an address (task-d6ebe4ab). When the interfaces cannot be read, only loopback counts.
 */
export function isLocalAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const local = new net.BlockList();
  local.addSubnet('127.0.0.0', 8, 'ipv4');
  local.addAddress('::1', 'ipv6');
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const { address: own } of entries ?? []) local.addAddress(own, net.isIPv6(own) ? 'ipv6' : 'ipv4');
    }
  } catch (error) {
    logger.debug({ error }, 'Could not read the network interfaces; only loopback counts as this machine');
  }
  return local.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/**
 * The IP literal a health probe should dial for `target`. The /health Host rule (server/healthHost.ts)
 * admits IP literals and localhost, never a configured name, so a daemon bound by name is probed at the
 * address that name resolves to: that literal is the Host Node sends, and it is the connection's arrival
 * address, which the rule admits. Admitting the configured name instead would trust whoever controls its DNS.
 * Null when the lookup fails or outlasts the probe timeout, and for a non-string `target`: daemon.json's bindHost
 * is unchecked JSON, and net.isIP coerces, so `["192.0.2.10"]` would pass as a literal (task-d6ebe4ab).
 */
export async function healthProbeAddress(target: string, timeoutMs: number): Promise<string | null> {
  if (typeof target !== 'string') return null;
  if (net.isIP(target) !== 0) return target;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
    });
    const resolved = dns.promises.lookup(target).then((found) => found.address, () => null);
    return await Promise.race([resolved, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when daemon.json was written on the other side of the WSL/Windows
 * boundary: a drive or UNC projectPath read outside Windows, or a POSIX one read
 * on Windows. The writer's pid lives in another pid namespace, so
 * `process.kill(pid, 0)` proves nothing either way and only /health may judge
 * it. Mirrors moe-agent.sh's pre-flight, which detects a Windows-owned
 * daemon.json by its drive-letter projectPath. A relative projectPath (only a
 * daemon before task-78fa7110 recorded one) names no side, so it stays local.
 */
export function isForeignDaemonInfo(info: Pick<DaemonInfo, 'projectPath'>, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? /^\/(?![\\/])/.test(info.projectPath)
    : /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(info.projectPath);
}

/**
 * The WSL default gateway (the Windows host in NAT mode), read from
 * /proc/net/route without spawning anything; null on any error. Node twin of
 * moe-agent.sh wsl_gateway_host (`ip route show default`).
 */
export function wslGatewayHost(): string | null {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf-8').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway ?? '') || /^0{8}$/.test(gateway)) continue;
      // Little-endian hex: 01D01AAC is 172.26.208.1.
      return gateway.match(/../g)!.reverse().map((byte) => parseInt(byte, 16)).join('.');
    }
  } catch { /* not Linux, or no procfs */ }
  return null;
}

/**
 * The addresses, in order, that a /health probe asks for a daemon.json from the other side of the WSL boundary
 * (isForeignDaemonInfo): its recorded bindHost when that is this machine (loopback under mirrored networking), then on
 * Linux the WSL gateway (NAT mode), which the routing table names rather than the repository. The daemon lifecycle
 * (index.ts validateDaemonInfoForProject) and `moe-daemon doctor` both ask exactly these. Never throws: a non-string,
 * failed or slow bindHost lookup gives no recorded address, and an unreadable routing table gives no gateway.
 */
export async function foreignProbeHosts(info: Pick<DaemonInfo, 'bindHost'>, timeoutMs: number): Promise<string[]> {
  const recorded = await healthProbeAddress(recordedProbeHost(info), timeoutMs);
  const hosts = recorded !== null && isLocalAddress(recorded) ? [recorded] : [];
  // Read at call time: index.test.ts flips process.platform to play the other side.
  const gateway = process.platform === 'linux' ? wslGatewayHost() : null;
  if (gateway && !hosts.includes(gateway)) hosts.push(gateway);
  return hosts;
}

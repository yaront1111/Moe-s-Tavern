// The address a local probe dials for a daemon's recorded bindHost. The daemon lifecycle (index.ts) and
// `moe-daemon doctor` (commands/doctor.ts) share this module, so the dial rule cannot drift between them.
// Keep the default os, dns and net imports: index.test.ts spies on those module objects (task-d6ebe4ab).
import dns from 'dns';
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

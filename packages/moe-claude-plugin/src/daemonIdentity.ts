// =============================================================================
// daemonIdentity - is the daemon behind daemon.json serving this project?
// =============================================================================
//
// A twin of moe-proxy's check (comparableProjectPath in
// packages/moe-proxy/src/utils.ts, probeDaemonIdentity in
// packages/moe-proxy/src/daemonIdentity.ts). The plugin ships on its own and
// cannot import the proxy; tests/daemonIdentity.test.ts holds the two to the
// same keys.
//
// daemon.json only proves which project wrote it: once that project's daemon
// dies, another project's daemon can take the port. The daemon's /health names
// the project it serves. 'unknown' (no answer, an older daemon with no
// projectPath, any surprise) proceeds; only a positive answer naming another
// project is 'foreign'.

import dns from 'node:dns';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';

const WINDOWS_FORM = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const WSL_SHARE = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i;
const MNT_DRIVE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

/**
 * The cross-platform project-path comparison key (see moe-proxy's
 * comparableProjectPath for the contract): `D:\x`, `d:/x/` and `/mnt/d/x` are
 * one project, as are a WSL share and its POSIX path. Comparison only.
 */
export function comparableProjectPath(projectPath: string): string {
  const raw = projectPath.trim();
  const abs = WINDOWS_FORM.test(raw) || raw.startsWith('/') ? raw : path.resolve(raw);
  if (!WINDOWS_FORM.test(abs)) return posixKey(abs);
  const s = abs.replace(/\\/g, '/');
  const share = WSL_SHARE.exec(s);
  if (share) return posixKey(share[1] ?? '/');
  const unc = s.startsWith('//');
  return ((unc ? '//' : '') + collapse(s, unc ? 2 : 1)).toLowerCase();
}

function posixKey(p: string): string {
  const key = '/' + collapse(p, 0);
  const mnt = MNT_DRIVE.exec(key);
  return mnt ? `${mnt[1]}:${mnt[2] ? `/${mnt[2]}` : ''}`.toLowerCase() : key;
}

/** Drops empty and '.' segments; '..' never pops the first `keep` (drive, or UNC server and share). */
function collapse(p: string, keep: number): string {
  const kept: string[] = [];
  for (const segment of p.split('/').filter((s) => s !== '' && s !== '.')) {
    if (segment !== '..') kept.push(segment);
    else if (kept.length > keep) kept.pop();
  }
  return kept.join('/');
}

export function isSameProjectPath(a: string, b: string): boolean {
  return comparableProjectPath(a) === comparableProjectPath(b);
}

export type DaemonIdentity = 'same' | 'foreign' | 'unknown';

/** The daemon answers 200 when healthy and 503 when a check fails; both name the project. */
const HEALTH_STATUS_CODES = new Set([200, 503]);
const MAX_HEALTH_BODY_BYTES = 64 * 1024;

/** A drive-letter, UNC or POSIX absolute path, whatever OS we run on. */
function isAbsoluteAnyOs(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\{2}[^\\/]|\/)/.test(value);
}

function classify(statusCode: number | undefined, body: string, projectPath: string): DaemonIdentity {
  if (statusCode === undefined || !HEALTH_STATUS_CODES.has(statusCode)) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unknown';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown';
  const served = (parsed as { projectPath?: unknown }).projectPath;
  if (typeof served !== 'string' || !isAbsoluteAnyOs(served)) return 'unknown';
  return isSameProjectPath(served, projectPath) ? 'same' : 'foreign';
}

/**
 * Ask the daemon at host:port (the address the client dials) which project it
 * serves. Never rejects; bounded by timeoutMs and MAX_HEALTH_BODY_BYTES.
 */
export function probeDaemonIdentity(
  host: string,
  port: number,
  projectPath: string,
  timeoutMs: number
): Promise<DaemonIdentity> {
  return new Promise((resolve) => {
    let done = false;
    let req: http.ClientRequest | null = null;
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(identity: DaemonIdentity): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(identity);
    }

    function request(address: string): void {
      if (done) return;
      req = http.request({ hostname: address, port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HEALTH_BODY_BYTES) {
            finish('unknown');
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(classify(res.statusCode, Buffer.concat(chunks).toString('utf-8'), projectPath)));
        res.on('error', () => finish('unknown'));
        res.on('aborted', () => finish('unknown'));
      });
      req.on('timeout', () => finish('unknown'));
      req.on('error', () => finish('unknown'));
      req.end();
    }

    try {
      // The daemon's /health admits only an IP literal or localhost as Host,
      // so a host name is resolved and its address dialed (as moe-proxy does).
      if (isIP(host) !== 0 || host === 'localhost') request(host);
      else dns.promises.lookup(host).then(({ address }) => request(address), () => finish('unknown'));
    } catch {
      finish('unknown');
    }
  });
}

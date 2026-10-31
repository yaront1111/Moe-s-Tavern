// =============================================================================
// Daemon identity probe
// =============================================================================
//
// daemon.json only proves which project WROTE the file. A stale file always
// matches its own project, so once that project's daemon dies and another
// project's daemon takes the port, readDaemonInfoResult still approves it and
// the proxy bridges a seat to the wrong project's board (task-e7f4026a). The
// daemon's /health reports the project it actually serves, so ask it.
//
// 'unknown' means "could not tell": unreachable, timeout, non-JSON, oversize,
// an unexpected status, an older daemon with no projectPath, or a relative one.
// The caller treats it exactly like 'same', so the reconnect path (a daemon
// mid-restart answers nothing) and older daemons keep working. Only a positive
// answer naming another project is 'foreign'.

import http from 'http';
import { isIPv6 } from 'net';
import { comparableProjectPath } from './utils.js';

export type DaemonIdentity =
  | { kind: 'same' }
  | { kind: 'foreign'; projectPath: string }
  | { kind: 'unknown' };

/** Same cap as daemon.json and the daemon's own probeDaemonHealth. */
export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

/** /health is local and answers in milliseconds; a wrapper RPC spawns a proxy per call. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** The daemon answers 200 when healthy and 503 when a check fails; both name the project. */
const HEALTH_STATUS_CODES = new Set([200, 503]);

const UNKNOWN: DaemonIdentity = { kind: 'unknown' };

/**
 * A drive-letter, UNC or POSIX absolute path, whatever OS we run on:
 * path.isAbsolute is per-OS and rejects 'D:\x' on Linux. The daemon reports its
 * raw --project argument, so a relative value ('.', 'sub/proj') is possible and
 * must not be resolved against our own cwd.
 */
export function isAbsoluteAnyOs(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\{2}[^\\/]|\/)/.test(value);
}

const MAX_DISPLAY_PATH_CHARS = 300;

/**
 * A served projectPath comes from whatever answered the port, up to 64 KiB of
 * it. Keep it to one bounded line before it reaches stderr or an error message.
 */
export function displayServedPath(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]/g, '?');
  return oneLine.length > MAX_DISPLAY_PATH_CHARS ? `${oneLine.slice(0, MAX_DISPLAY_PATH_CHARS)}...` : oneLine;
}

function classify(statusCode: number | undefined, body: string, projectPath: string): DaemonIdentity {
  if (statusCode === undefined || !HEALTH_STATUS_CODES.has(statusCode)) return UNKNOWN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return UNKNOWN;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return UNKNOWN;
  const served = (parsed as { projectPath?: unknown }).projectPath;
  if (typeof served !== 'string' || !isAbsoluteAnyOs(served)) return UNKNOWN;
  return comparableProjectPath(served) === comparableProjectPath(projectPath)
    ? { kind: 'same' }
    : { kind: 'foreign', projectPath: served };
}

/**
 * Ask the daemon at host:port which project it serves. Never rejects and is
 * bounded by timeoutMs and MAX_HEALTH_BODY_BYTES, so a black-holed host or a
 * server that trickles bytes cannot hang connect().
 */
export function probeDaemonIdentity(
  host: string,
  port: number,
  projectPath: string,
  options: { timeoutMs?: number } = {},
): Promise<DaemonIdentity> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let req: http.ClientRequest | null = null;
    const timer: NodeJS.Timeout = setTimeout(() => finish(UNKNOWN), timeoutMs);

    function finish(identity: DaemonIdentity): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(identity);
    }

    try {
      // Ask the endpoint ws dials for `ws://${host}:${port}/mcp`, not the raw
      // arguments: WHATWG URL strips TAB/LF/CR, percent-decodes the host, drops
      // userinfo and honors a port spelled inside the host, and http.request does
      // none of that. A bare IPv6 literal is not URL syntax, so bracket it first.
      // Copy only hostname and port: the URL object itself would turn userinfo
      // into an Authorization header and carry its path along.
      const url = new URL(`ws://${isIPv6(host) ? `[${host}]` : host}:${port}/mcp`);
      const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      req = http.request({ hostname, port: url.port || 80, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HEALTH_BODY_BYTES) {
            finish(UNKNOWN);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(classify(res.statusCode, Buffer.concat(chunks).toString('utf-8'), projectPath)));
        res.on('error', () => finish(UNKNOWN));
        res.on('aborted', () => finish(UNKNOWN));
      });
      req.on('timeout', () => finish(UNKNOWN));
      req.on('error', () => finish(UNKNOWN));
      req.end();
    } catch {
      // new URL() throws on a host ws cannot parse either (no socket opens there),
      // and http.request throws synchronously on an invalid port.
      finish(UNKNOWN);
    }
  });
}

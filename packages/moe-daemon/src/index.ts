#!/usr/bin/env node

// =============================================================================
// Moe Daemon - Entry Point
// =============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import dns from 'dns';
import http from 'http';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { StateManager } from './state/StateManager.js';
import { FileWatcher } from './state/FileWatcher.js';
import { healMassDeletion } from './state/massDeletionHeal.js';
import { McpAdapter } from './server/McpAdapter.js';
import { MoeWebSocketServer } from './server/WebSocketServer.js';
import { ensureRunnerKey } from './server/runnerChannel.js';
import { WSL_BIND_HOST, resolveBindHosts, listenOnHosts } from './server/bindHosts.js';
import { isAllowedHealthHost } from './server/healthHost.js';
import { backfillTaskMetrics } from './state/backfills/backfillTaskMetrics.js';
import { reconcileRunningAttempts } from './state/attemptStore.js';
import { runDoctor } from './commands/doctor.js';
import { runCheckArchitecture } from './commands/checkArchitecture.js';
import { logger } from './util/logger.js';
import { VERSION } from './util/version.js';
import { writeInitFiles } from './generated/initFiles.js';
import { writeSkillFiles } from './generated/skillFiles.js';
import { linkClaudeSkills } from './util/claudeSkills.js';
import { escapeJsonForFile } from './util/atomicWrite.js';
import { readDaemonJsonText } from './util/daemonJsonFile.js';
import { clearAllSpeedModeTimeouts, rearmSpeedModeApprovals } from './tools/submitPlan.js';
import { startAccountWatch } from './state/accountStore.js';
import os from 'os';
import type { DaemonInfo } from './types/schema.js';

// Configurable via environment variables with sensible defaults
const DEFAULT_PORT = parseInt(process.env.MOE_DEFAULT_PORT || '9876', 10);
const PORT_RANGE = parseInt(process.env.MOE_PORT_RANGE || '50', 10);
const SOCKET_TIMEOUT_MS = parseInt(process.env.MOE_SOCKET_TIMEOUT_MS || '200', 10);
const PORT_CHECK_INTERVAL_MS = parseInt(process.env.MOE_PORT_CHECK_INTERVAL_MS || '100', 10);
const PORT_READY_TIMEOUT_MS = parseInt(process.env.MOE_PORT_READY_TIMEOUT_MS || '5000', 10);
const LOCK_RETRY_DELAY_MS = parseInt(process.env.MOE_LOCK_RETRY_DELAY_MS || '2000', 10);
const LOCK_STALE_TIMEOUT_MS = parseInt(process.env.MOE_LOCK_STALE_TIMEOUT_MS || '15000', 10);
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.MOE_SHUTDOWN_TIMEOUT_MS || '10000', 10);
const HTTP_CLOSE_TIMEOUT_MS = parseInt(process.env.MOE_HTTP_CLOSE_TIMEOUT_MS || '5000', 10);

// Supervisor constants
const SUPERVISOR_MAX_RESTARTS = 5;
const SUPERVISOR_RESTART_WINDOW_MS = 60_000;
const SUPERVISOR_MAX_BACKOFF_MS = 30_000;
const SUPERVISOR_CHILD_KILL_TIMEOUT_MS = 10_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  const projectIndex = args.indexOf('--project');
  const portIndex = args.indexOf('--port');
  const nameIndex = args.indexOf('--name');
  const hostIndex = args.indexOf('--host');

  const projectPath = projectIndex >= 0 ? args[projectIndex + 1] : process.env.MOE_PROJECT_PATH || process.cwd();
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  const host = hostIndex >= 0 ? args[hostIndex + 1] : process.env.MOE_BIND_HOST || undefined;

  return { command, projectPath, port, name, host };
}

const DEFAULT_BIND_HOST = '127.0.0.1';
const LOOPBACK_PROBE_TIMEOUT_MS = 500;

/**
 * Address local probes (port scans, readiness checks) should connect to for a
 * given bind host. Wildcard and WSL binds include loopback; a specific address does not.
 */
function probeHostFor(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' || bindHost === WSL_BIND_HOST ? DEFAULT_BIND_HOST : bindHost;
}

function daemonInfoPath(projectPath: string): string {
  return path.join(projectPath, '.moe', 'daemon.json');
}

function lockFilePath(projectPath: string): string {
  return path.join(projectPath, '.moe', 'daemon.lock');
}

function canonicalProjectPath(projectPath: string): string {
  return path.resolve(projectPath);
}

const WINDOWS_FORM = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const WSL_SHARE = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i;
const MNT_DRIVE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

/**
 * Comparison-only form of a project path; never written anywhere. The contract
 * is documented on moe-proxy's comparableProjectPath (packages/moe-proxy/src/utils.ts).
 * Keep the two equivalent: scripts/tests/daemon-json-cap.test.mjs checks both dists against one table.
 */
function comparableProjectPath(projectPath: string): string {
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

function isSameProjectPath(a: string, b: string): boolean {
  return comparableProjectPath(a) === comparableProjectPath(b);
}

/**
 * True when daemon.json was written on the other side of the WSL/Windows
 * boundary: a drive or UNC projectPath read outside Windows, or a POSIX one read
 * on Windows. The writer's pid lives in another pid namespace, so
 * `process.kill(pid, 0)` proves nothing either way and only /health may judge
 * it. Mirrors moe-agent.sh's pre-flight, which detects a Windows-owned
 * daemon.json by its drive-letter projectPath. A relative projectPath (the
 * daemon records `--project` as given) names no side, so it stays local.
 */
function isForeignDaemonInfo(info: Pick<DaemonInfo, 'projectPath'>, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? /^\/(?![\\/])/.test(info.projectPath)
    : /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(info.projectPath);
}

/**
 * The WSL default gateway (the Windows host in NAT mode), read from
 * /proc/net/route without spawning anything; null on any error. Node twin of
 * moe-agent.sh wsl_gateway_host (`ip route show default`).
 */
function wslGatewayHost(): string | null {
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

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

function isDaemonInfoShape(value: unknown): value is DaemonInfo {
  const info = value as Partial<DaemonInfo> | null;
  return !!info
    && isValidPort(info.port)
    && isValidPid(info.pid)
    && typeof info.projectPath === 'string'
    && info.projectPath.trim().length > 0
    && typeof info.startedAt === 'string';
}

type DaemonValidationResult = {
  valid: boolean;
  reason?: string;
  info?: DaemonInfo;
  /** daemon.json belongs to the other side of the WSL boundary (isForeignDaemonInfo). */
  foreign?: boolean;
};

type LockInfo = {
  pid: number | null;
  projectPath: string | null;
  createdAtMs: number;
};

function readLockInfo(projectPath: string): LockInfo | null {
  const lockPath = lockFilePath(projectPath);
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return { pid: Number(raw), projectPath: null, createdAtMs: stat.mtimeMs };
    }
    const parsed = JSON.parse(raw) as { pid?: unknown; projectPath?: unknown; createdAt?: unknown };
    return {
      pid: isValidPid(parsed.pid) ? parsed.pid : null,
      projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : null,
      createdAtMs: typeof parsed.createdAt === 'string'
        ? new Date(parsed.createdAt).getTime()
        : stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function staleLockReason(projectPath: string): string | null {
  const info = readLockInfo(projectPath);
  if (!info || !info.pid || !Number.isFinite(info.createdAtMs)) return 'malformed lock';
  // Its owner's pid is in another pid namespace: never judge it stale from here.
  if (info.projectPath && isForeignDaemonInfo({ projectPath: info.projectPath })) return null;
  // acquireLock records path.resolve(--project). Resolve ours the same way, or a native alias of
  // this directory (//x on POSIX, /x on the current Windows drive) reads a live owner's lock as stale.
  if (info.projectPath && !isSameProjectPath(info.projectPath, canonicalProjectPath(projectPath))) return 'projectPath mismatch';
  if (!isProcessAlive(info.pid)) return 'lock owner not alive';
  if (Date.now() - info.createdAtMs > LOCK_STALE_TIMEOUT_MS) return 'lock owner unverifiable after timeout';
  return null;
}

function removeStaleLock(projectPath: string, context: string): boolean {
  const reason = staleLockReason(projectPath);
  if (!reason) return false;
  try {
    fs.unlinkSync(lockFilePath(projectPath));
    logger.warn({ reason, context }, 'Removed stale daemon lock');
    return true;
  } catch (error) {
    logger.debug({ error, reason, context }, 'Failed to remove stale daemon lock');
    return false;
  }
}

function acquireLock(projectPath: string): boolean {
  const lockPath = lockFilePath(projectPath);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // O_EXCL ensures atomic creation - fails if file exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, escapeJsonForFile(JSON.stringify({
        pid: process.pid,
        projectPath: canonicalProjectPath(projectPath),
        createdAt: new Date().toISOString(),
      })));
      fs.closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Try to clear a stale lock and retry; otherwise give up.
        if (!removeStaleLock(projectPath, 'acquireLock')) {
          return false;
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(projectPath: string): void {
  const lockPath = lockFilePath(projectPath);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore errors when releasing lock
  }
}

function waitForPortListening(port: number, timeoutMs: number = PORT_READY_TIMEOUT_MS, host: string = DEFAULT_BIND_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = () => {
      const socket = new net.Socket();
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, PORT_CHECK_INTERVAL_MS);
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, PORT_CHECK_INTERVAL_MS);
        }
      });
      socket.connect(port, host);
    };
    check();
  });
}

/**
 * The IP literal a health probe should dial for `target`. The /health Host rule (server/healthHost.ts)
 * admits IP literals and localhost, never a configured name, so a daemon bound by name is probed at the
 * address that name resolves to: that literal is the Host Node sends, and it is the connection's arrival
 * address, which the rule admits. Admitting the configured name instead would trust whoever controls its DNS.
 * Null when the lookup fails or outlasts the probe timeout.
 */
async function healthProbeAddress(target: string, timeoutMs: number): Promise<string | null> {
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

async function probeDaemonHealth(
  info: DaemonInfo,
  expectedProjectPath: string,
  timeoutMs: number = SOCKET_TIMEOUT_MS,
  host?: string,
): Promise<boolean> {
  // Exported, so it resolves the caller's own path itself (see validateDaemonInfoForProject).
  const own = canonicalProjectPath(expectedProjectPath);
  if (!isDaemonInfoShape(info) || !isSameProjectPath(info.projectPath, own)) {
    return false;
  }

  const address = await healthProbeAddress(
    host ?? (info.bindHost ? probeHostFor(info.bindHost) : DEFAULT_BIND_HOST),
    timeoutMs,
  );
  if (address === null) return false;

  return new Promise((resolve) => {
    const req = http.request({
      hostname: address,
      port: info.port,
      path: '/health',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          req.destroy();
          resolve(false);
        }
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { status?: string; projectPath?: string; pid?: unknown };
          resolve(
            res.statusCode === 200
            && parsed.status === 'healthy'
            && typeof parsed.projectPath === 'string'
            && isSameProjectPath(parsed.projectPath, own)
            && isValidPid(parsed.pid)
            && parsed.pid === info.pid
          );
        } catch {
          resolve(false);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function validateDaemonInfoForProject(
  projectPath: string,
  info: DaemonInfo | null
): Promise<DaemonValidationResult> {
  if (!info) return { valid: false, reason: 'missing' };
  if (!isDaemonInfoShape(info)) return { valid: false, reason: 'malformed' };
  const foreign = isForeignDaemonInfo(info);
  // Our --project names a directory on this host, so resolve it here: a native alias
  // (//x on POSIX, /x on the current Windows drive) must not orphan a live daemon's files.
  // Recorded and reported paths are compared as written. Resolving them here would
  // read the other side's /home/u/p as C:\home\u\p.
  const own = canonicalProjectPath(projectPath);
  if (!isSameProjectPath(info.projectPath, own)) {
    return { valid: false, reason: 'projectPath mismatch', ...(foreign ? { foreign } : {}) };
  }
  if (foreign) {
    // Loopback (mirrored networking) first, then the WSL gateway (NAT mode).
    const hosts = [info.bindHost ? probeHostFor(info.bindHost) : DEFAULT_BIND_HOST];
    const gateway = process.platform === 'linux' ? wslGatewayHost() : null;
    if (gateway && !hosts.includes(gateway)) hosts.push(gateway);
    for (const host of hosts) {
      if (await probeDaemonHealth(info, own, SOCKET_TIMEOUT_MS, host)) {
        return { valid: true, info, foreign: true };
      }
    }
    return { valid: false, reason: 'foreign daemon unreachable', foreign: true };
  }
  if (!isProcessAlive(info.pid)) return { valid: false, reason: 'pid not alive' };
  if (!await probeDaemonHealth(info, own)) return { valid: false, reason: 'health check failed' };
  return { valid: true, info };
}

async function closeHttpServer(server: http.Server, timeoutMs: number = HTTP_CLOSE_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`HTTP server close timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (timeout.unref) {
      timeout.unref();
    }

    try {
      server.close((error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const closeError = error as NodeJS.ErrnoException | undefined;
        if (closeError?.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }

        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Returns true unless we can confirm the process is gone. `process.kill(pid, 0)`
 * throws ESRCH when the PID is not running and EPERM when it exists but the
 * current user can't signal it — only ESRCH proves death. Anything else is
 * treated as "still alive" to stay conservative; we'd rather refuse to clean
 * a stale daemon.json than tear down a live daemon owned by another user.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    // EPERM (or anything else) → process exists, we just lack permission.
    return true;
  }
}

async function findAvailablePort(preferred: number, host: string | readonly string[] = DEFAULT_BIND_HOST): Promise<number> {
  const hosts = typeof host === 'string' ? [host] : host;
  for (let i = 0; i < PORT_RANGE; i += 1) {
    const port = preferred + i;
    let available = true;
    for (const address of hosts) {
      if (!await isPortAvailable(port, address)) { available = false; break; }
    }
    if (available && hosts.length > 0) return port;
  }
  throw new Error('No available port found');
}

function isPortAvailable(port: number, host: string = DEFAULT_BIND_HOST): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  }).then((bindable) => (bindable ? isLoopbackPortFree(port) : false));
}

// A bind probe alone is not enough on Windows: without SO_EXCLUSIVEADDRUSE a
// 0.0.0.0 listener and a 127.0.0.1 listener from two processes share one port
// with no EADDRINUSE, so two projects can both "own" the same port and a
// client dialing localhost reaches whichever project bound the specific
// address. Dial loopback as a client: anything that answers (either bind form)
// means the port is taken; a refusal (or silence) means it is free.
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.unref();
    socket.setTimeout(LOOPBACK_PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

function readDaemonInfo(projectPath: string): DaemonInfo | null {
  const filePath = daemonInfoPath(projectPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    // Bounded read: an oversize daemon.json is treated like an unparseable one.
    return JSON.parse(readDaemonJsonText(filePath)) as DaemonInfo;
  } catch {
    return null;
  }
}

function writeDaemonInfo(projectPath: string, info: DaemonInfo): void {
  const filePath = daemonInfoPath(projectPath);
  const tempPath = `${filePath}.tmp.${process.pid}`;
  // Atomic write: write to temp file, then rename
  fs.writeFileSync(tempPath, escapeJsonForFile(JSON.stringify(info, null, 2)));
  fs.renameSync(tempPath, filePath);
}

function removeDaemonInfo(projectPath: string): void {
  const filePath = daemonInfoPath(projectPath);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    logger.debug({ error }, 'Failed to remove daemon.json');
  }
}

function cleanupStaleDaemonFiles(projectPath: string, reason: string): void {
  logger.warn({ reason }, 'Cleaning up stale daemon lifecycle files');
  removeDaemonInfo(projectPath);
  removeStaleLock(projectPath, reason);
}

function stopSentinelPath(projectPath: string): string {
  return path.join(projectPath, '.moe', 'daemon.stop');
}

function writeStopSentinel(projectPath: string): void {
  try {
    fs.writeFileSync(stopSentinelPath(projectPath), String(Date.now()));
  } catch { /* best effort */ }
}

function consumeStopSentinel(projectPath: string): boolean {
  const sentinelPath = stopSentinelPath(projectPath);
  if (fs.existsSync(sentinelPath)) {
    try { fs.unlinkSync(sentinelPath); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function writeGlobalConfig(): void {
  try {
    // Source and compiled entrypoints sit three levels below the checkout root.
    const installPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const canary = path.join(installPath, 'packages', 'moe-daemon', 'dist', 'index.js');
    if (!fs.existsSync(canary)) {
      // Not running from source tree (e.g. npm global install) — skip
      return;
    }
    const moeHome = path.join(os.homedir(), '.moe');
    if (!fs.existsSync(moeHome)) {
      fs.mkdirSync(moeHome, { recursive: true });
    }
    const configPath = path.join(moeHome, 'config.json');
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        // overwrite corrupt config
      }
    }
    const config = {
      ...existing,
      installPath,
      version: VERSION,
      updatedAt: new Date().toISOString()
    };
    const tempPath = `${configPath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, escapeJsonForFile(JSON.stringify(config, null, 2)));
    fs.renameSync(tempPath, configPath);
    logger.debug({ installPath }, 'Wrote global config to ~/.moe/config.json');
  } catch (error) {
    logger.debug({ error }, 'Failed to write global config (non-fatal)');
  }
}

/**
 * Shared first gate of `start`/`init` (supervisor) and `_run`: true when an
 * existing daemon.json must stop this start. A live daemon, native or on the
 * other side of the WSL boundary, blocks it; so does a foreign daemon.json that
 * does not answer /health, which is reported (exit 1) and never removed. A
 * native stale daemon.json is cleaned up and the start proceeds.
 */
async function existingDaemonBlocksStart(projectPath: string): Promise<boolean> {
  const existing = readDaemonInfo(projectPath);
  const validation = await validateDaemonInfoForProject(projectPath, existing);
  if (validation.valid && validation.info) {
    logger.info({ port: validation.info.port, pid: validation.info.pid, foreign: validation.foreign }, 'Moe daemon already running');
    return true;
  }
  if (validation.foreign) {
    logger.error({ reason: validation.reason, port: existing?.port, projectPath: existing?.projectPath },
      'daemon.json belongs to a daemon on the other side of the WSL boundary that could not be confirmed here; '
      + 'not removing it and not starting a second daemon over the same .moe/');
    process.exitCode = 1;
    return true;
  }
  if (existing) {
    const existingPid = isDaemonInfoShape(existing) ? existing.pid : null;
    if (existingPid && !isProcessAlive(existingPid)) {
      logger.info({ pid: existingPid }, '[lock] cleaned stale daemon.json (pid not running)');
    }
    cleanupStaleDaemonFiles(projectPath, validation.reason || 'invalid daemon info');
  }
  return false;
}

async function startDaemon(projectPath: string, preferredPort?: number, bindHost?: string): Promise<void> {
  const host = bindHost || DEFAULT_BIND_HOST;
  let hosts = [host];
  if (host === WSL_BIND_HOST) {
    try { hosts = resolveBindHosts(host, os.networkInterfaces()); }
    catch (err) {
      logger.warn({ err }, 'Could not read WSL adapters; binding loopback only');
      hosts = [DEFAULT_BIND_HOST];
    }
  }
  if (await existingDaemonBlocksStart(projectPath)) return;

  // Acquire lock to prevent race conditions
  if (!acquireLock(projectPath)) {
    logger.info('Another process is starting the daemon, waiting...');
    // Wait a bit and check if daemon is now running
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    const info = readDaemonInfo(projectPath);
    const validation = await validateDaemonInfoForProject(projectPath, info);
    if (validation.valid && validation.info) {
      logger.info({ port: validation.info.port, pid: validation.info.pid }, 'Daemon started by another process');
      return;
    }
    if (info && !validation.foreign) cleanupStaleDaemonFiles(projectPath, validation.reason || 'invalid daemon info after lock wait');
    logger.error('Failed to acquire lock and daemon not running');
    return;
  }

  let port: number;
  let state: StateManager;
  try {
    port = await findAvailablePort(preferredPort || DEFAULT_PORT, hosts);
    state = new StateManager({ projectPath });
    await state.load();
    // state.load() above populates state.attempts, so both passes below see the
    // previous daemon's executions. Order matters: reconcile FIRST, so the
    // purge can see which seats still own a non-closed attempt and spare them
    // instead of yanking a task away from a CLI that is still running.
    await state.mutex.runExclusive(() => reconcileRunningAttempts(state));
    await state.purgeAllWorkers(); // Layer 1 - clean stale workers from previous run
    // Backfill missing TaskMetrics from the activity log. Idempotent — only
    // fills fields that are currently undefined; never overwrites.
    try {
      const backfillResult = await backfillTaskMetrics(state);
      if (backfillResult.backfilled > 0) {
        logger.info({ backfilled: backfillResult.backfilled }, 'backfilled task metrics');
      }
    } catch (err) {
      logger.warn({ error: err }, 'task metrics backfill failed (non-fatal)');
    }
    // Refresh scaffold docs on EVERY start, not just init: role docs, subagent
    // defs, and skills upgrade in place via the sha-marker convention (stale
    // moe-generated files are replaced; unmarked user customizations are kept).
    // Without this, a project only picks up new role docs when re-inited.
    const moePath = path.join(projectPath, '.moe');
    try { writeInitFiles(moePath); } catch (err) { logger.warn({ err }, 'writeInitFiles refresh failed (non-fatal)'); }
    try { writeSkillFiles(moePath); } catch (err) { logger.warn({ err }, 'writeSkillFiles refresh failed (non-fatal)'); }
    // Projects initialized before .claude/skills existed never got the mirror.
    linkClaudeSkills(projectPath);
  } catch (initError) {
    logger.error({ error: initError }, 'Failed to initialize daemon');
    releaseLock(projectPath);
    throw initError;
  }

  const startTime = Date.now();

  // Create HTTP server for health endpoint
  const handler: http.RequestListener = (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      // DNS-rebinding guard, before any check or stats work: see server/healthHost.ts.
      if (!isAllowedHealthHost(req.headers.host, req.socket.localAddress)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      // Perform health checks
      const checks: { name: string; healthy: boolean; message?: string }[] = [];

      // Check 1: WebSocket server is operational
      const wsHealthy = !wsServer.closed;
      checks.push({
        name: 'websocket_server',
        healthy: wsHealthy,
        message: wsHealthy ? undefined : 'WebSocket server is closed'
      });

      // Check 2: State manager has loaded project
      const stateHealthy = state.isLoaded();
      checks.push({
        name: 'state_manager',
        healthy: stateHealthy,
        message: stateHealthy ? undefined : 'State manager not loaded'
      });

      // Determine overall health
      const isHealthy = checks.every(c => c.healthy);
      const stats = state.getStats();

      const response = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        version: VERSION,
        pid: process.pid,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        projectPath,
        stats,
        checks,
        // The configured token, never server.address(): the local runner admits a daemon only on this field.
        bindHost: host
      };

      const statusCode = isHealthy ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
    } else {
      // Return 426 Upgrade Required for non-health requests
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    }
  };
  const httpServer = http.createServer(handler);

  const mcpAdapter = new McpAdapter(state);
  try {
    await ensureRunnerKey(projectPath);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) },
      'Runner channel key unavailable; /runner refuses every connection');
  }
  const wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);

  // Wait for server to actually start listening
  let servers: http.Server[];
  try {
    servers = await listenOnHosts(httpServer, hosts, port, handler);
  } catch (error) {
    releaseLock(projectPath);
    await wsServer.close();
    throw error;
  }
  logger.info({ hosts, port }, 'Daemon listening');

  // Verify port is actually accepting connections
  const portReady = await waitForPortListening(port, PORT_READY_TIMEOUT_MS, probeHostFor(host));
  if (!portReady) {
    logger.error({ port }, 'Server started but port not accepting connections');
    releaseLock(projectPath);
    process.exit(1);
  }

  state.setEmitter((event) => {
    wsServer.broadcast(event);
  });

  const watcher = new FileWatcher(state.moePath, async () => {
    try {
      // A wiped store (git clean / sparse-checkout / rm -rf) must not replace the in-memory board.
      if ((await healMassDeletion(state)) > 0) return;
      await state.load();
      wsServer.broadcast({ type: 'STATE_SNAPSHOT', payload: state.getSnapshot() });
    } catch (error) {
      logger.error({ error }, 'Failed to reload state from file watcher');
    }
  });
  state.setFileWatcher(watcher);
  watcher.start();

  // The machine's Claude account list and usage live outside .moe/ (written by
  // the `accounts` CLI and by every project's daemon), so FileWatcher never
  // sees them: poll them and push ACCOUNTS_UPDATED to the IDEs on a change.
  const stopAccountWatch = startAccountWatch(state);

  // SPEED-mode auto-approval timers live only in process memory, so a restart
  // would otherwise strand every AWAITING_APPROVAL task whose timer was lost.
  // Re-arm them once from persisted state now that the emitter + WS are wired.
  rearmSpeedModeApprovals(state);

  const info: DaemonInfo = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectPath,
    ...(host !== DEFAULT_BIND_HOST ? { bindHost: host } : {})
  };

  // Write daemon.json only after port is confirmed listening
  writeDaemonInfo(projectPath, info);

  // Write global install config so other projects can find this installation
  writeGlobalConfig();

  // Release lock now that daemon.json is written
  releaseLock(projectPath);

  // Guard against multiple shutdown calls
  let isShuttingDown = false;
  let shutdownExitCode = 0;

  const shutdown = async () => {
    if (isShuttingDown) {
      logger.debug('Shutdown already in progress...');
      return;
    }
    isShuttingDown = true;

    logger.info('Shutting down daemon...');

    // Set a hard timeout in case cleanup hangs
    const forceExitTimeout = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      try {
        releaseLock(projectPath);
      } catch (error) {
        logger.error({ error }, 'Error releasing lock during forced shutdown exit');
        // Last-resort: directly remove lock file
        try { fs.rmSync(lockFilePath(projectPath), { force: true }); } catch { /* ignore */ }
      }
      try {
        removeDaemonInfo(projectPath);
      } catch (error) {
        logger.error({ error }, 'Error removing daemon info during forced shutdown exit');
      }
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await watcher.stop();
    } catch (error) {
      logger.error({ error }, 'Error stopping file watcher');
    }

    try {
      await wsServer.close();
    } catch (error) {
      logger.error({ error }, 'Error closing WebSocket server');
    }

    await Promise.all(servers.map(async (server) => {
      try {
        await closeHttpServer(server);
      } catch (error) {
        logger.error({ error }, 'Error closing HTTP server');
      }
    }));

    // Cancel any pending SPEED mode auto-approval timeouts
    clearAllSpeedModeTimeouts();
    stopAccountWatch();

    // Flush any pending activity log writes
    try {
      await state.flushActivityLog();
    } catch (error) {
      logger.error({ error }, 'Error flushing activity log');
    }

    // Clear emitter to prevent any more broadcasts
    state.clearEmitter();

    try {
      removeDaemonInfo(projectPath);
    } catch (error) {
      logger.error({ error }, 'Error removing daemon info');
    }

    clearTimeout(forceExitTimeout);
    process.exit(shutdownExitCode);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    // Propagate non-zero exit through shutdown() so supervisor sees the failure.
    shutdownExitCode = 1;
    // Safety timeout in case shutdown() hangs
    const safetyTimeout = setTimeout(() => {
      try { releaseLock(projectPath); } catch { /* best effort */ }
      process.exit(1);
    }, 5000);
    safetyTimeout.unref();
    shutdown().catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
    // Don't shutdown on unhandled rejections, just log
  });

  logger.info({ projectPath, port, host }, 'Moe daemon running');
  logger.info({ endpoint: `ws://localhost:${port}/ws` }, 'WebSocket');
  logger.info({ endpoint: `ws://localhost:${port}/mcp` }, 'MCP bridge');
}

async function superviseDaemon(projectPath: string, preferredPort?: number, bindHost?: string): Promise<void> {
  if (await existingDaemonBlocksStart(projectPath)) return;

  // Clean up stale stop sentinel from previous runs
  consumeStopSentinel(projectPath);

  const scriptPath = process.argv[1];
  const childArgs = ['_run', '--project', projectPath];
  if (preferredPort !== undefined) {
    childArgs.push('--port', String(preferredPort));
  }
  if (bindHost !== undefined) {
    childArgs.push('--host', bindHost);
  }

  let restartTimestamps: number[] = [];
  let child: ChildProcess | null = null;
  let shuttingDown = false;

  function spawnChild(): void {
    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      stdio: 'inherit',
      env: process.env,
    });

    const childPid = child.pid;
    logger.info({ childPid }, 'Supervisor spawned daemon process');

    child.on('exit', (code, signal) => {
      child = null;

      if (shuttingDown) {
        process.exit(0);
        return;
      }

      // Check if stop was requested via sentinel file
      if (consumeStopSentinel(projectPath)) {
        logger.info('Daemon stopped by stop command');
        process.exit(0);
        return;
      }

      if (code === 0) {
        logger.info('Daemon exited cleanly');
        process.exit(0);
        return;
      }

      logger.warn({ code, signal }, 'Daemon crashed');

      // Track restart timestamps within the window
      const now = Date.now();
      restartTimestamps.push(now);
      restartTimestamps = restartTimestamps.filter(t => now - t < SUPERVISOR_RESTART_WINDOW_MS);

      if (restartTimestamps.length >= SUPERVISOR_MAX_RESTARTS) {
        logger.error(
          { restarts: restartTimestamps.length, windowMs: SUPERVISOR_RESTART_WINDOW_MS },
          'Too many restarts, supervisor giving up'
        );
        process.exit(1);
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const backoffMs = Math.min(
        SUPERVISOR_MAX_BACKOFF_MS,
        1000 * Math.pow(2, restartTimestamps.length - 1)
      );
      logger.info(
        { backoffMs, attempt: restartTimestamps.length, maxRestarts: SUPERVISOR_MAX_RESTARTS },
        'Restarting daemon after backoff'
      );
      // A `stop` issued during the backoff window has no live child to signal,
      // so it only drops a stop sentinel. Re-check before respawning so we
      // honour the stop instead of resurrecting the daemon.
      setTimeout(() => {
        if (shuttingDown || consumeStopSentinel(projectPath)) {
          logger.info('Stop requested during backoff; supervisor exiting');
          process.exit(0);
          return;
        }
        spawnChild();
      }, backoffMs);
    });
  }

  // Forward signals to child for graceful shutdown
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child && child.pid) {
      try {
        child.kill(signal);
      } catch { /* child may have already exited */ }
      // Force kill if child doesn't exit in time
      const forceTimeout = setTimeout(() => {
        if (child && child.pid) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
        process.exit(1);
      }, SUPERVISOR_CHILD_KILL_TIMEOUT_MS);
      forceTimeout.unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  logger.info({ projectPath }, 'Supervisor starting');
  spawnChild();
}

async function stopDaemon(projectPath: string): Promise<void> {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    // Write the stop sentinel even with no daemon.json: a supervisor may be
    // mid-backoff (child already exited) and will only abort the respawn if it
    // sees this marker.
    writeStopSentinel(projectPath);
    logger.info('No daemon info found');
    return;
  }

  const validation = await validateDaemonInfoForProject(projectPath, info);
  if (validation.foreign) {
    logger.warn({ port: info.port, pid: info.pid, projectPath: info.projectPath },
      'daemon.json belongs to a daemon on the other side of the WSL boundary; stop it from there '
      + '(no signal sent, nothing removed)');
    return;
  }
  if (!validation.valid || !validation.info) {
    const pid = isDaemonInfoShape(info) ? info.pid : null;
    if (pid && !isProcessAlive(pid)) {
      logger.info({ pid }, '[stop] daemon.json found but pid not running; removing stale file');
    }
    // Same backoff race: the supervisor may still be alive and waiting to
    // respawn, so leave a stop marker before cleaning up the stale files.
    writeStopSentinel(projectPath);
    cleanupStaleDaemonFiles(projectPath, validation.reason || 'invalid daemon info');
    logger.info('Daemon not running or daemon.json is stale');
    return;
  }

  // Write stop sentinel so the supervisor doesn't restart the child
  writeStopSentinel(projectPath);
  process.kill(validation.info.pid, 'SIGTERM');
  logger.info({ pid: validation.info.pid }, 'Sent SIGTERM to daemon');
}

async function statusDaemon(projectPath: string): Promise<void> {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    logger.info('Daemon not running');
    return;
  }

  const validation = await validateDaemonInfoForProject(projectPath, info);
  const shaped = isDaemonInfoShape(info);
  // A query only deletes what is proven gone here: a local daemon.json whose pid is dead.
  if (shaped && !validation.foreign && !isProcessAlive(info.pid)) {
    logger.info({ pid: info.pid }, 'Daemon not running (stale daemon.json removed: pid dead)');
    cleanupStaleDaemonFiles(projectPath, validation.reason || 'pid not alive');
    return;
  }
  logger.info({
    status: validation.valid ? 'running' : validation.foreign ? 'unknown' : 'stopped',
    owner: validation.foreign ? 'other side of the WSL boundary' : 'local',
    reason: validation.reason,
    port: shaped ? info.port : undefined,
    pid: shaped ? info.pid : undefined,
    projectPath: shaped ? info.projectPath : undefined
  }, 'Daemon status');
}

type InitResult = {
  alreadyInitialized: boolean;
  projectPath: string;
  projectId?: string;
  name?: string;
};

function initProject(projectPath: string, projectName?: string): InitResult {
  const moePath = path.join(projectPath, '.moe');

  if (fs.existsSync(moePath)) {
    let projectId: string | undefined;
    let name: string | undefined;
    const projectFile = path.join(moePath, 'project.json');
    if (fs.existsSync(projectFile)) {
      try {
        const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
        projectId = project?.id;
        name = project?.name;
      } catch {
        // Ignore invalid project.json
      }
    }
    // Backfill role docs and skills onto existing .moe/ — safe (skip-if-exists).
    // Log at warn so a partial-init repair is visible without crashing the daemon.
    try { writeInitFiles(moePath); } catch (err) { logger.warn({ err }, 'writeInitFiles backfill failed'); }
    try { writeSkillFiles(moePath); } catch (err) { logger.warn({ err }, 'writeSkillFiles backfill failed'); }
    logger.info({ projectPath, projectId, name }, 'Project already initialized (.moe folder exists)');
    return { alreadyInitialized: true, projectPath, projectId, name };
  }

  // Create directory structure
  const dirs = ['epics', 'tasks', 'workers', 'proposals', 'roles'];
  fs.mkdirSync(moePath, { recursive: true });
  for (const dir of dirs) {
    fs.mkdirSync(path.join(moePath, dir), { recursive: true });
  }

  // Generate project ID
  const projectId = `proj-${crypto.randomUUID().slice(0, 8)}`;
  const name = projectName || path.basename(projectPath);

  // Create project.json
  const project = {
    id: projectId,
    name,
    rootPath: projectPath,
    globalRails: {
      techStack: [],
      forbiddenPatterns: [],
      requiredPatterns: [],
      formatting: '',
      testing: '',
      customRules: []
    },
    settings: {
      approvalMode: 'CONTROL',
      speedModeDelayMs: 2000,
      autoCreateBranch: true,
      branchPattern: 'moe/{epicId}/{taskId}',
      commitPattern: 'feat({epicId}): {taskTitle}',
      agentCommand: 'claude',
      enableAgentTeams: false,
      chatEnabled: true,
      chatMaxAgentHops: 4,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(moePath, 'project.json'),
    escapeJsonForFile(JSON.stringify(project, null, 2))
  );

  // Create empty activity.log
  fs.writeFileSync(path.join(moePath, 'activity.log'), '');

  // Write role docs and .gitignore
  writeInitFiles(moePath);

  // Write the curated skill pack (.moe/skills/<name>/SKILL.md + manifest)
  writeSkillFiles(moePath);

  // Expose that pack at .claude/skills/ so nextAction.recommendedSkill names
  // resolve in the host's Skill tool instead of erroring "Unknown skill".
  linkClaudeSkills(projectPath);

  // Write global install config so other projects can find this installation
  writeGlobalConfig();

  logger.info({ projectPath, projectId, name }, 'Project initialized');
  return { alreadyInitialized: false, projectPath, projectId, name };
}

async function main() {
  // `accounts` manages the machine's Claude accounts and needs no project.
  if (process.argv[2] === 'accounts') {
    const { runAccountsCli } = await import('./accounts/cli.js');
    process.exitCode = runAccountsCli(process.argv.slice(3));
    return;
  }
  const { command, projectPath, port, name, host } = parseArgs();

  switch (command) {
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      break;
    case 'start':
      await superviseDaemon(projectPath, port, host);
      break;
    case '_run':
      // Internal: called by supervisor to run the actual daemon process
      await startDaemon(projectPath, port, host);
      break;
    case 'stop':
      await stopDaemon(projectPath);
      break;
    case 'status':
      await statusDaemon(projectPath);
      break;
    case 'init':
      initProject(projectPath, name);
      await superviseDaemon(projectPath, port, host);
      break;
    case 'doctor': {
      const result = await runDoctor(projectPath);
      for (const line of result.output) {
        // Use stdout directly — doctor output is human-readable, not structured logs.
        process.stdout.write(line + '\n');
      }
      process.exit(result.exitCode);
      break;
    }
    case 'check-architecture': {
      // One JSON line on stdout; exit 0 passed, 1 failed, 2 inconclusive or unavailable.
      const { exitCode, report } = await runCheckArchitecture(process.argv.slice(3), process.cwd());
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = exitCode;
      break;
    }
    default:
      logger.info('Usage: moe-daemon [start|stop|status|init|doctor|version] [--project <path>] [--port <port>] [--host <addr>] [--name <name>]');
      logger.info('       moe-daemon accounts [list|add|login|logout|check|remove] (Claude subscription accounts; see `accounts help`)');
      logger.info('       moe-daemon check-architecture --rules <repo path> [--base <rev>] [--tree <rev>] (run from the repository root)');
      logger.info('Note: `init` now starts the daemon and keeps running.');
  }
}

export {
  canonicalProjectPath,
  comparableProjectPath,
  isSameProjectPath,
  isForeignDaemonInfo,
  isDaemonInfoShape,
  probeDaemonHealth,
  validateDaemonInfoForProject,
  readDaemonInfo,
  removeDaemonInfo,
  cleanupStaleDaemonFiles,
  writeDaemonInfo,
  readLockInfo,
  staleLockReason,
  removeStaleLock,
  acquireLock,
  releaseLock,
  initProject,
  stopDaemon,
  statusDaemon,
  existingDaemonBlocksStart,
  findAvailablePort,
  isPortAvailable,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.fatal({ error: err }, 'Fatal error');
    process.exit(1);
  });
}

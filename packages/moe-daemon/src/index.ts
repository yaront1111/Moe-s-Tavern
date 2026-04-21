#!/usr/bin/env node

// =============================================================================
// Moe Daemon - Entry Point
// =============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { StateManager } from './state/StateManager.js';
import { FileWatcher } from './state/FileWatcher.js';
import { McpAdapter } from './server/McpAdapter.js';
import { MoeWebSocketServer } from './server/WebSocketServer.js';
import { logger } from './util/logger.js';
import { writeInitFiles } from './util/initFiles.js';
import { writeSkillFiles } from './util/skillFiles.js';
import { clearAllSpeedModeTimeouts } from './tools/submitPlan.js';
import os from 'os';
import type { DaemonInfo } from './types/schema.js';

const VERSION = '0.1.0';

// Configurable via environment variables with sensible defaults
const DEFAULT_PORT = parseInt(process.env.MOE_DEFAULT_PORT || '9876', 10);
const PORT_RANGE = parseInt(process.env.MOE_PORT_RANGE || '50', 10);
const SOCKET_TIMEOUT_MS = parseInt(process.env.MOE_SOCKET_TIMEOUT_MS || '200', 10);
const PORT_CHECK_INTERVAL_MS = parseInt(process.env.MOE_PORT_CHECK_INTERVAL_MS || '100', 10);
const PORT_READY_TIMEOUT_MS = parseInt(process.env.MOE_PORT_READY_TIMEOUT_MS || '5000', 10);
const LOCK_RETRY_DELAY_MS = parseInt(process.env.MOE_LOCK_RETRY_DELAY_MS || '2000', 10);
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

  const projectPath = projectIndex >= 0 ? args[projectIndex + 1] : process.env.MOE_PROJECT_PATH || process.cwd();
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;

  return { command, projectPath, port, name };
}

function daemonInfoPath(projectPath: string): string {
  return path.join(projectPath, '.moe', 'daemon.json');
}

function lockFilePath(projectPath: string): string {
  return path.join(projectPath, '.moe', 'daemon.lock');
}

function acquireLock(projectPath: string): boolean {
  const lockPath = lockFilePath(projectPath);
  try {
    // O_EXCL ensures atomic creation - fails if file exists
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock file exists, check if owning process is still alive
      try {
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isProcessAlive(lockPid)) {
          // Stale lock, remove and retry
          fs.unlinkSync(lockPath);
          return acquireLock(projectPath);
        }
      } catch {
        // Can't read lock file, try to remove it
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        return acquireLock(projectPath);
      }
    }
    return false;
  }
}

function releaseLock(projectPath: string): void {
  const lockPath = lockFilePath(projectPath);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore errors when releasing lock
  }
}

function waitForPortListening(port: number, timeoutMs: number = PORT_READY_TIMEOUT_MS): Promise<boolean> {
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
      socket.connect(port, '127.0.0.1');
    };
    check();
  });
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findAvailablePort(preferred: number): Promise<number> {
  for (let i = 0; i < PORT_RANGE; i += 1) {
    const port = preferred + i;
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  throw new Error('No available port found');
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

function readDaemonInfo(projectPath: string): DaemonInfo | null {
  const filePath = daemonInfoPath(projectPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

function writeDaemonInfo(projectPath: string, info: DaemonInfo): void {
  const filePath = daemonInfoPath(projectPath);
  const tempPath = `${filePath}.tmp.${process.pid}`;
  // Atomic write: write to temp file, then rename
  fs.writeFileSync(tempPath, JSON.stringify(info, null, 2));
  fs.renameSync(tempPath, filePath);
}

function removeDaemonInfo(projectPath: string): void {
  const filePath = daemonInfoPath(projectPath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
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
    // Derive installPath: __dirname is packages/moe-daemon/dist, go up 3 levels
    const installPath = path.resolve(__dirname, '..', '..', '..');
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
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    fs.renameSync(tempPath, configPath);
    logger.debug({ installPath }, 'Wrote global config to ~/.moe/config.json');
  } catch (error) {
    logger.debug({ error }, 'Failed to write global config (non-fatal)');
  }
}

async function startDaemon(projectPath: string, preferredPort?: number): Promise<void> {
  const existing = readDaemonInfo(projectPath);
  if (existing && isProcessAlive(existing.pid)) {
    logger.info({ port: existing.port, pid: existing.pid }, 'Moe daemon already running');
    return;
  }

  // Acquire lock to prevent race conditions
  if (!acquireLock(projectPath)) {
    logger.info('Another process is starting the daemon, waiting...');
    // Wait a bit and check if daemon is now running
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    const info = readDaemonInfo(projectPath);
    if (info && isProcessAlive(info.pid)) {
      logger.info({ port: info.port, pid: info.pid }, 'Daemon started by another process');
      return;
    }
    logger.error('Failed to acquire lock and daemon not running');
    return;
  }

  const port = await findAvailablePort(preferredPort || DEFAULT_PORT);
  const state = new StateManager({ projectPath });
  await state.load();
  await state.purgeAllWorkers(); // Layer 1 - clean stale workers from previous run

  const startTime = Date.now();

  // Create HTTP server for health endpoint
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
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
        uptime: Math.floor((Date.now() - startTime) / 1000),
        projectPath,
        stats,
        checks
      };

      const statusCode = isHealthy ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
    } else {
      // Return 426 Upgrade Required for non-health requests
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    }
  });

  const mcpAdapter = new McpAdapter(state);
  const wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);

  // Wait for server to actually start listening
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1');
  });

  // Verify port is actually accepting connections
  const portReady = await waitForPortListening(port, PORT_READY_TIMEOUT_MS);
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
      await state.load();
      wsServer.broadcast({ type: 'STATE_SNAPSHOT', payload: state.getSnapshot() });
    } catch (error) {
      logger.error({ error }, 'Failed to reload state from file watcher');
    }
  });
  state.setFileWatcher(watcher);
  watcher.start();

  const info: DaemonInfo = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectPath
  };

  // Write daemon.json only after port is confirmed listening
  writeDaemonInfo(projectPath, info);

  // Write global install config so other projects can find this installation
  writeGlobalConfig();

  // Release lock now that daemon.json is written
  releaseLock(projectPath);

  // Guard against multiple shutdown calls
  let isShuttingDown = false;

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

    try {
      await closeHttpServer(httpServer);
    } catch (error) {
      logger.error({ error }, 'Error closing HTTP server');
    }

    // Cancel any pending SPEED mode auto-approval timeouts
    clearAllSpeedModeTimeouts();

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
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    // Safety timeout in case shutdown() hangs
    const safetyTimeout = setTimeout(() => {
      try { releaseLock(projectPath); } catch { /* best effort */ }
      process.exit(1);
    }, 5000);
    safetyTimeout.unref();
    shutdown().then(() => process.exit(1)).catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
    // Don't shutdown on unhandled rejections, just log
  });

  logger.info({ projectPath, port }, 'Moe daemon running');
  logger.info({ endpoint: `ws://localhost:${port}/ws` }, 'WebSocket');
  logger.info({ endpoint: `ws://localhost:${port}/mcp` }, 'MCP bridge');
}

async function superviseDaemon(projectPath: string, preferredPort?: number): Promise<void> {
  // Check if daemon is already running
  const existing = readDaemonInfo(projectPath);
  if (existing && isProcessAlive(existing.pid)) {
    logger.info({ port: existing.port, pid: existing.pid }, 'Moe daemon already running');
    return;
  }

  // Clean up stale stop sentinel from previous runs
  consumeStopSentinel(projectPath);

  const scriptPath = process.argv[1];
  const childArgs = ['_run', '--project', projectPath];
  if (preferredPort !== undefined) {
    childArgs.push('--port', String(preferredPort));
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

      if (restartTimestamps.length > SUPERVISOR_MAX_RESTARTS) {
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
      setTimeout(spawnChild, backoffMs);
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

function stopDaemon(projectPath: string): void {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    logger.info('No daemon info found');
    return;
  }

  // Validate daemon.json points to this project to prevent killing wrong process
  const normalizedInfoPath = path.resolve(info.projectPath);
  const normalizedRequestPath = path.resolve(projectPath);
  if (normalizedInfoPath !== normalizedRequestPath) {
    logger.warn({ expected: normalizedRequestPath, found: normalizedInfoPath },
      'daemon.json projectPath mismatch, cleaning up stale file');
    removeDaemonInfo(projectPath);
    return;
  }

  if (isProcessAlive(info.pid)) {
    // Write stop sentinel so the supervisor doesn't restart the child
    writeStopSentinel(projectPath);
    process.kill(info.pid, 'SIGTERM');
    logger.info({ pid: info.pid }, 'Sent SIGTERM to daemon');
  } else {
    logger.info('Daemon not running. Cleaning up daemon.json');
    removeDaemonInfo(projectPath);
  }
}

function statusDaemon(projectPath: string): void {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    logger.info('Daemon not running');
    return;
  }

  const alive = isProcessAlive(info.pid);
  logger.info({
    status: alive ? 'running' : 'stopped',
    port: info.port,
    pid: info.pid,
    projectPath: info.projectPath
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
  const dirs = ['epics', 'tasks', 'workers', 'proposals', 'roles', 'memory', 'memory/sessions'];
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
      agentCommand: 'claude'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(moePath, 'project.json'),
    JSON.stringify(project, null, 2)
  );

  // Create empty activity.log
  fs.writeFileSync(path.join(moePath, 'activity.log'), '');

  // Write role docs and .gitignore
  writeInitFiles(moePath);

  // Write the curated skill pack (.moe/skills/<name>/SKILL.md + manifest)
  writeSkillFiles(moePath);

  // Write global install config so other projects can find this installation
  writeGlobalConfig();

  logger.info({ projectPath, projectId, name }, 'Project initialized');
  return { alreadyInitialized: false, projectPath, projectId, name };
}

async function main() {
  const { command, projectPath, port, name } = parseArgs();

  switch (command) {
    case 'start':
      await superviseDaemon(projectPath, port);
      break;
    case '_run':
      // Internal: called by supervisor to run the actual daemon process
      await startDaemon(projectPath, port);
      break;
    case 'stop':
      stopDaemon(projectPath);
      break;
    case 'status':
      statusDaemon(projectPath);
      break;
    case 'init':
      initProject(projectPath, name);
      await superviseDaemon(projectPath, port);
      break;
    default:
      logger.info('Usage: moe-daemon [start|stop|status|init] [--project <path>] [--port <port>] [--name <name>]');
      logger.info('Note: `init` now starts the daemon and keeps running.');
  }
}

main().catch((err) => {
  logger.fatal({ error: err }, 'Fatal error');
  process.exit(1);
});

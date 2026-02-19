#!/usr/bin/env node

// =============================================================================
// Moe Daemon - Entry Point
// =============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import crypto from 'crypto';
import { StateManager } from './state/StateManager.js';
import { FileWatcher } from './state/FileWatcher.js';
import { McpAdapter } from './server/McpAdapter.js';
import { MoeWebSocketServer } from './server/WebSocketServer.js';
import { logger } from './util/logger.js';
import { writeInitFiles } from './util/initFiles.js';
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
  state.purgeAllWorkers(); // Layer 1 - clean stale workers from previous run

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
    try {
      releaseLock(projectPath);
    } catch (lockError) {
      logger.error({ error: lockError }, 'Failed to release lock in uncaughtException handler');
    }
    shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
    // Don't shutdown on unhandled rejections, just log
  });

  logger.info({ projectPath, port }, 'Moe daemon running');
  logger.info({ endpoint: `ws://localhost:${port}/ws` }, 'WebSocket');
  logger.info({ endpoint: `ws://localhost:${port}/mcp` }, 'MCP bridge');
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

  // Write global install config so other projects can find this installation
  writeGlobalConfig();

  logger.info({ projectPath, projectId, name }, 'Project initialized');
  return { alreadyInitialized: false, projectPath, projectId, name };
}

async function main() {
  const { command, projectPath, port, name } = parseArgs();

  switch (command) {
    case 'start':
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
      await startDaemon(projectPath, port);
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

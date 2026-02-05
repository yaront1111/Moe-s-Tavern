#!/usr/bin/env node

// =============================================================================
// Moe Daemon - Entry Point
// =============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import { StateManager } from './state/StateManager.js';
import { FileWatcher } from './state/FileWatcher.js';
import { McpAdapter } from './server/McpAdapter.js';
import { MoeWebSocketServer } from './server/WebSocketServer.js';
import { logger } from './util/logger.js';
import type { DaemonInfo } from './types/schema.js';

const VERSION = '0.1.0';

const DEFAULT_PORT = 9876;
const PORT_RANGE = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  const projectIndex = args.indexOf('--project');
  const portIndex = args.indexOf('--port');

  const projectPath = projectIndex >= 0 ? args[projectIndex + 1] : process.env.MOE_PROJECT_PATH || process.cwd();
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;

  return { command, projectPath, port };
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

function waitForPortListening(port: number, timeoutMs: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = () => {
      const socket = new net.Socket();
      socket.setTimeout(200);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 100);
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 100);
        }
      });
      socket.connect(port, '127.0.0.1');
    };
    check();
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
    server.listen({ port }, () => {
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
    await new Promise(resolve => setTimeout(resolve, 2000));
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

  const startTime = Date.now();

  // Create HTTP server for health endpoint
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const stats = state.getStats();
      const response = {
        status: 'healthy',
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        projectPath,
        stats
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
    httpServer.listen(port);
  });

  // Verify port is actually accepting connections
  const portReady = await waitForPortListening(port, 5000);
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
      process.exit(1);
    }, 10000);

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
      httpServer.close();
    } catch (error) {
      logger.error({ error }, 'Error closing HTTP server');
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

async function main() {
  const { command, projectPath, port } = parseArgs();

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
    default:
      logger.info('Usage: moe-daemon [start|stop|status] [--project <path>] [--port <port>]');
  }
}

main().catch((err) => {
  logger.fatal({ error: err }, 'Fatal error');
  process.exit(1);
});

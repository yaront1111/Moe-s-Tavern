#!/usr/bin/env node

// =============================================================================
// Moe Daemon - Entry Point
// =============================================================================

import fs from 'fs';
import path from 'path';
import net from 'net';
import { StateManager } from './state/StateManager.js';
import { FileWatcher } from './state/FileWatcher.js';
import { McpAdapter } from './server/McpAdapter.js';
import { MoeWebSocketServer } from './server/WebSocketServer.js';
import type { DaemonInfo } from './types/schema.js';

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
  fs.writeFileSync(filePath, JSON.stringify(info, null, 2));
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
    console.log(`Moe daemon already running on port ${existing.port} (pid ${existing.pid}).`);
    return;
  }

  const port = await findAvailablePort(preferredPort || DEFAULT_PORT);
  const state = new StateManager({ projectPath });
  await state.load();

  const mcpAdapter = new McpAdapter(state);
  const wsServer = new MoeWebSocketServer(port, state, mcpAdapter);

  state.setEmitter((event) => {
    wsServer.broadcast(event);
  });

  const watcher = new FileWatcher(state.moePath, async () => {
    try {
      await state.load();
      wsServer.broadcast({ type: 'STATE_SNAPSHOT', payload: state.getSnapshot() });
    } catch (error) {
      console.error('Failed to reload state from file watcher:', error);
    }
  });
  watcher.start();

  const info: DaemonInfo = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectPath
  };

  writeDaemonInfo(projectPath, info);

  // Guard against multiple shutdown calls
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) {
      console.log('Shutdown already in progress...');
      return;
    }
    isShuttingDown = true;

    console.log('Shutting down daemon...');

    // Set a hard timeout in case cleanup hangs
    const forceExitTimeout = setTimeout(() => {
      console.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);

    try {
      await watcher.stop();
    } catch (error) {
      console.error('Error stopping file watcher:', error);
    }

    try {
      await wsServer.close();
    } catch (error) {
      console.error('Error closing WebSocket server:', error);
    }

    // Clear emitter to prevent any more broadcasts
    state.clearEmitter();

    try {
      removeDaemonInfo(projectPath);
    } catch (error) {
      console.error('Error removing daemon info:', error);
    }

    clearTimeout(forceExitTimeout);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    // Don't shutdown on unhandled rejections, just log
  });

  console.log(`Moe daemon running for ${projectPath}`);
  console.log(`WebSocket: ws://localhost:${port}/ws`);
  console.log(`MCP bridge: ws://localhost:${port}/mcp`);
}

function stopDaemon(projectPath: string): void {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    console.log('No daemon info found.');
    return;
  }

  if (isProcessAlive(info.pid)) {
    process.kill(info.pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (pid ${info.pid}).`);
  } else {
    console.log('Daemon not running. Cleaning up daemon.json.');
    removeDaemonInfo(projectPath);
  }
}

function statusDaemon(projectPath: string): void {
  const info = readDaemonInfo(projectPath);
  if (!info) {
    console.log('Daemon not running.');
    return;
  }

  const alive = isProcessAlive(info.pid);
  console.log(`Daemon: ${alive ? 'running' : 'stopped'}`);
  console.log(`Port: ${info.port}`);
  console.log(`PID: ${info.pid}`);
  console.log(`Project: ${info.projectPath}`);
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
      console.log('Usage: moe-daemon [start|stop|status] [--project <path>] [--port <port>]');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

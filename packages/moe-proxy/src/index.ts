#!/usr/bin/env node

// =============================================================================
// Moe Proxy - MCP stdio shim forwarding to daemon
// =============================================================================

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  projectPath: string;
}

// Reconnect configuration
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnected = false;
let pendingMessages: string[] = [];
let pendingRequests = 0;
let shuttingDown = false;

function readDaemonInfo(projectPath: string): DaemonInfo | null {
  const filePath = path.join(projectPath, '.moe', 'daemon.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const info = JSON.parse(raw) as DaemonInfo;
    // Basic validation
    if (typeof info.port !== 'number' || typeof info.pid !== 'number') {
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

function getProjectPath(): string {
  return process.env.MOE_PROJECT_PATH || process.cwd();
}

function writeError(message: string, code = -32000) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code, message }
  });
  process.stdout.write(payload + '\n');
}

function writeLog(message: string) {
  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  process.stderr.write(`[moe-proxy] ${message}\n`);
}

function calculateReconnectDelay(): number {
  // Exponential backoff with jitter
  const baseDelay = Math.min(
    INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS
  );
  const jitter = Math.random() * 0.3 * baseDelay;
  return baseDelay + jitter;
}

function gracefulShutdown(): void {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  if (pendingRequests <= 0) {
    process.exit(0);
    return;
  }

  writeLog(`Waiting for ${pendingRequests} pending response(s)...`);
  const startTime = Date.now();
  const maxWaitMs = 2000;

  const checkInterval = setInterval(() => {
    if (pendingRequests <= 0 || Date.now() - startTime >= maxWaitMs) {
      clearInterval(checkInterval);
      if (pendingRequests > 0) {
        writeLog(`Timeout waiting for ${pendingRequests} pending response(s)`);
      }
      process.exit(0);
    }
  }, 50);
}

function connect(projectPath: string): void {
  const info = readDaemonInfo(projectPath);

  if (!info) {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = calculateReconnectDelay();
      reconnectAttempts++;
      writeLog(`Daemon not running, retrying in ${Math.round(delay)}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => connect(projectPath), delay);
      return;
    }
    writeError('Moe daemon not running after retries. Start with: moe-daemon start');
    process.exit(1);
    return;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/mcp`);

  ws.on('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    writeLog('Connected to daemon');

    // Send any pending messages that arrived during reconnect
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift()!;
      pendingRequests++;
      ws.send(msg);
    }
  });

  ws.on('message', (data) => {
    const message = data.toString();

    // Validate response is valid JSON before forwarding
    try {
      JSON.parse(message);
      pendingRequests = Math.max(0, pendingRequests - 1);
      process.stdout.write(message + '\n');
    } catch {
      writeError('Received invalid JSON from daemon');
    }
  });

  ws.on('close', (code, reason) => {
    isConnected = false;
    writeLog(`Connection closed: ${code} ${reason}`);

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = calculateReconnectDelay();
      reconnectAttempts++;
      writeLog(`Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => connect(projectPath), delay);
    } else {
      writeError('Lost connection to daemon after max retries');
      process.exit(1);
    }
  });

  ws.on('error', (error) => {
    writeLog(`WebSocket error: ${error.message}`);
    // Don't exit immediately - let the close handler manage reconnection
  });

  // Set up stdin handling (only once)
  if (!process.stdin.readableFlowing) {
    process.stdin.setEncoding('utf-8');

    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        // Validate JSON before sending to daemon
        try {
          JSON.parse(line);
          if (isConnected && ws.readyState === WebSocket.OPEN) {
            pendingRequests++;
            ws.send(line);
          } else {
            // Queue message for when connection is restored
            pendingMessages.push(line);
            if (pendingMessages.length > 100) {
              // Prevent unbounded queue growth
              pendingMessages.shift();
              writeLog('Message queue overflow, dropping oldest message');
            }
          }
        } catch {
          writeError(`Invalid JSON input: ${line.substring(0, 100)}`);
        }
      }
    });

    process.stdin.on('end', () => {
      writeLog('stdin closed, shutting down');
      gracefulShutdown();
    });
  }
}

async function main() {
  const projectPath = getProjectPath();

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    writeLog('Received SIGTERM, shutting down');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    writeLog('Received SIGINT, shutting down');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    process.exit(0);
  });

  connect(projectPath);
}

main().catch((err) => {
  writeError(err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
});

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

// Per-message timeout configuration
const MESSAGE_TIMEOUT_MS = parseInt(process.env.MOE_MESSAGE_TIMEOUT_MS || '30000', 10);
const WAIT_FOR_TASK_TIMEOUT_MS = 11 * 60 * 1000; // 11 minutes (longer than max wait_for_task timeout)
const TIMEOUT_CHECK_INTERVAL_MS = 5000;

let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnected = false;
let currentWebSocket: WebSocket | null = null;
let pendingMessages: string[] = [];
let pendingRequestIds = new Set<string | number>();
// Track when each request was sent and its timeout for timeout detection
let pendingRequestTimes = new Map<string | number, { sentAt: number; timeoutMs: number }>();
let timeoutCheckTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

/**
 * Check if it's safe to send a message on the WebSocket.
 * This checks both the isConnected flag AND the actual WebSocket readyState
 * to prevent race conditions where the flag and state are out of sync.
 */
function isSafeToSend(): boolean {
  return isConnected &&
         currentWebSocket !== null &&
         currentWebSocket.readyState === WebSocket.OPEN;
}

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
  safeStdoutWrite(payload + '\n');
}

function writeLog(message: string) {
  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  process.stderr.write(`[moe-proxy] ${message}\n`);
}

function safeStdoutWrite(data: string): boolean {
  try {
    process.stdout.write(data);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown stdout write error';
    writeLog(`stdout write failed: ${errorMessage}`);
    return false;
  }
}

/**
 * Safely send a message over WebSocket with error handling.
 * On failure: logs the error, cleans up pendingRequestIds/pendingRequestTimes,
 * and writes a JSON-RPC error response to stdout for tracked request IDs.
 * Returns true if send succeeded, false otherwise.
 */
function safeSend(ws: WebSocket, data: string): boolean {
  try {
    ws.send(data);
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown send error';
    writeLog(`ws.send() failed: ${errorMsg}`);

    // Clean up tracking and send error response for this message's request ID
    try {
      const parsed = JSON.parse(data);
      if (parsed.id !== undefined && parsed.id !== null) {
        pendingRequestIds.delete(parsed.id);
        pendingRequestTimes.delete(parsed.id);

        const errorResponse = JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32000, message: `Failed to send to daemon: ${errorMsg}` }
        });
        safeStdoutWrite(errorResponse + '\n');
      }
    } catch { /* message wasn't valid JSON or had no ID */ }

    return false;
  }
}

/**
 * Compute per-request timeout based on the tool being called.
 * moe.wait_for_task is a blocking long-poll, so it needs a much longer timeout.
 */
function getRequestTimeout(parsed: Record<string, unknown>): number {
  if (parsed.method === 'tools/call') {
    const params = parsed.params as { name?: string } | undefined;
    if (params?.name === 'moe.wait_for_task') {
      return WAIT_FOR_TASK_TIMEOUT_MS;
    }
  }
  return MESSAGE_TIMEOUT_MS;
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

function checkMessageTimeouts(): void {
  if (shuttingDown) return;
  const now = Date.now();
  const timedOut: (string | number)[] = [];

  for (const [id, entry] of pendingRequestTimes) {
    if (now - entry.sentAt >= entry.timeoutMs) {
      timedOut.push(id);
    }
  }

  for (const id of timedOut) {
    const entry = pendingRequestTimes.get(id);
    pendingRequestIds.delete(id);
    pendingRequestTimes.delete(id);
    const timeoutMs = entry?.timeoutMs ?? MESSAGE_TIMEOUT_MS;
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `Request timed out after ${timeoutMs}ms` }
    });
    safeStdoutWrite(errorResponse + '\n');
    writeLog(`Request ${id} timed out`);
  }
}

function startTimeoutChecker(): void {
  if (timeoutCheckTimer) return;
  timeoutCheckTimer = setInterval(checkMessageTimeouts, TIMEOUT_CHECK_INTERVAL_MS);
}

function stopTimeoutChecker(): void {
  if (timeoutCheckTimer) {
    clearInterval(timeoutCheckTimer);
    timeoutCheckTimer = null;
  }
}

/**
 * Safely close the current WebSocket connection.
 * Sends a clean close frame to the daemon so it detects the disconnect promptly.
 */
function closeWebSocket(): void {
  if (currentWebSocket) {
    try {
      if (currentWebSocket.readyState === WebSocket.OPEN ||
          currentWebSocket.readyState === WebSocket.CONNECTING) {
        currentWebSocket.close();
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      writeLog(`Error closing WebSocket: ${errorMsg}`);
    }
    currentWebSocket = null;
    isConnected = false;
  }
}

function gracefulShutdown(): void {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopTimeoutChecker();

  if (pendingRequestIds.size === 0 && pendingMessages.length === 0) {
    closeWebSocket();
    process.exit(0);
    return;
  }

  const pendingCount = pendingRequestIds.size + pendingMessages.length;
  writeLog(`Waiting for ${pendingCount} pending request(s)...`);
  const startTime = Date.now();
  const maxWaitMs = 2000;

  const checkInterval = setInterval(() => {
    if ((pendingRequestIds.size === 0 && pendingMessages.length === 0) ||
        Date.now() - startTime >= maxWaitMs) {
      clearInterval(checkInterval);
      const remaining = pendingRequestIds.size + pendingMessages.length;
      if (remaining > 0) {
        writeLog(`Timeout waiting for ${remaining} pending request(s)`);
      }
      closeWebSocket();
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

  // Ensure any lingering socket and handlers are torn down before reconnecting.
  closeWebSocket();

  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/mcp`);
  currentWebSocket = ws;

  ws.on('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    writeLog('Connected to daemon');

    // Start timeout checker
    startTimeoutChecker();

    // Send any pending messages that arrived during reconnect
    const now = Date.now();
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift()!;
      try {
        const parsed = JSON.parse(msg);
        if (parsed.id !== undefined && parsed.id !== null) {
          pendingRequestIds.add(parsed.id);
          pendingRequestTimes.set(parsed.id, { sentAt: now, timeoutMs: getRequestTimeout(parsed) });
        }
      } catch { /* already validated */ }
      safeSend(ws, msg);
    }
  });

  ws.on('message', (data) => {
    const message = data.toString();

    // Validate response is valid JSON before forwarding
    try {
      const parsed = JSON.parse(message);
      // Remove the request ID from pending set (handles both success and error responses)
      if (parsed.id !== undefined && parsed.id !== null) {
        pendingRequestIds.delete(parsed.id);
        pendingRequestTimes.delete(parsed.id);
      }
      safeStdoutWrite(message + '\n');
    } catch {
      writeError('Received invalid JSON from daemon');
    }
  });

  ws.on('close', (code, reason) => {
    if (currentWebSocket !== ws) {
      writeLog(`Ignoring close event from stale socket: ${code} ${reason}`);
      return;
    }

    isConnected = false;
    currentWebSocket = null;
    writeLog(`Connection closed: ${code} ${reason}`);

    // Stop timeout checker while disconnected
    stopTimeoutChecker();

    // Clear any existing reconnect timer to prevent stacking
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (shuttingDown) return;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = calculateReconnectDelay();
      reconnectAttempts++;
      writeLog(`Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => connect(projectPath), delay);
    } else {
      // Send error responses for all pending requests before exiting
      for (const reqId of pendingRequestIds) {
        const errorResponse = JSON.stringify({
          jsonrpc: '2.0',
          id: reqId,
          error: { code: -32000, message: 'Lost connection to daemon after max retries' }
        });
        safeStdoutWrite(errorResponse + '\n');
      }
      pendingRequestIds.clear();
      pendingRequestTimes.clear();

      // Also send errors for queued messages
      for (const msg of pendingMessages) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.id !== undefined && parsed.id !== null) {
            const errorResponse = JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32000, message: 'Lost connection to daemon after max retries' }
            });
            safeStdoutWrite(errorResponse + '\n');
          }
        } catch { /* ignore parse errors */ }
      }
      pendingMessages = [];

      writeError('Lost connection to daemon after max retries');
      process.exit(1);
    }
  });

  ws.on('error', (error) => {
    if (currentWebSocket !== ws) {
      writeLog(`Ignoring error event from stale socket: ${error.message}`);
      return;
    }
    writeLog(`WebSocket error: ${error.message}`);
    // Don't exit immediately - let the close handler manage reconnection
  });

  // Set up stdin handling (only once)
  if (!process.stdin.readableFlowing) {
    process.stdin.setEncoding('utf-8');

    const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffer
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;

      // Prevent unbounded buffer growth if no newlines arrive
      if (buffer.length > MAX_BUFFER_SIZE && buffer.indexOf('\n') === -1) {
        writeError('Input buffer overflow: message too large without newline');
        buffer = '';
        return;
      }

      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        // Validate JSON before sending to daemon
        try {
          const parsed = JSON.parse(line);
          if (isSafeToSend()) {
            // Track request ID for proper pending count and timeout
            if (parsed.id !== undefined && parsed.id !== null) {
              pendingRequestIds.add(parsed.id);
              pendingRequestTimes.set(parsed.id, { sentAt: Date.now(), timeoutMs: getRequestTimeout(parsed) });
            }
            safeSend(currentWebSocket!, line);
          } else {
            // Queue message for when connection is restored
            pendingMessages.push(line);
            if (pendingMessages.length > 100) {
              // Prevent unbounded queue growth - send error for dropped message
              const droppedMsg = pendingMessages.shift()!;
              try {
                const droppedParsed = JSON.parse(droppedMsg);
                if (droppedParsed.id !== undefined && droppedParsed.id !== null) {
                  // Send error response for dropped request
                  const errorResponse = JSON.stringify({
                    jsonrpc: '2.0',
                    id: droppedParsed.id,
                    error: { code: -32000, message: 'Message dropped: queue overflow while disconnected' }
                  });
                  safeStdoutWrite(errorResponse + '\n');
                }
              } catch { /* ignore parse errors for dropped messages */ }
              writeLog('Message queue overflow, dropped oldest message');
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

    process.stdin.on('error', (err) => {
      writeLog(`stdin error: ${err.message || 'unknown'}`);
      gracefulShutdown();
    });
  }
}

async function main() {
  const projectPath = getProjectPath();

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    writeLog('Received SIGTERM, shutting down');
    gracefulShutdown();
  });

  process.on('SIGINT', () => {
    writeLog('Received SIGINT, shutting down');
    gracefulShutdown();
  });

  connect(projectPath);
}

main().catch((err) => {
  writeError(err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
});

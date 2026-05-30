#!/usr/bin/env node

// =============================================================================
// Moe Proxy - MCP stdio shim forwarding to daemon
// =============================================================================

import WebSocket from 'ws';
import { getProjectPath, injectWorkerId, readDaemonInfoResult } from './utils.js';

// Reconnect configuration
// Keep retrying for a generous wall-clock window rather than a fixed attempt
// count. A supervised daemon restart can take tens of seconds (port scan, crash
// backoff capped at 30s); a 5-attempt/~25s budget would make the proxy exit(1)
// permanently — killing the `moe` MCP server for the whole agent session — mid
// restart. The window is measured from the first failed attempt and reset on a
// successful connect.
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

// Per-message timeout configuration
function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MESSAGE_TIMEOUT_MS = parsePositiveIntEnv(process.env.MOE_MESSAGE_TIMEOUT_MS, 30000);
const WAIT_FOR_TASK_TIMEOUT_MS = 11 * 60 * 1000; // 11 minutes (longer than max wait_for_task timeout)
const TIMEOUT_CHECK_INTERVAL_MS = 5000;

let reconnectAttempts = 0;
// Wall-clock start of the current disconnect's retry window; null when connected.
let reconnectStartedAt: number | null = null;
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
    const code = (err as NodeJS.ErrnoException).code;
    const errorMessage = err instanceof Error ? err.message : 'Unknown stdout write error';
    writeLog(`stdout write failed: ${errorMessage}`);
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      writeLog('stdout pipe broken, exiting');
      process.exit(1);
    }
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
    if (params?.name === 'moe.wait_for_task' || params?.name === 'moe.chat_wait') {
      return WAIT_FOR_TASK_TIMEOUT_MS;
    }
  }
  return MESSAGE_TIMEOUT_MS;
}

/**
 * True while we should keep trying to reconnect. Measures elapsed wall-clock
 * from the first failed attempt (set lazily here) against RECONNECT_WINDOW_MS,
 * so a slow daemon restart doesn't exhaust a fixed attempt count. Reset to
 * null on a successful open.
 */
function withinReconnectWindow(): boolean {
  if (reconnectStartedAt === null) {
    reconnectStartedAt = Date.now();
    return true;
  }
  return Date.now() - reconnectStartedAt < RECONNECT_WINDOW_MS;
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
        // Emit error responses so clients don't hang forever waiting for replies
        for (const reqId of pendingRequestIds) {
          safeStdoutWrite(JSON.stringify({
            jsonrpc: '2.0',
            id: reqId,
            error: { code: -32000, message: 'Proxy shutting down before response received' }
          }) + '\n');
        }
        pendingRequestIds.clear();
        pendingRequestTimes.clear();
        for (const msg of pendingMessages) {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.id !== undefined && parsed.id !== null) {
              safeStdoutWrite(JSON.stringify({
                jsonrpc: '2.0',
                id: parsed.id,
                error: { code: -32000, message: 'Proxy shutting down with message still queued' }
              }) + '\n');
            }
          } catch { /* drop unparseable */ }
        }
        pendingMessages = [];
      }
      closeWebSocket();
      process.exit(0);
    }
  }, 50);
}

function connect(projectPath: string): void {
  const daemonInfo = readDaemonInfoResult(projectPath);
  const info = daemonInfo.info;

  if (!info) {
    if (daemonInfo.error && !daemonInfo.retryable) {
      writeError(daemonInfo.error);
      process.exit(1);
      return;
    }
    if (withinReconnectWindow()) {
      const delay = calculateReconnectDelay();
      reconnectAttempts++;
      writeLog(`Daemon not running, retrying in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
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
    reconnectStartedAt = null;
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

    // If we're shutting down, gracefulShutdown owns the pending-request lifecycle
    // and will emit its own errors; skip emission here to avoid duplicates.
    if (shuttingDown) return;

    // Emit clean JSON-RPC errors for every in-flight request so clients see a
    // disconnect rather than waiting for a per-message timeout. Reconnect logic
    // still proceeds; queued (not-yet-sent) messages remain queued to be flushed
    // on the next successful open.
    if (pendingRequestIds.size > 0) {
      for (const reqId of pendingRequestIds) {
        const errorResponse = JSON.stringify({
          jsonrpc: '2.0',
          id: reqId,
          error: { code: -32000, message: 'Connection to daemon lost before response received' }
        });
        safeStdoutWrite(errorResponse + '\n');
      }
      pendingRequestIds.clear();
      pendingRequestTimes.clear();
    }

    if (withinReconnectWindow()) {
      const delay = calculateReconnectDelay();
      reconnectAttempts++;
      writeLog(`Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
      reconnectTimer = setTimeout(() => connect(projectPath), delay);
    } else {
      // Also send errors for queued messages that never made it out
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
    const MAX_LINE_SIZE = 512 * 1024; // 512KB per-line limit
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;

      // Prevent unbounded buffer growth
      if (buffer.length > MAX_BUFFER_SIZE) {
        writeError('Input buffer overflow: buffer exceeds 1MB');
        buffer = '';
        return;
      }

      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        // Enforce per-line size limit
        if (line.length > MAX_LINE_SIZE) {
          writeLog(`Skipping oversized line (${line.length} bytes, max ${MAX_LINE_SIZE})`);
          continue;
        }

        // Validate JSON before sending to daemon
        try {
          const parsed = JSON.parse(line);
          const mutated = injectWorkerId(parsed, process.env.MOE_WORKER_ID);
          const payload = mutated ? JSON.stringify(parsed) : line;
          if (isSafeToSend()) {
            // Track request ID for proper pending count and timeout
            if (parsed.id !== undefined && parsed.id !== null) {
              pendingRequestIds.add(parsed.id);
              pendingRequestTimes.set(parsed.id, { sentAt: Date.now(), timeoutMs: getRequestTimeout(parsed) });
            }
            safeSend(currentWebSocket!, payload);
          } else {
            // Queue message for when connection is restored. If at cap, drop the
            // NEWEST (this incoming) message to preserve ordering of already-queued
            // messages.
            if (pendingMessages.length >= 100) {
              const droppedId = (parsed.id !== undefined && parsed.id !== null) ? parsed.id : null;
              const errorResponse = JSON.stringify({
                jsonrpc: '2.0',
                id: droppedId,
                error: { code: -32000, message: 'Message dropped: queue overflow while disconnected' }
              });
              safeStdoutWrite(errorResponse + '\n');
              writeLog('Message queue overflow, dropped newest message');
            } else {
              pendingMessages.push(payload);
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

  // Detect broken stdout pipe early
  process.stdout.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      writeLog('stdout pipe broken, exiting');
      process.exit(1);
    }
  });

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

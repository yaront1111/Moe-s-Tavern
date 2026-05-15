// =============================================================================
// daemonClient - tiny WebSocket client for the local Moe daemon
// =============================================================================
//
// Wire format mirrors moe-proxy: JSON-RPC 2.0 frames sent to ws://host:port/mcp.
// We open a connection, send a single tools/call request, and close.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DaemonInfo {
  port: number;
  pid?: number;
  startedAt: string;
  projectPath: string;
  host?: string;
}

export interface DaemonClientOptions {
  /** Override project path (defaults to cwd). */
  projectPath?: string;
  /** Connect/handshake timeout. Default 3000ms. */
  timeoutMs?: number;
}

export class DaemonError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DaemonError';
  }
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Locate daemon.json for the current project.
 *
 * Resolution order:
 *  1. Explicit projectPath option.
 *  2. MOE_PROJECT_PATH env var.
 *  3. Walk up from cwd looking for a .moe/ directory.
 *  4. Fall back to the most-recent entry in ~/.moe/projects.json.
 *
 * The daemon writes `.moe/daemon.json` inside the project — NOT in the user
 * home directory. ~/.moe/projects.json is the cross-project registry.
 */
export function findDaemonInfo(options: DaemonClientOptions = {}): DaemonInfo {
  const explicit = options.projectPath ?? process.env.MOE_PROJECT_PATH;

  // When the caller pins a project (test, hook payload, or env var), use only
  // that directory — never silently fall back to a different project. This
  // keeps behavior predictable and prevents test isolation from leaking onto
  // the developer's real Moe project.
  if (explicit) {
    const info = readDaemonJson(path.resolve(explicit));
    if (info) return info;
    throw new DaemonError(
      'DAEMON_NOT_FOUND',
      `Moe daemon not running for project ${explicit}. Start it with: moe-daemon start --project <path>`
    );
  }

  // Walk up from cwd looking for .moe/daemon.json.
  const candidates: string[] = [];
  let current = process.cwd();
  for (let i = 0; i < 12; i++) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    const info = readDaemonJson(candidate);
    if (info) return info;
  }

  // Last resort — most recent project in the global registry
  const registryProject = readRecentProject();
  if (registryProject) {
    const info = readDaemonJson(registryProject);
    if (info) return info;
  }

  throw new DaemonError(
    'DAEMON_NOT_FOUND',
    'Moe daemon not running. Start it with: moe-daemon start --project <path> ' +
      '(see packages/moe-claude-plugin/README.md)'
  );
}

function readDaemonJson(projectPath: string): DaemonInfo | null {
  const file = path.join(projectPath, '.moe', 'daemon.json');
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<DaemonInfo>;
  if (typeof obj.port !== 'number' || !Number.isInteger(obj.port)) return null;
  if (obj.port < 1 || obj.port > 65535) return null;
  if (typeof obj.projectPath !== 'string') return null;
  if (typeof obj.startedAt !== 'string') return null;
  return {
    port: obj.port,
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    startedAt: obj.startedAt,
    projectPath: obj.projectPath,
    host: typeof obj.host === 'string' ? obj.host : '127.0.0.1',
  };
}

function readRecentProject(): string | null {
  const file = path.join(os.homedir(), '.moe', 'projects.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const list = JSON.parse(raw) as Array<{ path?: string; lastOpenedAt?: string }>;
    if (!Array.isArray(list)) return null;
    const sorted = [...list]
      .filter((entry) => entry && typeof entry.path === 'string')
      .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
    return sorted[0]?.path ?? null;
  } catch {
    return null;
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Call a single MCP tool against the daemon. Opens a WebSocket, sends one
 * JSON-RPC request, awaits the matching response, then closes the socket.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: DaemonClientOptions = {}
): Promise<unknown> {
  const info = findDaemonInfo(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  const response = await sendOnce(info, JSON.stringify(request), timeoutMs);
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(response) as JsonRpcResponse;
  } catch {
    throw new DaemonError('INVALID_RESPONSE', 'Daemon returned invalid JSON');
  }
  if (parsed.error) {
    throw new DaemonError('TOOL_ERROR', parsed.error.message);
  }
  return parsed.result;
}

/**
 * Send a one-off event to the /ws plugin endpoint. Fire-and-forget — does not
 * wait for an ack. Used by the PostToolUse hook so agent tool calls aren't
 * delayed.
 */
export async function postEvent(
  payload: Record<string, unknown>,
  options: DaemonClientOptions = {}
): Promise<void> {
  const info = findDaemonInfo(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await sendOnce(info, JSON.stringify(payload), timeoutMs, '/ws', /* awaitReply */ false);
}

/**
 * Minimal RFC 6455 WebSocket client. Connects, sends one text frame, optionally
 * waits for one text frame in response, closes. No ping/pong, no fragmentation,
 * no compression — the daemon never sends frames larger than ~2MB and our
 * requests are tiny.
 */
async function sendOnce(
  info: DaemonInfo,
  payload: string,
  timeoutMs: number,
  pathSuffix: '/mcp' | '/ws' = '/mcp',
  awaitReply = true
): Promise<string> {
  const net = await import('node:net');
  const crypto = await import('node:crypto');

  return new Promise<string>((resolve, reject) => {
    const host = info.host || '127.0.0.1';
    const socket = net.createConnection({ host, port: info.port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;

    const fail = (code: string, msg: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(new DaemonError(code, msg));
    };

    const succeed = (value: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      fail('TIMEOUT', `Daemon did not respond within ${timeoutMs}ms`);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    socket.setNoDelay(true);
    socket.once('error', (err) => {
      clearTimeout(timer);
      fail('CONNECT_FAILED', `Cannot reach daemon at ${host}:${info.port}: ${err.message}`);
    });

    socket.once('close', () => {
      clearTimeout(timer);
      if (!settled) {
        if (!awaitReply) {
          settled = true;
          resolve('');
        } else {
          fail('CONNECTION_CLOSED', 'Daemon closed the connection before sending a response');
        }
      }
    });

    socket.once('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const handshake =
        `GET ${pathSuffix} HTTP/1.1\r\n` +
        `Host: ${host}:${info.port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`;
      socket.write(handshake);
    });

    socket.on('data', (chunk: Buffer | string) => {
      const next = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, next]);

      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headers = buffer.slice(0, headerEnd).toString('utf-8');
        const firstLine = headers.split('\r\n')[0] || '';
        if (!firstLine.includes(' 101 ')) {
          fail('HANDSHAKE_FAILED', `Daemon rejected WebSocket upgrade: ${firstLine}`);
          return;
        }
        buffer = buffer.slice(headerEnd + 4);
        handshakeDone = true;

        // Send our single text frame (masked, FIN=1).
        const frame = buildClientTextFrame(payload);
        socket.write(frame);

        if (!awaitReply) {
          // Fire-and-forget: give the daemon a tick to flush, then close.
          setTimeout(() => succeed(''), 25);
        }
      }

      if (!awaitReply) return;

      // Parse one server text frame.
      const result = tryReadServerTextFrame(buffer);
      if (result) {
        succeed(result.text);
      }
    });
  });
}

function buildClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const len = payload.length;
  const header: number[] = [0x81]; // FIN + text opcode
  let extLenBytes: Buffer;
  if (len < 126) {
    header.push(0x80 | len);
    extLenBytes = Buffer.alloc(0);
  } else if (len < 65536) {
    header.push(0x80 | 126);
    extLenBytes = Buffer.alloc(2);
    extLenBytes.writeUInt16BE(len, 0);
  } else {
    header.push(0x80 | 127);
    extLenBytes = Buffer.alloc(8);
    extLenBytes.writeBigUInt64BE(BigInt(len), 0);
  }
  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from(header), extLenBytes, mask, masked]);
}

function tryReadServerTextFrame(buffer: Buffer): { text: string; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const byte1 = buffer[0];
  const byte2 = buffer[1];
  const opcode = byte1 & 0x0f;
  // We only handle a single non-fragmented text frame for our simple RPC.
  if (opcode !== 0x1) return null;
  let len = byte2 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < offset + 2) return null;
    len = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buffer.length < offset + 8) return null;
    len = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  if (buffer.length < offset + len) return null;
  const text = buffer.slice(offset, offset + len).toString('utf-8');
  return { text, rest: buffer.slice(offset + len) };
}

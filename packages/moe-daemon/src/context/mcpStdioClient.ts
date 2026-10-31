/**
 * Minimal read-only MCP stdio client (CQ-C03b) for an external analyzer: newline-delimited JSON-RPC 2.0 over a child spawned
 * with no shell and exactly the caller's env. The tool allowlist is enforced before any frame is written; every stdout line is
 * bounded by MCP_FRAME_LIMIT_BYTES and each answer by maxResponseBytes. Only caller shape throws: every child, protocol, IO or
 * timeout failure is a fixed reason string that never carries analyzer bytes, and close() or any failure kills the whole tree.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { invalidInput } from '../util/errors.js';
import { VERSION } from '../util/version.js';

export interface AnalyzerLaunch {
  readonly command: string; readonly args: readonly string[]; readonly cwd: string;
  readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly maxResponseBytes: number;
}
export interface AnalyzerServerInfo { readonly name: string; readonly version: string; readonly protocolVersion: string }
export interface AnalyzerTool { readonly name: string; readonly inputSchema: unknown }
export type AnalyzerCallResult = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false; readonly reason: string };
export interface AnalyzerSession {
  readonly server: AnalyzerServerInfo; readonly tools: readonly AnalyzerTool[];
  call(tool: string, args: Readonly<Record<string, unknown>>): Promise<AnalyzerCallResult>; close(): Promise<void>;
}
export type AnalyzerOpenResult = { readonly ok: true; readonly session: AnalyzerSession } | { readonly ok: false; readonly reason: string };

/** Hard cap on any one stdout line, including a partial line still waiting for its newline. */
export const MCP_FRAME_LIMIT_BYTES = 4 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_ARGS = 256, MAX_TOOLS = 64, MAX_PAGES = 16, MAX_NAME = 256, MAX_TIMEOUT_MS = 600_000, CLOSE_GRACE_MS = 2000;
// A root-relative (\x) or drive-relative (C:x) command would resolve against the analyzer-controlled cwd.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

type Json = Record<string, unknown>;
type Reply = { ok: true; result: Json } | { ok: false; reason: string };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const noop = () => {};
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPlain = (v: unknown): v is Json => isObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME;
const isInt = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
const noNul = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
const isAbsolute = (v: unknown): v is string => noNul(v) && path.isAbsolute(v);
const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
};

/** Copies every field once, so later caller mutation is inert, and refuses a bad shape before any spawn. */
function snapshotLaunch(launch: AnalyzerLaunch): AnalyzerLaunch {
  if (!isObject(launch)) throw invalidInput('launch', 'must be an object');
  const { command, args, cwd, env, timeoutMs, maxResponseBytes } = launch;
  if (!isAbsolute(command) || (process.platform === 'win32' && !WINDOWS_ABSOLUTE.test(command))) {
    throw invalidInput('launch.command', 'must be an absolute path without NUL');
  }
  const argv: unknown[] = Array.isArray(args) ? [...args] : [null];
  if (argv.length > MAX_ARGS || !argv.every(noNul)) throw invalidInput('launch.args', `must be at most ${MAX_ARGS} strings without NUL`);
  if (!isAbsolute(cwd)) throw invalidInput('launch.cwd', 'must be an absolute path without NUL');
  const entries = isPlain(env) ? Object.entries(env) : null;
  if (!entries?.every(([key, value]) => key !== '' && !/[=\0]/.test(key) && noNul(value))) {
    throw invalidInput('launch.env', 'must be a plain object of NUL-free strings keyed by non-empty names without "="');
  }
  if (!isInt(timeoutMs, MAX_TIMEOUT_MS)) throw invalidInput('launch.timeoutMs', `must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  if (!isInt(maxResponseBytes, MCP_FRAME_LIMIT_BYTES)) throw invalidInput('launch.maxResponseBytes', `must be an integer from 1 to ${MCP_FRAME_LIMIT_BYTES}`);
  return { command, args: argv as string[], cwd, env: Object.fromEntries(entries) as Record<string, string>, timeoutMs, maxResponseBytes };
}

function snapshotAllowed(allowedTools: readonly string[]): ReadonlySet<string> {
  const names: unknown[] = Array.isArray(allowedTools) ? [...allowedTools] : [];
  const unique = new Set(names);
  if (names.length < 1 || names.length > MAX_TOOLS || unique.size !== names.length || !names.every(isName)) {
    throw invalidInput('allowedTools', `must be 1 to ${MAX_TOOLS} unique non-empty strings`);
  }
  return unique as ReadonlySet<string>;
}

/** One child speaking newline-delimited JSON-RPC. The first failure wins and is final for the session. */
class Connection {
  failure: string | null = null;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; timer: NodeJS.Timeout }>();
  private readonly exited: Promise<void>;
  private chunks: Buffer[] = [];
  private size = 0;
  private nextId = 1;
  private reaped = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly child: ChildProcess, private readonly timeoutMs: number) {
    child.stdin?.on('error', noop); // an analyzer that exits unread must not crash the daemon with EPIPE
    child.stdout?.on('error', noop).on('data', (chunk: Buffer) => this.onData(chunk));
    this.exited = new Promise(resolve => {
      child.once('exit', (code, signal) => { this.fail(`exited:${code ?? signal}`, false); void this.killTree(); resolve(); });
      child.on('error', error => { this.fail(`spawn-failed:${errorCode(error)}`); if (child.pid === undefined) resolve(); });
    });
  }

  request(method: string, params: Json): Promise<Reply> {
    if (this.failure !== null) return Promise.resolve({ ok: false, reason: this.failure });
    const id = this.nextId++;
    return new Promise(resolve => {
      // Session-fatal: a late answer can never be paired with a retired id.
      this.pending.set(id, { resolve, timer: setTimeout(() => this.fail('timeout'), this.timeoutMs).unref() });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void { if (this.failure === null) this.write({ method }); }

  /** Fails a live session and returns the reason that won. */
  reject(reason: string): string { this.fail(reason); return this.failure ?? reason; }

  fail(reason: string, kill = true): void {
    if (this.failure !== null) return;
    this.failure = reason;
    this.chunks = [];
    this.size = 0;
    this.child.stdout?.destroy();
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve({ ok: false, reason }); }
    this.pending.clear();
    if (kill) void this.killTree();
  }

  close(): Promise<void> { return (this.closing ??= this.shutdown()); }

  private async shutdown(): Promise<void> {
    const graceful = this.failure === null;
    this.fail('closed', false);
    if (process.platform === 'win32') await this.killTree(); // before EOF: an exited root orphans its tree
    this.child.stdin?.end();
    if (graceful) await this.waitExit();
    await this.killTree();
    if (!(await this.waitExit())) this.child.kill('SIGKILL');
  }

  private waitExit(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>(resolve => { timer = setTimeout(resolve, CLOSE_GRACE_MS, false); });
    return Promise.race([this.exited.then(() => true), late]).finally(() => clearTimeout(timer));
  }

  /** POSIX signals the whole group, which can outlive its leader; Windows /T needs a live root. */
  private killTree(): Promise<void> {
    const { pid, exitCode, signalCode } = this.child;
    if (pid === undefined) return Promise.resolve();
    if (process.platform !== 'win32') {
      // An exited leader's group is signalled once, at its exit: afterwards its pid (= pgid) may be reused.
      if (this.reaped) return Promise.resolve();
      this.reaped = exitCode !== null || signalCode !== null;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* ESRCH: the group is gone; nothing else is actionable */ }
      return Promise.resolve();
    }
    if (exitCode !== null || signalCode !== null) return Promise.resolve();
    const root = process.env.SystemRoot;
    const taskkill = path.win32.join(root && WINDOWS_ABSOLUTE.test(root) ? root : 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => resolve()));
  }

  private write(frame: Json): void { this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`); }

  private onData(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      if (!this.hold(chunk.subarray(start, end))) return;
      const line = Buffer.concat(this.chunks, this.size);
      this.chunks = [];
      this.size = 0;
      start = end + 1;
      this.onLine(line);
    }
    this.hold(chunk.subarray(start));
  }

  /** Buffers a partial line; past MCP_FRAME_LIMIT_BYTES it fails at once instead of waiting for a newline. */
  private hold(piece: Buffer): boolean {
    if (this.failure !== null) return false;
    if (this.size + piece.length > MCP_FRAME_LIMIT_BYTES) { this.fail('response-too-large'); return false; }
    if (piece.length > 0) { this.chunks.push(piece); this.size += piece.length; }
    return true;
  }

  private onLine(raw: Buffer): void {
    const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw; // Python MCP servers write CRLF on Windows
    if (line.length === 0) return;
    let message: unknown;
    try { message = JSON.parse(utf8.decode(line)); } catch { return this.fail('protocol-violation'); }
    if (!isObject(message) || message.jsonrpc !== '2.0') return this.fail('protocol-violation');
    if (typeof message.method !== 'string') return this.settle(message);
    if (!Object.hasOwn(message, 'id')) return; // a server notification: ignored
    // Echo only a JSON-RPC id (a nested one would overflow JSON.stringify), and stop a server that floods unread requests.
    const { id } = message;
    if (!(isName(id) || Number.isFinite(id)) || (this.child.stdin?.writableLength ?? 0) > MCP_FRAME_LIMIT_BYTES) return this.fail('protocol-violation');
    this.write({ id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) });
  }

  private settle(message: Json): void {
    const { id, result, error } = message;
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    const hasResult = Object.hasOwn(message, 'result');
    if (entry === undefined || hasResult === Object.hasOwn(message, 'error')
      || (hasResult ? !isObject(result) : !(isObject(error) && Number.isSafeInteger(error.code)))) return this.fail('protocol-violation');
    this.pending.delete(id as number);
    clearTimeout(entry.timer);
    entry.resolve(hasResult ? { ok: true, result: result as Json } : { ok: false, reason: `rpc-error:${(error as Json).code}` });
  }
}

async function listTools(conn: Connection): Promise<readonly AnalyzerTool[] | string> {
  const tools: AnalyzerTool[] = [];
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = await conn.request('tools/list', cursor === undefined ? {} : { cursor });
    if (!reply.ok) return reply.reason;
    const { tools: items, nextCursor } = reply.result;
    const more = typeof nextCursor === 'string';
    if (!Array.isArray(items) || !(more || nextCursor === undefined || nextCursor === null)) return conn.reject('protocol-violation');
    for (const tool of items) {
      if (!isObject(tool) || !isName(tool.name) || names.has(tool.name) || !isPlain(tool.inputSchema)) return conn.reject('protocol-violation');
      names.add(tool.name);
      tools.push(Object.freeze({ name: tool.name, inputSchema: tool.inputSchema }));
    }
    if (!more) return Object.freeze(tools);
    cursor = nextCursor;
  }
  return conn.reject('protocol-violation');
}

async function handshake(conn: Connection): Promise<{ server: AnalyzerServerInfo; tools: readonly AnalyzerTool[] } | string> {
  const init = await conn.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'moe-daemon', version: VERSION } });
  if (!init.ok) return init.reason;
  const { serverInfo, protocolVersion } = init.result;
  const { name, version } = isObject(serverInfo) ? serverInfo : {};
  if (!isName(name) || !isName(version) || !isName(protocolVersion)) return conn.reject('protocol-violation');
  conn.notify('notifications/initialized');
  const tools = await listTools(conn);
  return typeof tools === 'string' ? tools : { server: Object.freeze({ name, version, protocolVersion }), tools };
}

async function callTool(conn: Connection, allowed: ReadonlySet<string>, listed: ReadonlySet<string>, maxBytes: number,
  tool: string, args: Readonly<Record<string, unknown>>): Promise<AnalyzerCallResult> {
  if (typeof tool !== 'string') throw invalidInput('tool', 'must be a string');
  let snapshot: unknown;
  try { snapshot = JSON.parse(JSON.stringify(args)); } catch { snapshot = null; }
  if (!isPlain(args) || !isPlain(snapshot)) throw invalidInput('args', 'must be a JSON-serializable plain object');
  if (!allowed.has(tool)) return { ok: false, reason: 'tool-not-allowed' };
  if (!listed.has(tool)) return { ok: false, reason: 'tool-not-listed' };
  const reply = await conn.request('tools/call', { name: tool, arguments: snapshot });
  if (!reply.ok) return reply;
  if (reply.result.isError === true) return { ok: false, reason: 'tool-error' };
  const { content } = reply.result;
  if (!Array.isArray(content)) return { ok: false, reason: conn.reject('protocol-violation') };
  const text = content.map(item => (isObject(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')).join('');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { ok: true, text, truncated: false };
  // StringDecoder.write holds back an incomplete trailing sequence, so the cut never splits a character.
  return { ok: true, text: new StringDecoder('utf8').write(bytes.subarray(0, maxBytes)), truncated: true };
}

/**
 * Spawns the analyzer and completes initialize, notifications/initialized and paged tools/list. A malformed launch or
 * allowlist throws invalidInput before any spawn; every other failure is a reason, after the tree is killed.
 */
export async function openAnalyzerSession(launch: AnalyzerLaunch, allowedTools: readonly string[]): Promise<AnalyzerOpenResult> {
  const spec = snapshotLaunch(launch);
  const allowed = snapshotAllowed(allowedTools);
  let child: ChildProcess;
  try {
    // detached gives POSIX a process group, so close() reaches grandchildren such as language servers.
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'ignore'], shell: false,
      windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) {
    return { ok: false, reason: `spawn-failed:${errorCode(error)}` };
  }
  const conn = new Connection(child, spec.timeoutMs);
  const opened = await handshake(conn);
  if (typeof opened === 'string') { conn.fail(opened); await conn.close(); return { ok: false, reason: opened }; }
  const listed = new Set(opened.tools.map(tool => tool.name));
  const call = (tool: string, args: Readonly<Record<string, unknown>>) => callTool(conn, allowed, listed, spec.maxResponseBytes, tool, args);
  return { ok: true, session: Object.freeze({ server: opened.server, tools: opened.tools, call, close: () => conn.close() }) };
}

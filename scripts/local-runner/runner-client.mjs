// Client for the daemon's authenticated /runner channel (CQ-V04b1): the host's trusted check runner calls moe.* tools
// through it, and it is the only local-runner code that reads the runner key. It dials only the loopback daemon named by
// <projectPath>/.moe/daemon.json (guest-session.mjs's open, size and record discipline). The key is read once per open,
// handed straight to the WebSocket and never stored, returned or logged; this module never logs. Every failure is one
// fixed RUNNER_* code in a fixed message: never a path, a key byte or upstream text. A refused socket is accepted and
// then closed with 1008, so an open resolves only after a `ping` round trip proves the key was accepted.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DAEMON_INFO_BYTES } from './guest-session.mjs';

export const RUNNER_KEY_HEADER = 'x-moe-runner-key'; // mirrors server/runnerChannel.ts
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const TOOL_RE = /^moe\.[a-z_]+$/, NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const INFO = 'RUNNER_DAEMON_INFO_INVALID';
const validTimeout = ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647; // setTimeout's ceiling
const isRecord = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const runnerError = (code, extra) => Object.assign(new Error(`Runner channel failed: ${code}.`), { code }, extra);

/** `<MOE_RUNNER_KEY_DIR | ~/.moe/runner-keys>/<first 32 hex of sha256(projectPath)>.key`, the mirror of runnerKeyPath. */
export function runnerKeyFile(projectPath, env = process.env) {
  const configured = env.MOE_RUNNER_KEY_DIR?.trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), '.moe', 'runner-keys');
  return path.join(dir, `${createHash('sha256').update(projectPath).digest('hex').slice(0, 32)}.key`);
}

// No symlink follow and no FIFO block on POSIX (both flags are 0 where unsupported); at most `limit` bytes of a regular file.
async function readSmall(file, limit, missing, invalid) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) throw new Error('not a file');
    const bytes = Buffer.alloc(limit + 1); // the extra byte detects a file past the cap; a short read fails closed in the parse
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('too large');
    return bytes.toString('utf8', 0, bytesRead);
  } catch (error) {
    throw runnerError(error?.code === 'ENOENT' ? missing : invalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function discover(projectPath) {
  let info;
  try { info = JSON.parse(await readSmall(path.join(projectPath, '.moe', 'daemon.json'), MAX_DAEMON_INFO_BYTES, INFO, INFO)); } catch { throw runnerError(INFO); }
  if (!isRecord(info) || info.projectPath !== projectPath || !Number.isInteger(info.port) || info.port < 1 || info.port > 65_535) throw runnerError(INFO);
  if (Object.hasOwn(info, 'bindHost') && !['127.0.0.1', '::1'].includes(info.bindHost)) throw runnerError('RUNNER_DAEMON_NOT_LOOPBACK');
  return info;
}

// The key exists only as this call's argument, so no longer-lived frame holds it.
function dial(WebSocket, url, key) {
  if (!KEY_RE.test(key)) throw runnerError('RUNNER_KEY_INVALID');
  try { return new WebSocket(url, { headers: { [RUNNER_KEY_HEADER]: key } }); } catch { throw runnerError('RUNNER_CONNECT_FAILED'); }
}

// Pending requests settle exactly once, through take(); an entry leaves the map before it settles.
function wire(socket, defaultTimeoutMs) {
  const pending = new Map();
  let [nextId, opened, down] = [0, false, null];
  const take = id => {
    const entry = pending.get(id);
    if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.onAbort); }
    return entry;
  };
  const drop = (id, code, extra) => take(id)?.reject(runnerError(code, extra));
  const closeWith = code => { down ??= code; for (const id of [...pending.keys()]) drop(id, down); };
  const transmit = (id, data) => { try { socket.send(data); } catch { drop(id, 'RUNNER_DISCONNECTED'); } };

  const request = (method, params, { signal, timeoutMs = defaultTimeoutMs } = {}) => new Promise((resolve, reject) => {
    if (!validTimeout(timeoutMs) || (signal !== undefined && !(signal instanceof AbortSignal))) return reject(runnerError('RUNNER_CALL_INVALID'));
    if (down || signal?.aborted) return reject(runnerError(down ?? 'RUNNER_ABORTED'));
    const id = ++nextId;
    let data; // before any timer or listener exists, so an unserialisable argument leaves nothing behind
    try { data = JSON.stringify({ jsonrpc: '2.0', id, method, params }); } catch { return reject(runnerError('RUNNER_CALL_INVALID')); }
    const onAbort = () => drop(id, 'RUNNER_ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, { resolve, reject, signal, onAbort, timer: setTimeout(() => drop(id, 'RUNNER_CALL_TIMEOUT'), timeoutMs), data });
    if (opened) transmit(id, data);
  });

  socket.addEventListener('open', () => { opened = true; for (const [id, entry] of pending) transmit(id, entry.data); });
  socket.addEventListener('close', event => closeWith(event.code === 1008 ? 'RUNNER_AUTH_REFUSED' : 'RUNNER_DISCONNECTED'));
  socket.addEventListener('error', () => closeWith('RUNNER_DISCONNECTED'));
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message) || !pending.has(message.id)) return;
    const { code, data } = isRecord(message.error) ? message.error : {};
    if (!isRecord(message.error)) take(message.id).resolve(message.result);
    else drop(message.id, 'RUNNER_TOOL_ERROR', { rpcCode: Number.isInteger(code) ? code : undefined, codeName: typeof data?.codeName === 'string' && NAME_RE.test(data.codeName) ? data.codeName : undefined });
  });

  return { request, close() { closeWith('RUNNER_DISCONNECTED'); try { socket.close(); } catch { /* already closed */ } } };
}

/** Resolves {call(tool, args, {signal, timeoutMs}), close()}: call resolves the tool's parsed result or rejects a fixed RUNNER_* code. */
export async function openRunnerChannel(input = {}) {
  const { projectPath, timeoutMs = 30_000, signal, WebSocket = globalThis.WebSocket } = isRecord(input) ? input : {};
  if (typeof projectPath !== 'string' || projectPath === '' || projectPath.includes('\0') || !validTimeout(timeoutMs)
    || (signal !== undefined && !(signal instanceof AbortSignal))) throw runnerError('RUNNER_INPUT_INVALID');
  if (typeof WebSocket !== 'function') throw runnerError('RUNNER_WEBSOCKET_UNAVAILABLE');
  const info = await discover(path.resolve(projectPath));
  const link = wire(dial(WebSocket, `ws://${info.bindHost === '::1' ? '[::1]' : '127.0.0.1'}:${info.port}/runner`, await readSmall(runnerKeyFile(info.projectPath), 64, 'RUNNER_KEY_MISSING', 'RUNNER_KEY_INVALID')), timeoutMs);
  await link.request('ping', {}, { signal }).catch(error => {
    link.close();
    throw runnerError({ RUNNER_DISCONNECTED: 'RUNNER_CONNECT_FAILED', RUNNER_CALL_TIMEOUT: 'RUNNER_CONNECT_TIMEOUT' }[error.code] ?? error.code);
  });
  return Object.freeze({
    close: link.close,
    async call(tool, args, options) {
      if (typeof tool !== 'string' || !TOOL_RE.test(tool) || !isRecord(args)) throw runnerError('RUNNER_CALL_INVALID');
      const text = (await link.request('tools/call', { name: tool, arguments: args }, options))?.content?.[0]?.text;
      try { return JSON.parse(typeof text === 'string' ? text : undefined); } catch { throw runnerError('RUNNER_RESPONSE_INVALID'); }
    },
  });
}

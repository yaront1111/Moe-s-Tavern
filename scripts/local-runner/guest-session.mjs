// Host side of the CQ-R08 bridge: one `multipass exec ... moe-supervisor bridge` session for one host-bound job.
// name, binding, sessionId, daemonInfoPath, forward, provider and the callbacks are trusted host-controller inputs
// (R06 supplies ownership; forward must reach that same local daemon). Every guest byte is untrusted. The guest gets
// no daemon address, port, token or setting: its argv is the constant bridgeArgv(name) and nothing is added to its
// environment. A request reaches forward only after scopeRequest, a depth bound and a fresh loopback check of
// daemon.json. Child output reaches only onOutput, as bytes; the observation comes only from a supervisor frame.
// This is local session logic, not VM, Multipass or network-isolation certification (CQ-R13): executionReady is false.
import { spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { bridgeArgv, createFrameDecoder, encodeFrame, parseGuestFrame, scopeRequest } from './guest-bridge.mjs';

export const MAX_DAEMON_INFO_BYTES = 16_384;
export const MAX_PENDING_REQUESTS = 64; // the supervisor's MAX_CONNECTIONS * MAX_IN_FLIGHT
export const MAX_ARGUMENT_DEPTH = 64;
export const MAX_RESPONSE_BYTES = 1_048_576; // headroom under the supervisor's 4 MiB re-encode of each reply
const MAX_TIMEOUT_MS = 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const CONTROL = /[\x00-\x1f\x7f]/;
const EXECUTION = ['attemptId', 'generation', 'sessionId'];
// Host identity stamped after scoping, only onto tools whose daemon schema accepts it.
const STAMPED = { 'moe.get_context': ['sessionId'], 'moe.start_step': EXECUTION, 'moe.complete_step': EXECUTION, 'moe.complete_task': EXECUTION };
const TIMEOUT = Symbol('timeout');
// Only internal code literals reach here, so a message never carries a path, caller value, guest byte or upstream text.
const sessionError = code => Object.assign(new Error(`Guest bridge session failed: ${code}.`), { code });
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refusal = (id, code) => encodeFrame({ kind: 'response', id, ok: false, error: { code } });

/**
 * Resolves {observation, executionReady: false} only after a clean stdout EOF, provider close code 0, exactly one
 * exit observation and no owed reply; a nonzero job exit inside that observation is data, not a session failure.
 * Anything else rejects with a fixed SESSION_* code and never yields an observation. forward(tool, args, {signal}) is
 * the trusted daemon transport returning an MCP tool result; onOutput(stream, Buffer) and onObservation(frame) are
 * synchronous. provider: {executable = 'multipass', spawn = child_process.spawn}. timeoutMs (1-60000) bounds hello,
 * each forward, each stdin write and the wait for the provider to exit after teardown.
 */
export async function runGuestSession(input) {
  let options;
  try {
    const { name, binding, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, provider = {}, timeoutMs = 30_000 } = input;
    const { executable = 'multipass', spawn = spawnProcess } = isRecord(provider) ? provider : { spawn: null };
    const frozen = Object.freeze({ ...binding }); // a later caller edit cannot change authorization
    scopeRequest({ kind: 'request', id: 1, tool: 'moe.get_context', args: {} }, frozen); // validates the binding only
    if (typeof sessionId === 'string' && sessionId.trim() !== '' && sessionId.length <= 255 && !/[\0\r\n]/.test(sessionId)
      && typeof daemonInfoPath === 'string' && path.isAbsolute(daemonInfoPath) && !CONTROL.test(daemonInfoPath)
      && [forward, onOutput, onObservation, spawn].every(fn => typeof fn === 'function')
      && (signal === undefined || signal instanceof AbortSignal)
      && typeof executable === 'string' && executable.trim() !== '' && !CONTROL.test(executable)
      && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS) {
      options = { argv: bridgeArgv(name), binding: frozen, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, timeoutMs };
      options.start = () => spawn(executable, options.argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } catch { options = undefined; }
  if (!options) throw sessionError('SESSION_INPUT_INVALID');
  const refused = await daemonRefusal(options.daemonInfoPath);
  if (refused || options.signal?.aborted) throw sessionError(refused ?? 'SESSION_ABORTED');
  let child;
  try { child = options.start(); } catch { child = null; }
  if (typeof child?.kill !== 'function' || ![child, child.stdin, child.stdout, child.stderr].every(item => typeof item?.on === 'function')) {
    throw sessionError('SESSION_SPAWN_FAILED');
  }
  return relay(child, options);
}

// Admits only an absent own bindHost (the daemon's 127.0.0.1 default) or a literal loopback address: no DNS,
// coercion, environment fallback, wildcard or WSL exception. Returns null or the refusal code.
async function daemonRefusal(file) {
  let handle;
  let info;
  try {
    // No symlink follow and no FIFO block on POSIX; both flags are 0 where unsupported.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) return 'SESSION_DAEMON_INFO_INVALID';
    const bytes = Buffer.alloc(MAX_DAEMON_INFO_BYTES + 1); // the extra byte detects a file that grew past the cap
    let size = 0;
    for (let read; read !== 0 && size < bytes.length; size += read) ({ bytesRead: read } = await handle.read(bytes, size, bytes.length - size, size));
    if (size > MAX_DAEMON_INFO_BYTES) return 'SESSION_DAEMON_INFO_INVALID';
    info = JSON.parse(bytes.toString('utf8', 0, size));
  } catch {
    return 'SESSION_DAEMON_INFO_INVALID';
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!isRecord(info)) return 'SESSION_DAEMON_INFO_INVALID';
  return Object.hasOwn(info, 'bindHost') && !LOOPBACK.has(info.bindHost) ? 'SESSION_DAEMON_NOT_LOOPBACK' : null;
}

function relay(child, options) {
  return new Promise((resolve, reject) => {
    const session = { child, options, resolve, reject, decoder: createFrameDecoder(), controller: new AbortController(), timers: new Set(),
      pending: [], lastId: 0, opened: false, observation: null, ended: false, failure: null, closing: false, settled: false };
    session.hello = later(session, () => stop(session, 'SESSION_TIMEOUT'));
    session.onAbort = () => stop(session, 'SESSION_ABORTED');
    options.signal?.addEventListener('abort', session.onAbort, { once: true });
    child.on('error', () => stop(session, 'SESSION_SPAWN_FAILED'));
    child.on('close', code => {
      if (code !== 0) stop(session, 'SESSION_PROVIDER_FAILED');
      else if (!session.ended || !session.observation || session.pending.length > 0) stop(session, 'SESSION_PROTOCOL_VIOLATION');
      settle(session);
    });
    child.stdin.on('error', () => stop(session, 'SESSION_PROVIDER_FAILED'));
    child.stdout.on('error', () => stop(session, 'SESSION_PROVIDER_FAILED'));
    child.stdout.on('data', chunk => receive(session, chunk));
    child.stdout.on('end', () => {
      if (session.closing) return;
      try { session.decoder.end(); } catch { return stop(session, 'SESSION_PROTOCOL_VIOLATION'); }
      session.ended = true;
      stop(session);
    });
    child.stderr.on('error', () => {}).resume(); // drained unread: stderr is never protocol data
  });
}

// Hello first and once, then requests and output, then one observation. Output bytes go only to onOutput.
function receive(session, chunk) {
  if (session.closing) return; // stdout keeps draining, unread, after teardown
  try {
    for (const raw of session.decoder.push(chunk)) {
      const frame = parseGuestFrame(raw);
      if (session.closing) return;
      if (session.opened === (frame.kind === 'hello') || session.observation) throw sessionError('SESSION_PROTOCOL_VIOLATION');
      if (frame.kind === 'hello') {
        session.opened = true;
        cancel(session, session.hello);
      } else if (frame.kind === 'observation') {
        session.observation = frame;
      } else if (frame.kind === 'output') {
        try { session.options.onOutput(frame.stream, frame.data); } catch { stop(session, 'SESSION_CALLBACK_FAILED'); }
      } else {
        // One last-id counter: ids strictly increase, so a replay needs no history.
        if (frame.id <= session.lastId || session.pending.length >= MAX_PENDING_REQUESTS) throw sessionError('SESSION_PROTOCOL_VIOLATION');
        session.lastId = frame.id;
        if (session.pending.push(frame) === 1) pump(session);
      }
    }
  } catch { stop(session, 'SESSION_PROTOCOL_VIOLATION'); }
}

// Serves owed requests one at a time, in order; a request leaves the queue only once its one reply is written.
async function pump(session) {
  while (session.pending.length > 0) {
    try {
      const bytes = await reply(session, session.pending[0]);
      if (session.closing) return;
      await bounded(session, new Promise((done, failed) => session.child.stdin.write(bytes, error => (error ? failed(error) : done()))));
    } catch (error) {
      return stop(session, error === TIMEOUT ? 'SESSION_TIMEOUT' : 'SESSION_PROVIDER_FAILED');
    }
    session.pending.shift();
  }
}

// Exactly one reply frame per request, under its own id: a fixed refusal code or the scoped call's result. No retry.
async function reply(session, request) {
  const { binding, sessionId, daemonInfoPath, forward } = session.options;
  let scoped;
  try { scoped = scopeRequest(request, binding); } catch (error) { return refusal(request.id, error.code); }
  if (!withinDepth(scoped.args)) return refusal(request.id, 'BRIDGE_ARGUMENT_TOO_DEEP');
  const refused = await daemonRefusal(daemonInfoPath);
  if (refused) stop(session, refused);
  if (session.closing) return null;
  const identity = { attemptId: binding.attemptId, generation: binding.generation, sessionId };
  const args = { ...scoped.args };
  for (const key of STAMPED[scoped.tool] ?? []) args[key] = identity[key];
  let result;
  try {
    result = await bounded(session, forward(scoped.tool, args, { signal: session.controller.signal }));
  } catch (error) {
    if (error === TIMEOUT) throw error;
    return refusal(request.id, 'BRIDGE_UPSTREAM_FAILED'); // the error itself is never echoed
  }
  let clean;
  try { clean = JSON.parse(JSON.stringify(result)); } catch { clean = undefined; }
  if (clean?.isError === true) return refusal(request.id, 'BRIDGE_UPSTREAM_FAILED');
  if (!isRecord(clean) || !withinDepth(clean)) return refusal(request.id, 'BRIDGE_RESPONSE_INVALID');
  try { return encodeFrame({ kind: 'response', id: request.id, ok: true, result: clean }, MAX_RESPONSE_BYTES); } catch {
    return refusal(request.id, 'BRIDGE_RESPONSE_INVALID');
  }
}

// Iterative, so a guest- or daemon-chosen nesting cannot exhaust the stack.
function withinDepth(value) {
  for (const stack = [[value, 1]]; stack.length > 0;) {
    const [item, depth] = stack.pop();
    if (item === null || typeof item !== 'object') continue;
    if (depth > MAX_ARGUMENT_DEPTH) return false;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}

function bounded(session, promise) {
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = later(session, () => reject(TIMEOUT)); });
  return Promise.race([promise, deadline]).finally(() => cancel(session, timer));
}

function later(session, fn) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    fn();
  }, session.options.timeoutMs);
  session.timers.add(timer);
  return timer;
}

function cancel(session, timer) {
  clearTimeout(timer);
  session.timers.delete(timer);
}

// The one idempotent cleanup path (no code on a clean EOF): stop dispatch, abort forwards, close stdin so the
// supervisor's host-EOF path reaps the job group, keep draining stdout, and kill only the local provider if it is
// still running timeoutMs later. That kill stays a failure and is never evidence that the guest job ended.
function stop(session, code) {
  if (code) session.failure ??= code;
  if (session.closing) return;
  session.closing = true;
  session.controller.abort();
  session.child.stdin.destroy();
  later(session, () => {
    session.failure ??= 'SESSION_TIMEOUT';
    session.child.kill('SIGKILL');
    settle(session);
  });
}

function settle(session) {
  if (session.settled) return;
  session.settled = true;
  for (const timer of session.timers) clearTimeout(timer);
  session.options.signal?.removeEventListener('abort', session.onAbort);
  if (session.failure) return session.reject(sessionError(session.failure));
  try { session.options.onObservation(session.observation); } catch { return session.reject(sessionError('SESSION_CALLBACK_FAILED')); }
  session.resolve(Object.freeze({ observation: session.observation, executionReady: false }));
}

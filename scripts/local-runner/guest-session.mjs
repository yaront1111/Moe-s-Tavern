// Host side of the CQ-R08 bridge: one supervisor bridge session for one host-bound job, carried by one OpenSSH stream
// (guest-stream.mjs, CQ-R14d2) to the owned guest's forced-command supervisor, never by `multipass exec`, whose stdio
// truncates stdin on Linux and delivers none on Windows. name, binding, sessionId, daemonInfoPath, forward, provider
// and the callbacks are trusted host-controller inputs (R06 supplies ownership; forward must reach that same local
// daemon). Every guest byte is untrusted. The guest gets no daemon address, port, token or setting: its argv is
// sshStreamArgv for this VM's pinned key, known_hosts and fresh address, and nothing is added to its environment.
// A request reaches forward only after scopeRequest, a depth bound and a fresh loopback bind report from the daemon
// itself. Child output reaches only onOutput, as bytes; the observation comes only from a supervisor frame.
// Its stdin starts with the CQ-R10b job frame, the one place the job's credential goes.
// This is local session logic, not VM, Multipass or network-isolation certification (CQ-R13): executionReady is false.
import { spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JOB_IDENTITIES } from './guest-bootstrap.mjs';
import { createFrameDecoder, encodeFrame, jobFrame, parseGuestFrame, scopeRequest } from './guest-bridge.mjs';
import { openGuestStream } from './guest-stream.mjs';
import { invoker, isOwnedInstanceName, QUERY_TIMEOUT_MS } from './lifecycle.mjs';

export const MAX_DAEMON_INFO_BYTES = 16_384;
export const MAX_HEALTH_BYTES = 65_536; // the daemon's own probeDaemonHealth cap
export const MAX_PENDING_REQUESTS = 64; // the supervisor's MAX_CONNECTIONS * MAX_IN_FLIGHT
export const MAX_ARGUMENT_DEPTH = 64;
export const MAX_RESPONSE_BYTES = 1_048_576; // headroom under the supervisor's 4 MiB re-encode of each reply
const MAX_TIMEOUT_MS = 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const CONTROL = /[\x00-\x1f\x7f]/;
const EXECUTION = ['attemptId', 'generation', 'sessionId'];
// Host identity stamped after scoping, only onto the tools whose daemon schema accepts it: the same six moe-proxy stamps
// (EXECUTION_IDENTITY_TOOLS). qa_approve and qa_reject need it under verified-local (delivery/reviewBinding.ts).
const STAMPED = { 'moe.get_context': ['sessionId'], 'moe.start_step': EXECUTION, 'moe.complete_step': EXECUTION, 'moe.complete_task': EXECUTION,
  'moe.qa_approve': EXECUTION, 'moe.qa_reject': EXECUTION };
const TIMEOUT = Symbol('timeout');
// Only internal code literals reach here, so a message never carries a path, caller value, guest byte or upstream text.
const sessionError = code => Object.assign(new Error(`Guest bridge session failed: ${code}.`), { code });
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refusal = (id, code) => encodeFrame({ kind: 'response', id, ok: false, error: { code } });

/**
 * Resolves {observation, executionReady: false} only after a clean stdout EOF, provider close code 0 and exactly one
 * exit observation; a nonzero job exit inside that observation is data, not a session failure. That finish abandons
 * every request the guest still owes: an in-flight forward sees its signal abort, a queued one is never forwarded and
 * no reply is written after it. An aborted forward may already have acted upstream; nothing reports that undone.
 * Anything else rejects with a fixed SESSION_* code and never yields an observation. forward(tool, args, {signal}) is
 * the trusted daemon transport returning an MCP tool result; onOutput(stream, Buffer) and onObservation(frame) are
 * synchronous. provider: {executable = 'multipass', run = execFile} for the info read, plus openGuestStream's optional
 * ssh, keyDir and spawn = child_process.spawn; it is copied at entry. timeoutMs (1-60000) bounds hello,
 * each forward, each stdin write and the wait for the provider to exit after teardown. job: {cli, credential: {name,
 * value}} is encoded once, with the binding's role, into the job frame that is the first stdin write. The credential
 * reaches only that frame: never argv, spawn options, env, an error, onOutput or any other provider call.
 */
export async function runGuestSession(input) {
  let options;
  try {
    const { name, binding, job, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, provider = {}, timeoutMs = 30_000 } = input;
    const { executable = 'multipass', spawn = spawnProcess } = isRecord(provider) ? provider : { spawn: null };
    const frozen = Object.freeze({ ...binding }); // a later caller edit cannot change authorization
    scopeRequest({ kind: 'request', id: 1, tool: 'moe.get_context', args: {} }, frozen); // validates the binding only
    const keys = isRecord(job) ? Object.keys(job) : [];
    if (keys.length !== 2 || !keys.includes('cli') || !keys.includes('credential')) throw sessionError('SESSION_INPUT_INVALID');
    const first = jobFrame({ cli: job.cli, role: frozen.role, credential: job.credential }); // the role comes only from the binding
    if (isOwnedInstanceName(name) && typeof sessionId === 'string' && sessionId.trim() !== '' && sessionId.length <= 255 && !/[\0\r\n]/.test(sessionId)
      && typeof daemonInfoPath === 'string' && path.isAbsolute(daemonInfoPath) && !CONTROL.test(daemonInfoPath)
      && [forward, onOutput, onObservation, spawn].every(fn => typeof fn === 'function')
      && (signal === undefined || signal instanceof AbortSignal)
      && typeof executable === 'string' && executable.trim() !== '' && !CONTROL.test(executable)
      && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS) {
      // executable and run still drive the info read (and PKILL/PGREP); a later caller edit cannot change the route.
      options = { name, provider: Object.freeze({ ...provider, executable, spawn }), binding: frozen, first, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, timeoutMs };
    }
  } catch { options = undefined; }
  if (!options) throw sessionError('SESSION_INPUT_INVALID');
  const refused = await daemonRefusal(options.daemonInfoPath, { timeoutMs: options.timeoutMs });
  if (refused || options.signal?.aborted) throw sessionError(refused ?? 'SESSION_ABORTED');
  let child;
  // The only spawn: a transport refusal (bad client or key path, no address) spawns nothing and is SESSION_SPAWN_FAILED.
  try { child = await openGuestStream({ name: options.name, mode: 'bridge', provider: options.provider }); } catch { child = null; }
  if (typeof child?.kill !== 'function' || ![child, child.stdin, child.stdout, child.stderr].every(item => typeof item?.on === 'function')) {
    throw sessionError('SESSION_SPAWN_FAILED');
  }
  return relay(child, options);
}

// --- daemon admission shared with runner-client.mjs and vm-control.mjs ---

const windowsDrive = value => path.win32.normalize(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A port of comparableProjectPath (packages/moe-proxy/src/utils.ts, twin in packages/moe-daemon/src/util/projectPath.ts):
 * D:/x, D:\x and /mnt/d/x are one project, and so are their relative and non-normalized spellings. */
export function canonicalProjectPath(projectPath) {
  const raw = projectPath.trim();
  // A drive path is matched raw: off Windows, path.resolve would treat it as relative. /mnt/<d> is matched only after
  // normalizing: path.resolve on POSIX, path.posix.normalize of the raw string on win32, where resolve prefixes the cwd drive.
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return windowsDrive(raw);
  const resolved = path.resolve(raw);
  const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(process.platform === 'win32' ? path.posix.normalize(raw) : resolved);
  if (wsl) {
    const rest = (wsl[2] ?? '').replace(/\/+$/, '');
    return `${wsl[1]}:${rest ? `/${rest}` : ''}`.toLowerCase();
  }
  return /^[a-zA-Z]:[\\/]/.test(resolved) ? windowsDrive(resolved) : process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Resolves '127.0.0.1' or '::1', the loopback host this project's daemon answered on, else null; it never rejects.
 * info is daemon.json's parsed record: repository content, so it can only refuse. A non-record, an own bindHost other
 * than '127.0.0.1' or '::1', or an unusable port resolves null with no request. Otherwise one GET /health goes to that
 * port on loopback (no agent, proxy or redirect), under one total deadline and a MAX_HEALTH_BYTES body cap. Only a 200,
 * healthy report naming projectPath (canonicalProjectPath) with its own bindHost exactly '127.0.0.1' or '::1' admits.
 * With `spelling`, the report must also name the project exactly so: runner-client reads the key filed under that string.
 */
export function loopbackDaemonHost(info, projectPath, { timeoutMs = 5_000, signal, spelling } = {}) {
  const port = info?.port;
  if (!isRecord(info) || (Object.hasOwn(info, 'bindHost') && !LOOPBACK.has(info.bindHost))
    || !Number.isInteger(port) || port < 1 || port > 65_535) return Promise.resolve(null);
  const host = info.bindHost === '::1' ? '::1' : '127.0.0.1';
  return new Promise(resolve => {
    let request;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value) { clearTimeout(timer); request?.destroy(); resolve(value); } // idempotent: resolve settles once
    try {
      request = http.get({ host, port, path: '/health', agent: false, signal }, response => {
        if (response.statusCode !== 200) return finish(null);
        const chunks = [];
        let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_HEALTH_BYTES) finish(null); else chunks.push(chunk); });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try {
            const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(isRecord(report) && report.status === 'healthy' && typeof report.projectPath === 'string'
              && canonicalProjectPath(report.projectPath) === canonicalProjectPath(projectPath) && (spelling === undefined || report.projectPath === spelling)
              && LOOPBACK.has(report.bindHost) ? host : null);
          } catch { finish(null); }
        });
      });
      request.on('error', () => finish(null));
    } catch { finish(null); }
  });
}

// daemonInfoPath, a trusted input, is <project>/.moe/daemon.json: it names the project, never the file's projectPath
// field. The file may refuse (no record or port: info invalid); only the daemon's own report admits. Null or the code.
async function daemonRefusal(file, { timeoutMs, signal } = {}) {
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
  if (!isRecord(info) || !Number.isInteger(info.port) || info.port < 1 || info.port > 65_535) return 'SESSION_DAEMON_INFO_INVALID';
  return (await loopbackDaemonHost(info, path.dirname(path.dirname(file)), { timeoutMs, signal })) ? null : 'SESSION_DAEMON_NOT_LOOPBACK';
}

function relay(child, options) {
  return new Promise((resolve, reject) => {
    const session = { child, options, resolve, reject, decoder: createFrameDecoder(), controller: new AbortController(), timers: new Set(),
      pending: [], lastId: 0, opened: false, observation: null, ended: false, failure: null, closing: false, settled: false };
    session.hello = later(session, () => stop(session, 'SESSION_TIMEOUT'));
    session.onAbort = () => stop(session, 'SESSION_ABORTED');
    options.signal?.addEventListener('abort', session.onAbort, { once: true });
    // An abort that landed while openGuestStream read the address takes the one teardown path: no job frame is written.
    if (options.signal?.aborted) session.onAbort();
    child.on('error', () => stop(session, 'SESSION_SPAWN_FAILED'));
    // Exit 0 after a clean EOF and the observation is the finish; a request still owed then was abandoned, not failed.
    // Any other status, ssh's own 255 included, is the provider's failure: no supervisor code is derived from it.
    child.on('close', code => {
      if (code !== 0) stop(session, 'SESSION_PROVIDER_FAILED');
      else if (!session.ended || !session.observation) stop(session, 'SESSION_PROTOCOL_VIOLATION');
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
    // The job frame is the first stdin write: Node keeps write order and pump writes only after a request. Ending stdin
    // stays the cancel and host-gone signal; the supervisor's 74 comes back as ssh's own exit status.
    if (session.closing) return; // a session already torn down never receives the credential
    bounded(session, new Promise((done, failed) => child.stdin.write(options.first, error => (error ? failed(error) : done()))))
      .catch(error => stop(session, error === TIMEOUT ? 'SESSION_TIMEOUT' : 'SESSION_PROVIDER_FAILED'));
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
// Teardown ends dispatch: once it began, nothing queued is forwarded and no reply is written.
async function pump(session) {
  while (session.pending.length > 0 && !session.closing) {
    try {
      const bytes = await reply(session, session.pending[0]);
      if (session.closing) return;
      await bounded(session, new Promise((done, failed) => session.child.stdin.write(bytes, error => (error ? failed(error) : done()))));
    } catch (error) {
      if (session.closing) return; // a deadline or reply write that teardown cut short is no failure of its own
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
  const refused = await daemonRefusal(daemonInfoPath, { timeoutMs: session.options.timeoutMs, signal: session.controller.signal });
  if (refused && !session.closing) stop(session, refused); // a probe cut short by teardown never sets the failure code
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

// The agent identity's processes only. `sudo -n` and Multipass's CommandLineError both exit 1 with an empty stdout, so a
// pgrep exit 1 is proof only with its '0' count (procps-ng prints the count even when it is 0). The CR is a Windows host's.
const PKILL = Object.freeze(['sudo', '-n', 'pkill', '-KILL', '-U', JOB_IDENTITIES[0]]);
const PGREP = Object.freeze(['sudo', '-n', 'pgrep', '-c', '-U', JOB_IDENTITIES[0]]);
const NO_PROCESS = /^0\r?\n$/;

// The remote exit as {code, stdout}, the runGuestProbe rule; null for a transport failure (timeout, ENOENT, maxBuffer,
// a synchronous throw).
async function remote(invoke, name, argv) {
  try {
    const { stdout } = await invoke(['exec', '--no-map-working-directory', name, '--', ...argv], QUERY_TIMEOUT_MS);
    return { code: 0, stdout };
  } catch (error) {
    return Number.isInteger(error?.code) && !error.killed ? { code: error.code, stdout: error.stdout } : null;
  }
}

/**
 * Proves that no agent-identity process is left in the owned guest, which a local kill of the ssh client never shows.
 * Each round runs the fixed PKILL, then PGREP, through lifecycle's bounded invoker; provider is lifecycle's
 * {executable = 'multipass', run = execFile}, so one object can carry both run and runGuestSession's spawn. Resolves a
 * frozen {verified}: true only on pgrep exit 1 with a '0' count. pgrep exit 0 retries after delayMs; any other result,
 * a provider error or timeout, or running out of rounds is false. It never claims a termination it did not observe.
 */
export async function endAgentJobs(name, provider = {}, options = {}) {
  let invoke;
  let rounds;
  let sleep;
  let delayMs;
  try {
    ({ rounds = 3, sleep = delay, delayMs = 1_000 } = options);
    invoke = invoker(name, provider);
  } catch { invoke = null; }
  if (!invoke || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10 || typeof sleep !== 'function'
    || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw sessionError('SESSION_INPUT_INVALID');
  try {
    for (let round = 0; round < rounds; round += 1) {
      if (round > 0) await sleep(delayMs);
      if (!(await remote(invoke, name, PKILL))) break; // its exit code proves nothing; a transport failure ends the proof
      const counted = await remote(invoke, name, PGREP);
      if (counted?.code === 1 && typeof counted.stdout === 'string' && NO_PROCESS.test(counted.stdout)) return Object.freeze({ verified: true });
      if (counted?.code !== 0) break; // exit 0: a process is still there
    }
  } catch { /* a failed sleep: fail closed */ }
  return Object.freeze({ verified: false });
}

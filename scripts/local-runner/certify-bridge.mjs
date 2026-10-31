// Bridge certify checks (CQ-R13e1): they close two points CQ-R08 left uncertified. Host EOF on stdin must reach the guest
// supervisor through `multipass exec` with no pty, so it kills the job; and frame bytes must arrive exact in both directions.
// They run in the certify VM with the real supervisor, after 'no-mounts' and before 'teardown'. Certification is not
// activation: executionReady stays false and verified-local stays unavailable. Every argv is checkArgv(name),
// snapshotArgv(name, 'materialize') or a fixed `multipass exec` literal plus validated numbers, and every frame a fixed
// literal; guest bytes are only compared, so none reaches a command, an argv, a code or the report. CQ-R13e adds
// 'guest-network': no guest identity may reach the host's daemon ports at the VM gateway.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { runCheckSession } from './check-session.mjs';
import { JOB_IDENTITIES } from './guest-bootstrap.mjs';
import { createFrameDecoder, parseGuestFrame } from './guest-bridge.mjs';
import { invoker, QUERY_TIMEOUT_MS } from './lifecycle.mjs';
import { classifyFailure, providerError } from './multipass.mjs';
import { materializeSnapshot } from './snapshot-transfer.mjs';
import { validateImport } from './source-snapshot.mjs';

/** Certify's own bounds; certifyCore may lower each (1 to the constant) through deps.bounds, the native entry never. */
export const BRIDGE_BOUNDS = Object.freeze({ sessionMs: 120_000, exitMs: 30_000, transferMs: 120_000 });
/** 2 MiB: the sha256 digests of `moe-certify-payload-v1:<i>` for i in 0..65535, concatenated. */
export const CERTIFY_PAYLOAD = Buffer.concat(Array.from({ length: 65_536 }, (_, i) => createHash('sha256').update(`moe-certify-payload-v1:${i}`).digest()));
// Compared against instead of the exported Buffer, which a caller could mutate.
const PAYLOAD_SHA256 = createHash('sha256').update(CERTIFY_PAYLOAD).digest('hex');
const PAYLOAD_BYTES = CERTIFY_PAYLOAD.length;
const READY = Buffer.from('ready\n');
const passed = Object.freeze({ result: 'passed', code: null });
const failed = code => Object.freeze({ result: 'failed', code });

/** A fresh version-1 SourceSnapshot: the payload and a no-op executable. validateImport copies each file's bytes. */
export function certifySnapshot() {
  return Object.freeze({ version: 1, overlay: validateImport([]), base: validateImport([
    { kind: 'file', path: 'moe-certify/payload.bin', executable: false, data: CERTIFY_PAYLOAD },
    { kind: 'file', path: 'moe-certify/run.sh', executable: true, data: Buffer.from('#!/bin/sh\nexit 0\n') },
  ]) });
}

/**
 * One runCheckSession on context.name with the fixed frame { id, command, protected: [] }, under context.bounds. Its
 * spawn wraps context.provider.spawn, so certify also watches the child: `exit` is the child's own 'close' {code, signal},
 * or null after runCheckSession's local kill, which is never evidence. `stdout` is the reassembled stdout output, at most
 * `limit` bytes (`overflow` marks more), passed to onStdout after each frame while stdin is writable; `broken` marks a
 * frame the tee could not parse, or an onStdout throw. Resolves a frozen { outcome, exitCode, exit, stdout, overflow, broken }.
 */
export async function watchedSession(context, id, command, { signal, limit = 0, onStdout } = {}) {
  const { executable, spawn } = context.provider ?? {};
  const seen = { killed: false, exit: null, kept: [], size: 0, overflow: false, broken: false };
  const watched = (...args) => {
    const child = (typeof spawn === 'function' ? spawn : spawnProcess)(...args);
    if (typeof child?.kill !== 'function' || typeof child.on !== 'function' || typeof child.stdout?.on !== 'function') return child;
    const kill = child.kill.bind(child);
    child.kill = (...killArgs) => { seen.killed = true; return kill(...killArgs); };
    child.on('close', (code, closeSignal) => { seen.exit = Object.freeze({ code, signal: closeSignal }); });
    // stop() destroys stdin synchronously; drained output after that cannot trigger readiness or prove who caused EOF.
    const notify = out => { if (child.stdin?.writable) onStdout?.(out); };
    const decoder = createFrameDecoder();
    child.stdout.on('data', chunk => {
      if (seen.broken) return;
      try {
        for (const raw of decoder.push(chunk)) tee(seen, parseGuestFrame(raw), limit, onStdout && notify);
      } catch { seen.broken = true; }
    });
    return child;
  };
  const { outcome, exitCode } = await runCheckSession({ name: context.name, check: { id, command, protected: [] },
    provider: { executable: typeof executable === 'string' ? executable : 'multipass', spawn: watched },
    budgetMs: context.bounds?.sessionMs, timeoutMs: context.bounds?.exitMs, signal });
  return Object.freeze({ outcome, exitCode, exit: seen.killed ? null : seen.exit, stdout: Buffer.concat(seen.kept), overflow: seen.overflow, broken: seen.broken });
}

// Keeps copies, and only while there is room, so a flooding guest holds at most `limit` bytes; a non-integer limit keeps none.
function tee(seen, frame, limit, onStdout) {
  if (frame.kind !== 'output' || frame.stream !== 'stdout') return;
  const room = Math.max(0, (Number.isSafeInteger(limit) ? limit : 0) - seen.size);
  if (frame.data.length > room) seen.overflow = true;
  const kept = frame.data.subarray(0, room);
  if (kept.length > 0) seen.kept.push(Buffer.from(kept));
  seen.size += kept.length;
  onStdout?.(Buffer.concat(seen.kept));
}

// Host to guest is R09c's materialize digest check (its TRANSFER_* codes propagate); guest to host is the payload, byte-exact.
async function framing(context) {
  await materializeSnapshot({ name: context.name, snapshot: certifySnapshot(), provider: context.provider, timeoutMs: context.bounds.transferMs });
  const session = await watchedSession(context, 'certify-framing', 'cat moe-certify/payload.bin', { limit: PAYLOAD_BYTES });
  if (session.outcome !== 'passed') return failed('CERTIFY_BRIDGE_FRAMING_SESSION_FAILED');
  return session.overflow || session.broken || session.stdout.length !== PAYLOAD_BYTES
    || createHash('sha256').update(session.stdout).digest('hex') !== PAYLOAD_SHA256 ? failed('CERTIFY_BRIDGE_FRAMING_MISMATCH') : passed;
}

// Once the job printed exactly 'ready\n', the abort closes the host's stdin; only the provider's own exit 74 (the
// supervisor's host-EOF exit) within exitMs passes.
async function eof(context) {
  const controller = new AbortController();
  let ready = false;
  const session = await watchedSession(context, 'certify-eof', 'echo ready; exec sleep 600', { signal: controller.signal, limit: 64,
    onStdout: out => { if (!ready && out.equals(READY)) { ready = true; controller.abort(); } } });
  if (!ready) return failed('CERTIFY_BRIDGE_EOF_NOT_STARTED');
  if (session.exit === null) return failed('CERTIFY_BRIDGE_EOF_TIMEOUT');
  return session.exit.code === 74 && session.exit.signal === null ? passed : failed('CERTIFY_BRIDGE_EOF_EXIT');
}

// packages/moe-daemon/src/index.ts DEFAULT_PORT. certify takes no project input: the certify listener carries the bind-level
// claim for any port, this one surfaces an exposed default daemon (a 0.0.0.0 bind, WSL agent mode) as a failed connect, and
// guest-session.mjs refuses a non-loopback daemon.json bindHost at every agent session.
const DEFAULT_DAEMON_PORT = 9876;
/** One line, no single quote: only a real connect prints 'open' (exit 1); connect_ex returns errno, so a refusal or the 3 s
 * timeout prints 'closed' (exit 0), and a crash prints neither, which reads as unknown. argv: <gateway> <port>... */
export const CONNECT_PROBE = 'import socket,sys;socket.setdefaulttimeout(3);o=any(socket.socket().connect_ex((sys.argv[1],int(p)))==0 for p in sys.argv[2:]);print("open" if o else "closed");sys.exit(int(o))';
const GATEWAY_PROBE = Object.freeze(['ip', '-4', 'route', 'show', 'default']);
const OCTET = '(0|[1-9]\\d{0,2})';
const ROUTE = new RegExp(`^default via ${Array(4).fill(OCTET).join('\\.')} dev [A-Za-z0-9_.@-]{1,15}(?: [\\x20-\\x7e]*)?$`);
const [CLOSED, OPEN] = ['closed\n', 'open\n'];

/** The gateway of `ip -4 route show default`'s one line, rebuilt from its integers so no guest text reaches an argv; a unicast
 * dotted quad (first octet 1-223, not 127), else null. */
export function gatewayOf(stdout) {
  const octets = (typeof stdout === 'string' ? ROUTE.exec(stdout.replace(/\n$/, '')) : null)?.slice(1).map(Number);
  if (!octets || octets.some(octet => octet > 255) || octets[0] < 1 || octets[0] > 223 || octets[0] === 127) return null;
  return octets.join('.');
}

// runGuestProbe's handling (guest-readiness.mjs): a remote exit is {code, stdout}; a kill, spawn or other provider failure
// throws its PROVIDER_* code. certify-containment.mjs runs its fixed argv through it too.
export async function probe({ name, provider }, argv) {
  const invoke = invoker(name, provider);
  try {
    const { stdout } = await invoke(['exec', '--no-map-working-directory', name, '--', ...argv], QUERY_TIMEOUT_MS);
    return { code: 0, stdout };
  } catch (error) {
    if (!Number.isInteger(error?.code) || error.killed || typeof error.stdout !== 'string') throw providerError(classifyFailure(error));
    return { code: error.code, stdout: error.stdout };
  }
}

// The certify-owned host listener, loopback only, on an ephemeral port; its own accept count is evidence guest stdout cannot
// forge. Resolves null when it cannot listen.
function listen() {
  let accepted = 0;
  const server = net.createServer(socket => { accepted += 1; socket.destroy(); });
  return new Promise(resolve => {
    server.on('error', () => resolve(null));
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve({
      port: server.address().port, accepted: () => accepted, close: () => new Promise(done => { server.close(() => done()); }) }));
  });
}

// Exactly one token on its own exit: 'closed' on 0, 'open' on 1; anything else, a crash or a provider's own exit, is unknown.
const verdict = (closed, open) => (closed ? 'closed' : open ? 'open' : 'unknown');

// The check identity (its private netns) and the agent identity (the guest's root netns) each try the gateway's daemon ports.
// A confirmed connect, by either token or the listener's own count, is the finding, so it outranks every other result.
async function guestNetwork(context) {
  const route = await probe(context, GATEWAY_PROBE);
  const gateway = route.code === 0 ? gatewayOf(route.stdout) : null;
  if (gateway === null) return failed('CERTIFY_GATEWAY_UNKNOWN');
  const listener = await listen();
  if (listener === null) return failed('CERTIFY_LISTENER_FAILED');
  try {
    const args = [gateway, String(listener.port), String(DEFAULT_DAEMON_PORT)];
    const session = await watchedSession(context, 'certify-network', `python3 -I -c '${CONNECT_PROBE}' ${args.join(' ')}`, { limit: 64 });
    const [out, clean] = [session.stdout.toString('latin1'), !session.overflow && !session.broken];
    const check = verdict(clean && session.outcome === 'passed' && out === CLOSED,
      clean && session.outcome === 'code-failure' && session.exitCode === 1 && out === OPEN);
    let agent = 'unknown', agentError = null;
    try {
      const { code, stdout } = await probe(context, ['sudo', '-n', '-u', JOB_IDENTITIES[0], 'python3', '-I', '-c', CONNECT_PROBE, ...args]);
      agent = verdict(code === 0 && stdout === CLOSED, code === 1 && stdout === OPEN);
    } catch (error) { agentError = error; }
    // A completed TCP handshake can still have an undispatched accept. Keep listening across a poll turn before sampling:
    // one immediate could run in this turn's check phase; nesting it forces the next turn's I/O before the verdict.
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    if (check === 'open' || agent === 'open' || listener.accepted() > 0) return failed('CERTIFY_GUEST_NETWORK_REACHABLE');
    if (agentError) throw agentError;
    return check === 'closed' && agent === 'closed' ? passed : failed('CERTIFY_GUEST_NETWORK_UNKNOWN');
  } finally { await listener.close(); }
}

/** Spliced into certify.mjs's BODY after 'no-mounts'; 'bridge-framing' first, as it materializes the workspace later checks use. */
export const BRIDGE_CHECKS = Object.freeze([Object.freeze({ id: 'bridge-framing', run: framing }), Object.freeze({ id: 'bridge-eof', run: eof }),
  Object.freeze({ id: 'guest-network', run: guestNetwork })]);

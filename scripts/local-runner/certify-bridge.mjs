// Bridge certify checks (CQ-R13e1): they close two points CQ-R08 left uncertified. Host EOF on stdin must reach the guest
// supervisor through `multipass exec` with no pty, so it kills the job; and frame bytes must arrive exact in both directions.
// They run in the certify VM with the real supervisor, after 'no-mounts' and before 'teardown'. Certification is not
// activation: executionReady stays false and verified-local stays unavailable. Every argv is checkArgv(name) or
// snapshotArgv(name, 'materialize') and every frame a fixed literal; guest bytes are only compared, so none reaches a
// command, an argv, a code or the report.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runCheckSession } from './check-session.mjs';
import { createFrameDecoder, parseGuestFrame } from './guest-bridge.mjs';
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
        for (const raw of decoder.push(chunk)) tee(seen, parseGuestFrame(raw), limit, notify);
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

/** Spliced into certify.mjs's BODY after 'no-mounts'; 'bridge-framing' first, as it materializes the workspace later checks use. */
export const BRIDGE_CHECKS = Object.freeze([Object.freeze({ id: 'bridge-framing', run: framing }), Object.freeze({ id: 'bridge-eof', run: eof })]);

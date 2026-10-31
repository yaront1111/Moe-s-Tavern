// Host side of one CQ-R11 check: one `multipass exec ... moe-supervisor check` session runs one approved check in its
// fresh check VM, and its end is classified into the daemon's CheckOutcome values. name, check, provider and signal are
// trusted host-controller inputs; every guest byte is untrusted. The check frame is the first and only stdin write, and
// stdin then stays open: the supervisor reads host EOF as a gone host and kills the job (74). A check job has no Moe
// route, so a request frame ends the session. A local kill of the provider is never evidence that the guest job ended.
// This is local session logic, not VM or isolation certification (CQ-R13): executionReady stays false and verified-local
// stays unavailable.
import { spawn as spawnProcess } from 'node:child_process';
import { checkArgv, checkFrame, createFrameDecoder, parseGuestFrame } from './guest-bridge.mjs';

// guest-supervisor.py's codes, which C2 pins: 79 before hello (the candidate lacks an approved protected blob), 80
// after the observation (the job changed one) and 81 before hello, with no frame (the CQ-R11e5 dependency install failed).
// 82 is a SUPERVISOR refusal, never a job's exit: before hello, with no frame, it says the candidate's own package metadata
// was refused (a code failure, not an infrastructure one).
export const PROTECTED_MISMATCH = 79;
export const PROTECTED_CHANGED = 80;
export const DEPENDENCIES_FAILED = 81;
export const DEPENDENCIES_CANDIDATE_INVALID = 82;
// The one diagnostic for that refusal. It is host-owned ASCII, so no npm or guest byte (stderr is never read) reaches it.
const CANDIDATE_REFUSAL = 'MOE_DEPENDENCY_CANDIDATE_INVALID: Candidate package metadata is not compatible with the approved lockfile; remove npm-shrinkwrap.json/.npmrc and unsupported overrides or bundling.';
export const MAX_BUDGET_MS = 86_400_000;
export const MAX_CHECK_TAIL_BYTES = 16_384; // the daemon's MAX_CHECK_LOG_BYTES (checkRunStore.ts)
// Raw output bytes kept: twice the tail, so a cut sequence or U+FFFD expansion at the window's start never reaches it.
const TAIL_WINDOW = 2 * MAX_CHECK_TAIL_BYTES;
const MAX_TIMEOUT_MS = 60_000;
const CONTROL = /[\x00-\x1f\x7f]/;
const OBSERVED = ['passed', 'code-failure', 'inconclusive'];
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const within = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const result = (outcome, observation = null, outputTail = '') =>
  Object.freeze({ outcome, exitCode: observation?.code ?? null, signal: observation?.signal ?? null, outputTail });

/**
 * Resolves a frozen {outcome, exitCode, signal, outputTail}: 'timeout' when budgetMs, the host's wall clock from spawn,
 * fired; else 'infra-failure' for a spawn, stdin, protocol or provider failure, an abort, a local kill or any other exit
 * before hello, such as supervisor exit 81 (DEPENDENCIES_FAILED, the dependency install failed); 'skipped' for
 * supervisor exit 79 with no frame; 'inconclusive' for exit 80 after hello and one observation; and only after hello,
 * one observation, a clean stdout EOF and exit 0, 'passed' for job exit code 0, else 'code-failure'. exitCode and signal
 * are the observation's for those three, else null. One more 'code-failure' needs no observation: a clean stdout EOF and
 * supervisor exit 82 (DEPENDENCIES_CANDIDATE_INVALID) with no frame at all and a whole session, which resolves exitCode 82,
 * signal null and the fixed CANDIDATE_REFUSAL as outputTail, never any guest byte. provider: {executable = 'multipass', spawn = child_process.spawn};
 * timeoutMs (1-60000) bounds the stdin write and the wait for the provider to exit once stdin is closed. Invalid input
 * rejects with CHECK_SESSION_INPUT_INVALID before any spawn; nothing after that rejects.
 */
export async function runCheckSession(input) {
  let options;
  try {
    const { name, check, provider = {}, budgetMs, timeoutMs = 30_000, signal } = input;
    const { executable = 'multipass', spawn = spawnProcess } = isRecord(provider) ? provider : { spawn: null };
    if (typeof executable === 'string' && executable.trim() !== '' && !CONTROL.test(executable) && typeof spawn === 'function'
      && within(budgetMs, MAX_BUDGET_MS) && within(timeoutMs, MAX_TIMEOUT_MS) && (signal === undefined || signal instanceof AbortSignal)) {
      options = { executable, spawn, argv: checkArgv(name), frame: checkFrame(check), budgetMs, timeoutMs, signal };
    }
  } catch { options = undefined; }
  if (!options) throw Object.assign(new Error('Check session input was invalid.'), { code: 'CHECK_SESSION_INPUT_INVALID' });
  if (options.signal?.aborted) return result('infra-failure');
  let child;
  try {
    child = options.spawn(options.executable, options.argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { child = null; }
  if (typeof child?.kill !== 'function' || ![child, child.stdin, child.stdout, child.stderr].every(item => typeof item?.on === 'function')) {
    return result('infra-failure');
  }
  return new Promise(resolve => watch({ child, options, resolve, decoder: createFrameDecoder(), ring: Buffer.alloc(TAIL_WINDOW),
    at: 0, seen: 0, opened: false, observation: null, written: false, ended: false, failed: false, timedOut: false, killed: false,
    closing: false, settled: false }));
}

function watch(s) {
  const { child, options } = s;
  s.budget = setTimeout(() => { s.timedOut = true; stop(s); }, options.budgetMs);
  s.onAbort = () => stop(s, true);
  options.signal?.addEventListener('abort', s.onAbort, { once: true });
  child.on('error', () => stop(s, true));
  child.on('close', code => settle(s, code));
  child.stdin.on('error', () => stop(s, true));
  child.stdout.on('error', () => stop(s, true));
  child.stdout.on('data', chunk => receive(s, chunk));
  child.stdout.on('end', () => {
    try { s.decoder.end(); s.ended = true; } catch { s.failed = true; }
    stop(s);
  });
  child.stderr.on('error', () => {}).resume(); // drained unread: stderr is never protocol data
  s.deadline = setTimeout(() => stop(s, true), options.timeoutMs);
  try {
    child.stdin.write(options.frame, error => { clearTimeout(s.deadline); s.written = !error; if (error) stop(s, true); });
  } catch { stop(s, true); }
}

// Hello first and once, then output, then exactly one observation and nothing after it. Output data only feeds the tail.
function receive(s, chunk) {
  if (s.closing) return; // stdout keeps draining, unread, after teardown
  try {
    for (const raw of s.decoder.push(chunk)) {
      const frame = parseGuestFrame(raw);
      if (s.opened === (frame.kind === 'hello') || s.observation || frame.kind === 'request') throw new Error('protocol');
      if (frame.kind === 'hello') s.opened = true;
      else if (frame.kind === 'observation') s.observation = frame;
      else keep(s, frame.data);
    }
  } catch { stop(s, true); }
}

// The last TAIL_WINDOW raw bytes of stdout and stderr, in arrival order, in a fixed ring: bounded however long the job runs.
function keep(s, data) {
  const bytes = data.subarray(Math.max(0, data.length - TAIL_WINDOW));
  const first = bytes.copy(s.ring, s.at);
  bytes.copy(s.ring, 0, first);
  s.at = (s.at + bytes.length) % TAIL_WINDOW;
  s.seen += bytes.length;
}

// checkRunStore's boundOutputTail on the decoded window: malformed bytes become U+FFFD, the cut keeps the final
// MAX_CHECK_TAIL_BYTES UTF-8 bytes, and its start moves past continuation bytes onto a whole character.
function tailOf(s) {
  const raw = s.seen < TAIL_WINDOW ? s.ring.subarray(0, s.at) : Buffer.concat([s.ring.subarray(s.at), s.ring.subarray(0, s.at)]);
  const bytes = Buffer.from(raw.toString('utf8'));
  let start = Math.max(0, bytes.length - MAX_CHECK_TAIL_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

// The one idempotent teardown (`failed` marks a failure): close stdin, so the supervisor's host-EOF path kills and reaps
// the job group, keep draining stdout, and kill the local provider, a failure too, if it still runs timeoutMs later.
function stop(s, failed = false) {
  if (failed) s.failed = true;
  if (s.closing || s.settled) return;
  s.closing = true;
  s.child.stdin.destroy();
  s.kill = setTimeout(() => {
    s.killed = true;
    try { s.child.kill('SIGKILL'); } catch { /* settled below either way */ }
    settle(s, null);
  }, s.options.timeoutMs);
}

function settle(s, code) {
  if (s.settled) return;
  s.settled = true;
  for (const timer of [s.budget, s.deadline, s.kill]) clearTimeout(timer);
  s.options.signal?.removeEventListener('abort', s.onAbort);
  const outcome = outcomeOf(s, code);
  // The refusal is selected only by the clean no-frame branch below, so the host supplies its code and text itself.
  if (outcome === 'code-failure' && !s.opened && code === DEPENDENCIES_CANDIDATE_INVALID) {
    s.resolve(result(outcome, { code, signal: null }, CANDIDATE_REFUSAL));
    return;
  }
  s.resolve(result(outcome, OBSERVED.includes(outcome) ? s.observation : null, tailOf(s)));
}

// In this order, so nothing but a whole, clean session that exits 0 reaches 'passed'.
function outcomeOf(s, code) {
  if (s.timedOut) return 'timeout';
  if (s.failed || s.killed || !s.written || !s.ended) return 'infra-failure';
  if (code === PROTECTED_MISMATCH && !s.opened) return 'skipped'; // hello is the first frame, so no frame at all
  if (code === DEPENDENCIES_CANDIDATE_INVALID && !s.opened) return 'code-failure'; // likewise: the supervisor refused the candidate
  if (!s.opened || !s.observation) return 'infra-failure';
  if (code === PROTECTED_CHANGED) return 'inconclusive';
  if (code !== 0) return 'infra-failure';
  return s.observation.code === 0 ? 'passed' : 'code-failure';
}

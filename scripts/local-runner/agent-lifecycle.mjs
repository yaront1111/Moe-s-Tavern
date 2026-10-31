// Host side of one isolated agent job on an owned VM (CQ-R10): the job lease, a verified sweep, the no-mount check, one
// bridge session, a verified sweep, then the lease release. The inputs are trusted host-controller inputs (R06 supplies
// ownership); every guest byte is untrusted. A reconnect is a new job under a fresh session id, never a reattach.
// This is not isolation certification (CQ-R13): executionReady is always false and verified-local stays unavailable.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { platformFor } from './cli.mjs';
import { jobFrame, scopeRequest } from './guest-bridge.mjs';
import { endAgentJobs, MAX_RESPONSE_BYTES, runGuestSession } from './guest-session.mjs';
import { isOwnedInstanceName, jobLeaseResourceId } from './lifecycle.mjs';
import { assertNoMounts } from './snapshot-transfer.mjs';

// A missing required key fails its own check below; any other key, a sessionId included, is refused.
const KEYS = ['name', 'binding', 'job', 'daemonInfoPath', 'forward', 'onOutput', 'onObservation', 'signal', 'provider', 'timeoutMs', 'sleep'];
const CONTROL = /[\x00-\x1f\x7f]/;
const PASSED = /^(?:SESSION|TRANSFER|PROVIDER|LIFECYCLE)_[A-Z0-9_]{1,60}$/;
const TIMEOUT = Symbol('timeout');
// Owned names with a job running in this process. The daemon lease is task-keyed and renews for its own task, so it
// cannot keep two jobs of one task apart.
const running = new Set();
// Only internal code literals reach here: a message never carries the credential, a path, a guest byte or upstream text.
const agentError = code => Object.assign(new Error(`Agent job failed: ${code}.`), { code });
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const isIso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const usable = text => typeof text === 'string' && text.trim() !== '' && !CONTROL.test(text);

// Every input is checked, and the binding, job and provider copied once, before any daemon or provider call.
function parse(input) {
  try {
    const keys = isRecord(input) ? Object.keys(input) : [];
    if (!keys.every(key => KEYS.includes(key))) return null;
    const { name, binding, job, daemonInfoPath, forward, onOutput, onObservation, signal, provider = {}, timeoutMs = 30_000, sleep } = input;
    const frozen = Object.freeze({ ...binding });
    scopeRequest({ kind: 'request', id: 1, tool: 'moe.get_context', args: {} }, frozen); // validates the binding only
    const { cli, credential } = exactKeys(job, ['cli', 'credential']) ? job : {};
    const { name: key, value } = exactKeys(credential, ['name', 'value']) ? credential : {};
    const copy = Object.freeze({ cli, credential: Object.freeze({ name: key, value }) });
    jobFrame({ cli, role: frozen.role, credential: copy.credential });
    // Checked and used as this one copy, with this host's pinned client unless the caller names one: never a bare `multipass`.
    const kit = isRecord(provider) ? Object.freeze({ ...provider, executable: provider.executable ?? platformFor(process.platform)?.executable }) : null;
    const sessionId = `${frozen.workerId}@${new Date().toISOString()}#${randomBytes(8).toString('hex')}`;
    if (isOwnedInstanceName(name) && typeof daemonInfoPath === 'string' && path.isAbsolute(daemonInfoPath) && !CONTROL.test(daemonInfoPath)
      && [forward, onOutput, onObservation].every(fn => typeof fn === 'function') && [sleep, kit?.run, kit?.spawn]
        .every(fn => fn === undefined || typeof fn === 'function') && kit
      && usable(kit.executable) && (signal === undefined || signal instanceof AbortSignal)
      && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000 && sessionId.length <= 255) {
      return { name, binding: frozen, job: copy, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, timeoutMs,
        provider: kit, sweep: sleep ? { sleep } : {}, resourceId: jobLeaseResourceId(name) };
    }
  } catch { /* refused below */ }
  return null;
}

/**
 * Runs one agent job and resolves a frozen {sessionId, observation, failure, terminationVerified, lease, executionReady:
 * false}; only failure === null means the job ended and no agent-identity process remains. lease is 'released', 'kept'
 * (termination unverified: left to expiry or the next run's renewal) or 'release-failed'. Rejects, holding no lease and
 * having run no provider command, with AGENT_INPUT_INVALID, AGENT_ABORTED, AGENT_BUSY, AGENT_LEASE_BUSY or
 * AGENT_LEASE_UNAVAILABLE. Artifacts (workspace, session homes, the R06 ledger) are never touched.
 */
export async function runAgentJob(input) {
  const options = parse(input);
  if (!options) throw agentError('AGENT_INPUT_INVALID');
  if (options.signal?.aborted) throw agentError('AGENT_ABORTED');
  if (running.has(options.name)) throw agentError('AGENT_BUSY');
  running.add(options.name);
  try { return await agentJob(options); } finally { running.delete(options.name); }
}

async function agentJob(o) {
  const acquiredAt = await acquire(o);
  const sweep = () => endAgentJobs(o.name, o.provider, o.sweep).then(({ verified }) => verified === true, () => false);
  // A new job never starts while a process of an earlier one may still run, such as one a crashed controller left.
  if (!(await sweep())) return outcome(o, null, 'AGENT_TERMINATION_UNVERIFIED', false, 'kept');
  let observation = null;
  let failure = null;
  try {
    await assertNoMounts(o.name, o.provider);
    const { name, binding, job, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, provider, timeoutMs } = o;
    ({ observation } = await runGuestSession({ name, binding, job, sessionId, daemonInfoPath, forward, onOutput, onObservation, signal, provider, timeoutMs }));
  } catch (error) {
    failure = typeof error?.code === 'string' && PASSED.test(error.code) ? error.code : 'AGENT_JOB_FAILED';
  }
  // Whatever the session did, and also for descendants a cleanly exited job left behind.
  const verified = await sweep();
  return outcome(o, observation, failure ?? (verified ? null : 'AGENT_TERMINATION_UNVERIFIED'), verified, verified ? await release(o, acquiredAt) : 'kept');
}

const outcome = (o, observation, failure, terminationVerified, lease) =>
  Object.freeze({ sessionId: o.sessionId, observation, failure, terminationVerified, lease, executionReady: false });

async function acquire(o) {
  const { taskId, workerId } = o.binding;
  let value;
  try { value = await leaseCall(o, 'moe.acquire_resource', { resourceId: o.resourceId, taskId, workerId }); } catch { value = null; }
  if (value?.granted === false) throw agentError('AGENT_LEASE_BUSY');
  const lease = value?.granted === true && isRecord(value.lease) ? value.lease : {};
  // A lease the daemon granted but this call could not read stays held (fail closed): nothing is released here.
  if (lease.taskId !== taskId || lease.workerId !== workerId || !isIso(lease.acquiredAt)) throw agentError('AGENT_LEASE_UNAVAILABLE');
  return lease.acquiredAt;
}

// Pinned to the lease this run acquired; never forced, never another resourceId, never retried.
async function release(o, acquiredAt) {
  const { taskId, workerId } = o.binding;
  try {
    const value = await leaseCall(o, 'moe.release_resource',
      { resourceId: o.resourceId, workerId, taskId, ifHolderWorkerId: workerId, ifAcquiredAt: acquiredAt });
    if (isDeepStrictEqual(value.releasedHolders, [{ taskId, workerId, acquiredAt }])) return 'released';
  } catch { /* release-failed */ }
  return 'release-failed';
}

// Never the caller's signal, so a cancelled job still releases; its own signal aborts at timeoutMs, and the deadline
// bounds a forward that ignores it. Resolves the JSON object of exactly one text item, or throws.
async function leaseCall(o, tool, args) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(TIMEOUT); }, o.timeoutMs); });
  try {
    const { isError, content } = await Promise.race([Promise.resolve().then(() => o.forward(tool, args, { signal: controller.signal })), deadline]);
    const [item, ...rest] = Array.isArray(content) ? content : [];
    const { type, text } = isRecord(item) ? item : {};
    if ((isError === undefined || isError === false) && rest.length === 0 && type === 'text' && typeof text === 'string' && text.length <= MAX_RESPONSE_BYTES) {
      const value = JSON.parse(text);
      if (isRecord(value)) return value;
    }
  } finally { clearTimeout(timer); }
  throw agentError('AGENT_LEASE_UNAVAILABLE');
}

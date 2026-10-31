// Host side of one isolated check (CQ-R11), one fresh owned VM per run, in this order: provisioning plus R07 readiness,
// whose probes deny every job identity the supervisor credential; on the host, for the guest's verified image arch, the
// pinned Node toolchain and, for the caller's lockfile dirs, the offline dependency tree (CQ-R11e); the environment
// identity, which names both; a no-mount materialization, then the toolchain and the tree copied in; the environment to
// onReady before the session; the approved check once, in the R11a/R11b guest check mode (runCheckSession), whose guest
// first installs the tree offline (a failed install is infra-failure, R11e5); and the VM deleted before the run settles,
// on every path. A passed session's workspace is verified in the still-running VM before that delete (CQ-R11f).
// Inputs are trusted host-controller inputs; every guest byte is untrusted. This is not isolation certification (CQ-R13):
// executionReady is always false.
import { checkEnvironment } from './check-evidence.mjs';
import { MAX_BUDGET_MS, runCheckSession } from './check-session.mjs';
import { buildDependencyCache, MAX_LOCKFILES } from './dependency-cache.mjs';
import { GUEST_RESOURCES, IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { checkFrame } from './guest-bridge.mjs';
import { deleteOwned, validOwner } from './lifecycle.mjs';
import { provisionGuest } from './provision.mjs';
import { installDependencies as copyDependencies, installToolchain as copyToolchain, materializeSnapshot, verifyWorkspace,
  workspaceEntries } from './snapshot-transfer.mjs';
import { validateImportPath } from './source-snapshot.mjs';
import { fetchNodeToolchain } from './toolchain-cache.mjs';

const KEYS = ['platform', 'ledger', 'owner', 'cacheDir', 'supervisor', 'credential', 'snapshot', 'check', 'budgetMs', 'onReady', 'dependencies',
  'provider', 'signal', 'timeoutMs'];
const OPTIONAL = ['provider', 'signal', 'timeoutMs'];
const PROVISION_CODE = /^(?:PROVISION|BOOTSTRAP|LIFECYCLE|LEDGER|PROVIDER|IMAGE|PRIMARY)_[A-Z0-9_]{1,60}$/;
const TRANSFER_CODE = /^TRANSFER_[A-Z0-9_]{1,60}$/;
const TOOLCHAIN_CODE = /^TOOLCHAIN_[A-Z0-9_]{1,60}$/;
const DEPENDENCY_CODE = /^DEPENDENCY_[A-Z0-9_]{1,60}$/;
const OUTCOMES = ['passed', 'code-failure', 'infra-failure', 'timeout', 'skipped', 'inconclusive'];
const WORKSPACES = ['intact', 'changed'];
const ABORTED = Symbol('aborted');
// Only internal code literals reach here: a message never carries the credential, a path, a guest byte or upstream text.
const checkError = code => Object.assign(new Error(`Check job failed: ${code}.`), { code });
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const codeOf = (error, pattern, fallback) => (typeof error?.code === 'string' && pattern.test(error.code) ? error.code : fallback);
const within = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const sha256Hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// The listed lockfile dirs ('.' is the root), each read once, as frozen { dir, bytes }: bytes is the merged view's
// package-lock.json, validateImport's private copy. [] is the caller's choice of no dependency phase. Throws or returns
// null unless they are at most MAX_LOCKFILES unique portable dirs, each with a lockfile.
function lockfilesOf(dependencies, entries) {
  const count = Array.isArray(dependencies) ? dependencies.length : null;
  if (!Number.isSafeInteger(count) || count > MAX_LOCKFILES) return null;
  const dirs = Array.from({ length: count }, (_, at) => dependencies[at]);
  if (new Set(dirs).size !== count) return null;
  const files = new Map(entries.map(entry => [entry.path, entry.data]));
  const lockfiles = dirs.map(dir => Object.freeze({ dir, bytes: files.get(dir === '.' ? 'package-lock.json' : `${validateImportPath(dir)}/package-lock.json`) }));
  return lockfiles.every(({ bytes }) => bytes !== undefined) ? Object.freeze(lockfiles) : null;
}

// Every input is checked, and the owner, check, ledger methods and provider copied once, before any ledger or provider
// call. platform, cacheDir, supervisor and credential are provisionGuest's to validate; its refusals are fixed codes.
function parse(input) {
  try {
    const keys = isRecord(input) ? Object.keys(input) : [null];
    if (!keys.every(key => KEYS.includes(key)) || !KEYS.every(key => OPTIONAL.includes(key) || keys.includes(key))) return null;
    const { platform, ledger, owner, cacheDir, supervisor, credential, snapshot, check, budgetMs, onReady, dependencies, provider = {}, signal,
      timeoutMs = 30_000 } = input;
    const who = isRecord(owner) ? Object.freeze({ taskId: owner.taskId, attemptId: owner.attemptId, generation: owner.generation }) : null;
    const { id, command, protected: list } = isRecord(check) && Object.keys(check).sort().join() === 'command,id,protected' ? check : {};
    const entries = Array.isArray(list) && list.length <= 2000 ? list.map(entry => (isRecord(entry) ? Object.freeze({ ...entry }) : entry)) : null;
    const approved = Object.freeze({ id, command, protected: Object.freeze(entries) });
    checkFrame(approved); // the frame the session will send, built from this copy
    // Validation, and the lockfile bytes: the rest of the merged copy is dropped before provisioning.
    const lockfiles = lockfilesOf(dependencies, workspaceEntries(snapshot).entries);
    const { read, reserve, update, recordImage } = isRecord(ledger) ? ledger : {};
    // Every call after provisioning uses the platform's pinned client too, as provisioning does, never a bare `multipass`.
    const copy = isRecord(provider) ? { ...provider } : null;
    const executable = copy?.executable ?? platform?.executable;
    const kit = copy && Object.freeze(executable === undefined ? copy : { ...copy, executable });
    if (lockfiles && kit && validOwner(who) && [read, reserve, update, recordImage, onReady].every(fn => typeof fn === 'function')
      && within(budgetMs, MAX_BUDGET_MS) && within(timeoutMs, 60_000) && (signal === undefined || signal instanceof AbortSignal)) {
      return { platform, ledger: { read, reserve, update, recordImage }, owner: who, cacheDir, supervisor, credential, snapshot,
        check: approved, budgetMs, onReady, lockfiles, provider: kit, signal, timeoutMs };
    }
  } catch { /* refused below */ }
  return null;
}

/**
 * Runs one approved check in one fresh owned VM. input.dependencies is required: the lockfile dirs whose package-lock.json
 * the guest installs offline before the check ('.' is the root, at most MAX_LOCKFILES), or [] for no dependency phase, a
 * deliberate caller choice that the environment records as a null dependency digest. Once the delete has settled,
 * resolves a frozen {outcome, exitCode, signal, outputTail, environment, workspace, instance, vm, failure, executionReady:
 * false}: outcome is 'infra-failure' when a step stopped the run before the session (failure names it: a TOOLCHAIN_,
 * DEPENDENCY_ or TRANSFER_ code passes through, else CHECK_TOOLCHAIN_FAILED or CHECK_DEPENDENCIES_FAILED), else the
 * session's CheckOutcome, but a pass without a verified delete is 'inconclusive'. workspace is verify's 'intact' or
 * 'changed' for a passed session, else, or when verify fails, 'unverified'. vm is 'deleted', 'not-launched',
 * 'delete-failed' or 'none' (nothing reserved). Rejects CHECK_JOB_INPUT_INVALID or CHECK_ABORTED before any call, and
 * after the delete, onReady's own error unchanged or CHECK_READY_TIMEOUT. The second argument injects the steps.
 */
export async function runCheckJob(input, { provision = provisionGuest, materialize = materializeSnapshot, session = runCheckSession, verify = verifyWorkspace,
  remove = deleteOwned, toolchain = fetchNodeToolchain, dependencies = buildDependencyCache, installToolchain = copyToolchain,
  installDependencies = copyDependencies } = {}) {
  const o = parse(input);
  if (!o) throw checkError('CHECK_JOB_INPUT_INVALID');
  if (o.signal?.aborted) throw checkError('CHECK_ABORTED');
  const run = { name: null, environment: null, observed: null, workspace: 'unverified' };
  // Provisioning gets this wrapper, never the owner's ledger: it captures this run's own reservation to delete, even after a throw.
  const ledger = { ...o.ledger, reserve: async who => { const record = await o.ledger.reserve(who); run.name = record?.instance ?? null; return record; } };
  let failure;
  let vm = 'none';
  try {
    failure = await checkJob(o, run, ledger, { provision, materialize, session, verify, toolchain, dependencies, installToolchain, installDependencies });
  } finally { // 'not-launched': reserved, never launched by this run, so nothing of ours is left to delete.
    if (run.name !== null) vm = await Promise.resolve().then(() => remove({ ledger, name: run.name, owner: o.owner, provider: o.provider }))
      .then(gone => (gone === 'deleted' || gone === 'not-launched' ? gone : 'delete-failed'), () => 'delete-failed');
  }
  const deleted = vm === 'deleted';
  const observed = failure === null ? run.observed : { outcome: 'infra-failure', exitCode: null, signal: null, outputTail: '' };
  // CHECK_BOUNDARIES.process.vm is 'deleted-after-run': a pass without a verified delete is not a pass.
  return Object.freeze({ ...observed, outcome: observed.outcome === 'passed' && !deleted ? 'inconclusive' : observed.outcome,
    environment: run.environment, workspace: run.workspace, instance: run.name, vm,
    failure: failure ?? (deleted ? null : 'CHECK_VM_DELETE_FAILED'), executionReady: false });
}

// Each step passes or ends the run with one fixed code (null once the session ran): the session needs every step before it.
async function checkJob(o, run, ledger, steps) {
  const { provision, materialize, session, verify } = steps;
  const { platform, owner, cacheDir, supervisor, credential, provider, signal } = o;
  let guest;
  try { guest = await provision({ platform, ledger, owner, cacheDir, supervisor, credential, provider }); } catch (error) {
    return codeOf(error, PROVISION_CODE, 'CHECK_PROVISION_FAILED');
  }
  if (guest?.provisioned !== true) return 'CHECK_PROVISION_UNAVAILABLE';
  if (guest.instance !== run.name) return 'CHECK_PROVISION_FAILED';
  // R07 readiness ran every boundary probe, each job identity's denied read of the supervisor credential among them.
  if (guest.bootstrapReady !== true || !Array.isArray(guest.failures) || guest.failures.length !== 0) return 'CHECK_GUEST_NOT_READY';
  if (signal?.aborted) return 'CHECK_ABORTED';
  const host = await hostInputs(o, guest.image?.source?.arch, steps);
  if (typeof host === 'string') return host;
  try {
    // The launch size, not the observed one, which varies per boot: identical VMs then share fresh evidence (R11d).
    run.environment = checkEnvironment({ sourceImageSha256: guest.image?.source?.sha256, providerImageHash: guest.image?.provider?.imageHash,
      supervisorSha256: guest.supervisorSha256, resources: GUEST_RESOURCES, toolchainSha256: host.toolchain.sha256,
      dependencyDigest: host.cache === null ? null : host.cache.digest });
  } catch { return 'CHECK_ENVIRONMENT_UNKNOWN'; }
  if (signal?.aborted) return 'CHECK_ABORTED';
  try { await materialize({ name: run.name, snapshot: o.snapshot, provider }); } catch (error) {
    return codeOf(error, TRANSFER_CODE, 'CHECK_MATERIALIZE_FAILED');
  }
  const installed = await installHostInputs(o, run.name, host, steps);
  if (installed !== null) return installed;
  if (signal?.aborted || (await ready(o, run.environment)) === ABORTED) return 'CHECK_ABORTED';
  try {
    const { outcome, exitCode, signal: ended, outputTail } = await session({ name: run.name, check: o.check, provider,
      budgetMs: o.budgetMs, timeoutMs: o.timeoutMs, signal });
    if (!OUTCOMES.includes(outcome)) return 'CHECK_SESSION_FAILED';
    run.observed = { outcome, exitCode, signal: ended, outputTail };
  } catch { return 'CHECK_SESSION_FAILED'; }
  // Only a pass is worth verifying (V04b downgrades nothing else); any verify failure leaves the workspace 'unverified'.
  if (run.observed.outcome === 'passed') {
    run.workspace = await Promise.resolve().then(() => verify({ name: run.name, provider, timeoutMs: o.timeoutMs }))
      .then(state => (WORKSPACES.includes(state) ? state : 'unverified'), () => 'unverified');
  }
  return null;
}

// On the host, for the guest's verified image arch (never the host's, never a default): the pinned toolchain and, unless the
// caller listed no lockfile dirs, the offline dependency tree. Each result is read once. Resolves { toolchain, cache }
// (cache null: no dependency phase) or a fixed code.
async function hostInputs({ cacheDir, lockfiles, signal }, arch, steps) {
  if (!IMAGE_ARCHES.includes(arch)) return 'CHECK_TOOLCHAIN_FAILED';
  let toolchain, cache = null;
  try {
    const { file, sha256, size, version } = await steps.toolchain({ arch, cacheDir });
    if (!sha256Hex(sha256)) return 'CHECK_TOOLCHAIN_FAILED';
    toolchain = Object.freeze({ file, sha256, size, version });
  } catch (error) { return codeOf(error, TOOLCHAIN_CODE, 'CHECK_TOOLCHAIN_FAILED'); }
  if (signal?.aborted) return 'CHECK_ABORTED';
  if (lockfiles.length === 0) return { toolchain, cache };
  try {
    const { tree, digest } = await steps.dependencies({ lockfiles, cpu: arch, cacheDir });
    if (!sha256Hex(digest) || digest !== tree?.digest) return 'CHECK_DEPENDENCIES_FAILED';
    cache = { tree, digest };
  } catch (error) { return codeOf(error, DEPENDENCY_CODE, 'CHECK_DEPENDENCIES_FAILED'); }
  return { toolchain, cache }; // checkJob's abort check after the environment covers an abort during this step
}

// The toolchain, then any dependency tree, copied into the materialized guest. Each keeps its own transfer timeout, as
// materialize does, because a tree can outlast the 60 s call bound. null once both are in, else a fixed code.
async function installHostInputs({ provider, signal }, name, { toolchain, cache }, steps) {
  if (signal?.aborted) return 'CHECK_ABORTED';
  try { await steps.installToolchain({ name, toolchain, provider }); } catch (error) { return codeOf(error, TRANSFER_CODE, 'CHECK_TOOLCHAIN_FAILED'); }
  if (signal?.aborted) return 'CHECK_ABORTED';
  if (cache === null) return null;
  try { await steps.installDependencies({ name, tree: cache.tree, provider }); } catch (error) {
    return codeOf(error, TRANSFER_CODE, 'CHECK_DEPENDENCIES_FAILED');
  }
  return null;
}

// onReady, bounded by timeoutMs and the signal. Its own error and the timeout propagate, so runCheckJob rethrows them
// after the delete; an abort resolves ABORTED. The race subscribes to the hook, so a late rejection is never unhandled.
async function ready(o, environment) {
  let timer;
  let onAbort;
  const bounds = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(checkError('CHECK_READY_TIMEOUT')), o.timeoutMs);
    onAbort = () => resolve(ABORTED);
    o.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => o.onReady(environment)), bounds]); } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}

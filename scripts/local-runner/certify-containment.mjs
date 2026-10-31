// Check containment certify check (CQ-R13f1): three runCheckJob runs, each in its own fresh owned check VM, on one generated
// snapshot (a probe script, one protected file, one tracked unprotected file) show on real hardware that the check identity
// stays contained. The probe exits 0 only when every refusal holds; the certify host's own root change of the protected
// file mid-run must make the supervisor's after-run check resolve 'inconclusive' (exit 80), the only native path to it; an
// edit of the tracked file must verify 'changed'. Every run must delete its VM, and the first failing run stops the check.
// runCheckJob fetches the pinned Node toolchain into cacheDir, so the operator run needs host network. Fixed codes only; no
// guest byte reaches the report. Certification is not activation: executionReady stays false and verified-local stays
// unavailable. CQ-R13f adds two checks around it. Before it, 'writer-containment': in the certify VM the agent identity can
// read neither the supervisor credential nor the root-only workspace manifest, and can write neither /opt/moe, another job's
// session home, the supervisor nor the installed toolchain. After it, 'controller-replacement': the certify VM's supervisor,
// replaced as root, must fail readiness, and this run's cleanup must leave a ledger record rewritten to another owner alone.
// It taints the certify VM, so it runs last among the checks that use it.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probe as guestExec } from './certify-bridge.mjs';
import { CHECK_BOUNDARIES } from './check-evidence.mjs';
import { runCheckJob } from './check-lifecycle.mjs';
import { runCheckSession } from './check-session.mjs';
import { buildUserData, GUEST_LAYOUT, JOB_IDENTITIES } from './guest-bootstrap.mjs';
import { waitForGuestReady } from './guest-readiness.mjs';
import { deleteOwned, invoker, QUERY_TIMEOUT_MS, queryOwnedInstance } from './lifecycle.mjs';
import { installToolchain } from './snapshot-transfer.mjs';
import { validateImport } from './source-snapshot.mjs';
import { fetchNodeToolchain } from './toolchain-cache.mjs';

const { network, resources: { rlimits }, filesystem: { supervisorCredential } } = CHECK_BOUNDARIES;
const PROTECTED = 'moe-certify/protected.txt';
const PROTECTED_BYTES = Buffer.from('moe-certify-protected-v1\n');
// The approved entry: git's blob id of the protected bytes, which the supervisor checks before and after the job.
const PROTECTED_ENTRY = Object.freeze({ path: PROTECTED, oid: createHash('sha1').update(`blob ${PROTECTED_BYTES.length}\0`).update(PROTECTED_BYTES).digest('hex') });
// Root, in the guest's own mount namespace (guest-supervisor.py WORKSPACE), where the protected file is a plain root-owned
// file. Truncation keeps its inode, so the job's read-only bind and the supervisor's after-run check both see the change.
const CHANGE_ARGV = Object.freeze(['sudo', '-n', 'truncate', '-s', '0', `/var/lib/moe/workspace/${PROTECTED}`]);
// Exits 10-14 for the first refusal that does not hold. A write open truncates, so the kernel checks the read-only mount
// (EROFS) before the root-owned file's mode (EACCES). CPython ignores SIGXFSZ, so the write at the limit returns EFBIG.
const PROBE = `import errno, resource, socket, sys, tempfile
INTERFACES, CREDENTIAL, PROTECTED = ${JSON.stringify(network.interfaces)}, ${JSON.stringify(supervisorCredential.path)}, ${JSON.stringify(PROTECTED)}
NPROC, FSIZE = ${rlimits.RLIMIT_NPROC}, ${rlimits.RLIMIT_FSIZE}


def held(code, ok):
    if not ok:
        sys.exit(code)


def refused(code, attempt, number):
    try:
        attempt()
    except OSError as error:
        held(code, error.errno == number)
    else:
        sys.exit(code)


held(10, [name for _, name in socket.if_nameindex()] == INTERFACES)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
    held(10, route.connect_ex(('192.0.2.1', 9)) == errno.ENETUNREACH)
refused(11, lambda: open(CREDENTIAL, 'rb').close(), errno.EACCES)
refused(12, lambda: open(PROTECTED, 'wb').close(), errno.EROFS)
for name, value in (('RLIMIT_NPROC', NPROC), ('RLIMIT_FSIZE', FSIZE)):
    limit = getattr(resource, name)
    held(13, resource.getrlimit(limit) == (value, value))
    try:
        resource.setrlimit(limit, (value + 1, value + 1))
    except ValueError:
        pass
    else:
        sys.exit(13)
with tempfile.TemporaryFile(buffering=0) as scratch:
    scratch.seek(FSIZE)
    refused(14, lambda: scratch.write(b'x'), errno.EFBIG)
`;
// [id, approved command]: the probe; the integrity job, which exits 3 if it can overwrite the protected file, else waits
// (bounded) for the host's change and exits 0 once it sees it; the tracked edit.
const RUNS = Object.freeze([
  ['certify-probe', 'python3 -I -B moe-certify/probe.py'],
  ['certify-integrity', `printf x 2>/dev/null >${PROTECTED} && exit 3; i=0; while [ -s ${PROTECTED} ] && [ "$i" -lt 60 ]; do sleep 1; i=$((i+1)); done; [ ! -s ${PROTECTED} ]`],
  ['certify-edit', 'echo edited >>moe-certify/tracked.txt'],
]);
const REFUSALS = new Map([[10, 'CERTIFY_CONTAINMENT_NETWORK'], [11, 'CERTIFY_CONTAINMENT_CREDENTIAL'], [12, 'CERTIFY_CONTAINMENT_PROTECTED'],
  [13, 'CERTIFY_CONTAINMENT_RLIMIT'], [14, 'CERTIFY_CONTAINMENT_FSIZE']]);
const passed = Object.freeze({ result: 'passed', code: null });
const failed = code => Object.freeze({ result: 'failed', code });

/** A fresh version-1 SourceSnapshot: the probe, the protected file and the tracked file. validateImport copies each file's bytes. */
export function containmentSnapshot() {
  return Object.freeze({ version: 1, overlay: validateImport([]), base: validateImport([
    { kind: 'file', path: 'moe-certify/probe.py', executable: false, data: Buffer.from(PROBE) },
    { kind: 'file', path: PROTECTED, executable: false, data: PROTECTED_BYTES },
    { kind: 'file', path: 'moe-certify/tracked.txt', executable: false, data: Buffer.from('moe-certify-tracked-v1\n') },
  ]) });
}

// Resolves true once CHANGE_ARGV exits 0, else false; never rejects.
const changeProtected = (name, provider) => Promise.resolve()
  .then(() => invoker(name, provider)(['exec', '--no-map-working-directory', name, '--', ...CHANGE_ARGV], QUERY_TIMEOUT_MS)).then(() => true, () => false);

// The integrity run's session: runCheckSession unchanged, except that its spawn's first stdout bytes (the supervisor's hello,
// written after its before-run hash check) start the change, once. It settles only after the change has, into seen.changed.
const changingSession = seen => async input => {
  let change = null;
  const spawn = (...args) => {
    const child = (input.provider?.spawn ?? spawnProcess)(...args);
    child?.stdout?.once?.('data', () => { change ??= changeProtected(input.name, input.provider); });
    return child;
  };
  try { return await runCheckSession({ ...input, provider: { ...input.provider, spawn } }); } finally { seen.changed = await change; }
};

// Per run, null when it resolved as required, else its fixed code.
const RULES = [
  r => (r.outcome === 'passed' && r.workspace === 'intact' ? null : (r.outcome === 'code-failure' && REFUSALS.get(r.exitCode)) || 'CERTIFY_CONTAINMENT_PROBE_FAILED'),
  (r, changed) => (changed !== true ? 'CERTIFY_CONTAINMENT_CHANGE_FAILED' : r.outcome === 'inconclusive' && r.exitCode === 0 ? null : 'CERTIFY_CONTAINMENT_INTEGRITY_FAILED'),
  r => (r.outcome === 'passed' && r.workspace === 'changed' ? null : 'CERTIFY_CONTAINMENT_EDIT_FAILED'),
];
// A VM left behind first; then a run stopped before its session keeps runCheckJob's own failure code (certify keeps it if stable).
function verdict(at, result, changed) {
  if (result?.vm === 'delete-failed') return 'CERTIFY_CONTAINMENT_VM_NOT_DELETED';
  if (result?.failure !== null) return result?.failure;
  return result.vm === 'deleted' ? RULES[at](result, changed) : 'CERTIFY_CONTAINMENT_VM_NOT_DELETED';
}

// context: platform (observed), ledger (the base one), cacheDir, supervisor (the real bytes), provider, bounds; deps.containment
// = { runCheckJob } is a test-only seam, absent natively. A runCheckJob rejection propagates with its own code.
async function checkContainment(c) {
  const job = c.deps?.containment?.runCheckJob ?? runCheckJob;
  const snapshot = containmentSnapshot();
  for (const [at, [id, command]] of RUNS.entries()) {
    const seen = { changed: null };
    const result = await job({ platform: c.platform, ledger: c.ledger, owner: { taskId: 'task-certify', attemptId: `attempt-${randomBytes(16).toString('hex')}`, generation: 1 },
      cacheDir: c.cacheDir, supervisor: c.supervisor, credential: randomBytes(32), snapshot, check: { id, command, protected: [PROTECTED_ENTRY] },
      budgetMs: c.bounds.sessionMs, onReady: async () => {}, dependencies: [], provider: c.provider }, at === 1 ? { session: changingSession(seen) } : undefined);
    const code = verdict(at, result, seen.changed);
    if (code !== null) return failed(code);
  }
  return passed;
}

// guest-supervisor.py's own paths: SESSIONS holds each job's home, as session_home makes it (0700, owned by the job's identity);
// this one, made the same way for the other job identity under a name mkdtemp never draws, stands in for another job's home.
const OTHER_HOME = '/var/lib/moe/sessions/home-certify';
const HOME_ARGV = Object.freeze(['sudo', '-n', 'install', '-d', '-m', '0700', '-o', JOB_IDENTITIES[1], '-g', JOB_IDENTITIES[1], OTHER_HOME]);
// [code, target, access(2) mode: 4 R_OK or 2 W_OK]: WORKSPACE_MANIFEST is root-only; TOOLCHAIN/bin is first on a check job's PATH.
const WRITER_TARGETS = Object.freeze([['CREDENTIAL', GUEST_LAYOUT.credential, 4], ['MANIFEST', '/var/lib/moe/workspace.manifest.json', 4],
  ['CONTROL_PLANE', GUEST_LAYOUT.supervisorDirs[0], 2], ['HOME', OTHER_HOME, 2], ['SUPERVISOR', GUEST_LAYOUT.supervisor, 2],
  ['TOOLCHAIN', '/opt/moe/toolchain/bin', 2], ['TOOLCHAIN', '/opt/moe/toolchain/bin/node', 2]]);
/** One line, no quote, run as the agent identity: exits 10+i for the first target it may access, 20+i for one it cannot see
 * (absence is never evidence), else 0. A target that exists and that access(2) refuses is a permission refusal. */
export const WRITER_PROBE = `import os,sys;T=${JSON.stringify(WRITER_TARGETS.map(([, file, mode]) => [file, mode]))};sys.exit(next((10+i if `
  + 'os.path.exists(p) else 20+i for i,(p,m) in enumerate(T) if not os.path.exists(p) or os.access(p,m)),0))';
// Root, in the certify VM: another program's bytes over the supervisor. cp keeps its inode, owner and mode, so only its hash changes.
const REPLACE_ARGV = Object.freeze(['sudo', '-n', 'cp', '/usr/bin/true', GUEST_LAYOUT.supervisor]);

// Every target is made real first: the other job's home, then the pinned toolchain (R11e1's cache, R11e2's install). deps.writer
// = { toolchain, installToolchain } is a test-only seam, absent natively; their refusals keep their own codes.
async function writerContainment(c) {
  const seam = c.deps?.writer ?? {};
  if ((await guestExec(c, HOME_ARGV)).code !== 0) return failed('CERTIFY_WRITER_SETUP_FAILED');
  const toolchain = await (seam.toolchain ?? fetchNodeToolchain)({ arch: c.outcome?.image?.source?.arch, cacheDir: c.cacheDir });
  await (seam.installToolchain ?? installToolchain)({ name: c.name, toolchain, provider: c.provider, timeoutMs: c.bounds.transferMs });
  const { code } = await guestExec(c, ['sudo', '-n', '-u', JOB_IDENTITIES[0], 'python3', '-I', '-c', WRITER_PROBE]);
  if (code === 0) return passed;
  const [allowed, missing] = [WRITER_TARGETS[code - 10], WRITER_TARGETS[code - 20]];
  return failed(allowed ? `CERTIFY_WRITER_${allowed[0]}_ALLOWED` : missing ? 'CERTIFY_WRITER_TARGET_MISSING' : 'CERTIFY_WRITER_UNKNOWN');
}

// Readiness, re-run as provisioning ran it with buildUserData's digests of the real bytes (its throwaway credential is never sent),
// must refuse the replaced supervisor by its hash alone. Then this VM's own ledger record, rewritten on disk to another attempt as a
// replacement controller would leave it: this run's cleanup (teardown's deleteOwned) must refuse it, and the VM and the rewritten
// record must stay. The original bytes go back on every path, so teardown still deletes the VM. deps.replacement = { deleteOwned }
// is a test-only seam, absent natively.
async function controllerReplacement(c) {
  if ((await guestExec(c, REPLACE_ARGV)).code !== 0) return failed('CERTIFY_REPLACEMENT_NOT_REPLACED');
  const { supervisorSha256, shimSha256, shimToolsSha256 } = buildUserData({ supervisor: c.supervisor, credential: randomBytes(32) });
  const ready = await waitForGuestReady({ ledger: c.ledger, name: c.name, owner: c.owner, sourceImage: c.outcome.image.source,
    bootstrap: { supervisorSha256, shimSha256, shimToolsSha256 }, provider: c.provider, sleep: c.deps.sleep });
  if (ready.bootstrapReady !== false) return failed('CERTIFY_REPLACEMENT_ACCEPTED');
  if (ready.failures.length !== 1 || ready.failures[0] !== 'SUPERVISOR_HASH_MISMATCH') return failed('CERTIFY_REPLACEMENT_UNKNOWN');
  const file = path.join(c.ledgerDir, `${c.name}.json`);
  const [original, attemptId] = [await readFile(file), `attempt-${randomBytes(16).toString('hex')}`];
  try {
    await writeFile(file, `${JSON.stringify({ ...JSON.parse(original), attemptId })}\n`);
    const cleanup = c.deps.replacement?.deleteOwned ?? deleteOwned;
    const refusal = await Promise.resolve().then(() => cleanup({ ledger: c.ledger, name: c.name, owner: c.owner, provider: c.provider }))
      .then(() => null, error => error?.code);
    const kept = await c.ledger.read(c.name).catch(() => null);
    const vm = await queryOwnedInstance(c.name, c.provider).catch(() => null);
    return refusal === 'LIFECYCLE_NOT_OWNER' && kept?.phase === 'owned' && kept.attemptId === attemptId && vm?.present === true ? passed
      : failed('CERTIFY_REPLACEMENT_RECORD_NOT_KEPT');
  } finally { await writeFile(file, original); }
}

/** Spliced into certify.mjs's BODY after BRIDGE_CHECKS, in this order: 'controller-replacement' taints the certify VM, so it is last. */
export const CONTAINMENT_CHECKS = Object.freeze([['writer-containment', writerContainment], ['check-containment', checkContainment],
  ['controller-replacement', controllerReplacement]].map(([id, run]) => Object.freeze({ id, run })));

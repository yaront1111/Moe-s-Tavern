// CQ-M07b: the readiness evaluator for verified-local (mem:decision-verified-local-readiness-evaluator, decision 4 in
// mem:decision-cq-m07-verified-local-activation). It computes a snapshot ONLY from facts the daemon observes through injected
// inputs: no env var, platform, home, persisted label or project file is read here, and a setting can only refuse.
// LEAF-SAFE: node built-ins, certificationEvidence.ts, runnerChannel.ts (isRunnerKey) and pathKey only, so CQ-M07c's
// snapshot holder can import these ids and types. Nothing imports this module yet: verified-local stays unavailable.
import { constants, lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { CERTIFY_CHECK_IDS, CertificationEvidence, CertificationRefusal } from './certificationEvidence.js';
import { isRunnerKey } from '../server/runnerChannel.js';
import { pathKey } from '../util/affectedFiles.js';

/** Today's assertExecutionProfileReady order. */
export const READINESS_CAPABILITIES = Object.freeze(['protected-host-control-plane', 'isolated-agent-and-qa-vms', 'isolated-check-vm',
  'authenticated-runner-evidence', 'revision-bound-local-delivery'] as const);
/** Evidence failures, each matching one operator action. */
export const READINESS_EVIDENCE_IDS = Object.freeze(['certification-host-unsupported', 'certification-store-unsafe',
  'certification-unreadable', 'certification-report-missing', 'certification-report-rejected', 'certification-report-mismatch',
  'provider-probe-failed', 'provider-probe-timeout', 'provider-probe-malformed', 'provider-version-mismatch'] as const);
/** The one stable order: missingCapabilities is always a filter over this list, and consumers list it verbatim. */
export const READINESS_IDS = Object.freeze([...READINESS_CAPABILITIES, ...READINESS_EVIDENCE_IDS] as const);
export type ReadinessId = (typeof READINESS_IDS)[number];

type CertifyCheckId = (typeof CERTIFY_CHECK_IDS)[number];
/** The certify rows that prove isolated-agent-and-qa-vms (row meanings: docs/CERTIFICATION.md). */
export const AGENT_VM_ROWS: readonly CertifyCheckId[] = Object.freeze(['provision', 'readiness', 'no-mounts', 'bridge-framing', 'bridge-eof',
  'guest-network', 'writer-containment', 'controller-replacement', 'recovery', 'teardown']);
/** The certify rows that prove isolated-check-vm. */
export const CHECK_VM_ROWS: readonly CertifyCheckId[] = Object.freeze(['provision', 'readiness', 'no-mounts', 'guest-network',
  'check-containment', 'controller-replacement', 'cancellation', 'recovery', 'canary-check', 'teardown']);

/** Exhaustive, so tsc fails when CQ-M07a adds a refusal code. A *_MISMATCH-group id is the operator's re-certify signal. */
export const CERTIFICATION_REFUSAL_IDS: Readonly<Record<CertificationRefusal, ReadinessId>> = Object.freeze({
  CERTIFICATION_HOST_UNSUPPORTED: 'certification-host-unsupported',
  CERTIFICATION_STORE_UNSAFE: 'certification-store-unsafe',
  CERTIFICATION_STORE_IN_PROJECT: 'certification-store-unsafe',
  CERTIFICATION_INPUT_INVALID: 'certification-unreadable',
  CERTIFICATION_STORE_UNAVAILABLE: 'certification-unreadable',
  CERTIFICATION_STORE_UNREADABLE: 'certification-unreadable',
  CERTIFICATION_STORE_MISSING: 'certification-report-missing',
  CERTIFICATION_REPORT_NONE: 'certification-report-missing',
  CERTIFICATION_REPORT_UNSAFE: 'certification-report-rejected',
  CERTIFICATION_REPORT_UNREADABLE: 'certification-report-rejected',
  CERTIFICATION_REPORT_OVERSIZE: 'certification-report-rejected',
  CERTIFICATION_REPORT_MALFORMED: 'certification-report-rejected',
  CERTIFICATION_REPORT_SCHEMA: 'certification-report-rejected',
  CERTIFICATION_REPORT_CHECKS: 'certification-report-rejected',
  CERTIFICATION_REPORT_INJECTED: 'certification-report-rejected',
  CERTIFICATION_REPORT_UNCERTIFIED: 'certification-report-rejected',
  CERTIFICATION_REPORT_PLATFORM: 'certification-report-mismatch',
  CERTIFICATION_REPORT_ARCH: 'certification-report-mismatch',
  CERTIFICATION_REPORT_IMAGE: 'certification-report-mismatch',
  CERTIFICATION_REPORT_SUPERVISOR: 'certification-report-mismatch',
  CERTIFICATION_REPORT_PROVIDER_VERSION: 'certification-report-mismatch',
});

/** Compiled port of scripts/local-runner/platform-{linux,macos,windows}.mjs `executable` (the daemon cannot import scripts/):
 *  never a bare 'multipass', never a PATH lookup. programFiles only locates the win32 client, as platform-windows.mjs driveRoot does. */
export function pinnedMultipassClient(platform: string, programFiles?: string): string | null {
  if (platform === 'linux') return '/snap/bin/multipass';
  if (platform === 'darwin') return '/usr/local/bin/multipass';
  if (platform !== 'win32') return null;
  const root = typeof programFiles === 'string' && /^[A-Za-z]:\\/.test(programFiles) ? programFiles : 'C:\\Program Files';
  return path.win32.join(root, 'Multipass', 'bin', 'multipass.exe');
}
export const PROBE_ARGS = Object.freeze(['version', '--format', 'json'] as const);
/** multipass.mjs MAX_PROBE_TIMEOUT_MS and MAX_PROBE_BUFFER. */
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BYTES = 65_536;
const PROBE_GUARD_MS = PROBE_TIMEOUT_MS + 1000;

interface ProbeOptions {
  readonly encoding: 'utf8'; readonly shell: false; readonly windowsHide: true; readonly timeout: number; readonly maxBuffer: number;
  readonly killSignal: 'SIGKILL';
}
/** execFile-compatible: CQ-M07c wires promisify(execFile). There is no default, so a unit test can never spawn a real client. */
export type ProbeRunner = (file: string, args: string[], options: ProbeOptions) => Promise<{ stdout: unknown }>;
export interface ReadinessInputs {
  /** The project this daemon serves. */
  readonly projectRoot: string;
  /** The daemon's own package root (dist/ and node_modules/). */
  readonly daemonInstallDir: string;
  /** runnerKeyPath(projectRoot), as server/runnerChannel.ts files the key. */
  readonly runnerKeyPath: string;
  /** Only an own deliveryPolicy is read. */
  readonly settings: unknown;
  /** () => readHostCertificationEvidence(projectRoot), never readCertificationStore. */
  readonly readCertification: () => Promise<CertificationEvidence>;
  readonly runProbe: ProbeRunner;
  /** The ProgramFiles env value in production (CQ-M07c wires it); it only locates the win32 client and can never grant. */
  readonly programFiles?: string;
  readonly now: () => Date;
}
export interface ReadinessSnapshot {
  readonly ready: boolean;
  readonly missingCapabilities: readonly ReadinessId[];
  readonly evaluatedAt: string;
  readonly evidence: { readonly reportSha256: string; readonly platform: string; readonly arch: string | null;
    readonly providerVersion: string | null } | null;
}
type Evidence = ReadinessSnapshot['evidence'];

const CONTROL = /[\x00-\x1f\x7f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_KEY_BYTES = 64;
const ISOLATION: readonly ReadinessId[] = ['isolated-agent-and-qa-vms', 'isolated-check-vm'];
const errno = (error: unknown) => (error as { code?: unknown } | null)?.code;
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
// certificationEvidence.ts's copy of commitMaterializer.ts's containment test, case-folded where the file system is.
function inside(root: string, target: string): boolean {
  const rel = path.relative(pathKey(root), pathKey(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The project's real path and, unless absent, its .moe's (which may be a symlink elsewhere). Rejects on anything else. */
async function projectReals(inputs: ReadinessInputs): Promise<string[]> {
  const projectRoot: unknown = inputs.projectRoot;
  if (!absolute(projectRoot)) throw new Error('projectRoot is not an absolute path');
  const root = await realpath(projectRoot);
  const moe = await realpath(path.join(root, '.moe')).catch((error: unknown) => (errno(error) === 'ENOENT' ? null : Promise.reject(error)));
  return moe === null ? [root] : [root, moe];
}

/** protected-host-control-plane: the daemon's install tree and the project (and .moe) trees are disjoint. No env var counts. */
async function controlPlaneProtected(inputs: ReadinessInputs, project: Promise<string[] | null>): Promise<boolean> {
  try {
    const installDir: unknown = inputs.daemonInstallDir;
    if (!absolute(installDir)) return false;
    const install = await realpath(installDir);
    const bases = await project;
    return bases !== null && bases.every(base => !inside(base, install) && !inside(install, base));
  } catch { return false; }
}

/** authenticated-runner-evidence: a regular-file key in the stored format, filed outside the project and .moe. Its bytes never leave here. */
async function runnerKeyFiled(inputs: ReadinessInputs, project: Promise<string[] | null>): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    const keyPath: unknown = inputs.runnerKeyPath;
    if (!absolute(keyPath)) return false;
    const link = await lstat(keyPath);
    if (!link.isFile() || link.size > MAX_KEY_BYTES) return false;
    // No symlink follow and no FIFO block if the file is swapped after lstat.
    handle = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) return false;
    const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_KEY_BYTES || !isRunnerKey(bytes.subarray(0, bytesRead).toString('utf8'))) return false;
    const [real, bases] = [await realpath(keyPath), await project];
    return bases !== null && !bases.some(base => inside(base, real));
  } catch { return false; } finally { await handle?.close().catch(() => undefined); }
}

/** revision-bound-local-delivery: an OWN settings.deliveryPolicy of 'local-branch'. No other key is read, so a setting only refuses. */
function localDeliveryRequired(inputs: ReadinessInputs): boolean {
  try {
    const settings: unknown = inputs.settings;
    return isObject(settings) && Object.prototype.hasOwnProperty.call(settings, 'deliveryPolicy') && settings.deliveryPolicy === 'local-branch';
  } catch { return false; }
}

type Probe = { readonly ok: true; readonly stdout: unknown } | { readonly ok: false; readonly id: ReadinessId };
const timedOut = (error: unknown) => isObject(error) && (error.killed === true || error.code === 'ETIMEDOUT');
/** One bounded call of the pinned client, raced against a guard timer cleared on every path. Never rejects. */
async function probeProvider(executable: string, runProbe: unknown): Promise<Probe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof runProbe !== 'function') return { ok: false, id: 'provider-probe-failed' };
    const guard = new Promise<Probe>(resolve => {
      const fired = setTimeout(() => resolve({ ok: false, id: 'provider-probe-timeout' }), PROBE_GUARD_MS);
      fired.unref?.();
      timer = fired;
    });
    const options: ProbeOptions = { encoding: 'utf8', shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES,
      killSignal: 'SIGKILL' };
    const call = Promise.resolve((runProbe as ProbeRunner)(executable, [...PROBE_ARGS], options)).then(
      (result): Probe => ({ ok: true, stdout: (result as { stdout?: unknown } | null)?.stdout }),
      (error: unknown): Probe => ({ ok: false, id: timedOut(error) ? 'provider-probe-timeout' : 'provider-probe-failed' }));
    return await Promise.race([call, guard]);
  } catch { return { ok: false, id: 'provider-probe-failed' }; } finally { clearTimeout(timer); }
}

/** doctor.mjs's parse of `multipass version --format json`: a non-array object with string multipass and multipassd. */
function liveVersions(stdout: unknown): { multipass: string; multipassd: string } | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > PROBE_MAX_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!isObject(parsed) || Array.isArray(parsed)) return null;
  const { multipass, multipassd } = parsed;
  return typeof multipass === 'string' && typeof multipassd === 'string' ? { multipass, multipassd } : null;
}

/** Every listed row is present in report.checks, and every copy of it passed. */
function rowsPassed(rows: readonly unknown[], ids: readonly string[]): boolean {
  return ids.every(id => {
    const mine = rows.filter(row => isObject(row) && row.id === id);
    return mine.length > 0 && mine.every(row => (row as Record<string, unknown>).result === 'passed');
  });
}

function refusalIds(refusals: unknown): ReadinessId[] {
  if (!Array.isArray(refusals) || refusals.length === 0) return ['certification-unreadable'];
  return refusals.map(code => (typeof code === 'string' && Object.hasOwn(CERTIFICATION_REFUSAL_IDS, code)
    ? CERTIFICATION_REFUSAL_IDS[code as CertificationRefusal] : 'certification-unreadable'));
}

/** The accepted report's identity, or null when the reader's ok:true value is not shaped as one. Each field is read once. */
function acceptedIdentity(report: unknown, sha256: unknown): Evidence {
  if (!isObject(report) || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  const { platform, arch, provider } = report;
  const providerVersion = isObject(provider) ? provider.version : undefined;
  if (typeof platform !== 'string' || !nullableString(arch) || !nullableString(providerVersion)) return null;
  return Object.freeze({ reportSha256: sha256, platform, arch, providerVersion });
}

type Isolation = { readonly missing: readonly ReadinessId[]; readonly evidence: Evidence };
/** Both isolation capabilities: CQ-M07a accepted a report, the live pinned client matches its provider version, and the rows passed.
 *  The probe runs only after an accepted report, so a host that never certified spawns nothing. Never rejects. */
async function certifiedIsolation(inputs: ReadinessInputs): Promise<Isolation> {
  let evidence: Evidence = null;
  try {
    const result: unknown = await inputs.readCertification();
    if (!isObject(result) || (result.ok !== true && result.ok !== false)) return { missing: [...ISOLATION, 'certification-unreadable'], evidence };
    if (result.ok === false) return { missing: [...ISOLATION, ...refusalIds(result.refusals)], evidence };
    const { report, sha256 } = result;
    evidence = acceptedIdentity(report, sha256);
    if (evidence === null) return { missing: [...ISOLATION, 'certification-unreadable'], evidence };
    const executable = pinnedMultipassClient(evidence.platform, inputs.programFiles);
    const probe: Probe = executable === null ? { ok: false, id: 'provider-probe-failed' } : await probeProvider(executable, inputs.runProbe);
    if (!probe.ok) return { missing: [...ISOLATION, probe.id], evidence };
    const live = liveVersions(probe.stdout);
    if (live === null) return { missing: [...ISOLATION, 'provider-probe-malformed'], evidence };
    const version = evidence.providerVersion;
    if (live.multipass !== version || live.multipassd !== version) return { missing: [...ISOLATION, 'provider-version-mismatch'], evidence };
    const checks = (report as Record<string, unknown>).checks;
    const rows: readonly unknown[] = Array.isArray(checks) ? checks : [];
    return { missing: [...(rowsPassed(rows, AGENT_VM_ROWS) ? [] : [ISOLATION[0]]), ...(rowsPassed(rows, CHECK_VM_ROWS) ? [] : [ISOLATION[1]])], evidence };
  } catch { return { missing: [...ISOLATION, 'certification-unreadable'], evidence }; }
}

/** The verified-local readiness snapshot, deep-frozen. Never rejects for a failing fact: each check adds only its own ids.
 *  Holding the snapshot, scheduling and single-flight belong to CQ-M07c. */
export async function evaluateExecutionReadiness(inputs: ReadinessInputs): Promise<ReadinessSnapshot> {
  const project = projectReals(inputs).catch(() => null);
  const [control, key, isolation] = await Promise.all([controlPlaneProtected(inputs, project), runnerKeyFiled(inputs, project),
    certifiedIsolation(inputs)]);
  const missing = new Set<ReadinessId>(isolation.missing);
  if (!control) missing.add('protected-host-control-plane');
  if (!key) missing.add('authenticated-runner-evidence');
  if (!localDeliveryRequired(inputs)) missing.add('revision-bound-local-delivery');
  const missingCapabilities = Object.freeze(READINESS_IDS.filter(id => missing.has(id)));
  const evaluatedAt = inputs.now().toISOString();
  return Object.freeze({ ready: missingCapabilities.length === 0, missingCapabilities, evaluatedAt, evidence: isolation.evidence });
}

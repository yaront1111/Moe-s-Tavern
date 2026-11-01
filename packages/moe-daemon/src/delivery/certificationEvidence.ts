// CQ-M07a: the daemon's one fail-closed reader of this host's certification store (decision 4, "host store, live match", in
// mem:decision-cq-m07-verified-local-activation). It only reads and checks evidence; nothing here grants readiness. A LEAF (node built-ins
// and pathKey). npm and Docker ship no scripts/, so the schema is a TypeScript port of certify.mjs, proven by a drift test.
import { createHash } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathKey } from '../util/affectedFiles.js';

const [CODE, SHA256, VERSION] = [/^[A-Z][A-Z0-9_]{0,63}$/, /^[0-9a-f]{64}$/, /^[0-9A-Za-z.+-]{1,64}$/];
const [PLATFORMS, ARCHES, RESULTS]: ReadonlyArray<readonly unknown[]> = [['win32', 'linux', 'darwin'], ['x64', 'arm64'], ['passed', 'failed', 'not-run']];
const REPORT_KEYS = ['kind', 'version', 'platform', 'arch', 'transport', 'provider', 'image', 'supervisorSha256', 'startedAt',
  'finishedAt', 'checks', 'certified', 'executionReady'] as const;
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
/** certify.mjs CERTIFY_CHECKS ids, in registry order ('teardown' last). */
export const CERTIFY_CHECK_IDS = Object.freeze(['provision', 'readiness', 'no-mounts', 'bridge-framing', 'bridge-eof', 'guest-network',
  'writer-containment', 'check-containment', 'controller-replacement', 'cancellation', 'recovery', 'canary-check', 'teardown'] as const);
// The shipped pins, compiled in so no project file can move them: certified-provider.json (versions, hosts without driver,
// images[arch].sha256) and sha256(guest-supervisor.py), copied from HEAD. Whoever changes either file, CERTIFY_CHECKS or
// validateCertificationReport updates this in the same diff; the drift test fails until they agree (mem:decision-certification-evidence-pins).
export const CERTIFICATION_PINS = deepFreeze({
  versions: ['1.17.0'],
  hosts: [{ platform: 'win32', arch: 'x64', versionSuffix: '+win' }, { platform: 'linux', arch: 'x64', versionSuffix: '' },
    { platform: 'darwin', arch: 'x64', versionSuffix: '+mac' }, { platform: 'darwin', arch: 'arm64', versionSuffix: '+mac' }],
  images: { x64: '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94',
    arm64: '50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e' },
  supervisorSha256: '3a19f3bf07cf6d47a1fb93e425b4bf7f1eb7e2b3b2d31bb21ba00752ecef8190',
} as const);
export type CertificationHost = (typeof CERTIFICATION_PINS.hosts)[number];
export interface CertificationCheckRow { readonly id: string; readonly result: 'passed' | 'failed' | 'not-run'; readonly code: string | null }
export interface CertificationReport {
  readonly kind: 'isolation-certification'; readonly version: 1; readonly platform: string; readonly arch: string | null;
  readonly transport: 'native' | 'injected'; readonly provider: { readonly name: 'multipass'; readonly version: string | null };
  readonly image: { readonly sourceSha256: string | null; readonly providerImageHash: string | null }; readonly supervisorSha256: string | null;
  readonly startedAt: string; readonly finishedAt: string; readonly checks: readonly CertificationCheckRow[]; readonly certified: boolean;
  readonly executionReady: false;
}
type ReportCode = 'CERTIFICATION_REPORT_SCHEMA' | 'CERTIFICATION_REPORT_CHECKS';
export type CertificationReportCheck = { readonly ok: true; readonly report: CertificationReport } | { readonly ok: false; readonly code: ReportCode };
/** The pinned host entry for this platform and arch (only x64 and arm64 are listed), else null. */
export function hostIdentity(platform: string = process.platform, arch: string = process.arch): CertificationHost | null {
  return CERTIFICATION_PINS.hosts.find(host => host.platform === platform && host.arch === arch) ?? null;
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isIso = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
// certify.mjs exact(): a plain-record copy with exactly `keys` (Reflect.ownKeys, so symbols count), each read once.
function exact(value: unknown, keys: readonly string[]): Fields | null {
  if (!isRecord(value)) return null;
  const own = Reflect.ownKeys(value);
  return own.length !== keys.length || !keys.every(key => own.includes(key)) ? null : Object.fromEntries(keys.map(key => [key, value[key]]));
}
// certify.mjs validChecks(): the ids in order; 'not-run' exactly for the body rows after the first failure; a code only on 'failed'.
function validChecks(value: unknown): Fields[] | null {
  if (!Array.isArray(value) || value.length !== CERTIFY_CHECK_IDS.length) return null;
  const rows = CERTIFY_CHECK_IDS.map((_, at) => exact(value[at], ['id', 'result', 'code']));
  if (!rows.every((row): row is Fields => row !== null)) return null;
  return rows.every(({ id, result, code }, at) => id === CERTIFY_CHECK_IDS[at] && RESULTS.includes(result)
    && (result === 'not-run') === (at < rows.length - 1 && rows.slice(0, at).some(row => row.result === 'failed'))
    && (result === 'failed' ? typeof code === 'string' && CODE.test(code) : code === null)) ? rows : null;
}

/** The never-throwing port of certify.mjs validateCertificationReport: a deep-frozen copy of exactly the schema, or a fixed code. */
export function checkCertificationReport(value: unknown): CertificationReportCheck {
  let code: ReportCode = 'CERTIFICATION_REPORT_SCHEMA';
  try {
    const report = exact(value, REPORT_KEYS);
    const checks = report && validChecks(report.checks);
    if (report && !checks) code = 'CERTIFICATION_REPORT_CHECKS';
    const provider = report && exact(report.provider, ['name', 'version']);
    const image = report && exact(report.image, ['sourceSha256', 'providerImageHash']);
    if (report && checks && provider && image) {
      const { arch, certified, transport, version } = report;
      const hashes = [image.sourceSha256, image.providerImageHash, report.supervisorSha256];
      if (report.kind === 'isolation-certification' && version === 1 && PLATFORMS.includes(report.platform)
        && (arch === null ? certified === false : ARCHES.includes(arch)) && (transport === 'native' || transport === 'injected')
        && provider.name === 'multipass' && (provider.version === null || (typeof provider.version === 'string' && VERSION.test(provider.version)))
        && hashes.every(hash => (hash === null ? certified === false : typeof hash === 'string' && SHA256.test(hash)))
        && isIso(report.startedAt) && isIso(report.finishedAt)
        && certified === (transport === 'native' && checks.every(row => row.result === 'passed')) && report.executionReady === false) {
        return Object.freeze({ ok: true, report: deepFreeze({ ...report, provider, image, checks } as unknown as CertificationReport) });
      }
    }
  } catch { /* a hostile value (a throwing getter or proxy trap) is refused below */ }
  return Object.freeze({ ok: false, code });
}

const REFUSALS = ['INPUT_INVALID', 'HOST_UNSUPPORTED', 'STORE_UNAVAILABLE', 'STORE_MISSING', 'STORE_UNSAFE', 'STORE_IN_PROJECT',
  'STORE_UNREADABLE', 'REPORT_NONE', 'REPORT_UNSAFE', 'REPORT_UNREADABLE', 'REPORT_OVERSIZE', 'REPORT_MALFORMED', 'REPORT_SCHEMA',
  'REPORT_CHECKS', 'REPORT_INJECTED', 'REPORT_UNCERTIFIED', 'REPORT_PLATFORM', 'REPORT_ARCH', 'REPORT_IMAGE', 'REPORT_SUPERVISOR',
  'REPORT_PROVIDER_VERSION'] as const;
export type CertificationRefusal = `CERTIFICATION_${(typeof REFUSALS)[number]}`;
/** Every fixed refusal code. A refusal never carries a path, an errno or file bytes. */
export const CERTIFICATION_REFUSALS: readonly CertificationRefusal[] = Object.freeze(REFUSALS.map(name => `CERTIFICATION_${name}` as const));
export const MAX_REPORT_BYTES = 65_536;
export type CertificationEvidence = { readonly ok: true; readonly report: CertificationReport; readonly sha256: string }
  | { readonly ok: false; readonly refusals: readonly CertificationRefusal[] };
type Accepted = { readonly report: CertificationReport; readonly sha256: string };
// certify writeReport's (and the CQ-M07e store writer's) basename; every other name in the store is ignored.
const REPORT_NAME = /^certification-(win32|linux|darwin)-(x64|arm64)-\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const errno = (error: unknown) => (error as { code?: unknown } | null)?.code;
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value);
const refused = (refusals: CertificationRefusal[]): CertificationEvidence => Object.freeze({ ok: false, refusals: Object.freeze(refusals) });
// commitMaterializer.ts's containment test, case-folded where the file system is.
function inside(root: string, target: string): boolean {
  const rel = path.relative(pathKey(root), pathKey(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
/** <OS account home>/.moe/certification from the account record (passwd, the token's profile): never os.homedir(), HOME or USERPROFILE. */
export function certificationStoreDir(): string | null {
  try { return path.join(os.userInfo().homedir, '.moe', 'certification'); } catch { return null; }
}
/** The production entry (CQ-M07b calls only this): this OS account's store, which no env var, setting or argument relocates. */
export async function readHostCertificationEvidence(projectRoot: string): Promise<CertificationEvidence> {
  const storeDir = certificationStoreDir();
  return storeDir === null ? refused(['CERTIFICATION_STORE_UNAVAILABLE']) : readCertificationStore({ storeDir, projectRoot });
}
// The writer's rule (CQ-M07e): an owner-only real directory, outside the project and its (possibly symlinked) .moe.
async function storeRefusal(storeDir: string, root: string): Promise<CertificationRefusal | null> {
  let stat: Stats;
  try { stat = await lstat(storeDir); } catch (error) { return errno(error) === 'ENOENT' ? 'CERTIFICATION_STORE_MISSING' : 'CERTIFICATION_STORE_UNREADABLE'; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'CERTIFICATION_STORE_UNSAFE';
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return 'CERTIFICATION_STORE_UNSAFE';
  const real = await realpath(storeDir);
  const moe = await realpath(path.join(root, '.moe')).catch((error: unknown) => (errno(error) === 'ENOENT' ? null : Promise.reject(error)));
  return [root, moe].some(base => base !== null && inside(base, real)) ? 'CERTIFICATION_STORE_IN_PROJECT' : null;
}
// runner-client.mjs readSmall: no symlink follow, no FIFO block, a regular file only, at most the cap (the extra byte detects more).
async function readReportBytes(file: string): Promise<Buffer | CertificationRefusal> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) return 'CERTIFICATION_REPORT_UNSAFE';
    const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead > MAX_REPORT_BYTES ? 'CERTIFICATION_REPORT_OVERSIZE' : bytes.subarray(0, bytesRead);
  } catch (error) {
    return handle === undefined && ['ELOOP', 'EMLINK'].includes(String(errno(error))) ? 'CERTIFICATION_REPORT_UNSAFE' : 'CERTIFICATION_REPORT_UNREADABLE';
  } finally { await handle?.close().catch(() => undefined); }
}
async function judge(storeDir: string, entry: Dirent, host: CertificationHost): Promise<Accepted | CertificationRefusal> {
  if (!entry.isFile()) return 'CERTIFICATION_REPORT_UNSAFE';
  const bytes = await readReportBytes(path.join(storeDir, entry.name));
  if (!Buffer.isBuffer(bytes)) return bytes;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return 'CERTIFICATION_REPORT_MALFORMED'; }
  // Exactly the writer's bytes: refuses a BOM, invalid UTF-8, other whitespace and a duplicate key.
  if (!Buffer.from(`${JSON.stringify(value)}\n`, 'utf8').equals(bytes)) return 'CERTIFICATION_REPORT_MALFORMED';
  const checked = checkCertificationReport(value);
  if (!checked.ok) return checked.code;
  const { report } = checked;
  return report.transport !== 'native' ? 'CERTIFICATION_REPORT_INJECTED' : !report.certified ? 'CERTIFICATION_REPORT_UNCERTIFIED'
    : report.platform !== host.platform ? 'CERTIFICATION_REPORT_PLATFORM' : report.arch !== host.arch ? 'CERTIFICATION_REPORT_ARCH'
    : report.image.sourceSha256 !== CERTIFICATION_PINS.images[host.arch] ? 'CERTIFICATION_REPORT_IMAGE'
    : report.supervisorSha256 !== CERTIFICATION_PINS.supervisorSha256 ? 'CERTIFICATION_REPORT_SUPERVISOR'
    : !CERTIFICATION_PINS.versions.some(version => report.provider.version === version + host.versionSuffix) ? 'CERTIFICATION_REPORT_PROVIDER_VERSION'
    : { report, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** The test seam (production calls readHostCertificationEvidence only). Never rejects. The newest accepted report by finishedAt
 *  (a tie goes to the greater name) with the sha256 of its exact bytes, else each refusal once in name order. */
export async function readCertificationStore(input: { storeDir: string; projectRoot: string }): Promise<CertificationEvidence> {
  try {
    const { storeDir, projectRoot } = (input ?? {}) as Partial<typeof input>;
    const root = absolute(storeDir) && absolute(projectRoot) ? await realpath(projectRoot).catch(() => null) : null;
    if (root === null || !absolute(storeDir)) return refused(['CERTIFICATION_INPUT_INVALID']);
    const host = hostIdentity();
    if (host === null) return refused(['CERTIFICATION_HOST_UNSUPPORTED']);
    const unsafe = await storeRefusal(storeDir, root);
    if (unsafe !== null) return refused([unsafe]);
    const entries = (await readdir(storeDir, { withFileTypes: true })).filter(entry => REPORT_NAME.test(entry.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (entries.length === 0) return refused(['CERTIFICATION_REPORT_NONE']);
    const refusals = new Set<CertificationRefusal>();
    let best: Accepted | null = null;
    for (const entry of entries) {
      const judged = await judge(storeDir, entry, host);
      if (typeof judged === 'string') refusals.add(judged);
      else if (best === null || Date.parse(judged.report.finishedAt) >= Date.parse(best.report.finishedAt)) best = judged;
    }
    return best === null ? refused([...refusals]) : Object.freeze({ ok: true, report: best.report, sha256: best.sha256 });
  } catch { return refused(['CERTIFICATION_STORE_UNREADABLE']); }
}

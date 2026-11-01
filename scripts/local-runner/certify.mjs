// Native isolation certification (CQ-R13d): the ONLY evidence that can establish an isolation support claim. An ordered check
// registry runs the real flow through this host's own platform module, with the REAL guest supervisor and a fresh credential,
// then always deletes the run's VM by its exact owned name. It launches a real VM (and may download the ~600 MB image), so it
// is operator-invoked on real hardware, never CI; CQ-R13 validates the attached reports. The injectable core always reports
// 'injected' and the native entry takes exactly { workDir }, so mocks never certify. Certification is not activation:
// executionReady stays false and verified-local stays unavailable. Reports carry fixed codes and hashes only. CQ-R13e1 adds
// the bridge checks (certify-bridge.mjs) after 'no-mounts', with BRIDGE_BOUNDS, or certifyCore's validated overrides, on c.bounds.
// CQ-R13f1 and CQ-R13f add the certify-containment.mjs checks after them: 'writer-containment', 'check-containment' (its runs
// read c.platform, c.cacheDir and c.supervisor) and 'controller-replacement', which replaces this VM's supervisor, so it is last on it.
// CQ-R13h adds 'cancellation' and 'recovery' (certify-lifecycle.mjs) last before 'teardown', with LIFECYCLE_BOUNDS in BOUNDS.
// CQ-R13g adds 'canary-check' (certify-canary.mjs) after them; it needs host network for the toolchain and one registry tarball.
// CQ-M07e: a native, certified run also files a byte-identical copy of its report in <os.userInfo().homedir>/.moe/certification (dir 0700,
// file 0600, exclusive, never overwritten; no env override). .moe and the store must be real directories owned by this account and the
// store owner-only, else it is refused, never chmodded. A store failure only writes one fixed JSON code line to stderr: the workDir
// report, the result and the exit never change. An injected run never files. The daemon reader (CQ-M07a) owns the project and .moe/ containment refusals.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_BOUNDS, BRIDGE_CHECKS } from './certify-bridge.mjs';
import { CANARY_CHECKS } from './certify-canary.mjs';
import { CONTAINMENT_CHECKS } from './certify-containment.mjs';
import { LIFECYCLE_BOUNDS, LIFECYCLE_CHECKS } from './certify-lifecycle.mjs';
import { platformFor } from './cli.mjs';
import { runDoctor } from './doctor.mjs';
import { IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { createLedger, deleteOwned } from './lifecycle.mjs';
import { provisionGuest } from './provision.mjs';
import { assertNoMounts } from './snapshot-transfer.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const [PLATFORM_IDS, RESULTS] = [['win32', 'linux', 'darwin'], ['passed', 'failed', 'not-run']];
const BOUNDS = Object.freeze({ ...BRIDGE_BOUNDS, ...LIFECYCLE_BOUNDS });
const MESSAGES = {
  CERTIFY_INPUT_INVALID: 'Certification options must be exactly { workDir: <absolute path> }.',
  CERTIFY_UNSUPPORTED_HOST: 'This host has no platform module; isolation cannot be certified here.',
  CERTIFY_REPORT_INVALID: 'The certification report does not match the current schema and checks.',
  CERTIFY_REPORT_WRITE_FAILED: 'The certification report could not be created exclusively.',
  CERTIFY_STORE_UNSAFE: 'The host certification store is unusable: missing home, a symlink, not a directory, not owned by this account or not owner-only.',
  CERTIFY_STORE_WRITE_FAILED: 'The certified report could not be filed exclusively in the host certification store.',
};
const certifyError = code => Object.assign(new Error(MESSAGES[code]), { code });
const isRecord = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validWorkDir = dir => typeof dir === 'string' && path.isAbsolute(dir) && !CONTROL.test(dir);
const isIso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const sha = value => (typeof value === 'string' && SHA256.test(value) ? value : null);
const passed = Object.freeze({ result: 'passed', code: null });
const failed = code => ({ result: 'failed', code });
const stable = (code, fallback = 'CERTIFY_CHECK_FAILED') => (typeof code === 'string' && CODE.test(code) ? code : fallback);
const deepFreeze = value => { if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze); return Object.freeze(value); };

// Each check resolves {result: 'passed' | 'failed', code}; the runner turns a throw into 'failed' with its stable code.
const BODY = [
  ['provision', async c => {
    let supervisor;
    try { supervisor = await readFile(new URL('./guest-supervisor.py', import.meta.url)); } catch { return failed('CERTIFY_SUPERVISOR_UNAVAILABLE'); }
    [c.supervisor, c.supervisorSha256] = [supervisor, createHash('sha256').update(supervisor).digest('hex')];
    c.outcome = await provisionGuest({ platform: c.platform, ledger: c.capturing, owner: c.owner, cacheDir: c.cacheDir, supervisor,
      credential: randomBytes(32), provider: c.provider, fetch: c.deps.fetch, digest: c.deps.digest, sleep: c.deps.sleep });
    if (c.outcome?.provisioned !== true) return failed('CERTIFY_PROVISION_UNAVAILABLE');
    return c.outcome.instance === c.name ? passed : failed('CERTIFY_PROVISION_FAILED');
  }],
  // R07 readiness: a clean real boot reaches cloud-init done/done; a degraded boot is its own fixed failure code.
  ['readiness', async ({ outcome: { bootstrapReady, failures } }) => (bootstrapReady === true && Array.isArray(failures) && failures.length === 0 ? passed
    : failed(stable(failures?.[0], 'CERTIFY_NOT_READY')))],
  ['no-mounts', async ({ name, provider }) => { await assertNoMounts(name, provider); return passed; }],
  ...[...BRIDGE_CHECKS, ...CONTAINMENT_CHECKS, ...LIFECYCLE_CHECKS, ...CANARY_CHECKS].map(({ id, run }) => [id, run]),
];
// Always runs, whatever happened before; by exact owned name, so a foreign record in the same ledger is never touched.
const TEARDOWN = ['teardown', async ({ ledger, name, owner, provider }) => {
  if (name === null) return passed;
  const gone = await deleteOwned({ ledger, name, owner, provider }).catch(() => null);
  return gone === 'deleted' || gone === 'not-launched' ? passed : failed('CERTIFY_TEARDOWN_FAILED');
}];

/** The ordered registry. Later rows (CQ-R13e/f/h/g) append to BODY only, so 'teardown' always stays last. */
export const CERTIFY_CHECKS = Object.freeze([...BODY, TEARDOWN].map(([id, run]) => Object.freeze({ id, run })));

// No check can reject the run: a throw is 'failed' with the error's stable code.
async function runCheck({ id, run }, context) {
  let outcome;
  try { outcome = await run(context); } catch (error) { outcome = { code: error?.code }; }
  return outcome?.result === 'passed' ? { id, result: 'passed', code: null } : { id, result: 'failed', code: stable(outcome?.code) };
}

// The injected clock, or the real one when it gives no ISO time.
const isoNow = now => { try { const iso = (now ?? (() => new Date()))().toISOString(); if (isIso(iso)) return iso; } catch { /* real clock */ } return new Date().toISOString(); };

async function providerVersion(doctor = runDoctor, executable) {
  const report = await Promise.resolve().then(() => doctor({ executable })).catch(() => null);
  return report?.providerReady === true && typeof report.version === 'string' && VERSION.test(report.version) ? report.version : null;
}

// The one serialization: the workDir report and the store copy are the same bytes by construction.
const reportBytes = report => `${JSON.stringify(report)}\n`;

// Creates `file` exclusively and owner-only. An existing name (or link) fails at open, before anything is created or removed;
// a failure after the create removes only the file this call created.
async function createNew(file, text) {
  const handle = await open(file, 'wx', 0o600);
  try {
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  } catch (error) { await unlink(file).catch(() => {}); throw error; }
}

// <workDir>/certification-<platform>-<arch>-<YYYYMMDDTHHMMSSZ>-<6 hex>.json, Windows-safe, exclusive and owner-only: never overwrites.
// Resolves the file's base name.
async function writeReport(workDir, report, random = randomBytes) {
  try {
    const suffix = random(3);
    if (!Buffer.isBuffer(suffix) || suffix.length !== 3) throw certifyError('CERTIFY_REPORT_WRITE_FAILED');
    const stamp = `${report.startedAt.slice(0, 19).replace(/[-:]/g, '')}Z`;
    const name = `certification-${report.platform}-${report.arch ?? 'unknown'}-${stamp}-${suffix.toString('hex')}.json`;
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await createNew(path.join(workDir, name), reportBytes(report));
    return name;
  } catch { throw certifyError('CERTIFY_REPORT_WRITE_FAILED'); }
}

const STORE_NAME = /^certification-(win32|linux|darwin)-(x64|arm64)-\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/;
const STORE_CODES = ['CERTIFY_STORE_UNSAFE', 'CERTIFY_STORE_WRITE_FAILED', 'CERTIFY_REPORT_INVALID'];

// A real directory (never a link or junction) owned by this account, and for the store also owner-only on POSIX. Created 0700 when
// missing (its parent must exist), never chmodded: a pre-existing unsafe one is refused. mkdir fails EEXIST on a link, so nothing is created through it.
async function realDir(dir, ownerOnly) {
  try {
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error?.code !== 'EEXIST') throw error; });
    const info = await lstat(dir);
    const posix = typeof process.getuid === 'function';
    if (info.isDirectory() && !info.isSymbolicLink() && (!posix || (info.uid === process.getuid() && (!ownerOnly || (info.mode & 0o077) === 0)))) return;
  } catch { /* unsafe below */ }
  throw certifyError('CERTIFY_STORE_UNSAFE');
}

/** CQ-M07e: files a native, certified report in the host store. Never rejects; resolves a frozen { store: 'filed' | 'skipped' | 'failed', code }.
 * Any other report is 'skipped' and touches nothing. A failure writes one `{"code":...}` line through `warn` and changes nothing else. A
 * same-user race between the checks and the open is outside the threat model (decision 4, CQ-RF05). */
export async function fileCertifiedReport(input) {
  const { report, name, home, warn = line => process.stderr.write(line) } = isRecord(input) ? input : {};
  try {
    if (report?.transport !== 'native' || report.certified !== true) return Object.freeze({ store: 'skipped', code: null });
    const copy = validateCertificationReport(report);
    const [, platform, arch] = STORE_NAME.exec(typeof name === 'string' ? name : '') ?? [];
    if (platform !== copy.platform || arch !== copy.arch) throw certifyError('CERTIFY_STORE_WRITE_FAILED');
    if (!validWorkDir(home)) throw certifyError('CERTIFY_STORE_UNSAFE');
    const store = path.join(home, '.moe', 'certification');
    await realDir(path.dirname(store), false);
    await realDir(store, true);
    await createNew(path.join(store, name), reportBytes(copy)); // any failure here is an fs error: CERTIFY_STORE_WRITE_FAILED below
    return Object.freeze({ store: 'filed', code: null });
  } catch (error) {
    const code = STORE_CODES.find(known => { try { return error?.code === known; } catch { return false; } }) ?? 'CERTIFY_STORE_WRITE_FAILED';
    try { Promise.resolve(warn(`${JSON.stringify({ code })}\n`)).catch(() => {}); } catch { /* the warning is best effort */ }
    return Object.freeze({ store: 'failed', code });
  }
}

// The OS account's home, never HOME, USERPROFILE or os.homedir(); null when it has none.
const hostHome = () => { try { return os.userInfo().homedir; } catch { return null; } };

async function certify(platform, workDir, deps, native, bounds) {
  const startedAt = isoNow(deps.now);
  const ledgerDir = path.join(workDir, 'ledger');
  const ledger = createLedger(ledgerDir, { random: deps.random });
  const owner = { taskId: 'task-certify', attemptId: `attempt-${randomBytes(16).toString('hex')}`, generation: 1 }; // synthetic, per run
  const provider = { ...deps.provider, executable: deps.provider?.executable ?? platform.executable };
  const c = { workDir, deps, ledgerDir, ledger, owner, provider, bounds, cacheDir: path.join(workDir, 'images'), name: null, outcome: null, arch: platform.arch ?? null,
    supervisor: null, supervisorSha256: null };
  // Records the arch this run's prerequisites detected (macOS reads its hardware); the check-containment runs use it too.
  c.platform = { ...platform, prerequisites: async options => { const pre = await platform.prerequisites(options); c.arch = pre?.arch ?? c.arch; return pre; } };
  // Provisioning gets this wrapper: it captures this run's own reservation to delete, even after a throw.
  c.capturing = { ...ledger, reserve: async who => { const record = await ledger.reserve(who); c.name = record?.instance ?? null; return record; } };
  const version = await providerVersion(deps.doctor, provider.executable);
  const checks = [];
  for (const check of CERTIFY_CHECKS.slice(0, -1)) {
    checks.push(checks.some(row => row.result !== 'passed') ? { id: check.id, result: 'not-run', code: null } : await runCheck(check, c));
  }
  checks.push(await runCheck(CERTIFY_CHECKS.at(-1), c));
  const image = c.outcome?.image;
  const report = deepFreeze({
    kind: 'isolation-certification', version: 1, platform: platform.id, arch: IMAGE_ARCHES.includes(c.arch) ? c.arch : null,
    transport: native ? 'native' : 'injected', provider: { name: 'multipass', version },
    image: { sourceSha256: sha(image?.source?.sha256), providerImageHash: sha(image?.provider?.imageHash) }, supervisorSha256: c.supervisorSha256,
    startedAt, finishedAt: isoNow(deps.now), checks, certified: native && checks.every(row => row.result === 'passed'), executionReady: false,
  });
  const name = await writeReport(workDir, report, deps.random);
  if (native && report.certified === true) await fileCertifiedReport({ report, name, home: hostHome() });
  return report;
}

// deps.bounds: absent, or a plain record of own data properties named in BOUNDS, each a safe integer from 1 to its
// constant, read once into a frozen copy. Anything else, a getter or a throwing proxy trap included, refuses.
function boundsOf(bounds) {
  if (bounds === undefined) return BOUNDS;
  try {
    const entries = isRecord(bounds) ? Reflect.ownKeys(bounds).map(key => [key, Object.hasOwn(BOUNDS, key) ? Object.getOwnPropertyDescriptor(bounds, key).value : NaN]) : null;
    if (entries?.every(([key, value]) => Number.isSafeInteger(value) && value >= 1 && value <= BOUNDS[key])) return Object.freeze({ ...BOUNDS, ...Object.fromEntries(entries) });
  } catch { /* refused below */ }
  throw certifyError('CERTIFY_INPUT_INVALID');
}

/** Injected transports (tests): {provider, fetch, digest, sleep, random, doctor, now, bounds, containment, checkSteps, spawn, writer,
 * replacement, canary}. Its evidence can never certify. */
export async function certifyCore(input) {
  const { platform, workDir, deps = {} } = isRecord(input) ? input : {};
  if (!validWorkDir(workDir) || !isRecord(platform) || !PLATFORM_IDS.includes(platform.id) || typeof platform.prerequisites !== 'function'
    || !isRecord(deps)) throw certifyError('CERTIFY_INPUT_INVALID');
  return certify(platform, workDir, deps, false, boundsOf(deps.bounds));
}

/** The operator's native run on this host's own platform module; options are exactly { workDir }. */
export async function runIsolationCertify(options) {
  const keys = options !== null && typeof options === 'object' && !Array.isArray(options) ? Reflect.ownKeys(options) : [];
  const workDir = keys.length === 1 && keys[0] === 'workDir' ? options.workDir : undefined;
  if (!validWorkDir(workDir)) throw certifyError('CERTIFY_INPUT_INVALID');
  const platform = platformFor(process.platform);
  if (!platform) throw certifyError('CERTIFY_UNSUPPORTED_HOST');
  return certify(platform, workDir, {}, true, BOUNDS);
}

// A plain-record copy with exactly `keys`, each read once; anything else refuses.
function exact(value, keys) {
  if (!isRecord(value)) throw certifyError('CERTIFY_REPORT_INVALID');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every(key => own.includes(key))) throw certifyError('CERTIFY_REPORT_INVALID');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

// The current ids in order; 'not-run' exactly for the body checks after the first failure (teardown always runs); a code only on 'failed'.
function validChecks(value) {
  if (!Array.isArray(value) || value.length !== CERTIFY_CHECKS.length) return null;
  const checks = CERTIFY_CHECKS.map((_, at) => exact(value[at], ['id', 'result', 'code']));
  return checks.every(({ id, result, code }, at) => id === CERTIFY_CHECKS[at].id && RESULTS.includes(result)
    && (result === 'not-run') === (at < checks.length - 1 && checks.slice(0, at).some(row => row.result === 'failed'))
    && (result === 'failed' ? typeof code === 'string' && CODE.test(code) : code === null)) ? checks : null;
}

/** CQ-R13 checks each attached operator report: a deep-frozen copy of exactly this schema and the current check ids in order. */
export function validateCertificationReport(value) {
  try {
    const report = exact(value, ['kind', 'version', 'platform', 'arch', 'transport', 'provider', 'image', 'supervisorSha256', 'startedAt', 'finishedAt',
      'checks', 'certified', 'executionReady']);
    const provider = exact(report.provider, ['name', 'version']);
    const image = exact(report.image, ['sourceSha256', 'providerImageHash']);
    const checks = validChecks(report.checks);
    const hashes = [image.sourceSha256, image.providerImageHash, report.supervisorSha256];
    if (checks !== null && report.kind === 'isolation-certification' && report.version === 1 && PLATFORM_IDS.includes(report.platform)
      && (report.arch === null ? report.certified === false : IMAGE_ARCHES.includes(report.arch)) && ['native', 'injected'].includes(report.transport)
      && provider.name === 'multipass' && (provider.version === null || (typeof provider.version === 'string' && VERSION.test(provider.version)))
      && hashes.every(hash => (hash === null ? report.certified === false : sha(hash) !== null)) && isIso(report.startedAt) && isIso(report.finishedAt)
      && report.certified === (report.transport === 'native' && checks.every(row => row.result === 'passed')) && report.executionReady === false) {
      return deepFreeze({ ...report, provider, image, checks });
    }
  } catch { /* refused below */ }
  throw certifyError('CERTIFY_REPORT_INVALID');
}

// CQ-M07a: the certification-evidence reader. The drift rows load the runner sources themselves (repairPolicy.test.ts idiom), so a moved
// pin, a new or reordered check id, or a loosened or tightened validateCertificationReport clause fails here (each VARIANTS row tests one clause).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CERTIFICATION_PINS, CERTIFICATION_REFUSALS, CERTIFY_CHECK_IDS, MAX_REPORT_BYTES, certificationStoreDir, checkCertificationReport, hostIdentity,
  readCertificationStore, readHostCertificationEvidence } from './certificationEvidence.js';

interface CertifyModule { CERTIFY_CHECKS: ReadonlyArray<{ id: string }>; validateCertificationReport(value: unknown): unknown }
interface Manifest { versions: string[]; images: Record<string, { sha256: string }>; hosts: Array<Record<'platform' | 'arch' | 'versionSuffix', string>> }
const runner = (name: string) => new URL(`../../../../scripts/local-runner/${name}`, import.meta.url);
const certify = (): Promise<CertifyModule> => import(runner('certify.mjs').href);
type Row = { id: string; result: string; code: string | null }; type Report = Record<string, unknown>;

const host = hostIdentity() ?? CERTIFICATION_PINS.hosts[1];
const last = CERTIFY_CHECK_IDS.length - 1;
const passing = (): Row[] => CERTIFY_CHECK_IDS.map(id => ({ id, result: 'passed', code: null }));
/** Check `at` failed with code CERTIFY_X, the body rows after it not-run, teardown passed. */
const failedAt = (at: number): Row[] => passing().map((row, i) => (i === at ? { ...row, result: 'failed', code: 'CERTIFY_X' }
  : i > at && i < last ? { ...row, result: 'not-run' } : row));
const edit = (rows: Row[], at: number, patch: Report) => rows.map((row, i) => (i === at ? { ...row, ...patch } : row));
const without = (value: Report, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const deepFrozen = (value: unknown): boolean => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

/** A native, certified report for this host with the shipped pins, as certify's writeReport files it. */
function valid(over: Report = {}): Report {
  return { kind: 'isolation-certification', version: 1, platform: host.platform, arch: host.arch, transport: 'native',
    provider: { name: 'multipass', version: CERTIFICATION_PINS.versions[0] + host.versionSuffix },
    image: { sourceSha256: CERTIFICATION_PINS.images[host.arch], providerImageHash: 'b'.repeat(64) },
    supervisorSha256: CERTIFICATION_PINS.supervisorSha256, startedAt: '2026-11-01T09:00:00.000Z', finishedAt: '2026-11-01T09:20:00.000Z',
    checks: passing(), certified: true, executionReady: false, ...over };
}
const injected = valid({ transport: 'injected', certified: false });
const failedNative = valid({ certified: false, checks: failedAt(3) });
const failCode = (code: unknown) => valid({ certified: false, checks: edit(failedAt(3), 3, { code }) });
const provider = (version: unknown, name = 'multipass', extra: Report = {}) => valid({ provider: { name, version, ...extra } });
const swapped = valid({ checks: edit(edit(passing(), 0, { id: CERTIFY_CHECK_IDS[1] }), 1, { id: CERTIFY_CHECK_IDS[0] }) });

const VARIANTS: Array<[string, Report, boolean]> = [
  ['the valid native certified report', valid(), true], ['injected with a null hash', { ...injected, supervisorSha256: null }, true], ['injected, certified false', injected, true],
  ['native, failed then not-run', failedNative, true], ['a 64-char version of every class', provider('1.17.0-Rc+win'.padEnd(64, '0')), true],
  ['injected with arch null', { ...injected, arch: null }, true], ['provider.version null', provider(null), true], ['a 64-char failure code', failCode(`C${'9'.repeat(63)}`), true],
  ['a null-prototype report', Object.assign(Object.create(null), valid()), true], ['injected with arch ia32', { ...injected, arch: 'ia32' }, false],
  ['certified with a null hash', valid({ image: { sourceSha256: null, providerImageHash: 'b'.repeat(64) } }), false], ['certified with arch null', valid({ arch: null }), false],
  ['a 63-char hash', valid({ supervisorSha256: 'e'.repeat(63) }), false], ['a 65-char hash', valid({ supervisorSha256: 'e'.repeat(65) }), false],
  ['an uppercase hash', valid({ supervisorSha256: 'E'.repeat(64) }), false], ['certified as 1', valid({ certified: 1 }), false],
  ['a non-string hash', valid({ image: { ...(valid().image as Report), providerImageHash: ['b'.repeat(64)] } }), false], ['a numeric provider version', provider(1170), false],
  ['a 65-char provider version', provider('1'.repeat(65)), false], ['an empty provider version', provider(''), false], ['another provider name', provider(null, 'lxd'), false],
  ['a provider version with a space', provider('1.17 .0'), false], ['a 65-char failure code', failCode(`C${'X'.repeat(64)}`), false], ['two check ids swapped', swapped, false],
  ['a non-string failure code', failCode(['CERTIFY_X']), false], ['a failed row without a code', failCode(null), false], ['a lowercase later letter', failCode('CERTIFY_x'), false],
  ['code on a passed row', valid({ checks: edit(passing(), 0, { code: 'CERTIFY_X' }) }), false], ['a failure code with a leading digit', failCode('9CERTIFY'), false],
  ['an unknown check result', { ...injected, checks: edit(passing(), 2, { result: 'skipped' }) }, false], ['one check row short', valid({ checks: passing().slice(0, -1) }), false],
  ['not-run with no earlier failure', valid({ certified: false, checks: edit(passing(), 2, { result: 'not-run' }) }), false],
  ['not-run on teardown', valid({ certified: false, checks: edit(failedAt(3), last, { result: 'not-run' }) }), false], ['a lowercase first letter', failCode('cERTIFY_X'), false],
  ['one check row extra', valid({ checks: [...passing(), passing()[last]] }), false], ['array-like checks', valid({ checks: { ...passing(), length: last + 1 } }), false],
  ['a missing check-row key', valid({ checks: [without(passing()[0], 'code'), ...passing().slice(1)] }), false], ['an extra symbol key', { ...valid(), [Symbol('x')]: 1 }, false],
  ['a missing provider key', valid({ provider: { name: 'multipass' } }), false], ['an extra image key', valid({ image: { ...(valid().image as Report), url: null } }), false],
  ['an extra check-row key', valid({ checks: edit(passing(), 0, { at: 0 }) }), false], ['a missing image key', valid({ image: { sourceSha256: 'b'.repeat(64) } }), false],
  ['an extra top-level key', valid({ signature: null }), false], ['an extra provider key', provider(null, 'multipass', { driver: 'qemu' }), false],
  ['a missing top-level key', without(valid(), 'executionReady'), false], ['a non-ISO startedAt', valid({ startedAt: '2026-11-01' }), false],
  ['an unknown transport', { ...injected, transport: 'remote' }, false], ['executionReady null', valid({ executionReady: null }), false],
  ['an unknown platform', valid({ platform: 'freebsd' }), false], ['another kind', valid({ kind: 'isolation-smoke' }), false], ['version 2', valid({ version: 2 }), false],
  ['injected but certified', { ...injected, certified: true }, false], ['certified despite a failure', valid({ checks: failedAt(3) }), false],
  ['executionReady true', valid({ executionReady: true }), false], ['a finishedAt without millis', valid({ finishedAt: '2026-11-01T09:20:00Z' }), false],
];
for (const { platform, arch, versionSuffix: v } of CERTIFICATION_PINS.hosts) VARIANTS.push([`a ${platform}/${arch} report`, { ...provider(`1.17.0${v}`), platform, arch }, true]);

describe('drift', () => {
  it('CERTIFY_CHECK_IDS are certify.mjs CERTIFY_CHECKS ids in order; the pins equal certified-provider.json and guest-supervisor.py', async () => {
    expect([...CERTIFY_CHECK_IDS]).toEqual((await certify()).CERTIFY_CHECKS.map(check => check.id));
    const manifest = JSON.parse(readFileSync(runner('certified-provider.json'), 'utf8')) as Manifest;
    expect(manifest).toMatchObject({ schemaVersion: 1, provider: 'multipass' });
    expect(CERTIFICATION_PINS).toStrictEqual({
      versions: manifest.versions,
      hosts: manifest.hosts.map(({ platform, arch, versionSuffix }) => ({ platform, arch, versionSuffix })),
      images: Object.fromEntries(Object.entries(manifest.images).map(([arch, image]) => [arch, image.sha256])),
      supervisorSha256: createHash('sha256').update(readFileSync(runner('guest-supervisor.py'))).digest('hex'),
    });
    expect(deepFrozen(CERTIFICATION_PINS) && Object.isFrozen(CERTIFY_CHECK_IDS)).toBe(true);
  });
  it.each(VARIANTS)('%s: the port and validateCertificationReport agree', async (_name, value, accepted) => {
    const { validateCertificationReport } = await certify();
    let original = true;
    try { validateCertificationReport(value); } catch { original = false; }
    expect([checkCertificationReport(value).ok, original]).toEqual([accepted, accepted]);
  });
  it('accepts a deep-frozen copy and names CHECKS or SCHEMA on refusal, whatever the input', () => {
    expect(new Set(VARIANTS.map(([, , ok]) => ok))).toEqual(new Set([true, false]));
    const input = valid();
    const result = checkCertificationReport(input);
    expect(result).toStrictEqual({ ok: true, report: input });
    expect(deepFrozen(result) && !Object.isFrozen(input)).toBe(true);
    expect(checkCertificationReport(swapped)).toStrictEqual({ ok: false, code: 'CERTIFICATION_REPORT_CHECKS' });
    for (const hostile of [valid({ signature: null }), null, [], 'x', Object.assign(Object.create({}), valid()), new Proxy({}, { ownKeys() { throw new Error('trap'); } })]) {
      expect(checkCertificationReport(hostile)).toStrictEqual({ ok: false, code: 'CERTIFICATION_REPORT_SCHEMA' });
    }
  });
});

it('hostIdentity maps only the pinned platform/arch pairs', () => {
  for (const [platform, arch, versionSuffix] of [['win32', 'x64', '+win'], ['linux', 'x64', ''], ['darwin', 'x64', '+mac'], ['darwin', 'arm64', '+mac']]) {
    expect(hostIdentity(platform, arch)).toStrictEqual({ platform, arch, versionSuffix });
  }
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'arm64'], ['linux', 'ia32'], ['freebsd', 'x64']]) expect(hostIdentity(platform, arch)).toBeNull();
});

const refused = (...codes: string[]) => ({ ok: false, refusals: codes.map(code => `CERTIFICATION_${code}`) });
const other = (value: string, a: string, b: string) => (value === a ? b : a);
const canonical = (report: Report) => `${JSON.stringify(report)}\n`;
const MISMATCHES: Array<[string, Report | string | Buffer]> = [
  ['INJECTED', injected], ['UNCERTIFIED', failedNative], ['PLATFORM', valid({ platform: other(host.platform, 'linux', 'win32') })],
  ['ARCH', valid({ arch: other(host.arch, 'x64', 'arm64') })], ['SUPERVISOR', valid({ supervisorSha256: 'e'.repeat(64) })],
  ['IMAGE', valid({ image: { sourceSha256: 'd'.repeat(64), providerImageHash: 'b'.repeat(64) } })],
  ['PROVIDER_VERSION', provider(`1.16.0${host.versionSuffix}`)], ['PROVIDER_VERSION', provider(`1.17.0${other(host.versionSuffix, '+win', '+mac')}`)],
  ['SCHEMA', valid({ signature: null })], ['SCHEMA', without(valid(), 'executionReady')], ['CHECKS', swapped],
  ['MALFORMED', canonical(valid()).slice(0, 40)], ['MALFORMED', `${JSON.stringify(valid(), null, 2)}\n`],
  ['MALFORMED', `${JSON.stringify(valid()).slice(0, -1)},"certified":true}\n`],
  ['MALFORMED', String.fromCharCode(0xfeff) + canonical(valid())], ['OVERSIZE', Buffer.alloc(MAX_REPORT_BYTES + 1, 0x20)],
];

describe.skipIf(!hostIdentity())('readCertificationStore', () => {
  let dirs: string[] = [];
  const tmp = () => { const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'moe-cert-'))); dirs.push(dir); return dir; };
  const fileName = (at: number) => `certification-${host.platform}-${host.arch}-20261101T0900${String(at).padStart(2, '0')}Z-a0000${at}.json`;
  /** A 0700 store holding `files` as the writer files them, under writer-style names in index order. */
  function store(files: Array<Report | string | Buffer>, dir = path.join(tmp(), 'certification')): string {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    files.forEach((file, at) => writeFileSync(path.join(dir, fileName(at)), typeof file === 'string' || Buffer.isBuffer(file) ? file : canonical(file)));
    return dir;
  }
  const read = (storeDir: string, projectRoot = tmp()) => readCertificationStore({ storeDir, projectRoot });
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })); dirs = []; });

  it('returns a valid report, deep-frozen, with the sha256 of its exact bytes; the newest finishedAt wins', async () => {
    const one = store([valid()]);
    const result = await read(one);
    expect(result).toStrictEqual({ ok: true, report: valid(), sha256: sha(path.join(one, fileName(0))) });
    expect(deepFrozen(result)).toBe(true);
    const newer = valid({ finishedAt: '2026-11-01T10:00:00.000Z' });
    expect(await read(store([newer, valid(), injected]))).toMatchObject({ ok: true, report: newer });
    const tie = store([valid({ startedAt: '2026-11-01T08:00:00.000Z' }), valid(), 'x']);
    expect(await read(tie)).toStrictEqual({ ok: true, report: valid(), sha256: sha(path.join(tie, fileName(1))) });
  });
  it('names an empty, foreign-only or absent store, and each refusal once in name order', async () => {
    const foreign = store([]);
    writeFileSync(path.join(foreign, 'certification-linux-x64-latest.json'), canonical(valid()));
    for (const dir of [store([]), foreign]) expect(await read(dir)).toStrictEqual(refused('REPORT_NONE'));
    expect(await read(path.join(tmp(), 'certification'))).toStrictEqual(refused('STORE_MISSING'));
    expect(await read(store([injected, 'x', injected]))).toStrictEqual(refused('REPORT_INJECTED', 'REPORT_MALFORMED'));
    expect(new Set(CERTIFICATION_REFUSALS).size === 21 && Object.isFrozen(CERTIFICATION_REFUSALS)).toBe(true);
  });
  it.each(MISMATCHES)('%s: one mismatching file is refused with its own code (#%#)', async (code, file) => {
    expect(await read(store([file]))).toStrictEqual(refused(`REPORT_${code}`));
  });
  it('refuses a symlinked store, a symlinked or directory report and a loose store', async ctx => {
    const link = path.join(tmp(), 'certification');
    symlinkSync(store([valid()]), link, 'junction');
    expect(await read(link)).toStrictEqual(refused('STORE_UNSAFE'));
    const nested = store([]);
    mkdirSync(path.join(nested, fileName(0)));
    expect(await read(nested)).toStrictEqual(refused('REPORT_UNSAFE'));
    if (process.platform !== 'win32') {
      const loose = store([valid()]);
      chmodSync(loose, 0o755);
      expect(await read(loose)).toStrictEqual(refused('STORE_UNSAFE'));
    }
    const [target, linked] = [path.join(store([valid()]), fileName(0)), store([])]; // a valid report in another store
    try { symlinkSync(target, path.join(linked, fileName(0)), 'file'); } catch (error) {
      if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') return ctx.skip();
      throw error;
    }
    expect(await read(linked)).toStrictEqual(refused('REPORT_UNSAFE'));
  });
  it('refuses a store inside the project or its (symlinked) .moe, bad input and an unsupported host, never throwing', async () => {
    const [project, outside, looped, dir] = [tmp(), tmp(), tmp(), store([valid()])];
    expect(await read(store([valid()], path.join(project, 'certification')), project)).toStrictEqual(refused('STORE_IN_PROJECT'));
    expect(await read(dir, dir)).toStrictEqual(refused('STORE_IN_PROJECT'));
    symlinkSync(project, path.join(outside, 'via'), 'junction'); // a symlinked ancestor is resolved before the containment test
    expect(await read(path.join(outside, 'via', 'certification'), project)).toStrictEqual(refused('STORE_IN_PROJECT'));
    symlinkSync(outside, path.join(project, '.moe'), 'junction');
    expect(await read(store([valid()], path.join(outside, 'certification')), project)).toStrictEqual(refused('STORE_IN_PROJECT'));
    if (process.platform !== 'win32') { // an unresolvable .moe (ELOOP) fails closed
      symlinkSync(path.join(looped, '.moe'), path.join(looped, '.moe'));
      expect(await read(dir, looped)).toStrictEqual(refused('STORE_UNREADABLE'));
    }
    for (const input of [null, {}, { storeDir: 'certification', projectRoot: tmp() }, { storeDir: dir, projectRoot: '.' },
      { storeDir: `${dir}\n`, projectRoot: tmp() }, { storeDir: dir, projectRoot: path.join(tmp(), 'gone') }]) {
      expect(await readCertificationStore(input as never)).toStrictEqual(refused('INPUT_INVALID'));
    }
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    const onOs = async (value: string, storeDir: string) => {
      Object.defineProperty(process, 'platform', { ...platform, value });
      try { return await read(storeDir); } finally { Object.defineProperty(process, 'platform', platform); }
    };
    expect(await onOs('sunos', dir)).toStrictEqual(refused('HOST_UNSUPPORTED'));
    // A non-empty versionSuffix on every arch: the provider version must carry it.
    const mac = (version: string) => store([valid({ platform: 'darwin', provider: { name: 'multipass', version } })]);
    expect([(await onOs('darwin', mac('1.17.0+mac'))).ok, await onOs('darwin', mac('1.17.0'))]).toStrictEqual([true, refused('REPORT_PROVIDER_VERSION')]);
  });
  it('HOME and USERPROFILE never move the store: it comes from the OS account record', async () => {
    const home = tmp();
    const planted = sha(path.join(store([valid()], path.join(home, '.moe', 'certification')), fileName(0)));
    for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, home);
    expect(os.homedir()).toBe(home);
    const dir = certificationStoreDir() as string;
    expect(dir).toBe(path.join(os.userInfo().homedir, '.moe', 'certification'));
    expect(path.relative(home, dir).startsWith('..')).toBe(true);
    const result = await readHostCertificationEvidence(tmp());
    expect([planted, 'CERTIFICATION_STORE_UNAVAILABLE']).not.toContain(result.ok ? result.sha256 : result.refusals[0]);
    vi.spyOn(os, 'userInfo').mockImplementation(() => { throw new Error('no account record'); });
    expect([certificationStoreDir(), await readHostCertificationEvidence(tmp())]).toStrictEqual([null, refused('STORE_UNAVAILABLE')]);
  });
});

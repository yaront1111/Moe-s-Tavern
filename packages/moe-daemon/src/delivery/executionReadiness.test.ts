// CQ-M07b: the verified-local readiness evaluator. Every runProbe here is a fake: no test spawns a real Multipass client.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunnerKey } from '../server/runnerChannel.js';
import type { MoeError } from '../util/errors.js';
import {
  CERTIFICATION_PINS, CERTIFICATION_REFUSALS, CERTIFY_CHECK_IDS, hostIdentity, readCertificationStore, readHostCertificationEvidence,
  type CertificationEvidence, type CertificationHost,
} from './certificationEvidence.js';
import {
  AGENT_VM_ROWS, CERTIFICATION_REFUSAL_IDS, CHECK_VM_ROWS, PROBE_MAX_BYTES, PROBE_TIMEOUT_MS, READINESS_CAPABILITIES, READINESS_EVIDENCE_IDS,
  READINESS_IDS, evaluateExecutionReadiness, pinnedMultipassClient, type ProbeRunner, type ReadinessInputs,
} from './executionReadiness.js';
import { assertExecutionProfileReady } from './executionProfile.js';

type Fields = Record<string, unknown>;
type Over = Partial<Record<keyof ReadinessInputs, unknown>>;
const ISO = '2026-11-01T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const ISOLATION = ['isolated-agent-and-qa-vms', 'isolated-check-vm'];
const EVIDENCE = { reportSha256: SHA, platform: 'linux', arch: 'x64', providerVersion: '1.17.0' };
const LINUX = CERTIFICATION_PINS.hosts[1];
const runner = (name: string) => new URL(`../../../../scripts/local-runner/${name}`, import.meta.url).href;
const passing = () => CERTIFY_CHECK_IDS.map(id => ({ id, result: 'passed', code: null }));
const withRow = (id: string, patch: Fields) => passing().map(row => (row.id === id ? { ...row, ...patch } : row));
/** A native, certified report with the shipped pins, schema-shaped as certify writes it. */
function report(over: Fields = {}, host: CertificationHost = LINUX): Fields {
  return { kind: 'isolation-certification', version: 1, platform: host.platform, arch: host.arch, transport: 'native',
    provider: { name: 'multipass', version: CERTIFICATION_PINS.versions[0] + host.versionSuffix },
    image: { sourceSha256: CERTIFICATION_PINS.images[host.arch], providerImageHash: 'b'.repeat(64) },
    supervisorSha256: CERTIFICATION_PINS.supervisorSha256, startedAt: '2026-11-01T09:00:00.000Z', finishedAt: '2026-11-01T09:20:00.000Z',
    checks: passing(), certified: true, executionReady: false, ...over };
}
const accepted = (over: Fields = {}) => async () => Object.freeze({ ok: true, sha256: SHA, report: report(over) }) as unknown as CertificationEvidence;
const refused = (...refusals: string[]) => async () => Object.freeze({ ok: false, refusals }) as unknown as CertificationEvidence;
const versions = (multipass: string, multipassd = multipass) => JSON.stringify({ multipass, multipassd });
const resolving = (stdout: unknown = versions('1.17.0')) => vi.fn<ProbeRunner>(async () => ({ stdout, stderr: '' }));
const rejecting = (error: unknown) => vi.fn<ProbeRunner>(async () => { throw error; });

let root = '';
let project = '';
let install = '';
let keyPath = '';
const dir = (...parts: string[]) => { const at = path.join(...parts); mkdirSync(at, { recursive: true }); return at; };
/** The REAL ensureRunnerKey, filing this project's key under `keys` as runnerChannel.ts does. */
async function keyFor(projectPath: string, keys: string): Promise<string> {
  vi.stubEnv('MOE_RUNNER_KEY_DIR', keys);
  try { return await ensureRunnerKey(projectPath); } finally { vi.unstubAllEnvs(); }
}
/** project/.moe becomes a symlink to `target`. */
function moeAt(target: string): void {
  rmSync(path.join(project, '.moe'), { recursive: true });
  symlinkSync(dir(target), path.join(project, '.moe'), 'junction');
}
function inputs(over: Over = {}): ReadinessInputs {
  return { projectRoot: project, daemonInstallDir: install, runnerKeyPath: keyPath, settings: { deliveryPolicy: 'local-branch' },
    readCertification: accepted(), runProbe: resolving(), now: () => new Date(ISO), ...over } as ReadinessInputs;
}
const evaluate = (over: Over = {}) => evaluateExecutionReadiness(inputs(over));
const missing = async (over: Over = {}) => (await evaluate(over)).missingCapabilities;

/** A path relative to the cwd, or null where none exists (another Windows drive), so the row is skipped, not vacuous. */
const relative = (target: string) => { const rel = path.relative(process.cwd(), target); return path.isAbsolute(rel) ? null : rel; };

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'moe-ready-')));
  project = path.dirname(dir(root, 'project', '.moe'));
  install = dir(root, 'install');
  keyPath = await keyFor(project, path.join(root, 'keys'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('evaluateExecutionReadiness', () => {
  it('is ready with every fact present and matching: a deep-frozen snapshot naming the accepted report', async () => {
    const runProbe = resolving();
    const snapshot = await evaluate({ runProbe });
    expect(snapshot).toStrictEqual({ ready: true, missingCapabilities: [], evaluatedAt: ISO, evidence: EVIDENCE });
    expect([snapshot, snapshot.missingCapabilities, snapshot.evidence].map(value => Object.isFrozen(value))).toEqual([true, true, true]);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  const ALONE: Array<[string, string, () => Over | null | Promise<Over>]> = [
    ['the install inside the project', 'protected-host-control-plane', () => ({ daemonInstallDir: dir(project, 'node_modules', 'moe-daemon') })],
    ['the project inside the install', 'protected-host-control-plane', async () => {
      const inner = dir(install, 'projects', 'p');
      return { projectRoot: inner, runnerKeyPath: await keyFor(inner, path.join(root, 'keys')) };
    }],
    ['a .moe symlinked into the install', 'protected-host-control-plane', () => { moeAt(path.join(install, 'state')); return {}; }],
    ['an install path that does not exist', 'protected-host-control-plane', () => ({ daemonInstallDir: path.join(root, 'gone') })],
    ['a relative install path', 'protected-host-control-plane', () => { const rel = relative(install); return rel === null ? null : { daemonInstallDir: rel }; }],
    ['an absent runner key', 'authenticated-runner-evidence', () => ({ runnerKeyPath: path.join(root, 'keys', 'absent.key') })],
    ['a symlink to a valid key', 'authenticated-runner-evidence', () => {
      symlinkSync(keyPath, path.join(root, 'link.key'), 'file');
      return { runnerKeyPath: path.join(root, 'link.key') };
    }],
    ['a malformed key', 'authenticated-runner-evidence', () => { writeFileSync(path.join(root, 'short.key'), 'short'); return { runnerKeyPath: path.join(root, 'short.key') }; }],
    ['a key with a trailing newline', 'authenticated-runner-evidence', () => {
      writeFileSync(path.join(root, 'nl.key'), `${readFileSync(keyPath, 'utf8')}\n`);
      return { runnerKeyPath: path.join(root, 'nl.key') };
    }],
    ['a directory at the key path', 'authenticated-runner-evidence', () => ({ runnerKeyPath: dir(root, 'dir.key') })],
    ['a relative key path', 'authenticated-runner-evidence', () => { const rel = relative(keyPath); return rel === null ? null : { runnerKeyPath: rel }; }],
    ['a valid key inside the project', 'authenticated-runner-evidence', async () => ({ runnerKeyPath: await keyFor(project, path.join(project, 'keys')) })],
    ['a valid key inside a .moe symlinked out of the project', 'authenticated-runner-evidence', async () => {
      moeAt(path.join(root, 'state'));
      return { runnerKeyPath: await keyFor(project, path.join(root, 'state', 'keys')) };
    }],
    ['deliveryPolicy legacy', 'revision-bound-local-delivery', () => ({ settings: { deliveryPolicy: 'legacy' } })],
    ['deliveryPolicy remote-push', 'revision-bound-local-delivery', () => ({ settings: { deliveryPolicy: 'remote-push' } })],
    ['no deliveryPolicy', 'revision-bound-local-delivery', () => ({ settings: {} })],
    ['deliveryPolicy null', 'revision-bound-local-delivery', () => ({ settings: { deliveryPolicy: null } })],
    ['an inherited deliveryPolicy', 'revision-bound-local-delivery', () => ({ settings: Object.create({ deliveryPolicy: 'local-branch' }) })],
    ['settings null', 'revision-bound-local-delivery', () => ({ settings: null })],
    ['a throwing deliveryPolicy getter', 'revision-bound-local-delivery', () => ({ settings: { get deliveryPolicy(): string { throw new Error('getter'); } } })],
  ];
  it.for(ALONE)('%s fails exactly that capability', async ([, id, setup], ctx) => {
    let over: Over | null;
    try { over = await setup(); } catch (error) {
      if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') return ctx.skip();
      throw error;
    }
    if (over === null) return ctx.skip();
    expect(await missing(over)).toEqual([id]);
  });

  it.each(CERTIFY_CHECK_IDS)('a failed %s row fails exactly the isolation capabilities that list it', async id => {
    const expected = [AGENT_VM_ROWS.includes(id) ? ISOLATION[0] : null, CHECK_VM_ROWS.includes(id) ? ISOLATION[1] : null].filter(Boolean);
    expect(expected.length).toBeGreaterThan(0);
    expect(await missing({ readCertification: accepted({ checks: withRow(id, { result: 'failed', code: 'CERTIFY_X' }) }) })).toEqual(expected);
  });
  it('a missing, not-run or duplicated-failed row fails only its capabilities; no rows fails both', async () => {
    const without = (id: string) => passing().filter(row => row.id !== id);
    expect(await missing({ readCertification: accepted({ checks: without('canary-check') }) })).toEqual([ISOLATION[1]]);
    expect(await missing({ readCertification: accepted({ checks: without('bridge-eof') }) })).toEqual([ISOLATION[0]]);
    expect(await missing({ readCertification: accepted({ checks: withRow('writer-containment', { result: 'not-run' }) }) })).toEqual([ISOLATION[0]]);
    expect(await missing({ readCertification: accepted({ checks: [...passing(), { id: 'cancellation', result: 'failed', code: 'X' }] }) }))
      .toEqual([ISOLATION[1]]);
    expect(await missing({ readCertification: accepted({ checks: withRow('provision', { result: 'failed', code: 'X' }) }) })).toEqual(ISOLATION);
    expect(await missing({ readCertification: accepted({ checks: 'all passed' }) })).toEqual(ISOLATION);
  });
  it('lists several failures in READINESS_IDS order, whatever order the checks finish in', async () => {
    expect(await missing({ daemonInstallDir: dir(project, 'node_modules', 'moe-daemon'), runnerKeyPath: path.join(root, 'absent.key'),
      settings: { deliveryPolicy: 'legacy' }, readCertification: refused('CERTIFICATION_REPORT_INJECTED', 'CERTIFICATION_STORE_MISSING') }))
      .toEqual([...READINESS_CAPABILITIES, 'certification-report-missing', 'certification-report-rejected']);
    // An unusable projectRoot fails both checks that need the project's real path, and nothing else.
    expect(await missing({ projectRoot: path.join(root, 'gone') })).toEqual(['protected-host-control-plane', 'authenticated-runner-evidence']);
    expect(await missing({ projectRoot: 'project' })).toEqual(['protected-host-control-plane', 'authenticated-runner-evidence']);
    rmSync(path.join(project, '.moe'), { recursive: true });
    expect(await missing()).toEqual([]);
    if (process.platform !== 'win32') { // only an absent .moe is skipped: an unresolvable one (ELOOP) fails closed
      symlinkSync(path.join(project, '.moe'), path.join(project, '.moe'));
      expect(await missing()).toEqual(['protected-host-control-plane', 'authenticated-runner-evidence']);
    }
  });
});

describe('the live Multipass probe', () => {
  it.each([['a different live version', versions('1.18.0')], ['a different client only', versions('1.18.0', '1.17.0')],
    ['a different multipassd only', versions('1.17.0', '1.18.0')]])('%s gives provider-version-mismatch with the report still named', async (_, stdout) => {
    const snapshot = await evaluate({ runProbe: resolving(stdout) });
    expect([snapshot.ready, snapshot.missingCapabilities, snapshot.evidence]).toEqual([false, [...ISOLATION, 'provider-version-mismatch'], EVIDENCE]);
  });
  it('a report without a provider version never matches a live client', async () => {
    const snapshot = await evaluate({ readCertification: accepted({ provider: { name: 'multipass', version: null } }) });
    expect([snapshot.missingCapabilities, snapshot.evidence]).toEqual([[...ISOLATION, 'provider-version-mismatch'], { ...EVIDENCE, providerVersion: null }]);
  });
  const big = (bytes: number) => { const base = JSON.stringify({ multipass: '1.17.0', multipassd: '1.17.0', pad: '' }); return `${base.slice(0, -2)}${'x'.repeat(bytes - base.length)}"}`; };
  const PROBES: Array<[string, ProbeRunner | unknown, string]> = [
    ['a SIGKILLed client', rejecting({ killed: true, signal: 'SIGKILL', code: null }), 'provider-probe-timeout'],
    ['an ETIMEDOUT rejection', rejecting({ code: 'ETIMEDOUT' }), 'provider-probe-timeout'],
    ['ENOENT', rejecting({ code: 'ENOENT' }), 'provider-probe-failed'], ['a nonzero exit', rejecting({ code: 1 }), 'provider-probe-failed'],
    ['maxBuffer', rejecting({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'provider-probe-failed'],
    ['a synchronous throw', vi.fn(() => { throw new Error('spawn'); }), 'provider-probe-failed'],
    ['a stdout getter that throws', vi.fn(async () => ({ get stdout(): string { throw new Error('stdout'); } })), 'provider-probe-failed'],
    ['no runner', undefined, 'provider-probe-failed'],
    ['stdout nope', resolving('nope'), 'provider-probe-malformed'], ['stdout []', resolving('[]'), 'provider-probe-malformed'],
    ['stdout null', resolving('null'), 'provider-probe-malformed'], ['no stdout', vi.fn(async () => null), 'provider-probe-malformed'],
    ['a numeric multipass', resolving('{"multipass":1,"multipassd":"1.17.0"}'), 'provider-probe-malformed'],
    ['no multipassd', resolving('{"multipass":"1.17.0"}'), 'provider-probe-malformed'],
    ['a valid version over PROBE_MAX_BYTES', resolving(big(PROBE_MAX_BYTES + 1)), 'provider-probe-malformed'],
    ['a Buffer', resolving(Buffer.from(versions('1.17.0'))), 'provider-probe-malformed'],
  ];
  it.each(PROBES)('%s gives exactly its fixed id, still naming the accepted report', async (_, runProbe, id) => {
    const snapshot = await evaluate({ runProbe });
    expect([snapshot.missingCapabilities, snapshot.evidence]).toEqual([[...ISOLATION, id], EVIDENCE]);
  });
  it('accepts extra keys and exactly PROBE_MAX_BYTES of output', async () => {
    expect(await missing({ runProbe: resolving('{"multipass":"1.17.0","multipassd":"1.17.0","extra":1}') })).toEqual([]);
    expect(Buffer.byteLength(big(PROBE_MAX_BYTES))).toBe(PROBE_MAX_BYTES);
    expect(await missing({ runProbe: resolving(big(PROBE_MAX_BYTES)) })).toEqual([]);
  });
  it('a probe that never settles ends at the guard timer as provider-probe-timeout, leaving no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let invoked: () => void = () => undefined;
    const called = new Promise<void>(resolve => { invoked = resolve; });
    const pending = evaluate({ runProbe: vi.fn(() => { invoked(); return new Promise(() => undefined); }) });
    await called;
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 999);
    expect(vi.getTimerCount()).toBe(1); // the guard outlasts execFile's own timeout by a second
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).missingCapabilities).toEqual([...ISOLATION, 'provider-probe-timeout']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears its guard timer after a result, a rejection and a synchronous throw', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const runProbe of [resolving(), rejecting({ code: 'ENOENT' }), vi.fn(() => { throw new Error('spawn'); })]) {
      await evaluate({ runProbe });
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('calls the pinned client once with exactly `version --format json`, bounded', async () => {
    const runProbe = resolving();
    await evaluate({ runProbe });
    expect(runProbe.mock.calls).toEqual([['/snap/bin/multipass', ['version', '--format', 'json'],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES, killSignal: 'SIGKILL' }]]);
  });
  it('locates the win32 and darwin clients from the report platform; an unknown platform runs nothing', async () => {
    const [win, mac, bsd] = [resolving(), resolving(), resolving()];
    await evaluate({ readCertification: accepted({ platform: 'win32' }), programFiles: 'D:\\PF', runProbe: win });
    await evaluate({ readCertification: accepted({ platform: 'darwin' }), runProbe: mac });
    expect(await missing({ readCertification: accepted({ platform: 'freebsd' }), runProbe: bsd })).toEqual([...ISOLATION, 'provider-probe-failed']);
    expect([win.mock.calls[0]?.[0], mac.mock.calls[0]?.[0], bsd.mock.calls.length])
      .toEqual(['D:\\PF\\Multipass\\bin\\multipass.exe', '/usr/local/bin/multipass', 0]);
  });
  it('runs no probe without an accepted report', async () => {
    const runProbe = resolving();
    await evaluate({ readCertification: refused('CERTIFICATION_STORE_MISSING'), runProbe });
    await evaluate({ readCertification: async () => { throw new Error('reader'); }, runProbe });
    await evaluate({ readCertification: async () => ({ ok: true, sha256: 'A'.repeat(64), report: report() }), runProbe });
    expect(runProbe).toHaveBeenCalledTimes(0);
  });
});

describe('certification evidence', () => {
  const GROUPS: Record<string, string[]> = {
    'certification-host-unsupported': ['HOST_UNSUPPORTED'], 'certification-store-unsafe': ['STORE_UNSAFE', 'STORE_IN_PROJECT'],
    'certification-unreadable': ['INPUT_INVALID', 'STORE_UNAVAILABLE', 'STORE_UNREADABLE'], 'certification-report-missing': ['STORE_MISSING', 'REPORT_NONE'],
    'certification-report-rejected': ['REPORT_UNSAFE', 'REPORT_UNREADABLE', 'REPORT_OVERSIZE', 'REPORT_MALFORMED', 'REPORT_SCHEMA', 'REPORT_CHECKS',
      'REPORT_INJECTED', 'REPORT_UNCERTIFIED'],
    'certification-report-mismatch': ['REPORT_PLATFORM', 'REPORT_ARCH', 'REPORT_IMAGE', 'REPORT_SUPERVISOR', 'REPORT_PROVIDER_VERSION'],
  };
  it('maps every CQ-M07a refusal into its operator-action group', () => {
    const expected = Object.fromEntries(Object.entries(GROUPS).flatMap(([id, codes]) => codes.map(code => [`CERTIFICATION_${code}`, id])));
    expect(CERTIFICATION_REFUSAL_IDS).toStrictEqual(expected);
    expect(Object.keys(CERTIFICATION_REFUSAL_IDS).sort()).toEqual([...CERTIFICATION_REFUSALS].sort());
    expect(Object.isFrozen(CERTIFICATION_REFUSAL_IDS)).toBe(true);
  });
  it.each(CERTIFICATION_REFUSALS)('%s fails both isolation capabilities with its group id and no evidence', async code => {
    const snapshot = await evaluate({ readCertification: refused(code) });
    expect([snapshot.missingCapabilities, snapshot.evidence]).toEqual([[...ISOLATION, CERTIFICATION_REFUSAL_IDS[code]], null]);
  });
  const UNREADABLE: Array<[string, unknown]> = [
    ['a rejecting reader', async () => { throw new Error('reader'); }], ['no reader', undefined], ['a null result', async () => null],
    ['a string result', async () => 'ok'], ['ok neither true nor false', async () => ({ ok: 'yes', refusals: [] })],
    ['refusals []', refused()], ['refusals not an array', async () => ({ ok: false, refusals: 'CERTIFICATION_STORE_MISSING' })],
    ['an unknown code', refused('CERTIFICATION_SOMETHING_NEW')], ['an inherited code name', refused('toString')],
    ['ok:true with an uppercase sha256', async () => ({ ok: true, sha256: 'A'.repeat(64), report: report() })],
    ['ok:true without a report', async () => ({ ok: true, sha256: SHA, report: null })],
    ['ok:true with a numeric platform', accepted({ platform: 7 })], ['ok:true without a provider', accepted({ provider: undefined })],
    ['ok:true with a numeric provider version', accepted({ provider: { name: 'multipass', version: 117 } })],
    ['a throwing ok getter', async () => ({ get ok(): boolean { throw new Error('ok'); } })],
  ];
  it.each(UNREADABLE)('%s gives certification-unreadable', async (_, readCertification) => {
    const snapshot = await evaluate({ readCertification });
    expect([snapshot.missingCapabilities, snapshot.evidence]).toEqual([[...ISOLATION, 'certification-unreadable'], null]);
  });
  it('reads the accepted report once, so a changing answer cannot split its identity from its rows', async () => {
    let reads = 0;
    const result = { ok: true, sha256: SHA, get report() { reads += 1; return reads === 1 ? report() : report({ platform: 'win32', checks: [] }); } };
    const snapshot = await evaluate({ readCertification: async () => result });
    expect([snapshot.missingCapabilities, snapshot.evidence, reads]).toEqual([[], EVIDENCE, 1]);
  });
  it('lists mixed refusals once each, in READINESS_IDS order', async () => {
    expect(await missing({ readCertification: refused('CERTIFICATION_REPORT_IMAGE', 'CERTIFICATION_REPORT_SCHEMA', 'CERTIFICATION_REPORT_ARCH', 'X') }))
      .toEqual([...ISOLATION, 'certification-unreadable', 'certification-report-rejected', 'certification-report-mismatch']);
  });
});

describe('no shortcut makes it ready', () => {
  it('no env value: MOE_RUNTIME_PROTECTED, MOE_RUNNER_KEY_DIR, MOE_EXECUTION_PROFILE, HOME or USERPROFILE', async () => {
    const [keys, home] = [path.join(root, 'env-keys'), dir(root, 'home')];
    await keyFor(project, keys);
    const failing = inputs({ daemonInstallDir: dir(project, 'node_modules', 'moe-daemon'), runnerKeyPath: path.join(root, 'absent.key'),
      readCertification: refused('CERTIFICATION_STORE_MISSING') });
    const before = await evaluateExecutionReadiness(failing);
    expect(before.missingCapabilities).toEqual(['protected-host-control-plane', ...ISOLATION, 'authenticated-runner-evidence', 'certification-report-missing']);
    for (const [name, value] of [['MOE_RUNTIME_PROTECTED', '1'], ['MOE_RUNNER_KEY_DIR', keys], ['MOE_EXECUTION_PROFILE', 'verified-local'],
      ['HOME', home], ['USERPROFILE', home]]) vi.stubEnv(name, value);
    expect(await evaluateExecutionReadiness(failing)).toStrictEqual(before);
  });
  it('no persisted label: a settings label, a task JSON or a project.json under .moe', async () => {
    const label = { executionReady: true, ready: true, readiness: { ready: true, missingCapabilities: [] } };
    writeFileSync(path.join(project, '.moe', 'project.json'), JSON.stringify({ settings: { deliveryPolicy: 'local-branch', ...label } }));
    writeFileSync(path.join(dir(project, '.moe', 'tasks'), 'task-x.json'), JSON.stringify({ id: 'task-x', ...label }));
    const snapshot = await evaluate({ settings: { deliveryPolicy: 'legacy', ...label } });
    expect([snapshot.ready, snapshot.missingCapabilities]).toEqual([false, ['revision-bound-local-delivery']]);
  });

  describe.skipIf(!hostIdentity())('through the real CQ-M07a reader', () => {
    const host = hostIdentity() as CertificationHost;
    const live = resolving(versions(CERTIFICATION_PINS.versions[0] + host.versionSuffix));
    /** One canonical valid report for this host in a 0700 store, as certify files it; returns the sha256 of its bytes. */
    function plant(storeDir: string): string {
      mkdirSync(storeDir, { recursive: true, mode: 0o700 });
      const bytes = `${JSON.stringify(report({}, host))}\n`;
      writeFileSync(path.join(storeDir, `certification-${host.platform}-${host.arch}-20261101T092000Z-a1b2c3.json`), bytes);
      return createHash('sha256').update(bytes).digest('hex');
    }
    const seam = (storeDir: string) => () => readCertificationStore({ storeDir, projectRoot: project });

    it('a report in a store outside the project is the control: ready, naming its exact bytes', async () => {
      const storeDir = path.join(root, 'store', 'certification');
      const sha = plant(storeDir);
      const snapshot = await evaluate({ readCertification: seam(storeDir), runProbe: live });
      expect([snapshot.ready, snapshot.missingCapabilities, snapshot.evidence?.reportSha256]).toEqual([true, [], sha]);
    });
    it.each([['.moe', 'certification'], ['certification']])('the same report under project/%s is certification-store-unsafe', async (...parts: string[]) => {
      const storeDir = path.join(project, ...parts);
      plant(storeDir);
      const snapshot = await evaluate({ readCertification: seam(storeDir), runProbe: live });
      expect([snapshot.ready, snapshot.missingCapabilities, snapshot.evidence]).toEqual([false, [...ISOLATION, 'certification-store-unsafe'], null]);
    });
    it('the production reader ignores a report planted in a HOME or USERPROFILE home', async () => {
      const home = dir(root, 'home');
      const planted = plant(path.join(home, '.moe', 'certification'));
      for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, home);
      expect(os.homedir()).toBe(home);
      const snapshot = await evaluate({ settings: { deliveryPolicy: 'legacy' }, readCertification: () => readHostCertificationEvidence(project), runProbe: live });
      expect(snapshot.ready).toBe(false);
      expect(snapshot.missingCapabilities).toContain('revision-bound-local-delivery');
      expect(snapshot.evidence?.reportSha256).not.toBe(planted);
    });
  });
});

describe('ids and drift', () => {
  it('keeps one frozen, unique id order: capabilities, then evidence', () => {
    expect(READINESS_IDS).toEqual([...READINESS_CAPABILITIES, ...READINESS_EVIDENCE_IDS]);
    expect(new Set(READINESS_IDS).size).toBe(15);
    expect([READINESS_IDS, READINESS_CAPABILITIES, READINESS_EVIDENCE_IDS, AGENT_VM_ROWS, CHECK_VM_ROWS].every(Object.isFrozen)).toBe(true);
  });
  it('AGENT_VM_ROWS and CHECK_VM_ROWS cover exactly the certify rows', () => {
    expect(new Set([...AGENT_VM_ROWS, ...CHECK_VM_ROWS])).toEqual(new Set(CERTIFY_CHECK_IDS));
    expect([...AGENT_VM_ROWS, ...CHECK_VM_ROWS].filter(id => !CERTIFY_CHECK_IDS.includes(id))).toEqual([]);
    expect([AGENT_VM_ROWS.includes('check-containment'), CHECK_VM_ROWS.includes('writer-containment'), CHECK_VM_ROWS.includes('bridge-framing')])
      .toEqual([false, false, false]);
  });
  it('READINESS_CAPABILITIES is the list assertExecutionProfileReady throws today', () => {
    let thrown: unknown;
    try { assertExecutionProfileReady('verified-local'); } catch (error) { thrown = error; }
    expect((thrown as MoeError).context?.missingCapabilities).toEqual(READINESS_CAPABILITIES);
  });
  it('pinnedMultipassClient matches the platform modules, including a non-default ProgramFiles', async () => {
    vi.stubEnv('ProgramFiles', 'D:\\PF');
    const [{ linuxPlatform }, { macosPlatform }, { windowsPlatform }] = await Promise.all(
      ['platform-linux.mjs', 'platform-macos.mjs', 'platform-windows.mjs'].map(name => import(runner(name))));
    expect([pinnedMultipassClient('linux'), pinnedMultipassClient('darwin'), pinnedMultipassClient('win32', process.env.ProgramFiles)])
      .toEqual([linuxPlatform.executable, macosPlatform.executable, windowsPlatform.executable]);
    expect(windowsPlatform.executable).toBe('D:\\PF\\Multipass\\bin\\multipass.exe');
  });
  it('falls back like driveRoot and never returns a bare or PATH client', () => {
    for (const value of [undefined, '', 'relative', 'D:/PF', '\\\\server\\share']) {
      expect(pinnedMultipassClient('win32', value)).toBe('C:\\Program Files\\Multipass\\bin\\multipass.exe');
    }
    expect([pinnedMultipassClient('freebsd'), pinnedMultipassClient('Linux'), pinnedMultipassClient('')]).toEqual([null, null, null]);
  });
  it('PROBE_TIMEOUT_MS and PROBE_MAX_BYTES are multipass.mjs MAX_PROBE_TIMEOUT_MS and MAX_PROBE_BUFFER', async () => {
    const { MAX_PROBE_TIMEOUT_MS, MAX_PROBE_BUFFER } = await import(runner('multipass.mjs'));
    expect([PROBE_TIMEOUT_MS, PROBE_MAX_BYTES]).toEqual([MAX_PROBE_TIMEOUT_MS, MAX_PROBE_BUFFER]);
  });
  it('stays leaf-safe: its imports are node:fs/promises, node:path, the CQ-M07a reader, runnerChannel and affectedFiles only', () => {
    const source = readFileSync(new URL('./executionReadiness.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1])).toEqual(['node:fs/promises', 'node:path',
      './certificationEvidence.js', '../server/runnerChannel.js', '../util/affectedFiles.js']);
    expect(source).not.toMatch(/process\.|os\.|homedir|readFileSync/);
  });
});

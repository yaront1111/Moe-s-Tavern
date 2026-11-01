// CQ-M07c: the daemon's held verified-local readiness value, its scheduler and its three consumers. Every evaluate is a fake,
// except the in-project report row: the real evaluator, a recording fake runProbe. No test spawns a real Multipass client.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { runnerKeyPath } from '../server/runnerChannel.js';
import { activationGaps } from '../state/profileRollout.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Project, Task } from '../types/schema.js';
import { CERTIFICATION_PINS, CERTIFY_CHECK_IDS, hostIdentity } from './certificationEvidence.js';
import { READINESS_CAPABILITIES, type ProbeRunner, type ReadinessId, type ReadinessInputs, type ReadinessSnapshot } from './executionReadiness.js';
import { assertExecutionProfileReady } from './executionProfile.js';
import { evaluateDeliveryEvidence } from './policy.js';
import {
  DEFAULT_READINESS, READINESS_INTERVAL_MS, clearReadiness, heldReadiness, productionReadinessInputs, refreshReadiness,
  startReadinessEvaluation, type ReadinessEvaluator,
} from './readinessHolder.js';

// Stands in for CQ-M07d's client flip in the DoD 1 positive rows only; off, decodeClientHello is the real one.
const client = vi.hoisted(() => ({ verifiedLocal: false }));
vi.mock('../server/clientCapabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/clientCapabilities.js')>();
  return { ...actual, decodeClientHello: (payload: unknown) => {
    const agreed = actual.decodeClientHello(payload);
    return client.verifiedLocal ? { ...agreed, negotiatedCapabilities: { ...agreed.negotiatedCapabilities, verifiedLocal: true } } : agreed;
  } };
});

type Row = Record<string, unknown>;
const ISO = '2026-11-01T12:00:00.000Z';
const EVIDENCE = { reportSha256: 'a'.repeat(64), platform: 'linux', arch: 'x64', providerVersion: '1.17.0' };
const READY: ReadinessSnapshot = { ready: true, missingCapabilities: [], evaluatedAt: ISO, evidence: EVIDENCE };
const only = (...ids: ReadinessId[]): ReadinessSnapshot => ({ ready: false, missingCapabilities: ids, evaluatedAt: ISO, evidence: null });
const NOT_READY = only('revision-bound-local-delivery', 'certification-report-missing');
const NOT_READY_CODE = 'EXECUTION_PROFILE_NOT_READY';
/** MoeError prefixes its codeName; the text after it is assertExecutionProfileReady's own. */
const NEVER = `[${NOT_READY_CODE}] Execution profile verified-local is not ready: protected local isolation, trusted evidence and revision-bound delivery are not certified.`;
const INPUTS = Object.freeze({ projectRoot: 'never-read' }) as unknown as ReadinessInputs;
const hold = (snapshot: unknown) => refreshReadiness(INPUTS, async () => snapshot);
const fail = (error = new Error('evaluation failed')): ReadinessEvaluator => () => { throw error; };
function deferred() {
  let resolve: (value: unknown) => void = () => undefined;
  return { promise: new Promise<unknown>((done) => { resolve = done; }), resolve: (value: unknown) => resolve(value) };
}
/** The MoeError `act` throws or rejects with; anything else fails the row. */
async function refusal(act: () => unknown): Promise<MoeError> {
  const error = await Promise.resolve().then(act).then(() => null, (e: unknown) => e);
  if (!(error instanceof MoeError)) throw new Error(`expected a MoeError refusal, got ${String(error)}`);
  return error;
}

afterEach(() => { clearReadiness(); client.verifiedLocal = false; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the held value and assertExecutionProfileReady (DoD 2)', () => {
  it('holds a frozen DEFAULT_READINESS until evaluated, refused with today\'s exact message and context', async () => {
    expect(heldReadiness()).toBe(DEFAULT_READINESS);
    expect([Object.isFrozen(DEFAULT_READINESS), Object.isFrozen(DEFAULT_READINESS.missingCapabilities)]).toEqual([true, true]);
    expect(DEFAULT_READINESS).toEqual({ ready: false, missingCapabilities: [...READINESS_CAPABILITIES], evaluatedAt: null, evidence: null });
    const error = await refusal(() => assertExecutionProfileReady('verified-local'));
    expect([error.code, error.codeName, error.message, error.context]).toEqual([MoeErrorCode.NOT_ALLOWED, NOT_READY_CODE, NEVER,
      { executionProfile: 'verified-local', missingCapabilities: [...READINESS_CAPABILITIES] }]);
  });
  it.each([['the default', undefined], ['READY', READY], ['NOT_READY', NOT_READY]])('legacy and observe pass under %s', async (_n, held) => {
    if (held) await hold(held);
    expect([assertExecutionProfileReady('legacy'), assertExecutionProfileReady('observe')]).toEqual([undefined, undefined]);
  });
  it('refuses with exactly the held list once evaluated, passes while READY is held, and refuses again after clear', async () => {
    await hold(NOT_READY);
    const error = await refusal(() => assertExecutionProfileReady('verified-local'));
    expect([error.codeName, error.message, error.context]).toEqual([NOT_READY_CODE,
      `[${NOT_READY_CODE}] Execution profile verified-local is not ready: missing revision-bound-local-delivery, certification-report-missing.`,
      { executionProfile: 'verified-local', missingCapabilities: NOT_READY.missingCapabilities }]);
    (error.context as { missingCapabilities: string[] }).missingCapabilities.push('x');
    expect(heldReadiness().missingCapabilities).toEqual(NOT_READY.missingCapabilities);
    await hold(READY);
    expect(assertExecutionProfileReady('verified-local')).toBeUndefined();
    clearReadiness();
    expect((await refusal(() => assertExecutionProfileReady('verified-local'))).message).toBe(NEVER);
  });
});

describe('refreshReadiness holds only a well-formed evaluation', () => {
  const bad: [string, ReadinessEvaluator][] = [
    ['ready true with a non-empty list', async () => ({ ...READY, missingCapabilities: ['isolated-check-vm'] })],
    ['ready false with []', async () => ({ ...NOT_READY, missingCapabilities: [] })],
    ['an unknown id', async () => ({ ...NOT_READY, missingCapabilities: ['revision-bound-local-delivery', 'vm-ok'] })],
    ['ids out of READINESS_IDS order', async () => ({ ...NOT_READY, missingCapabilities: [...NOT_READY.missingCapabilities].reverse() })],
    ['a duplicate id', async () => ({ ...NOT_READY, missingCapabilities: ['isolated-check-vm', 'isolated-check-vm'] })],
    ['a non-array list', async () => ({ ...NOT_READY, missingCapabilities: 'isolated-check-vm' })],
    ["ready as the string 'true'", async () => ({ ...READY, ready: 'true' })],
    ['a non-ISO evaluatedAt', async () => ({ ...READY, evaluatedAt: '2026-11-01T12:00:00Z' })],
    ['an invalid-date evaluatedAt', async () => ({ ...READY, evaluatedAt: 'not a date' })],
    ['evidence with an extra key', async () => ({ ...READY, evidence: { ...EVIDENCE, trusted: true } })],
    ['evidence with a short sha', async () => ({ ...READY, evidence: { ...EVIDENCE, reportSha256: 'a'.repeat(63) } })],
    ['evidence with an uppercase sha', async () => ({ ...READY, evidence: { ...EVIDENCE, reportSha256: 'A'.repeat(64) } })],
    ['evidence with a numeric arch', async () => ({ ...READY, evidence: { ...EVIDENCE, arch: 64 } })],
    ['no evidence key', async () => ({ ready: true, missingCapabilities: [], evaluatedAt: ISO })],
    ['a class instance', async () => Object.assign(new (class Snapshot {})(), READY)],
    ['null', async () => null], ['an array', async () => [READY]],
    ['a throwing evaluate', fail()], ['a rejecting evaluate', async () => { throw new Error('rejected'); }],
  ];
  it.each(bad)('%s holds DEFAULT_READINESS, even over a held READY', async (_n, evaluate) => {
    await hold(READY);
    expect(await refreshReadiness(INPUTS, evaluate)).toBe(DEFAULT_READINESS);
    expect(heldReadiness()).toBe(DEFAULT_READINESS);
  });
  it.each([['READY', READY], ['NOT_READY', NOT_READY], ['null arch and version', { ...READY, evidence: { ...EVIDENCE, arch: null, providerVersion: null } }],
    ['a null-prototype snapshot', Object.assign(Object.create(null), READY)]])('holds %s as a deep-frozen copy', async (_n, snapshot) => {
    const mutable = { ...snapshot, missingCapabilities: [...snapshot.missingCapabilities], evidence: snapshot.evidence && { ...snapshot.evidence } };
    await hold(mutable);
    const held = heldReadiness();
    mutable.missingCapabilities.push('isolated-check-vm');
    if (mutable.evidence) mutable.evidence.platform = 'win32';
    expect(held).toEqual({ ...snapshot });
    expect(heldReadiness()).toBe(held);
    expect([held === mutable, Object.isFrozen(held), Object.isFrozen(held.missingCapabilities), held.evidence === null || Object.isFrozen(held.evidence)])
      .toEqual([false, true, true, true]);
  });
  it('the last-started refresh wins, and a clear supersedes an in-flight refresh', async () => {
    const older = deferred();
    const newer = deferred();
    const first = refreshReadiness(INPUTS, () => older.promise);
    const second = refreshReadiness(INPUTS, () => newer.promise);
    newer.resolve(NOT_READY);
    await second;
    older.resolve(READY);
    await first;
    expect(heldReadiness()).toEqual(NOT_READY);
    const late = deferred();
    const cleared = refreshReadiness(INPUTS, () => late.promise);
    clearReadiness();
    late.resolve(READY);
    expect(await cleared).toBe(DEFAULT_READINESS);
  });
});

describe('startReadinessEvaluation (DoD 5)', () => {
  it('evaluates at start with injected deps and holds the result', async () => {
    const inputs = vi.fn(() => INPUTS);
    const evaluate = vi.fn(async () => READY);
    const run = startReadinessEvaluation({ inputs, evaluate });
    expect(await run.first).toEqual(READY);
    run.stop();
    expect([heldReadiness(), evaluate.mock.calls, inputs.mock.calls.length]).toEqual([READY, [[INPUTS]], 1]);
  });
  it.each([['a throwing evaluate', { evaluate: fail() }], ['a throwing inputs()', { inputs: () => { throw new Error('settings'); } }]])(
    '%s leaves DEFAULT_READINESS, even over a held READY', async (_n, over) => {
      await hold(READY);
      const run = startReadinessEvaluation({ inputs: () => INPUTS, evaluate: async () => READY, ...over });
      expect(await run.first).toBe(DEFAULT_READINESS);
      run.stop();
      expect(heldReadiness()).toBe(DEFAULT_READINESS);
    });
  it.each([undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])('intervalMs %s schedules an unref\'d READINESS_INTERVAL_MS', async (intervalMs) => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const run = startReadinessEvaluation({ inputs: () => INPUTS, evaluate: async () => NOT_READY, intervalMs });
    await run.first;
    run.stop();
    expect([READINESS_INTERVAL_MS, spy.mock.calls[0]?.[1], (spy.mock.results[0]?.value as NodeJS.Timeout).hasRef()]).toEqual([300_000, 300_000, false]);
  });
  it('re-evaluates every interval with fresh inputs(); onChange runs once per change', async () => {
    vi.useFakeTimers();
    const results = [READY, READY, NOT_READY];
    let n = 0;
    const evaluate = vi.fn(async (inputs: ReadinessInputs) => results[(inputs.settings as number) - 1]);
    const onChange = vi.fn();
    const run = startReadinessEvaluation({ inputs: () => ({ ...INPUTS, settings: ++n }), evaluate, onChange });
    await run.first;
    await vi.advanceTimersByTimeAsync(READINESS_INTERVAL_MS - 1);
    expect([evaluate.mock.calls.length, heldReadiness()]).toEqual([1, READY]);
    await vi.advanceTimersByTimeAsync(1);
    expect([evaluate.mock.calls.length, heldReadiness(), onChange.mock.calls.length]).toEqual([2, READY, 1]);
    await vi.advanceTimersByTimeAsync(READINESS_INTERVAL_MS);
    run.stop();
    expect([evaluate.mock.calls.map(([i]) => i.settings), heldReadiness(), onChange.mock.calls]).toEqual([[1, 2, 3], NOT_READY, [[READY], [NOT_READY]]]);
  });
  it('is single-flight: ticks and refresh() during a slow evaluation join it; the next refresh evaluates again', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const evaluate = vi.fn<ReadinessEvaluator>(() => slow.promise);
    const run = startReadinessEvaluation({ inputs: () => INPUTS, evaluate, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect([run.refresh() === run.first, evaluate.mock.calls.length]).toEqual([true, 1]);
    slow.resolve(READY);
    expect(await run.first).toEqual(READY);
    evaluate.mockImplementation(async () => NOT_READY);
    expect(await run.refresh()).toEqual(NOT_READY);
    run.stop();
    expect(evaluate.mock.calls.length).toBe(2);
  });
  it('stop() is idempotent and no tick runs after it; a throwing onChange is swallowed', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn(async () => READY);
    const onChange = vi.fn(() => { throw new Error('listener'); });
    const run = startReadinessEvaluation({ inputs: () => INPUTS, evaluate, onChange });
    expect(await run.first).toEqual(READY);
    run.stop();
    run.stop();
    await vi.advanceTimersByTimeAsync(READINESS_INTERVAL_MS * 3);
    expect([evaluate.mock.calls.length, onChange.mock.calls.length, vi.getTimerCount(), heldReadiness()]).toEqual([1, 1, 0, READY]);
  });
});

it('productionReadinessInputs wires the own install root, this project\'s key path, the live settings and ProgramFiles', () => {
  vi.stubEnv('ProgramFiles', 'D:\\Programs');
  const project = path.join(os.tmpdir(), 'moe-holder-project');
  const settings = { deliveryPolicy: 'local-branch' };
  const inputs = productionReadinessInputs(project, settings);
  const manifest = JSON.parse(fs.readFileSync(path.join(inputs.daemonInstallDir, 'package.json'), 'utf8')) as { name?: unknown };
  expect([inputs.projectRoot, inputs.runnerKeyPath, manifest.name, path.isAbsolute(inputs.daemonInstallDir), inputs.programFiles, inputs.settings === settings,
    typeof inputs.readCertification, typeof inputs.runProbe, Math.abs(inputs.now().getTime() - Date.now()) < 60_000])
    .toEqual([project, runnerKeyPath(project), 'moe-daemon', true, 'D:\\Programs', true, 'function', 'function', true]);
});

describe('activationGaps (DoD 4): vm and check follow the held value; the client gate is real', () => {
  const VM = { capability: 'vm', reason: 'vm-provisioning-uncertified' };
  const CLIENT = { capability: 'client', reason: 'client-contract-unsupported' };
  const CHECK = { capability: 'check', reason: 'check-runner-uncertified' };
  it.each([['the default', undefined, [VM, CLIENT, CHECK]], ['READY', READY, [CLIENT]], ['NOT_READY', NOT_READY, [CLIENT]],
    ['only isolated-check-vm missing', only('isolated-check-vm'), [CLIENT, CHECK]],
    ['only isolated-agent-and-qa-vms missing', only('isolated-agent-and-qa-vms'), [VM, CLIENT]],
    ['only authenticated-runner-evidence missing', only('authenticated-runner-evidence'), [CLIENT]],
  ])('%s', async (_n, held, expected) => {
    if (held) await hold(held);
    const [first, second] = [activationGaps(), activationGaps()];
    expect([first, second, first[0] === second[0]]).toEqual([expected, expected, false]);
  });
});

describe('through the real tools (DoD 1 and DoD 3)', () => {
  const h = new ToolTestHarness();
  const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
  const BASE = { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true, branchPattern: 'moe/{epicId}/{taskId}',
    commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude' };
  const STRICT_SETTINGS = { executionProfile: 'verified-local', deliveryPolicy: 'local-branch' };
  /** deliveryPolicy is not an updatable setting, so it is seeded raw; the update requests the profile only. */
  const ACTIVATE = { executionProfile: 'verified-local' } as const;
  const LABELS = { executionReadiness: { ready: true, missingCapabilities: [] }, readiness: { ready: true, missingCapabilities: [] }, verifiedLocalReady: true };
  const ARGS = { ready: true, executionReadiness: { ready: true, missingCapabilities: [] }, missingCapabilities: [] };
  const STEP = { description: 'implement and test', affectedFiles: ['file.ts'] };
  const task = (id: string) => h.state.getTask(id)!;
  const bytes = (...parts: string[]) => fs.readFileSync(path.join(h.moePath, ...parts), 'utf8');
  /** task-p PLANNING, task-w a strict WORKING row, task-r a strict REVIEW row; raw JSON, then load. */
  async function seed(settings: Row = {}, label: Row = {}): Promise<void> {
    h.setupMoeFolder({ settings: { ...BASE, ...settings } } as unknown as Partial<Project>);
    h.createEpic();
    h.createTask({ id: 'task-p', status: 'PLANNING', ...label } as Partial<Task>);
    for (const [id, status] of [['task-w', 'WORKING'], ['task-r', 'REVIEW']]) {
      h.createTask({ id, status, planRevision: 1, approvedPlanRevision: 1, executionPolicySnapshot: STRICT, implementationPlan: [
        { stepId: 'step-1', description: 'done', status: 'COMPLETED', affectedFiles: ['file.ts'] }], ...label } as unknown as Partial<Task>);
    }
    await h.state.load();
  }
  const plan = (args: Row = {}) => submitPlanTool(h.state).handler({ taskId: 'task-p', steps: [STEP], ...args }, h.state);
  const claim = (args: Row = {}) => claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], taskId: 'task-w', workerId: 'worker-1',
    executionRoute: 'vm', ...args }, h.state);
  /** Each strict path refused, the client gate open, nothing written, and the held value untouched. */
  async function stillRefused(args: Row = {}): Promise<void> {
    client.verifiedLocal = true;
    const before = { held: heldReadiness(), tasks: ['task-p', 'task-w', 'task-r'].map((id) => bytes('tasks', `${id}.json`)), project: bytes('project.json') };
    for (const act of [() => plan(args), () => claim(args), () => h.state.updateSettings({ ...ACTIVATE, ...args } as never)]) {
      const error = await refusal(act);
      if (Object.keys(args).length === 0) expect(error.codeName).toBe(NOT_READY_CODE);
    }
    expect((await refusal(() => qaApproveTool(h.state).handler({ taskId: 'task-r', summary: 'verified', ...args }, h.state))).codeName).not.toBe('');
    expect((await refusal(() => evaluateDeliveryEvidence(h.state, task('task-r')))).codeName).toBe(NOT_READY_CODE);
    expect([heldReadiness(), ['task-p', 'task-w', 'task-r'].map((id) => bytes('tasks', `${id}.json`)), bytes('project.json'),
      fs.existsSync(path.join(h.moePath, 'attempts'))]).toEqual([before.held, before.tasks, before.project, false]);
  }

  beforeEach(() => h.init());
  afterEach(async () => { await h.state.flushActivityLog(); h.cleanup(); });

  it('DoD 1: a held READY lets the settings update, submit_plan and claim succeed; without the client gate only [client] remains', async () => {
    await seed({ deliveryPolicy: 'local-branch' });
    await hold(READY);
    const unsupported = await refusal(() => h.state.updateSettings(ACTIVATE));
    expect([unsupported.codeName, (unsupported.context as Row).unsupportedCapabilities]).toEqual(['EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED',
      [{ capability: 'client', reason: 'client-contract-unsupported' }]]);
    client.verifiedLocal = true;
    await h.state.updateSettings(ACTIVATE);
    expect((JSON.parse(bytes('project.json')) as { settings: Row }).settings).toMatchObject(STRICT_SETTINGS);
    await plan();
    expect([task('task-p').status, task('task-p').executionPolicySnapshot]).toEqual(['WORKING', { ...STRICT, planRevision: task('task-p').planRevision }]);
    expect(await claim({ taskId: 'task-p' })).toMatchObject({ hasNext: true, task: { id: 'task-p', status: 'WORKING' } });
    expect(task('task-p').assignedWorkerId).toBe('worker-1');
  });
  it('DoD 1: the default refuses the settings update, submit_plan and claim with EXECUTION_PROFILE_NOT_READY, writing nothing', async () => {
    await seed({ deliveryPolicy: 'local-branch' });
    client.verifiedLocal = true;
    expect((await refusal(() => h.state.updateSettings(ACTIVATE))).codeName).toBe(NOT_READY_CODE);
    h.state.project!.settings = { ...h.state.project!.settings, ...STRICT_SETTINGS } as never;
    fs.writeFileSync(path.join(h.moePath, 'project.json'), JSON.stringify(h.state.project, null, 2));
    await stillRefused();
  });

  describe('DoD 3: none of these makes verified-local pass', () => {
    it('env vars', async () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-holder-env-'));
      for (const [name, value] of [['MOE_RUNTIME_PROTECTED', '1'], ['MOE_EXECUTION_READY', '1'], ['MOE_VERIFIED_LOCAL', 'ready'],
        ['MOE_EXECUTION_PROFILE', 'verified-local'], ['MOE_RUNNER_KEY_DIR', temp], ['HOME', temp], ['USERPROFILE', temp]]) vi.stubEnv(name, value);
      await seed(STRICT_SETTINGS);
      await stillRefused();
      fs.rmSync(temp, { recursive: true, force: true });
    });
    it.each([['local-branch'], ['legacy'], [undefined]])('settings: executionProfile verified-local with deliveryPolicy %s', async (deliveryPolicy) => {
      await seed({ executionProfile: 'verified-local', ...(deliveryPolicy ? { deliveryPolicy } : {}) });
      await stillRefused();
    });
    it('readiness labels persisted in project.json settings and in task JSON', async () => {
      await seed({ ...STRICT_SETTINGS, ...LABELS }, LABELS);
      await stillRefused();
    });
    it('caller arguments on claim_next_task, submit_plan, the settings update and qa_approve', async () => {
      await seed(STRICT_SETTINGS);
      await stillRefused(ARGS);
    });
    it('a valid report inside the project and its .moe, under the real evaluator', async () => {
      await seed(STRICT_SETTINGS);
      const host = hostIdentity() ?? CERTIFICATION_PINS.hosts[1];
      const report = `${JSON.stringify({ kind: 'isolation-certification', version: 1, platform: host.platform, arch: host.arch, transport: 'native',
        provider: { name: 'multipass', version: CERTIFICATION_PINS.versions[0] + host.versionSuffix },
        image: { sourceSha256: CERTIFICATION_PINS.images[host.arch], providerImageHash: 'b'.repeat(64) }, supervisorSha256: CERTIFICATION_PINS.supervisorSha256,
        startedAt: '2026-11-01T09:00:00.000Z', finishedAt: '2026-11-01T09:20:00.000Z', checks: CERTIFY_CHECK_IDS.map((id) => ({ id, result: 'passed', code: null })),
        certified: true, executionReady: false })}\n`;
      for (const store of [path.join(h.moePath, 'certification'), path.join(h.testDir, 'certification')]) {
        fs.mkdirSync(store, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(store, `certification-${host.platform}-${host.arch}-20261101T092000Z-a1b2c3.json`), report);
      }
      const runProbe = vi.fn<ProbeRunner>(async () => ({ stdout: JSON.stringify({ multipass: 'x', multipassd: 'x' }) }));
      const held = await refreshReadiness({ ...productionReadinessInputs(h.testDir, h.state.project!.settings), runProbe });
      expect([held.ready, held.missingCapabilities.includes('authenticated-runner-evidence'), held.evidence?.reportSha256 ===
        createHash('sha256').update(report).digest('hex'), held.evaluatedAt === null]).toEqual([false, true, false, false]);
      await stillRefused();
    });
  });
});

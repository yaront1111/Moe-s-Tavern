// =============================================================================
// CQ-M01f: one per-task delivery-policy selection (resolveTaskDeliveryPolicy),
// shared by qa_approve, the dependency gate and the board projection.
//   - Legacy and observe tasks keep the LIVE settings.deliveryPolicy rules; a
//     captured deliveryPolicy is identity only and is never consulted.
//   - A strict task (a stored verified-local snapshot of any version or
//     revision, or a hand-edited live verified-local profile) and malformed
//     configuration fail closed: refused before any write, never satisfied.
// update_settings and the CQ-M01c backstop refuse verified-local, so strict
// rows exist only as hand-edited raw JSON. Nothing here reads a snapshot as
// approval, readiness or verified delivery.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { listReviewsForTask } from '../state/reviewStore.js';
import { MoeError } from '../util/errors.js';
import * as policy from './policy.js';
import {
  dependencyShortfall, describeUnmetDependency, isDependencySatisfied, runDependencyUnblock, unmetDependsOn,
} from '../state/dependencyUnblock.js';
import { deliveryProjection } from '../state/deliveryProjection.js';
import { recordCheckRun } from '../state/checkRunStore.js';

type Row = Record<string, unknown>;

const GATE = 'node gate.cjs';
const TREE = 'c3'.repeat(20);
const STARTED = '2026-10-24T10:00:00.000Z';
const SUMMARY = 'Re-ran the gate and checked each DoD item against the recorded evidence.';

/** setupMoeFolder REPLACES the whole settings object when settings are overridden. */
const HARNESS_SETTINGS = {
  approvalMode: 'CONTROL',
  speedModeDelayMs: 2000,
  autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  agentCommand: 'claude',
};
const GATED = { ...HARNESS_SETTINGS, autoCommit: true, qualityGate: GATE, qualityGateScope: 'everyTask' };
const LIVE_LEGACY = { executionProfile: 'legacy', deliveryPolicy: 'legacy' };
const LIVE_OBSERVE = { executionProfile: 'observe', deliveryPolicy: 'local-branch' };
const LIVE_STRICT = { executionProfile: 'verified-local' };

const STRICT_V2 = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const STRICT_LEGACY = { ...STRICT_V2, deliveryPolicy: 'legacy' };
const STRICT_V1 = { version: 1, profile: 'verified-local', planRevision: 1 };
const LEGACY_V1 = { version: 1, profile: 'legacy', planRevision: 1 };
const OBSERVE_V1 = { version: 1, profile: 'observe', planRevision: 1 };
const legacyV2 = (deliveryPolicy: string): Row => ({ version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy });
const observeV2 = (deliveryPolicy: string): Row => ({ version: 2, profile: 'observe', planRevision: 1, deliveryPolicy });

/** [label, live settings, stored snapshot (undefined = none), task extras]: every way a task is strict. */
const STRICT_SOURCES: Array<[string, Row, unknown, Row]> = [
  ['(a) STRICT_V2 after a rollback to the default policy', {}, STRICT_V2, {}],
  ['(b) a stale STRICT_V2 under live legacy', LIVE_LEGACY, STRICT_V2, { planRevision: 3 }],
  ['(c) STRICT_V2 under live observe/local-branch with complete evidence', LIVE_OBSERVE, STRICT_V2, {}],
  ['(d) STRICT_LEGACY under live legacy', LIVE_LEGACY, STRICT_LEGACY, {}],
  ['(e) STRICT_V1 under live legacy', LIVE_LEGACY, STRICT_V1, {}],
  ['(f) no snapshot under a live verified-local profile', LIVE_STRICT, undefined, {}],
  ["(g) legacyV2('legacy') under a live verified-local profile", LIVE_STRICT, legacyV2('legacy'), {}],
];

const MALFORMED: Array<[string, unknown]> = [
  ['null', null],
  ['an array', []],
  ['a bare string', 'verified-local'],
  ['version 3', { ...STRICT_V2, version: 3 }],
  ['an upper-case profile', { ...STRICT_V2, profile: 'VERIFIED-LOCAL' }],
  ['an extra ready key', { ...STRICT_V2, ready: true }],
  ['v2 verified-local without deliveryPolicy', { version: 2, profile: 'verified-local', planRevision: 1 }],
  ['a string planRevision', { ...STRICT_V2, planRevision: '1' }],
];

const NOT_READY = {
  code: -32003,
  codeName: 'EXECUTION_PROFILE_NOT_READY',
  context: {
    executionProfile: 'verified-local',
    missingCapabilities: [
      'protected-host-control-plane',
      'isolated-agent-and-qa-vms',
      'isolated-check-vm',
      'authenticated-runner-evidence',
      'revision-bound-local-delivery',
    ],
  },
};

const candidate = (id: string, taskId: string): Row => ({
  id, attemptId: `attempt-${taskId}`, taskId, baseRevision: 'a1'.repeat(20), treeSha: TREE,
  deliveryTarget: 'refs/heads/moe/work', createdAt: '2026-10-24T09:30:00.000Z',
});
const passingRun = (id: string, candidateId: string): Row => ({
  id, candidateId, treeSha: TREE, command: GATE, exitCode: 0, outputTail: 'gate ok', runnerId: 'runner-1', source: 'runner-observed',
});
const completion = (pushed: boolean): Row => ({
  sha: 'abc1234abc1234', ref: 'moe/work', kind: 'completion', role: 'worker', sessionId: 'worker-1@2026-10-24T09:00:00.000Z',
  paths: ['src/a.ts'], pushed, recordedBy: 'worker-1', recordedAt: '2026-10-24T10:00:05.000Z',
});

/** The default REVIEW task-1: one pushed completion commit this round. */
const reviewTask = (snapshot: unknown, extra: Row = {}): Row => ({
  id: 'task-1', status: 'REVIEW', reviewStartedAt: STARTED, planRevision: 1, commits: [completion(true)],
  ...(snapshot === undefined ? {} : { executionPolicySnapshot: snapshot }), ...extra,
});

const h = new ToolTestHarness();
let roleChannel: MockInstance;

beforeEach(() => h.init());
afterEach(async () => {
  await h.state.flushActivityLog();
  h.state.clearEmitter();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.cleanup();
});

function writeRecord(kind: string, record: Row): void {
  const dir = path.join(h.moePath, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(record.id)}.json`), JSON.stringify(record, null, 2));
}

/** Raw records on disk, then load: the only way a strict row or setting can exist. */
async function seed(settings: Row, tasks: Row[], candidates: Row[] = [], checks: Row[] = []): Promise<void> {
  for (const record of candidates) writeRecord('candidates', record);
  for (const record of checks) writeRecord('checks', record);
  h.setupMoeFolder({ settings: { ...GATED, ...settings } as never });
  h.createEpic();
  for (const task of tasks) h.createTask(task as never);
  await h.state.load();
  roleChannel = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
}

/** The Q fixture: task-1 with complete evidence (candidate, passing gate run, pushed commit). */
const seedReview = (settings: Row, snapshot: unknown, extra: Row = {}): Promise<void> =>
  seed(settings, [reviewTask(snapshot, extra)], [candidate('cand-1', 'task-1')], [passingRun('check-1', 'cand-1')]);

const approve = (extra: Row = {}): Promise<Row> =>
  qaApproveTool(h.state).handler(
    { taskId: 'task-1', workerId: 'qa-1', summary: SUMMARY, candidateId: 'cand-1', ...extra }, h.state,
  ) as Promise<Row>;

function thrown(act: () => unknown): MoeError {
  try {
    act();
  } catch (err) {
    if (err instanceof MoeError) return err;
    throw err;
  }
  throw new Error('expected a MoeError, but the call returned');
}

const identity = (err: MoeError): Row => ({ code: err.code, codeName: err.codeName, context: err.context });
const expectNotReady = (err: MoeError): void => { expect(identity(err)).toEqual(NOT_READY); };
function expectInvalid(err: MoeError, fieldPrefix: string): void {
  expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32602, codeName: 'INVALID_INPUT' });
  expect(String((err.context as Row).field).startsWith(fieldPrefix)).toBe(true);
}

/**
 * `call` must be refused with `codeName` BEFORE every write: no entity write,
 * worker touch, chat post or event; identical task bytes and row, still REVIEW,
 * and no Review in memory or on disk.
 */
async function refusedWithoutWrites(call: () => Promise<unknown>, codeName: string): Promise<MoeError> {
  const file = path.join(h.moePath, 'tasks', 'task-1.json');
  const bytes = fs.readFileSync(file, 'utf8');
  const row = structuredClone(h.state.getTask('task-1'));
  const writes = vi.spyOn(h.state, 'writeEntity');
  const touches = vi.spyOn(h.state, 'touchWorker');
  const system = vi.spyOn(h.state, 'postSystemMessage');
  const events: string[] = [];
  const unsubscribe = h.state.subscribe((event) => { events.push(event.type); });
  let error: unknown;
  try {
    await call();
  } catch (err) {
    error = err;
  } finally {
    unsubscribe();
  }
  expect(error).toBeInstanceOf(MoeError);
  expect((error as MoeError).codeName).toBe(codeName);
  expect({
    writes: writes.mock.calls.length, touches: touches.mock.calls.length,
    system: system.mock.calls.length, role: roleChannel.mock.calls.length, events,
  }).toEqual({ writes: 0, touches: 0, system: 0, role: 0, events: [] });
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  expect(h.state.getTask('task-1')).toEqual(row);
  expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  expect(listReviewsForTask(h.state, 'task-1')).toEqual([]);
  expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
  return error as MoeError;
}

describe('CQ-M01f Q: qa_approve cannot bypass a strict task policy', () => {
  it.each(STRICT_SOURCES)('Q1 %s is refused EXECUTION_PROFILE_NOT_READY before any write', async (_label, settings, snapshot, extra) => {
    await seedReview(settings, snapshot, extra);
    expectNotReady(await refusedWithoutWrites(() => approve(), 'EXECUTION_PROFILE_NOT_READY'));
  });

  it("Q1 control: observeV2('local-branch') under live observe/local-branch with the same evidence reaches DONE", async () => {
    await seedReview(LIVE_OBSERVE, observeV2('local-branch'));
    const result = await approve();
    expect({ status: result.status, deliveryPolicy: result.deliveryPolicy }).toEqual({ status: 'DONE', deliveryPolicy: 'local-branch' });
    expect(listReviewsForTask(h.state, 'task-1').map((r) => r.decision)).toEqual(['approve']);
  });

  it.each<[string, Row]>([
    ['manual-artifact', { manualArtifact: 'docs/handbook.md' }],
    ['merged-pull-request', { mergedPullRequest: 'https://example.test/pr/7' }],
  ])('Q2 a strict %s task is refused even with the attestation supplied, and no label is written', async (live, attestation) => {
    await seedReview({ deliveryPolicy: live }, { ...STRICT_V2, deliveryPolicy: live });
    expectNotReady(await refusedWithoutWrites(() => approve(attestation), 'EXECUTION_PROFILE_NOT_READY'));
    expect(h.state.getTask('task-1')!.deliveryEvidence).toBeUndefined();
  });

  it('Q2 precedence: strictness is refused before an attestation is read', async () => {
    await seedReview(LIVE_LEGACY, STRICT_V2);
    expectNotReady(await refusedWithoutWrites(() => approve({ manualArtifact: 'docs/handbook.md' }), 'EXECUTION_PROFILE_NOT_READY'));
  });

  it('Q2 precedence twin: an observe task keeps the existing attestation INVALID_INPUT', async () => {
    await seedReview(LIVE_LEGACY, observeV2('local-branch'));
    const err = await refusedWithoutWrites(() => approve({ manualArtifact: 'docs/handbook.md' }), 'INVALID_INPUT');
    expect(err.message).toContain('is accepted only under deliveryPolicy manual-artifact');
  });

  it.each(STRICT_SOURCES)('Q3 an environment readiness flag does not lift %s', async (_label, settings, snapshot, extra) => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    await seedReview(settings, snapshot, extra);
    expectNotReady(await refusedWithoutWrites(() => approve(), 'EXECUTION_PROFILE_NOT_READY'));
  });

  it.each(MALFORMED)('Q4 a malformed snapshot (%s) is refused INVALID_INPUT before any write', async (_label, snapshot) => {
    await seedReview(LIVE_LEGACY, snapshot);
    expectInvalid(await refusedWithoutWrites(() => approve(), 'INVALID_INPUT'), 'executionPolicySnapshot');
  });

  it('Q4 a malformed live executionProfile is refused INVALID_INPUT naming the setting', async () => {
    await seedReview({ executionProfile: 'VERIFIED-LOCAL' }, legacyV2('legacy'));
    expectInvalid(await refusedWithoutWrites(() => approve(), 'INVALID_INPUT'), 'executionProfile');
  });
});

describe('CQ-M01f Q5: resolveTaskDeliveryPolicy', () => {
  const resolve = (settings: unknown, snapshot: unknown): unknown =>
    policy.resolveTaskDeliveryPolicy(settings as never, (snapshot === undefined ? {} : { executionPolicySnapshot: snapshot }) as never);

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['LEGACY_V1', LEGACY_V1],
    ['OBSERVE_V1', OBSERVE_V1],
    ["legacyV2('manual-artifact')", legacyV2('manual-artifact')],
    ["observeV2('remote-push')", observeV2('remote-push')],
  ])('returns the LIVE policy, never the captured one, for a %s snapshot', (_label, snapshot) => {
    for (const executionProfile of [undefined, 'legacy', 'observe']) {
      for (const deliveryPolicy of [undefined, 'legacy', 'local-branch', 'merged-pull-request']) {
        const settings = { ...(executionProfile ? { executionProfile } : {}), ...(deliveryPolicy ? { deliveryPolicy } : {}) };
        expect(resolve(settings, snapshot), JSON.stringify(settings)).toBe(deliveryPolicy ?? 'legacy');
      }
    }
    expect(resolve(undefined, snapshot)).toBe('legacy');
    expect(resolve(null, snapshot)).toBe('legacy');
  });

  it.each(STRICT_SOURCES)('throws NOT_READY for %s', (_label, settings, snapshot) => {
    expectNotReady(thrown(() => resolve(settings, snapshot)));
  });

  it.each(MALFORMED)('throws INVALID_INPUT for a malformed snapshot (%s)', (_label, snapshot) => {
    expectInvalid(thrown(() => resolve(LIVE_LEGACY, snapshot)), 'executionPolicySnapshot');
  });

  it('keeps the verbatim INVALID_INPUT for an unrecognised live deliveryPolicy', () => {
    const err = thrown(() => resolve({ deliveryPolicy: 'merged' }, observeV2('legacy')));
    expectInvalid(err, 'deliveryPolicy');
    expect(err.message).toBe(thrown(() => policy.resolveDeliveryPolicy({ deliveryPolicy: 'merged' })).message);
  });

  it('accepts frozen inputs and leaves them unchanged', () => {
    const settings = Object.freeze({ executionProfile: 'observe', deliveryPolicy: 'remote-push' });
    const task = Object.freeze({ executionPolicySnapshot: Object.freeze(observeV2('legacy')) });
    const before = JSON.stringify({ settings, task });
    expect(policy.resolveTaskDeliveryPolicy(settings, task as never)).toBe('remote-push');
    expect(JSON.stringify({ settings, task })).toBe(before);
  });
});

// --- E: the consumers agree ---------------------------------------------------

/** DONE task-P with complete evidence (current candidate cand-P, passing gate run), and task-D waiting on it. */
const prereq = (snapshot: unknown, extra: Row = {}): Row => ({
  id: 'task-P', status: 'DONE', order: 1, planRevision: 1, requiredCheckAtDone: GATE,
  ...(snapshot === undefined ? {} : { executionPolicySnapshot: snapshot }), ...extra,
});
const WAITER: Row = {
  id: 'task-D', status: 'BLOCKED', order: 2, assignedWorkerId: null, blockedFromStatus: 'WORKING',
  blockedOnTaskIds: ['task-P'], blockedAt: STARTED, blockedReason: 'waiting on task-P',
};
const seedDep = (settings: Row, snapshot: unknown, extra: Row = {}, checks: Row[] = [passingRun('check-P', 'cand-P')]): Promise<void> =>
  seed(settings, [prereq(snapshot, extra), WAITER], [candidate('cand-P', 'task-P')], checks);
const taskP = () => h.state.getTask('task-P')!;
const unblock = (): Promise<string[]> => h.state.mutex.runExclusive(() => runDependencyUnblock(h.state, 'task-P'));
const CHECK = 'required-check:node gate.cjs';

/**
 * Every consumer of a DONE task-P whose policy cannot be applied withholds it,
 * read-only (E5): no write, and the stored snapshot and file bytes are unchanged.
 */
async function expectConsumersWithhold(check: (err: MoeError) => void): Promise<void> {
  const file = path.join(h.moePath, 'tasks', 'task-P.json');
  const bytes = fs.readFileSync(file, 'utf8');
  const stored = structuredClone(taskP().executionPolicySnapshot);
  const writes = vi.spyOn(h.state, 'writeEntity');
  check(thrown(() => policy.evaluateDeliveryEvidence(h.state, taskP())));
  check(thrown(() => dependencyShortfall(h.state, 'task-P')));
  expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
  expect(unmetDependsOn(h.state, { dependsOn: ['task-P'] })).toEqual(['task-P']);
  const described = describeUnmetDependency(h.state, 'task-P');
  expect(described.startsWith('task-P [DONE')).toBe(true);
  expect(described).toContain('could not be judged');
  const projection = deliveryProjection(h.state, taskP())!;
  expect(projection.currentCandidate?.id).toBe('cand-P');
  expect(projection.latestCheckRun).toEqual({ command: GATE, exitCode: 0, source: 'runner-observed' });
  expect('requiredCheckSatisfied' in projection).toBe(false);
  expect(writes.mock.calls.length).toBe(0);
  expect(await unblock()).toEqual([]);
  expect(h.state.getTask('task-D')!.status).toBe('BLOCKED');
  expect(taskP().executionPolicySnapshot).toEqual(stored);
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
}

describe('CQ-M01f E: evaluate, the dependency gate and the projection agree', () => {
  it.each(STRICT_SOURCES)('E1 %s: a DONE prerequisite is withheld by every consumer', async (_label, settings, snapshot, extra) => {
    await seedDep(settings, snapshot, extra);
    await expectConsumersWithhold(expectNotReady);
  });

  it("E1 control: observeV2('legacy') under live observe/local-branch with the same evidence satisfies", async () => {
    await seedDep(LIVE_OBSERVE, observeV2('legacy'));
    expect(policy.evaluateDeliveryEvidence(h.state, taskP())).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
    expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, taskP())!.requiredCheckSatisfied).toBe(true);
    expect(await unblock()).toEqual(['task-D']);
    expect(h.state.getTask('task-D')!.status).toBe('WORKING');
  });

  it.each(STRICT_SOURCES)('E2 %s in REVIEW: evaluation throws NOT_READY and the projection omits the verdict', async (_label, settings, snapshot, extra) => {
    await seedDep(settings, snapshot, { ...extra, status: 'REVIEW', requiredCheckAtDone: undefined });
    expectNotReady(thrown(() => policy.evaluateDeliveryEvidence(h.state, taskP())));
    const projection = deliveryProjection(h.state, taskP())!;
    expect(projection.currentCandidate?.id).toBe('cand-P');
    expect('requiredCheckSatisfied' in projection).toBe(false);
  });

  it.each<[string, Row, unknown, string]>([
    ['a null snapshot', LIVE_OBSERVE, null, 'executionPolicySnapshot'],
    ['an extra ready key', LIVE_OBSERVE, { ...STRICT_V2, ready: true }, 'executionPolicySnapshot'],
    ['v2 verified-local without deliveryPolicy', LIVE_OBSERVE, { version: 2, profile: 'verified-local', planRevision: 1 }, 'executionPolicySnapshot'],
    ['an upper-case live executionProfile', { executionProfile: 'VERIFIED-LOCAL', deliveryPolicy: 'local-branch' }, observeV2('legacy'), 'executionProfile'],
  ])('E3 malformed configuration (%s) is INVALID_INPUT and withheld by every consumer', async (_label, settings, snapshot, field) => {
    await seedDep(settings, snapshot);
    await expectConsumersWithhold((err) => expectInvalid(err, field));
  });

  it('E4 compatibility: an ARCHIVED strict prerequisite still satisfies (the existing rule)', async () => {
    await seedDep(LIVE_LEGACY, STRICT_V2, { status: 'ARCHIVED' });
    expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: true, missingEvidence: [] });
    expect(await unblock()).toEqual(['task-D']);
  });
});

// --- L: legacy and observe keep the live rules ----------------------------------

const L_SNAPSHOTS: Array<[string, unknown]> = [
  ['absent', undefined],
  ['LEGACY_V1', LEGACY_V1],
  ['OBSERVE_V1', OBSERVE_V1],
  ["legacyV2('manual-artifact')", legacyV2('manual-artifact')],
  ["observeV2('remote-push')", observeV2('remote-push')],
];
const LEGACY_RESULT = { policy: 'legacy', satisfied: true, missingEvidence: [] };
const owing = (live: string, landing: string[]): Row => ({ policy: live, satisfied: false, missingEvidence: [...landing, CHECK] });

describe('CQ-M01f L: legacy and observe tasks keep the live delivery rules', () => {
  it.each<[string, string | undefined, Row]>([
    ['absent', undefined, LEGACY_RESULT],
    ['legacy', 'legacy', LEGACY_RESULT],
    ['local-branch', 'local-branch', owing('local-branch', [])],
    ['remote-push', 'remote-push', owing('remote-push', ['pushed-completion-commit'])],
    ['merged-pull-request', 'merged-pull-request', owing('merged-pull-request', ['merged-pull-request'])],
    ['manual-artifact', 'manual-artifact', owing('manual-artifact', ['manual-artifact'])],
  ])('L1 live deliveryPolicy %s: every live profile and legacy/observe snapshot gets the snapshot-less result', async (_label, deliveryPolicy, expected) => {
    // An unpushed completion commit this round, the gate owed and no candidate, so no passing run.
    await seed({}, [reviewTask(undefined, { commits: [completion(false)] })]);
    const evaluate = (executionProfile: string | undefined, snapshot: unknown) => {
      h.state.project!.settings = {
        ...GATED, ...(deliveryPolicy ? { deliveryPolicy } : {}), ...(executionProfile ? { executionProfile } : {}),
      } as never;
      const task = { ...h.state.getTask('task-1')!, ...(snapshot === undefined ? {} : { executionPolicySnapshot: snapshot }) };
      return policy.evaluateDeliveryEvidence(h.state, task as never);
    };
    const twin = evaluate(undefined, undefined);
    expect(twin).toEqual(expected);
    for (const executionProfile of [undefined, 'legacy', 'observe']) {
      for (const [label, snapshot] of L_SNAPSHOTS) {
        expect(evaluate(executionProfile, snapshot), `${executionProfile}/${label}`).toEqual(twin);
      }
    }
  });

  describe.each<[string, unknown]>([
    ['absent', undefined],
    ["legacyV2('manual-artifact')", legacyV2('manual-artifact')],
    ['OBSERVE_V1', OBSERVE_V1],
  ])('L2 qa_approve under a %s snapshot (no gate, no candidate: landing evidence only)', (_label, snapshot) => {
    const seedL2 = (deliveryPolicy: string | undefined, commits: Row[]): Promise<void> =>
      seed({ qualityGate: undefined, ...(deliveryPolicy ? { deliveryPolicy } : {}) }, [reviewTask(snapshot, { commits })]);
    const approveL2 = (extra: Row = {}): Promise<Row> => approve({ candidateId: undefined, ...extra });

    it('the live default reaches DONE with the NO-COMPLETION-COMMIT warning and no deliveryPolicy key', async () => {
      await seedL2(undefined, []);
      const result = await approveL2();
      expect(result.status).toBe('DONE');
      expect(String(result.warning).startsWith('NO-COMPLETION-COMMIT: task task-1')).toBe(true);
      expect('deliveryPolicy' in result).toBe(false);
    });

    it.each<[string, Row[], string[]]>([
      ['local-branch', [], ['completion-commit']],
      ['remote-push', [completion(false)], ['pushed-completion-commit']],
      ['merged-pull-request', [], ['merged-pull-request']],
      ['manual-artifact', [], ['manual-artifact']],
    ])('live %s without its evidence is refused DELIVERY_EVIDENCE_MISSING before any write', async (live, commits, missingEvidence) => {
      await seedL2(live, commits);
      const err = await refusedWithoutWrites(() => approveL2(), 'DELIVERY_EVIDENCE_MISSING');
      expect(err.context).toEqual({ taskId: 'task-1', deliveryPolicy: live, missingEvidence });
    });

    it.each<[string, Row[]]>([
      ['local-branch', [completion(false)]],
      ['remote-push', [completion(true)]],
    ])('live %s with its landing evidence reaches DONE', async (live, commits) => {
      await seedL2(live, commits);
      const result = await approveL2();
      expect({ status: result.status, deliveryPolicy: result.deliveryPolicy }).toEqual({ status: 'DONE', deliveryPolicy: live });
      expect(h.state.getTask('task-1')!.deliveryEvidence).toBeUndefined();
    });

    it.each<[string, string, string]>([
      ['merged-pull-request', 'mergedPullRequest', 'https://example.test/pr/7'],
      ['manual-artifact', 'manualArtifact', 'docs/handbook.md'],
    ])('live %s with its attestation reaches DONE labelled NOT verified delivery', async (live, field, reference) => {
      await seedL2(live, []);
      const result = await approveL2({ [field]: reference });
      expect(result.status).toBe('DONE');
      expect(h.state.getTask('task-1')!.deliveryEvidence).toEqual({
        kind: live, reference, verifiedDelivery: false, recordedBy: 'qa-1', recordedAt: expect.any(String),
      });
      expect(String(result.message)).toContain(`(evidence: ${live} attested by qa-1 — NOT verified delivery)`);
    });

    it('manualArtifact under live local-branch keeps the existing INVALID_INPUT', async () => {
      await seedL2('local-branch', [completion(false)]);
      const err = await refusedWithoutWrites(() => approveL2({ manualArtifact: 'docs/handbook.md' }), 'INVALID_INPUT');
      expect(err.message).toContain('is accepted only under deliveryPolicy manual-artifact (this project uses local-branch)');
    });
  });

  const L3_CASES: Array<[string, Row, Row[], string | null]> = [
    ['a padded everyTask gate', {}, [], GATE],
    ['autoCommit false', { autoCommit: false }, [], null],
    ['an epic-final scope with a higher-order sibling', { qualityGateScope: undefined }, [{ id: 'task-2', status: 'PLANNING', order: 5 }], null],
  ];
  it.each(L3_CASES.flatMap(([label, settings, siblings, expected]) => [
    [`${label} (observeV2('local-branch'))`, settings, siblings, expected, observeV2('local-branch')],
    [`${label} (snapshot-less twin)`, settings, siblings, expected, undefined],
  ] as Array<[string, Row, Row[], string | null, unknown]>))('L3 requiredCheckAtDone for %s is the live rule', async (_label, settings, siblings, expected, snapshot) => {
    await seed(
      { ...LIVE_LEGACY, qualityGate: `  ${GATE}  `, ...settings },
      [reviewTask(snapshot), ...siblings], [candidate('cand-1', 'task-1')], [passingRun('check-1', 'cand-1')],
    );
    expect((await approve()).status).toBe('DONE');
    expect(h.state.getTask('task-1')!.requiredCheckAtDone).toBe(expected);
  });

  it("L4 a DONE legacyV2('local-branch') prerequisite under live legacy satisfies with no projection verdict", async () => {
    await seedDep(LIVE_LEGACY, legacyV2('local-branch'), {}, []);
    expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: true, missingEvidence: [] });
    expect('requiredCheckSatisfied' in deliveryProjection(h.state, taskP())!).toBe(false);
  });

  it('L4 under live observe/local-branch the check is owed until a runner-observed pass is recorded', async () => {
    await seedDep(LIVE_OBSERVE, legacyV2('local-branch'), {}, []);
    expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: false, missingEvidence: [CHECK] });
    expect(deliveryProjection(h.state, taskP())!.requiredCheckSatisfied).toBe(false);
    await recordCheckRun(h.state, {
      candidateId: 'cand-P', treeSha: TREE, command: GATE, exitCode: 0, outputTail: 'gate ok', runnerId: 'runner-1', source: 'runner-observed',
    });
    expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, taskP())!.requiredCheckSatisfied).toBe(true);
  });
});

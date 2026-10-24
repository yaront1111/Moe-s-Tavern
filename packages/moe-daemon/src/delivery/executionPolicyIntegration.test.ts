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

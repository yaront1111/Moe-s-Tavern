// =============================================================================
// Revision-bound QA review (CQ-V06).
//
// Real tool handlers drive a task to REVIEW under legacy (claim admission refuses
// a strict claim): a producer attempt (gen1) records two candidates and lands,
// then a QA attempt (gen2) claims and reads context. The loaded settings then flip
// to verified-local in memory, as the CQ-F12 e2e does. verified-local stays
// unavailable: an approval that passes the binding is still refused
// EXECUTION_PROFILE_NOT_READY. Only Q5 stubs readiness, to reach the shared
// delivery policy's strict check binding.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { getContextTool } from '../tools/getContext.js';
import { startStepTool } from '../tools/startStep.js';
import { completeStepTool } from '../tools/completeStep.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { recordCandidateTool } from '../tools/recordCandidate.js';
import { finalizeAttemptTool } from '../tools/finalizeAttempt.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { qaRejectTool } from '../tools/qaReject.js';
import { recordCheckDispatchTool } from '../tools/recordCheckDispatch.js';
import { recordCheckObservationTool } from '../tools/recordCheckObservation.js';
import { getCandidate } from '../state/candidateStore.js';
import { getAttempt } from '../state/attemptStore.js';
import { listReviewsForTask } from '../state/reviewStore.js';
import { MoeError } from '../util/errors.js';
import * as executionProfile from './executionProfile.js';
import { evaluateDeliveryEvidence, requiredCheckToken } from './policy.js';
import { assertReviewedCandidateCurrent } from './reviewBinding.js';

const TASK = 'task-1';
const RUNNER = { processStartedAt: '4242@2026-10-30T00:00:00.0000000Z', host: 'box-1' };
const CHANNEL = { runner: { runnerId: 'runner-0123456789abcdef' } };
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const GATE = 'npm run gate';
const DIRS = ['tasks', 'attempts', 'candidates', 'reviews', 'messages'];
type Ids = { workerId: string; attemptId: string; generation: number; sessionId: string };

const h = new ToolTestHarness();
const task = () => h.state.getTask(TASK)!;
const settings = () => h.state.project!.settings as unknown as Record<string, unknown>;
const strict = () => { settings().executionProfile = 'verified-local'; };
/** An approved plan revision `n`, as a re-approval leaves it. */
const revise = (n: number) => h.state.tasks.set(TASK, { ...task(), planRevision: n, approvedPlanRevision: n });
const approve = (args: Record<string, unknown>) => qaApproveTool(h.state).handler({ taskId: TASK, summary: 'verified', ...args }, h.state);
const reject = (args: Record<string, unknown>) => qaRejectTool(h.state).handler({ taskId: TASK, reason: 'step-1 broke', ...args }, h.state);
const serve = (id: Ids) => getContextTool(h.state).handler({ taskId: TASK, workerId: id.workerId, sessionId: id.sessionId }, h.state);

beforeEach(() => {
  for (const key of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(key, '');
  h.init(); h.setupMoeFolder({ schemaVersion: 6 }); h.createEpic();
});
afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

async function claim(workerId: string, sessionId: string, status: 'WORKING' | 'REVIEW'): Promise<Ids> {
  const r = (await claimNextTaskTool(h.state).handler({ workerId, statuses: [status], taskId: TASK, ...RUNNER }, h.state)) as
    { attemptId: string; generation: number };
  return { workerId, attemptId: r.attemptId, generation: r.generation, sessionId };
}

/** Legacy to REVIEW: the producer (gen1) records cand-old then cand-new and lands; QA (gen2) claims and reads. */
async function toReview(): Promise<{ w: Ids; q: Ids }> {
  h.createTask({ id: TASK, status: 'PLANNING' });
  await h.state.load();
  await submitPlanTool(h.state).handler({ taskId: TASK, steps: [{ description: 'only', affectedFiles: ['file.ts'] }] }, h.state);
  await h.state.runExclusive(() => h.state.approveTask(TASK, 1));
  const w = await claim('worker-w', 'worker-w@session-w', 'WORKING');
  await serve(w);
  await startStepTool(h.state).handler({ taskId: TASK, stepId: 'step-1', ...w }, h.state);
  await completeStepTool(h.state).handler({ taskId: TASK, stepId: 'step-1', modifiedFiles: ['file.ts'], ...w }, h.state);
  for (const [id, tree] of [['cand-old', 'a'], ['cand-new', 'b']]) {
    await recordCandidateTool(h.state).handler({ id, taskId: TASK, attemptId: w.attemptId, generation: w.generation, workerId: w.workerId,
      baseRevision: '0'.repeat(40), treeSha: tree.repeat(40), deliveryTarget: 'refs/heads/moe/work' }, h.state);
    // createdAt has millisecond resolution and a tie sorts by id, which puts 'cand-new' first: keep the two on different milliseconds.
    const createdAt = Date.parse(getCandidate(h.state, id)!.createdAt);
    while (Date.now() <= createdAt) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await completeTaskTool(h.state).handler({ taskId: TASK, verification: { command: 'npm test', exitCode: 0 }, ...w }, h.state);
  await finalizeAttemptTool(h.state).handler({ taskId: TASK, workerId: w.workerId, runnerId: w.workerId, attemptId: w.attemptId,
    generation: w.generation, outcome: 'landed', landedRevision: 'c'.repeat(40) }, h.state);
  const q = await claim('qa-q', 'qa-q@session-q', 'REVIEW');
  await serve(q);
  return { w, q };
}

function bytes(): Record<string, string> {
  return Object.fromEntries(DIRS.flatMap((dir) => {
    const root = path.join(h.moePath, dir);
    if (!fs.existsSync(root)) return [];
    return (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(root, f)).isFile())
      .map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(root, f), 'utf8')]);
  }));
}
/** Refused with `codeName`, and nothing written: no file, no Review, no task field. */
async function refused(call: () => Promise<unknown>, codeName: string): Promise<MoeError> {
  const before = bytes();
  const row = structuredClone(task());
  const err = await call().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(MoeError);
  expect((err as MoeError).codeName).toBe(codeName);
  expect(bytes()).toEqual(before);
  expect(task()).toEqual(row);
  expect(listReviewsForTask(h.state, TASK)).toEqual([]);
  return err as MoeError;
}

describe('Q1 strict qa_approve fences QA\'s own attempt (DoD 2)', () => {
  it('refuses a missing identity, the producer\'s attempt and an unread session, then reaches readiness', async () => {
    const { w, q } = await toReview();
    strict();
    const missing = await refused(() => approve({ workerId: q.workerId, candidateId: 'cand-new' }), 'STEP_ENTRY_IDENTITY_REQUIRED');
    expect(missing.context?.missing).toEqual(['attemptId', 'generation', 'sessionId']);
    const human = await refused(() => approve({ candidateId: 'cand-new' }), 'STEP_ENTRY_IDENTITY_REQUIRED');
    expect(human.context?.missing).toEqual(['workerId', 'attemptId', 'generation', 'sessionId']);
    await refused(() => approve({ ...q, attemptId: w.attemptId, generation: w.generation, candidateId: 'cand-new' }), 'ATTEMPT_SUPERSEDED');
    const stale = await refused(() => approve({ ...q, sessionId: 'qa-q@never-read', candidateId: 'cand-new' }), 'CONTEXT_RECEIPT_STALE');
    expect(stale.context?.stale).toEqual(['sessionId']);
    await refused(() => approve({ ...q, candidateId: 'cand-new' }), 'EXECUTION_PROFILE_NOT_READY');
    // Provenance: the candidate keeps its producer, gen1; the reviewer is gen2.
    expect(getCandidate(h.state, 'cand-new')?.attemptId).toBe(w.attemptId);
    expect([w.generation, q.generation, getAttempt(h.state, q.attemptId)?.workerId]).toEqual([1, 2, 'qa-q']);
  });
});

describe('Q2 strict qa_approve refuses stale bindings (DoD 1)', () => {
  it('refuses an omitted and a superseded candidate', async () => {
    const { q } = await toReview();
    strict();
    const required = await refused(() => approve({ ...q }), 'REVIEWED_CANDIDATE_REQUIRED');
    expect(required.context).toEqual({ taskId: TASK, currentCandidateId: 'cand-new' });
    await refused(() => approve({ ...q, candidateId: null }), 'REVIEWED_CANDIDATE_REQUIRED');
    await refused(() => approve({ ...q, candidateId: 'cand-old' }), 'CANDIDATE_MISMATCH');
  });

  it('refuses a candidate produced under another plan revision, read from the producer attempt', async () => {
    const { q } = await toReview();
    strict();
    revise(2);
    await serve(q);
    const err = await refused(() => approve({ ...q, candidateId: 'cand-new' }), 'CANDIDATE_REVISION_STALE');
    expect(err.context).toEqual({ taskId: TASK, candidateId: 'cand-new', candidateRevision: 1, planRevision: 2 });
  });

  it.each([
    ['its producer attempt is missing', (w: Ids) => {
      h.state.candidates.set('cand-new', { ...getCandidate(h.state, 'cand-new')!, attemptId: 'attempt-gone' });
      void w;
    }],
    ['its producer attempt has no snapshot', (w: Ids) => {
      const { executionPolicySnapshot: _dropped, ...rest } = h.state.attempts.get(w.attemptId)!;
      h.state.attempts.set(w.attemptId, rest);
    }],
    ['its producer snapshot is malformed', (w: Ids) => {
      h.state.attempts.set(w.attemptId, { ...h.state.attempts.get(w.attemptId)!, executionPolicySnapshot: { version: 9 } as never });
    }],
  ])('fails closed with candidateRevision null when %s', async (_label, damage) => {
    const { w } = await toReview();
    expect(assertReviewedCandidateCurrent(h.state, task(), 'cand-new', 1)).toBeUndefined();
    damage(w);
    const err = (() => { try { assertReviewedCandidateCurrent(h.state, task(), 'cand-new', 1); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(MoeError);
    expect([(err as MoeError).codeName, (err as MoeError).context]).toEqual(
      ['CANDIDATE_REVISION_STALE', { taskId: TASK, candidateId: 'cand-new', candidateRevision: null, planRevision: 1 }]);
  });
});

describe('Q3 strict qa_reject', () => {
  it('fences identity and a superseded candidate, but rejects a stale-revision candidate', async () => {
    const { w, q } = await toReview();
    strict();
    await refused(() => reject({ workerId: q.workerId, candidateId: 'cand-new' }), 'STEP_ENTRY_IDENTITY_REQUIRED');
    await refused(() => reject({ ...q, attemptId: w.attemptId, generation: w.generation, candidateId: 'cand-new' }), 'ATTEMPT_SUPERSEDED');
    await refused(() => reject({ ...q }), 'REVIEWED_CANDIDATE_REQUIRED');
    await refused(() => reject({ ...q, candidateId: 'cand-old' }), 'CANDIDATE_MISMATCH');
    revise(2);
    await serve(q);
    await expect(reject({ ...q, candidateId: 'cand-new' })).resolves.toMatchObject({ success: true, status: 'WORKING' });
    expect(listReviewsForTask(h.state, TASK)).toEqual([
      expect.objectContaining({ candidateId: 'cand-new', reviewerId: 'qa-q', decision: 'reject' })]);
  });
});

describe('Q4 legacy and observe keep today\'s omission behavior (DoD 3)', () => {
  const unbound = (tool: string) => `NO-REVIEWED-CANDIDATE: task ${TASK} has current candidate cand-new but ${tool} named none — ` +
    'pass candidateId so the decision is bound to the bytes you actually read';

  it.each(['legacy', 'observe'])('%s approves with no identity and no candidateId, even across a revision', async (profile) => {
    const { q } = await toReview();
    if (profile === 'observe') settings().executionProfile = 'observe';
    revise(2);
    const r = (await approve({ workerId: q.workerId })) as { status: string; warnings: string[] };
    expect(r.status).toBe('DONE');
    expect(r.warnings).toContain(unbound('qa_approve'));
    expect(listReviewsForTask(h.state, TASK)).toEqual([expect.objectContaining({ candidateId: 'cand-new', decision: 'approve' })]);
  });

  it.each(['legacy', 'observe'])('%s rejects with no identity and no candidateId', async (profile) => {
    const { q } = await toReview();
    if (profile === 'observe') settings().executionProfile = 'observe';
    const r = (await reject({ workerId: q.workerId })) as { status: string; warnings?: string[] };
    expect([r.status, r.warnings]).toEqual(['WORKING', [unbound('qa_reject')]]);
  });
});

describe('Q5 the shared delivery policy binds a strict required-check run to the approved revision (DoD 1)', () => {
  async function pass(): Promise<void> {
    const { dispatch } = (await recordCheckDispatchTool(h.state).handler({ id: `dispatch-${task().planRevision}`, taskId: TASK,
      candidateId: 'cand-new', planRevision: task().planRevision, command: GATE, environment: ENV }, h.state, CHANNEL)) as
      { dispatch: { id: string } };
    await recordCheckObservationTool(h.state).handler({ id: `run-${dispatch.id}`, dispatchId: dispatch.id, exitCode: 0,
      outcome: 'passed', environment: ENV }, h.state, CHANNEL);
  }
  const owesGate = () => evaluateDeliveryEvidence(h.state, task()).missingEvidence.includes(requiredCheckToken(GATE));

  it('counts a passing run only at the approved revision under strict, and at any revision under legacy', async () => {
    await toReview();
    // Test-only stand-in for a future certified readiness gate (precedent: server/planApproval.test.ts).
    vi.spyOn(executionProfile, 'assertExecutionProfileReady').mockImplementation(() => {});
    Object.assign(settings(), { deliveryPolicy: 'local-branch', qualityGate: GATE, qualityGateScope: 'everyTask', checkEnvironments: [ENV] });
    strict();
    expect(owesGate()).toBe(true);
    await pass();
    expect(owesGate()).toBe(false);
    revise(2);
    expect(owesGate()).toBe(true);
    delete settings().executionProfile;
    expect(owesGate()).toBe(false);
    strict();
    await pass();
    expect(owesGate()).toBe(false);
  });
});

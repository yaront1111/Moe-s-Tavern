import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { RUNNER_KEY_HEADER, authenticateRunner, ensureRunnerKey } from '../server/runnerChannel.js';
import * as executionProfile from '../delivery/executionProfile.js';
import { deliveryEvidenceRefusal, describeMissingEvidence } from '../delivery/policy.js';
import { dependencyEvidenceRefusal } from '../util/claimGuards.js';
import { invalidInput, MoeErrorCode, type MoeError } from '../util/errors.js';
import { createMcpCaller, McpCallError, type McpCaller } from './mcpCall.js';

// =============================================================================
// CQ-V12a: delivery bypass acceptance, through the real MCP registry.
//
// One strict (verified-local) scenario, A0, approves. Every other case is A0
// with exactly ONE defect: forged, stale, missing, target-raced or replayed
// evidence, and each must leave qa_approve (or a strict consumer's claim)
// refused with the exact codeName and tokens. Every call goes through
// createMcpCaller: `call` is /mcp, `runnerCall` carries the identity
// authenticateRunner derives from a temp host key (the dispatch /runner uses),
// and W1 drives the real /runner WebSocket. Readiness is spied in THIS file
// only; P0 pins that production still refuses verified-local.
// =============================================================================

const h = new ToolTestHarness();
type Call = McpCaller['call'];
type Ids = { workerId: string; attemptId: string; generation: number; sessionId: string };

const TASK = 'task-1';
const CONSUMER = 'task-2';
const GATE = 'npm run gate';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const OWED = [`required-check:${GATE}`];
const SUMMARY = 'verified DoD; re-ran the gate';
const RUNNER = { processStartedAt: '4242@2026-10-30T00:00:00.0000000Z', host: 'box-1' };
const STRICT_SNAPSHOT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' } as const;
const sha = (c: string) => c.repeat(40);

let call: Call;
let runnerCall: Call;
let adapter: McpAdapter;
let runnerId = '';
let key = '';
let seq = 0;

const stubRequest = (values: string[]) =>
  ({ socket: { remoteAddress: '127.0.0.1' }, headersDistinct: { [RUNNER_KEY_HEADER]: values } }) as unknown as IncomingMessage;

/** Both callers over one adapter; the runner identity comes only from authenticateRunner over the temp host key. */
function callers(): void {
  const runner = authenticateRunner(stubRequest([key]), h.state.projectPath);
  expect(runner?.runnerId).toMatch(/^runner-[0-9a-f]{16}$/);
  runnerId = runner!.runnerId;
  adapter = new McpAdapter(h.state);
  call = createMcpCaller(h.state, adapter).call;
  runnerCall = createMcpCaller(h.state, adapter, { runner: runner! }).call;
}

/** The validated path refuses verified-local; only then is readiness spied and the loaded profile flipped in memory. */
async function strictInMemory(): Promise<void> {
  const refused = await h.state.updateSettings({ executionProfile: 'verified-local' }).then(() => 'resolved', (e: MoeError) => e.codeName);
  expect(refused).toBe('EXECUTION_PROFILE_NOT_READY');
  vi.spyOn(executionProfile, 'assertExecutionProfileReady').mockImplementation(() => {});
  h.state.project!.settings.executionProfile = 'verified-local';
}

beforeEach(async () => {
  for (const name of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(name, '');
  h.init();
  vi.stubEnv('MOE_RUNNER_KEY_DIR', path.join(h.testDir, 'runner-keys'));
  h.setupMoeFolder({ schemaVersion: 6, settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '',
    commitPattern: '', agentCommand: 'claude', deliveryPolicy: 'local-branch', qualityGate: GATE, qualityGateScope: 'everyTask',
    checkEnvironments: [ENV] } as never });
  h.createEpic();
  h.createTask({ id: TASK, status: 'PLANNING' });
  h.createTask({ id: CONSUMER, status: 'WORKING', dependsOn: [TASK], planRevision: 1, approvedPlanRevision: 1,
    executionPolicySnapshot: STRICT_SNAPSHOT, implementationPlan: [{ stepId: 'step-1', description: 'use it', status: 'PENDING', affectedFiles: [] }] });
  await h.state.load();
  await strictInMemory();
  key = fs.readFileSync(await ensureRunnerKey(h.state.projectPath), 'utf8');
  seq = 0;
  callers();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); h.state.clearEmitter(); h.cleanup(); });

async function claim(workerId: string, status: 'WORKING' | 'REVIEW'): Promise<Ids> {
  const r = (await call('moe.claim_next_task', { workerId, statuses: [status], taskId: TASK, ...RUNNER })) as { attemptId: string; generation: number };
  const ids = { workerId, attemptId: r.attemptId, generation: r.generation, sessionId: `${workerId}@session` };
  await call('moe.get_context', { taskId: TASK, workerId, sessionId: ids.sessionId });
  return ids;
}

/**
 * The strict producer: plan, one step, a candidate per tree (the last is current; `between` runs after the
 * first), completion, the wrapper's landing record, the runner's finalize. Ends with QA claimed and read.
 */
async function toReview(trees = ['a'], between?: () => Promise<unknown>): Promise<Ids> {
  await call('moe.submit_plan', { taskId: TASK, steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }] });
  const w = await claim('worker-w', 'WORKING');
  await call('moe.start_step', { taskId: TASK, stepId: 'step-1', ...w });
  await call('moe.complete_step', { taskId: TASK, stepId: 'step-1', modifiedFiles: ['file.ts'], ...w });
  for (const [i, tree] of trees.entries()) {
    await call('moe.record_candidate', { id: `cand-${tree}`, taskId: TASK, attemptId: w.attemptId, generation: w.generation,
      workerId: w.workerId, baseRevision: sha('0'), treeSha: sha(tree), deliveryTarget: 'refs/heads/moe/work' });
    if (i === 0) await between?.();
  }
  await call('moe.complete_task', { taskId: TASK, verification: { command: GATE, exitCode: 0 }, ...w });
  await call('moe.record_commit', { taskId: TASK, outcome: 'committed', kind: 'completion', sha: sha('c'), treeId: sha(trees.at(-1)!),
    ref: 'moe/work', role: 'worker', sessionId: `${w.workerId}@unknown`, workerId: w.workerId, paths: ['file.ts'] });
  await call('moe.finalize_attempt', { taskId: TASK, workerId: w.workerId, runnerId: w.workerId, attemptId: w.attemptId,
    generation: w.generation, outcome: 'landed', landedRevision: sha('c') });
  expect(h.state.getTask(TASK)).toMatchObject({ status: 'REVIEW', executionPolicySnapshot: { profile: 'verified-local' } });
  return claim('qa-q', 'REVIEW');
}

const dispatch = (candidateId: string, via = runnerCall) => via('moe.record_check_dispatch', { id: `dispatch-${++seq}`, taskId: TASK,
  candidateId, planRevision: 1, command: GATE, environment: ENV }) as Promise<{ dispatch: { id: string } }>;
const observe = (dispatchId: string, outcome = 'passed', extra: Record<string, unknown> = {}, via = runnerCall) =>
  via('moe.record_check_observation', { id: `run-${dispatchId}`, dispatchId, exitCode: 0, outcome, environment: ENV, ...extra }) as
    Promise<{ repair?: Record<string, unknown> }>;
/** The runner's evidence: a dispatch on `candidateId`, then its observed result. */
const pass = async (candidateId = 'cand-a', outcome = 'passed') => observe((await dispatch(candidateId)).dispatch.id, outcome);
const approve = (q: Ids, candidateId = 'cand-a') => call('moe.qa_approve', { taskId: TASK, summary: SUMMARY, ...q, candidateId });

const files = (dir: string) => { const d = path.join(h.moePath, dir); return fs.existsSync(d) ? (fs.readdirSync(d, { recursive: true }) as string[]).sort() : []; };
const taskBytes = () => fs.readFileSync(path.join(h.moePath, 'tasks', `${TASK}.json`), 'utf8');
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e) as Promise<McpCallError | null>;

/** qa_approve is refused with exactly `codeName` (and, from the evidence gate, exactly `tokens`), moving not one byte. */
async function refusedApproval(q: Ids, codeName: string, tokens?: string[], args: Partial<Ids> & { candidateId?: string } = {}): Promise<void> {
  const before = [taskBytes(), files('reviews')];
  const err = await failure(call('moe.qa_approve', { taskId: TASK, summary: SUMMARY, ...q, candidateId: 'cand-a', ...args }));
  expect(err).toBeInstanceOf(McpCallError);
  expect(err!.codeName).toBe(codeName);
  if (tokens) expect(err!.message).toBe(deliveryEvidenceRefusal(TASK, { policy: 'local-branch', satisfied: false, missingEvidence: tokens }, true).message);
  expect([taskBytes(), files('reviews')]).toEqual(before);
  expect(h.state.getTask(TASK)!.status).toBe('REVIEW');
}

/** A strict consumer's explicit claim of CONSUMER (dependsOn TASK). */
const consumerClaim = () => call('moe.claim_next_task', { workerId: 'worker-c', statuses: ['WORKING'], taskId: CONSUMER, ...RUNNER });
/** A0's approval, to DONE: the prerequisite every consumer case builds on. */
async function approvedPrerequisite(trees = ['a'], beforeEvidence?: (q: Ids) => Promise<void>): Promise<void> {
  const q = await toReview(trees);
  await beforeEvidence?.(q);
  await pass(`cand-${trees.at(-1)}`);
  await approve(q, `cand-${trees.at(-1)}`);
  expect(h.state.getTask(TASK)!.status).toBe('DONE');
}

describe('CQ-V12a delivery bypass fixtures (strict task, through McpAdapter)', () => {
  it('P0: production readiness still refuses verified-local once the spy is restored', () => {
    vi.mocked(executionProfile.assertExecutionProfileReady).mockRestore();
    const err = (() => { try { executionProfile.assertExecutionProfileReady('verified-local'); return null; } catch (e) { return e as MoeError; } })();
    expect(err?.codeName).toBe('EXECUTION_PROFILE_NOT_READY');
  });

  it('A0: the unmodified strict scenario approves (positive control)', async () => {
    const q = await toReview();
    expect(await pass()).toMatchObject({ repair: { action: 'none', reason: 'passed' } });
    expect(await approve(q)).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
    expect(files('reviews')).toHaveLength(1);
  });

  describe('forgery (DoD 1)', () => {
    it('F1: a /mcp record_check_run claiming runner-observed, with the real runnerId and dispatchId, is recorded but never evidence', async () => {
      const q = await toReview();
      const { dispatch: d } = await dispatch('cand-a');
      await expect(call('moe.record_check_run', { id: 'run-forged', candidateId: 'cand-a', treeSha: sha('a'), command: GATE, exitCode: 0,
        outcome: 'passed', planRevision: 1, environment: ENV, runnerId, source: 'runner-observed', dispatchId: d.id }))
        .resolves.toMatchObject({ success: true, duplicate: false });
      await refusedApproval(q, 'DELIVERY_EVIDENCE_MISSING', OWED);
    });

    it('F2: dispatch and observation without the /runner context are refused before anything is written', async () => {
      const q = await toReview();
      for (const attempt of [dispatch('cand-a', call), observe('dispatch-1', 'passed', {}, call)]) {
        const err = await failure(attempt);
        expect([err?.code, err?.codeName]).toEqual([MoeErrorCode.NOT_ALLOWED, 'RUNNER_CHANNEL_REQUIRED']);
      }
      expect(files('checks')).toEqual([]);
      await refusedApproval(q, 'DELIVERY_EVIDENCE_MISSING', OWED);
    });

    it.each([
      ['runnerId', () => runnerId], ['source', () => 'runner-observed'], ['candidateId', () => 'cand-a'],
      ['treeSha', () => sha('a')], ['planRevision', () => 1],
    ])('F3: an observation carrying %s is refused by name and records nothing', async (field, value) => {
      const q = await toReview();
      const { dispatch: d } = await dispatch('cand-a');
      const err = await failure(observe(d.id, 'passed', { [field]: value() }));
      expect([err?.codeName, err?.message]).toEqual(['INVALID_INPUT', invalidInput(field, 'is not a supported check observation field').message]);
      expect(files('checks')).toEqual(['dispatches', `dispatches/${d.id}.json`]);
      await refusedApproval(q, 'DELIVERY_EVIDENCE_MISSING', OWED);
    });
  });

  describe('stale (DoD 2)', () => {
    it('S1/M2: a pass on a superseded candidate (the tree moved after an exit-0 run) never covers the current one', async () => {
      const q = await toReview(['a', 'b'], () => pass('cand-a'));
      await refusedApproval(q, 'DELIVERY_EVIDENCE_MISSING', OWED, { candidateId: 'cand-b' });
      await refusedApproval(q, 'CANDIDATE_MISMATCH', undefined, { candidateId: 'cand-a' });
    });

    it('S2: after a re-approval to revision 2, QA cannot approve the revision-1 candidate and its pass', async () => {
      const q = await toReview();
      await pass();
      h.state.tasks.set(TASK, { ...h.state.getTask(TASK)!, planRevision: 2, approvedPlanRevision: 2 });
      await call('moe.get_context', { taskId: TASK, workerId: q.workerId, sessionId: q.sessionId });
      await refusedApproval(q, 'CANDIDATE_REVISION_STALE');
    });

    it('S2: a DONE prerequisite re-approved to revision 2 does not release a strict consumer on its revision-1 pass', async () => {
      await approvedPrerequisite();
      h.state.tasks.set(TASK, { ...h.state.getTask(TASK)!, planRevision: 2, approvedPlanRevision: 2 });
      const err = await failure(consumerClaim());
      expect([err?.codeName, err?.message]).toEqual(['DEPENDENCY_EVIDENCE_MISSING', dependencyEvidenceRefusal({ taskId: CONSUMER,
        prerequisiteTaskId: TASK, missing: OWED.map((token) => ({ token, reason: describeMissingEvidence(token) })) }).message]);
    });

    it('S3: a sessionId with no served-context receipt is CONTEXT_RECEIPT_STALE', async () => {
      const q = await toReview();
      await pass();
      await refusedApproval(q, 'CONTEXT_RECEIPT_STALE', undefined, { sessionId: 'qa-q@never-read' });
    });
  });
});

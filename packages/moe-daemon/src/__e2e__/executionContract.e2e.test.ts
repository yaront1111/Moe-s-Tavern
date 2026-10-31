// =============================================================================
// Revision-bound execution contract, end to end (CQ-F12).
//
// Real tool handlers only: a plan submitted and token-approved, a legacy claim,
// served context, daemon restarts with reattach, a reassignment, and the
// legacy-to-strict cutover an operator can only make by hand-editing
// project.json (the validated settings path refuses verified-local, and claim
// admission refuses a strict claim). Per-tool refusal matrices live in
// startStepAuthorization.test.ts and completionAuthorization.test.ts; this file
// proves the pieces compose. verified-local stays unavailable throughout:
// complete_task is refused EXECUTION_PROFILE_NOT_READY, never enabled.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { getContextTool } from '../tools/getContext.js';
import { startStepTool } from '../tools/startStep.js';
import { completeStepTool } from '../tools/completeStep.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { reattachAttemptTool } from '../tools/reattachAttempt.js';
import { releaseTaskTool } from '../tools/releaseTask.js';
import { recordCandidateTool } from '../tools/recordCandidate.js';
import { finalizeAttemptTool } from '../tools/finalizeAttempt.js';
import { recordCheckRunTool } from '../tools/recordCheckRun.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { listCandidatesForAttempt } from '../state/candidateStore.js';
import { listReviewsForTask } from '../state/reviewStore.js';
import { getAttempt, reconcileRunningAttempts } from '../state/attemptStore.js';
import type { MoeError } from '../util/errors.js';

const TASK = 'task-1';
const RUNNER = { processStartedAt: '4242@2026-10-26T00:00:00.0000000Z', host: 'box-1' };
type Ids = { workerId: string; attemptId: string; generation: number; sessionId: string };
type Served = { planRevision: number; approvedPlanRevision: number | null; attemptId: string | null; generation: number | null; receiptStatus: string };

describe('execution contract E2E (CQ-F12)', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    for (const key of ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID']) vi.stubEnv(key, '');
    h.init(); h.setupMoeFolder({ schemaVersion: 6 }); h.createEpic();
  });

  afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  const task = () => h.state.getTask(TASK)!;
  const attempt = (id: Ids) => getAttempt(h.state, id.attemptId)!;
  const evidence = (id: Ids) => attempt(id).stepCompletions?.map((e) => [e.stepId, e.planRevision]);

  /** A PLANNING row, a two-step plan (planRevision 1), and a human approval carrying the rendered revision. */
  async function boot(): Promise<void> {
    h.createTask({ id: TASK, status: 'PLANNING' });
    await h.state.load();
    await submitPlanTool(h.state).handler({ taskId: TASK, steps: [
      { description: 'first', affectedFiles: ['file.ts'] }, { description: 'second', affectedFiles: ['file.ts'] },
    ] }, h.state);
    expect(task()).toMatchObject({ status: 'AWAITING_APPROVAL', planRevision: 1 });
    await h.state.runExclusive(() => h.state.approveTask(TASK, 1));
    expect(task()).toMatchObject({ status: 'WORKING', planRevision: 1, approvedPlanRevision: 1 });
  }
  /** A real claim by a wrapper-launched seat; the session id is the one its get_context reads present. */
  async function claim(workerId: string, sessionId: string): Promise<Ids> {
    const r = (await claimNextTaskTool(h.state).handler(
      { workerId, statuses: ['WORKING'], taskId: TASK, ...RUNNER }, h.state)) as Record<string, unknown>;
    expect(r.hasNext).toBe(true);
    return { workerId, attemptId: String(r.attemptId), generation: Number(r.generation), sessionId };
  }
  async function serve(id: Pick<Ids, 'workerId' | 'sessionId'>): Promise<Served> {
    const r = (await getContextTool(h.state).handler({ taskId: TASK, ...id }, h.state)) as { servedContext: Served };
    return r.servedContext;
  }
  const start = (id: Ids, stepId: string) => startStepTool(h.state).handler({ taskId: TASK, stepId, ...id }, h.state);
  const step = (id: Ids, stepId: string) => completeStepTool(h.state).handler({ taskId: TASK, stepId, modifiedFiles: ['file.ts'], ...id }, h.state);
  const done = (id: Ids) => completeTaskTool(h.state).handler(
    { taskId: TASK, verification: { command: 'npm test', exitCode: 0 }, ...id }, h.state);
  const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: MoeError) => e.codeName);

  /** index.ts's startup order: load, park running attempts whose seat holds its task, purge workers. */
  async function restartDaemon(): Promise<void> {
    h.state.clearEmitter();
    h.state = new StateManager({ projectPath: h.testDir });
    await h.state.load();
    await h.state.runExclusive(() => reconcileRunningAttempts(h.state));
    await h.state.purgeAllWorkers();
  }
  const reattach = (id: Ids) => reattachAttemptTool(h.state).handler(
    { taskId: TASK, workerId: id.workerId, runnerId: id.workerId, attemptId: id.attemptId, generation: id.generation, ...RUNNER }, h.state);
  /** The validated path refuses verified-local; an operator's hand edit of project.json is the only way in. */
  async function cutover(): Promise<void> {
    expect(await codeOf(h.state.updateSettings({ executionProfile: 'verified-local' }))).toBe('EXECUTION_PROFILE_NOT_READY');
    const file = path.join(h.moePath, 'project.json');
    const project = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...project, settings: { ...project.settings, executionProfile: 'verified-local' } }));
    await restartDaemon();
  }
  /** Scenario A proves the restart path; later cases flip the loaded settings in memory. */
  async function strictInMemory(): Promise<void> {
    expect(await codeOf(h.state.updateSettings({ executionProfile: 'verified-local' }))).toBe('EXECUTION_PROFILE_NOT_READY');
    h.state.project!.settings.executionProfile = 'verified-local';
  }
  const bytes = () => Object.fromEntries(['tasks', 'attempts'].flatMap((dir) =>
    fs.readdirSync(path.join(h.moePath, dir)).map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(h.moePath, dir, f), 'utf8')])));
  /** Refused with codeName and nothing written. */
  async function refused(call: () => Promise<unknown>, codeName: string): Promise<MoeError> {
    const before = bytes();
    const err = (await call().then(() => null, (e: MoeError) => e))!;
    expect(err).toMatchObject({ codeName });
    expect(bytes()).toEqual(before);
    return err;
  }

  it('DoD2: one served-context receipt carries execution-only progress across restarts and the strict cutover', async () => {
    await boot();
    const w = await claim('worker-w', 'worker-w@session-1');
    expect(await serve(w)).toMatchObject({ receiptStatus: 'recorded', planRevision: 1, approvedPlanRevision: 1, attemptId: w.attemptId, generation: 1 });
    const receipt = attempt(w).contextReceipt;
    expect(receipt).toMatchObject({ sessionId: w.sessionId, planRevision: 1, approvedPlanRevision: 1 });
    const unchanged = () => {
      expect(task()).toMatchObject({ planRevision: 1, approvedPlanRevision: 1 });
      expect(attempt(w).contextReceipt).toEqual(receipt);
    };

    await cutover();
    expect(await codeOf(start(w, 'step-1'))).toBe('ATTEMPT_NOT_RUNNING');
    await reattach(w);
    await start(w, 'step-1'); unchanged();
    await step(w, 'step-1'); unchanged();

    await restartDaemon();
    expect(await codeOf(start(w, 'step-2'))).toBe('ATTEMPT_NOT_RUNNING');
    await reattach(w); unchanged();
    await start(w, 'step-2'); unchanged();
    await step(w, 'step-2'); unchanged();
    expect(evidence(w)).toEqual([['step-1', 1], ['step-2', 1]]);

    expect(await codeOf(done(w))).toBe('EXECUTION_PROFILE_NOT_READY');
    expect(attempt(w).phase).toBe('running');
    expect(task()).toMatchObject({ status: 'WORKING', assignedWorkerId: 'worker-w' });

    // Contrast: a material edit revises the plan; no receipt, old or new, grants approval.
    await h.state.runExclusive(() => h.state.updateTask(TASK, { definitionOfDone: ['Tests pass', 'Docs updated'] }));
    expect(task()).toMatchObject({ planRevision: 2, approvedPlanRevision: 1 });
    expect(await codeOf(done(w))).toBe('PLAN_REVISION_NOT_APPROVED');
    expect(await serve(w)).toMatchObject({ receiptStatus: 'recorded', planRevision: 2, approvedPlanRevision: 1 });
    expect(await codeOf(done(w))).toBe('PLAN_REVISION_NOT_APPROVED');
  });

  it('a reassignment keeps the approval and never transfers a receipt', async () => {
    await boot();
    const a = await claim('worker-a', 'worker-a@session-a');
    await serve(a);
    await start(a, 'step-1');
    const receiptA = attempt(a).contextReceipt;
    await releaseTaskTool(h.state).handler({ taskId: TASK, workerId: a.workerId }, h.state);
    expect(task()).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
    expect(attempt(a).phase).toBe('closed');
    const b = await claim('worker-b', 'worker-b@session-b');
    expect(await serve(b)).toMatchObject({ receiptStatus: 'recorded', attemptId: b.attemptId, generation: 2 });

    await strictInMemory();
    expect(task()).toMatchObject({ planRevision: 1, approvedPlanRevision: 1 });
    await refused(() => start(a, 'step-1'), 'NOT_ALLOWED');
    await refused(() => step(a, 'step-1'), 'NOT_ALLOWED');
    await refused(() => start({ ...b, attemptId: a.attemptId, generation: a.generation }, 'step-1'), 'ATTEMPT_SUPERSEDED');
    const stale = await refused(() => start({ ...b, sessionId: a.sessionId }, 'step-1'), 'CONTEXT_RECEIPT_STALE');
    expect(stale.context?.stale).toContain('sessionId');
    expect(attempt(a).contextReceipt).toEqual(receiptA);
    expect(receiptA).toMatchObject({ workerId: 'worker-a', sessionId: a.sessionId });
    await expect(start(b, 'step-2')).resolves.toMatchObject({ success: true });
  });

  it('the cutover never backfills approval onto a row approved before revision stamps', async () => {
    h.createTask({
      id: TASK, status: 'WORKING', planRevision: 1, planApprovedAt: new Date().toISOString(),
      implementationPlan: ['step-1', 'step-2'].map((stepId) => ({ stepId, description: stepId, status: 'PENDING' as const, affectedFiles: [] })),
    });
    await h.state.load();
    const w = await claim('worker-w', 'worker-w@session-1');
    expect(await serve(w)).toMatchObject({ receiptStatus: 'recorded', planRevision: 1, approvedPlanRevision: null });
    await strictInMemory();
    await refused(() => start(w, 'step-1'), 'PLAN_REVISION_NOT_APPROVED');
    expect(task()).not.toHaveProperty('approvedPlanRevision');
  });

  it('legacy-era progress is never strict evidence, and a rollback restores legacy completion', async () => {
    await boot();
    const w = await claim('worker-w', 'worker-w@session-1');
    await serve(w);
    await start(w, 'step-1');
    await step(w, 'step-1');
    expect(attempt(w)).not.toHaveProperty('stepCompletions');

    await strictInMemory();
    await start(w, 'step-2');
    await step(w, 'step-2');
    expect(evidence(w)).toEqual([['step-2', 1]]);
    const err = await refused(() => done(w), 'EXECUTION_EVIDENCE_INELIGIBLE');
    expect(err.context?.steps).toEqual(['step-1']);
    expect(task().implementationPlan.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED']);

    delete h.state.project!.settings.executionProfile;
    await expect(done(w)).resolves.toMatchObject({ success: true });
    expect(task().status).toBe('REVIEW');
    expect(attempt(w).phase).toBe('finalizing');
    expect(evidence(w)).toEqual([['step-2', 1]]);
  });

  it("DoD3: the producer's candidate provenance stays distinct from the current QA attempt", async () => {
    await boot();
    const w = await claim('worker-w', 'worker-w@session-w');
    await serve(w);
    for (const stepId of ['step-1', 'step-2']) { await start(w, stepId); await step(w, stepId); }
    const candidate = (args: Ids) => recordCandidateTool(h.state).handler({
      id: 'cand-producer', taskId: TASK, attemptId: args.attemptId, generation: args.generation, workerId: args.workerId,
      baseRevision: 'a'.repeat(40), treeSha: 'b'.repeat(40), deliveryTarget: 'refs/heads/moe/work',
    }, h.state) as Promise<{ candidate: { id: string; attemptId: string; treeSha: string } }>;
    const { candidate: cand } = await candidate(w);
    expect(cand.attemptId).toBe(w.attemptId);
    await done(w);
    expect(attempt(w).phase).toBe('finalizing');
    await finalizeAttemptTool(h.state).handler({ taskId: TASK, workerId: w.workerId, runnerId: w.workerId,
      attemptId: w.attemptId, generation: 1, outcome: 'landed', landedRevision: 'c'.repeat(40) }, h.state);
    expect(attempt(w).phase).toBe('closed');

    const candidateFile = path.join(h.moePath, 'candidates', 'cand-producer.json');
    const candidateBytes = fs.readFileSync(candidateFile, 'utf8');
    const candidateUnchanged = () => expect(fs.readFileSync(candidateFile, 'utf8')).toBe(candidateBytes);
    const qa = (await claimNextTaskTool(h.state).handler(
      { workerId: 'qa-q', statuses: ['REVIEW'], taskId: TASK }, h.state)) as { attemptId: string; generation: number };
    const q: Ids = { workerId: 'qa-q', attemptId: qa.attemptId, generation: qa.generation, sessionId: 'qa-q@session-q' };
    expect(attempt(q)).toMatchObject({ workerId: 'qa-q', generation: 2 });
    const read = (await getContextTool(h.state).handler({ taskId: TASK, workerId: q.workerId, sessionId: q.sessionId }, h.state)) as
      { servedContext: Served; currentCandidate: { id: string; attemptId: string } };
    expect(read.servedContext).toMatchObject({ attemptId: q.attemptId, generation: 2, receiptStatus: 'recorded' });
    expect(read.currentCandidate).toMatchObject({ id: 'cand-producer', attemptId: w.attemptId });
    expect(listCandidatesForAttempt(h.state, q.attemptId)).toEqual([]);
    expect(attempt(w).contextReceipt).toMatchObject({ workerId: 'worker-w', sessionId: w.sessionId });
    expect(attempt(q).contextReceipt).toMatchObject({ workerId: 'qa-q', sessionId: q.sessionId });
    candidateUnchanged();

    const { checkRun } = (await recordCheckRunTool(h.state).handler({
      candidateId: cand.id, treeSha: cand.treeSha, command: 'npm test', exitCode: 0, runnerId: q.workerId,
      source: 'agent-reported', attemptId: q.attemptId, outcome: 'passed', planRevision: 1,
    }, h.state)) as { checkRun: { attemptId?: string } };
    expect(checkRun.attemptId).toBe(q.attemptId);
    expect(checkRun.attemptId).not.toBe(cand.attemptId);
    candidateUnchanged();

    const files = fs.readdirSync(path.join(h.moePath, 'candidates'));
    expect(await codeOf(candidate(w))).toBe('ATTEMPT_SUPERSEDED');
    expect(fs.readdirSync(path.join(h.moePath, 'candidates'))).toEqual(files);

    await qaApproveTool(h.state).handler({ taskId: TASK, workerId: q.workerId, candidateId: cand.id, summary: 'verified' }, h.state);
    expect(task().status).toBe('DONE');
    expect(listReviewsForTask(h.state, TASK)).toEqual([expect.objectContaining({ candidateId: 'cand-producer', reviewerId: 'qa-q' })]);
    candidateUnchanged();
  });
});

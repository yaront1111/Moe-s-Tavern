import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { createMcpCaller, McpCallError, type McpCaller } from './mcpCall.js';
import * as executionProfile from '../delivery/executionProfile.js';
import { dependencyShortfall, isDependencySatisfied, runDependencyUnblock } from '../state/dependencyUnblock.js';
import type { ExecutionPolicySnapshot, Task, TaskStatus } from '../types/schema.js';

// =============================================================================
// CQ-V12b: every daemon projection of prerequisite readiness gives the answer of
// the ONE shared predicate, isDependencySatisfied(state, id, consumer).
//
// "Strict" is CQ-V09's meaning: a consumer whose execution profile is
// verified-local, never one picked by the live deliveryPolicy. Each projection is
// read through the real MCP registry (createMcpCaller) and must equal BOTH a
// hard-coded column and the predicate, so a wrong predicate fails too. Rows are
// seeded as raw rows plus stores, as dependencyReadiness.strict.test.ts seeds
// them, because no tool mints a historical state. DoD 2's approval is a real
// moe.qa_approve. No tool handler is imported.
// =============================================================================

// Copied from dependencyReadiness.strict.test.ts: production readiness is never enabled by these fixtures.
vi.mock('../delivery/executionProfile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery/executionProfile.js')>()),
  assertExecutionProfileReady: () => undefined,
}));

const h = new ToolTestHarness();
const P = 'task-p';
const GATE = 'npm run gate';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const TREE = 'a'.repeat(40);
const RUNNER = { runnerId: 'runner-0123456789abcdef' };
const IDENTITY = { processStartedAt: '4242@2026-10-30T00:00:00.0000000Z', host: 'box-1' };
const STRICT: ExecutionPolicySnapshot = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'legacy' };
const LEGACY: ExecutionPolicySnapshot = { ...STRICT, profile: 'legacy' };
const KINDS = ['legacy', 'strict'] as const;
type Kind = typeof KINDS[number];
let call: McpCaller['call'];
let runner: McpCaller['call'];
let seq = 0;

const task = (id: string) => h.state.getTask(id)!;
const patch = (id: string, changes: Partial<Task>) => h.state.tasks.set(id, { ...task(id), ...changes });
/** A raw row, as a hand-built board would hold it. */
function row(id: string, status: TaskStatus, changes: Partial<Task> = {}): void {
  const now = '2026-10-30T00:00:00.000Z';
  h.state.tasks.set(id, { id, epicId: 'epic-1', title: id, description: id, definitionOfDone: [], taskRails: [], implementationPlan: [],
    status, assignedWorkerId: null, branch: null, prLink: null, reopenCount: 0, reopenReason: null, createdBy: 'HUMAN',
    parentTaskId: null, priority: 'MEDIUM', comments: [], order: ++seq, createdAt: now, updatedAt: now, ...changes } as Task);
}
const consumerId = (kind: Kind, n: number) => `task-${kind}-${n}`;
const snapshotOf = (kind: Kind) => (kind === 'strict' ? STRICT : LEGACY);

beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); h.createEpic({ id: 'epic-2' }); seq = 0;
  await h.state.load();
  h.state.project!.settings = { ...h.state.project!.settings, approvalMode: 'TURBO', deliveryPolicy: 'legacy', qualityGate: GATE,
    qualityGateScope: 'everyTask', checkEnvironments: [ENV] } as never;
  const adapter = new McpAdapter(h.state);
  call = createMcpCaller(h.state, adapter).call;
  // The /runner channel's authenticated identity, as WebSocketServer forwards it.
  runner = createMcpCaller(h.state, { handle: (request: never) => adapter.handle(request, { runner: RUNNER }) } as unknown as McpAdapter).call;
});
afterEach(async () => { vi.restoreAllMocks(); await h.state.flushActivityLog(); h.state.clearEmitter(); h.cleanup(); });

/** A runner-observed, authenticated pass of the gate on `candidateId`, at P's approved revision. */
async function pass(candidateId: string): Promise<void> {
  const { dispatch } = (await runner('moe.record_check_dispatch', { id: `dispatch-${++seq}`, taskId: P, candidateId, planRevision: 1,
    command: GATE, environment: ENV })) as { dispatch: { id: string } };
  await runner('moe.record_check_observation', { id: `run-${dispatch.id}`, dispatchId: dispatch.id, exitCode: 0, outcome: 'passed', environment: ENV });
}
function candidate(id = 'cand-p'): string {
  h.state.candidates.set(id, { id, attemptId: 'attempt-p', taskId: P, baseRevision: 'b'.repeat(40), treeSha: TREE,
    deliveryTarget: 'refs/heads/main', createdAt: '2026-10-30T00:00:00.000Z' });
  return id;
}
function review(candidateId: string): void {
  h.state.reviews.set(`review-${candidateId}`, { id: `review-${candidateId}`, taskId: P, candidateId, reviewerId: 'qa-1', decision: 'approve',
    summary: 'verified', createdAt: '2026-10-30T00:00:01.000Z' });
}
function receipt(candidateId: string): void {
  h.state.receipts.set(`receipt-${candidateId}`, { id: `receipt-${candidateId}`, candidateId, target: 'refs/heads/main',
    targetBefore: '0'.repeat(40), targetAfter: TREE, landedRevision: TREE, pushResult: null });
}

interface Row {
  /** null: the id was never created. */
  status: 'DONE' | 'ARCHIVED' | 'REVIEW' | null;
  snapshot?: unknown;
  pass?: boolean;
  receipt?: boolean;
  /** The hard-coded answer per consumer kind: true = met. */
  legacy: boolean;
  strict: boolean;
  /** An explicit-taskId claim of an unmet consumer is refused with this codeName, naming this text (CQ-V09's token). */
  refusal: [string, string] | null;
}

const ROWS: Array<[string, Row]> = [
  ['legacy DONE', { status: 'DONE', snapshot: LEGACY, legacy: true, strict: false,
    refusal: ['DEPENDENCY_EVIDENCE_MISSING', 'verified-local-snapshot'] }],
  ['strict DONE with verified delivery', { status: 'DONE', pass: true, legacy: true, strict: true, refusal: null }],
  ['strict DONE without verified delivery', { status: 'DONE', legacy: false, strict: false,
    refusal: ['DEPENDENCY_EVIDENCE_MISSING', `required-check:${GATE}`] }],
  ['ARCHIVED with retained proof', { status: 'ARCHIVED', pass: true, receipt: true, legacy: true, strict: true, refusal: null }],
  ['ARCHIVED without a receipt', { status: 'ARCHIVED', pass: true, legacy: true, strict: false,
    refusal: ['NOT_ALLOWED', `${P} [ARCHIVED, missing delivery-receipt]`] }],
  ['missing id', { status: null, legacy: true, strict: false, refusal: ['NOT_ALLOWED', `${P} [missing, missing prerequisite-missing]`] }],
  ['not DONE (REVIEW)', { status: 'REVIEW', pass: true, legacy: false, strict: false, refusal: ['NOT_ALLOWED', `unmet dependencies: ${P} (`] }],
  // Error handling: a hand-edited snapshot nothing can judge is unmet everywhere (fail closed).
  ['unjudgeable snapshot', { status: 'DONE', snapshot: { ...STRICT, deliveryPolicy: 'bogus' }, legacy: false, strict: false,
    refusal: ['INVALID_INPUT', 'executionPolicySnapshot.deliveryPolicy'] }],
];

/** The prerequisite: a candidate with an approving review always; the pass, receipt, status and snapshot per row. */
async function seedPrerequisite(r: Row): Promise<void> {
  if (r.status === null) return;
  row(P, 'WORKING', { executionPolicySnapshot: STRICT, planRevision: 1, approvedPlanRevision: 1 });
  const cand = candidate();
  if (r.pass) await pass(cand);
  review(cand);
  if (r.receipt) receipt(cand);
  patch(P, { status: r.status, ...(r.snapshot === undefined ? {} : { executionPolicySnapshot: r.snapshot as ExecutionPolicySnapshot }) });
}

/**
 * Per kind: consumer 1 (dependsOn, set by set_task_dependencies), 2 (report_blocked), 3 (BLOCKED, auto-unblock).
 * Strict consumers sit in epic-2: a solo seat may not claim an epic+status another live seat holds.
 */
function seedConsumers(): void {
  for (const kind of KINDS) {
    const base = { executionPolicySnapshot: snapshotOf(kind), epicId: kind === 'strict' ? 'epic-2' : 'epic-1' };
    row(consumerId(kind, 1), 'WORKING', base);
    row(consumerId(kind, 2), 'PLANNING', base);
    // Restored to PLANNING, so a restored row never enters the WORKING claim pool below.
    row(consumerId(kind, 3), 'BLOCKED', { ...base, blockedOnTaskIds: [P], blockedFromStatus: 'PLANNING',
      blockedReason: 'waits on task-p', blockedAt: '2026-10-30T00:00:00.000Z' });
  }
}

async function refused(name: string, args: Record<string, unknown>): Promise<McpCallError> {
  const error = await call(name, args).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(McpCallError);
  return error as McpCallError;
}

describe('CQ-V12b: every readiness projection equals the shared predicate', () => {
  it('keeps the real readiness assertion unconditional', async () => {
    const actual = await vi.importActual<typeof executionProfile>('../delivery/executionProfile.js');
    expect(() => actual.assertExecutionProfileReady('verified-local')).toThrow(expect.objectContaining({ codeName: 'EXECUTION_PROFILE_NOT_READY' }));
  });

  it.each(ROWS)('%s', async (_, r) => {
    await seedPrerequisite(r);
    seedConsumers();
    for (const kind of KINDS) {
      const id = consumerId(kind, 1);
      const met = r[kind];
      const expectMet = (actual: boolean, projection: string) => expect(actual, `${kind} ${projection}`).toBe(met);
      expectMet(isDependencySatisfied(h.state, P, task(id)), 'oracle');

      // set_task_dependencies creates the edge every later projection reads; an unknown id is refused, so it is seeded.
      if (r.status === null) {
        expect((await refused('moe.set_task_dependencies', { taskId: id, workerId: 'architect-1', dependsOn: [P] })).codeName).toBe('INVALID_INPUT');
        patch(id, { dependsOn: [P] });
      } else {
        const set = (await call('moe.set_task_dependencies', { taskId: id, workerId: 'architect-1', dependsOn: [P] })) as { dependsOnUnmet: number };
        expectMet(set.dependsOnUnmet === 0, 'set_task_dependencies');
      }
      const context = (await call('moe.get_context', { taskId: id })) as { task: { dependsOnUnmet: string[] } };
      expect(context.task.dependsOnUnmet, `${kind} get_context`).toStrictEqual(met ? [] : [P]);
      const listed = (await call('moe.list_tasks', {})) as { tasks: Array<{ id: string; dependsOnUnmet?: number }> };
      expectMet(listed.tasks.find((t) => t.id === id)?.dependsOnUnmet === 0, 'list_tasks');
      const found = (await call('moe.search_tasks', { query: id })) as { tasks: Array<{ id: string; dependsOnUnmet?: number }> };
      expectMet(found.tasks.find((t) => t.id === id)?.dependsOnUnmet === 0, 'search_tasks');

      const second = consumerId(kind, 2);
      const blocked = (await call('moe.report_blocked', { taskId: second, reason: 'waits on the prerequisite', blockedOnTaskIds: [P] })) as
        { dependenciesSatisfied?: boolean; ignoredBlockedOnTaskIds?: string[] };
      if (r.status === null) {
        // An unknown id is never recorded, so there is no readiness to project: the input contract answers.
        expect(blocked.ignoredBlockedOnTaskIds, `${kind} report_blocked`).toEqual([P]);
        expect(task(second).blockedOnTaskIds ?? [], `${kind} report_blocked`).toEqual([]);
      } else {
        expectMet(blocked.dependenciesSatisfied === true, 'report_blocked');
        expectMet(task(second).status !== 'BLOCKED', 'report_blocked status');
      }
    }

    const unblocked = await runDependencyUnblock(h.state);
    for (const kind of KINDS) expect(unblocked.includes(consumerId(kind, 3)), `${kind} auto-unblock`).toBe(r[kind]);

    for (const kind of KINDS) {
      if (r[kind]) continue;
      const error = await refused('moe.claim_next_task', { workerId: `seat-${kind}`, statuses: ['WORKING'], taskId: consumerId(kind, 1), ...IDENTITY });
      expect([error.codeName, error.message], `${kind} explicit claim`).toEqual([r.refusal?.[0], expect.stringContaining(r.refusal?.[1] ?? '?')]);
    }
    const claimed: string[] = [];
    for (const seat of ['seat-a', 'seat-b']) {
      const claim = (await call('moe.claim_next_task', { workerId: seat, statuses: ['WORKING'], ...IDENTITY })) as { task?: { id: string } };
      if (claim.task) claimed.push(claim.task.id);
    }
    expect(claimed.sort(), 'ranked claim pool').toEqual(KINDS.filter((kind) => r[kind]).map((kind) => consumerId(kind, 1)));
  });
});

describe('DoD 2: a strict consumer is released only by a successful qa_approve', () => {
  const W = { workerId: 'worker-w', sessionId: 'worker-w@session' };
  const Q = { workerId: 'qa-q', sessionId: 'qa-q@session' };
  type Ids = { attemptId: string; generation: number };
  const blockedKinds = () => KINDS.filter((kind) => task(consumerId(kind, 3)).status === 'BLOCKED');

  /**
   * P reaches REVIEW through MCP under the live legacy profile, then its captured snapshot is made
   * verified-local, as V06's reviewBinding test flips strictness after the QA claim. Returns QA's identity.
   */
  async function toReview(): Promise<Record<string, unknown>> {
    row(P, 'PLANNING');
    seedConsumers();
    await call('moe.submit_plan', { taskId: P, steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }] });
    const w = (await call('moe.claim_next_task', { ...W, statuses: ['WORKING'], taskId: P, ...IDENTITY })) as Ids;
    await call('moe.get_context', { taskId: P, ...W });
    await call('moe.start_step', { taskId: P, stepId: 'step-1', ...W, ...w });
    await call('moe.complete_step', { taskId: P, stepId: 'step-1', modifiedFiles: ['file.ts'], ...W, ...w });
    await call('moe.complete_task', { taskId: P, ...W, ...w, verification: { command: GATE, exitCode: 0 } });
    await call('moe.record_candidate', { taskId: P, ...w, workerId: W.workerId, id: 'cand-p', baseRevision: 'b'.repeat(40), treeSha: TREE,
      deliveryTarget: 'refs/heads/main' });
    await call('moe.finalize_attempt', { taskId: P, workerId: W.workerId, runnerId: W.workerId, ...w, outcome: 'nothing-to-commit' });
    const q = (await call('moe.claim_next_task', { workerId: Q.workerId, statuses: ['REVIEW'], taskId: P, ...IDENTITY })) as Ids;
    await call('moe.get_context', { taskId: P, ...Q });
    patch(P, { executionPolicySnapshot: STRICT });
    expect(blockedKinds()).toEqual(KINDS);
    for (const kind of KINDS) expect(isDependencySatisfied(h.state, P, task(consumerId(kind, 3)))).toBe(false);
    return { taskId: P, summary: 'verified', candidateId: 'cand-p', ...Q, ...q };
  }

  it('P2: refused before the pass, then approved: both consumers return to blockedFromStatus', async () => {
    const approval = await toReview();
    // The strict review binding is live: QA's own attempt is required (CQ-V06).
    expect((await refused('moe.qa_approve', { ...approval, attemptId: undefined })).codeName).toBe('STEP_ENTRY_IDENTITY_REQUIRED');
    const early = await refused('moe.qa_approve', approval);
    expect([early.codeName, early.message]).toEqual(['DELIVERY_EVIDENCE_MISSING', expect.stringContaining(`required-check:${GATE}`)]);
    expect(blockedKinds()).toEqual(KINDS);
    await pass('cand-p');
    expect(await call('moe.qa_approve', approval)).toMatchObject({ success: true, status: 'DONE' });
    expect(blockedKinds()).toEqual([]);
    for (const kind of KINDS) expect(task(consumerId(kind, 3))).toMatchObject({ status: 'PLANNING', blockedOnTaskIds: null });
  });

  it.each([false, true])('P1: set_task_status DONE without qa_approve keeps the strict consumer BLOCKED (gate passed: %s)', async (passed) => {
    await toReview();
    if (passed) await pass('cand-p');
    await call('moe.set_task_status', { taskId: P, status: 'DONE' });
    expect(task(P).status).toBe('DONE');
    // The legacy consumer keeps today's rule, DONE plus evidence; the strict one also needs the approving review.
    expect(blockedKinds()).toEqual(passed ? ['strict'] : KINDS);
    expect(dependencyShortfall(h.state, P, task(consumerId('strict', 3))).missingEvidence).toContain('approved-review');
  });

  it('P3: a legacy prerequisite moved to DONE releases only the legacy consumer', async () => {
    row(P, 'REVIEW', { executionPolicySnapshot: LEGACY });
    seedConsumers();
    await call('moe.set_task_status', { taskId: P, status: 'DONE' });
    expect(blockedKinds()).toEqual(['strict']);
    expect(dependencyShortfall(h.state, P, task(consumerId('strict', 3))).missingEvidence).toContain('verified-local-snapshot');
  });
});

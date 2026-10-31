import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { createMcpCaller, McpCallError, type McpCaller } from './mcpCall.js';
import * as policy from '../delivery/policy.js';
import * as checkRunStore from '../state/checkRunStore.js';
// Imported for the A2 mirroring check ONLY: the one place a handler is called directly, to show it stays green.
import { qaApproveTool } from '../tools/qaApprove.js';

// =============================================================================
// CQ-V11: producer -> consumer acceptance, through the real MCP registry.
//
// The producer is the check run (record_check_run); the consumer is qa_approve,
// gated by the strict delivery policy. Every case reaches the daemon through
// createMcpCaller, so registration, dispatch and error mapping are part of what
// is proven. gatedApproval is the ONE scenario; its own assertions are what the
// meta-tests (A2 unwired consumer, A3 injected defects) must make fail.
// =============================================================================

const h = new ToolTestHarness();
type Call = McpCaller['call'];
type Entry = { path: string; oid: string };
type RequiredCheck = { id: string; command: string; assertionRoots?: string[] };

const TASK = 'task-1';
const WORKER = 'worker-a';
const QA = 'qa-1';
const GATE = 'npm test';
const CANDIDATE = 'cand-001';
const SUMMARY = 'verified DoD; re-ran verification command green';
const ROOT = 'packages/moe-daemon/src/__acceptance__';
const sha = (c: string) => c.repeat(40);
const BASE = { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '', commitPattern: '',
  agentCommand: 'claude', enableAgentTeams: false };
const STRICT = { deliveryPolicy: 'local-branch', qualityGate: GATE, qualityGateScope: 'everyTask' };

async function boot(extra: Record<string, unknown> = {}): Promise<void> {
  h.init(); h.setupMoeFolder({ settings: { ...BASE, ...extra } as never }); h.createEpic(); h.createTask({ status: 'PLANNING' });
  await h.state.load();
}
afterEach(() => { vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

interface Scenario {
  /** Strict policy (default): the check run and a completion commit gate the approval. False: legacy, nothing is owed. */
  strict?: boolean;
  requiredChecks?: RequiredCheck[];
  tree?: string;
  protectedEntries?: Entry[];
  /** After the check run the decision is refused naming exactly these tokens; absent = approved. */
  refusedWith?: string[];
}

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: McpCallError };

/** One tool call's outcome: a daemon refusal (it carries a codeName) is data, a wiring failure is not and propagates. */
async function decide(call: Call, name: string, args: Record<string, unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: (await call(name, args)) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof McpCallError) || error.codeName === undefined) throw error;
    return { ok: false, error };
  }
}

/** The decision must be a delivery-evidence refusal naming every token. The completion commit is always recorded, so it is never named. */
function expectRefusal(outcome: Outcome, tag: string, tokens: string[]): void {
  expect(outcome.ok, tag).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error.codeName).toBe('DELIVERY_EVIDENCE_MISSING');
  for (const token of tokens) expect(outcome.error.message).toContain(token);
  expect(outcome.error.message).not.toContain('completion-commit');
}

/** The producer side: plan, worker steps, the wrapper's landing record, the runner's candidate. */
async function produce(call: Call, s: Scenario): Promise<void> {
  const tree = s.tree ?? sha('a');
  const contract = s.requiredChecks ? { executionContract: { requiredChecks: s.requiredChecks } } : {};
  await call('moe.submit_plan', { taskId: TASK, steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }], ...contract });
  await call('moe.claim_next_task', { workerId: WORKER, statuses: ['WORKING'], taskId: TASK });
  const context = (await call('moe.get_context', { taskId: TASK, workerId: WORKER })) as { task: { implementationPlan: Array<{ stepId: string }> } };
  for (const { stepId } of context.task.implementationPlan) {
    await call('moe.start_step', { taskId: TASK, stepId, workerId: WORKER });
    await call('moe.complete_step', { taskId: TASK, stepId, workerId: WORKER });
  }
  const done = (await call('moe.complete_task', { taskId: TASK, workerId: WORKER, verification: { command: GATE, exitCode: 0 } })) as
    { attemptId: string; generation: number };
  if (s.strict !== false) {
    await call('moe.record_commit', { taskId: TASK, outcome: 'committed', kind: 'completion', sha: sha('c'), treeId: tree, ref: 'main',
      role: 'worker', sessionId: `${WORKER}@unknown`, workerId: WORKER, paths: ['file.ts'] });
  }
  await call('moe.record_candidate', { taskId: TASK, attemptId: done.attemptId, generation: done.generation, id: CANDIDATE,
    baseRevision: sha('b'), treeSha: tree, deliveryTarget: 'refs/heads/main', ...(s.protectedEntries ? { protectedEntries: s.protectedEntries } : {}) });
  await call('moe.finalize_attempt', { taskId: TASK, workerId: WORKER, runnerId: WORKER, attemptId: done.attemptId,
    generation: done.generation, outcome: 'nothing-to-commit' });
}

const runArgs = (tree: string) => ({ id: 'run-001', candidateId: CANDIDATE, treeSha: tree, command: GATE, exitCode: 0, outputTail: 'ok',
  runnerId: 'runner-1', source: 'runner-observed', outcome: 'passed' });
const approval = { taskId: TASK, workerId: QA, summary: SUMMARY, candidateId: CANDIDATE };

/** The reusable scenario. Its assertions carry tags the meta-tests look for. */
async function gatedApproval(call: Call, s: Scenario = {}): Promise<Record<string, unknown>> {
  await produce(call, s);
  await call('moe.claim_next_task', { workerId: QA, statuses: ['REVIEW'], taskId: TASK });
  await call('moe.get_context', { taskId: TASK, workerId: QA });
  if (s.strict === false) {
    const legacy = await decide(call, 'moe.qa_approve', approval);
    expect(legacy.ok, 'LEGACY-APPROVES: legacy policy owes no evidence').toBe(true);
    return legacy.ok ? legacy.value : {};
  }
  const owed = [`required-check:${GATE}`];
  expectRefusal(await decide(call, 'moe.qa_approve', approval), 'REFUSE-BEFORE-RUN: qa_approve must refuse before any check run', owed);
  // A run the agent reports about itself is never evidence: only a runner-observed run satisfies the gate.
  const tree = s.tree ?? sha('a');
  await call('moe.record_check_run', { ...runArgs(tree), id: 'run-000', source: 'agent-reported' });
  expectRefusal(await decide(call, 'moe.qa_approve', approval), 'REFUSE-AGENT-REPORTED: an agent-reported run must not satisfy the gate', owed);
  await call('moe.record_check_run', runArgs(tree));
  const late = await decide(call, 'moe.qa_approve', approval);
  if (s.refusedWith) {
    expectRefusal(late, 'REFUSE-DRIFT: a changed protected file must still refuse', s.refusedWith);
    if (!late.ok) expect(late.error.message).not.toContain('required-check:');
    return {};
  }
  expect(late.ok, 'APPROVE-AFTER-RUN: the recorded check run must satisfy the gate').toBe(true);
  return late.ok ? late.value : {};
}

const unwire = (adapter: McpAdapter, tool: string) => (adapter as unknown as { tools: Map<string, unknown> }).tools.delete(tool);

describe('producer -> consumer acceptance through McpAdapter', () => {
  beforeEach(() => boot(STRICT));

  it('A1: a check run gates qa_approve: refused before it, approved with it', async () => {
    const approved = await gatedApproval(createMcpCaller(h.state).call);
    expect(approved).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
    expect(h.state.getTask(TASK)!.status).toBe('DONE');
  });

  it('A2: an unregistered consumer fails acceptance while a handler-level mirror stays green', async () => {
    const adapter = new McpAdapter(h.state);
    expect(unwire(adapter, 'moe.qa_approve')).toBe(true);
    const caller = createMcpCaller(h.state, adapter);
    expect(await caller.listTools()).not.toContain('moe.qa_approve');
    expect(await createMcpCaller(h.state).listTools()).toContain('moe.qa_approve');

    const failure: unknown = await gatedApproval(caller.call).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpCallError);
    expect(failure).toMatchObject({ code: -32601 });

    // The mirror imports the handler: it never needs the registry, so it passes on the same fixture.
    const mirror = qaApproveTool(h.state);
    await expect(mirror.handler(approval, h.state)).rejects.toMatchObject({ codeName: 'DELIVERY_EVIDENCE_MISSING' });
    await caller.call('moe.record_check_run', runArgs(sha('a')));
    await expect(mirror.handler(approval, h.state)).resolves.toMatchObject({ success: true, status: 'DONE' });
  });

  describe('A3: injected defects make the scenario fail', () => {
    it('an always-satisfied evidence evaluation is caught by the refusal before the run', async () => {
      vi.spyOn(policy, 'evaluateDeliveryEvidence').mockReturnValue({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
      await expect(gatedApproval(createMcpCaller(h.state).call)).rejects.toThrow('REFUSE-BEFORE-RUN');
    });

    it('check runs hidden from the policy are caught by the approval after the run', async () => {
      vi.spyOn(checkRunStore, 'listCheckRunsForCandidate').mockReturnValue([]);
      await expect(gatedApproval(createMcpCaller(h.state).call)).rejects.toThrow('APPROVE-AFTER-RUN');
    });

    it('control: the restored modules pass the same scenario', async () => {
      await expect(gatedApproval(createMcpCaller(h.state).call)).resolves.toMatchObject({ status: 'DONE' });
    });
  });
});

describe('A4: a candidate cannot weaken the protected acceptance assertions', () => {
  const FILES = { [`${ROOT}/mcpCall.ts`]: 'caller\n', [`${ROOT}/producerConsumer.acceptance.test.ts`]: 'scenario\n', 'src/app.ts': 'app\n' };
  const checks: RequiredCheck[] = [{ id: 'acceptance', command: GATE, assertionRoots: [ROOT] }];
  const byPath = (a: Entry, b: Entry) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
  const changed = (file: string) => `protected-check-changed:${ROOT}/${file}`;
  let tree = '';
  let entries: Entry[] = [];

  function git(...args: string[]): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: h.testDir, encoding: 'utf8',
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim();
  }

  beforeEach(async () => {
    await boot(STRICT);
    git('init', '-q');
    for (const [file, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
      fs.writeFileSync(path.join(h.testDir, file), text);
    }
    git('add', '-A'); git('commit', '-qm', 'fixture');
    tree = git('rev-parse', 'HEAD^{tree}');
    entries = Object.keys(FILES).filter((file) => file.startsWith(`${ROOT}/`)).map((file) => ({ path: file, oid: git('rev-parse', `${tree}:${file}`) })).sort(byPath);
  });

  const scenario = (protectedEntries: Entry[], refusedWith?: string[]): Scenario => ({ requiredChecks: checks, tree, protectedEntries, ...(refusedWith ? { refusedWith } : {}) });

  it('accepts the unchanged candidate', async () => {
    await expect(gatedApproval(createMcpCaller(h.state).call, scenario(entries))).resolves.toMatchObject({ status: 'DONE' });
  });

  it('refuses a candidate that changes a file under the assertion root', async () => {
    const weakened = entries.map((e) => (e.path.endsWith('mcpCall.ts') ? { ...e, oid: 'e5'.repeat(20) } : e));
    await gatedApproval(createMcpCaller(h.state).call, scenario(weakened, [changed('mcpCall.ts')]));
  });

  it('refuses a candidate that ADDS a file under the assertion root', async () => {
    const added = [...entries, { path: `${ROOT}/weaker.acceptance.test.ts`, oid: 'e5'.repeat(20) }].sort(byPath);
    await gatedApproval(createMcpCaller(h.state).call, scenario(added, [changed('weaker.acceptance.test.ts')]));
  });
});

describe('A5: the default legacy policy is unchanged', () => {
  beforeEach(() => boot());

  it('approves with the soft NO-COMPLETION-COMMIT warning and no evidence', async () => {
    const approved = await gatedApproval(createMcpCaller(h.state).call, { strict: false });
    expect(approved).toMatchObject({ success: true, status: 'DONE' });
    expect(approved.warning).toMatch(/^NO-COMPLETION-COMMIT/);
    expect(approved).not.toHaveProperty('deliveryPolicy');
    expect(h.state.getTask(TASK)!.status).toBe('DONE');
  });
});

describe('A6: createMcpCaller maps replies faithfully', () => {
  beforeEach(() => boot(STRICT));
  const stub = (reply: unknown) => createMcpCaller(h.state, { handle: async () => reply } as unknown as McpAdapter);
  const text = (value: string) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: value }] } });

  it('gives -32601 for an unknown tool and the codeName for a tool refusal', async () => {
    const caller = createMcpCaller(h.state);
    await expect(caller.call('moe.no_such_tool')).rejects.toMatchObject({ name: 'McpCallError', code: -32601 });
    await expect(caller.call('moe.record_check_run', { candidateId: 'cand-none', treeSha: sha('a'), command: GATE, exitCode: 0,
      runnerId: 'runner-1', source: 'runner-observed' })).rejects.toMatchObject({ code: expect.any(Number), codeName: 'CANDIDATE_NOT_FOUND' });
  });

  it.each([
    ['a reply with neither result nor error', { jsonrpc: '2.0', id: 1 }],
    ['no reply at all', null],
    ['a batch reply', []],
    ['result text that is not JSON', text('not json')],
    ['a result without text content', { jsonrpc: '2.0', id: 1, result: { content: [] } }],
  ])('rejects %s as an internal error, never a pass', async (_, reply) => {
    await expect(stub(reply).call('moe.get_context')).rejects.toMatchObject({ name: 'McpCallError', code: -32603 });
  });

  it('parses a well-formed result', async () => {
    await expect(stub(text('{"a":1}')).call('moe.get_context')).resolves.toEqual({ a: 1 });
  });
});

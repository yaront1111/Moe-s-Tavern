import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { RUNNER_KEY_HEADER, authenticateRunner, ensureRunnerKey } from '../server/runnerChannel.js';
import { clearReadiness, refreshReadiness } from '../delivery/readinessHolder.js';
import type { ReadinessInputs, ReadinessSnapshot } from '../delivery/executionReadiness.js';
import { EVIDENCE_TOKENS, deliveryEvidenceRefusal } from '../delivery/policy.js';
import { createMcpCaller, McpCallError, type McpCaller } from './mcpCall.js';

// =============================================================================
// CQ-M07 final row: the activated verified-local system, composed end to end.
//
// Each M07 slice tested its own seam. This file walks ONE verified-local task
// through the real MCP registry in the order the VM-route wrappers call it
// (scripts/moe-agent.sh wt_land_rounds after CQ-M07r/s/t): the marked worker
// claim; complete_task; then the post-flight freezes candidate M on base B,
// the check VMs report over /runner (check-dispatch.mjs), and the landing sends
// the completion row, the delivery receipt and only then finalize_attempt
// (CQ-V08 defers the finalize until the receipt is acknowledged); then the
// marked QA claim and qa_approve.
//
// Readiness is held READY only through readinessHolder.refreshReadiness and
// cleared in afterEach. Nothing spies assertExecutionProfileReady or
// activationGaps: activation goes through h.state.updateSettings, the recorded
// path. `runnerCall` carries the identity authenticateRunner derives from a
// temp host key; `call` is /mcp. Stores and a temp Git repo are real.
// =============================================================================

const h = new ToolTestHarness();
type Call = McpCaller['call'];
type Ids = { workerId: string; attemptId: string; generation: number; sessionId: string };
type Claimed = { hasNext: boolean; attemptId: string; generation: number; workspace?: unknown };
type Land = { receipt?: boolean; entries?: (tree: string) => unknown; checks?: (tree: string) => Promise<unknown> };

const TASK = 'task-1';
const CONSUMER = 'task-2';
const CAND = 'cand-m';
const GATE = 'npm test';
const LOCK = 'package-lock.json';
const ENV = `moe-local-vm-v1:${'a'.repeat(64)}`;
const TARGET = 'refs/heads/moe/work';
const OWED = [`required-check:${GATE}`];
const SUMMARY = 'verified the DoD; the check VM passed the gate';
const ROUTE = { processStartedAt: '4242@2026-11-05T00:00:00.0000000Z', host: 'box-1' };
const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' } as const;
const SEAT_ENV = ['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_SESSION_ID', 'MOE_ATTEMPT_ID', 'MOE_ATTEMPT_GENERATION',
  'MOE_RUNNER_PROCESS_STARTED_AT', 'MOE_RUNNER_HOST'];
const DIRS = ['tasks', 'attempts', 'candidates', 'checks', 'reviews', 'receipts'];
const READY: ReadinessSnapshot = { ready: true, missingCapabilities: [], evaluatedAt: '2026-11-05T00:00:00.000Z',
  evidence: { reportSha256: 'a'.repeat(64), platform: 'linux', arch: 'x64', providerVersion: '1.17.0' } };
const INPUTS = Object.freeze({ projectRoot: 'never-read' }) as unknown as ReadinessInputs;

let call: Call;
let runnerCall: Call;
let base = { sha: '', tree: '' };
let seq = 0;

// git() is workstreamComposition.e2e's; commit() stages only its own files, never the daemon's .moe state.
function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function commit(files: Record<string, string>): { sha: string; tree: string } {
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(h.testDir, file), text);
  git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'fixture');
  return { sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

/** Every file under the evidence directories, for the no-write proofs. */
function bytes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of DIRS.map((d) => path.join(h.moePath, d)).filter((d) => fs.existsSync(d))) {
    for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const file = path.join(dir, rel);
      if (fs.statSync(file).isFile()) out[path.relative(h.moePath, file)] = fs.readFileSync(file, 'utf8');
    }
  }
  return out;
}
/** Refused with exactly `codeName`, and nothing in bytes() moved. A success fails the row. */
async function refused(act: () => Promise<unknown>, codeName: string): Promise<McpCallError> {
  const before = bytes();
  const err = await act().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(McpCallError);
  expect((err as McpCallError).codeName).toBe(codeName);
  expect(bytes()).toEqual(before);
  return err as McpCallError;
}

const task = () => h.state.getTask(TASK)!;
const settingsRecords = () =>
  h.state.getActivityLog(500).filter((e) => e.event === 'PROJECT_SETTINGS_UPDATED').map((e) => e.payload);

beforeEach(async () => {
  for (const name of SEAT_ENV) vi.stubEnv(name, '');
  h.init();
  vi.stubEnv('MOE_RUNNER_KEY_DIR', path.join(h.testDir, 'runner-keys'));
  h.setupMoeFolder({ schemaVersion: 6, settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
    branchPattern: '', commitPattern: '', agentCommand: 'claude', deliveryPolicy: 'local-branch', worktreeMode: 'on',
    qualityGate: GATE, qualityGateScope: 'everyTask', checkEnvironments: [ENV] } as never });
  h.createEpic();
  h.createTask({ id: TASK, status: 'PLANNING' });
  h.createTask({ id: CONSUMER, status: 'WORKING', dependsOn: [TASK], planRevision: 1, approvedPlanRevision: 1,
    executionPolicySnapshot: STRICT, implementationPlan: [{ stepId: 'step-1', description: 'use it', status: 'PENDING', affectedFiles: [] }] });
  git('init', '-q');
  base = commit({ [LOCK]: '{"lockfileVersion":3}\n', 'file.ts': 'export const a = 1;\n' });
  await h.state.load();
  const key = fs.readFileSync(await ensureRunnerKey(h.state.projectPath), 'utf8');
  const request = { socket: { remoteAddress: '127.0.0.1' }, headersDistinct: { [RUNNER_KEY_HEADER]: [key] } } as unknown as IncomingMessage;
  const runner = authenticateRunner(request, h.state.projectPath);
  if (!runner) throw new Error('fixture: authenticateRunner refused the temp host key');
  const adapter = new McpAdapter(h.state);
  call = createMcpCaller(h.state, adapter).call;
  runnerCall = createMcpCaller(h.state, adapter, { runner }).call;
  seq = 0;
  // The daemon's own holder is the only readiness source; activation takes the recorded settings path.
  expect((await refreshReadiness(INPUTS, async () => READY)).ready).toBe(true);
  await h.state.updateSettings({ executionProfile: 'verified-local' });
});
afterEach(() => { clearReadiness(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.state.clearEmitter(); h.cleanup(); });

const claimArgs = (workerId: string, status: string, taskId = TASK) => ({ workerId, statuses: [status], taskId, ...ROUTE });
let workspace: unknown;
/** A strict claim: refused without the VM-route marker (writing nothing), then claimed with it and served its context. */
async function claim(workerId: string, status: 'WORKING' | 'REVIEW'): Promise<Ids> {
  await refused(() => call('moe.claim_next_task', claimArgs(workerId, status)), 'EXECUTION_ROUTE_REQUIRED');
  const r = (await call('moe.claim_next_task', { ...claimArgs(workerId, status), executionRoute: 'vm' })) as Claimed;
  expect(r.hasNext).toBe(true);
  workspace = r.workspace;
  const ids = { workerId, attemptId: r.attemptId, generation: r.generation, sessionId: `${workerId}@session` };
  await call('moe.get_context', { taskId: TASK, workerId, sessionId: ids.sessionId });
  return ids;
}

const dispatch = (environment = ENV) => runnerCall('moe.record_check_dispatch', { id: `dispatch-${++seq}`, taskId: TASK,
  candidateId: CAND, planRevision: 1, command: GATE, checkId: 'gate', environment }) as Promise<{ dispatch: { id: string } }>;
/** What check-dispatch.mjs sends over /runner for the one owed check: its dispatch, then the observed pass. */
async function pass(): Promise<unknown> {
  const { dispatch: d } = await dispatch();
  return runnerCall('moe.record_check_observation', { id: `run-${d.id}`, dispatchId: d.id, exitCode: 0, outcome: 'passed', environment: ENV });
}
/** The runner's `git ls-tree` entries for the protected lockfile in `tree` (MCP_SERVER.md record_candidate protectedEntries). */
const measured = (tree: string) => [{ path: LOCK, oid: git('rev-parse', `${tree}:${LOCK}`) }];
const receipt = (landed: string) => call('moe.record_delivery_receipt', { candidateId: CAND, target: TARGET,
  targetBefore: base.sha, targetAfter: landed, landedRevision: landed });

/** Plan, the marked worker claim and its steps, complete_task, then the wrapper's post-flight in wt_land_rounds order. */
async function land(opts: Land = {}): Promise<void> {
  await call('moe.submit_plan', { taskId: TASK, steps: [{ description: 'implement with error handling and test it', affectedFiles: ['file.ts'] }],
    executionContract: { requiredChecks: [{ id: 'gate', command: GATE, configs: [LOCK] }] } });
  expect(task()).toMatchObject({ status: 'WORKING', executionPolicySnapshot: STRICT, requiredCheckSnapshot: { revision: base.tree } });
  const w = await claim('worker-w', 'WORKING');
  expect(workspace).toMatchObject({ mode: 'worktree', branch: `moe/task/${TASK}` });
  await call('moe.start_step', { taskId: TASK, stepId: 'step-1', ...w });
  await call('moe.complete_step', { taskId: TASK, stepId: 'step-1', modifiedFiles: ['file.ts'], ...w });
  await call('moe.complete_task', { taskId: TASK, verification: { command: GATE, exitCode: 0 }, currentBranch: `moe/task/${TASK}`, ...w });
  expect(task().status).toBe('REVIEW');
  // C = commit-tree M -p B: the merged tree M on the target's base B.
  const m = commit({ 'file.ts': 'export const a = 2;\n' });
  const protectedEntries = (opts.entries ?? measured)(m.tree);
  await call('moe.record_candidate', { id: CAND, taskId: TASK, attemptId: w.attemptId, generation: w.generation, workerId: w.workerId,
    baseRevision: base.sha, treeSha: m.tree, deliveryTarget: TARGET, ...(protectedEntries === undefined ? {} : { protectedEntries }) });
  await (opts.checks ?? pass)(m.tree);
  await call('moe.record_commit', { taskId: TASK, outcome: 'committed', kind: 'completion', sha: m.sha, treeId: m.tree, ref: 'moe/work',
    role: 'worker', sessionId: `${w.workerId}@unknown`, workerId: w.workerId, paths: ['file.ts'] });
  if (opts.receipt !== false) expect(await receipt(m.sha)).toMatchObject({ success: true, duplicate: false });
  await call('moe.finalize_attempt', { taskId: TASK, workerId: w.workerId, runnerId: w.workerId, attemptId: w.attemptId,
    generation: w.generation, outcome: 'landed', landedRevision: m.sha });
}
const approve = (q: Ids) => call('moe.qa_approve', { taskId: TASK, summary: SUMMARY, workerId: q.workerId, attemptId: q.attemptId,
  generation: q.generation, sessionId: q.sessionId, candidateId: CAND });
/** qa_approve refused with exactly the evidence gate's message for `tokens`, moving not one byte. */
async function refusedApproval(q: Ids, tokens: string[]): Promise<void> {
  const err = await refused(() => approve(q), 'DELIVERY_EVIDENCE_MISSING');
  expect(err.message).toBe(deliveryEvidenceRefusal(TASK, { policy: 'local-branch', satisfied: false, missingEvidence: tokens }, true).message);
  expect(task().status).toBe('REVIEW');
}

describe('CQ-M07 verified-local activation, composed (through McpAdapter)', () => {
  it('L1: activation is recorded, then one task runs plan -> marked claims -> check VMs -> receipt -> qa_approve, to DONE', async () => {
    expect(settingsRecords()[0]).toMatchObject({ setting: 'executionProfile', from: 'legacy', to: 'verified-local',
      transition: 'activate', outcome: 'applied' });
    expect(h.state.project!.settings.executionProfile).toBe('verified-local');
    await land({ checks: async () => expect(await pass()).toMatchObject({ repair: { action: 'none', reason: 'passed' } }) });
    const q = await claim('qa-q', 'REVIEW');
    expect(await approve(q)).toMatchObject({ success: true, status: 'DONE', deliveryPolicy: 'local-branch' });
    expect(Object.keys(bytes()).filter((f) => f.startsWith('reviews'))).toHaveLength(1);
  });

  describe('L2: a verified-local consumer of the landed task', () => {
    const consumerUnmet = async () =>
      ((await call('moe.get_context', { taskId: CONSUMER })) as { task: { dependsOnUnmet: string[] } }).task.dependsOnUnmet;
    const consumerClaim = () => call('moe.claim_next_task', { ...claimArgs('worker-c', 'WORKING', CONSUMER), executionRoute: 'vm' });
    /** The producer approved (DONE releases the consumer, receipt or not), then archived. */
    async function archivedProducer(withReceipt: boolean): Promise<void> {
      await land({ receipt: withReceipt });
      expect(await consumerUnmet()).toEqual([TASK]);
      await approve(await claim('qa-q', 'REVIEW'));
      expect(task().status).toBe('DONE');
      expect(await consumerUnmet()).toEqual([]);
      await call('moe.archive_task', { taskId: TASK });
      expect(task().status).toBe('ARCHIVED');
    }

    it('stays claimable after ARCHIVED through the delivery receipt', async () => {
      await archivedProducer(true);
      expect(await consumerUnmet()).toEqual([]);
      expect(await consumerClaim()).toMatchObject({ hasNext: true, task: { id: CONSUMER }, workspace: { mode: 'worktree' } });
    });

    it('a twin landed with no receipt is withheld once ARCHIVED, naming delivery-receipt', async () => {
      await archivedProducer(false);
      expect(await consumerUnmet()).toEqual([TASK]);
      const err = await refused(consumerClaim, 'NOT_ALLOWED');
      expect(err.message).toContain(`unmet dependencies: ${TASK} [ARCHIVED, missing ${EVIDENCE_TOKENS.deliveryReceipt}] (`);
    });
  });

  describe('L3: one defect each keeps the task refused', () => {
    it('(a) no observation: qa_approve names the owed check', async () => {
      await land({ checks: async () => undefined });
      await refusedApproval(await claim('qa-q', 'REVIEW'), OWED);
    });

    it('(b) only the old host L6 record_check_run over /mcp: recorded, never evidence', async () => {
      await land({ checks: (tree) => expect(call('moe.record_check_run', { id: 'run-host', candidateId: CAND, treeSha: tree, command: GATE,
        exitCode: 0, outcome: 'passed', runnerId: 'worker-w', source: 'runner-observed', workerId: 'worker-w' }))
        .resolves.toMatchObject({ success: true, duplicate: false }) });
      await refusedApproval(await claim('qa-q', 'REVIEW'), OWED);
    });

    it('(c) a dispatch in an environment checkEnvironments does not list is refused before any write', async () => {
      await land({ checks: () => refused(() => dispatch(`moe-local-vm-v1:${'b'.repeat(64)}`), 'CHECK_ENVIRONMENT_NOT_APPROVED') });
      await refusedApproval(await claim('qa-q', 'REVIEW'), OWED);
    });

    it('(d) after clearReadiness() the next strict claim is EXECUTION_PROFILE_NOT_READY', async () => {
      await land();
      clearReadiness();
      await refused(() => call('moe.claim_next_task', { ...claimArgs('qa-q', 'REVIEW'), executionRoute: 'vm' }), 'EXECUTION_PROFILE_NOT_READY');
    });

    it('(e) a candidate without protectedEntries (both wrappers today, bug task-ee10405f) is protected-checks-unmeasured', async () => {
      await land({ entries: () => undefined });
      await refusedApproval(await claim('qa-q', 'REVIEW'), [EVIDENCE_TOKENS.protectedChecksUnmeasured]);
    });

    it('(f) a candidate whose protected lockfile changed is protected-check-changed', async () => {
      await land({ entries: () => [{ path: LOCK, oid: 'e5'.repeat(20) }] });
      await refusedApproval(await claim('qa-q', 'REVIEW'), [`protected-check-changed:${LOCK}`]);
    });
  });
});

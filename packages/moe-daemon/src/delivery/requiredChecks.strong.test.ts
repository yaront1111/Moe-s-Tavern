import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { recordCheckDispatchTool } from '../tools/recordCheckDispatch.js';
import { recordCheckObservationTool } from '../tools/recordCheckObservation.js';
import { recordCheckRunTool } from '../tools/recordCheckRun.js';
import { describeMissingEvidence, evaluateDeliveryEvidence, owedChecks } from './policy.js';
import { untrustedArchitectureChecks } from './requiredChecks.js';
import { deliveryProjection } from '../state/deliveryProjection.js';
import { dependencyShortfall, unmetDependsOn } from '../state/dependencyUnblock.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { CheckDispatch, ProtectedCheckDefinition } from '../types/schema.js';

// CQ-V04: the verified-local pass rule and record_check_dispatch admission. Readiness is mocked in THIS
// file only, so the strong branch is reachable; the real assertion stays unconditional (pinned below).
vi.mock('./executionProfile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./executionProfile.js')>()),
  assertExecutionProfileReady: () => undefined,
}));

const h = new ToolTestHarness();
const UNIT = 'npm run test:acc';
const LINT = 'npm run lint:acc';
const GATE = 'npm run gate';
const ENV_A = `moe-local-vm-v1:${'a'.repeat(64)}`;
const ENV_B = `moe-local-vm-v1:${'b'.repeat(64)}`;
const RUNNER = { runner: { runnerId: 'runner-0123456789abcdef' } };
const token = (command: string) => `required-check:${command}`;
const defs: ProtectedCheckDefinition[] = [
  { id: 'acc', command: UNIT, configs: ['cfg/vitest.json'], assertionRoots: ['tests'] },
  { id: 'lint', command: LINT, scripts: ['scripts/lint.sh'] },
];
const PROTECTED = ['cfg/vitest.json', 'scripts/lint.sh', 'tests/a.test.ts'];

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd: h.testDir, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), text);
  }
  git('add', '-A'); git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD^{tree}');
}

const task = () => h.state.getTask('task-1')!;
const missing = () => evaluateDeliveryEvidence(h.state, task()).missingEvidence;
function settings(patch: Record<string, unknown>): void {
  h.state.project!.settings = { ...h.state.project!.settings, ...patch } as never;
}
/** The live profile AND the task's captured one, since a stored verified-local snapshot floors the profile. */
function profile(name: string): void {
  settings({ executionProfile: name });
  h.state.tasks.set('task-1', { ...task(), executionPolicySnapshot: { ...task().executionPolicySnapshot!, profile: name } as never });
}
async function approve(extra: Record<string, unknown> = {}, requiredChecks = defs): Promise<void> {
  if (task().status !== 'PLANNING') h.state.tasks.set('task-1', { ...task(), status: 'PLANNING' });
  await submitPlanTool(h.state).handler({ taskId: 'task-1', steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }],
    executionContract: { requiredChecks }, ...extra }, h.state);
}

let seq = 0;
let cand = '';
/** A runner-recorded candidate, now the current one, reporting the protected entries of `tree`. */
function candidate(tree: string): string {
  const id = `cand-${String(++seq).padStart(3, '0')}`;
  h.state.candidates.set(id, { id, attemptId: 'attempt-1', taskId: 'task-1', baseRevision: tree, treeSha: tree,
    deliveryTarget: 'refs/heads/main', protectedEntries: PROTECTED.map((p) => ({ path: p, oid: git('rev-parse', `${tree}:${p}`) })),
    createdAt: new Date(Date.UTC(2026, 9, 30, 0, 0, seq)).toISOString() });
  return id;
}
type DispatchResult = { success: true; dispatch: CheckDispatch; duplicate: boolean };
async function dispatch(command: string, checkId?: string, environment = ENV_A, id = `dispatch-${++seq}`): Promise<DispatchResult> {
  return await recordCheckDispatchTool(h.state).handler({ id, taskId: 'task-1', candidateId: cand, planRevision: task().planRevision,
    command, ...(checkId === undefined ? {} : { checkId }), environment }, h.state, RUNNER) as DispatchResult;
}
async function observe(dispatchId: string, outcome: string, exitCode: number): Promise<void> {
  await recordCheckObservationTool(h.state).handler({ id: `run-${dispatchId}`, dispatchId, exitCode, outcome, environment: ENV_A }, h.state, RUNNER);
}
async function pass(command: string, checkId?: string): Promise<void> {
  await observe((await dispatch(command, checkId)).dispatch.id, 'passed', 0);
}
/** [code, codeName, context.field] of the MoeError the call is refused with. */
async function refused(promise: Promise<unknown>): Promise<[number, string, unknown]> {
  const error = await promise.then(() => null, (e: unknown) => e);
  if (!(error instanceof MoeError)) throw new Error(`expected a MoeError refusal, got ${String(error)}`);
  return [error.code, error.codeName, (error.context as { field?: unknown } | undefined)?.field];
}
const dispatchFiles = () => { const dir = path.join(h.moePath, 'checks', 'dispatches'); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; };

let tree1 = '';
beforeEach(async () => {
  h.init(); h.setupMoeFolder(); h.createEpic(); seq = 0;
  h.createTask({ status: 'PLANNING', commits: [{ sha: 'ab'.repeat(20), ref: 'main', kind: 'completion', role: 'worker',
    sessionId: 'worker-1@x', paths: [], recordedBy: 'worker-1', recordedAt: '2026-10-30T00:00:00.000Z' }] });
  await h.state.load();
  settings({ executionProfile: 'verified-local', deliveryPolicy: 'local-branch', approvalMode: 'TURBO', checkEnvironments: [ENV_A] });
  git('init', '-q');
  tree1 = commit({ 'cfg/vitest.json': '{}\n', 'scripts/lint.sh': 'lint\n', 'tests/a.test.ts': 'a\n', 'src/app.ts': 'app\n' });
  await approve();
  cand = candidate(tree1);
});
afterEach(() => { vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

describe('verified-local required checks (CQ-V04)', () => {
  it('keeps production readiness unconditional: only this file mocks it', async () => {
    const actual = await vi.importActual<typeof import('./executionProfile.js')>('./executionProfile.js');
    const error = (() => { try { actual.assertExecutionProfileReady('verified-local'); return null; } catch (e) { return e; } })();
    expect([error instanceof MoeError, (error as MoeError | null)?.codeName]).toEqual([true, 'EXECUTION_PROFILE_NOT_READY']);
    expect([task().approvedPlanRevision, task().planRevision, task().executionPolicySnapshot?.profile]).toEqual([1, 1, 'verified-local']);
  });

  it('P passes with an authenticated passed run of each owed check', async () => {
    expect(owedChecks(h.state, task())).toEqual([{ checkId: 'acc', command: UNIT }, { checkId: 'lint', command: LINT }]);
    await pass(UNIT, 'acc');
    await pass(LINT, 'lint');
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(true);
  });

  describe('A dispatch admission', () => {
    it.each([
      ['an unowed command', 'npm run other', 'acc', ENV_A, 'CHECK_DEFINITION_NOT_APPROVED'],
      ['an owed command with a wrong checkId', UNIT, 'lint', ENV_A, 'CHECK_DEFINITION_NOT_APPROVED'],
      ['an owed command without its checkId', UNIT, undefined, ENV_A, 'CHECK_DEFINITION_NOT_APPROVED'],
      ['an unlisted environment', UNIT, 'acc', ENV_B, 'CHECK_ENVIRONMENT_NOT_APPROVED'],
    ])('refuses %s and writes nothing', async (_label, command, checkId, environment, codeName) => {
      expect(await refused(dispatch(command, checkId, environment))).toEqual([MoeErrorCode.NOT_ALLOWED, codeName, undefined]);
      expect(dispatchFiles()).toEqual([]);
    });

    it('approves no environment when checkEnvironments is absent', async () => {
      settings({ checkEnvironments: undefined });
      expect(await refused(dispatch(UNIT, 'acc'))).toEqual([MoeErrorCode.NOT_ALLOWED, 'CHECK_ENVIRONMENT_NOT_APPROVED', undefined]);
      expect(dispatchFiles()).toEqual([]);
    });

    it('refuses a malformed checkEnvironments as INVALID_INPUT, at dispatch and in evaluation', async () => {
      settings({ checkEnvironments: ENV_A });
      expect(await refused(dispatch(UNIT, 'acc'))).toEqual([MoeErrorCode.INVALID_INPUT, 'INVALID_INPUT', 'checkEnvironments']);
      expect(dispatchFiles()).toEqual([]);
      expect(() => missing()).toThrow(/checkEnvironments/);
    });

    it('replays a recorded dispatch id without re-admitting it, even after its environment is revoked', async () => {
      const first = await dispatch(UNIT, 'acc', ENV_A, 'dispatch-r');
      settings({ checkEnvironments: [] });
      expect(await dispatch(UNIT, 'acc', ENV_A, 'dispatch-r')).toStrictEqual({ ...first, duplicate: true });
      expect(dispatchFiles()).toEqual(['dispatch-r.json']);
    });
  });

  it.each([
    ['a re-approval at revision 2', () => approve()],
    ['ENV_A removed from checkEnvironments', async () => settings({ checkEnvironments: [ENV_B] })],
    ['a newer candidate with a different tree', async () => { cand = candidate(commit({ 'src/app.ts': 'app2\n' })); }],
  ])('R %s brings both required-check tokens back', async (_label, change) => {
    await pass(UNIT, 'acc');
    await pass(LINT, 'lint');
    expect(missing()).toEqual([]);
    await change();
    expect(missing()).toEqual([token(UNIT), token(LINT)]);
  });

  it.each([['verified-local', [token(UNIT)]], ['legacy', []]])('D under %s, a record_check_run report copying a real binding', async (name, expected) => {
    await pass(LINT, 'lint');
    const { dispatch: real } = await dispatch(UNIT, 'acc');
    await recordCheckRunTool(h.state).handler({ id: 'run-reported', candidateId: cand, treeSha: tree1, command: UNIT, exitCode: 0,
      outcome: 'passed', runnerId: RUNNER.runner.runnerId, source: 'runner-observed', planRevision: 1, environment: ENV_A,
      dispatchId: real.id }, h.state, RUNNER);
    profile(name);
    expect(missing()).toEqual(expected);
  });

  it.each([
    ['no dispatch', null],
    ['a dispatch never observed', []],
    ['skipped at exit 0', ['skipped', 0]],
    ['inconclusive at exit 0', ['inconclusive', 0]],
    ['timeout at exit 0', ['timeout', 0]],
    ['infra-failure at exit 0', ['infra-failure', 0]],
    ['code-failure', ['code-failure', 1]],
  ] as const)('O %s keeps the token, and the one predicate withholds dependents', async (_label, result) => {
    await pass(LINT, 'lint');
    if (result !== null) {
      const { dispatch: d } = await dispatch(UNIT, 'acc');
      if (result.length === 2) await observe(d.id, result[0], result[1]);
    }
    expect(missing()).toEqual([token(UNIT)]);
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(false);
    h.state.tasks.set('task-1', { ...task(), status: 'DONE' });
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(['task-1']);
    expect(dependencyShortfall(h.state, 'task-1').missingEvidence).toEqual([token(UNIT)]);
  });

  it('U reports required-checks-undeclared when nothing is owed, and owes the gate once it is set', async () => {
    await approve({ executionContract: { checkRefs: [UNIT] } });
    expect([owedChecks(h.state, task()), missing()]).toEqual([[], ['required-checks-undeclared']]);
    settings({ qualityGate: ` ${GATE} `, qualityGateScope: 'everyTask' });
    expect([owedChecks(h.state, task()), missing()]).toEqual([[{ command: GATE }], [token(GATE)]]);
    await pass(GATE);
    expect(missing()).toEqual([]);
  });

  it('T owes twin definitions sharing one command separately', async () => {
    await approve({}, [defs[0], { id: 'acc2', command: UNIT, scripts: ['scripts/lint.sh'] }]);
    await pass(UNIT, 'acc');
    expect(missing()).toEqual([token(UNIT)]);
    await pass(UNIT, 'acc2');
    expect(missing()).toEqual([]);
  });

  it.each(['legacy', 'observe'])('L keeps today\'s verdicts and V03 dispatch under %s', async (name) => {
    profile(name);
    settings({ checkEnvironments: undefined });
    expect(missing()).toEqual([token(UNIT), token(LINT)]);
    expect((await dispatch('npm run anything')).duplicate).toBe(false);
    for (const [i, command] of [UNIT, LINT].entries()) {
      await recordCheckRunTool(h.state).handler({ id: `run-legacy-${i}`, candidateId: cand, treeSha: tree1, command, exitCode: 0,
        runnerId: 'runner-1', source: 'runner-observed' }, h.state);
    }
    expect(missing()).toEqual([]);
    await approve({ executionContract: { checkRefs: [UNIT] } });
    expect(missing()).toEqual([]);
  });
});

/**
 * A verified-local task whose project never set a strict deliveryPolicy ('absent' deletes the key), with no completion
 * commit, so an invented landing demand would show. The snapshot is written directly: submit_plan keeps a stored
 * verified-local one whole and cannot recapture it.
 */
function legacyPolicy(value: 'legacy' | null | 'absent'): void {
  const next: Record<string, unknown> = { ...h.state.project!.settings };
  if (value === 'absent') delete next.deliveryPolicy; else next.deliveryPolicy = value;
  h.state.project!.settings = next as never;
  h.state.tasks.set('task-1', { ...task(), commits: [], executionPolicySnapshot: { ...task().executionPolicySnapshot!, deliveryPolicy: 'legacy' } as never });
}
const setDone = () => h.state.tasks.set('task-1', { ...task(), status: 'DONE' });
const BOTH = [token(UNIT), token(LINT)];

describe('V verified-local under the legacy deliveryPolicy (bug task-43088e9b)', () => {
  it.each(['legacy', 'absent', null] as const)('V1 owes its trusted checks and no landing evidence under deliveryPolicy %s', async (value) => {
    legacyPolicy(value);
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'legacy', satisfied: false, missingEvidence: BOTH });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(false);
    const { dispatch: real } = await dispatch(UNIT, 'acc');
    await recordCheckRunTool(h.state).handler({ id: 'run-reported', candidateId: cand, treeSha: tree1, command: UNIT, exitCode: 0,
      outcome: 'passed', runnerId: RUNNER.runner.runnerId, source: 'runner-observed', planRevision: 1, environment: ENV_A,
      dispatchId: real.id }, h.state, RUNNER);
    expect(missing()).toEqual(BOTH);
    setDone();
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(['task-1']);
    expect(dependencyShortfall(h.state, 'task-1')).toEqual({ satisfied: false, missingEvidence: BOTH });
  });

  it('V2 is satisfied by an authenticated pass of each owed check, and an environment revoked or absent brings the tokens back', async () => {
    legacyPolicy('legacy');
    await pass(UNIT, 'acc');
    await pass(LINT, 'lint');
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(true);
    setDone();
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual([]);
    expect(dependencyShortfall(h.state, 'task-1')).toEqual({ satisfied: true, missingEvidence: [] });
    settings({ checkEnvironments: undefined });
    expect(missing()).toEqual(BOTH);
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(['task-1']);
  });

  it('V3 keeps judging a stored verified-local snapshot after the live profile and policy roll back to legacy', () => {
    settings({ executionProfile: 'legacy', deliveryPolicy: 'legacy' });
    expect(task().executionPolicySnapshot?.profile).toBe('verified-local');
    expect(missing()).toEqual(BOTH);
  });

  it('V4 reports required-checks-undeclared when nothing is owed', async () => {
    legacyPolicy('legacy');
    await approve({ executionContract: { checkRefs: [UNIT] } });
    expect(missing()).toEqual(['required-checks-undeclared']);
  });

  it('V5 refuses a malformed checkEnvironments as INVALID_INPUT and withholds dependents', () => {
    legacyPolicy('legacy');
    settings({ checkEnvironments: ENV_A });
    expect(() => missing()).toThrow(/checkEnvironments/);
    setDone();
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(['task-1']);
  });

  it.each(['legacy', 'observe'])('L2 leaves a %s task satisfied with no run, even with a malformed checkEnvironments', (name) => {
    profile(name);
    legacyPolicy('legacy');
    settings({ checkEnvironments: ENV_A });
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBeUndefined();
    setDone();
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual([]);
  });
});

const INSTALLED = 'moe-daemon check-architecture --rules arch.json';
const BUILT = 'node packages/moe-daemon/dist/index.js check-architecture --rules arch.json';
const CHECKER_SRC = 'packages/moe-daemon/src/commands/checkArchitecture.ts';
const ENGINE_SRC = 'packages/moe-daemon/src/delivery/architectureRules.ts';
const untrusted = (id: string) => `required-check-untrusted-checker:${id}`;
const archDef = (command: unknown, extra: Partial<ProtectedCheckDefinition> = {}, id = 'x') =>
  ({ id, command, ...extra }) as ProtectedCheckDefinition;

describe('UC a candidate-built architecture checker under verified-local (bug task-efbf1742)', () => {
  it.each([
    [INSTALLED], [`${INSTALLED} --base ${'a'.repeat(40)} --tree HEAD`], [`  ${INSTALLED}\t`], ['npm test'],
    ['npm run lint -- --max-warnings=0', { scripts: ['scripts/lint.sh'] }], [INSTALLED, { scripts: [CHECKER_SRC, ENGINE_SRC] }],
  ] as [string, Partial<ProtectedCheckDefinition>?][])('UC1 accepts %j', (command, extra) => {
    expect(untrustedArchitectureChecks([archDef(command, extra)])).toEqual([]);
  });

  it.each([
    [BUILT], [`npx ${INSTALLED}`], [`./node_modules/.bin/${INSTALLED}`], [`MOE_X=1 ${INSTALLED}`],
    [`${INSTALLED}; true`], [`${INSTALLED} && node x.js`], [`${INSTALLED} | cat`], [`${INSTALLED} $(id)`],
    [`${INSTALLED} \`id\``], [`${INSTALLED}\nid`], [`${INSTALLED} > out.json`], [`${INSTALLED} --rules *.json`],
    ['moe-daemon check-architecture --rules "arch.json"'], ["moe-daemon check-architecture --rules 'arch.json'"],
    ['moe-daemon  check-architecture --rules arch.json'], ['moe-daemon\tcheck-architecture --rules arch.json'],
    ['moe-daemon\u00a0check-architecture --rules arch.json'], ['MOE-DAEMON CHECK-ARCHITECTURE --rules arch.json'],
    [`node -e "import('./packages/moe-daemon/dist/commands/checkArchitecture.js')"`],
    ['npm run arch', { scripts: [CHECKER_SRC] }], ['npm run arch', { scripts: ['scripts/a.sh', ENGINE_SRC] }],
    ['npm run arch', { configs: [CHECKER_SRC] }], [42], ['npm test', { scripts: 'scripts/a.sh' as never }],
  ] as [unknown, Partial<ProtectedCheckDefinition>?][])('UC1 refuses %j and never throws', (command, extra) => {
    expect(untrustedArchitectureChecks([archDef(command, extra)])).toEqual(['x']);
  });

  it('UC1 lists refused ids in definition order', () => {
    const list = [archDef(BUILT, {}, 'a'), archDef('npm test', {}, 'b'), archDef(INSTALLED, {}, 'c'), archDef(`npx ${INSTALLED}`, {}, 'd')];
    expect(untrustedArchitectureChecks(list)).toEqual(['a', 'd']);
  });

  it.each([
    ['UC2 the candidate-built form never delivers', BUILT, [untrusted('arch'), token(BUILT)], [untrusted('arch')]],
    ['UC3 the installed form delivers', INSTALLED, [token(INSTALLED)], []],
  ] as const)('%s, even with a passing runner run and equal protectedEntries', async (_label, command, before, after) => {
    await approve({}, [{ id: 'arch', command, configs: ['cfg/vitest.json'], scripts: ['scripts/lint.sh'] }]);
    expect(missing()).toEqual(before);
    await pass(command, 'arch');
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'local-branch', satisfied: after.length === 0, missingEvidence: after });
    expect(deliveryProjection(h.state, task())?.requiredCheckSatisfied).toBe(after.length === 0);
    setDone();
    expect(unmetDependsOn(h.state, { dependsOn: ['task-1'] })).toEqual(after.length === 0 ? [] : ['task-1']);
  });

  it.each(['legacy', 'observe'])('UC4 leaves %s verdicts unchanged: no untrusted-checker token appears', async (name) => {
    profile(name);
    settings({ checkEnvironments: undefined });
    await approve({}, [{ id: 'arch', command: BUILT, scripts: ['scripts/lint.sh'] }]);
    expect(missing()).toEqual([token(BUILT)]);
    await recordCheckRunTool(h.state).handler({ id: 'run-built', candidateId: cand, treeSha: tree1, command: BUILT, exitCode: 0,
      runnerId: 'runner-1', source: 'runner-observed' }, h.state);
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
    legacyPolicy('legacy');
    expect(evaluateDeliveryEvidence(h.state, task())).toEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
  });

  it('UC5 names the id and the installed form, and nothing from candidate data', () => {
    const reason = describeMissingEvidence(untrusted('arch'));
    expect(reason).toContain('required check arch runs the architecture checker from code the candidate builds');
    expect(reason).toContain('`moe-daemon check-architecture ...`');
  });
});

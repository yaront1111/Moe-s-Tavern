// CQ-V04b check-dispatch.mjs, against scripted fakes: the /runner `call`, and a `runCheck` logging VM create/delete around onReady.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dispatchFocusedChecks, landedRunCheck, owedChecks, runDispatchCli } from '../local-runner/check-dispatch.mjs';
import { runCheckJob } from '../local-runner/check-lifecycle.mjs';
import { checkEnvironment } from '../local-runner/check-evidence.mjs';
import { MAX_CHECK_TAIL_BYTES } from '../local-runner/check-session.mjs';
import { GUEST_RESOURCES } from '../local-runner/guest-bootstrap.mjs';
import { validateImport } from '../local-runner/source-snapshot.mjs';

const [TASK, TREE, ENV] = ['task-0123456789abcdef0123456789abcdef', 'a'.repeat(40), `check-env-${'e'.repeat(64)}`];
const SECRET = 'SENTINELKEYsentinelkeySENTINELKEYsentinelk';
const ENTRIES = [['scripts/check.sh', 1], ['test/a.test.mjs', 2], ['test/b/c.mjs', 3], ['testdata/x', 4], ['vitest.config.ts', 5]]
  .map(([path, n]) => ({ path, oid: String(n).repeat(40) }));
const UNIT = { id: 'unit', command: ' npm test ', scripts: ['scripts/check.sh'], assertionRoots: ['test'] };
const LINT = { id: 'lint', command: 'npm run lint', configs: ['vitest.config.ts'] };
const GATE_DEF = { id: 'gate', command: 'npm run gate' };
const UNIT_FRAME = { id: 'unit', command: 'npm test', protected: ENTRIES.slice(0, 3) };
const GATE_FRAME = { id: 'gate', command: 'npm run gate', protected: [] };
const fail = (code, codeName) => Object.assign(new Error(`Runner channel failed: ${code}. ${SECRET}`), { code, ...(codeName ? { codeName } : {}) });
const times = (n, make) => Array.from({ length: n }, make);
const [SNAP, DIRTY] = [{ tree: TREE, overlay: { entries: [] } }, { tree: TREE, overlay: { entries: [{ kind: 'file', path: 'peer-dirt' }] } }];

function context({ defs = [UNIT, GATE_DEF], bound = true, gate = 'npm run gate', scope = 'everyTask', final = false, autoCommit, envs = [ENV],
  plan = [2, 2], candidate = { id: 'cand-1', treeSha: TREE } } = {}) {
  return {
    project: { settings: { qualityGate: gate, qualityGateScope: scope, autoCommit, checkEnvironments: envs } },
    task: { id: TASK, isEpicFinal: final, executionContract: { requiredChecks: defs },
      ...(bound ? { requiredCheckSnapshot: { version: 1, revision: TREE, definitionDigest: 'd'.repeat(64), entries: ENTRIES } } : {}) },
    ...(candidate ? { currentCandidate: candidate } : {}),
    servedContext: { taskId: TASK, planRevision: plan[0], approvedPlanRevision: plan[1], attemptId: 'attempt-1', generation: 3 },
  };
}

// tools: per-tool scripted answers (a value, an Error to throw, or a function of args); runs: per-run results or Errors.
function harness(ctx, { tools = {}, runs = [], environment = ENV, ready = true } = {}) {
  const [events, inputs] = [[], []];
  const call = async (tool, args) => {
    events.push(['call', tool, structuredClone(args)]);
    if (tool === 'moe.get_context') return ctx;
    const next = typeof tools[tool]?.[0] === 'function' ? tools[tool].shift()(args) : tools[tool]?.shift();
    return next instanceof Error ? Promise.reject(next) : next ?? { success: true };
  };
  const runCheck = async input => {
    inputs.push(input);
    events.push(['create', structuredClone(input.check)]);
    try {
      if (!ready) return { outcome: 'infra-failure', exitCode: null, outputTail: '', environment: null, workspace: 'unverified', failure: 'CHECK_PROVISION_FAILED' };
      await input.onReady(environment);
      const result = runs.shift() ?? {};
      return result instanceof Error ? Promise.reject(result) : { outcome: 'passed', exitCode: 0, outputTail: 'ok', environment, workspace: 'intact', ...result };
    } finally { events.push(['delete']); }
  };
  return { events, inputs, call, runCheck,
    of: tool => events.filter(([kind, name]) => kind === 'call' && name === tool).map(event => event[2]),
    trace: () => events.map(([kind, name]) => (kind === 'call' ? name.slice(4) : kind)),
    frames: () => events.filter(([kind]) => kind === 'create').map(event => event[1]) };
}

const run = (h, extra = {}) => dispatchFocusedChecks({ taskId: TASK, snapshot: SNAP, call: h.call, runCheck: h.runCheck, ...extra });
// Every create has exactly one delete before the next create: never two VMs, never one left behind.
const assertPaired = h => {
  const vm = h.events.filter(([kind]) => kind === 'create' || kind === 'delete').map(([kind]) => kind);
  assert.deepEqual(vm, times(vm.length + (vm.length % 2), (_, index) => (index % 2 ? 'delete' : 'create')));
};

test('O: owedChecks mirrors the daemon rule from get_context', () => {
  assert.deepEqual(owedChecks(context({ defs: [UNIT, LINT], gate: '' })), [
    { checkId: 'unit', command: 'npm test', protected: ENTRIES.slice(0, 3), dependencies: [] },
    { checkId: 'lint', command: 'npm run lint', protected: [ENTRIES[4]], dependencies: [] }]);
  const gateOnly = [{ command: 'npm run gate', protected: [] }];
  assert.deepEqual(owedChecks(context({ bound: false, gate: ' npm run gate ' })), gateOnly);
  assert.deepEqual(owedChecks(context({ bound: false, scope: 'epicFinal', final: true })), gateOnly);
  assert.deepEqual(owedChecks(context({ defs: [UNIT], gate: 'npm test' })), [
    { checkId: 'unit', command: 'npm test', protected: ENTRIES.slice(0, 3), dependencies: [] }]);
  const configs = ['package-lock.json', 'pkg/package-lock.json', 'pkg', 'vitest.config.ts', 'xpackage-lock.json', 'a/package-lock.json.bak'];
  assert.deepEqual(owedChecks(context({ defs: [{ ...LINT, configs }], gate: '' })), [
    { checkId: 'lint', command: 'npm run lint', protected: [ENTRIES[4]], dependencies: ['.', 'pkg'] }]);
  for (const ctx of [context({ bound: false, scope: 'epicFinal' }), context({ bound: false, autoCommit: false }), context({ bound: false, gate: '   ' }),
    context({ plan: [3, 2] }), context({ plan: [2, null] })]) assert.deepEqual(owedChecks(ctx), []);
});

test('B: no candidate, a foreign snapshot tree or an unapproved revision dispatches nothing', async () => {
  const foreign = [{ ...SNAP, tree: 'b'.repeat(40) }, DIRTY, { tree: TREE }]; // another tree; checkout dirt on top; no overlay record
  for (const [ctx, code, snapshot] of [[context({ candidate: null }), 'RUNNER_NO_CANDIDATE'], ...foreign.map(s => [context(), 'RUNNER_SNAPSHOT_MISMATCH', s]),
    [context({ plan: [3, 2] }), 'RUNNER_PLAN_NOT_APPROVED'], [context({ bound: false, gate: '' }), 'RUNNER_NOTHING_OWED'],
    [context({ bound: false }), 'RUNNER_DEPENDENCIES_UNDECLARED'], [context({ defs: [UNIT] }), 'RUNNER_DEPENDENCIES_UNDECLARED']]) {
    const h = harness(ctx);
    assert.deepEqual(await run(h, snapshot ? { snapshot } : {}), { taskId: TASK, candidateId: ctx.currentCandidate?.id ?? null, results: [], stopped: { code } });
    assert.deepEqual(h.trace(), ['get_context']);
  }
});

test('C: malformed configs stop before any dispatch with a fixed context refusal', async () => {
  for (const configs of [null, {}, 'package-lock.json', [42]]) {
    const h = harness(context({ defs: [{ ...UNIT, configs }], gate: '' }));
    assert.deepEqual((await run(h)).stopped, { code: 'RUNNER_CONTEXT_INVALID' });
    assert.deepEqual(h.trace(), ['get_context']);
  }
});

test('H: each owed check is dispatched with its frozen frame, observed once, on its own VM', async () => {
  const [h, snapshot] = [harness(context()), { ...SNAP }];
  const summary = await run(h, { snapshot });
  assert.deepEqual(h.trace(), ['get_context', 'create', 'record_check_dispatch', 'delete', 'record_check_observation',
    'create', 'record_check_dispatch', 'delete', 'record_check_observation']);
  assert.deepEqual(h.frames(), [UNIT_FRAME, GATE_FRAME]);
  assert.deepEqual([h.inputs[0].snapshot === snapshot, h.inputs[0].owner], [true, { taskId: TASK, attemptId: 'attempt-1', generation: 3 }]);
  const [[d1, d2], [o1, o2]] = [h.of('moe.record_check_dispatch'), h.of('moe.record_check_observation')];
  for (const [d, o] of [[d1, o1], [d2, o2]]) {
    assert.match(d.id, /^dispatch-[0-9a-f]{32}$/);
    assert.match(o.id, /^check-[0-9a-f]{32}$/);
    assert.deepEqual(o, { id: o.id, dispatchId: d.id, exitCode: 0, outcome: 'passed', outputTail: 'ok', environment: ENV });
  }
  assert.deepEqual(d1, { id: d1.id, taskId: TASK, candidateId: 'cand-1', planRevision: 2, command: 'npm test', checkId: 'unit', environment: ENV });
  assert.deepEqual(d2, { id: d2.id, taskId: TASK, candidateId: 'cand-1', planRevision: 2, command: 'npm run gate', checkId: 'gate', environment: ENV });
  assert.notEqual(d1.id, d2.id);
  assert.deepEqual(summary, { taskId: TASK, candidateId: 'cand-1', results: [
    { checkId: 'unit', command: 'npm test', dispatchId: d1.id, outcome: 'passed' }, { checkId: 'gate', command: 'npm run gate', dispatchId: d2.id, outcome: 'passed' }] });
  assert.deepEqual([Object.isFrozen(summary), Object.isFrozen(summary.results[0])], [true, true]);
  assertPaired(h);
});

test('E: an environment outside settings.checkEnvironments is never dispatched and stops the run', async () => {
  for (const [envs, environment] of [[[ENV], 'unlisted'], [null, ENV], [['other'], ENV]]) {
    const h = harness(context({ envs }), { environment });
    assert.deepEqual(await run(h), { taskId: TASK, candidateId: 'cand-1', results: [], stopped: { code: 'RUNNER_ENVIRONMENT_NOT_APPROVED' } });
    assert.deepEqual(h.trace(), ['get_context', 'create', 'delete']);
  }
});

test('F: a daemon refusal stops the run, naming its codeName, with no observation and no further check', async () => {
  const h = harness(context(), { tools: { 'moe.record_check_dispatch': [fail('RUNNER_TOOL_ERROR', 'CHECK_DEFINITION_NOT_APPROVED')] } });
  assert.deepEqual((await run(h)).stopped, { code: 'RUNNER_TOOL_ERROR', codeName: 'CHECK_DEFINITION_NOT_APPROVED' });
  assert.deepEqual(h.trace(), ['get_context', 'create', 'record_check_dispatch', 'delete']);
  // A racing coordinator already answered this dispatch: the loser reports the refusal and stops.
  const race = harness(context(), { tools: { 'moe.record_check_observation': [fail('RUNNER_TOOL_ERROR', 'CHECK_DISPATCH_ALREADY_OBSERVED')] } });
  const summary = await run(race);
  assert.deepEqual([summary.stopped, summary.results], [{ code: 'RUNNER_TOOL_ERROR', codeName: 'CHECK_DISPATCH_ALREADY_OBSERVED',
    dispatchId: race.of('moe.record_check_dispatch')[0].id }, []]);
  assert.deepEqual(race.trace(), ['get_context', 'create', 'record_check_dispatch', 'delete', 'record_check_observation']);
});

test('I: a pass is published only with an intact workspace; other outcomes pass through', async () => {
  for (const [result, outcome, exitCode] of [[{ workspace: 'changed' }, 'inconclusive', 0], [{ workspace: 'unverified' }, 'inconclusive', 0],
    [{ workspace: 'intact' }, 'passed', 0], [{ outcome: 'code-failure', exitCode: 1, workspace: 'unverified' }, 'code-failure', 1],
    [{ outcome: 'timeout', exitCode: null }, 'timeout', -1], [{ outcome: 'infra-failure', exitCode: null }, 'infra-failure', -1]]) {
    const h = harness(context({ gate: '' }), { runs: [result] });
    const [summary, [o]] = [await run(h), h.of('moe.record_check_observation')];
    assert.deepEqual([o.outcome, o.exitCode, summary.results[0].outcome, summary.stopped], [outcome, exitCode, outcome, undefined]);
  }
});

test('R: a lost dispatch or observation is retried with the same id; three transport failures stop the run', async () => {
  const h = harness(context({ defs: [UNIT], gate: '' }), { tools: { 'moe.record_check_dispatch': [fail('RUNNER_CALL_TIMEOUT'), { success: true, duplicate: true }],
    'moe.record_check_observation': [fail('RUNNER_DISCONNECTED'), {}] } });
  assert.equal((await run(h)).stopped, undefined);
  for (const tool of ['moe.record_check_dispatch', 'moe.record_check_observation']) assert.deepEqual(h.of(tool), times(2, () => h.of(tool)[0]));
  const lost = harness(context(), { tools: { 'moe.record_check_observation': times(3, () => fail('RUNNER_DISCONNECTED')) } });
  assert.deepEqual((await run(lost)).stopped, { code: 'RUNNER_OBSERVATION_UNRECORDED', dispatchId: lost.of('moe.record_check_dispatch')[0].id });
  assert.deepEqual(lost.of('moe.record_check_observation'), times(3, () => lost.of('moe.record_check_observation')[0]));
  assert.deepEqual(lost.frames(), [UNIT_FRAME]);
  const gone = harness(context(), { tools: { 'moe.record_check_dispatch': times(3, () => fail('RUNNER_DISCONNECTED')) } });
  assert.deepEqual((await run(gone)).stopped, { code: 'RUNNER_DISCONNECTED' });
  assert.deepEqual(gone.trace(), ['get_context', 'create', 'record_check_dispatch', 'record_check_dispatch', 'record_check_dispatch', 'delete']);
  for (const each of [lost, gone]) assertPaired(each);
});

test('Y: a retry-infra decision re-runs the same check with fresh ids, capped at 10 re-runs', async () => {
  const infra = { outcome: 'infra-failure', exitCode: null };
  const h = harness(context(), { runs: [infra, infra], tools: { 'moe.record_check_observation': [
    { success: true, repair: { action: 'retry-infra', attempt: 1, remaining: 1 } }, { success: true, repair: { action: 'escalate' } }] } });
  const summary = await run(h);
  assert.deepEqual(h.frames(), [UNIT_FRAME, UNIT_FRAME, GATE_FRAME]);
  const [d1, d2, d3] = h.of('moe.record_check_dispatch');
  assert.deepEqual([d1.id !== d2.id, { ...d2, id: d1.id }], [true, d1]);
  assert.equal(new Set(h.of('moe.record_check_observation').map(o => o.id)).size, 3);
  assert.deepEqual(summary.results.map(r => [r.command, r.dispatchId, r.outcome]),
    [['npm test', d1.id, 'infra-failure'], ['npm test', d2.id, 'infra-failure'], ['npm run gate', d3.id, 'passed']]);
  const loop = harness(context(), { tools: { 'moe.record_check_observation': times(20, () => () => ({ repair: { action: 'retry-infra' } })) } });
  const [capped, dispatches] = [await run(loop), loop.of('moe.record_check_dispatch')];
  assert.deepEqual([dispatches.length, loop.frames()], [11, times(11, () => UNIT_FRAME)]);
  assert.deepEqual(capped.stopped, { code: 'RUNNER_RETRY_LIMIT', dispatchId: dispatches[10].id });
  for (const each of [h, loop]) assertPaired(each);
});

test('V: a run that cannot be observed stops without inventing an observation, and no VM starts after a stop', async () => {
  const rejected = harness(context(), { runs: [Object.assign(new Error(SECRET), { code: 'CHECK_SESSION_X' })] });
  assert.deepEqual((await run(rejected)).stopped, { code: 'RUNNER_CHECK_FAILED', dispatchId: rejected.of('moe.record_check_dispatch')[0].id });
  assert.deepEqual(rejected.trace(), ['get_context', 'create', 'record_check_dispatch', 'delete']);
  const unready = harness(context(), { ready: false });
  assert.deepEqual((await run(unready)).stopped, { code: 'RUNNER_CHECK_FAILED', failure: 'CHECK_PROVISION_FAILED' });
  assert.deepEqual(unready.trace(), ['get_context', 'create', 'delete']);
  const controller = new AbortController();
  const aborted = harness(context(), { tools: { 'moe.record_check_observation': [() => { controller.abort(); return {}; }] } });
  assert.deepEqual((await run(aborted, { signal: controller.signal })).stopped, { code: 'RUNNER_ABORTED' });
  assert.deepEqual([aborted.inputs[0].signal === controller.signal, aborted.frames()], [true, [UNIT_FRAME]]);
  for (const each of [rejected, unready, aborted]) assertPaired(each);
});

test('K: the CLI prints one line of fixed codes and never an error message or the key', async () => {
  const ARGS = ['--project', '/srv/project', '--task', TASK, '--commit', TREE];
  const cli = async (deps, argv = ARGS) => {
    const [lines, state] = [[], { opened: 0, closed: 0 }];
    const open = async input => { state.opened += 1; assert.equal(input.projectPath, ARGS[1]); return { call: deps.call, close: () => { state.closed += 1; } }; };
    const exit = await runDispatchCli(argv, { write: text => lines.push(text), exportSnapshot: async () => DIRTY,
      loadRunCheck: async () => harness(null).runCheck, open, ...deps });
    assert.deepEqual([lines.length, lines[0].includes(SECRET), lines[0].endsWith('\n')], [1, false, true]);
    return { exit, report: JSON.parse(lines[0]), ...state };
  };
  const ok = await cli({ call: harness(context()).call });
  assert.deepEqual([ok.exit, ok.report.results.map(r => r.outcome), ok.opened, ok.closed], [0, ['passed', 'passed'], 1, 1]);
  const refused = await cli({ call: async () => { throw fail('RUNNER_TOOL_ERROR', 'TASK_NOT_FOUND'); } });
  assert.deepEqual([refused.exit, refused.report.stopped, refused.closed], [2, { code: 'RUNNER_TOOL_ERROR', codeName: 'TASK_NOT_FOUND' }, 1]);
  const red = harness(context({ gate: '' }), { runs: [{ outcome: 'code-failure', exitCode: 1 }] });
  assert.equal((await cli({ call: red.call, loadRunCheck: async () => red.runCheck })).exit, 2);
  assert.deepEqual((await cli({ open: async () => { throw fail('RUNNER_AUTH_REFUSED'); } })).report, { code: 'RUNNER_AUTH_REFUSED' });
  const exported = async error => (await cli({ exportSnapshot: async () => { throw error; } })).report;
  assert.deepEqual(await exported(Object.assign(new Error(SECRET), { code: 'EXPORT_COMMIT_INVALID' })), { code: 'EXPORT_COMMIT_INVALID' });
  assert.deepEqual(await exported(new Error(SECRET)), { code: 'RUNNER_DISPATCH_FAILED' });
  const missing = await cli({ loadRunCheck: async () => null });
  assert.deepEqual([missing.exit, missing.report, missing.opened], [2, { code: 'RUNNER_SEAM_UNAVAILABLE' }, 0]);
  for (const argv of [ARGS.slice(0, 4), ['--project', 'relative', ...ARGS.slice(2)], [...ARGS.slice(0, 5), 'HEAD'], [...ARGS, '--x'],
    ['--project', '/srv/\nproject', ...ARGS.slice(2)], ['--task', TASK, '--project', '/srv/project', '--commit', TREE]]) {
    const bad = await cli({}, argv);
    assert.deepEqual([bad.exit, bad.report, bad.opened], [2, { code: 'RUNNER_CLI_INPUT_INVALID' }, 0]);
  }
  const entry = spawnSync(process.execPath, [fileURLToPath(new URL('../local-runner/check-dispatch.mjs', import.meta.url)), '--project', 'relative'],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual([entry.status, entry.stdout, entry.stderr], [2, '{"code":"RUNNER_CLI_INPUT_INVALID"}\n', '']);
});

test('D: the real dispatch adapter binds only approved lockfiles, with no dependency default', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moe-dispatch-'));
  const project = path.join(root, 'project'), previous = process.env.MOE_RUNNER_STATE_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.MOE_RUNNER_STATE_DIR; else process.env.MOE_RUNNER_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(project);
  process.env.MOE_RUNNER_STATE_DIR = path.join(root, 'state');
  const [sha256, imageHash, supervisorSha256, toolchainSha256] = ['1', '2', '3', '4'].map(c => c.repeat(64));
  const pairs = [['.', 'ROOT'], ['pkg', 'PKG']], digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const digest = digestOf(pairs), inputs = [], installed = [], lines = [];
  const snapshot = { version: 1, tree: TREE, overlay: validateImport([]), base: validateImport([
    ['package-lock.json', 'ROOT'], ['pkg/package-lock.json', 'PKG'], ['other/package-lock.json', 'OTHER']
  ].map(([path, bytes]) => ({ kind: 'file', path, executable: false, data: Buffer.from(bytes) }))) };
  const steps = {
    provision: async ({ ledger, owner }) => {
      const { instance } = await ledger.reserve(owner);
      return { provisioned: true, instance, bootstrapReady: true, failures: [], supervisorSha256,
        image: { source: { arch: 'arm64', sha256 }, provider: { imageHash } } };
    },
    toolchain: async () => ({ file: path.join(root, 'node.tar.xz'), sha256: toolchainSha256, size: 1, version: '24.22.2' }),
    dependencies: async input => {
      inputs.push({ lockfiles: input.lockfiles.map(({ dir, bytes }) => [dir, Buffer.from(bytes).toString()]), cpu: input.cpu });
      const digest = digestOf(inputs.at(-1).lockfiles);
      return { tree: { entries: [], digest }, digest };
    },
    installDependencies: async ({ tree }) => { installed.push(tree.digest); }, materialize: async () => {}, installToolchain: async () => {},
    session: async () => ({ outcome: 'passed', exitCode: 0, signal: null, outputTail: 'ok' }), verify: async () => 'intact', remove: async () => 'deleted',
  };
  const envOf = dependencyDigest => checkEnvironment({ sourceImageSha256: sha256, providerImageHash: imageHash, supervisorSha256,
    resources: GUEST_RESOURCES, toolchainSha256, dependencyDigest });
  const LOCKED = { id: 'unit', command: 'npm test', configs: ['package-lock.json', 'pkg/package-lock.json', 'vitest.config.ts'] };
  const PLAIN = { id: 'plain', command: 'python3 -m unittest' }, envs = [envOf(digest), envOf(null)];
  const h = harness(context({ defs: [LOCKED, PLAIN], gate: '', envs }));
  const exit = await runDispatchCli(['--project', project, '--task', TASK, '--commit', TREE], {
    open: async () => ({ call: h.call, close() {} }), exportSnapshot: async () => snapshot,
    loadRunCheck: dir => landedRunCheck(dir, steps), write: text => lines.push(text),
  });
  assert.deepEqual([exit, JSON.parse(lines[0]).results.map(r => r.outcome)], [0, ['passed', 'passed']], lines[0]);
  assert.deepEqual(h.of('moe.record_check_observation').map(o => o.outcome), ['passed', 'passed']);
  assert.deepEqual([inputs, installed], [[{ lockfiles: pairs, cpu: 'arm64' }], [digest]]);
  assert.deepEqual(h.of('moe.record_check_dispatch').map(d => d.environment), envs);
  let provisions = 0;
  const runCheck = await landedRunCheck(project, { provision: async () => { provisions += 1; throw fail('PROVISION_SENTINEL'); } });
  const input = { snapshot, check: { id: 'unit', command: 'npm test', protected: [] },
    owner: { taskId: TASK, attemptId: 'attempt-1', generation: 3 }, onReady: async () => {} };
  await assert.rejects(runCheck(input), { code: 'CHECK_JOB_INPUT_INVALID' });
  assert.equal(provisions, 0);
  assert.deepEqual([(await runCheck({ ...input, dependencies: [] })).failure, provisions], ['PROVISION_SENTINEL', 1]);
});

// task-12e89395 cleanup visibility: the real runCheckJob over injected, logged steps (remove settles as told), then dispatch.
const OWNER = { taskId: TASK, attemptId: 'attempt-1', generation: 3 };
const PASS = { outcome: 'passed', exitCode: 0, signal: null, outputTail: 'ok' };
const [IMG, PROV, SUP, TOOL] = ['1', '2', '3', '4'].map(c => c.repeat(64));
const JOB_ENV = checkEnvironment({ sourceImageSha256: IMG, providerImageHash: PROV, supervisorSha256: SUP, resources: GUEST_RESOURCES, toolchainSha256: TOOL,
  dependencyDigest: null });
const RESOLVES = Symbol('resolves');
const REMOVALS = [['deleted', 'deleted'], ['gone', 'delete-failed'], [fail('LIFECYCLE_STATE_UNKNOWN'), 'delete-failed']];
const reportOf = vm => ({ vm, failure: vm === 'delete-failed' ? 'CHECK_VM_DELETE_FAILED' : null });
function jobSteps(log, { remove = 'deleted', session = PASS, verify = 'intact', materialize = async () => {} } = {}) {
  return { provision: async ({ ledger, owner }) => { log.push('create'); return { provisioned: true, instance: (await ledger.reserve(owner)).instance,
    bootstrapReady: true, failures: [], supervisorSha256: SUP, image: { source: { arch: 'x64', sha256: IMG }, provider: { imageHash: PROV } } }; },
  toolchain: async () => ({ file: '/t', sha256: TOOL, size: 1, version: '24.22.2' }), materialize, installToolchain: async () => {},
  session: async () => { log.push('session'); return session; }, verify: async () => verify,
  remove: async () => {
    log.push('remove');
    await new Promise(setImmediate);
    try { if (remove instanceof Error) throw remove; return remove; } finally { log.push('removed'); }
  } };
}
const jobInput = (log, changes = {}) => ({ platform: {}, owner: OWNER, cacheDir: '/c', supervisor: Buffer.from('s'), credential: Buffer.alloc(32, 7),
  ledger: { read: async () => null, reserve: async () => ({ instance: 'moe-check-1' }), update: async () => null, recordImage: async () => null },
  snapshot: { version: 1, tree: TREE, overlay: validateImport([]), base: validateImport([]) }, check: { id: 'unit', command: 'npm test', protected: [] },
  dependencies: [], budgetMs: 1_000, timeoutMs: 20, onReady: async () => { log.push('onReady'); }, onCleanup: report => { log.push(report); }, ...changes });
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

test('CL1 runCheckJob tells onCleanup its settled delete once, after remove, and still rejects with onReady\'s own error', async () => {
  const [boom, frozen] = [new Error(SECRET), Object.freeze(new Error(SECRET))];
  const hooks = [[async () => {}], [async () => { throw boom; }, boom], [() => Promise.reject(null), null], [() => { throw SECRET; }, SECRET],
    [async () => { throw frozen; }, frozen], [() => new Promise(() => {}), 'timeout']];
  for (const [hook, thrown = RESOLVES] of hooks) {
    for (const [remove, vm] of REMOVALS) {
      const log = [];
      const end = await settled(runCheckJob(jobInput(log, { onReady: env => { log.push('onReady'); return hook(env); } }), jobSteps(log, { remove })));
      const reports = log.filter(entry => typeof entry !== 'string');
      assert.deepEqual([reports, log.slice(-3), Object.isFrozen(reports[0]), log.includes('session')],
        [[reportOf(vm)], ['remove', 'removed', reports[0]], true, thrown === RESOLVES], `${String(thrown)} ${vm}`);
      assert.deepEqual(Object.keys(end), [thrown === RESOLVES ? 'value' : 'error']);
      if (thrown === RESOLVES) assert.deepEqual([end.value.vm, end.value.outcome], [vm, vm === 'deleted' ? 'passed' : 'inconclusive']);
      else if (thrown === 'timeout') assert.deepEqual([end.error.code, end.error.message], ['CHECK_READY_TIMEOUT', 'Check job failed: CHECK_READY_TIMEOUT.']);
      else assert.equal(end.error, thrown);
    }
  }
});

test('CL2 a throwing, rejecting or never-settling onCleanup changes nothing; an invalid one, or an abort, refuses before any step', async () => {
  const [unhandled, boom] = [[], new Error('hook')];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const onCleanup of [() => { throw new Error(SECRET); }, async () => { throw new Error(SECRET); }, () => new Promise(() => {}),
      () => ({ then() { throw new Error(SECRET); } }), () => Object.defineProperty({}, 'then', { get() { throw new Error(SECRET); } })]) {
      for (const [onReady, thrown = RESOLVES] of [[async () => {}], [async () => { throw boom; }, boom]]) {
        const log = [];
        const end = await settled(runCheckJob(jobInput(log, { onCleanup, onReady }), jobSteps(log, { remove: 'gone' })));
        assert.deepEqual([end.error ?? RESOLVES, end.value?.vm, log.filter(entry => entry === 'removed').length], [thrown, thrown === RESOLVES ? 'delete-failed' : undefined, 1]);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
  for (const changes of [{ onCleanup: null }, { onCleanup: 'x' }, { onCleanup: {} }, { signal: AbortSignal.abort() }]) {
    const log = [];
    await assert.rejects(runCheckJob(jobInput(log, changes), jobSteps(log)), { code: changes.signal ? 'CHECK_ABORTED' : 'CHECK_JOB_INPUT_INVALID' });
    assert.deepEqual(log, []);
  }
});

const JOB_SNAP = { version: 1, tree: TREE, overlay: validateImport([]), base: validateImport([]) };
const DIAG = 'RUNNER_VM_DELETE_FAILED: VM cleanup was not confirmed; no further checks will be launched.';
const [FAILED, DELETED] = [reportOf('delete-failed'), reportOf('deleted')];
// The real landedRunCheck over jobSteps, its ledger in a temp state dir outside the project.
async function landedSeam(t, log, steps) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moe-cleanup-')), previous = process.env.MOE_RUNNER_STATE_DIR;
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project'));
  process.env.MOE_RUNNER_STATE_DIR = path.join(root, 'state');
  try { return await landedRunCheck(path.join(root, 'project'), jobSteps(log, steps)); } finally {
    if (previous === undefined) delete process.env.MOE_RUNNER_STATE_DIR; else process.env.MOE_RUNNER_STATE_DIR = previous;
  }
}
// runDispatchCli over the scripted daemon, its calls logged among the VM steps; one JSON line with no secret or escape byte.
async function dispatchCli(runCheck, log, { ctx = context({ envs: [JOB_ENV] }), tools } = {}) {
  const [h, lines] = [harness(ctx, { tools }), []];
  const call = async (tool, args) => { log.push(tool.slice(4)); return h.call(tool, args); };
  const exit = await runDispatchCli(['--project', '/srv/project', '--task', TASK, '--commit', TREE], { open: async () => ({ call, close() {} }),
    exportSnapshot: async () => JOB_SNAP, loadRunCheck: async () => runCheck, write: text => lines.push(text) });
  assert.deepEqual([lines.length, /SENTINEL|\x1b/.test(lines[0])], [1, false]);
  return { exit, report: JSON.parse(lines[0]), h };
}
const RAN = ['get_context', 'create', 'record_check_dispatch', 'session', 'remove', 'removed', 'record_check_observation'];
const UNREADY = ['get_context', 'create', 'remove', 'removed'];
const retryInfra = () => ({ success: true, repair: { action: 'retry-infra' } });
const lost = n => times(n, () => fail('RUNNER_DISCONNECTED'));

test('CD1 a known failed delete stops the whole dispatch: observed once, never passed, with the fixed diagnostic, and in the CLI report', async t => {
  const infra = { outcome: 'infra-failure', exitCode: null, signal: null, outputTail: 'boom' };
  const red = { outcome: 'code-failure', exitCode: 1, signal: null, outputTail: 'red\n' };
  const timedOut = { outcome: 'timeout', exitCode: null, signal: null, outputTail: '' };
  for (const [label, steps, tools, trace, observed, stop] of [
    ['infra + retry-infra', { session: infra }, { 'moe.record_check_observation': [retryInfra] }, RAN, ['infra-failure', -1, `boom\n${DIAG}`], {}],
    ['passed + intact', {}, {}, RAN, ['inconclusive', 0, `ok\n${DIAG}`], {}],
    ['code-failure', { session: red, remove: fail('LIFECYCLE_STATE_UNKNOWN') }, {}, RAN, ['code-failure', 1, `red\n${DIAG}`], {}],
    ['timeout', { session: timedOut }, {}, RAN, ['timeout', -1, DIAG], {}],
    ['observation lost', {}, { 'moe.record_check_observation': lost(3) }, [...RAN, 'record_check_observation', 'record_check_observation'],
      ['inconclusive', 0, `ok\n${DIAG}`], { causeCode: 'RUNNER_OBSERVATION_UNRECORDED' }],
    ['observation refused', {}, { 'moe.record_check_observation': [fail('RUNNER_TOOL_ERROR', 'CHECK_DISPATCH_ALREADY_OBSERVED')] }, RAN,
      ['inconclusive', 0, `ok\n${DIAG}`], { causeCode: 'RUNNER_TOOL_ERROR', codeName: 'CHECK_DISPATCH_ALREADY_OBSERVED' }],
  ]) {
    const log = [];
    const { exit, report, h } = await dispatchCli(await landedSeam(t, log, { remove: 'gone', ...steps }), log, { tools });
    const [[d], observations] = [h.of('moe.record_check_dispatch'), h.of('moe.record_check_observation')];
    assert.deepEqual([exit, log, observations.map(o => [o.outcome, o.exitCode, o.outputTail])], [2, trace, times(observations.length, () => observed)], label);
    assert.equal(new Set(observations.map(o => o.id)).size, 1, label);
    const recorded = stop.causeCode ? [] : [{ checkId: 'unit', command: 'npm test', dispatchId: d.id, outcome: observed[0], ...FAILED }];
    assert.deepEqual(report.results, recorded, label);
    assert.deepEqual(report.stopped, { ...stop, code: 'RUNNER_VM_DELETE_FAILED', dispatchId: d.id, ...FAILED }, label);
  }
});

test('CD2 a deleted VM with an unverified workspace is ordinary inconclusive: its own tail, no stop, later checks still run', async t => {
  const log = [];
  const { exit, report, h } = await dispatchCli(await landedSeam(t, log, { verify: 'unverified' }), log);
  const [[d1, d2], observations] = [h.of('moe.record_check_dispatch'), h.of('moe.record_check_observation')];
  assert.deepEqual([exit, log, observations.map(o => [o.outcome, o.outputTail])], [2, [...RAN, ...RAN.slice(1)], [['inconclusive', 'ok'], ['inconclusive', 'ok']]]);
  assert.deepEqual(report, { taskId: TASK, candidateId: 'cand-1', results: [{ checkId: 'unit', command: 'npm test', dispatchId: d1.id, outcome: 'inconclusive', ...DELETED },
    { checkId: 'gate', command: 'npm run gate', dispatchId: d2.id, outcome: 'inconclusive', ...DELETED }] });
});

test('CD3 a run rejected before its dispatch is accepted reports the failed delete with its cause, and never an observation', async t => {
  for (const [label, ctx, tools, trace, cause] of [
    ['unlisted environment', context({ envs: [ENV] }), () => ({}), UNREADY, { causeCode: 'RUNNER_ENVIRONMENT_NOT_APPROVED' }],
    ['dispatch refused', undefined, () => ({ 'moe.record_check_dispatch': [fail('RUNNER_TOOL_ERROR', 'CHECK_DEFINITION_NOT_APPROVED')] }),
      ['get_context', 'create', 'record_check_dispatch', 'remove', 'removed'], { causeCode: 'RUNNER_TOOL_ERROR', codeName: 'CHECK_DEFINITION_NOT_APPROVED' }],
  ]) {
    for (const [remove, cleanup] of [['gone', FAILED], ['deleted', DELETED]]) {
      const log = [];
      const { exit, report } = await dispatchCli(await landedSeam(t, log, { remove }), log, { ctx, tools: tools() });
      const { causeCode, ...rest } = cause;
      const stopped = cleanup === FAILED ? { ...cause, code: 'RUNNER_VM_DELETE_FAILED', ...FAILED } : { ...rest, code: causeCode, ...DELETED };
      assert.deepEqual([exit, log, report.results, report.stopped], [2, trace, [], stopped], `${label} ${remove}`);
    }
  }
});

test('CD4 deleted infra failures still follow the daemon\'s retries with fresh ids and the cap; a failed delete before any dispatch keeps the job\'s code', async t => {
  const log = [], infra = { outcome: 'infra-failure', exitCode: null, signal: null, outputTail: 'boom' };
  const { report, h } = await dispatchCli(await landedSeam(t, log, { session: infra }), log, { tools: { 'moe.record_check_observation': times(20, () => retryInfra) } });
  const dispatches = h.of('moe.record_check_dispatch');
  assert.deepEqual([log.filter(entry => entry === 'create').length, new Set(dispatches.map(d => d.id)).size, report.stopped],
    [11, 11, { code: 'RUNNER_RETRY_LIMIT', dispatchId: dispatches[10].id }]);
  assert.deepEqual(report.results.map(r => [r.outcome, r.vm, r.failure]), times(11, () => ['infra-failure', 'deleted', null]));
  for (const [remove, stopped] of [['gone', { code: 'RUNNER_VM_DELETE_FAILED', causeCode: 'CHECK_MATERIALIZE_FAILED', ...FAILED }],
    ['deleted', { code: 'RUNNER_CHECK_FAILED', vm: 'deleted', failure: 'CHECK_MATERIALIZE_FAILED' }]]) {
    const unready = [];
    const { exit, report: summary } = await dispatchCli(await landedSeam(t, unready, { remove, materialize: async () => { throw new Error(SECRET); } }), unready);
    assert.deepEqual([exit, unready, summary.results, summary.stopped], [2, UNREADY, [], stopped], remove);
  }
});

test('CD5 a dispatch answered after the readiness timeout resumes nothing, and two simultaneous dispatches keep their own cleanup', async t => {
  let release;
  const [log, late] = [[], new Promise(resolve => { release = resolve; })];
  const short = input => runCheckJob({ ...jobInput(log), ...input, timeoutMs: 30 }, jobSteps(log, { remove: 'gone' }));
  const { exit, report } = await dispatchCli(short, log, { tools: { 'moe.record_check_dispatch': [() => late] } });
  release({ success: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([exit, report.results, report.stopped], [2, [], { code: 'RUNNER_VM_DELETE_FAILED', causeCode: 'RUNNER_CHECK_FAILED', ...FAILED }]);
  assert.deepEqual(log, ['get_context', 'create', 'record_check_dispatch', 'remove', 'removed']);
  const [failing, clean] = [[], []];
  const seams = [await landedSeam(t, failing, { remove: 'gone' }), await landedSeam(t, clean)];
  const [a, b] = await Promise.all([dispatchCli(seams[0], failing), dispatchCli(seams[1], clean)]);
  assert.deepEqual([a.exit, a.report.stopped.code, failing.filter(e => e === 'create').length], [2, 'RUNNER_VM_DELETE_FAILED', 1]);
  assert.deepEqual([b.exit, b.report.stopped, clean, b.report.results.map(r => [r.outcome, r.vm])],
    [0, undefined, [...RAN, ...RAN.slice(1)], [['passed', 'deleted'], ['passed', 'deleted']]]);
});

test('CD6 hostile or conflicting cleanup metadata fails closed with fixed codes; a huge multibyte tail keeps the diagnostic within the cap', async t => {
  const [intact, throwing] = [{ ...PASS, workspace: 'intact' }, new Proxy({}, { get: (_, key) => { if (key !== 'then') throw new Error(SECRET); } })];
  const seam = (cleanup, result) => async ({ onReady, onCleanup }) => {
    await onReady(JOB_ENV);
    onCleanup(cleanup);
    if (result instanceof Error) throw result;
    return result;
  };
  const stop = { code: 'RUNNER_VM_DELETE_FAILED', ...FAILED }, after = { ...stop, causeCode: 'RUNNER_CHECK_FAILED' }, diagnosed = [['inconclusive', `ok\n${DIAG}`]];
  for (const [label, cleanup, result, observed, stopped] of [['result says failed', DELETED, { ...intact, ...FAILED }, diagnosed, stop],
    ['report says failed', FAILED, { ...intact, ...DELETED }, diagnosed, stop], ['unreadable report', throwing, intact, diagnosed, stop],
    ['unreadable result', DELETED, throwing, [], after], ['rejects with a secret', FAILED, Object.assign(new Error(`${SECRET}\x1b[31m`), { code: '\x1b[31mX' }), [], after],
    ['unreadable outcome', DELETED, Object.defineProperty({ ...DELETED }, 'outcome', { get() { throw new Error(SECRET); } }), [], { code: 'RUNNER_CHECK_FAILED', ...DELETED }],
    ['unknown values', { vm: 'evil', failure: `${SECRET} x` }, { ...intact, vm: 'gone', failure: 'lower' }, [['passed', 'ok'], ['passed', 'ok']], undefined]]) {
    const { report, h } = await dispatchCli(seam(cleanup, result), []);
    const ids = h.of('moe.record_check_dispatch').map(d => d.id);
    assert.deepEqual([ids.length, h.of('moe.record_check_observation').map(o => [o.outcome, o.outputTail]), report.stopped],
      [stopped ? 1 : 2, observed, stopped && { ...stopped, dispatchId: ids[0] }], label);
  }
  const [log, big] = [[], `${'€'.repeat(8_000)}z`]; // the cut lands inside a '€'
  const { h } = await dispatchCli(await landedSeam(t, log, { remove: 'gone', session: { ...PASS, outputTail: big } }), log);
  const [{ outputTail }] = h.of('moe.record_check_observation'), kept = outputTail.slice(0, -DIAG.length - 1), size = Buffer.byteLength(outputTail);
  assert.deepEqual([outputTail.endsWith(`z\n${DIAG}`), big.endsWith(kept), kept[0], size <= MAX_CHECK_TAIL_BYTES, size > MAX_CHECK_TAIL_BYTES - 3],
    [true, true, '€', true, true]);
});

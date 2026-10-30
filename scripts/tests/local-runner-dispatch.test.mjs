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
import { checkEnvironment } from '../local-runner/check-evidence.mjs';
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

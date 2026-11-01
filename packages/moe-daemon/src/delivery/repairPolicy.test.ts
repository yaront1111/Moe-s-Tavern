import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPAIR_POLICY, decideRepair, resolveRepairPolicy, type RepairDecision, type RepairInput } from './repairPolicy.js';
import type { CheckOutcome } from '../types/schema.js';

type Run = RepairInput['runs'][number];
const POLICY = { maxCodeRepairs: 3, maxInfraRetries: 2 };
const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, treeSha: `t${i + 1}` }));

let tick = 0;
function run(id: string, candidateId: string, over: Partial<Run> = {}): Run {
  tick += 1;
  return {
    id, candidateId, command: 'npm test', exitCode: 1, outcome: 'code-failure', outputTail: `fail ${id}`, planRevision: 1,
    createdAt: `2026-10-30T00:00:${String(tick).padStart(2, '0')}.000Z`, ...over,
  };
}
const input = (over: Partial<RepairInput>): RepairInput =>
  ({ planRevision: 1, approvedPlanRevision: 1, candidates: [], runs: [], policy: POLICY, ...over });
const diag = (r: Run, logRefs: string[], excerpt = r.outputTail) => ({
  checkRunId: r.id, candidateId: r.candidateId, command: r.command, outcome: r.outcome, exitCode: r.exitCode, excerpt, logRefs,
});
const diagOf = (d: RepairDecision) => ('diagnostics' in d ? d.diagnostics : undefined);
const decide = (candidates: RepairInput['candidates'], runs: Run[], over: Partial<RepairInput> = {}) =>
  decideRepair(input({ candidates, runs, ...over }));

describe('resolveRepairPolicy', () => {
  it.each([undefined, null, {}, { repairPolicy: null }, { repairPolicy: {} }])('S1 defaults for %j', (settings) => {
    expect(resolveRepairPolicy(settings as never)).toStrictEqual({ maxCodeRepairs: 3, maxInfraRetries: 2 });
  });

  it('S1 configures each budget, accepts the bounds 0 and 10, and returns a frozen copy', () => {
    expect(resolveRepairPolicy({ repairPolicy: { maxCodeRepairs: 5 } })).toStrictEqual({ maxCodeRepairs: 5, maxInfraRetries: 2 });
    expect(resolveRepairPolicy({ repairPolicy: { maxInfraRetries: 0 } })).toStrictEqual({ maxCodeRepairs: 3, maxInfraRetries: 0 });
    expect(resolveRepairPolicy({ repairPolicy: { maxCodeRepairs: 0, maxInfraRetries: 10 } })).toStrictEqual({ maxCodeRepairs: 0, maxInfraRetries: 10 });
    const resolved = resolveRepairPolicy({ repairPolicy: { maxCodeRepairs: 10 } });
    expect(resolved).toStrictEqual({ maxCodeRepairs: 10, maxInfraRetries: 2 });
    expect([resolved, DEFAULT_REPAIR_POLICY].map(Object.isFrozen)).toStrictEqual([true, true]);
  });

  const KEYS = ['maxCodeRepairs', 'maxInfraRetries'];
  const BAD: unknown[] = [-1, 11, 1.5, '3', Number.NaN, undefined];
  it.each<[string, unknown, string]>([
    ['a string', 'fast', 'settings.repairPolicy'],
    ['an array', [3, 2], 'settings.repairPolicy'],
    ['an unknown key', { maxRepairs: 3 }, 'settings.repairPolicy.maxRepairs'],
    ['an unknown key beside a valid one', { maxCodeRepairs: 3, extra: 1 }, 'settings.repairPolicy.extra'],
    ...KEYS.flatMap((key) => BAD.map((v): [string, unknown, string] => [`${key} ${String(v)}`, { [key]: v }, `settings.repairPolicy.${key}`])),
  ])('S1 refuses %s', (_name, repairPolicy, field) => {
    let thrown: unknown;
    try { resolveRepairPolicy({ repairPolicy }); } catch (err) { thrown = err; }
    expect(thrown).toMatchObject({ name: 'MoeError', codeName: 'INVALID_INPUT', context: { field } });
  });
});

describe('decideRepair budgets', () => {
  it('C1 spends the code budget one failing candidate at a time, then escalates', () => {
    const c = cands(4);
    const runs = c.map((x, i) => run(`r${i + 1}`, x.id, { outputTail: `different ${i}` }));
    const at = (n: number, policy = POLICY) => decide(c.slice(0, n), runs.slice(0, n), { policy });
    expect(at(1)).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(runs[0], ['r1']) });
    expect(at(2)).toStrictEqual({ action: 'repair', attempt: 2, remaining: 1, diagnostics: diag(runs[1], ['r2', 'r1']) });
    expect(at(3)).toStrictEqual({ action: 'repair', attempt: 3, remaining: 0, diagnostics: diag(runs[2], ['r3', 'r2', 'r1']) });
    expect(at(4)).toStrictEqual({ action: 'escalate', reason: 'code-repair-budget-exhausted', diagnostics: diag(runs[3], ['r4', 'r3', 'r2', 'r1']) });
    expect(at(1, { maxCodeRepairs: 0, maxInfraRetries: 2 })).toMatchObject({ action: 'escalate', reason: 'code-repair-budget-exhausted' });
    expect(at(4, { maxCodeRepairs: 10, maxInfraRetries: 2 })).toMatchObject({ action: 'repair', attempt: 4, remaining: 6 });
  });

  it('C1 a candidate with no run in the middle spends no repair', () => {
    const runs = [run('r1', 'c1', { outputTail: 'a' }), run('r3', 'c3', { outputTail: 'c' })];
    expect(decide(cands(3), runs)).toMatchObject({ action: 'repair', attempt: 2, remaining: 1 });
  });

  it('C2 escalates a failing candidate whose tree equals the previous failing candidate', () => {
    const c = [{ id: 'c1', treeSha: 'same' }, { id: 'c2', treeSha: 'same' }];
    const runs = [run('r1', 'c1', { outputTail: 'a' }), run('r2', 'c2', { outputTail: 'b' })];
    expect(decide(c, runs)).toStrictEqual({ action: 'escalate', reason: 'unchanged-candidate', diagnostics: diag(runs[1], ['r2', 'r1']) });
  });

  it('C3 escalates a changed tree that fails exactly as before; a different tail or exit code repairs', () => {
    const same = [run('r1', 'c1', { outputTail: 'boom' }), run('r2', 'c2', { outputTail: 'boom' })];
    expect(decide(cands(2), same)).toStrictEqual({ action: 'escalate', reason: 'unchanged-failure', diagnostics: diag(same[1], ['r2', 'r1']) });
    const tail = [run('r1', 'c1', { outputTail: 'boom' }), run('r2', 'c2', { outputTail: 'boom!' })];
    expect(decide(cands(2), tail)).toStrictEqual({ action: 'repair', attempt: 2, remaining: 1, diagnostics: diag(tail[1], ['r2', 'r1']) });
    const exit = [run('r1', 'c1', { outputTail: 'boom' }), run('r2', 'c2', { outputTail: 'boom', exitCode: 2 })];
    expect(decide(cands(2), exit).action).toBe('repair');
    // Only each candidate's latest run is compared.
    const latest = [run('r1', 'c1', { outputTail: 'old' }), run('r2', 'c1', { outputTail: 'boom' }), run('r3', 'c2', { outputTail: 'boom' })];
    expect(decide(cands(2), latest)).toMatchObject({ action: 'escalate', reason: 'unchanged-failure' });
  });

  it('I1 retries infrastructure in its own per-candidate budget and never spends a code repair', () => {
    const infra = (id: string, cand: string, outcome: CheckOutcome, exitCode: number) => run(id, cand, { outcome, exitCode, outputTail: id });
    const [r1, r2, r3] = [infra('r1', 'c1', 'infra-failure', 137), infra('r2', 'c1', 'timeout', 124), infra('r3', 'c1', 'infra-failure', 137)];
    const on1 = (runs: Run[], policy = POLICY) => decide(cands(1), runs, { policy });
    expect(on1([r1])).toStrictEqual({ action: 'retry-infra', attempt: 1, remaining: 1, diagnostics: diag(r1, ['r1']) });
    expect(on1([r1, r2])).toStrictEqual({ action: 'retry-infra', attempt: 2, remaining: 0, diagnostics: diag(r2, ['r2', 'r1']) });
    expect(on1([r1, r2, r3])).toStrictEqual({ action: 'escalate', reason: 'infra-retry-budget-exhausted', diagnostics: diag(r3, ['r3', 'r2', 'r1']) });
    expect(on1([r1], { maxCodeRepairs: 3, maxInfraRetries: 0 })).toMatchObject({ action: 'escalate', reason: 'infra-retry-budget-exhausted' });
    // c1's infra runs spent no code repair and none of c2's infra budget.
    const code = run('r4', 'c2', { outputTail: 'assert' });
    expect(decide(cands(2), [r1, r2, r3, code])).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(code, ['r4', 'r3', 'r2', 'r1']) });
    expect(decide(cands(2), [r1, r2, r3, infra('r5', 'c2', 'timeout', 124)])).toMatchObject({ action: 'retry-infra', attempt: 1, remaining: 1 });
  });
});

describe('decideRepair evidence', () => {
  it('N1 a new candidate with no run awaits evidence, even when an older candidate passed', () => {
    const passed = run('r1', 'c1', { exitCode: 0, outcome: 'passed' });
    expect(decide(cands(2), [passed])).toStrictEqual({ action: 'none', reason: 'awaiting-evidence' });
    expect(decide([], [passed]).action).toBe('none');
  });

  it('N1 a pass on the current candidate is passed, whatever failed before; a later failure supersedes it', () => {
    const ok = run('r2', 'c2', { exitCode: 0, outcome: 'passed', outputTail: 'ok' });
    expect(decide(cands(2), [run('r1', 'c1'), ok])).toStrictEqual({ action: 'none', reason: 'passed' });
    expect(decide(cands(2), [run('r1', 'c1'), ok, run('r3', 'c2', { outputTail: 'flaked' })]).action).toBe('repair');
  });

  it('N1 ignores runs that name no listed candidate, even as log refs', () => {
    expect(decide(cands(1), [run('r1', 'ghost')])).toStrictEqual({ action: 'none', reason: 'awaiting-evidence' });
    const real = run('r1', 'c1', { outputTail: 'real' });
    expect(decide(cands(1), [real, run('r2', 'ghost')])).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(real, ['r1']) });
  });

  it.each<[string, Partial<Run>]>([
    ['skipped', { outcome: 'skipped', exitCode: 0 }],
    ['inconclusive', { outcome: 'inconclusive', exitCode: 0 }],
    ['passed with a nonzero exit', { outcome: 'passed', exitCode: 1 }],
    ['code-failure with a zero exit', { outcome: 'code-failure', exitCode: 0 }],
    ['an unrecognised outcome', { outcome: 'weird' as CheckOutcome, exitCode: 0 }],
  ])('N2 %s is not repairable (fails closed)', (_name, over) => {
    const r = run('r1', 'c1', over);
    expect(decide(cands(1), [r])).toStrictEqual({ action: 'escalate', reason: 'non-repairable-outcome', diagnostics: diag(r, ['r1']) });
  });

  it('N3 legacy rows without an outcome classify by exit code', () => {
    const legacy = (id: string, exitCode: number): Run => ({ ...run(id, 'c1', { exitCode }), outcome: undefined });
    expect(decide(cands(1), [legacy('r1', 0)])).toStrictEqual({ action: 'none', reason: 'passed' });
    expect(decide(cands(1), [legacy('r2', 2)])).toStrictEqual({
      action: 'repair', attempt: 1, remaining: 2, diagnostics: { ...diag(legacy('r2', 2), ['r2']), outcome: 'code-failure' },
    });
  });

  it('R1 an unapproved plan revision needs a replan before anything else is read', () => {
    const replan = { action: 'replan', reason: 'plan-revision-unapproved' };
    expect(decide(cands(1), [run('r1', 'c1')], { planRevision: 2, approvedPlanRevision: 1 })).toStrictEqual(replan);
    expect(decide([], [], { planRevision: 2, approvedPlanRevision: undefined })).toStrictEqual(replan);
  });

  it('R1 runs of an older plan revision are ignored (fresh budget); a run without a revision still counts', () => {
    const c = cands(4);
    const old = c.map((x, i) => run(`r${i + 1}`, x.id, { outputTail: `old ${i}` }));
    const rev2 = { planRevision: 2, approvedPlanRevision: 2 };
    expect(decide(c, old, rev2)).toStrictEqual({ action: 'none', reason: 'awaiting-evidence' });
    const fresh = run('r5', 'c4', { planRevision: 2, outputTail: 'new world' });
    expect(decide(c, [...old, fresh], rev2)).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(fresh, ['r5']) });
    expect(decide(cands(1), [run('r6', 'c1', { planRevision: undefined })]).action).toBe('repair');
  });
});

describe('decideRepair diagnostics and determinism', () => {
  it('D1 diagnostics come from the latest run of the current candidate', () => {
    const runs = [
      run('r1', 'c1', { outputTail: 'first' }),
      run('r2', 'c2', { outputTail: 'first run on c2', command: 'npm run lint' }),
      run('r3', 'c2', { outputTail: 'second run on c2', exitCode: 3, command: 'npm run lint' }),
    ];
    expect(decide(cands(2), runs)).toStrictEqual({ action: 'repair', attempt: 2, remaining: 1, diagnostics: diag(runs[2], ['r3', 'r2', 'r1']) });
  });

  it('D1 the excerpt is the last 20 lines, at most 2000 characters, never starting on half a surrogate pair', () => {
    const excerpt = (outputTail: string) => diagOf(decide(cands(1), [run('r1', 'c1', { outputTail })]))?.excerpt;
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    expect(excerpt(`${lines.join('\n')}\n`)).toBe(lines.slice(-20).join('\n'));
    expect(excerpt('x'.repeat(16 * 1024))).toBe('x'.repeat(2000));
    expect(excerpt(`${'a'.repeat(5000)}\n${'b'.repeat(5000)}`)).toBe('b'.repeat(2000));
    // 2401 code units: the last 2000 start on the LOW half of an emoji, which must be dropped.
    expect(excerpt(`${'😀'.repeat(1200)}z`)).toBe(`${'😀'.repeat(999)}z`);
    expect(excerpt('')).toBe('');
  });

  it('D1 logRefs are at most 5 non-passing run ids, newest first', () => {
    const runs = [
      ...Array.from({ length: 7 }, (_, i) => run(`f${i + 1}`, 'c1', { outputTail: `tail ${i}` })),
      run('ok', 'c1', { exitCode: 0, outcome: 'passed' }),
      run('last', 'c2', { outputTail: 'last' }),
    ];
    expect(diagOf(decide(cands(2), runs))?.logRefs).toStrictEqual(['last', 'f7', 'f6', 'f5', 'f4']);
  });

  it('D2 the decision is independent of input order', () => {
    const runs = ['a', 'b', 'c', 'd'].map((t, i) => run(`r${i + 1}`, `c${Math.min(i + 1, 3)}`, { outputTail: t }));
    const expected = decide(cands(3), runs);
    expect(expected).toMatchObject({ action: 'repair', attempt: 3, diagnostics: { checkRunId: 'r4' } });
    for (const order of [[3, 2, 1, 0], [2, 0, 3, 1], [3, 1, 2, 0]]) {
      expect(decide(cands(3), order.map((i) => runs[i]))).toStrictEqual(expected);
    }
  });

  it('D2 equal timestamps order by id by code unit, a missing createdAt sorts first, a duplicated id counts once', () => {
    const at = { createdAt: '2026-10-30T00:00:00.000Z' };
    const [a, b, upper] = [run('a', 'c1', at), run('b', 'c1', at), run('B', 'c1', at)];
    for (const order of [[a, b, upper], [upper, b, a], [b, a, upper]]) {
      expect(diagOf(decide(cands(1), order))).toMatchObject({ checkRunId: 'b', logRefs: ['b', 'a', 'B'] });
    }
    expect(diagOf(decide(cands(1), [run('a', 'c1'), run('z', 'c1', { createdAt: undefined })]))?.checkRunId).toBe('a');
    const [one, two] = [run('dup', 'c1', { ...at, outputTail: 'one' }), run('dup', 'c1', { ...at, outputTail: 'two' })];
    expect(decide(cands(1), [two, one])).toStrictEqual(decide(cands(1), [one, two]));
    expect(decide(cands(1), [one, two])).toMatchObject({ action: 'repair', attempt: 1, diagnostics: { logRefs: ['dup'] } });
  });
});

// task-42e9990c: the real host check session (scripts/local-runner/check-session.mjs, imported by this test only) settles
// a fake provider's clean, frameless supervisor exit, and its actual result is the run decideRepair reads, as
// check-dispatch records it (no exitCode becomes -1). A candidate dependency refusal (82) repairs with the fixed host
// text; the environment's 81 retries infrastructure in its own budget. The guest's stderr is never read.
interface Settled { outcome: CheckOutcome; exitCode: number | null; signal: string | null; outputTail: string }
type FakeChild = EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill(signal?: string): boolean };
const runner = (name: string) => import(new URL(`../../../../scripts/local-runner/${name}`, import.meta.url).href);

// CQ-R14d3 (6ac51c42): the session opens its check stream over the SSH route (guest-stream.mjs openGuestStream), which reads
// the guest address through provider.run before it spawns ssh. This is the shape of scripts/tests/local-runner-check.test.mjs
// CHECK_ROUTE: a fake run answers only that one info read, and ssh and keyDir are strings that are never created or executed
// (spawn is faked). The provider records its run args and spawn commands so settle can prove no real binary ran.
const INFO = { state: 'Running', image_hash: 'a'.repeat(64), image_release: '24.04 LTS', cpu_count: '2', memory: {}, disks: { sda1: {} }, mounts: {},
  ipv4: ['10.0.0.2'] };
const SSH = join(tmpdir(), 'moe-stream', 'ssh');
const KEYS = join(tmpdir(), 'moe-stream', 'keys');

// The scripts test's checkProvider order: the check frame's write completes, stdout ends, then the child closes with code.
// The child emits only from its stdin write callback, never synchronously after spawn, because the spawn now follows an
// async info read and a late listener would miss an eager emit.
function exitingProvider(code: number, name: string) {
  const runCalls: string[][] = [];
  const spawnCommands: string[] = [];
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
      child.stderr.end('npm ERR! //registry.npmjs.org/:_authToken=npm_secret0123\n');
      child.stdout.once('close', () => child.emit('close', code, null)).end();
    },
  });
  child.kill = (signal) => { setImmediate(() => child.emit('close', null, signal ?? 'SIGKILL')); return true; };
  const run = async (_executable: string, args: string[]) => {
    runCalls.push(args);
    if (JSON.stringify(args) !== JSON.stringify(['info', name, '--format', 'json'])) throw new Error('unexpected provider call');
    return { stdout: JSON.stringify({ errors: [], info: { [name]: INFO } }), stderr: '' };
  };
  const spawn = (command: string) => { spawnCommands.push(command); return child; };
  return { provider: { run, spawn, ssh: SSH, keyDir: KEYS }, runCalls, spawnCommands };
}

async function settle(code: number): Promise<Settled> {
  const [{ runCheckSession }, { ownedInstanceName }] = await Promise.all([runner('check-session.mjs'), runner('lifecycle.mjs')]);
  const name = ownedInstanceName({ random: () => Buffer.alloc(10, 0xab) });
  const { provider, runCalls, spawnCommands } = exitingProvider(code, name);
  const settled = await runCheckSession({ name, check: { id: 'unit-1', command: 'npm test', protected: [] }, provider, budgetMs: 5_000, timeoutMs: 1_000 });
  // Only the fake info read and one fake-ssh spawn happened: the SSH route ran and no real multipass or ssh did.
  expect(runCalls).toStrictEqual([['info', name, '--format', 'json']]);
  expect(spawnCommands).toStrictEqual([SSH]);
  return settled;
}
const observed = (id: string, candidateId: string, s: Settled) =>
  run(id, candidateId, { outcome: s.outcome, exitCode: s.exitCode ?? -1, outputTail: s.outputTail });

describe('decideRepair over real host check sessions', () => {
  it('H1 a candidate dependency refusal (82) repairs with the fixed host text, even with no infrastructure budget', async () => {
    const { DEPENDENCIES_CANDIDATE_INVALID } = await runner('check-session.mjs');
    const refused = await settle(DEPENDENCIES_CANDIDATE_INVALID);
    expect(refused).toMatchObject({ outcome: 'code-failure', exitCode: 82, signal: null });
    expect(refused.outputTail).toMatch(/^MOE_DEPENDENCY_CANDIDATE_INVALID: [\x20-\x7e]+$/);
    expect(Buffer.byteLength(refused.outputTail)).toBeLessThanOrEqual(512);
    expect(refused.outputTail).not.toContain('secret');
    const r1 = observed('r1', 'c1', refused);
    expect(decide(cands(1), [r1])).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(r1, ['r1']) });
    expect(diagOf(decide(cands(1), [r1]))?.excerpt).toBe(refused.outputTail);
    expect(decide(cands(1), [r1], { policy: { maxCodeRepairs: 3, maxInfraRetries: 0 } })).toMatchObject({ action: 'repair', attempt: 1, remaining: 2 });
  });

  it('H2 an environment dependency failure (81) retries infrastructure in its own budget, then escalates, and spends no code repair', async () => {
    const { DEPENDENCIES_FAILED, DEPENDENCIES_CANDIDATE_INVALID } = await runner('check-session.mjs');
    const failed = await settle(DEPENDENCIES_FAILED);
    expect(failed).toStrictEqual({ outcome: 'infra-failure', exitCode: null, signal: null, outputTail: '' });
    const [r1, r2, r3] = ['r1', 'r2', 'r3'].map((id) => observed(id, 'c1', failed));
    expect(r1.exitCode).toBe(-1);
    const on1 = (runs: Run[], policy = POLICY) => decide(cands(1), runs, { policy });
    expect(on1([r1])).toStrictEqual({ action: 'retry-infra', attempt: 1, remaining: 1, diagnostics: diag(r1, ['r1']) });
    expect(on1([r1, r2])).toStrictEqual({ action: 'retry-infra', attempt: 2, remaining: 0, diagnostics: diag(r2, ['r2', 'r1']) });
    expect(on1([r1, r2, r3])).toStrictEqual({ action: 'escalate', reason: 'infra-retry-budget-exhausted', diagnostics: diag(r3, ['r3', 'r2', 'r1']) });
    expect(on1([r1], { maxCodeRepairs: 3, maxInfraRetries: 0 })).toMatchObject({ action: 'escalate', reason: 'infra-retry-budget-exhausted' });
    // c1's infrastructure runs left the code budget whole: c2's candidate refusal is repair 1 of 3.
    const r4 = observed('r4', 'c2', await settle(DEPENDENCIES_CANDIDATE_INVALID));
    expect(decide(cands(2), [r1, r2, r3, r4])).toStrictEqual({ action: 'repair', attempt: 1, remaining: 2, diagnostics: diag(r4, ['r4', 'r3', 'r2', 'r1']) });
  });

  it('H3 the same candidate refusal again never retries infrastructure: an unchanged failure or tree escalates as code', async () => {
    const { DEPENDENCIES_CANDIDATE_INVALID } = await runner('check-session.mjs');
    const [first, again] = [await settle(DEPENDENCIES_CANDIDATE_INVALID), await settle(DEPENDENCIES_CANDIDATE_INVALID)];
    expect(again).toStrictEqual(first);
    const runs = [observed('r1', 'c1', first), observed('r2', 'c2', again)];
    expect(decide(cands(2), runs)).toStrictEqual({ action: 'escalate', reason: 'unchanged-failure', diagnostics: diag(runs[1], ['r2', 'r1']) });
    expect(decide([{ id: 'c1', treeSha: 'same' }, { id: 'c2', treeSha: 'same' }], runs)).toMatchObject({ action: 'escalate', reason: 'unchanged-candidate' });
  });
});

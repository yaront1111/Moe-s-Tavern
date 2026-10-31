import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodingSnapshot, digestFiles, FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY,
  validateWorkload, WORKLOAD_CANDIDATE_ROOT_ENV } from './workloadSnapshot.js';
import { buildOutcomeRecord, checkPreconditions, criteriaFromTap, decideStop, readUsageReceipts,
  rolesFromReceipts, runAssessment, runBaselineWorkload, terminateTree, validateRecord } from './baselineRun.js';

const moeRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).reverse().map(fn => fn())); });
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moe-driver-test-'));
  cleanup.push(async () => {
    for (const name of await fs.readdir(root)) {
      if (!name.startsWith('moe-baseline-')) continue;
      try { const p = JSON.parse(await fs.readFile(path.join(root, name, 'processes.json'), 'utf8')); [p.daemon, ...p.seats].forEach(killGroup); } catch { /* setup may have failed */ }
      try { const p = JSON.parse(await fs.readFile(path.join(root, name, 'project-path.json'), 'utf8')); if (p.root.startsWith(path.join(os.tmpdir(), 'moe-workload-coding-'))) await fs.rm(p.root, { recursive: true, force: true }); } catch { /* no snapshot */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function treeDigest(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? await treeDigest(path.join(dir, entry.name)) : await fs.readFile(path.join(dir, entry.name)));
  }
  return hash.digest('hex');
}
function fixture(hang = false) {
  const initialFiles = { 'value.mjs': 'export const value = 0;\n' };
  const assessmentFiles = { 'held-out.test.mjs': `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {value} = await import(pathToFileURL(process.env.${WORKLOAD_CANDIDATE_ROOT_ENV} + '/value.mjs'));
test('correct-value: returns the fixed value', async () => { ${hang ? 'await new Promise(() => {setInterval(() => {}, 1000)});' : 'assert.equal(value, 1);'} });` };
  return validateWorkload({ contractVersion: 1, id: 'defect-baseline-driver', category: 'defect',
    startingCommit: FROZEN_STARTING_COMMIT, source: { repository: SOURCE_REPOSITORY, paths: ['value.mjs'], adaptation: 'adapted', note: 'Synthetic driver fixture.' },
    intendedBehavior: 'Export value equal to 1.', initialFiles, assessmentFiles,
    snapshotDigest: digestFiles(initialFiles), assessmentDigest: digestFiles(assessmentFiles),
    rubric: { criteria: [{ id: 'correct-value', description: 'The exported value equals 1.' }], coverageTags: ['changed-requirements'] } });
}
const options = () => ({ workload: fixture(), corpusVersion: 1, moeCommit: FROZEN_STARTING_COMMIT, moeRoot });
const receipt = (overrides = {}) => ({ version: 1, taskId: 'task-one', role: 'worker', launchId: 'launch-one',
  requestedModel: 'requested-only', requestedEffort: 'high', reportedModels: ['actual-model'], ...overrides });

it('U1 receipts use reported models, requested effort and distinct task launch ids only', () => {
  const rows = [receipt(), receipt(), receipt({ taskId: 'decoy' }), receipt({ version: 2 }), '{bad', receipt({ role: 'governor' })];
  expect(rolesFromReceipts(rows, 'task-one', 'claude')).toEqual({ notes: [], roles: [
    { role: 'architect', cli: 'claude', model: null, effort: null, launches: null },
    { role: 'worker', cli: 'claude', model: 'actual-model', effort: 'high', launches: 1 },
    { role: 'qa', cli: 'claude', model: null, effort: null, launches: null },
  ] });
  expect(rolesFromReceipts([receipt({ reportedModels: [] })], 'task-one', 'claude').roles[1].model).toBeNull();
  const mixed = rolesFromReceipts([receipt(), receipt({ launchId: 'two', requestedEffort: 'max', reportedModels: ['other'] })], 'task-one', 'claude');
  expect(mixed.roles[1]).toMatchObject({ model: null, effort: null, launches: 2 });
  expect(mixed.notes).toHaveLength(1);
  expect(rolesFromReceipts([receipt({ requestedEffort: null })], 'task-one', 'claude').roles[1].effort).toBeNull();
  expect(mixed.notes[0].length).toBeLessThanOrEqual(200);
});
it('U1 reads bounded regular receipts, skips malformed lines and directories without echoing content', async () => {
  const dir = await temp();
  await fs.writeFile(path.join(dir, 'one.jsonl'), JSON.stringify(receipt()) + '\nSECRET-BROKEN\n');
  await fs.mkdir(path.join(dir, 'directory.jsonl'));
  const result = await readUsageReceipts(dir);
  expect(result.rows).toEqual([receipt()]);
  expect(result.malformedLines).toBe(1);
  expect(JSON.stringify(result.notes)).not.toContain('SECRET');
  await fs.writeFile(path.join(dir, 'large-line.jsonl'), 'x'.repeat(256 * 1024 + 1) + '\n');
  expect((await readUsageReceipts(dir)).malformedLines).toBe(2);
  const missing = await readUsageReceipts(path.join(dir, 'missing'));
  expect(missing.rows).toEqual([]);
  expect(missing.notes.length).toBeGreaterThan(0);
});
// An NT file symlink needs SeCreateSymbolicLinkPrivilege (elevation or Developer Mode); POSIX always runs the link case.
const canSymlink = process.platform !== 'win32' || (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'moe-symlink-probe-'));
  try { symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file'); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return false; throw e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
})();
it.runIf(canSymlink)('U1 never follows a receipt symlink', async () => {
  const dir = await temp();
  await fs.writeFile(path.join(dir, 'one.jsonl'), JSON.stringify(receipt()) + '\n');
  await fs.symlink(path.join(dir, 'one.jsonl'), path.join(dir, 'link.jsonl'));
  expect(await readUsageReceipts(dir)).toEqual({ rows: [receipt()], malformedLines: 0, notes: [] });
});
it('U2 TAP handles nested lines, failure dominance, absent ids, comments and bounded output', () => {
  const output = 'ok 1 - a: pass\n    ok 2 - b: nested\nnot ok 3 - a: fail\nok 4 - decoy: pass\n# ok 5 - c: spoof\n';
  expect(criteriaFromTap(output, ['a', 'b', 'c'])).toEqual([
    { id: 'a', result: 'fail' }, { id: 'b', result: 'pass' }, { id: 'c', result: 'not-run' },
  ]);
  expect(criteriaFromTap('x'.repeat(1024 * 1024) + '\nok 1 - a: beyond cap', ['a'])[0].result).toBe('not-run');
});
it('U3 assesses a separate held-out snapshot against the final candidate, never copying tests to coding', async () => {
  const workload = fixture();
  const coding = await createCodingSnapshot(workload); cleanup.push(() => coding.dispose());
  expect(await fs.readdir(coding.root)).toEqual(['value.mjs']);
  const failed = await runAssessment(workload, coding.root, { timeoutMs: 3000 });
  expect(failed).toMatchObject({ ran: true, exitCode: 1, criteria: [{ id: 'correct-value', result: 'fail' }] });
  await fs.writeFile(path.join(coding.root, 'value.mjs'), 'export const value = 1;\n');
  expect(await runAssessment(workload, coding.root, { timeoutMs: 3000 })).toMatchObject({ ran: true, exitCode: 0, criteria: [{ id: 'correct-value', result: 'pass' }] });
  expect(await fs.readdir(coding.root)).toEqual(['value.mjs']);
});
// terminateTree signals POSIX process groups; on win32 process.kill(-pid) throws ESRCH, so a hung assessment is never killed and outlives the run.
it.skipIf(process.platform === 'win32')('U3 assessment timeout preserves not-run and a null exit', async () => {
  const coding = await createCodingSnapshot(fixture()); cleanup.push(() => coding.dispose());
  expect(await runAssessment(fixture(true), coding.root, { timeoutMs: 100 })).toEqual({ ran: true, exitCode: null,
    criteria: [{ id: 'correct-value', result: 'not-run' }], reason: 'assessment timed out' });
});
it.each(['completed', 'capped', 'failed', 'aborted'] as const)('U4 %s record is accepted unchanged; unknowns stay null', async status => {
  const record = buildOutcomeRecord({ ...options(), startedAt: 1000, wallClockMs: status === 'capped' ? 3_600_000 : 500,
    status, assessment: { ran: false, exitCode: null, criteria: [{ id: 'correct-value', result: 'not-run' }], reason: 'not started' } });
  expect(await validateRecord(record, moeRoot)).toEqual(record);
  expect(record.run.wallClockCapMs).toBe(3_600_000);
  expect(record.run.endedAt).toBe(new Date(1000 + record.run.wallClockMs).toISOString());
  expect(record.latency.firstCodeChangeMs).toBeNull();
  expect(record.retrieval).toEqual({ sourceRetrievals: null, retrievedBytes: null });
  expect(record.moeOutcome.repairAttempts).toBeNull();
});
it('U4 completedAt fixes timing at the cap even with a late poll; skew cannot mint completion', () => {
  const task = { status: 'DONE', completedAt: new Date(1100).toISOString() };
  expect(decideStop(task, 1000, 100, 2000)).toEqual({ status: 'completed', wallClockMs: 100 });
  expect(decideStop({ ...task, completedAt: new Date(999).toISOString() }, 1000, 100, 1200)).toEqual({ status: 'capped', wallClockMs: 200 });
  expect(decideStop({ status: 'WORKING' }, 1000, 100, 1050)).toBeNull();
  expect(decideStop({ status: 'WORKING' }, 1000, 100, 1100)).toEqual({ status: 'capped', wallClockMs: 100 });
});
async function until(condition: () => Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await condition())) { if (Date.now() >= end) throw new Error('condition timed out'); await delay(25); }
}
const killGroup = (pid: number) => { try { if (pid > 0) process.kill(-pid, 'SIGKILL'); } catch { /* already reaped */ } };
const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } };
it.skipIf(process.platform === 'win32')('U5 terminates the complete detached process tree', async () => {
  const dir = await temp();
  const child = spawn('bash', ['-c', `trap 'wait; exit' TERM; bash -c 'trap "wait; exit" TERM; sleep 60 & echo $! > "$1/grandchild"; wait' bash "$1" & echo $! > "$1/child"; wait`, 'bash', dir], { detached: true, stdio: 'ignore' });
  cleanup.push(async () => { killGroup(child.pid!); });
  await until(async () => existsSync(path.join(dir, 'grandchild')));
  const pids = [child.pid!, ...await Promise.all(['child', 'grandchild'].map(async name => Number(await fs.readFile(path.join(dir, name), 'utf8'))))];
  await terminateTree(child, 500);
  await until(async () => pids.every(dead));
  pids.forEach(pid => expect(dead(pid)).toBe(true));
});
it.skipIf(process.platform === 'win32')('U5 escalates a group ignoring TERM', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  cleanup.push(async () => { killGroup(child.pid!); });
  await new Promise(resolve => child.stdout!.once('data', resolve));
  expect(await terminateTree(child, 50)).toBe(true);
  await until(async () => dead(child.pid!));
});
it('U6 rejects invalid inputs and missing artifacts before creating directories', async () => {
  const before = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('moe-baseline-'));
  await expect(checkPreconditions({ ...options(), moeCommit: 'BAD' })).rejects.toThrow();
  await expect(checkPreconditions({ ...options(), workload: { ...fixture(), id: '../escape' } })).rejects.toThrow();
  for (const missing of ['packages/moe-daemon/dist/index.js', 'packages/moe-proxy/dist/index.js', 'scripts/moe-agent.sh']) {
    const root = await temp();
    for (const f of ['packages/moe-daemon/dist/index.js', 'packages/moe-proxy/dist/index.js', 'scripts/moe-agent.sh', 'scripts/moe-call.sh', 'scripts/baseline-report.mjs']) {
      if (f !== missing) { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), ''); }
    }
    await expect(checkPreconditions({ ...options(), moeRoot: root })).rejects.toThrow(/.{1,200}/);
  }
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  await expect(checkPreconditions(options())).rejects.toThrow(/POSIX/);
  expect((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('moe-baseline-'))).toEqual(before);
});

const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('fake-claude 1.0'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'})); process.exit(0); }
const env = process.env, role = env.MOE_WORKER_ID.split('-')[0];
const arg = flag => process.argv[process.argv.indexOf(flag)+1];
const model = arg('--model'), effort = arg('--effort');
fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({role,model,effort,pid:process.pid,home:env.HOME,ambient:env.MOE_UNRELATED_SECRET??null})+'\\n');
function call(tool,args={}) {
  const output=cp.execFileSync('bash',[env.FAKE_MOE_ROOT+'/scripts/moe-call.sh',tool,JSON.stringify(args),'--project',env.MOE_PROJECT_PATH], {encoding:'utf8',timeout:15000});
  const result=JSON.parse(output); if(result.error || result.success === false || result.code) throw new Error('fake tool failed '+tool+': '+output); return result;
}
const context=call('get_context'); const task=context.task, taskId=task.id;
if(role==='architect') call('submit_plan',{taskId,steps:[{description:'Fix exported value and verify with node --check value.mjs.',affectedFiles:['value.mjs']}]});
if(role==='worker') {
  const stepId=task.implementationPlan[0].stepId; call('start_step',{taskId,stepId});
  if(env.FAKE_MODE==='hang') {
    const child=cp.spawn('sleep',['120']); fs.writeFileSync(env.FAKE_PID_DIR+'/pids',JSON.stringify([process.pid,child.pid]));
    process.on('SIGTERM',()=>{child.kill('SIGTERM');child.on('exit',()=>process.exit(0));});
    setInterval(()=>{},1000);
  } else {
    fs.writeFileSync('value.mjs','export const value = 1;\\n');
    cp.execFileSync(process.execPath,['--check','value.mjs']);
    call('complete_step',{taskId,stepId,modifiedFiles:['value.mjs'],note:'Fake CLI fixture only.'});
    call('complete_task',{taskId,verification:{command:'node --check value.mjs',exitCode:0,outputTail:'syntax ok'}});
  }
}
if(role==='qa') { cp.execFileSync(process.execPath,['--check','value.mjs']); call('qa_approve',{taskId,candidateId:context.currentCandidate?.id,summary:'Fake fixture: node --check value.mjs passed.'}); }
if(!(role==='worker'&&env.FAKE_MODE==='hang')) console.log(JSON.stringify({type:'result',subtype:'success',session_id:role,modelUsage:{[model]:{}},usage:{input_tokens:7,output_tokens:3},result:'fixture done'}));
`;
const runnable = process.platform !== 'win32' && ['bash', 'python3', 'git'].every(cmd => spawnSync(cmd, ['--version']).status === 0)
  && ['moe-daemon', 'moe-proxy'].every(pkg => existsSync(path.join(moeRoot, `packages/${pkg}/dist/index.js`)));
async function fakeOptions(mode = 'fix') {
  const root = await temp(); const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), fakeCli, { mode: 0o700 });
  return { ...options(), sourceDirty: true, parentDir: root, capMs: 60_000, pollMs: 50, killGraceMs: 500,
    seatEnv: { PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: path.join(root, 'launches.jsonl'),
      FAKE_MODE: mode, FAKE_PID_DIR: root, FAKE_MOE_ROOT: moeRoot } };
}
async function assertStopped(root: string) {
  const pids = JSON.parse(await fs.readFile(path.join(root, 'processes.json'), 'utf8')) as { daemon: number; seats: number[] };
  expect(pids.seats.length).toBeLessThanOrEqual(3);
  await until(async () => [pids.daemon, ...pids.seats].every(dead));
}
async function registerResult(result: Awaited<ReturnType<typeof runBaselineWorkload>>) {
  await assertStopped(result.runRoot);
  const project = (JSON.parse(await fs.readFile(path.join(result.runRoot, 'project-path.json'), 'utf8')) as { root: string }).root;
  cleanup.push(() => fs.rm(project, { recursive: true, force: true }));
  return project;
}
async function launches(file: string): Promise<Array<{ role: string; model: string; effort: string; pid: number; home: string; ambient: string | null }>> {
  return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
describe.runIf(runnable)('real daemon and wrapper, fake agent only', () => {
  it('E1 completed run is accepted unchanged, joins usage and preserves boundaries/defaults', async () => {
    const opts = await fakeOptions();
    const sentinel = await temp(); await fs.writeFile(path.join(sentinel, 'sentinel'), 'unchanged');
    const scriptBefore = await treeDigest(path.join(moeRoot, 'scripts'));
    vi.stubEnv('HOME', sentinel); vi.stubEnv('MOE_WORKER_ID', 'foreign-seat');
    vi.stubEnv('MOE_UNRELATED_SECRET', 'never-in-seat');
    const cwd = process.cwd(); process.chdir(sentinel);
    let result: Awaited<ReturnType<typeof runBaselineWorkload>>;
    try { result = await runBaselineWorkload(opts); } finally { process.chdir(cwd); vi.unstubAllEnvs(); }
    const project = await registerResult(result); const { record } = result;
    expect(await validateRecord(record, moeRoot)).toEqual(record);
    expect(JSON.parse(await fs.readFile(result.recordPath, 'utf8'))).toEqual(record);
    expect(result.recordPath).toBe(path.join(result.runRoot, 'records', opts.workload.id + '.json'));
    expect(record.run).toMatchObject({ status: 'completed', moeCommit: opts.moeCommit, repetition: 1, repetitionsPlanned: 1, cliVersion: 'fake-claude 1.0', platform: process.platform, nodeVersion: process.version });
    expect(record.run.wallClockMs).toBeLessThanOrEqual(opts.capMs);
    const logged = await launches(opts.seatEnv.FAKE_CLAUDE_LOG);
    for (const r of record.run.roles) {
      const entries = logged.filter(l => l.role === r.role);
      expect(entries).toHaveLength(1);
      expect(r).toEqual({ role: r.role, cli: 'claude', model: entries[0].model, effort: entries[0].effort, launches: entries.length });
    }
    expect(logged.every(l => l.home === path.join(result.runRoot, 'home') && l.ambient === null)).toBe(true);
    expect(record.moeOutcome).toEqual({ finalStatus: 'DONE', qaApprovals: 1, qaRejections: 0, reopenCount: 0, plannerSessions: 1, repairAttempts: null });
    expect(record.assessment).toMatchObject({ ran: true, exitCode: 0, criteria: [{ id: 'correct-value', result: 'pass' }] });
    expect(record.latency.firstCodeChangeMs).toBeNull();
    expect(record.retrieval).toEqual({ sourceRetrievals: null, retrievedBytes: null });
    expect(record.notes.join(' ')).toContain('dirty'); expect(record.notes.join(' ')).toContain('TURBO'); expect(record.notes.join(' ')).toContain('FAKE_MODE');
    const task = JSON.parse(await fs.readFile(path.join(project, '.moe/tasks', record.run.usageTaskId! + '.json'), 'utf8'));
    expect(task.commits.some((c: { kind: string; sha: string }) => c.kind === 'completion' && /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
    expect(task.definitionOfDone).toEqual(opts.workload.rubric.criteria.map(c => c.description));
    expect(await fs.readFile(path.join(sentinel, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(await fs.readdir(sentinel)).toEqual(['sentinel']);
    expect(await treeDigest(path.join(moeRoot, 'scripts'))).toBe(scriptBefore);
    expect(spawnSync('git', ['-C', project, 'remote'], { encoding: 'utf8' }).stdout).toBe('');
    const rootCommit = spawnSync('git', ['-C', project, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    expect(spawnSync('git', ['-C', project, 'show', '-s', '--format=%s', rootCommit], { encoding: 'utf8' }).stdout.trim()).toBe('baseline initial snapshot');
    expect(existsSync(path.join(result.runRoot, 'home/.moe'))).toBe(true);
    const usageDir = path.join(result.runRoot, 'usage', opts.workload.id);
    const usageModule = await import(pathToFileURL(path.join(moeRoot, 'scripts/usage-report.mjs')).href);
    const baselineModule = await import(pathToFileURL(path.join(moeRoot, 'scripts/baseline-report.mjs')).href);
    const usage = usageModule.buildUsageReport(usageDir);
    const report = baselineModule.buildBaselineReport({ records: [record], usageByWorkload: { [opts.workload.id]: usage } });
    expect(report.rows[0].usage.status).toBe('observed');
    expect(report.rows[0].acceptance).toBe('accepted');
  }, 240_000);
  it('E2 caps once, kills trees and preserves partial task and usage observations', async () => {
    const opts = await fakeOptions('hang'); opts.capMs = 25_000;
    const stopIdleSeat = until(async () => existsSync(path.join(opts.parentDir, 'pids')), 20_000).then(async () => {
      const runDir = (await fs.readdir(opts.parentDir)).find(n => n.startsWith('moe-baseline-'))!;
      const pids = JSON.parse(await fs.readFile(path.join(opts.parentDir, runDir, 'processes.json'), 'utf8'));
      process.kill(-pids.seats[2], 'SIGTERM'); // intentional early seat exit; no replacement permitted
    });
    const result = await runBaselineWorkload(opts); await stopIdleSeat; const project = await registerResult(result);
    expect(result.record.run.status).toBe('capped');
    expect(result.record.run.wallClockMs).toBeGreaterThanOrEqual(opts.capMs);
    const pids: number[] = JSON.parse(await fs.readFile(path.join(opts.parentDir, 'pids'), 'utf8'));
    await until(async () => pids.every(dead));
    const logged = await launches(opts.seatEnv.FAKE_CLAUDE_LOG);
    expect(logged.filter(l => l.role === 'worker')).toHaveLength(1);
    const task = JSON.parse(await fs.readFile(path.join(project, '.moe/tasks', result.record.run.usageTaskId! + '.json'), 'utf8'));
    expect(result.record.moeOutcome.finalStatus).toBe(task.status);
    expect(result.record.moeOutcome.plannerSessions).toBeGreaterThanOrEqual(1);
    expect(result.record.assessment.criteria[0].result).toBe('fail');
    expect(await fs.readdir(path.join(result.runRoot, 'records'))).toEqual([opts.workload.id + '.json']);
  }, 120_000);
  it('E3 daemon failure writes a bounded failed record without launching a seat', async () => {
    const opts = await fakeOptions();
    const input = { ...opts, workload: { ...opts.workload }, daemonCommand: [process.execPath, '-e', 'process.exit(9)'] as [string, ...string[]] };
    const running = runBaselineWorkload(input); input.workload.id = '../escape';
    const result = await running;
    expect(result.record.workload.id).toBe(opts.workload.id);
    await registerResult(result);
    expect(result.record.run.status).toBe('failed');
    expect(result.record.run.failureReason).toMatch(/daemon/);
    expect(result.record.run.failureReason!.length).toBeLessThanOrEqual(200);
    expect(result.record.run.roles.every(r => r.model === null && r.effort === null && r.launches === null)).toBe(true);
    expect(result.record.assessment.ran).toBe(false);
    expect(existsSync(opts.seatEnv.FAKE_CLAUDE_LOG)).toBe(false);
  }, 120_000);
  it('E4 abort after seats start kills processes and writes the aborted record', async () => {
    const opts = await fakeOptions('hang'); const controller = new AbortController();
    const watching = until(async () => existsSync(opts.seatEnv.FAKE_CLAUDE_LOG), 30_000).then(() => controller.abort());
    const result = await runBaselineWorkload({ ...opts, signal: controller.signal }); await watching;
    await registerResult(result);
    expect(result.record.run.status).toBe('aborted');
    expect(existsSync(result.recordPath)).toBe(true);
    const logged = await launches(opts.seatEnv.FAKE_CLAUDE_LOG);
    await until(async () => logged.every(l => dead(l.pid)));
  }, 120_000);
  it('E5 daemon child exit fails the run rather than accepting a supervisor restart', async () => {
    const opts = await fakeOptions('hang');
    const interrupt = until(async () => existsSync(opts.seatEnv.FAKE_CLAUDE_LOG), 30_000).then(async () => {
      const run = (await fs.readdir(opts.parentDir)).find(n => n.startsWith('moe-baseline-'))!;
      const {root} = JSON.parse(await fs.readFile(path.join(opts.parentDir, run, 'project-path.json'), 'utf8'));
      const info = JSON.parse(await fs.readFile(path.join(root, '.moe/daemon.json'), 'utf8'));
      process.kill(info.pid, 'SIGKILL');
    });
    const result = await runBaselineWorkload(opts); await interrupt; await registerResult(result);
    expect(result.record.run.status).toBe('failed');
    expect(result.record.run.failureReason).toContain('daemon');
  }, 120_000);
  it('E6 a synchronous process launch refusal still records a failed outcome', async () => {
    const opts = await fakeOptions();
    const result = await runBaselineWorkload({ ...opts, daemonCommand: ['invalid\0command'] });
    expect(result.record.run.status).toBe('failed');
    expect(result.record.run.failureReason).toBe('daemon startup failed');
    if (process.platform === 'linux') {
      const links = await Promise.all((await fs.readdir('/proc/self/fd')).map(fd => fs.readlink('/proc/self/fd/' + fd).catch(() => '')));
      expect(links).not.toContain(path.join(result.runRoot, 'logs/daemon.log'));
    }
    expect(result.record.assessment.ran).toBe(false);
    expect(await validateRecord(result.record, moeRoot)).toEqual(result.record);
    expect(existsSync(opts.seatEnv.FAKE_CLAUDE_LOG)).toBe(false);
  }, 30_000);
});

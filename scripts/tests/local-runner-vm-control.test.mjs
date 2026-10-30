import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createLedger, lifecycleError } from '../local-runner/lifecycle.mjs';
import {
  canonicalProjectPath, cleanupReport, mcpCaller, ownedLedgerDir, readDaemonInfo, reconcileReport, runVmControl, statusReport,
} from '../local-runner/vm-control.mjs';

const CLI = fileURLToPath(new URL('../local-runner/vm-control.mjs', import.meta.url));
const INVALID = '{"code":"VM_CONTROL_INPUT_INVALID"}\n';
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32);
const owner = n => ({ taskId: `task-${n}`, attemptId: `attempt-${n}`, generation: 1 });
const FOREIGN = 'moe-vm-ffffffffffffffffffff';
const UNREADABLE = { list: async () => { throw lifecycleError('LEDGER_RECORD_INVALID'); } };

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-vmc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A real R06 ledger whose records are all 'owned', named moe-vm-0101…, moe-vm-0202… in ledger order. */
async function ledgerWith(t, owners) {
  const [dir, names] = [scratch(t), []];
  const ledger = createLedger(dir, { random: size => Buffer.alloc(size, names.length + 1) });
  for (const o of owners) names.push((await ledger.update(await ledger.update(await ledger.reserve(o), { phase: 'launching', launchTries: 1 }), { phase: 'owned' })).instance);
  return { dir, ledger, names };
}
function fakeProvider(states) {
  const calls = [];
  const run = async (executable, args) => {
    calls.push(args.join(' '));
    const name = args[0] === 'info' ? args[1] : args[2];
    if (args[0] === 'delete') { delete states[name]; return { stdout: '', stderr: '' }; }
    if (states[name] === undefined) throw Object.assign(new Error('gone'), { code: 2, stderr: `info failed: The following errors occurred:\ninstance "${name}" does not exist` });
    if (states[name] === 'FAIL') throw Object.assign(new Error('/secret/provider-stderr'), { code: 3, stderr: '/secret/provider-stderr' });
    return { stdout: JSON.stringify({ errors: [], info: { [name]: { state: states[name] } } }), stderr: '' };
  };
  return { calls, provider: { run } };
}
function fakeDaemon({ open = {}, unreadable = [], resources = [], down = false }) {
  const calls = [];
  const call = async (tool, args) => {
    calls.push(tool);
    if (down) throw Object.assign(new Error('down'), { code: 'DAEMON_UNREACHABLE' });
    if (tool === 'moe.list_resources') return resources instanceof Error ? Promise.reject(resources) : { success: true, resources };
    if (!Object.hasOwn(open, args.taskId)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
    const receiptStatus = unreadable.includes(args.taskId) ? 'identity-unreadable' : 'no-session';
    return { servedContext: { taskId: args.taskId, planRevision: 1, attemptId: open[args.taskId], generation: 1, receiptStatus } };
  };
  return { calls, call };
}
async function captured(argv, deps) {
  const out = { stdout: '', stderr: '' };
  const original = process.stderr.write;
  process.stderr.write = text => { out.stderr += text; return true; };
  try { return { code: await runVmControl(argv, { ...deps, write: text => { out.stdout += text; } }), ...out }; } finally { process.stderr.write = original; }
}

test('VC-L1 one ledger directory per project across Windows-drive, backslash and /mnt spellings, outside the project', t => {
  const [state, project, home] = [scratch(t), scratch(t), scratch(t)];
  const saved = ['MOE_RUNNER_STATE_DIR', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]); // restored even on a throw
  t.after(() => { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { MOE_RUNNER_STATE_DIR: `  ${state}  `, HOME: home, USERPROFILE: home });
  const expected = path.join(state, hash('d:/p/x'), 'vms');
  assert.deepEqual(['D:/p/x', 'D:\\p\\x', 'd:\\p\\x\\', '/mnt/d/p/x'].map(ownedLedgerDir), [expected, expected, expected, expected]);
  assert.notEqual(ownedLedgerDir('/home/u/x'), expected);
  const own = ownedLedgerDir(project);
  assert.equal(own, path.join(state, hash(canonicalProjectPath(project)), 'vms'));
  assert.equal(path.relative(project, own).split(path.sep)[0], '..');
  if (process.platform !== 'win32') assert.equal(statSync(expected).mode & 0o777, 0o700);
  process.env.MOE_RUNNER_STATE_DIR = path.join(project, '.moe');
  assert.throws(() => ownedLedgerDir(project), { code: 'VM_CONTROL_STATE_DIR_INVALID' });
  process.env.MOE_RUNNER_STATE_DIR = '   '; // blank, then unset: ~/.moe/runner-state
  assert.equal(ownedLedgerDir('/mnt/d/p/x'), path.join(home, '.moe', 'runner-state', hash('d:/p/x'), 'vms'));
  delete process.env.MOE_RUNNER_STATE_DIR;
  assert.equal(ownedLedgerDir('D:/p/x'), path.join(home, '.moe', 'runner-state', hash('d:/p/x'), 'vms'));
});

test('VC-S1 status lists exactly the ledger records, queries only their names and never claims execution', async t => {
  const { dir, ledger, names: [a, b, c] } = await ledgerWith(t, [owner('a'), owner('b'), owner('c')]);
  writeFileSync(path.join(dir, `${FOREIGN.slice(0, -4)}zzzz.json`), '{"instance":"tampered"}');
  const { calls, provider } = fakeProvider({ [a]: 'Running', [b]: 'FAIL', [FOREIGN]: 'Running' });
  const prerequisites = async () => ({ platform: 'linux', ready: true, executionReady: false, providerCode: 'PROVIDER_READY', prerequisites: [] });
  assert.deepEqual(await statusReport({ ledger, provider, prerequisites }), {
    schema: 'moe-vm-status-v1', provider: { ready: true, code: 'PROVIDER_READY', platform: 'linux' }, executionReady: false, verified: false,
    instances: [[a, 'Running', 'task-a'], [b, 'Unknown', 'task-b'], [c, 'Absent', 'task-c']].map(([instance, state, taskId]) => ({ instance, phase: 'owned', state, launchTries: 1, taskId })),
    invalid: 1,
  });
  assert.deepEqual(calls, [a, b, c].map(name => `info ${name} --format json`));
  assert.deepEqual((await statusReport({ ledger, provider, prerequisites: async () => { throw new Error('/x'); } })).provider, { ready: false, code: 'PREREQUISITES_UNAVAILABLE' });
  assert.deepEqual((await statusReport({ ledger, provider, prerequisites: async () => ({ ready: 'yes', code: '/x/KEY', platform: '../x' }) })).provider, { ready: false });
  assert.deepEqual(await statusReport({ ledger: UNREADABLE, provider, prerequisites }),
    { schema: 'moe-vm-status-v1', code: 'LEDGER_UNREADABLE', instances: [], executionReady: false, verified: false });
});

test('VC-R1 reconcile is R06 reconcileOwned over the ledger only, with its schema and an invalid count', async t => {
  const { dir, ledger, names: [a, b] } = await ledgerWith(t, [owner('a'), owner('b')]);
  writeFileSync(path.join(dir, 'junk.json'), 'not json');
  const { calls, provider } = fakeProvider({ [b]: 'Running', [FOREIGN]: 'Running' });
  assert.deepEqual(await reconcileReport({ ledger, provider }),
    { schema: 'moe-vm-reconcile-v1', reconciled: [{ instance: a, from: 'owned', to: 'absent' }], unknown: [], invalid: 1 });
  assert.deepEqual(calls, [`info ${a} --format json`, `info ${b} --format json`]);
  assert.deepEqual(await reconcileReport({ ledger: UNREADABLE, provider }), { schema: 'moe-vm-reconcile-v1', code: 'LEDGER_UNREADABLE' });
});

test('VC-C1 cleanup deletes only a closed owner attempt with a free job lease; every other case is preserved', async t => {
  const { ledger, names, names: [a, b, n, c, d, u, o] } = await ledgerWith(t, ['a', 'b', 'n', 'c', 'd', 'u', 'o'].map(owner));
  const { calls, provider } = fakeProvider(Object.fromEntries(names.map(name => [name, 'Running'])));
  const daemon = fakeDaemon({
    open: { 'task-a': 'attempt-a', 'task-b': 'attempt-z', 'task-n': null, 'task-c': null, 'task-u': null, 'task-o': undefined },
    unreadable: ['task-u'],
    resources: [{ id: b, holders: [], queue: [] }, { id: c, holders: [{ taskId: 'task-q', workerId: 'w', acquiredAt: 'x' }], queue: [] }],
  });
  assert.deepEqual(await cleanupReport({ ledger, provider, call: daemon.call }), {
    schema: 'moe-vm-cleanup-v1', deleted: [b, n], errors: [], invalid: 0,
    preserved: [{ instance: a, reason: 'attempt-active' }, { instance: c, reason: 'job-lease-held' },
      ...[d, u, o].map(instance => ({ instance, reason: 'attempt-unknown' }))],
  });
  assert.deepEqual(calls.splice(0), [b, n].flatMap(name => [`info ${name} --format json`, `delete --purge ${name}`, `info ${name} --format json`]));
  const [gc, lr] = ['moe.get_context', 'moe.list_resources']; // one fresh lease read per closed record, right after its attempt read
  assert.deepEqual(daemon.calls, [gc, gc, lr, gc, lr, gc, lr, gc, gc, gc]);
  // An unreachable daemon, then an unreadable resource list, preserves every remaining record and deletes nothing.
  const left = [a, c, d, u, o];
  assert.deepEqual(await cleanupReport({ ledger, provider, call: fakeDaemon({ down: true }).call }), {
    schema: 'moe-vm-cleanup-v1', deleted: [], errors: [], invalid: 0, preserved: left.map(instance => ({ instance, reason: 'attempt-unknown' })),
  });
  for (const resources of [[{ id: a }], new Error('list_resources down')]) {
    const broken = fakeDaemon({ open: { 'task-a': null, 'task-c': null, 'task-d': null, 'task-u': null, 'task-o': null }, resources });
    assert.deepEqual((await cleanupReport({ ledger, provider, call: broken.call })).preserved, left.map(instance => ({ instance, reason: 'job-lease-held' })));
  }
  assert.deepEqual(calls, []);
});

const PROJECT = path.resolve(tmpdir(), 'moe-vmc-project');
async function refusedUntouched(argvs) {
  for (const argv of argvs) {
    const touched = [];
    const spy = label => (() => { touched.push(label); throw new Error(label); });
    const deps = { ledger: { list: spy('ledger'), read: spy('read') }, provider: { run: spy('provider') }, call: spy('daemon'), prerequisites: spy('prereq') };
    assert.deepEqual({ ...(await captured(argv, deps)), touched }, { code: 2, stdout: INVALID, stderr: '', touched: [] });
  }
}

test('VC-C2 no flag or argument supplies daemon truth or names an instance', () => refusedUntouched([
  ['cleanup', '--project', PROJECT, '--attempt-closed'], ['cleanup', '--lease-free', '--project', PROJECT],
  ['cleanup', '--project', PROJECT, FOREIGN], [FOREIGN, '--project', PROJECT], ['reconcile', '--instance', FOREIGN, '--project', PROJECT]]));

test('VC-U1 usage errors exit 2 with only VM_CONTROL_INPUT_INVALID, before anything is read', async () => {
  await refusedUntouched([[], ['list', '--project', PROJECT], ['status'], ['status', '--project'], ['status', '--project', 'rel/x'],
    ['status', '--project', `${PROJECT}\n`], ['status', '--project', PROJECT, '--project', PROJECT], ['status', 'extra', '--project', PROJECT],
    ['status', `--project=${PROJECT}`]]);
  const run = spawnSync(process.execPath, [CLI, 'status', '--project', 'relative'], { encoding: 'utf8' });
  assert.deepEqual([run.status, run.stdout, run.stderr], [2, INVALID, '']);
});

test('VC-O1 every report is one bounded line of fixed codes; internal throws never leak text', async t => {
  const [project, state] = [scratch(t), scratch(t)];
  const secret = '/secret/sentinel-key';
  const leak = { ledger: { list: async () => { throw new Error(secret); } }, provider: {}, prerequisites: async () => ({ ready: false }) };
  for (const command of ['status', 'reconcile', 'cleanup']) {
    assert.deepEqual(await captured([command, '--project', project], { ...leak, call: async () => { throw new Error(secret); } }),
      { code: 0, stdout: '{"code":"VM_CONTROL_FAILED"}\n', stderr: '' });
  }
  const many = Array.from({ length: 700 }, (_, i) => ({ instance: `moe-vm-${i.toString(16).padStart(20, '0')}`, phase: 'owned', launchTries: 1, taskId: 'task-a' }));
  const huge = { ledger: { list: async () => ({ records: many, invalid: [] }) }, provider: fakeProvider({}).provider, prerequisites: async () => ({ ready: false }) };
  assert.deepEqual(await captured(['status', '--project', project], huge), { code: 0, stdout: '{"code":"VM_CONTROL_REPORT_TOO_LARGE"}\n', stderr: '' });
  const run = spawnSync(process.execPath, [CLI, 'reconcile', '--project', project], { encoding: 'utf8', env: { ...process.env, MOE_RUNNER_STATE_DIR: state } });
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '{"schema":"moe-vm-reconcile-v1","reconciled":[],"unknown":[],"invalid":0}\n', '']);
});

function fakeSocket(reply) {
  const made = [];
  class FakeSocket extends EventTarget {
    constructor(url) { super(); Object.assign(this, { url, sent: [], closed: 0 }); made.push(this); if (reply) queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) { this.sent.push(JSON.parse(text)); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: this.sent.at(-1).id, ...reply() }) }))); }
    close() { this.closed += 1; }
  }
  return { made, FakeSocket };
}
const rejectsWith = async (promise, code) => assert.equal(await promise.then(() => 'resolved', error => error?.code), code);

test('VC-M1 the daemon caller trusts only a bounded loopback daemon.json for this project and fails closed', async t => {
  const project = scratch(t);
  mkdirSync(path.join(project, '.moe'));
  const info = value => writeFileSync(path.join(project, '.moe', 'daemon.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const good = { port: 9876, pid: 1, startedAt: 'x', projectPath: `${project}${path.sep}` };
  await rejectsWith(readDaemonInfo(project), 'DAEMON_UNREACHABLE');
  for (const bad of [{ ...good, port: 0 }, { ...good, port: 65536 }, { ...good, port: '9876' }, { ...good, bindHost: '0.0.0.0' },
    { ...good, projectPath: path.join(project, 'other') }, `${JSON.stringify(good)}${' '.repeat(16_384)}`, 'not json']) {
    info(bad);
    const { made, FakeSocket } = fakeSocket(() => ({ result: {} }));
    await rejectsWith(readDaemonInfo(project), 'DAEMON_UNREACHABLE');
    await rejectsWith(mcpCaller(project, { WebSocketImpl: FakeSocket })('moe.list_resources', {}), 'DAEMON_UNREACHABLE');
    assert.equal(made.length, 0); // refused before any connection attempt
  }
  info({ ...good, bindHost: '::1' });
  assert.deepEqual(await readDaemonInfo(project), { port: 9876 });
  info(good);
  const ok = fakeSocket(() => ({ result: { content: [{ type: 'text', text: '{"success":true,"resources":[]}' }] } }));
  assert.deepEqual(await mcpCaller(project, { WebSocketImpl: ok.FakeSocket })('moe.list_resources', {}), { success: true, resources: [] });
  const { url, sent, closed } = ok.made[0];
  assert.deepEqual({ url, sent, closed }, { url: 'ws://127.0.0.1:9876/mcp', closed: 1,
    sent: [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'moe.list_resources', arguments: {} } }] });
  const refused = fakeSocket(() => ({ error: { code: -32602, message: '/secret', data: { tool: 'moe.get_context', codeName: 'NOT_FOUND' } } }));
  await rejectsWith(mcpCaller(project, { WebSocketImpl: refused.FakeSocket })('moe.get_context', { taskId: 'task-a' }), 'NOT_FOUND');
  const silent = fakeSocket(null);
  await rejectsWith(mcpCaller(project, { WebSocketImpl: silent.FakeSocket, timeoutMs: 20 })('moe.list_resources', {}), 'DAEMON_UNREACHABLE');
  assert.equal(silent.made[0].closed, 1);
  await rejectsWith(mcpCaller(project, { WebSocketImpl: null })('moe.list_resources', {}), 'DAEMON_UNREACHABLE');
});

/** Run `body` with MOE_RUNNER_STATE_DIR pointed at a scratch dir; env is restored even on a throw. */
function withStateDir(t, body) {
  const [state, home] = [scratch(t), scratch(t)];
  const saved = ['MOE_RUNNER_STATE_DIR', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { MOE_RUNNER_STATE_DIR: state, HOME: home, USERPROFILE: home });
  return body(state);
}
const onWin32 = (t, then) => { // a win32 stand-in: platform flipped and path.resolve answering as Windows with cwd C:\work
  if (process.platform === 'win32') return then();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.mock.method(path, 'resolve', (...parts) => path.win32.resolve('C:\\work', ...parts));
  return then();
};

test('VC-L2 canonical spellings keep their pre-fix keys and ledger dirs', t => withStateDir(t, state => {
  // Literals taken from the pre-fix code; never recomputed, so a drift in the key shows here.
  for (const spelling of ['D:/x', 'D:\\x', '/mnt/d/x']) {
    assert.equal(canonicalProjectPath(spelling), 'd:/x');
    assert.equal(ownedLedgerDir(spelling), path.join(state, 'e11c306f14173b564d02903d983005d9', 'vms'));
  }
  if (process.platform !== 'win32') { // its pre-fix value depends on the cwd drive on win32
    assert.equal(canonicalProjectPath('/home/u/x'), '/home/u/x');
    assert.equal(canonicalProjectPath('/home/U/X'), '/home/U/X'); // a POSIX path keeps its case
    assert.equal(ownedLedgerDir('/home/u/x'), path.join(state, '323c3dfd5c9093fc987bfa6f5abd6e59', 'vms'));
  }
}));

test('VC-L3 relative and non-normalized /mnt spellings map to the normalized key', { skip: process.platform === 'win32' && 'a Windows process never has a /mnt cwd' }, t => withStateDir(t, () => {
  t.mock.method(process, 'cwd', () => '/mnt/d/x');
  const rows = ['.', '/mnt/d/x/.', '/mnt/d/x/sub/..', '/mnt/d//x', 'sub/..', '/mnt/d/x/./', '/mnt/d/x/', '/mnt/d/x', 'D:\\x'];
  assert.deepEqual(rows.map(input => [input, canonicalProjectPath(input)]), rows.map(input => [input, 'd:/x']));
  assert.equal(canonicalProjectPath('sub'), 'd:/x/sub');
  assert.equal(canonicalProjectPath('..'), 'd:');
  assert.equal(canonicalProjectPath('/mnt/D/x'), 'd:/x');
  assert.equal(canonicalProjectPath('/mnt/d/../../etc'), '/etc'); // resolves out of the mount: not a drive key
  assert.equal(ownedLedgerDir('.'), ownedLedgerDir('D:/x'));
  assert.equal(ownedLedgerDir('/mnt/d//x'), ownedLedgerDir('D:/x'));
}));

test('VC-L4 on win32 a raw /mnt path is posix-normalized before mapping', t => onWin32(t, () => {
  const rows = ['/mnt/d/x/sub/..', '/mnt/d/x/./', '/mnt/d//x', 'D:\\x'];
  assert.deepEqual(rows.map(input => [input, canonicalProjectPath(input)]), rows.map(input => [input, 'd:/x']));
  assert.equal(canonicalProjectPath('/mnt/d/x/sub/../..'), 'd:');
}));

test('VC-M2 readDaemonInfo accepts this project\'s daemon.json in another spelling and still refuses another project', { skip: process.platform === 'win32' && 'a Windows process never has a /mnt cwd' }, async t => {
  const project = scratch(t);
  mkdirSync(path.join(project, '.moe'));
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(project); // the relative '.' reads this file through the OS cwd...
  t.mock.method(process, 'cwd', () => '/mnt/d/x'); // ...while canonicalization sees the WSL spelling
  const info = projectPath => writeFileSync(path.join(project, '.moe', 'daemon.json'), JSON.stringify({ port: 9876, pid: 1, startedAt: 'x', projectPath }));
  for (const projectPath of ['/mnt/d/x', 'D:\\x', '/mnt/d//x/', '/mnt/d/x/sub/..']) {
    info(projectPath);
    assert.deepEqual(await readDaemonInfo('.'), { port: 9876 }, projectPath);
  }
  for (const projectPath of ['/mnt/d/y', '/mnt/c/x']) {
    info(projectPath);
    await rejectsWith(readDaemonInfo('.'), 'DAEMON_UNREACHABLE');
  }
});

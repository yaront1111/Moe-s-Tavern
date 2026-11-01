// CQ-M07i seat VM start and stop (agent-seat.mjs): a real CQ-M07g ledger under a scratch MOE_RUNNER_STATE_DIR, the real
// CQ-M07h admission and deleteOwned, and a fake provider run. No row runs multipass or signals a process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runAgentSeat, seatForward, startSeat, stopSeat } from '../local-runner/agent-seat.mjs';
import { platformFor } from '../local-runner/cli.mjs';
import { createLedger, deleteOwned } from '../local-runner/lifecycle.mjs';
import { admitSeatVm } from '../local-runner/seat-capacity.mjs';
import { ownedLedgerDir } from '../local-runner/vm-control.mjs';

const SEAT = Object.freeze({ workerId: 'worker-a1', runner: '4242@tok a', host: 'host-a' });
const OTHER = Object.freeze({ workerId: 'worker-b2', runner: '4343@tok b', host: 'host-a' });
const [DEAD, ALIVE, UNSURE] = ['7@dead', '8@alive', '9@unsure'].map(runner => ({ ...SEAT, runner }));
const TOOLCHAIN = Object.freeze({ file: '/cache/node.tar.xz', sha256: 'a'.repeat(64), size: 1, version: '24.0.0' });
const opaque = () => new Error('/secret/provider-stderr'); // no code: the stage's fixed code replaces it

/** A scratch runner-state root (its restore registered BEFORE the mutation), a project, its real ledger and fake VMs. */
function world(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-seat-'));
  const saved = process.env.MOE_RUNNER_STATE_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.MOE_RUNNER_STATE_DIR; else process.env.MOE_RUNNER_STATE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.MOE_RUNNER_STATE_DIR = path.join(dir, 'state');
  const w = { project: path.join(dir, 'project'), vms: new Map(), calls: [], order: [], removed: [] };
  const run = async (_executable, args) => {
    w.calls.push(args.join(' '));
    const name = args[0] === 'info' ? args[1] : args[2];
    if (args[0] === 'delete') {
      if (w.vms.get(name) === 'stuck') throw Object.assign(opaque(), { code: 3, stderr: '/secret/provider-stderr' });
      w.vms.delete(name);
      return { stdout: '', stderr: '' };
    }
    if (!w.vms.has(name)) throw Object.assign(new Error('gone'), { code: 2, stderr: `info failed:\ninstance "${name}" does not exist` });
    return { stdout: JSON.stringify({ errors: [], info: { [name]: { state: 'Running' } } }), stderr: '' };
  };
  w.provider = { run, keyDir: path.join(dir, 'keys') };
  w.ledger = createLedger(ownedLedgerDir(w.project));
  /** Moves a reserved record to owned with a fake VM ('stuck': one whose delete fails). */
  w.launch = async (record, vm = 'Running') => {
    w.vms.set(record.instance, vm);
    return w.ledger.update(await w.ledger.update(record, { phase: 'launching', launchTries: 1 }), { phase: 'owned' });
  };
  w.recordOf = async (owner, phase = 'owned') => (phase === 'reserved' ? w.ledger.reserve(owner)
    : w.launch(await w.ledger.reserve(owner), phase === 'stuck' ? 'stuck' : 'Running'));
  return w;
}

/** startSeat's steps over `w`: the fake provision reserves through the admitted ledger, launches and reports `report`. */
function stepsFor(w, { fail, code, count = 0, cap = 2, report = {}, vm = 'Running' } = {}) {
  const step = (label, value) => async args => {
    w.order.push([label, args.name, args.arch].filter(Boolean).join(' '));
    w.providers = [...(w.providers ?? []), args.provider].filter(Boolean);
    if (fail === label) throw code ? Object.assign(opaque(), { code }) : opaque();
    return value;
  };
  return {
    provider: w.provider, cap: () => cap, probe: record => ({ [DEAD.runner]: false, [ALIVE.runner]: true, [OTHER.runner]: false })[record.runner],
    supervisor: async () => { if (fail === 'supervisor') throw opaque(); return Buffer.from('supervisor'); },
    count: async () => { w.order.push('count'); if (fail === 'count') throw opaque(); return { count, invalid: 0 }; },
    admit: args => { w.order.push('admit'); return admitSeatVm(args); },
    remove: args => { w.order.push(`remove ${args.name}`); w.removed.push([args.name, args.owner]); return deleteOwned(args); },
    provision: async ({ ledger, owner, provider, cacheDir, credential }) => {
      w.order.push('provision');
      w.seen = { provider, cacheDir, credential: credential.length };
      if (fail === 'unavailable') return { provisioned: false, bootstrapReady: false, executionReady: false };
      const record = await ledger.reserve(owner);
      w.reserved = record.instance;
      if (fail === 'reserve') throw opaque();
      await w.launch(record, vm);
      if (fail === 'provision') throw opaque();
      return { provisioned: true, instance: record.instance, bootstrapReady: true, failures: [], image: { source: { arch: 'x64' } }, ...report };
    },
    toolchain: step('toolchain', TOOLCHAIN), installToolchain: step('installToolchain'), installAgents: step('installAgents'),
  };
}
const start = (w, options) => startSeat({ project: w.project, owner: SEAT }, stepsFor(w, options));

test('AS0 the CI local-runner step runs this file once', () => {
  const [, run] = /\n *- name: Test local runner prerequisite bundles\n *(run: [^\n]*)/.exec(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(run.split(' ').filter(file => file === 'scripts/tests/local-runner-seat.test.mjs').length, 1);
});

test('AS1 startSeat provisions exactly one seat-owned VM in order with the pinned client; each refusal is one fixed code', async t => {
  const w = world(t);
  for (const [input, options, code] of [
    [{ project: w.project, owner: { ...SEAT, runner: 'no-pid' } }, {}, 'SEAT_INPUT_INVALID'], [{ project: w.project, owner: { ...SEAT, x: 1 } }, {}, 'SEAT_INPUT_INVALID'],
    [{ project: 'relative/p', owner: SEAT }, {}, 'SEAT_INPUT_INVALID'], [{ project: `${w.project}\n`, owner: SEAT }, {}, 'SEAT_INPUT_INVALID'],
    [{ project: w.project, owner: SEAT, extra: 1 }, {}, 'SEAT_INPUT_INVALID'], [{ project: w.project, owner: SEAT }, { platform: null }, 'SEAT_UNSUPPORTED_HOST'],
    [{ project: w.project, owner: SEAT }, { fail: 'count' }, 'SEAT_CAPACITY_UNKNOWN'],
    [{ project: w.project, owner: SEAT }, { fail: 'supervisor' }, 'SEAT_SUPERVISOR_UNAVAILABLE'],
    [{ project: w.project, owner: SEAT }, { fail: 'unavailable' }, 'SEAT_PROVISION_UNAVAILABLE'],
  ]) {
    const { platform, ...rest } = options;
    const result = await startSeat(input, { ...stepsFor(w, rest), ...('platform' in options ? { platform } : {}) });
    assert.deepEqual(result, { ok: false, code, vm: 'none' }, JSON.stringify(input));
    if (code === 'SEAT_INPUT_INVALID') assert.deepEqual(w.order, []);
  }
  assert.deepEqual([w.order.includes('admit'), w.calls, (await w.ledger.list()).records], [false, [], []]);
  w.order.length = 0;
  const result = await start(w);
  const records = (await w.ledger.list()).records;
  const name = records[0]?.instance;
  assert.deepEqual([result, Object.isFrozen(result)], [{ ok: true, instance: name, executionReady: false }, true]);
  assert.deepEqual(records.map(r => [r.workerId, r.runner, r.host, r.phase]), [[SEAT.workerId, SEAT.runner, SEAT.host, 'owned']]);
  assert.deepEqual(w.order, ['count', 'provision', 'admit', 'toolchain x64', `installToolchain ${name}`, `installAgents ${name} x64`]);
  const pinned = { ...w.provider, executable: platformFor(process.platform).executable };
  assert.deepEqual(w.seen, { provider: pinned, cacheDir: path.join(path.dirname(ownedLedgerDir(w.project)), 'images'), credential: 32 });
  assert.ok(w.providers.length === 2 && w.providers.every(provider => provider === w.seen.provider));
});

test('AS2 a full cap refuses SEAT_CAPACITY_FULL before any reserve or provider call; a race lost under the lock reserves nothing', async t => {
  const w = world(t);
  assert.deepEqual(await start(w, { count: 2, cap: 2 }), { ok: false, code: 'SEAT_CAPACITY_FULL', vm: 'none' });
  assert.deepEqual([w.order, w.calls, (await w.ledger.list()).records], [['count'], [], []]);
  // Another project's seat takes the last slot after the unlocked pre-check: the locked admission refuses.
  await createLedger(path.join(process.env.MOE_RUNNER_STATE_DIR, 'c'.repeat(32), 'vms')).reserve(OTHER);
  w.order.length = 0;
  assert.deepEqual(await start(w, { count: 0, cap: 1 }), { ok: false, code: 'SEAT_CAPACITY_FULL', vm: 'none' });
  assert.deepEqual([w.order, w.calls, (await w.ledger.list()).records], [['count', 'provision', 'admit'], [], []]);
});

test('AS3 a failure at any stage after the reserve deletes exactly that VM by name; a failed delete keeps the record', async t => {
  const w = world(t);
  for (const [options, code] of [
    [{ fail: 'provision' }, 'SEAT_PROVISION_FAILED'], [{ report: { instance: 'moe-vm-ffffffffffffffffffff' } }, 'SEAT_PROVISION_FAILED'],
    [{ report: { bootstrapReady: false } }, 'SEAT_GUEST_NOT_READY'], [{ report: { failures: ['BOOTSTRAP_X'] } }, 'SEAT_GUEST_NOT_READY'],
    [{ report: { image: { source: { arch: 'sparc' } } } }, 'SEAT_TOOLCHAIN_FAILED'], [{ fail: 'toolchain' }, 'SEAT_TOOLCHAIN_FAILED'],
    [{ fail: 'installToolchain' }, 'SEAT_TOOLCHAIN_FAILED'], [{ fail: 'installToolchain', code: 'TRANSFER_EXIT_FAILED' }, 'TRANSFER_EXIT_FAILED'],
    [{ fail: 'installAgents' }, 'SEAT_AGENTS_FAILED'],
  ]) {
    w.removed.length = 0;
    assert.deepEqual(await start(w, options), { ok: false, code, vm: 'deleted' }, JSON.stringify(options));
    assert.deepEqual([w.removed, (await w.ledger.read(w.reserved)).phase, w.vms.has(w.reserved)], [[[w.reserved, SEAT]], 'deleted', false]);
  }
  w.removed.length = 0;
  assert.deepEqual(await start(w, { fail: 'reserve' }), { ok: false, code: 'SEAT_PROVISION_FAILED', vm: 'retired' });
  await assert.rejects(w.ledger.read(w.reserved), { code: 'LEDGER_RECORD_INVALID' }); // retired: the record file is gone
  assert.deepEqual(await start(w, { fail: 'installAgents', vm: 'stuck' }), { ok: false, code: 'SEAT_AGENTS_FAILED', vm: 'delete-failed' });
  assert.deepEqual([w.removed.length, (await w.ledger.read(w.reserved)).phase, w.vms.has(w.reserved)], [2, 'owned', true]);
});

test('AS4 stopSeat deletes only its own named VM, idempotently, and never touches another owner\'s record', async t => {
  const w = world(t);
  const [a, b, c, d] = [await w.recordOf(SEAT), await w.recordOf(OTHER), await w.recordOf(SEAT, 'reserved'), await w.recordOf(SEAT, 'stuck')];
  const stop = (instance, steps) => stopSeat({ project: w.project, owner: SEAT, instance }, { provider: w.provider, ...steps });
  assert.deepEqual(await stop(a.instance), { ok: true, instance: a.instance, vm: 'deleted' });
  assert.ok(w.calls.length > 0 && w.calls.every(call => call.includes(a.instance)) && w.vms.has(b.instance) && !w.vms.has(a.instance));
  const [calls, file] = [w.calls.length, path.join(ownedLedgerDir(w.project), `${b.instance}.json`)];
  assert.deepEqual(await stop(a.instance), { ok: true, instance: a.instance, vm: 'deleted' });
  assert.equal(w.calls.length, calls); // already deleted: no provider call at all
  const bytes = readFileSync(file);
  assert.deepEqual(await stop(b.instance), { ok: false, code: 'LIFECYCLE_NOT_OWNER', vm: 'none' });
  assert.deepEqual([readFileSync(file), w.calls.length], [bytes, calls]);
  assert.deepEqual([await stop(c.instance), await stop(c.instance)], [{ ok: true, instance: c.instance, vm: 'retired' }, { ok: true, instance: c.instance, vm: 'gone' }]);
  assert.deepEqual(await stop(d.instance), { ok: false, code: 'SEAT_STOP_FAILED', vm: 'delete-failed' });
  assert.deepEqual([(await w.ledger.read(d.instance)).phase, await stop('moe-vm-bad')], ['owned', { ok: false, code: 'SEAT_INPUT_INVALID', vm: 'none' }]);
  const e = await w.ledger.update(await w.ledger.reserve(SEAT), { phase: 'collision' }); // foreign: never retired or deleted
  assert.deepEqual([await stop(e.instance), (await w.ledger.read(e.instance)).phase, await stop(a.instance, { remove: async () => 'kept' })],
    [{ ok: true, instance: e.instance, vm: 'none' }, 'collision', { ok: false, code: 'SEAT_STOP_FAILED', vm: 'delete-failed' }]);
});

test('AS5 startSeat first reclaims its own leftovers and a dead previous incarnation, never another record', async t => {
  const w = world(t);
  const [own, left, dead] = [await w.recordOf(SEAT), await w.recordOf(SEAT, 'reserved'), await w.recordOf(DEAD)];
  const kept = [await w.recordOf(ALIVE), await w.recordOf(UNSURE), await w.recordOf(OTHER), await w.recordOf({ ...SEAT, host: 'host-b' })]; // live, unprovable, another worker's dead, another host
  const result = await start(w, { cap: 9 }); // the locked admission counts the three kept seat VMs
  assert.equal(result.ok, true, JSON.stringify(result));
  const swept = w.order.slice(0, w.order.indexOf('count'));
  assert.deepEqual(swept.sort(), [own, left, dead].map(record => `remove ${record.instance}`).sort());
  assert.deepEqual(new Map(w.removed).get(dead.instance), DEAD);
  const phases = new Map((await w.ledger.list()).records.map(record => [record.instance, record.phase]));
  assert.deepEqual([own, left, dead, ...kept].map(record => phases.get(record.instance)), ['deleted', undefined, 'deleted', ...kept.map(() => 'owned')]);
  assert.deepEqual([...w.vms.keys()].sort(), [...kept.map(record => record.instance), result.instance].sort());
  await w.recordOf(SEAT, 'stuck');
  w.order.length = 0;
  assert.deepEqual(await start(w), { ok: false, code: 'SEAT_PREVIOUS_VM_UNREMOVED', vm: 'none' });
  assert.ok(w.order.every(entry => entry.startsWith('remove ')), w.order.join());
});

test('AS6 the CLI: usage exits 2 before any step; one JSON line; exit 0 ok, 75 capacity, 1 any other failure', async t => {
  const w = world(t);
  const lines = [];
  const cli = (argv, options, extra = {}) => runAgentSeat(argv, { ...stepsFor(w, options), ...extra, write: text => lines.push(text) });
  const head = ['--project', w.project, '--worker', SEAT.workerId, '--runner', SEAT.runner, '--host', SEAT.host];
  const VM = 'moe-vm-0123456789abcdef0123';
  for (const argv of [[], ['seat-start'], ['seat-begin', ...head], ['seat-start', ...head, '--instance', VM], ['seat-start', ...head.slice(0, -1)],
    ['seat-start', ...head.slice(2), ...head.slice(0, 2)], ['seat-start', '--Project', ...head.slice(1)], ['seat-start', '--project', 'relative', ...head.slice(2)],
    ['seat-start', ...head.slice(0, 3), 'worker\u0007', ...head.slice(4)], ['seat-stop', ...head, '--instance', 'moe-vm-XYZ'], ['seat-stop', ...head]]) {
    assert.equal(await cli(argv), 2, JSON.stringify(argv));
  }
  assert.deepEqual([lines.splice(0), w.order], [Array(11).fill('{"code":"SEAT_INPUT_INVALID"}\n'), []]);
  assert.equal(await cli(['seat-start', ...head]), 0);
  const { instance } = JSON.parse(lines[0]);
  const trap = { get code() { throw opaque(); } }; // a defect inside startSeat itself, after the reserve: the cleanup still runs
  assert.deepEqual([await cli(['seat-stop', ...head, '--instance', instance]), await cli(['seat-start', ...head], { count: 2 }),
    await cli(['seat-start', ...head], { fail: 'supervisor' }), await cli(['seat-stop', ...head, '--instance', VM]),
    await cli(['seat-start', ...head], {}, { provision: async ({ ledger, owner }) => { await ledger.reserve(owner); throw trap; } })], [0, 75, 1, 0, 1]);
  assert.deepEqual([lines, (await w.ledger.list()).records.map(record => record.phase)], [[`{"ok":true,"instance":"${instance}","executionReady":false}\n`,
    `{"ok":true,"instance":"${instance}","vm":"deleted"}\n`, '{"ok":false,"code":"SEAT_CAPACITY_FULL","vm":"none"}\n',
    '{"ok":false,"code":"SEAT_SUPERVISOR_UNAVAILABLE","vm":"none"}\n', `{"ok":true,"instance":"${VM}","vm":"gone"}\n`, '{"ok":false,"code":"SEAT_FAILED"}\n'], ['deleted']]);
  const spawned = spawnSync(process.execPath, [fileURLToPath(new URL('../local-runner/agent-seat.mjs', import.meta.url)), 'seat-start'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true }); // the direct entry, as the wrappers run it
  assert.deepEqual([spawned.status, spawned.stdout, spawned.stderr], [2, '{"code":"SEAT_INPUT_INVALID"}\n', '']);
});

// CQ-M07j1 seatForward: a fake WebSocket over a scratch project whose /health is a real loopback http server (VC-M1 style).
const ARGS = Object.freeze({ resourceId: 'r', taskId: 'task-a', workerId: 'w' });
const RESULT = Object.freeze({ content: [{ type: 'text', text: '{"granted":true}' }], structuredContent: { k: 1 } });
const say = (socket, body) => socket.dispatchEvent(new MessageEvent('message', { data: typeof body === 'string' ? body : JSON.stringify(body) }));
const echo = reply => (socket, frame) => say(socket, { jsonrpc: '2.0', id: frame.id, ...reply(frame) });
const rejectsFixed = async promise => {
  const error = await promise.then(() => assert.fail('resolved'), caught => caught);
  assert.deepEqual([error.code, error.message], ['SEAT_FORWARD_FAILED', 'Seat forward failed.']); // never the daemon's text
};

/** A fake daemon /health on `listen`:0 reporting `report` as its bind for `project`; port stays 0 where `listen` cannot bind. */
const sfHealth = (t, project, { listen = '127.0.0.1', report = listen, onRequest } = {}) => new Promise(resolve => {
  const health = { port: 0, hits: 0 };
  const server = createServer((_req, res) => { health.hits += 1; onRequest?.(); res.end(JSON.stringify({ status: 'healthy', projectPath: project, bindHost: report })); });
  server.once('error', () => resolve(health)).listen(0, listen, () => {
    t.after(() => { server.closeAllConnections(); server.close(); });
    health.port = server.address().port;
    resolve(health);
  });
});

/** A scratch project whose daemon.json (`w.info(...)`) names a live loopback /health; `base` is the good daemon.json. */
async function sfDaemon(t, options) {
  const project = mkdtempSync(path.join(tmpdir(), 'moe-sf-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.moe'));
  const health = await sfHealth(t, project, options);
  const info = value => writeFileSync(path.join(project, '.moe', 'daemon.json'), JSON.stringify(value));
  const base = { port: health.port, pid: 1, startedAt: 'x', projectPath: project };
  info(base);
  return { project, health, base, info };
}

/** An EventTarget WebSocket that records its constructor arguments, parsed frames and close() calls; `open` is the event it
 * dispatches after construction (null: none) and onSend(socket, frame) scripts the reply. */
function sfSocket({ open = 'open', onSend = () => {} } = {}) {
  const made = [];
  class FakeSocket extends EventTarget {
    constructor(...args) { super(); Object.assign(this, { args, sent: [], closed: 0 }); made.push(this); if (open) queueMicrotask(() => this.dispatchEvent(new Event(open))); }
    send(text) { this.sent.push(JSON.parse(text)); onSend(this, this.sent.at(-1)); }
    close() { this.closed += 1; }
  }
  return { made, FakeSocket };
}
const echoArgs = echo(frame => ({ result: { content: [{ type: 'text', text: JSON.stringify(frame.params.arguments) }], structuredContent: { k: 1 } } }));
const frameOf = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('SF1 forward sends one tools/call over loopback /mcp and resolves the daemon\'s raw result object', async t => {
  const w = await sfDaemon(t);
  const { made, FakeSocket } = sfSocket({ onSend: echoArgs });
  const forward = seatForward(w.project, { WebSocketImpl: FakeSocket });
  const { signal } = new AbortController();
  // The raw { content, structuredContent }, not the parsed text (which would be ARGS).
  assert.deepStrictEqual(await forward('moe.acquire_resource', ARGS, { signal }), { content: [{ type: 'text', text: JSON.stringify(ARGS) }], structuredContent: { k: 1 } });
  assert.deepEqual([made.length, made[0].args, made[0].sent, made[0].closed, getEventListeners(signal, 'abort').length],
    [1, [`ws://127.0.0.1:${w.health.port}/mcp`], [frameOf(1, 'moe.acquire_resource', ARGS)], 1, 0]);
  const [a, b] = await Promise.all([forward('moe.x', { n: 1 }), forward('moe.x', { n: 2 })]); // each matches only its own id
  assert.deepEqual([a, b].map(result => result.content[0].text), ['{"n":1}', '{"n":2}']);
  assert.deepEqual([made.length, made.slice(1).map(socket => socket.sent.length), made.slice(1).map(socket => socket.sent[0].id).sort(), made.map(socket => socket.closed)], [3, [1, 1], [2, 3], [1, 1, 1]]);
  const v6 = await sfHealth(t, w.project, { listen: '::1' });
  if (!v6.port) return t.diagnostic('the ::1 row is skipped: ::1 cannot bind on this host');
  w.info({ ...w.base, port: v6.port, bindHost: '::1' });
  await forward('moe.x', {});
  assert.deepEqual(made.at(-1).args, [`ws://[::1]:${v6.port}/mcp`]);
});

test('SF2 every failure rejects with one fixed code and releases the socket, timer and abort listener', { timeout: 10_000 }, async t => {
  const w = await sfDaemon(t);
  const error = { error: { code: -32602, message: '/secret', data: { codeName: 'NOT_FOUND' } } };
  for (const [make, timeoutMs = 60_000] of [ // a long timer, so only the event under test can reject
    [() => ({ onSend: echo(() => error) })], [() => ({ onSend: socket => socket.dispatchEvent(new Event('close')) })], [() => ({ open: 'error' })],
    [() => ({ onSend: socket => say(socket, 'not json') })], [() => ({ onSend: echo(() => ({ result: null })) })], [() => ({ onSend: echo(() => ({ result: [] })) })],
    [() => ({ onSend: echo(() => ({ ...error, result: RESULT })) })], [() => ({ onSend: () => { throw new Error('/secret'); } })], // an error beside a result; a send that throws
    [() => ({ onSend: (socket, frame) => say(socket, { jsonrpc: '2.0', id: frame.id + 100, result: RESULT }) }), 20], // another call's reply is ignored, then silence
    [() => ({ onSend: () => {} }), 20], [ac => ({ onSend: () => ac.abort() })], // the timeout; an abort mid-call
  ]) {
    const ac = new AbortController();
    const { made, FakeSocket } = sfSocket(make(ac));
    await rejectsFixed(seatForward(w.project, { WebSocketImpl: FakeSocket, timeoutMs })('moe.x', ARGS, { signal: ac.signal }));
    assert.deepEqual([made.length, made[0].closed, getEventListeners(ac.signal, 'abort').length], [1, 1, 0], String(make));
  }
  let hits = w.health.hits;
  const ac = new AbortController();
  const probing = await sfDaemon(t, { onRequest: () => ac.abort() }); // aborted during the /health probe: one hit, no socket
  const swallow = sfSocket({ onSend: echoArgs });
  await rejectsFixed(seatForward(probing.project, { WebSocketImpl: swallow.FakeSocket })('moe.x', ARGS, { signal: ac.signal }));
  assert.deepEqual([probing.health.hits, swallow.made.length, getEventListeners(ac.signal, 'abort').length], [1, 0, 0]);
  const live = new AbortController();
  const explode = class { constructor() { throw new Error('/secret'); } };
  for (const [WebSocketImpl, args, options] of [[swallow.FakeSocket, ARGS, { signal: AbortSignal.abort() }], [swallow.FakeSocket, { n: 1n }, { signal: live.signal }],
    [swallow.FakeSocket, ARGS, { signal: {} }], [swallow.FakeSocket, ARGS, { get signal() { throw new Error('/secret'); } }],
    [null, ARGS, { signal: live.signal }], [explode, ARGS, { signal: live.signal }]]) {
    hits = w.health.hits;
    await rejectsFixed(seatForward(w.project, { WebSocketImpl })('moe.x', args, options));
    assert.deepEqual([w.health.hits - hits, swallow.made.length, getEventListeners(live.signal, 'abort').length], [WebSocketImpl === explode ? 1 : 0, 0, 0]);
  }
});

test('SF3 no runner key is read or sent: the constructor gets the URL alone, whatever MOE_RUNNER_KEY_DIR says', async t => {
  const w = await sfDaemon(t);
  const run = async () => {
    const { made, FakeSocket } = sfSocket({ onSend: echoArgs });
    const result = await seatForward(w.project, { WebSocketImpl: FakeSocket })('moe.x', ARGS);
    return [result, made.map(socket => [socket.args, socket.sent])];
  };
  const before = await run();
  const saved = process.env.MOE_RUNNER_KEY_DIR;
  t.after(() => { if (saved === undefined) delete process.env.MOE_RUNNER_KEY_DIR; else process.env.MOE_RUNNER_KEY_DIR = saved; });
  process.env.MOE_RUNNER_KEY_DIR = path.join(w.project, 'missing');
  assert.deepStrictEqual(await run(), before);
  assert.deepEqual([before[1][0][0], existsSync(process.env.MOE_RUNNER_KEY_DIR)], [[`ws://127.0.0.1:${w.health.port}/mcp`], false]);
});

test('SF4 a daemon.json for another project or a non-loopback bind refuses before any socket opens', async t => {
  for (const [health, patch] of [[{}, { projectPath: 'other' }], [{ report: '0.0.0.0' }, {}], [{}, { bindHost: '0.0.0.0' }], [{}, null]]) {
    const w = await sfDaemon(t, health);
    if (patch === null) rmSync(path.join(w.project, '.moe', 'daemon.json'));
    else w.info({ ...w.base, ...patch, ...('projectPath' in patch ? { projectPath: path.join(w.project, patch.projectPath) } : {}) });
    const { made, FakeSocket } = sfSocket({ onSend: echoArgs });
    await rejectsFixed(seatForward(w.project, { WebSocketImpl: FakeSocket })('moe.x', ARGS));
    assert.equal(made.length, 0, JSON.stringify([health, patch]));
  }
});

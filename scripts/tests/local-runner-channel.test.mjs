// CQ-V04b1 runner channel client. C1-C3 and the scripted-socket rows need no daemon; C4-C9 run a real built daemon's
// /runner endpoint (build packages/moe-daemon first). A sentinel key sits in every key file; C9 proves it never leaks.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_DAEMON_INFO_BYTES } from '../local-runner/guest-session.mjs';
import { RUNNER_KEY_HEADER, openRunnerChannel, runnerKeyFile } from '../local-runner/runner-client.mjs';
const daemonEntry = fileURLToPath(new URL('../../packages/moe-daemon/dist/index.js', import.meta.url));
const SENTINEL = `KEYSENTINEL${'x'.repeat(32)}`; // 43 base64url characters
const OTHER = `OTHERKEYZZZ${'z'.repeat(32)}`;
const VECTOR = 'a2bb049ac5d34b7ab874f73dd463c932'; // sha256('/srv/moe-project') hex, first 32
const [roots, seen, logged] = [[], [], []];
const keyDirWas = process.env.MOE_RUNNER_KEY_DIR;
const consoleWas = { ...console };
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...args) => logged.push(args.map(dump).join(' '));
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-runner-client-')); roots.push(dir); return dir; };
const keyName = projectPath => `${createHash('sha256').update(projectPath).digest('hex').slice(0, 32)}.key`;
function dump(value) { return `${value?.stack ?? ''}${String(value)}${JSON.stringify(value, value instanceof Error ? Object.getOwnPropertyNames(value) : undefined)}`; }
const keep = value => { seen.push(dump(value)); return value; };
const freePort = async () => { const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening'); const { port } = probe.address(); await new Promise(resolve => probe.close(resolve)); return port; };
const text = value => ({ content: [{ type: 'text', text: value }] });
async function refused(promise, code, extra = {}) {
  const error = keep(await promise.then(() => assert.fail(`resolved instead of ${code}`), failure => failure));
  assert.deepEqual({ code: error.code, message: error.message, ...Object.fromEntries(Object.keys(extra).map(name => [name, error[name]])) },
    { code, message: `Runner channel failed: ${code}.`, ...extra });
  return error;
}

// A scripted WebSocket: it opens on the next timer (unless silent), answers the open ping and records other frames.
const fakeSocket = () => class extends EventTarget {
  static calls = [];
  sent = [];
  constructor(url, options) {
    super();
    Object.assign(this, { url, options });
    this.constructor.calls.push(this);
    if (!this.constructor.silent) setTimeout(() => this.dispatchEvent(new Event('open')), 0);
  }
  send(data) {
    const frame = JSON.parse(data);
    if (frame.method === 'ping') setTimeout(() => this.reply({ jsonrpc: '2.0', id: frame.id, result: {} }), 0);
    else this.sent.push(frame);
  }
  close() { this.closed = true; }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) })); }
};

// The daemon: a fake /health reporting its loopback bind for the latest fixture's project (::1 best-effort; 0 where it cannot bind).
let healthProject;
const healthOn = host => new Promise(resolve => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ status: 'healthy', projectPath: healthProject, bindHost: host })));
  server.once('error', () => resolve(0)).listen(0, host, () => { after(() => { server.closeAllConnections(); server.close(); }); resolve(server.address().port); });
});
const [HEALTH_PORT, HEALTH_V6_PORT] = [await healthOn('127.0.0.1'), await healthOn('::1')];

// A project whose daemon.json is the valid default merged with `info` (null: none; a string: verbatim) and a fresh key dir.
function fixture({ info = {}, key, setup } = {}) {
  const [project, keys] = [scratch(), scratch()];
  process.env.MOE_RUNNER_KEY_DIR = keys;
  fs.mkdirSync(path.join(project, '.moe'));
  healthProject = project;
  const file = path.join(project, '.moe', 'daemon.json');
  const record = extra => JSON.stringify({ port: HEALTH_PORT, projectPath: project, ...extra });
  if (info !== null) fs.writeFileSync(file, typeof info === 'function' ? info(record) : typeof info === 'string' ? info : record(info));
  if (key !== undefined) fs.writeFileSync(path.join(keys, keyName(project)), key);
  setup?.(file);
  return { project, keys, WebSocket: fakeSocket() };
}

after(() => {
  Object.assign(console, consoleWas);
  if (keyDirWas === undefined) delete process.env.MOE_RUNNER_KEY_DIR; else process.env.MOE_RUNNER_KEY_DIR = keyDirWas;
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('C1 daemon.json discovery: each refusal is its own code and opens no socket', () => {
  const [INFO, LOOP] = ['RUNNER_DAEMON_INFO_INVALID', 'RUNNER_DAEMON_NOT_LOOPBACK'];
  const cases = [
    ['missing', { info: null }, INFO], ['not JSON', { info: '{nope' }, INFO], ['an array', { info: '[1]' }, INFO],
    ['one byte over the size cap', { info: record => record({ pad: 'a'.repeat(MAX_DAEMON_INFO_BYTES + 1 - record({ pad: '' }).length) }) }, INFO],
    ['a directory', { info: null, setup: file => fs.mkdirSync(file) }, INFO], ['a symlink', { setup: file => { fs.renameSync(file, `${file}.real`); fs.symlinkSync(`${file}.real`, file); } }, INFO, process.platform === 'win32'],
    ['another project', { info: { projectPath: path.join(os.tmpdir(), 'elsewhere') } }, INFO],
    ['a string port', { info: { port: '9' } }, INFO], ['port 65536', { info: { port: 65536 } }, INFO], ['no port', { info: { port: undefined } }, INFO],
    ['bindHost 0.0.0.0', { info: { bindHost: '0.0.0.0' } }, LOOP], ['bindHost localhost', { info: { bindHost: 'localhost' } }, LOOP],
  ];
  for (const [name, options, code, skip] of cases) {
    it(`${name} is ${code}`, { skip }, async () => {
      const { project, WebSocket } = fixture({ key: SENTINEL, ...options });
      await refused(openRunnerChannel({ projectPath: project, WebSocket }), code);
      assert.equal(WebSocket.calls.length, 0);
    });
  }
});

describe('C2 key file and C3 inputs and transport', () => {
  it('a missing file is RUNNER_KEY_MISSING; a directory, 42 or 44 characters, a newline, a bad character or oversize is RUNNER_KEY_INVALID', async () => {
    const missing = fixture();
    await refused(openRunnerChannel({ projectPath: missing.project, WebSocket: missing.WebSocket }), 'RUNNER_KEY_MISSING');
    fs.mkdirSync(path.join(missing.keys, keyName(missing.project)));
    await refused(openRunnerChannel({ projectPath: missing.project, WebSocket: missing.WebSocket }), 'RUNNER_KEY_INVALID');
    for (const key of [SENTINEL.slice(1), `${SENTINEL}x`, `${SENTINEL}\n`, `${SENTINEL.slice(1)}+`, 'x'.repeat(5000)]) {
      const { project, WebSocket } = fixture({ key });
      await refused(openRunnerChannel({ projectPath: project, WebSocket }), 'RUNNER_KEY_INVALID');
      assert.equal(WebSocket.calls.length, 0);
    }
    assert.equal(missing.WebSocket.calls.length, 0);
  });
  it('the key location honours MOE_RUNNER_KEY_DIR (trimmed, resolved) and falls back to ~/.moe/runner-keys', () => {
    const home = path.join(os.homedir(), '.moe', 'runner-keys', `${VECTOR}.key`);
    assert.deepEqual([{ MOE_RUNNER_KEY_DIR: ' /tmp/k ' }, {}, { MOE_RUNNER_KEY_DIR: '   ' }].map(env => runnerKeyFile('/srv/moe-project', env)),
      [path.join(path.resolve('/tmp/k'), `${VECTOR}.key`), home, home]);
  });
  it('hashes daemon.json\'s projectPath, not the caller\'s spelling, and dials the loopback endpoint with the header', async t => {
    if (!HEALTH_V6_PORT) t.diagnostic('the ::1 row is skipped: ::1 cannot bind on this host');
    const hosts = [[{}, `ws://127.0.0.1:${HEALTH_PORT}/runner`], [{ bindHost: '127.0.0.1' }, `ws://127.0.0.1:${HEALTH_PORT}/runner`],
      ...(HEALTH_V6_PORT ? [[{ bindHost: '::1', port: HEALTH_V6_PORT }, `ws://[::1]:${HEALTH_V6_PORT}/runner`]] : [])];
    for (const [info, url] of hosts) {
      const { project, WebSocket } = fixture({ info, key: SENTINEL });
      const channel = await openRunnerChannel({ projectPath: `${project}${path.sep}.${path.sep}`, WebSocket });
      assert.equal(WebSocket.calls[0].url, url);
      assert.ok(WebSocket.calls[0].options.headers[RUNNER_KEY_HEADER] === SENTINEL, 'the key header is sent');
      channel.close();
    }
  });

  it('a missing WebSocket is RUNNER_WEBSOCKET_UNAVAILABLE before any key read, and bad inputs are RUNNER_INPUT_INVALID', async () => {
    const { project, WebSocket } = fixture();
    await refused(openRunnerChannel({ projectPath: project, WebSocket: null }), 'RUNNER_WEBSOCKET_UNAVAILABLE');
    for (const input of [{}, { projectPath: '' }, { projectPath: 5 }, { projectPath: project, timeoutMs: 0 }, { projectPath: project, signal: {} }]) {
      await refused(openRunnerChannel({ WebSocket, ...input }), 'RUNNER_INPUT_INVALID');
    }
  });
  it('a refused connection is RUNNER_CONNECT_FAILED', async () => { // the fake /health has no /runner upgrade
    await refused(openRunnerChannel({ projectPath: fixture({ key: SENTINEL }).project }), 'RUNNER_CONNECT_FAILED');
  });
  it('a socket that never opens is RUNNER_CONNECT_TIMEOUT, and an abort is RUNNER_ABORTED', async () => {
    const { project, WebSocket } = fixture({ key: SENTINEL });
    WebSocket.silent = true;
    await refused(openRunnerChannel({ projectPath: project, WebSocket, timeoutMs: 150 }), 'RUNNER_CONNECT_TIMEOUT');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await refused(openRunnerChannel({ projectPath: project, WebSocket, signal: controller.signal }), 'RUNNER_ABORTED');
    await refused(openRunnerChannel({ projectPath: project, WebSocket, signal: AbortSignal.abort() }), 'RUNNER_ABORTED');
  });
});

describe('call() against a scripted socket', () => {
  const open = async () => {
    const { project, WebSocket } = fixture({ key: SENTINEL });
    return { channel: await openRunnerChannel({ projectPath: project, WebSocket }), socket: WebSocket.calls[0] };
  };
  const ask = async (channel, socket, reply, ...rest) => {
    const pending = channel.call('moe.list_tasks', {}, ...rest);
    pending.catch(() => {}); // a rejection during the tick below is awaited by the caller afterwards
    await tick();
    if (reply) socket.reply({ jsonrpc: '2.0', id: socket.sent.at(-1).id, ...reply });
    return pending;
  };
  it('sends one tools/call frame per call under increasing ids, ignores unmatched or garbage replies, and refuses a bad call', async () => {
    const { channel, socket } = await open();
    const first = channel.call('moe.list_tasks', { limit: 1 });
    const second = channel.call('moe.get_context', {});
    await tick();
    const [one, two] = socket.sent;
    assert.deepEqual(one, { jsonrpc: '2.0', id: one.id, method: 'tools/call', params: { name: 'moe.list_tasks', arguments: { limit: 1 } } });
    assert.ok(Number.isInteger(one.id) && two.id > one.id);
    for (const noise of ['not json', '[]', 'null', { id: 999, result: text('{}') }]) socket.reply(noise);
    socket.reply({ jsonrpc: '2.0', id: two.id, result: text('{"second":true}') });
    socket.reply({ jsonrpc: '2.0', id: one.id, result: text('{"first":true}') });
    assert.deepEqual(keep(await Promise.all([first, second])), [{ first: true }, { second: true }]);
    for (const [tool, args] of [['list_tasks', {}], ['moe.List', {}], ['moe.list_tasks', []], ['moe.list_tasks', null], [5, {}], ['moe.list_tasks', { n: 1n }]]) {
      await refused(channel.call(tool, args), 'RUNNER_CALL_INVALID');
    }
    assert.equal(socket.sent.length, 2);
  });
  it('a malformed result is RUNNER_RESPONSE_INVALID; an error carries its numbers but never its text', async () => {
    const { channel, socket } = await open();
    for (const result of [text('not json'), {}, { content: [] }, { content: [{ type: 'text', text: 5 }] }]) {
      await refused(ask(channel, socket, { result }), 'RUNNER_RESPONSE_INVALID');
    }
    const error = { code: -32001, message: '/secret/path upstream text', data: { codeName: 'TASK_NOT_FOUND' } };
    const failure = await refused(ask(channel, socket, { error }), 'RUNNER_TOOL_ERROR', { rpcCode: -32001, codeName: 'TASK_NOT_FOUND' });
    assert.ok(!dump(failure).includes('secret'), 'upstream text stays out of the error');
    await refused(ask(channel, socket, { error: { ...error, data: { codeName: 'secret\nnames' } } }), 'RUNNER_TOOL_ERROR', { rpcCode: -32001, codeName: undefined });
  });
  it('a timeout or an abort drops that call only, and a late reply is ignored', async () => {
    const { channel, socket } = await open();
    const controller = new AbortController();
    const aborted = ask(channel, socket, null, { signal: controller.signal });
    await refused(ask(channel, socket, null, { timeoutMs: 30 }), 'RUNNER_CALL_TIMEOUT');
    controller.abort();
    await refused(aborted, 'RUNNER_ABORTED');
    for (const frame of socket.sent) socket.reply({ jsonrpc: '2.0', id: frame.id, result: text('{"late":true}') });
    assert.deepEqual(keep(await ask(channel, socket, { result: text('{"ok":1}') })), { ok: 1 });
    const lingering = new AbortController();
    await refused(ask(channel, socket, null, { signal: lingering.signal, timeoutMs: 30 }), 'RUNNER_CALL_TIMEOUT');
    assert.equal(getEventListeners(lingering.signal, 'abort').length, 0, 'a settled call leaves no abort listener');
  });
  it('a close or an error rejects every pending and later call, and close() is idempotent', async () => {
    for (const event of ['close', 'error']) {
      const { channel, socket } = await open();
      const pending = [ask(channel, socket, null), ask(channel, socket, null)];
      socket.dispatchEvent(new Event(event));
      for (const one of pending) await refused(one, 'RUNNER_DISCONNECTED');
      await refused(channel.call('moe.list_tasks', {}), 'RUNNER_DISCONNECTED');
      channel.close();
      channel.close();
    }
    const { channel, socket } = await open();
    const pending = ask(channel, socket, null);
    channel.close();
    channel.close();
    await refused(pending, 'RUNNER_DISCONNECTED');
    assert.equal(socket.closed, true);
  });
});

describe('the real daemon /runner endpoint (C4-C9)', () => {
  const profile = scratch();
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MOE_')));
  let [daemon, project, keys, channel, diagnostics] = [null, '', '', null, ''];
  const until = async (check, label) => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await tick()) { if (await check()) return; }
    throw new Error(`Timed out: ${label}`);
  };
  const stopDaemon = async () => {
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
    try { execFileSync(process.execPath, [daemonEntry, 'stop', '--project', project], { env, windowsHide: true, timeout: 15_000, stdio: 'pipe' }); } catch { daemon.kill(); }
    await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 'daemon stop');
  };

  before(async () => {
    assert.ok(fs.existsSync(path.join(path.dirname(daemonEntry), 'server', 'runnerChannel.js')), 'build packages/moe-daemon first: dist predates the runner channel');
    assert.match(fs.readFileSync(daemonEntry, 'utf8'), /checks,\s*(?:\/\/.*\s+)?bindHost: host\b/, 'build packages/moe-daemon first: dist predates the /health bind report');
    [project, keys] = [scratch(), scratch()];
    fs.writeFileSync(path.join(keys, keyName(project)), SENTINEL, { mode: 0o600 });
    Object.assign(env, { HOME: profile, USERPROFILE: profile, NODE_ENV: 'production', LOG_LEVEL: 'warn', MOE_RUNNER_KEY_DIR: keys });
    daemon = spawn(process.execPath, [daemonEntry, 'init', '--project', project, '--port', String(await freePort())], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });
    process.env.MOE_RUNNER_KEY_DIR = keys;
    await until(async () => { // the client is the readiness probe: it opens only once the daemon accepts the key
      assert.equal(daemon.exitCode, null, 'the daemon exited before it was ready');
      channel = await openRunnerChannel({ projectPath: project, timeoutMs: 2000 }).catch(() => null);
      return channel;
    }, 'a runner channel');
    assert.ok(fs.readFileSync(path.join(keys, keyName(project)), 'utf8') === SENTINEL, 'the daemon reused the sentinel key');
  });
  after(async () => { channel?.close(); await stopDaemon(); });

  it('C4/C5 resolve a tool result as parsed JSON and reject a tool error with the daemon\'s code and codeName', async () => {
    assert.equal(Object.getPrototypeOf(keep(await channel.call('moe.list_tasks', {}))), Object.prototype);
    await refused(channel.call('moe.get_context', { taskId: 'task-0000000000000000000000000000dead' }), 'RUNNER_TOOL_ERROR',
      { rpcCode: -32001, codeName: 'TASK_NOT_FOUND' });
  });
  it('C6 refuses a different key with RUNNER_AUTH_REFUSED', async () => {
    const wrong = scratch();
    fs.writeFileSync(path.join(wrong, keyName(project)), OTHER);
    process.env.MOE_RUNNER_KEY_DIR = wrong;
    await refused(openRunnerChannel({ projectPath: project }), 'RUNNER_AUTH_REFUSED');
    process.env.MOE_RUNNER_KEY_DIR = keys;
  });
  it('C7 times out a parked call and the channel stays usable', async () => {
    await refused(channel.call('moe.chat_wait', { workerId: 'runner-test-timeout', timeoutMs: 5000 }, { timeoutMs: 500 }), 'RUNNER_CALL_TIMEOUT');
    assert.equal(Object.getPrototypeOf(keep(await channel.call('moe.list_tasks', {}))), Object.prototype);
  });
  it('C8 rejects every pending call, and later ones, when the daemon stops', async () => {
    const pending = ['a', 'b'].map(id => channel.call('moe.chat_wait', { workerId: `runner-test-${id}`, timeoutMs: 600_000 }, { timeoutMs: 60_000 }));
    for (const one of pending) one.catch(() => {}); // they reject while the daemon stops, before anything awaits them
    await tick();
    await stopDaemon();
    for (const one of pending) await refused(one, 'RUNNER_DISCONNECTED');
    await refused(channel.call('moe.list_tasks', {}), 'RUNNER_DISCONNECTED');
    channel.close();
    channel.close();
  });
  it('C9 the key never reaches an error, a value, a console call or the daemon output', () => {
    assert.ok(dump(Object.assign(new Error('probe'), { code: SENTINEL })).includes(SENTINEL), 'the dump sees a leaked key');
    for (const secret of [SENTINEL, OTHER]) {
      assert.ok(!seen.some(entry => entry.includes(secret)), 'a client product carries a key');
      assert.ok(!diagnostics.includes(secret), 'the daemon output carries a key');
    }
    assert.deepEqual(logged, []);
  });
});

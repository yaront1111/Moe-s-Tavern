// The local runner admits a daemon only on that daemon's own /health bind report for this project. daemon.json is
// repository content, so it may refuse but never admit. Every daemon here is a fake /health on loopback: no built
// daemon is needed, and port 9876 is never touched.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeFrame } from '../local-runner/guest-bridge.mjs';
import { runGuestSession } from '../local-runner/guest-session.mjs';
import { ownedInstanceName } from '../local-runner/lifecycle.mjs';
import { openRunnerChannel, runnerKeyFile } from '../local-runner/runner-client.mjs';
import { mcpCaller, readDaemonInfo } from '../local-runner/vm-control.mjs';

const HEALTH_CAP = 65_536; // DB1 pins it to MAX_HEALTH_BYTES
const OTHER = path.join(tmpdir(), 'moe-daemon-bind-other');
const KEY = `KEYSENTINEL${'k'.repeat(32)}`; // 43 base64url characters
const V6 = await new Promise(resolve => {
  const probe = net.createServer().once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});
const NO_V6 = !V6 && '::1 cannot bind on this host';

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-daemon-bind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function closedPort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const report = fake => ({ status: 'healthy', projectPath: fake.project, bindHost: fake.host, ...fake.body });
// A valid report padded to exactly `size` bytes.
const padded = size => (req, res, fake) => {
  const base = Buffer.byteLength(JSON.stringify({ ...report(fake), pad: '' }));
  send(res, 200, JSON.stringify({ ...report(fake), pad: 'x'.repeat(size - base) }));
};
const silent = () => {};
const trickle = (req, res) => {
  res.writeHead(200);
  const timer = setInterval(() => res.write(' '), 20);
  res.on('close', () => clearInterval(timer));
};

/** A fake daemon on host:0 answering `answer`, else 200 with report(fake); every request is logged, all closed in t.after. */
async function fakeHealth(t, project, { host = '127.0.0.1', body = {}, answer } = {}) {
  const fake = { project, host, body, answer, log: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    fake.log.push(`${req.method} ${req.url} ${req.socket.remoteAddress}`);
    if (fake.answer) fake.answer(req, res, fake);
    else send(res, 200, report(fake));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  fake.port = server.address().port;
  fake.close = () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  t.after(fake.close);
  return fake;
}

/** A scratch project, its fake daemon and its .moe/daemon.json {port, pid, projectPath, ...info}; closed: a dead port. */
async function daemon(t, { closed = false, info = {}, ...fakeOptions } = {}) {
  const root = scratch(t);
  const fake = await fakeHealth(t, root, fakeOptions);
  const record = JSON.parse(JSON.stringify({ port: closed ? await closedPort() : fake.port, pid: 1, projectPath: root, ...info }));
  mkdirSync(path.join(root, '.moe'));
  const file = path.join(root, '.moe', 'daemon.json');
  writeFileSync(file, JSON.stringify(record));
  return { root, file, fake, info: record };
}

// Every module refuses each of these with its own code.
const KINDS = Object.entries({
  'no answer': { closed: true },
  'a timeout': { answer: silent },
  'a malformed reply': { answer: (req, res) => send(res, 200, '{') },
  'an oversized reply': { answer: padded(HEALTH_CAP + 1) },
  'another project': { body: { projectPath: OTHER } },
  'a missing bind field': { body: { bindHost: undefined } },
  'a 0.0.0.0 bind with no file bindHost': { body: { bindHost: '0.0.0.0' } },
  'a wsl bind with no file bindHost': { body: { bindHost: 'wsl' } },
});
// A refusal code, 'admitted', or 'unsettled' when nothing settles within ms.
const settled = (promise, ms = 3_000) =>
  Promise.race([promise.then(() => 'admitted', error => error?.code ?? 'uncoded'), sleep(ms, 'unsettled', { ref: false })]);
function keyDir(t) {
  const was = process.env.MOE_RUNNER_KEY_DIR;
  t.after(() => { if (was === undefined) delete process.env.MOE_RUNNER_KEY_DIR; else process.env.MOE_RUNNER_KEY_DIR = was; });
  process.env.MOE_RUNNER_KEY_DIR = scratch(t);
}
// A scripted WebSocket: it opens on a microtask and answers every frame with one successful tool result.
const scripted = () => class Socket extends EventTarget {
  static made = [];
  constructor(url) { super(); this.url = url; Socket.made.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(text) {
    const { id } = JSON.parse(text);
    const result = { content: [{ type: 'text', text: '{"success":true}' }] };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })));
  }
  close() {}
};

test('DB1 loopbackDaemonHost admits only a healthy loopback report for this project, within one total deadline', async t => {
  const { loopbackDaemonHost, MAX_HEALTH_BYTES } = await import('../local-runner/guest-session.mjs');
  assert.equal(MAX_HEALTH_BYTES, HEALTH_CAP);
  const rows = [
    ['no file bindHost', {}, '127.0.0.1'], ['file bindHost 127.0.0.1', { info: { bindHost: '127.0.0.1' } }, '127.0.0.1'],
    ['this project in another spelling', { spelling: root => `${root}${path.sep}` }, '127.0.0.1'],
    ['a reply of exactly MAX_HEALTH_BYTES', { answer: padded(HEALTH_CAP) }, '127.0.0.1'],
    ...KINDS, ['a trickle', { answer: trickle }],
    ...['[]', 'null'].map(body => [`reply ${body}`, { answer: (req, res) => send(res, 200, body) }]),
    ['a 503', { answer: (req, res, fake) => send(res, 503, report(fake)) }], ['an unhealthy status', { body: { status: 'unhealthy' } }],
    ['a 302', { answer: (req, res, fake) => { res.setHeader('location', '/health'); send(res, 302, report(fake)); } }],
    ...['::', 'localhost', '127.0.0.2', '::ffff:127.0.0.1', '', null, 1, ['127.0.0.1'], '127.0.0.1 ', 'WSL']
      .map(bindHost => [`report bindHost ${JSON.stringify(bindHost)}`, { body: { bindHost } }]),
  ];
  for (const [name, { spelling = root => root, ...options }, expected = null] of rows) {
    const { root, fake, info } = await daemon(t, options);
    const started = Date.now();
    const host = await Promise.race([loopbackDaemonHost(info, spelling(root), { timeoutMs: 200 }), sleep(1_000, 'unsettled', { ref: false })]);
    assert.deepEqual([host, Date.now() - started < 1_000], [expected, true], name);
    assert.deepEqual(fake.log, options.closed ? [] : ['GET /health 127.0.0.1'], name);
  }
  // daemon.json can only refuse: a non-loopback or malformed bindHost, or an unusable port, sends no request.
  for (const extra of [...['0.0.0.0', 'wsl', null, ['127.0.0.1']].map(bindHost => ({ bindHost })), { port: 0 }, { port: 65_536 }, { port: '1' }, { port: undefined }]) {
    const { root, fake, info } = await daemon(t, { info: extra });
    assert.deepEqual([await loopbackDaemonHost(info, root, { timeoutMs: 200 }), fake.log], [null, []], JSON.stringify(extra));
  }
  for (const info of [null, [], 'x', 7]) assert.equal(await loopbackDaemonHost(info, OTHER), null);
  const { root, info } = await daemon(t);
  assert.equal(await loopbackDaemonHost(info, root, { signal: AbortSignal.abort() }), null);
});

test('DB1 ::1 is admitted only from a ::1 daemon reporting a loopback bind', { skip: NO_V6 }, async t => {
  const { loopbackDaemonHost } = await import('../local-runner/guest-session.mjs');
  const { root, fake, info } = await daemon(t, { host: '::1', info: { bindHost: '::1' } });
  assert.deepEqual([await loopbackDaemonHost(info, root, { timeoutMs: 1_000 }), fake.log], ['::1', ['GET /health ::1']]);
});

const NAME = ownedInstanceName({ random: () => Buffer.alloc(10, 0xab) });
const BINDING = Object.freeze({ role: 'worker', workerId: 'worker-1', taskId: 'task-abc', attemptId: 'attempt-1', generation: 2 });
const JOB = Object.freeze({ cli: 'claude', credential: Object.freeze({ name: 'ANTHROPIC_API_KEY', value: 'sk-test-key' }) });
const HELLO = { kind: 'hello', protocol: 1 };
const REQUEST = { kind: 'request', id: 1, tool: 'moe.get_context', args: {} };
const EXIT = { kind: 'observation', type: 'exit', code: 0, signal: null };

// The bridge test's fake provider, cut down: real streams; it exits 74 when the host closes its stdin.
function provider() {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], written: [], job: null });
  proc.stdin = new Writable({ write(chunk, encoding, done) { if (proc.job === null) proc.job = chunk; else proc.written.push(chunk); done(); } });
  proc.exit = (code = 0) => { if (!proc.stdout.writableEnded) proc.stdout.once('close', () => proc.emit('close', code, null)).end(); };
  proc.stdin.once('close', () => proc.exit(74));
  proc.kill = signal => { setImmediate(() => proc.emit('close', null, signal)); return true; };
  proc.spawn = (...args) => { proc.calls.push(args); return proc; };
  proc.send = (...frames) => proc.stdout.write(Buffer.concat(frames.map(frame => encodeFrame(frame))));
  return proc;
}
function session(proc, daemonInfoPath, options = {}) {
  const run = { forwarded: [] };
  run.promise = runGuestSession({ name: NAME, binding: BINDING, job: JOB, sessionId: 'worker-1@2026-10-30T00:00:00.000Z', daemonInfoPath,
    provider: { spawn: proc.spawn }, timeoutMs: 200, onOutput: () => {}, onObservation: () => {},
    forward: tool => { run.forwarded.push(tool); return { content: [{ type: 'text', text: tool }] }; }, ...options });
  return run;
}
async function until(check) {
  for (const deadline = Date.now() + 5_000; !check(); await sleep(5)) if (Date.now() > deadline) throw new Error('timed out');
}

test('DB2 guest-session starts only on the loopback report of the project its daemonInfoPath names', async t => {
  for (const [name, options] of KINDS) {
    const { file } = await daemon(t, options);
    const proc = provider();
    assert.deepEqual([await settled(session(proc, file).promise), proc.calls.length], ['SESSION_DAEMON_NOT_LOOPBACK', 0], name);
  }
  for (const info of [{ port: undefined }, { port: 'x' }]) {
    const { file } = await daemon(t, { info });
    assert.equal(await settled(session(provider(), file).promise), 'SESSION_DAEMON_INFO_INVALID');
  }
  // The project is the one daemonInfoPath sits in, never daemon.json's own projectPath field.
  const elsewhere = await daemon(t);
  const named = scratch(t);
  mkdirSync(path.join(named, '.moe'));
  writeFileSync(path.join(named, '.moe', 'daemon.json'), JSON.stringify(elsewhere.info));
  const proc = provider();
  assert.deepEqual([await settled(session(proc, path.join(named, '.moe', 'daemon.json')).promise), proc.calls.length, elsewhere.fake.log.length],
    ['SESSION_DAEMON_NOT_LOOPBACK', 0, 1]);
  const { file } = await daemon(t);
  const started = provider();
  const run = session(started, file);
  started.send(HELLO, EXIT);
  started.exit(0);
  assert.deepEqual(await run.promise, { observation: EXIT, executionReady: false });
});

test('DB2 guest-session asks the daemon again before every forward', async t => {
  const rebind = fake => { fake.body = { bindHost: '0.0.0.0' }; };
  for (const [change, code] of [[rebind, 'SESSION_DAEMON_NOT_LOOPBACK'], [fake => fake.close(), 'SESSION_DAEMON_NOT_LOOPBACK'],
    [fake => { fake.answer = silent; }, 'SESSION_ABORTED']]) {
    const { file, fake } = await daemon(t);
    const controller = new AbortController();
    const proc = provider();
    const run = session(proc, file, { timeoutMs: 1_000, signal: controller.signal });
    proc.send(HELLO, REQUEST);
    await until(() => proc.written.length === 1);
    await change(fake);
    proc.send({ ...REQUEST, id: 2 });
    // A probe cut short by teardown never sets the session's failure code.
    if (code === 'SESSION_ABORTED') await until(() => fake.log.length === 2).then(() => controller.abort());
    assert.deepEqual([await settled(run.promise), run.forwarded], [code, ['moe.get_context']]);
    proc.exit(0);
  }
});

test('DB3 runner-client dials /runner only on the daemon\'s loopback report, before the key is read', async t => {
  keyDir(t); // no key file exists until a row writes one: a key read would surface RUNNER_KEY_MISSING
  for (const [name, options] of KINDS) {
    const { root } = await daemon(t, options);
    const WebSocket = scripted();
    assert.deepEqual([await settled(openRunnerChannel({ projectPath: root, WebSocket, timeoutMs: 200 })), WebSocket.made.length],
      ['RUNNER_DAEMON_NOT_LOOPBACK', 0], name);
  }
  for (const [options, url] of [[{}, port => `ws://127.0.0.1:${port}/runner`],
    ...(V6 ? [[{ host: '::1', info: { bindHost: '::1' } }, port => `ws://[::1]:${port}/runner`]] : [])]) {
    const { root, fake } = await daemon(t, options);
    writeFileSync(runnerKeyFile(root), KEY);
    const WebSocket = scripted();
    (await openRunnerChannel({ projectPath: root, WebSocket, timeoutMs: 1_000 })).close();
    assert.deepEqual([WebSocket.made.map(socket => socket.url), fake.log.length], [[url(fake.port)], 1]);
  }
  // An abort stays RUNNER_ABORTED: already aborted, or aborted while the daemon has not answered.
  const { root } = await daemon(t, { answer: silent });
  writeFileSync(runnerKeyFile(root), KEY);
  const WebSocket = scripted();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  for (const signal of [AbortSignal.abort(), controller.signal]) {
    assert.equal(await settled(openRunnerChannel({ projectPath: root, WebSocket, timeoutMs: 10_000, signal }), 1_000), 'RUNNER_ABORTED');
  }
  assert.equal(WebSocket.made.length, 0);
});

test('DB4 vm-control reads daemon info and dials /mcp only on the daemon\'s loopback report', async t => {
  for (const [name, options] of KINDS) {
    const { root } = await daemon(t, options);
    assert.equal(await settled(readDaemonInfo(root, { timeoutMs: 200 })), 'DAEMON_UNREACHABLE', name);
  }
  for (const bindHost of ['0.0.0.0', 'wsl']) {
    const { root } = await daemon(t, { body: { bindHost } });
    const WebSocketImpl = scripted();
    assert.equal(await settled(mcpCaller(root, { WebSocketImpl })('moe.list_resources', {})), 'DAEMON_UNREACHABLE');
    assert.equal(WebSocketImpl.made.length, 0);
  }
  for (const [options, host, url] of [[{}, '127.0.0.1', port => `ws://127.0.0.1:${port}/mcp`],
    ...(V6 ? [[{ host: '::1', info: { bindHost: '::1' } }, '::1', port => `ws://[::1]:${port}/mcp`]] : [])]) {
    const { root, fake } = await daemon(t, options);
    assert.deepEqual(await readDaemonInfo(root, { timeoutMs: 1_000 }), { port: fake.port, host });
    const WebSocketImpl = scripted();
    assert.deepEqual(await mcpCaller(root, { WebSocketImpl })('moe.list_resources', {}), { success: true });
    assert.deepEqual(WebSocketImpl.made.map(socket => socket.url), [url(fake.port)]);
  }
});

test('DB5 a non-loopback daemon.json bindHost refuses in every module with no request, even beside a loopback report', async t => {
  keyDir(t);
  for (const bindHost of ['0.0.0.0', 'wsl']) {
    const { root, file, fake } = await daemon(t, { info: { bindHost } });
    writeFileSync(runnerKeyFile(root), KEY);
    const [proc, WebSocket] = [provider(), scripted()];
    assert.deepEqual([await settled(session(proc, file).promise), await settled(openRunnerChannel({ projectPath: root, WebSocket })),
      await settled(readDaemonInfo(root)), fake.log, proc.calls.length, WebSocket.made.length],
    ['SESSION_DAEMON_NOT_LOOPBACK', 'RUNNER_DAEMON_NOT_LOOPBACK', 'DAEMON_UNREACHABLE', [], 0, 0], bindHost);
  }
});

// The caller's own path, spelled the native way that path.resolve folds back: //x on POSIX, a drive-relative /x on win32.
test('DB6 each module admits its own daemon when the caller spells the project //x (POSIX) or /x (win32)', async t => {
  keyDir(t);
  const { root, file, fake } = await daemon(t);
  writeFileSync(runnerKeyFile(root), KEY);
  const win = process.platform === 'win32';
  const alias = value => (win ? value.slice(2).replace(/\\/g, '/') : `/${value}`);
  if (win) { // '/x' takes the cwd's drive, and the checkout may sit on another drive than tmpdir
    const cwd = process.cwd();
    process.chdir(path.dirname(root));
    t.after(() => process.chdir(cwd));
  }
  const proc = provider();
  const run = session(proc, alias(file));
  proc.send(HELLO, EXIT);
  proc.exit(0);
  assert.deepEqual(await run.promise, { observation: EXIT, executionReady: false });
  (await openRunnerChannel({ projectPath: alias(root), WebSocket: scripted(), timeoutMs: 1_000 })).close();
  assert.deepEqual(await readDaemonInfo(alias(root), { timeoutMs: 1_000 }), { port: fake.port, host: '127.0.0.1' });
});

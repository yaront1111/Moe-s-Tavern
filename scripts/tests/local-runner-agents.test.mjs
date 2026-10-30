// CQ-R10d in-guest agents. CQ-R10d1: the guest MCP stdio shim (rows SH1-SH9) under the host's python3, against a
// fake agent-socket peer built from the CQ-R08a decoder and encoder. Later CQ-R10d slices extend this file.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUserData, GUEST_LAYOUT, MAX_SUPERVISOR_BYTES } from '../local-runner/guest-bootstrap.mjs';
import { createFrameDecoder, encodeFrame, MAX_GUEST_FRAME_BYTES, MAX_HOST_FRAME_BYTES, parseGuestFrame, TOOLS } from '../local-runner/guest-bridge.mjs';

const NO_GUEST = process.platform === 'win32' && 'the MCP shim runs only in the Linux guest (POSIX python3)';
const RUNNER = fileURLToPath(new URL('../local-runner/', import.meta.url));
const [SHIM, TOOLS_FILE] = ['guest-mcp-shim.py', 'guest-mcp-tools.json'].map(name => join(RUNNER, name));
const PROJECTION = Object.fromEntries(Object.entries(TOOLS).map(([role, tools]) => [role, Object.fromEntries(Object.entries(tools).map(([tool, { args }]) => [tool, args]))]));
// -B: both IDE bundlers copy scripts/local-runner wholesale, so a __pycache__ there would ship.
const LOAD = `import importlib.util, json, os, sys
m = importlib.util.module_from_spec(spec := importlib.util.spec_from_file_location('moe_shim', sys.argv[1]))
spec.loader.exec_module(m)
`;
const ERRORS = {
  PARSE: [-32700, 'Parse error.'], INVALID_REQUEST: [-32600, 'Invalid request.'], TOO_LARGE: [-32600, 'Request too large.'], METHOD: [-32601, 'Method not found.'],
  INVALID_PARAMS: [-32602, 'Invalid params.'], TOOL_DENIED: [-32602, 'Tool not available to this role.'], ARGUMENT_DENIED: [-32602, 'Argument not allowed for this tool.'],
  BUSY: [-32001, 'Too many tool calls in flight.'], TIMEOUT: [-32002, 'The tool call timed out.'], UNAVAILABLE: [-32003, 'The Moe bridge is unavailable.'], REFUSED: [-32004, 'Moe refused the tool call.'],
};
const fail = (name, id = null, data) => ({ jsonrpc: '2.0', id, error: { code: ERRORS[name][0], message: ERRORS[name][1], ...(data && { data }) } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpc = (id, method, params) => ({ jsonrpc: '2.0', ...(id !== undefined && { id }), method, ...(params !== undefined && { params }) });
const call = (id, name, args) => rpc(id, 'tools/call', { name, ...(args !== undefined && { arguments: args }) });
const heartbeat = id => call(id, 'moe.heartbeat');
const listed = role => ({ tools: Object.entries(TOOLS[role]).map(([name, { args }]) =>
  ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(args.map(key => [key, {}])), additionalProperties: false } })) });
const response = (id, answer) => encodeFrame({ kind: 'response', id, ...answer }, MAX_HOST_FRAME_BYTES);
const until = async (check, label) => { for (const end = Date.now() + 10_000; !check(); await sleep(10)) assert.ok(Date.now() < end, `timed out: ${label}`); };
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'moe-shim-')); dirs.push(dir); return dir; };

// A failing row must not leave a shim or a listener behind, or node --test never exits.
const [shims, servers, dirs] = [[], [], []];
after(() => {
  for (const proc of shims) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// serve() on a child python3 with MOE_ROLE (null: unset); setup runs first, e.g. to lower a module limit.
function launch({ role = 'worker', socket = '/nonexistent/moe-shim/agent.sock', timeout = 'None', setup = '' } = {}) {
  const code = `${LOAD}${setup}\nsys.exit(m.serve(os.environ.get('MOE_ROLE'), m.load_tools(sys.argv[2]), sys.argv[3], timeout=${timeout}))`;
  const env = { PATH: process.env.PATH, ...(role !== null && { MOE_ROLE: role }) };
  const proc = spawn('python3', ['-I', '-B', '-c', code, SHIM, TOOLS_FILE, socket], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  shims.push(proc);
  const shim = { text: '', exited: once(proc, 'exit'), get lines() { return this.text.split('\n').slice(0, -1).map(line => JSON.parse(line)); } };
  proc.stdout.setEncoding('utf8').on('data', chunk => { shim.text += chunk; });
  shim.send = (...messages) => { for (const m of messages) proc.stdin.write(typeof m === 'string' || Buffer.isBuffer(m) ? m : `${JSON.stringify(m)}\n`); };
  shim.wait = count => until(() => shim.lines.length >= count, `${count} lines`);
  shim.end = async () => { proc.stdin.end(); assert.deepEqual([...await shim.exited, shim.text.split('\n').at(-1)], [0, null, '']); return shim.lines; };
  return shim;
}
const exchange = (messages, options) => { const shim = launch(options); shim.send(...messages); return shim.end(); };

// A fake agent socket: each connection's guest frames must pass the R08a decoder and parseGuestFrame.
async function fakePeer() {
  const peer = { path: join(scratch(), 'agent.sock'), conns: [], frames: [], errors: [] };
  const server = createServer(sock => {
    const decoder = createFrameDecoder(MAX_GUEST_FRAME_BYTES);
    const conn = { sock, frames: [], closed: false };
    peer.conns.push(conn);
    sock.on('error', () => {}).on('close', () => { conn.closed = true; }).on('data', chunk => {
      try { for (const frame of decoder.push(chunk).map(parseGuestFrame)) { conn.frames.push(frame); peer.frames.push(frame); } } catch (error) { peer.errors.push(error.code); }
    });
  });
  servers.push(server);
  await once(server.listen(peer.path), 'listening');
  return peer;
}
const relay = async options => { const peer = await fakePeer(); return [peer, launch({ socket: peer.path, ...options })]; };

test('SH1 tools.json is the TOOLS projection, and tools/list serves exactly MOE_ROLE\'s tools', { timeout: 30_000 }, async t => {
  assert.equal(readFileSync(TOOLS_FILE, 'utf8'), `${JSON.stringify(PROJECTION)}\n`);
  if (NO_GUEST) return t.skip(NO_GUEST);
  for (const role of ['worker', 'qa']) assert.deepEqual(await exchange([rpc(1, 'tools/list')], { role }), [ok(1, listed(role))], role);
  for (const role of [null, '', 'admin', 'WORKER', 'constructor']) {
    assert.deepEqual(await exchange([rpc(1, 'tools/list'), call(2, 'moe.get_context')], { role }), [ok(1, { tools: [] }), fail('TOOL_DENIED', 2)], String(role));
  }
  const dir = scratch();
  const small = '{"worker":{"moe.x":[]}}';
  const files = [
    '{', '[]', '{"worker":[]}', '{"worker":{"moe.Get":[]}}', '{"worker":{"moe.x-y":[]}}', '{"worker":{"get_context":[]}}', '{"worker":{"moe.x":"view"}}',
    '{"worker":{"moe.x":["a","a"]}}', '{"worker":{"moe.x":["1a"]}}', '{"worker":{"moe.x":["a-b"]}}', '{"worker":{"moe.x":[1]}}', '{"worker":{"moe.x":[]},"n":NaN}',
    Buffer.from([0x7b, 0xff, 0x7d]), small.padEnd(MAX_SUPERVISOR_BYTES + 1), small.padEnd(MAX_SUPERVISOR_BYTES),
  ].map((content, index) => { const file = join(dir, `${index}.json`); writeFileSync(file, content); return file; });
  const code = `${LOAD}print(json.dumps([m.load_tools(p) for p in sys.argv[2:]]))`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, SHIM, join(dir, 'missing.json'), ...files, TOOLS_FILE]);
  assert.equal(run.status, 0, String(run.stderr));
  // The missing file and every invalid one serve none; only the file at the size bound and the repo table load.
  assert.deepEqual(JSON.parse(run.stdout), [...Array(files.length).fill({}), JSON.parse(small), PROJECTION]);
});

test('SH2 initialize negotiates the protocol version, and notifications are never answered', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  const init = (id, protocolVersion) => ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'moe-guest-shim', version: '1' } });
  assert.deepEqual(await exchange([
    ...versions.map((protocolVersion, id) => rpc(id, 'initialize', { protocolVersion, capabilities: {} })),
    rpc(9, 'initialize', { protocolVersion: '2099-01-01' }), rpc(undefined, 'notifications/initialized'),
    rpc(undefined, 'notifications/cancelled', { requestId: 9 }), rpc(undefined, 'tools/call', { name: 'moe.get_context' }),
    rpc(undefined, 'unknown/notification'), ' \t\r\n', '\n', rpc('p', 'ping'),
  ]), [...versions.map((version, id) => init(id, version)), init(9, '2025-11-25'), ok('p', {})]);
});

test('SH3 refused calls, malformed messages and unknown methods get fixed errors and never reach the socket', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const peer = await fakePeer();
  const mark = 'zqmarkzq';
  const cases = [
    [call(1, `moe.${mark}`), fail('TOOL_DENIED', 1)], [call(2, 'moe.qa_approve', { summary: 's' }), fail('TOOL_DENIED', 2)],
    [call(3, 'moe.get_context', { taskId: 'task-x' }), fail('ARGUMENT_DENIED', 3)], [call(4, 'moe.start_step', { stepId: 's', workerId: 'w' }), fail('ARGUMENT_DENIED', 4)],
    [call(5, 'moe.add_comment', { [mark]: 1 }), fail('ARGUMENT_DENIED', 5)], [call(6, 'moe.add_comment', ['content']), fail('INVALID_PARAMS', 6)],
    [call(7, 'moe.add_comment', null), fail('INVALID_PARAMS', 7)], [rpc(8, 'tools/call', { name: 5 }), fail('INVALID_PARAMS', 8)],
    [rpc(9, 'tools/call', ['moe.add_comment']), fail('INVALID_PARAMS', 9)], [rpc(10, 'ping', 'x'), fail('INVALID_PARAMS', 10)],
    [rpc(11, 'initialize', {}), fail('INVALID_PARAMS', 11)], [rpc(12, 'initialize', { protocolVersion: 20250618 }), fail('INVALID_PARAMS', 12)],
    [rpc(13, `${mark}/list`), fail('METHOD', 13)], [rpc('s', 'resources/list'), fail('METHOD', 's')], [`{"${mark}\n`, fail('PARSE')],
    [Buffer.from('{"jsonrpc":"2.0","id":1,"method":"\xff"}\n', 'latin1'), fail('PARSE')], [`\uFEFF${JSON.stringify(rpc(14, 'ping'))}\n`, fail('PARSE')],
    ['{"jsonrpc":"2.0","id":15,"method":"ping","params":{"x":NaN}}\n', fail('PARSE')], ['{"jsonrpc":"2.0","id":16,"method":"ping","params":{"x":1e999}}\n', fail('PARSE')],
    ...[[rpc(17, 'ping')], '5\n', 'null\n', { ...rpc(18, 'ping'), jsonrpc: '1.0' }, { jsonrpc: '2.0', id: 19 }, { ...rpc(20, 'ping'), method: 7 },
      ...[1.5, true, null, {}, 'i'.repeat(257), 2 ** 53].map(id => ({ ...rpc(1, 'ping'), id }))].map(input => [input, fail('INVALID_REQUEST')]),
    [rpc('i'.repeat(256), 'ping'), ok('i'.repeat(256), {})], [rpc(-(2 ** 53 - 1), 'ping'), ok(-(2 ** 53 - 1), {})],
  ];
  const lines = await exchange(cases.map(([input]) => input), { socket: peer.path });
  assert.deepEqual([lines, JSON.stringify(lines).includes(mark)], [cases.map(([, expected]) => expected), false]);
  await sleep(50);
  assert.deepEqual([peer.conns.length, peer.errors], [0, []]);
});

test('SH4 the CI local-runner step keeps its pinned prefix and runs this file', () => {
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const [, run] = /\n *- name: Test local runner prerequisite bundles\n *(run: [^\n]*)/.exec(ci);
  assert.match(run, /^run: node --test scripts\/tests\/local-runner\.test\.mjs scripts\/tests\/local-runner-bundle\.test\.mjs /);
  assert.equal(run.split(' ').filter(file => file === 'scripts/tests/local-runner-agents.test.mjs').length, 1);
});

test('SH5 an allowed tools/call is one request frame on the agent socket, answered with the host result unchanged', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const [peer, shim] = await relay();
  const result = { content: [{ type: 'text', text: 'café \u{1F600} </script>' }], structuredContent: { n: [1, 2.5, null, true, -0.125] } };
  shim.send(call(1, 'moe.start_step', { stepId: 'step-1' }), call('s', 'moe.get_handoff_history'), call(3, 'moe.add_comment', { content: 'x' }));
  await until(() => peer.frames.length === 3, 'three frames');
  assert.deepEqual(peer.frames, [
    { kind: 'request', id: 1, tool: 'moe.start_step', args: { stepId: 'step-1' } },
    { kind: 'request', id: 2, tool: 'moe.get_handoff_history', args: {} }, { kind: 'request', id: 3, tool: 'moe.add_comment', args: { content: 'x' } },
  ]);
  // Out of order and in one chunk: each reply is matched by its bridge id.
  const replies = [[1, { ok: true, result }], [3, { ok: false, error: { code: 'BRIDGE_UPSTREAM_FAILED' } }], [2, { ok: true, result: { content: [] } }]];
  peer.conns[0].sock.write(Buffer.concat(replies.map(([id, answer]) => response(id, answer))));
  await shim.wait(3);
  assert.deepEqual(await shim.end(), [ok(1, result), fail('REFUSED', 3, { code: 'BRIDGE_UPSTREAM_FAILED' }), ok('s', { content: [] })]);
  assert.deepEqual([peer.conns.length, peer.errors], [1, []]);
});

test('SH6 lines, frames, in-flight calls, request ids and call time are bounded', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const MAX_LINE_BYTES = 262_144;
  const ping = (id, bytes) => JSON.stringify(rpc(id, 'ping', { p: 'x'.repeat(bytes - JSON.stringify(rpc(id, 'ping', { p: '' })).length) }));
  assert.deepEqual(await exchange([`${ping(1, MAX_LINE_BYTES)}\n`, `${ping(2, MAX_LINE_BYTES + 1)}\n`, `${'['.repeat(3 * MAX_LINE_BYTES)}\n`, rpc(3, 'ping')]),
    [ok(1, {}), fail('TOO_LARGE'), fail('TOO_LARGE'), ok(3, {})]);

  // A body of exactly the lowered frame limit is sent and one byte more is not ('é' is two UTF-8 bytes); ids end at 2.
  const base = Buffer.byteLength(JSON.stringify({ kind: 'request', id: 1, tool: 'moe.add_comment', args: { content: '' } }));
  const sized = (id, bytes) => call(id, 'moe.add_comment', { content: 'é'.repeat((bytes - base) >> 1) + 'x'.repeat((bytes - base) & 1) });
  const sizes = frames => frames.map(f => [f.id, Buffer.byteLength(JSON.stringify(f))]);
  let [peer, shim] = await relay({ setup: 'm.MAX_GUEST_FRAME_BYTES = 200\nm.MAX_REQUEST_ID = 2' });
  shim.send(sized('a', 200), sized('b', 201), sized('c', 80), sized('d', 80));
  await until(() => peer.frames.length === 2 && shim.lines.length === 2, 'limit');
  assert.deepEqual(sizes(peer.frames), [[1, 200], [2, 80]]);
  assert.deepEqual(await shim.end(), [fail('TOO_LARGE', 'b'), fail('UNAVAILABLE', 'd')]);
  [peer, shim] = await relay();
  shim.send(...Array.from({ length: 9 }, (_, at) => heartbeat(at + 1)));
  await until(() => peer.frames.length === 8 && shim.lines.length === 1, 'eight in flight');
  peer.conns[0].sock.write(response(4, { ok: true, result: { n: 4 } }));
  await shim.wait(2);
  shim.send(heartbeat(10));
  await until(() => peer.frames.length === 9, 'a freed slot');
  assert.deepEqual(peer.frames.map(f => f.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await shim.end(), [fail('BUSY', 9), ok(4, { n: 4 })]);
  // A peer that stops reading never blocks the shim: frames wait in its outbox while stdin is still served. A frame
  // stays a little under the guest limit, because its stdin line carries a larger envelope than the frame does.
  [peer, shim] = await relay();
  shim.send(heartbeat(1));
  await until(() => peer.frames.length === 1, 'connected');
  peer.conns[0].sock.pause();
  const near = MAX_GUEST_FRAME_BYTES - 256;
  shim.send(sized(2, near), sized(3, near), rpc('p', 'ping'));
  await shim.wait(1);
  assert.equal(peer.frames.length, 1);
  peer.conns[0].sock.resume();
  await until(() => peer.frames.length === 3, 'drained');
  assert.deepEqual(sizes(peer.frames.slice(1)), [[2, near], [3, near]]);
  assert.deepEqual(await shim.end(), [ok('p', {})]);
  [peer, shim] = await relay({ timeout: '0.3' });
  shim.send(heartbeat(1));
  await shim.wait(1);
  peer.conns[0].sock.write(response(1, { ok: true, result: { late: true } }));
  shim.send(heartbeat(2));
  await until(() => peer.frames.length === 2, 'second frame');
  peer.conns[0].sock.write(response(2, { ok: true, result: { n: 2 } }));
  await shim.wait(2);
  assert.deepEqual(await shim.end(), [fail('TIMEOUT', 1), ok(2, { n: 2 })]);
  assert.deepEqual([peer.conns.length, peer.errors], [1, []]);
});

test('SH7 an absent bridge, a closed connection or a bad host frame fails pending calls, and the next call reconnects', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const bound = 'import socket\nlone = socket.socket(socket.AF_UNIX)\nlone.bind(sys.argv[3])';
  for (const [socket, setup] of [[join(scratch(), 'missing.sock'), ''], [join(scratch(), 'bound.sock'), bound]]) {
    const started = Date.now();
    assert.deepEqual(await exchange([heartbeat(1), heartbeat(2)], { socket, setup }), [fail('UNAVAILABLE', 1), fail('UNAVAILABLE', 2)]);
    assert.ok(Date.now() - started < 5_000, socket);
  }
  const header = length => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(length); return bytes; };
  const bad = [
    () => response(true, { ok: true, result: {} }), 'close', header(0), header(MAX_HOST_FRAME_BYTES + 1), id => response(id + 50, { ok: true, result: {} }), () => response(0, { ok: true, result: {} }),
    id => response(id, { ok: true, result: {}, extra: 1 }), id => response(id, { ok: true, error: { code: 'X' } }),
    id => response(id, { ok: 'true', result: {} }), id => response(id, { ok: true }), id => response(id, { ok: false, error: { code: 'bridge_busy' } }),
    id => response(id, { ok: false, error: { code: 5 } }), id => response(id, { ok: false, error: { code: 'X', why: 'y' } }), id => response(id, { ok: false, error: { code: 'BRIDGE_BUSY x' } }),
    id => response(id, { ok: true, result: [1] }), id => encodeFrame({ kind: 'request', id, ok: true, result: {} }, MAX_HOST_FRAME_BYTES),
    Buffer.concat([header(3), Buffer.from([0x7b, 0xff, 0x7d])]), Buffer.concat([header(5), Buffer.from('{"a":')]),
  ];
  const [peer, shim] = await relay();
  for (const [at, answer] of bad.entries()) {
    shim.send(heartbeat(`c${at}`));
    await until(() => peer.conns[at]?.frames.length === 1, `connection ${at}`);
    const conn = peer.conns[at];
    if (answer === 'close') conn.sock.end();
    else conn.sock.write(typeof answer === 'function' ? answer(conn.frames[0].id) : answer);
    await shim.wait(at + 1);
    assert.deepEqual(shim.lines[at], fail('UNAVAILABLE', `c${at}`), String(at));
    await until(() => conn.closed, `closed ${at}`);
  }
  shim.send(heartbeat('last'));
  await until(() => peer.conns[bad.length]?.frames.length === 1, 'reconnected');
  peer.conns[bad.length].sock.write(response(bad.length + 1, { ok: true, result: { n: 1 } }));
  await shim.wait(bad.length + 1);
  assert.deepEqual((await shim.end()).at(-1), ok('last', { n: 1 }));
  assert.deepEqual(peer.conns.map(conn => conn.frames[0].id), [...bad.keys(), bad.length].map(at => at + 1));
  // A host result the encoder refuses becomes UNAVAILABLE rather than an exception out of serve().
  const run = spawnSync('python3', ['-I', '-B', '-c', `${LOAD}m._Shim({}, '/nonexistent', 1, 0, 1).emit(m._reply(7, {'x': [float('nan')]}))`, SHIM]);
  assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, fail('UNAVAILABLE', 7)], String(run.stderr));
});

const STATIC = `import ast, json, sys
nodes = list(ast.walk(ast.parse(open(sys.argv[1], 'rb').read())))
roots = {alias.name.split('.')[0] for n in nodes if isinstance(n, ast.Import) for alias in n.names}
roots |= {'.' if n.level else n.module.split('.')[0] for n in nodes if isinstance(n, ast.ImportFrom)}
names = [getattr(n, 'attr', getattr(n, 'id', None)) for n in nodes if isinstance(n, (ast.Attribute, ast.Name))]
print(json.dumps({
    'outside': sorted(roots - set(sys.stdlib_module_names)),
    'socket': sorted({n.attr for n in nodes if isinstance(n, ast.Attribute) and getattr(n.value, 'id', '') == 'socket'}),
    'env': [name for name in names if name in ('environ', 'environb', 'getenv', 'getenvb', 'putenv', 'unsetenv')],
    'reads': [ast.unparse(n) for n in nodes if isinstance(n, ast.Call) and ast.unparse(n.func) == 'os.environ.get'],
}))
`;
// main() with every socket replaced by a recorder whose connect fails as if the agent socket were absent.
const MAIN = `import socket
calls = []
class Recorder:
    def __init__(self, family, kind):
        calls.append([socket.AddressFamily(family).name, socket.SocketKind(kind).name])
    def connect(self, address):
        calls[-1].append(address)
        raise FileNotFoundError(2, 'absent')
    settimeout = close = lambda self, *rest: None
m.TOOLS_PATH, m.socket.socket = sys.argv[2], Recorder
sys.stderr.write(json.dumps([m.main(), calls]))
`;

test('SH8 the shim is stdlib-only, reads only MOE_ROLE and connects only to the fixed agent socket', { skip: NO_GUEST, timeout: 30_000 }, () => {
  const source = readFileSync(SHIM);
  assert.deepEqual([source.toString('latin1').split('\n')[0], source.includes(0x0d)], ['#!/usr/bin/python3 -I', false]);
  assert.deepEqual(JSON.parse(spawnSync('python3', ['-I', '-B', '-c', STATIC, SHIM]).stdout), {
    outside: [], socket: ['AF_UNIX', 'SOCK_STREAM', 'socket'], env: ['environ'], reads: ["os.environ.get('MOE_ROLE')"],
  });
  const env = { PATH: process.env.PATH, MOE_ROLE: 'qa', MOE_AGENT_SOCKET: '/tmp/decoy.sock', MOE_TOOLS_PATH: '/tmp/decoy.json', MOE_SOCKET: '/tmp/x' };
  const input = [rpc(1, 'tools/list'), call(2, 'moe.qa_approve', { summary: 's' })].map(m => `${JSON.stringify(m)}\n`).join('');
  const run = spawnSync('python3', ['-I', '-B', '-c', `${LOAD}${MAIN}`, SHIM, TOOLS_FILE], { env, input, timeout: 20_000 });
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(run.stdout.toString().trimEnd().split('\n').map(line => JSON.parse(line)), [ok(1, listed('qa')), fail('UNAVAILABLE', 2)]);
  assert.deepEqual(JSON.parse(run.stderr), [0, [['AF_UNIX', 'SOCK_STREAM', '/run/moe/agent.sock']]]);
});

test('SH9 buildUserData installs the repo shim and tools.json, and refuses a missing, empty or oversized asset', { timeout: 30_000 }, async () => {
  const input = { supervisor: Buffer.from('#!/bin/sh\n'), credential: Buffer.from('credential') };
  const built = buildUserData(input);
  const assets = [[GUEST_LAYOUT.shim, '0555', readFileSync(SHIM), built.shimSha256], [GUEST_LAYOUT.shimTools, '0444', readFileSync(TOOLS_FILE), built.shimToolsSha256]];
  for (const [file, mode, bytes, digest] of assets) {
    const entry = built.userData.split('\n  - path: ').find(text => text.startsWith(`${file}\n`)).split('\n');
    assert.deepEqual(entry.slice(1, 4), ['    owner: root:root', `    permissions: '${mode}'`, '    encoding: b64'], file);
    assert.deepEqual([Buffer.from(entry[4].slice("    content: '".length, -1), 'base64'), digest], [bytes, createHash('sha256').update(bytes).digest('hex')]);
  }
  for (const [at, [name, bytes]] of [['guest-mcp-shim.py'], ['guest-mcp-tools.json', ''], ['guest-mcp-shim.py', Buffer.alloc(MAX_SUPERVISOR_BYTES + 1, 35)]].entries()) {
    const dir = join(scratch(), 'local-runner');
    cpSync(RUNNER, dir, { recursive: true });
    if (bytes === undefined) rmSync(join(dir, name)); else writeFileSync(join(dir, name), bytes);
    const copy = await import(pathToFileURL(join(dir, 'guest-bootstrap.mjs')).href);
    assert.throws(() => copy.buildUserData(input), { code: 'BOOTSTRAP_ASSET_INVALID', message: 'A bundled guest asset was missing or invalid.' }, name);
    if (at === 0) assert.throws(() => copy.buildUserData({ ...input, supervisor: Buffer.alloc(0) }), { code: 'BOOTSTRAP_INPUT_INVALID' });
  }
});

// CQ-R10d2: the host's pinned agent CLI cache (rows AB1-AB11). Bodies come from an injected fetch over fixture routes,
// never the network; test manifests keep the shipped fixed URLs and swap in fixture sizes and hashes.
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fetchAgentBinary, loadAgentManifest, validateAgentManifest } from '../local-runner/agent-cache.mjs';

const SHIPPED = JSON.parse(readFileSync(join(RUNNER, 'agent-binaries.json'), 'utf8'));
const MEMBER = SHIPPED.binaries.codex.x64.member;
const CDN = 'https://cdn.fixture.test';
const AGENT_MESSAGES = {
  AGENT_BINARY_INPUT_INVALID: 'The agent binary request was invalid.',
  AGENT_BINARY_MANIFEST_INVALID: 'The installed agent binary manifest is invalid or unavailable.',
  AGENT_BINARY_DOWNLOAD_FAILED: 'The pinned agent binary could not be downloaded.',
  AGENT_BINARY_CHECKSUM_MISMATCH: 'The agent binary did not match its pinned checksum.',
  AGENT_BINARY_TOO_LARGE: 'The agent binary exceeded its pinned size.',
  AGENT_BINARY_ARCHIVE_INVALID: 'The agent binary archive was malformed.',
  AGENT_BINARY_UNREADABLE: 'The cached agent binary could not be read.',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [CLAUDE_BYTES, CODEX_BYTES] = ['claude', 'codex'].map(cli => Buffer.from(`#!fixture ${cli} binary\n`.repeat(64)));
// Incompressible and deterministic, so gunzip output chunks split the member and its neighbours irregularly.
const noise = size => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, at) => createHash('sha256').update(String(at)).digest())).subarray(0, size);
// AC5: a refusal carries only its fixed code and text, never a URL, a path or body bytes.
const refused = code => error => assert.deepEqual([error.code, error.message, Object.keys(error)], [code, AGENT_MESSAGES[code], ['code']]) ?? true;
const urlOf = (cli, arch) => SHIPPED.binaries[cli][arch].url;
const binOf = (cacheDir, bytes) => ({ file: join(cacheDir, `${sha(bytes)}.bin`), sha256: sha(bytes), size: bytes.length });

// The shipped manifest with one entry's pins replaced; its URL stays the real fixed template.
function pinned(cli, arch, pins) {
  const manifest = structuredClone(SHIPPED);
  Object.assign(manifest.binaries[cli][arch], pins);
  return manifest;
}
const claudeAt = arch => pinned('claude', arch, { sha256: sha(CLAUDE_BYTES), size: CLAUDE_BYTES.length });
const codexAt = (archive, member = CODEX_BYTES) => pinned('codex', 'x64', { sha256: sha(archive), size: archive.length, memberSha256: sha(member), memberSize: member.length });

// A minimal ustar writer for fixture archives; entries are [name, bytes, typeflag, linkname].
function tar(entries) {
  return Buffer.concat([...entries.flatMap(([name, bytes = Buffer.alloc(0), type = '0', link = '']) => {
    const header = Buffer.alloc(512);
    for (const [at, text] of [[0, name], [100, '0000644'], [124, bytes.length.toString(8).padStart(11, '0')], [148, ' '.repeat(8)],
      [156, type], [157, link], [257, 'ustar\x0000']]) header.write(text, at, 'latin1');
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0`, 148, 'latin1');
    return [header, bytes, Buffer.alloc(-bytes.length & 511)];
  }), Buffer.alloc(1024)]);
}
const DECOY = ['README.md', Buffer.from('decoy entry\n')];
const ARCHIVE = gzipSync(tar([DECOY, [MEMBER, CODEX_BYTES]]));

// An injected fetch over fixture routes: url -> [status, body chunks (an Error chunk fails the stream) or a thrown Error,
// headers, the response's final url (as if the fetch had followed redirects itself)].
function routes(table) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url, init.redirect, init.signal instanceof AbortSignal]);
    const [status = 404, chunks = [], headers = {}, final = url] = table[url] ?? [];
    if (chunks instanceof Error) throw chunks;
    const queue = [...chunks];
    const body = new ReadableStream({ pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close(); else if (next instanceof Error) controller.error(next); else controller.enqueue(new Uint8Array(next));
    } }, { highWaterMark: 0 });
    return { ok: status >= 200 && status < 300, status, url: final, headers: new Headers(headers), body };
  };
  return { fetch, calls };
}
// url -> CDN/hop/1 -> ... -> CDN/hop/count, which serves chunks; every Location after the first is relative.
function redirected(url, count, chunks) {
  const stops = [url, ...Array.from({ length: count }, (_, at) => `${CDN}/hop/${at + 1}`)];
  return Object.fromEntries(stops.map((stop, at) => [stop, at === count ? [200, chunks] : [302, [], { location: at ? `/hop/${at + 1}` : stops[1] }]]));
}
function request(cli, arch, manifest, table, cacheDir = join(scratch(), 'agent cache')) {
  const server = routes(table);
  return { server, cacheDir, result: fetchAgentBinary({ cli, arch, cacheDir }, { fetch: server.fetch, manifest }) };
}

test('AB1 the shipped manifest loads deep-frozen, with every cli and arch at its fixed https template', async () => {
  const manifest = await loadAgentManifest();
  assert.deepEqual([manifest, Object.isFrozen(manifest.binaries.codex.arm64)], [SHIPPED, true]);
  for (const [arch, triple] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const [claude, codex] = [manifest.binaries.claude[arch], manifest.binaries.codex[arch]];
    assert.equal(claude.url, `https://downloads.claude.ai/claude-code-releases/${claude.version}/linux-${arch}/claude`);
    assert.equal(codex.url, `https://github.com/openai/codex/releases/download/rust-v${codex.version}/codex-${triple}-unknown-linux-musl.tar.gz`);
    assert.deepEqual([codex.archive, codex.member, 'archive' in claude], ['tar.gz', `codex-${triple}-unknown-linux-musl`, false]);
  }
});

test('AB2 validateAgentManifest refuses every off-shape manifest, also through the fetch seam', async () => {
  const version = (cli, bad) => m => { const entry = m.binaries[cli].x64; entry.url = entry.url.replace(entry.version, bad); entry.version = bad; };
  const set = (cli, key, value) => m => { m.binaries[cli].x64[key] = value; };
  for (const [label, change] of [
    ['not an object', () => []], ['schemaVersion 2', m => { m.schemaVersion = 2; }], ['an extra top-level key', m => { m.mirror = CDN; }],
    ['a missing cli', m => { delete m.binaries.codex; }], ['an extra cli', m => { m.binaries.grok = m.binaries.codex; }],
    ['a missing arch', m => { delete m.binaries.claude.arm64; }], ['an extra arch', m => { m.binaries.claude.ia32 = m.binaries.claude.x64; }],
    ['an extra entry key', set('claude', 'mirror', CDN)], ['archive keys on a raw cli', m => { Object.assign(m.binaries.claude.x64, { archive: 'tar.gz', member: 'claude', memberSha256: 'a'.repeat(64), memberSize: 1 }); }],
    ['an http url', set('claude', 'url', urlOf('claude', 'x64').replace('https:', 'http:'))],
    ['another host', set('codex', 'url', urlOf('codex', 'x64').replace('github.com', 'github.com.fixture.test'))],
    ["another arch's url", set('codex', 'url', urlOf('codex', 'arm64'))],
    ['a dot-segment version', version('claude', '1.0.0/..')], ['a prerelease version', version('codex', '0.166.0-alpha.1')],
    ['an uppercase sha256', set('claude', 'sha256', SHIPPED.binaries.claude.x64.sha256.toUpperCase())], ['a short sha256', set('claude', 'sha256', 'a'.repeat(63))],
    ['a zero size', set('claude', 'size', 0)], ['a fractional size', set('claude', 'size', 1.5)], ['a string size', set('claude', 'size', '1')],
    ['a size over 1 GiB', set('claude', 'size', 2 ** 30 + 1)], ['a zip archive', set('codex', 'archive', 'zip')],
    ...['member', 'memberSha256', 'memberSize'].map(key => [`an archive entry without ${key}`, m => { delete m.binaries.codex.x64[key]; }]),
    ['a non-hex memberSha256', set('codex', 'memberSha256', 'g'.repeat(64))], ['a zero memberSize', set('codex', 'memberSize', 0)],
    ...['/codex', '../codex', 'bin/../codex', 'bin\\codex', './codex', 'bin//codex', ''].map(member => [`member ${JSON.stringify(member)}`, set('codex', 'member', member)]),
  ]) {
    const manifest = structuredClone(SHIPPED);
    assert.throws(() => validateAgentManifest(change(manifest) ?? manifest), refused('AGENT_BINARY_MANIFEST_INVALID'), label);
  }
  const seam = request('claude', 'x64', pinned('claude', 'x64', { url: urlOf('claude', 'x64').replace('https:', 'http:') }), {});
  await assert.rejects(seam.result, refused('AGENT_BINARY_MANIFEST_INVALID'));
  assert.deepEqual(seam.server.calls, []);
});

test('AB3 loadAgentManifest reads only its module-relative file, at most 64 KiB of valid JSON', async () => {
  const dir = join(scratch(), 'local-runner');
  cpSync(RUNNER, dir, { recursive: true });
  const copy = await import(pathToFileURL(join(dir, 'agent-cache.mjs')).href);
  const text = JSON.stringify(SHIPPED);
  for (const [label, bytes, loads] of [['exactly 64 KiB', text.padEnd(65_536), true], ['64 KiB + 1', text.padEnd(65_537)], ['not JSON', 'pinned: no'], ['missing']]) {
    if (bytes === undefined) rmSync(join(dir, 'agent-binaries.json')); else writeFileSync(join(dir, 'agent-binaries.json'), bytes);
    if (loads) assert.deepEqual(await copy.loadAgentManifest(), SHIPPED, label);
    else await assert.rejects(copy.loadAgentManifest(), refused('AGENT_BINARY_MANIFEST_INVALID'), label);
  }
});

test('AB4 a body matching its pins is kept at <cacheDir>/<sha256>.bin, after at most 5 https-only manual redirects', async () => {
  for (const [arch, hops, chunks] of [['x64', 0, [CLAUDE_BYTES]], ['arm64', 5, [CLAUDE_BYTES.subarray(0, 7), CLAUDE_BYTES.subarray(7)]]]) {
    const table = redirected(urlOf('claude', arch), hops, chunks);
    const { server, cacheDir, result } = request('claude', arch, claudeAt(arch), table);
    const bin = binOf(cacheDir, CLAUDE_BYTES);
    assert.deepEqual([await result, Object.isFrozen(await result)], [bin, true]);
    assert.deepEqual(server.calls, Object.keys(table).map(url => [url, 'manual', true]));
    assert.deepEqual([readdirSync(cacheDir), readFileSync(bin.file)], [[`${bin.sha256}.bin`], CLAUDE_BYTES]);
    if (process.platform !== 'win32') assert.deepEqual([statSync(bin.file).mode & 0o777, statSync(cacheDir).mode & 0o777], [0o600, 0o700]);
  }
});

test('AB5 a mismatched, oversized, redirected-to-http or interrupted download fails closed and leaves no file', async () => {
  const url = urlOf('claude', 'x64');
  const http = url.replace('https:', 'http:');
  const flipped = Buffer.from(CLAUDE_BYTES);
  flipped[9] ^= 1;
  for (const [label, table, code] of [
    ['bytes missing the sha256', { [url]: [200, [flipped]] }, 'AGENT_BINARY_CHECKSUM_MISMATCH'],
    ['a short body', { [url]: [200, [CLAUDE_BYTES.subarray(1)]] }, 'AGENT_BINARY_CHECKSUM_MISMATCH'],
    ['a declared length over the pin', { [url]: [200, [CLAUDE_BYTES], { 'content-length': String(CLAUDE_BYTES.length + 1) }] }, 'AGENT_BINARY_TOO_LARGE'],
    ['a streamed body over the pin', { [url]: [200, [CLAUDE_BYTES, Buffer.from('x')]] }, 'AGENT_BINARY_TOO_LARGE'],
    ['a redirect to http', { [url]: [301, [], { location: http }], [http]: [200, [CLAUDE_BYTES]] }, 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a fetch that followed to http on its own', { [url]: [200, [CLAUDE_BYTES], {}, http] }, 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a redirect chain over 5', redirected(url, 6, [CLAUDE_BYTES]), 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a redirect without a Location', { [url]: [302, []] }, 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a non-2xx status', {}, 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a rejected request', { [url]: [200, Object.assign(new Error(`${url} secret`), { code: 'ECONNRESET' })] }, 'AGENT_BINARY_DOWNLOAD_FAILED'],
    ['a body that errors midway', { [url]: [200, [CLAUDE_BYTES.subarray(0, 9), new Error(`${url} secret`)]] }, 'AGENT_BINARY_DOWNLOAD_FAILED'],
  ]) {
    const { server, cacheDir, result } = request('claude', 'x64', claudeAt('x64'), table);
    await assert.rejects(result, refused(code), label);
    assert.deepEqual(readdirSync(cacheDir), [], label);
    assert.deepEqual(server.calls.filter(([target]) => !target.startsWith('https://')), [], label);
  }
});

// The timeouts turn a stalled pipeline (bytes left unread after the end-of-archive block) into a failure.
test('AB6 only the pinned regular member of a verified tar.gz is extracted, verified and kept', { timeout: 30_000 }, async () => {
  // The third archive has 150 KB past its end-of-archive block, spanning read chunks: drained, never parsed.
  for (const [decoy, member, type, trailer = Buffer.alloc(0)] of [[DECOY, CODEX_BYTES, '0'], [['vendor/notes.bin', noise(70_001)], noise(200_003), '\0'],
    [DECOY, CODEX_BYTES, '0', noise(150_000)]]) {
    const archive = gzipSync(Buffer.concat([tar([decoy, [MEMBER, member, type]]), trailer]));
    const { server, cacheDir, result } = request('codex', 'x64', codexAt(archive, member), redirected(urlOf('codex', 'x64'), 1, [archive.subarray(0, 100), archive.subarray(100)]));
    const bin = binOf(cacheDir, member);
    assert.deepEqual([await result, server.calls.length], [bin, 2]);
    assert.deepEqual([readdirSync(cacheDir), readFileSync(bin.file).equals(member)], [[`${bin.sha256}.bin`], true]);
    if (process.platform !== 'win32') assert.equal(statSync(bin.file).mode & 0o777, 0o600);
  }
});

test('AB7 a bad archive or member fails closed and leaves no file', { timeout: 30_000 }, async () => {
  const at = (bytes, type, link) => [MEMBER, bytes, type, link];
  const raw = tar([DECOY, at(CODEX_BYTES)]);
  const corrupt = Buffer.from(raw);
  corrupt[136] ^= 1; // an mtime byte: the first header's checksum no longer adds up
  const [flipped, gz] = [Buffer.from(CODEX_BYTES), gzipSync(raw)];
  const badCrc = gzipSync(Buffer.concat([raw, noise(150_000)]));
  flipped[9] ^= 1;
  badCrc[badCrc.length - 8] ^= 1; // the tar decodes in full; gunzip's trailer check fails chunks after the end-of-archive block
  for (const [label, archive, code, pins = {}] of [
    ['archive bytes missing their sha256, before any parsing', Buffer.from('not gzip'), 'AGENT_BINARY_CHECKSUM_MISMATCH', { sha256: sha(ARCHIVE) }],
    ['member bytes missing memberSha256', gzipSync(tar([at(flipped)])), 'AGENT_BINARY_CHECKSUM_MISMATCH'],
    ['a short member', gzipSync(tar([at(CODEX_BYTES.subarray(1))])), 'AGENT_BINARY_CHECKSUM_MISMATCH'],
    ['a member over memberSize', gzipSync(tar([at(Buffer.concat([CODEX_BYTES, Buffer.from('x')]))])), 'AGENT_BINARY_TOO_LARGE'],
    ['a decoy past the decompression bound', gzipSync(tar([['pad', Buffer.alloc(2 ** 20 + 1)], at(CODEX_BYTES)])), 'AGENT_BINARY_TOO_LARGE'],
    ['no member', gzipSync(tar([DECOY])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['the member under another path', gzipSync(tar([[`./${MEMBER}`, CODEX_BYTES]])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a symlink at the member path', gzipSync(tar([at(undefined, '2', '/usr/bin/evil')])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a symlink, then a regular file, at the member path', gzipSync(tar([at(undefined, '2', '/usr/bin/evil'), at(CODEX_BYTES)])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a hard link at the member path', gzipSync(tar([at(undefined, '1', DECOY[0])])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a directory at the member path', gzipSync(tar([at(undefined, '5')])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a duplicate member', gzipSync(tar([at(CODEX_BYTES), at(CODEX_BYTES)])), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a corrupt header checksum', gzipSync(corrupt), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a truncated gzip', gz.subarray(0, gz.length - 12), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a gzip with a bad CRC', badCrc, 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a tar cut inside the member', gzipSync(raw.subarray(0, 1536)), 'AGENT_BINARY_ARCHIVE_INVALID'],
    ['a plain tar', raw, 'AGENT_BINARY_ARCHIVE_INVALID'],
  ]) {
    const { cacheDir, result } = request('codex', 'x64', pinned('codex', 'x64', { ...codexAt(archive).binaries.codex.x64, ...pins }), { [urlOf('codex', 'x64')]: [200, [archive]] });
    await assert.rejects(result, refused(code), label);
    assert.deepEqual(readdirSync(cacheDir), [], label);
  }
});

test('AB8 a cache hit is re-verified without a fetch; a corrupt entry is removed and fetched exactly once', async () => {
  const cacheDir = join(scratch(), 'agent cache');
  const [bin, url] = [binOf(cacheDir, CLAUDE_BYTES), urlOf('claude', 'x64')];
  const get = (body = CLAUDE_BYTES) => request('claude', 'x64', claudeAt('x64'), { [url]: [200, [body]] }, cacheDir);
  mkdirSync(cacheDir);
  writeFileSync(bin.file, CLAUDE_BYTES);
  const hit = get();
  assert.deepEqual([await hit.result, hit.server.calls.length], [bin, 0]);
  const flipped = Buffer.from(CLAUDE_BYTES);
  flipped[9] ^= 1;
  for (const corrupt of [flipped, CLAUDE_BYTES.subarray(1), Buffer.concat([CLAUDE_BYTES, Buffer.from('x')])]) {
    writeFileSync(bin.file, corrupt);
    const repair = get();
    assert.deepEqual([await repair.result, repair.server.calls.length, readFileSync(bin.file), readdirSync(cacheDir)], [bin, 1, CLAUDE_BYTES, [`${bin.sha256}.bin`]]);
  }
  writeFileSync(bin.file, flipped);
  const tampered = get(flipped);
  await assert.rejects(tampered.result, refused('AGENT_BINARY_CHECKSUM_MISMATCH'));
  assert.deepEqual([tampered.server.calls.length, readdirSync(cacheDir)], [1, []]);
  // An archived cli is keyed by its member: a cached member hits without fetching the archive.
  writeFileSync(binOf(cacheDir, CODEX_BYTES).file, CODEX_BYTES);
  const member = request('codex', 'x64', codexAt(ARCHIVE), {}, cacheDir);
  assert.deepEqual([await member.result, member.server.calls.length], [binOf(cacheDir, CODEX_BYTES), 0]);
});

test('AB9 a cached directory or symlink is refused, never followed or deleted, and nothing is fetched', async () => {
  const cacheDir = join(scratch(), 'agent cache');
  const { file } = binOf(cacheDir, CLAUDE_BYTES);
  mkdirSync(file, { recursive: true });
  const dir = request('claude', 'x64', claudeAt('x64'), {}, cacheDir);
  await assert.rejects(dir.result, refused('AGENT_BINARY_INPUT_INVALID'));
  assert.deepEqual([dir.server.calls.length, statSync(file).isDirectory()], [0, true]);
  if (process.platform === 'win32') return;
  rmSync(file, { recursive: true });
  const outside = join(cacheDir, '..', 'outside.bin');
  writeFileSync(outside, CLAUDE_BYTES);
  symlinkSync(outside, file);
  const link = request('claude', 'x64', claudeAt('x64'), {}, cacheDir);
  await assert.rejects(link.result, refused('AGENT_BINARY_INPUT_INVALID'));
  assert.deepEqual([link.server.calls.length, lstatSync(file).isSymbolicLink(), readFileSync(outside)], [0, true, CLAUDE_BYTES]);
});

test('AB10 concurrent calls both resolve the verified file and leave no .part', async () => {
  const cacheDir = join(scratch(), 'agent cache');
  const table = { [urlOf('claude', 'x64')]: [200, [CLAUDE_BYTES.subarray(0, 50), CLAUDE_BYTES.subarray(50)]] };
  const calls = [1, 2].map(() => request('claude', 'x64', claudeAt('x64'), table, cacheDir));
  const bin = binOf(cacheDir, CLAUDE_BYTES);
  assert.deepEqual(await Promise.all(calls.map(call => call.result)), [bin, bin]);
  assert.deepEqual([readdirSync(cacheDir), readFileSync(bin.file), calls.map(call => call.server.calls.length)], [[`${bin.sha256}.bin`], CLAUDE_BYTES, [1, 1]]);
});

test('AB11 invalid requests are refused before any fetch or cache write', async () => {
  const cacheDir = join(scratch(), 'agent cache');
  const server = routes({});
  const valid = { cli: 'claude', arch: 'x64', cacheDir };
  for (const [input, options] of [
    [{ ...valid, cli: 'grok' }, {}], [{ ...valid, cli: 'constructor' }, {}], [{ ...valid, arch: 'ia32' }, {}], [{ ...valid, cacheDir: 'relative cache' }, {}],
    [{ ...valid, cacheDir: `${cacheDir}\n` }, {}], [undefined, {}], [valid, { fetch: urlOf('claude', 'x64') }],
  ]) await assert.rejects(fetchAgentBinary(input, { fetch: server.fetch, ...options }), refused('AGENT_BINARY_INPUT_INVALID'), JSON.stringify([input, options]));
  assert.deepEqual([server.calls, existsSync(cacheDir)], [[], false]);
});

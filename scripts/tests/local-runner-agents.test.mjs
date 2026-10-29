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
    '{', '[]', '{"worker":[]}', '{"worker":{"moe.Get":[]}}', '{"worker":{"get_context":[]}}', '{"worker":{"moe.x":"view"}}',
    '{"worker":{"moe.x":["a","a"]}}', '{"worker":{"moe.x":["1a"]}}', '{"worker":{"moe.x":[1]}}', '{"worker":{"moe.x":[]},"n":NaN}',
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
    'close', header(0), header(MAX_HOST_FRAME_BYTES + 1), id => response(id + 50, { ok: true, result: {} }), () => response(0, { ok: true, result: {} }),
    id => response(id, { ok: true, result: {}, extra: 1 }), id => response(id, { ok: true, error: { code: 'X' } }),
    id => response(id, { ok: 'true', result: {} }), id => response(id, { ok: true }), id => response(id, { ok: false, error: { code: 'bridge_busy' } }),
    id => response(id, { ok: false, error: { code: 5 } }), id => response(id, { ok: false, error: { code: 'X', why: 'y' } }),
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

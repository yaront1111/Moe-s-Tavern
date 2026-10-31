import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  AGENT_JOBS, MAX_GUEST_FRAME_BYTES, MAX_HOST_FRAME_BYTES, bridgeArgv, createFrameDecoder, encodeFrame, jobFrame as hostJobFrame, parseGuestFrame,
  scopeRequest, TOOLS,
} from '../local-runner/guest-bridge.mjs';
import { GUEST_LAYOUT, JOB_IDENTITIES } from '../local-runner/guest-bootstrap.mjs';
import {
  MAX_ARGUMENT_DEPTH, MAX_DAEMON_INFO_BYTES, MAX_PENDING_REQUESTS, MAX_RESPONSE_BYTES, endAgentJobs, runGuestSession,
} from '../local-runner/guest-session.mjs';
import { ownedInstanceName, QUERY_TIMEOUT_MS } from '../local-runner/lifecycle.mjs';
import { AGENT_CLIS } from '../local-runner/agent-cache.mjs';

// The H section's project and daemon: a fake /health reporting its loopback bind for PROJECT (::1 best-effort; 0 where it
// cannot bind). It is awaited before any test is registered: awaited after them, rows that all finish meanwhile (every
// POSIX-only row skips on Windows) let the root's after() remove PROJECT mid-load.
const PROJECT = mkdtempSync(join(tmpdir(), 'moe-r08-'));
const DAEMON_DIR = join(PROJECT, '.moe');
mkdirSync(DAEMON_DIR);
after(() => rmSync(PROJECT, { recursive: true, force: true }));
const healthOn = host => new Promise(resolve => {
  const server = createServer((req, res) => res.end(JSON.stringify({ status: 'healthy', projectPath: PROJECT, bindHost: host })));
  server.once('error', () => resolve(0)).listen(0, host, () => { after(() => { server.closeAllConnections(); server.close(); }); resolve(server.address().port); });
});
const [HEALTH_PORT, HEALTH_V6_PORT] = [await healthOn('127.0.0.1'), await healthOn('::1')];

const refuses = (fn, expected, label) => assert.throws(fn, error => error?.code === expected, label);
const header = length => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(length); return bytes; };
const framed = body => Buffer.concat([header(body.length), Buffer.from(body)]);
const decodeAll = chunks => {
  const decoder = createFrameDecoder();
  const frames = chunks.flatMap(chunk => decoder.push(chunk));
  decoder.end();
  return frames;
};
const FRAMES = [
  { kind: 'hello', protocol: 1 },
  { kind: 'request', id: 7, tool: 'moe.add_comment', args: { content: 'café \u{1F600}' } },
  { kind: 'output', stream: 'stdout', data: Buffer.from('hi\n').toString('base64') },
];

test('B1 frames round-trip whole, byte by byte and split at every byte offset', () => {
  const wire = Buffer.concat(FRAMES.map(frame => encodeFrame(frame)));
  assert.deepEqual(decodeAll([wire]), FRAMES);
  assert.deepEqual(decodeAll([...wire].map(byte => Uint8Array.of(byte))), FRAMES);
  for (let at = 0; at <= wire.length; at += 1) assert.deepEqual(decodeAll([wire.subarray(0, at), wire.subarray(at)]), FRAMES, `${at}`);
});

test('B2 the length header is bounded before any body byte is buffered', () => {
  assert.equal(MAX_GUEST_FRAME_BYTES, 262_144);
  assert.equal(MAX_HOST_FRAME_BYTES, 4_194_304);
  const fill = 'x'.repeat(MAX_GUEST_FRAME_BYTES - 8);
  assert.deepEqual(createFrameDecoder().push(framed(`{"a":"${fill}"}`)), [{ a: fill }]);
  for (const length of [0, MAX_GUEST_FRAME_BYTES + 1, 0xffffffff]) {
    refuses(() => createFrameDecoder().push(header(length)), 'BRIDGE_FRAME_INVALID', String(length));
  }
  assert.deepEqual(createFrameDecoder(16).push(framed('{"a":"xxxxxxxx"}')), [{ a: 'xxxxxxxx' }]);
  refuses(() => createFrameDecoder(16).push(header(17)), 'BRIDGE_FRAME_INVALID');
  assert.deepEqual(createFrameDecoder(MAX_HOST_FRAME_BYTES).push(header(MAX_HOST_FRAME_BYTES)), []);
  for (const bad of [0, -1, 1.5, '16', MAX_HOST_FRAME_BYTES + 1]) refuses(() => createFrameDecoder(bad), 'BRIDGE_INPUT_INVALID', String(bad));
  for (const chunk of ['{}', [1], null]) refuses(() => createFrameDecoder().push(chunk), 'BRIDGE_INPUT_INVALID', String(chunk));
});

test('B3 invalid UTF-8, a BOM and non-object JSON bodies are refused', () => {
  const inString = bytes => [...Buffer.from('{"a":"'), ...bytes, ...Buffer.from('"}')];
  const bodies = [[0xff], [0xc0, 0xaf], inString([0xff]), inString([0xc0, 0xaf]), inString([0xed, 0xa0, 0x80]), [0xef, 0xbb, 0xbf, 0x7b, 0x7d],
    ...['[]', 'null', '1', '"x"', 'true', '{'].map(text => [...Buffer.from(text)])];
  for (const body of bodies) refuses(() => createFrameDecoder().push(framed(body)), 'BRIDGE_FRAME_INVALID', String(body));
});

test('B4 end refuses a partial header or body and passes when nothing is buffered', () => {
  const partialHeader = createFrameDecoder();
  assert.deepEqual(partialHeader.push(header(5).subarray(0, 2)), []);
  refuses(() => partialHeader.end(), 'BRIDGE_FRAME_INVALID');
  const partialBody = createFrameDecoder();
  assert.deepEqual(partialBody.push(framed('{"a":1}').subarray(0, 7)), []);
  refuses(() => partialBody.end(), 'BRIDGE_FRAME_INVALID');
  const headerOnly = createFrameDecoder();
  assert.deepEqual(headerOnly.push(header(7)), []);
  refuses(() => headerOnly.end(), 'BRIDGE_FRAME_INVALID');
  assert.equal(createFrameDecoder().end(), undefined);
});

test('B5 a decoder stays poisoned after its first error', () => {
  for (const [bad, first] of [[header(0), 'BRIDGE_FRAME_INVALID'], [framed('{'), 'BRIDGE_FRAME_INVALID'], ['x', 'BRIDGE_INPUT_INVALID']]) {
    const decoder = createFrameDecoder();
    refuses(() => decoder.push(bad), first);
    refuses(() => decoder.push(encodeFrame({ kind: 'hello', protocol: 1 })), 'BRIDGE_FRAME_INVALID');
    refuses(() => decoder.end(), 'BRIDGE_FRAME_INVALID');
  }
});

test('B6 encodeFrame writes a big-endian length and refuses non-objects and oversize bodies', () => {
  assert.deepEqual(encodeFrame({}), Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]));
  const value = { kind: 'response', id: 3, ok: true, result: { text: 'é' } };
  assert.deepEqual(createFrameDecoder(MAX_HOST_FRAME_BYTES).push(encodeFrame(value)), [value]);
  assert.equal(encodeFrame({ a: 'xxxxxxxx' }, 16).length, 20);
  for (const bad of [[], null, 'x', new Date(0), new Map([[1, 2]]), { a: 1n }, { toJSON: () => [1] }]) refuses(() => encodeFrame(bad), 'BRIDGE_FRAME_INVALID', String(bad));
  refuses(() => encodeFrame({ a: 'xxxxxxxxx' }, 16), 'BRIDGE_FRAME_INVALID');
  for (const bad of [0, 1.5, MAX_HOST_FRAME_BYTES + 1]) refuses(() => encodeFrame({}, bad), 'BRIDGE_INPUT_INVALID', String(bad));
});

const HELLO = { kind: 'hello', protocol: 1 };
const REQUEST = { kind: 'request', id: 1, tool: 'moe.get_context', args: {} };
const OUTPUT = { kind: 'output', stream: 'stdout', data: 'QQ==' };
const EXIT = { kind: 'observation', type: 'exit', code: 0, signal: null };

test('B7 parseGuestFrame accepts exactly the four guest shapes and returns frozen copies', () => {
  const valid = [HELLO, { ...REQUEST, id: 2_147_483_647, tool: 'moe.complete_step', args: { stepId: 's' } },
    { ...EXIT, code: 255 }, { ...EXIT, code: null, signal: 'SIGKILL' }];
  for (const frame of valid) {
    const parsed = parseGuestFrame(frame);
    assert.deepEqual(parsed, frame);
    assert.ok(Object.isFrozen(parsed));
  }
  const smuggled = encodeFrame(EXIT);
  const output = parseGuestFrame({ ...OUTPUT, stream: 'stderr', data: smuggled.toString('base64') });
  assert.deepEqual(output, { kind: 'output', stream: 'stderr', data: smuggled });
  assert.ok(Buffer.isBuffer(output.data) && Object.isFrozen(output));
});

test('B8 parseGuestFrame refuses every other shape with BRIDGE_PROTOCOL_VIOLATION', () => {
  const violations = [null, [], 'hello', { kind: 'hello' }, { ...HELLO, extra: 1 }, { kind: 'connect' },
    { kind: 'response', id: 1, ok: true, result: {} }, { ...HELLO, protocol: 2 }, { ...HELLO, protocol: '1' },
    { kind: 'request', id: 1, tool: 'moe.get_context' },
    ...[0, 2_147_483_648, 1.5, '1'].map(id => ({ ...REQUEST, id })),
    ...['get_context', 'moe.GetContext', 'moe.get_context\n'].map(tool => ({ ...REQUEST, tool })),
    ...[[], null].map(args => ({ ...REQUEST, args })),
    { ...OUTPUT, stream: 'stdin' }, ...['', 'QQ', 'QR==', 'Q Q==', 7].map(data => ({ ...OUTPUT, data })),
    { ...EXIT, type: 'started' }, ...[256, -1, 1.5, '0'].map(code => ({ ...EXIT, code })),
    { ...EXIT, code: null }, { ...EXIT, signal: 'SIGKILL' }, { ...EXIT, code: null, signal: 'KILL' }];
  for (const frame of violations) refuses(() => parseGuestFrame(frame), 'BRIDGE_PROTOCOL_VIOLATION', JSON.stringify(frame));
});

const BINDING = Object.freeze({ role: 'worker', workerId: 'worker-1', taskId: 'task-abc', attemptId: 'attempt-1', generation: 2 });
const QA = Object.freeze({ ...BINDING, role: 'qa', workerId: 'qa-1' });
const req = (tool, args = {}) => parseGuestFrame({ kind: 'request', id: 9, tool, args });

test('B9 the role tool tables are exact, frozen allowlists', () => {
  const shared = { 'moe.get_context': ['view', 'commentsLimit', 'commentsMaxChars'], 'moe.add_comment': ['content'],
    'moe.get_handoff_history': [], 'moe.heartbeat': ['presenceKind'] };
  const pinned = {
    worker: { ...shared, 'moe.start_step': ['stepId'], 'moe.complete_step': ['stepId', 'modifiedFiles', 'note'],
      'moe.complete_task': ['verification', 'summary'],
      'moe.report_blocked': ['reason', 'needsFrom', 'currentStepId', 'blockedOnTaskIds'] },
    qa: { ...shared, 'moe.qa_approve': ['summary', 'candidateId'],
      'moe.qa_reject': ['reason', 'failedDodItems', 'issues', 'candidateId'] },
  };
  assert.deepEqual(Object.keys(TOOLS), ['worker', 'qa']);
  for (const [role, tools] of Object.entries(TOOLS)) {
    assert.deepEqual(Object.fromEntries(Object.entries(tools).map(([name, entry]) => [name, entry.args])), pinned[role]);
    assert.ok(Object.isFrozen(TOOLS) && Object.isFrozen(tools));
    for (const entry of Object.values(tools)) assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.args));
  }
});

test('B10 every table entry forwards guest args with identity stamped only where the daemon schema has it', () => {
  for (const binding of [BINDING, QA]) {
    for (const name of Object.keys(TOOLS[binding.role])) {
      const expected = { ...(name === 'moe.heartbeat' ? {} : { taskId: binding.taskId }),
        ...(name === 'moe.get_handoff_history' ? {} : { workerId: binding.workerId }) };
      const scoped = scopeRequest(req(name), binding);
      assert.deepEqual(scoped, { id: 9, tool: name, args: expected }, name);
      assert.ok(Object.isFrozen(scoped) && Object.isFrozen(scoped.args));
    }
  }
  const args = { stepId: 's', modifiedFiles: ['a'], note: 'n', workerId: 'worker-1', taskId: 'task-abc' };
  assert.deepEqual(scopeRequest(req('moe.complete_step', args), BINDING).args, args);
  assert.deepEqual(scopeRequest(req('moe.get_handoff_history', { workerId: 'worker-1' }), BINDING).args, { taskId: 'task-abc' });
  assert.deepEqual(scopeRequest(req('moe.heartbeat', { taskId: 'task-abc', presenceKind: 'idle' }), BINDING).args,
    { presenceKind: 'idle', workerId: 'worker-1' });
});

test('B11 tools outside the binding role table are BRIDGE_TOOL_DENIED', () => {
  const denied = ['moe.set_task_dependencies', 'moe.set_task_status', 'moe.update_epic', 'moe.propose_rail',
    'moe.claim_next_task', 'moe.submit_plan', 'moe.record_check_run', 'moe.constructor', 'moe.qa_approve', 'moe.qa_reject'];
  for (const tool of denied) refuses(() => scopeRequest(req(tool), BINDING), 'BRIDGE_TOOL_DENIED', tool);
  refuses(() => scopeRequest(req('moe.qa_approve', { role: 'qa' }), BINDING), 'BRIDGE_TOOL_DENIED');
  for (const tool of ['moe.complete_task', 'moe.start_step', 'moe.report_blocked']) refuses(() => scopeRequest(req(tool), QA), 'BRIDGE_TOOL_DENIED', tool);
});

test('B12 argument keys outside the tool table are BRIDGE_ARGUMENT_DENIED', () => {
  const cases = [[BINDING, 'moe.complete_task', { prLink: 'x' }], [BINDING, 'moe.complete_task', { currentBranch: 'main' }],
    [BINDING, 'moe.report_blocked', { reason: 'r', resourceId: 'r1' }], [QA, 'moe.qa_approve', { manualArtifact: {} }],
    [QA, 'moe.qa_approve', { mergedPullRequest: {} }], [BINDING, 'moe.get_context', { extra: 1 }],
    [BINDING, 'moe.get_handoff_history', { constructor: 1 }]];
  for (const [binding, tool, args] of cases) refuses(() => scopeRequest(req(tool, args), binding), 'BRIDGE_ARGUMENT_DENIED', JSON.stringify(args));
});

test('B13 identity keys from a guest are BRIDGE_IDENTITY_MISMATCH unless workerId/taskId equal the binding', () => {
  const cases = [['moe.get_context', { workerId: 'worker-2' }], ['moe.get_context', { taskId: 'task-other' }],
    ['moe.get_handoff_history', { workerId: 'worker-2' }], ['moe.heartbeat', { taskId: 'task-other' }],
    ['moe.get_context', { workerId: 1 }], ['moe.complete_task', { prLink: 'x', attemptId: 'attempt-1' }],
    ...[{ role: 'worker' }, { attemptId: 'attempt-1' }, { generation: 2 }, { processStartedAt: 'x' }, { host: 'h' }]
      .map(args => ['moe.get_context', args])];
  for (const [tool, args] of cases) refuses(() => scopeRequest(req(tool, args), BINDING), 'BRIDGE_IDENTITY_MISMATCH', JSON.stringify(args));
});

test('B14 a malformed binding is BRIDGE_INPUT_INVALID and a non-request frame is BRIDGE_PROTOCOL_VIOLATION', () => {
  const { generation, ...missing } = BINDING;
  assert.equal(generation, 2);
  const bindings = [null, missing, { ...BINDING, extra: 1 }, { ...BINDING, role: 'architect' }, { ...BINDING, role: 'governor' },
    { ...BINDING, role: ['worker'] }, { ...BINDING, taskId: 'task-a/b' }, { ...BINDING, generation: 0 },
    { ...BINDING, attemptId: 'attempt-' }, { ...BINDING, workerId: '' }, { ...BINDING, workerId: 'w\n' },
    { ...BINDING, workerId: 'w\u0085' }, { ...BINDING, workerId: 'w'.repeat(129) }];
  for (const binding of bindings) refuses(() => scopeRequest(req('moe.get_context'), binding), 'BRIDGE_INPUT_INVALID', JSON.stringify(binding));
  assert.equal(scopeRequest(req('moe.get_context'), { ...BINDING, workerId: 'w'.repeat(128) }).args.workerId.length, 128);
  for (const frame of [HELLO, parseGuestFrame(OUTPUT), { ...REQUEST, id: 0 }, { ...REQUEST, extra: 1 }, null]) {
    refuses(() => scopeRequest(frame, BINDING), 'BRIDGE_PROTOCOL_VIOLATION');
  }
});

test('B15 bridgeArgv is the one fixed supervisor command for an owned instance name only', () => {
  const name = ownedInstanceName({ random: () => Buffer.alloc(10, 0xab) });
  const argv = bridgeArgv(name);
  assert.deepEqual(argv, ['exec', '--no-map-working-directory', name, '--', 'sudo', '-n', '/opt/moe/bin/moe-supervisor', 'bridge']);
  assert.ok(Object.isFrozen(argv));
  for (const bad of ['primary', 'moe-vm-', `moe-vm-${'A'.repeat(20)}`, `moe-vm-${'a'.repeat(21)}`, `moe-vm-${'a'.repeat(19)} `,
    'moe-vm- aaaaaaaaaaaaaaaaaaa', '', undefined, 7]) {
    refuses(() => bridgeArgv(bad), 'BRIDGE_INPUT_INVALID', String(bad));
  }
});

// CQ-R08b: the real guest supervisor under the host's python3, decoded with the R08a decoder and parseGuestFrame.
const NO_GUEST = process.platform === 'win32' && 'the guest supervisor runs only in the Linux guest (POSIX python3)';
const SUPERVISOR = fileURLToPath(new URL('../local-runner/guest-supervisor.py', import.meta.url));
// -B: both IDE bundlers copy scripts/local-runner wholesale, so a __pycache__ there would ship.
const LOAD = `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('moe_supervisor', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
const harness = (code, ...args) => spawnSync('python3', ['-I', '-B', '-c', LOAD + code, SUPERVISOR, ...args],
  { maxBuffer: 64 << 20, timeout: 60_000 });
// The harness holds the write end of in_fd, the host stream, open: its EOF would be a gone host.
const RELAY = "r, w = os.pipe()\nsys.exit(m.relay(['python3', '-I', '-c', *sys.argv[2:]], in_fd=r))";
const relay = (child, ...args) => harness(RELAY, child, ...args);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const WRITE = 'import base64, os, sys\nos.write(1, base64.b64decode(sys.argv[1]))\nos.write(2, base64.b64decode(sys.argv[2]))\n';

// Every frame must decode within MAX_GUEST_FRAME_BYTES and pass parseGuestFrame: hello, output frames, one exit.
function session(run) {
  assert.equal(run.status, 0, String(run.error ?? run.stderr));
  const decoder = createFrameDecoder();
  const frames = decoder.push(run.stdout).map(parseGuestFrame);
  decoder.end();
  assert.deepEqual(frames[0], HELLO);
  const outputs = frames.slice(1, -1);
  assert.deepEqual(outputs.filter(frame => frame.kind !== 'output'), []);
  const exit = frames.at(-1);
  assert.equal(exit.kind, 'observation');
  const bytes = stream => Buffer.concat(outputs.filter(frame => frame.stream === stream).map(frame => frame.data));
  return { exit, outputs, stdout: bytes('stdout'), stderr: bytes('stderr') };
}

test('S1 child bytes shaped like frames reach the host only as byte-exact output frames', { skip: NO_GUEST }, () => {
  const out = Buffer.concat([encodeFrame(HELLO), encodeFrame(REQUEST), encodeFrame(EXIT), header(5).subarray(0, 2)]);
  const err = Buffer.concat([encodeFrame(EXIT), encodeFrame(HELLO), header(MAX_GUEST_FRAME_BYTES + 1)]);
  const { exit, stdout, stderr } = session(relay(WRITE, b64(out), b64(err)));
  assert.deepEqual(stdout, out);
  assert.deepEqual(stderr, err);
  assert.deepEqual(exit, EXIT);
});

test('S2 the exit observation comes only from waitpid', { skip: NO_GUEST }, () => {
  const forged = session(relay('import base64, os, sys\nos.write(1, base64.b64decode(sys.argv[1]))\nos._exit(7)\n', b64(encodeFrame(EXIT))));
  assert.deepEqual(forged.stdout, encodeFrame(EXIT));
  assert.deepEqual(forged.exit, { ...EXIT, code: 7 });
  const killed = session(relay('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n'));
  assert.deepEqual(killed.exit, { ...EXIT, code: null, signal: 'SIGKILL' });
  // An invoker's inherited SIGCHLD=SIG_IGN would let the kernel discard the status before waitpid reads it.
  const ignored = session(harness(`import signal\nsignal.signal(signal.SIGCHLD, signal.SIG_IGN)\n${RELAY}`, 'import os\nos._exit(7)\n'));
  assert.deepEqual(ignored.exit, { ...EXIT, code: 7 });
  const run = harness(`out = [m.exit_observation(s) for s in (7 << 8, 9, 40)]
try:
    m.exit_observation(0x137f)
except ValueError:
    out.append('ValueError')
print(json.dumps(out))`);
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(JSON.parse(run.stdout), [{ ...EXIT, code: 7 }, { ...EXIT, code: null, signal: 'SIGKILL' },
    { ...EXIT, code: null, signal: 'SIG40' }, 'ValueError']);
});

test('S3 large interleaved output is split into ordered whole frames within the guest limit', { skip: NO_GUEST }, () => {
  const counters = offset => {
    const bytes = Buffer.alloc(1 << 20);
    for (let i = 0; i < bytes.length / 4; i += 1) bytes.writeUInt32BE(offset + i, i * 4);
    return bytes;
  };
  const { exit, outputs, stdout, stderr } = session(relay(`import struct, sys
data = [b''.join(struct.pack('>I', base + i) for i in range(1 << 18)) for base in (0, 1 << 31)]
for at in range(0, 1 << 20, 3000):
    for stream, chunk in zip((sys.stdout.buffer, sys.stderr.buffer), data):
        stream.write(chunk[at:at + 3000])
        stream.flush()
`));
  assert.deepEqual(exit, EXIT);
  assert.ok(stdout.equals(counters(0)) && stderr.equals(counters(2 ** 31)));
  for (const stream of ['stdout', 'stderr']) assert.ok(outputs.filter(frame => frame.stream === stream).length > 1, stream);
  // A body of exactly the limit encodes; one byte more is refused.
  const run = harness(`def size(n):
    try:
        return len(m.encode_frame({'a': 'x' * n}))
    except ValueError:
        return 'ValueError'
print(json.dumps([m.MAX_GUEST_FRAME_BYTES, m.OUTPUT_CHUNK_BYTES, size(m.MAX_GUEST_FRAME_BYTES - 8), size(m.MAX_GUEST_FRAME_BYTES - 7)]))`);
  const [max, chunk, ...sizes] = JSON.parse(run.stdout);
  assert.deepEqual([max, ...sizes], [MAX_GUEST_FRAME_BYTES, MAX_GUEST_FRAME_BYTES + 4, 'ValueError']);
  // Pipe capacity caps real reads at 64 KiB, so only this bound catches a raised chunk size.
  assert.ok(encodeFrame({ kind: 'output', stream: 'stderr', data: b64(Buffer.alloc(chunk)) }, MAX_GUEST_FRAME_BYTES).length > chunk);
  // write_frame finishes a frame across partial writes.
  const trickle = harness("real = os.write\nos.write = lambda fd, data: real(fd, bytes(data[:3]))\nm.write_frame(1, m.exit_observation(7 << 8))");
  assert.deepEqual(trickle.stdout, encodeFrame({ ...EXIT, code: 7 }));
});

test('S4 the child gets /dev/null stdin and no inherited descriptor', { skip: NO_GUEST }, () => {
  const run = harness(`os.set_inheritable(os.dup(1), True)\n${RELAY}`, `import json, os
def held(fd):
    try:
        os.fstat(fd)
    except OSError:
        return False
    return True
print(json.dumps({'devnull': os.path.samestat(os.fstat(0), os.stat(os.devnull)), 'extra': [fd for fd in range(3, 256) if held(fd)]}))
`);
  assert.deepEqual(JSON.parse(session(run).stdout), { devnull: true, extra: [] });
});

test('S5 a child that cannot start gives EX_OSERR after hello alone, and a dead stdout gives EX_IOERR', { skip: NO_GUEST }, () => {
  const run = harness("sys.exit(m.relay(['/nonexistent/moe-child']))");
  assert.equal(run.status, 71, String(run.stderr));
  const decoder = createFrameDecoder();
  assert.deepEqual(decoder.push(run.stdout).map(parseGuestFrame), [HELLO]);
  decoder.end();
  const closed = harness("r, w = os.pipe()\nos.close(r)\nsys.exit(m.relay(['/nonexistent/moe-child'], w))");
  assert.equal(closed.status, 74, String(closed.stderr));
  assert.equal(closed.stdout.length, 0);
});

test('S6 a host that vanishes mid-stream gets EX_IOERR and the whole child process group is killed', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const child = `import os, signal, time
signal.signal(signal.SIGPIPE, signal.SIG_IGN)
grandchild = os.fork()
if grandchild == 0:
    time.sleep(60)
    os._exit(0)
os.write(1, b'%d %d\\n' % (os.getpid(), grandchild))
while True:
    try:
        os.write(1, bytes(65536))
    except OSError:
        time.sleep(60)
`;
  const proc = spawn('python3', ['-I', '-B', '-c', LOAD + RELAY, SUPERVISOR, child], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(proc, 'exit');
  const pids = [];
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  try {
    const decoder = createFrameDecoder();
    for await (const chunk of proc.stdout) {
      const output = decoder.push(chunk).map(parseGuestFrame).find(frame => frame.kind === 'output');
      if (output) {
        pids.push(...output.data.toString('latin1').split('\n')[0].split(' ').map(Number));
        break;
      }
    }
    assert.equal(pids.length, 2);
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 1), String(pids));
    assert.deepEqual(await exited, [74, null]);
    // The orphaned grandchild may briefly be an unreaped zombie of init.
    for (let waited = 0; waited < 5000 && !pids.every(gone); waited += 100) await sleep(100);
    assert.deepEqual(pids.filter(pid => !gone(pid)), []);
  } finally {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

const IMPORT_ROOTS = `import ast, json, sys
tree = ast.parse(open(sys.argv[1], 'rb').read())
roots = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        roots.update(alias.name.split('.')[0] for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
        roots.add('.' if node.level else node.module.split('.')[0])
print(json.dumps({'roots': sorted(roots), 'outside': sorted(roots - set(sys.stdlib_module_names))}))
`;

test('S7 the supervisor is an isolated stdlib-only script whose CLI accepts only bridge', { skip: NO_GUEST }, () => {
  assert.equal(readFileSync(SUPERVISOR, 'latin1').split('\n')[0], '#!/usr/bin/python3 -I');
  const { roots, outside } = JSON.parse(spawnSync('python3', ['-I', '-B', '-c', IMPORT_ROOTS, SUPERVISOR]).stdout);
  assert.ok(roots.includes('subprocess'), String(roots));
  assert.deepEqual(outside, []);
  for (const args of [[], ['relay'], ['bridge', 'x'], ['BRIDGE']]) {
    const run = spawnSync('python3', ['-I', SUPERVISOR, ...args]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0], `${args} ${run.stderr}`);
  }
  for (const [code, status] of [["['bridge'], geteuid=lambda: 0", 74], ["['relay'], geteuid=lambda: 0", 64], ["['bridge'], geteuid=lambda: 1000", 77]]) {
    const run = harness(`sys.exit(m.main(${code}))`);
    assert.deepEqual([run.status, run.stdout.length], [status, 0], `${code} ${run.stderr}`);
  }
});

test('S8 bridge mode refuses a non-root euid without writing a frame',
  { skip: NO_GUEST || (process.getuid() === 0 && 'the euid refusal needs a non-root test user') }, () => {
    const run = spawnSync('python3', ['-I', SUPERVISOR, 'bridge']);
    assert.deepEqual([run.status, run.stdout.length], [77, 0], String(run.stderr));
  });

// CQ-R08c: Node is the host on the supervisor's stdio and every agent on its socket. Linux checks the real
// SO_PEERCRED; macOS has none, so there the peer uid is injected.
const PEER = process.platform === 'linux' ? '' : ', peer_uid=lambda sock: os.getuid()';
const AGENT_CHILD = 'import os, time\nos.write(1, b"%d" % os.getpid())\ntime.sleep(600)\n';
async function until(check, label) {
  for (const end = Date.now() + 10_000; !check(); await sleep(10)) assert.ok(Date.now() < end, `timed out: ${label}`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const busy = id => ({ kind: 'response', id, ok: false, error: { code: 'BRIDGE_BUSY' } });

const sessions = [];
after(() => {
  for (const host of sessions) {
    if (host.proc.exitCode === null && host.proc.signalCode === null) { // a live supervisor still pins its child's pid
      try { process.kill(host.child, 'SIGKILL'); } catch { /* never started */ }
      host.proc.kill('SIGKILL');
    }
    rmSync(dirname(host.socket), { recursive: true, force: true });
  }
});

async function ingress(options = 'agent_uid=os.getuid()', setup = '', socket = `${mkdtempSync(`${tmpdir()}/moe-r08c-`)}/agent.sock`) {
  const code = `${LOAD}${setup}\nsys.exit(m.relay(['python3', '-I', '-c', sys.argv[3]], agent_socket=sys.argv[2], ${options}${PEER}))`;
  const proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, socket, AGENT_CHILD], { stdio: ['pipe', 'pipe', 'inherit'] });
  const host = { proc, socket, frames: [], exited: once(proc, 'exit') };
  sessions.push(host);
  const decoder = createFrameDecoder();
  proc.stdout.on('data', chunk => host.frames.push(...decoder.push(chunk).map(parseGuestFrame)));
  host.requests = () => host.frames.filter(frame => frame.kind === 'request');
  host.answer = (id, reply = { ok: true, result: { id } }) => proc.stdin.write(encodeFrame({ kind: 'response', id, ...reply }));
  host.end = () => proc.stdin.end() && host.exited;
  await until(() => host.frames.some(frame => frame.kind === 'output'), 'agent child started');
  host.child = Number(host.frames.find(frame => frame.kind === 'output').data);
  return host;
}

async function agent(host) {
  const socket = connect(host.socket);
  const decoder = createFrameDecoder(MAX_HOST_FRAME_BYTES);
  const peer = { socket, bytes: [], frames: [], closed: false };
  socket.on('data', chunk => { peer.bytes.push(chunk); peer.frames.push(...decoder.push(chunk)); });
  socket.on('error', () => {}); // a refused peer may see ECONNRESET
  socket.on('close', () => { peer.closed = true; });
  await once(socket, 'connect');
  peer.send = frame => socket.write(Buffer.isBuffer(frame) ? frame : encodeFrame(frame, MAX_GUEST_FRAME_BYTES));
  return peer;
}

test('I1 a peer that is not the agent identity is closed at accept and nothing it sends is relayed', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const host = await ingress('agent_uid=os.getuid() + 1');
  const peer = await agent(host);
  peer.send(REQUEST);
  await until(() => peer.closed, 'refused peer closed');
  assert.deepEqual(peer.bytes, []);
  assert.ok(alive(host.child), 'a refused peer does not end the bridge');
  assert.deepEqual(await host.end(), [74, null]);
  assert.deepEqual(host.requests(), []);
  assert.equal(alive(host.child), false);
});

test('I2 supervisor ids keep connections apart and each rebuilt response reaches only its requester', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  // A stale socket from an earlier bridge is replaced; the live one is connectable by any guest user.
  const host = await ingress(undefined, 'import socket\nstale = socket.socket(socket.AF_UNIX)\nstale.bind(sys.argv[2])\nstale.close()');
  assert.equal(statSync(host.socket).mode & 0o777, 0o666);
  const [a, b] = [await agent(host), await agent(host)];
  const comment = { content: 'café \u{1F600}' };
  a.send({ ...REQUEST, id: 7 });
  await until(() => host.requests().length === 1, 'first request');
  b.send({ kind: 'request', id: 7, tool: 'moe.add_comment', args: comment });
  await until(() => host.requests().length === 2, 'second request');
  assert.deepEqual(host.requests(), [{ ...REQUEST, id: 1 }, { kind: 'request', id: 2, tool: 'moe.add_comment', args: comment }]);
  const result = { text: 'é\u{1F600}', lone: '\ud800' };
  host.answer(2, { ok: false, error: { code: 'BRIDGE_TOOL_DENIED' } });
  host.answer(1, { ok: true, result });
  await until(() => a.frames.length && b.frames.length, 'both responses');
  assert.deepEqual(Buffer.concat(a.bytes), encodeFrame({ kind: 'response', id: 7, ok: true, result }));
  assert.deepEqual(Buffer.concat(b.bytes), encodeFrame({ kind: 'response', id: 7, ok: false, error: { code: 'BRIDGE_TOOL_DENIED' } }));
  assert.deepEqual(await host.end(), [74, null]);
  assert.equal(existsSync(host.socket), false);
});

test('I3 an unknown, answered or malformed host response ends the bridge as a protocol violation', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const reply = (extra = {}) => encodeFrame({ kind: 'response', id: 1, ok: true, result: {}, ...extra });
  const cases = [reply({ id: 2 }), Buffer.concat([reply(), reply()]), reply({ id: '1' }), reply({ kind: 'request' }), reply({ extra: 1 }),
    reply({ ok: 'yes' }), reply({ ok: false }), encodeFrame({ kind: 'response', id: 1, ok: true }),
    ...[{ code: 'lower' }, { code: 'X', detail: 1 }, 'X'].map(error => encodeFrame({ kind: 'response', id: 1, ok: false, error })),
    header(0), header(MAX_HOST_FRAME_BYTES + 1), framed('{'), framed('[]'), framed([0xff])];
  for (const bytes of cases) {
    const host = await ingress();
    const peer = await agent(host);
    peer.send(REQUEST);
    await until(() => host.requests().length === 1, 'request relayed');
    host.proc.stdin.write(bytes);
    assert.deepEqual(await host.exited, [76, null], bytes.toString('latin1'));
    await until(() => peer.closed, 'agent closed');
    assert.ok(peer.frames.length <= 1 && host.frames.every(frame => frame.kind !== 'observation'));
    assert.equal(alive(host.child), false);
    await host.end();
  }
});

test('I4 a malformed or over-limit agent frame closes only its own connection', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const host = await ingress();
  const kept = await agent(host);
  const exact = { kind: 'request', id: 1, tool: 'moe.add_comment', args: { content: '' } };
  exact.args.content = 'x'.repeat(MAX_GUEST_FRAME_BYTES - JSON.stringify(exact).length);
  kept.send(exact);
  await until(() => host.requests().length === 1, 'exact-limit request');
  assert.deepEqual(host.requests(), [exact]);
  const nested = `{"kind":"request","id":1,"tool":"moe.get_context","args":{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`;
  const bad = [header(0), header(MAX_GUEST_FRAME_BYTES + 1), framed('{'), framed([0xff]), framed([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    framed('[]'), framed(nested), framed('{"kind":"request","id":1,"tool":"moe.get_context","args":{"a":1e999}}'),
    ...[0, 2 ** 31, true, 1.5].map(id => encodeFrame({ ...REQUEST, id })), encodeFrame({ ...REQUEST, extra: 1 }),
    ...['moe.get_context\n', 'get_context'].map(tool => encodeFrame({ ...REQUEST, tool })), encodeFrame({ ...REQUEST, args: [] }),
    encodeFrame(HELLO), encodeFrame({ kind: 'response', id: 1, ok: true, result: {} })];
  for (const bytes of bad) {
    const peer = await agent(host);
    peer.send(bytes);
    await until(() => peer.closed, bytes.subarray(0, 40).toString('latin1'));
    assert.deepEqual(peer.bytes, []);
  }
  kept.send({ ...REQUEST, id: 3 });
  await until(() => host.requests().length === 2, 'kept connection still relays');
  host.answer(2);
  await until(() => kept.frames.length === 1, 'kept connection answered');
  assert.deepEqual(kept.frames, [{ kind: 'response', id: 3, ok: true, result: { id: 2 } }]);
  assert.deepEqual(await host.end(), [74, null]);
});

test('I5 requests past the in-flight or total bound get BRIDGE_BUSY unrelayed, and connections past the cap are refused', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const run = harness('print(json.dumps([m.MAX_CONNECTIONS, m.MAX_IN_FLIGHT, m.AGENT_IDENTITY, m.AGENT_SOCKET]))');
  assert.deepEqual(JSON.parse(run.stdout), [8, 8, JOB_IDENTITIES[0], '/run/moe/agent.sock']);
  const host = await ingress(undefined, 'm.MAX_CONNECTIONS, m.MAX_IN_FLIGHT = 2, 2');
  const relayed = () => host.requests().map(frame => frame.id);
  const a = await agent(host);
  for (const id of [1, 2, 3]) a.send({ ...REQUEST, id });
  await until(() => a.frames.length === 1 && relayed().length === 2, 'per-connection bound');
  assert.deepEqual(a.frames, [busy(3)]);
  const [b, c] = [await agent(host), await agent(host)];
  await until(() => c.closed, 'connection bound');
  host.answer(1);
  await until(() => a.frames.length === 2, 'the answer reaches a and frees its slot');
  assert.deepEqual(a.frames[1], { kind: 'response', id: 1, ok: true, result: { id: 1 } });
  a.send({ ...REQUEST, id: 4 });
  await until(() => relayed().length === 3, 'freed slot relays');
  a.socket.destroy(); // ids 2 and 3 are now answers nobody may receive
  await until(() => a.closed, 'a closed');
  for (const id of [1, 2]) b.send({ ...REQUEST, id });
  await until(() => relayed().length === 5, 'b relays');
  const d = await agent(host);
  d.send({ ...REQUEST, id: 1 });
  await until(() => d.frames.length === 1, 'total bound');
  assert.deepEqual(d.frames, [busy(1)]);
  host.answer(2);
  host.answer(3);
  d.send({ ...REQUEST, id: 2 });
  await until(() => relayed().length === 6, 'orphan answers dropped and slot freed');
  assert.deepEqual(relayed(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await host.end(), [74, null]);
});

test('I7 a newer bridge on the same path keeps its socket when an older bridge ends', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const older = await ingress();
  const newer = await ingress(undefined, '', older.socket);
  assert.deepEqual(await older.end(), [74, null]);
  const peer = await agent(newer);
  peer.send(REQUEST);
  await until(() => newer.requests().length === 1, 'the newer bridge still serves its path');
  assert.deepEqual(await newer.end(), [74, null]);
  assert.equal(existsSync(newer.socket), false);
});

test('I6 the agent socket opens only in a directory private to the supervisor', { skip: NO_GUEST }, () => {
  const dir = mkdtempSync(`${tmpdir()}/moe-r08c-`);
  try {
    const cases = ['os.chmod(d, 0o777)', "open(d + '/agent.sock', 'w').close()", "os.symlink(d, d + '-link')\nd += '-link'",
      'os.geteuid = lambda: os.getuid() + 1', "m.AGENT_IDENTITY = 'moe-r08c-no-such-account'", "argv = [d + '/no-such-job']"];
    for (const [index, setup] of cases.entries()) {
      const uid = setup.startsWith('m.') ? '' : ', agent_uid=os.getuid()';
      const run = harness(`d = os.path.join(sys.argv[2], '${index}')\nos.mkdir(d, 0o700)\nargv = ['python3', '-c', '']\n${setup}
sys.exit(m.relay(argv, in_fd=os.pipe()[0], agent_socket=d + '/agent.sock'${uid}))`, dir);
      assert.equal(run.status, 71, `${setup} ${run.stderr}`);
      assert.deepEqual(createFrameDecoder().push(run.stdout).map(parseGuestFrame), [HELLO], setup);
      // Only the planted file stays; a socket bound before the job failed to spawn is unlinked with its listener.
      assert.equal(existsSync(`${dir}/${index}/agent.sock`), index === 1, setup);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const families = spawnSync('python3', ['-I', '-B', '-c', `import ast, sys
tree = ast.parse(open(sys.argv[1], 'rb').read())
print(sorted({n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute) and getattr(n.value, 'id', '') == 'socket'}))`, SUPERVISOR]);
  assert.equal(families.stdout.toString().trim(), "['AF_UNIX', 'SOCK_STREAM', 'SOL_SOCKET', 'SO_PEERCRED', 'socket']");
});

// CQ-R08 host session. H1-H4 drive it through a spawn-compatible fake provider made of real Node streams which, like
// the supervisor, exits 74 on host EOF unless it is hung.
const NAME = ownedInstanceName({ random: () => Buffer.alloc(10, 0xab) });
const SESSION_ID = 'worker-1@2026-10-26T00:00:00.000Z';
const SPAWNED = ['multipass', bridgeArgv(NAME), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }];
const daemonFile = (name, info = {}) => {
  writeFileSync(join(DAEMON_DIR, name), typeof info === 'string' ? info : JSON.stringify({ port: HEALTH_PORT, pid: 1, projectPath: '/p', ...info }));
  return join(DAEMON_DIR, name);
};
const DAEMON = daemonFile('daemon.json');
// A surfaced error is a fixed code whose message carries no path and no upstream text.
const rejectsWith = (promise, code, label) => assert.rejects(promise, error => error?.code === code && !/[\\/]|secret/.test(error.message), label);
const nest = depth => Array.from({ length: depth }).reduce(value => [value], 0);
const answered = (id, text) => ({ kind: 'response', id, ok: true, result: { content: [{ type: 'text', text }] } });
const refused = (id, code) => ({ kind: 'response', id, ok: false, error: { code } });
// CQ-R10c: every session carries a job, whose frame the fake provider keeps apart as proc.job.
const KEY = 'sk-secret-R10c!~';
const HOST_JOB = Object.freeze({ cli: 'claude', credential: Object.freeze({ name: 'ANTHROPIC_API_KEY', value: KEY }) });

function fakeProvider({ hung = false, first = (chunk, done) => done(), write = (chunk, done) => done() } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], kills: [], written: [], job: null });
  proc.stdin = new Writable({ write(chunk, encoding, done) {
    if (proc.job === null) { proc.job = chunk; return first(chunk, done); } // the job frame; replies() decodes only what follows
    proc.written.push(chunk);
    write(chunk, done);
  } });
  proc.exit = (code = 0) => { if (!proc.stdout.writableEnded) proc.stdout.once('close', () => proc.emit('close', code, null)).end(); };
  if (!hung) proc.stdin.once('close', () => proc.exit(74));
  proc.kill = signal => { proc.kills.push(signal); setImmediate(() => proc.emit('close', null, signal)); return true; }; // async, as in Node
  proc.spawn = (...args) => { proc.calls.push(args); return proc; };
  proc.send = (...frames) => proc.stdout.write(Buffer.concat(frames.map(frame => (Buffer.isBuffer(frame) ? frame : encodeFrame(frame)))));
  proc.replies = () => createFrameDecoder(MAX_HOST_FRAME_BYTES).push(Buffer.concat(proc.written));
  return proc;
}

function openSession(provider, { answer = tool => ({ content: [{ type: 'text', text: tool }] }), ...options } = {}) {
  const run = { outputs: [], observations: [], forwarded: [], signals: [] };
  run.promise = runGuestSession({
    name: NAME, binding: BINDING, job: HOST_JOB, sessionId: SESSION_ID, daemonInfoPath: DAEMON, provider: { spawn: provider.spawn }, timeoutMs: 1_000,
    forward: (tool, args, { signal }) => { run.forwarded.push([tool, args]); run.signals.push(signal); return answer(tool, args); },
    onOutput: (stream, data) => run.outputs.push([stream, data]), onObservation: frame => run.observations.push(frame), ...options,
  });
  return run;
}

// Sends hello and frames, waits for `answers` replies, then ends the job with exit 0 and returns the session result.
async function exchange(proc, run, frames, answers) {
  proc.send(HELLO, ...frames);
  await until(() => proc.written.length === answers, `${answers} answers`);
  proc.send(EXIT);
  proc.exit(0);
  return run.promise;
}

test('H1 invalid input, unsafe daemon info and an aborted signal refuse before spawn', { timeout: 30_000 }, async t => {
  const posix = process.platform !== 'win32';
  if (posix) {
    assert.equal(spawnSync('mkfifo', [join(DAEMON_DIR, 'fifo')]).status, 0);
    symlinkSync(DAEMON, join(DAEMON_DIR, 'link.json'));
  }
  const invalid = [{ name: 'primary' }, { binding: { ...BINDING, role: 'architect' } }, { binding: null }, { sessionId: undefined },
    { sessionId: ' ' }, { sessionId: 'a\nb' }, { sessionId: 'a\rb' }, { sessionId: 'a\0b' }, { sessionId: 's'.repeat(256) }, { forward: null },
    { onOutput: 1 }, { onObservation: undefined }, { signal: {} }, { provider: null }, { provider: { executable: ' ' } },
    { provider: { executable: 'multi\tpass' } }, { provider: { spawn: 'spawn' } }, { daemonInfoPath: 'daemon.json' },
    { daemonInfoPath: `${DAEMON}\n` }, ...[0, 1.5, 60_001, '100'].map(timeoutMs => ({ timeoutMs }))];
  const unreadable = [join(DAEMON_DIR, 'absent.json'), DAEMON_DIR, daemonFile('big.json', `{}${' '.repeat(MAX_DAEMON_INFO_BYTES - 1)}`),
    daemonFile('bad.json', '{'), daemonFile('list.json', '[]'), daemonFile('null.json', 'null'),
    ...(posix ? ['fifo', 'link.json'].map(name => join(DAEMON_DIR, name)) : [])];
  const wide = ['0.0.0.0', '::', 'localhost', '10.0.2.2', '127.0.0.2', '::ffff:127.0.0.1', '', null, 1]
    .map((bindHost, index) => daemonFile(`wide-${index}.json`, { bindHost }));
  for (const [code, options] of [...invalid.map(options => ['SESSION_INPUT_INVALID', options]),
    ...unreadable.map(daemonInfoPath => ['SESSION_DAEMON_INFO_INVALID', { daemonInfoPath }]),
    ...wide.map(daemonInfoPath => ['SESSION_DAEMON_NOT_LOOPBACK', { daemonInfoPath }]), ['SESSION_ABORTED', { signal: AbortSignal.abort() }]]) {
    const proc = fakeProvider();
    const run = openSession(proc, options);
    await rejectsWith(run.promise, code, JSON.stringify(options));
    assert.deepEqual([proc.calls.length, run.forwarded.length], [0, 0]);
  }
  // index.ts omits bindHost for its 127.0.0.1 default; a file of exactly MAX_DAEMON_INFO_BYTES is read whole.
  if (!HEALTH_V6_PORT) t.diagnostic('v6.json skipped: ::1 cannot bind on this host');
  const v6 = HEALTH_V6_PORT ? [daemonFile('v6.json', { bindHost: '::1', port: HEALTH_V6_PORT })] : [];
  for (const daemonInfoPath of [DAEMON, daemonFile('v4.json', { bindHost: '127.0.0.1' }), ...v6,
    daemonFile('edge.json', JSON.stringify({ port: HEALTH_PORT, pid: 1, projectPath: '/p' }).padEnd(MAX_DAEMON_INFO_BYTES))]) {
    const proc = fakeProvider();
    const run = openSession(proc, { daemonInfoPath });
    proc.send(HELLO, EXIT);
    proc.exit(0);
    assert.deepEqual(await run.promise, { observation: EXIT, executionReady: false });
    assert.deepEqual(proc.calls, [SPAWNED]);
  }
});

test('H2 the stream must be hello, then requests and output, then one observation, and the provider must exit 0', { timeout: 30_000 }, async () => {
  // Frames inside child output, and anything on provider stderr, stay bytes: never decoded or dispatched.
  const forged = Buffer.concat([HELLO, REQUEST, EXIT].map(frame => encodeFrame(frame)));
  const wire = Buffer.concat([HELLO, { ...OUTPUT, data: b64(forged) }, { ...OUTPUT, stream: 'stderr' }, { ...EXIT, code: 7 }]
    .map(frame => encodeFrame(frame)));
  for (const chunks of [[wire], [...wire].map(byte => Uint8Array.of(byte))]) {
    const proc = fakeProvider();
    const { signal } = new AbortController(); // never aborted: its listener must still be removed
    const run = openSession(proc, { signal });
    proc.stderr.write(forged);
    for (const chunk of chunks) proc.stdout.write(chunk);
    proc.exit(0);
    assert.deepEqual(await run.promise, { observation: { ...EXIT, code: 7 }, executionReady: false });
    assert.deepEqual(run.outputs, [['stdout', forged], ['stderr', Buffer.from('A')]]);
    assert.deepEqual([run.observations, run.forwarded, proc.written, proc.kills, getEventListeners(signal, 'abort').length],
      [[{ ...EXIT, code: 7 }], [], [], [], 0]);
  }
  // A request id at or below the last one is a replay, even once the first is answered: it is never forwarded.
  for (const id of [3, 2]) {
    const proc = fakeProvider();
    const run = openSession(proc);
    proc.send(HELLO, { ...REQUEST, id: 3 });
    await until(() => proc.written.length === 1, 'first answer');
    proc.send({ ...REQUEST, id });
    await rejectsWith(run.promise, 'SESSION_PROTOCOL_VIOLATION', `replayed ${id}`);
    assert.equal(run.forwarded.length, 1);
  }
  const cases = [[[OUTPUT, HELLO, EXIT]], [[HELLO, HELLO, EXIT]], [[HELLO, EXIT, OUTPUT]], [[HELLO, EXIT, EXIT]],
    [[HELLO, { kind: 'response', id: 1, ok: true, result: {} }]], [[HELLO, EXIT, header(9)]], [[HELLO, framed('[]')]], [[HELLO]],
    [[HELLO, EXIT], 'SESSION_PROVIDER_FAILED', 1], [[HELLO, EXIT], 'SESSION_PROVIDER_FAILED', null], [[], 'SESSION_TIMEOUT']];
  for (const [frames, code = 'SESSION_PROTOCOL_VIOLATION', exitCode = 0] of cases) {
    const proc = fakeProvider();
    const run = openSession(proc, { timeoutMs: frames.length ? 1_000 : 100 });
    proc.send(...frames);
    if (frames.length) proc.exit(exitCode);
    await rejectsWith(run.promise, code, JSON.stringify(frames));
    assert.deepEqual([run.outputs, run.observations], [[], []]);
  }
});

test('H3 each role tool is forwarded with only the host-bound identity, and refused requests never reach forward', { timeout: 30_000 }, async () => {
  const execution = { attemptId: BINDING.attemptId, generation: BINDING.generation, sessionId: SESSION_ID };
  const stamps = { 'moe.get_context': { sessionId: SESSION_ID }, 'moe.start_step': execution, 'moe.complete_step': execution,
    'moe.complete_task': execution };
  for (const binding of [BINDING, QA]) {
    const tools = Object.keys(TOOLS[binding.role]);
    const caller = { ...binding };
    const proc = fakeProvider();
    const run = openSession(proc, { binding: caller });
    // The session snapshots its binding, so a later change by the caller authorizes nothing.
    Object.assign(caller, { role: binding.role === 'qa' ? 'worker' : 'qa', workerId: 'qa-9', taskId: 'task-other',
      attemptId: 'attempt-9', generation: 9 });
    await exchange(proc, run, tools.map((tool, index) => ({ kind: 'request', id: index + 1, tool, args: {} })), tools.length);
    assert.deepEqual(run.forwarded, tools.map(tool => [tool, { ...(tool === 'moe.heartbeat' ? {} : { taskId: binding.taskId }),
      ...(tool === 'moe.get_handoff_history' ? {} : { workerId: binding.workerId }), ...stamps[tool] }]));
    assert.deepEqual(proc.replies(), tools.map((tool, index) => answered(index + 1, tool)));
  }
  const denied = [...['moe.qa_approve', 'moe.set_task_dependencies', 'moe.set_task_status', 'moe.init_project', 'moe.claim_next_task']
    .map(tool => ['BRIDGE_TOOL_DENIED', tool, {}]),
  ...[{ role: 'qa' }, { workerId: 'qa-1' }, { taskId: 'task-other' }, { attemptId: BINDING.attemptId }, { generation: BINDING.generation }]
    .map(args => ['BRIDGE_IDENTITY_MISMATCH', 'moe.get_context', args]),
  ['BRIDGE_ARGUMENT_DENIED', 'moe.get_context', { sessionId: SESSION_ID }], ['BRIDGE_ARGUMENT_DENIED', 'moe.complete_task', { prLink: 'x' }]];
  const proc = fakeProvider();
  const run = openSession(proc);
  await exchange(proc, run, denied.map(([, tool, args], index) => ({ kind: 'request', id: index + 1, tool, args })), denied.length);
  assert.deepEqual(run.forwarded, []);
  assert.deepEqual(proc.replies(), denied.map(([code], index) => refused(index + 1, code)));
});

test('H4 replies, bounds and failures each answer once or end the session with a fixed code', { timeout: 30_000 }, async () => {
  assert.deepEqual([MAX_DAEMON_INFO_BYTES, MAX_PENDING_REQUESTS, MAX_ARGUMENT_DEPTH, MAX_RESPONSE_BYTES], [16_384, 64, 64, 1_048_576]);
  // Guest argument depth is checked iteratively before forward, even at 100k levels.
  const comment = (id, content) => ({ kind: 'request', id, tool: 'moe.add_comment', args: { content } });
  const deep = framed(`{"kind":"request","id":3,"tool":"moe.add_comment","args":{"content":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`);
  const depth = fakeProvider();
  const nested = openSession(depth);
  await exchange(depth, nested, [comment(1, nest(MAX_ARGUMENT_DEPTH - 1)), comment(2, nest(MAX_ARGUMENT_DEPTH)), deep], 3);
  assert.deepEqual(nested.forwarded, [['moe.add_comment', { content: nest(MAX_ARGUMENT_DEPTH - 1), taskId: 'task-abc', workerId: 'worker-1' }]]);
  assert.deepEqual(depth.replies(), [answered(1, 'moe.add_comment'), refused(2, 'BRIDGE_ARGUMENT_TOO_DEEP'), refused(3, 'BRIDGE_ARGUMENT_TOO_DEEP')]);
  // A failed or isError forward is BRIDGE_UPSTREAM_FAILED; a result that is not a JSON object, is too deep or exceeds
  // MAX_RESPONSE_BYTES is BRIDGE_RESPONSE_INVALID. Neither echoes it.
  const sized = (id, extra) => ({ text: 'x'.repeat(MAX_RESPONSE_BYTES + extra
    - JSON.stringify({ kind: 'response', id, ok: true, result: { text: '' } }).length) });
  const cyclic = {};
  cyclic.self = cyclic;
  const results = [[() => { throw new Error('secret'); }, 'BRIDGE_UPSTREAM_FAILED'],
    [async () => { throw new Error('secret'); }, 'BRIDGE_UPSTREAM_FAILED'],
    [() => ({ isError: true, content: [{ type: 'text', text: 'secret' }] }), 'BRIDGE_UPSTREAM_FAILED'],
    ...[undefined, 'secret', ['secret'], { secret: 1n }, cyclic, { content: nest(MAX_ARGUMENT_DEPTH) }, sized(10, 1)]
      .map(value => [() => value, 'BRIDGE_RESPONSE_INVALID']), [() => ({ content: nest(MAX_ARGUMENT_DEPTH - 1) })], [() => sized(12, 0)]];
  const replies = fakeProvider();
  const run = openSession(replies, { answer: (tool, args) => results[args.view][0]() });
  await exchange(replies, run, results.map((_, view) => ({ ...REQUEST, id: view + 1, args: { view } })), results.length);
  assert.deepEqual(replies.replies(), results.map(([make, code], view) => (code ? refused(view + 1, code)
    : { kind: 'response', id: view + 1, ok: true, result: make() })));
  assert.equal(Buffer.concat(replies.written).includes('secret'), false);
  // At most MAX_PENDING_REQUESTS answers may be owed; one more request ends the session before anything is forwarded.
  for (const count of [MAX_PENDING_REQUESTS, MAX_PENDING_REQUESTS + 1]) {
    const proc = fakeProvider();
    const owed = openSession(proc);
    const requests = Array.from({ length: count }, (_, index) => ({ ...REQUEST, id: index + 1 }));
    if (count === MAX_PENDING_REQUESTS) {
      await exchange(proc, owed, requests, count);
      assert.deepEqual(proc.replies().map(frame => frame.id), requests.map(frame => frame.id));
      continue;
    }
    proc.send(HELLO, ...requests);
    await rejectsWith(owed.promise, 'SESSION_PROTOCOL_VIOLATION');
    assert.deepEqual([owed.forwarded, proc.written], [[], []]);
  }
  const ends = async (code, { fake, ...options }, drive = () => {}) => {
    const proc = fakeProvider(fake);
    const ended = openSession(proc, options);
    await drive(proc, ended);
    await rejectsWith(ended.promise, code, code);
    return { proc, ended };
  };
  const spawned = proc => until(() => proc.calls.length === 1, 'spawned');
  let finish;
  const late = new Promise(resolve => { finish = resolve; });
  const slow = await ends('SESSION_TIMEOUT', { timeoutMs: 100, answer: () => late }, proc => proc.send(HELLO, REQUEST));
  finish({ content: [] }); // too late: never written
  await sleep(20);
  assert.deepEqual([slow.proc.written, slow.ended.signals.map(signal => signal.aborted)], [[], [true]]);
  await ends('SESSION_TIMEOUT', { timeoutMs: 100, fake: { write: () => {} } }, proc => proc.send(HELLO, REQUEST)); // stdin never drains
  await ends('SESSION_PROVIDER_FAILED', { fake: { write: (chunk, done) => done(new Error('secret')) } }, proc => proc.send(HELLO, REQUEST));
  await ends('SESSION_PROVIDER_FAILED', { timeoutMs: 100 }, async proc => {
    proc.send(HELLO);
    await spawned(proc);
    proc.stdout.destroy(new Error('secret'));
  });
  await ends('SESSION_SPAWN_FAILED', {}, async proc => {
    await spawned(proc);
    proc.emit('error', Object.assign(new Error('secret'), { code: 'ENOENT' }));
  });
  for (const spawn of [() => { throw new Error('secret'); }, () => ({})]) await ends('SESSION_SPAWN_FAILED', { provider: { spawn } });
  let outputs = 0;
  await ends('SESSION_CALLBACK_FAILED', { onOutput: () => { outputs += 1; throw new Error('secret'); } }, proc => proc.send(HELLO, OUTPUT, OUTPUT));
  assert.equal(outputs, 1);
  await ends('SESSION_CALLBACK_FAILED', { onObservation: () => { throw new Error('secret'); } }, proc => {
    proc.send(HELLO, EXIT);
    proc.exit(0);
  });
  // An answer still owed when the job ends leaves the session unclean, so no observation is delivered.
  const unanswered = await ends('SESSION_PROTOCOL_VIOLATION', { answer: () => new Promise(() => {}) }, async (proc, ended) => {
    proc.send(HELLO, REQUEST);
    await until(() => ended.forwarded.length === 1, 'forwarded');
    proc.send(EXIT);
    proc.exit(0);
  });
  assert.deepEqual([unanswered.ended.observations, unanswered.proc.written], [[], []]);
  // The daemon's bind is checked again before every forward.
  const moved = await ends('SESSION_DAEMON_NOT_LOOPBACK', { daemonInfoPath: daemonFile('rebind.json') }, async proc => {
    proc.send(HELLO, REQUEST);
    await until(() => proc.written.length === 1, 'first answer');
    daemonFile('rebind.json', { bindHost: '0.0.0.0' });
    proc.send({ ...REQUEST, id: 2 });
  });
  assert.equal(moved.ended.forwarded.length, 1);
  // An abort closes the bridge stdin; only a provider still running timeoutMs later is killed, locally.
  const controller = new AbortController();
  const stopped = await ends('SESSION_ABORTED', { signal: controller.signal, answer: () => new Promise(() => {}) }, async (proc, ended) => {
    proc.send(HELLO, REQUEST);
    await until(() => ended.forwarded.length === 1, 'forwarded');
    controller.abort();
  });
  assert.deepEqual([stopped.proc.kills, stopped.ended.signals[0].aborted, getEventListeners(controller.signal, 'abort').length], [[], true, 0]);
  const hungController = new AbortController();
  const hung = await ends('SESSION_ABORTED', { timeoutMs: 100, fake: { hung: true }, signal: hungController.signal }, async proc => {
    proc.send(HELLO);
    await spawned(proc);
    hungController.abort();
  });
  assert.deepEqual(hung.proc.kills, ['SIGKILL']);
  // A provider that must be killed is a failure even after a clean observation, which is then never delivered.
  const killed = await ends('SESSION_TIMEOUT', { timeoutMs: 100, fake: { hung: true } }, proc => {
    proc.send(HELLO, EXIT);
    proc.stdout.end();
  });
  assert.deepEqual([killed.proc.kills, killed.ended.observations], [['SIGKILL'], []]);
  // Only hello has a deadline: once it arrives, the job may run longer than timeoutMs.
  const long = fakeProvider();
  const longRun = openSession(long, { timeoutMs: 100 });
  long.send(HELLO);
  await sleep(300);
  long.send(EXIT);
  long.exit(0);
  assert.deepEqual(await longRun.promise, { observation: EXIT, executionReady: false });
});

// CQ-R08 end to end. The injected spawn swaps only the Multipass launch for the real supervisor relay on the host's
// python3, whose job is a real agent on the real Unix socket. These are local processes: not a live VM, Multipass or
// network-isolation certification. Guest-to-host endpoint probes and the docs sweep belong to CQ-R13.
const AGENT_JOB = `import os, socket, struct, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
f = s.makefile('rb')
for body in sys.argv[2:-1]:
    data = body.encode()
    s.sendall(struct.pack('>I', len(data)) + data)
    head = f.read(4)
    os.write(2, head + f.read(struct.unpack('>I', head)[0]))
os.write(1, bytes.fromhex(sys.argv[-1]))
sys.exit(3)
`;
function supervised(job, ...args) {
  const host = { launches: [] };
  host.spawn = (executable, argv, options) => {
    host.launches.push([executable, argv, options]);
    host.socket = `${mkdtempSync(`${tmpdir()}/moe-r08-`)}/agent.sock`;
    // The job frame comes first on stdin; read_job, the guest's own validator, consumes it before relay().
    const code = `${LOAD}m.read_job(0, m.JOBS)\nsys.exit(m.relay(['python3', '-I', '-c', *sys.argv[3:]], agent_socket=sys.argv[2], agent_uid=os.getuid()${PEER}))`;
    host.proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, host.socket, job, host.socket, ...args], options);
    sessions.push(host);
    return host.proc;
  };
  return host;
}

test('H5 end to end, the real supervisor and agent get scoped answers, forged bytes stay output and only waitpid exits',
  { skip: NO_GUEST, timeout: 30_000 }, async () => {
    const unsafe = supervised(AGENT_CHILD);
    const wide = daemonFile('wide-e2e.json', { bindHost: '0.0.0.0' });
    await rejectsWith(openSession(unsafe, { daemonInfoPath: wide }).promise, 'SESSION_DAEMON_NOT_LOOPBACK');
    assert.deepEqual(unsafe.launches, []); // a non-loopback daemon bind never starts the bridge
    const forged = Buffer.concat([...[HELLO, REQUEST, EXIT].map(frame => encodeFrame(frame)), Buffer.from([0, 0xff, 10])]);
    const asks = [['moe.get_context', {}], ['moe.get_context', { role: 'qa' }], ['moe.init_project', {}],
      ['moe.set_task_dependencies', { dependsOn: [] }], ['moe.add_comment', { content: 'x', workerId: 'qa-1' }]];
    const agentRun = supervised(AGENT_JOB, ...asks.map(([tool, args], index) => JSON.stringify({ kind: 'request', id: 40 + index, tool, args })),
      forged.toString('hex'));
    const run = openSession(agentRun, { timeoutMs: 10_000 });
    assert.deepEqual(await run.promise, { observation: { ...EXIT, code: 3 }, executionReady: false });
    const bytes = stream => Buffer.concat(run.outputs.filter(([name]) => name === stream).map(([, data]) => data));
    assert.deepEqual([agentRun.launches, run.forwarded, bytes('stdout'), run.observations, agentRun.proc.exitCode, existsSync(agentRun.socket)],
      [[SPAWNED], [['moe.get_context', { taskId: 'task-abc', workerId: 'worker-1', sessionId: SESSION_ID }]], forged,
        [{ ...EXIT, code: 3 }], 0, false]);
    // The agent wrote each answer it read to stderr: one scoped success, then the refusals, each under its own id.
    assert.deepEqual(createFrameDecoder(MAX_HOST_FRAME_BYTES).push(bytes('stderr')), [answered(40, 'moe.get_context'),
      ...[[41, 'BRIDGE_IDENTITY_MISMATCH'], [42, 'BRIDGE_TOOL_DENIED'], [43, 'BRIDGE_TOOL_DENIED'], [44, 'BRIDGE_IDENTITY_MISMATCH']]
        .map(([id, code]) => refused(id, code))]);
    // Abort with a silent job: the session closes the bridge stdin, and the supervisor's host-EOF path kills and reaps the
    // job and removes its socket, with no observation and no local kill.
    const silent = supervised(AGENT_CHILD);
    const controller = new AbortController();
    const stopped = openSession(silent, { signal: controller.signal, timeoutMs: 10_000 });
    await until(() => stopped.outputs.length > 0, 'silent job started');
    silent.child = Number(stopped.outputs[0][1]);
    assert.deepEqual([alive(silent.child), existsSync(silent.socket)], [true, true]);
    controller.abort();
    await rejectsWith(stopped.promise, 'SESSION_ABORTED');
    assert.deepEqual([alive(silent.child), existsSync(silent.socket), silent.proc.exitCode, stopped.observations], [false, false, 74, []]);
  });

// CQ-R10a: SIGTERM, SIGHUP and SIGINT take relay()'s teardown; the guard empties the session of a SIGKILLed supervisor.
const EX_TERMINATED = 75;
const GROUP_JOB = `import os, signal, time
grandchild = os.fork()
if grandchild == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(600)
    os._exit(0)
os.write(1, b'%d %d %d' % (os.getpid(), grandchild, os.getsid(0)))
time.sleep(600)
`;
// Linux /proc/<pid>/stat after the comm field: [0] state, [3] session id.
const procState = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'latin1').split(')').at(-1).trim().split(' '); } catch { return null; } };
const running = pid => alive(pid) && (process.platform !== 'linux' || procState(pid)?.[0] !== 'Z');
const sessionMembers = sid => readdirSync('/proc').filter(entry => String(Number(entry)) === entry).map(Number)
  .filter(pid => { const fields = procState(pid); return fields !== null && fields[0] !== 'Z' && Number(fields[3]) === sid; });
async function guarded(job = GROUP_JOB) {
  const socket = `${mkdtempSync(`${tmpdir()}/moe-r10a-`)}/agent.sock`;
  const code = `${LOAD}r, w = os.pipe()
sys.exit(m.relay(['python3', '-I', '-c', sys.argv[3]], in_fd=r, agent_socket=sys.argv[2], agent_uid=os.getuid()${PEER}))`;
  const proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, socket, job], { stdio: ['ignore', 'pipe', 'inherit'] });
  const host = { proc, socket, frames: [], exited: once(proc, 'exit') };
  sessions.push(host); // after() kills a supervisor a failed test left running and removes the socket directory
  const decoder = createFrameDecoder();
  proc.stdout.on('data', chunk => host.frames.push(...decoder.push(chunk).map(parseGuestFrame)));
  await until(() => host.frames.some(frame => frame.kind === 'output'), 'job started');
  [host.child, host.grandchild, host.sid] = String(host.frames.find(frame => frame.kind === 'output').data).split(' ').map(Number);
  return host;
}

for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  test(`S9 ${name} during relay() kills and reaps the whole job group, closes the bridge and exits 75 with no observation`, { skip: NO_GUEST, timeout: 30_000 }, async () => {
    const host = await guarded();
    try {
      const agent = connect(host.socket);
      await once(agent, 'connect');
      const closed = once(agent, 'close');
      host.proc.kill(name);
      assert.deepEqual(await host.exited, [EX_TERMINATED, null]);
      await closed;
      for (let waited = 0; waited < 5000 && [host.child, host.grandchild].some(running); waited += 100) await sleep(100);
      assert.deepEqual([host.child, host.grandchild].filter(running), []);
      assert.equal(existsSync(host.socket), false);
      assert.deepEqual(host.frames.filter(frame => frame.kind === 'observation'), []);
    } finally { // today's code leaves both alive, and after() only handles a live supervisor
      for (const pid of [host.child, host.grandchild]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
}

test('S10 a SIGKILLed supervisor leaves no process of the job session alive within 5 seconds',
  { skip: NO_GUEST || (process.platform !== 'linux' && 'session membership is read from /proc'), timeout: 30_000 }, async () => {
    const host = await guarded();
    try {
      host.proc.kill('SIGKILL');
      assert.deepEqual(await host.exited, [null, 'SIGKILL']);
      for (let waited = 0; waited < 5000 && sessionMembers(host.sid).length; waited += 100) await sleep(100);
      assert.deepEqual(sessionMembers(host.sid), []);
    } finally {
      for (const pid of [host.child, host.grandchild]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

test('S11 a normal relay completion never kills the group: a lingering grandchild outlives it', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const run = relay(`import os, time
grandchild = os.fork()
if grandchild == 0:
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    os.dup2(null, 2)
    time.sleep(30)
    os._exit(0)
os.write(1, b'%d' % grandchild)
`);
  const { exit, stdout } = session(run);
  const grandchild = Number(stdout.toString());
  try {
    assert.deepEqual(exit, EXIT);
    await sleep(1000);
    assert.ok(running(grandchild), 'the lingering grandchild was killed');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('S12 on every exit path relay() restores SIGTERM, SIGHUP, SIGINT and the wakeup fd, leaks no fd and leaves SIGCHLD at SIG_DFL; its guard is stdlib-only', { skip: NO_GUEST, timeout: 30_000 }, () => {
  // killSignal: this harness keeps a no-op SIGTERM handler, so a default SIGTERM timeout kill would not end it.
  const run = spawnSync('python3', ['-I', '-B', '-c', `${LOAD}import ast, signal
roots = {alias.name.split('.')[0] for node in ast.walk(ast.parse(m.GUARD)) if isinstance(node, ast.Import) for alias in node.names}
assert 'subprocess' in roots and roots <= set(sys.stdlib_module_names), roots
mark = lambda number, frame: None
TERM = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
for number in TERM:
    signal.signal(number, mark)
null = os.open(os.devnull, os.O_WRONLY)
wakeup = os.pipe()[1]  # the caller's own wakeup fd, which relay() must hand back
os.set_blocking(wakeup, False)
signal.set_wakeup_fd(wakeup)
def host(data=b''):
    r, w = os.pipe()
    os.write(w, data)
    return r, w
results = []
def call(argv, out_fd=null, in_fd=None):
    in_fd = host()[0] if in_fd is None else in_fd
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    fds = set(os.listdir('/dev/fd'))
    code = m.relay(argv, out_fd=out_fd, in_fd=in_fd)
    results.append([code, all(signal.getsignal(number) is mark for number in TERM), signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
                    signal.set_wakeup_fd(wakeup) == wakeup, set(os.listdir('/dev/fd')) == fds])
sleeper = ['python3', '-I', '-c', 'import time; time.sleep(30)']
call(['python3', '-I', '-c', 'pass'])
call(['/nonexistent/moe-child'])
r, w = os.pipe()
os.close(r)
call(sleeper, out_fd=w)
r, w = host()
os.close(w)
call(sleeper, in_fd=r)
call(sleeper, in_fd=host(bytes([0, 0, 0, 1]) + b'x')[0])
call(['python3', '-I', '-c', 'import os, signal, sys, time; os.kill(int(sys.argv[1]), signal.SIGTERM); time.sleep(30)', str(os.getpid())])
print(json.dumps(results))
`, SUPERVISOR], { timeout: 30_000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, String(run.error ?? run.stderr));
  assert.deepEqual(JSON.parse(run.stdout), [0, 71, 74, 74, 76, EX_TERMINATED].map(code => [code, true, true, true, true]));
});

// A job that SIGKILLs its own group takes the guard with it, so the stand-down byte can meet a closed pipe; the legacy
// supervisor observed SIGKILL every time. The sleep lets the guard confirm the start first.
test('S13 a job that SIGKILLs its own group, guard included, still ends with the SIGKILL observation', { skip: NO_GUEST, timeout: 30_000 }, () => {
  const job = 'import os, signal, time\ntime.sleep(0.1)\nos.killpg(0, signal.SIGKILL)\n';
  for (let run = 0; run < 6; run += 1) assert.deepEqual(session(relay(job)).exit, { ...EXIT, code: null, signal: 'SIGKILL' }, `run ${run}`);
});

test('S14 a job killed by TERM, HUP, INT or glibc-reserved 32 gets that signal as its observation through the guard', { skip: NO_GUEST, timeout: 30_000 }, () => {
  // The guard's handlers for TERM, HUP and INT reset at the job's exec, and the guard resets each before it re-raises.
  // glibc's sigaction refuses 32 (Linux only), so that one is re-raised without a reset. 33 is refused too, but the
  // guard's thread has made glibc install its own handler for 33, so that one falls back to exit 128 + 33.
  const { SIGTERM, SIGHUP, SIGINT } = constants.signals;
  const deaths = [[SIGTERM, 'SIGTERM'], [SIGHUP, 'SIGHUP'], [SIGINT, 'SIGINT'], ...(process.platform === 'linux' ? [[32, 'SIG32']] : [])];
  for (const [number, signal] of deaths) {
    assert.deepEqual(session(relay('import os, sys\nos.kill(os.getpid(), int(sys.argv[1]))\n', String(number))).exit, { ...EXIT, code: null, signal }, signal);
  }
});

// QA's gdb repro: a signal that lands after a wait's last Python-level check, but before its syscall blocks, interrupts
// nothing, so only the wakeup fd can end that wait. A signal sent to a helper thread leaves the main thread in that same
// state at any timing: CPython runs the C handler on the helper thread, and the blocked syscall never sees the signal.
const STALLED = `import base64, signal, threading, time
r, w = os.pipe()
seen, frames = bytearray(), []
def fire():
    while len(frames) < 2:  # hello, then the job's pid
        frames.extend(m.take_frames(seen, os.read(r, 65536), m.MAX_GUEST_FRAME_BYTES))
    time.sleep(0.5)  # by now the main thread is blocked in its wait
    signal.pthread_kill(threading.get_ident(), signal.SIGTERM)
threading.Thread(target=fire, daemon=True).start()
code = m.relay(['python3', '-I', '-c', sys.argv[2]], out_fd=w, in_fd=os.pipe()[0])
os.close(w)
while data := os.read(r, 65536):
    frames.extend(m.take_frames(seen, data, m.MAX_GUEST_FRAME_BYTES))
print(json.dumps([code, [frame['kind'] for frame in frames], int(base64.b64decode(frames[1]['data']))]))
`;

test('S15 a termination signal that interrupts no syscall still ends a blocked wait with 75, in pump and in the last start-pipe read', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const started = 'import os, time\nos.write(1, b"%d" % os.getpid())\n';
  const closed = 'null = os.open(os.devnull, os.O_RDWR)\nos.dup2(null, 1)\nos.dup2(null, 2)\n'; // pump ends; the guard waits on
  for (const job of [`${started}time.sleep(600)\n`, `${started}${closed}time.sleep(600)\n`]) {
    // SIGKILL: a timeout's SIGTERM would itself wake the hung wait and let the run pass.
    const run = spawnSync('python3', ['-I', '-B', '-c', LOAD + STALLED, SUPERVISOR, job], { timeout: 10_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, String(run.error ?? run.stderr));
    const [code, kinds, pid] = JSON.parse(run.stdout);
    try {
      assert.deepEqual([code, kinds], [EX_TERMINATED, ['hello', 'output']]);
      for (let waited = 0; waited < 5000 && running(pid); waited += 100) await sleep(100);
      assert.equal(running(pid), false);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('S16 a signal relay() does not handle still reaches the caller handler and never makes its wait spin, in pump and in the last start-pipe read', { skip: NO_GUEST, timeout: 30_000 }, () => {
  const run = harness(`import resource, signal
calls = []
signal.signal(signal.SIGUSR1, lambda number, frame: calls.append(number))
cpu = lambda: sum(resource.getrusage(resource.RUSAGE_SELF)[:2])
send = 'import os, signal, sys, time\\nos.kill(int(sys.argv[1]), signal.SIGUSR1)\\ntime.sleep(1)'
quiet = 'import os, time\\nnull = os.open(os.devnull, os.O_RDWR)\\nos.dup2(null, 1)\\nos.dup2(null, 2)\\ntime.sleep(0.3)\\n'  # pump ends first
results = []
for job in (send, quiet + send):
    before, calls[:] = cpu(), []
    code = m.relay(['python3', '-I', '-c', job, str(os.getpid())], out_fd=os.open(os.devnull, os.O_WRONLY), in_fd=os.pipe()[0])
    results.append([code, list(calls), cpu() - before < 0.5])  # an undrained wakeup byte would spin for the job's whole second
print(json.dumps(results))
`);
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(JSON.parse(run.stdout), [[0, [constants.signals.SIGUSR1], true], [0, [constants.signals.SIGUSR1], true]]);
});

// pump stops polling the listener once the job's output closes, so a connection made after that stays queued until
// the bridge closes; S9's agent can race into the same queue between its connect and the signal.
test('S17 a connection the listener still queues when relay() ends reads EOF, never a reset', { skip: NO_GUEST, timeout: 30_000 }, async () => {
  const host = await guarded('import os, time\nos.write(1, b"%d" % os.getpid())\nnull = os.open(os.devnull, os.O_RDWR)\nos.dup2(null, 1)\nos.dup2(null, 2)\ntime.sleep(600)\n');
  try {
    await sleep(500); // the job has closed its output, so pump has ended
    const agent = connect(host.socket);
    await once(agent, 'connect');
    const closed = once(agent, 'close'); // rejects on ECONNRESET, the reset of a connection never accepted
    host.proc.kill('SIGTERM');
    assert.deepEqual(await host.exited, [EX_TERMINATED, null]);
    await closed;
  } finally {
    try { process.kill(host.child, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// CQ-R10b: a root bridge reads one job frame from stdin before hello, then runs that agent CLI as the agent identity.
// Paths, the identity and the job table reach main() only as Python keywords, through the harness's own argv. A non-root
// runner cannot setgroups, so OWN passes None for the groups; J3 pins the real account's [] with a recorder.
const SECRET = 'sk-R10b!~test0';
const JOB = Object.freeze({ kind: 'job', version: 1, cli: 'claude', role: 'worker', credential: Object.freeze({ name: 'ANTHROPIC_API_KEY', value: SECRET }) });
const QA_JOB = Object.freeze({ kind: 'job', version: 1, cli: 'codex', role: 'qa', credential: Object.freeze({ name: 'CODEX_API_KEY', value: SECRET }) });
const jobFrame = value => encodeFrame(value, MAX_HOST_FRAME_BYTES);
const OWN = 'identity=(os.getuid(), os.getgid(), None)';
// A fresh dir holds ws, a regular file and a link to ws; sessions does not exist yet.
const JOB_DIRS = `import types
os.umask(0o022)  # sudo's, under which the guest supervisor runs
base = sys.argv[2]
workspace, sessions = os.path.join(base, sys.argv[3]), os.path.join(base, 'sessions')
os.makedirs(os.path.join(base, 'ws'))
open(os.path.join(base, 'file'), 'w').close()
os.symlink(os.path.join(base, 'ws'), os.path.join(base, 'link'))
`;
// The recorder stands in for relay(), which must get job by keyword: it prints its call and returns 42.
const RECORD = `def record(argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid, *, job):
    print(json.dumps([argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid is m.peer_uid, job]))
    return 42
m.relay = record
`;
const LA_PROMPTS = {
  worker: 'Call moe.get_context for your assigned task first. You are the worker: follow nextAction and the approved implementation plan, then finish with moe.complete_task.',
  qa: 'Call moe.get_context for your assigned task first. You are QA: review against the definition of done, then finish with moe.qa_approve or moe.qa_reject.',
};
const LA_CONFIG = {
  claude: JSON.stringify({ mcpServers: { moe: { command: '/opt/moe/bin/moe-mcp-shim' } } }),
  codex: '[mcp_servers.moe]\ncommand = "/opt/moe/bin/moe-mcp-shim"\nenv_vars = ["MOE_ROLE"]\ndefault_tools_approval_mode = "approve"\n',
};
function launchArgv(cli, role, home, exe = `/opt/moe/agents/${cli}`) {
  return cli === 'claude'
    ? [exe, '-p', LA_PROMPTS[role], '--mcp-config', join(home, '.moe-mcp.json'), '--strict-mcp-config', '--dangerously-skip-permissions']
    : [exe, 'exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', LA_PROMPTS[role]];
}
function bridgeJob(input, { workspace = 'ws', setup = '', seams = OWN, runs = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moe-r10b-'));
  const code = `${LOAD}${JOB_DIRS}${RECORD}${setup}
codes = [m.main(['bridge'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, ${seams}) for _ in range(${runs})]
sys.exit(codes[0] if len(set(codes)) == 1 else 99)
`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, SUPERVISOR, dir, workspace], { input, maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
  const sessions = join(dir, 'sessions');
  return Object.assign(run, { dir, sessions, homes: existsSync(sessions) ? readdirSync(sessions) : null });
}

test('J1 a malformed, disallowed or cut job frame, or no workspace, fails before hello with no frame, job or home', { skip: NO_GUEST, timeout: 30_000 }, t => {
  const raw = bytes => framed(Buffer.from(bytes));
  const valued = value => ({ ...JOB, credential: { ...JOB.credential, value } });
  const malformed = [raw('{'), raw('[]'), raw('null'), raw(`﻿${JSON.stringify(JOB)}`), raw('['.repeat(100_000) + ']'.repeat(100_000)),
    raw(Buffer.concat([Buffer.from('{"kind":"'), Buffer.from([0xff]), Buffer.from('"}')])), header(0), header(MAX_HOST_FRAME_BYTES + 1),
    ...[{ ...JOB, extra: 1 }, { ...JOB, credential: { ...JOB.credential, extra: 1 } }, { ...JOB, role: undefined }, { ...JOB, kind: 'jobs' },
      ...[2, true, '1'].map(version => ({ ...JOB, version })), ...['gemini', [], {}].map(cli => ({ ...JOB, cli })),
      ...['architect', 'WORKER'].map(role => ({ ...JOB, role })), ...['x', null].map(credential => ({ ...JOB, credential })),
      ...['OPENAI_API_KEY', 'PATH'].map(name => ({ ...JOB, credential: { ...JOB.credential, name } })), { ...JOB, cli: 'codex' },
      ...['', 'a b', 'a\tb', 'a\nb', 'a\x7fb', 'café', 'x'.repeat(4097), 7, null].map(valued)].map(jobFrame)];
  const cases = [...malformed.map(input => [65, input, {}]), [74, Buffer.alloc(0), {}], [74, header(9).subarray(0, 2), {}],
    [74, jobFrame(JOB).subarray(0, 20), {}], [74, Buffer.alloc(0), { workspace: 'absent' }],
    ...['absent', 'file', 'link'].map(workspace => [66, jobFrame(JOB), { workspace }]),
    [66, jobFrame(JOB), { seams: 'identity=(os.getuid() + 1, os.getgid(), None)' }]];
  for (const [status, input, options] of cases) {
    const run = bridgeJob(input, options);
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    assert.deepEqual([run.status, run.stdout.length, run.stderr.length, run.homes], [status, 0, 0, null],
      `${input.subarray(0, 64)} ${JSON.stringify(options)} ${run.stderr}`);
  }
});

test('J2 the job frame is read byte-exact up to the host frame limit, leaving every later stdin byte to relay()', { skip: NO_GUEST, timeout: 30_000 }, t => {
  const unread = 'm.relay = lambda *args, **options: print(os.read(0, 64).decode()) or 42\n';
  const runs = [bridgeJob(Buffer.concat([jobFrame(JOB), Buffer.from('after')]), { setup: unread }),
    bridgeJob(framed(Buffer.from(JSON.stringify(JOB).padEnd(MAX_HOST_FRAME_BYTES)))),
    bridgeJob(jobFrame({ ...JOB, credential: { ...JOB.credential, value: 'x'.repeat(4096) } }))];
  for (const run of runs) t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.deepEqual(runs.map(run => run.status), [42, 42, 42], runs.map(run => String(run.stderr)).join('\n'));
  assert.equal(String(runs[0].stdout), 'after\n');
});

test('J3 main() routes a root bridge to relay as the real agent account with no supplementary groups, and each job gets a fresh kept home',
  { skip: NO_GUEST, timeout: 30_000 }, t => {
    const account = `m.pwd = types.SimpleNamespace(getpwnam=lambda name: print(name, file=sys.stderr) or types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
os.chown = lambda path, uid, gid, chown=os.chown: print('chown', path, uid, gid, file=sys.stderr) or chown(path, uid, gid)  # a no-op for the owner
`;
    const run = bridgeJob(Buffer.concat([jobFrame(JOB), jobFrame(QA_JOB)]), { setup: account, seams: '', runs: 2 });
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    const calls = String(run.stdout).trim().split('\n').map(line => JSON.parse(line));
    const uid = process.getuid();
    assert.equal(calls.length, 2);
    const chowned = calls.map(call => `moe-agent\nchown ${call[6].env.HOME} ${uid} ${process.getgid()}\n`).join('');
    assert.deepEqual([run.status, String(run.stderr)], [42, chowned]);
    for (const [index, { cli, role, credential }] of [JOB, QA_JOB].entries()) {
      const [argv, outFd, inFd, socket, agentUid, realPeer, job] = calls[index];
      const home = job.env.HOME;
      assert.deepEqual([argv, outFd, inFd, socket, agentUid, realPeer], [launchArgv(cli, role, home), 1, 0, '/run/moe/agent.sock', uid, true]);
      assert.deepEqual(job, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, USER: 'moe-agent', LOGNAME: 'moe-agent', LANG: 'C.UTF-8',
        MOE_ROLE: role, [credential.name]: SECRET, ...(cli === 'codex' ? { CODEX_HOME: join(home, '.codex') } : {}) },
      spawn: { user: uid, group: process.getgid(), extra_groups: [], umask: 0o077, cwd: join(run.dir, 'ws') } });
      assert.equal(dirname(home), run.sessions);
      const info = statSync(home);
      assert.deepEqual([info.isDirectory(), info.mode & 0o7777, info.uid], [true, 0o700, uid]);
    }
    assert.notEqual(calls[0][6].env.HOME, calls[1][6].env.HOME);
    assert.deepEqual(run.homes.map(name => join(run.sessions, name)).sort(), calls.map(call => call[6].env.HOME).sort());
    assert.equal(statSync(run.sessions).mode & 0o7777, 0o711);
    const refusals = [['def gone(name):\n    raise KeyError(name)\nm.pwd = types.SimpleNamespace(getpwnam=gone)\n', ''],
      ['os.mkdir(sessions)\nos.chmod(sessions, 0o730)\n', OWN], ['os.mkdir(sessions)\nos.chmod(sessions, 0o703)\n', OWN],
      ["os.mkdir(sessions + '.real')\nos.symlink(sessions + '.real', sessions)\n", OWN]];
    for (const [setup, seams] of refusals) {
      const refused = bridgeJob(jobFrame(JOB), { setup, seams });
      t.after(() => rmSync(refused.dir, { recursive: true, force: true }));
      assert.deepEqual([refused.status, refused.stdout.length, refused.stderr.length, refused.homes ?? []], [71, 0, 0, []], `${setup} ${refused.stderr}`);
    }
  });

// The probe job reports what it was given. The harness is the supervisor: it moves stdin into a pipe whose write end it
// keeps, so relay() sees no host EOF, and the job frame, credential included, never enters its argv.
const PROBE = `import json, os
def parent(pid):
    return int(open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()[1])
def cmdline(pid):
    return open('/proc/%d/cmdline' % pid, 'rb').read().decode('latin1')
environ = open('/proc/self/environ', 'rb').read().decode().split('\\0')
status = open('/proc/self/status').read().splitlines()
print(json.dumps({'env': dict(entry.split('=', 1) for entry in environ if entry), 'cwd': os.getcwd(), 'umask': os.umask(0),
                  'nnp': [line for line in status if line.startswith('NoNewPrivs:')],
                  'cmdlines': [cmdline(pid) for pid in (os.getpid(), os.getppid(), parent(os.getppid()))]}))
`;
const HELD = groups => `data = b''.join(iter(lambda: os.read(0, 65536), b''))
r, w = os.pipe()
os.write(w, data)
os.dup2(r, 0)
probe = os.path.join(base, 'probe')
with open(probe, 'w') as f:
    f.write('#!%s -I\\n%s' % (sys.executable, sys.argv[4]))
os.chmod(probe, 0o700)
jobs = {cli: (probe, names) for cli, (_, names) in m.JOBS.items()}
sys.exit(m.main(['bridge'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, identity=(os.getuid(), os.getgid(), ${groups}),
                jobs=jobs, agent_socket=None))
`;

test('J4 the job gets exactly the allowlisted environment and its one credential, the workspace, umask 077 and NoNewPrivs, and no argv holds the credential',
  { skip: NO_GUEST || (process.platform !== 'linux' && 'the job probes read /proc'), timeout: 30_000 }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-r10b-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const held = (name, groups, input) => spawnSync('python3', ['-I', '-B', '-c', `${LOAD}${JOB_DIRS}${HELD(groups)}`, SUPERVISOR, join(dir, name), 'ws', PROBE],
      { input, maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
    const { exit, stdout } = session(held('kept', 'None', jobFrame(QA_JOB)));
    assert.deepEqual(exit, EXIT);
    const probe = JSON.parse(stdout);
    const homes = readdirSync(join(dir, 'kept', 'sessions'));
    assert.equal(homes.length, 1);
    assert.deepEqual(probe.env, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(dir, 'kept', 'sessions', homes[0]), USER: 'moe-agent',
      LOGNAME: 'moe-agent', LANG: 'C.UTF-8', MOE_ROLE: 'qa', CODEX_API_KEY: SECRET, CODEX_HOME: join(dir, 'kept', 'sessions', homes[0], '.codex') });
    assert.deepEqual([probe.cwd, probe.umask, probe.nnp], [realpathSync(join(dir, 'kept', 'ws')), 0o077, ['NoNewPrivs:\t1']]);
    assert.ok(probe.cmdlines[1].includes('\0-c\0import json, os, resource, signal'), 'the parent is the guard');
    assert.ok(probe.cmdlines[2].includes(`\0${SUPERVISOR}\0`), 'the grandparent is the supervisor');
    assert.deepEqual(probe.cmdlines.filter(line => line.includes(SECRET)), []);
    if (process.getuid() !== 0) { // setgroups needs root: a guard that applies extra_groups [] cannot start the job
      const groups = held('dropped', '[]', jobFrame(JOB));
      assert.equal(groups.status, 71, String(groups.stderr));
      assert.deepEqual(decodeAll([groups.stdout]).map(parseGuestFrame), [HELLO]);
    }
  });

// CQ-R10d4: launch only fixed, headless CLI argv and a private, per-job MCP configuration.
test('LA1 each CLI and role gets the exact fixed headless argv, never a credential or resume token', { skip: NO_GUEST }, t => {
  for (const cli of ['claude', 'codex']) for (const role of ['worker', 'qa']) {
    const frame = { ...(cli === 'claude' ? JOB : QA_JOB), role };
    const run = bridgeJob(jobFrame(frame));
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    assert.equal(run.status, 42, String(run.stderr));
    const [argv, , , , , , job] = JSON.parse(run.stdout);
    assert.deepEqual(argv, launchArgv(cli, role, job.env.HOME));
    assert.equal(argv.some(arg => /^(--resume|--continue|resume)/.test(arg) || arg.includes(SECRET)), false);
    assert.ok(LA_PROMPTS[role].startsWith('Call moe.get_context for your assigned task first.'));
    assert.notEqual(LA_PROMPTS.worker, LA_PROMPTS.qa);
  }
});

test('LA2 only the shim config exists in the fresh home, with private modes and agent ownership', { skip: NO_GUEST }, t => {
  // As a non-root test the real fchown is a no-op, so a spy proves each created entry is handed to the job uid and gid.
  const chowns = "os.fchown = lambda fd, uid, gid, chown=os.fchown: print('fchown', uid, gid, file=sys.stderr) or chown(fd, uid, gid)\n";
  for (const frame of [JOB, QA_JOB]) {
    const run = bridgeJob(jobFrame(frame), { setup: chowns });
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    const paths = frame.cli === 'claude' ? ['.moe-mcp.json'] : ['.codex', '.codex/config.toml'];
    assert.deepEqual([run.status, String(run.stderr)], [42, `fchown ${process.getuid()} ${process.getgid()}\n`.repeat(paths.length)]);
    const job = JSON.parse(run.stdout)[6], home = job.env.HOME;
    assert.equal(dirname(home), run.sessions);
    assert.deepEqual(readdirSync(home), [paths[0]]);
    if (frame.cli === 'codex') {
      assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml']);
      assert.equal(job.env.CODEX_HOME, join(home, '.codex'));
    }
    for (const path of ['', ...paths]) {
      const info = statSync(join(home, path));
      assert.deepEqual([info.mode & 0o7777, info.uid, info.gid], [info.isDirectory() ? 0o700 : 0o600, process.getuid(), process.getgid()]);
    }
    const text = readFileSync(join(home, paths.at(-1)), 'utf8');
    if (frame.cli === 'claude') assert.deepEqual(JSON.parse(text), JSON.parse(LA_CONFIG.claude));
    else {
      assert.equal(text, LA_CONFIG.codex);
      // codex hands its MCP server only the variables named here: exactly the role, never the credential, no env table.
      assert.deepEqual(text.split('\n').filter(line => line.startsWith('env_vars')), ['env_vars = ["MOE_ROLE"]']);
      assert.equal(/^env\s*=/m.test(text) || text.includes('CODEX_API_KEY'), false);
    }
    assert.equal(text.includes(SECRET), false);
  }
});

test('LA2 pre-existing config entries or a failed config write refuse before relay without following links', { skip: NO_GUEST }, t => {
  for (const frame of [JOB, QA_JOB]) for (const planted of ['symlink', 'file', 'directory', 'write-error']) {
    const setup = `original = m.session_home
def planted_home(*args):
    home = original(*args)
    target = os.path.join(base, 'untouched')
    with open(target, 'w') as f: f.write('original')
    path = os.path.join(home, ${JSON.stringify(frame.cli === 'claude' ? '.moe-mcp.json' : '.codex/config.toml')})
    if ${JSON.stringify(frame.cli)} == 'codex': os.mkdir(os.path.dirname(path), 0o700)
    if ${JSON.stringify(planted)} == 'symlink': os.symlink(target, path)
    elif ${JSON.stringify(planted)} == 'file': open(path, 'w').close()
    elif ${JSON.stringify(planted)} == 'directory': os.mkdir(path)
    else:
        def fail(*args): raise OSError('private failure')
        m.write_all = fail
    return home
m.session_home = planted_home
`;
    const run = bridgeJob(jobFrame(frame), { setup });
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    assert.deepEqual([run.status, run.stdout.length, run.stderr.length], [71, 0, 0], `${frame.cli} ${planted} ${run.stderr}`);
    assert.equal(readFileSync(join(run.dir, 'untouched'), 'utf8'), 'original');
  }
});

// Pinned codex 0.166 exec loads <workspace>/.codex/config.toml (MCP servers, providers) even with a fresh CODEX_HOME and
// no trusted project (probed with the pinned member), so a candidate tree holding any `.codex` entry is refused before
// a home exists. claude's --strict-mcp-config already ignores every workspace MCP file (probed against pinned 2.1.308).
test('LA6 a codex job refuses a workspace holding any .codex entry with no frame, home or job; claude is unaffected', { skip: NO_GUEST }, t => {
  for (const planted of ['directory', 'config', 'file', 'dangling symlink']) for (const frame of [JOB, QA_JOB]) {
    const setup = `path = os.path.join(workspace, '.codex')
if ${JSON.stringify(planted)} in ('directory', 'config'): os.mkdir(path)
if ${JSON.stringify(planted)} == 'config': open(os.path.join(path, 'config.toml'), 'w').write('[mcp_servers.evil]\\ncommand = "/bin/true"\\n')
elif ${JSON.stringify(planted)} == 'file': open(path, 'w').close()
elif ${JSON.stringify(planted)} == 'dangling symlink': os.symlink('absent', path)
`;
    const run = bridgeJob(jobFrame(frame), { setup });
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    const refused = frame.cli === 'codex';
    assert.deepEqual([run.status, run.stdout.length > 0, run.stderr.length, run.homes?.length ?? 0], refused ? [65, false, 0, 0] : [42, true, 0, 1],
      `${frame.cli} ${planted} ${run.stderr}`);
  }
});

test('LA3 real probe through main sees its headless argv, workspace and exact session config bytes', { skip: NO_GUEST }, t => {
  const probe = `import json, os, sys
home = os.environ['HOME']
configs = {path: open(os.path.join(home, path)).read() for path in ('.moe-mcp.json', '.codex/config.toml') if os.path.exists(os.path.join(home, path))}
print(json.dumps({'argv': sys.argv, 'cwd': os.getcwd(), 'home': home, 'configs': configs}))
`;
  for (const frame of [JOB, QA_JOB]) {
    const dir = mkdtempSync(join(tmpdir(), 'moe-launch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const run = spawnSync('python3', ['-I', '-B', '-c', `${LOAD}${JOB_DIRS}${HELD('None')}`, SUPERVISOR, dir, 'ws', probe],
      { input: jobFrame(frame), timeout: 30_000 });
    const result = session(run);
    assert.deepEqual(result.exit, EXIT, String(run.stderr));
    const observed = JSON.parse(result.stdout), path = frame.cli === 'claude' ? '.moe-mcp.json' : '.codex/config.toml';
    assert.deepEqual(observed.argv, launchArgv(frame.cli, frame.role, observed.home, join(dir, 'probe')));
    assert.equal(observed.cwd, realpathSync(join(dir, 'ws'))); // getcwd() is a realpath: macOS's tmpdir is under /private
    assert.deepEqual(Object.keys(observed.configs), [path]);
    if (frame.cli === 'claude') assert.deepEqual(JSON.parse(observed.configs[path]), JSON.parse(LA_CONFIG.claude));
    else assert.equal(observed.configs[path], LA_CONFIG.codex);
  }
});

test('LA4 launch keys, exact prompts and shim path mirror the protected tables', { skip: NO_GUEST }, () => {
  const run = harness("print(json.dumps([sorted(m.LAUNCH), sorted(m.JOBS), sorted(m.PROMPTS), sorted(m.JOB_ROLES), m.SHIM, m.PROMPTS]))");
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(JSON.parse(run.stdout), [['claude', 'codex'], ['claude', 'codex'], ['qa', 'worker'], ['qa', 'worker'], GUEST_LAYOUT.shim, LA_PROMPTS]);
});

// Opt-in (needs the 319 MB pinned member, see agent-binaries.json): codex 0.166 starts a stdio MCP server with only
// HOME/PATH/LC_CTYPE, so the role reaches the real shim only through env_vars. A recorder stands in for the shim.
const PINNED_CODEX = process.env.MOE_PINNED_CODEX;
const LA5_SKIP = process.platform !== 'linux' ? 'pinned codex runs only on Linux'
  : !PINNED_CODEX ? 'set MOE_PINNED_CODEX to the pinned codex member to run this row' : false;
const RECORDER = `#!/usr/bin/env python3
import json, os, sys
json.dump(dict(os.environ), open(sys.argv[1], 'w'))
for line in sys.stdin:
    message = json.loads(line)
    if 'id' in message:
        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'recorder', 'version': '1'}} if message.get('method') == 'initialize' else {'tools': []}
        print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
`;
test('LA5 pinned codex forwards exactly MOE_ROLE to its MCP server', { skip: LA5_SKIP }, t => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pinned = JSON.parse(readFileSync(new URL('../local-runner/agent-binaries.json', import.meta.url), 'utf8')).binaries.codex[arch].memberSha256;
  assert.equal(createHash('sha256').update(readFileSync(PINNED_CODEX)).digest('hex'), pinned, 'MOE_PINNED_CODEX is not the pinned codex member');
  for (const role of ['worker', 'qa']) {
    const dir = mkdtempSync(join(tmpdir(), 'moe-la5-'));
    try {
      const home = join(dir, 'home'), ws = join(dir, 'ws'), marker = join(dir, 'env.json'), recorder = join(dir, 'recorder.py');
      mkdirSync(join(home, '.codex'), { recursive: true });
      mkdirSync(ws);
      writeFileSync(recorder, RECORDER);
      chmodSync(recorder, 0o700);
      const parts = LA_CONFIG.codex.split('"/opt/moe/bin/moe-mcp-shim"');
      assert.equal(parts.length, 2, 'exactly one shim path to replace');
      writeFileSync(join(home, '.codex', 'config.toml'), parts.join(`"${recorder}"\nargs = ["${marker}"]`));
      // The model call fails by design (unreachable base URL), so codex's exit code is not asserted.
      spawnSync(PINNED_CODEX, ['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', LA_PROMPTS[role]], {
        cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL',
        env: { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: '/usr/bin:/bin', MOE_ROLE: role, CODEX_API_KEY: SECRET, OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' } });
      assert.ok(existsSync(marker), `${role}: codex never started the MCP server`);
      const env = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(env.MOE_ROLE, role);
      assert.equal(Object.keys(env).includes('CODEX_API_KEY') || Object.values(env).some(value => value.includes(SECRET)), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// CQ-R10c: the host's job frame is the first stdin write of every session, and endAgentJobs proves the end of the guest
// job only from a pgrep count it observed. KEY holds 'secret', so rejectsWith also proves that no error echoes it.
test('B16 jobFrame encodes exactly the CQ-R10b job frame and refuses any other job without echoing the credential', () => {
  assert.ok([AGENT_JOBS, ...Object.values(AGENT_JOBS)].every(Object.isFrozen));
  const credential = { name: 'CODEX_API_KEY', value: `!${'x'.repeat(4094)}~` };
  assert.deepEqual(hostJobFrame({ cli: 'codex', role: 'qa', credential }),
    framed(JSON.stringify({ kind: 'job', version: 1, cli: 'codex', role: 'qa', credential })));
  const job = { cli: 'claude', role: 'worker', credential: HOST_JOB.credential };
  const valued = value => ({ ...job, credential: { ...job.credential, value } });
  const hidden = Object.defineProperty({ value: KEY, extra: 1 }, 'name', { value: 'ANTHROPIC_API_KEY', enumerable: false });
  const throwing = { name: 'ANTHROPIC_API_KEY', get value() { throw new Error(KEY); } };
  const invalid = [null, [], { ...job, extra: 1 }, { cli: 'claude', role: 'worker' }, ...['gemini', 'constructor'].map(cli => ({ ...job, cli })),
    { ...job, role: 'architect' }, ...['x', { ...job.credential, extra: 1 }, hidden, throwing].map(value => ({ ...job, credential: value })),
    { ...job, credential: { ...job.credential, name: 'OPENAI_API_KEY' } }, ...['', 'a b', 'x\n', 'a\x7f', 'café', 'x'.repeat(4097), 7].map(valued)];
  for (const input of invalid) {
    assert.throws(() => hostJobFrame(input), error => error?.code === 'BRIDGE_INPUT_INVALID' && !/secret/.test(error.message), String(input?.cli));
  }
});

test('B17 AGENT_JOBS is the guest supervisor job table', { skip: NO_GUEST }, () => {
  const run = harness('print(json.dumps({cli: list(names) for cli, (_, names) in m.JOBS.items()}))');
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(JSON.parse(run.stdout), AGENT_JOBS);
});

const QA_HOST_JOB = Object.freeze({ cli: 'codex', credential: Object.freeze({ name: 'CODEX_API_KEY', value: KEY }) });

test('H6 the job frame is the first stdin write, bounded, with the binding role, and the credential reaches nothing else', { timeout: 30_000 }, async () => {
  for (const [binding, job] of [[BINDING, HOST_JOB], [QA, QA_HOST_JOB]]) {
    const caller = { ...job, credential: { ...job.credential } };
    const proc = fakeProvider();
    const run = openSession(proc, { binding, job: caller });
    Object.assign(caller.credential, { name: 'OPENAI_API_KEY', value: 'changed' }); // encoded once, before spawn
    const result = await exchange(proc, run, [REQUEST], 1);
    assert.deepEqual(proc.job, hostJobFrame({ cli: job.cli, role: binding.role, credential: job.credential }));
    assert.deepEqual([proc.calls, proc.replies()], [[SPAWNED], [answered(1, 'moe.get_context')]]);
    assert.equal(JSON.stringify([proc.calls, run.outputs, run.forwarded, result]).includes(KEY), false);
  }
  // Hello has arrived, so only the job write's own bound is left.
  for (const [code, first] of [['SESSION_TIMEOUT', () => {}], ['SESSION_PROVIDER_FAILED', (chunk, done) => done(new Error(KEY))]]) {
    const proc = fakeProvider({ first });
    const run = openSession(proc, { timeoutMs: 100 });
    proc.send(HELLO);
    await rejectsWith(run.promise, code, code);
    assert.deepEqual([run.forwarded, proc.written], [[], []]);
  }
  // A job write that throws fails the session, even when the guest then ends cleanly.
  const broken = fakeProvider();
  broken.stdin.write = () => { throw new Error(KEY); };
  const brokenRun = openSession(broken);
  broken.send(HELLO, EXIT);
  broken.exit(0);
  await rejectsWith(brokenRun.promise, 'SESSION_PROVIDER_FAILED');
  assert.deepEqual(brokenRun.observations, []);
  for (const job of [undefined, null, { cli: 'claude' }, { ...HOST_JOB, role: 'worker' }, { cli: 'codex', credential: HOST_JOB.credential },
    { ...HOST_JOB, credential: { ...HOST_JOB.credential, value: 'a b' } }]) {
    const proc = fakeProvider();
    const run = openSession(proc, { job });
    await rejectsWith(run.promise, 'SESSION_INPUT_INVALID', String(job?.cli));
    assert.deepEqual([proc.calls.length, run.forwarded.length], [0, 0]);
  }
});

// CQ-R10c end to end through R10b's main(): the probe is the job's agent CLI. Its argv is the executable alone, so the
// socket path is baked in. It reports its role, its env beyond the fixed keys and each credential's sha256, never a value.
// On macOS, CoreFoundation sets __CF_USER_TEXT_ENCODING in every process it loads into, this python3 included.
const PROBE_AGENT = `import hashlib, json, os, socket, struct
s = socket.socket(socket.AF_UNIX)
s.connect(SOCKET)
body = json.dumps({'kind': 'request', 'id': 1, 'tool': 'moe.get_context', 'args': {}}).encode()
s.sendall(struct.pack('>I', len(body)) + body)
f = s.makefile('rb')
answer = json.loads(f.read(struct.unpack('>I', f.read(4))[0]))
names = sorted(set(os.environ) - {'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'MOE_ROLE', 'CODEX_HOME'${process.platform === 'darwin' ? ", '__CF_USER_TEXT_ENCODING'" : ''}})
print(json.dumps({'role': os.environ['MOE_ROLE'], 'names': names, 'sha': [hashlib.sha256(os.environ[name].encode()).hexdigest() for name in names],
                  'answer': answer}))
`;
function bridgeMain() {
  const host = { launches: [] };
  host.spawn = (executable, argv, options) => {
    host.launches.push([executable, argv, options]);
    host.socket = join(mkdtempSync(join(tmpdir(), 'moe-r10c-')), 'agent.sock');
    const code = `${LOAD}base = os.path.dirname(sys.argv[2])
probe = os.path.join(base, 'probe')
with open(probe, 'w') as f:
    f.write('#!%s -I\\nSOCKET = %r\\n%s' % (sys.executable, sys.argv[2], sys.argv[3]))
os.chmod(probe, 0o700)
os.mkdir(os.path.join(base, 'ws'))
jobs = {cli: (probe, names) for cli, (_, names) in m.JOBS.items()}
sys.exit(m.main(['bridge'], geteuid=lambda: 0, workspace=os.path.join(base, 'ws'), sessions=os.path.join(base, 'sessions'),
                identity=(os.getuid(), os.getgid(), None), jobs=jobs, agent_socket=sys.argv[2]${PEER}))
`;
    host.proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, host.socket, PROBE_AGENT], options);
    sessions.push(host);
    return host.proc;
  };
  return host;
}

test('H7 end to end, main() starts the job with exactly the frame credential and the binding role, and get_context carries only the host sessionId',
  { skip: NO_GUEST, timeout: 30_000 }, async () => {
    const host = bridgeMain();
    const run = openSession(host, { binding: QA, job: QA_HOST_JOB, timeoutMs: 10_000 });
    assert.deepEqual(await run.promise, { observation: EXIT, executionReady: false });
    const bytes = stream => Buffer.concat(run.outputs.filter(([name]) => name === stream).map(([, data]) => data));
    assert.deepEqual(JSON.parse(bytes('stdout')), { role: 'qa', names: ['CODEX_API_KEY'], sha: [createHash('sha256').update(KEY).digest('hex')],
      answer: answered(1, 'moe.get_context') }, String(bytes('stderr')));
    assert.deepEqual([host.launches, run.forwarded, host.proc.exitCode],
      [[SPAWNED], [['moe.get_context', { taskId: 'task-abc', workerId: 'qa-1', sessionId: SESSION_ID }]], 0]);
    assert.equal(JSON.stringify(host.launches).includes(KEY) || Buffer.concat(run.outputs.map(([, data]) => data)).includes(KEY), false);
  });

// A scripted run stands in for lifecycle's execFile: a resolved call is exit 0, a rejection carries the remote exit code
// (execFile's error.code) unless it was killed, and anything else is a transport failure.
const remote = (code, stdout = '') => (code === 0 ? { stdout, stderr: '' } : Object.assign(new Error(KEY), { code, killed: false, stdout, stderr: '' }));
const TIMED_OUT = Object.assign(new Error(KEY), { code: null, killed: true, signal: 'SIGKILL', stdout: '0\n' });
const MISSING = Object.assign(new Error(KEY), { code: 'ENOENT' });

test('H8 endAgentJobs reports verified only on an observed pgrep count of 0, retries a live job and fails closed otherwise', { timeout: 30_000 }, async () => {
  const exec = argv => ['exec', '--no-map-working-directory', NAME, '--', 'sudo', '-n', ...argv];
  const [pkill, pgrep] = [exec(['pkill', '-KILL', '-U', 'moe-agent']), exec(['pgrep', '-c', '-U', 'moe-agent'])];
  const thrown = () => { throw new Error(KEY); };
  // Each row is [results, verified]. Every result is consumed, so the calls alternate pkill and pgrep, one per result.
  const rows = [[[remote(0), remote(1, '0\n')], true], [[remote(1), remote(1, '0\r\n')], true], [[remote(255), remote(1, '0\n')], true],
    [[remote(0), remote(0, '2\n'), remote(0), remote(1, '0\n')], true], [Array(3).fill([remote(0), remote(0, '1\n')]).flat(), false],
    [[remote(1), remote(1)], false], [[remote(0), remote(1, '0\n\n')], false], [[remote(0), remote(1, ' 0\n')], false],
    [[remote(0), remote(2, '0\n')], false], [[remote(0), TIMED_OUT], false], [[remote(0), thrown], false], [[remote(0), MISSING], false],
    [[MISSING], false], [[TIMED_OUT], false], [[thrown], false]];
  for (const [index, [results, verified]] of rows.entries()) {
    const calls = [];
    const slept = [];
    const run = (executable, args, options) => {
      calls.push([executable, args, options]);
      const result = results[calls.length - 1];
      if (typeof result === 'function') return result(); // a synchronous throw
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    };
    const result = await endAgentJobs(NAME, { run }, { sleep: async ms => { slept.push(ms); }, delayMs: 7 });
    const label = `row ${index}`;
    assert.ok(Object.isFrozen(result), label);
    assert.deepEqual(result, { verified }, label);
    assert.deepEqual(calls.map(([, args]) => args), results.map((_, call) => (call % 2 ? pgrep : pkill)), label);
    for (const [executable, , options] of calls) {
      assert.deepEqual([executable, options.shell, options.timeout, options.killSignal], ['multipass', false, QUERY_TIMEOUT_MS, 'SIGKILL'], label);
    }
    assert.deepEqual(slept, Array(Math.ceil(results.length / 2) - 1).fill(7), label);
  }
  // Only a full count of rounds is tried, and an unset sleep waits for real between them.
  const live = [];
  const started = Date.now();
  assert.deepEqual(await endAgentJobs(NAME, { run: async (...call) => { live.push(call); return remote(0, '1\n'); } }, { rounds: 2, delayMs: 50 }),
    { verified: false });
  assert.deepEqual([live.length, Date.now() - started >= 45], [4, true]);
  const never = async () => { throw new Error('never run'); };
  for (const [name, provider, options] of [['primary', { run: never }, {}], [NAME, null, {}], [NAME, { run: 'run' }, {}],
    [NAME, { run: never, executable: ' ' }, {}], ...[0, 11, 1.5, '3'].map(rounds => [NAME, { run: never }, { rounds }]),
    ...[-1, 60_001, 0.5].map(delayMs => [NAME, { run: never }, { delayMs }]), ...[null, 'sleep'].map(sleep => [NAME, { run: never }, { sleep }]),
    [NAME, { run: never }, null]]) {
    await rejectsWith(endAgentJobs(name, provider, options), 'SESSION_INPUT_INVALID', JSON.stringify([name, options]));
  }
});

// CQ-R10d end to end: the landed R10d slices compose. A fake CLI is installed by the real agents mode, started by the real
// bridge job from its own session config, and reaches the host only through the real shim and the agent socket. These are
// local processes: not a live VM, a real CLI, isolation or verified-local.
const SHIM_FILE = fileURLToPath(new URL('../local-runner/guest-mcp-shim.py', import.meta.url));
const TOOLS_FILE = fileURLToPath(new URL('../local-runner/guest-mcp-tools.json', import.meta.url));
const NO_TOMLLIB = NO_GUEST || (spawnSync('python3', ['-I', '-c', 'import tomllib']).status !== 0
  && 'the fake codex reads config.toml with tomllib (python3 >= 3.11)');
const UPSTREAM = 'upstream-marker-R10d-7f3a';
const TABLE = JSON.parse(readFileSync(TOOLS_FILE, 'utf8'));
// The fake knows only what a real CLI knows: its argv, its session config and the shim command that config names. It
// sends one request and reads its reply before the next, because the shim drops pending calls at stdin EOF.
const FAKE_CLI = `import json, os, signal, subprocess, sys
signal.alarm(20)
cli = os.path.basename(sys.argv[0])
record = {'cli': cli, 'argv': sys.argv, 'cwd': os.getcwd(), 'home': os.environ['HOME'], 'config': None, 'replies': [], 'shim': None}
try:
    if cli == 'claude':
        with open(sys.argv[sys.argv.index('--mcp-config') + 1]) as file:
            record['config'] = json.load(file)
        servers, env = record['config']['mcpServers'], dict(os.environ)
    else:
        import tomllib
        with open(os.path.join(os.environ['CODEX_HOME'], 'config.toml'), 'rb') as file:
            record['config'] = tomllib.load(file)
        servers = record['config']['mcp_servers']
        env = None
    (server,) = servers.values()
    if server['command'] == ${JSON.stringify(GUEST_LAYOUT.shim)} and 'args' not in server:
        if env is None:  # codex gives an MCP server only HOME, PATH and the names its env_vars lists
            env = {name: os.environ[name] for name in ('HOME', 'PATH', *server.get('env_vars', [])) if name in os.environ}
        shim = subprocess.Popen([os.path.join(os.path.dirname(os.path.dirname(sys.argv[0])), 'moe-mcp-shim')],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True)
        other = {'worker': 'moe.qa_approve', 'qa': 'moe.complete_task'}[os.environ['MOE_ROLE']]
        def send(message, replied=True):
            print(json.dumps({'jsonrpc': '2.0', **message}), file=shim.stdin, flush=True)
            if replied:
                record['replies'].append(json.loads(shim.stdout.readline()))
        def tool(id, name, arguments):
            send({'id': id, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}})
        send({'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'fake', 'version': '1'}}})
        send({'method': 'notifications/initialized'}, False)
        send({'id': 2, 'method': 'tools/list'})
        tool(3, 'moe.get_context', {})
        tool(4, other, {})
        tool(5, 'moe.add_comment', {'content': 'e2e', 'workerId': 'someone-else'})
        tool(6, 'moe.add_comment', {'content': 'e2e'})
        shim.stdin.close()
        record['shim'] = shim.wait()
finally:
    print(json.dumps(record))
`;
const agentFrames = (cli, bytes, digest = createHash('sha256').update(bytes).digest('hex')) =>
  [{ kind: 'agent', cli, size: bytes.length, sha256: digest }, { kind: 'data', data: bytes.toString('base64') }];
// The real agents mode, as the current user, into <base>/agents.
const installFakes = (base, frames) => spawnSync('python3', ['-I', '-B', '-c', `${LOAD}sys.exit(m.install_agents(0, 1, sys.argv[2], (os.getuid(), os.getgid())))`,
  SUPERVISOR, join(base, 'agents')], { input: Buffer.concat([...frames, { kind: 'end' }].map(frame => encodeFrame(frame, MAX_HOST_FRAME_BYTES))),
  maxBuffer: 64 << 20, timeout: 30_000 });
// The local stand-in for /opt/moe/bin/moe-mcp-shim: the shipped shim, with the socket and table paths moved under <base>. It
// reports the NAMES of its environment on stderr, never a value.
function standIn(base, python) {
  const file = join(base, 'moe-mcp-shim');
  writeFileSync(file, `#!${python} -IB
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('moe_shim', ${JSON.stringify(SHIM_FILE)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.AGENT_SOCKET = ${JSON.stringify(join(base, 'agent.sock'))}
m.TOOLS_PATH = ${JSON.stringify(TOOLS_FILE)}
print(json.dumps({'role': os.environ.get('MOE_ROLE'), 'env': sorted(os.environ)}), file=sys.stderr, flush=True)
sys.exit(m.main())
`);
  chmodSync(file, 0o700);
}
// bridgeMain's shape, with every JOBS executable re-rooted under <base>/agents at its path below AGENTS, so a job runs the
// very file agents mode installed.
function agentMain(base) {
  const host = { launches: [], socket: join(base, 'agent.sock') };
  host.spawn = (executable, argv, options) => {
    host.launches.push([executable, argv, options]);
    const code = `${LOAD}base = os.path.dirname(sys.argv[2])
os.mkdir(os.path.join(base, 'ws'))
jobs = {cli: (os.path.join(base, 'agents', os.path.relpath(exe, m.AGENTS)), names) for cli, (exe, names) in m.JOBS.items()}
sys.exit(m.main(['bridge'], geteuid=lambda: 0, workspace=os.path.join(base, 'ws'), sessions=os.path.join(base, 'sessions'),
                identity=(os.getuid(), os.getgid(), None), jobs=jobs, agent_socket=sys.argv[2]${PEER}))
`;
    host.proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, host.socket], options);
    sessions.push(host);
    return host.proc;
  };
  return host;
}
const outputText = (run, stream) => Buffer.concat(run.outputs.filter(([name]) => name === stream).map(([, data]) => data));
const pythonPath = () => spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();

test('AE1 end to end, each installed CLI starts headless from its session config and reaches Moe only through the shim and the agent socket',
  { skip: NO_TOMLLIB, timeout: 60_000 }, async t => {
    const python = pythonPath();
    const fake = Buffer.from(`#!${python} -I\n${FAKE_CLI}`);
    for (const [binding, job] of [[BINDING, HOST_JOB], [QA, HOST_JOB], [BINDING, QA_HOST_JOB], [QA, QA_HOST_JOB]]) {
      const label = `${job.cli}/${binding.role}`;
      const base = mkdtempSync(join(tmpdir(), 'moe-r10d-'));
      t.after(() => rmSync(base, { recursive: true, force: true }));
      const install = installFakes(base, AGENT_CLIS.flatMap(cli => agentFrames(cli, fake)));
      assert.equal(install.status, 0, `${label} ${install.stderr}`);
      assert.deepEqual(createFrameDecoder(MAX_HOST_FRAME_BYTES).push(install.stdout), [{ kind: 'installed', count: 2 }], label);
      for (const cli of AGENT_CLIS) {
        assert.equal(statSync(join(base, 'agents', cli)).mode & 0o777, 0o555, `${label} ${cli}`);
        assert.deepEqual(readFileSync(join(base, 'agents', cli)), fake, `${label} ${cli}`);
      }
      standIn(base, python);
      const host = agentMain(base);
      const run = openSession(host, { binding, job, timeoutMs: 10_000, answer: tool => {
        if (tool === 'moe.add_comment') throw new Error(UPSTREAM);
        return { content: [{ type: 'text', text: tool }] };
      } });
      assert.deepEqual(await run.promise, { observation: EXIT, executionReady: false }, `${label} ${outputText(run, 'stderr')}`);
      assert.deepEqual([host.launches, host.proc.exitCode], [[SPAWNED], 0], label);
      const report = JSON.parse(outputText(run, 'stdout'));
      const config = job.cli === 'claude' ? { mcpServers: { moe: { command: GUEST_LAYOUT.shim } } }
        : { mcp_servers: { moe: { command: GUEST_LAYOUT.shim, env_vars: ['MOE_ROLE'], default_tools_approval_mode: 'approve' } } };
      assert.deepEqual([report.argv, report.cwd, report.config, report.shim],
        [launchArgv(job.cli, binding.role, report.home, join(base, 'agents', job.cli)), realpathSync(join(base, 'ws')), config, 0], label);
      const tools = Object.entries(TABLE[binding.role]).map(([name, properties]) => ({ name, inputSchema: { type: 'object', properties, additionalProperties: false } }));
      assert.deepEqual(tools.map(tool => tool.name), Object.keys(TOOLS[binding.role]), label);
      const rpc = (id, body) => ({ jsonrpc: '2.0', id, ...body });
      assert.deepEqual([report.replies[0].id, report.replies[0].result.protocolVersion], [1, '2025-06-18'], label);
      assert.deepEqual(report.replies.slice(1), [rpc(2, { result: { tools } }),
        rpc(3, { result: { content: [{ type: 'text', text: 'moe.get_context' }] } }),
        rpc(4, { error: { code: -32602, message: 'Tool not available to this role.' } }),
        rpc(5, { error: { code: -32602, message: 'Argument not allowed for this tool.' } }),
        rpc(6, { error: { code: -32004, message: 'Moe refused the tool call.', data: { code: 'BRIDGE_UPSTREAM_FAILED' } } })], label);
      // Only the allowed calls reached the host, each stamped with the binding.
      assert.deepEqual(run.forwarded, [['moe.get_context', { taskId: 'task-abc', workerId: binding.workerId, sessionId: SESSION_ID }],
        ['moe.add_comment', { content: 'e2e', taskId: 'task-abc', workerId: binding.workerId }]], label);
      // The stand-in wrote exactly one stderr line: pin names, because PEP 538 adds LC_CTYPE to a python child without LANG.
      const stderr = outputText(run, 'stderr').toString();
      assert.ok(stderr.endsWith('\n') && !stderr.slice(0, -1).includes('\n'), `${label} ${stderr}`);
      const seen = JSON.parse(stderr);
      assert.ok(seen.role === binding.role && seen.env.includes('MOE_ROLE'), label);
      if (job.cli === 'codex') assert.deepEqual(seen.env.filter(name => name === job.credential.name || name === 'CODEX_HOME'), [], label);
      const everything = Buffer.concat([...run.outputs.map(([, data]) => data), Buffer.from(JSON.stringify([host.launches, run.forwarded, report]))]);
      for (const secret of [KEY, UPSTREAM]) assert.equal(everything.includes(secret), false, `${label} ${secret}`);
    }
  });

test('AE2 a CLI binary that misses its pinned sha256 is never installed, so its job never starts, and JOBS runs only agents-mode paths',
  { skip: NO_GUEST, timeout: 30_000 }, async t => {
    // The host cache's CLI list, agents mode (which installs under AGENTS) and the job table name one set of files.
    const layout = harness('print(json.dumps([m.AGENTS, {cli: exe for cli, (exe, _) in m.JOBS.items()}]))');
    assert.equal(layout.status, 0, String(layout.stderr));
    const [agentsDir, executables] = JSON.parse(layout.stdout);
    assert.deepEqual(executables, Object.fromEntries(AGENT_CLIS.map(cli => [cli, `${agentsDir}/${cli}`])));
    const base = mkdtempSync(join(tmpdir(), 'moe-r10d-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const good = Buffer.from('#!/bin/sh\nexit 0\n');
    // claude's bytes miss their pin by one byte; install_agents is all-or-nothing, so the valid codex binary goes too.
    const install = installFakes(base, [...agentFrames('claude', Buffer.concat([good, Buffer.from('#')]), createHash('sha256').update(good).digest('hex')),
      ...agentFrames('codex', good)]);
    assert.deepEqual([install.status, install.stdout.length, readdirSync(join(base, 'agents'))], [65, 0, []], String(install.stderr));
    // No binary, so the job cannot start: the supervisor says hello, its guard finds nothing to run and it exits EX_OSERR.
    const host = agentMain(base);
    const session = openSession(host, { binding: BINDING, job: HOST_JOB, timeoutMs: 10_000 });
    await rejectsWith(session.promise, 'SESSION_PROVIDER_FAILED');
    assert.deepEqual([session.forwarded, session.observations, session.outputs, host.proc.exitCode], [[], [], [], 71]);
  });

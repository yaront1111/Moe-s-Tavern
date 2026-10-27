import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  MAX_GUEST_FRAME_BYTES, MAX_HOST_FRAME_BYTES, bridgeArgv, createFrameDecoder, encodeFrame, parseGuestFrame, scopeRequest, TOOLS,
} from '../local-runner/guest-bridge.mjs';
import { JOB_IDENTITIES } from '../local-runner/guest-bootstrap.mjs';
import {
  MAX_ARGUMENT_DEPTH, MAX_DAEMON_INFO_BYTES, MAX_PENDING_REQUESTS, MAX_RESPONSE_BYTES, runGuestSession,
} from '../local-runner/guest-session.mjs';
import { ownedInstanceName } from '../local-runner/lifecycle.mjs';

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
  for (const [code, status] of [["['bridge'], geteuid=lambda: 0", 78], ["['relay'], geteuid=lambda: 0", 64], ["['bridge'], geteuid=lambda: 1000", 77]]) {
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
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'moe-r08-'));
after(() => rmSync(DAEMON_DIR, { recursive: true, force: true }));
const daemonFile = (name, info = {}) => {
  writeFileSync(join(DAEMON_DIR, name), typeof info === 'string' ? info : JSON.stringify({ port: 9876, pid: 1, projectPath: '/p', ...info }));
  return join(DAEMON_DIR, name);
};
const DAEMON = daemonFile('daemon.json');
// A surfaced error is a fixed code whose message carries no path and no upstream text.
const rejectsWith = (promise, code, label) => assert.rejects(promise, error => error?.code === code && !/[\\/]|secret/.test(error.message), label);
const nest = depth => Array.from({ length: depth }).reduce(value => [value], 0);
const answered = (id, text) => ({ kind: 'response', id, ok: true, result: { content: [{ type: 'text', text }] } });
const refused = (id, code) => ({ kind: 'response', id, ok: false, error: { code } });

function fakeProvider({ hung = false, write = (chunk, done) => done() } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], kills: [], written: [] });
  proc.stdin = new Writable({ write(chunk, encoding, done) { proc.written.push(chunk); write(chunk, done); } });
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
    name: NAME, binding: BINDING, sessionId: SESSION_ID, daemonInfoPath: DAEMON, provider: { spawn: provider.spawn }, timeoutMs: 1_000,
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

test('H1 invalid input, unsafe daemon info and an aborted signal refuse before spawn', { timeout: 30_000 }, async () => {
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
  for (const daemonInfoPath of [DAEMON, daemonFile('v4.json', { bindHost: '127.0.0.1' }), daemonFile('v6.json', { bindHost: '::1' }),
    daemonFile('edge.json', `{}${' '.repeat(MAX_DAEMON_INFO_BYTES - 2)}`)]) {
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
  const late = Promise.withResolvers();
  const slow = await ends('SESSION_TIMEOUT', { timeoutMs: 100, answer: () => late.promise }, proc => proc.send(HELLO, REQUEST));
  late.resolve({ content: [] }); // too late: never written
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
    const code = `${LOAD}sys.exit(m.relay(['python3', '-I', '-c', *sys.argv[3:]], agent_socket=sys.argv[2], agent_uid=os.getuid()${PEER}))`;
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
async function guarded() {
  const socket = `${mkdtempSync(`${tmpdir()}/moe-r10a-`)}/agent.sock`;
  const code = `${LOAD}r, w = os.pipe()
sys.exit(m.relay(['python3', '-I', '-c', sys.argv[3]], in_fd=r, agent_socket=sys.argv[2], agent_uid=os.getuid()${PEER}))`;
  const proc = spawn('python3', ['-I', '-B', '-c', code, SUPERVISOR, socket, GROUP_JOB], { stdio: ['ignore', 'pipe', 'inherit'] });
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

test('S12 relay() restores SIGTERM, SIGHUP and SIGINT on every exit path, leaves SIGCHLD at SIG_DFL, and its guard is stdlib-only', { skip: NO_GUEST, timeout: 30_000 }, () => {
  // killSignal: this harness keeps a no-op SIGTERM handler, so a default SIGTERM timeout kill would not end it.
  const run = spawnSync('python3', ['-I', '-B', '-c', `${LOAD}import ast, signal
roots = {alias.name.split('.')[0] for node in ast.walk(ast.parse(m.GUARD)) if isinstance(node, ast.Import) for alias in node.names}
assert 'subprocess' in roots and roots <= set(sys.stdlib_module_names), roots
mark = lambda number, frame: None
TERM = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
for number in TERM:
    signal.signal(number, mark)
null = os.open(os.devnull, os.O_WRONLY)
def host(data=b''):
    r, w = os.pipe()
    os.write(w, data)
    return r, w
results = []
def call(argv, out_fd=null, in_fd=None):
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    code = m.relay(argv, out_fd=out_fd, in_fd=host()[0] if in_fd is None else in_fd)
    results.append([code, all(signal.getsignal(number) is mark for number in TERM), signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL])
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
  assert.deepEqual(JSON.parse(run.stdout), [[0, true, true], [71, true, true], [74, true, true], [74, true, true], [76, true, true], [EX_TERMINATED, true, true]]);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_GUEST_FRAME_BYTES, MAX_HOST_FRAME_BYTES, bridgeArgv, createFrameDecoder, encodeFrame, parseGuestFrame, scopeRequest, TOOLS,
} from '../local-runner/guest-bridge.mjs';
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

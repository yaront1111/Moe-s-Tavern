import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatUsage } from '../prompt-cache-usage.mjs';
import { normalizeUsageContext } from '../usage-receipt.mjs';

const helper = fileURLToPath(new URL('../prompt-cache.mjs', import.meta.url));
const context = {
  taskId: 'task-123', workerId: 'worker-456', role: 'worker', attemptId: 'attempt-789',
  launchId: 'launch-abc', requestedModel: 'claude-opus-5-5', requestedEffort: 'max', launchMode: 'headless',
};
const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 1000,
  output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 } };
function run(t, provider, events, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe usage receipt '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'usage.jsonl');
  const result = spawnSync(process.execPath, [helper, `${provider}-stream`], {
    input: events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'),
    encoding: 'utf8', env: { ...process.env, MOE_USAGE_RECEIPT_FILE: file,
      MOE_USAGE_CONTEXT_JSON: JSON.stringify(context), ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  const receipts = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, receipts, file, dir };
}

test('console retains input/cache semantics and adds output without double counting reasoning', () => {
  assert.equal(formatUsage('claude', usage),
    '[prompt-cache] provider=claude input=2000 read=900 write=1000 uncached=100 hit=45.0% output=80 reasoning=30 total=2080');
  assert.match(formatUsage('codex', { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 80 }),
    /input=1000 read=900 write=unknown uncached=100 hit=90.0% output=80 reasoning=unknown total=1080$/);
});

test('Claude writes only cumulative result receipt and preserves all attribution events', t => {
  const assistant = { type: 'assistant', session_id: 'session-one',
    message: { content: [{ text: 'DO_NOT_STORE_PROMPT' }], usage: { ...usage, input_tokens: 100000 } } };
  const final = { type: 'result', subtype: 'success', is_error: false, session_id: 'session-one', uuid: 'event-one',
    modelUsage: { 'claude-opus-5-5': { inputTokens: 200000, costUSD: 300 } },
    result: 'DO_NOT_STORE_OUTPUT', total_cost_usd: 500, usage };
  const r = run(t, 'claude', [assistant, final, final], {
    MOE_USAGE_CONTEXT_JSON: JSON.stringify({ ...context, prompt: 'DO_NOT_STORE_CONTEXT', apiKey: 'SECRET' }),
  });
  assert.equal(r.receipts.length, 1, 'one receipt for repeated cumulative final');
  assert.ok(r.stdout.startsWith(`${JSON.stringify(assistant)}\n${JSON.stringify(final)}\n`));
  const receipt = r.receipts[0];
  assert.equal(receipt.version, 1);
  assert.ok(Number.isFinite(Date.parse(receipt.timestamp)));
  for (const [key, value] of Object.entries(context)) assert.equal(receipt[key], value);
  assert.equal(receipt.provider, 'claude');
  assert.equal(receipt.scope, 'session');
  assert.equal(receipt.sessionId, 'session-one');
  assert.equal(receipt.eventId, 'event-one');
  assert.equal(receipt.outcome, 'success');
  assert.equal(receipt.coverage, 'reported');
  assert.deepEqual(receipt.reportedModels, ['claude-opus-5-5']);
  assert.deepEqual(receipt.usage, { inputTokens: 2000, cacheReadTokens: 900, cacheWriteTokens: 1000,
    uncachedInputTokens: 100, outputTokens: 80, reasoningTokens: 30, totalTokens: 2080 });
  assert.doesNotMatch(JSON.stringify(receipt), /DO_NOT_STORE|SECRET|costUSD|total_cost/);
});

test('usage logging remains disabled without a destination', t => {
  const r = run(t, 'claude', [{ type: 'result', usage }], { MOE_USAGE_RECEIPT_FILE: '' });
  assert.equal(r.receipts.length, 0);
  assert.match(r.stdout, /input=2000/);
  assert.equal(r.stderr, '');
});

test('missing, invalid and overflowing counters stay unknown', t => {
  const cases = [
    { raw: {}, expected: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      uncachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null } },
    { raw: { ...usage, output_tokens: -1 }, field: 'outputTokens' },
    { raw: { ...usage, output_tokens: '80' }, field: 'outputTokens' },
    { raw: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER }, field: 'inputTokens' },
    { raw: { ...usage, output_tokens_details: { reasoning_tokens: 81 } }, field: 'reasoningTokens' },
    { raw: { ...usage, reasoning_tokens: 31 }, field: 'reasoningTokens' },
  ];
  for (const item of cases) {
    const r = run(t, 'claude', [{ type: 'result', usage: item.raw }]);
    assert.equal(r.receipts.length, 1);
    const recorded = r.receipts[0].usage;
    if (item.expected) assert.deepEqual(recorded, item.expected);
    else assert.equal(recorded[item.field], null);
    if (item.field === 'outputTokens' || item.field === 'inputTokens') assert.equal(recorded.totalTokens, null);
  }
});

test('missing final events produce an explicit unknown receipt without transcript storage', t => {
  const r = run(t, 'claude', ['provider stderr SECRET', '{bad', { type: 'assistant', message: { usage } }]);
  assert.equal(r.receipts.length, 1);
  assert.equal(r.receipts[0].outcome, 'unknown');
  assert.equal(r.receipts[0].coverage, 'missing');
  assert.equal(r.receipts[0].usage.inputTokens, null);
  assert.equal(r.receipts[0].sessionId, null);
  assert.doesNotMatch(JSON.stringify(r.receipts[0]), /SECRET|provider stderr|bad/);
});

test('metadata validation rejects malformed values and never stores arbitrary fields', t => {
  const r = run(t, 'claude', [{ type: 'result', is_error: true, session_id: 'bad\nidentity', uuid: {}, usage,
    modelUsage: { 'bad model\nSECRET': {}, valid_model: {} } }], {
    MOE_USAGE_CONTEXT_JSON: JSON.stringify({ ...context, taskId: 'bad\nSECRET', launchId: 'x'.repeat(300),
      role: 'invented', requestedEffort: {}, userContent: 'SECRET' }),
  });
  const receipt = r.receipts[0];
  assert.ok(receipt);
  for (const field of ['taskId', 'launchId', 'role', 'requestedEffort', 'sessionId', 'eventId']) assert.equal(receipt[field], null, field);
  assert.deepEqual(receipt.reportedModels, ['valid_model']);
  assert.equal(receipt.outcome, 'error');
  assert.doesNotMatch(JSON.stringify(receipt), /SECRET/);
  for (const raw of ['{malformed', 'null', '[]', 'true']) {
    const bad = run(t, 'claude', [{ type: 'result', usage }], { MOE_USAGE_CONTEXT_JSON: raw });
    assert.equal(bad.receipts.length, 1);
    assert.equal(bad.receipts[0].taskId, null);
    assert.doesNotMatch(bad.stderr, /malformed/);
  }
});

test('unwritable receipt output fails open with one bounded data-free warning', t => {
  const r = run(t, 'claude', [
    { type: 'result', uuid: 'one', usage }, { type: 'result', uuid: 'two', usage },
  ], { MOE_USAGE_RECEIPT_FILE: path.join(tmpdir(), 'nonexistent-receipt-parent-DO_NOT_LOG', 'usage.jsonl') });
  assert.match(r.stdout, /input=2000/);
  assert.equal((r.stderr.match(/MOE_USAGE_RECEIPT_WRITE_FAILED/g) || []).length, 1);
  assert.ok(r.stderr.length < 200);
  assert.doesNotMatch(r.stderr, /DO_NOT_LOG|ENOENT|usage.jsonl/);
});

test('Codex receipts explicitly describe separate turns and output includes reasoning subset', t => {
  const r = run(t, 'codex', [
    { type: 'thread.started', thread_id: 'thread-one' },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100,
      reasoning_output_tokens: 40 } },
    { type: 'turn.completed', usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 60 } },
  ]);
  assert.equal(r.receipts.length, 2);
  assert.deepEqual(r.receipts.map(receipt => [receipt.scope, receipt.turnIndex, receipt.usage.totalTokens]),
    [['turn', 1, 1100], ['turn', 2, 1560]]);
  assert.equal(r.receipts[0].usage.reasoningTokens, 40);
  assert.equal(r.receipts[1].usage.reasoningTokens, null);
});

test('a truncated Codex turn following a completed turn remains missing coverage', t => {
  const r = run(t, 'codex', [
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    { type: 'turn.started' }, { type: 'item.started', item: { type: 'command_execution', command: 'SECRET' } },
  ]);
  assert.equal(r.receipts.length, 2);
  assert.equal(r.receipts[1].scope, 'turn');
  assert.equal(r.receipts[1].turnIndex, 2);
  assert.equal(r.receipts[1].coverage, 'missing');
  assert.equal(r.receipts[1].outcome, 'unknown');
  assert.equal(r.receipts[1].usage.totalTokens, null);
  assert.doesNotMatch(JSON.stringify(r.receipts), /SECRET/);
});

test('launch start emits pending coverage without inventing a completed stream', t => {
  const r = run(t, 'claude', [], { MOE_USAGE_RECEIPT_FILE: '' });
  const started = spawnSync(process.execPath, [helper, 'usage-start', 'claude'], {
    encoding: 'utf8', env: { ...process.env, MOE_USAGE_RECEIPT_FILE: r.file,
      MOE_USAGE_CONTEXT_JSON: JSON.stringify(context) },
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '');
  const receipt = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.equal(receipt.coverage, 'pending');
  assert.equal(receipt.outcome, 'unknown');
  assert.equal(receipt.usage.totalTokens, null);
  assert.equal(receipt.launchId, context.launchId);
});

test('changed cumulative results survive deduplication so reports can flag conflicts', t => {
  const r = run(t, 'claude', [
    { type: 'result', uuid: 'same-result', session_id: 'same-session', usage },
    { type: 'result', uuid: 'same-result', session_id: 'same-session', usage: { ...usage, input_tokens: 200 } },
  ]);
  assert.deepEqual(r.receipts.map(receipt => receipt.usage.uncachedInputTokens), [100, 200]);
});

test('anonymous result events are not silently conflated', t => {
  const r = run(t, 'claude', [{ type: 'result', usage }, { type: 'result', usage }]);
  assert.equal(r.receipts.length, 2);
  assert.equal(r.receipts[0].eventId, null);
});

// CQ-M02: additive correlation contract. Session-correlation integration cases
// live here so the existing usage-session.test.mjs stays untouched.
const sessionHelper = fileURLToPath(new URL('../usage-session.mjs', import.meta.url));
const correlation = { planRevision: 3, packetId: 'packet-1', sourceRetrievalId: 'retrieval-1',
  plannerInvocationId: 'planner-1', runnerId: 'runner-1', candidateId: 'cand-1',
  deliveryReceiptId: 'receipt-1', workKind: 'implementation' };
const unknownCorrelation = Object.fromEntries(Object.keys(correlation).map(field => [field, null]));
const unknownContext = Object.fromEntries([...Object.keys(context), ...Object.keys(correlation)].map(field => [field, null]));

test('the shared context normalizer keeps an exact allowlist and rejects poisoned values', () => {
  assert.deepEqual(normalizeUsageContext({ ...context, ...correlation, prompt: 'SECRET', nested: { a: 1 } }),
    { ...context, ...correlation });
  for (const raw of [null, [], 'text', 7]) assert.deepEqual(normalizeUsageContext(raw), unknownContext);
  assert.equal(normalizeUsageContext({ planRevision: 0 }).planRevision, 0);
  for (const planRevision of [-1, 1.5, '3', 2 ** 53, true, {}]) {
    assert.equal(normalizeUsageContext({ planRevision }).planRevision, null, String(planRevision));
  }
  for (const field of ['packetId', 'sourceRetrievalId', 'plannerInvocationId', 'runnerId', 'candidateId', 'deliveryReceiptId']) {
    for (const bad of ['', 'bad\nSECRET', 'x'.repeat(129), '../up', ' lead', 7, {}]) {
      assert.equal(normalizeUsageContext({ [field]: bad })[field], null, `${field}=${JSON.stringify(bad)}`);
    }
  }
  for (const kind of ['planning', 'context', 'implementation', 'repair', 'qa']) assert.equal(normalizeUsageContext({ workKind: kind }).workKind, kind);
  for (const kind of ['review', 'Repair', 'error', null]) assert.equal(normalizeUsageContext({ workKind: kind }).workKind, null);
});

test('receipts persist bounded correlation but never arbitrary nested metadata', t => {
  const r = run(t, 'claude', [{ type: 'result', uuid: 'event-c', session_id: 'session-c', usage }], {
    MOE_USAGE_CONTEXT_JSON: JSON.stringify({ ...context, ...correlation, nested: { prompt: 'DO_NOT_STORE' },
      toolArguments: ['SECRET'], costUSD: 9 }),
  });
  assert.equal(r.receipts.length, 1);
  const receipt = r.receipts[0];
  for (const [key, value] of Object.entries({ ...context, ...correlation })) assert.equal(receipt[key], value, key);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.usage.totalTokens, 2080, 'provider counters are unchanged by correlation');
  assert.doesNotMatch(JSON.stringify(receipt), /DO_NOT_STORE|SECRET|nested|toolArguments|costUSD/);
});

test('legacy and invalid correlation stays explicitly unknown, never zero or fabricated', t => {
  const legacy = run(t, 'claude', [{ type: 'result', uuid: 'legacy', usage }]).receipts[0];
  for (const [key, value] of Object.entries(context)) assert.equal(legacy[key], value, key);
  for (const field of Object.keys(correlation)) assert.ok(Object.hasOwn(legacy, field) && legacy[field] === null, field);
  const invalid = run(t, 'claude', [{ type: 'result', uuid: 'invalid', usage }], {
    MOE_USAGE_CONTEXT_JSON: JSON.stringify({ ...context, planRevision: -2, packetId: 'bad\nSECRET', runnerId: {},
      workKind: 'error', candidateId: 'x'.repeat(300) }),
  }).receipts[0];
  for (const field of Object.keys(correlation)) assert.equal(invalid[field], null, field);
  assert.doesNotMatch(JSON.stringify(invalid), /SECRET/);
});

function moeProject(t, records = {}) {
  const project = mkdtempSync(path.join(tmpdir(), 'moe usage 漢字 corr '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const [relative, body] of Object.entries(records)) {
    const file = path.join(project, '.moe', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    if (body === 'DIRECTORY') mkdirSync(file);
    else writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return project;
}
function prepare(project, supplied) {
  const result = spawnSync(process.execPath, [sessionHelper, project], {
    encoding: 'utf8', env: { ...process.env, MOE_USAGE_CONTEXT_JSON: JSON.stringify(supplied) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes(project), 'no path leak');
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|DO_NOT_COPY/);
  return JSON.parse(result.stdout);
}

test('launch preparation snapshots canonical revision and runner from matching records only', t => {
  const task = { id: 'task-123', planRevision: 4, title: 'DO_NOT_COPY title' };
  const attempt = { id: 'attempt-789', taskId: 'task-123', workerId: 'worker-456', runnerId: 'runner-real',
    workspace: '/DO_NOT_COPY/workspace' };
  const project = moeProject(t, { 'tasks/task-123.json': task, 'attempts/attempt-789.json': attempt });
  const files = ['tasks/task-123.json', 'attempts/attempt-789.json'].map(name => path.join(project, '.moe', name));
  const before = files.map(file => readFileSync(file, 'utf8'));
  // Caller-supplied revision/runner values are overrides the canonical snapshot ignores.
  const supplied = { ...context, planRevision: 99, runnerId: 'forged-runner', packetId: 'packet-1', workKind: 'repair',
    prompt: 'SECRET', nested: { a: 1 } };
  const [first, second] = [prepare(project, supplied), prepare(project, supplied)];
  assert.notEqual(first.file, second.file);
  assert.notEqual(first.context.launchId, second.context.launchId);
  assert.notEqual(first.context.launchId, context.launchId);
  assert.deepEqual(first.context, { ...context, ...unknownCorrelation, launchId: first.context.launchId,
    planRevision: 4, runnerId: 'runner-real', packetId: 'packet-1', workKind: 'repair' });
  for (const prepared of [first, second]) {
    assert.equal(path.dirname(prepared.file), path.join(project, 'logs', 'moe-usage'));
    assert.equal(readFileSync(prepared.file, 'utf8'), '');
    if (process.platform !== 'win32') assert.equal(statSync(prepared.file).mode & 0o777, 0o600);
  }
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before, 'canonical records are read-only');
  // The prepared context is exactly what the stream receipt then persists.
  const receipt = run(t, 'claude', [{ type: 'result', uuid: 'prepared', usage }], {
    MOE_USAGE_CONTEXT_JSON: JSON.stringify(first.context) }).receipts[0];
  assert.deepEqual([receipt.planRevision, receipt.runnerId, receipt.launchId, receipt.workKind],
    [4, 'runner-real', first.context.launchId, 'repair']);
});

test('canonical snapshots fail open to unknown for mismatched, malformed, traversal and unreadable records', t => {
  const ids = { taskId: 'task-1', workerId: 'worker-1', attemptId: 'attempt-1' };
  const task = { id: 'task-1', planRevision: 2 };
  const attempt = { id: 'attempt-1', taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1' };
  const sneaky = { taskId: 'x/../../planted', workerId: 'worker-1', attemptId: 'x/../../planted-attempt' };
  const cases = [
    ['matching control', { 'tasks/task-1.json': task, 'attempts/attempt-1.json': attempt }, ids, 2, 'runner-1'],
    ['no records', {}, ids, null, null],
    ['legacy task without revision', { 'tasks/task-1.json': { id: 'task-1' } }, ids, null, null],
    ['task id mismatch', { 'tasks/task-1.json': { ...task, id: 'task-2' } }, ids, null, null],
    ['negative revision', { 'tasks/task-1.json': { ...task, planRevision: -1 } }, ids, null, null],
    ['string revision', { 'tasks/task-1.json': { ...task, planRevision: '2' } }, ids, null, null],
    ['malformed task', { 'tasks/task-1.json': '{SECRET broken' }, ids, null, null],
    ['array task', { 'tasks/task-1.json': '[]' }, ids, null, null],
    ['oversized task', { 'tasks/task-1.json': JSON.stringify({ ...task, pad: 'x'.repeat(1_100_000) }) }, ids, null, null],
    ['unreadable task', { 'tasks/task-1.json': 'DIRECTORY' }, ids, null, null],
    ['attempt for another task', { 'attempts/attempt-1.json': { ...attempt, taskId: 'task-2' } }, ids, null, null],
    ['attempt for another worker', { 'attempts/attempt-1.json': { ...attempt, workerId: 'worker-2' } }, ids, null, null],
    ['attempt id mismatch', { 'attempts/attempt-1.json': { ...attempt, id: 'attempt-2' } }, ids, null, null],
    ['worker unknown', { 'attempts/attempt-1.json': attempt }, { ...ids, workerId: null }, null, null],
    ['invalid runner', { 'attempts/attempt-1.json': { ...attempt, runnerId: 'bad\nSECRET' } }, ids, null, null],
    ['traversal ids', { 'planted.json': { id: sneaky.taskId, planRevision: 5 },
      'planted-attempt.json': { id: sneaky.attemptId, taskId: sneaky.taskId, workerId: 'worker-1', runnerId: 'runner-planted' } },
    sneaky, null, null],
  ];
  for (const [name, records, ids, revision, runner] of cases) {
    const project = moeProject(t, records);
    const prepared = prepare(project, { ...ids, role: 'worker', planRevision: 9, runnerId: 'forged' });
    assert.deepEqual([prepared.context.planRevision, prepared.context.runnerId], [revision, runner], name);
    assert.equal(prepared.context.taskId, ids.taskId, `${name}: existing identifier semantics unchanged`);
    assert.equal(readFileSync(prepared.file, 'utf8'), '', name);
  }
});

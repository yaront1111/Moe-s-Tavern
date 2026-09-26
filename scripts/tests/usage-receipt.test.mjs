import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatUsage } from '../prompt-cache-usage.mjs';

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

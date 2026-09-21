import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = new URL('../prompt-cache.mjs', import.meta.url);
test('shared prompt cache helper is shipped', () => assert.ok(existsSync(helper)));
test('provider usage semantics and missing counters', async () => {
  assert.ok(existsSync(helper), 'shared cache helper must exist');
  const { formatUsage } = await import('../prompt-cache-usage.mjs');
  assert.match(formatUsage('claude', { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 1000 }), /input=2000 read=900 write=1000 uncached=100 hit=45.0%/);
  assert.match(formatUsage('codex', { input_tokens: 1000, cached_input_tokens: 900 }), /input=1000 read=900 write=unknown uncached=100 hit=90.0%/);
  for (const usage of [undefined, {}, { input_tokens: 200 }, { input_tokens: 200, cached_input_tokens: 300 }, { input_tokens: -1, cached_input_tokens: 0 }]) {
    assert.match(formatUsage('codex', usage), /usage=unknown/);
  }
  assert.match(formatUsage('codex', { input_tokens: 0, cached_input_tokens: 0 }), /hit=n\/a/);
  assert.match(formatUsage('claude', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), /hit=0.0%/);
});

test('strict policy refuses disable controls and malformed local settings without leaking values', async t => {
  assert.ok(existsSync(helper), 'shared cache helper must exist');
  const { checkPolicy } = await import('../prompt-cache-policy.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'moe policy '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { provider: 'claude', project: dir, cwd: dir, home: dir, managedPaths: [], env: {} };
  for (const key of ['DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_FABLE', 'MOE_NO_DYNAMIC_PROMPT_EXCLUDE']) {
    assert.throws(() => checkPolicy({ ...base, env: { [key]: '1' } }), /MOE_PROMPT_CACHE_DISABLED/);
  }
  assert.equal(checkPolicy(base), 'strict');
  assert.equal(checkPolicy({ ...base, provider: 'codex', env: { DISABLE_PROMPT_CACHING: '1' } }), 'strict');
  assert.equal(checkPolicy({ ...base, env: { MOE_PROMPT_CACHE_MODE: 'inherit', DISABLE_PROMPT_CACHING: '1' } }), 'inherit');
  assert.throws(() => checkPolicy({ ...base, env: { MOE_PROMPT_CACHE_MODE: 'typo' } }), /MOE_PROMPT_CACHE_POLICY_INVALID/);
  mkdirSync(path.join(dir, '.claude'));
  const settings = path.join(dir, '.claude/settings.json');
  writeFileSync(settings, JSON.stringify({ env: { DISABLE_PROMPT_CACHING: 'true', SECRET: 'never-log-me' } }));
  assert.throws(() => checkPolicy(base), e => /MOE_PROMPT_CACHE_DISABLED/.test(e.message) && !e.message.includes('never-log-me'));
  writeFileSync(settings, '{invalid secret');
  assert.throws(() => checkPolicy(base), /MOE_PROMPT_CACHE_SETTINGS_INVALID/);
  writeFileSync(settings, JSON.stringify({ env: { DISABLE_PROMPT_CACHING: '0' } }));
  assert.equal(checkPolicy(base), 'strict');
  assert.throws(() => checkPolicy({ ...base, args: ['--settings', '{"env":{"DISABLE_PROMPT_CACHING":"1"}}'] }), /MOE_PROMPT_CACHE_DISABLED/);
});

test('Codex stream reports each turn once and preserves useful output', () => {
  assert.ok(existsSync(helper), 'shared cache helper must exist');
  const events = [
    'startup warning',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'finished task' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 1800 } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'provider failed' } }),
    '{broken',
  ];
  const result = spawnSync(process.execPath, [fileURLToPath(helper), 'codex-stream'], { input: events.join('\n'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /startup warning/);
  assert.match(result.stdout, /finished task/);
  assert.match(result.stdout, /provider failed/);
  assert.equal((result.stdout.match(/\[prompt-cache\] provider=codex/g) || []).length, 2);
});

test('Claude stream keeps attribution events intact and reports only cumulative result usage', () => {
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'abc', input: { text: '漢字' } }], usage: { input_tokens: 50 } } });
  const resultEvent = JSON.stringify({ type: 'result', usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 1000 } });
  const result = spawnSync(process.execPath, [fileURLToPath(helper), 'claude-stream'], { input: `${assistant}\n${resultEvent}\n`, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`${assistant}\n${resultEvent}\n`));
  assert.equal((result.stdout.match(/\[prompt-cache\]/g) || []).length, 1);
  assert.match(result.stdout, /hit=45.0%/);
});

test('empty provider streams explicitly report unknown usage', () => {
  for (const provider of ['claude', 'codex']) {
    const result = spawnSync(process.execPath, [fileURLToPath(helper), `${provider}-stream`], { input: '', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage=unknown/);
  }
});

// =============================================================================
// Frozen refactor workloads (CQ-M03d), corpus contract version 1
// =============================================================================
//
// Test-only benchmark data: the five refactor cases of the CQ-M03 matched corpus,
// validated and deep-frozen at import against workloadSnapshot.ts. No production
// module imports this file.
//
// A refactor case asks for a behaviour-preserving structural change. Each rubric
// pairs exact behaviour tables, captured from the unsolved original, with ONE
// structural-intent criterion (a shared helper, a single implementation site or
// detached results), so a rewrite earns nothing for its shape unless it also keeps
// every observable output.
//
// Each case is an ADAPTED Node ESM overlay of Moe source at FROZEN_STARTING_COMMIT
// (exact changes in each `source.note`), never a whole-repository checkout. The
// coding inputs hold only the unsolved original: the corrected and plausible-wrong
// candidates live in refactorWorkloads.test.ts, and each held-out assessment is a
// node:test file that imports the candidate from the coding snapshot named by
// WORKLOAD_CANDIDATE_ROOT_ENV.
//
// Fixture files are String.raw templates, so every backslash is the fixture's own
// byte; fixture code uses string concatenation, never a template literal. Template
// line endings normalize to LF, so digests do not depend on the checkout.

import {
  FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV, validateWorkloads,
  type Workload,
} from './workloadSnapshot.js';

const js = String.raw;
const COMMON = { contractVersion: 1, category: 'refactor', startingCommit: FROZEN_STARTING_COMMIT } as const;
const SRC = 'packages/moe-daemon/src/';

const PRELUDE = js`import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.${WORKLOAD_CANDIDATE_ROOT_ENV};
if (!root) throw new Error('${WORKLOAD_CANDIDATE_ROOT_ENV} is not set: point it at the candidate coding snapshot');
const candidatePath = (rel) => path.join(root, ...rel.split('/'));
const load = (rel) => import(pathToFileURL(candidatePath(rel)).href);
const sourceOf = (rel) => fs.readFileSync(candidatePath(rel), 'utf8');
// Source without comments, so the structural checks never judge what a comment says.
const codeOf = (rel) => sourceOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
`;

const IMPORT_CHECK = js`
// Static reuse check: every name is imported from spec, by name or through a namespace alias.
const importsAll = (text, spec, names) => {
  const named = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)]
    .filter((m) => m[3] === spec).map((m) => m[1]).join(',');
  const aliases = [...text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/g)]
    .filter((m) => m[3] === spec).map((m) => m[1]);
  return names.every((name) => new RegExp('(?:^|[^\\w$])' + name + '(?:$|[^\\w$])').test(named)
    || aliases.some((alias) => text.includes(alias + '.' + name)));
};
`;

// -----------------------------------------------------------------------------
// Case 1: one source of provider-counter normalization
// -----------------------------------------------------------------------------

const PROMPT_CACHE_USAGE = js`// Reduced from scripts/prompt-cache-usage.mjs at the frozen commit: only the counter
// helpers, normalizeUsage and formatUsage are kept, and template literals are rewritten
// as string concatenation. formatUsage renders one provider usage event as a log line.
const count = n => Number.isSafeInteger(n) && n >= 0;
const counter = n => count(n) ? n : null;
const sum = values => values.every(count) && count(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;

// Keep provider input accounting distinct. Reasoning, when explicitly exposed,
// is a subset of output; it is never added to the input + output total.
export function normalizeUsage(provider, usage) {
  const input = counter(usage?.input_tokens);
  let read = counter(provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cached_input_tokens);
  const write = provider === 'claude' ? counter(usage?.cache_creation_input_tokens) : null;
  if (provider !== 'claude' && input !== null && read !== null && read > input) read = null;
  const inputTokens = provider === 'claude' ? sum([input, read, write]) : input;
  const outputTokens = counter(usage?.output_tokens);
  const reasoning = [usage?.reasoning_tokens, usage?.reasoning_output_tokens,
    usage?.output_tokens_details?.reasoning_tokens].filter(value => value !== undefined);
  const reasoningTokens = reasoning.length && reasoning.every(count) &&
    reasoning.every(value => value === reasoning[0]) && outputTokens !== null && reasoning[0] <= outputTokens
    ? reasoning[0] : null;
  return {
    inputTokens, cacheReadTokens: read, cacheWriteTokens: write,
    uncachedInputTokens: provider === 'claude' ? input : input !== null && read !== null ? input - read : null,
    outputTokens, reasoningTokens, totalTokens: sum([inputTokens, outputTokens]),
  };
}

// Anthropic input excludes read/write tokens. Codex input includes cached input.
// Missing counters are unknown, never silently reported as a zero cache hit.
export function formatUsage(provider, usage) {
  const prefix = '[prompt-cache] provider=' + provider;
  const normalized = normalizeUsage(provider, usage);
  const output = ' output=' + (normalized.outputTokens ?? 'unknown') + ' reasoning=' + (normalized.reasoningTokens ?? 'unknown')
    + ' total=' + (normalized.totalTokens ?? 'unknown');
  const input = usage?.input_tokens;
  const read = provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cached_input_tokens;
  const write = provider === 'claude' ? usage?.cache_creation_input_tokens : undefined;
  if (!count(input) || !count(read) || (provider === 'claude' ? !count(write) : read > input)) {
    return prefix + ' usage=unknown' + output;
  }
  const total = provider === 'claude' ? input + read + write : input;
  if (!Number.isSafeInteger(total)) return prefix + ' usage=unknown' + output;
  const uncached = provider === 'claude' ? input : input - read;
  const hit = total ? (100 * read / total).toFixed(1) + '%' : 'n/a';
  return prefix + ' input=' + total + ' read=' + read + ' write=' + (write ?? 'unknown') + ' uncached=' + uncached
    + ' hit=' + hit + output;
}
`;

const USAGE_ASSESSMENT = js`${PRELUDE}
const { formatUsage, normalizeUsage } = await load('src/promptCacheUsage.mjs');
const MAX = Number.MAX_SAFE_INTEGER;
const PREFIX = '[prompt-cache] provider=';

// Captured from the unsolved original. Each row: provider, usage, the exact line after
// PREFIX, then the normalized counters in the order input, read, write, uncached,
// output, reasoning, total.
const CASES = [
  ['claude', { input_tokens: 12, cache_read_input_tokens: 800, cache_creation_input_tokens: 188, output_tokens: 50 },
    'claude input=1000 read=800 write=188 uncached=12 hit=80.0% output=50 reasoning=unknown total=1050',
    [1000, 800, 188, 12, 50, null, 1050]],
  ['claude', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    'claude input=0 read=0 write=0 uncached=0 hit=n/a output=0 reasoning=unknown total=0',
    [0, 0, 0, 0, 0, null, 0]],
  ['claude', { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    'claude usage=unknown output=3 reasoning=unknown total=unknown',
    [null, 5, null, 10, 3, null, null]],
  ['claude', { input_tokens: 10, cache_read_input_tokens: -1, cache_creation_input_tokens: 0, output_tokens: 3 },
    'claude usage=unknown output=3 reasoning=unknown total=unknown',
    [null, null, 0, 10, 3, null, null]],
  ['claude', { input_tokens: MAX, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 1 },
    'claude usage=unknown output=1 reasoning=unknown total=unknown',
    [null, 1, 0, MAX, 1, null, null]],
  ['claude', { input_tokens: 10, cached_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 3 },
    'claude usage=unknown output=3 reasoning=unknown total=unknown',
    [null, null, 0, 10, 3, null, null]],
  ['claude', { input_tokens: '10', cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 3 },
    'claude usage=unknown output=3 reasoning=unknown total=unknown',
    [null, 5, 0, null, 3, null, null]],
  ['claude', { input_tokens: 4, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 9, reasoning_tokens: 9 },
    'claude input=10 read=4 write=2 uncached=4 hit=40.0% output=9 reasoning=9 total=19',
    [10, 4, 2, 4, 9, 9, 19]],
  ['claude', null,
    'claude usage=unknown output=unknown reasoning=unknown total=unknown',
    [null, null, null, null, null, null, null]],
  ['codex', { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 40, reasoning_output_tokens: 10 },
    'codex input=1000 read=250 write=unknown uncached=750 hit=25.0% output=40 reasoning=10 total=1040',
    [1000, 250, null, 750, 40, 10, 1040]],
  ['codex', { input_tokens: 100, cached_input_tokens: 101, output_tokens: 5 },
    'codex usage=unknown output=5 reasoning=unknown total=105',
    [100, null, null, null, 5, null, 105]],
  ['codex', { input_tokens: 100, output_tokens: 5 },
    'codex usage=unknown output=5 reasoning=unknown total=105',
    [100, null, null, null, 5, null, 105]],
  ['codex', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 8, reasoning_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } },
    'codex input=10 read=0 write=unknown uncached=10 hit=0.0% output=8 reasoning=unknown total=18',
    [10, 0, null, 10, 8, null, 18]],
  ['codex', { input_tokens: 10, cached_input_tokens: 10, output_tokens: 3, reasoning_output_tokens: 4 },
    'codex input=10 read=10 write=unknown uncached=0 hit=100.0% output=3 reasoning=unknown total=13',
    [10, 10, null, 0, 3, null, 13]],
  ['codex', { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    'codex input=0 read=0 write=unknown uncached=0 hit=n/a output=0 reasoning=unknown total=0',
    [0, 0, null, 0, 0, null, 0]],
  ['codex', { input_tokens: MAX, cached_input_tokens: 0, output_tokens: 1 },
    'codex input=9007199254740991 read=0 write=unknown uncached=9007199254740991 hit=0.0% output=1 reasoning=unknown total=unknown',
    [MAX, 0, null, MAX, 1, null, null]],
  ['codex', { input_tokens: 1.5, cached_input_tokens: 0, output_tokens: 2 },
    'codex usage=unknown output=2 reasoning=unknown total=unknown',
    [null, 0, null, null, 2, null, null]],
  ['codex', { input_tokens: 7, cache_read_input_tokens: 7, output_tokens: 0 },
    'codex usage=unknown output=0 reasoning=unknown total=7',
    [7, null, null, null, 0, null, 7]],
  ['codex', { input_tokens: 3, cached_input_tokens: 1 },
    'codex input=3 read=1 write=unknown uncached=2 hit=33.3% output=unknown reasoning=unknown total=unknown',
    [3, 1, null, 2, null, null, null]],
  ['codex', undefined,
    'codex usage=unknown output=unknown reasoning=unknown total=unknown',
    [null, null, null, null, null, null, null]],
  ['gemini', { input_tokens: 50, cached_input_tokens: 25, output_tokens: 5, output_tokens_details: { reasoning_tokens: 5 } },
    'gemini input=50 read=25 write=unknown uncached=25 hit=50.0% output=5 reasoning=5 total=55',
    [50, 25, null, 25, 5, 5, 55]],
];
const counters = ([inputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens, outputTokens, reasoningTokens, totalTokens]) =>
  ({ inputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens, outputTokens, reasoningTokens, totalTokens });

test('format-output-preserved: formatUsage prints the same line for every provider and counter shape', () => {
  for (const [provider, usage, line] of CASES) {
    assert.equal(formatUsage(provider, usage), PREFIX + line, JSON.stringify([provider, usage]));
  }
});

test('normalize-output-preserved: normalizeUsage returns the same counters, unknowns included', () => {
  for (const [provider, usage, , expected] of CASES) {
    assert.deepEqual(normalizeUsage(provider, usage), counters(expected), JSON.stringify([provider, usage]));
  }
});

test('single-counter-normalization: each raw provider counter is read in one place and formatUsage derives from it', () => {
  const code = codeOf('src/promptCacheUsage.mjs');
  for (const field of ['input_tokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
    const reads = code.match(new RegExp('\\b' + field + '\\b', 'g')) ?? [];
    assert.ok(reads.length <= 1, field + ' appears ' + reads.length + ' times; normalize each raw counter once');
  }
  assert.ok((code.match(/\bnormalizeUsage\b/g) ?? []).length >= 2, 'formatUsage must derive its numbers from normalizeUsage');
});
`;

const USAGE_COUNTER_NORMALIZATION = {
  ...COMMON,
  id: 'refactor-usage-counter-normalization',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: ['scripts/prompt-cache-usage.mjs'],
    adaptation: 'adapted',
    note: 'Adapted from scripts/prompt-cache-usage.mjs: only count, counter, sum, normalizeUsage and formatUsage are '
      + 'kept (renderCodexEvent and the stream CLI are dropped), and the template literals in formatUsage are rewritten '
      + 'as string concatenation. Its output was checked equal to the frozen script on every assessment input. The '
      + 'duplicated raw-counter reads in formatUsage are the frozen code as it is, not an injected defect.',
  },
  intendedBehavior: 'src/promptCacheUsage.mjs normalizes provider usage counters twice: normalizeUsage(provider, '
    + 'usage) reads and validates the raw input, cache read, cache write and output counters, and formatUsage(provider, '
    + 'usage) reads the same raw fields again with its own unknown-detection rules. Refactor formatUsage so every '
    + 'number it prints is derived from the result of normalizeUsage, so each raw provider counter is read in exactly '
    + 'one place. This is a pure refactor: formatUsage must print byte-identical lines for every input (complete usage, '
    + 'missing or invalid counters, a codex cached count above its input, inconsistent reasoning counters, a zero total '
    + 'and unsafe-integer sums), and normalizeUsage must keep returning exactly the same counters, with unknown values '
    + 'still null and reasoning still a subset of output.',
  initialFiles: { 'src/promptCacheUsage.mjs': PROMPT_CACHE_USAGE },
  assessmentFiles: { 'acceptance.test.mjs': USAGE_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'format-output-preserved', description: 'formatUsage prints the original line for every provider and counter shape in the table.' },
      { id: 'normalize-output-preserved', description: 'normalizeUsage returns the original counters for the same table, unknowns null.' },
      { id: 'single-counter-normalization', description: 'Each raw provider counter field is read at most once in the module and formatUsage derives from normalizeUsage.' },
    ],
    coverageTags: ['reusable-helper', 'behavior-preservation', 'unknown-preservation'],
  },
  snapshotDigest: 'sha256:5c74b60fc7c72c2ce8ffa2977fd2626600be7265ccca2367682ed6cf4532da14',
  assessmentDigest: 'sha256:a46e3e6477f3d07ac60a9ffee3561e19d25185ab3e26b67d009a98abe2283e64',
};

// -----------------------------------------------------------------------------
// Case 2: one chat page budget for both readers
// -----------------------------------------------------------------------------

const CHAT_PAYLOAD = js`// Adapted from packages/moe-daemon/src/util/chatPayload.ts at the frozen commit: types
// removed, unrelated exports dropped, and truncateForBudget from util/memorySettings.ts
// inlined with the ellipsis written as a char code. The response budget is a parameter
// (default MAX_CHAT_RESPONSE_CHARS), so callers and tests can use small budgets.
const ELLIPSIS = String.fromCharCode(0x2026);

/** Ceiling on the TOTAL content a single chat response may carry. */
export const MAX_CHAT_RESPONSE_CHARS = 40000;
/** Approximate serialized overhead of one message's metadata fields. */
export const CHAT_MESSAGE_OVERHEAD_CHARS = 220;

function truncateForBudget(text, maxChars) {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).trimEnd() + ELLIPSIS,
    truncated: true,
  };
}

/**
 * How many chars a message will occupy in a response once maxContentChars
 * truncation is applied. maxContentChars <= 0 means "no truncation".
 */
export function chatMessageResponseCost(message, maxContentChars) {
  const contentChars = maxContentChars > 0
    ? Math.min(message.content.length, maxContentChars)
    : message.content.length;
  return contentChars + CHAT_MESSAGE_OVERHEAD_CHARS;
}

/**
 * Cut a message list at the response-size ceiling. Returns the prefix that fits plus
 * what was left behind, so the caller can keep the undelivered tail unread instead of
 * advancing a cursor past it. Always yields at least one message: a single oversized
 * message must still be deliverable, or the caller would spin on it forever.
 */
export function capChatMessagesToResponseBudget(messages, maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS) {
  let used = 0;
  for (let i = 0; i < messages.length; i++) {
    used += chatMessageResponseCost(messages[i], maxContentChars);
    if (used > budget && i > 0) {
      return { delivered: messages.slice(0, i), dropped: messages.slice(i) };
    }
  }
  return { delivered: messages, dropped: [] };
}

export function truncateChatMessage(message, maxContentChars) {
  if (maxContentChars <= 0 || message.content.length <= maxContentChars) {
    return message;
  }
  const truncated = truncateForBudget(message.content, maxContentChars);
  return {
    ...message,
    content: truncated.text,
    contentTruncated: truncated.truncated,
    contentOriginalLength: message.content.length,
  };
}

export function truncateChatMessages(messages, maxContentChars) {
  return messages.map((message) => truncateChatMessage(message, maxContentChars));
}

export function countTruncatedMessages(messages) {
  return messages.filter((message) => message.contentTruncated).length;
}
`;

const CHAT_BACKLOG = js`// Adapted from summarizeChatBurst in packages/moe-daemon/src/util/chatBacklog.ts at the
// frozen commit: types, logging, the off-bus pile and the scan-scope bookkeeping are
// dropped. One drained pile is de-duplicated, ordered, count-capped and budget-capped,
// then shaped for the response. Cursors come from delivered messages only.
import { capChatMessagesToResponseBudget, countTruncatedMessages, truncateChatMessages } from './chatPayload.mjs';

/** Messages returned in one burst response; the rest stay unread for the next call. */
export const MAX_BURST_MESSAGES = 100;

export function drainChatBurst(pile, maxContentChars, budget) {
  const seen = new Set();
  const ordered = [];
  for (const message of pile) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    ordered.push(message);
  }
  // Sort on timestamp ONLY (Array#sort is stable): an id tiebreaker would reorder
  // same-millisecond messages, and a channel cursor could then skip an undelivered one.
  ordered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const counted = ordered.slice(0, MAX_BURST_MESSAGES);
  const capped = capChatMessagesToResponseBudget(counted, maxContentChars, budget);
  const dropped = [...capped.dropped, ...ordered.slice(MAX_BURST_MESSAGES)];
  // channelId -> id of the LAST message actually being delivered for it.
  const cursorUpdates = {};
  for (const message of capped.delivered) cursorUpdates[message.channel] = message.id;
  const messages = truncateChatMessages(capped.delivered, maxContentChars);
  return {
    messages,
    cursorUpdates,
    hasMore: dropped.length > 0,
    truncated: countTruncatedMessages(messages),
  };
}
`;

const CHAT_READ = js`// Adapted from the response-budget loop in packages/moe-daemon/src/tools/chatRead.ts at
// the frozen commit: the tool wrapper, channel fetch and unread bookkeeping are dropped,
// and the page runs FORWARD from the caller's cursor (oldest first, like the backlog
// drain) instead of trimming the oldest of a newest-first window. It keeps its own copy
// of the budget arithmetic.
import { MAX_CHAT_RESPONSE_CHARS, chatMessageResponseCost, truncateChatMessage } from './chatPayload.mjs';

export function readChatPage(window, sinceId, maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS) {
  let kept = window.length;
  let used = 0;
  for (let i = 0; i < window.length; i++) {
    used += chatMessageResponseCost(window[i], maxContentChars);
    if (used > budget && i > 0) {
      kept = i;
      break;
    }
  }
  const delivered = window.slice(0, kept);
  const messages = delivered.map((message) => truncateChatMessage(message, maxContentChars));
  // The cursor is the newest DELIVERED id, so an omitted message stays unread.
  const cursor = delivered.length > 0 ? delivered[delivered.length - 1].id : sinceId || null;
  return {
    messages,
    cursor,
    omitted: window.length - delivered.length,
    truncated: messages.filter((message) => message.contentTruncated).length,
  };
}
`;

const CHAT_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { readChatPage } = await load('src/chatRead.mjs');
const { drainChatBurst } = await load('src/chatBacklog.mjs');
const ELLIPSIS = String.fromCharCode(0x2026);
const msg = (id, channel, second, content) => ({
  id, channel, sender: 'worker-a', timestamp: '2026-10-24T00:00:' + String(second).padStart(2, '0') + '.000Z', content,
});
const x = (n) => 'x'.repeat(n);
const cut = (message, content) => ({ ...message, content, contentTruncated: true, contentOriginalLength: message.content.length });
const page = ({ messages, omitted, truncated }) => ({ messages, omitted, truncated });
const burst = ({ messages, hasMore, truncated }) => ({ messages, hasMore, truncated });

// Fixed inputs; the expected views below were captured from the unsolved original.
const W4 = [msg('m1', 'c1', 1, x(30)), msg('m2', 'c1', 2, x(30)), msg('m3', 'c1', 3, x(30)), msg('m4', 'c1', 4, x(30))];
const BIG = [msg('b1', 'c1', 1, x(15000)), msg('b2', 'c1', 2, x(15000)), msg('b3', 'c1', 3, x(15000))];
const TRIM = [msg('t1', 'c1', 1, 'abcd     efghij'), msg('t2', 'c1', 2, 'short')];
const PILE = [
  msg('p3', 'c2', 3, x(20)), msg('p1', 'c1', 1, x(20)), msg('p2b', 'c1', 2, 'tie-b'),
  msg('p2a', 'c2', 2, 'tie-a'), msg('p1', 'c1', 1, 'dup'), msg('p4', 'c1', 4, x(20)),
];
const [p3, p1, p2b, p2a, , p4] = PILE;
const MANY = Array.from({ length: 102 }, (_, i) => msg('n' + i, i % 2 ? 'c1' : 'c2', 10 + (i % 40), ''));
// Stable timestamp order, then the 100-message count cap drops the two newest (n39, n79).
const MANY_DELIVERED = [];
for (let second = 0; second < 39; second++) for (let i = second; i < 102; i += 40) MANY_DELIVERED.push(MANY[i]);

test('page-output-preserved: both callers deliver the same views, cut points and counts', () => {
  const nine = x(9) + ELLIPSIS;
  assert.deepEqual(page(readChatPage(W4, 'm0', 10, 700)), { messages: W4.slice(0, 3).map((m) => cut(m, nine)), omitted: 1, truncated: 3 });
  assert.deepEqual(page(readChatPage(W4, 'm0', 0, 1000)), { messages: W4, omitted: 0, truncated: 0 });
  assert.deepEqual(page(readChatPage(W4, 'm0', 0, 999)), { messages: W4.slice(0, 3), omitted: 1, truncated: 0 });
  assert.deepEqual(page(readChatPage(W4, 'm0', -1, 920)), { messages: W4.slice(0, 3), omitted: 1, truncated: 0 });
  assert.deepEqual(page(readChatPage(BIG, null, 0)), { messages: BIG.slice(0, 2), omitted: 1, truncated: 0 });
  assert.deepEqual(page(readChatPage(TRIM, 'm0', 8, 1000)), { messages: [cut(TRIM[0], 'abcd' + ELLIPSIS), TRIM[1]], omitted: 0, truncated: 1 });
  assert.deepEqual(page(readChatPage([], 'm9', 10, 100)), { messages: [], omitted: 0, truncated: 0 });

  assert.deepEqual(burst(drainChatBurst(PILE, 5, 700)), { messages: [cut(p1, 'xxxx' + ELLIPSIS), p2b, p2a], hasMore: true, truncated: 1 });
  assert.deepEqual(burst(drainChatBurst(PILE, 0, 10000)), { messages: [p1, p2b, p2a, p3, p4], hasMore: false, truncated: 0 });
  assert.equal(MANY_DELIVERED.length, 100);
  assert.deepEqual(burst(drainChatBurst(MANY, 0, 1e9)), { messages: MANY_DELIVERED, hasMore: true, truncated: 0 });
  assert.deepEqual(burst(drainChatBurst([], 10, 100)), { messages: [], hasMore: false, truncated: 0 });
  assert.deepEqual(burst(drainChatBurst(BIG, 0)), { messages: BIG.slice(0, 2), hasMore: true, truncated: 0 });
});

test('cursor-never-skips-omitted: cursors stop at the last delivered message, so omitted ones stay unread', () => {
  assert.equal(readChatPage(W4, 'm0', 10, 700).cursor, 'm3');
  assert.equal(readChatPage(W4, 'm0', 0, 999).cursor, 'm3');
  assert.equal(readChatPage(BIG, null, 0).cursor, 'b2');
  assert.equal(readChatPage([msg('o1', 'c1', 1, x(500)), msg('o2', 'c1', 2, 'tail')], 'm0', 0, 100).cursor, 'o1');
  assert.equal(readChatPage(W4, 'm0', 0, 1000).cursor, 'm4');
  assert.equal(readChatPage([], 'm9', 10, 100).cursor, 'm9');
  assert.equal(readChatPage([], '', 10, 100).cursor, null);
  assert.equal(readChatPage([], undefined, 10, 100).cursor, null);

  assert.deepEqual(drainChatBurst(PILE, 5, 700).cursorUpdates, { c1: 'p2b', c2: 'p2a' });
  assert.deepEqual(drainChatBurst(PILE, 0, 10000).cursorUpdates, { c1: 'p4', c2: 'p3' });
  assert.deepEqual(drainChatBurst(PILE, 0, 230).cursorUpdates, { c1: 'p1' });
  assert.deepEqual(drainChatBurst(MANY, 0, 1e9).cursorUpdates, { c1: 'n77', c2: 'n78' });
  assert.deepEqual(drainChatBurst([], 10, 100).cursorUpdates, {});
  assert.deepEqual(drainChatBurst(BIG, 0).cursorUpdates, { c1: 'b2' });
});

test('oversized-first-message-delivered: a first message over the whole budget is still delivered alone', () => {
  const huge = msg('h1', 'c1', 1, x(5000));
  const next = msg('h2', 'c1', 2, 'next');
  assert.deepEqual(page(readChatPage([huge, next], null, 0, 1000)), { messages: [huge], omitted: 1, truncated: 0 });
  assert.deepEqual(page(readChatPage([huge], 'm0', 100, 50)), { messages: [cut(huge, x(99) + ELLIPSIS)], omitted: 0, truncated: 1 });
  assert.deepEqual(page(readChatPage([huge, next], null, 0, 0)), { messages: [huge], omitted: 1, truncated: 0 });
  assert.deepEqual(burst(drainChatBurst([next, huge], 0, 1000)), { messages: [huge], hasMore: true, truncated: 0 });
  assert.deepEqual(burst(drainChatBurst([huge], 10, 0)), { messages: [cut(huge, x(9) + ELLIPSIS)], hasMore: false, truncated: 1 });
});

test('single-budget-implementation: both callers use one consolidated deliverChatPage and keep no budget or truncation code', () => {
  for (const rel of ['src/chatBacklog.mjs', 'src/chatRead.mjs']) {
    const code = codeOf(rel);
    assert.ok(importsAll(code, './chatPayload.mjs', ['deliverChatPage']), rel + ' must import deliverChatPage from ./chatPayload.mjs');
    for (const own of ['chatMessageResponseCost', 'capChatMessagesToResponseBudget', 'truncateChatMessage', 'countTruncatedMessages',
      'CHAT_MESSAGE_OVERHEAD_CHARS', 'truncateForBudget', 'contentTruncated', 'content.length']) {
      assert.ok(!code.includes(own), rel + ' still carries budget or truncation code of its own: ' + own);
    }
  }
});
`;

const CHAT_BUDGET_CONSOLIDATION = {
  ...COMMON,
  id: 'refactor-chat-budget-consolidation',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/chatPayload.ts`, `${SRC}util/chatBacklog.ts`, `${SRC}tools/chatRead.ts`, `${SRC}util/memorySettings.ts`],
    adaptation: 'adapted',
    note: 'Adapted. chatPayload.mjs keeps the frozen cost, cap and truncation helpers with types removed, unrelated '
      + 'exports dropped and truncateForBudget (util/memorySettings.ts) inlined. chatBacklog.mjs reduces summarizeChatBurst '
      + 'to one pile: no off-bus messages, scan scope or logging. chatRead.mjs keeps the inline cost loop of tools/chatRead.ts '
      + 'but pages forward, oldest first; the frozen tool trims the oldest of a newest-first window. Budgets are '
      + 'parameters so tests can use small ones.',
  },
  intendedBehavior: 'Chat responses are budgeted in two callers: drainChatBurst(pile, maxContentChars, budget) in '
    + 'src/chatBacklog.mjs caps with capChatMessagesToResponseBudget and then truncates, and readChatPage(window, '
    + 'sinceId, maxContentChars, budget) in src/chatRead.mjs carries its own inline copy of the cost loop. Consolidate '
    + 'per-message truncation and aggregate response budgeting into ONE helper exported from src/chatPayload.mjs, '
    + 'deliverChatPage(messages, maxContentChars, budget), returning { messages, dropped, cursor, truncated }: the '
    + 'truncated views of the delivered prefix, the undelivered tail, the id of the LAST DELIVERED message (null when '
    + 'nothing is delivered) and the count of truncated views. Make both callers use it and keep no budget or '
    + 'truncation arithmetic of their own. This is a pure refactor: keep the same cut points (always at least one '
    + 'message, even an oversized one), views, flags, counts, ordering, de-duplication and count cap, and cursors that '
    + 'point at the last delivered message so omitted messages stay unread (readChatPage still falls back to sinceId, '
    + 'or null, when nothing is delivered). Keep the existing chatPayload exports working for other callers.',
  initialFiles: { 'src/chatPayload.mjs': CHAT_PAYLOAD, 'src/chatBacklog.mjs': CHAT_BACKLOG, 'src/chatRead.mjs': CHAT_READ },
  assessmentFiles: { 'acceptance.test.mjs': CHAT_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'page-output-preserved', description: 'Both callers return the original views, omitted/hasMore flags and truncation counts for the fixed inputs.' },
      { id: 'cursor-never-skips-omitted', description: 'readChatPage and the backlog channel cursors point at the last delivered message, never past an omitted one.' },
      { id: 'oversized-first-message-delivered', description: 'A first message larger than the whole budget is still delivered alone by both callers.' },
      { id: 'single-budget-implementation', description: 'Both callers import deliverChatPage from ./chatPayload.mjs and carry no cost, cap or truncation code of their own.' },
    ],
    coverageTags: ['behavior-preservation', 'cursor-safety'],
  },
  snapshotDigest: 'sha256:0ce1b0693c021866f680c7cf3d19a7ce0eec50b45a0462f6ca3f4aa49fa75a75',
  assessmentDigest: 'sha256:257e320ce85fb50f29d1d0392aa716a76fe13f3fec5de167aa6d12ff194723b7',
};

// -----------------------------------------------------------------------------
// Case 3: one path normalizer shared by both callers
// -----------------------------------------------------------------------------

/** The private normalizer each case-3 caller carries, byte-identical in both files. */
const PRIVATE_NORMALIZER = js`const MAX_PATH_LEN = 500;

function invalidInput(field, reason) {
  const error = new Error('[INVALID_INPUT] Invalid ' + field + ': ' + reason);
  error.code = 'INVALID_INPUT';
  error.context = { field, reason };
  return error;
}

/**
 * Canonicalize one affected-file path: backslashes become forward slashes, a leading
 * ./ is stripped, surrounding whitespace trimmed, . and empty segments dropped. Throws
 * on an empty or non-string entry, traversal, an absolute Unix or Windows path, or more
 * than MAX_PATH_LEN characters.
 */
function normalizeEntry(raw, fieldName) {
  if (typeof raw !== 'string') {
    throw invalidInput(fieldName, 'each entry must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw invalidInput(fieldName, 'entry cannot be empty');
  }
  if (trimmed.length > MAX_PATH_LEN) {
    throw invalidInput(fieldName, 'entry too long (max ' + MAX_PATH_LEN + ' chars)');
  }
  let p = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('/')) {
    throw invalidInput(fieldName, 'paths must be project-relative (got "' + raw + '")');
  }
  if (/^[A-Za-z]:\//.test(p)) {
    throw invalidInput(fieldName, 'paths must be project-relative (got "' + raw + '")');
  }
  const segments = p.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw invalidInput(fieldName, 'path traversal not allowed (got "' + raw + '")');
  }
  p = segments.filter((seg) => seg !== '' && seg !== '.').join('/');
  if (p.length === 0) {
    throw invalidInput(fieldName, 'entry resolves to empty path (got "' + raw + '")');
  }
  return p;
}
`;

const PLAN_SCOPE = js`// Adapted from normalizeAffectedFiles in packages/moe-daemon/src/util/affectedFiles.ts at
// the frozen commit: types removed and invalidInput inlined as an Error carrying code and
// context like MoeError. This caller keeps its own private copy of the path normalization.
${PRIVATE_NORMALIZER}
/** Normalize a plan step's affected files, deduplicating while preserving first-seen order. */
export function normalizeScope(raw, fieldName = 'affectedFiles') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw invalidInput(fieldName, 'must be an array of strings');
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const normalized = normalizeEntry(entry, fieldName);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}
`;

const COLLISIONS = js`// Adapted from the collision keys in packages/moe-daemon/src/util/affectedFiles.ts and
// their reuse in util/cachedPlanPaths.ts at the frozen commit: types removed, invalidInput
// inlined, and case folding takes an explicit platform instead of reading process.platform,
// so results are deterministic on every host. This caller keeps its own private copy of
// the path normalization.
${PRIVATE_NORMALIZER}
/**
 * The claimed paths another active task also touches, in claimed order, each reported
 * once. win32 and darwin filesystems are case-insensitive, so there Src/A.ts and
 * src/a.ts are the same file; everywhere else case is significant.
 */
export function findCollisions(claimed, active, platform) {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const key = (p) => (caseInsensitive ? p.toLowerCase() : p);
  const activeKeys = new Set(active.map((entry) => key(normalizeEntry(entry, 'activeFiles'))));
  const seen = new Set();
  const out = [];
  for (const entry of claimed) {
    const p = normalizeEntry(entry, 'claimedFiles');
    const k = key(p);
    if (activeKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}
`;

const PATHS_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { normalizeScope } = await load('src/planScope.mjs');
const { findCollisions } = await load('src/collisions.mjs');
const BS = String.fromCharCode(92);
const E_ACUTE = String.fromCharCode(0xe9);
const E_ACUTE_UPPER = String.fromCharCode(0xc9);
const KANJI = String.fromCharCode(0x6587);
const SMILE = String.fromCodePoint(0x1f600);
const rejects = (fn, field, reason) => assert.throws(fn, (error) => {
  assert.equal(error.message, '[INVALID_INPUT] Invalid ' + field + ': ' + reason);
  assert.equal(error.code, 'INVALID_INPUT');
  assert.deepEqual(error.context, { field, reason });
  return true;
}, field + ': ' + reason);

// Every expected value below was captured from the unsolved original.
test('plan-scope-preserved: normalizeScope keeps its exact output, order and exact-case de-duplication', () => {
  const raw = ['src' + BS + 'a.ts', './src/b.ts', 'src//c.ts', 'src/./d.ts', '  src/e.ts  ', 'src/a.ts', 'Src/A.ts',
    '.' + BS + 'src' + BS + 'f.ts', 'src/dir/', 'docs/caf' + E_ACUTE + '.md', 'docs/' + KANJI + SMILE + '.md', '.hidden/x', 'a/.../b'];
  assert.deepEqual(normalizeScope(raw), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'Src/A.ts', 'src/f.ts',
    'src/dir', 'docs/caf' + E_ACUTE + '.md', 'docs/' + KANJI + SMILE + '.md', '.hidden/x', 'a/.../b']);
  assert.deepEqual(normalizeScope(undefined), []);
  assert.deepEqual(normalizeScope(null), []);
  assert.deepEqual(normalizeScope([]), []);
  assert.deepEqual(normalizeScope(['b.ts', 'a.ts', 'b.ts'], 'newFiles'), ['b.ts', 'a.ts']);
  assert.deepEqual(normalizeScope(['y'.repeat(500)]), ['y'.repeat(500)]);
});

test('collisions-preserved: case folds only on win32 and darwin', () => {
  const claimed = ['Src/A.ts', 'lib' + BS + 'b.ts', 'c.ts', 'docs/' + E_ACUTE_UPPER + '.md', 'only/mine.ts'];
  const active = ['src/a.ts', 'lib/b.ts', 'C.TS', 'docs/' + E_ACUTE + '.md'];
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(findCollisions(claimed, active, platform), ['Src/A.ts', 'lib/b.ts', 'c.ts', 'docs/' + E_ACUTE_UPPER + '.md'], platform);
  }
  for (const platform of ['linux', 'freebsd', undefined]) {
    assert.deepEqual(findCollisions(claimed, active, platform), ['lib/b.ts'], String(platform));
  }
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(findCollisions(['src/a.ts', 'SRC/A.TS', './src/a.ts'], ['src/a.ts'], platform), ['src/a.ts'], platform);
  }
  assert.deepEqual(findCollisions(['Src/A.ts'], ['src/a.ts'], 'linux'), []);
  assert.deepEqual(findCollisions([], ['a.ts'], 'win32'), []);
});

test('errors-preserved: both callers reject the same paths with the same messages and fields', () => {
  rejects(() => normalizeScope(['../x']), 'affectedFiles', 'path traversal not allowed (got "../x")');
  rejects(() => normalizeScope(['ok.ts', 'a/b/../c'], 'newFiles'), 'newFiles', 'path traversal not allowed (got "a/b/../c")');
  rejects(() => normalizeScope(['/etc/passwd']), 'affectedFiles', 'paths must be project-relative (got "/etc/passwd")');
  rejects(() => normalizeScope(['C:' + BS + 'x' + BS + 'y.ts']), 'affectedFiles', 'paths must be project-relative (got "C:' + BS + 'x' + BS + 'y.ts")');
  rejects(() => normalizeScope([BS + BS + 'server' + BS + 'share']), 'affectedFiles',
    'paths must be project-relative (got "' + BS + BS + 'server' + BS + 'share")');
  rejects(() => normalizeScope(['c:/x']), 'affectedFiles', 'paths must be project-relative (got "c:/x")');
  rejects(() => normalizeScope(['   ']), 'affectedFiles', 'entry cannot be empty');
  rejects(() => normalizeScope([7]), 'affectedFiles', 'each entry must be a string');
  rejects(() => normalizeScope(['x'.repeat(501)]), 'affectedFiles', 'entry too long (max 500 chars)');
  rejects(() => normalizeScope(['./']), 'affectedFiles', 'entry resolves to empty path (got "./")');
  rejects(() => normalizeScope(['.']), 'affectedFiles', 'entry resolves to empty path (got ".")');
  rejects(() => normalizeScope('src/a.ts'), 'affectedFiles', 'must be an array of strings');
  rejects(() => findCollisions(['a/../b'], [], 'linux'), 'claimedFiles', 'path traversal not allowed (got "a/../b")');
  rejects(() => findCollisions([], ['/abs'], 'win32'), 'activeFiles', 'paths must be project-relative (got "/abs")');
  rejects(() => findCollisions(['   '], ['a.ts'], 'darwin'), 'claimedFiles', 'entry cannot be empty');
});

test('single-path-normalizer: both callers import the shared normalizer from ./affectedFiles.mjs and keep no copy of it', () => {
  assert.ok(importsAll(codeOf('src/planScope.mjs'), './affectedFiles.mjs', ['normalizeAffectedFile']),
    'planScope.mjs must import normalizeAffectedFile from ./affectedFiles.mjs');
  assert.ok(importsAll(codeOf('src/collisions.mjs'), './affectedFiles.mjs', ['normalizeAffectedFile', 'pathKey']),
    'collisions.mjs must import normalizeAffectedFile and pathKey from ./affectedFiles.mjs');
  for (const rel of ['src/planScope.mjs', 'src/collisions.mjs']) {
    const code = codeOf(rel);
    for (const own of ['replace(', 'toLowerCase', 'toUpperCase', "'..'", '"..', 'traversal', 'project-relative', 'win32', 'darwin',
      'MAX_PATH_LEN', '.trim(']) {
      assert.ok(!code.includes(own), rel + ' still carries path normalization of its own: ' + own);
    }
  }
});
`;

const SHARED_PATH_NORMALIZATION = {
  ...COMMON,
  id: 'refactor-shared-path-normalization',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/affectedFiles.ts`, `${SRC}util/cachedPlanPaths.ts`],
    adaptation: 'adapted',
    note: 'Adapted. At the frozen commit util/affectedFiles.ts already exports normalizeAffectedFile and pathKey, and '
      + 'util/cachedPlanPaths.ts reuses them; this fixture rewinds that to a pre-extraction state in which each of two '
      + 'callers carries a byte-identical private copy of normalizeAffectedFile (types removed, invalidInput inlined with '
      + 'MoeError\'s message and context, and its code name INVALID_INPUT as error.code where MoeError keeps a numeric '
      + 'code). collisions.mjs folds case from an explicit platform argument instead of process.platform, so results '
      + 'are host-independent. With that code mapped, the frozen normalizeAffectedFiles and normalizeAffectedFile pass '
      + 'every behaviour criterion of the held-out assessment.',
  },
  intendedBehavior: 'src/planScope.mjs (normalizeScope(list, fieldName)) and src/collisions.mjs (findCollisions(claimed, '
    + 'active, platform)) each carry an identical private copy of the affected-file path normalizer, and collisions.mjs '
    + 'also folds case by itself. Extract ONE shared module, src/affectedFiles.mjs, exporting '
    + "normalizeAffectedFile(raw, fieldName = 'affectedFiles') and pathKey(path, platform), where pathKey folds case only "
    + 'for the case-insensitive win32 and darwin filesystems. Make both callers import them and keep no separator, '
    + 'traversal or case-folding logic of their own. This is a pure refactor: identical normalized output, order and '
    + 'exact-case de-duplication in normalizeScope, identical collisions on every platform (win32 and darwin treat '
    + 'Src/A.ts and src/a.ts as one file, linux and other platforms do not), and identical errors: the same messages, '
    + 'field names, code and context for traversal, absolute Unix or Windows paths, empty, non-string and over-long '
    + 'entries.',
  initialFiles: { 'src/planScope.mjs': PLAN_SCOPE, 'src/collisions.mjs': COLLISIONS },
  assessmentFiles: { 'acceptance.test.mjs': PATHS_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'plan-scope-preserved', description: 'normalizeScope returns the original normalized paths, order and exact-case de-duplication.' },
      { id: 'collisions-preserved', description: 'findCollisions folds case on win32 and darwin only, with the original results and order.' },
      { id: 'errors-preserved', description: 'Both callers reject the same inputs with the original message, field, code and context.' },
      { id: 'single-path-normalizer', description: 'Both callers import the normalizer (and collisions.mjs pathKey) from ./affectedFiles.mjs and keep no copy of the logic.' },
    ],
    coverageTags: ['reusable-helper', 'behavior-preservation', 'windows-paths'],
  },
  snapshotDigest: 'sha256:156e363f96e1579f871413d99978c1aac608b38b3e21207eb7da184471b4a2fa',
  assessmentDigest: 'sha256:a375dafc8bfc202e29a5921ed848b5cc9b37600aa23bc58817003be9f0ad74ee',
};

// -----------------------------------------------------------------------------
// Case 4: snapshot readers return detached copies
// -----------------------------------------------------------------------------

const ERRORS = js`// Reduced from packages/moe-daemon/src/util/errors.ts at the frozen commit: only the
// INVALID_INPUT error survives, with MoeError's message prefix, code name and context.
export function invalidInput(field, reason) {
  const error = new Error('[INVALID_INPUT] Invalid ' + field + ': ' + reason);
  error.name = 'MoeError';
  error.code = 'INVALID_INPUT';
  error.context = { field, reason };
  return error;
}
`;

const EXECUTION_PROFILE = js`// Adapted from packages/moe-daemon/src/delivery/executionProfile.ts at the frozen commit:
// types removed, template literals rewritten as string concatenation and
// assertExecutionProfileReady dropped. Unlike the frozen source, readExecutionPolicySnapshot
// returns the validated INPUT object itself, so every caller shares (and can mutate) the
// stored snapshot.
import { invalidInput } from './errors.mjs';

const PROFILES = Object.freeze({
  legacy: true,
  observe: true,
  'verified-local': true,
});
export const EXECUTION_PROFILES = Object.freeze(Object.keys(PROFILES));

function decodeProfile(value, field) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value)) return value;
  throw invalidInput(field, 'must be one of: ' + EXECUTION_PROFILES.join(', '));
}

/** Recognizing a requested profile does not certify that its execution path is ready. */
export function resolveExecutionProfile(settings) {
  const raw = settings?.executionProfile;
  return raw === undefined ? 'legacy' : decodeProfile(raw, 'executionProfile');
}

/** Strictly read an optional { version: 1, profile, planRevision } snapshot. */
export function readExecutionPolicySnapshot(raw) {
  if (raw === undefined) return undefined;
  const field = 'executionPolicySnapshot';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidInput(field, 'must be an object');
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput(field, 'must be a plain object');
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !['version', 'profile', 'planRevision'].every(key => Object.prototype.hasOwnProperty.call(raw, key))) {
    throw invalidInput(field, 'must contain only version, profile and planRevision');
  }
  if (raw.version !== 1) throw invalidInput(field + '.version', 'must be 1');
  decodeProfile(raw.profile, field + '.profile');
  const planRevision = raw.planRevision;
  if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision < 0) {
    throw invalidInput(field + '.planRevision', 'must be a non-negative safe integer');
  }
  return raw;
}

/** A project rollback cannot downgrade the requirements a verified task already owes. */
export function resolveTaskExecutionProfile(settings, snapshot) {
  const current = resolveExecutionProfile(settings);
  const stored = readExecutionPolicySnapshot(snapshot);
  return stored?.profile === 'verified-local' ? 'verified-local' : current;
}
`;

const SNAPSHOT_ASSESSMENT = js`${PRELUDE}
const { readExecutionPolicySnapshot: read, resolveExecutionProfile, resolveTaskExecutionProfile } = await load('src/executionProfile.mjs');
const PREFIX = '[INVALID_INPUT] Invalid ';
const PROFILE_REASON = 'must be one of: legacy, observe, verified-local';
const REVISION_REASON = 'must be a non-negative safe integer';
const snapshot = (profile, planRevision) => ({ version: 1, profile, planRevision });
/** Accepted values are compared on the three validated fields only. */
const outcome = (value) => {
  try {
    const r = read(value);
    return r === undefined ? ['accepted', undefined] : ['accepted', { version: r.version, profile: r.profile, planRevision: r.planRevision }];
  } catch (error) {
    return ['rejected', error.message];
  }
};
const rejects = (fn, field, reason, label) => assert.throws(fn, (error) => {
  assert.equal(error.message, PREFIX + field + ': ' + reason);
  assert.equal(error.code, 'INVALID_INPUT');
  assert.deepEqual(error.context, { field, reason });
  return true;
}, label);
class Snapshot {
  constructor() {
    this.version = 1;
    this.profile = 'legacy';
    this.planRevision = 1;
  }
}

test('returns-detached: an accepted snapshot is a fresh plain copy that shares nothing with the input', () => {
  const input = snapshot('observe', 4);
  const result = read(input);
  assert.notEqual(result, input);
  assert.deepEqual({ ...result }, snapshot('observe', 4));
  result.planRevision = 9;
  assert.equal(input.planRevision, 4);
  input.profile = 'legacy';
  assert.equal(result.profile, 'observe');
  assert.notEqual(read(input), read(input));

  const frozen = Object.freeze(snapshot('legacy', 2));
  const copy = read(frozen);
  assert.equal(Object.isFrozen(copy), false);
  copy.planRevision = 3;
  assert.equal(copy.planRevision, 3);
  assert.equal(frozen.planRevision, 2);

  const bare = Object.assign(Object.create(null), snapshot('verified-local', 0));
  assert.equal(Object.getPrototypeOf(read(bare)), Object.prototype);
  const hidden = Object.defineProperty(snapshot('observe', 2), 'note', { value: 'x', enumerable: false });
  assert.deepEqual(Reflect.ownKeys(read(hidden)).sort(), ['planRevision', 'profile', 'version']);
});

// Captured from the unsolved original, which matches the frozen decoder on every row.
test('validation-preserved: the same inputs are accepted and rejected for the same structural reasons', () => {
  const OBJECT = PREFIX + 'executionPolicySnapshot: must be an object';
  const PLAIN = PREFIX + 'executionPolicySnapshot: must be a plain object';
  const KEYS = PREFIX + 'executionPolicySnapshot: must contain only version, profile and planRevision';
  const rows = [
    ['plain', snapshot('observe', 3), ['accepted', snapshot('observe', 3)]],
    ['null prototype', Object.assign(Object.create(null), snapshot('verified-local', 0)), ['accepted', snapshot('verified-local', 0)]],
    ['frozen', Object.freeze(snapshot('legacy', Number.MAX_SAFE_INTEGER)), ['accepted', snapshot('legacy', Number.MAX_SAFE_INTEGER)]],
    ['non-enumerable extra', Object.defineProperty(snapshot('observe', 2), 'note', { value: 'x', enumerable: false }),
      ['accepted', snapshot('observe', 2)]],
    ['symbol extra', { ...snapshot('observe', 2), [Symbol('tag')]: 1 }, ['accepted', snapshot('observe', 2)]],
    ['undefined', undefined, ['accepted', undefined]],
    ['own extra key holding undefined', { ...snapshot('legacy', 0), extra: undefined }, ['rejected', KEYS]],
    ['own extra key', { ...snapshot('legacy', 0), extra: 1 }, ['rejected', KEYS]],
    ['missing key', { version: 1, profile: 'legacy' }, ['rejected', KEYS]],
    ['class instance', new Snapshot(), ['rejected', PLAIN]],
    ['inherited fields', Object.create(snapshot('legacy', 1)), ['rejected', PLAIN]],
    ['own fields over a null-prototype parent', Object.assign(Object.create(Object.create(null)), snapshot('legacy', 1)), ['rejected', PLAIN]],
    ['date', new Date(0), ['rejected', PLAIN]],
    ['map', new Map(), ['rejected', PLAIN]],
    ['array', [], ['rejected', OBJECT]],
    ['null', null, ['rejected', OBJECT]],
    ['zero', 0, ['rejected', OBJECT]],
    ['empty string', '', ['rejected', OBJECT]],
    ['false', false, ['rejected', OBJECT]],
    ['string', 'snapshot', ['rejected', OBJECT]],
    ['function', () => 1, ['rejected', OBJECT]],
  ];
  for (const [name, value, expected] of rows) assert.deepEqual(outcome(value), expected, name);
});

test('messages-preserved: value errors keep their order, field, message, code and context', () => {
  const field = 'executionPolicySnapshot';
  const rows = [
    [{ version: 2, profile: 'legacy', planRevision: 0 }, field + '.version', 'must be 1'],
    [{ version: '1', profile: 'legacy', planRevision: 0 }, field + '.version', 'must be 1'],
    [{ version: 2, profile: 'LEGACY', planRevision: -1 }, field + '.version', 'must be 1'],
    [snapshot('LEGACY', -1), field + '.profile', PROFILE_REASON],
    [snapshot(null, 0), field + '.profile', PROFILE_REASON],
    [snapshot('toString', 0), field + '.profile', PROFILE_REASON],
    [snapshot('legacy', -1), field + '.planRevision', REVISION_REASON],
    [snapshot('legacy', 1.5), field + '.planRevision', REVISION_REASON],
    [snapshot('legacy', '1'), field + '.planRevision', REVISION_REASON],
    [snapshot('legacy', NaN), field + '.planRevision', REVISION_REASON],
    [snapshot('legacy', Infinity), field + '.planRevision', REVISION_REASON],
    [snapshot('legacy', 2 ** 53), field + '.planRevision', REVISION_REASON],
    [[], field, 'must be an object'],
    [{ version: 1 }, field, 'must contain only version, profile and planRevision'],
  ];
  for (const [value, at, reason] of rows) rejects(() => read(value), at, reason, String(JSON.stringify(value)));
});

test('task-profile-unchanged: resolveTaskExecutionProfile and resolveExecutionProfile keep their results', () => {
  assert.equal(resolveTaskExecutionProfile(undefined, undefined), 'legacy');
  assert.equal(resolveTaskExecutionProfile({ executionProfile: 'observe' }, undefined), 'observe');
  assert.equal(resolveTaskExecutionProfile({ executionProfile: 'observe' }, snapshot('verified-local', 2)), 'verified-local');
  assert.equal(resolveTaskExecutionProfile({}, snapshot('legacy', 0)), 'legacy');
  assert.equal(resolveTaskExecutionProfile({ executionProfile: 'verified-local' }, snapshot('observe', 1)), 'verified-local');
  assert.equal(resolveTaskExecutionProfile(null, undefined), 'legacy');
  assert.equal(resolveExecutionProfile(null), 'legacy');
  assert.equal(resolveExecutionProfile({ executionProfile: undefined }), 'legacy');
  rejects(() => resolveTaskExecutionProfile({ executionProfile: 'observe' }, snapshot('observe', -1)),
    'executionPolicySnapshot.planRevision', REVISION_REASON, 'invalid stored snapshot');
  rejects(() => resolveTaskExecutionProfile({ executionProfile: 'strong' }, snapshot('verified-local', 1)),
    'executionProfile', PROFILE_REASON, 'settings are decoded first');
  rejects(() => resolveExecutionProfile({ executionProfile: null }), 'executionProfile', PROFILE_REASON, 'null profile');
});
`;

const DETACHED_SNAPSHOT_RETURNS = {
  ...COMMON,
  id: 'refactor-detached-snapshot-returns',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}delivery/executionProfile.ts`, `${SRC}util/errors.ts`],
    adaptation: 'adapted',
    note: 'Adapted from delivery/executionProfile.ts as it was at the frozen commit (later commits changed it): types '
      + 'removed, template literals rewritten and assertExecutionProfileReady dropped; errors.mjs reduces '
      + 'util/errors.ts to the INVALID_INPUT shape (MoeError\'s message, name and context, with its code name as '
      + 'error.code where MoeError keeps a numeric code). The refactor target is deliberately re-introduced: the frozen '
      + 'readExecutionPolicySnapshot already returns a fresh literal, while this fixture returns the validated input '
      + 'object itself. With that code mapped, the frozen module passes every criterion of the held-out assessment.',
  },
  intendedBehavior: 'readExecutionPolicySnapshot(raw) in src/executionProfile.mjs validates a { version: 1, profile, '
    + 'planRevision } snapshot and then returns the caller-supplied object itself, so every reader shares, and can '
    + 'mutate, the stored snapshot (and a frozen input yields a frozen result). Refactor it to return a detached copy: '
    + 'a fresh plain object holding only the three validated fields. This is a pure refactor of the return value: the '
    + 'same inputs must be accepted and rejected for the same reasons (plain and null-prototype objects only, exactly '
    + 'the three own enumerable keys, version 1, a known profile, a non-negative safe-integer planRevision), with the '
    + 'same check order, messages, codes and context, and resolveExecutionProfile and resolveTaskExecutionProfile must '
    + 'keep their results.',
  initialFiles: { 'src/errors.mjs': ERRORS, 'src/executionProfile.mjs': EXECUTION_PROFILE },
  assessmentFiles: { 'acceptance.test.mjs': SNAPSHOT_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'returns-detached', description: 'An accepted snapshot is a fresh, mutable plain object with only the three fields, sharing nothing with the input.' },
      { id: 'validation-preserved', description: 'The original accept/reject table holds, including the undefined-valued extra key, class instances and inherited fields.' },
      { id: 'messages-preserved', description: 'Value errors keep their check order, field, message, code and context.' },
      { id: 'task-profile-unchanged', description: 'resolveExecutionProfile and resolveTaskExecutionProfile keep their results and errors.' },
    ],
    coverageTags: ['behavior-preservation', 'detached-results'],
  },
  snapshotDigest: 'sha256:41bb7bf16a4f3f92c0cddcd555fb6c26bd3f06e45c45ffb2bae36ac1768bd110',
  assessmentDigest: 'sha256:cd2418de03a531b1439d7d052a44186cf2521f2cab436d65151dfdd39e00a804',
};

// -----------------------------------------------------------------------------
// Case 5: one UTF-8-aware bounded tail
// -----------------------------------------------------------------------------

const TEXT_BUDGET = js`// Reduced from packages/moe-daemon/src/util/memorySettings.ts at the frozen commit: only
// truncateForBudget, with types removed and the ellipsis written as a char code. This
// module is the home of the shared text-budget helpers.
const ELLIPSIS = String.fromCharCode(0x2026);

/** Cut text to at most maxChars UTF-16 units, ending in an ellipsis when it was cut. */
export function truncateForBudget(text, maxChars) {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).trimEnd() + ELLIPSIS,
    truncated: true,
  };
}
`;

const CHECK_RUN_TAIL = js`// Adapted from boundOutputTail in packages/moe-daemon/src/state/checkRunStore.ts at the
// frozen commit: types removed, the error inlined with a reduced renderGot, and the byte
// bound is a parameter (default MAX_CHECK_LOG_BYTES) so tests can use small bounds.
export const MAX_CHECK_LOG_BYTES = 16384;

const renderGot = (value) => (value === null ? 'null'
  : typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol'
    ? 'a value of type ' + typeof value : String(value));

/**
 * Keep the final maxBytes UTF-8 bytes of a check log, then move the start past
 * continuation bytes (0b10xxxxxx), so the kept text never begins inside a character
 * and the cut itself never introduces a U+FFFD.
 */
export function boundOutputTail(value, maxBytes = MAX_CHECK_LOG_BYTES) {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    const error = new Error('[INVALID_INPUT] Invalid outputTail: must be a string when supplied (got ' + renderGot(value) + ')');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
`;

const VERIFICATION_SUMMARY = js`// Adapted from assertVerificationEvidence in packages/moe-daemon/src/util/enforcement.ts at
// the frozen commit: reduced to the command, exit code and output tail, errors inlined, and the
// tail bounded in UTF-8 bytes by its own copy of the check-run byte cut (the frozen code
// keeps the last 2000 UTF-16 units with slice instead).
export const MAX_VERIFICATION_TAIL_BYTES = 2000;

function invalid(field, reason) {
  const error = new Error('[INVALID_INPUT] Invalid ' + field + ': ' + reason);
  error.code = 'INVALID_INPUT';
  return error;
}

/** Validate completion evidence and keep only the bounded tail of its output. */
export function summarizeVerification(verification, maxBytes = MAX_VERIFICATION_TAIL_BYTES) {
  if (typeof verification !== 'object' || verification === null || Array.isArray(verification)) {
    throw invalid('verification', 'must be an object');
  }
  const v = verification;
  if (typeof v.command !== 'string' || v.command.trim().length === 0) {
    throw invalid('verification.command', 'must be a non-empty string');
  }
  if (typeof v.exitCode !== 'number' || !Number.isInteger(v.exitCode)) {
    throw invalid('verification.exitCode', 'must be an integer exit code');
  }
  if (v.outputTail !== undefined && typeof v.outputTail !== 'string') {
    throw invalid('verification.outputTail', 'must be a string');
  }
  let outputTail;
  if (typeof v.outputTail === 'string' && v.outputTail.length > 0) {
    const encoded = Buffer.from(v.outputTail, 'utf8');
    let from = encoded.length > maxBytes ? encoded.length - maxBytes : 0;
    // Never start inside a character: skip UTF-8 continuation bytes.
    while (from < encoded.length && (encoded[from] & 0xc0) === 0x80) from++;
    outputTail = encoded.subarray(from).toString('utf8');
  }
  return {
    command: v.command.trim(),
    exitCode: v.exitCode,
    ...(outputTail !== undefined ? { outputTail } : {}),
  };
}
`;

const TAIL_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { boundOutputTail, MAX_CHECK_LOG_BYTES } = await load('src/checkRunTail.mjs');
const { summarizeVerification, MAX_VERIFICATION_TAIL_BYTES } = await load('src/verificationSummary.mjs');
const KAN = String.fromCharCode(0x6f22);
const JI = String.fromCharCode(0x5b57);
const CJK = KAN + JI;
const SMILE = String.fromCodePoint(0x1f600);
const E2 = String.fromCharCode(0xe9);
const REPLACEMENT = String.fromCharCode(0xfffd);
const tailOf = (text, max) => summarizeVerification({ command: 'npm test', exitCode: 0, outputTail: text }, max).outputTail;
const fails = (fn, message) => assert.throws(fn, (error) => {
  assert.equal(error.message, message);
  assert.equal(error.code, 'INVALID_INPUT');
  return true;
}, message);

// Captured from the unsolved original: [text, maxBytes, kept tail]. CJK characters take 3
// UTF-8 bytes, the emoji 4 and E2 2, so several cuts land inside a character.
const TABLE = [
  ['abcdef', 3, 'def'], ['abcdef', 6, 'abcdef'], ['abcdef', 7, 'abcdef'], ['abcdef', 0, ''],
  ['ab' + CJK, 3, JI], ['ab' + CJK, 4, JI], ['ab' + CJK, 5, JI], ['ab' + CJK, 6, CJK], ['ab' + CJK, 7, 'b' + CJK],
  ['ab' + CJK, 8, 'ab' + CJK],
  ['x' + SMILE + 'y', 1, 'y'], ['x' + SMILE + 'y', 2, 'y'], ['x' + SMILE + 'y', 4, 'y'], ['x' + SMILE + 'y', 5, SMILE + 'y'],
  ['x' + SMILE + 'y', 6, 'x' + SMILE + 'y'],
  [E2 + E2 + E2, 3, E2], [E2 + E2 + E2, 4, E2 + E2], [SMILE + SMILE, 7, SMILE], [SMILE + SMILE, 8, SMILE + SMILE],
];
const SAMPLES = ['plain ascii text', 'ab' + CJK + 'cd' + E2 + 'e', SMILE + 'x' + SMILE + E2 + KAN, E2.repeat(5), SMILE.repeat(4),
  'z' + KAN.repeat(3) + SMILE];

test('tail-output-preserved: both callers keep the same tails, defaults, shapes and errors', () => {
  for (const [text, max, kept] of TABLE) {
    assert.equal(boundOutputTail(text, max), kept, 'boundOutputTail ' + JSON.stringify([text, max]));
    assert.equal(tailOf(text, max), kept, 'summarizeVerification ' + JSON.stringify([text, max]));
  }
  assert.equal(MAX_CHECK_LOG_BYTES, 16384);
  assert.equal(MAX_VERIFICATION_TAIL_BYTES, 2000);
  assert.equal(boundOutputTail('L'.repeat(16380) + SMILE + 'end'), 'L'.repeat(16377) + SMILE + 'end');
  assert.equal(boundOutputTail(SMILE + 'L'.repeat(16382)), 'L'.repeat(16382));
  assert.deepEqual(summarizeVerification({ command: '  run  ', exitCode: 0, outputTail: 'v'.repeat(1990) + CJK.repeat(5) }),
    { command: 'run', exitCode: 0, outputTail: 'v'.repeat(1970) + CJK.repeat(5) });
  assert.equal(summarizeVerification({ command: 'c', exitCode: 0, outputTail: 'x' + KAN.repeat(667) }).outputTail, KAN.repeat(666));
  assert.equal(boundOutputTail(undefined), '');
  assert.equal(boundOutputTail('', 5), '');
  assert.deepEqual(summarizeVerification({ command: 'c', exitCode: 1 }), { command: 'c', exitCode: 1 });
  assert.deepEqual(summarizeVerification({ command: 'c', exitCode: 0, outputTail: '' }), { command: 'c', exitCode: 0 });
  assert.deepEqual(summarizeVerification({ command: 'c', exitCode: 0, outputTail: 'abc' }, 0), { command: 'c', exitCode: 0, outputTail: '' });
  fails(() => boundOutputTail(5), '[INVALID_INPUT] Invalid outputTail: must be a string when supplied (got 5)');
  fails(() => boundOutputTail(null), '[INVALID_INPUT] Invalid outputTail: must be a string when supplied (got null)');
  fails(() => boundOutputTail({}), '[INVALID_INPUT] Invalid outputTail: must be a string when supplied (got a value of type object)');
  fails(() => summarizeVerification({ command: 'c', exitCode: 0, outputTail: 5 }), '[INVALID_INPUT] Invalid verification.outputTail: must be a string');
  fails(() => summarizeVerification({ command: ' ', exitCode: 0 }), '[INVALID_INPUT] Invalid verification.command: must be a non-empty string');
  fails(() => summarizeVerification({ command: 'c', exitCode: 1.5 }), '[INVALID_INPUT] Invalid verification.exitCode: must be an integer exit code');
  fails(() => summarizeVerification(null), '[INVALID_INPUT] Invalid verification: must be an object');
});

test('complete-characters: every kept tail is whole characters and the longest byte suffix that fits', () => {
  for (const text of SAMPLES) {
    const bytes = Buffer.from(text, 'utf8');
    for (let max = 0; max <= bytes.length + 1; max++) {
      for (const [name, tail] of [['boundOutputTail', boundOutputTail(text, max)], ['summarizeVerification', tailOf(text, max)]]) {
        const label = name + ' ' + JSON.stringify([text, max]);
        const kept = Buffer.from(tail, 'utf8');
        assert.ok(!tail.includes(REPLACEMENT), label + ' introduced U+FFFD');
        assert.ok(kept.equals(bytes.subarray(bytes.length - kept.length)), label + ' is not a byte suffix of the input');
        assert.ok(kept.length >= Math.min(max, bytes.length) - 3, label + ' dropped a whole character it had room for');
      }
    }
  }
});

test('byte-bound-respected: no kept tail exceeds its byte budget', () => {
  for (const text of SAMPLES) {
    for (let max = 0; max <= Buffer.byteLength(text) + 1; max++) {
      assert.ok(Buffer.byteLength(boundOutputTail(text, max)) <= max, 'boundOutputTail ' + JSON.stringify([text, max]));
      assert.ok(Buffer.byteLength(tailOf(text, max)) <= max, 'summarizeVerification ' + JSON.stringify([text, max]));
    }
  }
  assert.ok(Buffer.byteLength(boundOutputTail(SMILE.repeat(5000))) <= 16384);
  assert.ok(Buffer.byteLength(tailOf('y' + SMILE.repeat(600))) <= 2000);
});

test('single-tail-helper: both callers import boundedUtf8Tail from ./textBudget.mjs and keep no byte slicing of their own', () => {
  for (const rel of ['src/checkRunTail.mjs', 'src/verificationSummary.mjs']) {
    const code = codeOf(rel);
    assert.ok(importsAll(code, './textBudget.mjs', ['boundedUtf8Tail']), rel + ' must import boundedUtf8Tail from ./textBudget.mjs');
    const lower = code.toLowerCase();
    for (const own of ['buffer', 'subarray', 'textencoder', 'textdecoder', 'bytelength', '0xc0', '0x80']) {
      assert.ok(!lower.includes(own), rel + ' still cuts bytes itself: ' + own);
    }
  }
});
`;

const UTF8_BOUNDED_TAIL = {
  ...COMMON,
  id: 'refactor-utf8-bounded-tail',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/memorySettings.ts`, `${SRC}state/checkRunStore.ts`, `${SRC}util/enforcement.ts`],
    adaptation: 'adapted',
    note: 'Adapted. textBudget.mjs reduces util/memorySettings.ts to truncateForBudget. checkRunTail.mjs is boundOutputTail '
      + 'from state/checkRunStore.ts with types removed, a reduced renderGot (no 40-character cut) and the byte bound as '
      + 'a parameter. verificationSummary.mjs reduces assertVerificationEvidence in util/enforcement.ts: the non-zero '
      + 'exit refusal and the command length cap are dropped, a null or blank input gets a short INVALID_INPUT message '
      + 'instead of the missing-field and contract-suffixed ones, and the tail is bounded in UTF-8 bytes by its own copy '
      + 'of the check-run cut where the frozen code slices 2000 UTF-16 units. Inlined errors carry the code name '
      + 'INVALID_INPUT as error.code; MoeError keeps a numeric code.',
  },
  intendedBehavior: 'Two callers keep their own copy of the same UTF-8-aware tail cut (keep the final maxBytes bytes, '
    + 'then skip leading continuation bytes so the result never starts inside a character): boundOutputTail(value, '
    + 'maxBytes) in src/checkRunTail.mjs and summarizeVerification(verification, maxBytes) in '
    + 'src/verificationSummary.mjs. Centralize it as ONE helper exported from src/textBudget.mjs, '
    + 'boundedUtf8Tail(text, maxBytes), next to truncateForBudget, and make both callers use it with no byte handling '
    + 'of their own. This is a pure refactor: byte-identical results for ASCII, 2-, 3- and 4-byte characters at and '
    + 'across the cut, an exact fit, a 0-byte budget and empty text; never a partial character or U+FFFD; never more '
    + 'than maxBytes bytes; and the same defaults (16384 and 2000 bytes), result shapes and error messages in both '
    + 'callers. truncateForBudget must not change.',
  initialFiles: {
    'src/textBudget.mjs': TEXT_BUDGET, 'src/checkRunTail.mjs': CHECK_RUN_TAIL, 'src/verificationSummary.mjs': VERIFICATION_SUMMARY,
  },
  assessmentFiles: { 'acceptance.test.mjs': TAIL_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'tail-output-preserved', description: 'Both callers return the original tails, defaults, result shapes and errors, including cuts inside a character.' },
      { id: 'complete-characters', description: 'Every kept tail is the longest whole-character byte suffix that fits; no U+FFFD is introduced.' },
      { id: 'byte-bound-respected', description: 'No kept tail exceeds its byte budget, explicit or default.' },
      { id: 'single-tail-helper', description: 'Both callers import boundedUtf8Tail from ./textBudget.mjs and carry no byte slicing of their own.' },
    ],
    coverageTags: ['reusable-helper', 'behavior-preservation', 'utf8-boundary'],
  },
  snapshotDigest: 'sha256:41ee8a7ec56bb79680827e0f2df018269e4341066682dcf0cd0b3fe711710066',
  assessmentDigest: 'sha256:aef4868da02b7b53e80cced798cf756248c78014fc09a2c9a3fd633c33dcb0cf',
};

/** The five frozen refactor workloads, validated and deep-frozen at import. */
export const REFACTOR_WORKLOADS: readonly Workload[] = validateWorkloads([
  USAGE_COUNTER_NORMALIZATION,
  CHAT_BUDGET_CONSOLIDATION,
  SHARED_PATH_NORMALIZATION,
  DETACHED_SNAPSHOT_RETURNS,
  UTF8_BOUNDED_TAIL,
]);

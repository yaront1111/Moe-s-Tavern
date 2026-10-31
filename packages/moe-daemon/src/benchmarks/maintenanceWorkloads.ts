// =============================================================================
// Frozen maintenance workloads (CQ-M03b), corpus contract version 1
// =============================================================================
//
// Test-only benchmark data: the five maintenance cases of the CQ-M03 matched
// corpus, validated and deep-frozen at import against workloadSnapshot.ts. No
// production module imports this file.
//
// Each case is a REDUCED or ADAPTED Node ESM overlay of Moe source at
// FROZEN_STARTING_COMMIT (exact changes in each `source.note`), never a
// whole-repository checkout. The coding inputs hold only the unsolved original:
// the corrected and plausible-wrong candidates live in maintenanceWorkloads.test.ts,
// and each held-out assessment is a node:test file that imports the candidate
// from the coding snapshot named by WORKLOAD_CANDIDATE_ROOT_ENV.
//
// Fixture files are String.raw templates, so every backslash is the fixture's own
// byte; fixture code uses string concatenation, never a template literal. Template
// line endings normalize to LF, so digests do not depend on the checkout.

import {
  FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV, validateWorkloads,
  type Workload,
} from './workloadSnapshot.js';

const js = String.raw;
const COMMON = { contractVersion: 1, category: 'maintenance', startingCommit: FROZEN_STARTING_COMMIT } as const;
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
// Case 1: integrate the existing UTF-8-safe truncation helper
// -----------------------------------------------------------------------------

const TEXT_BUDGET = js`// Adapted from truncateForBudget in packages/moe-daemon/src/util/memorySettings.ts at the
// frozen commit: types removed, the ellipsis spelled as a char code, and the cut backs off
// one code unit so a surrogate pair is never split. Shared by every payload trimmer.
const ELLIPSIS = String.fromCharCode(0x2026);

export function truncateForBudget(text, maxChars) {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  let end = Math.max(0, maxChars - ELLIPSIS.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end).trimEnd() + ELLIPSIS, truncated: true };
}
`;

const COMPACT_QUESTION = js`// Adapted from compactQuestion in packages/moe-daemon/src/tools/getPendingQuestions.ts:
// trims a pending human question to a content budget for the agent payload.
export function compactQuestion(question, maxContentChars) {
  if (maxContentChars <= 0 || question.content.length <= maxContentChars) {
    return question;
  }
  return { ...question, content: question.content.slice(0, maxContentChars) };
}
`;

const TRUNCATION_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { compactQuestion } = await load('src/compactQuestion.mjs');
const { truncateForBudget } = await load('src/textBudget.mjs');
const ELLIPSIS = String.fromCharCode(0x2026);
const SMILE = String.fromCodePoint(0x1f600);
const STAMP = '2026-10-24T00:00:00.000Z';
const question = (content) => ({ commentId: 'c-1', content, timestamp: STAMP });
const wellFormed = (s) => Buffer.from(s, 'utf8').toString('utf8') === s;

test('returns-compact-shape: an over-budget question keeps its fields and gains the truncation flags', () => {
  const input = question('abcdefghij'.repeat(3));
  const result = compactQuestion(input, 10);
  assert.deepEqual(result, {
    commentId: 'c-1', content: 'abcdefghi' + ELLIPSIS, timestamp: STAMP, contentTruncated: true, contentOriginalLength: 30,
  });
  assert.ok(result.content.length <= 10);
  assert.notEqual(result, input);
  assert.equal(input.content, 'abcdefghij'.repeat(3));
  assert.equal(input.contentTruncated, undefined);
  assert.equal(compactQuestion(question('abcd     efghij'), 8).content, 'abcd' + ELLIPSIS);
});

test('keeps-complete-characters: an emoji at the cut is dropped whole, never split', () => {
  for (const max of [4, 5]) {
    const result = compactQuestion(question('abc' + SMILE + 'defgh'), max);
    assert.equal(result.content, 'abc' + ELLIPSIS);
    assert.ok(wellFormed(result.content), 'lone surrogate at budget ' + max);
  }
});

test('passes-short-through: content within budget, or a budget of 0 or less, returns the same object', () => {
  const short = question('short');
  for (const max of [5, 6, 100, 0, -1]) assert.equal(compactQuestion(short, max), short);
  const long = question('x'.repeat(50));
  for (const max of [0, -3]) assert.equal(compactQuestion(long, max), long);
});

test('reuses-text-budget-helper: compactQuestion imports truncateForBudget and has no truncation of its own', () => {
  const text = sourceOf('src/compactQuestion.mjs');
  assert.ok(importsAll(text, './textBudget.mjs', ['truncateForBudget']), 'truncateForBudget must come from ./textBudget.mjs');
  for (const own of ['.slice(', '.substring(', '.substr(', 'trimEnd', 'fromCharCode', '0x2026', '8230', ELLIPSIS]) {
    assert.ok(!text.includes(own), 'compactQuestion.mjs carries its own truncation: ' + JSON.stringify(own));
  }
});

test('helper-unchanged: truncateForBudget keeps its behaviour for its other callers', () => {
  const cases = [
    ['hello', 10, 'hello', false], ['hello', 5, 'hello', false], ['hello world', 6, 'hello' + ELLIPSIS, true],
    ['hello', 1, ELLIPSIS, true], ['hello', 0, '', true], ['', 0, '', false], ['ab   cd', 6, 'ab' + ELLIPSIS, true],
    ['abc' + SMILE + 'defgh', 5, 'abc' + ELLIPSIS, true],
  ];
  for (const [text, max, expected, truncated] of cases) {
    assert.deepEqual(truncateForBudget(text, max), { text: expected, truncated }, JSON.stringify([text, max]));
  }
});
`;

const TRUNCATION_HELPER_REUSE = {
  ...COMMON,
  id: 'maintenance-truncation-helper-reuse',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/memorySettings.ts`, `${SRC}tools/getPendingQuestions.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. truncateForBudget comes from util/memorySettings.ts with types removed, the ellipsis '
      + 'written as a char code and a one-unit back-off so a surrogate pair is never split (the frozen helper can split '
      + 'one). compactQuestion comes from tools/getPendingQuestions.ts with types removed and rewound to a '
      + 'pre-integration form that slices the content itself and sets no flags; at the frozen commit it already calls '
      + 'the helper. The tool wrapper, pagination and the other payload callers are dropped.',
  },
  intendedBehavior: 'Pending-question payloads are trimmed by compactQuestion(question, maxContentChars) in '
    + 'src/compactQuestion.mjs, which still truncates by itself. Integrate the existing shared helper '
    + 'truncateForBudget(text, maxChars) from src/textBudget.mjs instead of duplicating truncation logic. When the '
    + 'content is longer than a positive budget, return a new object with every original field, content set to the '
    + "helper's text (ellipsis-terminated, at most maxContentChars characters, never splitting a surrogate pair), "
    + 'contentTruncated: true and contentOriginalLength set to the original content length. When the content fits, or '
    + 'the budget is 0 or less, return the very same question object. Do not change truncateForBudget: the other '
    + 'payload trimmers depend on its behaviour.',
  initialFiles: { 'src/textBudget.mjs': TEXT_BUDGET, 'src/compactQuestion.mjs': COMPACT_QUESTION },
  assessmentFiles: { 'acceptance.test.mjs': TRUNCATION_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'returns-compact-shape', description: 'An over-budget question keeps its fields, gets the helper text and both truncation flags, and the input is not mutated.' },
      { id: 'keeps-complete-characters', description: 'A surrogate pair at the cut is dropped whole; the result is well-formed text.' },
      { id: 'passes-short-through', description: 'Content within budget, or a budget of 0 or less, returns the identical question object.' },
      { id: 'reuses-text-budget-helper', description: 'compactQuestion.mjs imports truncateForBudget from ./textBudget.mjs and carries no slicing, trimming or ellipsis of its own.' },
      { id: 'helper-unchanged', description: 'truncateForBudget keeps its compatibility table for its other callers.' },
    ],
    coverageTags: ['reusable-helper', 'utf8-boundary'],
  },
  snapshotDigest: 'sha256:74fe9255d91e09943d2569874968f057328d7484277089e663ad253649ea940c',
  assessmentDigest: 'sha256:e9f6c6c607654f3d43302708f95f5798e1bf8b764a43f9881098066a8fe6e9f2',
};

// -----------------------------------------------------------------------------
// Case 2: branch-policy message names the policy kind; matching unchanged
// -----------------------------------------------------------------------------

const BRANCH_POLICY = js`// Adapted from packages/moe-daemon/src/util/branchPolicy.ts at the frozen commit: types
// removed, comments condensed and template literals rewritten as string concatenation.
// Branch-policy matching for settings.consolidationBranch has exactly one definition, here.

/** Regex metacharacters that must not survive into the compiled pattern. */
const REGEX_METACHARACTERS = /[.*+?^{}$()|[\]\\]/g;

/**
 * Bounds that keep the compiled pattern from becoming a ReDoS: a real git branch is far
 * under 255 characters and real patterns carry one wildcard.
 */
const MAX_BRANCH_LENGTH = 255;
const MAX_GLOB_WILDCARDS = 10;

/**
 * Does branch satisfy pattern? pattern is a literal branch name or a glob whose only
 * wildcard is * (any run of characters, including an empty one). Matching is anchored
 * and case-sensitive. Returns false, never throws, for a non-string, empty or over-long
 * branch, an empty pattern, too many wildcards, or a pattern that fails to compile.
 */
export function matchesBranchPattern(branch, pattern) {
  if (typeof branch !== 'string' || typeof pattern !== 'string') return false;
  if (!branch || !pattern) return false;
  if (branch.length > MAX_BRANCH_LENGTH) return false;
  if (!pattern.includes('*')) return branch === pattern;
  if ((pattern.match(/\*/g) || []).length > MAX_GLOB_WILDCARDS) return false;

  try {
    // Escape EVERY metacharacter first (this turns * into \*), then expand only those
    // placeholders. Expanding before escaping would let 'release/v1.0-*' match
    // 'release/v1X0-a', and an unescaped ( would throw at compile time. Adjacent
    // wildcards collapse to one .* so ** cannot introduce an ambiguous star pair.
    const source = pattern
      .replace(REGEX_METACHARACTERS, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/(?:\.\*)+/g, '.*');
    return new RegExp('^' + source + '$').test(branch);
  } catch {
    return false;
  }
}

/** The teaching message body for a branch-policy rejection. */
export function describeBranchPolicyFailure(branch, pattern) {
  return 'this task was completed on branch "' + branch + '", but this project requires "' + pattern + '". '
    + 'Switch to the sanctioned branch (the agent wrapper post-flight peels onto '
    + 'moe/work-<YYYY-MM-DD> for you), move your commits onto it, then call moe.complete_task again.';
}
`;

const BRANCH_POLICY_ASSESSMENT = js`${PRELUDE}
const { matchesBranchPattern, describeBranchPolicyFailure } = await load('src/branchPolicy.mjs');
const REMEDIATION = 'Switch to the sanctioned branch (the agent wrapper post-flight peels onto '
  + 'moe/work-<YYYY-MM-DD> for you), move your commits onto it, then call moe.complete_task again.';
const lead = (branch) => 'this task was completed on branch "' + branch + '", but this project requires ';

test('literal-policy-message: a literal pattern names the required branch', () => {
  assert.equal(describeBranchPolicyFailure('feature/x', 'main'), lead('feature/x') + 'branch "main". ' + REMEDIATION);
  assert.equal(describeBranchPolicyFailure('main', 'release/v1.0'), lead('main') + 'branch "release/v1.0". ' + REMEDIATION);
});

test('glob-policy-message: a glob pattern says the branch must match it', () => {
  assert.equal(describeBranchPolicyFailure('feature/x', 'moe/work-*'),
    lead('feature/x') + 'a branch matching "moe/work-*". ' + REMEDIATION);
  assert.equal(describeBranchPolicyFailure('main', '*'), lead('main') + 'a branch matching "*". ' + REMEDIATION);
});

test('keeps-remediation: both kinds keep the completed-branch clause and the remediation sentence verbatim', () => {
  for (const pattern of ['main', 'moe/work-*', 'feature/(x)']) {
    const message = describeBranchPolicyFailure('topic/y', pattern);
    assert.ok(message.startsWith(lead('topic/y')), message);
    assert.ok(message.endsWith('"' + pattern + '". ' + REMEDIATION), message);
  }
});

test('match-semantics-unchanged: literal, glob, escaping, anchoring and the caps match exactly as before', () => {
  const cases = [
    ['main', 'main', true], ['Main', 'main', false], ['main2', 'main', false],
    ['moe/work-2026-10-24', 'moe/work-*', true], ['moe/work-', 'moe/work-*', true],
    ['moe/work-1/extra', 'moe/work-*', true], ['x/moe/work-1', 'moe/work-*', false],
    ['release/v1.0-a', 'release/v1.0-*', true], ['release/v1X0-a', 'release/v1.0-*', false],
    ['feature/(x)', 'feature/(x)', true], ['feature/(x)-1', 'feature/(x)-*', true], ['feature/x-1', 'feature/(x)-*', false],
    ['a+bc', 'a+b*', true], ['aab', 'a+b*', false], ['moe/a/b', 'moe/**', true], ['ab', 'a**b', true],
    ['main', '', false], ['', 'main', false], ['', '*', false],
    ['a'.repeat(255), '*', true], ['a'.repeat(256), '*', false],
    ['abcdefghijk', 'a*b*c*d*e*f*g*h*i*j*k', true], ['abcdefghijkl', 'a*b*c*d*e*f*g*h*i*j*k*l', false],
    [null, 'main', false], ['main', 42, false], [undefined, '*', false],
  ];
  for (const [branch, pattern, expected] of cases) {
    assert.equal(matchesBranchPattern(branch, pattern), expected, JSON.stringify([branch, pattern]));
  }
});
`;

const BRANCH_POLICY_MESSAGE = {
  ...COMMON,
  id: 'maintenance-branch-policy-message',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/branchPolicy.ts`],
    adaptation: 'adapted',
    note: 'Adapted from util/branchPolicy.ts: matchesBranchPattern and describeBranchPolicyFailure with types removed, '
      + 'comments condensed and reworded without backticks, template literals rewritten as string concatenation and '
      + 'the metacharacter class reordered ({}$ instead of ${}) without changing its members. Strings, bounds and '
      + 'matching logic are otherwise as at the frozen commit.',
  },
  intendedBehavior: 'describeBranchPolicyFailure(branch, pattern) in src/branchPolicy.mjs builds the rejection message '
    + 'for a completion made on the wrong branch. Update the wording so it names the policy kind: a literal pattern '
    + '(no *) must read ... but this project requires branch "<pattern>". and a glob pattern (contains *) must read '
    + '... but this project requires a branch matching "<pattern>". The opening clause (this task was completed on '
    + 'branch "<branch>", but this project requires) and the remediation sentence that follows stay verbatim. '
    + 'matchesBranchPattern must keep its exact matching semantics: a literal compares exactly and case-sensitively, '
    + '* matches any run of characters including an empty one, every other character is literal, matching is '
    + 'anchored, and the length and wildcard caps still return false.',
  initialFiles: { 'src/branchPolicy.mjs': BRANCH_POLICY },
  assessmentFiles: { 'acceptance.test.mjs': BRANCH_POLICY_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'literal-policy-message', description: 'A literal pattern yields the exact requires branch "<pattern>" message.' },
      { id: 'glob-policy-message', description: 'A glob pattern yields the exact requires a branch matching "<pattern>" message.' },
      { id: 'keeps-remediation', description: 'Both kinds keep the completed-branch clause and the remediation sentence verbatim.' },
      { id: 'match-semantics-unchanged', description: 'The literal, glob, escaping, anchoring, collapsing and cap table matches exactly as at the frozen commit.' },
    ],
    coverageTags: ['changed-requirements', 'message-update', 'compatibility'],
  },
  snapshotDigest: 'sha256:064e4ee0f757eff74b2000edde291be02f547e267a74be61a25d9612de82dc00',
  assessmentDigest: 'sha256:aebd50ac6f8cf6ec46197271dc0d05e094deb9767a0731bdd1f9e3db8cbd6502',
};

// -----------------------------------------------------------------------------
// Case 3: human-readable usage line, unknown token values retained
// -----------------------------------------------------------------------------

const PROMPT_CACHE_USAGE = js`// Reduced from scripts/prompt-cache-usage.mjs at the frozen commit: count, counter, sum,
// normalizeUsage and formatUsage only (renderCodexEvent dropped). Template literals are
// rewritten as string concatenation with the same output.
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
  return prefix + ' input=' + total + ' read=' + read + ' write=' + (write ?? 'unknown') + ' uncached=' + uncached + ' hit=' + hit + output;
}
`;

const USAGE_ASSESSMENT = js`${PRELUDE}
const { normalizeUsage, formatUsage } = await load('src/promptCacheUsage.mjs');
const line = (provider, fields) => '[prompt-cache] provider=' + provider + ' ' + fields;
const UNKNOWN_INPUT = 'input=unknown cached=unknown written=unknown uncached=unknown hit=unknown';

test('claude-complete-line: complete Claude accounting renders every field under the new keys', () => {
  assert.equal(formatUsage('claude', { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 60, output_tokens: 7 }),
    line('claude', 'input=100 cached=30 written=60 uncached=10 hit=30.0% output=7 reasoning=unknown total=107'));
});

test('codex-complete-line: complete Codex accounting shows written=unknown and its reasoning', () => {
  assert.equal(formatUsage('codex', { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40, output_tokens_details: { reasoning_tokens: 12 } }),
    line('codex', 'input=200 cached=50 written=unknown uncached=150 hit=25.0% output=40 reasoning=12 total=240'));
});

test('unknown-input-fields: incomplete input accounting spells every input field unknown, never 0', () => {
  assert.equal(formatUsage('claude', { input_tokens: 10, cache_creation_input_tokens: 60, output_tokens: 7 }),
    line('claude', UNKNOWN_INPUT + ' output=7 reasoning=unknown total=unknown'));
  assert.equal(formatUsage('claude', { input_tokens: -1, cache_read_input_tokens: 30, cache_creation_input_tokens: 60, output_tokens: 7 }),
    line('claude', UNKNOWN_INPUT + ' output=7 reasoning=unknown total=unknown'));
  assert.equal(formatUsage('codex', { input_tokens: 10, cached_input_tokens: 20, output_tokens: 5 }),
    line('codex', UNKNOWN_INPUT + ' output=5 reasoning=unknown total=15'));
  assert.equal(formatUsage('codex', undefined), line('codex', UNKNOWN_INPUT + ' output=unknown reasoning=unknown total=unknown'));
});

test('unknown-output-fields: missing or inconsistent output counters stay unknown, never 0', () => {
  const missingOutput = formatUsage('claude', { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 60 });
  assert.ok(missingOutput.endsWith(' output=unknown reasoning=unknown total=unknown'), missingOutput);
  const inconsistent = formatUsage('codex', { input_tokens: 9, cached_input_tokens: 3, output_tokens: 8, reasoning_tokens: 5, reasoning_output_tokens: 6 });
  assert.ok(inconsistent.endsWith(' output=8 reasoning=unknown total=17'), inconsistent);
  const overOutput = formatUsage('codex', { input_tokens: 9, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 6 });
  assert.ok(overOutput.endsWith(' output=4 reasoning=unknown total=13'), overOutput);
  for (const text of [missingOutput, inconsistent, overOutput]) assert.doesNotMatch(text, /=0(?= |$)/);
});

test('zero-total-hit: an all-zero complete input accounting reports hit=n/a', () => {
  assert.equal(formatUsage('claude', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
    line('claude', 'input=0 cached=0 written=0 uncached=0 hit=n/a output=0 reasoning=unknown total=0'));
  assert.equal(formatUsage('codex', { input_tokens: 0, cached_input_tokens: 0, output_tokens: 3 }),
    line('codex', 'input=0 cached=0 written=unknown uncached=0 hit=n/a output=3 reasoning=unknown total=3'));
});

test('normalize-unchanged: normalizeUsage keeps its provider accounting', () => {
  const shape = (inputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens, outputTokens, reasoningTokens, totalTokens) =>
    ({ inputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens, outputTokens, reasoningTokens, totalTokens });
  assert.deepEqual(normalizeUsage('claude', { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 60, output_tokens: 7 }),
    shape(100, 30, 60, 10, 7, null, 107));
  assert.deepEqual(normalizeUsage('codex', { input_tokens: 10, cached_input_tokens: 20, output_tokens: 5 }),
    shape(10, null, null, null, 5, null, 15));
  assert.deepEqual(normalizeUsage('codex', { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40, reasoning_output_tokens: 12 }),
    shape(200, 50, null, 150, 40, 12, 240));
  assert.deepEqual(normalizeUsage('claude', { input_tokens: 1.5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: '4' }),
    shape(null, 2, 3, null, null, null, null));
});
`;

const USAGE_UNKNOWN_FORMAT = {
  ...COMMON,
  id: 'maintenance-usage-unknown-format',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: ['scripts/prompt-cache-usage.mjs'],
    adaptation: 'reduced',
    note: 'Reduced from scripts/prompt-cache-usage.mjs: only count, counter, sum, normalizeUsage and formatUsage are '
      + 'kept (renderCodexEvent is dropped) and the file is renamed src/promptCacheUsage.mjs. Template literals are '
      + 'rewritten as string concatenation producing the same output; logic and wording are as at the frozen commit.',
  },
  intendedBehavior: 'formatUsage(provider, usage) in src/promptCacheUsage.mjs renders one human-readable prompt-cache '
    + 'line per agent turn. Update the line to the new key names: [prompt-cache] provider=<provider> input=<total '
    + 'input> cached=<cache reads> written=<cache writes> uncached=<uncached input> hit=<percent> output=<output> '
    + 'reasoning=<reasoning> total=<total>. When the input accounting is incomplete (a missing or invalid counter, or '
    + 'Codex cached input above its input), replace the old single usage=unknown token with input=unknown '
    + 'cached=unknown written=unknown uncached=unknown hit=unknown, while output, reasoning and total keep showing '
    + 'their own values. Unknown token values must be retained: a missing or invalid counter is never shown as 0. '
    + 'Codex has no cache-write counter, so it shows written=unknown; a zero total input shows hit=n/a; the '
    + 'percentage keeps one decimal. normalizeUsage must not change.',
  initialFiles: { 'src/promptCacheUsage.mjs': PROMPT_CACHE_USAGE },
  assessmentFiles: { 'acceptance.test.mjs': USAGE_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'claude-complete-line', description: 'Complete Claude accounting renders the exact new-key line.' },
      { id: 'codex-complete-line', description: 'Complete Codex accounting renders the exact new-key line with written=unknown and its reasoning.' },
      { id: 'unknown-input-fields', description: 'Incomplete input accounting spells input, cached, written, uncached and hit unknown and keeps the output fields.' },
      { id: 'unknown-output-fields', description: 'Missing or inconsistent output and reasoning counters stay unknown and no field is shown as 0.' },
      { id: 'zero-total-hit', description: 'An all-zero complete input accounting shows hit=n/a.' },
      { id: 'normalize-unchanged', description: 'normalizeUsage keeps its provider accounting table.' },
    ],
    coverageTags: ['changed-requirements', 'unknown-preservation', 'format-update', 'compatibility'],
  },
  snapshotDigest: 'sha256:69d44cfe994f8b6254b8425670f0f0580b04a901ca619961d71aa9d04c0c3c7e',
  assessmentDigest: 'sha256:204f14328678e29e7131d3da55e085a07e0606303ec523e3097c3af5222c800b',
};

// -----------------------------------------------------------------------------
// Case 4: a new caller of the shared affected-file normalization
// -----------------------------------------------------------------------------

const AFFECTED_FILES = js`// Adapted from packages/moe-daemon/src/util/affectedFiles.ts at the frozen commit: types
// removed, invalidInput inlined as an Error carrying code and context like MoeError, and
// pathKey takes an explicit platform instead of reading process.platform, so case folding
// is deterministic on every host. Shared by every caller that stores or compares paths.
const MAX_PATH_LEN = 500;

function invalidInput(field, reason) {
  const error = new Error('[INVALID_INPUT] Invalid ' + field + ': ' + reason);
  error.code = 'INVALID_INPUT';
  error.context = { field, reason };
  return error;
}

/**
 * Case-fold a normalized project-relative path for comparison: win32 and darwin
 * filesystems are case-insensitive. Every consumer folds with this one rule.
 */
export function pathKey(p, platform) {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * Canonicalize one affected-file path: backslashes become forward slashes, a leading
 * ./ is stripped, trailing whitespace trimmed. Throws on an empty or non-string entry,
 * traversal, an absolute Unix or Windows path, or more than MAX_PATH_LEN characters.
 */
export function normalizeAffectedFile(raw, fieldName = 'affectedFiles') {
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

/** Normalize an array of affected files, deduplicating while preserving first-seen order. */
export function normalizeAffectedFiles(raw, fieldName = 'affectedFiles') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw invalidInput(fieldName, 'must be an array of strings');
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const normalized = normalizeAffectedFile(entry, fieldName);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}
`;

const DECLARED_FILES = js`// Caller written for this workload: merges newly declared paths into a task's
// declared-file list without dropping or reordering the paths already declared.
export function mergeDeclaredFiles(existing, incoming, platform) {
  throw new Error('mergeDeclaredFiles is not implemented');
}
`;

const AFFECTED_FILE_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { mergeDeclaredFiles } = await load('src/declaredFiles.mjs');
const { normalizeAffectedFile, normalizeAffectedFiles, pathKey } = await load('src/affectedFiles.mjs');
const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);
const E_ACUTE = String.fromCharCode(0xe9);
const CAFE_UPPER = 'DOCS/CAF' + String.fromCharCode(0xc9) + '.md';
const CAFE_NFC = 'docs/caf' + E_ACUTE + '.md';
const CAFE_NFD = 'docs/cafe' + String.fromCharCode(0x301) + '.md';

test('windows-separators: every backslash, a leading dot segment and doubled separators are normalized', () => {
  assert.deepEqual(mergeDeclaredFiles([], [win('src', 'util', 'a.ts'), win('.', 'docs', 'b.md'), './c.md', 'src//d.ts'], 'linux'),
    ['src/util/a.ts', 'docs/b.md', 'c.md', 'src/d.ts']);
  assert.deepEqual(mergeDeclaredFiles(['src/util/a.ts'], [win('src', 'util', 'a.ts'), ' src/e.ts '], 'linux'),
    ['src/util/a.ts', 'src/e.ts']);
});

test('platform-case-folding: win32 and darwin fold case through pathKey, linux keeps both spellings', () => {
  const incoming = ['src/a.ts', CAFE_UPPER, CAFE_NFC];
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(mergeDeclaredFiles(['Src/A.ts'], incoming, platform), ['Src/A.ts', CAFE_UPPER], platform);
  }
  assert.deepEqual(mergeDeclaredFiles(['Src/A.ts'], incoming, 'linux'), ['Src/A.ts', ...incoming]);
});

test('unicode-preserved: Unicode spellings are kept exactly and NFC and NFD stay distinct', () => {
  const cjk = 'docs/' + String.fromCharCode(0x65e5, 0x672c) + '.md';
  for (const platform of ['win32', 'linux']) {
    const merged = mergeDeclaredFiles([], [CAFE_NFD, CAFE_NFC, cjk, win('docs', 'x' + E_ACUTE + '.md')], platform);
    assert.deepEqual(merged, [CAFE_NFD, CAFE_NFC, cjk, 'docs/x' + E_ACUTE + '.md'], platform);
  }
});

test('rejects-traversal: traversal and absolute entries throw the shared normalizer error and change nothing', () => {
  const existing = ['src/a.ts'];
  for (const bad of ['src/../secrets.txt', win('src', '..', 'x'), '/etc/passwd', 'C:' + BS + 'x.ts']) {
    let expected;
    try { normalizeAffectedFile(bad); } catch (error) { expected = error; }
    assert.ok(expected, 'the shared normalizer must reject ' + JSON.stringify(bad));
    const incoming = ['src/b.ts', bad];
    assert.throws(() => mergeDeclaredFiles(existing, incoming, 'linux'),
      (error) => error.code === expected.code && error.context?.reason === expected.context.reason, JSON.stringify(bad));
    assert.deepEqual(existing, ['src/a.ts']);
    assert.deepEqual(incoming, ['src/b.ts', bad]);
  }
});

test('reuses-normalizer: declaredFiles.mjs imports the normalizer and pathKey and rewrites or folds nothing itself', () => {
  const text = sourceOf('src/declaredFiles.mjs');
  const spec = './affectedFiles.mjs';
  assert.ok(importsAll(text, spec, ['pathKey']), 'pathKey must come from ' + spec);
  assert.ok(importsAll(text, spec, ['normalizeAffectedFile']) || importsAll(text, spec, ['normalizeAffectedFiles']),
    'the shared normalizer must come from ' + spec);
  for (const own of ['replace(', 'replaceAll(', 'split(', 'fromCharCode', 'toLowerCase', 'toUpperCase',
    'toLocaleLowerCase', 'toLocaleUpperCase', 'localeCompare', '.normalize(']) {
    assert.ok(!text.includes(own), 'declaredFiles.mjs rewrites or folds paths itself: ' + own);
  }
});

test('normalizer-unchanged: the shared normalizer and pathKey keep their behaviour', () => {
  assert.equal(normalizeAffectedFile(win('src', 'a.ts')), 'src/a.ts');
  assert.equal(normalizeAffectedFile('./src/./b//c.ts '), 'src/b/c.ts');
  assert.deepEqual(normalizeAffectedFiles(['a.ts', './a.ts', 'b.ts']), ['a.ts', 'b.ts']);
  assert.deepEqual(normalizeAffectedFiles(undefined), []);
  assert.equal(pathKey('Src/A.ts', 'win32'), 'src/a.ts');
  assert.equal(pathKey('Src/A.ts', 'darwin'), 'src/a.ts');
  assert.equal(pathKey('Src/A.ts', 'linux'), 'Src/A.ts');
  for (const bad of ['', '   ', 42, '../x', '/abs', 'C:/x', 'a'.repeat(501), '.']) {
    assert.throws(() => normalizeAffectedFile(bad), (error) => error.code === 'INVALID_INPUT', JSON.stringify(bad));
  }
});
`;

const AFFECTED_FILE_CALLER = {
  ...COMMON,
  id: 'maintenance-affected-file-caller',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/affectedFiles.ts`],
    adaptation: 'adapted',
    note: 'Adapted from util/affectedFiles.ts: normalizeAffectedFile, normalizeAffectedFiles and pathKey with types '
      + 'removed, doc comments condensed, template-literal messages concatenated, invalidInput inlined as an Error '
      + 'carrying code and context like MoeError, and pathKey taking an explicit platform argument instead of reading '
      + 'process.platform so folding is deterministic on every host. findMissingPaths and collision detection are '
      + 'dropped. src/declaredFiles.mjs is a new caller stub written for this workload, not Moe source.',
  },
  intendedBehavior: 'Implement mergeDeclaredFiles(existing, incoming, platform) in src/declaredFiles.mjs as a new '
    + 'caller of the shared affected-file normalization in src/affectedFiles.mjs. It returns a NEW array: the '
    + 'already-normalized existing paths followed by each newly declared incoming path. Every incoming entry must go '
    + 'through the shared normalizer (Windows backslashes, a leading ./ and doubled separators normalized; '
    + 'traversal and absolute paths rejected), and duplicates are detected with the shared pathKey(path, platform), '
    + 'so win32 and darwin compare case-insensitively while linux does not. Keep the first spelling and the original '
    + 'order, preserve Unicode spellings exactly (no case or Unicode normalization of your own), and when the '
    + 'normalizer rejects an entry, let its error propagate without changing existing or incoming. Do not change '
    + 'src/affectedFiles.mjs.',
  initialFiles: { 'src/affectedFiles.mjs': AFFECTED_FILES, 'src/declaredFiles.mjs': DECLARED_FILES },
  assessmentFiles: { 'acceptance.test.mjs': AFFECTED_FILE_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'windows-separators', description: 'Every backslash, a leading dot segment and doubled separators are normalized before merging.' },
      { id: 'platform-case-folding', description: 'Duplicates fold case on win32 and darwin through pathKey; linux keeps both spellings.' },
      { id: 'unicode-preserved', description: 'Unicode spellings are kept exactly; NFC and NFD forms stay distinct.' },
      { id: 'rejects-traversal', description: 'Traversal and absolute entries throw the shared normalizer error and leave both inputs unchanged.' },
      { id: 'reuses-normalizer', description: 'declaredFiles.mjs imports the normalizer and pathKey from ./affectedFiles.mjs and does no rewriting or folding of its own.' },
      { id: 'normalizer-unchanged', description: 'The shared normalizer and pathKey keep their compatibility table.' },
    ],
    coverageTags: ['reusable-helper', 'new-caller', 'windows-paths', 'unicode-paths'],
  },
  snapshotDigest: 'sha256:21e5fc46af2e96624f1fa2c89da43f5c5b2f041a4be4ca8c8a3164525b941174',
  assessmentDigest: 'sha256:4be63e01a46e66e4b5abf7026b95b084f4ee787d82c89ce6fda41264339eee35',
};

// -----------------------------------------------------------------------------
// Case 5: cached-ref lookup recipe for a changed caller; protected-branch intent kept
// -----------------------------------------------------------------------------

const CACHED_PLAN_PATHS = js`// Reduced from packages/moe-daemon/src/util/cachedPlanPaths.ts at the frozen commit (see the
// workload note): read-only lookup of plan paths in a cached remote-tracking ref.
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const CONFIG_KEYS = '^(extensions[.]partialclone|remote[.].*[.]promisor|core[.]worktree)$';

/** Only an explicitly configured, literal consolidation branch is evidence. */
export function cachedPlanRef(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/')
      || branch.endsWith('.') || branch.split('/').some((p) => p.endsWith('.lock'))) return undefined;
  return 'refs/remotes/origin/' + branch;
}

/**
 * Read-only fallback for a stale protected checkout. run(args) executes one git command
 * and resolves its stdout. Nothing is fetched, checked out, staged or accepted on
 * uncertainty, and every refusal names its reason.
 */
export async function findCachedPlanPaths(branch, missing, run) {
  const ref = cachedPlanRef(branch);
  if (!ref) {
    const shown = typeof branch === 'string' ? JSON.stringify(branch.slice(0, 80)) : String(branch ?? null);
    return { miss: 'consolidationBranch ' + shown + ' is not a literal branch name' };
  }
  if (missing.length === 0 || missing.length > 100 || missing.some((p) => typeof p !== 'string' || p.includes(NUL))) {
    return { miss: 'the path list is empty, over 100 paths or not plain strings' };
  }
  try {
    const special = await run(['config', '--local', '--includes', '--get-regexp', CONFIG_KEYS]);
    if (special.trim()) {
      return { miss: 'local Git config sets ' + special.trim().split(' ')[0]
        + '; partial-clone, promisor and core.worktree repositories are never trusted' };
    }
    const commit = (await run(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return { miss: ref + ' did not resolve to a commit id' };
    const listing = await run(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...missing]);
    if (listing && !listing.endsWith(NUL)) return { miss: 'unparsable ls-tree output for ' + ref };
    const found = new Set();
    for (const entry of listing.split(NUL).filter(Boolean)) {
      const tab = entry.indexOf(TAB);
      if (tab < 0 || !/^[0-7]{6} (?:blob|tree|commit) [0-9a-f]{40,64}$/.test(entry.slice(0, tab))) {
        return { miss: 'unparsable ls-tree output for ' + ref };
      }
      found.add(entry.slice(tab + 1));
    }
    const paths = missing.filter((p) => found.has(p));
    if (!paths.length) return { miss: ref + ' at ' + commit.slice(0, 12) + ' does not contain them either' };
    return { ref, commit, paths };
  } catch (error) {
    // A missing ref, a failed command or bad config keeps the ordinary miss. Never fetch.
    return { miss: 'git lookup failed: ' + String(error?.message ?? error).split('\n')[0] };
  }
}
`;

const SUBMIT_PLAN_LOOKUP = js`// Plan-submission caller written for this workload. It now reads the consolidation remote
// from settings as well and passes both to the cached lookup.
import { findCachedPlanPaths } from './cachedPlanPaths.mjs';

export function lookupCachedPlanPaths(settings, missing, run) {
  return findCachedPlanPaths({ branch: settings.consolidationBranch, remote: settings.consolidationRemote }, missing, run);
}
`;

const CACHED_REF_ASSESSMENT = js`${PRELUDE}
const { cachedPlanRef, findCachedPlanPaths } = await load('src/cachedPlanPaths.mjs');
const { lookupCachedPlanPaths } = await load('src/submitPlanLookup.mjs');
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const COMMIT = 'c'.repeat(40);
const BRANCH = 'moe/work-2026-10-24';
const CONFIG = ['config', '--local', '--includes', '--get-regexp', '^(extensions[.]partialclone|remote[.].*[.]promisor|core[.]worktree)$'];
const recipe = (ref, paths) => [CONFIG, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'],
  ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', COMMIT, '--', ...paths]];
const isMiss = (result) => typeof result?.miss === 'string' && !('paths' in result);

// A fake git that records every argv; it would resolve any ref, glob listings included.
function fakeGit(config = '') {
  const calls = [];
  const run = async (args) => {
    calls.push([...args]);
    if (args[0] === 'config') return config;
    if (args[0] === 'rev-parse') return COMMIT + '\n';
    if (args[0] === 'for-each-ref') return 'refs/remotes/origin/' + BRANCH + '\n';
    if (args[1] === 'ls-tree') return '100644 blob ' + 'b'.repeat(40) + TAB + 'src/a.ts' + NUL;
    throw new Error('unexpected git ' + args.join(' '));
  };
  return { run, calls };
}

test('accepts-caller-options: the changed caller resolves the configured remote-tracking ref', async () => {
  const origin = fakeGit();
  assert.deepEqual(await lookupCachedPlanPaths({ consolidationBranch: BRANCH }, ['src/a.ts', 'src/b.ts'], origin.run),
    { ref: 'refs/remotes/origin/' + BRANCH, commit: COMMIT, paths: ['src/a.ts'] });
  const upstream = fakeGit();
  assert.deepEqual(await lookupCachedPlanPaths({ consolidationBranch: BRANCH, consolidationRemote: 'upstream' }, ['src/a.ts'], upstream.run),
    { ref: 'refs/remotes/upstream/' + BRANCH, commit: COMMIT, paths: ['src/a.ts'] });
  assert.deepEqual(upstream.calls[1], ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/upstream/' + BRANCH + '^{commit}']);
});

test('legacy-string-still-works: a plain branch string and cachedPlanRef keep resolving origin', async () => {
  assert.deepEqual(await findCachedPlanPaths('main', ['src/a.ts'], fakeGit().run),
    { ref: 'refs/remotes/origin/main', commit: COMMIT, paths: ['src/a.ts'] });
  assert.equal(cachedPlanRef('main'), 'refs/remotes/origin/main');
  assert.equal(cachedPlanRef(BRANCH), 'refs/remotes/origin/' + BRANCH);
  assert.equal(cachedPlanRef('moe/work-*'), undefined);
  assert.equal(cachedPlanRef(42), undefined);
});

test('glob-is-not-evidence: a glob or other non-literal branch misses before any git command', async () => {
  for (const branch of ['moe/work-*', '*', 'release/*/x', 'a..b', 'topic.lock', 'x/', '-x', '']) {
    const calls = [
      (run) => findCachedPlanPaths(branch, ['src/a.ts'], run),
      (run) => findCachedPlanPaths({ branch, remote: 'origin' }, ['src/a.ts'], run),
      (run) => lookupCachedPlanPaths({ consolidationBranch: branch }, ['src/a.ts'], run),
    ];
    for (const call of calls) {
      const git = fakeGit();
      const result = await call(git.run);
      assert.ok(isMiss(result), JSON.stringify([branch, result]));
      assert.deepEqual(git.calls, [], JSON.stringify(branch));
    }
  }
});

test('rejects-unsafe-remote: the remote must be one safe ref component, checked before any git command', async () => {
  for (const remote of ['origin/../heads', '*', '-x', '', 'a.lock', 'up..stream', 'origin.', 42, null]) {
    const git = fakeGit();
    assert.ok(isMiss(await findCachedPlanPaths({ branch: 'main', remote }, ['src/a.ts'], git.run)), JSON.stringify(remote));
    assert.deepEqual(git.calls, [], JSON.stringify(remote));
  }
  for (const remote of ['upstream', 'fork_2', 'my-remote.v2']) {
    const result = await findCachedPlanPaths({ branch: 'main', remote }, ['src/a.ts'], fakeGit().run);
    assert.equal(result.ref, 'refs/remotes/' + remote + '/main', JSON.stringify(result));
  }
});

test('read-only-recipe: each lookup runs exactly the read-only git recipe and nothing else', async () => {
  const legacy = fakeGit();
  await findCachedPlanPaths(BRANCH, ['src/a.ts', 'src/b.ts'], legacy.run);
  assert.deepEqual(legacy.calls, recipe('refs/remotes/origin/' + BRANCH, ['src/a.ts', 'src/b.ts']));
  const options = fakeGit();
  await findCachedPlanPaths({ branch: BRANCH, remote: 'upstream' }, ['src/a.ts'], options.run);
  assert.deepEqual(options.calls, recipe('refs/remotes/upstream/' + BRANCH, ['src/a.ts']));
  const promisor = fakeGit('remote.origin.promisor true\n');
  assert.ok(isMiss(await lookupCachedPlanPaths({ consolidationBranch: BRANCH }, ['src/a.ts'], promisor.run)));
  assert.deepEqual(promisor.calls, [CONFIG]);
});
`;

const CACHED_REF_CALLER = {
  ...COMMON,
  id: 'maintenance-cached-ref-caller',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/cachedPlanPaths.ts`],
    adaptation: 'reduced',
    note: 'Reduced from util/cachedPlanPaths.ts: cachedPlanRef and findCachedPlanPaths(branch, missing, run) with an '
      + 'injected run(args) runner. Dropped: the projectRoot argument, the default execFile runner and its environment '
      + 'masking, the realpath and toplevel checks, the time budget, the 24000-character limit, pathKey folding, the '
      + 'normalizeAffectedFile defence and the warning field; the path-list miss text is shortened and failures are '
      + 'reduced to the first message line. The config key regex spells literal dots as [.], ls-tree entries are '
      + 'parsed with indexOf, and template literals are concatenated. src/submitPlanLookup.mjs is a caller written '
      + 'for this workload, not Moe source.',
  },
  intendedBehavior: 'The plan-submission caller lookupCachedPlanPaths in src/submitPlanLookup.mjs changed: it now '
    + 'passes { branch, remote } (remote may be undefined) to findCachedPlanPaths, so every lookup currently misses. '
    + 'Update the lookup in src/cachedPlanPaths.mjs to accept either the legacy branch string or an options object '
    + '{ branch, remote }, with remote defaulting to origin when undefined, and resolve refs/remotes/<remote>/<branch>. '
    + 'Protected-branch intent is unchanged: only a literal branch accepted by the cachedPlanRef rules is evidence (a '
    + 'glob or other non-literal branch is a miss), and the remote must be one safe ref component (1-64 letters, '
    + 'digits, dots, underscores or hyphens, starting with a letter or digit, without .., a trailing dot or a .lock '
    + 'suffix), otherwise a miss. Both are decided before any git command runs. The read-only recipe stays exactly: '
    + 'config --local --includes --get-regexp <keys>, rev-parse --verify --end-of-options <ref>^{commit}, then '
    + '--literal-pathspecs ls-tree -z --full-tree <commit> -- <paths>; never fetch, list or resolve other refs, or '
    + 'check anything out. cachedPlanRef(branch) keeps returning refs/remotes/origin/<branch> for existing callers.',
  initialFiles: { 'src/cachedPlanPaths.mjs': CACHED_PLAN_PATHS, 'src/submitPlanLookup.mjs': SUBMIT_PLAN_LOOKUP },
  assessmentFiles: { 'acceptance.test.mjs': CACHED_REF_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'accepts-caller-options', description: 'The changed caller resolves refs/remotes/<remote>/<branch>, defaulting the remote to origin.' },
      { id: 'legacy-string-still-works', description: 'A plain branch string and cachedPlanRef keep resolving refs/remotes/origin/<branch>.' },
      { id: 'glob-is-not-evidence', description: 'A glob or other non-literal branch misses in every call form with zero git commands.' },
      { id: 'rejects-unsafe-remote', description: 'An unsafe remote misses with zero git commands; a safe single-component remote resolves.' },
      { id: 'read-only-recipe', description: 'Every lookup runs exactly the config, rev-parse and literal ls-tree argv and nothing else.' },
    ],
    coverageTags: ['changed-caller', 'recipe-mismatch', 'protected-branch-intent', 'read-only-recipe'],
  },
  snapshotDigest: 'sha256:b852af8b5cf5b2fd1f231c00d09cd86be3e8f6181f808489736ddfda5b1da0da',
  assessmentDigest: 'sha256:103f838c41e05d8a6ae33c2d203a394a5e0c03b972f138a65a59e5d113e5a403',
};

/** The five frozen maintenance workloads, validated and deep-frozen at import. */
export const MAINTENANCE_WORKLOADS: readonly Workload[] = validateWorkloads([
  TRUNCATION_HELPER_REUSE,
  BRANCH_POLICY_MESSAGE,
  USAGE_UNKNOWN_FORMAT,
  AFFECTED_FILE_CALLER,
  CACHED_REF_CALLER,
]);

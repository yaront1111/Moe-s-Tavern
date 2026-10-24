// =============================================================================
// Frozen non-routine workloads (CQ-M03e), corpus contract version 1
// =============================================================================
//
// Test-only benchmark data: the five non-routine cases of the CQ-M03 matched
// corpus, validated and deep-frozen at import against workloadSnapshot.ts. No
// production module imports this file.
//
// A non-routine case asks for genuinely new behavior, specified in each
// `intendedBehavior` with adversarial examples rather than by a reference
// implementation. Each case is a REDUCED or ADAPTED Node ESM overlay of Moe
// source at FROZEN_STARTING_COMMIT (exact changes and synthetic parts in each
// `source.note`), never a whole-repository checkout. The coding inputs hold only
// the unsolved original: the corrected and plausible-wrong candidates live in
// non-routineWorkloads.test.ts, and each held-out assessment is a node:test file
// that imports the candidate from the coding snapshot named by
// WORKLOAD_CANDIDATE_ROOT_ENV. Every external effect (Git, file reads) is an
// injected function, so no assessment touches real Git, the network or a clock.
//
// Fixture files are String.raw templates, so every backslash is the fixture's own
// byte; fixture code uses string concatenation, never a template literal. Template
// line endings normalize to LF, so digests do not depend on the checkout.

import {
  FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV, validateWorkloads,
  type Workload,
} from './workloadSnapshot.js';

const js = String.raw;
const COMMON = { contractVersion: 1, category: 'non-routine', startingCommit: FROZEN_STARTING_COMMIT } as const;
const SRC = 'packages/moe-daemon/src/';

const PRELUDE = js`import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.${WORKLOAD_CANDIDATE_ROOT_ENV};
if (!root) throw new Error('${WORKLOAD_CANDIDATE_ROOT_ENV} is not set: point it at the candidate coding snapshot');
const load = (rel) => import(pathToFileURL(path.join(root, ...rel.split('/'))).href);
`;

// -----------------------------------------------------------------------------
// Case 1: cached positive lookups invalidated by the ref's commit fingerprint
// -----------------------------------------------------------------------------

const CACHED_PLAN_PATHS = js`// Reduced from packages/moe-daemon/src/util/cachedPlanPaths.ts at the frozen commit: the
// literal-ref rule (cachedPlanRef) and the two read-only Git steps of findCachedPlanPaths
// (rev-parse of the ref, then a literal ls-tree of the commit), with types removed. Every Git
// call goes through an injected run(args), which resolves to stdout or rejects.

/** Only an explicitly configured, literal consolidation branch is evidence. */
export function cachedPlanRef(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/')
      || branch.endsWith('.') || branch.split('/').some((p) => p.endsWith('.lock'))) return undefined;
  return 'refs/remotes/origin/' + branch;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_ENTRY = /^(?:[0-7]{6}) (?:blob|tree|commit) [0-9a-f]{40,64}\t([\s\S]+)$/;

/** The commit id ref names right now; rejects on a Git failure or output that is not a commit id. */
export async function resolveCommit(run, ref) {
  const commit = String(await run(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
  if (!COMMIT_ID.test(commit)) throw new Error(ref + ' did not resolve to a commit id');
  return commit;
}

/** The paths present in the tree of commit, in input order (exact spelling); rejects on unparsable output. */
export async function listPaths(run, commit, paths) {
  const listing = String(await run(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...paths]));
  if (listing && !listing.endsWith('\0')) throw new Error('unparsable ls-tree output for ' + commit);
  const present = new Set();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = TREE_ENTRY.exec(entry);
    if (!match) throw new Error('unparsable ls-tree output for ' + commit);
    present.add(match[1]);
  }
  return paths.filter((p) => present.has(p));
}
`;

const PATH_LOOKUP_CACHE = js`// submit_plan retries look the same missing paths up in the cached consolidation ref again
// and again, so this module memoizes those lookups on top of src/cachedPlanPaths.mjs.
import { cachedPlanRef, listPaths, resolveCommit } from './cachedPlanPaths.mjs';

/**
 * createCachedPathLookup(run).lookup(branch, paths) resolves to { status, commit, found, missing }:
 * - 'miss': the branch is not a literal ref; no Git command runs; every path is missing.
 * - 'unknown': a Git step failed; nothing is reported found.
 * - 'ok': found and missing split paths in input order.
 */
export function createCachedPathLookup(run) {
  // ref + NUL + path, for every path once listed in the cached ref.
  const known = new Set();
  const keyOf = (ref, p) => ref + '\0' + p;
  return {
    async lookup(branch, paths) {
      const ref = cachedPlanRef(branch);
      if (!ref) return { status: 'miss', commit: null, found: [], missing: [...paths] };
      const pending = paths.filter((p) => !known.has(keyOf(ref, p)));
      let commit = null;
      if (pending.length > 0) {
        try {
          commit = await resolveCommit(run, ref);
          for (const p of await listPaths(run, commit, pending)) known.add(keyOf(ref, p));
        } catch {
          return { status: 'unknown', commit: null, found: [], missing: [...paths] };
        }
      }
      const found = paths.filter((p) => known.has(keyOf(ref, p)));
      return { status: 'ok', commit, found, missing: paths.filter((p) => !found.includes(p)) };
    },
  };
}
`;

const CACHED_LOOKUP_ASSESSMENT = js`${PRELUDE}
const { createCachedPathLookup } = await load('src/pathLookupCache.mjs');
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const BLOB = 'f'.repeat(40);
const MAIN = 'refs/remotes/origin/main';
const COMMIT_SUFFIX = '^{commit}';

// Fake read-only Git: heads maps a ref to its commit, trees maps a commit to the paths it holds.
// revParse is 'ok', 'throw', 'garbage' (not a commit id) or 'empty'; lsTree is 'ok', 'throw' or 'garbage'.
function fakeGit(trees, heads) {
  const git = { trees, heads, revParse: 'ok', lsTree: 'ok', calls: [] };
  git.run = async (args) => {
    git.calls.push(args);
    if (args.length === 4 && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--end-of-options'
        && args[3].endsWith(COMMIT_SUFFIX)) {
      if (git.revParse === 'throw') throw new Error('fatal: Needed a single revision');
      if (git.revParse === 'garbage') return 'warning: refname is ambiguous\n';
      if (git.revParse === 'empty') return '';
      const head = git.heads[args[3].slice(0, -COMMIT_SUFFIX.length)];
      if (!head) throw new Error('fatal: Needed a single revision');
      return head + '\n';
    }
    if (args[0] === '--literal-pathspecs' && args[1] === 'ls-tree' && args[2] === '-z' && args[3] === '--full-tree'
        && args[5] === '--') {
      if (git.lsTree === 'throw') throw new Error('fatal: unable to read tree');
      if (git.lsTree === 'garbage') return 'not a tree listing';
      const tree = git.trees[args[4]];
      if (!tree) throw new Error('fatal: not a tree object: ' + args[4]);
      return args.slice(6).filter((p) => tree.includes(p)).map((p) => '100644 blob ' + BLOB + '\t' + p + '\0').join('');
    }
    throw new Error('unexpected git command: ' + args.join(' '));
  };
  git.count = (verb) => git.calls.filter((args) => args[0] === verb || args[1] === verb).length;
  git.listed = () => git.calls.filter((args) => args[1] === 'ls-tree').map((args) => args.slice(6));
  return git;
}

test('serves-fresh-positive: at an unchanged commit a found path is served from the cache, the ref resolved per lookup', async () => {
  const git = fakeGit({ [C1]: ['src/a.ts', 'src/b.ts'] }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  assert.deepEqual(await cache.lookup('main', ['src/a.ts', 'src/z.ts']),
    { status: 'ok', commit: C1, found: ['src/a.ts'], missing: ['src/z.ts'] });
  assert.deepEqual(await cache.lookup('main', ['src/a.ts']), { status: 'ok', commit: C1, found: ['src/a.ts'], missing: [] });
  assert.equal(git.count('ls-tree'), 1, 'a fresh positive is not listed again');
  assert.equal(git.count('rev-parse'), 2, 'every lookup resolves the ref exactly once');
  assert.deepEqual(await cache.lookup('main', ['src/b.ts', 'src/a.ts']),
    { status: 'ok', commit: C1, found: ['src/b.ts', 'src/a.ts'], missing: [] });
  assert.deepEqual(git.listed().at(-1), ['src/b.ts'], 'only the paths not served from the cache are listed');
  assert.equal(git.count('rev-parse'), 3);
});

test('invalidates-on-fingerprint-change: a positive recorded at another commit is listed again', async () => {
  const git = fakeGit({ [C1]: ['src/a.ts', 'src/keep.ts'], [C2]: ['src/keep.ts'] }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  assert.deepEqual((await cache.lookup('main', ['src/a.ts', 'src/keep.ts'])).found, ['src/a.ts', 'src/keep.ts']);
  git.heads[MAIN] = C2;
  assert.deepEqual(await cache.lookup('main', ['src/a.ts', 'src/keep.ts']),
    { status: 'ok', commit: C2, found: ['src/keep.ts'], missing: ['src/a.ts'] });
  assert.deepEqual(git.listed(), [['src/a.ts', 'src/keep.ts'], ['src/a.ts', 'src/keep.ts']],
    'both positives were recorded at the old commit');
  git.heads[MAIN] = C1;
  assert.deepEqual((await cache.lookup('main', ['src/a.ts'])).found, ['src/a.ts']);
  git.heads['refs/remotes/origin/release'] = C2;
  assert.deepEqual(await cache.lookup('release', ['src/a.ts']), { status: 'ok', commit: C2, found: [], missing: ['src/a.ts'] });
});

test('fail-closed-on-resolution-error: no cached positive is served when the ref or tree cannot be read', async () => {
  const git = fakeGit({ [C1]: ['src/a.ts'], [C2]: ['src/b.ts'] }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  assert.deepEqual((await cache.lookup('main', ['src/a.ts'])).found, ['src/a.ts']);
  for (const mode of ['throw', 'garbage', 'empty']) {
    git.revParse = mode;
    assert.deepEqual(await cache.lookup('main', ['src/a.ts']),
      { status: 'unknown', commit: null, found: [], missing: ['src/a.ts'] }, 'rev-parse ' + mode);
  }
  assert.equal(git.count('ls-tree'), 1, 'nothing is listed without a resolved commit');
  git.revParse = 'ok';
  git.heads[MAIN] = C2;
  for (const mode of ['throw', 'garbage']) {
    git.lsTree = mode;
    assert.deepEqual(await cache.lookup('main', ['src/a.ts', 'src/b.ts']),
      { status: 'unknown', commit: null, found: [], missing: ['src/a.ts', 'src/b.ts'] }, 'ls-tree ' + mode);
  }
  git.lsTree = 'ok';
  assert.deepEqual(await cache.lookup('main', ['src/a.ts', 'src/b.ts']),
    { status: 'ok', commit: C2, found: ['src/b.ts'], missing: ['src/a.ts'] });
});

test('no-negative-caching: a missing path is listed again on every lookup, even at the same commit', async () => {
  const git = fakeGit({ [C1]: [], [C2]: ['src/new.ts'] }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  const missing = { status: 'ok', commit: C1, found: [], missing: ['src/new.ts'] };
  assert.deepEqual(await cache.lookup('main', ['src/new.ts']), missing);
  assert.deepEqual(await cache.lookup('main', ['src/new.ts']), missing);
  assert.equal(git.count('ls-tree'), 2);
  git.heads[MAIN] = C2;
  assert.deepEqual(await cache.lookup('main', ['src/new.ts']), { status: 'ok', commit: C2, found: ['src/new.ts'], missing: [] });
});

test('bounded-cache: at most 256 positives are kept and the oldest is evicted first', async () => {
  const paths = Array.from({ length: 300 }, (_, i) => 'src/f' + i + '.ts');
  const git = fakeGit({ [C1]: paths }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  for (const p of paths) assert.deepEqual((await cache.lookup('main', [p])).found, [p]);
  const listedBefore = git.count('ls-tree');
  const recent = paths.slice(44);
  assert.deepEqual(await cache.lookup('main', recent), { status: 'ok', commit: C1, found: recent, missing: [] });
  assert.equal(git.count('ls-tree'), listedBefore, 'the 256 most recent positives are still cached');
  assert.deepEqual((await cache.lookup('main', [paths[43]])).found, [paths[43]]);
  assert.deepEqual(git.listed().at(-1), [paths[43]], 'an evicted positive is listed again');
});

test('literal-ref-only: a glob, unsafe or non-string branch misses without running Git', async () => {
  const git = fakeGit({ [C1]: ['src/a.ts'] }, { [MAIN]: C1 });
  const cache = createCachedPathLookup(git.run);
  for (const branch of ['release/*', '../main', 'main.lock', 'feature//x', '-main', '', 42, null]) {
    assert.deepEqual(await cache.lookup(branch, ['src/a.ts']),
      { status: 'miss', commit: null, found: [], missing: ['src/a.ts'] }, JSON.stringify(branch));
  }
  assert.deepEqual(git.calls, []);
});
`;

const CACHED_LOOKUP_FINGERPRINT = {
  ...COMMON,
  id: 'non-routine-cached-lookup-fingerprint',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/cachedPlanPaths.ts`],
    adaptation: 'adapted',
    note: 'Reduced and adapted. src/cachedPlanPaths.mjs keeps cachedPlanRef from util/cachedPlanPaths.ts with types '
      + 'removed, and turns the rev-parse and literal ls-tree steps of findCachedPlanPaths into resolveCommit and '
      + 'listPaths over an injected run(args) instead of execFile. The project-root, toplevel and config checks, the '
      + 'time budget, path normalization and the named miss reasons are dropped. src/pathLookupCache.mjs is synthetic: '
      + 'the frozen commit has no lookup cache, so this module is written for the workload in the style of the source.',
  },
  intendedBehavior: 'src/pathLookupCache.mjs memoizes cached-ref path lookups for submit_plan retries: '
    + 'createCachedPathLookup(run).lookup(branch, paths) resolves to { status, commit, found, missing }, where run(args) '
    + 'is the injected read-only Git runner (it resolves to stdout or rejects). Today a path, once found, is served from '
    + 'the cache forever, even after the ref moves to a commit that no longer contains it. Make the cache '
    + 'commit-aware. Every lookup of a literal branch resolves the ref with resolveCommit exactly once. A cached '
    + 'positive is served only when it was recorded at that same commit; otherwise the path is listed again. '
    + 'listPaths (ls-tree) runs only for the paths not served from the cache, and not at all when every path is. A '
    + "successful lookup returns status 'ok' with commit set to the resolved commit and found and missing in input "
    + 'order. Fail closed: when the ref cannot be resolved (run rejects, or prints something that is not a commit id) '
    + "or the listing fails or cannot be parsed, return { status: 'unknown', commit: null, found: [], missing: <every "
    + 'path> }, never a cached positive, and record nothing from that lookup. Misses are never cached: a path reported '
    + 'missing is listed again on the next lookup, even at the same commit. Keep at most 256 cached positives, evicting '
    + "the oldest first. A non-literal branch keeps returning { status: 'miss', commit: null, found: [], missing: "
    + '<every path> } without running Git. Adversarial examples: (1) src/a.ts is found at commit A; the ref advances '
    + 'to commit B, which deleted it: the next lookup reports it missing at B. (2) After a positive at A, rev-parse '
    + "fails or prints garbage: the lookup is 'unknown' and reports nothing found, not the cached positive. (3) After "
    + '300 single-path lookups at one commit, the 256 most recent paths are served without ls-tree and the 44 oldest '
    + 'are listed again.',
  initialFiles: { 'src/cachedPlanPaths.mjs': CACHED_PLAN_PATHS, 'src/pathLookupCache.mjs': PATH_LOOKUP_CACHE },
  assessmentFiles: { 'acceptance.test.mjs': CACHED_LOOKUP_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'serves-fresh-positive', description: 'At an unchanged commit a positive is served without ls-tree, the ref is resolved once per lookup and only uncached paths are listed.' },
      { id: 'invalidates-on-fingerprint-change', description: 'A positive recorded at another commit is listed again; a path deleted by the new commit is reported missing.' },
      { id: 'fail-closed-on-resolution-error', description: "A failed or unparsable rev-parse or ls-tree yields 'unknown' with nothing found, never a cached positive." },
      { id: 'no-negative-caching', description: 'A missing path is listed again on every lookup and is found once the ref gains it.' },
      { id: 'bounded-cache', description: 'At most 256 positives are kept; the oldest are evicted and listed again.' },
      { id: 'literal-ref-only', description: "A glob, unsafe or non-string branch is a 'miss' with zero Git commands." },
    ],
    coverageTags: ['stale-positive-context', 'cache-invalidation', 'source-fingerprint', 'fail-closed'],
  },
  snapshotDigest: 'sha256:3a0f68ea8263398e67cca2d065221f68c2ca3790c3f5166198320412e1bfe90f',
  assessmentDigest: 'sha256:f88bfa61329cd29ae3b734fe5ce89487a27838d03b4ed0a425d422f4e3755931',
};

// -----------------------------------------------------------------------------
// Case 2: stale negative export lookups after a new source export appears
// -----------------------------------------------------------------------------

const HELPER_FINDER = js`// Before writing a helper, an agent asks whether one is already exported. This module answers
// from module text and memoizes the answers for the session. readSource(module) is the injected
// reader: it resolves to the module's current text, or rejects when the module cannot be read.

/** Named-export declarations; only lines that start with export count, so a commented-out one does not. */
const DECLARATION = /^export\s+(?:async\s+)?(?:function\s*\*?\s*|(?:const|let|var|class)\s+)([A-Za-z_$][\w$]*)/;
const EXPORT_LIST = /^export\s*\{([^}]*)\}/;

/** True when text exports exactly name: a declaration, or an export list entry under its exported alias. */
export function exportsName(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    const declared = DECLARATION.exec(trimmed);
    if (declared && declared[1] === name) return true;
    const list = EXPORT_LIST.exec(trimmed);
    if (list && list[1].split(',').some((part) => part.trim().split(/\s+as\s+/).pop() === name)) return true;
  }
  return false;
}

export function createHelperFinder(readSource) {
  // name -> the last answer, found or not.
  const answers = new Map();
  return {
    /** Resolves to { status: 'found', module } (the first module, in order, exporting name) or { status: 'not-found' }. */
    async find(name, modules) {
      if (answers.has(name)) return answers.get(name);
      let answer = { status: 'not-found' };
      for (const module of modules) {
        if (exportsName(await readSource(module), name)) {
          answer = { status: 'found', module };
          break;
        }
      }
      answers.set(name, answer);
      return answer;
    },
  };
}
`;

const SAMPLE_TEXT_BUDGET = js`// Sample module for helperFinder: declaration exports.
const ELLIPSIS = String.fromCharCode(0x2026);

export const DEFAULT_BUDGET = 1000;

export function truncateForBudget(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars - 1)) + ELLIPSIS, truncated: true };
}
`;

const SAMPLE_LIST_TAIL = js`// Sample module for helperFinder: an export list with an alias. The commented-out line is
// not an export.
function takeLast(items, n) {
  return n > 0 ? items.slice(-n) : [];
}

// export function boundedTail(items, n) { return takeLast(items, n); }
export { takeLast as boundedTailX };
`;

const EXPORT_INDEX_ASSESSMENT = js`${PRELUDE}
const { createHelperFinder } = await load('src/helperFinder.mjs');
const A = 'src/util/a.mjs';
const B = 'src/util/b.mjs';
const C = 'src/util/c.mjs';
const PLAIN = 'export function unrelated() {\n  return 1;\n}\n';
const helper = (name) => PLAIN + 'export function ' + name + '(items, n) {\n  return items.slice(-n);\n}\n';
const found = (module) => ({ status: 'found', module });
const NOT_FOUND = { status: 'not-found' };
const UNKNOWN = { status: 'unknown' };

// In-memory modules: texts holds each module's current text; a module in failing cannot be read.
function workspace(texts) {
  const ws = { texts: { ...texts }, failing: new Set(), reads: [] };
  ws.readSource = async (module) => {
    ws.reads.push(module);
    if (ws.failing.has(module)) throw new Error('EACCES: permission denied, open ' + module);
    if (!Object.prototype.hasOwnProperty.call(ws.texts, module)) throw new Error('ENOENT: no such file, open ' + module);
    return ws.texts[module];
  };
  return ws;
}

test('detects-new-export: a cached negative is not reused after a module gains the export', async () => {
  const ws = workspace({ [A]: PLAIN, [B]: PLAIN });
  const finder = createHelperFinder(ws.readSource);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), NOT_FOUND);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), NOT_FOUND);
  ws.texts[B] = helper('boundedTail');
  assert.deepEqual(await finder.find('boundedTail', [A, B]), found(B));
  assert.deepEqual(await finder.find('lastItem', [A, B]), NOT_FOUND);
  ws.texts[A] = PLAIN + 'const last = (items) => items.at(-1);\nexport { last as lastItem };\n';
  assert.deepEqual(await finder.find('lastItem', [A, B]), found(A));
});

test('scope-aware-negative: an answer for one module set is not reused for another', async () => {
  const ws = workspace({ [A]: PLAIN, [B]: PLAIN, [C]: helper('boundedTail') });
  const finder = createHelperFinder(ws.readSource);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), NOT_FOUND);
  assert.deepEqual(await finder.find('boundedTail', [A, B, C]), found(C));
  assert.deepEqual(await finder.find('boundedTail', [B, A]), NOT_FOUND);
  assert.deepEqual(await finder.find('boundedTail', [C, B]), found(C));
  assert.deepEqual(await finder.find('boundedTail', [A]), NOT_FOUND);
});

test('detects-removed-export: a cached positive is re-verified against the current text', async () => {
  const ws = workspace({ [A]: helper('boundedTail'), [B]: PLAIN });
  const finder = createHelperFinder(ws.readSource);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), found(A));
  ws.texts[A] = helper('boundedTailV2');
  assert.deepEqual(await finder.find('boundedTail', [A, B]), NOT_FOUND);
  ws.texts[B] = helper('boundedTail');
  assert.deepEqual(await finder.find('boundedTail', [A, B]), found(B));
});

test('reverifies-cached-positive: an unchanged cached positive costs one read of its own module', async () => {
  const ws = workspace({ [A]: PLAIN, [B]: PLAIN, [C]: helper('boundedTail') });
  const finder = createHelperFinder(ws.readSource);
  assert.deepEqual(await finder.find('boundedTail', [A, B, C]), found(C));
  ws.reads.length = 0;
  assert.deepEqual(await finder.find('boundedTail', [A, B, C]), found(C));
  assert.deepEqual(ws.reads, [C]);
  ws.texts[A] = helper('boundedTail');
  ws.reads.length = 0;
  assert.deepEqual(await finder.find('boundedTail', [A, B, C]), found(C), 'the cached module is kept while it still exports');
  assert.deepEqual(ws.reads, [C]);
});

test('read-errors-not-cached: an unreadable module makes the answer unknown, and that answer is never reused', async () => {
  const ws = workspace({ [A]: PLAIN, [B]: helper('boundedTail') });
  const finder = createHelperFinder(ws.readSource);
  ws.failing.add(B);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), UNKNOWN);
  ws.failing.delete(B);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), found(B));
  ws.failing.add(B);
  assert.deepEqual(await finder.find('boundedTail', [A, B]), UNKNOWN, 'a cached positive whose module cannot be read');
  assert.deepEqual(await finder.find('lastItem', [A, B]), UNKNOWN);
  ws.failing.delete(B);
  assert.deepEqual(await finder.find('lastItem', [A, B]), NOT_FOUND);
  ws.failing.add(A);
  assert.deepEqual(await finder.find('lastItem', [A, B]), UNKNOWN, 'a cached negative whose module cannot be read');
  ws.failing.delete(A);
  assert.deepEqual(await finder.find('lastItem', [A, B]), NOT_FOUND);
  assert.deepEqual(await finder.find('boundedTail', [A, 'src/util/missing.mjs']), UNKNOWN);
});

test('exact-export-matching: only a named export of exactly that name counts', async () => {
  const texts = {
    [A]: 'export function boundedTailX(items, n) {\n  return items.slice(-n);\n}\n'
      + '// export function boundedTail(items, n) {}\nconst boundedTail = 1;\nexport class BoundedTail {}\n',
    [B]: 'function tail(items) {\n  return items.at(-1);\n}\nexport { tail as lastItem, tail as boundedTailFast };\n',
    [C]: 'export const takeLast = (items, n) => items.slice(-n);\nexport async function loadTail() {}\n'
      + 'export function* walkTail() {}\nexport let tailSize = 3;\n',
  };
  const expectations = [
    ['boundedTail', NOT_FOUND], ['boundedTailX', found(A)], ['BoundedTail', found(A)], ['lastItem', found(B)],
    ['tail', NOT_FOUND], ['boundedTailFast', found(B)], ['takeLast', found(C)], ['loadTail', found(C)],
    ['walkTail', found(C)], ['tailSize', found(C)], ['boundedtail', NOT_FOUND],
  ];
  for (const [name, expected] of expectations) {
    const finder = createHelperFinder(workspace(texts).readSource);
    assert.deepEqual(await finder.find(name, [A, B, C]), expected, name);
  }
});
`;

const STALE_NEGATIVE_EXPORT_INDEX = {
  ...COMMON,
  id: 'non-routine-stale-negative-export-index',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/cachedPlanPaths.ts`, 'docs/plans/2026-10-24-ai-code-quality-and-context.md'],
    adaptation: 'adapted',
    note: 'Synthetic, adapted from two sources. The export index (exportsName, createHelperFinder) does not exist at '
      + 'the frozen commit; it is written for this workload after the "Track negative searches too" paragraph of the '
      + 'plan document (a cached statement that no suitable helper exists goes stale when another worker adds one, so '
      + 'its provenance includes the searched namespace and an index generation) and the miss semantics of '
      + 'util/cachedPlanPaths.ts (a lookup that cannot be performed is never a cached answer). The two sample modules '
      + 'only illustrate the recognized export forms.',
  },
  intendedBehavior: 'src/helperFinder.mjs answers "is a helper with this name already exported?" before an agent '
    + "writes one: createHelperFinder(readSource).find(name, modules) resolves to { status: 'found', module } or "
    + "{ status: 'not-found' }, and readSource(module) resolves to the module's current text or rejects. Today every "
    + "answer, 'not-found' included, is cached by name alone and served forever, so a helper another worker adds "
    + 'later stays invisible. Make the cache provenance-aware. A cached answer belongs to the name AND the searched '
    + 'namespace, the set of modules (order and duplicates do not matter), so an answer for [a, b] is never reused '
    + "for [a, b, c] or [a]. A cached 'not-found' is reused only while every module of that namespace still has the "
    + 'same content fingerprint (the SHA-256 of its current text, from node:crypto) as when the negative was '
    + "recorded; otherwise search again. A cached 'found' is re-verified by reading only its own module: if that "
    + 'module still exports the name, answer it again with exactly that one readSource call; otherwise search '
    + 'again. A fresh search answers the first module, in the given order, that exports the name. If any readSource '
    + "call made by find fails, the answer is { status: 'unknown' } and nothing from that call is cached, so a later "
    + 'call with a readable source reports the true status. Export matching stays exactly as exportsName defines '
    + 'it: a named export of exactly that name (a function, async or generator function, const, let, var or class '
    + 'declaration, or an export list entry under its exported alias); commented-out lines, local names and longer '
    + 'or differently cased names do not count. Adversarial examples: (1) boundedTail is not found in [a, b]; then b '
    + 'gains export function boundedTail: the next find reports b. (2) A negative for [a, b] must not answer '
    + '[a, b, c] when c exports the name. (3) The cached positive in a is renamed away: report not-found, or the '
    + "next module that exports it. (4) b cannot be read: answer 'unknown', never 'not-found', and do not keep that "
    + 'answer. (5) boundedTailX does not match boundedTail.',
  initialFiles: {
    'src/helperFinder.mjs': HELPER_FINDER,
    'src/samples/textBudget.mjs': SAMPLE_TEXT_BUDGET,
    'src/samples/listTail.mjs': SAMPLE_LIST_TAIL,
  },
  assessmentFiles: { 'acceptance.test.mjs': EXPORT_INDEX_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'detects-new-export', description: 'A cached negative is not reused after a module of the namespace gains the export.' },
      { id: 'scope-aware-negative', description: 'Answers are scoped to the module set: a negative for [a, b] never answers [a, b, c], and order does not matter.' },
      { id: 'detects-removed-export', description: 'A cached positive whose module no longer exports the name is searched again.' },
      { id: 'reverifies-cached-positive', description: 'An unchanged cached positive is answered with exactly one read, of its own module.' },
      { id: 'read-errors-not-cached', description: "Any failed read yields 'unknown', never 'not-found', and is never reused." },
      { id: 'exact-export-matching', description: 'Only a named export of exactly that name counts: no prefixes, comments, local names or case folding.' },
    ],
    coverageTags: ['stale-negative-context', 'cache-invalidation', 'source-fingerprint', 'fail-closed'],
  },
  snapshotDigest: 'sha256:1254ff6ad4c03b1240339977bf4e79dae301e2d677e3532f37ec614f1f46b16b',
  assessmentDigest: 'sha256:7e3faff0f3602042a9a2ce8195ee0f6c603e0cff6a61f52a9d74c9877ac6990f',
};

// -----------------------------------------------------------------------------
// Case 3: bounded chat pagination that keeps the unread remainder
// -----------------------------------------------------------------------------

const CHAT_PAYLOAD = js`// Adapted from packages/moe-daemon/src/util/chatPayload.ts at the frozen commit: types removed,
// the system-feed filter, the other limit constants and countTruncatedMessages dropped. truncateForBudget
// is a minimal stand-in for the shared helper in util/memorySettings.ts.

/** Ceiling on the TOTAL content one chat response may carry. */
export const MAX_CHAT_RESPONSE_CHARS = 40000;
/** Approximate serialized overhead of one message's metadata fields. */
export const CHAT_MESSAGE_OVERHEAD_CHARS = 220;

const ELLIPSIS = String.fromCharCode(0x2026);

export function truncateForBudget(text, maxChars) {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).trimEnd() + ELLIPSIS, truncated: true };
}

/** Chars one message occupies in a response once maxContentChars truncation applies (0 or less: none). */
export function chatMessageResponseCost(message, maxContentChars) {
  const contentChars = maxContentChars > 0
    ? Math.min(message.content.length, maxContentChars)
    : message.content.length;
  return contentChars + CHAT_MESSAGE_OVERHEAD_CHARS;
}

/**
 * Cut a message list at the response-size ceiling. Returns the prefix that fits plus what was
 * left behind, so the caller can keep the undelivered tail unread instead of advancing a cursor
 * past it. Always yields at least one message: a single oversized message must still be
 * deliverable, or the caller would spin on it forever.
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
`;

const CHAT_BACKLOG = js`// Adapted from packages/moe-daemon/src/util/chatBacklog.ts at the frozen commit: the state
// manager, watched channels, per-channel cursors and burst caps are replaced by one in-memory
// channel, an array of { id, sender, content, timestamp } messages in delivery order.
import { truncateChatMessages } from './chatPayload.mjs';

/** Every message after sinceId (the whole channel when sinceId is absent or not found), truncated. */
export function readBacklog(messages, sinceId, maxContentChars) {
  const start = sinceId === undefined ? 0 : messages.findIndex((message) => message.id === sinceId) + 1;
  return truncateChatMessages(messages.slice(start), maxContentChars);
}
`;

const CHAT_PAGINATION_ASSESSMENT = js`${PRELUDE}
const payload = await load('src/chatPayload.mjs');
const backlog = await load('src/chatBacklog.mjs');
const ELLIPSIS = String.fromCharCode(0x2026);
const msg = (n, chars) => ({
  id: 'm' + n, sender: 'worker-1', content: 'x'.repeat(chars), timestamp: '2026-10-24T00:00:' + String(n).padStart(2, '0') + '.000Z',
});
const ids = (list) => list.map((message) => message.id);
const page = (messages, options) => backlog.readPage(messages, options);
// Six messages of 80 characters: each costs 80 + 220 = 300 response characters untruncated.
const six = () => Array.from({ length: 6 }, (_, i) => msg(i + 1, 80));

test('respects-limit-and-budget: a page holds at most limit messages and fits the budget after truncation', () => {
  assert.deepEqual(ids(page(six(), { limit: 2, maxContentChars: 0, budget: 100000 }).messages), ['m1', 'm2']);
  assert.deepEqual(ids(page(six(), { limit: 5, maxContentChars: 0, budget: 1000 }).messages), ['m1', 'm2', 'm3']);
  assert.deepEqual(ids(page(six(), { limit: 6, maxContentChars: 30, budget: 1000 }).messages), ['m1', 'm2', 'm3', 'm4']);
  const large = [msg(1, 15000), msg(2, 15000), msg(3, 15000)];
  assert.deepEqual(ids(page(large, { limit: 10, maxContentChars: 0 }).messages), ['m1', 'm2'], 'the default budget');
});

test('cursor-is-last-delivered: nextCursor names the last delivered message and remaining counts the rest', () => {
  const messages = six();
  const first = page(messages, { limit: 5, maxContentChars: 0, budget: 1000 });
  assert.equal(first.nextCursor, 'm3');
  assert.equal(first.remaining, 3);
  const second = page(messages, { sinceId: first.nextCursor, limit: 5, maxContentChars: 0, budget: 1000 });
  assert.deepEqual(ids(second.messages), ['m4', 'm5', 'm6']);
  assert.equal(second.nextCursor, 'm6');
  assert.equal(second.remaining, 0);
  assert.deepEqual(page(messages, { sinceId: 'm6', limit: 5, maxContentChars: 0, budget: 1000 }),
    { messages: [], nextCursor: 'm6', remaining: 0 });
  assert.deepEqual(page([], { limit: 5, maxContentChars: 0, budget: 1000 }), { messages: [], nextCursor: null, remaining: 0 });
});

test('pages-cover-all-exactly-once: paging from each nextCursor returns every message once, in order', () => {
  const sizes = [10, 900, 50, 3000, 5, 5, 5, 1200, 70, 400, 2600, 1];
  const messages = sizes.map((chars, i) => msg(i + 1, chars));
  for (const [limit, maxContentChars, budget] of [[1, 0, 1000], [3, 0, 1000], [5, 200, 900], [4, 0, 2500], [12, 0, 100000]]) {
    const label = JSON.stringify({ limit, maxContentChars, budget });
    const seen = [];
    let cursor;
    for (let guard = 0; guard <= messages.length; guard++) {
      const result = page(messages, { sinceId: cursor, limit, maxContentChars, budget });
      seen.push(...ids(result.messages));
      assert.equal(result.remaining, messages.length - seen.length, label + ' remaining after ' + seen.length);
      cursor = result.nextCursor;
      if (result.remaining === 0) break;
    }
    assert.deepEqual(seen, ids(messages), label);
  }
});

test('oversized-message-progress: a message over the whole budget is delivered alone and paging moves past it', () => {
  const messages = [msg(1, 5000), msg(2, 10), msg(3, 6000)];
  const first = page(messages, { limit: 3, maxContentChars: 0, budget: 500 });
  assert.deepEqual([ids(first.messages), first.nextCursor, first.remaining], [['m1'], 'm1', 2]);
  assert.equal(first.messages[0].content.length, 5000);
  const second = page(messages, { sinceId: first.nextCursor, limit: 3, maxContentChars: 0, budget: 500 });
  assert.deepEqual([ids(second.messages), second.nextCursor, second.remaining], [['m2'], 'm2', 1]);
  const third = page(messages, { sinceId: second.nextCursor, limit: 3, maxContentChars: 0, budget: 500 });
  assert.deepEqual([ids(third.messages), third.nextCursor, third.remaining], [['m3'], 'm3', 0]);
});

test('rejects-unknown-cursor: a sinceId that is not in the channel throws instead of restarting', () => {
  const messages = [msg(1, 10), msg(2, 10)];
  assert.deepEqual(ids(page(messages, { sinceId: 'm1', limit: 5, maxContentChars: 0, budget: 1000 }).messages), ['m2']);
  assert.deepEqual(ids(page(messages, { sinceId: null, limit: 5, maxContentChars: 0, budget: 1000 }).messages), ['m1', 'm2']);
  assert.throws(() => page(messages, { sinceId: 'gone', limit: 5, maxContentChars: 0, budget: 1000 }), /gone/);
  assert.throws(() => page([], { sinceId: 'm1', limit: 5, maxContentChars: 0, budget: 1000 }), /m1/);
});

test('truncation-flags-preserved: delivered messages are truncated with their flags and inputs stay intact', () => {
  const messages = [msg(1, 50), msg(2, 5)];
  const result = page(messages, { limit: 5, maxContentChars: 20, budget: 1000 });
  assert.deepEqual(result.messages, [
    { ...messages[0], content: 'x'.repeat(19) + ELLIPSIS, contentTruncated: true, contentOriginalLength: 50 },
    messages[1],
  ]);
  assert.equal(messages[0].content.length, 50);
  assert.equal(page(messages, { limit: 5, maxContentChars: 0, budget: 1000 }).messages[0].content.length, 50);
});

test('payload-helpers-unchanged: the shared payload helpers and readBacklog keep their behaviour for other callers', () => {
  assert.equal(payload.CHAT_MESSAGE_OVERHEAD_CHARS, 220);
  assert.equal(payload.MAX_CHAT_RESPONSE_CHARS, 40000);
  assert.equal(payload.chatMessageResponseCost(msg(1, 50), 0), 270);
  assert.equal(payload.chatMessageResponseCost(msg(1, 50), 20), 240);
  const list = [msg(1, 600), msg(2, 600), msg(3, 600)];
  const capped = payload.capChatMessagesToResponseBudget(list, 0, 1000);
  assert.deepEqual([ids(capped.delivered), ids(capped.dropped)], [['m1'], ['m2', 'm3']]);
  assert.deepEqual(ids(payload.capChatMessagesToResponseBudget([msg(1, 5000)], 0, 10).delivered), ['m1']);
  assert.deepEqual(ids(payload.capChatMessagesToResponseBudget(list, 0, 100000).delivered), ['m1', 'm2', 'm3']);
  assert.equal(payload.truncateChatMessage(list[0], 0), list[0]);
  assert.deepEqual(ids(backlog.readBacklog(list, 'm1', 0)), ['m2', 'm3']);
  assert.deepEqual(ids(backlog.readBacklog(list, undefined, 0)), ['m1', 'm2', 'm3']);
});
`;

const CHAT_PAGINATION_REMAINDER = {
  ...COMMON,
  id: 'non-routine-chat-pagination-remainder',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/chatPayload.ts`, `${SRC}util/chatBacklog.ts`],
    adaptation: 'adapted',
    note: 'Adapted. src/chatPayload.mjs keeps MAX_CHAT_RESPONSE_CHARS, CHAT_MESSAGE_OVERHEAD_CHARS, '
      + 'chatMessageResponseCost, capChatMessagesToResponseBudget, truncateChatMessage and truncateChatMessages from '
      + 'util/chatPayload.ts with types removed; truncateForBudget is a minimal stand-in for the util/memorySettings.ts '
      + 'helper, and the system-feed filter, the other limit constants and countTruncatedMessages are dropped. '
      + 'src/chatBacklog.mjs replaces the multi-channel drain of util/chatBacklog.ts (state manager, per-channel '
      + 'cursors, burst caps, delivery bookkeeping) with one in-memory channel and an unbounded readBacklog written '
      + 'for this workload.',
  },
  intendedBehavior: 'src/chatBacklog.mjs serves one in-memory chat channel, an array of { id, sender, content, '
    + 'timestamp } messages in delivery order. readBacklog(messages, sinceId, maxContentChars) returns EVERY message '
    + 'after sinceId in one unbounded response and silently restarts from the first message when sinceId is unknown. '
    + 'Add a bounded pager next to it and keep readBacklog for its callers: readPage(messages, { sinceId, limit, '
    + 'maxContentChars, budget }) returns { messages, nextCursor, remaining }. sinceId undefined or null starts at '
    + 'the first message; a sinceId that is not in the channel throws an Error whose message names it, never a '
    + 'silent restart. A page takes at most limit (a positive integer) messages after the cursor and then keeps only '
    + 'the prefix that fits the response budget, as capChatMessagesToResponseBudget in src/chatPayload.mjs decides '
    + 'with costs counted after maxContentChars truncation; budget defaults to MAX_CHAT_RESPONSE_CHARS. A page '
    + 'always carries at least one message while any remain, even a message larger than the whole budget. Returned '
    + 'messages are truncated by truncateChatMessages, so a truncated one carries contentTruncated and '
    + 'contentOriginalLength (maxContentChars 0 or less: no truncation). nextCursor is the id of the LAST DELIVERED '
    + 'message (when nothing is delivered: the sinceId passed, or null without one), and remaining is the number of '
    + 'messages after nextCursor. Paging from each nextCursor until remaining is 0 returns every message exactly '
    + 'once, in order. Do not change the shared payload helpers: other callers depend on them. Adversarial '
    + 'examples: (1) Six messages costing 300 characters each, limit 5, budget 1000: the page holds m1-m3, '
    + 'nextCursor is m3 (not m5) and remaining is 3. (2) A 5000-character message with budget 500 is delivered alone '
    + "and the next page starts after it. (3) sinceId 'gone' throws instead of returning the whole channel again.",
  initialFiles: { 'src/chatPayload.mjs': CHAT_PAYLOAD, 'src/chatBacklog.mjs': CHAT_BACKLOG },
  assessmentFiles: { 'acceptance.test.mjs': CHAT_PAGINATION_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'respects-limit-and-budget', description: 'A page holds at most limit messages and fits the (default or given) budget, costs counted after truncation.' },
      { id: 'cursor-is-last-delivered', description: 'nextCursor is the last delivered id and remaining counts the messages after it, including empty pages.' },
      { id: 'pages-cover-all-exactly-once', description: 'Paging from each nextCursor until remaining is 0 returns every message once, in order.' },
      { id: 'oversized-message-progress', description: 'A message over the whole budget is delivered alone, untruncated, and paging moves past it.' },
      { id: 'rejects-unknown-cursor', description: 'An unknown sinceId throws an Error naming it; a known or absent cursor pages normally.' },
      { id: 'truncation-flags-preserved', description: 'Delivered messages carry the truncateChatMessage text and flags; inputs are not mutated.' },
      { id: 'payload-helpers-unchanged', description: 'The shared payload helpers and readBacklog keep their behaviour for other callers.' },
    ],
    coverageTags: ['reusable-helper', 'bounded-context', 'cursor-safety', 'pagination'],
  },
  snapshotDigest: 'sha256:dd52b34def2da7e0bb28799d31c8eebff89610340f218e1b6fbbfb7ae5c0deab',
  assessmentDigest: 'sha256:be1d27574836ff2d9496015358429bc94c8f35bfa9aec494138d74b9c6563abf',
};

// -----------------------------------------------------------------------------
// Case 4: monotonic attempt generations from the historical maximum
// -----------------------------------------------------------------------------

const ATTEMPT_GENERATIONS = js`// Adapted from packages/moe-daemon/src/state/attemptStore.ts at the frozen commit. Every
// execution attempt of a task gets a fencing generation, so a late caller can be told whether it
// still owns the current attempt. The state manager, phases and persistence are replaced by a
// plain store object { records: [{ id, taskId, generation }] } that is saved as JSON; records may
// be pruned (deleteAttempt) or arrive with gaps, for example after a crash.

export const MAX_ATTEMPT_GENERATION = Number.MAX_SAFE_INTEGER;

/** Next fencing generation for taskId. */
export function nextGeneration(store, taskId) {
  return store.records.filter((record) => record.taskId === taskId).length + 1;
}

/** Opens a new attempt record for taskId with the next generation. */
export function openAttempt(store, taskId, id) {
  const record = { id, taskId, generation: nextGeneration(store, taskId) };
  store.records.push(record);
  return record;
}

/** Prunes one attempt record. */
export function deleteAttempt(store, id) {
  const index = store.records.findIndex((record) => record.id === id);
  if (index >= 0) store.records.splice(index, 1);
}
`;

const ATTEMPT_GENERATION_ASSESSMENT = js`${PRELUDE}
const generations = await load('src/attemptGenerations.mjs');
const MAX = Number.MAX_SAFE_INTEGER;
const store = (records, highWater) => ({
  records: records.map(([id, taskId, generation]) => ({ id, taskId, generation })),
  ...(highWater === undefined ? {} : { highWater }),
});
const next = (s, taskId) => generations.nextGeneration(s, taskId);
const exhausted = (error) => error instanceof Error && error.code === 'ATTEMPT_GENERATION_EXHAUSTED';

test('uses-historical-maximum: the next generation follows the highest stored one, not the record count', () => {
  assert.equal(next(store([['a1', 't1', 1], ['a2', 't1', 2], ['a5', 't1', 5]]), 't1'), 6);
  assert.equal(next(store([['b9', 't2', 9], ['b3', 't2', 3]]), 't2'), 10);
  assert.equal(next(store([]), 't3'), 1);
});

test('survives-deleted-highest: a pruned highest attempt is never reissued', () => {
  assert.equal(next(store([['a1', 't1', 1], ['a2', 't1', 2]], { t1: 5 }), 't1'), 6);
  const live = { records: [] };
  assert.equal(generations.openAttempt(live, 't1', 'x1').generation, 1);
  assert.equal(generations.openAttempt(live, 't1', 'x2').generation, 2);
  generations.deleteAttempt(live, 'x2');
  assert.equal(generations.openAttempt(live, 't1', 'x3').generation, 3);
  generations.deleteAttempt(live, 'x1');
  generations.deleteAttempt(live, 'x3');
  assert.deepEqual(live.records, []);
  assert.equal(generations.openAttempt(live, 't1', 'x4').generation, 4);
  const reloaded = JSON.parse(JSON.stringify(live));
  reloaded.records = [];
  assert.equal(next(reloaded, 't1'), 5);
});

test('per-task-independence: each task allocates from its own history only', () => {
  const s = store([['a1', 't1', 1], ['b1', 't2', 1], ['b2', 't2', 2], ['b3', 't2', 3]], { t3: 7 });
  assert.equal(next(s, 't1'), 2);
  assert.equal(next(s, 't2'), 4);
  assert.equal(next(s, 't9'), 1);
  assert.equal(s.highWater.t3, 7);
  assert.deepEqual(s.records.map((record) => record.generation), [1, 1, 2, 3]);
});

test('rejects-malformed-stored: a corrupt stored generation throws, names its record and changes nothing', () => {
  for (const bad of [0, -1, 1.5, '3', NaN, MAX + 2, Infinity, null, undefined]) {
    const s = store([['ok-record', 't1', 1], ['bad-record', 't1', bad]], { other: 4 });
    assert.throws(() => next(s, 't1'), /bad-record/, String(bad));
    assert.deepEqual(s.highWater, { other: 4 }, 'a failed call changes nothing: ' + String(bad));
  }
  for (const bad of [0, -2, 2.5, '9', NaN, MAX + 2]) {
    const s = store([['ok-record', 't1', 1]], { t1: bad });
    assert.throws(() => next(s, 't1'), /t1/, 'high-water mark ' + String(bad));
    assert.equal(s.highWater.t1, bad);
  }
});

test('exhaustion-fails-closed: no generation is issued past Number.MAX_SAFE_INTEGER', () => {
  assert.equal(generations.MAX_ATTEMPT_GENERATION, MAX);
  assert.equal(next(store([['near', 't1', MAX - 1]]), 't1'), MAX);
  assert.throws(() => next(store([['last', 't1', MAX]]), 't1'), exhausted);
  const marked = store([], { t1: MAX });
  assert.throws(() => next(marked, 't1'), exhausted);
  assert.deepEqual(marked.highWater, { t1: MAX });
});

test('persists-high-water: each allocation is recorded, so later ones strictly increase', () => {
  const s = { records: [] };
  assert.equal(next(s, 't1'), 1);
  assert.deepEqual(s.highWater, { t1: 1 });
  const seen = [1];
  for (let i = 0; i < 6; i++) seen.push(next(s, 't1'));
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(s.highWater, { t1: 7 });
  assert.equal(next(JSON.parse(JSON.stringify(s)), 't1'), 8);
  assert.equal(next(store([['a1', 't2', 3]], { t2: 2 }), 't2'), 4);
});
`;

const MONOTONIC_ATTEMPT_GENERATION = {
  ...COMMON,
  id: 'non-routine-monotonic-attempt-generation',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}state/attemptStore.ts`],
    adaptation: 'adapted',
    note: 'Adapted and deliberately rewound. At the frozen commit state/attemptStore.ts already allocates the max '
      + 'over every prior attempt + 1 and decodes stored generations strictly; this fixture starts from the superseded '
      + 'count-based allocation that design replaced, on a plain { records } store instead of the state manager, with '
      + 'openAttempt and deleteAttempt reduced to record bookkeeping. The persisted high-water mark the workload asks '
      + 'for does not exist in the source.',
  },
  intendedBehavior: 'src/attemptGenerations.mjs allocates the fencing generation of each execution attempt. The '
    + 'store is a plain object { records: [{ id, taskId, generation }] } persisted as JSON; records can be pruned '
    + "(deleteAttempt) or arrive with gaps. nextGeneration(store, taskId) returns the number of the task's records + "
    + '1, so after a prune it reissues a generation an in-flight caller still holds. Rework the allocation. '
    + 'nextGeneration must return max(store.highWater[taskId], the highest stored generation among the task\'s '
    + 'records) + 1, a missing value counting as 0, and record that value as store.highWater[taskId] (creating '
    + 'store.highWater when it is absent) before returning, so no generation is ever issued twice for a task, even '
    + "after its records are deleted. Tasks are independent: other tasks' records and high-water marks neither "
    + 'affect nor change the result. Fail closed on corrupt data: a stored generation of one of the task\'s records '
    + "that is not a positive safe integer (0, -1, 1.5, the string '3', NaN, null, Infinity or anything above "
    + "Number.MAX_SAFE_INTEGER) throws an Error whose message names that record's id, and a present but corrupt "
    + 'store.highWater[taskId] throws an Error naming the task; never skip or coerce them. When the maximum is '
    + "already MAX_ATTEMPT_GENERATION (Number.MAX_SAFE_INTEGER), throw an Error with code 'ATTEMPT_GENERATION_EXHAUSTED'. "
    + 'A call that throws changes nothing. openAttempt and deleteAttempt keep their signatures. Adversarial examples: '
    + '(1) Records with generations 1, 2 and 5 allocate 6, not 4. (2) Records 1 and 2 with a high-water mark of 5 '
    + '(attempt 5 was pruned) allocate 6, not 3. (3) Two calls with no new record return 1, then 2. (4) A high-water '
    + 'mark of Number.MAX_SAFE_INTEGER throws ATTEMPT_GENERATION_EXHAUSTED even with no records.',
  initialFiles: { 'src/attemptGenerations.mjs': ATTEMPT_GENERATIONS },
  assessmentFiles: { 'acceptance.test.mjs': ATTEMPT_GENERATION_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'uses-historical-maximum', description: 'The next generation is the highest stored generation + 1, not the record count + 1.' },
      { id: 'survives-deleted-highest', description: 'A pruned highest attempt is never reissued, through the store and through openAttempt and deleteAttempt.' },
      { id: 'per-task-independence', description: "Other tasks' records and high-water marks neither affect nor change a task's allocation." },
      { id: 'rejects-malformed-stored', description: 'A corrupt stored generation or high-water mark throws, naming the record or task, and changes nothing.' },
      { id: 'exhaustion-fails-closed', description: "At Number.MAX_SAFE_INTEGER, from records or the high-water mark, it throws 'ATTEMPT_GENERATION_EXHAUSTED'." },
      { id: 'persists-high-water', description: 'Every allocation is recorded in store.highWater, so repeated allocations strictly increase across a JSON round trip.' },
    ],
    coverageTags: ['changed-requirements', 'monotonic-identity', 'history-gaps', 'fail-closed'],
  },
  snapshotDigest: 'sha256:086d62fc4ca7f99f22f047a7e47d53442291620edce50da831234cac95350ed0',
  assessmentDigest: 'sha256:0194f40a7fc9769c9d07c0971107219c09f2ed348839a5d62c054ade4d4bd356',
};

// -----------------------------------------------------------------------------
// Case 5: cross-role usage rollup deduplicated by durable provider identity
// -----------------------------------------------------------------------------

const USAGE_ROLLUP = js`// Reduced from scripts/usage-report.mjs at the frozen commit. The counter field list, count, key,
// the metadata helper, identifiedGroups, mergeGroup and aggregate are kept as they were; the
// receipt reader, task records, warnings and report shape are dropped. Callers pass normalized
// receipt rows:
//   { provider, scope, coverage, outcome, taskId, launchId, sessionId, eventId, roles: [role],
//     requestedModels, requestedEfforts, reportedModels, usage: { <field>: number or null } }
// where a null counter is unknown.

export const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens'];
export const count = value => Number.isSafeInteger(value) && value >= 0;
export const key = (...values) => JSON.stringify(values);
const metadataFields = ['roles', 'requestedModels', 'requestedEfforts', 'reportedModels'];
const metadata = rows => Object.fromEntries(metadataFields.map(field =>
  [field, [...new Set(rows.flatMap(row => row[field]))].sort()]));

/** The counters identifiedGroups and mergeGroup maintain. */
export function newStats() {
  return { duplicateRecords: 0, unidentifiedRecords: 0, conflictingGroups: 0 };
}

export function identifiedGroups(records, stats) {
  const identities = new Map();
  const groups = new Set();
  for (const row of records) {
    const ids = [];
    // Missing usage belongs to that failed/incomplete launch, never to an older
    // measured cumulative result for a resumed Claude session.
    if (row.scope === 'session' && row.sessionId && !['missing', 'pending'].includes(row.coverage)) {
      ids.push(key(row.provider, 'session', row.sessionId));
    }
    if (row.eventId) ids.push(key(row.provider, row.scope, row.coverage === 'missing' ? 'missing-event' : 'event', row.eventId));
    if (!ids.length) stats.unidentifiedRecords++;
    const matched = new Set(ids.map(id => identities.get(id)).filter(Boolean));
    const group = { rows: [row], ids: new Set(ids) };
    for (const prior of matched) {
      group.rows.push(...prior.rows);
      for (const id of prior.ids) group.ids.add(id);
      groups.delete(prior);
    }
    for (const id of group.ids) identities.set(id, group);
    groups.add(group);
  }
  return [...groups].map(group => mergeGroup(group.rows, stats));
}

export function mergeGroup(rows, stats) {
  stats.duplicateRecords += rows.length - 1;
  const usage = {};
  let conflict = false;
  for (const field of fields) {
    const values = new Set(rows.map(row => row.usage[field]).filter(value => value !== null));
    usage[field] = values.size === 1 ? [...values][0] : null;
    if (values.size > 1) conflict = true;
  }
  // An input/output disagreement also invalidates any derived total.
  if (usage.inputTokens === null || usage.outputTokens === null) usage.totalTokens = null;
  const tasks = new Set(rows.map(row => row.taskId).filter(Boolean));
  const outcomes = new Set(rows.map(row => row.outcome).filter(value => value !== 'unknown'));
  if (tasks.size > 1 || outcomes.size > 1) conflict = true;
  if (conflict) stats.conflictingGroups++;
  return { provider: rows[0].provider, taskId: tasks.size === 1 ? [...tasks][0] : null,
    launches: [...new Set(rows.map(row => row.launchId).filter(Boolean))],
    outcome: outcomes.size === 1 ? [...outcomes][0] : 'unknown', ...metadata(rows), usage };
}

export function aggregate(rows) {
  const usage = {};
  const overflowFields = [];
  for (const field of fields) {
    const values = rows.map(row => row.usage[field]).filter(value => value !== null);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!count(total)) overflowFields.push(field);
    usage[field] = { observedTokens: values.length && count(total) ? total : null,
      unknownRecords: rows.length - values.length };
  }
  return { records: rows.length, launches: new Set(rows.flatMap(row => row.launches)).size,
    errors: rows.filter(row => row.outcome === 'error').length,
    unknownOutcomes: rows.filter(row => row.outcome === 'unknown').length, ...metadata(rows), usage, overflowFields };
}

/** The usage report's task table: one entry per provider and task, deduplicated by durable identity first. */
export function rollupByProviderTask(records) {
  const stats = newStats();
  const groups = new Map();
  for (const row of identifiedGroups(records, stats)) {
    const id = key(row.provider, row.taskId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const entries = [...groups.values()].map(rows => ({ provider: rows[0].provider, taskId: rows[0].taskId, ...aggregate(rows) }))
    .sort((a, b) => key(a.provider, a.taskId).localeCompare(key(b.provider, b.taskId)));
  return { stats, entries };
}
`;

const USAGE_ROLLUP_ASSESSMENT = js`${PRELUDE}
const rollup = await load('scripts/usageRollup.mjs');
const usage = (input, output) => ({
  inputTokens: input, cacheReadTokens: null, cacheWriteTokens: null, uncachedInputTokens: null,
  outputTokens: output, reasoningTokens: null, totalTokens: input === null || output === null ? null : input + output,
});
// A normalized Claude session receipt; overrides switch provider, identity, role, task or counters.
const receipt = (overrides) => ({
  provider: 'claude', scope: 'session', coverage: 'reported', outcome: 'success', taskId: 'task-a',
  launchId: 'launch-1', sessionId: 'session-1', eventId: null, roles: ['worker'],
  requestedModels: [], requestedEfforts: [], reportedModels: [], usage: usage(100, 10), ...overrides,
});
const turn = (overrides) => receipt({ provider: 'codex', scope: 'turn', sessionId: null, ...overrides });
const entryFor = (entries, taskId) => {
  const entry = entries.find((candidate) => candidate.taskId === taskId);
  assert.ok(entry, 'no entry for task ' + taskId);
  return entry;
};

test('dedupes-durable-identity: a session or event reported twice counts once, across launches', () => {
  const entries = rollup.rollupByTask([
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(100, 10) }),
    receipt({ launchId: 'L2', sessionId: 'S1', usage: usage(100, 10) }),
    turn({ launchId: 'L3', eventId: 'E1', roles: ['qa'], usage: usage(30, 3) }),
    turn({ launchId: 'L3', eventId: 'E2', roles: ['qa'], usage: usage(50, 5) }),
    turn({ launchId: 'L3', eventId: 'E2', roles: ['qa'], usage: usage(50, 5) }),
  ]);
  assert.equal(entries.length, 1);
  const entry = entryFor(entries, 'task-a');
  assert.equal(entry.records, 3);
  assert.deepEqual(entry.usage.inputTokens, { observedTokens: 180, unknownRecords: 0 });
  assert.deepEqual(entry.usage.outputTokens, { observedTokens: 18, unknownRecords: 0 });
  assert.deepEqual(entry.providers, ['claude', 'codex']);
  assert.equal(entry.launches, 3);
  assert.equal(entry.unidentifiedRecords, 0);
});

test('keeps-unidentified-visible: rows without durable identity stay counted and flagged, never merged or dropped', () => {
  const unidentified = { launchId: null, sessionId: null, coverage: 'missing', outcome: 'error', usage: usage(null, null) };
  const entries = rollup.rollupByTask([
    receipt({ sessionId: 'S1' }),
    receipt(unidentified),
    receipt(unidentified),
    receipt({ launchId: 'L8', sessionId: 'S9', coverage: 'pending', outcome: 'unknown', usage: usage(null, null) }),
    receipt({ taskId: 'task-b', launchId: 'L9', sessionId: 'S2' }),
  ]);
  const a = entryFor(entries, 'task-a');
  assert.equal(a.records, 4);
  assert.equal(a.unidentifiedRecords, 3);
  assert.equal(a.errors, 2);
  assert.deepEqual(a.usage.inputTokens, { observedTokens: 100, unknownRecords: 3 });
  assert.equal(entryFor(entries, 'task-b').unidentifiedRecords, 0);
});

test('preserves-unknown-counters: unknown counters stay unknown, never zero', () => {
  const entry = entryFor(rollup.rollupByTask([
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(100, 10) }),
    receipt({ launchId: 'L2', sessionId: 'S2', usage: usage(null, 7) }),
    receipt({ launchId: 'L3', sessionId: 'S3', usage: usage(50, null) }),
  ]), 'task-a');
  assert.deepEqual(entry.usage.inputTokens, { observedTokens: 150, unknownRecords: 1 });
  assert.deepEqual(entry.usage.outputTokens, { observedTokens: 17, unknownRecords: 1 });
  assert.deepEqual(entry.usage.totalTokens, { observedTokens: 110, unknownRecords: 2 });
  assert.deepEqual(entry.usage.cacheReadTokens, { observedTokens: null, unknownRecords: 3 });
});

test('conflicts-become-unknown: disagreeing duplicates leave that field, or the task, unknown', () => {
  const entries = rollup.rollupByTask([
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(100, 10) }),
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(120, 10) }),
    receipt({ launchId: 'L2', sessionId: 'S2', usage: usage(5, 1) }),
    receipt({ taskId: 'task-a', launchId: 'L5', sessionId: 'S5', usage: usage(9, 9) }),
    receipt({ taskId: 'task-b', launchId: 'L5', sessionId: 'S5', usage: usage(9, 9) }),
    receipt({ taskId: 'task-b', launchId: 'L6', sessionId: 'S6', usage: usage(2, 2) }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.taskId), ['task-a', 'task-b', null]);
  const a = entryFor(entries, 'task-a');
  assert.equal(a.records, 2);
  assert.deepEqual(a.usage.inputTokens, { observedTokens: 5, unknownRecords: 1 });
  assert.deepEqual(a.usage.outputTokens, { observedTokens: 11, unknownRecords: 0 });
  assert.deepEqual(a.usage.totalTokens, { observedTokens: 6, unknownRecords: 1 });
  assert.deepEqual(entryFor(entries, 'task-b').usage.inputTokens, { observedTokens: 2, unknownRecords: 0 });
  const unattributed = entryFor(entries, null);
  assert.equal(unattributed.records, 1);
  assert.deepEqual(unattributed.usage.inputTokens, { observedTokens: 9, unknownRecords: 0 });
});

test('per-role-breakdown: each deduplicated group counts once, under its single role, multiple or unknown', () => {
  const entry = entryFor(rollup.rollupByTask([
    receipt({ launchId: 'L1', sessionId: 'S-arch', roles: ['architect'], usage: usage(10, 1) }),
    receipt({ launchId: 'L2', sessionId: 'S-work', roles: ['worker'], usage: usage(100, 10) }),
    receipt({ launchId: 'L3', sessionId: 'S-work', roles: ['worker'], usage: usage(100, 10) }),
    turn({ launchId: 'L4', eventId: 'E-qa', roles: ['qa'], usage: usage(30, 3) }),
    receipt({ launchId: 'L5', sessionId: 'S-both', roles: ['worker'], usage: usage(7, 1) }),
    receipt({ launchId: 'L6', sessionId: 'S-both', roles: ['qa'], usage: usage(7, 1) }),
    receipt({ launchId: 'L7', sessionId: 'S-none', roles: [], usage: usage(4, 4) }),
  ]), 'task-a');
  const summary = Object.fromEntries(Object.entries(entry.byRole)
    .map(([role, part]) => [role, [part.records, part.usage.inputTokens.observedTokens]]));
  assert.deepEqual(summary, { architect: [1, 10], worker: [1, 100], qa: [1, 30], multiple: [1, 7], unknown: [1, 4] });
  assert.equal(entry.records, 5);
  assert.deepEqual(entry.usage.inputTokens, { observedTokens: 151, unknownRecords: 0 });
  assert.deepEqual(entry.roles, ['architect', 'qa', 'worker']);
});

test('overflow-unknown: a sum past Number.MAX_SAFE_INTEGER is unknown and listed', () => {
  const big = 2 ** 52;
  const entries = rollup.rollupByTask([
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(big, 1) }),
    receipt({ launchId: 'L2', sessionId: 'S2', usage: usage(big, 1) }),
    receipt({ taskId: 'task-b', launchId: 'L3', sessionId: 'S3', usage: usage(3, 1) }),
  ]);
  const a = entryFor(entries, 'task-a');
  assert.deepEqual(a.usage.inputTokens, { observedTokens: null, unknownRecords: 0 });
  assert.deepEqual(a.usage.outputTokens, { observedTokens: 2, unknownRecords: 0 });
  assert.deepEqual(a.overflowFields, ['inputTokens', 'totalTokens']);
  assert.deepEqual(entryFor(entries, 'task-b').overflowFields, []);
});

test('provider-rollup-unchanged: the per-provider task rollup keeps its behaviour', () => {
  const { entries, stats } = rollup.rollupByProviderTask([
    receipt({ launchId: 'L1', sessionId: 'S1', usage: usage(100, 10) }),
    receipt({ launchId: 'L2', sessionId: 'S1', usage: usage(100, 10) }),
    turn({ launchId: 'L3', eventId: 'E1', roles: ['qa'], usage: usage(30, 3) }),
    receipt({ taskId: 'task-b', launchId: 'L4', sessionId: 'S2', usage: usage(5, 1) }),
    receipt({ launchId: null, sessionId: null, coverage: 'missing', outcome: 'error', usage: usage(null, null) }),
  ]);
  assert.deepEqual(entries.map((e) => [e.provider, e.taskId, e.records, e.launches, e.usage.inputTokens.observedTokens,
    e.usage.inputTokens.unknownRecords]), [
    ['claude', 'task-a', 2, 2, 100, 1], ['claude', 'task-b', 1, 1, 5, 0], ['codex', 'task-a', 1, 1, 30, 0],
  ]);
  assert.deepEqual(stats, { duplicateRecords: 1, unidentifiedRecords: 1, conflictingGroups: 0 });
});
`;

const CROSS_ROLE_USAGE_ROLLUP = {
  ...COMMON,
  id: 'non-routine-cross-role-usage-rollup',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: ['scripts/usage-report.mjs'],
    adaptation: 'reduced',
    note: 'Reduced from scripts/usage-report.mjs at the frozen commit (CQ-M02 changed the file afterwards). The '
      + 'counter field list, count, key, the metadata helper, identifiedGroups, mergeGroup and aggregate are kept '
      + 'verbatim apart from export keywords; newStats holds only the three counters they touch, and '
      + 'rollupByProviderTask is the per-provider task grouping of grouped() without task records. The receipt reader '
      + 'and its validation, task records, warnings and the report shape are dropped: callers pass normalized rows.',
  },
  intendedBehavior: "scripts/usageRollup.mjs keeps the usage report's durable-identity deduplication: "
    + 'identifiedGroups(records, stats) merges receipt rows that share a provider session identity (a measured '
    + "Claude session: scope 'session' with a sessionId and coverage other than 'missing' or 'pending') or a "
    + 'provider event identity (eventId); mergeGroup turns disagreeing counters, outcomes or tasks into unknown '
    + '(null); aggregate sums observed counters and counts unknown ones. Its only rollup, rollupByProviderTask, '
    + 'splits a task by provider and loses which role spent what. Add rollupByTask(records): an array with one entry '
    + 'per task across providers and roles, sorted by taskId, with the entry for groups without a single task '
    + '(missing or conflicting attribution, taskId null) last. Deduplicate by durable identity BEFORE summing, '
    + 'exactly as identifiedGroups does, so the same session or event reported by two launches or two roles counts '
    + 'once; never merge rows by launchId or by equal contents. Each entry is { taskId, providers, '
    + "...aggregate(<the entry's deduplicated groups>), unidentifiedRecords, byRole }. providers is the sorted list "
    + "of providers. unidentifiedRecords counts the entry's input rows that carry no durable identity; those rows "
    + 'stay counted as records of their own, never dropped or merged. Unknown counters stay unknown: they are '
    + 'excluded from observedTokens and counted in unknownRecords, and a field with no observed value has '
    + 'observedTokens null, never 0. A conflicting duplicate makes that field unknown, as mergeGroup decides. A sum '
    + "that is not a safe integer makes that field's observedTokens null and lists it in overflowFields, as "
    + "aggregate decides. byRole maps each deduplicated group's role to aggregate(<that role's groups>): the group's "
    + "single role, 'multiple' when its rows name more than one role, or 'unknown' when they name none; the byRole "
    + 'records add up to the entry records. Keep rollupByProviderTask, identifiedGroups, mergeGroup and aggregate '
    + 'behaving as they do. Adversarial examples: (1) Claude session S1 reported by launches L1 and L2 counts once. '
    + '(2) Codex events E1 and E2 from one launch are two turns, not one. (3) Two identical rows without sessionId '
    + 'or eventId are two unidentified records. (4) Input tokens 100, unknown and 50 give observedTokens 150 with '
    + "unknownRecords 1. (5) A session reported by a worker launch and a QA launch counts once, under 'multiple'.",
  initialFiles: { 'scripts/usageRollup.mjs': USAGE_ROLLUP },
  assessmentFiles: { 'acceptance.test.mjs': USAGE_ROLLUP_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'dedupes-durable-identity', description: 'A session or event reported by several launches counts once; distinct events of one launch stay distinct.' },
      { id: 'keeps-unidentified-visible', description: 'Rows without durable identity stay separate records and are counted in unidentifiedRecords.' },
      { id: 'preserves-unknown-counters', description: 'Unknown counters are excluded from observedTokens and counted; an all-unknown field is null, not 0.' },
      { id: 'conflicts-become-unknown', description: 'Disagreeing duplicates make the field unknown, or the task null (sorted last).' },
      { id: 'per-role-breakdown', description: "byRole counts each deduplicated group once under its single role, 'multiple' or 'unknown'." },
      { id: 'overflow-unknown', description: 'A sum past Number.MAX_SAFE_INTEGER is null and listed in overflowFields.' },
      { id: 'provider-rollup-unchanged', description: 'rollupByProviderTask and its stats keep their behaviour.' },
    ],
    coverageTags: ['reusable-helper', 'usage-dedup', 'unknown-preservation', 'cross-role'],
  },
  snapshotDigest: 'sha256:bdf97bfc94aed0f30c6d655d6e7b834a7d8ce91c37bb71bab9c79126e83a1bca',
  assessmentDigest: 'sha256:523c6d3dcc636f854277c9b11a63fed774de73223aa17a2b70ea166389e3f039',
};

/** The five frozen non-routine workloads, validated and deep-frozen at import. */
export const NON_ROUTINE_WORKLOADS: readonly Workload[] = validateWorkloads([
  CACHED_LOOKUP_FINGERPRINT,
  STALE_NEGATIVE_EXPORT_INDEX,
  CHAT_PAGINATION_REMAINDER,
  MONOTONIC_ATTEMPT_GENERATION,
  CROSS_ROLE_USAGE_ROLLUP,
]);

// Negative search provenance (CQ-C05): when a literal search over a scope found nothing, and whether that still holds. Each
// negative carries a generation derived from the content of the scope it searched, so a new, changed or deleted file in scope
// moves it. A lookup is 'absent' only when the caller's freshly computed generation equals the recorded one. Watchers, git
// status and mtimes are never consulted, and anything partial, failed, unverifiable or lost reads 'unknown'. Semantic (C03)
// answers are never negatives: an analyzer cannot establish absence. Only caller-shape errors throw.
import { createHash } from 'node:crypto';
import { openProjectGit, runGit, runGitHead, type GitHeadRunner, type PlanPathGitRunner } from '../util/cachedPlanPaths.js';
import { invalidInput } from '../util/errors.js';
import { limitedHead, limitedRun, SOURCE_LIMITS, SOURCE_SLOTS, validateSourceRequest, type RepositorySource } from './repositorySource.js';
import { SNAPSHOT_CONTROL_SEGMENTS, verifySourceSnapshot } from './snapshotManifest.js';
import type { SnapshotSource } from './snapshotSource.js';
import { sourceCacheKey, type SourceCache } from './sourceCache.js';

export type NegativeNamespace = 'repository-literal' | 'snapshot-literal';
export interface NegativeQuery { namespace: NegativeNamespace; literal: string; paths?: string[] }
export type NegativeLookup = 'absent' | 'stale' | 'unknown';
interface NegativeRecord { version: 1; key: string; namespace: NegativeNamespace; generation: string; manifest: unknown }
// What each provider never searches: C02 greps with --no-recurse-submodules, and R09b exports no control segment.
const EXCLUSIONS: Record<NegativeNamespace, readonly string[]> = Object.freeze({
  'repository-literal': ['gitlinks'], 'snapshot-literal': [...SNAPSHOT_CONTROL_SEGMENTS].sort() });
// The limitation each provider stamps on its own results.
const PROVIDER: Record<NegativeNamespace, string> = Object.freeze({ 'repository-literal': 'committed-bytes-only', 'snapshot-literal': 'snapshot-bytes' });
const TAG = 'moe-negative-generation-v1\0';
const HEX64 = /^[0-9a-f]{64}$/;
const LS_TREE_BYTES = 4 * 1024 * 1024;
// A recursive listing holds only blobs and gitlinks; the path after the tab is raw bytes.
const ENTRY = /^(?:(?:100644|100755|120000) blob|160000 commit) (?:[0-9a-f]{40}|[0-9a-f]{64})\t[\s\S]+$/;
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// By C02's own rules for a commit, a literal and its scopes; sorted and deduplicated, so [] and undefined are one scope.
function scope(paths: unknown, literal: unknown = 'x', commit = '0'.repeat(40)): string[] {
  validateSourceRequest(commit, [{ id: 'negative', purpose: 'source', op: 'search', literal, paths }]);
  return [...new Set((paths as string[] | undefined) ?? [])].sort();
}

/** The C04 SourceCache key of a negative, in its own key space beside the positive slices. */
export function negativeSearchKey(query: NegativeQuery): string {
  if (!query || typeof query !== 'object' || !Object.hasOwn(EXCLUSIONS, query.namespace)) {
    throw invalidInput('namespace', 'must be repository-literal or snapshot-literal');
  }
  return sourceCacheKey(['negative-search', 1, query.namespace, query.literal, scope(query.paths, query.literal), EXCLUSIONS[query.namespace]]);
}

/** The merged view's in-scope files (overlay files win, overlay deletes hide base files), each as its path, executable bit and
 * the sha256 the verifier recomputed from its bytes. Null when the raw snapshot does not verify. Pure and synchronous. */
export function snapshotScopeGeneration(snapshot: unknown, paths?: readonly string[]): string | null {
  const scopes = scope(paths);
  let verified: ReturnType<typeof verifySourceSnapshot>;
  try { verified = verifySourceSnapshot(snapshot); } catch { return null; }
  if (!verified.ok) return null;
  const files = new Map(verified.snapshot.base);
  for (const [path, entry] of verified.snapshot.overlay) if ('kind' in entry) files.delete(path); else files.set(path, entry);
  const kept = [...files.values()].filter(f => !scopes.length || scopes.some(s => f.path === s || f.path.startsWith(`${s}/`)))
    .map(f => ({ f, key: Buffer.from(f.path) })).sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash('sha256').update(TAG).update(u32(kept.length));
  for (const { f, key } of kept) hash.update(key).update(Uint8Array.of(0, f.executable ? 1 : 0)).update(Buffer.from(f.sha256, 'hex'));
  return hash.digest('hex');
}

/** The scope's committed entries (mode, type, oid, path; no commit id), so an unrelated commit keeps the generation. Null on
 * any Git failure, overflow or unparsable listing. Read-only, bounded and slot-limited like C02. */
export async function repositoryScopeGeneration(projectRoot: string, commit: string, paths?: readonly string[],
  options: { run?: PlanPathGitRunner; head?: GitHeadRunner } = {}): Promise<string | null> {
  const scopes = scope(paths, 'x', commit);
  try {
    const git = await openProjectGit(projectRoot, limitedRun(SOURCE_SLOTS, options.run ?? runGit), SOURCE_LIMITS.timeBudgetMs,
      limitedHead(SOURCE_SLOTS, options.head ?? runGitHead));
    const out = await git.head('ls-tree', ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', `${commit}^{commit}`, '--', ...scopes], LS_TREE_BYTES);
    if (out.truncated || out.exitCode !== 0 || (out.stdout.length > 0 && out.stdout.at(-1) !== 0)) return null;
    // latin1 maps each byte to one character, so the NUL framing splits exactly.
    const records = out.stdout.length ? out.stdout.subarray(0, -1).toString('latin1').split('\0') : [];
    if (!records.every(record => ENTRY.test(record))) return null;
    return createHash('sha256').update(TAG).update(u32(records.length)).update(out.stdout).digest('hex');
  } catch { return null; }
}

// Why a provider result is not a complete zero-match enumeration of one search, or undefined when it is.
function refusal(namespace: NegativeNamespace, result: RepositorySource | SnapshotSource | null, generation: unknown): string | undefined {
  const item = Array.isArray(result?.items) && result.items.length === 1 ? result.items[0] : undefined;
  if (item?.op !== 'search') return 'not-single-search';
  if (item.status !== 'served' || item.reason !== undefined) return `${item.status}:${item.reason}`;
  if (!Array.isArray(item.matches) || item.matches.length > 0) return 'not-zero-match';
  if (result!.complete !== true) return 'incomplete';
  if (!Array.isArray(result!.limitations) || !result!.limitations.includes(PROVIDER[namespace])) return 'namespace-mismatch';
  if (typeof generation !== 'string' || !HEX64.test(generation)) return 'generation-unknown';
  return undefined;
}

/** Stores a negative in C04's one store, only for the single served, zero-match, complete search the caller ran for this query,
 * with the generation computed from the same snapshot or commit. Anything partial, failed or positive is refused and stored never. */
export function recordNegative(cache: SourceCache, query: NegativeQuery, result: RepositorySource | SnapshotSource,
  generation: string | null): { ok: true } | { ok: false; reason: string } {
  const key = negativeSearchKey(query), reason = refusal(query.namespace, result, generation);
  if (reason !== undefined) return { ok: false, reason };
  // The cache stores and returns detached clones; a re-record replaces the entry.
  cache.set(key, { version: 1, key, namespace: query.namespace, generation: generation!, manifest: result.manifest } satisfies NegativeRecord);
  return { ok: true };
}

/** 'absent' only when the generation the caller just computed from content equals the recorded one; 'stale' when it differs;
 * 'unknown' for no generation and for a missing, evicted or malformed entry. A stale entry stays until re-recorded or evicted:
 * a lookup for an older snapshot must not erase a negative that still holds for a newer one. */
export function lookupNegative(cache: SourceCache, query: NegativeQuery, generation: string | null): NegativeLookup {
  const key = negativeSearchKey(query);
  if (typeof generation !== 'string' || !HEX64.test(generation)) return 'unknown';
  const stored = cache.get<Partial<NegativeRecord>>(key);
  if (!stored || typeof stored !== 'object' || stored.version !== 1 || stored.key !== key || stored.namespace !== query.namespace
    || typeof stored.generation !== 'string' || !HEX64.test(stored.generation)) return 'unknown';
  return stored.generation === generation ? 'absent' : 'stale';
}

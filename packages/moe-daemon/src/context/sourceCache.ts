// Positive source cache (CQ-C04): in-memory, bounded, positive-only, advisory reuse of the C02 commit, C02b snapshot and C03
// semantic answers. Each key hashes the immutable content, analyzer identity and exact request an answer depends on, so a changed
// input makes an old entry unreachable, never stale. Nothing persists: a miss, eviction, clear() or restart costs recomputation,
// never correctness. No filesystem or process access here. Negatives (missing, zero-match, empty) belong to CQ-C05.
import { createHash } from 'node:crypto';
import { invalidInput } from '../util/errors.js';
import { openAnalyzerSession, type AnalyzerCallResult } from './mcpStdioClient.js';
import { capTotal, readRepositorySource, SOURCE_LIMITS, validateSourceRequest, type RepositorySource, type SourceItem,
  type SourceLimits, type SourceOptions, type SourceQuery } from './repositorySource.js';
import { readSemanticSource, type SemanticOptions, type SemanticQuery, type SemanticSource } from './semanticSource.js';
import { verifySourceSnapshot, type VerifiedSnapshotFile } from './snapshotManifest.js';
import { readSnapshotSource, type SnapshotProvenance, type SnapshotRequest, type SnapshotSource, type SnapshotSourceItem } from './snapshotSource.js';

export const SOURCE_CACHE_LIMITS = Object.freeze({ maxEntries: 2048, maxBytes: 33_554_432 });
/** LRU in Map insertion order. No timers and no TTL: time is not a content dependency. */
export class SourceCache {
  private readonly limits: typeof SOURCE_CACHE_LIMITS;
  private readonly entries = new Map<string, { value: unknown; size: number }>();
  private readonly counts = { bytes: 0, hits: 0, misses: 0, evictions: 0 };
  constructor(limits: Partial<typeof SOURCE_CACHE_LIMITS> = {}) {
    if (!limits || typeof limits !== 'object' || Object.getPrototypeOf(limits) !== Object.prototype) throw invalidInput('limits', 'must be a plain object');
    for (const [key, value] of Object.entries(limits)) {
      if (!Object.hasOwn(SOURCE_CACHE_LIMITS, key) || !Number.isSafeInteger(value) || (value as number) <= 0) throw invalidInput(`limits.${key}`, 'must be a known positive safe integer');
    }
    this.limits = { ...SOURCE_CACHE_LIMITS, ...limits };
  }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key); if (entry === undefined) { this.counts.misses++; return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); this.counts.hits++;
    return structuredClone(entry.value) as T;
  }
  /** Never throws, so the cache cannot fail a request: a value it cannot clone, size or hold drops the key instead. */
  set(key: string, value: unknown): void {
    this.drop(key);
    try {
      const copy = structuredClone(value), size = Buffer.byteLength(JSON.stringify(copy));
      if (size > this.limits.maxBytes) return;
      this.entries.set(key, { value: copy, size }); this.counts.bytes += size;
    } catch { return; }
    for (const [oldest] of this.entries) {
      if (this.entries.size <= this.limits.maxEntries && this.counts.bytes <= this.limits.maxBytes) break;
      this.drop(oldest); this.counts.evictions++;
    }
  }
  clear(): void { this.entries.clear(); this.counts.bytes = 0; }
  stats(): { entries: number; bytes: number; hits: number; misses: number; evictions: number } { return { entries: this.entries.size, ...this.counts }; }
  private drop(key: string): void {
    const entry = this.entries.get(key); if (entry !== undefined) { this.entries.delete(key); this.counts.bytes -= entry.size; }
  }
}

/** Callers pass only JSON values (strings, numbers, booleans, null, arrays, plain objects) built in a fixed key order. */
export const sourceCacheKey = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(['moe-source-cache-v1', ...parts])).digest('hex');
// Fail open: whatever cannot be prepared or keyed is simply not cached.
const attempt = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
/** A served read (an empty file still exists) or a served search with a match. */
export const isPositiveSource = (item: { status: string; op: string; matches?: readonly unknown[] }): boolean =>
  item.status === 'served' && (item.op === 'read' || (item.op === 'search' && (item.matches?.length ?? 0) > 0));
/** A complete, nonblank analyzer answer; an empty '[]' or '{}' may be a negative. */
export const isPositiveAnswer = (answer: AnalyzerCallResult): boolean =>
  answer.ok && !answer.truncated && !/^\s*(?:\[\s*\]|\{\s*\})?\s*$/.test(answer.text);

// Shared merge over provider RESULTS, so the sync snapshot wrapper reuses it. A warm answer equals the uncached one but for availability.
// A failed, total-capped or budget-cut subset item can depend on which queries shared its batch: answer with the full call.
const batchBound = (items: readonly SourceItem[]) => items.some(i => i.status === 'unavailable' || i.status === 'omitted' || i.reason === 'time-budget');
function remember<R extends { items: SourceItem[] }>(cache: SourceCache, keys: readonly (string | undefined)[], result: R): R {
  result.items.forEach((item, i) => { const key = keys[i]; if (key !== undefined && isPositiveSource(item)) cache.set(key, item); });
  return result;
}
function assemble<T extends SourceItem>(queries: SourceQuery[], hits: readonly (T | undefined)[], fresh: readonly T[],
  rebind: (hit: T, q: SourceQuery) => T, maxTotalBytes: number): T[] {
  let next = 0;
  return capTotal(queries.map((q, i) => { const hit = hits[i]; return hit === undefined ? fresh[next++] : rebind(hit, q); }), maxTotalBytes);
}
const envelope = <M, T extends SourceItem>(manifest: M, items: T[], limitations: string[]) => ({ manifest, items,
  complete: items.every(i => i.status === 'served'), limitations: [...new Set(limitations)].sort(), bytes: items.reduce((sum, i) => sum + i.bytes, 0) });
const searched = (hits: readonly (SourceItem | undefined)[]) => (hits.some(hit => hit?.op === 'search') ? ['literal-search-only'] : []);

/** C02 by commit. A full hit skips C02's reads entirely: the commit names immutable bytes (read with --no-replace-objects), so reuse
 * can only add availability, for example after the commit was deleted, never change an answer. Slices are per commit. */
export async function cachedRepositorySource(cache: SourceCache, projectRoot: string, commit: string, queries: SourceQuery[],
  options: SourceOptions = {}): Promise<RepositorySource> {
  const read = (qs: SourceQuery[]) => readRepositorySource(projectRoot, commit, qs, options);
  let limits: SourceLimits, keys: string[], hits: (SourceItem | undefined)[];
  try {
    validateSourceRequest(commit, queries, options.limits);
    limits = { ...SOURCE_LIMITS, ...options.limits };
    // id and purpose are rebound on a hit. Budgets only cost availability, and the total cap is reapplied below.
    keys = queries.map(q => sourceCacheKey(q.op === 'read' ? ['git-read', projectRoot, commit, q.path, limits.maxFileBytes]
      : ['git-search', projectRoot, commit, q.literal, q.paths ?? null, limits.maxMatches, limits.maxSearchBytes]));
    hits = keys.map(key => cache.get<SourceItem>(key));
  } catch { return read(queries); } // the uncached call throws or answers canonically
  const rest = queries.filter((_, i) => hits[i] === undefined);
  if (rest.length === queries.length) return remember(cache, keys, await read(queries));
  const subset = rest.length > 0 ? await read(rest) : undefined;
  if (subset !== undefined && batchBound(subset.items)) return remember(cache, keys, await read(queries));
  if (subset !== undefined) remember(cache, keys.filter((_, i) => hits[i] === undefined), subset);
  const items = assemble(queries, hits, subset?.items ?? [], (hit, q) => ({ ...hit, id: q.id, purpose: q.purpose }), limits.maxTotalBytes);
  return envelope({ commit }, items, ['committed-bytes-only', ...subset?.limitations ?? [], ...searched(hits)]);
}

// Undefined when C02b answers on its own: unverifiable or stale (nothing is stored), or a caller error (C02b throws it).
function prepareSnapshot(cache: SourceCache, snapshot: unknown, request: SnapshotRequest, queries: SourceQuery[], overrides?: Partial<SourceLimits>) {
  validateSourceRequest(request.commit, queries, overrides);
  const verified = verifySourceSnapshot(snapshot);
  if (!verified.ok) return undefined;
  const { commit, tree, identity, base, overlay } = verified.snapshot;
  if (commit !== request.commit || (request.base !== undefined && request.base !== identity.base)
    || (request.overlay !== undefined && request.overlay !== identity.overlay)) return undefined;
  // The merged view, from the verified copies only: base files, replaced by overlay files, minus overlay deletes.
  const files = new Map<string, { file: VerifiedSnapshotFile; layer: 'base' | 'overlay' }>([...base].map(([path, file]) => [path, { file, layer: 'base' }]));
  for (const [path, entry] of overlay) if ('kind' in entry) files.delete(path); else files.set(path, { file: entry, layer: 'overlay' });
  const sorted = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const limits: SourceLimits = { ...SOURCE_LIMITS, ...overrides };
  // A slice keys only its own bytes (no commit, tree or layer digest): a same-status dirty edit re-keys just the slices that see it.
  const keys = queries.map(q => {
    if (q.op === 'read') { const file = files.get(q.path)?.file; return file && sourceCacheKey(['snapshot-read', q.path, file.executable, file.sha256, limits.maxFileBytes]); }
    const scopes = q.paths ?? [], scope = createHash('sha256');
    for (const p of sorted) if (!scopes.length || scopes.some(s => p === s || p.startsWith(`${s}/`))) scope.update(`${p}\0${files.get(p)!.file.sha256}\n`);
    return sourceCacheKey(['snapshot-search', q.literal, q.paths ?? null, scope.digest('hex'), limits.maxMatches, limits.maxSearchBytes]);
  });
  const provenanceOf = (path: string): SnapshotProvenance => { const { file, layer } = files.get(path)!; return { layer, manifest: identity[layer], sha256: file.sha256 }; };
  return { keys, hits: keys.map(key => (key === undefined ? undefined : cache.get<SnapshotSourceItem>(key))), limits, provenanceOf,
    manifest: { commit, tree, base: identity.base, overlay: identity.overlay } };
}

/** C02b by content. Synchronous, like C02b, so nothing runs between this verification and C02b's. Known cost: a call with any
 * miss verifies twice, because C02b takes the raw snapshot; a fully cached call never calls C02b. */
export function cachedSnapshotSource(cache: SourceCache, snapshot: unknown, request: SnapshotRequest, queries: SourceQuery[],
  options: { limits?: Partial<SourceLimits> } = {}): SnapshotSource {
  const read = (qs: SourceQuery[]) => readSnapshotSource(snapshot, request, qs, options);
  const prepared = attempt(() => prepareSnapshot(cache, snapshot, request, queries, options.limits));
  if (prepared === undefined) return read(queries); // C02b answers or throws canonically
  const { keys, hits, limits, provenanceOf, manifest } = prepared;
  // Merge and store only from a result for this very snapshot: raw input that reads differently twice can never mix two.
  const ours = (result: SnapshotSource) => JSON.stringify(result.manifest) === JSON.stringify(manifest);
  const full = () => { const result = read(queries); return ours(result) ? remember(cache, keys, result) : result; };
  const rest = queries.filter((_, i) => hits[i] === undefined);
  if (rest.length === queries.length) return full();
  const subset = rest.length > 0 ? read(rest) : undefined;
  if (subset !== undefined && (!ours(subset) || batchBound(subset.items))) return full();
  if (subset !== undefined) remember(cache, keys.filter((_, i) => hits[i] === undefined), subset);
  // Provenance always names the snapshot actually served.
  const items = assemble(queries, hits, subset?.items ?? [], (hit, q) => ({ ...hit, id: q.id, purpose: q.purpose, ...(hit.op === 'read'
    ? { provenance: provenanceOf(hit.path!) } : { matches: hit.matches!.map(m => ({ ...m, provenance: provenanceOf(m.path) })) }) }), limits.maxTotalBytes);
  return envelope(manifest, items, ['snapshot-bytes', ...subset?.limitations ?? [], ...searched(hits)]);
}

/** C03 via its open seam. Keys: content is the whole immutable commit (an answer can depend on any file, in-repo config or lockfile);
 * the analyzer is its absolute command, server {name, version, protocolVersion} and the tool's inputSchema; the instruction is tool,
 * args and maxResponseBytes; launch cwd, env, args and timeoutMs are temp paths and budgets. Hits skip query work only: identity is
 * known only from a live session. A dev build or language server swapped without a version or schema change goes unnoticed. */
export function cachedSemanticSource(cache: SourceCache, projectRoot: string, commit: string, queries: SemanticQuery[],
  options: SemanticOptions = {}): Promise<SemanticSource> {
  const open = options.open ?? openAnalyzerSession;
  return readSemanticSource(projectRoot, commit, queries, { ...options, open: async (launch, allowedTools) => {
    const opened = await open(launch, allowedTools);
    if (!opened.ok) return opened; // C03 serves its explicit unavailable items, never anything cached
    const s = opened.session, schema = (tool: string) => s.tools.find(t => t.name === tool)?.inputSchema ?? null;
    const call = async (tool: string, args: Readonly<Record<string, unknown>>): Promise<AnalyzerCallResult> => {
      const key = attempt(() => sourceCacheKey(['semantic', projectRoot, commit, launch.command, s.server, schema(tool), tool, args, launch.maxResponseBytes]));
      const hit = key === undefined ? undefined : cache.get<AnalyzerCallResult>(key); if (hit !== undefined) return hit;
      const answer = await s.call(tool, args);
      if (key !== undefined && isPositiveAnswer(answer)) cache.set(key, answer);
      return answer;
    };
    return { ok: true, session: { server: s.server, tools: s.tools, call, close: () => s.close() } };
  } });
}

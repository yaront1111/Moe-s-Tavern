// Serves C02 source queries from R09b's SourceSnapshot (a protected base commit plus overlay bytes), only after
// snapshotManifest.ts has verified it. Pure and synchronous: no filesystem, process or Git access. Only the verifier's
// private copies are served, and every refusal stays explicit: never a fallback to base, working-tree or Git bytes.
import { invalidInput } from '../util/errors.js';
import {
  capTotal, SOURCE_LIMITS, validateSourceRequest,
  type SourceItem, type SourceItemStatus, type SourceLimits, type SourceMatch, type SourceQuery,
} from './repositorySource.js';
import { snapshotPathRefusal, verifySourceSnapshot, type VerifiedSnapshot, type VerifiedSnapshotFile } from './snapshotManifest.js';

// manifest is the recomputed digest of the layer that supplied the bytes; sha256 is recomputed from the served copy.
export interface SnapshotProvenance { readonly layer: 'base' | 'overlay'; readonly manifest: string; readonly sha256: string }
export interface SnapshotSourceMatch extends SourceMatch { provenance: SnapshotProvenance }
export interface SnapshotSourceItem extends Omit<SourceItem, 'oid' | 'matches'> {
  provenance?: SnapshotProvenance;
  matches?: SnapshotSourceMatch[];
}
export interface SnapshotSource {
  manifest: { commit: string; tree: string | null; base: string | null; overlay: string | null };
  items: SnapshotSourceItem[];
  complete: boolean;
  limitations: string[];
  bytes: number;
}
export interface SnapshotRequest { commit: string; base?: string; overlay?: string }

interface Served { readonly file: VerifiedSnapshotFile; readonly provenance: SnapshotProvenance }
interface View {
  readonly files: ReadonlyMap<string, Served>;
  readonly deleted: ReadonlySet<string>;
  readonly sorted: ReadonlyArray<{ readonly key: Buffer; readonly path: string; readonly served: Served }>;
}
const HEX64 = /^[0-9a-f]{64}$/;
// ignoreBOM keeps a leading U+FEFF, so decoded text has exactly the byte length of the bytes it came from.
const decode = (bytes: Uint8Array, stream = false) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream });

function item(query: SourceQuery, status: SourceItemStatus, reason?: string): SnapshotSourceItem {
  return { id: query.id, purpose: query.purpose, op: query.op, status, bytes: 0,
    ...(query.op === 'read' ? { path: query.path } : {}), ...(reason !== undefined ? { reason } : {}) };
}
function result(manifest: SnapshotSource['manifest'], items: SnapshotSourceItem[], limitations: string[]): SnapshotSource {
  return { manifest, items, complete: items.every(i => i.status === 'served'),
    limitations: [...new Set(['snapshot-bytes', ...limitations])].sort(), bytes: items.reduce((sum, i) => sum + i.bytes, 0) };
}

// Base files minus overlay deletes, plus overlay files, in UTF-8 path-byte order (git grep's order).
function mergedView(snapshot: VerifiedSnapshot): View {
  const files = new Map<string, Served>();
  const deleted = new Set<string>();
  for (const [layer, entries] of [['base', snapshot.base], ['overlay', snapshot.overlay]] as const) {
    for (const [path, entry] of entries) {
      if ('kind' in entry) { files.delete(path); deleted.add(path); continue; }
      files.set(path, { file: entry, provenance: Object.freeze({ layer, manifest: snapshot.identity[layer], sha256: entry.sha256 }) });
    }
  }
  const sorted = [...files].map(([path, served]) => ({ key: Buffer.from(path), path, served }));
  return { files, deleted, sorted: sorted.sort((a, b) => Buffer.compare(a.key, b.key)) };
}

// Undefined when the path names a file, or, for a search scope, a directory of the merged view.
function classify(path: string, view: View, scope: boolean): { status: SourceItemStatus; reason: string } | undefined {
  const refusal = snapshotPathRefusal(path);
  if (refusal) return { status: 'refused', reason: refusal === 'SNAPSHOT_CONTROL_PATH' ? 'control-path' : 'path-invalid' };
  if (view.deleted.has(path)) return { status: 'missing', reason: 'deleted-in-overlay' };
  if (view.files.has(path)) return undefined;
  if ([...view.files.keys()].some(p => p.startsWith(`${path}/`))) return scope ? undefined : { status: 'refused', reason: 'not-a-file' };
  return { status: 'missing', reason: scope ? 'scope-not-in-manifest' : 'not-in-manifest' };
}

function readItem(query: SourceQuery & { op: 'read' }, view: View, limits: SourceLimits): SnapshotSourceItem {
  const verdict = classify(query.path, view, false);
  if (verdict) return item(query, verdict.status, verdict.reason);
  const { file, provenance } = view.files.get(query.path)!;
  const base = { ...item(query, 'served'), mode: file.executable ? '100755' : '100644', size: file.size, provenance };
  const truncated = file.size > limits.maxFileBytes;
  // As C02's readBlob sees it: only the first maxFileBytes, and streaming drops ONLY an unfinished final sequence.
  const head = file.data.subarray(0, limits.maxFileBytes);
  if (head.includes(0)) return { ...base, status: 'refused', reason: 'binary' };
  let content: string;
  try { content = decode(head, truncated); } catch { return { ...base, status: 'refused', reason: 'not-utf8' }; }
  const bytes = Buffer.byteLength(content);
  return truncated ? { ...base, status: 'truncated', reason: 'file-byte-cap', content, bytes } : { ...base, content, bytes };
}

// Mirrors `git grep -F -n -a`: lines split on LF only (a CR stays in the text), one match per line. Unlike C02, which
// caps raw grep output, maxSearchBytes caps the served path+text bytes. The deadline is checked between files.
function searchItem(query: SourceQuery & { op: 'search' }, view: View, limits: SourceLimits, deadline: number, limitations: string[]): SnapshotSourceItem {
  const scopes = query.paths ?? [];
  for (const scope of scopes) {
    const verdict = classify(scope, view, true);
    if (verdict) return item(query, verdict.status, verdict.reason);
  }
  limitations.push('literal-search-only');
  const needle = Buffer.from(query.literal);
  const matches: SnapshotSourceMatch[] = [];
  let bytes = 0;
  let reason: string | undefined;
  scan: for (const { path, served } of view.sorted) {
    if (scopes.length && !scopes.some(s => path === s || path.startsWith(`${s}/`))) continue;
    if (performance.now() > deadline) { reason ??= 'time-budget'; break; }
    const data = Buffer.from(served.file.data.buffer, served.file.data.byteOffset, served.file.data.byteLength);
    if (!data.includes(needle)) continue;
    for (let start = 0, line = 1; start < data.length; line += 1) {
      // A file may hold millions of short lines: re-check the deadline every 4096 of them, not only between files.
      if (line % 4096 === 0 && performance.now() > deadline) { reason ??= 'time-budget'; break scan; }
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      const text = data.subarray(start, end);
      start = end + 1;
      if (!text.includes(needle)) continue;
      let decoded: string | undefined;
      try { if (!text.includes(0)) decoded = decode(text); } catch { /* invalid UTF-8: reported below */ }
      if (decoded === undefined) { reason ??= 'undecodable-match'; continue; }
      if (matches.length >= limits.maxMatches) { reason ??= 'match-cap'; break scan; }
      const size = Buffer.byteLength(path) + text.length;
      if (bytes + size > limits.maxSearchBytes) { reason ??= 'search-byte-cap'; break scan; }
      bytes += size;
      matches.push({ path, line, text: decoded, provenance: served.provenance });
    }
  }
  return { ...item(query, reason ? 'truncated' : 'served', reason), matches, bytes };
}

/** Verifies the raw snapshot once, then serves every query from its verified bytes. Only caller-shape errors throw. */
export function readSnapshotSource(snapshot: unknown, request: SnapshotRequest, queries: SourceQuery[],
  options: { limits?: Partial<SourceLimits> } = {}): SnapshotSource {
  if (typeof request !== 'object' || request === null) throw invalidInput('request', 'must be an object');
  const { commit: wanted, base, overlay } = request;
  validateSourceRequest(wanted, queries, options.limits);
  for (const [key, value] of [['base', base], ['overlay', overlay]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !HEX64.test(value))) throw invalidInput(`request.${key}`, 'must be a lowercase sha256 hex digest');
  }
  const limits: SourceLimits = { ...SOURCE_LIMITS, ...options.limits };
  const deadline = performance.now() + limits.timeBudgetMs;
  const unavailable = (reason: string, manifest: SnapshotSource['manifest']) =>
    result(manifest, queries.map(q => item(q, 'unavailable', reason)), [reason.split(':')[0]]);
  const verified = verifySourceSnapshot(snapshot);
  if (!verified.ok) return unavailable(`snapshot-unverifiable:${verified.code}`, { commit: wanted, tree: null, base: null, overlay: null });
  const { commit, tree, identity } = verified.snapshot;
  const manifest = { commit, tree, base: identity.base, overlay: identity.overlay };
  if (commit !== wanted || (base !== undefined && base !== identity.base) || (overlay !== undefined && overlay !== identity.overlay)) {
    return unavailable('snapshot-stale', manifest);
  }
  const view = mergedView(verified.snapshot);
  const limitations: string[] = [];
  const items = queries.map(q => (performance.now() > deadline ? item(q, 'unavailable', 'time-budget')
    : q.op === 'read' ? readItem(q, view, limits) : searchItem(q, view, limits, deadline, limitations)));
  return result(manifest, capTotal(items, limits.maxTotalBytes), limitations);
}

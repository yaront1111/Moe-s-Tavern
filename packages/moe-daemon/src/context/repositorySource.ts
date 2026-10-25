import { normalizeAffectedFile } from '../util/affectedFiles.js';
import { invalidInput, notFound, MoeError, MoeErrorCode } from '../util/errors.js';
import type { StateManager } from '../state/StateManager.js';
import { openProjectGit, runGit, runGitHead, type GitHeadRunner, type PlanPathGitRunner } from '../util/cachedPlanPaths.js';

export type SourcePurpose = 'source' | 'pattern' | 'caller' | 'config' | 'test';
export type SourceQuery = { id: string; purpose: SourcePurpose } & (
  { op: 'read'; path: string } | { op: 'search'; literal: string; paths?: string[] });
export type SourceItemStatus = 'served' | 'truncated' | 'omitted' | 'missing' | 'refused' | 'unavailable';
export interface SourceMatch { path: string; line: number; text: string }
export interface SourceItem {
  id: string;
  purpose: SourcePurpose;
  op: SourceQuery['op'];
  status: SourceItemStatus;
  reason?: string;
  path?: string;
  oid?: string;
  mode?: string;
  size?: number;
  content?: string;
  matches?: SourceMatch[];
  bytes: number;
}
export interface RepositorySource {
  manifest: { commit: string };
  items: SourceItem[];
  complete: boolean;
  limitations: string[];
  bytes: number;
}
export const SOURCE_LIMITS = Object.freeze({
  timeBudgetMs: 3000, maxQueries: 32, maxFileBytes: 65536, maxSearchBytes: 65536,
  maxMatches: 200, maxTotalBytes: 262144, maxLiteralChars: 200, maxScopePaths: 16, maxPathspecChars: 24000,
});
export type SourceLimits = { [K in keyof typeof SOURCE_LIMITS]: number };

function sourceLimits(overrides: Partial<SourceLimits> = {}): SourceLimits {
  if (!plainObject(overrides)) throw invalidInput('limits', 'must be a plain object');
  const limits = { ...SOURCE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    const ceiling = key === 'timeBudgetMs' ? 10000 : SOURCE_LIMITS[key as keyof SourceLimits];
    if (!ceiling || !Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw invalidInput(`limits.${key}`, 'must be a positive integer within the ceiling');
    }
  }
  return limits;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function normalizedPath(value: unknown): value is string {
  try {
    return typeof value === 'string' && normalizeAffectedFile(value) === value
      && !value.includes('\ufffd') && Buffer.from(value).toString('utf8') === value
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
  } catch { return false; }
}
function prefixes(path: string): string[] {
  const parts = path.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}
function pathspecs(queries: SourceQuery[]): string[] {
  return [...new Set(queries.flatMap(q => (q.op === 'read' ? [q.path] : q.paths ?? []).flatMap(prefixes)))];
}
function validateQuery(q: unknown, index: number, ids: Set<string>, limits: SourceLimits): void {
  const field = `queries[${index}]`;
  if (!plainObject(q)) throw invalidInput(field, 'must be a plain object');
  if (q.op !== 'read' && q.op !== 'search') throw invalidInput(`${field}.op`, 'unknown operation');
  if (typeof q.purpose !== 'string' || !['source', 'pattern', 'caller', 'config', 'test'].includes(q.purpose)) {
    throw invalidInput(`${field}.purpose`, 'unknown purpose');
  }
  if (typeof q.id !== 'string' || !q.id.length || q.id.length > 128 || ids.has(q.id)) {
    throw invalidInput(`${field}.id`, 'must be a unique nonempty string of at most 128 characters');
  }
  ids.add(q.id);
  if (q.op === 'read') {
    if (!normalizedPath(q.path)) throw invalidInput(`${field}.path`, 'must be an exact normalized representable path');
    return;
  }
  if (typeof q.literal !== 'string' || !q.literal.length || q.literal.length > limits.maxLiteralChars || /[\0\r\n]/.test(q.literal)) {
    throw invalidInput(`${field}.literal`, 'must be a bounded, nonempty single literal');
  }
  if (q.paths !== undefined) {
    if (!Array.isArray(q.paths) || q.paths.length > limits.maxScopePaths) throw invalidInput(`${field}.paths`, 'invalid scopes');
    for (let i = 0; i < q.paths.length; i++) {
      if (!normalizedPath(q.paths[i])) throw invalidInput(`${field}.paths[${i}]`, 'must be an exact normalized representable path');
    }
  }
}

const slotBudgetError = () => new Error('budget exhausted waiting for a git slot');
export class SourceSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('slot limit must be a positive safe integer');
  }
  private acquire(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.reject(slotBudgetError());
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const grant = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        reject(slotBudgetError());
      }, timeoutMs);
      this.waiting.push(grant);
    });
  }
  async run<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(timeoutMs);
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
export const SOURCE_SLOTS = new SourceSlots(4);
function withinSlot<T>(slots: SourceSlots, timeout: number, fn: (remaining: number) => Promise<T>): Promise<T> {
  const deadline = performance.now() + timeout;
  return slots.run(timeout, () => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw slotBudgetError();
    return fn(remaining);
  });
}
export function limitedRun(slots: SourceSlots, run: PlanPathGitRunner): PlanPathGitRunner {
  return (args, cwd, timeout, maxBuffer) => withinSlot(slots, timeout, remaining => run(args, cwd, remaining, maxBuffer));
}
export function limitedHead(slots: SourceSlots, head: GitHeadRunner): GitHeadRunner {
  return (args, cwd, timeout, maxBytes) => withinSlot(slots, timeout, remaining => head(args, cwd, remaining, maxBytes));
}
/** Pure validation: no filesystem, mutex, or process may run before this. */
export function validateSourceRequest(commit: unknown, queries: unknown, overrides?: Partial<SourceLimits>): void {
  const limits = sourceLimits(overrides);
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw invalidInput('commit', 'must be a full lowercase commit id');
  if (!Array.isArray(queries) || !queries.length || queries.length > limits.maxQueries) throw invalidInput('queries', 'invalid query count');
  const ids = new Set<string>();
  for (let index = 0; index < queries.length; index++) validateQuery(queries[index], index, ids, limits);
  if (pathspecs(queries).reduce((sum, p) => sum + p.length + 3, 0) > limits.maxPathspecChars) {
    throw invalidInput('pathspecs', 'lookup exceeds command-line budget');
  }
}

function copyQueries(queries: SourceQuery[]): SourceQuery[] {
  return queries.map(q => q.op === 'read' ? { ...q } : { ...q, paths: q.paths?.slice() });
}

export interface SourceOptions {
  limits?: Partial<SourceLimits>;
  run?: PlanPathGitRunner;
  head?: GitHeadRunner;
  slots?: SourceSlots;
}
type ProjectGit = Awaited<ReturnType<typeof openProjectGit>>;
interface TreeEntry { mode: string; oid: string; size?: number }
function parseTree(listing: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  if (listing && !listing.endsWith('\0')) throw new Error('git ls-tree: unparsable output');
  for (const record of listing ? listing.slice(0, -1).split('\0') : []) {
    const m = /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!m) throw new Error('git ls-tree: unparsable output');
    entries.set(m[5], { mode: m[1], oid: m[3], ...(m[4] === '-' ? {} : { size: Number(m[4]) }) });
  }
  return entries;
}
function classify(path: string, entries: Map<string, TreeEntry>, scope = false): { status: SourceItemStatus; reason: string } | undefined {
  for (const ancestor of prefixes(path).slice(0, -1)) {
    const mode = entries.get(ancestor)?.mode;
    if (mode === '120000') return { status: 'refused', reason: 'symlink-ancestor' };
    if (mode === '160000') return { status: 'refused', reason: 'submodule' };
    if (mode === '100644' || mode === '100755') return { status: 'missing', reason: 'not-in-manifest' };
  }
  const entry = entries.get(path);
  if (entry?.mode === '120000') return { status: 'refused', reason: 'symlink' };
  if (entry?.mode === '160000') return { status: 'refused', reason: 'submodule' };
  const tree = entry?.mode === '040000' || [...entries.keys()].some(p => p.startsWith(`${path}/`));
  if (tree) return scope ? undefined : { status: 'refused', reason: 'not-a-file' };
  if (!entry) return { status: 'missing', reason: scope ? 'scope-not-in-manifest' : 'not-in-manifest' };
}
function item(query: SourceQuery, status: SourceItemStatus, reason?: string): SourceItem {
  return { id: query.id, purpose: query.purpose, op: query.op, status, bytes: 0,
    ...(query.op === 'read' ? { path: query.path } : {}), ...(reason !== undefined ? { reason } : {}) };
}
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 500);
function result(commit: string, items: SourceItem[], limitations = ['committed-bytes-only']): RepositorySource {
  return { manifest: { commit }, items, complete: items.every(i => i.status === 'served'),
    limitations: [...new Set(limitations)].sort(), bytes: items.reduce((sum, i) => sum + i.bytes, 0) };
}
async function readBlob(git: ProjectGit, query: SourceQuery & { op: 'read' }, entry: TreeEntry, limits: SourceLimits): Promise<SourceItem> {
  const base = { ...item(query, 'served'), ...entry };
  try {
    const output = await git.head('cat-file', ['cat-file', 'blob', entry.oid], limits.maxFileBytes);
    if (!output.truncated && output.exitCode !== 0) return { ...base, status: 'unavailable', reason: `git cat-file: ${output.stderr}` };
    if (!output.truncated && output.stdout.length !== entry.size) return { ...base, status: 'unavailable', reason: 'size-mismatch' };
    if (output.stdout.includes(0)) return { ...base, status: 'refused', reason: 'binary' };
    let content: string;
    try {
      // Streaming drops ONLY an unfinished final sequence; all other invalid UTF-8 fails.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output.stdout, { stream: output.truncated });
    } catch { return { ...base, status: 'refused', reason: 'not-utf8' }; }
    const bytes = Buffer.byteLength(content);
    return output.truncated || (entry.size ?? 0) > limits.maxFileBytes
      ? { ...base, status: 'truncated', reason: 'file-byte-cap', content, bytes } : { ...base, content, bytes };
  } catch (error) { return { ...base, status: 'unavailable', reason: firstLine(error) }; }
}
function decodeMatch(commit: string, name: Buffer, line: Buffer, text: Buffer): SourceMatch | undefined {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const fullPath = decoder.decode(name);
    const number = decoder.decode(line);
    if (!fullPath.startsWith(`${commit}:`) || !/^[0-9]+$/.test(number) || !Number.isSafeInteger(Number(number)) || Number(number) < 1) return;
    const path = fullPath.slice(commit.length + 1);
    if (!normalizedPath(path)) return;
    return { path, line: Number(number), text: decoder.decode(text) };
  } catch { return undefined; }
}
function parseMatches(commit: string, bytes: Buffer, truncated: boolean, maxMatches: number) {
  const matches: SourceMatch[] = [];
  let reason = truncated ? 'search-byte-cap' : undefined;
  let offset = 0;
  while (offset < bytes.length) {
    const pathEnd = bytes.indexOf(0, offset);
    const lineEnd = pathEnd < 0 ? -1 : bytes.indexOf(0, pathEnd + 1);
    const textEnd = lineEnd < 0 ? -1 : bytes.indexOf(10, lineEnd + 1);
    if (textEnd < 0) { if (!truncated) reason = 'undecodable-match'; break; }
    const match = decodeMatch(commit, bytes.subarray(offset, pathEnd), bytes.subarray(pathEnd + 1, lineEnd), bytes.subarray(lineEnd + 1, textEnd));
    if (!match) reason = 'undecodable-match';
    else if (matches.length >= maxMatches) reason ??= 'match-cap';
    else matches.push(match);
    offset = textEnd + 1;
  }
  return { matches, reason };
}
async function searchTree(git: ProjectGit, commit: string, query: SourceQuery & { op: 'search' }, limits: SourceLimits): Promise<SourceItem> {
  try {
    const output = await git.head('grep', ['--literal-pathspecs', 'grep', '-F', '-z', '-n', '-I', '--no-color', '--full-name',
      '-e', query.literal, commit, '--', ...query.paths ?? []], limits.maxSearchBytes);
    if (!output.truncated && output.exitCode === 1) return { ...item(query, 'served'), matches: [] };
    if (!output.truncated && output.exitCode !== 0) return item(query, 'unavailable', `git grep: ${output.stderr}`);
    const { matches, reason } = parseMatches(commit, output.stdout, output.truncated, limits.maxMatches);
    return { ...item(query, reason ? 'truncated' : 'served', reason), matches,
      bytes: matches.reduce((sum, m) => sum + Buffer.byteLength(m.path) + Buffer.byteLength(m.text), 0) };
  } catch (error) { return item(query, 'unavailable', firstLine(error)); }
}
async function readItem(git: ProjectGit, commit: string, query: SourceQuery, entries: Map<string, TreeEntry>, limits: SourceLimits, limitations: string[]): Promise<SourceItem> {
  if (query.op === 'search') {
    for (const scope of query.paths ?? []) {
      const refusal = classify(scope, entries, true);
      if (refusal) return item(query, refusal.status, refusal.reason);
    }
    limitations.push('literal-search-only');
    return searchTree(git, commit, query, limits);
  }
  const refusal = classify(query.path, entries);
  if (refusal) return { ...item(query, refusal.status, refusal.reason), ...entries.get(query.path) };
  return readBlob(git, query, entries.get(query.path)!, limits);
}
function capTotal(items: SourceItem[], maxBytes: number): SourceItem[] {
  let bytes = 0;
  return items.map(value => {
    if (bytes + value.bytes <= maxBytes) { bytes += value.bytes; return value; }
    const { content: _content, matches: _matches, ...metadata } = value;
    return { ...metadata, status: 'omitted', reason: 'total-byte-cap', bytes: 0 };
  });
}
/** Immutable committed bytes only. Invoke outside the state mutex; never a filesystem fallback. */
export async function readRepositorySource(projectRoot: string, commit: string, queries: SourceQuery[], options: SourceOptions = {}): Promise<RepositorySource> {
  validateSourceRequest(commit, queries, options.limits);
  queries = copyQueries(queries);
  const limits = sourceLimits(options.limits);
  const slots = options.slots ?? SOURCE_SLOTS;
  const unavailable = (reason: string, limitations?: string[]) => result(commit, queries.map(q => item(q, 'unavailable', reason)), limitations);
  let git: ProjectGit;
  try {
    git = await openProjectGit(projectRoot, limitedRun(slots, options.run ?? runGit), limits.timeBudgetMs, limitedHead(slots, options.head ?? runGitHead));
  } catch (error) { return unavailable(`repository: ${firstLine(error)}`, ['committed-bytes-only', 'repository-unavailable']); }
  try {
    const resolved = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`])).trim();
    if (resolved !== commit) throw new Error('object did not resolve to the exact commit');
  } catch (error) { return unavailable(`manifest: ${firstLine(error)}`); }
  let entries: Map<string, TreeEntry>;
  try {
    entries = parseTree(await git('ls-tree', ['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', ...pathspecs(queries)], { maxBuffer: 1048576 }));
  } catch (error) { return unavailable(firstLine(error)); }
  const limitations = ['committed-bytes-only'];
  const items = await Promise.all(queries.map(q => readItem(git, commit, q, entries, limits, limitations)));
  return result(commit, capTotal(items, limits.maxTotalBytes), limitations);
}

export interface SourceRequest {
  taskId: string;
  commit: string;
  queries: SourceQuery[];
  expectedPlanRevision?: number;
}
function revision(state: StateManager, taskId: string): number {
  const task = state.getTask(taskId);
  if (!task) throw notFound('Task', taskId);
  const stored = task.planRevision;
  if (stored === undefined) return 0;
  if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0) {
    throw invalidInput('planRevision', `stored revision for task ${taskId} is not a non-negative safe integer`);
  }
  return stored;
}
/** Blocking-path service: capture under lock, analyze outside it, then revalidate. No state writes. */
export async function serveRepositorySource(state: StateManager, request: SourceRequest, options: SourceOptions = {}): Promise<RepositorySource & { taskId: string; planRevision: number }> {
  const { taskId, commit, expectedPlanRevision } = request;
  if (state.mutex.isHeld()) {
    throw new MoeError(MoeErrorCode.NOT_ALLOWED,
      'repository source analysis must run outside the state mutex; call it from a blocking: true path (see submit_plan)',
      { taskId }, 'SOURCE_ANALYSIS_UNDER_MUTEX');
  }
  validateSourceRequest(commit, request.queries, options.limits);
  const queries = copyQueries(request.queries);
  options = { ...options, limits: sourceLimits(options.limits) };
  if (expectedPlanRevision !== undefined && (!Number.isSafeInteger(expectedPlanRevision) || expectedPlanRevision < 0)) {
    throw invalidInput('expectedPlanRevision', 'must be a non-negative safe integer');
  }
  const captured = await state.runExclusive(async () => {
    const current = revision(state, taskId);
    if (expectedPlanRevision !== undefined && expectedPlanRevision !== current) {
      throw new MoeError(MoeErrorCode.STATE_CONFLICT, 'source request does not match the current plan revision',
        { taskId, expectedPlanRevision, currentPlanRevision: current }, 'SOURCE_REVISION_MISMATCH');
    }
    return current;
  });
  const result = await readRepositorySource(state.projectPath, commit, queries, options);
  return state.runExclusive(async () => {
    const current = revision(state, taskId);
    if (current !== captured) {
      throw new MoeError(MoeErrorCode.STATE_CONFLICT,
        `plan revision changed from ${captured} to ${current} during source analysis; nothing was served`,
        { taskId, servedForRevision: captured, currentPlanRevision: current }, 'SOURCE_REVISION_CHANGED');
    }
    return { taskId, planRevision: captured, ...result };
  });
}

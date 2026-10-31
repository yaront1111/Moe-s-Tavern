// Optional semantic source (CQ-C03): read-only Serena queries over ONE immutable commit, materialized privately (C03a) and served
// through the read-only MCP client (C03b) with a private SERENA_HOME, an allowlisted env and three read tools. Any absent, failed,
// mismatched or slow analyzer leaves its items 'unavailable' and inconclusive with a C02 literal fallback at the same commit: never
// a claim that a symbol is absent. Invoke outside the state mutex. Only caller-shape errors throw; nothing persists after the call.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invalidInput } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { MATERIALIZE_LIMITS, materializeCommit } from './commitMaterializer.js';
import { openAnalyzerSession, type AnalyzerServerInfo, type AnalyzerSession } from './mcpStdioClient.js';
import { readRepositorySource, validateSourceRequest, type RepositorySource, type SourceItem, type SourceItemStatus,
  type SourcePurpose, type SourceQuery } from './repositorySource.js';

export type SemanticQuery = { id: string; purpose: SourcePurpose } & (
  { op: 'symbol'; name: string; path?: string } | { op: 'references'; name: string; path: string } | { op: 'overview'; path: string });
/** bytes counts the content or fallback carried; inconclusive says nothing is known; fallback is literal, never semantic, evidence. */
export interface SemanticItem {
  id: string; purpose: SourcePurpose; op: SemanticQuery['op']; status: SourceItemStatus; reason?: string; tool?: string;
  content?: string; bytes: number; inconclusive?: true; fallback?: SourceItem;
}
export interface SemanticSource {
  manifest: { commit: string; analyzer: AnalyzerServerInfo | null };
  items: SemanticItem[]; complete: boolean; limitations: string[]; bytes: number;
}
/** The ONLY tools the analyzer may be asked to run: no write, memory or shell tool. */
export const SEMANTIC_TOOLS = Object.freeze({ symbol: 'find_symbol', references: 'find_referencing_symbols', overview: 'get_symbols_overview' } as const);
export const SEMANTIC_LIMITS = Object.freeze({ maxQueries: 16, timeBudgetMs: 60_000, maxResponseBytes: 65_536, maxTotalBytes: 262_144 });
export type SemanticLimits = { [K in keyof typeof SEMANTIC_LIMITS]: number };
/** serenaPath (absolute) beats MOE_SERENA_PATH and ~/.local/bin/serena; a launcher runs `command ...prefixArgs start-mcp-server`. */
export interface SemanticOptions {
  limits?: Partial<SemanticLimits>; serenaPath?: string; launcher?: { command: string; prefixArgs: readonly string[] };
  materialize?: typeof materializeCommit; open?: typeof openAnalyzerSession; fallback?: typeof readRepositorySource;
}
const CEILINGS: SemanticLimits = { ...SEMANTIC_LIMITS, timeBudgetMs: 120_000 };
const ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const NAME = /^[^\0\r\n]{1,200}$/;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
type Outcome = SemanticItem | string; // an answered item, or the cause it was not answered
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
function semanticLimits(raw: unknown = {}): SemanticLimits {
  if (!isObject(raw)) throw invalidInput('limits', 'must be an object');
  const limits: Json = { ...SEMANTIC_LIMITS, ...raw };
  for (const [key, value] of Object.entries(limits)) {
    const ceiling = Object.hasOwn(CEILINGS, key) ? CEILINGS[key as keyof SemanticLimits] : 0;
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > ceiling) throw invalidInput(`limits.${key}`, `must be a positive integer at most ${ceiling}`);
  }
  return limits as SemanticLimits;
}
const literalOf = (name: string) => name.split('/').pop()!.replace(/\[\d+\]$/, '');
/** The C02 query a fallback runs. References search the whole commit: their definition file would hide every other caller. */
function toSource(q: SemanticQuery, validation = false): SourceQuery {
  const { id, purpose } = q;
  if (q.op === 'overview') return { id, purpose, op: 'read', path: q.path };
  const scope = q.op === 'symbol' || validation ? q.path : undefined;
  return { id, purpose, op: 'search', literal: literalOf(q.name), ...(scope === undefined ? {} : { paths: [scope] }) };
}
/** Pure validation before any IO; C02's rules check the commit, ids, purposes, paths and each derived literal. */
export function validateSemanticRequest(commit: unknown, queries: unknown, overrides?: Partial<SemanticLimits>): void {
  const { maxQueries } = semanticLimits(overrides);
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > maxQueries) throw invalidInput('queries', `must hold 1 to ${maxQueries} queries`);
  queries.forEach((q: unknown, index) => {
    const field = `queries[${index}]`;
    if (!isObject(q) || !Object.hasOwn(SEMANTIC_TOOLS, q.op as string)) throw invalidInput(`${field}.op`, 'unknown operation');
    const named = q.op === 'overview' || (typeof q.name === 'string' && NAME.test(q.name) && literalOf(q.name) !== '');
    if (!named) throw invalidInput(`${field}.name`, 'must be 1 to 200 characters without NUL or line breaks, ending in a name');
    if (typeof q.path !== 'string' && !(q.op === 'symbol' && q.path === undefined)) throw invalidInput(`${field}.path`, 'must be a path string');
  });
  validateSourceRequest(commit, (queries as SemanticQuery[]).map(q => toSource(q, true)));
}
async function resolveAnalyzer(options: SemanticOptions): Promise<string | null> {
  const command: unknown = options.launcher?.command ?? options.serenaPath ?? process.env.MOE_SERENA_PATH
    ?? path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'serena.exe' : 'serena');
  // C03b refuses a relative command: on Windows it would resolve against the materialized repository first.
  if (typeof command !== 'string' || command.includes('\0') || !path.isAbsolute(command)
    || (process.platform === 'win32' && !WINDOWS_ABSOLUTE.test(command))) return null;
  try {
    if (process.platform !== 'win32') await fs.access(command, fs.constants.X_OK);
    return (await fs.stat(command)).isFile() ? command : null;
  } catch { return null; }
}
/** A throwaway SERENA_HOME: Serena registers every project and keeps memories and logs there. Only the binary cache is shared. */
async function privateHome(): Promise<{ dir: string; linked: boolean }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moe-serena-home-'));
  const cache = path.join(process.env.SERENA_HOME?.trim() || path.join(os.homedir(), '.serena'), 'language_servers');
  // Without a shared cache, Serena downloads into the private home.
  const link = (stat: { isDirectory(): boolean }) => stat.isDirectory() && fs.symlink(cache, path.join(dir, 'language_servers'), 'junction').then(() => true);
  return { dir, linked: await fs.stat(cache).then(link).catch(() => false) };
}
async function removeHome(home: { dir: string; linked: boolean }): Promise<void> {
  // Unlink the cache link first, so the recursive removal can never descend into the real cache.
  if (home.linked) await fs.unlink(path.join(home.dir, 'language_servers'));
  await fs.rm(home.dir, { recursive: true, force: true });
}
const analyzerEnv = (home: string): Record<string, string> => ({ ...Object.fromEntries(ENV_KEYS.flatMap(key => {
  const value = process.env[key];
  return value === undefined || value.includes('\0') ? [] : [[key, value]];
})), SERENA_HOME: home });
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(resolve, Math.max(ms, 0), null); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/** Arguments in a fixed key order (CQ-C04 keys cached answers by them), or null when the schema lacks a parameter we send. */
function argsFor(q: SemanticQuery, schema: unknown): Record<string, string> | null {
  const props = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const has = (key: string) => Object.hasOwn(props, key);
  if (!has('relative_path')) return null;
  if (q.op === 'overview') return { relative_path: q.path };
  const key = (q.op === 'symbol' ? ['name_path_pattern', 'name_path'] : ['name_path']).find(has);
  return key === undefined ? null : { [key]: q.name, relative_path: q.path ?? '' };
}
async function ask(session: AnalyzerSession, q: SemanticQuery, remaining: number): Promise<Outcome> {
  const tool = SEMANTIC_TOOLS[q.op];
  const listed = session.tools.find(t => t.name === tool);
  if (listed === undefined) return `capability-missing:${tool}`;
  const args = argsFor(q, listed.inputSchema);
  if (args === null) return `capability-mismatch:${tool}`;
  const answer = remaining > 0 ? await withDeadline(session.call(tool, args), remaining) : null;
  if (answer === null) return 'time-budget';
  if (!answer.ok) return `tool-failed:${answer.reason}`;
  // An empty answer is served as returned, never rewritten into a claim of absence.
  return { id: q.id, purpose: q.purpose, op: q.op, status: answer.truncated ? 'truncated' : 'served',
    ...(answer.truncated ? { reason: 'response-byte-cap' } : {}), tool, content: answer.text, bytes: Buffer.byteLength(answer.text) };
}
interface Run { projectRoot: string; commit: string; queries: SemanticQuery[]; limits: SemanticLimits; options: SemanticOptions;
  remaining: () => number; outcomes: (Outcome | undefined)[]; cleanup: (() => Promise<void>)[]; analyzer: AnalyzerServerInfo | null }
async function analyze(run: Run): Promise<void> {
  const { options, outcomes } = run;
  const rest = (cause: string) => { for (let i = 0; i < run.queries.length; i++) outcomes[i] ??= cause; };
  const command = await resolveAnalyzer(options);
  if (command === null) return rest('analyzer-absent');
  const timeBudgetMs = Math.max(1, Math.min(run.remaining(), MATERIALIZE_LIMITS.timeBudgetMs));
  const materialized = await (options.materialize ?? materializeCommit)(run.projectRoot, run.commit, { limits: { timeBudgetMs } });
  if (!materialized.ok) return rest(`materialize-failed:${materialized.reason}`);
  const { dir } = materialized.materialized;
  run.cleanup.push(() => materialized.materialized.dispose());
  // Committed Serena config is writer-controlled: its ls_additional_workspace_folders is not trust-gated and reaches past the snapshot.
  await fs.rm(path.join(dir, '.serena'), { recursive: true, force: true });
  const home = await privateHome().catch(() => null);
  if (home === null) return rest('home-failed');
  run.cleanup.push(() => removeHome(home));
  const args = [...options.launcher?.prefixArgs ?? [], 'start-mcp-server', '--context', 'agent', '--project', dir,
    '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false', '--open-web-dashboard', 'false'];
  const left = run.remaining();
  const pending = left > 0 ? (options.open ?? openAnalyzerSession)({ command, args, cwd: dir, env: analyzerEnv(home.dir), timeoutMs: left,
    maxResponseBytes: run.limits.maxResponseBytes }, Object.values(SEMANTIC_TOOLS)) : null;
  const opened = pending && await withDeadline(pending, left);
  if (opened === null) {
    void pending?.then(late => (late.ok ? late.session.close() : undefined)).catch(() => undefined); // a late session is still closed
    return rest('time-budget');
  }
  if (!opened.ok) return rest(`analyzer-failed:${opened.reason}`);
  const { session } = opened;
  run.cleanup.push(() => session.close());
  run.analyzer = { name: session.server.name, version: session.server.version, protocolVersion: session.server.protocolVersion };
  // A spent budget stays spent: timers can fire a millisecond early, so later queries are never sent on a sliver.
  for (let i = 0; i < run.queries.length; i++) outcomes[i] = outcomes[i - 1] === 'time-budget' ? 'time-budget' : await ask(session, run.queries[i], run.remaining());
}
function capTotal(items: SemanticItem[], maxBytes: number): SemanticItem[] {
  let bytes = 0;
  return items.map(item => {
    if (bytes + item.bytes <= maxBytes) { bytes += item.bytes; return item; }
    const { content: _content, fallback: _fallback, ...metadata } = item;
    return { ...metadata, status: 'omitted', reason: 'total-byte-cap', bytes: 0 };
  });
}
/** Semantic answers at one immutable commit, each failure explicit and backed by C02 literal evidence at the same commit. */
export async function readSemanticSource(projectRoot: string, commit: string, queries: SemanticQuery[], options: SemanticOptions = {}): Promise<SemanticSource> {
  validateSemanticRequest(commit, queries, options.limits);
  const limits = semanticLimits(options.limits);
  const deadline = performance.now() + limits.timeBudgetMs;
  const run: Run = { projectRoot, commit, queries: queries.map(q => ({ ...q })), limits, options,
    remaining: () => Math.floor(deadline - performance.now()), outcomes: [], cleanup: [], analyzer: null };
  try {
    await analyze(run);
  } catch (error) {
    logger.warn({ error }, 'Semantic analyzer failed unexpectedly');
    run.outcomes = run.queries.map((_, i) => run.outcomes[i] ?? 'internal-error');
  } finally {
    // Session first, then the private home and the materialized commit; a cleanup error never replaces the result.
    for (const step of run.cleanup.reverse()) await Promise.resolve().then(step).catch(error => logger.warn({ error }, 'Semantic source cleanup failed'));
  }
  const failed = run.queries.filter((_, i) => typeof run.outcomes[i] === 'string');
  const limitations = new Set(['committed-bytes-only']);
  // Measured on Serena 1.6.2: without a tsconfig, cross-file references come back '{}'. An empty answer never proves absence.
  if (run.analyzer !== null) limitations.add('semantic-empty-not-absence');
  let fallback: RepositorySource | null = null;
  if (failed.length > 0) {
    ['semantic-unavailable', 'literal-search-fallback'].forEach(l => limitations.add(l));
    fallback = await Promise.resolve().then(() => (options.fallback ?? readRepositorySource)(projectRoot, commit, failed.map(q => toSource(q))))
      .catch(error => { logger.warn({ error }, 'Semantic fallback failed unexpectedly'); return null; });
    (fallback?.limitations ?? ['fallback-unavailable']).forEach(l => limitations.add(l));
  }
  const items = capTotal(run.queries.map(({ id, purpose, op }, i): SemanticItem => {
    const outcome = run.outcomes[i]!, carried = fallback?.items.find(item => item.id === id);
    return typeof outcome !== 'string' ? outcome : { id, purpose, op, status: 'unavailable', reason: `semantic-unavailable:${outcome}`,
      bytes: carried?.bytes ?? 0, inconclusive: true, ...(carried ? { fallback: carried } : {}) };
  }), limits.maxTotalBytes);
  return { manifest: { commit, analyzer: run.analyzer }, items, complete: items.every(i => i.status === 'served'),
    limitations: [...limitations].sort(), bytes: items.reduce((sum, i) => sum + i.bytes, 0) };
}

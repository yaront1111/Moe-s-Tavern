import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MoeErrorCode } from '../util/errors.js';
import type { MaterializedCommit, MaterializeResult } from './commitMaterializer.js';
import { openAnalyzerSession, type AnalyzerCallResult, type AnalyzerLaunch, type AnalyzerOpenResult, type AnalyzerTool } from './mcpStdioClient.js';
import { readRepositorySource, type SourceQuery } from './repositorySource.js';
import { readSemanticSource, SEMANTIC_TOOLS, type SemanticOptions, type SemanticQuery, type SemanticSource } from './semanticSource.js';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
const scratch = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir; };
const listing = (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(n => n.split(path.sep).join('/')).sort();
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

// A temp repository driven by a GIT_*-scrubbed git: the commit says helperOld, the dirty worktree then says helperNew.
let root = '', commit = '', git: (...args: string[]) => string;
beforeAll(() => {
  root = scratch('moe-sem-repo-');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: posix ? '/dev/null' : 'NUL', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
  git = (...args) => execFileSync('git', args, { cwd: root, env }).toString('utf8').trim();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/util.ts'), 'export function helperOld() {}\n');
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'c1'); commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'src/util.ts'), 'export function helperNew() {}\n');
});

const props = (...keys: string[]) => ({ type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])) });
const TOOLS: AnalyzerTool[] = [{ name: 'find_symbol', inputSchema: props('name_path_pattern', 'relative_path', 'depth') },
  { name: 'find_referencing_symbols', inputSchema: props('name_path', 'relative_path') }, { name: 'get_symbols_overview', inputSchema: props('relative_path') }];
const SERVER = { name: 'serena', version: '1.6.2', protocolVersion: '2025-06-18' };
const sym = (id = 's', name = 'helperOld', p?: string): SemanticQuery => ({ id, purpose: 'source', op: 'symbol', name, ...(p ? { path: p } : {}) });
const refs: SemanticQuery = { id: 'r', purpose: 'caller', op: 'references', name: 'Mod/helperOld', path: 'src/util.ts' };
const view: SemanticQuery = { id: 'o', purpose: 'source', op: 'overview', path: 'src/util.ts' };
const ALL = [sym(), refs, view];
const planted = () => { const dir = scratch('moe-sem-mat-'); fs.mkdirSync(path.join(dir, '.serena')); fs.writeFileSync(path.join(dir, '.serena/project.yml'), `ls_additional_workspace_folders: ['${root}']\n`); return dir; };
interface Over { materialize?: () => MaterializeResult; open?: AnalyzerOpenResult; tools?: AnalyzerTool[];
  answer?: (tool: string) => AnalyzerCallResult | Promise<AnalyzerCallResult>; fallbackThrows?: boolean }
async function run(queries: SemanticQuery[], over: Over = {}, extra: SemanticOptions = {}) {
  const log = { materialize: 0, dispose: 0, close: 0, open: [] as AnalyzerLaunch[], allowed: [] as (readonly string[])[],
    calls: [] as [string, unknown][], fallback: [] as SourceQuery[][], config: [] as boolean[] };
  const options: SemanticOptions = {
    serenaPath: process.execPath,
    materialize: async () => (log.materialize++, over.materialize?.())
      ?? { ok: true, materialized: { dir: planted(), dispose: async () => { log.dispose++; } } as unknown as MaterializedCommit },
    open: async (launch, allowed) => {
      log.open.push(launch); log.allowed.push(allowed); log.config.push(fs.existsSync(path.join(launch.cwd, '.serena')));
      return over.open ?? { ok: true, session: { server: SERVER, tools: over.tools ?? TOOLS, close: async () => { log.close++; },
        call: async (tool, args) => { log.calls.push([tool, args]); return over.answer?.(tool) ?? { ok: true, text: `${tool}:answer`, truncated: false }; } } };
    },
    fallback: async (...args) => { log.fallback.push(args[2]); if (over.fallbackThrows) throw new Error('boom'); return readRepositorySource(...args); },
    ...extra,
  };
  return { log, result: await readSemanticSource(root, commit, queries, options) };
}
const rows = (r: SemanticSource) => r.items.map(i => [i.id, i.status, i.reason ?? null, i.inconclusive ?? false, i.fallback?.status ?? null]);
const down = (cause: string, ids = ['s', 'r', 'o']) => ids.map(id => [id, 'unavailable', `semantic-unavailable:${cause}`, true, 'served']);
const served = (...ids: string[]) => ids.map(id => [id, 'served', null, false, null]);

describe('readSemanticSource', () => {
  const C = 'a'.repeat(40);
  it.each<[string, string, unknown, SemanticOptions['limits']?]>([
    ['commit', 'HEAD', [sym()]], ['queries', C, []], ['queries', C, Array.from({ length: 17 }, (_, i) => sym(String(i)))],
    ['queries[1].id', C, [sym(), sym()]], ['queries[0].op', C, [{ ...sym(), op: 'write' }]], ['queries[0].path', C, [{ ...refs, path: undefined }]],
    ['queries[0].paths[0]', C, [sym('s', 'x', '../a')]], ['queries[0].path', C, [{ ...view, path: 'a/../b' }]],
    ['queries[0].name', C, [sym('s', 'a\0b')]], ['queries[0].name', C, [sym('s', 'Mod/')]], ['queries[0].name', C, [sym('s', 'x'.repeat(201))]],
    ['limits.timeBudgetMs', C, [sym()], { timeBudgetMs: 120_001 }], ['limits.maxQueries', C, [sym()], { maxQueries: 0 }],
    ['limits.bogus', C, [sym()], { bogus: 1 } as never],
  ])('T1/T12 refuses %s before any IO %#', async (field, c, queries, limits) => {
    let calls = 0; const seam = async () => { calls++; throw new Error('seam called'); };
    await expect(readSemanticSource(root, c, queries as SemanticQuery[], { limits, materialize: seam, open: seam, fallback: seam }))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT, context: { field } });
    expect(calls).toBe(0);
  });
  it.each<[string, () => string]>([['missing', () => path.join(root, 'nope')], ['relative', () => 'serena'], ['a directory', () => root],
    ...(posix ? [['not executable', () => path.join(root, 'src/util.ts')] as [string, () => string]] : [])])(
    'T2 a %s analyzer gives explicit literal fallbacks at the commit, never absence', async (_name, serenaPath) => {
    const { log, result } = await run(ALL, {}, { serenaPath: serenaPath() });
    expect(rows(result)).toEqual(down('analyzer-absent'));
    expect([result.items[0].fallback?.matches, result.items[1].fallback?.matches]).toEqual(Array(2).fill([{ path: 'src/util.ts', line: 1, text: 'export function helperOld() {}' }]));
    expect([result.items[2].fallback?.content, result.manifest, result.complete, result.limitations, log.materialize]).toEqual(['export function helperOld() {}\n',
      { commit, analyzer: null }, false, ['committed-bytes-only', 'literal-search-fallback', 'literal-search-only', 'semantic-unavailable'], 0]);
    // A references fallback searches the whole commit: its definition file would hide every other caller.
    expect(log.fallback).toEqual([[{ id: 's', purpose: 'source', op: 'search', literal: 'helperOld' },
      { id: 'r', purpose: 'caller', op: 'search', literal: 'helperOld' }, { id: 'o', purpose: 'source', op: 'read', path: 'src/util.ts' }]]);
  });
  it.each<[string, Over, string, number, number, number]>([
    ['materialize fails', { materialize: () => ({ ok: false, reason: 'boom' }) }, 'materialize-failed:boom', 0, 0, 0],
    ['materialize throws', { materialize: () => { throw new Error('boom'); } }, 'internal-error', 0, 0, 0],
    ['open fails', { open: { ok: false, reason: 'exited:1' } }, 'analyzer-failed:exited:1', 1, 1, 0],
    ['a call throws', { answer: () => { throw new Error('boom'); } }, 'internal-error', 1, 1, 1],
  ])('T3/T4/T10 %s: explicit cause, fallback, and each cleanup exactly once', async (_name, over, cause, opens, disposes, closes) => {
    const { log, result } = await run(ALL, over);
    expect([rows(result), log.open.length, log.dispose, log.close]).toEqual([down(cause), opens, disposes, closes]);
    for (const launch of log.open) expect(fs.existsSync(launch.env.SERENA_HOME)).toBe(false);
  });
  it('T5 a missing tool sends only its items to the fallback', async () => {
    const { log, result } = await run(ALL, { tools: TOOLS.filter(t => t.name !== 'find_referencing_symbols') });
    expect(rows(result)).toEqual([...served('s'), ...down('capability-missing:find_referencing_symbols', ['r']), ...served('o')]);
    expect([log.fallback.length, log.fallback[0].map(q => q.id), log.calls.map(c => c[0])]).toEqual([1, ['r'], ['find_symbol', 'get_symbols_overview']]);
  });
  it.each<[string, string[], unknown[]]>([['no name parameter', ['relative_path'], []], ['no relative_path', ['name_path_pattern'], []],
    ['an old name_path schema', ['name_path', 'relative_path'], [['find_symbol', { name_path: 'helperOld', relative_path: '' }]]]])(
    'T6 checks the find_symbol schema: %s', async (_name, keys, calls) => {
    const { log, result } = await run([sym()], { tools: [{ name: 'find_symbol', inputSchema: props(...keys) }] });
    expect([rows(result), log.calls]).toEqual([calls.length ? served('s') : down('capability-mismatch:find_symbol', ['s']), calls]);
  });
  it('T7 a failed call fails only its own item', async () => {
    const { result } = await run(ALL, { answer: tool => (tool === 'find_symbol' ? { ok: false, reason: 'timeout' } : { ok: true, text: 'x', truncated: false }) });
    expect(rows(result)).toEqual([...down('tool-failed:timeout', ['s']), ...served('r', 'o')]);
  });
  it('T8/T10 serves bounded answers through exactly the allowlist, without committed Serena config, then cleans up once', async () => {
    const { log, result } = await run(ALL);
    expect([rows(result), result.items.map(i => [i.tool, i.content, i.bytes]), result.bytes, result.complete, result.limitations, result.manifest])
      .toEqual([served('s', 'r', 'o'), Object.values(SEMANTIC_TOOLS).map(t => [t, `${t}:answer`, t.length + 7]), 76, true, ['committed-bytes-only', 'semantic-empty-not-absence'], { commit, analyzer: SERVER }]);
    expect(JSON.stringify(log.calls)).toBe(JSON.stringify([['find_symbol', { name_path_pattern: 'helperOld', relative_path: '' }],
      ['find_referencing_symbols', { name_path: 'Mod/helperOld', relative_path: 'src/util.ts' }], ['get_symbols_overview', { relative_path: 'src/util.ts' }]]));
    const [launch] = log.open;
    expect([log.allowed, launch.command, launch.args.slice(0, 5), launch.maxResponseBytes, log.fallback, log.dispose, log.close])
      .toEqual([[['find_symbol', 'find_referencing_symbols', 'get_symbols_overview']], process.execPath, ['start-mcp-server', '--context', 'agent', '--project', launch.cwd], 65536, [], 1, 1]);
    expect([launch.timeoutMs > 0 && launch.timeoutMs <= 60_000, fs.existsSync(launch.env.SERENA_HOME), log.config]).toEqual([true, false, [false]]);
  });
  it('T8 marks truncation and caps the total, stripping what does not fit', async () => {
    const { result } = await run(ALL, { answer: tool => ({ ok: true, text: tool, truncated: tool === 'find_symbol' }) }, { limits: { maxTotalBytes: 32 } });
    expect([rows(result), result.items[1].content, result.bytes, result.complete])
      .toEqual([[['s', 'truncated', 'response-byte-cap', false, null], ['r', 'omitted', 'total-byte-cap', false, null], ...served('o')], undefined, 31, false]);
  });
  it('T9 an empty answer is served as returned, never rewritten into absence', async () => {
    const { log, result } = await run([sym()], { answer: () => ({ ok: true, text: '[]', truncated: false }) });
    expect([result.items, log.fallback, result.limitations]).toEqual([[{ id: 's', purpose: 'source', op: 'symbol', status: 'served', tool: 'find_symbol', content: '[]', bytes: 2 }],
      [], ['committed-bytes-only', 'semantic-empty-not-absence']]);
  });
  it('T11 the analyzer env holds only allowlisted keys and a private SERENA_HOME', async () => {
    for (const [key, value] of [['MOE_WORKER_ID', 'w'], ['GIT_DIR', '/x'], ['ANTHROPIC_API_KEY', 'k'], ['SERENA_HOME', '']]) vi.stubEnv(key, value);
    const { log } = await run([sym()]);
    const { env } = log.open[0], allowed = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SERENA_HOME'];
    expect([Object.keys(env).filter(key => !allowed.includes(key)), env.SERENA_HOME.startsWith(path.join(os.tmpdir(), 'moe-serena-home-'))]).toEqual([[], true]);
  });
  it('T12 an exhausted budget fails the remaining items explicitly, and a failed fallback is a limitation', async () => {
    const { log, result } = await run(ALL, { answer: tool => (tool === 'find_symbol' ? { ok: true, text: 'x', truncated: false } : new Promise(() => {})) }, { limits: { timeBudgetMs: 300 } });
    expect([rows(result), log.calls.length, log.close]).toEqual([[...served('s'), ...down('time-budget', ['r', 'o'])], 2, 1]);
    const failed = await run([sym()], { open: { ok: false, reason: 'closed' }, fallbackThrows: true });
    expect([rows(failed.result), failed.result.limitations]).toEqual([[['s', 'unavailable', 'semantic-unavailable:analyzer-failed:closed', true, null]],
      ['committed-bytes-only', 'fallback-unavailable', 'literal-search-fallback', 'semantic-unavailable']]);
  });
});

// A stdio MCP server shaped like Serena 1.6.2: find_symbol greps <--project>/<relative_path>, and it mimics Serena's side effects.
const FAKE = `
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [pids, ...argv] = process.argv.slice(2), project = argv[argv.indexOf('--project') + 1];
const linked = fs.existsSync(path.join(process.env.SERENA_HOME, 'language_servers', 'static', 'keep.txt'));
fs.writeFileSync(pids, [process.pid, cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid, linked].join(' '));
fs.mkdirSync(path.join(project, '.serena')); fs.writeFileSync(path.join(project, '.serena', 'cache.txt'), 'x');
fs.writeFileSync(path.join(process.env.SERENA_HOME, 'serena_config.yml'), 'projects: [' + JSON.stringify(project) + ']');
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), schema = { type: 'object', properties: { name_path_pattern: {}, relative_path: {} } };
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'serena', version: '1.6.2.dev0' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'find_symbol', inputSchema: schema }] } });
  const { name_path_pattern: name, relative_path: file } = m.method === 'tools/call' ? m.params.arguments : {};
  if (file) send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(fs.readFileSync(path.join(project, file), 'utf8').split('\\n').filter(l => l.includes(name))) }] } });
}).on('close', () => process.exit(0));
`;
async function gone(pid: number): Promise<boolean> {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 25))) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
  }
  return false;
}

describe('readSemanticSource with the real materializer and MCP client', () => {
  it('analyzes only the immutable commit and leaves nothing behind', async () => {
    const tools = scratch('moe-sem-fake-'), home = scratch('moe-sem-home-'), script = path.join(tools, 'serena.cjs'), pids = path.join(tools, 'pids');
    fs.writeFileSync(script, FAKE);
    // A fake HOME whose real language-server cache must survive while nothing else is written to it.
    fs.mkdirSync(path.join(home, '.serena', 'language_servers', 'static'), { recursive: true });
    fs.writeFileSync(path.join(home, '.serena', 'language_servers', 'static', 'keep.txt'), 'cache');
    for (const [key, value] of [['HOME', home], ['USERPROFILE', home], ['SERENA_HOME', '']]) vi.stubEnv(key, value);
    const before = () => [fs.readFileSync(path.join(root, '.git', 'index')), git('--no-optional-locks', 'status', '--porcelain'), listing(root)];
    const snapshot = before();
    let seen: AnalyzerLaunch | undefined;
    const result = await readSemanticSource(root, commit, [sym('a', 'helperOld', 'src/util.ts'), sym('b', 'helperNew', 'src/util.ts')], {
      launcher: { command: process.execPath, prefixArgs: [script, pids] }, open: (launch, allowed) => { seen = launch; return openAnalyzerSession(launch, allowed); } });
    expect([rows(result), result.items.map(i => i.content), result.manifest.analyzer?.version])
      .toEqual([served('a', 'b'), ['["export function helperOld() {}"]', '[]'], '1.6.2.dev0']);
    expect(before()).toEqual(snapshot);
    expect([fs.existsSync(path.join(root, '.serena')), fs.existsSync(seen!.cwd), fs.existsSync(seen!.env.SERENA_HOME)]).toEqual([false, false, false]);
    expect(listing(home)).toEqual(['.serena', '.serena/language_servers', '.serena/language_servers/static', '.serena/language_servers/static/keep.txt']);
    const [pid, grandchild, linked] = fs.readFileSync(pids, 'utf8').split(' '); // the analyzer saw the shared language-server cache
    expect([await gone(Number(pid)), await gone(Number(grandchild)), linked]).toEqual([true, true, 'true']);
  });
});

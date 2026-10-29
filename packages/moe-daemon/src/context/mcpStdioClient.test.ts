import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MCP_FRAME_LIMIT_BYTES, openAnalyzerSession, type AnalyzerLaunch, type AnalyzerSession } from './mcpStdioClient.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const SCHEMA = { type: 'object', properties: { name_path: { type: 'string' } }, required: ['name_path'] };
const ALLOWED = ['find_symbol', 'get_symbols_overview', 'missing_tool'];
const ENV: Record<string, string> = { MOE_FAKE: '1', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) };
// libuv copies these into any Windows env block that lacks them (uv_spawn make_program_env), so exactness is POSIX-only.
const LIBUV_WINDOWS_ENV = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const AB = { ok: true, text: 'AB', truncated: false };

// Fake stdio MCP server, argv [startMode, logFile]: logs every received line and writes its pid (and a grandchild's) beside the log.
// 'crlf' also writes a blank CRLF line before each reply, which only a stripped CR lets the client skip.
const FAKE = `
const fs = require('fs'), cp = require('child_process');
const [mode, log] = process.argv.slice(2);
const send = m => process.stdout.write((mode === 'crlf' ? '\\r\\n' : '') + JSON.stringify({ jsonrpc: '2.0', ...m }) + (mode === 'crlf' ? '\\r\\n' : '\\n'));
const text = (id, t) => send({ id, result: { content: [{ type: 'text', text: t }] } });
const tool = (name, inputSchema = { type: 'object' }) => ({ name, description: name, inputSchema });
fs.writeFileSync(log + '.pid', String(process.pid));
if (mode === 'die') process.exit(0);
if (mode === 'grandchild' || mode === 'orphan') fs.writeFileSync(log + '.gc', String(cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid));
const replies = new Set(); let held;
const calls = {
  plain: m => send({ id: m.id, result: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] } }),
  env: m => text(m.id, JSON.stringify(process.env)), big: m => text(m.id, '\\u00e9'.repeat(4)),
  rpc: m => send({ id: m.id, error: { code: -32602, message: 'bad params' } }), garbage: () => process.stdout.write('not json\\n'),
  badid: m => text(m.id + 1000, 'x'), huge: () => process.stdout.write('x'.repeat(${MCP_FRAME_LIMIT_BYTES + 1})),
  hang: () => {}, crash: () => process.exit(3),
  deepid: () => process.stdout.write('{"jsonrpc":"2.0","method":"ping","id":' + '['.repeat(200000) + ']'.repeat(200000) + '}\\n'),
  flood: () => { process.stdin.pause(); for (let i = 0; i < 40000; i++) send({ id: 'f' + i + 'x'.repeat(200), method: 'ping' }); },
  request: m => { held = m; send({ method: 'notifications/message', params: { level: 'info', data: 'hi' } }); send({ id: 's1', method: 'sampling/createMessage', params: {} }); send({ id: 's2', method: 'ping' }); },
};
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(log, line + '\\n');
  const m = JSON.parse(line);
  if (m.method === undefined) { replies.add(m.id); if (replies.size === 2) text(held.id, 'ok'); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: m.params.cursor === 'p2' ? { tools: [tool('get_symbols_overview')] }
    : { tools: [tool('find_symbol', ${JSON.stringify(SCHEMA)}), tool('write_memory')], nextCursor: 'p2' } });
  if (m.method !== 'tools/call') return;
  if (m.params.name === 'get_symbols_overview') send({ id: m.id, result: { content: [{ type: 'text', text: 'x' }], isError: true } });
  else calls[m.params.arguments.mode ?? 'plain'](m);
}).on('close', () => { if (mode !== 'grandchild') process.exit(0); });
`;

let dir = '';
let seq = 0;
const sessions: AnalyzerSession[] = [];
function launch(startMode = 'plain', over: Partial<AnalyzerLaunch> = {}) {
  const log = path.join(dir, `log-${++seq}`);
  const spec: AnalyzerLaunch = { command: process.execPath, args: [path.join(dir, 'fake-server.cjs'), startMode, log], cwd: dir, env: ENV,
    timeoutMs: 5000, maxResponseBytes: 65536, ...over };
  return { log, spec };
}
const readPid = async (file: string) => Number(await readFile(file, 'utf8'));
async function open(startMode?: string, over?: Partial<AnalyzerLaunch>) {
  const { log, spec } = launch(startMode, over);
  const opened = await openAnalyzerSession(spec, ALLOWED);
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  sessions.push(opened.session);
  return { session: opened.session, log, pid: await readPid(`${log}.pid`) };
}
const find = (session: AnalyzerSession, mode?: string) => session.call('find_symbol', mode ? { mode } : {});
const frames = async (log: string) => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
/** Polls for up to 3 s until the pid no longer exists (ESRCH). */
async function gone(pid: number): Promise<boolean> {
  for (const end = Date.now() + 3000; Date.now() < end;) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'moe-mcp-stdio-'));
  await writeFile(path.join(dir, 'fake-server.cjs'), FAKE);
});
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(sessions.splice(0).map(session => session.close())); });
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('openAnalyzerSession', () => {
  it('S1 completes initialize, notifications/initialized and paged tools/list, then joins text items', async () => {
    const { session, log } = await open();
    expect(session.server).toEqual({ name: 'fake', version: '1.0', protocolVersion: '2025-06-18' });
    expect(session.tools.map(tool => tool.name)).toEqual(['find_symbol', 'write_memory', 'get_symbols_overview']);
    expect(session.tools[0].inputSchema).toEqual(SCHEMA);
    expect(await find(session)).toEqual(AB);
    const sent = await frames(log);
    expect(sent.map(frame => frame.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
    expect([sent[0].params.clientInfo.name, sent[2].params, sent[3].params]).toEqual(['moe-daemon', {}, { cursor: 'p2' }]);
  });

  it('S2 accepts CRLF-terminated replies and skips blank lines', async () => {
    const { session } = await open('crlf');
    expect([session.tools.length, await find(session)]).toEqual([3, AB]);
  });

  it('S3 cuts call text at maxResponseBytes on a character boundary', async () => {
    const { session } = await open('plain', { maxResponseBytes: 5 });
    expect(await find(session, 'big')).toEqual({ ok: true, text: '\u00e9\u00e9', truncated: true });
  });

  it('S4 keeps the session alive after a tool error or a JSON-RPC error', async () => {
    const { session } = await open();
    expect(await session.call('get_symbols_overview', {})).toEqual({ ok: false, reason: 'tool-error' });
    expect(await find(session, 'rpc')).toEqual({ ok: false, reason: 'rpc-error:-32602' });
    expect(await find(session)).toEqual(AB);
  });

  it('S5 gives the child launch.env and nothing from the parent', async () => {
    vi.stubEnv('MOE_PARENT_ONLY', 'x');
    const reply = await find((await open()).session, 'env');
    const env: Record<string, string> = JSON.parse(reply.ok ? reply.text : '{}');
    if (process.platform !== 'win32') return expect(env).toEqual(ENV);
    expect(Object.fromEntries(Object.entries(env).filter(([key]) => key in ENV))).toEqual(ENV);
    expect(Object.keys(env).filter(key => !(key in ENV) && !LIBUV_WINDOWS_ENV.includes(key.toUpperCase()))).toEqual([]);
  });

  it('S6 refuses an unallowed or unlisted tool without sending a frame', async () => {
    const { session, log } = await open();
    expect(await session.call('write_memory', {})).toEqual({ ok: false, reason: 'tool-not-allowed' });
    expect(await session.call('missing_tool', {})).toEqual({ ok: false, reason: 'tool-not-listed' });
    expect(await find(session)).toEqual(AB);
    expect((await frames(log)).filter(frame => frame.method === 'tools/call').map(frame => frame.params.name)).toEqual(['find_symbol']);
  });

  it.each([
    ['garbage', 'protocol-violation', 5000], ['badid', 'protocol-violation', 5000], ['huge', 'response-too-large', 5000],
    ['hang', 'timeout', 1500], ['crash', 'exited:3', 5000],
    ['deepid', 'protocol-violation', 5000], ['flood', 'protocol-violation', 5000],
  ])('S7 %s fails the session with %s and kills the server', async (mode, reason, timeoutMs) => {
    const { session, log, pid } = await open('plain', { timeoutMs });
    expect(await find(session, mode)).toEqual({ ok: false, reason });
    const before = await readFile(log, 'utf8');
    expect(await find(session)).toEqual({ ok: false, reason });
    expect([await readFile(log, 'utf8'), await gone(pid)]).toEqual([before, true]);
  });

  it('S8 answers server requests (-32601, ping) and ignores notifications', async () => {
    const { session, log } = await open();
    expect(await find(session, 'request')).toEqual({ ok: true, text: 'ok', truncated: false });
    const sent = await frames(log);
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 's1', error: { code: -32601, message: 'Method not found' } });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 's2', result: {} });
  });

  it('S9 reports an early exit or a missing command as a reason, never a throw', async () => {
    await expect(openAnalyzerSession(launch('die').spec, ALLOWED)).resolves.toEqual({ ok: false, reason: 'exited:0' });
    const missing = launch('plain', { command: path.join(dir, 'no-such-analyzer') }).spec;
    await expect(openAnalyzerSession(missing, ALLOWED)).resolves.toEqual({ ok: false, reason: 'spawn-failed:ENOENT' });
  });

  it.each<{ name: string; field: string; over?: Partial<AnalyzerLaunch>; allowed?: string[] }>([
    { name: 'a relative command', field: 'launch.command', over: { command: 'node' } },
    { name: 'args that are not an array', field: 'launch.args', over: { args: 'x' as unknown as string[] } },
    { name: 'a non-string env value', field: 'launch.env', over: { env: { A: 1 } as unknown as Record<string, string> } },
    { name: 'an env key containing =', field: 'launch.env', over: { env: { 'A=B': 'x' } } },
    { name: 'timeoutMs 0', field: 'launch.timeoutMs', over: { timeoutMs: 0 } },
    { name: 'maxResponseBytes over the frame limit', field: 'launch.maxResponseBytes', over: { maxResponseBytes: MCP_FRAME_LIMIT_BYTES + 1 } },
    { name: 'an empty allowedTools', field: 'allowedTools', allowed: [] },
    { name: 'a duplicate allowedTools entry', field: 'allowedTools', allowed: ['find_symbol', 'find_symbol'] },
  ])('S10 refuses $name with INVALID_INPUT before any spawn', async ({ field, over, allowed = ALLOWED }) => {
    vi.mocked(spawn).mockClear();
    await expect(openAnalyzerSession(launch('plain', over).spec, allowed)).rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('S11 close() and a failure each kill the server and its grandchild on every platform', async () => {
    for (const failWith of [null, 'garbage']) {
      const { session, log, pid } = await open('grandchild');
      const grandchild = await readPid(`${log}.gc`);
      if (failWith) expect(await find(session, failWith)).toEqual({ ok: false, reason: 'protocol-violation' });
      else await session.close();
      expect([await gone(pid), await gone(grandchild)]).toEqual([true, true]);
    }
  }, 20000);

  it.skipIf(process.platform === 'win32')('S12 close() kills a grandchild its exited leader orphaned', async () => {
    const { session, log, pid } = await open('orphan');
    const grandchild = await readPid(`${log}.gc`);
    await session.close();
    expect([await gone(pid), await gone(grandchild)]).toEqual([true, true]);
  }, 10000);

  it.skipIf(process.platform === 'win32')('S14 signals an exited leader group once, at exit, never on a later close()', async () => {
    const { session, pid } = await open();
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(await find(session, 'crash')).toEqual({ ok: false, reason: 'exited:3' });
      await session.close();
      expect(kill.mock.calls.filter(([target]) => target === -pid)).toEqual([[-pid, 'SIGKILL']]);
    } finally { kill.mockRestore(); }
  });

  it('S13 close() is idempotent and settles pending and later calls as closed', async () => {
    const { session } = await open();
    const pending = find(session, 'hang');
    const first = session.close();
    expect(session.close()).toBe(first);
    await first;
    expect([await pending, await find(session)]).toEqual([{ ok: false, reason: 'closed' }, { ok: false, reason: 'closed' }]);
  });
});

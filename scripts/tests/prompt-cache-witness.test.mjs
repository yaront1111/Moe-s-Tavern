import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../prompt-cache.mjs', import.meta.url));
const WARN = '  [WARN] tool write outside the repo not harvested: ';

// CAPTURED: real `codex exec --json` lines from codex-cli 0.166.0 (x86_64-unknown-linux-musl build), captured
// 2026-10-30 on WSL Ubuntu x86_64 with model gpt-6-luna, in scratch git repos (recipe: mem:gotcha-codex-exec-json-event-shapes).
// Trimmed: long texts end in [trimmed]; reasoning, agent_message, thread.started and turn.started lines are dropped.
// <REPO> is the capture's repo root. event() swaps it inside changes[].path after JSON.parse, never in the raw text,
// because a Windows temp path's backslashes would corrupt the JSON.
const CAPTURED = {
  addStarted: String.raw`{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"<REPO>/created.txt","kind":"add"}],"status":"in_progress"}}`,
  addCompleted: String.raw`{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"<REPO>/created.txt","kind":"add"}],"status":"completed"}}`,
  lockedStarted: String.raw`{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"<REPO>/locked/target.txt","kind":"update"}],"status":"in_progress"}}`,
  lockedFailed: String.raw`{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"<REPO>/locked/target.txt","kind":"update"}],"status":"failed"}}`,
  patchTurn: String.raw`{"type":"turn.completed","usage":{"input_tokens":48023,"cached_input_tokens":38912,"cache_write_input_tokens":0,"output_tokens":132,"reasoning_output_tokens":0}}`,
  instructionsStarted: String.raw`{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"serena","tool":"initial_instructions","arguments":{},"result":null,"error":null,"status":"in_progress"}}`,
  instructionsCompleted: String.raw`{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"serena","tool":"initial_instructions","arguments":{},"result":{"content":[{"type":"text","text":"You have semantic coding tools that you rely on heavily. [trimmed]"}],"structured_content":{"result":"[trimmed]"}},"error":null,"status":"completed"}}`,
  replaceStarted: String.raw`{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"serena","tool":"replace_in_files","arguments":{"relative_path":"mod.py","mode":"literal","needle":"X = 1","repl":"X = 2","expected_count":1},"result":null,"error":null,"status":"in_progress"}}`,
  replaceCompleted: String.raw`{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"serena","tool":"replace_in_files","arguments":{"relative_path":"mod.py","mode":"literal","needle":"X = 1","repl":"X = 2","expected_count":1},"result":{"content":[{"type":"text","text":"Replaced 1 occurrence(s) in 1 file(s):\n  mod.py: 1"}],"structured_content":{"result":"Replaced 1 occurrence(s) in 1 file(s):\n  mod.py: 1"}},"error":null,"status":"completed"}}`,
  missStarted: String.raw`{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"serena","tool":"replace_in_files","arguments":{"relative_path":"mod.py","mode":"literal","needle":"NOT_PRESENT_TOKEN","repl":"Y"},"result":null,"error":null,"status":"in_progress"}}`,
  missFailed: String.raw`{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"serena","tool":"replace_in_files","arguments":{"relative_path":"mod.py","mode":"literal","needle":"NOT_PRESENT_TOKEN","repl":"Y"},"result":{"content":[{"type":"text","text":"Error executing tool replace_in_files: ValueError: No occurrences of the pattern were found - NO changes were applied. [trimmed]"}],"structured_content":null},"error":null,"status":"failed"}}`,
  serenaTurn: String.raw`{"type":"turn.completed","usage":{"input_tokens":129447,"cached_input_tokens":98944,"cache_write_input_tokens":0,"output_tokens":212,"reasoning_output_tokens":0}}`,
};

// A captured event with <REPO> swapped for repo. A patch makes it a DERIVED variant: it is merged into the item first.
function event(name, repo, patch) {
  const evt = JSON.parse(CAPTURED[name]);
  if (patch) Object.assign(evt.item, patch);
  for (const change of Array.isArray(evt.item?.changes) ? evt.item.changes : []) {
    if (typeof change?.path === 'string') change.path = change.path.replace('<REPO>', () => repo);
  }
  return evt;
}
// The captured success result shape, carrying another Serena answer (derived).
const answer = text => ({ content: [{ type: 'text', text }], structured_content: { result: text } });
// Derived from the captured applied replace_in_files: another Serena tool, arguments and answer.
const serena = (repo, tool, args, text) => event('replaceCompleted', repo, { tool, arguments: args, result: answer(text) });
const changes = (repo, ...paths) => event('addCompleted', repo, { changes: paths.map(p => ({ path: p, kind: 'update' })) });

function workspace(t) {
  const top = mkdtempSync(path.join(tmpdir(), 'moe witness top '));
  const out = mkdtempSync(path.join(tmpdir(), 'moe witness out '));
  t.after(() => { for (const dir of [top, out]) rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(out, 'tool-writes.txt');
  const vars = { MOE_TOOL_WRITES_FILE: file, MOE_GIT_TOP: top, MOE_GIT_REL: 'sub/', MOE_SERENA_PROJECT_ROOT: path.join(top, 'sub') };
  return { top, out, file, vars };
}

function witnessed(file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) return [];
  const text = readFileSync(file, 'utf8');
  assert.ok(text === '' || text.endsWith('\n'), `every witness line ends in a newline: ${JSON.stringify(text)}`);
  return text.split('\n').slice(0, -1);
}

// Spawns codex-stream with every inherited MOE_* key dropped, so a live seat's harvest or receipt file never gets fixture data.
function run(events, vars) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOE_/i.test(key)));
  const input = events.map(evt => typeof evt === 'string' ? evt : JSON.stringify(evt)).join('\n');
  const result = spawnSync(process.execPath, [helper, 'codex-stream'], {
    input, env: { ...env, ...vars }, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, witnessed: witnessed(vars.MOE_TOOL_WRITES_FILE) };
}
const warnings = stdout => stdout.split(/\r?\n/).filter(line => line.startsWith(WARN));

const appended = [
  ['W1 the captured completed add, after its in_progress start', top => [event('addStarted', top), event('addCompleted', top)], ['created.txt']],
  ['W2 a derived relative file_change path gets MOE_GIT_REL', top => [changes(top, 'lib/a.txt')], ['sub/lib/a.txt']],
  ['W3 the captured applied replace_in_files joins the Serena root', top => [event('replaceStarted', top), event('replaceCompleted', top)], ['sub/mod.py']],
  ['W4 a derived replace_content witnesses its relative_path', top => [serena(top, 'replace_content', { relative_path: 'pkg/x.py', needle: 'a', repl: 'b', mode: 'literal' }, 'OK')], ['sub/pkg/x.py']],
  ['W5 a derived Serena diagnostics envelope is unwrapped', top => [serena(top, 'replace_in_files', { relative_path: 'mod.py', needle: 'a', repl: 'b' },
    JSON.stringify({ result: 'Replaced 1 occurrence(s) in 1 file(s):\n  mod.py: 1', 'diagnostics[warning-or-higher]': { 'mod.py': ['unused name'] } }))], ['sub/mod.py']],
  ['W6 a derived CRLF summary keeps a backslash path and stops at its first non-file line', top => [serena(top, 'replace_in_files', { relative_path: 'pkg', needle: 'a', repl: 'b' },
    'Replaced 2 occurrence(s) in 2 file(s):\r\n  pkg\\y.py: 1\r\nnot a summary line\r\n  pkg/z.py: 1')], ['sub/pkg/y.py']],
  ['W7 a derived safe_delete_symbol answering OK', top => [serena(top, 'safe_delete_symbol', { name_path: 'f', relative_path: 'pkg/x.py' }, 'OK')], ['sub/pkg/x.py']],
  ['W8 a derived rename_symbol witnesses only its relative_path', top => [serena(top, 'rename_symbol', { name_path: 'f', relative_path: 'pkg/x.py', new_name: 'g' },
    "Successfully renamed 'f' to 'g' (3 changes applied)")], ['sub/pkg/x.py']],
  ['W9 a derived file_change with add, update and delete witnesses all three in order', top => [event('addCompleted', top, { changes: [
    { path: '<REPO>/a.txt', kind: 'add' }, { path: '<REPO>/b.txt', kind: 'update' }, { path: '<REPO>/c.txt', kind: 'delete' }] })], ['a.txt', 'b.txt', 'c.txt']],
];
for (const [name, events, expected] of appended) {
  test(name, t => {
    const ws = workspace(t);
    const result = run(events(ws.top), ws.vars);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.witnessed, expected);
    assert.deepEqual(warnings(result.stdout), []);
  });
}

const refused = [
  ['N1 the captured failed file_change', top => [event('lockedStarted', top), event('lockedFailed', top)]],
  ['N2 the captured item.started lines, and derived item.started/item.updated carrying status completed', top => ['addStarted', 'lockedStarted',
    'instructionsStarted', 'replaceStarted', 'missStarted'].map(name => event(name, top))
    .concat(['item.started', 'item.updated'].map(type => ({ ...event('addCompleted', top), type })))],
  // The derived replace_content variant counts its relative_path whatever its text, so only the status check rejects it.
  ['N3 the captured failed replace_in_files (isError: status failed, result present, error null), and a derived replace_content one',
    top => [event('missStarted', top), event('missFailed', top), event('missFailed', top, { tool: 'replace_content' })]],
  ['N4 a derived result-less failed call', top => [event('replaceCompleted', top, { status: 'failed', result: null, error: { message: 'tool call timed out' } })]],
  ['N5 a derived completed call with an error', top => [event('replaceCompleted', top, { error: { message: 'transport closed' } })]],
  ['N6 a derived completed call without a result', top => [event('replaceCompleted', top, { result: null })]],
  ['N7 the captured non-editing initial_instructions', top => [event('instructionsStarted', top), event('instructionsCompleted', top)]],
  ['N8 a derived safe_delete_symbol refusal', top => [serena(top, 'safe_delete_symbol', { name_path: 'X', relative_path: 'pkg/x.py' },
    'Cannot delete, the symbol X is referenced in: {"pkg/y.py": [3]}')]],
  ['N9 a derived replace_in_files dry run', top => [serena(top, 'replace_in_files', { relative_path: 'mod.py', needle: 'X', repl: 'Y', dry_run: true },
    'Found 1 occurrence(s) in 1 file(s). DRY RUN - no changes were applied.\n--- mod.py\n+++ mod.py')]],
  ['N10 a derived rename_symbol answer without Successfully renamed', top => [serena(top, 'rename_symbol', { name_path: 'f', relative_path: 'pkg/x.py', new_name: 'g' },
    'No symbol f was found; nothing renamed')]],
  ['N11 a derived command_execution, because a shell write leaves no witness', top => [event('addCompleted', top, {
    type: 'command_execution', changes: undefined, command: "/bin/bash -lc 'echo hi > shell.txt'", aggregated_output: '', exit_code: 0 })]],
];
for (const [name, events] of refused) {
  test(name, t => {
    const ws = workspace(t);
    const result = run(events(ws.top), ws.vars);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.witnessed, []);
    assert.deepEqual(warnings(result.stdout), []);
  });
}

test('N12 an absolute path outside the repo prints the WARN line and is not appended', t => {
  const ws = workspace(t);
  const raws = [path.join(tmpdir(), 'moe-witness-elsewhere', 'x.txt'), `${ws.top}-sibling/a.txt`];
  const result = run([changes(ws.top, ...raws)], ws.vars);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.witnessed, []);
  assert.deepEqual(warnings(result.stdout), raws.map(raw => WARN + raw));
});

test('N13 a path with a .. segment is refused with a WARN each', t => {
  const ws = workspace(t);
  const joined = `${ws.vars.MOE_SERENA_PROJECT_ROOT.replaceAll('\\', '/')}/../escape.py`;
  const result = run([changes(ws.top, '../x.txt', `${ws.top}/../x.txt`),
    serena(ws.top, 'replace_content', { relative_path: '../escape.py', needle: 'a', repl: 'b' }, 'OK')], ws.vars);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.witnessed, []);
  assert.deepEqual(warnings(result.stdout), [WARN + '../x.txt', `${WARN}${ws.top}/../x.txt`, WARN + joined]);
});

test('N15 a path with a line break is refused whole, so it cannot forge a second witness line', t => {
  const ws = workspace(t);
  const raws = ['ok.txt\nforged.txt', `${ws.top}/a.txt\rforged.txt`];
  const result = run([changes(ws.top, raws[0]),
    serena(ws.top, 'create_text_file', { relative_path: 'b.py\nforged.py', content: '' }, 'File created: b.py'),
    changes(ws.top, raws[1])], ws.vars);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.witnessed, []);
  for (const raw of raws) assert.ok(result.stdout.includes(`${WARN}${raw}\n`), raw);
});

test('N14 malformed events the renderer survives append nothing and leave the stream running', t => {
  const ws = workspace(t);
  const result = run(['null', '"a JSON string"', '42', { type: 'item.completed', item: null },
    event('addCompleted', ws.top, { changes: undefined }),
    event('addCompleted', ws.top, { changes: [{ path: 42, kind: 'add' }, { path: '', kind: 'add' }, { path: '   ', kind: 'add' }] }),
    event('replaceCompleted', ws.top, { tool: 'replace_content', arguments: 'mod.py' }),
    event('replaceCompleted', ws.top, { tool: undefined }),
    event('addCompleted', ws.top)], ws.vars);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.witnessed, ['created.txt']);
  assert.deepEqual(warnings(result.stdout), []);
});

test('S1 without MOE_TOOL_WRITES_FILE the whole captured stream renders byte-identically and writes nothing', t => {
  const ws = workspace(t);
  const stream = Object.keys(CAPTURED).map(name => event(name, ws.top));
  const { MOE_TOOL_WRITES_FILE, ...rest } = ws.vars;
  const bare = run(stream, {});
  const unset = run(stream, rest);
  assert.deepEqual(readdirSync(ws.top), []);
  assert.deepEqual(readdirSync(ws.out), []);
  const set = run(stream, ws.vars);
  for (const result of [bare, unset, set]) assert.equal(result.status, 0, result.stderr);
  assert.equal((bare.stdout.match(/\[prompt-cache\] provider=codex/g) || []).length, 2);
  assert.equal(unset.stdout, bare.stdout);
  assert.equal(set.stdout, bare.stdout);
  assert.deepEqual(set.witnessed, ['created.txt', 'sub/mod.py']);
});

test('S2 an unwritable witness file never breaks the stream', t => {
  const ws = workspace(t);
  const stream = Object.keys(CAPTURED).map(name => event(name, ws.top));
  const { MOE_TOOL_WRITES_FILE, ...rest } = ws.vars;
  const baseline = run(stream, rest);
  const missing = path.join(ws.out, 'missing');
  for (const file of [path.join(missing, 'tool-writes.txt'), ws.out]) {
    const result = run(stream, { ...rest, MOE_TOOL_WRITES_FILE: file });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, baseline.stdout);
  }
  assert.equal(existsSync(missing), false);
});

// In-process rows: the platform rules, with console.log mocked to catch the WARN line.
async function writer(t, env, platform) {
  const { createWitnessWriter } = await import('../prompt-cache-witness.mjs');
  const out = mkdtempSync(path.join(tmpdir(), 'moe witness unit '));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const file = path.join(out, 'tool-writes.txt');
  const log = t.mock.method(console, 'log', () => {});
  const witness = createWitnessWriter({ MOE_TOOL_WRITES_FILE: file, MOE_GIT_REL: '', ...env }, platform);
  return { witness, lines: () => witnessed(file), logged: () => log.mock.calls.map(call => call.arguments.join(' ')) };
}

test('P1 win32 matches a drive path case-insensitively and keeps its own spelling', async t => {
  for (const top of ['C:/Repo', 'C:\\Repo\\']) {
    const w = await writer(t, { MOE_GIT_TOP: top }, 'win32');
    w.witness.event(changes('', 'c:\\repo\\A.txt'));
    assert.deepEqual(w.lines(), ['A.txt'], top);
    assert.deepEqual(w.logged(), []);
  }
});

test('P2 win32 maps the Git-Bash /c/ form onto the drive', async t => {
  const w = await writer(t, { MOE_GIT_TOP: 'C:/Repo' }, 'win32');
  w.witness.event(changes('', '/c/Repo/a.txt'));
  assert.deepEqual(w.lines(), ['a.txt']);
});

test('P3 darwin accepts a case-only mismatch', async t => {
  const w = await writer(t, { MOE_GIT_TOP: '/Users/me/Repo' }, 'darwin');
  w.witness.event(changes('', '/users/ME/repo/b.txt'));
  assert.deepEqual(w.lines(), ['b.txt']);
});

test('P4 linux refuses a case-only mismatch and the /c/ form, with the WARN', async t => {
  const w = await writer(t, { MOE_GIT_TOP: '/home/me/Repo' }, 'linux');
  w.witness.event(changes('', '/home/me/repo/b.txt', '/home/me/Repo/c.txt'));
  assert.deepEqual(w.lines(), ['c.txt']);
  assert.deepEqual(w.logged(), [`${WARN}/home/me/repo/b.txt`]);
  const drive = await writer(t, { MOE_GIT_TOP: 'C:/Repo' }, 'linux');
  drive.witness.event(changes('', '/c/Repo/a.txt'));
  assert.deepEqual(drive.lines(), []);
});

test('P5 malformed shapes return without throwing or appending', async t => {
  const w = await writer(t, { MOE_GIT_TOP: '/repo', MOE_SERENA_PROJECT_ROOT: '/repo' }, 'linux');
  for (const evt of [undefined, null, 'item.completed', 42, { type: 'item.completed' }, { type: 'item.completed', item: null },
    event('addCompleted', '', { changes: 'x' }), event('addCompleted', '', { changes: [null, 7, { kind: 'add' }] }),
    event('replaceCompleted', '', { arguments: null }), event('replaceCompleted', '', { arguments: ['mod.py'] }),
    event('replaceCompleted', '', { result: { content: {} } }), event('replaceCompleted', '', { result: 'Replaced 1 occurrence(s) in 1 file(s):\n  mod.py: 1' }),
    event('replaceCompleted', '', { tool: 'safe_delete_symbol', arguments: { relative_path: 'x.py' }, result: { content: { type: 'text', text: 'OK' } } }),
    event('replaceCompleted', '', { result: { content: [null, 42, { type: 'text', text: 5 }] } })]) {
    assert.doesNotThrow(() => w.witness.event(evt));
  }
  assert.deepEqual(w.lines(), []);
  assert.deepEqual(w.logged(), []);
});

test('P6 without MOE_TOOL_WRITES_FILE the writer prints and writes nothing', async t => {
  const { createWitnessWriter } = await import('../prompt-cache-witness.mjs');
  const log = t.mock.method(console, 'log', () => {});
  const witness = createWitnessWriter({ MOE_TOOL_WRITES_FILE: '', MOE_GIT_TOP: '/repo', MOE_GIT_REL: '' }, 'linux');
  witness.event(changes('', '/elsewhere/x.txt', 'inside.txt'));
  assert.equal(log.mock.callCount(), 0);
});

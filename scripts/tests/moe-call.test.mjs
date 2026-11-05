// Exercise the real helper; only the daemon/proxy boundary is replaced.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../moe-call.sh', import.meta.url));
const windows = process.platform === 'win32';
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const nativePath = value => value.replaceAll('\\', '/');
const shellPath = value => windows
  ? nativePath(value).replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
  : value;
const fakeProxy = `import { readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (request.method !== 'tools/call' || request.params.name !== 'moe.get_context') {
  throw new Error('unexpected fixture request');
}
const frame = readFileSync(process.env.MOE_C00_RESPONSE_FILE);
// The fake producer must drain correctly, so it cannot cause the tested loss.
await new Promise((resolve, reject) => {
  process.stdout.write(frame, error => error ? reject(error) : resolve());
});
`;

function invoke(t, wire, destination = 'pipe', args = '{}') {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe CLI response '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'scratch project');
  mkdirSync(path.join(project, '.moe'), { recursive: true });
  // Discovery-only fixture: never contact or mutate a real Moe project.
  writeFileSync(path.join(project, '.moe', 'daemon.json'), '{}\n');
  const proxy = path.join(dir, 'fake-proxy.mjs');
  const frame = path.join(dir, 'response.jsonl');
  const output = path.join(dir, 'actual-output');
  writeFileSync(proxy, fakeProxy);
  writeFileSync(frame, wire);
  const fd = destination === 'file' ? openSync(output, 'w') : undefined;
  let result;
  try {
    result = spawnSync(bash, [shellPath(helper), 'get_context', args, '--project', shellPath(project)], {
      timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', fd ?? 'pipe', 'pipe'],
      env: { ...process.env, MOE_PROXY_PATH: nativePath(proxy), MOE_C00_RESPONSE_FILE: nativePath(frame) },
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  assert.ifError(result.error);
  return { status: result.status, stderr: result.stderr.toString('utf8'),
    bytes: fd === undefined ? result.stdout : readFileSync(output) };
}

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const frameOf = response => `${JSON.stringify({ jsonrpc: '2.0', id: 1, ...response })}\n`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function expectComplete(result, expected, status = 0) {
  const wanted = Buffer.from(expected, 'utf8');
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.bytes.length, wanted.length, 'helper must retain the entire response, including its tail');
  // Compare hashes rather than dumping a megabyte-sized assertion diff on RED.
  assert.equal(digest(result.bytes), digest(wanted), 'response bytes and UTF-8 content must match exactly');
}

function responseCase(kind, text) {
  const payload = { task: { id: 'scratch-only', description: text },
    omitted: ['futureSection'], futureField: { sentinel: 'END-OF-COMPLETE-RESPONSE' } };
  if (kind === 'error') {
    const error = { code: -32002, message: text, data: { sentinel: 'END-OF-COMPLETE-ERROR' } };
    return { wire: frameOf({ error }), expected: pretty(error), status: 1 };
  }
  if (kind === 'bare') return { wire: frameOf({ result: payload }), expected: pretty(payload), status: 0 };
  const raw = `${text}\nEND-OF-RAW-RESPONSE`;
  const content = kind === 'raw' ? raw : JSON.stringify(payload);
  return { wire: frameOf({ result: { content: [{ type: 'text', text: content }] } }),
    expected: kind === 'raw' ? `${raw}\n` : pretty(payload), status: 0 };
}

for (const [label, text] of [['ASCII', 'x'.repeat(1_200_000)], ['Unicode', 'שלום🙂漢字'.repeat(100_000)]]) {
  for (const kind of ['structured', 'raw', 'bare', 'error']) {
    for (const destination of ['pipe', 'file']) {
      test(`large ${label} ${kind} response survives ${destination} transport`, t => {
        const fixture = responseCase(kind, text);
        const result = invoke(t, fixture.wire, destination);
        if (label === 'Unicode' && destination === 'file') {
          assert.equal(result.bytes.toString('utf8').includes('\ufffd'), false,
            'regular-file output isolates split UTF-8 corruption from pipe-drain loss');
        }
        expectComplete(result, fixture.expected, fixture.status);
      });
    }
  }
}

for (const kind of ['structured', 'raw', 'bare', 'error']) {
  test(`short legacy ${kind} response preserves status and shell-sensitive text`, t => {
    const fixture = responseCase(kind, 'literal $VALUE `text` "quotes" \\ path — שלום🙂漢字');
    expectComplete(invoke(t, fixture.wire), fixture.expected, fixture.status);
  });
}

test('multiple text items retain order and the tail after a large item', t => {
  const first = { description: 'large '.repeat(200_000) };
  const last = 'tail $literal `not-shell` — שלום🙂漢字';
  const wire = frameOf({ result: { content: [
    { type: 'text', text: JSON.stringify(first) }, { type: 'image', data: 'ignored' }, { type: 'text', text: last },
  ] } });
  expectComplete(invoke(t, wire), pretty(first) + last + '\n');
});

test('the first matching result still wins over later response lines', t => {
  const first = { selected: 'first' };
  const wire = `proxy startup notice\n${frameOf({ result: first })}${frameOf({ result: { selected: 'second' } })}`;
  expectComplete(invoke(t, wire), pretty(first));
});

test('an error still stops parsing before a later successful result', t => {
  const error = { code: -32002, message: 'first error' };
  const wire = frameOf({ error }) + frameOf({ result: { mustNotAppear: true } });
  expectComplete(invoke(t, wire), pretty(error), 1);
});

test('malformed responses fail without inventing a successful result', t => {
  const result = invoke(t, 'not JSON\n');
  assert.equal(result.status, 1);
  assert.equal(result.bytes.length, 0);
  assert.match(result.stderr, /could not parse response/);
});

test('an empty proxy response remains a failure', t => {
  const result = invoke(t, '');
  assert.equal(result.status, 1);
  assert.equal(result.bytes.length, 0);
  assert.match(result.stderr, /no response from daemon/);
});

test('malformed request arguments fail before forwarding', t => {
  const result = invoke(t, frameOf({ result: { mustNotAppear: true } }), 'pipe', '{');
  assert.equal(result.status, 1);
  assert.equal(result.bytes.length, 0);
  assert.match(result.stderr, /failed to build JSON-RPC request/);
});

// CQ-R13c2 follow-up: with MOE_RUNTIME_PROTECTED exactly '1' the helper runs only
// MOE_PROXY_PATH. Every proxy it could resolve is a decoy that logs its label.
const decoy = label => `import('node:fs').then(({ appendFileSync }) => {
  appendFileSync(process.env.MOE_CALL_RAN_LOG, '${label}\\n');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const { params } = JSON.parse(input);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ran: '${label}', tool: params.name } }) + '\\n');
  });
});
`;

function runtimeLayout(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe protected runtime '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (relative, text) => {
    const file = path.join(dir, ...relative.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const proxies = {
    named: put('named/proxy.mjs', decoy('named')),
    repo: put('install/packages/moe-proxy/dist/index.js', decoy('repo')),
    global: put('global/packages/moe-proxy/dist/index.js', decoy('global')),
    plugin: put('home/Library/Application Support/JetBrains/IDE/moe-jetbrains/proxy/index.js', decoy('plugin')),
    inherited: put('inherited/proxy.mjs', decoy('inherited')),
  };
  put('home/.moe/config.json', JSON.stringify({ installPath: nativePath(path.join(dir, 'global')) }));
  put('scratch project/.moe/daemon.json', '{}\n');
  return { dir, proxies, put, helper: put('install/scripts/moe-call.sh', readFileSync(helper)) };
}

function callHelper(layout, { marker, proxyPath, cwd, tool = 'get_context', args = '{}', searchPath } = {}) {
  const log = path.join(layout.dir, 'ran.log');
  rmSync(log, { force: true });
  // A seat's own env must not decide the row: set or drop every input explicitly.
  const env = { ...process.env, HOME: nativePath(path.join(layout.dir, 'home')),
    MOE_CALL_RAN_LOG: nativePath(log), PROXY_PATH: nativePath(layout.proxies.inherited) };
  delete env.MOE_RUNTIME_PROTECTED;
  delete env.MOE_PROXY_PATH;
  if (marker !== undefined) env.MOE_RUNTIME_PROTECTED = marker;
  if (proxyPath !== undefined) env.MOE_PROXY_PATH = proxyPath;
  if (searchPath !== undefined) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = searchPath;
  }
  const result = spawnSync(bash, [shellPath(layout.helper), tool, args,
    '--project', shellPath(path.join(layout.dir, 'scratch project'))], { cwd, env, timeout: 20_000 });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'),
    ran: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}

const refusal = /^Error: MOE_RUNTIME_PROTECTED_PATH_MISSING: MOE_PROXY_PATH must be an absolute path to an existing file when MOE_RUNTIME_PROTECTED=1; refusing to start\.$/m;

for (const [label, pick] of [
  ['unset', () => ({})],
  ['empty', () => ({ proxyPath: '' })],
  ['a directory holding index.js', ({ proxies }) => ({ proxyPath: nativePath(path.dirname(proxies.repo)) })],
  ['relative', ({ proxies }) => ({ proxyPath: 'proxy.mjs', cwd: path.dirname(proxies.named) })],
  // The deregister moe-agent.sh runs after moe_call_allowed passed, and the agent's
  // own MOE_FALLBACK_CLI call, both after the named proxy vanished.
  ['vanished before the deregister', ({ proxies }) => ({ vanish: true, proxyPath: nativePath(proxies.named),
    tool: 'deregister_worker', args: '{"workerId":"worker-protected","reason":"terminal_closed"}' })],
  ['vanished before an agent fallback CLI call', ({ proxies }) => ({ vanish: true, proxyPath: nativePath(proxies.named),
    tool: 'get_context', args: '{"taskId":"task-protected"}' })],
]) {
  test(`protected runtime refuses MOE_PROXY_PATH ${label} and runs no other proxy`, t => {
    const layout = runtimeLayout(t);
    const { vanish, ...call } = pick(layout);
    if (vanish) rmSync(layout.proxies.named);
    const result = callHelper(layout, { marker: '1', ...call });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.ran, []);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, refusal);
    if (call.proxyPath) assert.equal(result.stderr.includes(call.proxyPath), false, 'the refusal never prints the path');
  });
}

test('protected runtime runs exactly an existing absolute MOE_PROXY_PATH', t => {
  const layout = runtimeLayout(t);
  const result = callHelper(layout, { marker: '1', proxyPath: nativePath(layout.proxies.named) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ran, ['named']);
  assert.deepEqual(JSON.parse(result.stdout), { ran: 'named', tool: 'moe.get_context' });
});

test('without the marker the fallback order is unchanged', t => {
  const layout = runtimeLayout(t);
  // Windows-native python cannot open the POSIX $HOME path the helper hands it,
  // so the global-install step is unreachable there (pre-existing behaviour).
  for (const label of windows ? ['named', 'repo', 'plugin'] : ['named', 'repo', 'global', 'plugin']) {
    const result = callHelper(layout, { proxyPath: nativePath(layout.proxies.named) });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.deepEqual(result.ran, [label]);
    assert.deepEqual(JSON.parse(result.stdout), { ran: label, tool: 'moe.get_context' });
    rmSync(layout.proxies[label]);
  }
  const none = callHelper(layout, { proxyPath: nativePath(layout.proxies.named) });
  assert.equal(none.status, 1);
  assert.deepEqual(none.ran, []);
  assert.match(none.stderr, /moe-proxy not found\. Set MOE_PROXY_PATH or install Moe\./);
});

// Only the global-install step reads its config with Python. With none on PATH
// find_python fails, which under set -e ended every call silently.
test('without Python on PATH the call still runs, and only the global-install step is skipped', t => {
  const layout = runtimeLayout(t);
  let searchPath = path.dirname(process.execPath); // Git Bash adds its own /usr/bin, which holds no Python.
  if (!windows) {
    searchPath = path.join(layout.dir, 'bin');
    mkdirSync(searchPath);
    symlinkSync(process.execPath, path.join(searchPath, 'node'));
    for (const tool of ['dirname', 'find']) {
      symlinkSync(['/usr/bin', '/bin'].map(dir => path.join(dir, tool)).find(file => existsSync(file)), path.join(searchPath, tool));
    }
  }
  for (const label of ['named', 'repo', 'plugin']) {
    const result = callHelper(layout, { proxyPath: nativePath(layout.proxies.named), searchPath });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.deepEqual(result.ran, [label]);
    assert.deepEqual(JSON.parse(result.stdout), { ran: label, tool: 'moe.get_context' });
    rmSync(layout.proxies[label]);
  }
});

test('without the marker a relative MOE_PROXY_PATH still resolves from the caller directory', t => {
  const layout = runtimeLayout(t);
  const result = callHelper(layout, { proxyPath: 'proxy.mjs', cwd: path.dirname(layout.proxies.named) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ran, ['named']);
});

for (const marker of ['', '0', '01', 'true', ' 1', '1 ']) {
  test(`MOE_RUNTIME_PROTECTED=${JSON.stringify(marker)} keeps the legacy fallback`, t => {
    const layout = runtimeLayout(t);
    rmSync(layout.proxies.named);
    const result = callHelper(layout, { marker, proxyPath: nativePath(layout.proxies.named) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.ran, ['repo']);
  });
}

// task-0d9ebe5b: run by path, the kernel (MSYS on Windows) picks the interpreter
// from the shebang before any helper line runs. The project holds bash and sh plants.
const dash = ['/bin/dash', '/usr/bin/dash'].find(file => existsSync(file));
const plant = name => `#!/bin/sh\necho 'project ${name}' >> "$MOE_CALL_RAN_LOG"\nexit 42\n`;

function directCall(layout, { marker, dot = true, via, extra = {}, helper: file = layout.helper } = {}) {
  const project = path.join(layout.dir, 'scratch project');
  const log = path.join(layout.dir, 'ran.log');
  rmSync(log, { force: true });
  chmodSync(file, 0o755);
  for (const name of ['bash', 'sh']) writeFileSync(path.join(project, name), plant(name), { mode: 0o755 });
  const env = { ...process.env, HOME: nativePath(path.join(layout.dir, 'home')), MOE_CALL_RAN_LOG: nativePath(log),
    PROXY_PATH: nativePath(layout.proxies.inherited), MOE_PROXY_PATH: nativePath(layout.proxies.named) };
  for (const name of ['MOE_RUNTIME_PROTECTED', 'MOE_CALL_BASH_ENTRY', 'POSIXLY_CORRECT', 'SHELLOPTS']) delete env[name];
  if (marker !== undefined) env.MOE_RUNTIME_PROTECTED = marker;
  Object.assign(env, extra);
  // Windows keeps the inherited PATH, which Git Bash converts.
  if (!windows) env.PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const options = { cwd: project, env, timeout: 20_000 };
  // The shim only sets PATH and execs the file by path: real direct execution.
  const result = via
    ? spawnSync(via, [file, 'get_context', '{}', '--project', project],
      { ...options, env: { ...env, PATH: `.:${env.PATH}` } })
    : spawnSync(bash, ['-c', `${dot ? 'PATH=".:$PATH"; export PATH; ' : ''}exec "$0" "$@"`, shellPath(file),
      'get_context', '{}', '--project', shellPath(project)], options);
  assert.ifError(result.error); // a hand-over loop fails here as a timeout
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'),
    ran: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}

function expectNamed(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ran, ['named']);
  assert.deepEqual(JSON.parse(result.stdout), { ran: 'named', tool: 'moe.get_context' });
}

function expectPlant(result) {
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.ran, ['project bash']);
  assert.equal(result.stdout, '');
}

test('direct exec D1: the marker never runs a project bash; legacy still finds bash by PATH', t => {
  const layout = runtimeLayout(t);
  expectNamed(directCall(layout, { marker: '1' }));
  expectPlant(directCall(layout, {}));
});

test('direct exec D2: a bash running as sh hands over',
  { skip: windows && 'Git Bash /bin/sh is bash in POSIX mode: D1 covers it' }, t => {
  const layout = runtimeLayout(t);
  const sh = path.join(layout.dir, 'shbin', 'sh');
  mkdirSync(path.dirname(sh));
  symlinkSync('/bin/bash', sh);
  expectNamed(directCall(layout, { marker: '1', via: sh }));
  // Running the body in place would reach 'named'; the hand-over reaches the PATH bash.
  expectPlant(directCall(layout, { via: sh }));
});

test('direct exec D3: POSIXLY_CORRECT hands over at most once', t => {
  const layout = runtimeLayout(t);
  const extra = { POSIXLY_CORRECT: '1' };
  expectNamed(directCall(layout, { marker: '1', extra }));
  expectNamed(directCall(layout, { dot: false, extra }));
});

test('direct exec D4: dash hands over, and a preset sentinel refuses',
  { skip: windows ? 'POSIX only' : !dash && 'no dash on this host' }, t => {
  const layout = runtimeLayout(t);
  expectNamed(directCall(layout, { marker: '1', via: dash }));
  const forged = directCall(layout, { marker: '1', via: dash, extra: { MOE_CALL_BASH_ENTRY: '1' } });
  assert.equal(forged.status, 1, forged.stderr);
  assert.equal(forged.stdout, '');
  assert.deepEqual(forged.ran, []);
  assert.equal(forged.stderr, 'Error: moe-call.sh must run under bash; refusing to start.\n');
});

test('direct exec D5: without /bin/bash the marker refuses and never falls back to the PATH bash', t => {
  const layout = runtimeLayout(t);
  const text = readFileSync(layout.helper, 'utf8');
  assert.ok(text.split('/bin/bash').length - 1 >= 2, 'the helper must name /bin/bash for this row to mean anything');
  const file = layout.put('nobash/scripts/moe-call.sh', text.replaceAll('/bin/bash', '/nonexistent/moe-bash'));
  const result = directCall(layout, { marker: '1', helper: file });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.ran, []);
  assert.match(result.stderr, /^Error: MOE_PROTECTED_INTERPRETER_NOT_FOUND: \/nonexistent\/moe-bash is not executable/m);
});

// Exercise the real helper; only the daemon/proxy boundary is replaced.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  return { dir, proxies, helper: put('install/scripts/moe-call.sh', readFileSync(helper)) };
}

function callHelper(layout, { marker, proxyPath, cwd, tool = 'get_context', args = '{}' } = {}) {
  const log = path.join(layout.dir, 'ran.log');
  rmSync(log, { force: true });
  // A seat's own env must not decide the row: set or drop every input explicitly.
  const env = { ...process.env, HOME: nativePath(path.join(layout.dir, 'home')),
    MOE_CALL_RAN_LOG: nativePath(log), PROXY_PATH: nativePath(layout.proxies.inherited) };
  delete env.MOE_RUNTIME_PROTECTED;
  delete env.MOE_PROXY_PATH;
  if (marker !== undefined) env.MOE_RUNTIME_PROTECTED = marker;
  if (proxyPath !== undefined) env.MOE_PROXY_PATH = proxyPath;
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

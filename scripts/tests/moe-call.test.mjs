// Exercise the real helper; only the daemon/proxy boundary is replaced.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

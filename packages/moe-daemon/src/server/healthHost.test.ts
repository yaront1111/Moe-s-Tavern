import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { isAllowedHealthHost } from './healthHost.js';
import * as daemon from '../index.js';
import type { DaemonInfo } from '../types/schema.js';

type Row = [host: string | undefined, localAddress: string | undefined];

// A. The pure rule: no Host, localhost, loopback literals, or the address the connection arrived on.
const allowed: Row[] = [
  [undefined, '127.0.0.1'], [undefined, undefined],
  ['localhost', '127.0.0.1'], ['localhost:9876', '127.0.0.1'], ['LocalHost:1', '127.0.0.1'],
  ['127.0.0.1', '127.0.0.1'], ['127.0.0.1:9876', undefined], ['127.255.0.9:80', '172.26.208.1'],
  ['[::1]', '::1'], ['[::1]:9876', '127.0.0.1'], ['[0:0:0:0:0:0:0:1]:9876', undefined],
  // The WSL gateway: the Windows vEthernet address the agents dial is the address the connection arrives on.
  ['172.26.208.1:9876', '172.26.208.1'], ['172.26.208.1', '172.26.208.1'],
  ['172.26.208.1:9876', '::ffff:172.26.208.1'], ['172.26.208.1', '::ffff:172.26.208.1'],
  ['[fd00::5]:9876', 'fd00::5'], ['[fd00:0:0:0:0:0:0:5]', 'fd00::5'],
];
const refused: Row[] = [
  ['evil.example', '127.0.0.1'], ['evil.example:9876', '127.0.0.1'],
  ['localhost.evil.example', '127.0.0.1'], ['127.0.0.1.nip.io:9876', '127.0.0.1'],
  ['localhost.', '127.0.0.1'], ['sub.localhost', '127.0.0.1'], ['LOCALHOST.:9876', '127.0.0.1'],
  ['10.0.0.5:9876', '127.0.0.1'], ['172.26.208.1:9876', '127.0.0.1'], ['[fd00::5]', '::1'],
  ['10.0.0.5', undefined], ['172.26.208.2:9876', '::ffff:172.26.208.1'],
  ['', '127.0.0.1'], [' ', '127.0.0.1'],
  ['127.0.0.1:', '127.0.0.1'], ['127.0.0.1:abc', '127.0.0.1'], ['127.0.0.1:0', '127.0.0.1'], ['127.0.0.1:65536', '127.0.0.1'],
  ['user@127.0.0.1', '127.0.0.1'], ['127.0.0.1/x', '127.0.0.1'],
  ['::1', '::1'], ['[::1', '::1'], ['[::1]x', '::1'],
  ['127.1', '127.0.0.1'], ['0x7f.0.0.1', '127.0.0.1'], ['2130706433', '127.0.0.1'],
  ['[fe80::1%eth0]', 'fe80::1'],
];
describe('isAllowedHealthHost', () => {
  it.each(allowed)('allows Host %j on local address %j', (host, localAddress) => {
    expect(isAllowedHealthHost(host, localAddress)).toBe(true);
  });
  it.each(refused)('refuses Host %j on local address %j', (host, localAddress) => {
    expect(isAllowedHealthHost(host, localAddress)).toBe(false);
  });
});

// B. The real handler, over a real `_run`. SIGTERM cleanup is POSIX-only (see gotcha-daemon-subprocess-tests).
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function freePort(): Promise<number> {
  for (;;) {
    const probe = net.createServer();
    const port = await within(new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as net.AddressInfo).port));
    }));
    await within(new Promise<void>(resolve => probe.close(() => resolve())));
    if (port !== 9876) return port;
  }
}

interface Reply { status: number; headers: Record<string, string>; body: string; text: string }
// HTTP/1.1 replies come back chunked; HTTP/1.0 ones do not.
function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = body.indexOf('\r\n', at);
    const size = eol < 0 ? 0 : parseInt(body.subarray(at, eol).toString('latin1'), 16);
    if (!(size > 0)) return Buffer.concat(parts);
    parts.push(body.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}
// Raw bytes, so each row controls the Host header exactly (including sending none).
async function raw(port: number, request: string, ms = 3000): Promise<Reply> {
  const socket = net.connect({ host: '127.0.0.1', port });
  try {
    const bytes = await within(new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.setTimeout(ms, () => socket.destroy(new Error('socket timeout')));
      socket.on('connect', () => socket.write(request));
      socket.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      socket.on('error', reject);
      socket.on('close', () => resolve(Buffer.concat(chunks)));
    }), ms + 1000);
    const split = bytes.indexOf('\r\n\r\n');
    const lines = bytes.subarray(0, split).toString('latin1').split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const payload = bytes.subarray(split + 4);
    const body = (headers['transfer-encoding'] === 'chunked' ? dechunk(payload) : payload).toString('utf8');
    return { status: Number(lines[0].split(' ')[1]), headers, body, text: bytes.toString('utf8') };
  } finally { socket.destroy(); }
}
const get = (target: string, host?: string, version = '1.1') =>
  `GET ${target} HTTP/${version}\r\n${host === undefined ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`;

describe.skipIf(process.platform === 'win32')('GET /health Host rule on a real daemon', () => {
  let root = '';
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> = Promise.resolve();
  let output = '';
  let port = 0;
  let info: DaemonInfo;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-health-host-'));
    daemon.initProject(root);
    port = await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MOE_|GIT_)/i.test(key)));
    Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root, NODE_ENV: 'production',
      MOE_RUNNER_KEY_DIR: path.join(root, 'keys'), MOE_ACCOUNTS_FILE: path.join(root, 'accounts.json') });
    const args = [fileURLToPath(import.meta.resolve('tsx/cli')), fileURLToPath(new URL('../index.ts', import.meta.url)),
      '_run', '--project', root, '--port', String(port), '--host', '127.0.0.1'];
    const spawned = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = spawned;
    for (const stream of [spawned.stdout, spawned.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
    exited = new Promise(resolve => { spawned.once('exit', resolve); spawned.once('error', resolve); });
    const infoFile = path.join(root, '.moe', 'daemon.json');
    const deadline = Date.now() + 25000;
    for (;;) {
      if (spawned.exitCode !== null || spawned.signalCode !== null || Date.now() > deadline) throw new Error(`daemon not ready: ${output}`);
      try {
        info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as DaemonInfo;
        if ((await raw(port, get('/health', `127.0.0.1:${port}`))).status === 200) return;
      } catch { /* not written or not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, 40000);

  afterAll(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await within(exited, 10000);
    } catch {
      if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await within(exited, 5000).catch(() => undefined);
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it.each([
    ['the loopback literal', (p: number) => `127.0.0.1:${p}`],
    ['localhost', (p: number) => `localhost:${p}`],
  ])('answers 200 with the health JSON to %s', async (_name, hostFor) => {
    const reply = await raw(port, get('/health', hostFor(port)));
    expectHealthy(reply);
  });

  it('answers 200 with the health JSON to a request with no Host header', async () => {
    const reply = await raw(port, get('/health', undefined, '1.0'));
    expectHealthy(reply);
  });

  it.each([
    ['a foreign name with the port', (p: number) => `evil.example:${p}`],
    ['a foreign IP literal', (p: number) => `10.0.0.5:${p}`],
    ['a name that starts with localhost', () => 'localhost.evil.example'],
  ])('answers 403 Forbidden and no JSON to %s', async (_name, hostFor) => {
    const host = hostFor(port);
    const reply = await raw(port, get('/health', host));
    expect(reply.status).toBe(403);
    expect(reply.headers['content-type']).toBe('text/plain');
    expect(reply.body).toBe('Forbidden');
    for (const leak of ['projectPath', '"pid"', root, host]) expect(reply.text).not.toContain(leak);
  });

  it('keeps the daemon CLI probe working against the spawned daemon', async () => {
    expect(await daemon.probeDaemonHealth(info, root, 2000)).toBe(true);
  });

  it.each([
    ['a loopback Host', get('/other', '127.0.0.1')],
    ['a foreign Host', get('/other', 'evil.example')],
    ['an absolute-form target naming another host', get('http://evil.example/health', 'evil.example')],
  ])('still answers 426 Upgrade Required to a request other than /health with %s', async (_name, request) => {
    const reply = await raw(port, request);
    expect(reply.status).toBe(426);
    expect(reply.headers['content-type']).toBe('text/plain');
    expect(reply.body).toBe('Upgrade Required');
  });

  function expectHealthy(reply: Reply): void {
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json');
    const body = JSON.parse(reply.body) as Record<string, unknown>;
    expect(body.status).toBe('healthy');
    expect(body.pid).toBe(info.pid);
    expect(daemon.isSameProjectPath(String(body.projectPath), root)).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['status', 'projectPath', 'pid', 'version', 'uptime', 'stats', 'checks']));
    expect(Array.isArray(body.checks)).toBe(true);
  }
});

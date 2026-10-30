import { afterEach, expect, it, vi } from 'vitest';
import http from 'http';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { resolveBindHosts, listenOnHosts, WSL_BIND_HOST } from './bindHosts.js';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { McpAdapter } from './McpAdapter.js';
import { StateManager } from '../state/StateManager.js';
import * as daemon from '../index.js';
import type { DaemonInfo } from '../types/schema.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  vi.restoreAllMocks();
  expect(errors).toEqual([]);
});

async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const entry = (address: string, family: string | number = 'IPv4', internal = false) =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
const adapters = {
  'vEthernet (WSL)': [entry('172.20.48.1'), entry('fe80::1', 'IPv6'), entry('127.0.0.3', 'IPv4', true)],
  'vEthernet (WSL (Hyper-V firewall))': [entry('172.29.0.1'), entry('172.20.48.1')],
  Ethernet: [entry('192.168.1.5')], 'Loopback Pseudo-Interface 1': [entry('127.0.0.1', 'IPv4', true)],
};
it.each([
  ['NAT adapters in order', 'wsl', adapters, ['127.0.0.1', '172.20.48.1', '172.29.0.1']],
  ['numeric family and case-insensitive adapter', 'wsl', { 'VETHERNET (wsl)': [entry('172.29.0.1', 4)] }, ['127.0.0.1', '172.29.0.1']],
  ['no adapter', 'wsl', { Ethernet: adapters.Ethernet }, ['127.0.0.1']],
  ['empty map', 'wsl', {}, ['127.0.0.1']],
  ['missing entries', 'wsl', { 'vEthernet (WSL)': undefined }, ['127.0.0.1']],
  ['unsafe addresses', 'wsl', { 'vEthernet (WSL)': [entry('0.0.0.0'), entry('::'), entry(''), entry('127.0.0.1')] }, ['127.0.0.1']],
  ...['127.0.0.1', '0.0.0.0', '::', '::1', 'WSL', '192.168.1.5'].map(host => ['literal host', host, adapters, [host]]),
] as [string, string, NodeJS.Dict<os.NetworkInterfaceInfo[]>, string[]][])(
  'R: %s (%s)', (_name, host, interfaces, expected) => {
    expect(WSL_BIND_HOST).toEqual('wsl');
    expect(resolveBindHosts(host, interfaces)).toEqual(expected);
  },
);

function server(handler?: http.RequestListener): http.Server {
  const result = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  result.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await within(new Promise<void>(resolve => result.close(() => resolve())));
  });
  return result;
}
const portOf = (s: http.Server) => (s.address() as net.AddressInfo).port;
const listen = (s: http.Server, host: string, port = 0) => within(new Promise<void>((resolve, reject) => {
  s.once('error', reject); s.listen(port, host, resolve);
}));
const close = (s: http.Server) => within(new Promise<void>((resolve, reject) => {
  s.close(error => error ? reject(error) : resolve());
}));
const canBindAdapter = await (async () => {
  const s = http.createServer();
  try { await listen(s, '127.0.0.2'); return true; }
  catch { return false; }
  finally { await new Promise<void>(resolve => s.close(() => resolve())); }
})();

function health(host: string, port: number): Promise<{ status: number | undefined; body: string }> {
  return within(new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/health', agent: false, timeout: 2000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    cleanups.push(() => req.destroy());
  }));
}
function upgrade(host: string, port: number, origin?: string): Promise<number> {
  return within(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}/mcp`, { origin, handshakeTimeout: 2000 });
    cleanups.push(() => ws.terminate());
    ws.on('error', reject);
    ws.once('open', () => { resolve(101); ws.close(); });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
  }));
}
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-bind-hosts-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  daemon.initProject(root);
  return root;
}

it.skipIf(!canBindAdapter)('L: resolved addresses share HTTP, MCP and the Origin rule, then all close', async () => {
  const root = project();
  const state = new StateManager({ projectPath: root });
  await state.load();
  const handler: http.RequestListener = (_req, res) => { res.end('shared health'); };
  const primary = server(handler);
  const ws = new MoeWebSocketServer(primary, state, new McpAdapter(state));
  const hosts = resolveBindHosts('wsl', { 'vEthernet (WSL)': [entry('127.0.0.2')] });
  let servers = [primary];
  cleanups.push(async () => {
    await within(ws.close());
    await within(Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve())))));
  });
  servers = await listenOnHosts(primary, hosts, 0, handler);
  const port = portOf(primary);
  expect(servers.map(s => s.address())).toEqual([
    { address: '127.0.0.1', family: 'IPv4', port }, { address: '127.0.0.2', family: 'IPv4', port },
  ]);
  for (const host of ['127.0.0.1', '127.0.0.2']) {
    expect(await health(host, port)).toEqual({ status: 200, body: 'shared health' });
    expect(await upgrade(host, port)).toEqual(101);
    expect(await upgrade(host, port, 'https://example.com')).toEqual(403);
  }
  await within(ws.close());
  await Promise.all(servers.map(close));
  for (const host of hosts) await expect(health(host, port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

it('L-fail: a failed second bind rolls back the primary', async () => {
  const primary = server();
  let port = 0;
  primary.once('listening', () => { port = portOf(primary); });
  await expect(within(listenOnHosts(primary, ['127.0.0.1', '192.0.2.1'], 0, () => {})))
    .rejects.toThrow('192.0.2.1');
  expect(primary.listening).toEqual(false);
  await expect(health('127.0.0.1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

it('L-socket: rollback closes connections accepted during startup', async () => {
  const primary = server();
  const extra = server();
  vi.spyOn(http, 'createServer').mockReturnValueOnce(extra);
  vi.spyOn(extra, 'listen').mockImplementation(() => {
    const socket = net.connect(portOf(primary), '127.0.0.1');
    socket.on('error', () => {}); // Rollback may reset this intentionally idle connection.
    cleanups.push(() => socket.destroy());
    primary.once('connection', () => setImmediate(() => extra.emit('error', new Error('bind failed'))));
    return extra;
  });
  await expect(within(listenOnHosts(primary, ['127.0.0.1', '192.0.2.1'], 0, () => {})))
    .rejects.toThrow('192.0.2.1');
  expect(primary.listening).toEqual(false);
});

it('L-invalid: invalid arguments reject asynchronously without a wildcard listener', async () => {
  const primary = server();
  await expect(listenOnHosts(primary, [], 0, () => {})).rejects.toThrow();
  await expect(listenOnHosts(primary, ['127.0.0.1'], -1, () => {})).rejects.toThrow('127.0.0.1');
  expect(primary.listening).toEqual(false);
});

it.skipIf(!canBindAdapter)('L-port: selection skips a port held only on the extra address', async () => {
  const held = server();
  await listen(held, '127.0.0.2');
  const port = portOf(held);
  expect(await daemon.findAvailablePort(port, '127.0.0.1')).toEqual(port);
  const selected = await daemon.findAvailablePort(port, ['127.0.0.1', '127.0.0.2']);
  expect(selected > port).toEqual(true);
  expect(await daemon.isPortAvailable(selected, '127.0.0.2')).toEqual(true);
});

function spawnDaemon(root: string, mode: string, port: number) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MOE_|GIT_)/i.test(key)));
  Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
    NODE_ENV: 'production', MOE_RUNNER_KEY_DIR: path.join(root, 'keys'), MOE_ACCOUNTS_FILE: path.join(root, 'accounts.json') });
  if (mode !== 'default') env.MOE_BIND_HOST = mode === 'flag' ? '0.0.0.0' : 'wsl';
  const preload = mode === 'interfaces throw' ? 'import os from "node:os";os.networkInterfaces=()=>{throw new Error("interfaces unavailable")};'
    : mode === 'listen fails' ? 'import http from "node:http";http.Server.prototype.listen=function(){queueMicrotask(()=>this.emit("error",new Error("bind failed")));return this;};'
    : mode === 'multi' ? `import os from "node:os";import http from "node:http";
      os.networkInterfaces=()=>(${JSON.stringify({ 'vEthernet (WSL)': [entry('127.0.0.2')] })});
      const close=http.Server.prototype.close;http.Server.prototype.close=function(...args){
        if(this.address())console.log('CLOSE:'+this.address().address);return close.apply(this,args);};` : '';
  const preloader = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const args = [fileURLToPath(import.meta.resolve('tsx/cli')), ...preloader,
    fileURLToPath(new URL('../index.ts', import.meta.url)), '_run', '--project', root, '--port', String(port)];
  if (mode === 'flag') args.push('--host', 'wsl');
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-5000); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await within(exited, 10000); }
    catch { if (child.pid) process.kill(-child.pid, 'SIGKILL'); await within(exited); }
  });
  return { child, exited, output: () => output };
}

async function childDaemon(root: string, mode: string, port: number) {
  const { child, exited, output } = spawnDaemon(root, mode, port);
  const infoFile = path.join(root, '.moe', 'daemon.json');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(infoFile)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(output());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { child, exited, output, infoFile, info: JSON.parse(fs.readFileSync(infoFile, 'utf8')) as DaemonInfo };
}

// Windows kills rather than dispatches SIGTERM, and killing tsx alone orphans its child.
// These process rows require POSIX signals; R/L still cover the Windows bind logic.
const posixIt = it.skipIf(process.platform === 'win32');
posixIt.each(['flag', 'env', 'interfaces throw', 'default'])('D: %s starts, probes on loopback and shuts down', async mode => {
  const root = project();
  const reservation = server();
  await listen(reservation, '127.0.0.1');
  const port = portOf(reservation);
  await close(reservation);
  const { child, exited, infoFile, info } = await childDaemon(root, mode, port);
  // daemon.json omits the default bind; /health always reports the token the daemon listens with.
  expect(Object.hasOwn(info, 'bindHost')).toEqual(mode !== 'default');
  expect(info.bindHost).toEqual(mode === 'default' ? undefined : 'wsl');
  expect(info.port).toEqual(port);
  const response = await health('127.0.0.1', port);
  expect(response.status).toEqual(200);
  const body = JSON.parse(response.body);
  expect(Object.keys(body)).toEqual(['status', 'version', 'pid', 'uptime', 'projectPath', 'stats', 'checks', 'bindHost']);
  expect(body.bindHost).toEqual(mode === 'default' ? '127.0.0.1' : 'wsl');
  expect(body.pid).toEqual(info.pid);
  expect(await daemon.probeDaemonHealth(info, root, 2000)).toEqual(true);
  expect(await daemon.validateDaemonInfoForProject(root, info)).toEqual({ valid: true, info });
  // Pre-symbolic daemon.json files still take the existing loopback probe route.
  for (const bindHost of [undefined, '0.0.0.0', '::']) {
    expect(await daemon.probeDaemonHealth({ ...info, bindHost }, root, 2000)).toEqual(true);
  }
  child.kill('SIGTERM');
  await within(exited, 10000);
  expect(fs.existsSync(infoFile)).toEqual(false);
  expect(fs.existsSync(path.join(root, '.moe', 'daemon.lock'))).toEqual(false);
  await expect(health('127.0.0.1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}, 25000);

it.skipIf(!canBindAdapter || process.platform === 'win32')('D-multi: real shutdown closes the extra listener too', async () => {
  const root = project();
  const reservation = server();
  await listen(reservation, '127.0.0.1');
  const port = portOf(reservation);
  await close(reservation);
  const { child, exited, output, info } = await childDaemon(root, 'multi', port);
  expect((await health('127.0.0.2', info.port)).status).toEqual(200);
  expect(await upgrade('127.0.0.2', info.port, 'https://example.com')).toEqual(403);
  child.kill('SIGTERM');
  await within(exited, 10000);
  expect(output().split('\n').filter(line => line.startsWith('CLOSE:'))).toEqual(['CLOSE:127.0.0.1', 'CLOSE:127.0.0.2']);
  for (const host of ['127.0.0.1', '127.0.0.2']) {
    await expect(health(host, info.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  }
}, 25000);

posixIt('D-fail: a final listen failure releases the startup lock', async () => {
  const root = project();
  const reservation = server();
  await listen(reservation, '127.0.0.1');
  const port = portOf(reservation);
  await close(reservation);
  const { exited } = spawnDaemon(root, 'listen fails', port);
  expect(await within(exited, 15000)).toEqual(1);
  for (const name of ['daemon.json', 'daemon.lock']) expect(fs.existsSync(path.join(root, '.moe', name))).toEqual(false);
  await expect(health('127.0.0.1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}, 20000);

// Real built daemon + MCP proxy, fresh project, no agent account or IDE required.
// First build packages/moe-daemon and packages/moe-proxy, then run:
// node scripts/tests/onboarding.mjs [extracted IDE bundle directory]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = process.argv[2] && path.resolve(process.argv[2]);
const daemonEntry = bundle ? path.join(bundle, 'daemon/index.js') : path.join(root, 'packages/moe-daemon/dist/index.js');
const proxyEntry = bundle ? path.join(bundle, 'proxy/index.js') : path.join(root, 'packages/moe-proxy/dist/index.js');
const manifest = bundle ? path.join(bundle, 'daemon/package.json') : path.join(root, 'packages/moe-daemon/package.json');
const expectedVersion = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
assert.ok(fs.existsSync(daemonEntry), 'Build moe-daemon first');
assert.ok(fs.existsSync(proxyEntry), 'Build moe-proxy first');
const require = createRequire(proxyEntry);
const WebSocket = require('ws');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-onboarding-'));
const project = path.join(scratch, 'project with spaces');
const profile = path.join(scratch, 'profile');
fs.mkdirSync(project);
fs.mkdirSync(profile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOE_')));
Object.assign(env, { HOME: profile, USERPROFILE: profile, NODE_ENV: 'production', LOG_LEVEL: 'warn' });
let daemon;
let proxy;
let board;
let diagnostics = '';
function capture(stream, label) {
  stream.on('data', chunk => { diagnostics = `${diagnostics}\n${label}: ${chunk}`.slice(-16000); });
}

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function start() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  daemon = spawn(process.execPath, [daemonEntry, 'init', '--project', project, '--port', String(port)],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  capture(daemon.stdout, 'daemon');
  capture(daemon.stderr, 'daemon stderr');
  let spawnError;
  daemon.once('error', error => { spawnError = error; });
  return until(async () => {
    if (spawnError) throw spawnError;
    assert.equal(daemon.exitCode, null, 'Daemon exited before becoming healthy');
    const infoPath = path.join(project, '.moe/daemon.json');
    if (!fs.existsSync(infoPath)) return false;
    let info;
    try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch { return false; }
    assert.equal(path.resolve(info.projectPath), project);
    let response;
    try { response = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1000) }); }
    catch { return false; }
    if (!response.ok) return false;
    const health = await response.json();
    assert.equal(health.version, expectedVersion, 'Health must report the installed package version');
    return info;
  }, 'fresh daemon health');
}

function connectProxy() {
  proxy = spawn(process.execPath, [proxyEntry], {
    env: { ...env, MOE_PROJECT_PATH: project }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  capture(proxy.stderr, 'proxy stderr');
  let sequence = 0;
  let proxyFailure;
  const pending = new Map();
  createInterface({ input: proxy.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch (error) { fail(error); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${request.label}: ${JSON.stringify(message.error)}`));
    else request.resolve(message.result);
  });
  const fail = error => {
    proxyFailure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  proxy.on('error', fail);
  proxy.on('exit', code => fail(new Error(`Proxy exited: ${code}`)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    if (proxyFailure) { reject(proxyFailure); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer, label: params.name || method });
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function stop() {
  if (board) { board.terminate(); board = undefined; }
  try {
    if (proxy) {
      const current = proxy;
      proxy = undefined;
      if (current.exitCode === null && current.signalCode === null) {
        current.kill();
        await until(() => current.exitCode !== null || current.signalCode !== null, 'proxy stop');
      }
    }
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      execFileSync(process.execPath, [daemonEntry, 'stop', '--project', project],
        { env, windowsHide: true, timeout: 15_000, stdio: 'pipe' });
      await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 'supervisor stop');
    }
  }
}

try {
  const info = await start();
  const rpc = connectProxy();
  const initialized = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'onboarding-smoke', version: '1.0.0' },
  });
  assert.ok(initialized.serverInfo.name);
  assert.equal(initialized.serverInfo.version, expectedVersion, 'MCP must report the installed package version');
  if (!bundle) {
    const configPath = path.join(profile, '.moe/config.json');
    assert.ok(fs.existsSync(configPath), 'Source initialization must register this installation');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).version, expectedVersion);
  }
  const tools = await rpc('tools/list');
  assert.ok(tools.tools.some(tool => tool.name === 'moe.create_task'));
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name: `moe.${name}`, arguments: args });
    assert.ok(!result.isError, `Tool failed: ${name}`);
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const { epic } = await call('create_epic', { title: 'First project' });
  const { task } = await call('create_task', {
    epicId: epic.id, title: 'Document the project', definitionOfDone: ['README describes the project'],
  });
  assert.equal(task.status, 'BACKLOG');
  await call('set_task_status', { taskId: task.id, status: 'PLANNING' });
  const { team } = await call('create_team', { name: 'First architect', role: 'architect' });
  await call('join_team', { teamId: team.id, workerId: 'onboarding-architect' });
  const claim = await call('claim_next_task', {
    workerId: 'onboarding-architect', statuses: ['PLANNING'], taskId: task.id,
  });
  assert.equal(claim.task.id, task.id);
  await call('get_context', { taskId: task.id, workerId: 'onboarding-architect' });
  await call('submit_plan', { taskId: task.id, workerId: 'onboarding-architect', steps: [{
    description: 'Write project overview', affectedFiles: ['README.md'], newFiles: ['README.md'],
  }] });
  let context = await call('get_context', { taskId: task.id });
  assert.equal(context.task.status, 'AWAITING_APPROVAL', 'CONTROL must wait for approval');
  board = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
  await once(board, 'open');
  board.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: task.id } }));
  await until(async () => {
    context = await call('get_context', { taskId: task.id });
    return context.task.status === 'WORKING';
  }, 'board approval');
  const doctor = execFileSync(process.execPath, [daemonEntry, 'doctor', '--project', project],
    { env, windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  assert.ok(doctor.length > 0);
  await stop();
  await start();
  const restarted = connectProxy();
  const result = await restarted('tools/call', { name: 'moe.get_context', arguments: { taskId: task.id } });
  const persisted = JSON.parse(result.content.find(item => item.type === 'text').text);
  assert.equal(persisted.task.id, task.id);
  assert.equal(persisted.task.status, 'WORKING');
  console.log('PASS onboarding: fresh init, health, MCP, epic/task, architect claim, plan approval, doctor, restart persistence');
} catch (error) {
  console.error('Fixture daemon/proxy diagnostics:', diagnostics || '(none)');
  throw error;
} finally {
  await stop();
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('moe-onboarding-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}

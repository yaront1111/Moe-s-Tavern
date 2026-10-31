// One absolute Multipass client per platform, used by every local-runner entry point (task 92307adc). Windows libuv
// looks a bare `multipass` up in the current directory first (.com, then .exe), and POSIX does through a relative PATH
// entry, so MX9 plants one there and shows that no entry point runs it. A caller-named executable always wins.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runAgentJob } from '../local-runner/agent-lifecycle.mjs';
import { certifySnapshot } from '../local-runner/certify-bridge.mjs';
import { CANARY_CHECK } from '../local-runner/certify-canary.mjs';
import { certifyCore } from '../local-runner/certify.mjs';
import { runCheckJob } from '../local-runner/check-lifecycle.mjs';
import { runCli } from '../local-runner/cli.mjs';
import { runDoctor } from '../local-runner/doctor.mjs';
import { createLedger } from '../local-runner/lifecycle.mjs';
import { nativeSmokeCore } from '../local-runner/native-smoke.mjs';
import { linuxPlatform } from '../local-runner/platform-linux.mjs';
import { macosPlatform } from '../local-runner/platform-macos.mjs';
import { windowsPlatform } from '../local-runner/platform-windows.mjs';
import { provisionGuest } from '../local-runner/provision.mjs';
import { runVmControl } from '../local-runner/vm-control.mjs';

const windowsPin = root => path.win32.join(/^[A-Za-z]:\\/.test(root ?? '') ? root : 'C:\\Program Files', 'Multipass', 'bin', 'multipass.exe');
const PIN = Object.freeze({ linux: '/snap/bin/multipass', darwin: '/usr/local/bin/multipass', win32: windowsPin(process.env.ProgramFiles) });
const PLATFORMS = [linuxPlatform, macosPlatform, windowsPlatform];
const IDS = ['linux', 'darwin', 'win32'];
const EXPLICIT = '/opt/explicit/multipass';
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const owner = { taskId: 'task-0123abcd', attemptId: 'attempt-4567ef', generation: 3 };
const NAME = `moe-vm-${'ab'.repeat(10)}`;
const ACQUIRED = '2026-10-31T06:00:00.000Z';
const STUBS = {
  linux: { statDevice: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, statfs: async () => { throw new Error('absent'); },
    cpus: () => 1, freemem: () => 0, homedir: () => '/home/u', host: { platform: 'linux', arch: 'x64' } },
  darwin: { probe: async () => ({ driver: 'qemu' }), host: { platform: 'darwin', arch: 'x64' } },
  win32: { hypervisor: async () => true, host: { platform: 'win32', arch: 'x64' } },
};

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-pinned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** fn() with process.platform reading id; the descriptor is restored on every path. */
async function asPlatform(id, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...saved, value: id });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', saved); }
}
/** run and spawn transports that record each executable and fail like a missing client. */
function failing() {
  const seen = [];
  const missing = executable => { seen.push(executable); return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  return { seen, run: async executable => { throw missing(executable); }, spawn: executable => { throw missing(executable); } };
}
/** A prerequisites gate that records the executable it is handed and is never ready. */
function notReady() {
  const seen = [];
  return { seen, prerequisites: async options => { seen.push(options?.provider?.executable); return { ready: false, prerequisites: [] }; } };
}
const notFound = name => Object.assign(new Error('gone'), { code: 2, stderr: `info failed: The following errors occurred:\ninstance "${name}" does not exist` });
/** A real R06 ledger holding one 'owned' record. */
async function ownedLedger(t) {
  const ledger = createLedger(scratch(t), { random: size => Buffer.alloc(size, 0xab) });
  const record = await ledger.reserve(owner);
  await ledger.update(await ledger.update(record, { phase: 'launching', launchTries: 1 }), { phase: 'owned' });
  return { ledger, name: record.instance };
}
// The daemon reports another open attempt (so ours is closed) and no lease: cleanup may delete.
const daemon = async tool => (tool === 'moe.list_resources' ? { resources: [] } : { servedContext: { attemptId: 'attempt-other', receiptStatus: 'no-session' } });
const granted = async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, granted: true, resourceId: NAME,
  lease: { taskId: owner.taskId, workerId: 'worker-1', acquiredAt: ACQUIRED } }) }] });
function agentInput(daemonInfoPath, provider, forwarded = []) {
  return { name: NAME, binding: { role: 'worker', workerId: 'worker-1', ...owner },
    job: { cli: 'claude', credential: { name: 'ANTHROPIC_API_KEY', value: 'sk-mx8-agent'.padEnd(32, 'k') } }, daemonInfoPath,
    forward: async tool => { forwarded.push(tool); return granted(); }, onOutput: () => {}, onObservation: () => {}, sleep: async () => {},
    timeoutMs: 1_000, ...(provider === undefined ? {} : { provider }) };
}

test('MX0 the CI local-runner step runs this file once', () => {
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const [, run] = /\n *- name: Test local runner prerequisite bundles\n *(run: [^\n]*)/.exec(ci);
  assert.equal(run.split(' ').filter(file => file === 'scripts/tests/local-runner-pinned-client.test.mjs').length, 1);
});

test('MX1 each platform module pins one absolute client, Windows under a drive-absolute ProgramFiles, and no other module names one', async () => {
  assert.deepEqual([linuxPlatform.executable, macosPlatform.executable, windowsPlatform.executable], [PIN.linux, PIN.darwin, PIN.win32]);
  assert.deepEqual([Object.isFrozen(windowsPlatform), Object.keys(windowsPlatform)], [true, ['id', 'arch', 'executable', 'prerequisites']]);
  const saved = process.env.ProgramFiles;
  try {
    for (const [index, [root, expected]] of [['D:\\Apps', 'D:\\Apps\\Multipass\\bin\\multipass.exe'], [undefined, 'C:\\Program Files\\Multipass\\bin\\multipass.exe'],
      ['relative\\dir', 'C:\\Program Files\\Multipass\\bin\\multipass.exe'], ['\\\\server\\share', 'C:\\Program Files\\Multipass\\bin\\multipass.exe']].entries()) {
      if (root === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = root;
      const { windowsPlatform: fresh } = await import(`../local-runner/platform-windows.mjs?mx1=${index}`);
      assert.equal(fresh.executable, expected, `ProgramFiles ${root}`);
    }
  } finally { if (saved === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = saved; }
  const dir = fileURLToPath(new URL('../local-runner/', import.meta.url));
  const naming = needle => readdirSync(dir).filter(file => file.endsWith('.mjs') && readFileSync(path.join(dir, file), 'utf8').includes(needle));
  assert.deepEqual(['/snap/bin/multipass', '/usr/local/bin/multipass', 'multipass.exe'].map(naming),
    [['platform-linux.mjs'], ['platform-macos.mjs'], ['platform-windows.mjs']]);
});

test('MX2 each platform module hands its doctor its own pin, unless the caller names an executable', async () => {
  for (const platform of PLATFORMS) {
    for (const [provider, expected] of [[{}, PIN[platform.id]], [{ executable: EXPLICIT }, EXPLICIT]]) {
      const seen = [];
      const doctor = async options => { seen.push(options.executable); return { providerReady: false, code: 'PROVIDER_NOT_FOUND' }; };
      await platform.prerequisites({ ...STUBS[platform.id], provider: { ...provider, run: failing().run }, doctor });
      assert.deepEqual(seen, [expected], `${platform.id} ${JSON.stringify(provider)}`);
    }
  }
});

test('MX3 cli doctor passes this host platform pin, --executable wins, and an unsupported host refuses before any spawn', async () => {
  const doctorOf = seen => async options => { seen.push(options); return { providerReady: false }; };
  for (const id of IDS) {
    for (const [argv, expected] of [[['doctor'], { executable: PIN[id] }], [['doctor', '--executable', EXPLICIT], { executable: EXPLICIT }]]) {
      const seen = [];
      const code = await asPlatform(id, () => runCli(argv, { doctor: doctorOf(seen), write: () => {} }));
      assert.deepEqual([code, seen], [2, [expected]], `${id} ${argv.join(' ')}`);
    }
  }
  const [seen, transport] = [[], failing()];
  await asPlatform('aix', () => runCli(['doctor'], { doctor: doctorOf(seen), write: () => {} }));
  assert.deepEqual(seen, [{ executable: undefined }]);
  const report = await asPlatform('aix', () => runDoctor({ ...seen[0], run: transport.run }));
  assert.deepEqual([report.code, transport.seen], ['HOST_UNSUPPORTED', []]);
});

test('MX4 provisioning and the native smoke hand each platform pin to its prerequisites and spawn nothing when unready', async t => {
  for (const platform of PLATFORMS) {
    const [gate, smokeGate, transport, reserved] = [notReady(), notReady(), failing(), []];
    const result = await provisionGuest({ platform: { ...platform, prerequisites: gate.prerequisites }, ledger: { reserve: async who => { reserved.push(who); } },
      owner, cacheDir: path.join(scratch(t), 'images'), supervisor: Buffer.from('#!/bin/sh\n'), credential: Buffer.alloc(32, 1), provider: { run: transport.run } });
    const smoke = await nativeSmokeCore({ platform: { ...platform, prerequisites: smokeGate.prerequisites }, workDir: scratch(t),
      deps: { provider: { run: transport.run, spawn: transport.spawn } } });
    assert.deepEqual([result.provisioned, smoke.result, smoke.cleanup, gate.seen, smokeGate.seen, transport.seen, reserved],
      [false, 'blocked', 'none', [PIN[platform.id]], [PIN[platform.id]], [], []], platform.id);
  }
});

test('MX5 runCheckJob provisions and deletes its VM through each platform pin', async t => {
  for (const platform of PLATFORMS) {
    const seen = [];
    const ledger = { read: async () => ({}), reserve: async () => ({ instance: NAME }), update: async () => ({}), recordImage: async () => ({}) };
    const provision = async ({ ledger: own, owner: who, provider }) => {
      seen.push(['provision', provider.executable]);
      const { instance } = await own.reserve(who);
      return { provisioned: true, instance, bootstrapReady: true, failures: [], image: { source: { arch: 'x64', sha256: 'a'.repeat(64) } } };
    };
    const remove = async ({ provider }) => { seen.push(['remove', provider.executable]); return 'deleted'; };
    const toolchain = async () => { throw Object.assign(new Error('offline'), { code: 'TOOLCHAIN_FETCH_FAILED' }); };
    const result = await runCheckJob({ platform, ledger, owner, cacheDir: scratch(t), supervisor: Buffer.from('#!/bin/sh\n'), credential: Buffer.alloc(32, 1),
      snapshot: certifySnapshot(), check: CANARY_CHECK, budgetMs: 60_000, onReady: async () => {}, dependencies: [] }, { provision, remove, toolchain });
    assert.deepEqual([result.vm, result.failure, seen], ['deleted', 'TOOLCHAIN_FETCH_FAILED',
      [['provision', PIN[platform.id]], ['remove', PIN[platform.id]]]], platform.id);
  }
});

test('MX6 certify hands each platform pin to its doctor and prerequisites, and an injected run never certifies', async t => {
  for (const platform of PLATFORMS) {
    const [gate, transport, doctored] = [notReady(), failing(), []];
    const report = await certifyCore({ platform: { ...platform, prerequisites: gate.prerequisites }, workDir: scratch(t),
      deps: { doctor: async options => { doctored.push(options); return { providerReady: false }; }, provider: { run: transport.run, spawn: transport.spawn } } });
    assert.deepEqual([report.certified, doctored, gate.seen, transport.seen], [false, [{ executable: PIN[platform.id] }], [PIN[platform.id]], []], platform.id);
  }
});

test('MX7 vm-control status, reconcile and cleanup query through this host platform pin, an explicit one wins, an unsupported host refuses first', async t => {
  for (const id of IDS) {
    for (const [executable, expected] of [[undefined, PIN[id]], [EXPLICIT, EXPLICIT]]) {
      for (const command of ['status', 'reconcile', 'cleanup']) {
        const [{ ledger, name }, seen, lines] = [await ownedLedger(t), [], []];
        const provider = { run: async file => { seen.push(file); throw notFound(name); }, ...(executable ? { executable } : {}) };
        const code = await asPlatform(id, () => runVmControl([command, '--project', scratch(t)],
          { ledger, provider, prerequisites: async () => ({ ready: false }), call: daemon, write: text => lines.push(text) }));
        assert.deepEqual([code, seen, lines.join('').includes('VM_CONTROL_FAILED')], [0, [expected], false], `${id} ${command} ${executable}`);
      }
    }
  }
  const state = scratch(t);
  const saved = process.env.MOE_RUNNER_STATE_DIR;
  process.env.MOE_RUNNER_STATE_DIR = state;
  try {
    for (const command of ['status', 'reconcile', 'cleanup']) {
      const [calls, lines] = [[], []];
      const ledger = { list: async () => { calls.push('list'); return { records: [], invalid: [] }; } };
      const deps = { provider: { run: async () => { calls.push('run'); throw new Error('unreachable'); } }, call: async () => { calls.push('call'); },
        prerequisites: async () => { calls.push('prerequisites'); return {}; }, write: text => lines.push(text) };
      for (const injected of [{ ledger }, {}]) {
        const code = await asPlatform('aix', () => runVmControl([command, '--project', scratch(t)], { ...deps, ...injected }));
        assert.deepEqual([code, lines.splice(0), calls], [0, ['{"code":"VM_CONTROL_FAILED"}\n'], []], `${command} ${Object.keys(injected)}`);
      }
    }
    assert.deepEqual(readdirSync(state), []); // no ledger directory either
  } finally { if (saved === undefined) delete process.env.MOE_RUNNER_STATE_DIR; else process.env.MOE_RUNNER_STATE_DIR = saved; }
});

test('MX8 runAgentJob sweeps through this host platform pin, an explicit one wins, and an unsupported host refuses first', async t => {
  const daemonInfoPath = path.join(scratch(t), 'daemon.json');
  for (const id of IDS) {
    for (const [executable, expected] of [[undefined, PIN[id]], [EXPLICIT, EXPLICIT]]) {
      const [transport, forwarded] = [failing(), []];
      const provider = { run: transport.run, spawn: transport.spawn, ...(executable ? { executable } : {}) };
      const result = await asPlatform(id, () => runAgentJob(agentInput(daemonInfoPath, provider, forwarded)));
      assert.deepEqual([result.failure, result.lease, transport.seen, forwarded],
        ['AGENT_TERMINATION_UNVERIFIED', 'kept', [expected], ['moe.acquire_resource']], `${id} ${executable}`);
    }
  }
  const [transport, forwarded] = [failing(), []];
  await assert.rejects(asPlatform('aix', () => runAgentJob(agentInput(daemonInfoPath, { run: transport.run, spawn: transport.spawn }, forwarded))),
    { code: 'AGENT_INPUT_INVALID' });
  assert.deepEqual([transport.seen, forwarded], [[], []]);
});

/** multipass, multipass.exe and multipass.com in dir, each appending to `ran` when run: a sh script on POSIX, and on
 * win32 a node.exe link (else copy) that NODE_OPTIONS points at mark.cjs. */
function plant(dir, ran) {
  for (const name of ['multipass', 'multipass.exe', 'multipass.com']) {
    const file = path.join(dir, name);
    if (process.platform !== 'win32') {
      writeFileSync(file, `#!/bin/sh\necho ran >> '${ran}'\n`);
      chmodSync(file, 0o755);
    } else try { linkSync(process.execPath, file); } catch { copyFileSync(process.execPath, file); }
  }
  writeFileSync(path.join(dir, 'mark.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(ran)}, 'ran\\n'); process.exit(0);\n`);
}

test('MX9 a multipass, multipass.exe or multipass.com planted in the current directory never runs', async t => {
  const dir = scratch(t);
  const ran = path.join(dir, 'ran');
  plant(dir, ran);
  const saved = { cwd: process.cwd(), PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  const unplanted = async (label, fn) => t.test(label, async () => {
    rmSync(ran, { force: true });
    await fn();
    assert.equal(existsSync(ran), false, `${label} ran the planted client`);
  });
  try {
    // NODE_OPTIONS reads a backslash inside quotes as an escape, so the path uses forward slashes.
    if (process.platform === 'win32') process.env.NODE_OPTIONS = `--require "${path.join(dir, 'mark.cjs').replaceAll('\\', '/')}"`;
    process.chdir(dir);
    process.env.PATH = `.${path.delimiter}${saved.PATH ?? ''}`; // POSIX then resolves a bare name in dir, as win32 does from the cwd
    await t.test('(a) control: a bare multipass runs the plant', () => {
      try { execFileSync('multipass', ['version'], { stdio: 'ignore' }); } catch { /* only the marker counts */ }
      assert.equal(existsSync(ran), true);
    });
    await unplanted('(b) cli doctor', async () => {
      const lines = [];
      await runCli(['doctor'], { write: text => lines.push(text) });
      assert.match(JSON.parse(lines.join('')).code, CODE);
    });
    await unplanted('(b) cli prerequisites', async () => {
      const lines = [];
      await runCli(['prerequisites'], { write: text => lines.push(text) });
      const report = JSON.parse(lines.join(''));
      assert.match(report.providerCode ?? report.code, CODE);
    });
    await unplanted('(b) vm-control status', async () => {
      const [{ ledger }, lines] = [await ownedLedger(t), []];
      assert.equal(await runVmControl(['status', '--project', scratch(t)], { ledger, prerequisites: async () => ({ ready: false }), write: text => lines.push(text) }), 0);
      const report = JSON.parse(lines.join(''));
      assert.deepEqual([report.schema, ['Unknown', 'Absent'].includes(report.instances?.[0]?.state)], ['moe-vm-status-v1', true]);
    });
    await unplanted('(b) agent job', async () => {
      const result = await runAgentJob(agentInput(path.join(dir, 'daemon.json')));
      assert.equal(result.failure, 'AGENT_TERMINATION_UNVERIFIED');
    });
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['PATH', 'NODE_OPTIONS']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

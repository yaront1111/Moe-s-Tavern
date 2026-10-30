import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadCertifiedProvider, runDoctor, validateManifest } from '../local-runner/doctor.mjs';
import { probeMultipass, MAX_PROBE_BUFFER, MAX_PROBE_TIMEOUT_MS } from '../local-runner/multipass.mjs';
import { runCli } from '../local-runner/cli.mjs';

const AGENT_TMP_ROOT = tmpdir(); // Capture before any test can redirect the temp environment.
const host = { platform: 'win32', arch: 'x64' };
const version = { multipass: '1.17.0+win', multipassd: '1.17.0+win' };
const commands = [['version', '--format', 'json'], ['get', 'local.driver'], ['get', 'client.primary-name']];
function transport({ versions = version, driver = 'hcs', primaryName = 'primary', fail, output } = {}) {
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (fail) throw fail;
    const stdout = output ?? (args[0] === 'version' ? JSON.stringify(versions) : args[1] === 'local.driver' ? driver : primaryName);
    return { stdout, stderr: '' };
  };
  return { calls, run };
}
const doctor = (overrides = {}, provider = {}) => runDoctor({ host, ...overrides, run: transport(provider).run });

test('manifest pins dated official images and client/daemon versions', async () => {
  const manifest = await loadCertifiedProvider();
  assert.deepEqual(manifest.versions, ['1.17.0']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.provider, 'multipass');
  assert.deepEqual(manifest.images, {
    x64: {
      url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img',
      sha256: '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94',
    },
    arm64: {
      url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-arm64.img',
      sha256: '50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e',
    },
  });
  assert.ok(Object.isFrozen(manifest.images.x64));
});

for (const [platform, arch, driver] of [['win32', 'x64', 'hcs'], ['linux', 'x64', 'qemu'], ['darwin', 'x64', 'qemu'], ['darwin', 'arm64', 'qemu']]) {
  test(`provider prerequisites permit declared ${platform}/${arch}/${driver}, never claim execution readiness`, async () => {
    const released = `1.17.0${platform === 'win32' ? '+win' : platform === 'darwin' ? '+mac' : ''}`;
    const result = await doctor({ host: { platform, arch } }, { driver, versions: { multipass: released, multipassd: released } });
    assert.equal(result.code, 'PROVIDER_PREREQUISITES_READY');
    assert.equal(result.providerReady, true);
    assert.equal(result.executionReady, false);
    assert.equal(result.certification, 'not-established');
    assert.equal(result.image.sha256.length, 64);
  });
}

for (const [label, versions, code] of [
  ['unknown', { multipass: '1.18.0', multipassd: '1.18.0' }, 'VERSION_UNSUPPORTED'],
  ['prerelease', { multipass: '1.17.0-rc1', multipassd: '1.17.0-rc1' }, 'VERSION_UNSUPPORTED'],
  ['unrecognized build metadata', { multipass: '1.17.0+evil', multipassd: '1.17.0+evil' }, 'VERSION_UNSUPPORTED'],
  ['wrong platform build', { multipass: '1.17.0+mac', multipassd: '1.17.0+mac' }, 'VERSION_UNSUPPORTED'],
  ['mismatched', { multipass: '1.17.0', multipassd: '1.16.4' }, 'VERSION_MISMATCH'],
  ['missing daemon', { multipass: '1.17.0' }, 'PROVIDER_OUTPUT_INVALID'],
  ['wrong shape', ['1.17.0', '1.17.0'], 'PROVIDER_OUTPUT_INVALID'],
]) {
  test(`${label} version fails closed`, async () => {
    const result = await doctor({}, { versions });
    assert.equal(result.code, code);
    assert.equal(result.providerReady, false);
    assert.equal(result.executionReady, false);
  });
}

for (const unsupported of [{ platform: 'win32', arch: 'arm64' }, { platform: 'freebsd', arch: 'x64' }, { platform: 'linux', arch: 's390x' }, null]) {
  test(`unknown host ${JSON.stringify(unsupported)} performs no provider calls`, async () => {
    const fake = transport();
    const result = await runDoctor({ host: unsupported, run: fake.run });
    assert.equal(result.code, 'HOST_UNSUPPORTED');
    assert.equal(result.providerReady, false);
    assert.equal(fake.calls.length, 0);
  });
}

for (const driver of ['hyperv', 'virtualbox', 'applevz', 'qemu']) {
  test(`Windows driver ${driver} is not silently replaced`, async () => {
    const result = await doctor({}, { driver });
    assert.equal(result.code, 'DRIVER_UNSUPPORTED');
    assert.equal(result.executionReady, false);
  });
}

for (const [label, failure, expected] of [
  ['missing executable', { code: 'ENOENT' }, 'PROVIDER_NOT_FOUND'],
  ['access denied', { code: 'EACCES' }, 'PROVIDER_ACCESS_DENIED'],
  ['unauthenticated', { code: 1, stderr: 'The client is not authenticated with the Multipass service' }, 'PROVIDER_ACCESS_DENIED'],
  ['timed out', { code: 'ETIMEDOUT', killed: true }, 'PROVIDER_TIMEOUT'],
  ['buffer exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'PROVIDER_OUTPUT_LIMIT'],
  ['nonzero exit', { code: 7, stderr: 'sensitive diagnostic secret' }, 'PROVIDER_COMMAND_FAILED'],
]) {
  test(`${label} returns a stable diagnostic without leaking raw output`, async () => {
    const result = await doctor({}, { fail: Object.assign(new Error('provider failure'), failure) });
    assert.equal(result.code, expected);
    assert.equal(result.providerReady, false);
    assert.equal(result.executionReady, false);
    assert.equal(JSON.stringify(result).includes('sensitive diagnostic secret'), false);
  });
}

for (const output of ['not json', '{}', 'null', ' '.repeat(100), '{"multipass":false,"multipassd":"1.17.0"}']) {
  test(`malformed provider output ${JSON.stringify(output).slice(0, 35)} is rejected`, async () => {
    assert.equal((await doctor({}, { output })).code, 'PROVIDER_OUTPUT_INVALID');
  });
}

test('oversized injected stdout is rejected even when transport ignores maxBuffer', async () => {
  assert.equal((await doctor({}, { output: 'x'.repeat(MAX_PROBE_BUFFER + 1) })).code, 'PROVIDER_OUTPUT_LIMIT');
  assert.equal((await doctor({}, { output: 'é'.repeat(MAX_PROBE_BUFFER / 2 + 1) })).code, 'PROVIDER_OUTPUT_LIMIT');
  const run = async () => ({ stdout: JSON.stringify(version), stderr: 'x'.repeat(MAX_PROBE_BUFFER + 1) });
  assert.equal((await runDoctor({ host, run })).code, 'PROVIDER_OUTPUT_LIMIT');
});

test('later probe failure cannot leave a successful partial prerequisite report', async () => {
  let calls = 0;
  const run = async () => {
    if (++calls === 1) return { stdout: JSON.stringify(version), stderr: '' };
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  const result = await runDoctor({ host, run });
  assert.equal(result.code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(result.providerReady, false);
  assert.equal(calls, 2);
});

test('probe uses only exact read-only argv and bounded direct execution', async () => {
  const fake = transport();
  const executable = '/trusted binaries/multipass;echo injected';
  const result = await runDoctor({ host, executable, run: fake.run });
  assert.equal(result.providerReady, true);
  assert.deepEqual(fake.calls.map(call => call.args), commands);
  for (const call of fake.calls) {
    assert.equal(call.executable, executable);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, MAX_PROBE_TIMEOUT_MS);
    assert.equal(call.options.maxBuffer, MAX_PROBE_BUFFER);
    assert.equal(call.options.killSignal, 'SIGKILL');
  }
});

test('probe rejects invalid executable before invoking transport', async () => {
  for (const executable of ['', null, 'binary\nlaunch', 'binary\0launch']) {
    const fake = transport();
    await assert.rejects(probeMultipass({ executable, run: fake.run }), error => error.code === 'PROVIDER_INPUT_INVALID');
    assert.equal(fake.calls.length, 0);
  }
});

test('primary name is bounded metadata, not a readiness bypass', async () => {
  for (const primaryName of ['', 'bad name', 'primary\nother']) {
    assert.equal((await doctor({}, { primaryName })).code, 'PROVIDER_OUTPUT_INVALID');
  }
  assert.equal((await doctor({}, { primaryName: 'my-default' })).primaryName, 'my-default');
  assert.equal((await doctor({}, { primaryName: 'p'.repeat(65) })).primaryName, 'p'.repeat(65));
  assert.equal((await doctor({}, { primaryName: '<empty>' })).primaryName, null);
});

test('manifest validation rejects invalid versions, floating images and unsupported schema', async () => {
  const original = await loadCertifiedProvider();
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.versions = ['latest']; },
    value => { value.images.x64.sha256 = 'wrong'; },
    value => { value.images.x64.url = 'https://example.com/image.img'; },
    value => { value.images.x64.url = value.images.x64.url.replace('release-20261017', 'release'); },
    value => { value.hosts[0].driver = 'arbitrary'; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateManifest(changed), error => error.code === 'MANIFEST_INVALID');
  }
  for (const value of [null, [], {}]) assert.throws(() => validateManifest(value), error => error.code === 'MANIFEST_INVALID');
});

test('manifest source is module-relative and cannot be selected through environment', async () => {
  const before = process.env.MOE_LOCAL_RUNNER_MANIFEST;
  process.env.MOE_LOCAL_RUNNER_MANIFEST = '/nonexistent/forged-provider.json';
  try { assert.equal((await doctor({ manifest: { versions: ['1.18.0'] } })).providerReady, true); }
  finally {
    if (before === undefined) delete process.env.MOE_LOCAL_RUNNER_MANIFEST;
    else process.env.MOE_LOCAL_RUNNER_MANIFEST = before;
  }
});

test('unexpected exceptions never leak paths or secret diagnostics', async () => {
  for (const code of [undefined, 'PROVIDER_COMMAND_FAILED', 'VERSION_UNSUPPORTED', 'PROVIDER_MADE_UP']) {
    const options = { get host() { throw Object.assign(new Error('/private/path contains secret-value'), { code }); } };
    const result = await runDoctor(options);
    assert.equal(result.providerReady, false);
    assert.equal(result.executionReady, false);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
    assert.equal(JSON.stringify(result).includes('/private/path'), false);
  }
});

test('CLI outputs one JSON report and distinguishes prerequisite failure', async () => {
  for (const ready of [true, false]) {
    const writes = [];
    const code = await runCli(['doctor'], { doctor: async () => ({ providerReady: ready, executionReady: false }), write: text => writes.push(text) });
    assert.equal(code, ready ? 0 : 2);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0]), { providerReady: ready, executionReady: false });
  }
});

for (const args of [[], ['launch'], ['doctor', '--manifest', 'evil'], ['doctor', '--executable'], ['doctor', '--executable', 'a', '--executable', 'b'], ['doctor', 'extra']]) {
  test(`CLI rejects ${JSON.stringify(args)} before any doctor call`, async () => {
    let calls = 0;
    const writes = [];
    const code = await runCli(args, { doctor: async () => { calls++; }, write: text => writes.push(text) });
    assert.equal(code, 2);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(writes[0]).code, 'CLI_INPUT_INVALID');
  });
}

test('real CLI entrypoint returns JSON and failure for nonexistent executable', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../local-runner/cli.mjs', import.meta.url)), 'doctor', '--executable', '/does-not-exist/multipass'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.providerReady, false);
  assert.equal(report.executionReady, false);
  assert.equal(report.code, 'PROVIDER_NOT_FOUND');
});

test('real execFile adapter cannot interpret shell-shaped executable input', async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe-provider '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'injected');
  const executable = `${path.join(scratch, 'missing')};echo bad > "${marker}"`;
  const result = await runDoctor({ host, executable });
  assert.equal(result.code, 'PROVIDER_NOT_FOUND');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false);
});

test('real source CLI reports prerequisites only with genuine process output', { skip: process.platform === 'win32' }, t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe-provider-cli '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const executable = path.join(scratch, 'provider');
  const released = `1.17.0${process.platform === 'darwin' ? '+mac' : ''}`;
  writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);\nprocess.stdout.write(args[0]==='version'?JSON.stringify({multipass:'${released}',multipassd:'${released}'}):args[1]==='local.driver'?'qemu':'primary');\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../local-runner/cli.mjs', import.meta.url)), 'doctor', '--executable', executable], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.providerReady, true);
  assert.equal(report.executionReady, false);
  assert.equal(report.certification, 'not-established');
});

test('real process output exceeding maxBuffer fails closed', { skip: process.platform === 'win32' }, async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe-provider-output '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const executable = path.join(scratch, 'provider');
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(1000000));\n`, { mode: 0o755 });
  assert.equal((await runDoctor({ host, executable })).code, 'PROVIDER_OUTPUT_LIMIT');
});

test('real hung process is killed by bounded timeout', { skip: process.platform === 'win32', timeout: MAX_PROBE_TIMEOUT_MS + 5000 }, async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe-provider-timeout '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const executable = path.join(scratch, 'provider');
  writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o755 });
  assert.equal((await runDoctor({ host, executable })).code, 'PROVIDER_TIMEOUT');
});

// CQ-R06 owned VM lifecycle
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  cleanupOwned, createLedger, deleteOwnedInstance, DELETE_TIMEOUT_MS, isOwnedInstanceName, jobLeaseResourceId,
  MAX_LAUNCH_TRIES, OWNED_NAME_PREFIX, ownedInstanceName, provisionOwned, QUERY_TIMEOUT_MS, queryOwnedInstance, reconcileOwned,
} from '../local-runner/lifecycle.mjs';

const hexOf = index => index.toString(16).padStart(2, '0');
const nameAt = index => `moe-vm-${hexOf(index).repeat(10)}`;
const FOREIGN = `moe-vm-${'f0'.repeat(10)}`;
const FOREIGNERS = [[FOREIGN, 'Running'], ['primary', 'Running']];
const owner = { taskId: 'task-0123abcd', attemptId: 'attempt-4567ef', generation: 3 };
const RECORD_KEYS = ['attemptId', 'createdAt', 'generation', 'instance', 'launchTries', 'phase', 'provider', 'schemaVersion', 'taskId', 'updatedAt'];
const infoArgs = name => ['info', name, '--format', 'json'];
const lifecycleOptions = timeout => ({ encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL' });
const noSleep = async () => assert.fail('unexpected retry sleep');
const failWith = fields => Object.assign(new Error('/private/path secret-diagnostic'), fields);

function sequence() {
  let index = 0;
  return size => Buffer.from(hexOf(++index).repeat(size), 'hex');
}

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe lifecycle '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function notFound(command, name) {
  return Object.assign(new Error('Command failed'), { code: 2, stderr: `${command} failed: The following errors occurred:\ninstance "${name}" does not exist\n` });
}

/** execFile-compatible fake implementing only `info <n> --format json` and `delete --purge <n>`. */
function fakeMultipass({ present = new Map(), script, events = [] } = {}) {
  const calls = [];
  const unexpected = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    events.push(args.join(' '));
    const override = script?.([...args], calls.length - 1);
    if (override?.error) throw override.error;
    if (override) return { stdout: override.stdout, stderr: '' };
    if (args.length === 4 && args[0] === 'info' && args[2] === '--format' && args[3] === 'json') {
      if (!present.has(args[1])) throw notFound('info', args[1]);
      return { stdout: JSON.stringify({ errors: [], info: { [args[1]]: { state: present.get(args[1]), ipv4: [] } } }), stderr: '' };
    }
    if (args.length === 3 && args[0] === 'delete' && args[1] === '--purge') {
      if (!present.delete(args[2])) throw notFound('delete', args[2]);
      return { stdout: '', stderr: '' };
    }
    unexpected.push([...args]);
    throw new Error(`unexpected provider command ${JSON.stringify(args)}`);
  };
  return { run, calls, unexpected, present, events, argv: () => calls.map(call => call.args) };
}

function harness(t, present = [], script) {
  const dir = scratch(t);
  const events = [];
  const fake = fakeMultipass({ present: new Map(present), script, events });
  return { dir, events, fake, provider: { run: fake.run }, ledger: createLedger(dir, { random: sequence() }) };
}

/** Writes a record through the ledger API only, reaching `phase` the way the lifecycle does. */
async function seed(ledger, phase, launchTries = 1, who = owner) {
  const record = await ledger.reserve(who);
  if (phase === 'reserved') return record;
  if (phase === 'collision') return ledger.update(record, { phase });
  const launching = await ledger.update(record, { phase: 'launching', launchTries });
  return phase === 'launching' ? launching : ledger.update(launching, { phase });
}

function assertScoped(fake, owned) {
  assert.deepEqual(fake.unexpected, []);
  for (const args of fake.argv()) {
    assert.equal(args.includes('--all'), false);
    assert.notDeepEqual(args, ['purge']);
    assert.equal(['list', 'stop', 'start', 'launch', 'purge'].includes(args[0]), false);
    assert.ok(owned.includes(args[0] === 'delete' ? args[2] : args[1]), `foreign name in ${JSON.stringify(args)}`);
  }
  assert.equal(fake.present.get(FOREIGN), 'Running');
  assert.equal(fake.present.get('primary'), 'Running');
}

function assertSanitized(error, code) {
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(/secret|private/.test(error.message), false);
  return true;
}

const provision = (h, overrides) => provisionOwned({ ledger: h.ledger, name: nameAt(1), owner, provider: h.provider, sleep: noSleep, ...overrides });
const phasesOf = async ledger => (await ledger.list()).records.map(record => record.phase);

test('owned instance names are random Multipass hostnames and daemon resource ids', () => {
  const source = readFileSync(fileURLToPath(new URL('../../packages/moe-daemon/src/state/resourceStore.ts', import.meta.url)), 'utf8');
  const literal = source.match(/export const RESOURCE_ID_RE = \/(.+)\/;/);
  assert.ok(literal, 'RESOURCE_ID_RE literal moved; update this drift guard');
  const resourceId = new RegExp(literal[1]);
  const names = [ownedInstanceName(), ownedInstanceName()];
  for (const name of names) {
    assert.match(name, /^moe-vm-[0-9a-f]{20}$/);
    assert.match(name, /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
    assert.match(name, resourceId);
    assert.equal(isOwnedInstanceName(name), true);
    assert.equal(jobLeaseResourceId(name), name);
  }
  assert.notEqual(names[0], names[1]);
  assert.equal(OWNED_NAME_PREFIX, 'moe-vm-');
  assert.equal(ownedInstanceName({ random: sequence() }), nameAt(1));
  assert.throws(() => ownedInstanceName({ random: () => Buffer.alloc(3) }), { code: 'LIFECYCLE_INPUT_INVALID' });
  for (const bad of ['primary', `moe-vm-${'a'.repeat(21)}`, `moe-vm-${'A'.repeat(20)}`, `x${nameAt(1)}`, null]) {
    assert.throws(() => jobLeaseResourceId(bad), { code: 'LIFECYCLE_INPUT_INVALID' });
    assert.equal(isOwnedInstanceName(bad), false);
  }
});

test('queryOwnedInstance runs only bounded info on the owned name and accepts every v1.17.0 state', async () => {
  const fake = fakeMultipass({ present: new Map([[nameAt(1), 'Running'], [nameAt(2), 'Deleted']]) });
  assert.equal(QUERY_TIMEOUT_MS, 30_000);
  assert.equal(DELETE_TIMEOUT_MS, 120_000);
  assert.deepEqual(await queryOwnedInstance(nameAt(1), { run: fake.run }), { present: true, state: 'Running' });
  assert.deepEqual(await queryOwnedInstance(nameAt(2), { run: fake.run, executable: '/opt/multi pass/multipass' }), { present: true, state: 'Deleted' });
  assert.deepEqual(fake.calls, [
    { executable: 'multipass', args: infoArgs(nameAt(1)), options: lifecycleOptions(QUERY_TIMEOUT_MS) },
    { executable: '/opt/multi pass/multipass', args: infoArgs(nameAt(2)), options: lifecycleOptions(QUERY_TIMEOUT_MS) },
  ]);
  for (const state of ['Running', 'Stopped', 'Deleted', 'Starting', 'Restarting', 'Delayed Shutdown', 'Suspending', 'Suspended', 'Unavailable', 'Unknown']) {
    const single = fakeMultipass({ present: new Map([[nameAt(1), state]]) });
    assert.deepEqual(await queryOwnedInstance(nameAt(1), { run: single.run }), { present: true, state });
  }
});

test('deleteOwnedInstance purges exactly one owned name without global flags', async () => {
  const fake = fakeMultipass({ present: new Map([[nameAt(1), 'Stopped'], ...FOREIGNERS]) });
  assert.equal(await deleteOwnedInstance(nameAt(1), { run: fake.run }), undefined);
  assert.deepEqual(fake.calls, [{ executable: 'multipass', args: ['delete', '--purge', nameAt(1)], options: lifecycleOptions(DELETE_TIMEOUT_MS) }]);
  await assert.rejects(deleteOwnedInstance(nameAt(1), { run: fake.run }), error => assertSanitized(error, 'LIFECYCLE_STATE_UNKNOWN'));
  assertScoped(fake, [nameAt(1)]);
});

test('absence requires exit code 2 and the exact not-found line for this name', async () => {
  const crlf = Object.assign(new Error('x'), { code: 2, stderr: `info failed: The following errors occurred:\r\ninstance "${nameAt(1)}" does not exist\r\n` });
  const fake = fakeMultipass({ present: new Map(FOREIGNERS), script: (args, index) => (index === 1 ? { error: crlf } : undefined) });
  assert.deepEqual(await queryOwnedInstance(nameAt(1), { run: fake.run }), { present: false });
  assert.deepEqual(await queryOwnedInstance(nameAt(1), { run: fake.run }), { present: false });
  assert.deepEqual(fake.argv(), [infoArgs(nameAt(1)), infoArgs(nameAt(1))]);
});

for (const [label, outcome, code] of [
  ['daemon failure', { error: failWith({ code: 3, stderr: 'info failed: secret-diagnostic\n' }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['another instance missing', { error: notFound('info', nameAt(2)) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['suffixed name missing', { error: notFound('info', `${nameAt(1)}x`) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['prefix name missing', { error: notFound('info', nameAt(1).slice(0, -1)) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['padded not-found line', { error: Object.assign(notFound('info', nameAt(1)), { stderr: `instance "${nameAt(1)}" does not exist secret-diagnostic\n` }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['string exit code', { error: Object.assign(notFound('info', nameAt(1)), { code: '2' }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['missing executable', { error: failWith({ code: 'ENOENT' }) }, 'PROVIDER_NOT_FOUND'],
  ['access denied', { error: failWith({ code: 'EACCES' }) }, 'PROVIDER_ACCESS_DENIED'],
  ['timeout', { error: failWith({ killed: true, code: 'ETIMEDOUT' }) }, 'PROVIDER_TIMEOUT'],
  ['output limit', { error: failWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }, 'PROVIDER_OUTPUT_LIMIT'],
  ['non-json output', { stdout: 'not json secret-diagnostic' }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['empty object', { stdout: '{}' }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['info without the name', { stdout: JSON.stringify({ errors: [], info: {} }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['info with a foreign key', { stdout: JSON.stringify({ errors: [], info: { [nameAt(1)]: { state: 'Running' }, [FOREIGN]: { state: 'Running' } } }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['unlisted state', { stdout: JSON.stringify({ errors: [], info: { [nameAt(1)]: { state: 'Exploded' } } }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['reported errors', { stdout: JSON.stringify({ errors: ['secret-diagnostic'], info: { [nameAt(1)]: { state: 'Running' } } }) }, 'LIFECYCLE_STATE_UNKNOWN'],
  ['oversized output', { stdout: ' '.repeat(MAX_PROBE_BUFFER) + JSON.stringify({ errors: [], info: { [nameAt(1)]: { state: 'Running' } } }) }, 'LIFECYCLE_STATE_UNKNOWN'],
]) {
  test(`query outcome "${label}" fails closed as ${code}, never absence`, async () => {
    const fake = fakeMultipass({ script: () => outcome });
    await assert.rejects(queryOwnedInstance(nameAt(1), { run: fake.run }), error => assertSanitized(error, code));
    assert.deepEqual(fake.argv(), [infoArgs(nameAt(1))]);
  });
}

test('invalid names or providers fail before any provider call', async () => {
  const fake = fakeMultipass();
  for (const name of ['', 'moe vm', 'moe-vm-x;rm', 'name\n', `${nameAt(1)}\n`, '-rf', 'm'.repeat(65), null, 'primary']) {
    await assert.rejects(queryOwnedInstance(name, { run: fake.run }), { code: 'LIFECYCLE_INPUT_INVALID' });
    await assert.rejects(deleteOwnedInstance(name, { run: fake.run }), { code: 'LIFECYCLE_INPUT_INVALID' });
  }
  for (const executable of ['', '   ', 'multi\npass', 'multi\x7fpass', 42]) {
    await assert.rejects(queryOwnedInstance(nameAt(1), { run: fake.run, executable }), { code: 'PROVIDER_INPUT_INVALID' });
    await assert.rejects(deleteOwnedInstance(nameAt(1), { run: fake.run, executable }), { code: 'PROVIDER_INPUT_INVALID' });
  }
  for (const provider of [null, 'multipass', { run: 'not a function' }]) {
    await assert.rejects(queryOwnedInstance(nameAt(1), provider), { code: 'LIFECYCLE_INPUT_INVALID' });
  }
  assert.equal(fake.calls.length, 0);
});

test('reserve durably records exact ownership intent that survives a restart', async t => {
  const dir = scratch(t);
  const ledger = createLedger(dir, { random: sequence() });
  const record = await ledger.reserve(owner);
  const file = path.join(dir, `${nameAt(1)}.json`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), RECORD_KEYS);
  assert.deepEqual(record, {
    schemaVersion: 1, provider: 'multipass', instance: nameAt(1), ...owner,
    phase: 'reserved', launchTries: 0, createdAt: record.createdAt, updatedAt: record.createdAt,
  });
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  const restarted = createLedger(dir);
  const reread = await restarted.read(nameAt(1));
  assert.deepEqual(reread, record);
  reread.phase = 'owned';
  assert.equal((await restarted.read(nameAt(1))).phase, 'reserved');
  const bytes = readFileSync(file);
  await assert.rejects(createLedger(dir, { random: sequence() }).reserve(owner), { code: 'LEDGER_CONFLICT' });
  for (const bad of [null, { ...owner, taskId: 'task-' }, { ...owner, taskId: ['task-a'] }, { ...owner, attemptId: 'attempt-a/b' },
    { ...owner, attemptId: 'run-1' }, { ...owner, generation: 0 }, { ...owner, generation: 1.5 }, { ...owner, generation: '3' }]) {
    await assert.rejects(ledger.reserve(bad), { code: 'LEDGER_INPUT_INVALID' });
  }
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readdirSync(dir), [`${nameAt(1)}.json`]);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

const stamp = '2026-10-24T12:00:00.000Z';
const stored = (changes = {}) => JSON.stringify({
  schemaVersion: 1, provider: 'multipass', instance: nameAt(1), ...owner, phase: 'owned', launchTries: 1, createdAt: stamp, updatedAt: stamp, ...changes,
});
for (const [label, text, file = `${nameAt(1)}.json`] of [
  ['an extra constructor key', stored({ constructor: 1 })],
  ['a missing key', stored({ updatedAt: undefined })],
  ['schema version 2', stored({ schemaVersion: 2 })],
  ['an unknown phase', stored({ phase: 'running' })],
  ['generation 0', stored({ generation: 0 })],
  ['a fractional generation', stored({ generation: 1.5 })],
  ['a string generation', stored({ generation: '1' })],
  ['a filename/instance mismatch', stored(), `${nameAt(2)}.json`],
  ['an oversized record', stored() + ' '.repeat(4096)],
  ['invalid JSON', '{"schemaVersion":1'],
  ['a launched phase without tries', stored({ launchTries: 0 })],
  ['an unlaunched phase with tries', stored({ phase: 'reserved' })],
  ['too many tries', stored({ launchTries: 4 })],
  ['a non-ISO timestamp', stored({ createdAt: '2026-10-24' })],
  ['an unsafe task id', stored({ taskId: 'task-../x' })],
  ['another provider', stored({ provider: 'lxd' })],
  ['a non-owned name', stored({ instance: 'primary' }), 'primary.json'],
]) {
  test(`ledger refuses ${label} and never acts on it`, async t => {
    const h = harness(t, [[nameAt(1), 'Running'], [nameAt(2), 'Running'], ...FOREIGNERS]);
    writeFileSync(path.join(h.dir, file), text);
    assert.deepEqual(await h.ledger.list(), { records: [], invalid: [file] });
    const name = file.slice(0, -'.json'.length);
    await assert.rejects(h.ledger.read(name), { code: isOwnedInstanceName(name) ? 'LEDGER_RECORD_INVALID' : 'LIFECYCLE_INPUT_INVALID' });
    assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), { reconciled: [], unknown: [], invalid: [file] });
    const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase: () => 'closed', leaseHeld: () => false });
    assert.deepEqual(swept, { deleted: [], preserved: [], errors: [], invalid: [file] });
    assert.equal(h.fake.calls.length, 0);
    assert.equal(readFileSync(path.join(h.dir, file), 'utf8'), text);
  });
}

test('ledger updates are compare-and-swap atomic renames that leave no temp files', async t => {
  const dir = path.join(scratch(t), 'missing state dir');
  const ledger = createLedger(dir, { random: sequence() });
  assert.deepEqual(await ledger.list(), { records: [], invalid: [] });
  const reserved = await ledger.reserve(owner);
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
  const launching = await ledger.update(reserved, { phase: 'launching', launchTries: 1 });
  assert.deepEqual(launching, { ...reserved, phase: 'launching', launchTries: 1, updatedAt: launching.updatedAt });
  assert.deepEqual(await ledger.read(nameAt(1)), launching);
  assert.deepEqual(readdirSync(dir), [`${nameAt(1)}.json`]);
  const file = path.join(dir, `${nameAt(1)}.json`);
  const bytes = readFileSync(file);
  await assert.rejects(ledger.update(reserved, { phase: 'owned' }), { code: 'LEDGER_CONFLICT' });
  await assert.rejects(ledger.update({ ...launching, launchTries: 2 }, { phase: 'owned' }), { code: 'LEDGER_CONFLICT' });
  for (const changes of [{ phase: 'bogus' }, { launchTries: 0 }, { launchTries: 4 }, { taskId: 'task-other' }, null]) {
    await assert.rejects(ledger.update(launching, changes), { code: 'LEDGER_INPUT_INVALID' });
  }
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readdirSync(dir), [`${nameAt(1)}.json`]);
  writeFileSync(path.join(dir, `.${nameAt(1)}.123.deadbeef.tmp`), 'torn');
  writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  assert.deepEqual(await ledger.list(), { records: [launching], invalid: [] });
  for (const bad of ['relative/state', '', `${dir}\nx`, `${dir}\u0000`, null, 42]) {
    assert.throws(() => createLedger(bad), { code: 'LEDGER_INPUT_INVALID' });
  }
});

test('provisionOwned makes launch intent durable before the platform launcher runs', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  const seen = [];
  const result = await provision(h, {
    launch: async name => {
      const durable = await createLedger(h.dir).read(name);
      seen.push([name, durable.phase, durable.launchTries]);
      h.fake.present.set(name, 'Running');
    },
  });
  assert.deepEqual(result, { instance: nameAt(1), phase: 'owned', launchTries: 1, executionReady: false });
  assert.deepEqual(seen, [[nameAt(1), 'launching', 1]]);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1))]);
  assert.equal((await h.ledger.read(nameAt(1))).phase, 'owned');
});

test('a name taken before launch is a foreign collision: never launched, adopted or deleted', async t => {
  const h = harness(t, [[nameAt(1), 'Stopped'], ...FOREIGNERS]);
  await h.ledger.reserve(owner);
  let launches = 0;
  const launch = async () => { launches++; };
  await assert.rejects(provision(h, { launch }), { code: 'LIFECYCLE_NAME_COLLISION' });
  assert.deepEqual([(await h.ledger.read(nameAt(1))).phase, (await h.ledger.read(nameAt(1))).launchTries], ['collision', 0]);
  await assert.rejects(provision(h, { launch }), { code: 'LIFECYCLE_NAME_COLLISION' });
  assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), { reconciled: [], unknown: [], invalid: [] });
  const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase: () => 'closed', leaseHeld: () => false });
  assert.deepEqual(swept, { deleted: [], preserved: [], errors: [], invalid: [] });
  assert.equal(launches, 0);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1))]);
  assert.equal(h.fake.present.get(nameAt(1)), 'Stopped');
  assertScoped(h.fake, [nameAt(1)]);
});

test('a timed-out launch re-queries the same owned name before one bounded retry', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  const launches = [];
  const launch = async name => {
    launches.push(name);
    h.events.push(`launch ${name}`);
    if (launches.length === 1) throw failWith({ killed: true, code: 'ETIMEDOUT' });
    h.fake.present.set(name, 'Running');
  };
  const result = await provision(h, { launch, retryDelayMs: 7, sleep: async ms => { h.events.push(`sleep ${ms}`); } });
  const info = infoArgs(nameAt(1)).join(' ');
  assert.deepEqual(h.events, [info, `launch ${nameAt(1)}`, info, 'sleep 7', `launch ${nameAt(1)}`]);
  assert.deepEqual(result, { instance: nameAt(1), phase: 'owned', launchTries: 2, executionReady: false });
  assert.deepEqual(launches, [nameAt(1), nameAt(1)]);
});

test('a timed-out launch whose VM exists is adopted after exactly one launch', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  let launches = 0;
  const launch = async name => {
    launches++;
    h.fake.present.set(name, 'Starting');
    throw failWith({ killed: true, code: 'ETIMEDOUT' });
  };
  assert.deepEqual(await provision(h, { launch }), { instance: nameAt(1), phase: 'owned', launchTries: 1, executionReady: false });
  assert.equal(launches, 1);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1)), infoArgs(nameAt(1))]);
});

test('an already-exists rejection after a timed-out launch adopts our late VM without another launch', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  const launches = [];
  const launch = async name => {
    launches.push(name);
    if (launches.length === 1) throw failWith({ killed: true, code: 'ETIMEDOUT' });
    throw failWith({ code: 2, stderr: `launch failed: instance "${name}" already exists` });
  };
  // The provider finishes the first launch late, while we wait to retry.
  const sleep = async () => { h.fake.present.set(nameAt(1), 'Running'); };
  assert.deepEqual(await provision(h, { launch, sleep }), { instance: nameAt(1), phase: 'owned', launchTries: 2, executionReady: false });
  assert.deepEqual(launches, [nameAt(1), nameAt(1)]);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1)), infoArgs(nameAt(1)), infoArgs(nameAt(1))]);
});

test('an unknown post-failure query leaves launching and never retries or deletes', async t => {
  const h = harness(t, FOREIGNERS, (args, index) => (index === 1 ? { error: failWith({ code: 3, stderr: 'secret-diagnostic' }) } : undefined));
  await h.ledger.reserve(owner);
  let launches = 0;
  const failing = async () => { launches++; throw failWith({ code: 1 }); };
  await assert.rejects(provision(h, { launch: failing }), error => assertSanitized(error, 'LIFECYCLE_STATE_UNKNOWN'));
  const record = await h.ledger.read(nameAt(1));
  assert.deepEqual([record.phase, record.launchTries], ['launching', 1]);
  await assert.rejects(provision(h, { launch: failing }), { code: 'LIFECYCLE_STATE_UNKNOWN' });
  assert.equal(launches, 1);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1)), infoArgs(nameAt(1))]);
});

test('launch retries are bounded to MAX_LAUNCH_TRIES with the same name', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  const launches = [];
  const sleeps = [];
  const launch = async name => { launches.push(name); throw failWith({ code: 1 }); };
  const sleep = async ms => { sleeps.push(ms); };
  await assert.rejects(provision(h, { launch, sleep }), error => assertSanitized(error, 'LIFECYCLE_RETRY_EXHAUSTED'));
  assert.equal(MAX_LAUNCH_TRIES, 3);
  assert.deepEqual(launches, [nameAt(1), nameAt(1), nameAt(1)]);
  assert.deepEqual(sleeps, [5000, 5000]);
  const record = await h.ledger.read(nameAt(1));
  assert.deepEqual([record.phase, record.launchTries], ['failed', 3]);
  assert.deepEqual(h.fake.argv(), Array.from({ length: 4 }, () => infoArgs(nameAt(1))));
  await assert.rejects(provision(h, { launch, sleep }), { code: 'LIFECYCLE_RETRY_EXHAUSTED' });
  assert.equal(launches.length, 3);
  assert.equal(h.fake.calls.length, 4);
});

test('restored absent records resume the persisted retry budget', async t => {
  const h = harness(t, FOREIGNERS);
  await seed(h.ledger, 'absent', 2);
  await seed(h.ledger, 'absent', 3);
  const launches = [];
  const launch = async name => { launches.push(name); throw failWith({ code: 1 }); };
  await assert.rejects(provision(h, { launch }), { code: 'LIFECYCLE_RETRY_EXHAUSTED' });
  assert.deepEqual(launches, [nameAt(1)]);
  await assert.rejects(provision(h, { name: nameAt(2), launch }), { code: 'LIFECYCLE_RETRY_EXHAUSTED' });
  assert.deepEqual(launches, [nameAt(1)]);
  assert.deepEqual(await phasesOf(h.ledger), ['failed', 'failed']);
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1))]);
});

for (const [label, other] of [['attempt', { ...owner, attemptId: 'attempt-other' }], ['generation', { ...owner, generation: 4 }],
  ['task', { ...owner, taskId: 'task-other' }], ['missing owner', undefined]]) {
  test(`provisionOwned fences a different ${label} without writes or calls`, async t => {
    const h = harness(t, FOREIGNERS);
    await h.ledger.reserve(owner);
    const file = path.join(h.dir, `${nameAt(1)}.json`);
    const bytes = readFileSync(file);
    let launches = 0;
    await assert.rejects(provision(h, { owner: other, launch: async () => { launches++; } }), { code: 'LIFECYCLE_NOT_OWNER' });
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(launches, 0);
    assert.equal(h.fake.calls.length, 0);
  });
}

test('provisionOwned refuses launching, deleted and unknown records and is idempotent once owned', async t => {
  const h = harness(t, FOREIGNERS);
  await seed(h.ledger, 'launching');
  await seed(h.ledger, 'owned');
  await seed(h.ledger, 'deleted');
  let launches = 0;
  const launch = async () => { launches++; };
  await assert.rejects(provision(h, { launch }), { code: 'LIFECYCLE_STATE_UNKNOWN' });
  assert.deepEqual(await provision(h, { name: nameAt(2), launch }), { instance: nameAt(2), phase: 'owned', launchTries: 1, executionReady: false });
  await assert.rejects(provision(h, { name: nameAt(3), launch }), { code: 'LIFECYCLE_PHASE_INVALID' });
  await assert.rejects(provision(h, { name: nameAt(9), launch }), { code: 'LEDGER_RECORD_INVALID' });
  await assert.rejects(provision(h, { name: nameAt(2), launch: 'launch' }), { code: 'LIFECYCLE_INPUT_INVALID' });
  await assert.rejects(provision(h, { name: nameAt(2), launch, retryDelayMs: -1 }), { code: 'LIFECYCLE_INPUT_INVALID' });
  assert.equal(launches, 0);
  assert.equal(h.fake.calls.length, 0);
  assert.deepEqual(await phasesOf(h.ledger), ['launching', 'owned', 'deleted']);
});

test('launcher failure text never reaches errors or ledger bytes', async t => {
  const h = harness(t, FOREIGNERS);
  await h.ledger.reserve(owner);
  const leak = failWith({ code: 'secret-value', stderr: '/private/path secret-value' });
  await assert.rejects(provision(h, { launch: async () => { throw leak; }, sleep: async () => {} }), error => assertSanitized(error, 'LIFECYCLE_RETRY_EXHAUSTED'));
  const bytes = readFileSync(path.join(h.dir, `${nameAt(1)}.json`), 'utf8');
  assert.equal(/secret|private/.test(bytes), false);
  assert.equal(JSON.parse(bytes).phase, 'failed');
});

test('reconcileOwned resolves each crash phase by querying only its own owned name', async t => {
  const h = harness(t, FOREIGNERS, args => (args[1] === nameAt(3) ? { error: failWith({ code: 3 }) } : undefined));
  const layout = [['launching', true], ['launching', false], ['launching', 'unknown'], ['owned', false], ['failed', true], ['reserved', true],
    ['collision', true], ['deleted', true], ['absent', false], ['owned', true], ['failed', false]];
  for (const [index, [phase, present]] of layout.entries()) {
    await seed(h.ledger, phase);
    if (present === true) h.fake.present.set(nameAt(index + 1), 'Running');
  }
  assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), {
    reconciled: [
      { instance: nameAt(1), from: 'launching', to: 'owned' },
      { instance: nameAt(2), from: 'launching', to: 'absent' },
      { instance: nameAt(4), from: 'owned', to: 'absent' },
      { instance: nameAt(5), from: 'failed', to: 'owned' },
    ],
    unknown: [nameAt(3)],
    invalid: [],
  });
  const queried = [1, 2, 3, 4, 5, 9, 10, 11].map(index => infoArgs(nameAt(index)));
  const expected = ['owned', 'absent', 'launching', 'absent', 'owned', 'reserved', 'collision', 'deleted', 'absent', 'owned', 'failed'];
  assert.deepEqual(h.fake.argv(), queried);
  assert.deepEqual(await phasesOf(h.ledger), expected);
  assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), { reconciled: [], unknown: [nameAt(3)], invalid: [] });
  assert.deepEqual(await phasesOf(h.ledger), expected);
  assert.deepEqual(h.fake.argv(), [...queried, ...queried]);
  assertScoped(h.fake, layout.map((_, index) => nameAt(index + 1)));
});

test('cleanupOwned deletes only closed, unleased, launched records by exact name', async t => {
  const h = harness(t, FOREIGNERS);
  const plan = [
    { attempt: 'running', reason: 'attempt-active' }, { attempt: 'finalizing', reason: 'attempt-active' },
    { attempt: 'reconciling', reason: 'attempt-active' }, { attempt: null, reason: 'attempt-unknown' },
    { attempt: 'other', reason: 'attempt-unknown' }, { attempt: 'throw', reason: 'attempt-unknown' },
    { attempt: 'closed', lease: true, reason: 'job-lease-held' }, { attempt: 'closed', lease: 'throw', reason: 'lease-unknown' },
    { attempt: 'closed', lease: undefined, reason: 'lease-unknown' }, { attempt: 'closed', lease: 0, reason: 'lease-unknown' },
    { attempt: 'closed', lease: false, phase: 'owned' }, { attempt: 'closed', lease: false, phase: 'failed', absent: true },
    { attempt: 'closed', lease: false, phase: 'reserved' }, { attempt: 'closed', lease: false, phase: 'collision' },
  ];
  for (const [index, entry] of plan.entries()) {
    await seed(h.ledger, entry.phase ?? 'owned', 1, { ...owner, attemptId: `attempt-${hexOf(index + 1)}` });
    if (!entry.absent) h.fake.present.set(nameAt(index + 1), 'Running');
  }
  const attemptCalls = [];
  const leaseCalls = [];
  const entryFor = hex => plan[Number.parseInt(hex, 16) - 1];
  const answer = value => { if (value === 'throw') throw failWith({}); return value; };
  const swept = await cleanupOwned({
    ledger: h.ledger, provider: h.provider,
    attemptPhase: async id => { attemptCalls.push(id); return answer(entryFor(id.slice(-2)).attempt); },
    leaseHeld: async id => { leaseCalls.push(id); return answer(entryFor(id.slice(-2)).lease); },
  });
  assert.deepEqual(swept, {
    deleted: [nameAt(11), nameAt(12)],
    preserved: plan.slice(0, 10).map((entry, index) => ({ instance: nameAt(index + 1), reason: entry.reason })),
    errors: [],
    invalid: [],
  });
  assert.deepEqual(attemptCalls, plan.slice(0, 12).map((_, index) => `attempt-${hexOf(index + 1)}`));
  assert.deepEqual(leaseCalls, [7, 8, 9, 10, 11, 12].map(nameAt));
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(11)), ['delete', '--purge', nameAt(11)], infoArgs(nameAt(11)), infoArgs(nameAt(12))]);
  assert.deepEqual(await phasesOf(h.ledger), [...Array(10).fill('owned'), 'deleted', 'deleted', 'reserved', 'collision']);
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14]) assert.equal(h.fake.present.get(nameAt(index)), 'Running');
  assert.equal(h.fake.present.has(nameAt(11)), false);
  assertScoped(h.fake, plan.map((_, index) => nameAt(index + 1)));
});

test('a failed delete keeps the record unless a re-query proves absence, and the sweep continues', async t => {
  const [stuck, unknown, raced, clean] = [1, 2, 3, 4].map(nameAt);
  const infoCount = name => h.fake.calls.filter(call => call.args[0] === 'info' && call.args[1] === name).length;
  const h = harness(t, [...FOREIGNERS, [stuck, 'Running'], [unknown, 'Running'], [raced, 'Running'], [clean, 'Running']], args => {
    if (args[0] === 'delete' && args[2] === stuck) return { error: failWith({ code: 3, stderr: 'secret-diagnostic' }) };
    if (args[0] === 'delete' && args[2] === unknown) return { error: failWith({ killed: true, code: 'ETIMEDOUT' }) };
    if (args[0] === 'info' && args[1] === unknown && infoCount(unknown) > 1) return { error: failWith({ code: 3 }) };
    if (args[0] === 'delete' && args[2] === raced) {
      h.fake.present.delete(raced); // a concurrent sweep purged it first
      return { error: notFound('delete', raced) };
    }
    return undefined;
  });
  for (let index = 0; index < 4; index++) await seed(h.ledger, 'owned');
  const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase: () => 'closed', leaseHeld: () => false });
  assert.deepEqual(swept, {
    deleted: [raced, clean],
    preserved: [],
    errors: [{ instance: stuck, code: 'LIFECYCLE_STATE_UNKNOWN' }, { instance: unknown, code: 'PROVIDER_TIMEOUT' }],
    invalid: [],
  });
  assert.equal(/secret|private/.test(JSON.stringify(swept)), false);
  assert.deepEqual(await phasesOf(h.ledger), ['owned', 'owned', 'deleted', 'deleted']);
  assert.deepEqual(h.fake.argv(), [stuck, unknown, raced, clean].flatMap(name => [infoArgs(name), ['delete', '--purge', name], infoArgs(name)]));
  assertScoped(h.fake, [stuck, unknown, raced, clean]);
});

test('cleanup records unknown first queries and concurrent ledger writers without retrying', async t => {
  const [unknown, contested] = [1, 2].map(nameAt);
  const h = harness(t, [...FOREIGNERS, [unknown, 'Running'], [contested, 'Running']],
    args => (args[1] === unknown ? { error: failWith({ code: 'EACCES' }) } : undefined));
  await seed(h.ledger, 'owned');
  await seed(h.ledger, 'owned');
  let attempts = 0;
  const attemptPhase = async () => {
    if (++attempts === 2) {
      // A concurrent writer moves the contested record after this sweep listed it.
      const other = createLedger(h.dir);
      await other.update(await other.read(contested), { phase: 'absent' });
    }
    return 'closed';
  };
  const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase, leaseHeld: () => false });
  assert.deepEqual(swept, {
    deleted: [],
    preserved: [],
    errors: [{ instance: unknown, code: 'PROVIDER_ACCESS_DENIED' }, { instance: contested, code: 'LEDGER_CONFLICT' }],
    invalid: [],
  });
  assert.deepEqual(h.fake.argv(), [infoArgs(unknown), infoArgs(contested), ['delete', '--purge', contested], infoArgs(contested)]);
  assert.deepEqual(await phasesOf(h.ledger), ['owned', 'absent']);
  assert.equal(h.fake.present.get(unknown), 'Running');
  assertScoped(h.fake, [unknown, contested]);
});

test('real provider process: owned query and purge use only per-name commands', { skip: process.platform === 'win32' }, async t => {
  const dir = scratch(t);
  const statePath = path.join(dir, 'instances.json');
  const violations = path.join(dir, 'violations.log');
  const executable = path.join(dir, 'fake multipass');
  writeFileSync(statePath, JSON.stringify({ [nameAt(1)]: 'Running', [FOREIGN]: 'Running', primary: 'Running' }));
  writeFileSync(executable, `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const [statePath, violations] = ${JSON.stringify([statePath, violations])};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
function missing(command, name) {
  process.stderr.write(command + ' failed: The following errors occurred:\\ninstance "' + name + '" does not exist\\n');
  return 2;
}
function main() {
  if (args.length === 4 && args[0] === 'info' && args[2] === '--format' && args[3] === 'json') {
    if (!Object.hasOwn(state, args[1])) return missing('info', args[1]);
    process.stdout.write(JSON.stringify({ errors: [], info: { [args[1]]: { state: state[args[1]] } } }));
    return 0;
  }
  if (args.length === 3 && args[0] === 'delete' && args[1] === '--purge') {
    if (!Object.hasOwn(state, args[2])) return missing('delete', args[2]);
    delete state[args[2]];
    fs.writeFileSync(statePath, JSON.stringify(state));
    return 0;
  }
  fs.appendFileSync(violations, JSON.stringify(args) + '\\n');
  return 64;
}
process.exitCode = main();
`, { mode: 0o755 });
  const provider = { executable };
  assert.deepEqual(await queryOwnedInstance(nameAt(1), provider), { present: true, state: 'Running' });
  assert.deepEqual(await queryOwnedInstance(nameAt(2), provider), { present: false });
  const ledger = createLedger(path.join(dir, 'ledger state'), { random: sequence() });
  await seed(ledger, 'owned');
  const swept = await cleanupOwned({ ledger, provider, attemptPhase: () => 'closed', leaseHeld: () => false });
  assert.deepEqual(swept, { deleted: [nameAt(1)], preserved: [], errors: [], invalid: [] });
  assert.deepEqual(await queryOwnedInstance(nameAt(1), provider), { present: false });
  assert.equal((await ledger.read(nameAt(1))).phase, 'deleted');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { [FOREIGN]: 'Running', primary: 'Running' });
  assert.equal(existsSync(violations), false);
});

// CQ-R07 pinned guest bootstrap
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import {
  buildUserData, GUEST_LAYOUT, GUEST_RESOURCES, hashFile, JOB_IDENTITIES, launchResourceArgs,
  MAX_CREDENTIAL_BYTES, MAX_SUPERVISOR_BYTES, verifySourceImage,
} from '../local-runner/guest-bootstrap.mjs';
import { GUEST_PROBES, readGuestInfo, runGuestProbe, waitForGuestReady } from '../local-runner/guest-readiness.mjs';

const GiB = 2 ** 30;
const GUEST = nameAt(1);
const IDENTITIES = ['moe-agent', 'moe-check'];
const PINS = (await loadCertifiedProvider()).images;
const SOURCE = { arch: 'x64', url: PINS.x64.url, sha256: PINS.x64.sha256 };
const PROVIDER_HASH = 'cd'.repeat(32);
const SUPERVISOR = Buffer.from('#!/bin/sh\nexec /usr/lib/moe/supervisor "$@"\n');
const CREDENTIAL = Buffer.from('secret-credential-0123456789');
const BOOTSTRAP = buildUserData({ supervisor: SUPERVISOR, credential: CREDENTIAL });
const DENIALS = [
  ['readCredential', '-r', '/etc/moe/supervisor.credential', 'CREDENTIAL_EXPOSED'],
  ['readUserData', '-r', '/var/lib/cloud/instance/user-data.txt', 'CREDENTIAL_EXPOSED'],
  ['readUserDataParts', '-r', '/var/lib/cloud/instance/user-data.txt.i', 'CREDENTIAL_EXPOSED'],
  ['readCloudConfig', '-r', '/var/lib/cloud/instance/cloud-config.txt', 'CREDENTIAL_EXPOSED'],
  ['readCachedObject', '-r', '/var/lib/cloud/instance/obj.pkl', 'CREDENTIAL_EXPOSED'],
  ['readInstanceData', '-r', '/run/cloud-init/instance-data-sensitive.json', 'CREDENTIAL_EXPOSED'],
  ['readCombinedConfig', '-r', '/run/cloud-init/combined-cloud-config.json', 'CREDENTIAL_EXPOSED'],
  ['readSeed', '-r', '/dev/sr0', 'CREDENTIAL_EXPOSED'],
  ['writeSupervisor', '-w', '/opt/moe/bin/moe-supervisor', 'SUPERVISOR_WRITABLE'],
  ['writeSupervisorDir', '-w', '/opt/moe/bin', 'SUPERVISOR_WRITABLE'],
];
const EXPECTED_PROBES = {
  cloudInit: ['cloud-init', 'status', '--format', 'json'],
  mountinfo: ['cat', '/proc/self/mountinfo'],
  layout: ['sudo', '-n', 'stat', '--format=%U:%G:%a:%A:%n', '/opt/moe', '/opt/moe/bin', '/opt/moe/bin/moe-supervisor', '/etc/moe', '/etc/moe/supervisor.credential', '/opt/moe/bin/moe-mcp-shim', '/opt/moe/bin/tools.json'],
  supervisorHash: ['sudo', '-n', 'sha256sum', '/opt/moe/bin/moe-supervisor'],
  shimHash: ['sudo', '-n', 'sha256sum', '/opt/moe/bin/moe-mcp-shim'],
  shimToolsHash: ['sudo', '-n', 'sha256sum', '/opt/moe/bin/tools.json'],
};
for (const id of IDENTITIES) {
  const as = ['sudo', '-n', '-u', id];
  Object.assign(EXPECTED_PROBES, {
    [`whoami:${id}`]: [...as, 'id', '--user', '--name'],
    [`status:${id}`]: ['sudo', '-n', 'passwd', '--status', id],
    [`groups:${id}`]: ['id', '--groups', '--name', id],
    ...Object.fromEntries(DENIALS.map(([key, flag, file]) => [`${key}:${id}`, [...as, 'test', flag, file]])),
    [`sudo:${id}`]: [...as, 'sudo', '-n', 'true'],
    [`keys:${id}`]: ['sudo', '-n', 'test', '-e', `/home/${id}/.ssh/authorized_keys`],
  });
}
EXPECTED_PROBES.agentHashes = ['sudo', '-n', 'sha256sum', '/opt/moe/agents/claude', '/opt/moe/agents/codex']; // CQ-R10d3 checkAgents' probe
const BOUNDARY = Object.keys(EXPECTED_PROBES).filter(id => id !== 'cloudInit' && id !== 'agentHashes'); // checkAgents runs after install, never at bootstrap
const PROBE_IDS = new Map(Object.entries(EXPECTED_PROBES).map(([id, argv]) => [JSON.stringify(argv), id]));
const execArgs = id => ['exec', '--no-map-working-directory', GUEST, '--', ...EXPECTED_PROBES[id]];

/** A Multipass v1.17.0 `info --format json` instance detail (json_formatter.cpp generate_instance_details). */
const guestDetail = (changes = {}) => ({
  zone: null, state: 'Running', image_hash: PROVIDER_HASH, image_release: '24.04 LTS', release: 'Ubuntu 24.04.3 LTS', cpu_count: '2',
  load: [0.1, 0.05, 0.01], disks: { sda1: { used: '2147483648', total: String(19 * GiB) } },
  memory: { used: 268435456, total: 4 * GiB - 2 ** 24 }, ipv4: ['10.0.0.2'], mounts: {}, ...changes,
});
const cloudInit = (code, status, extended = status, errors = [], recoverable = {}) =>
  ({ code, stdout: JSON.stringify({ status, extended_status: extended, errors, recoverable_errors: recoverable }) });
const MOUNTS = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,discard,errors=remount-ro',
  '23 22 8:15 / /boot/efi rw,relatime shared:2 - vfat /dev/sda15 rw,fmask=0077,dmask=0077',
  '24 22 7:0 / /snap/core22/1612 ro,nodev,relatime shared:3 - squashfs /dev/loop0 ro,errors=continue',
  '25 22 0:24 / /run rw,nosuid,nodev,noexec,relatime shared:4 - tmpfs tmpfs rw,size=401816k,mode=755',
  '26 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw',
  '27 22 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:6 - sysfs sysfs rw',
  '28 27 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:7 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot',
  '29 27 0:40 / /sys/fs/fuse/connections rw,nosuid,nodev,noexec,relatime shared:8 - fusectl fusectl rw',
];
const mountinfo = (lines = MOUNTS) => ({ code: 0, stdout: `${lines.join('\n')}\n` });
const LAYOUT = [
  'root:root:755:drwxr-xr-x:/opt/moe', 'root:root:755:drwxr-xr-x:/opt/moe/bin', 'root:root:500:-r-x------:/opt/moe/bin/moe-supervisor',
  'root:root:755:drwxr-xr-x:/etc/moe', 'root:root:400:-r--------:/etc/moe/supervisor.credential',
  'root:root:555:-r-xr-xr-x:/opt/moe/bin/moe-mcp-shim', 'root:root:444:-r--r--r--:/opt/moe/bin/tools.json',
];
const layout = (lines = LAYOUT, code = 0) => ({ code, stdout: `${lines.join('\n')}\n` });
const withLine = (lines, index, line) => lines.map((entry, at) => (at === index ? line : entry));

/** Probe answers of a correctly bootstrapped guest; overrides replace answers by probe id. */
function healthy(overrides = {}) {
  const answers = {
    cloudInit: cloudInit(0, 'done'), mountinfo: mountinfo(), layout: layout(),
    supervisorHash: { code: 0, stdout: `${BOOTSTRAP.supervisorSha256}  /opt/moe/bin/moe-supervisor\n` },
    shimHash: { code: 0, stdout: `${BOOTSTRAP.shimSha256}  /opt/moe/bin/moe-mcp-shim\n` }, shimToolsHash: { code: 0, stdout: `${BOOTSTRAP.shimToolsSha256}  /opt/moe/bin/tools.json\n` },
  };
  for (const id of IDENTITIES) {
    answers[`whoami:${id}`] = { code: 0, stdout: `${id}\n` };
    answers[`status:${id}`] = { code: 0, stdout: `${id} L 10/24/2026 0 99999 7 -1\n` };
    answers[`groups:${id}`] = { code: 0, stdout: `${id}\n` };
    for (const key of [...DENIALS.map(([name]) => name), 'sudo', 'keys']) answers[`${key}:${id}`] = { code: 1, stdout: '' };
  }
  return { ...answers, ...overrides };
}

/** execFile-compatible guest: only `info <guest> --format json` and `exec --no-map-working-directory <guest> -- <probe>`. */
function fakeGuest({ info = guestDetail(), answers = healthy() } = {}) {
  const calls = [];
  const unexpected = [];
  const take = value => (Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value);
  const run = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    let answer;
    if (args.length === 4 && args[0] === 'info' && args[1] === GUEST && args[2] === '--format' && args[3] === 'json') {
      const detail = take(info);
      answer = detail.error ? detail : { code: 0, stdout: JSON.stringify({ errors: [], info: { [GUEST]: detail } }) };
    } else if (args.length > 4 && args[0] === 'exec' && args[1] === '--no-map-working-directory' && args[2] === GUEST && args[3] === '--') {
      const id = PROBE_IDS.get(JSON.stringify(args.slice(4)));
      answer = id && Object.hasOwn(answers, id) ? take(answers[id]) : undefined;
    }
    if (!answer) {
      unexpected.push([...args]);
      throw new Error(`unexpected provider command ${JSON.stringify(args)}`);
    }
    if (answer.error) throw answer.error;
    if (answer.code === 0) return { stdout: answer.stdout, stderr: '' };
    throw Object.assign(new Error('Command failed /private/path'), { code: answer.code, stdout: answer.stdout, stderr: 'secret-diagnostic' });
  };
  const ids = () => calls.map(call => (call.args[0] === 'info' ? 'info' : PROBE_IDS.get(JSON.stringify(call.args.slice(4)))));
  return { run, calls, unexpected, ids };
}

async function guestHarness(t) {
  const dir = scratch(t);
  const ledger = createLedger(dir, { random: sequence() });
  const record = await seed(ledger, 'owned');
  return { dir, ledger, record, file: path.join(dir, `${GUEST}.json`) };
}

/** One readiness run against a fresh fake guest (healthy unless fakeOptions say otherwise). */
async function bootGuest(h, fakeOptions = {}, overrides = {}) {
  const fake = fakeGuest(fakeOptions);
  const sleeps = [];
  const result = await waitForGuestReady({
    ledger: h.ledger, name: GUEST, owner, sourceImage: SOURCE, bootstrap: BOOTSTRAP, provider: { run: fake.run },
    sleep: async ms => { sleeps.push(ms); }, pollMs: 5, maxWaitMs: 20, ...overrides,
  });
  assert.deepEqual(fake.unexpected, []);
  return { result, fake, sleeps };
}

const outcome = (failures, provider = { imageHash: PROVIDER_HASH, imageRelease: '24.04 LTS' }) => ({
  instance: GUEST, bootstrapReady: failures.length === 0, executionReady: false,
  image: { source: SOURCE, provider }, supervisorSha256: BOOTSTRAP.supervisorSha256, failures,
});

/** Exactly `failures`, no ledger write and no diagnostic text in the report. */
async function expectRefused(h, fakeOptions, failures, { provider, label, overrides } = {}) {
  const before = readFileSync(h.file);
  const run = await bootGuest(h, fakeOptions, overrides);
  assert.deepEqual(run.result, outcome(failures, provider), label);
  assert.deepEqual(readFileSync(h.file), before, label);
  assert.equal(/secret|private/.test(JSON.stringify(run.result)), false, label);
  return run;
}

test('hashFile streams sha256 of a regular file and refuses links, directories, relative and oversized paths', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe private secret image '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source image.img');
  const bytes = Buffer.alloc(200_000);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31) % 251;
  writeFileSync(file, bytes);
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await hashFile({ file }), expected);
  assert.equal(await hashFile({ file, maxBytes: bytes.length }), expected);
  const invalid = error => assertSanitized(error, 'IMAGE_INPUT_INVALID');
  await assert.rejects(hashFile({ file, maxBytes: bytes.length - 1 }), invalid);
  for (const maxBytes of [-1, 1.5, '200000']) await assert.rejects(hashFile({ file, maxBytes }), invalid);
  const folder = path.join(dir, 'folder');
  mkdirSync(folder);
  await assert.rejects(hashFile({ file: folder }), invalid);
  for (const bad of ['relative/source.img', `${file}\n`, `${file}\u0000`, '', null, 42]) await assert.rejects(hashFile({ file: bad }), invalid);
  await assert.rejects(hashFile(), invalid);
  await assert.rejects(hashFile({ file: path.join(dir, 'missing.img') }), error => assertSanitized(error, 'IMAGE_UNREADABLE'));
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.img');
    symlinkSync(file, link);
    await assert.rejects(hashFile({ file: link }), invalid);
  }
});

test('verifySourceImage accepts only the installed manifest pin for the requested architecture', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe private secret source '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ubuntu image.img');
  writeFileSync(file, 'not the pinned image');
  await assert.rejects(verifySourceImage({ file, arch: 'x64' }), error => assertSanitized(error, 'IMAGE_CHECKSUM_MISMATCH'));
  for (const arch of ['x64', 'arm64']) {
    const seen = [];
    const verified = await verifySourceImage({ file, arch }, { digest: async input => { seen.push(input); return PINS[arch].sha256; } });
    assert.deepEqual(verified, { arch, url: PINS[arch].url, sha256: PINS[arch].sha256 });
    assert.equal(Object.isFrozen(verified), true);
    assert.deepEqual(seen, [{ file }]);
  }
  for (const sha of [PINS.arm64.sha256, PINS.x64.sha256.toUpperCase(), undefined]) {
    await assert.rejects(verifySourceImage({ file, arch: 'x64' }, { digest: async () => sha }), error => assertSanitized(error, 'IMAGE_CHECKSUM_MISMATCH'));
  }
  for (const arch of ['ia32', 'amd64', 'valueOf', 'constructor', undefined]) {
    let calls = 0;
    const digest = async () => { calls++; return PINS.x64.sha256; };
    await assert.rejects(verifySourceImage({ file, arch }, { digest }), error => assertSanitized(error, 'IMAGE_INPUT_INVALID'));
    assert.equal(calls, 0);
  }
  await assert.rejects(verifySourceImage(null), error => assertSanitized(error, 'IMAGE_INPUT_INVALID'));
  await assert.rejects(verifySourceImage({ file, arch: 'x64' }, { digest: PINS.x64.sha256 }), error => assertSanitized(error, 'IMAGE_INPUT_INVALID'));
});

test('buildUserData renders deterministic cloud-config with a protected supervisor and locked identities', () => {
  const [shim, tools] = ['guest-mcp-shim.py', 'guest-mcp-tools.json'].map(name => readFileSync(new URL(`../local-runner/${name}`, import.meta.url)));
  const expected = [
    '#cloud-config', 'ssh_pwauth: false', 'disable_root: true', 'mounts: []', 'users:', '  - default',
    '  - name: moe-agent', '    lock_passwd: true', '    shell: /bin/bash',
    '  - name: moe-check', '    lock_passwd: true', '    shell: /bin/bash',
    'write_files:',
    '  - path: /opt/moe/bin/moe-supervisor', '    owner: root:root', "    permissions: '0500'", '    encoding: b64',
    `    content: '${SUPERVISOR.toString('base64')}'`,
    '  - path: /opt/moe/bin/moe-mcp-shim', '    owner: root:root', "    permissions: '0555'", '    encoding: b64', `    content: '${shim.toString('base64')}'`,
    '  - path: /opt/moe/bin/tools.json', '    owner: root:root', "    permissions: '0444'", '    encoding: b64', `    content: '${tools.toString('base64')}'`,
    '  - path: /etc/moe/supervisor.credential', '    owner: root:root', "    permissions: '0400'", '    encoding: b64',
    `    content: '${CREDENTIAL.toString('base64')}'`,
    '',
  ].join('\n');
  const built = buildUserData({ supervisor: SUPERVISOR, credential: CREDENTIAL });
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(built, { userData: expected, supervisorSha256: sha256(SUPERVISOR), shimSha256: sha256(shim), shimToolsSha256: sha256(tools) });
  assert.equal(Object.isFrozen(built), true);
  assert.equal(buildUserData({ supervisor: SUPERVISOR, credential: CREDENTIAL }).userData, expected);
  assert.equal(built.userData.includes(CREDENTIAL.toString('utf8')), false);
  assert.equal(/groups|sudo/.test(built.userData.split('write_files:')[0]), false);
  // Payloads whose base64 spells a YAML boolean or integer stay quoted strings.
  const literal = buildUserData({ supervisor: Buffer.from('true', 'base64'), credential: Buffer.from('1234', 'base64') }).userData;
  assert.equal(literal.includes("    content: 'true'\n"), true);
  assert.equal(literal.endsWith("    content: '1234'\n"), true);
  const largest = { supervisor: Buffer.alloc(MAX_SUPERVISOR_BYTES, 1), credential: Buffer.alloc(MAX_CREDENTIAL_BYTES, 2) };
  assert.equal(buildUserData(largest).supervisorSha256, createHash('sha256').update(largest.supervisor).digest('hex'));
  assert.equal(MAX_SUPERVISOR_BYTES, 262_144);
  assert.equal(MAX_CREDENTIAL_BYTES, 4096);
  for (const [supervisor, credential] of [
    [Buffer.alloc(0), CREDENTIAL], [SUPERVISOR, Buffer.alloc(0)],
    [Buffer.alloc(MAX_SUPERVISOR_BYTES + 1, 1), CREDENTIAL], [SUPERVISOR, Buffer.alloc(MAX_CREDENTIAL_BYTES + 1, 1)],
    ['#!/bin/sh', CREDENTIAL], [SUPERVISOR, 'secret-credential'], [new Uint8Array([1]), CREDENTIAL], [SUPERVISOR, undefined],
  ]) assert.throws(() => buildUserData({ supervisor, credential }), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'));
  assert.throws(() => buildUserData(null), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'));
});

test('guest layout, identities and resource bounds are frozen constants shared with the launchers', () => {
  assert.deepEqual(launchResourceArgs(), ['--cpus', '2', '--memory', '4G', '--disk', '20G']);
  assert.notEqual(launchResourceArgs(), launchResourceArgs());
  assert.deepEqual(GUEST_RESOURCES, { cpus: 2, memoryBytes: 4 * GiB, diskBytes: 20 * GiB });
  assert.deepEqual(JOB_IDENTITIES, IDENTITIES);
  assert.deepEqual(GUEST_LAYOUT, {
    supervisor: '/opt/moe/bin/moe-supervisor', supervisorDirs: ['/opt/moe', '/opt/moe/bin'],
    credential: '/etc/moe/supervisor.credential', credentialDir: '/etc/moe',
    shim: '/opt/moe/bin/moe-mcp-shim', shimTools: '/opt/moe/bin/tools.json',
  });
  for (const value of [GUEST_RESOURCES, JOB_IDENTITIES, GUEST_LAYOUT, GUEST_LAYOUT.supervisorDirs]) assert.equal(Object.isFrozen(value), true);
});

test('readGuestInfo runs bounded info on the owned name and parses the v1.17.0 detail strictly', async () => {
  const fake = fakeGuest();
  assert.deepEqual(await readGuestInfo(GUEST, { run: fake.run }), {
    state: 'Running', providerImageHash: PROVIDER_HASH, imageRelease: '24.04 LTS', cpuCount: 2,
    memoryTotal: 4 * GiB - 2 ** 24, diskTotal: 19 * GiB, mountCount: 0,
  });
  assert.deepEqual(fake.calls, [{ executable: 'multipass', args: infoArgs(GUEST), options: lifecycleOptions(QUERY_TIMEOUT_MS) }]);
  const starting = guestDetail({ image_hash: 'CD'.repeat(32), state: 'Starting', cpu_count: '', memory: {}, disks: { sda1: {} }, mounts: { '/home/ubuntu/x': {} } });
  const upper = fakeGuest({ info: starting });
  assert.deepEqual(await readGuestInfo(GUEST, { executable: '/opt/multipass bin/multipass', run: upper.run }), {
    state: 'Starting', providerImageHash: PROVIDER_HASH, imageRelease: '24.04 LTS', cpuCount: null, memoryTotal: null, diskTotal: null, mountCount: 1,
  });
  assert.equal(upper.calls[0].executable, '/opt/multipass bin/multipass');
  for (const [label, detail] of [
    ['missing image_hash', guestDetail({ image_hash: undefined })], ['non-hex image_hash', guestDetail({ image_hash: 'zz'.repeat(32) })],
    ['short image_hash', guestDetail({ image_hash: 'cd'.repeat(31) })], ['array image_hash', guestDetail({ image_hash: [PROVIDER_HASH] })],
    ['cpu_count two', guestDetail({ cpu_count: 'two' })], ['numeric cpu_count', guestDetail({ cpu_count: 2 })],
    ['string memory total', guestDetail({ memory: { total: String(4 * GiB) } })], ['negative memory total', guestDetail({ memory: { total: -1 } })],
    ['fractional memory total', guestDetail({ memory: { total: 1.5 } })], ['missing memory', guestDetail({ memory: undefined })],
    ['non-decimal disk total', guestDetail({ disks: { sda1: { total: '20G' } } })], ['missing disks', guestDetail({ disks: undefined })],
    ['array mounts', guestDetail({ mounts: [] })], ['null mounts', guestDetail({ mounts: null })],
    ['unknown state', guestDetail({ state: 'Booting' })], ['control characters in release', guestDetail({ image_release: '24.04\nsecret' })],
    ['oversized release', guestDetail({ image_release: 'x'.repeat(129) })], ['numeric release', guestDetail({ image_release: 24.04 })],
  ]) {
    await assert.rejects(readGuestInfo(GUEST, { run: fakeGuest({ info: detail }).run }), error => assertSanitized(error, 'PROVIDER_INFO_INVALID'), label);
  }
  for (const stdout of [
    JSON.stringify({ errors: [], info: { [GUEST]: guestDetail(), [FOREIGN]: guestDetail() } }),
    JSON.stringify({ errors: [], info: { [FOREIGN]: guestDetail() } }),
    JSON.stringify({ errors: ['secret-diagnostic'], info: { [GUEST]: guestDetail() } }),
    JSON.stringify({ info: { [GUEST]: guestDetail() } }),
    JSON.stringify({ errors: [], info: { [GUEST]: guestDetail({ release: 'x'.repeat(MAX_PROBE_BUFFER) }) } }),
    'not json secret-diagnostic',
  ]) {
    await assert.rejects(readGuestInfo(GUEST, { run: async () => ({ stdout, stderr: '' }) }), error => assertSanitized(error, 'PROVIDER_INFO_INVALID'));
  }
  for (const [fields, code] of [
    [{ code: 2, stderr: 'secret-diagnostic' }, 'PROVIDER_COMMAND_FAILED'], [{ killed: true, code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
    [{ code: 'ENOENT' }, 'PROVIDER_NOT_FOUND'], [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'PROVIDER_OUTPUT_LIMIT'],
  ]) await assert.rejects(readGuestInfo(GUEST, { run: async () => { throw failWith(fields); } }), error => assertSanitized(error, code));
  const counted = fakeGuest();
  for (const name of ['primary', `moe-vm-${'F0'.repeat(10)}`, '', null]) {
    await assert.rejects(readGuestInfo(name, { run: counted.run }), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  }
  await assert.rejects(readGuestInfo(GUEST, { executable: '', run: counted.run }), error => assertSanitized(error, 'PROVIDER_INPUT_INVALID'));
  assert.equal(counted.calls.length, 0);
});

test('runGuestProbe executes only the frozen fixed-argv table without host-directory mapping', async () => {
  assert.deepEqual(Object.keys(GUEST_PROBES), Object.keys(EXPECTED_PROBES));
  assert.deepEqual(GUEST_PROBES, EXPECTED_PROBES);
  assert.equal(Object.keys(GUEST_PROBES).length, 7 + 15 * IDENTITIES.length);
  assert.equal(Object.isFrozen(GUEST_PROBES), true);
  for (const argv of Object.values(GUEST_PROBES)) {
    assert.equal(Object.isFrozen(argv), true);
    for (const element of argv) assert.match(element, /^[A-Za-z0-9_.:\/%=+-]+$/);
  }
  const fake = fakeGuest({ answers: healthy({ 'sudo:moe-check': { code: 3, stdout: 'x' } }) });
  const provider = { run: fake.run };
  assert.deepEqual(await runGuestProbe(GUEST, 'cloudInit', provider), cloudInit(0, 'done'));
  assert.deepEqual(await runGuestProbe(GUEST, 'readSeed:moe-agent', provider), { code: 1, stdout: '' });
  assert.deepEqual(await runGuestProbe(GUEST, 'sudo:moe-check', provider), { code: 3, stdout: 'x' });
  assert.deepEqual(fake.calls.map(call => call.args), [execArgs('cloudInit'), execArgs('readSeed:moe-agent'), execArgs('sudo:moe-check')]);
  for (const call of fake.calls) assert.deepEqual([call.executable, call.options], ['multipass', lifecycleOptions(QUERY_TIMEOUT_MS)]);
  let calls = 0;
  const counting = { run: async () => { calls++; return { stdout: '', stderr: '' }; } };
  for (const id of ['nope', 'valueOf', 'constructor', 'toString', 'hasOwnProperty', '', null, 42]) {
    await assert.rejects(runGuestProbe(GUEST, id, counting), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'));
  }
  await assert.rejects(runGuestProbe('primary', 'cloudInit', counting), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  assert.equal(calls, 0);
  const oversized = 'x'.repeat(MAX_PROBE_BUFFER + 1);
  for (const [answer, code] of [
    [{ error: failWith({ killed: true, code: null, signal: 'SIGKILL', stdout: '' }) }, 'PROVIDER_TIMEOUT'],
    [{ error: failWith({ killed: true, code: 1, stdout: '' }) }, 'PROVIDER_TIMEOUT'],
    [{ error: failWith({ code: 'ENOENT' }) }, 'PROVIDER_NOT_FOUND'],
    [{ error: failWith({ code: 'EACCES' }) }, 'PROVIDER_ACCESS_DENIED'],
    [{ error: failWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'x' }) }, 'PROVIDER_OUTPUT_LIMIT'],
    [{ error: failWith({ code: 1, stderr: 'secret-diagnostic' }) }, 'PROVIDER_COMMAND_FAILED'],
    [{ error: failWith({ code: 1, stdout: oversized }) }, 'PROVIDER_OUTPUT_LIMIT'],
    [{ stdout: oversized }, 'PROVIDER_OUTPUT_LIMIT'],
    [{ stdout: Buffer.from('done') }, 'PROVIDER_OUTPUT_INVALID'],
  ]) {
    const run = async () => { if (answer.error) throw answer.error; return { stdout: answer.stdout, stderr: '' }; };
    await assert.rejects(runGuestProbe(GUEST, 'mountinfo', { run }), error => assertSanitized(error, code));
  }
});

test('readiness waits through Starting and unfinished cloud-init, then runs every boundary probe once', async t => {
  const h = await guestHarness(t);
  const { result, fake, sleeps } = await bootGuest(h, {
    info: [guestDetail({ state: 'Starting', cpu_count: '' }), guestDetail()],
    answers: healthy({ cloudInit: [cloudInit(0, 'not started'), cloudInit(0, 'running'), cloudInit(0, 'done')] }),
  });
  assert.deepEqual(result, outcome([]));
  assert.deepEqual(sleeps, [5, 5, 5]);
  assert.deepEqual(fake.ids(), ['info', 'info', 'cloudInit', 'info', 'cloudInit', 'info', 'cloudInit', ...BOUNDARY]);
  assert.deepEqual(fake.calls.at(-1).args, execArgs('keys:moe-check'));
  for (const call of fake.calls) assert.deepEqual([call.executable, call.options], ['multipass', lifecycleOptions(QUERY_TIMEOUT_MS)]);
  const reread = await createLedger(h.dir).read(GUEST);
  assert.deepEqual(reread, { ...h.record, image: { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH }, updatedAt: reread.updatedAt });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.file, 'utf8'))).sort(), [...RECORD_KEYS, 'image'].sort());
});

test('a Running guest whose cloud-init never finishes is not ready and times out after bounded polls', async t => {
  const h = await guestHarness(t);
  for (const [maxWaitMs, polls] of [[20, 4], [21, 5], [5, 1], [4, 1]]) {
    const run = await expectRefused(h, { answers: healthy({ cloudInit: cloudInit(0, 'running') }) }, ['BOOTSTRAP_TIMEOUT'],
      { overrides: { maxWaitMs }, label: `maxWaitMs ${maxWaitMs}` });
    assert.deepEqual(run.fake.ids(), Array(polls).fill(['info', 'cloudInit']).flat());
    assert.deepEqual(run.sleeps, Array(polls - 1).fill(5));
  }
  for (const state of ['Starting', 'Restarting']) {
    const run = await expectRefused(h, { info: guestDetail({ state }) }, ['BOOTSTRAP_TIMEOUT'], { label: state });
    assert.deepEqual(run.fake.ids(), ['info', 'info', 'info', 'info']);
  }
});

test('cloud-init error, degradation, disablement or a stopped guest fails bootstrap without boundary probes', async t => {
  const h = await guestHarness(t);
  for (const [label, answer] of [
    ['exit 1 error', cloudInit(1, 'error', 'error - done', ['secret-diagnostic'])],
    ['exit 2 degraded done', cloudInit(2, 'done', 'degraded done', [], { WARNING: ['secret-diagnostic'] })],
    ['exit 2 degraded running', cloudInit(2, 'running', 'degraded running')],
    ['exit 0 degraded done', cloudInit(0, 'done', 'degraded done')],
    ['exit 0 degraded running', cloudInit(0, 'running', 'degraded running')],
    ['exit 0 done with errors', cloudInit(0, 'done', 'done', ['x'])],
    ['exit 0 done with recoverable errors', cloudInit(0, 'done', 'done', [], { DEPRECATED: ['x'] })],
    ['exit 0 done with object errors', { code: 0, stdout: JSON.stringify({ status: 'done', extended_status: 'done', errors: {}, recoverable_errors: {} }) }],
    ['exit 0 done without recoverable errors', { code: 0, stdout: JSON.stringify({ status: 'done', extended_status: 'done', errors: [] }) }],
    ['exit 0 done without extended status', { code: 0, stdout: JSON.stringify({ status: 'done', errors: [], recoverable_errors: {} }) }],
    ['exit 0 disabled', cloudInit(0, 'disabled')],
    ['exit 0 non-JSON', { code: 0, stdout: 'status: done secret-diagnostic' }],
    ['exit 0 JSON array', { code: 0, stdout: '["done"]' }],
    ['exit 3 from Multipass', { code: 3, stdout: '' }],
  ]) {
    const run = await expectRefused(h, { answers: healthy({ cloudInit: answer }) }, ['BOOTSTRAP_FAILED'], { label });
    assert.deepEqual(run.fake.ids(), ['info', 'cloudInit'], label);
    assert.deepEqual(run.sleeps, [], label);
  }
  for (const state of ['Stopped', 'Deleted', 'Suspended', 'Unknown', 'Delayed Shutdown']) {
    const run = await expectRefused(h, { info: [guestDetail({ state: 'Starting' }), guestDetail({ state })] }, ['BOOTSTRAP_FAILED'], { label: state });
    assert.deepEqual(run.fake.ids(), ['info', 'info'], state);
    assert.deepEqual(run.sleeps, [5], state);
  }
});

test('any provider mount or host-sharing filesystem inside the guest fails the boundary', async t => {
  const h = await guestHarness(t);
  const mounted = { '/home/ubuntu/src': { source_path: '/private/secret', uid_mappings: [], gid_mappings: [] } };
  await expectRefused(h, { info: guestDetail({ mounts: mounted }) }, ['MOUNTS_PRESENT']);
  for (const fstype of ['9p', 'virtiofs', 'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'vboxsf', 'drvfs', 'fuse', 'fuseblk', 'fuse.sshfs', 'fuse.vmhgfs-fuse']) {
    const line = `40 22 0:50 / /home/ubuntu/src rw,relatime shared:9 - ${fstype} host-share rw`;
    await expectRefused(h, { answers: healthy({ mountinfo: mountinfo([...MOUNTS, line]) }) }, ['MOUNTS_PRESENT'], { label: fstype });
  }
  for (const [label, answer] of [
    ['an unparsable line', mountinfo([...MOUNTS, 'secret-diagnostic garbage'])],
    ['a line without the separator', mountinfo([...MOUNTS, '40 22 0:50 / /mnt rw shared:9 9p host rw'])],
    ['an empty interior line', mountinfo([MOUNTS[0], '', MOUNTS[1]])],
    ['empty output', { code: 0, stdout: '' }],
    ['a failed read', { code: 1, stdout: mountinfo().stdout }],
  ]) await expectRefused(h, { answers: healthy({ mountinfo: answer }) }, ['MOUNTS_UNKNOWN'], { label });
  const varied = ['30 22 0:51 / /tmp rw,relatime - tmpfs tmpfs rw', '31 22 8:17 / /srv rw shared:10 master:2 - ext4 /dev/sdb1 rw'];
  assert.equal((await bootGuest(h, { answers: healthy({ mountinfo: mountinfo([...MOUNTS, ...varied]) }) })).result.bootstrapReady, true);
});

test('the supervisor and credential must be root-only files under root-owned unwritable directories', async t => {
  const h = await guestHarness(t);
  for (const [label, lines] of [
    ['supervisor owned by ubuntu', withLine(LAYOUT, 2, 'ubuntu:root:500:-r-x------:/opt/moe/bin/moe-supervisor')],
    ['supervisor group ubuntu', withLine(LAYOUT, 2, 'root:ubuntu:500:-r-x------:/opt/moe/bin/moe-supervisor')],
    ['supervisor mode 555', withLine(LAYOUT, 2, 'root:root:555:-r-xr-xr-x:/opt/moe/bin/moe-supervisor')],
    ['supervisor mode 755', withLine(LAYOUT, 2, 'root:root:755:-rwxr-xr-x:/opt/moe/bin/moe-supervisor')],
    ['supervisor setuid', withLine(LAYOUT, 2, 'root:root:4500:-r-s------:/opt/moe/bin/moe-supervisor')],
    ['supervisor symlink', withLine(LAYOUT, 2, 'root:root:777:lrwxrwxrwx:/opt/moe/bin/moe-supervisor')],
    ['credential mode 440', withLine(LAYOUT, 4, 'root:root:440:-r--r-----:/etc/moe/supervisor.credential')],
    ['credential mode 600', withLine(LAYOUT, 4, 'root:root:600:-rw-------:/etc/moe/supervisor.credential')],
    ['credential directory', withLine(LAYOUT, 4, 'root:root:400:dr--------:/etc/moe/supervisor.credential')],
    ['group-writable /opt/moe', withLine(LAYOUT, 0, 'root:root:775:drwxrwxr-x:/opt/moe')],
    ['other-writable /etc/moe', withLine(LAYOUT, 3, 'root:root:757:drwxr-xrwx:/etc/moe')],
    ['sticky world-writable /opt/moe/bin', withLine(LAYOUT, 1, 'root:root:1777:drwxrwxrwt:/opt/moe/bin')],
    ['/opt/moe/bin owned by ubuntu', withLine(LAYOUT, 1, 'ubuntu:ubuntu:755:drwxr-xr-x:/opt/moe/bin')],
    ['/etc/moe a regular file', withLine(LAYOUT, 3, 'root:root:755:-rwxr-xr-x:/etc/moe')],
    ['/opt/moe a symlink', withLine(LAYOUT, 0, 'root:root:777:lrwxrwxrwx:/opt/moe')],
    ['a writable octal mode under a safe-looking type', withLine(LAYOUT, 0, 'root:root:775:drwxr-xr-x:/opt/moe')],
    ['a writable symbolic mode under a safe-looking octal', withLine(LAYOUT, 3, 'root:root:755:drwxrwxr-x:/etc/moe')],
    ['a missing line', LAYOUT.slice(0, 4)],
    ['an extra line', [...LAYOUT, 'root:root:755:drwxr-xr-x:/opt']],
    ['reordered lines', [LAYOUT[1], LAYOUT[0], ...LAYOUT.slice(2)]],
    ['an extra field', withLine(LAYOUT, 3, 'root:root:755:drwxr-xr-x:/etc/moe:x')],
    ['shim mode 755', withLine(LAYOUT, 5, 'root:root:755:-rwxr-xr-x:/opt/moe/bin/moe-mcp-shim')], ['shim owned by ubuntu', withLine(LAYOUT, 5, 'ubuntu:root:555:-r-xr-xr-x:/opt/moe/bin/moe-mcp-shim')],
    ['tools mode 644', withLine(LAYOUT, 6, 'root:root:644:-rw-r--r--:/opt/moe/bin/tools.json')], ['tools mode 666', withLine(LAYOUT, 6, 'root:root:666:-rw-rw-rw-:/opt/moe/bin/tools.json')],
  ]) await expectRefused(h, { answers: healthy({ layout: layout(lines) }) }, ['LAYOUT_INVALID'], { label });
  await expectRefused(h, { answers: healthy({ layout: layout(LAYOUT, 1) }) }, ['LAYOUT_INVALID'], { label: 'stat exit 1' });
  const digestLine = sha => `${sha}  /opt/moe/bin/moe-supervisor\n`;
  for (const [label, answer] of [
    ['another digest', { code: 0, stdout: digestLine('ef'.repeat(32)) }],
    ['another path', { code: 0, stdout: `${BOOTSTRAP.supervisorSha256}  /tmp/moe-supervisor\n` }],
    ['an uppercase digest', { code: 0, stdout: digestLine(BOOTSTRAP.supervisorSha256.toUpperCase()) }],
    ['a failed sha256sum', { code: 1, stdout: digestLine(BOOTSTRAP.supervisorSha256) }],
  ]) await expectRefused(h, { answers: healthy({ supervisorHash: answer }) }, ['SUPERVISOR_HASH_MISMATCH'], { label });
  for (const [id, sha, file, failure] of [
    ['shimHash', BOOTSTRAP.shimSha256, '/opt/moe/bin/moe-mcp-shim', 'SHIM_HASH_MISMATCH'], ['shimToolsHash', BOOTSTRAP.shimToolsSha256, '/opt/moe/bin/tools.json', 'SHIM_TOOLS_HASH_MISMATCH'],
  ]) {
    const rows = [['another digest', 0, `${'ef'.repeat(32)}  ${file}\n`], ['an uppercase digest', 0, `${sha.toUpperCase()}  ${file}\n`], ['another path', 0, digestLine(sha)], ['a failed sha256sum', 1, `${sha}  ${file}\n`]];
    for (const [label, code, stdout] of rows) await expectRefused(h, { answers: healthy({ [id]: { code, stdout } }) }, [failure], { label: `${id} ${label}` });
  }
  for (const id of IDENTITIES) {
    for (const [key, , , exposed] of DENIALS) {
      for (const [code, failure] of [[0, exposed], [2, 'PROBE_UNKNOWN'], [3, 'PROBE_UNKNOWN'], [126, 'PROBE_UNKNOWN']]) {
        await expectRefused(h, { answers: healthy({ [`${key}:${id}`]: { code, stdout: '' } }) }, [failure], { label: `${key}:${id} exit ${code}` });
      }
    }
  }
  const strict = withLine(withLine(LAYOUT, 3, 'root:root:700:drwx------:/etc/moe'), 0, 'root:root:711:drwx--x--x:/opt/moe');
  assert.equal((await bootGuest(h, { answers: healthy({ layout: layout(strict) }) })).result.bootstrapReady, true);
});

test('job identities must be locked, unprivileged and without sudo or login keys', async t => {
  const h = await guestHarness(t);
  for (const id of IDENTITIES) {
    for (const [label, overrides, failure] of [
      ['a usable password', { [`status:${id}`]: { code: 0, stdout: `${id} P 10/24/2026 0 99999 7 -1\n` } }, 'IDENTITY_NOT_LOCKED'],
      ['no password', { [`status:${id}`]: { code: 0, stdout: `${id} NP 10/24/2026 0 99999 7 -1\n` } }, 'IDENTITY_NOT_LOCKED'],
      ['another user status', { [`status:${id}`]: { code: 0, stdout: 'ubuntu L 10/24/2026 0 99999 7 -1\n' } }, 'IDENTITY_NOT_LOCKED'],
      ['a failed passwd', { [`status:${id}`]: { code: 1, stdout: `${id} L\n` } }, 'IDENTITY_NOT_LOCKED'],
      ['the sudo group', { [`groups:${id}`]: { code: 0, stdout: `${id} sudo\n` } }, 'IDENTITY_PRIVILEGED'],
      ['the adm group', { [`groups:${id}`]: { code: 0, stdout: `${id} adm\n` } }, 'IDENTITY_PRIVILEGED'],
      ['a failed id', { [`groups:${id}`]: { code: 1, stdout: '' } }, 'IDENTITY_PRIVILEGED'],
      ['working sudo', { [`sudo:${id}`]: { code: 0, stdout: '' } }, 'IDENTITY_PRIVILEGED'],
      ['unknown sudo', { [`sudo:${id}`]: { code: 2, stdout: '' } }, 'PROBE_UNKNOWN'],
      ['authorized keys', { [`keys:${id}`]: { code: 0, stdout: '' } }, 'IDENTITY_LOGIN_ENABLED'],
      ['unknown authorized keys', { [`keys:${id}`]: { code: 3, stdout: '' } }, 'PROBE_UNKNOWN'],
      ['probes running as another user', { [`whoami:${id}`]: { code: 0, stdout: 'ubuntu\n' } }, 'PROBE_UNKNOWN'],
      ['a failed identity switch', { [`whoami:${id}`]: { code: 1, stdout: '' } }, 'PROBE_UNKNOWN'],
    ]) await expectRefused(h, { answers: healthy(overrides) }, [failure], { label: `${id}: ${label}` });
  }
});

test('guest resources must be reported and within the bootstrap bounds', async t => {
  const h = await guestHarness(t);
  for (const [label, changes, failure] of [
    ['four cpus', { cpu_count: '4' }, 'RESOURCES_UNBOUNDED'],
    ['three cpus', { cpu_count: '3' }, 'RESOURCES_UNBOUNDED'],
    ['memory above 4 GiB', { memory: { used: 1, total: 4 * GiB + 1 } }, 'RESOURCES_UNBOUNDED'],
    ['disk above 20 GiB', { disks: { sda1: { used: '1', total: String(20 * GiB + 1) } } }, 'RESOURCES_UNBOUNDED'],
    ['an unknown cpu count', { cpu_count: '' }, 'RESOURCES_UNKNOWN'],
    ['a missing memory total', { memory: { used: 1 } }, 'RESOURCES_UNKNOWN'],
    ['a missing disk total', { disks: { sda1: { used: '1' } } }, 'RESOURCES_UNKNOWN'],
    ['too many cpus and unknown memory', { cpu_count: '8', memory: {} }, 'RESOURCES_UNBOUNDED'],
  ]) await expectRefused(h, { info: guestDetail(changes) }, [failure], { label });
  const exact = { cpu_count: '2', memory: { used: 1, total: 4 * GiB }, disks: { sda1: { used: '1', total: String(20 * GiB) } } };
  assert.equal((await bootGuest(h, { info: guestDetail(exact) })).result.bootstrapReady, true);
});

test('the source checksum and provider image identity are recorded separately and never overwritten', async t => {
  const h = await guestHarness(t);
  assert.notEqual(PROVIDER_HASH, SOURCE.sha256);
  assert.deepEqual((await bootGuest(h)).result, outcome([]));
  const reread = await createLedger(h.dir).read(GUEST);
  assert.deepEqual(reread.image, { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH });
  const bytes = readFileSync(h.file);
  assert.deepEqual((await bootGuest(h)).result, outcome([]));
  assert.deepEqual(readFileSync(h.file), bytes);
  const converted = 'ef'.repeat(32);
  const changed = await bootGuest(h, { info: guestDetail({ image_hash: converted }) });
  assert.deepEqual(changed.result, outcome(['IMAGE_IDENTITY_CHANGED'], { imageHash: converted, imageRelease: '24.04 LTS' }));
  assert.deepEqual(readFileSync(h.file), bytes);
  await assert.rejects(h.ledger.recordImage(reread, { ...reread.image, providerImageHash: converted }), error => assertSanitized(error, 'IMAGE_IDENTITY_CHANGED'));
  await assert.rejects(h.ledger.recordImage(reread, { ...reread.image, sourceSha256: PINS.arm64.sha256 }), error => assertSanitized(error, 'IMAGE_IDENTITY_CHANGED'));
  assert.deepEqual(await h.ledger.recordImage(reread, reread.image), reread);
  assert.deepEqual(readFileSync(h.file), bytes);
});

test('an image whose provider hash equals the source checksum still stores both fields', async t => {
  const h = await guestHarness(t);
  const run = await bootGuest(h, { info: guestDetail({ image_hash: SOURCE.sha256.toUpperCase() }) });
  assert.deepEqual(run.result, outcome([], { imageHash: SOURCE.sha256, imageRelease: '24.04 LTS' }));
  assert.deepEqual((await h.ledger.read(GUEST)).image, { sourceSha256: SOURCE.sha256, providerImageHash: SOURCE.sha256 });
});

test('recordImage is a compare-and-swap on an owned record with an exact image shape, kept by later updates', async t => {
  const dir = scratch(t);
  const ledger = createLedger(dir, { random: sequence() });
  const image = { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH };
  const unowned = [await seed(ledger, 'reserved'), await seed(ledger, 'launching'), await seed(ledger, 'absent')];
  const owned = await seed(ledger, 'owned');
  const snapshot = () => readdirSync(dir).map(name => readFileSync(path.join(dir, name), 'utf8'));
  const before = snapshot();
  for (const record of unowned) await assert.rejects(ledger.recordImage(record, image), error => assertSanitized(error, 'LIFECYCLE_PHASE_INVALID'));
  await assert.rejects(ledger.recordImage({ ...owned, phase: 'launching' }, image), error => assertSanitized(error, 'LEDGER_CONFLICT'));
  for (const bad of [
    null, { sourceSha256: SOURCE.sha256 }, { ...image, extra: 1 }, { ...image, providerImageHash: PROVIDER_HASH.toUpperCase() },
    { ...image, sourceSha256: 'x' }, { ...image, providerImageHash: [PROVIDER_HASH] },
  ]) await assert.rejects(ledger.recordImage(owned, bad), error => assertSanitized(error, 'LEDGER_INPUT_INVALID'));
  await assert.rejects(ledger.recordImage({ instance: 'primary' }, image), error => assertSanitized(error, 'LEDGER_INPUT_INVALID'));
  assert.deepEqual(snapshot(), before);
  const recorded = await ledger.recordImage(owned, { providerImageHash: PROVIDER_HASH, sourceSha256: SOURCE.sha256 });
  assert.deepEqual(recorded, { ...owned, image, updatedAt: recorded.updatedAt });
  assert.equal(JSON.stringify(recorded.image), JSON.stringify(image));
  assert.deepEqual(await createLedger(dir).read(nameAt(4)), recorded);
  const deleted = await ledger.update(recorded, { phase: 'deleted' });
  assert.deepEqual(deleted, { ...recorded, phase: 'deleted', updatedAt: deleted.updatedAt });
  assert.deepEqual((await createLedger(dir).read(nameAt(4))).image, image);
  await assert.rejects(ledger.recordImage(deleted, image), error => assertSanitized(error, 'LIFECYCLE_PHASE_INVALID'));
});

test('a malformed source image or supervisor digest is refused before any provider call', async t => {
  const h = await guestHarness(t);
  const before = readFileSync(h.file);
  const fake = fakeGuest();
  const call = overrides => waitForGuestReady({
    ledger: h.ledger, name: GUEST, owner, sourceImage: SOURCE, bootstrap: BOOTSTRAP, provider: { run: fake.run }, sleep: noSleep, ...overrides,
  });
  for (const [label, overrides] of [
    ['another checksum', { sourceImage: { ...SOURCE, sha256: PINS.arm64.sha256 } }],
    ['a caller-minted checksum', { sourceImage: { ...SOURCE, sha256: 'ab'.repeat(32) } }],
    ['another url', { sourceImage: { ...SOURCE, url: PINS.arm64.url } }],
    ['a mirror url', { sourceImage: { ...SOURCE, url: 'https://example.invalid/ubuntu.img' } }],
    ['an unknown arch', { sourceImage: { ...SOURCE, arch: 'ia32' } }],
    ['a prototype arch', { sourceImage: { ...SOURCE, arch: 'constructor' } }],
    ['an extra key', { sourceImage: { ...SOURCE, file: '/private/secret.img' } }],
    ['a missing key', { sourceImage: { arch: 'x64', sha256: SOURCE.sha256 } }],
    ['no source image', { sourceImage: null }],
    ['an uppercase supervisor digest', { bootstrap: { ...BOOTSTRAP, supervisorSha256: BOOTSTRAP.supervisorSha256.toUpperCase() } }],
    ['a short supervisor digest', { bootstrap: { supervisorSha256: 'ab' } }],
    ['an array supervisor digest', { bootstrap: { supervisorSha256: [BOOTSTRAP.supervisorSha256] } }],
    ...['shimSha256', 'shimToolsSha256'].flatMap(key => [[`no ${key}`, { bootstrap: { ...BOOTSTRAP, [key]: undefined } }],
      [`an uppercase ${key}`, { bootstrap: { ...BOOTSTRAP, [key]: BOOTSTRAP[key].toUpperCase() } }]]),
    ['no bootstrap', { bootstrap: undefined }],
    ['a zero poll interval', { pollMs: 0 }],
    ['a fractional wait', { maxWaitMs: 1.5 }],
    ['a negative wait', { maxWaitMs: -5 }],
    ['a non-function sleep', { sleep: 5 }],
    ['no ledger', { ledger: null }],
  ]) await assert.rejects(call(overrides), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'), label);
  await assert.rejects(call({ provider: { executable: '', run: fake.run } }), error => assertSanitized(error, 'PROVIDER_INPUT_INVALID'));
  await assert.rejects(call({ provider: { run: 'multipass' } }), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(readFileSync(h.file), before);
  const arm = { arch: 'arm64', url: PINS.arm64.url, sha256: PINS.arm64.sha256 };
  const run = await bootGuest(h, {}, { sourceImage: arm });
  assert.deepEqual(run.result, { ...outcome([]), image: { source: arm, provider: { imageHash: PROVIDER_HASH, imageRelease: '24.04 LTS' } } });
  assert.deepEqual((await h.ledger.read(GUEST)).image, { sourceSha256: PINS.arm64.sha256, providerImageHash: PROVIDER_HASH });
});

test('readiness is refused before any provider call unless the caller owns an owned record', async t => {
  const dir = scratch(t);
  const ledger = createLedger(dir, { random: sequence() });
  for (const phase of ['reserved', 'launching', 'absent', 'failed', 'collision']) await seed(ledger, phase);
  await seed(ledger, 'owned');
  await ledger.update(await seed(ledger, 'owned'), { phase: 'deleted' });
  const fake = fakeGuest();
  const call = (name, who) => waitForGuestReady({ ledger, name, owner: who, sourceImage: SOURCE, bootstrap: BOOTSTRAP, provider: { run: fake.run }, sleep: noSleep });
  for (const index of [1, 2, 3, 4, 5, 7]) await assert.rejects(call(nameAt(index), owner), error => assertSanitized(error, 'LIFECYCLE_PHASE_INVALID'));
  for (const who of [{ ...owner, taskId: 'task-other' }, { ...owner, attemptId: 'attempt-other' }, { ...owner, generation: 4 }, null, undefined]) {
    await assert.rejects(call(nameAt(6), who), error => assertSanitized(error, 'LIFECYCLE_NOT_OWNER'));
  }
  await assert.rejects(call(nameAt(1), { ...owner, generation: 2 }), error => assertSanitized(error, 'LIFECYCLE_NOT_OWNER'));
  await assert.rejects(call('primary', owner), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  await assert.rejects(call(nameAt(9), owner), error => assertSanitized(error, 'LEDGER_RECORD_INVALID'));
  assert.equal(fake.calls.length, 0);
  assert.equal((await ledger.read(nameAt(6))).image, undefined);
});

test('every boundary failure is collected once, without diagnostics, and executionReady stays false', async t => {
  const h = await guestHarness(t);
  const secret = 'secret-diagnostic /private/path';
  const run = await expectRefused(h, {
    info: guestDetail({ cpu_count: '8' }),
    answers: healthy({
      mountinfo: mountinfo([...MOUNTS, '41 22 0:60 / /mnt rw - 9p secret-diagnostic rw']),
      layout: { code: 1, stdout: secret },
      'groups:moe-agent': { code: 0, stdout: `moe-agent sudo ${secret}\n` },
      'groups:moe-check': { code: 0, stdout: 'moe-check sudo\n' },
      'readSeed:moe-check': { code: 0, stdout: secret },
      'keys:moe-check': { error: failWith({ killed: true, code: 'ETIMEDOUT', stdout: secret }) },
    }),
  }, ['MOUNTS_PRESENT', 'LAYOUT_INVALID', 'IDENTITY_PRIVILEGED', 'CREDENTIAL_EXPOSED', 'PROVIDER_TIMEOUT', 'RESOURCES_UNBOUNDED']);
  assert.deepEqual(run.fake.ids(), ['info', 'cloudInit', ...BOUNDARY]);
  for (const [label, info, failure] of [
    ['an info timeout', [{ error: failWith({ killed: true, code: 'ETIMEDOUT', stderr: secret }) }], 'PROVIDER_TIMEOUT'],
    ['a missing provider', [{ error: failWith({ code: 'ENOENT' }) }], 'PROVIDER_NOT_FOUND'],
    ['malformed info', [guestDetail({ state: 'Booting' })], 'PROVIDER_INFO_INVALID'],
  ]) await expectRefused(h, { info }, [failure], { label, provider: null });
  await expectRefused(h, { answers: healthy({ cloudInit: { error: failWith({ code: 'EACCES' }) } }) }, ['PROVIDER_ACCESS_DENIED'], { label: 'cloud-init access' });
  // A concurrent writer moving the record during the wait fences the identity write.
  const sleep = async () => { await createLedger(h.dir).update(h.record, { phase: 'absent' }); };
  const fenced = await bootGuest(h, { info: [guestDetail({ state: 'Starting' }), guestDetail()] }, { sleep });
  assert.deepEqual(fenced.result, outcome(['LEDGER_CONFLICT']));
  assert.deepEqual(await h.ledger.read(GUEST), { ...h.record, phase: 'absent', updatedAt: (await h.ledger.read(GUEST)).updatedAt });
});

test('records carrying a valid image still reconcile and clean up, keeping the image', async t => {
  const image = { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH };
  const h = harness(t, FOREIGNERS);
  writeFileSync(path.join(h.dir, `${nameAt(1)}.json`), stored({ image }));
  const record = await h.ledger.read(nameAt(1));
  assert.deepEqual(record.image, image);
  assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), {
    reconciled: [{ instance: nameAt(1), from: 'owned', to: 'absent' }], unknown: [], invalid: [],
  });
  const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase: () => 'closed', leaseHeld: () => false });
  assert.deepEqual(swept, { deleted: [nameAt(1)], preserved: [], errors: [], invalid: [] });
  const deleted = await h.ledger.read(nameAt(1));
  assert.deepEqual(deleted, { ...record, phase: 'deleted', updatedAt: deleted.updatedAt });
  assert.deepEqual(h.fake.argv(), [infoArgs(nameAt(1)), infoArgs(nameAt(1))]);
  assertScoped(h.fake, [nameAt(1)]);
});

for (const [label, image] of [
  ['a short source checksum', { sourceSha256: 'x', providerImageHash: PROVIDER_HASH }],
  ['an extra image key', { sourceSha256: PINS.x64.sha256, providerImageHash: PROVIDER_HASH, url: 'x' }],
  ['a missing provider hash', { sourceSha256: PINS.x64.sha256 }],
  ['an uppercase provider hash', { sourceSha256: PINS.x64.sha256, providerImageHash: PROVIDER_HASH.toUpperCase() }],
  ['a numeric checksum', { sourceSha256: 1, providerImageHash: PROVIDER_HASH }],
  ['a null image', null],
  ['a string image', PROVIDER_HASH],
]) {
  test(`ledger refuses a record with ${label} and never acts on it`, async t => {
    const h = harness(t, [[nameAt(1), 'Running'], ...FOREIGNERS]);
    const file = `${nameAt(1)}.json`;
    const text = stored({ image });
    writeFileSync(path.join(h.dir, file), text);
    assert.deepEqual(await h.ledger.list(), { records: [], invalid: [file] });
    await assert.rejects(h.ledger.read(nameAt(1)), { code: 'LEDGER_RECORD_INVALID' });
    assert.deepEqual(await reconcileOwned({ ledger: h.ledger, provider: h.provider }), { reconciled: [], unknown: [], invalid: [file] });
    const swept = await cleanupOwned({ ledger: h.ledger, provider: h.provider, attemptPhase: () => 'closed', leaseHeld: () => false });
    assert.deepEqual(swept, { deleted: [], preserved: [], errors: [], invalid: [file] });
    const ready = waitForGuestReady({ ledger: h.ledger, name: nameAt(1), owner, sourceImage: SOURCE, bootstrap: BOOTSTRAP, provider: h.provider, sleep: noSleep });
    await assert.rejects(ready, { code: 'LEDGER_RECORD_INVALID' });
    assert.equal(h.fake.calls.length, 0);
    assert.equal(readFileSync(path.join(h.dir, file), 'utf8'), text);
  });
}

test('real provider process: readiness uses only info and the fixed exec probes', { skip: process.platform === 'win32' }, async t => {
  const dir = scratch(t);
  const scenarioPath = path.join(dir, 'guest scenario.json');
  const violations = path.join(dir, 'violations.log');
  const executable = path.join(dir, 'fake multipass');
  const scenario = answers => JSON.stringify({
    info: guestDetail(), probes: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [JSON.stringify(EXPECTED_PROBES[id]), answer])),
  });
  writeFileSync(executable, `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const [scenarioPath, violations, name] = ${JSON.stringify([scenarioPath, violations, GUEST])};
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
function main() {
  if (args.length === 4 && args[0] === 'info' && args[1] === name && args[2] === '--format' && args[3] === 'json') {
    process.stdout.write(JSON.stringify({ errors: [], info: { [name]: scenario.info } }));
    return 0;
  }
  const exec = args.length > 4 && args[0] === 'exec' && args[1] === '--no-map-working-directory' && args[2] === name && args[3] === '--';
  const answer = exec && Object.hasOwn(scenario.probes, JSON.stringify(args.slice(4))) ? scenario.probes[JSON.stringify(args.slice(4))] : undefined;
  if (answer) {
    process.stdout.write(answer.stdout);
    return answer.code;
  }
  fs.appendFileSync(violations, JSON.stringify(args) + '\\n');
  return 64;
}
process.exitCode = main();
`, { mode: 0o755 });
  const ledger = createLedger(path.join(dir, 'ledger state'), { random: sequence() });
  await seed(ledger, 'owned');
  const boot = () => waitForGuestReady({ ledger, name: GUEST, owner, sourceImage: SOURCE, bootstrap: BOOTSTRAP, provider: { executable }, sleep: noSleep });
  writeFileSync(scenarioPath, scenario(healthy({ mountinfo: mountinfo([...MOUNTS, '41 22 0:60 / /home/ubuntu/src rw - 9p host rw']) })));
  assert.deepEqual(await boot(), outcome(['MOUNTS_PRESENT']));
  assert.equal((await ledger.read(GUEST)).image, undefined);
  writeFileSync(scenarioPath, scenario(healthy()));
  assert.deepEqual(await boot(), outcome([]));
  assert.deepEqual((await ledger.read(GUEST)).image, { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH });
  assert.equal(existsSync(violations), false);
});

// CQ-R03 Windows VM provisioning
import { Writable } from 'node:stream';
import { MAX_IMAGE_BYTES } from '../local-runner/guest-bootstrap.mjs';
import { DOWNLOAD_TIMEOUT_MS, ensurePinnedImage } from '../local-runner/image-cache.mjs';
import { probeHypervisor, windowsPlatform } from '../local-runner/platform-windows.mjs';
import { fileImageUrl, launchInstance, provisionGuest } from '../local-runner/provision.mjs';

const WIN_HOST = { platform: 'win32', arch: 'x64' };
const IMAGE_BYTES = Buffer.from('pinned ubuntu image bytes');
const IMAGE_FILE = `${PINS.x64.sha256}.img`;
const T = true;
const F = false;
const U = null;
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent'];
const launchArgs = (url, name = GUEST) => ['launch', url, '--name', name, '--cloud-init', '-', '--timeout', '900', '--cpus', '2', '--memory', '4G', '--disk', '20G'];
const hostUrl = file => `file://${process.platform === 'win32' ? file.replaceAll('\\', '/') : file}`;
const WIN_ITEMS = [
  ['host-windows-x64', false, 'Run Moe on a Windows x64 host.'],
  ['multipass-installed', true, 'Install Multipass 1.17.0 for Windows (+win build) as an Administrator.'],
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.'],
  ['driver-hcs', true, 'An administrator configures the Multipass driver to hcs; Moe never changes local.driver.'],
  ['hyper-v', true, 'Enable Hyper-V as an Administrator and reboot.'],
];
const items = states => WIN_ITEMS.map(([id, requiresElevation, action], at) => ({ id, satisfied: states[at], requiresElevation, action }));
const READY_ITEMS = items([T, T, T, T, T]);
/** Every argv an R03 fake saw, as [executable, ...args]; the no-global-change test reads it last. */
const R03_CALLS = [];

/** Stands in for R07's sha256 (tested there): the expected bytes hash to the pin, anything else does not. */
function pinDigest(arch = 'x64') {
  const files = [];
  const digest = async ({ file }) => {
    files.push(file);
    return readFileSync(file).equals(IMAGE_BYTES) ? PINS[arch].sha256 : 'ee'.repeat(32);
  };
  return { digest, files };
}

/** A fetch Response stand-in. highWaterMark 0: the body is pulled only when the code reads it. */
function fakeFetch(chunks = [IMAGE_BYTES], { status = 200, url, contentLength } = {}) {
  const calls = [];
  let pulls = 0;
  const fetch = async (target, init) => {
    calls.push({ target, init });
    if (chunks instanceof Error) throw chunks;
    const queue = [...chunks];
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        const next = queue.shift();
        if (next === undefined) controller.close();
        else if (next instanceof Error) controller.error(next);
        else controller.enqueue(new Uint8Array(next));
      },
    }, { highWaterMark: 0 });
    const headers = new Headers(contentLength === undefined ? {} : { 'content-length': String(contentLength) });
    return { ok: status >= 200 && status < 300, status, url: url ?? target, headers, body };
  };
  return { fetch, calls, pulls: () => pulls };
}

function cacheHarness(t, arch) {
  return { cacheDir: path.join(scratch(t), 'image cache'), ...pinDigest(arch) };
}

/** A promisified-execFile stand-in for `launch`: the promise carries child.stdin and settles once stdin is captured. */
function fakeLaunch(settle = () => ({ stdout: 'Launched\n', stderr: '' })) {
  const calls = [];
  const launches = [];
  const run = (executable, args, options) => {
    calls.push([...args]);
    R03_CALLS.push([executable, ...args]);
    const chunks = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const pending = new Promise(resolve => setImmediate(resolve)).then(() => {
      launches.push({ executable, args: [...args], options, stdin: Buffer.concat(chunks).toString('utf8'), ended: stdin.writableEnded });
      return settle(args, launches.length);
    });
    pending.child = { stdin };
    return pending;
  };
  return { run, calls, launches };
}

/** One provider for the R02 doctor, the R03 launch, the R06 query and the R07 probes (R07's fakeGuest). */
function fakeVm({ primaryName = 'primary', versionError, launch, answers } = {}) {
  const present = new Map();
  const guest = fakeGuest({ answers });
  const calls = [];
  const launcher = fakeLaunch((args, count) => {
    const outcome = launch?.(count) ?? {};
    if (outcome.create !== false) present.set(args[3], 'Running');
    if (outcome.error) throw outcome.error;
    return { stdout: `Launched: ${args[3]}\n`, stderr: '' };
  });
  const answer = async (executable, args, options) => {
    const command = args.join(' ');
    if (command === 'version --format json') {
      if (versionError) throw versionError;
      return { stdout: JSON.stringify(version), stderr: '' };
    }
    if (command === 'get local.driver') return { stdout: 'hcs\n', stderr: '' };
    if (command === 'get client.primary-name') return { stdout: `${primaryName}\n`, stderr: '' };
    if (args[0] === 'info' && !present.has(args[1])) throw notFound('info', args[1]);
    return guest.run(executable, args, options);
  };
  const run = (executable, args, options) => {
    calls.push([...args]);
    if (args[0] === 'launch') return launcher.run(executable, args, options);
    R03_CALLS.push([executable, ...args]);
    return answer(executable, args, options);
  };
  return { run, present, guest, launches: launcher.launches, commands: () => calls.map(args => args[0]) };
}

const onWindows = (hypervisor = async () => true) => ({
  ...windowsPlatform, prerequisites: options => windowsPlatform.prerequisites({ ...options, host: WIN_HOST, hypervisor }),
});

function provisionHarness(t, fakeOptions = {}, download = fakeFetch()) {
  const dir = scratch(t);
  const ledgerDir = path.join(dir, 'ledger');
  return {
    fake: fakeVm(fakeOptions), download, sleeps: [], ledgerDir, cacheDir: path.join(dir, 'image cache'),
    ledger: createLedger(ledgerDir, { random: sequence() }), ...pinDigest(),
  };
}

const provisionWith = (h, overrides = {}) => provisionGuest({
  platform: onWindows(), ledger: h.ledger, owner, cacheDir: h.cacheDir, supervisor: SUPERVISOR, credential: CREDENTIAL,
  provider: { run: h.fake.run }, fetch: h.download.fetch, digest: h.digest, sleep: async ms => { h.sleeps.push(ms); }, ...overrides,
});

const provisioned = (failures = []) => ({
  provisioned: true, instance: GUEST, bootstrapReady: failures.length === 0, executionReady: false, prerequisites: READY_ITEMS,
  image: { source: SOURCE, provider: { imageHash: PROVIDER_HASH, imageRelease: '24.04 LTS' } }, supervisorSha256: BOOTSTRAP.supervisorSha256, failures,
});

test('fileImageUrl keeps the literal path Multipass strips from file://, never percent-encoded', () => {
  assert.equal(fileImageUrl(`C:\\Users\\me\\My Images\\${IMAGE_FILE}`, 'win32'), `file://C:/Users/me/My Images/${IMAGE_FILE}`);
  assert.equal(fileImageUrl('d:/cache/x.img', 'win32'), 'file://d:/cache/x.img');
  assert.equal(fileImageUrl('/home/u/My Images/x.img', 'linux'), 'file:///home/u/My Images/x.img');
  assert.equal(fileImageUrl('/Users/u/x%20y#1.img', 'darwin'), 'file:///Users/u/x%20y#1.img');
  for (const [file, platform] of [
    ['x.img', 'linux'], ['C:\\x.img', 'linux'], ['\\\\server\\share\\x.img', 'win32'], ['\\\\?\\C:\\x.img', 'win32'], ['/home/u/x.img', 'win32'],
    ['C:x.img', 'win32'], ['C:\\a\nb.img', 'win32'], ['/tmp/a\u0000.img', 'linux'], ['/tmp/a\x7f.img', 'linux'], ['', 'linux'], [undefined, 'linux'],
  ]) assert.throws(() => fileImageUrl(file, platform), error => assertSanitized(error, 'PROVISION_INPUT_INVALID'), JSON.stringify([file, platform]));
});

const LAUNCH = { name: GUEST, imageFile: `/var/cache/moe images/${IMAGE_FILE}`, userData: BOOTSTRAP.userData, platform: 'linux' };

test('launchInstance runs one bounded launch of a local image with cloud-init only on stdin', async () => {
  const fake = fakeLaunch();
  assert.equal(await launchInstance({ ...LAUNCH, provider: { run: fake.run } }), undefined);
  assert.deepEqual(fake.launches, [{
    executable: 'multipass', args: launchArgs(`file:///var/cache/moe images/${IMAGE_FILE}`), options: lifecycleOptions(960_000),
    stdin: BOOTSTRAP.userData, ended: true,
  }]);
  const secret = CREDENTIAL.toString('base64');
  assert.equal(fake.launches[0].args.some(arg => ['--mount', '--network', '--bridged', '--all'].includes(arg) || arg.includes(secret)), false);
  const windows = fakeLaunch();
  const executable = 'C:\\Program Files\\Multipass\\bin\\multipass.exe';
  await launchInstance({ ...LAUNCH, imageFile: 'C:\\Moe Cache\\x.img', platform: 'win32', timeoutSeconds: 60, provider: { run: windows.run, executable } });
  assert.deepEqual(windows.launches.map(({ executable: exe, args, options }) => [exe, args, options.timeout]),
    [[executable, ['launch', 'file://C:/Moe Cache/x.img', '--name', GUEST, '--cloud-init', '-', '--timeout', '60', '--cpus', '2', '--memory', '4G', '--disk', '20G'], 120_000]]);
});

test('a failed launch reports a sanitized provider code, never its diagnostics', async () => {
  for (const [error, code] of [
    [failWith({ killed: true, code: 'ETIMEDOUT', stderr: 'secret-diagnostic' }), 'PROVIDER_TIMEOUT'],
    [failWith({ code: 1, stderr: 'launch failed: secret-diagnostic /private/path' }), 'PROVIDER_COMMAND_FAILED'],
    [failWith({ code: 'ENOENT' }), 'PROVIDER_NOT_FOUND'],
  ]) {
    const fake = fakeLaunch(() => { throw error; });
    await assert.rejects(launchInstance({ ...LAUNCH, provider: { run: fake.run } }), failure => assertSanitized(failure, code), code);
    assert.deepEqual(fake.launches.map(launch => [launch.stdin, launch.ended]), [[BOOTSTRAP.userData, true]], code);
  }
});

test('launchInstance refuses invalid input before running and a transport that cannot take stdin', async () => {
  const fake = fakeLaunch();
  for (const [changes, code] of [
    [{ name: 'primary' }, 'PROVISION_INPUT_INVALID'], [{ name: GUEST.toUpperCase() }, 'PROVISION_INPUT_INVALID'],
    [{ userData: '' }, 'PROVISION_INPUT_INVALID'], [{ userData: Buffer.from('#cloud-config\n') }, 'PROVISION_INPUT_INVALID'],
    [{ imageFile: 'relative.img' }, 'PROVISION_INPUT_INVALID'], [{ imageFile: 'C:\\x.img', platform: 'linux' }, 'PROVISION_INPUT_INVALID'],
    [{ timeoutSeconds: 0 }, 'PROVISION_INPUT_INVALID'], [{ timeoutSeconds: 3601 }, 'PROVISION_INPUT_INVALID'], [{ timeoutSeconds: 1.5 }, 'PROVISION_INPUT_INVALID'],
    [{ provider: { run: fake.run, executable: ' ' } }, 'PROVIDER_INPUT_INVALID'],
  ]) {
    await assert.rejects(launchInstance({ ...LAUNCH, provider: { run: fake.run }, ...changes }), error => assertSanitized(error, code), JSON.stringify(changes));
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(await launchInstance({ ...LAUNCH, timeoutSeconds: 3600, provider: { run: fake.run } }), undefined);
  assert.equal(fake.launches[0].options.timeout, 3_660_000);
  const killed = [];
  const noStdin = () => Object.assign(Promise.resolve({ stdout: '', stderr: '' }), { child: { stdin: null, kill: signal => killed.push(signal) } });
  const noChild = () => Promise.resolve({ stdout: '', stderr: '' });
  for (const run of [noStdin, noChild]) {
    await assert.rejects(launchInstance({ ...LAUNCH, provider: { run } }), error => assertSanitized(error, 'PROVISION_LAUNCH_FAILED'));
  }
  assert.deepEqual(killed, ['SIGKILL']);
});

test('a client that exits without reading stdin fails the launch without an unhandled pipe error', { skip: process.platform === 'win32' }, async t => {
  const executable = path.join(scratch(t), 'fake multipass');
  writeFileSync(executable, `#!${process.execPath}\nprocess.exitCode = 3;\n`, { mode: 0o755 });
  // Larger than any pipe buffer, so a write is still pending when the client exits (EPIPE).
  const userData = `#cloud-config\n${'x'.repeat(2 ** 20)}\n`;
  await assert.rejects(launchInstance({ ...LAUNCH, userData, provider: { executable } }), error => assertSanitized(error, 'PROVIDER_COMMAND_FAILED'));
});

test('ensurePinnedImage downloads only the manifest URL into a verified private cache entry', async t => {
  assert.equal(DOWNLOAD_TIMEOUT_MS, 3_600_000);
  for (const [arch, chunks] of [['x64', [IMAGE_BYTES]], ['arm64', [IMAGE_BYTES.subarray(0, 5), IMAGE_BYTES.subarray(5, 9), IMAGE_BYTES.subarray(9)]]]) {
    const h = cacheHarness(t, arch);
    const download = fakeFetch(chunks);
    const result = await ensurePinnedImage({ cacheDir: h.cacheDir, arch, url: 'https://attacker.invalid/x.img' }, { fetch: download.fetch, digest: h.digest });
    const file = path.join(h.cacheDir, `${PINS[arch].sha256}.img`);
    assert.deepEqual(result, { file, sourceImage: { arch, url: PINS[arch].url, sha256: PINS[arch].sha256 } });
    assert.deepEqual(download.calls.map(({ target, init }) => [target, Object.keys(init).sort(), init.redirect]), [[PINS[arch].url, ['redirect', 'signal'], 'follow']]);
    assert.ok(download.calls[0].init.signal instanceof AbortSignal);
    assert.equal(download.calls[0].init.signal.aborted, false);
    assert.deepEqual(readdirSync(h.cacheDir), [path.basename(file)]);
    assert.deepEqual(readFileSync(file), IMAGE_BYTES);
    // The digest checked the private partial download before it became the cache entry.
    assert.equal(h.files.length, 1);
    assert.equal(path.dirname(h.files[0]), h.cacheDir);
    assert.match(path.basename(h.files[0]), new RegExp(`^\\.${PINS[arch].sha256}\\.${process.pid}\\.[0-9a-f]{8}\\.part$`));
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(h.cacheDir).mode & 0o777, 0o700);
    }
  }
});

test('unsafe or unverifiable downloads are refused and leave no partial or cached file', async t => {
  const size = IMAGE_BYTES.length;
  for (const [label, download, code, read = true] of [
    ['a non-ok status', fakeFetch(undefined, { status: 404 }), 'IMAGE_DOWNLOAD_FAILED', false],
    ['a final URL that is not https', fakeFetch(undefined, { url: PINS.x64.url.replace('https:', 'http:') }), 'IMAGE_DOWNLOAD_FAILED', false],
    ['an aborted or failed request', fakeFetch(failWith({ name: 'AbortError', code: 20 })), 'IMAGE_DOWNLOAD_FAILED', false],
    ['a body stream error', fakeFetch([IMAGE_BYTES.subarray(0, 4), failWith({ code: 'ECONNRESET' })]), 'IMAGE_DOWNLOAD_FAILED'],
    ['a declared length above the bound', fakeFetch(undefined, { contentLength: size + 1 }), 'IMAGE_INPUT_INVALID', false],
    ['a body exceeding the bound mid-stream', fakeFetch([IMAGE_BYTES, Buffer.from('x')], { contentLength: size }), 'IMAGE_INPUT_INVALID'],
    ['bytes not matching the pin', fakeFetch([Buffer.from('tampered image bytes')]), 'IMAGE_CHECKSUM_MISMATCH'],
  ]) {
    const h = cacheHarness(t);
    const options = { fetch: download.fetch, digest: h.digest, maxBytes: size };
    await assert.rejects(ensurePinnedImage({ cacheDir: h.cacheDir, arch: 'x64' }, options), error => assertSanitized(error, code), label);
    assert.deepEqual(readdirSync(h.cacheDir), [], label);
    assert.equal(download.calls.length, 1, label);
    assert.equal(download.pulls() > 0, read, label);
    assert.equal(h.files.length, code === 'IMAGE_CHECKSUM_MISMATCH' ? 1 : 0, label);
  }
});

test('invalid cache inputs are refused before any download', async t => {
  const h = cacheHarness(t);
  const download = fakeFetch();
  const valid = { cacheDir: h.cacheDir, arch: 'x64' };
  for (const [input, options] of [
    [{ cacheDir: 'relative cache', arch: 'x64' }, {}], [{ cacheDir: `${h.cacheDir}\n`, arch: 'x64' }, {}], [{ cacheDir: h.cacheDir, arch: 'ia32' }, {}],
    [undefined, {}], [valid, { fetch: PINS.x64.url }], [valid, { digest: PINS.x64.sha256 }], [valid, { maxBytes: 0 }],
    [valid, { maxBytes: MAX_IMAGE_BYTES + 1 }], [valid, { maxBytes: 1.5 }],
  ]) {
    const attempt = ensurePinnedImage(input, { fetch: download.fetch, digest: h.digest, ...options });
    await assert.rejects(attempt, error => assertSanitized(error, 'IMAGE_INPUT_INVALID'), JSON.stringify([input, options]));
  }
  assert.equal(download.calls.length, 0);
  assert.equal(existsSync(h.cacheDir), false);
});

test('a cached pinned image is re-verified without a download; a corrupt one is replaced at most once', async t => {
  const h = cacheHarness(t);
  const file = path.join(h.cacheDir, IMAGE_FILE);
  const ensure = download => ensurePinnedImage({ cacheDir: h.cacheDir, arch: 'x64' }, { fetch: download.fetch, digest: h.digest });
  mkdirSync(h.cacheDir);
  writeFileSync(file, IMAGE_BYTES);
  const idle = fakeFetch();
  assert.deepEqual(await ensure(idle), { file, sourceImage: SOURCE });
  assert.deepEqual(h.files, [file]);
  assert.equal(idle.calls.length, 0);
  writeFileSync(file, 'corrupted cache entry');
  const repair = fakeFetch();
  assert.deepEqual(await ensure(repair), { file, sourceImage: SOURCE });
  assert.equal(repair.calls.length, 1);
  assert.deepEqual(readFileSync(file), IMAGE_BYTES);
  assert.deepEqual(readdirSync(h.cacheDir), [IMAGE_FILE]);
  writeFileSync(file, 'corrupted cache entry');
  const tampered = fakeFetch([Buffer.from('tampered image bytes')]);
  await assert.rejects(ensure(tampered), error => assertSanitized(error, 'IMAGE_CHECKSUM_MISMATCH'));
  assert.equal(tampered.calls.length, 1);
  assert.deepEqual(readdirSync(h.cacheDir), []);
});

test('a non-regular cache entry is refused without a download', async t => {
  const h = cacheHarness(t);
  const file = path.join(h.cacheDir, IMAGE_FILE);
  const download = fakeFetch();
  const ensure = () => ensurePinnedImage({ cacheDir: h.cacheDir, arch: 'x64' }, { fetch: download.fetch, digest: h.digest });
  mkdirSync(file, { recursive: true });
  await assert.rejects(ensure(), error => assertSanitized(error, 'IMAGE_INPUT_INVALID'));
  if (process.platform !== 'win32') {
    rmSync(file, { recursive: true });
    const outside = path.join(path.dirname(h.cacheDir), 'outside.img');
    writeFileSync(outside, IMAGE_BYTES);
    symlinkSync(outside, file);
    await assert.rejects(ensure(), error => assertSanitized(error, 'IMAGE_INPUT_INVALID'));
    assert.deepEqual(readFileSync(outside), IMAGE_BYTES);
  }
  assert.equal(download.calls.length, 0);
  assert.deepEqual(h.files, []);
});

const doctorReport = code => (code === 'PROVIDER_PREREQUISITES_READY'
  ? { provider: 'multipass', code, providerReady: true, executionReady: false, primaryName: 'primary' }
  : { provider: 'multipass', code, providerReady: false, executionReady: false, message: 'sanitized' });

async function windowsPrerequisites({ report = doctorReport('PROVIDER_PREREQUISITES_READY'), hypervisor = true, provider } = {}) {
  const calls = { doctor: [], hypervisor: [] };
  const result = await windowsPlatform.prerequisites({
    provider, host: WIN_HOST,
    doctor: async options => { calls.doctor.push(options); return report; },
    hypervisor: async options => { calls.hypervisor.push(options); return hypervisor; },
  });
  return { result, calls };
}

test('Windows prerequisites are explicit operator actions with their elevation needs', async () => {
  assert.equal(Object.isFrozen(windowsPlatform), true);
  assert.deepEqual([windowsPlatform.id, windowsPlatform.arch], ['win32', 'x64']);
  const run = async () => assert.fail('the injected checks own every call');
  const executable = 'C:\\Program Files\\Multipass\\bin\\multipass.exe';
  const { result, calls } = await windowsPrerequisites({ provider: { executable, run } });
  assert.deepEqual(result, { platform: 'win32', ready: true, providerCode: 'PROVIDER_PREREQUISITES_READY', prerequisites: READY_ITEMS, primaryName: 'primary' });
  assert.deepEqual(calls, { doctor: [{ host: WIN_HOST, executable, run }], hypervisor: [{ run }] });
  for (const item of result.prerequisites) assert.deepEqual(Object.keys(item), ['id', 'satisfied', 'requiresElevation', 'action']);
});

test('a failed provider check marks only its own prerequisite; what it cannot speak to stays unknown', async () => {
  for (const [code, expected] of [
    ['HOST_UNSUPPORTED', [F, U, U, U, U]], ['PROVIDER_NOT_FOUND', [U, F, U, U, T]], ['VERSION_MISMATCH', [U, F, U, U, T]],
    ['VERSION_UNSUPPORTED', [U, F, U, U, T]], ['PROVIDER_ACCESS_DENIED', [U, U, F, U, T]], ['DRIVER_UNSUPPORTED', [U, U, U, F, T]],
    ['PROVIDER_TIMEOUT', [U, U, U, U, T]], ['MANIFEST_INVALID', [U, U, U, U, T]],
  ]) {
    const { result, calls } = await windowsPrerequisites({ report: doctorReport(code) });
    assert.deepEqual(result, { platform: 'win32', ready: false, providerCode: code, prerequisites: items(expected), primaryName: null }, code);
    // An unsupported host never gets a PowerShell probe.
    assert.equal(calls.hypervisor.length, code === 'HOST_UNSUPPORTED' ? 0 : 1, code);
  }
  for (const [hypervisor, satisfied] of [[false, F], [null, U], ['True', U], [1, U], [0, U]]) {
    const { result } = await windowsPrerequisites({ hypervisor });
    assert.deepEqual(result, {
      platform: 'win32', ready: false, providerCode: 'PROVIDER_PREREQUISITES_READY', prerequisites: items([T, T, T, T, satisfied]), primaryName: 'primary',
    }, String(hypervisor));
  }
  const { result } = await windowsPrerequisites({ report: { ...doctorReport('PROVIDER_PREREQUISITES_READY'), providerReady: 'true' } });
  assert.deepEqual([result.ready, result.primaryName, result.prerequisites.map(item => item.satisfied)], [false, null, [U, U, U, U, T]]);
});

test('the Hyper-V check is one fixed, non-elevated, bounded read-only CIM query', async () => {
  const saved = process.env.SystemRoot;
  const fallback = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  try {
    for (const [root, executable] of [['D:\\WinRoot', 'D:\\WinRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], [undefined, fallback], ['relative\\root', fallback]]) {
      if (root === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = root;
      const calls = [];
      const run = async (exe, args, options) => {
        calls.push({ exe, args: [...args], options });
        R03_CALLS.push([exe, ...args]);
        return { stdout: 'True\r\n', stderr: '' };
      };
      assert.equal(await probeHypervisor({ run }), true);
      assert.deepEqual(calls, [{
        exe: executable, args: POWERSHELL_ARGS,
        options: { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: MAX_PROBE_BUFFER, killSignal: 'SIGKILL' },
      }], String(root));
    }
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
});

test('only an exact True or False Hyper-V answer is known; anything else is unknown', async () => {
  for (const [answer, expected] of [
    [{ stdout: 'True\n' }, T], [{ stdout: '  False\r\n' }, F], [{ stdout: 'true\n' }, U], [{ stdout: 'True\nFalse\n' }, U], [{ stdout: '' }, U],
    [{ stdout: undefined }, U], [{ stdout: `${' '.repeat(MAX_PROBE_BUFFER)}True` }, U], [{ error: failWith({ killed: true, code: 'ETIMEDOUT' }) }, U],
    [{ error: failWith({ code: 1, stdout: 'True\n' }) }, U], [{ error: failWith({ code: 'ENOENT' }) }, U],
  ]) {
    const run = async (exe, args) => {
      R03_CALLS.push([exe, ...args]);
      if (answer.error) throw answer.error;
      return { stdout: answer.stdout, stderr: '' };
    };
    assert.equal(await probeHypervisor({ run }), expected, JSON.stringify(answer).slice(0, 60));
  }
});

test('provisioning does nothing until every Windows prerequisite is satisfied', async t => {
  const unauthenticated = failWith({ code: 1, stderr: 'The client is not authenticated with the Multipass service. secret-diagnostic' });
  for (const [label, fakeOptions, hypervisor, expected, commands] of [
    ['an unauthenticated client', { versionError: unauthenticated }, async () => true, [U, U, F, U, T], ['version']],
    ['Hyper-V absent', {}, async () => false, [T, T, T, T, F], ['version', 'get', 'get']],
    ['Hyper-V unknown', {}, async () => null, [T, T, T, T, U], ['version', 'get', 'get']],
  ]) {
    const h = provisionHarness(t, fakeOptions);
    const result = await provisionWith(h, { platform: onWindows(hypervisor) });
    assert.deepEqual(result, { provisioned: false, bootstrapReady: false, executionReady: false, prerequisites: items(expected) }, label);
    assert.deepEqual(h.fake.commands(), commands, label);
    assert.equal(h.download.calls.length, 0, label);
    assert.equal(existsSync(h.cacheDir), false, label);
    assert.equal(existsSync(h.ledgerDir), false, label);
  }
});

test('provisionGuest launches the verified cached image once under one durable owned name', async t => {
  const h = provisionHarness(t);
  assert.deepEqual(await provisionWith(h), provisioned());
  const cached = path.join(h.cacheDir, IMAGE_FILE);
  assert.deepEqual(h.fake.launches.map(({ args, stdin, ended }) => ({ args, stdin, ended })), [{ args: launchArgs(hostUrl(cached)), stdin: BOOTSTRAP.userData, ended: true }]);
  assert.deepEqual(h.fake.launches[0].options, lifecycleOptions(960_000));
  assert.deepEqual(h.fake.commands(), ['version', 'get', 'get', 'info', 'launch', 'info', ...Array(1 + BOUNDARY.length).fill('exec')]);
  assert.deepEqual(h.fake.guest.unexpected, []);
  assert.deepEqual(readdirSync(h.ledgerDir), [`${GUEST}.json`]);
  const record = await h.ledger.read(GUEST);
  assert.deepEqual([record.phase, record.launchTries, record.image], ['owned', 1, { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH }]);
  assert.deepEqual(h.download.calls.map(call => call.target), [PINS.x64.url]);
  assert.deepEqual(readdirSync(h.cacheDir), [IMAGE_FILE]);
  assert.deepEqual([...h.fake.present.keys()], [GUEST]);
  assert.deepEqual(h.sleeps, []);
});

for (const [label, created, launches, sleeps] of [
  ['absent is retried under the same name', false, [GUEST, GUEST], [5_000]],
  ['present is adopted without another launch', true, [GUEST], []],
]) {
  test(`a timed-out launch whose VM is ${label}`, async t => {
    const h = provisionHarness(t, { launch: count => (count === 1 ? { error: failWith({ killed: true, code: 'ETIMEDOUT' }), create: created } : {}) });
    assert.deepEqual(await provisionWith(h), provisioned());
    assert.deepEqual(h.fake.launches.map(launch => [launch.args[3], launch.stdin === BOOTSTRAP.userData, launch.ended]), launches.map(name => [name, true, true]));
    assert.deepEqual(readdirSync(h.ledgerDir), [`${GUEST}.json`]);
    assert.equal((await h.ledger.read(GUEST)).launchTries, launches.length);
    assert.deepEqual([...h.fake.present.keys()], [GUEST]);
    assert.deepEqual(h.sleeps, sleeps);
    assert.equal(h.download.calls.length, 1);
  });
}

test('refusals before reservation leave no record, launch or extra download', async t => {
  const conflict = provisionHarness(t, { primaryName: `moe-vm-${'ab'.repeat(10)}` });
  await assert.rejects(provisionWith(conflict), error => assertSanitized(error, 'PRIMARY_NAME_CONFLICT'));
  const unavailable = provisionHarness(t, {}, fakeFetch(undefined, { status: 503 }));
  await assert.rejects(provisionWith(unavailable), error => assertSanitized(error, 'IMAGE_DOWNLOAD_FAILED'));
  const unbootable = provisionHarness(t);
  await assert.rejects(provisionWith(unbootable, { credential: Buffer.alloc(0) }), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'));
  for (const [h, downloads] of [[conflict, 0], [unavailable, 1], [unbootable, 0]]) {
    assert.deepEqual(h.fake.commands(), ['version', 'get', 'get']);
    assert.equal(h.download.calls.length, downloads);
    assert.equal(existsSync(h.ledgerDir), false);
  }
  const unready = provisionHarness(t);
  for (const changes of [{ platform: { ...windowsPlatform, prerequisites: undefined } }, { platform: null }, { ledger: {} }, { provider: null }, { sleep: 5 }]) {
    await assert.rejects(provisionWith(unready, changes), error => assertSanitized(error, 'PROVISION_INPUT_INVALID'));
  }
  assert.deepEqual(unready.fake.commands(), []);
});

test('a launched guest that fails readiness keeps its record for reconcile and is never deleted here', async t => {
  const h = provisionHarness(t, { answers: healthy({ mountinfo: mountinfo([...MOUNTS, '41 22 0:60 / /home/ubuntu rw - 9p host rw']) }) });
  assert.deepEqual(await provisionWith(h), provisioned(['MOUNTS_PRESENT']));
  const record = await h.ledger.read(GUEST);
  assert.deepEqual([record.phase, record.image], ['owned', undefined]);
  assert.equal(h.fake.commands().includes('delete'), false);
  assert.deepEqual([...h.fake.present.keys()], [GUEST]);
  const exhausted = provisionHarness(t, { launch: () => ({ error: failWith({ code: 1, stderr: 'secret-diagnostic' }), create: false }) });
  await assert.rejects(provisionWith(exhausted), error => assertSanitized(error, 'LIFECYCLE_RETRY_EXHAUSTED'));
  assert.deepEqual(exhausted.fake.launches.map(launch => launch.args[3]), [GUEST, GUEST, GUEST]);
  assert.deepEqual(readdirSync(exhausted.ledgerDir), [`${GUEST}.json`]);
  assert.equal((await exhausted.ledger.read(GUEST)).phase, 'failed');
  assert.equal(exhausted.fake.commands().includes('delete'), false);
});

const USAGE = 'Usage: cli.mjs doctor|prerequisites [--executable <path>] | native-smoke --work-dir <absolute path>';

test('CLI prerequisites prints one JSON report and exits 0 only when every prerequisite is ready', async () => {
  const executable = 'C:\\Program Files\\Multipass\\bin\\multipass.exe';
  for (const [args, ready, options] of [[['prerequisites', '--executable', executable], true, { executable }], [['prerequisites'], false, {}]]) {
    const writes = [];
    const seen = [];
    const report = { platform: 'win32', ready, executionReady: false, providerCode: 'PROVIDER_PREREQUISITES_READY', prerequisites: items([T, T, T, T, ready]) };
    const code = await runCli(args, {
      doctor: async () => assert.fail('doctor is a separate command'), prerequisites: async received => { seen.push(received); return report; }, write: text => writes.push(text),
    });
    assert.deepEqual([code, seen, writes], [ready ? 0 : 2, [options], [`${JSON.stringify(report)}\n`]]);
  }
  const crossed = [];
  assert.equal(await runCli(['prerequisites'], { prerequisites: async () => ({ providerReady: true, ready: false }), write: text => crossed.push(text) }), 2);
  assert.equal(await runCli(['doctor'], {
    doctor: async () => ({ providerReady: false, ready: true }), prerequisites: async () => assert.fail('not a doctor dependency'), write: text => crossed.push(text),
  }), 2);
  for (const failure of [async () => { throw failWith({ code: 'EACCES' }); }, () => { throw failWith({}); }]) {
    const writes = [];
    assert.equal(await runCli(['prerequisites'], { prerequisites: failure, write: text => writes.push(text) }), 2);
    assert.deepEqual(writes, [`${JSON.stringify({ code: 'PREREQUISITES_UNAVAILABLE', ready: false, executionReady: false })}\n`]);
  }
});

for (const args of [['prerequisites', 'extra'], ['prerequisites', '--executable'], ['prerequisites', '--executable', ' '], ['prerequisites', '--executable', 'a\nb'],
  ['prerequisites', '--executable', 'a', '--executable', 'b'], ['prerequisites', '--manifest', 'evil'], ['Prerequisites']]) {
  test(`CLI rejects ${JSON.stringify(args)} before any prerequisite call`, async () => {
    let calls = 0;
    const writes = [];
    const code = await runCli(args, { doctor: async () => { calls++; }, prerequisites: async () => { calls++; }, write: text => writes.push(text) });
    assert.deepEqual([code, calls, writes.length], [2, 0, 1]);
    assert.deepEqual(JSON.parse(writes[0]), { code: 'CLI_INPUT_INVALID', providerReady: false, executionReady: false, message: USAGE });
  });
}

test('CLI prerequisites refuse a host without a platform module', async () => {
  // R04 gave Linux a platform module, so an unsupported host is simulated.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const writes = [];
  Object.defineProperty(process, 'platform', { ...platform, value: 'sunos' });
  try {
    assert.equal(await runCli(['prerequisites'], { write: text => writes.push(text) }), 2);
  } finally { Object.defineProperty(process, 'platform', platform); }
  assert.deepEqual(writes, [`${JSON.stringify({ code: 'PLATFORM_UNSUPPORTED', ready: false, executionReady: false })}\n`]);
});

test('no R03 command changes provider or host settings, elevates, authenticates or mounts', () => {
  const FORBIDDEN = ['set', 'authenticate', 'runas', 'enable-windowsoptionalfeature', 'dism', 'bcdedit', '--all', '--mount', 'mount', '--network', '--bridged'];
  const kinds = new Set(R03_CALLS.map(argv => (argv[0].endsWith('powershell.exe') ? 'powershell' : argv[1])));
  assert.deepEqual([...kinds].sort(), ['exec', 'get', 'info', 'launch', 'powershell', 'version']);
  for (const argv of R03_CALLS) {
    // After `--` is R07's frozen guest probe table, tested there; the image URL holds a temporary path.
    const head = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    for (const element of head.filter(value => !value.startsWith('file://'))) {
      assert.equal(FORBIDDEN.some(token => element.toLowerCase().includes(token)), false, JSON.stringify(argv));
    }
    if (argv[1] === 'get') assert.ok(['local.driver', 'client.primary-name'].includes(argv[2]), JSON.stringify(argv));
  }
});

test('real provider process: provisioning sends cloud-init on stdin and runs only owned commands', { skip: process.platform === 'win32' }, async t => {
  const dir = scratch(t);
  const statePath = path.join(dir, 'provider state.json');
  const violations = path.join(dir, 'violations.log');
  const executable = path.join(dir, 'fake multipass');
  const probes = Object.fromEntries(Object.entries(healthy()).map(([id, answer]) => [JSON.stringify(EXPECTED_PROBES[id]), answer]));
  writeFileSync(statePath, JSON.stringify({ instances: {}, launches: [], info: guestDetail(), probes }));
  writeFileSync(executable, `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const [statePath, violations] = ${JSON.stringify([statePath, violations])};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const out = text => {
  process.stdout.write(text);
  return 0;
};
function main() {
  const command = args.join(' ');
  if (command === 'version --format json') return out('{"multipass":"1.17.0+win","multipassd":"1.17.0+win"}');
  if (command === 'get local.driver') return out('hcs\\n');
  if (command === 'get client.primary-name') return out('primary\\n');
  if (args[0] === 'launch') {
    state.launches.push({ args, stdin: fs.readFileSync(0, 'utf8') });
    state.instances[args[3]] = 'Running';
    fs.writeFileSync(statePath, JSON.stringify(state));
    return out('Launched: ' + args[3] + '\\n');
  }
  if (args.length === 4 && args[0] === 'info' && args[2] === '--format' && args[3] === 'json') {
    if (!Object.hasOwn(state.instances, args[1])) {
      process.stderr.write('info failed: The following errors occurred:\\ninstance "' + args[1] + '" does not exist\\n');
      return 2;
    }
    return out(JSON.stringify({ errors: [], info: { [args[1]]: state.info } }));
  }
  const exec = args.length > 4 && args[0] === 'exec' && args[1] === '--no-map-working-directory' && Object.hasOwn(state.instances, args[2]) && args[3] === '--';
  const answer = exec ? state.probes[JSON.stringify(args.slice(4))] : undefined;
  if (answer) {
    process.stdout.write(answer.stdout);
    return answer.code;
  }
  fs.appendFileSync(violations, JSON.stringify(args) + '\\n');
  return 64;
}
process.exitCode = main();
`, { mode: 0o755 });
  const cacheDir = path.join(dir, 'image cache');
  const result = await provisionGuest({
    platform: onWindows(), ledger: createLedger(path.join(dir, 'ledger state'), { random: sequence() }), owner, cacheDir,
    supervisor: SUPERVISOR, credential: CREDENTIAL, provider: { executable }, fetch: fakeFetch().fetch, digest: pinDigest().digest, sleep: noSleep,
  });
  assert.deepEqual(result, provisioned());
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.launches, [{ args: launchArgs(hostUrl(path.join(cacheDir, IMAGE_FILE))), stdin: BOOTSTRAP.userData }]);
  assert.deepEqual(state.instances, { [GUEST]: 'Running' });
  assert.equal(existsSync(violations), false);
});

// CQ-R04 Linux VM provisioning
import { platformFor } from '../local-runner/cli.mjs';
import { HOST_DISK_HEADROOM_BYTES, linuxPlatform, MULTIPASS_STORAGE, REQUIRED_SNAP_PLUGS } from '../local-runner/platform-linux.mjs';

const LINUX_HOST = { platform: 'linux', arch: 'x64' };
const SNAP = '/usr/bin/snap';
const SNAP_MULTIPASS = '/snap/bin/multipass';
const SNAP_LIST = 'list multipass --unicode=never --color=never';
const DISK = GUEST_RESOURCES.diskBytes + HOST_DISK_HEADROOM_BYTES;
// snapd's --unicode=never table: a verified publisher renders as `canonical**`; Notes `-` is strict confinement.
const snapRow = ({ version = '1.17.0', publisher = 'canonical**', notes = '-' } = {}) => `multipass  ${version}  14535  latest/stable  ${publisher}  ${notes}`;
const snapList = (...rows) => `${['Name       Version  Rev    Tracking       Publisher    Notes', ...rows].join('\n')}\n`;
const plugRow = (plug, slot = `:${plug === 'all-home' ? 'home' : plug}`) => `${plug === 'all-home' ? 'home' : plug}  multipass:${plug}  ${slot}  -`;
const connections = (rows = REQUIRED_SNAP_PLUGS.map(plug => plugRow(plug))) =>
  `${['Interface          Plug                         Slot                 Notes', ...rows, plugRow('network-manager', '-')].join('\n')}\n`;
const LINUX_ANSWERS = {
  [SNAP_LIST]: snapList(snapRow()), 'connections multipass': connections(), 'version --format json': '{"multipass":"1.17.0","multipassd":"1.17.0"}',
  'get local.driver': 'qemu\n', 'get client.primary-name': 'primary\n',
};
/** One execFile-compatible transport for the snap CLI and the R02 doctor; an Error answer is thrown. */
function linuxTransport(changes = {}) {
  const answers = { ...LINUX_ANSWERS, ...changes };
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ argv: [executable, ...args], options });
    const answer = answers[args.join(' ')];
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: '' };
  };
  return { run, calls };
}
const ROOMY = {
  host: LINUX_HOST, cacheDir: '/home/u/moe-images', homedir: () => '/home/u', cpus: () => GUEST_RESOURCES.cpus, freemem: () => GUEST_RESOURCES.memoryBytes,
  statDevice: async () => ({ isCharacterDevice: () => true }), statfs: async () => ({ bavail: DISK / 4096, bsize: 4096 }),
};
const RESOURCE_ACTION = 'Free host CPU, memory or disk, or use a larger host; Moe never runs jobs on the host instead.';
const connectAction = (plugs = REQUIRED_SNAP_PLUGS) =>
  `Connect the required Multipass snap interfaces (requires sudo): ${plugs.map(plug => `sudo snap connect multipass:${plug}`).join('; ')}.`;
const LINUX_ITEMS = [
  ['host-linux-x64', false, 'Run Moe on a Linux x64 host.'],
  ['multipass-snap', true, 'Install the Multipass 1.17.0 snap from the verified Canonical publisher with strict confinement (requires sudo).'],
  ['snap-interfaces', true, connectAction()],
  ['multipass-installed', true, 'Refresh the Multipass snap so client and daemon both report 1.17.0 (requires sudo).'],
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.'],
  ['driver-qemu', true, 'An administrator configures the Multipass driver to qemu; Moe never changes local.driver.'],
  ['kvm-available', true, 'Enable hardware virtualization in firmware and load the kvm module (requires administrator); Moe never falls back to emulation or host execution.'],
  ['host-cpus', false, RESOURCE_ACTION], ['host-memory', false, RESOURCE_ACTION], ['host-disk', false, RESOURCE_ACTION],
  ['image-cache-location', false, 'Use a non-hidden directory under your home directory for the image cache.'],
];
const linuxItems = (states, plugs) => LINUX_ITEMS.map(([id, requiresElevation, action], at) => ({
  id, satisfied: states[at], requiresElevation, action: plugs && id === 'snap-interfaces' ? connectAction(plugs) : action,
}));
/** Every prerequisite satisfied except the one at index `at`. */
const only = (at, value) => Array.from({ length: LINUX_ITEMS.length }, (_, index) => (index === at ? value : T));
const LINUX_READY = linuxItems(Array(LINUX_ITEMS.length).fill(T));
const satisfiedOf = result => result.prerequisites.map(item => item.satisfied);
const linuxPrerequisites = (changes = {}, transport = linuxTransport()) => linuxPlatform.prerequisites({ provider: { run: transport.run }, ...ROOMY, ...changes });

test('Linux prerequisites pin the snap client and the required plugs of the v1.17.0 snap', async () => {
  assert.equal(Object.isFrozen(linuxPlatform), true);
  assert.deepEqual([linuxPlatform.id, linuxPlatform.arch, linuxPlatform.executable], ['linux', 'x64', SNAP_MULTIPASS]);
  assert.equal(Object.isFrozen(REQUIRED_SNAP_PLUGS), true);
  assert.deepEqual(REQUIRED_SNAP_PLUGS, ['all-home', 'firewall-control', 'kvm', 'multipass-support', 'network-bind', 'network-control']);
  assert.deepEqual([HOST_DISK_HEADROOM_BYTES, MULTIPASS_STORAGE], [2 * GiB, '/var/snap/multipass/common']);
  const transport = linuxTransport();
  const probed = [];
  const result = await linuxPrerequisites({
    statDevice: async file => { probed.push(file); return { isCharacterDevice: () => true }; },
    statfs: async dir => { probed.push(dir); return { bavail: DISK / 4096, bsize: 4096 }; },
  }, transport);
  assert.deepEqual(result, { platform: 'linux', ready: true, providerCode: 'PROVIDER_PREREQUISITES_READY', prerequisites: LINUX_READY, primaryName: 'primary' });
  assert.deepEqual(transport.calls.map(call => call.argv.join(' ')).sort(), [
    `${SNAP_MULTIPASS} get client.primary-name`, `${SNAP_MULTIPASS} get local.driver`, `${SNAP_MULTIPASS} version --format json`,
    `${SNAP} connections multipass`, `${SNAP} ${SNAP_LIST}`,
  ]);
  for (const call of transport.calls) assert.deepEqual(call.options, lifecycleOptions(MAX_PROBE_TIMEOUT_MS));
  assert.deepEqual(probed.sort(), ['/dev/kvm', MULTIPASS_STORAGE]);
  for (const item of result.prerequisites) assert.deepEqual(Object.keys(item), ['id', 'satisfied', 'requiresElevation', 'action']);
});

test('only the strictly confined Canonical-verified Multipass 1.17.0 snap satisfies multipass-snap', async () => {
  const rejected = [{ version: '1.16.1' }, { version: '1.17.0+win' }, { publisher: 'canonical' }, { publisher: 'canonical*' }, { publisher: 'someone**' },
    ...['devmode', 'classic', 'jailmode', 'disabled', 'try', 'broken', 'devmode,disabled'].map(notes => ({ notes }))];
  for (const [answer, expected] of [
    ...rejected.map(row => [snapList(snapRow(row)), F]), [failWith({ code: 'ENOENT' }), F],
    [snapList(), U], [snapList(snapRow(), snapRow()), U], [snapList(`${snapRow()}  extra`), U], [snapList('multipass  1.17.0  14535'), U], [snapRow(), U],
    [snapList(snapRow()).replace('Publisher', 'Developer'), U], ['', U], [undefined, U], [`${snapList(snapRow())}${' '.repeat(MAX_PROBE_BUFFER)}`, U],
    [failWith({ code: 1, stderr: 'error: no matching snaps installed' }), U], [failWith({ killed: true, code: 'ETIMEDOUT' }), U],
  ]) {
    const result = await linuxPrerequisites({}, linuxTransport({ [SNAP_LIST]: answer }));
    assert.deepEqual([result.ready, satisfiedOf(result)], [false, only(1, expected)], JSON.stringify(answer)?.slice(0, 90));
  }
});

test('every required multipassd plug must be connected; the action names exactly the missing connects', async () => {
  for (const plug of REQUIRED_SNAP_PLUGS) {
    const disconnected = REQUIRED_SNAP_PLUGS.map(name => plugRow(name, name === plug ? '-' : undefined));
    const absent = REQUIRED_SNAP_PLUGS.filter(name => name !== plug).map(name => plugRow(name));
    for (const answer of [connections(disconnected), connections(absent)]) {
      const result = await linuxPrerequisites({}, linuxTransport({ 'connections multipass': answer }));
      assert.deepEqual([result.ready, result.prerequisites], [false, linuxItems(only(2, F), [plug])], plug);
    }
  }
  const others = REQUIRED_SNAP_PLUGS.filter(name => !['kvm', 'network-control'].includes(name)).map(name => plugRow(name));
  const two = await linuxPrerequisites({}, linuxTransport({ 'connections multipass': connections([...others, 'kvm  other:kvm  :kvm  -']) }));
  assert.deepEqual(two.prerequisites, linuxItems(only(2, F), ['kvm', 'network-control']));
  for (const answer of [connections().replace('Slot ', 'Slots'), `${connections()}kvm  multipass:kvm  :kvm\n`, '', undefined, failWith({ code: 1 }), failWith({ code: 'ENOENT' })]) {
    const result = await linuxPrerequisites({}, linuxTransport({ 'connections multipass': answer }));
    assert.deepEqual([result.ready, result.prerequisites], [false, linuxItems(only(2, U))], JSON.stringify(answer)?.slice(0, 90));
  }
});

test('a failed provider check marks only its own Linux prerequisite; the doctor runs against the snap client', async () => {
  for (const [code, [host, installed, authenticated, driver]] of [
    ['HOST_UNSUPPORTED', [F, U, U, U]], ['PROVIDER_NOT_FOUND', [U, F, U, U]], ['VERSION_MISMATCH', [U, F, U, U]], ['VERSION_UNSUPPORTED', [U, F, U, U]],
    ['PROVIDER_ACCESS_DENIED', [U, U, F, U]], ['DRIVER_UNSUPPORTED', [U, U, U, F]], ['PROVIDER_TIMEOUT', [U, U, U, U]],
  ]) {
    const seen = [];
    const transport = linuxTransport();
    const result = await linuxPrerequisites({ doctor: async options => { seen.push(options); return doctorReport(code); } }, transport);
    assert.deepEqual([result.ready, result.providerCode, result.primaryName, satisfiedOf(result)],
      [false, code, null, [host, T, T, installed, authenticated, driver, T, T, T, T, T]], code);
    assert.deepEqual(seen, [{ host: LINUX_HOST, executable: SNAP_MULTIPASS, run: transport.run }], code);
  }
  // The real R02 doctor applies the manifest's linux entry: a Windows build or the hcs driver is refused.
  for (const [changes, expected] of [
    [{ 'version --format json': JSON.stringify(version) }, [U, T, T, F, U, U]], [{ 'get local.driver': 'hcs\n' }, [U, T, T, U, U, F]],
    [{ 'version --format json': failWith({ code: 1, stderr: 'The client is not authenticated with the Multipass service.' }) }, [U, T, T, U, F, U]],
  ]) {
    const result = await linuxPrerequisites({}, linuxTransport(changes));
    assert.deepEqual([result.ready, satisfiedOf(result)], [false, [...expected, T, T, T, T, T]], JSON.stringify(changes));
  }
});

test('missing KVM, short resources or an unreadable cache location block without a fallback', async () => {
  const device = (character, error) => async () => { if (error) throw error; return { isCharacterDevice: () => character }; };
  const disk = (bavail, bsize = 4096) => async () => ({ bavail, bsize });
  for (const [changes, at, expected] of [
    [{ statDevice: device(false) }, 6, F], [{ statDevice: device(true, failWith({ code: 'ENOENT' })) }, 6, F],
    [{ statDevice: device(true, failWith({ code: 'EACCES' })) }, 6, U], [{ statDevice: async () => ({}) }, 6, U],
    [{ cpus: () => GUEST_RESOURCES.cpus - 1 }, 7, F], [{ cpus: () => Number.NaN }, 7, U],
    [{ freemem: () => GUEST_RESOURCES.memoryBytes - 1 }, 8, F], [{ freemem: () => undefined }, 8, U],
    [{ statfs: disk(DISK / 4096 - 1) }, 9, F], [{ statfs: disk(DISK - 1, 1) }, 9, F], [{ statfs: disk(1.5) }, 9, U],
    [{ statfs: async () => { throw failWith({ code: 'ENOENT' }); } }, 9, U],
    ...['/home/u/.cache/moe', '/home/u/moe/.x', '/home/u/moe/../.x', '/var/tmp/x', 'moe-images', '/home/u', '/home/u2/x', '/home/u/../u2/x', 7]
      .map(cacheDir => [{ cacheDir }, 10, F]),
    [{ cacheDir: undefined }, 10, U], [{ homedir: () => 'home/u' }, 10, U], [{ cacheDir: 'moe-images', homedir: () => '/' }, 10, F],
  ]) {
    const result = await linuxPrerequisites(changes);
    assert.deepEqual([result.ready, satisfiedOf(result)], [false, only(at, expected)], `${at} ${JSON.stringify(changes)}`);
  }
  const huge = await linuxPrerequisites({ statfs: disk(2n ** 60n, 4096n), cacheDir: '/home/u/a b/moe-images', cpus: () => 64 });
  assert.equal(huge.ready, true);
});

test('Linux checks are isolated: a throwing check is unknown, never ready, and nothing rejects', async () => {
  const boom = () => { throw failWith({ code: 'EIO' }); };
  const result = await linuxPrerequisites({ doctor: async () => boom(), statDevice: boom, statfs: boom, cpus: boom, freemem: boom, homedir: boom },
    linuxTransport({ [SNAP_LIST]: failWith({ code: 'EIO' }), 'connections multipass': failWith({ code: 'EIO' }) }));
  assert.deepEqual(result, { platform: 'linux', ready: false, providerCode: null, prerequisites: linuxItems(Array(LINUX_ITEMS.length).fill(U)), primaryName: null });
});

/** R03's fakeVm behind the Linux snap and doctor answers, recording the executable of every call. */
function linuxVm(h, changes) {
  const transport = linuxTransport(changes);
  const executables = [];
  const run = (executable, args, options) => {
    executables.push(executable);
    return executable === SNAP || ['version', 'get'].includes(args[0]) ? transport.run(executable, args, options) : h.fake.run(executable, args, options);
  };
  return { run, transport, executables };
}
// The two Linux provisioning tests compose POSIX host paths, so they run only where Linux provisioning can.
const onLinux = (h, probes = {}) => ({
  ...linuxPlatform, prerequisites: options => linuxPlatform.prerequisites({ ...ROOMY, homedir: () => path.dirname(h.cacheDir), ...options, ...probes }),
});

test('Linux provisioning does nothing until every prerequisite is satisfied: there is no host fallback', { skip: process.platform === 'win32' }, async t => {
  const noKvm = [{ statDevice: async () => { throw failWith({ code: 'ENOENT' }); } }, {}, only(6, F)];
  for (const [label, [probes, changes, states, plugs]] of Object.entries({
    devmode: [{}, { [SNAP_LIST]: snapList(snapRow({ notes: 'devmode' })) }, only(1, F)],
    unplugged: [{}, { 'connections multipass': connections(REQUIRED_SNAP_PLUGS.slice(0, 2).map(plug => plugRow(plug))) }, only(2, F), REQUIRED_SNAP_PLUGS.slice(2)],
    mismatch: [{}, { 'version --format json': '{"multipass":"1.17.0","multipassd":"1.16.1"}' }, [U, T, T, F, U, U, T, T, T, T, T]],
    noKvm, cpus: [{ cpus: () => 1 }, {}, only(7, F)], memory: [{ freemem: () => Number.NaN }, {}, only(8, U)],
    disk: [{ statfs: async () => ({ bavail: 0, bsize: 4096 }) }, {}, only(9, F)], cache: [{ homedir: () => '/home/nobody' }, {}, only(10, F)],
  })) {
    const h = provisionHarness(t);
    const result = await provisionWith(h, { platform: onLinux(h, probes), provider: { run: linuxVm(h, changes).run } });
    assert.deepEqual(result, { provisioned: false, bootstrapReady: false, executionReady: false, prerequisites: linuxItems(states, plugs) }, label);
    assert.deepEqual([h.download.calls.length, existsSync(h.cacheDir), existsSync(h.ledgerDir), h.fake.commands()], [0, false, false, []], label);
  }
});

test('Linux provisioning launches the pinned image through the snap client without mounts or settings', { skip: process.platform === 'win32' }, async t => {
  const h = provisionHarness(t);
  const vm = linuxVm(h);
  assert.deepEqual(await provisionWith(h, { platform: onLinux(h), provider: { run: vm.run } }), { ...provisioned(), prerequisites: LINUX_READY });
  assert.deepEqual([...new Set(vm.executables)].sort(), [SNAP_MULTIPASS, SNAP]);
  assert.deepEqual(vm.transport.calls.map(call => call.argv.join(' ')).sort(), [
    `${SNAP_MULTIPASS} get client.primary-name`, `${SNAP_MULTIPASS} get local.driver`, `${SNAP_MULTIPASS} version --format json`,
    `${SNAP} connections multipass`, `${SNAP} ${SNAP_LIST}`,
  ]);
  assert.deepEqual(h.fake.launches.map(launch => launch.args), [launchArgs(hostUrl(path.join(h.cacheDir, IMAGE_FILE)))]);
  assert.deepEqual(h.fake.commands(), ['info', 'launch', 'info', ...Array(1 + BOUNDARY.length).fill('exec')]);
  assert.deepEqual(h.fake.guest.unexpected, []);
  const record = await h.ledger.read(GUEST);
  assert.deepEqual([readdirSync(h.ledgerDir), record.phase, record.image], [[`${GUEST}.json`], 'owned', { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH }]);
});

test('Windows provisioning keeps its own multipass client and ignores the cache location argument', async t => {
  const h = provisionHarness(t);
  const executables = new Set();
  const run = (executable, args, options) => { executables.add(executable); return h.fake.run(executable, args, options); };
  assert.deepEqual(await provisionWith(h, { provider: { run } }), provisioned());
  assert.deepEqual([...executables], ['multipass']);
});

test('the CLI selects the Linux platform module and no other host gains one', () => {
  // R05 gave darwin its module (tested in the CQ-R05 section).
  assert.deepEqual([platformFor('linux'), platformFor('win32'), platformFor('darwin'), platformFor('sunos'), platformFor('constructor'), platformFor('toString')],
    [linuxPlatform, windowsPlatform, macosPlatform, null, null, null]);
});

test('real snap and Multipass processes: Linux prerequisites read genuine output and refuse a devmode snap', { skip: process.platform === 'win32' }, async t => {
  const dir = scratch(t);
  const [answersPath, violations, snap, multipass] = ['answers.json', 'violations.log', 'fake snap', 'fake multipass'].map(name => path.join(dir, name));
  const script = `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const [answersPath, violations] = ${JSON.stringify([answersPath, violations])};
const answer = JSON.parse(fs.readFileSync(answersPath, 'utf8'))[process.argv.slice(2).join(' ')];
if (typeof answer === 'string') process.stdout.write(answer);
else {
  fs.appendFileSync(violations, JSON.stringify(process.argv.slice(2)) + '\\n');
  process.exitCode = 64;
}
`;
  for (const file of [snap, multipass]) writeFileSync(file, script, { mode: 0o755 });
  const probe = () => linuxPlatform.prerequisites({ ...ROOMY, provider: { executable: multipass }, snapExecutable: snap });
  writeFileSync(answersPath, JSON.stringify(LINUX_ANSWERS));
  assert.deepEqual(await probe(), { platform: 'linux', ready: true, providerCode: 'PROVIDER_PREREQUISITES_READY', prerequisites: LINUX_READY, primaryName: 'primary' });
  writeFileSync(answersPath, JSON.stringify({ ...LINUX_ANSWERS, [SNAP_LIST]: snapList(snapRow({ notes: 'devmode' })) }));
  const devmode = await probe();
  assert.deepEqual([devmode.ready, satisfiedOf(devmode)], [false, only(1, F)]);
  assert.equal(existsSync(violations), false);
});

// CQ-R05 macOS VM provisioning
import { detectHostArch, MACOS_SUPPORT_MATRIX, macosPlatform } from '../local-runner/platform-macos.mjs';
import { nativeSmokeCore, runNativeProviderSmoke } from '../local-runner/native-smoke.mjs';

const [MAC_HOST, MAC_X64] = [{ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }];
const [SYSCTL, MAC_MULTIPASS, ARM64] = ['/usr/sbin/sysctl', '/usr/local/bin/multipass', '-in hw.optional.arm64'];
const MAC_ANSWERS = { [ARM64]: '1\n', 'version --format json': '{"multipass":"1.17.0+mac","multipassd":"1.17.0+mac"}', 'get local.driver': 'qemu\n',
  'get client.primary-name': 'primary\n' };
const macTransport = (changes = {}) => linuxTransport({ ...MAC_ANSWERS, ...changes });
const macPrerequisites = (changes = {}, transport = macTransport()) => macosPlatform.prerequisites({ provider: { run: transport.run }, host: MAC_HOST, ...changes });
const macItems = (states, { host = 'darwin/arm64', combination } = {}) => [
  ['host-macos', false, `Run Moe on a certified Mac (darwin/x64 or darwin/arm64); this host is ${host}.`],
  ['multipass-installed', true, 'Install Multipass 1.17.0 for macOS (+mac package) as an administrator.'],
  ['multipass-authenticated', true, 'An administrator sets a Multipass passphrase; then run `multipass authenticate` as this user.'],
  ['host-provider-combination', true, combination ? `${combination} is not a certified combination (certified: qemu); Moe never changes local.driver.`
    : 'An administrator configures the Multipass driver to qemu; Moe never changes local.driver.'],
].map(([id, requiresElevation, action], at) => ({ id, satisfied: states[at], requiresElevation, action }));
const macReady = (arch = 'arm64') => ({ platform: 'darwin', arch, ready: true, providerCode: 'PROVIDER_PREREQUISITES_READY', primaryName: 'primary',
  certification: 'not-established', prerequisites: macItems([T, T, T, T], { host: `darwin/${arch}` }) });

test('detectHostArch asks the hardware once: a Rosetta-translated x64 Node on Apple Silicon is arm64', async () => {
  for (const [answer, processArch, expected] of [
    ['1\n', 'x64', 'arm64'], ['1', 'arm64', 'arm64'], ['', 'x64', 'x64'], ['0\n', 'x64', 'x64'], ['', 'arm64', null], ['0', 'ia32', null], ['2', 'x64', null],
    ['1 1', 'arm64', null], [undefined, 'x64', null], [`1${' '.repeat(MAX_PROBE_BUFFER)}`, 'arm64', null], [failWith({ code: 'ENOENT' }), 'x64', null],
  ]) {
    const { run, calls } = linuxTransport({ [ARM64]: answer });
    assert.equal(await detectHostArch({ run, processArch }), expected, JSON.stringify([answer, processArch]).slice(0, 60));
    assert.deepEqual(calls, [{ argv: [SYSCTL, '-in', 'hw.optional.arm64'], options: lifecycleOptions(MAX_PROBE_TIMEOUT_MS) }]);
  }
  assert.equal(await detectHostArch({ run: () => { throw failWith({}); }, processArch: 'x64' }), null);
});

test('macOS prerequisites are explicit operator actions; ready only when all hold on a certified Mac', async () => {
  assert.deepEqual([Object.isFrozen(macosPlatform), macosPlatform.id, macosPlatform.arch, macosPlatform.executable], [true, 'darwin', null, MAC_MULTIPASS]);
  const transport = macTransport();
  const result = await macPrerequisites({}, transport);
  assert.deepEqual(result, macReady());
  assert.deepEqual(transport.calls.map(call => call.argv.join(' ')), [`${SYSCTL} ${ARM64}`, ...commands.map(args => `${MAC_MULTIPASS} ${args.join(' ')}`)]);
  assert.deepEqual(await macPrerequisites({ host: MAC_X64 }), macReady());
  assert.deepEqual(await macPrerequisites({ host: MAC_X64 }, macTransport({ [ARM64]: '' })), macReady('x64'));
  const boom = async () => { throw failWith({ code: 'EIO' }); };
  const broken = await macPrerequisites({ doctor: boom, probe: boom }, macTransport({ [ARM64]: failWith({ code: 'EIO' }) }));
  assert.deepEqual(broken, { ...macReady(), arch: null, ready: false, providerCode: null, prerequisites: macItems([U, U, U, U]), primaryName: null });
});

test('the macOS support matrix mirrors the manifest; every other host/driver pair is named and blocked', async () => {
  assert.equal(Object.isFrozen(MACOS_SUPPORT_MATRIX) && MACOS_SUPPORT_MATRIX.every(Object.isFrozen), true);
  const darwin = (await loadCertifiedProvider()).hosts.filter(entry => entry.platform === 'darwin').map(({ arch, driver }) => ({ arch, driver }));
  assert.deepEqual([MACOS_SUPPORT_MATRIX, darwin], Array(2).fill([{ arch: 'x64', driver: 'qemu' }, { arch: 'arm64', driver: 'qemu' }]));
  for (const [host, changes, states, named] of [
    [MAC_HOST, { 'get local.driver': 'virtualbox\n' }, [T, U, U, F], { combination: 'darwin/arm64 + virtualbox' }],
    [MAC_X64, { [ARM64]: '0\n', 'get local.driver': 'applevz\n' }, [T, U, U, F], { host: 'darwin/x64', combination: 'darwin/x64 + applevz' }],
    ...[['ia32', 'darwin/ia32'], ['Evil Arch', 'darwin/unknown']].map(([arch, named]) => [{ platform: 'darwin', arch }, { [ARM64]: '' }, [F, U, U, U], { host: named }]),
    [MAC_X64, { [ARM64]: '?' }, [U, T, T, T], { host: 'darwin/x64' }], [{ platform: 'linux', arch: 'x64' }, { [ARM64]: '?' }, [F, F, U, U], { host: 'linux/x64' }],
  ]) {
    const transport = macTransport(changes);
    const result = await macPrerequisites({ host }, transport);
    assert.deepEqual([result.ready, result.prerequisites], [false, macItems(states, named)], JSON.stringify([host, named]));
    assert.equal(transport.calls.some(call => call.argv[0] === SYSCTL), host.platform === 'darwin', JSON.stringify(host));
  }
  for (const [driver, probe] of [['Evil;$(x)\n', undefined], ['qemu\n', async () => { throw failWith({ code: 'EIO' }); }], ['qemu\n', async () => ({ driver: 42 })]]) {
    const result = await macPrerequisites({ doctor: async () => doctorReport('DRIVER_UNSUPPORTED'), probe }, macTransport({ 'get local.driver': driver }));
    assert.deepEqual(result.prerequisites, macItems([T, U, U, F], { combination: 'darwin/arm64 + unknown' }), driver);
  }
});

test('the macOS doctor runs against the pkg client for the detected arch; its codes mark only their own item', async () => {
  const seen = [];
  const transport = macTransport();
  const ready = async options => { seen.push(options); return doctorReport('PROVIDER_PREREQUISITES_READY'); };
  assert.equal((await macPrerequisites({ host: MAC_X64, doctor: ready }, transport)).ready, true);
  assert.equal((await macPrerequisites({ provider: { executable: '/opt/mp', run: transport.run }, doctor: ready })).ready, true);
  assert.deepEqual(seen, [{ host: MAC_HOST, executable: MAC_MULTIPASS, run: transport.run }, { host: MAC_HOST, executable: '/opt/mp', run: transport.run }]);
  for (const [code, states] of [['PROVIDER_NOT_FOUND', [T, F, U, U]], ['VERSION_MISMATCH', [T, F, U, U]], ['VERSION_UNSUPPORTED', [T, F, U, U]],
    ['PROVIDER_ACCESS_DENIED', [T, U, F, U]], ['PROVIDER_TIMEOUT', [T, U, U, U]], ['HOST_UNSUPPORTED', [T, U, U, U]]]) {
    const result = await macPrerequisites({ doctor: async () => doctorReport(code) });
    assert.deepEqual([result.ready, result.providerCode, result.primaryName, result.prerequisites], [false, code, null, macItems(states)], code);
  }
  // The real R02 doctor applies the manifest's darwin entry: a Windows build on a Mac is refused.
  assert.deepEqual((await macPrerequisites({}, macTransport({ 'version --format json': JSON.stringify(version) }))).prerequisites, macItems([T, F, U, U]));
});

/** R03's fakeVm behind the macOS sysctl and doctor answers, recording every executable. */
function macVm(h, changes) {
  const transport = macTransport(changes);
  const executables = new Set();
  const run = (executable, args, options) => {
    executables.add(executable);
    return (executable === SYSCTL || ['version', 'get'].includes(args[0]) ? transport.run : h.fake.run)(executable, args, options);
  };
  return { run, executables };
}
const onMac = arch => ({ ...macosPlatform, prerequisites: options => macosPlatform.prerequisites({ ...options, host: { platform: 'darwin', arch } }) });

test('macOS provisioning launches the pinned image of the hardware arch, even under Rosetta; an unknown arch downloads nothing', async t => {
  for (const [sysctl, processArch, arch] of [['1\n', 'x64', 'arm64'], ['1\n', 'arm64', 'arm64'], ['\n', 'x64', 'x64'], ['', 'arm64'], [failWith({}), 'x64'], ['', 'ia32']]) {
    const h = provisionHarness(t);
    const vm = macVm(h, { [ARM64]: sysctl });
    const result = await provisionWith(h, { platform: onMac(processArch), provider: { run: vm.run }, digest: pinDigest(arch).digest });
    if (!arch) {
      assert.deepEqual([result.provisioned, result.prerequisites[0].satisfied], [false, processArch === 'ia32' ? F : U]);
      assert.deepEqual([h.download.calls.length, existsSync(h.cacheDir), existsSync(h.ledgerDir), h.fake.commands()], [0, false, false, []]);
      continue;
    }
    assert.deepEqual([result.provisioned, result.bootstrapReady, result.executionReady, result.image.source], [true, true, false, { arch, ...PINS[arch] }]);
    assert.deepEqual(h.download.calls.map(call => call.target), [PINS[arch].url]);
    assert.deepEqual(h.fake.launches.map(launch => launch.args), [launchArgs(hostUrl(path.join(h.cacheDir, `${PINS[arch].sha256}.img`)))]);
    assert.deepEqual([...vm.executables].sort(), [MAC_MULTIPASS, SYSCTL]);
  }
});

test('provisionGuest prefers the prerequisite arch and refuses any other image arch before any mutation', async t => {
  for (const arch of ['ia32', 'amd64', '']) {
    const h = provisionHarness(t);
    const result = await provisionWith(h, { platform: { ...onWindows(), prerequisites: async options => ({ ...(await onWindows().prerequisites(options)), arch }) } });
    assert.deepEqual(result, { provisioned: false, bootstrapReady: false, executionReady: false, prerequisites: READY_ITEMS }, arch);
    assert.deepEqual([h.download.calls.length, existsSync(h.cacheDir), existsSync(h.ledgerDir), h.fake.commands()], [0, false, false, ['version', 'get', 'get']]);
  }
});

const SMOKE_SUPERVISOR = { code: 0, stdout: `${createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')}  /opt/moe/bin/moe-supervisor\n` };
/** R03's fakeVm, also answering `delete --purge <name>`; its guest holds the smoke's own no-op supervisor (R07 checks the hash). */
function smokeHarness(t, { guest, deleteFails = false, ...fakeOptions } = {}) {
  const workDir = scratch(t);
  const fake = fakeVm({ ...fakeOptions, answers: healthy({ supervisorHash: SMOKE_SUPERVISOR, ...guest }) });
  const [download, deletes] = [fakeFetch(), []];
  // Not async: R03's launch transport carries child.stdin on the returned promise.
  const run = (executable, args, options) => {
    if (args[0] !== 'delete') return fake.run(executable, args, options);
    deletes.push([...args]);
    if (deleteFails) return Promise.reject(failWith({ code: 1 }));
    fake.present.delete(args[2]);
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  const deps = { provider: { run }, fetch: download.fetch, digest: pinDigest().digest, sleep: async () => {}, random: sequence() };
  return { workDir, fake, download, deletes, smoke: (platform = onWindows()) => nativeSmokeCore({ platform, workDir, deps }) };
}
const evidence = changes => ({ kind: 'native-provider-smoke', platform: 'win32', arch: 'x64', result: 'passed', transport: 'injected', supportEstablished: false,
  bootstrapReady: true, image: { sourceSha256: SOURCE.sha256, providerImageHash: PROVIDER_HASH }, failures: [], cleanup: 'deleted', ...changes });
const unready = changes => evidence({ result: 'failed', bootstrapReady: false, image: null, ...changes });

test('an injected smoke passes, deletes only its own guest and never establishes support', async t => {
  const h = smokeHarness(t);
  const foreign = createLedger(path.join(h.workDir, 'ledger'), { random: () => Buffer.alloc(10, 0xab) });
  const other = await seed(foreign, 'owned');
  h.fake.present.set(other.instance, 'Running');
  const result = await h.smoke();
  assert.deepEqual([result, h.deletes, JSON.stringify(result).includes(h.workDir)], [evidence(), [['delete', '--purge', GUEST]], false]);
  assert.deepEqual([(await foreign.read(GUEST)).phase, (await foreign.read(other.instance)).phase, h.fake.present.get(other.instance)], ['deleted', 'owned', 'Running']);
});

test('a blocked, failed or uncleaned smoke is reported as such, and cleanup runs on every path', async t => {
  const blocked = smokeHarness(t);
  assert.deepEqual(await blocked.smoke(onWindows(async () => false)), unready({ result: 'blocked', cleanup: 'none' }));
  assert.deepEqual([blocked.download.calls.length, blocked.fake.launches.length, readdirSync(blocked.workDir)], [0, 0, []]);
  const mounted = smokeHarness(t, { guest: { mountinfo: mountinfo([...MOUNTS, '41 22 0:60 / /home/ubuntu rw - 9p host rw']) } });
  assert.deepEqual([await mounted.smoke(), mounted.deletes], [unready({ failures: ['MOUNTS_PRESENT'] }), [['delete', '--purge', GUEST]]]);
  const exhausted = smokeHarness(t, { launch: () => ({ error: failWith({ code: 1 }), create: false }) });
  assert.deepEqual(await exhausted.smoke(), unready({ failures: ['LIFECYCLE_RETRY_EXHAUSTED'] }));
  const conflict = smokeHarness(t, { primaryName: nameAt(9) });
  assert.deepEqual(await conflict.smoke(), unready({ failures: ['PRIMARY_NAME_CONFLICT'], cleanup: 'none' }));
  assert.deepEqual(await smokeHarness(t, { deleteFails: true }).smoke(), evidence({ cleanup: 'failed' }));
});

test('the native smoke entry takes exactly an absolute workDir: nothing can be injected into it', async () => {
  const spy = () => assert.fail('an injected dependency ran');
  const workDir = path.resolve(tmpdir(), 'moe native smoke');
  for (const options of [undefined, null, {}, [workDir], workDir, { workDir: '' }, { workDir: 'relative/dir' }, { workDir: `${workDir}\n` }, { workDir: 7 },
    { workDir, provider: { run: spy } }, { workDir, fetch: spy }, { workDir, [Symbol('deps')]: { fetch: spy } }]) {
    await assert.rejects(runNativeProviderSmoke(options), error => assertSanitized(error, 'NATIVE_SMOKE_INPUT_INVALID'), JSON.stringify(options));
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'sunos' });
  try {
    await assert.rejects(runNativeProviderSmoke({ workDir }), error => assertSanitized(error, 'NATIVE_SMOKE_UNSUPPORTED_HOST'));
  } finally { Object.defineProperty(process, 'platform', platform); }
  assert.equal(existsSync(workDir), false);
});

test('CLI native-smoke prints the evidence and exits 0 only when native support is established', async () => {
  assert.equal(platformFor('darwin'), macosPlatform);
  const workDir = path.resolve(tmpdir(), 'moe native smoke');
  const cli = async (args, nativeSmoke) => {
    const writes = [];
    const other = async () => assert.fail('not a native-smoke dependency');
    return [await runCli(args, { doctor: other, prerequisites: other, nativeSmoke, write: text => writes.push(text) }), writes.map(text => JSON.parse(text))];
  };
  for (const established of [true, false, 'true']) {
    const [seen, report] = [[], evidence({ transport: 'native', supportEstablished: established })];
    assert.deepEqual([...await cli(['native-smoke', '--work-dir', workDir], async options => { seen.push(options); return report; }), seen],
      [established === true ? 0 : 2, [report], [{ workDir }]]);
  }
  for (const [code, error] of [['NATIVE_SMOKE_UNSUPPORTED_HOST', failWith({ code: 'NATIVE_SMOKE_UNSUPPORTED_HOST' })], ['NATIVE_SMOKE_UNAVAILABLE', failWith({ code: 'EIO' })]]) {
    assert.deepEqual(await cli(['native-smoke', '--work-dir', workDir], async () => { throw error; }), [2, [{ code, supportEstablished: false, executionReady: false }]]);
  }
  for (const args of [['native-smoke'], ['native-smoke', '--work-dir'], ['native-smoke', '--work-dir', 'relative'], ['native-smoke', '--work-dir', `${workDir}\n`],
    ['native-smoke', '--work-dir', workDir, 'extra'], ['native-smoke', '--executable', workDir], ['prerequisites', '--work-dir', workDir]]) {
    const invalid = { code: 'CLI_INPUT_INVALID', providerReady: false, executionReady: false, message: USAGE };
    assert.deepEqual(await cli(args, async () => assert.fail('no smoke on invalid input')), [2, [invalid]], JSON.stringify(args));
  }
});

const NATIVE_SMOKE = process.platform === 'darwin' && process.env.MOE_NATIVE_PROVIDER_SMOKE === '1' && path.isAbsolute(process.env.MOE_NATIVE_SMOKE_WORK_DIR ?? '');
test('opt-in native provider smoke on real macOS hardware establishes support', {
  skip: !NATIVE_SMOKE && 'native provider smoke not run: macOS support is NOT established by this run', timeout: 3_600_000,
}, async () => {
  const result = await runNativeProviderSmoke({ workDir: process.env.MOE_NATIVE_SMOKE_WORK_DIR });
  assert.deepEqual([result.result, result.transport, result.supportEstablished, result.cleanup], ['passed', 'native', true, 'deleted'], JSON.stringify(result));
});

test('real sysctl and Multipass processes: macOS prerequisites read genuine output and name a virtualbox driver', { skip: process.platform === 'win32' }, async t => {
  const dir = scratch(t);
  const [answersPath, sysctl, multipass] = ['answers.json', 'fake sysctl', 'fake multipass'].map(name => path.join(dir, name));
  const script = `#!${process.execPath}
const answer = JSON.parse(process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(answersPath)}, 'utf8'))[process.argv.slice(2).join(' ')];
if (typeof answer === 'string') process.stdout.write(answer); else process.exitCode = 64;
`;
  for (const file of [sysctl, multipass]) writeFileSync(file, script, { mode: 0o755 });
  const probe = answers => {
    writeFileSync(answersPath, JSON.stringify({ ...MAC_ANSWERS, ...answers }));
    return macosPlatform.prerequisites({ provider: { executable: multipass }, sysctlExecutable: sysctl, host: MAC_X64 });
  };
  assert.deepEqual(await probe(), macReady());
  const virtualbox = await probe({ 'get local.driver': 'virtualbox\n' });
  assert.deepEqual([virtualbox.ready, virtualbox.prerequisites], [false, macItems([T, U, U, F], { combination: 'darwin/arm64 + virtualbox' })]);
});

// CQ-R09c copy-only snapshot materialization
import { validateImport } from '../local-runner/source-snapshot.mjs';
import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createFrameDecoder, encodeFrame, MAX_GUEST_FRAME_BYTES, MAX_HOST_FRAME_BYTES } from '../local-runner/guest-bridge.mjs';
import {
  assertNoMounts, hostFrames, materializeSnapshot, runSupervisorStream, SNAPSHOT_CHUNK_BYTES, snapshotArgv, workspaceEntries,
} from '../local-runner/snapshot-transfer.mjs';

const fileOf = (path, bytes, executable = false) => ({ kind: 'file', path, executable, data: Buffer.from(bytes) });
const snapshotOf = (base, overlay = []) => ({
  version: 1, commit: 'a'.repeat(40), tree: 'b'.repeat(40), base: validateImport(base), overlay: validateImport(overlay), excluded: 0,
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// A surfaced error is a fixed code whose message carries no path, guest text or byte.
const transferRefused = code => error => error?.code === code && !/secret|private|[\\/]/.test(error.message);

test('T1 workspaceEntries is the validated base plus overlay replacements and additions, minus overlay deletes', () => {
  const merged = workspaceEntries(snapshotOf([fileOf('a', 'A'), fileOf('b', 'B'), fileOf('c/d', 'D', true)],
    [fileOf('b', 'B2', true), fileOf('e', 'E'), { kind: 'delete', path: 'c/d' }]));
  assert.deepEqual(merged.entries.map(({ path, executable, size, sha256 }) => [path, executable, size, sha256]),
    [['a', false, 1, sha('A')], ['b', true, 2, sha('B2')], ['e', false, 1, sha('E')]]);
  assert.equal(merged.digest, validateImport([fileOf('e', 'E'), fileOf('a', 'A'), fileOf('b', 'B2', true)]).digest);
  const good = snapshotOf([fileOf('a', 'A')]);
  for (const [label, snapshot, code] of [
    ['null', null, 'TRANSFER_INPUT_INVALID'], ['version 2', { ...good, version: 2 }, 'TRANSFER_INPUT_INVALID'],
    ['no overlay', { ...good, overlay: undefined }, 'TRANSFER_INPUT_INVALID'],
    ['entries not an array', { ...good, base: { entries: 'a', digest: good.base.digest } }, 'TRANSFER_INPUT_INVALID'],
    ['a null entry', { ...good, base: { entries: [null], digest: good.base.digest } }, 'TRANSFER_INPUT_INVALID'],
    ['a base delete', { ...good, base: validateImport([{ kind: 'delete', path: 'a' }]) }, 'TRANSFER_INPUT_INVALID'],
    ['a merge collision', snapshotOf([fileOf('a', 'A')], [fileOf('a/x', 'X')]), 'SNAPSHOT_PATH_COLLISION'],
  ]) assert.throws(() => workspaceEntries(snapshot), transferRefused(code), label);
});

test('T2 snapshotArgv is the frozen supervisor argv where only the owned name varies', () => {
  for (const mode of ['materialize', 'export']) {
    const argv = snapshotArgv(GUEST, mode);
    assert.deepEqual(argv, ['exec', '--no-map-working-directory', GUEST, '--', 'sudo', '-n', '/opt/moe/bin/moe-supervisor', mode]);
    assert.equal(Object.isFrozen(argv), true);
  }
  for (const [name, mode] of [[GUEST, 'bridge'], [GUEST, 'MATERIALIZE'], [GUEST, undefined], ['primary', 'materialize'],
    [`${GUEST}\n`, 'export'], [`moe-vm-\0${'a'.repeat(19)}`, 'export'], [undefined, 'export']]) {
    assert.throws(() => snapshotArgv(name, mode), transferRefused('TRANSFER_INPUT_INVALID'), `${name} ${mode}`);
  }
});

const SHARED_LINE = fstype => `40 22 0:50 / /home/ubuntu/src rw,relatime shared:9 - ${fstype} host-share rw`;
const HOST_MOUNT = { '/home/ubuntu/src': { source_path: '/private/secret', uid_mappings: [], gid_mappings: [] } };
test('T3 assertNoMounts runs info then the mountinfo probe and refuses any mount, unknown mounts or provider failure', async () => {
  const fake = fakeGuest();
  assert.equal(await assertNoMounts(GUEST, { run: fake.run }), undefined);
  assert.deepEqual([fake.ids(), fake.unexpected], [['info', 'mountinfo'], []]);
  for (const [label, options, code] of [
    ['provider mount', { info: guestDetail({ mounts: HOST_MOUNT }) }, 'TRANSFER_MOUNTS_PRESENT'],
    ...['9p', 'virtiofs', 'fuse.sshfs'].map(fstype => [fstype, { answers: healthy({ mountinfo: mountinfo([...MOUNTS, SHARED_LINE(fstype)]) }) },
      'TRANSFER_MOUNTS_PRESENT']),
    ['empty mountinfo', { answers: healthy({ mountinfo: { code: 0, stdout: '' } }) }, 'TRANSFER_MOUNTS_UNKNOWN'],
    ['unparsable mountinfo', { answers: healthy({ mountinfo: mountinfo([...MOUNTS, 'secret garbage']) }) }, 'TRANSFER_MOUNTS_UNKNOWN'],
    ['provider failure', { info: { error: failWith({ code: 'ENOENT' }) } }, 'PROVIDER_NOT_FOUND'],
  ]) await assert.rejects(assertNoMounts(GUEST, { run: fakeGuest(options).run }), transferRefused(code), label);
});

// A spawn-compatible supervisor of Node streams. It records every stdin byte and the peak queued stdin length, completes
// each write a turn later and answers once stdin ends; stall never completes a write and answers right after spawn.
// kill() closes asynchronously, as Node does.
function fakeSpawn(respond = proc => proc.reply({ kind: 'materialized', digest: proc.frames()[0].digest }), { stall = false } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], kills: [], written: [], peak: 0 });
  proc.stdin = new Writable({ write(chunk, encoding, done) {
    proc.written.push(chunk);
    proc.peak = Math.max(proc.peak, proc.stdin.writableLength);
    if (!stall) setImmediate(done);
  } });
  proc.frames = () => createFrameDecoder(MAX_HOST_FRAME_BYTES).push(Buffer.concat(proc.written));
  proc.reply = (frames, code = 0, signal = null) => {
    proc.stdout.write(Buffer.concat([frames].flat().map(frame => (Buffer.isBuffer(frame) ? frame : encodeFrame(frame)))));
    proc.stdout.once('close', () => proc.emit('close', code, signal)).end();
  };
  proc.kill = signal => { proc.kills.push(signal); setImmediate(() => proc.emit('close', null, signal)); return true; };
  proc.spawn = (...args) => {
    proc.calls.push(args);
    if (stall) setImmediate(() => respond(proc));
    else proc.stdin.once('finish', () => respond(proc));
    return proc;
  };
  return proc;
}
function transferProvider(guestOptions, respond, spawnOptions) {
  const guest = fakeGuest(guestOptions);
  const proc = fakeSpawn(respond, spawnOptions);
  return { guest, proc, provider: { run: guest.run, spawn: (...args) => { proc.before = guest.ids(); return proc.spawn(...args); } } };
}
const PIPES = { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
const dataFrames = bytes => Array.from({ length: Math.ceil(bytes.length / SNAPSHOT_CHUNK_BYTES) },
  (_, at) => ({ kind: 'data', data: Buffer.from(bytes).subarray(at * SNAPSHOT_CHUNK_BYTES, (at + 1) * SNAPSHOT_CHUNK_BYTES).toString('base64') }));
const BIG = Buffer.alloc(2.5 * SNAPSHOT_CHUNK_BYTES, 7);

test('T4 a clean materialize streams the merged view on the supervisor stdin and resolves the frozen result', async () => {
  const snapshot = snapshotOf([fileOf('src/big.bin', BIG), fileOf('empty', ''), fileOf('run.sh', '#!/bin/sh\n', true)], [fileOf('new.txt', 'N')]);
  const { digest } = workspaceEntries(snapshot);
  const bytes = BIG.length + 11;
  const t = transferProvider();
  const result = await materializeSnapshot({ name: GUEST, snapshot, provider: t.provider });
  assert.deepEqual(result, { instance: GUEST, digest, files: 4, bytes, executionReady: false });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual([t.proc.before, t.guest.ids(), t.guest.unexpected], [['info', 'mountinfo'], ['info', 'mountinfo', 'info', 'mountinfo'], []]);
  assert.deepEqual([t.proc.calls, t.proc.kills], [[['multipass', snapshotArgv(GUEST, 'materialize'), PIPES]], []]);
  assert.equal(dataFrames(BIG).length, 3);
  assert.deepEqual(t.proc.frames(), [{ kind: 'snapshot', version: 1, files: 4, bytes, digest },
    { kind: 'file', path: 'empty', executable: false, size: 0 },
    { kind: 'file', path: 'new.txt', executable: false, size: 1 }, ...dataFrames('N'),
    { kind: 'file', path: 'run.sh', executable: true, size: 10 }, ...dataFrames('#!/bin/sh\n'),
    { kind: 'file', path: 'src/big.bin', executable: false, size: BIG.length }, ...dataFrames(BIG), { kind: 'end' }]);
  assert.deepEqual(Buffer.concat(t.proc.written), Buffer.concat([...hostFrames(workspaceEntries(snapshot))]));
  // Backpressure: a write that fills the queue waits for 'drain', so it never holds more than one data frame past it.
  assert.ok(t.proc.peak <= encodeFrame(dataFrames(BIG)[0]).length + t.proc.stdin.writableHighWaterMark, String(t.proc.peak));
});

test('T5 invalid input or mounts before the stream refuse it without a spawn, and mounts that appear during it refuse the result', async () => {
  const snapshot = snapshotOf([fileOf('a', 'A')]);
  for (const [label, options] of [['primary', { name: 'primary' }], ['snapshot', { snapshot: { ...snapshot, version: 2 } }],
    ['timeout', { timeoutMs: 600_001 }], ['spawn', { provider: { spawn: 'spawn' } }], ['executable', { provider: { executable: 'a\tb' } }]]) {
    const t = transferProvider();
    await assert.rejects(materializeSnapshot({ name: GUEST, snapshot, provider: t.provider, ...options }), transferRefused('TRANSFER_INPUT_INVALID'), label);
    assert.deepEqual([t.guest.calls, t.proc.calls], [[], []], label);
  }
  for (const [label, options, code] of [['provider mount', { info: guestDetail({ mounts: HOST_MOUNT }) }, 'TRANSFER_MOUNTS_PRESENT'],
    ['9p', { answers: healthy({ mountinfo: mountinfo([...MOUNTS, SHARED_LINE('9p')]) }) }, 'TRANSFER_MOUNTS_PRESENT'],
    ['unknown', { answers: healthy({ mountinfo: { code: 0, stdout: '' } }) }, 'TRANSFER_MOUNTS_UNKNOWN']]) {
    const t = transferProvider(options);
    await assert.rejects(materializeSnapshot({ name: GUEST, snapshot, provider: t.provider }), transferRefused(code), label);
    assert.deepEqual([t.guest.ids(), t.proc.calls], [['info', 'mountinfo'], []], label);
  }
  for (const [label, options] of [['late provider mount', { info: [guestDetail(), guestDetail({ mounts: HOST_MOUNT })] }],
    ['late virtiofs', { answers: healthy({ mountinfo: [mountinfo(), mountinfo([...MOUNTS, SHARED_LINE('virtiofs')])] }) }]]) {
    const t = transferProvider(options);
    await assert.rejects(materializeSnapshot({ name: GUEST, snapshot, provider: t.provider }), transferRefused('TRANSFER_MOUNTS_PRESENT'), label);
    assert.deepEqual([t.proc.calls.length, t.guest.ids().length], [1, 4], label);
  }
});

test('T6 a wrong, missing, repeated or malformed answer, a failed exit or a hang is a fixed refusal that kills the child', async () => {
  const snapshot = snapshotOf([fileOf('a', 'A')]);
  const done = { kind: 'materialized', digest: workspaceEntries(snapshot).digest };
  for (const [label, respond, code, kills = ['SIGKILL']] of [
    ['wrong digest', proc => proc.reply({ ...done, digest: 'f'.repeat(64) }), 'TRANSFER_DIGEST_MISMATCH'],
    ['no frame', proc => proc.reply([]), 'TRANSFER_FRAME_INVALID', []],
    ['two frames', proc => proc.reply([done, done]), 'TRANSFER_FRAME_INVALID'],
    ['an extra key', proc => proc.reply({ ...done, extra: 1 }), 'TRANSFER_FRAME_INVALID'],
    ['an unknown kind', proc => proc.reply({ kind: 'exported', digest: done.digest }), 'TRANSFER_FRAME_INVALID'],
    ['malformed JSON', proc => proc.reply(Buffer.from([0, 0, 0, 2, 0x7b, 0x7b])), 'TRANSFER_FRAME_INVALID'],
    ['an oversize frame', proc => proc.reply(Buffer.from([0, 4, 0, 1])), 'TRANSFER_FRAME_INVALID'],
    ['a truncated frame', proc => proc.reply(encodeFrame(done).subarray(0, 9)), 'TRANSFER_FRAME_INVALID'],
    ['a nonzero exit', proc => proc.reply(done, 65), 'TRANSFER_EXIT_FAILED'],
    ['a signal exit', proc => proc.reply(done, null, 'SIGSEGV'), 'TRANSFER_EXIT_FAILED'],
    ['a hang', () => {}, 'TRANSFER_TIMEOUT'],
  ]) {
    const t = transferProvider(undefined, respond);
    await assert.rejects(materializeSnapshot({ name: GUEST, snapshot, provider: t.provider, timeoutMs: label === 'a hang' ? 50 : 5_000 }),
      transferRefused(code), label);
    assert.deepEqual(t.proc.kills, kills, label);
  }
  // Exit 0 before the guest took its input: the first data frame never completes.
  const large = snapshotOf([fileOf('a', BIG)]);
  const early = transferProvider(undefined, proc => proc.reply({ ...done, digest: workspaceEntries(large).digest }), { stall: true });
  await assert.rejects(materializeSnapshot({ name: GUEST, snapshot: large, provider: early.provider }), transferRefused('TRANSFER_EXIT_FAILED'));
  assert.deepEqual(early.proc.kills, ['SIGKILL']);
  const boom = new Error('host check');
  const direct = fakeSpawn(proc => proc.reply({ kind: 'any' }));
  await assert.rejects(runSupervisorStream({ name: GUEST, mode: 'export', provider: { spawn: direct.spawn }, onFrame: () => { throw boom; } }),
    error => error === boom);
  assert.deepEqual([direct.calls[0][1], direct.kills], [snapshotArgv(GUEST, 'export'), ['SIGKILL']]);
  const base = { name: GUEST, mode: 'export', provider: { spawn: fakeSpawn().spawn }, onFrame: () => {} };
  for (const [label, options] of [['no options', null], ['mode', { mode: 'bridge' }], ['onFrame', { onFrame: undefined }],
    ['input string', { input: 'abc' }], ['input object', { input: {} }], ['timeout 0', { timeoutMs: 0 }], ['timeout 1.5', { timeoutMs: 1.5 }]]) {
    await assert.rejects(runSupervisorStream(options && { ...base, ...options }), transferRefused('TRANSFER_INPUT_INVALID'), label);
  }
  for (const spawn of [() => { throw new Error('/private/secret'); }, () => ({}), () => null]) {
    await assert.rejects(runSupervisorStream({ ...base, provider: { spawn } }), transferRefused('TRANSFER_SPAWN_FAILED'));
  }
  const odd = fakeSpawn(() => {});
  await assert.rejects(runSupervisorStream({ ...base, provider: { spawn: odd.spawn }, input: ['not a buffer'] }), transferRefused('TRANSFER_INPUT_INVALID'));
  assert.deepEqual([odd.written, odd.kills], [[], ['SIGKILL']]);
});

// CQ-R09c supervisor rows: the real guest-supervisor.py, loaded under python3 -I -B with importlib as in
// local-runner-bridge.test.mjs (-B: a __pycache__ in scripts/local-runner would ship in both IDE bundles).
const NOT_POSIX = process.platform === 'win32' && 'the guest supervisor runs only in the Linux guest (POSIX python3)';
const PY_SUPERVISOR = fileURLToPath(new URL('../local-runner/guest-supervisor.py', import.meta.url));
const PY_LOAD = `import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('moe_supervisor', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
// materialize() into <dir>/lib, whose parent it creates, owned by the test user; setup runs first in the harness.
const layoutIn = dir => ({ lib: path.join(dir, 'lib'), workspace: path.join(dir, 'lib', 'workspace'),
  manifest: path.join(dir, 'lib', 'workspace.manifest.json') });
function materializeIn(dir, input, setup = '', ...extra) {
  const paths = layoutIn(dir);
  const code = `${PY_LOAD}${setup}\nsys.exit(m.materialize(0, 1, sys.argv[2], sys.argv[3], (os.getuid(), os.getgid())))`;
  return Object.assign(spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, paths.workspace, paths.manifest, ...extra],
    { input, maxBuffer: 64 << 20, timeout: 60_000 }), paths);
}
const framesOf = list => Buffer.concat(list.map(frame => (Buffer.isBuffer(frame) ? frame : encodeFrame(frame))));
const modeOf = file => statSync(file).mode & 0o7777;

test('M1 the supervisor CLI accepts only bridge and materialize, and materialize needs root', { skip: NOT_POSIX }, () => {
  for (const args of [['materialize', 'x'], ['MATERIALIZE']]) {
    const run = spawnSync('python3', ['-I', '-B', PY_SUPERVISOR, ...args]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0], `${args} ${run.stderr}`);
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}sys.exit(m.main(['materialize'], geteuid=lambda: 1000))`, PY_SUPERVISOR]);
  assert.deepEqual([run.status, run.stdout.length], [77, 0], String(run.stderr));
  // As root, 'materialize' runs materialize(0, 1) with the fixed layout defaults, and nothing else.
  const routed = `${PY_LOAD}m.materialize = lambda *a, **k: sys.stderr.write(repr((a, k))) and 42\nsys.exit(m.main(['materialize'], geteuid=lambda: 0))`;
  const root = spawnSync('python3', ['-I', '-B', '-c', routed, PY_SUPERVISOR]);
  assert.deepEqual([root.status, String(root.stderr), root.stdout.length], [42, '((0, 1), {})', 0]);
});

test('M2 a clean stream writes exactly the merged files and the root-only manifest, and answers with the Node digest', { skip: NOT_POSIX }, t => {
  const snapshot = snapshotOf([fileOf('src/main.c', 'int main;\n'), fileOf('bin/run', '#!/bin/sh\n', true), fileOf('src/old', 'x')],
    [fileOf('src/\u{1F600}', BIG.subarray(0, SNAPSHOT_CHUNK_BYTES + 3)), fileOf('src/～', 'w'), fileOf('empty', ''), { kind: 'delete', path: 'src/old' }]);
  const manifest = workspaceEntries(snapshot);
  const run = materializeIn(scratch(t), framesOf([...hostFrames(manifest)]));
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(createFrameDecoder().push(run.stdout), [{ kind: 'materialized', digest: manifest.digest }]);
  assertMaterialized(run, manifest);
});

// Exactly the manifest's files, bytes, owner and modes, no staging tree, and the root-only manifest recording them.
function assertMaterialized(paths, manifest) {
  assert.deepEqual(readdirSync(paths.lib).sort(), ['workspace', 'workspace.manifest.json']);
  const listed = readdirSync(paths.workspace, { recursive: true }).filter(name => statSync(path.join(paths.workspace, name)).isFile());
  assert.deepEqual(listed.sort(), manifest.entries.map(entry => entry.path).sort());
  for (const entry of manifest.entries) {
    const file = path.join(paths.workspace, entry.path);
    assert.deepEqual([readFileSync(file), modeOf(file), statSync(file).uid], [Buffer.from(entry.data), entry.executable ? 0o755 : 0o644, process.getuid()]);
    assert.equal(modeOf(path.dirname(file)), file === path.join(paths.workspace, path.basename(file)) ? 0o700 : 0o755, entry.path);
  }
  assert.deepEqual([modeOf(paths.workspace), modeOf(paths.manifest)], [0o700, 0o600]);
  const stored = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  assert.deepEqual(stored, { version: 1, digest: manifest.digest,
    files: Object.fromEntries(manifest.entries.map(({ path: name, executable, size, sha256 }) => [name, [executable, size, sha256]])) });
  assert.deepEqual(Object.keys(stored.files), manifest.entries.map(entry => entry.path)); // UTF-8 path-byte order
}

test('M3 a malformed, out-of-order or mismatched stream exits 65 with no frame and leaves no workspace, manifest or staging', { skip: NOT_POSIX }, t => {
  const { digest } = workspaceEntries(snapshotOf([fileOf('a', 'A')]));
  const head = (files = 1, bytes = 1, changes = {}) => ({ kind: 'snapshot', version: 1, files, bytes, digest, ...changes });
  const file = (name = 'a', size = 1, changes = {}) => ({ kind: 'file', path: name, executable: false, size, ...changes });
  const data = (text = 'QQ==') => ({ kind: 'data', data: text });
  const END = { kind: 'end' };
  const one = name => [head(), file(name), data(), END];
  for (const [label, frames] of [
    ...['../x', '/abs', 'a//b', 'a\0b', './a', 'a/..', ''].map(name => [JSON.stringify(name), one(name)]),
    ['a duplicate path', [head(2, 2), file(), data(), file(), data(), END]],
    ['a path under a file', [head(2, 2), file(), data(), file('a/b'), data(), END]],
    ['a wrong digest', [head(1, 1, { digest: 'b'.repeat(64) }), file(), data(), END]],
    ['short data', [head(1, 2), file('a', 2), data(), END]], ['long data', [head(1, 2), file('a', 1), data('QUE='), END]],
    ['over the header total', [head(1, 0), file(), data(), END]], ['under the header total', [head(1, 2), file(), data(), END]],
    ['empty data', [head(), file(), data(''), data(), END]],
    ['non-canonical base64', [head(), file(), data('QR=='), END]], ['data before a header', [data(), head(), file(), data(), END]],
    ['a missing end', [head(), file(), data()]], ['bytes after end', [...one('a'), Buffer.from([0])]],
    ['a frame after end', [...one('a'), END]], ['more files than the header counts', [head(1, 2), file(), data(), file('b'), data(), END]],
    ['a version 2 header', [head(1, 1, { version: 2 }), file(), data(), END]], ['a true version', [head(1, 1, { version: true }), file(), data(), END]],
    ['an extra key', [head(), file('a', 1, { mode: 420 }), data(), END]], ['a numeric executable', [head(), file('a', 1, { executable: 1 }), data(), END]],
    ['a truncated frame', [...one('a').slice(0, 3), encodeFrame(END).subarray(0, 5)]],
  ]) {
    const run = materializeIn(scratch(t), framesOf(frames));
    assert.deepEqual([run.status, run.stdout.length, readdirSync(run.lib)], [65, 0, []], `${label} ${run.stderr}`);
  }
  assert.equal(materializeIn(scratch(t), framesOf(one('a'))).status, 0); // each row breaks exactly one rule
  const pair = workspaceEntries(snapshotOf([fileOf('a', 'A'), fileOf('b', 'A')]));
  const reversed = [head(2, 2, { digest: pair.digest }), file('b'), data(), file(), data(), END];
  assert.equal(materializeIn(scratch(t), framesOf(reversed)).status, 0); // the digest sorts by path bytes, whatever the order
});

test('M4 an existing workspace, manifest or symlink exits 73 untouched, and a planted parent symlink is never followed', { skip: NOT_POSIX }, t => {
  const frames = framesOf([...hostFrames(workspaceEntries(snapshotOf([fileOf('a/b', 'B')])))]);
  const outside = scratch(t);
  const listing = lib => readdirSync(lib).map(name => [name, lstatSync(path.join(lib, name)).mtimeMs]);
  for (const [label, plant] of [['workspace', paths => mkdirSync(paths.workspace)], ['manifest', paths => writeFileSync(paths.manifest, 'kept')],
    ['symlink', paths => symlinkSync(outside, paths.workspace)]]) {
    const dir = scratch(t);
    const paths = layoutIn(dir);
    mkdirSync(paths.lib);
    plant(paths);
    const before = listing(paths.lib);
    const run = materializeIn(dir, frames);
    assert.deepEqual([run.status, run.stdout.length, listing(paths.lib)], [73, 0, before], `${label} ${run.stderr}`);
  }
  // os.mkdir patched in the harness plants a symlink to `outside` in place of the parent directory 'a'.
  const planted = `real = os.mkdir
def plant(name, mode=0o777, *, dir_fd=None):
    if dir_fd is None:
        return real(name, mode)
    os.symlink(sys.argv[4], name, dir_fd=dir_fd)
os.mkdir = plant`;
  const run = materializeIn(scratch(t), frames, planted, outside);
  assert.ok([65, 74].includes(run.status), `${run.status} ${run.stderr}`);
  assert.deepEqual([run.stdout.length, readdirSync(run.lib), readdirSync(outside)], [0, [], []]);
  // I/O failures once the manifest is created, and once it is written: no manifest, staging or workspace is left.
  for (const call of ['fsync', 'rename']) {
    const failed = materializeIn(scratch(t), frames, `def fail(*args, **kwargs):\n    raise OSError(5, 'injected')\nos.${call} = fail`);
    assert.deepEqual([failed.status, failed.stdout.length, readdirSync(failed.lib)], [74, 0, []], `${call} ${failed.stderr}`);
  }
});

test('T7 end to end, materializeSnapshot copies the merged view through the real supervisor and refuses a second copy',
  { skip: NOT_POSIX, timeout: 60_000 }, async t => {
    const paths = layoutIn(scratch(t));
    const guest = fakeGuest();
    const launches = [];
    t.after(() => launches.forEach(({ child }) => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')));
    // A spawn that keeps only the argv's final mode and runs that real supervisor function on the child's stdio.
    const spawn = (executable, argv, options) => {
      const code = `${PY_LOAD}sys.exit(m.${argv.at(-1)}(0, 1, sys.argv[2], sys.argv[3], (os.getuid(), os.getgid())))`;
      const child = spawnChild('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, paths.workspace, paths.manifest], options);
      launches.push({ call: [executable, argv, options], before: guest.ids(), child });
      return child;
    };
    const snapshot = snapshotOf([fileOf('a.txt', 'old'), fileOf('bin/tool', '#!/bin/sh\nexit 0\n', true), fileOf('docs/old.md', 'gone')],
      [fileOf('a.txt', 'new text'), fileOf('src/new.js', BIG), { kind: 'delete', path: 'docs/old.md' }]);
    const merged = workspaceEntries(snapshot);
    const copy = () => materializeSnapshot({ name: GUEST, snapshot, provider: { run: guest.run, spawn }, timeoutMs: 30_000 });
    assert.deepEqual(await copy(), { instance: GUEST, digest: merged.digest, files: 3, bytes: 8 + 17 + BIG.length, executionReady: false });
    assert.deepEqual([launches.map(({ call, before }) => [call, before]), guest.ids(), guest.unexpected],
      [[[['multipass', snapshotArgv(GUEST, 'materialize'), PIPES], ['info', 'mountinfo']]], ['info', 'mountinfo', 'info', 'mountinfo'], []]);
    assertMaterialized(paths, merged);
    await assert.rejects(copy(), transferRefused('TRANSFER_EXIT_FAILED'));
    assert.deepEqual([launches.length, launches[1].child.exitCode, guest.ids().length], [2, 73, 6]);
    assertMaterialized(paths, merged); // the first workspace is untouched
  });

// CQ-R11e2: offline, copy-only Node toolchain install; all tarballs are local fixtures.
import * as toolchainTransfer from '../local-runner/snapshot-transfer.mjs';
import { readlinkSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const HAS_DATA_FILTER = spawnSync('python3', ['-I', '-B', '-c', 'import tarfile; exit(0 if hasattr(tarfile, "data_filter") else 1)']).status === 0;
const TOOLCHAIN_SKIP = NOT_POSIX || (!HAS_DATA_FILTER && 'python3 tarfile.data_filter is required');
const { installToolchain, MAX_TOOLCHAIN_BYTES } = toolchainTransfer;
const NODE_MEMBERS = [
  { name: 'node-v1.2.3-linux-x64', type: 'dir', mode: 0o4777 },
  { name: 'node-v1.2.3-linux-x64/bin/node', data: 'node', mode: 0o2777 },
  { name: 'node-v1.2.3-linux-x64/lib/x.js', data: 'npm', mode: 0o666 },
  { name: 'node-v1.2.3-linux-x64/bin/npm', type: 'symlink', linkname: '../lib/x.js' },
];
function tarballOf(dir, members = NODE_MEMBERS, compression = 'gz') {
  const file = path.join(dir, 'fixture.tar');
  const code = `import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:' + sys.argv[2]) as tar:
    for row in json.load(sys.stdin):
        entry = tarfile.TarInfo(row['name'])
        entry.type = {'file': tarfile.REGTYPE, 'dir': tarfile.DIRTYPE, 'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'chr': tarfile.CHRTYPE}[row.get('type', 'file')]
        entry.mode, entry.uid, entry.gid = row.get('mode', 0o644), 12345, 12345
        entry.linkname = row.get('linkname', '')
        data = row.get('data', '').encode()
        entry.size = len(data) if entry.isfile() else 0
        tar.addfile(entry, io.BytesIO(data))`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, file, compression], { input: JSON.stringify(members) });
  assert.equal(run.status, 0, String(run.stderr));
  return readFileSync(file);
}
const toolchainRows = (bytes, overrides = {}) => [{ kind: 'toolchain', version: 1, size: bytes.length, sha256: sha(bytes), ...overrides },
  ...dataFrames(bytes), { kind: 'end' }];
const toolchainFrames = (bytes, overrides) => framesOf(toolchainRows(bytes, overrides));
function toolchainIn(dir, input, setup = '') {
  const toolchain = path.join(dir, 'opt', 'toolchain');
  const code = `${PY_LOAD}${setup}\nsys.exit(m.install_toolchain(0, 1, sys.argv[2]))`;
  return Object.assign(spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, toolchain], { input, timeout: 60_000 }), { toolchain });
}
function assertToolchainRefused(run, status = 65) {
  assert.deepEqual([run.status, run.stdout.length, existsSync(run.toolchain)], [status, 0, false], String(run.stderr));
  const parent = path.dirname(run.toolchain);
  assert.deepEqual(existsSync(parent) ? readdirSync(parent) : [], []);
}
function assertToolchainTree(toolchain) {
  const names = readdirSync(toolchain, { recursive: true }).sort();
  assert.deepEqual(names, ['bin', 'bin/node', 'bin/npm', 'lib', 'lib/x.js']);
  for (const name of ['', ...names]) {
    const info = lstatSync(path.join(toolchain, name));
    assert.equal(info.uid, process.getuid(), name);
    if (!info.isSymbolicLink()) assert.equal(info.mode & 0o7022, 0, name);
  }
  assert.deepEqual([modeOf(path.join(toolchain, 'bin/node')), readFileSync(path.join(toolchain, 'bin/node'), 'utf8'),
    readFileSync(path.join(toolchain, 'bin/npm'), 'utf8'), readlinkSync(path.join(toolchain, 'bin/npm'))], [0o755, 'node', 'npm', '../lib/x.js']);
  assert.deepEqual(readdirSync(path.dirname(toolchain)), ['toolchain']);
}

test('TC1 toolchain CLI routes only the exact root invocation and shares the host bound', { skip: TOOLCHAIN_SKIP }, () => {
  for (const argv of [['toolchain', 'x'], ['TOOLCHAIN']]) {
    const run = spawnSync('python3', ['-I', '-B', PY_SUPERVISOR, ...argv]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0]);
  }
  for (const [uid, status, stderr] of [[1000, 77, ''], [0, 42, '((0, 1), {})']]) {
    const code = `${PY_LOAD}m.install_toolchain = lambda *a, **k: sys.stderr.write(repr((a, k))) and 42\nsys.exit(m.main(['toolchain'], geteuid=lambda: ${uid}))`;
    const run = spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR]);
    assert.deepEqual([run.status, run.stdout.length, String(run.stderr)], [status, 0, stderr]);
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}print(m.MAX_TOOLCHAIN_BYTES)`, PY_SUPERVISOR]);
  assert.deepEqual([run.status, Number(String(run.stdout)), MAX_TOOLCHAIN_BYTES], [0, 134217728, 134217728]);
});
test('TC2 gz and xz install only the fixture tree with safe modes and ownership under umask zero', { skip: TOOLCHAIN_SKIP }, t => {
  for (const compression of ['gz', 'xz']) {
    const bytes = tarballOf(scratch(t), NODE_MEMBERS, compression);
    const dir = path.join(scratch(t), 'alias');
    symlinkSync(scratch(t), dir); // also exercises platforms whose temp parent is itself a symlink
    const run = toolchainIn(dir, toolchainFrames(bytes), 'os.umask(0)');
    assert.equal(run.status, 0, String(run.stderr));
    assert.deepEqual(createFrameDecoder().push(run.stdout), [{ kind: 'installed', sha256: sha(bytes) }]);
    assertToolchainTree(run.toolchain);
  }
});
test('TC3 malformed streams and mismatched pins leave no install or staging', { skip: TOOLCHAIN_SKIP }, t => {
  const bytes = tarballOf(scratch(t));
  const rows = toolchainRows(bytes);
  const invalid = [{ size: bytes.length + 1 }, { sha256: 'b'.repeat(64) }, { version: 2 }, { version: true }, { size: 0 },
    { size: 134217729 }, { size: true }, { sha256: 'A'.repeat(64) }, { sha256: 'a' }, { sha256: null }, { extra: true }];
  const streams = [...invalid.map(head => toolchainRows(bytes, head)),
    [rows[0], { kind: 'data', data: 'QR==' }, rows.at(-1)], [rows[0], { kind: 'data', data: '' }, ...rows.slice(1)],
    [rows[0], ...dataFrames(Buffer.concat([bytes, Buffer.from('x')])), rows.at(-1)], rows.slice(0, -1), [...rows, rows.at(-1)],
    [...rows, Buffer.from([0])], toolchainRows(Buffer.from('not a tarball'))];
  for (const stream of streams) assertToolchainRefused(toolchainIn(scratch(t), framesOf(stream)));
});
test('TC4 hostile tar members never escape staging or install', { skip: TOOLCHAIN_SKIP }, t => {
  const outside = path.join(scratch(t), 'outside');
  const members = [
    [{ name: outside, data: 'escape' }], [{ name: '../escape', data: 'escape' }],
    ...['/etc', '../../x'].map(linkname => [{ name: 'node/link', type: 'symlink', linkname }]),
    [{ name: 'node/hard', type: 'hardlink', linkname: outside }], [{ name: 'node/dev', type: 'chr' }],
    [{ name: 'one', type: 'dir' }, { name: 'two', type: 'dir' }], [{ name: 'node', data: 'file' }],
    [{ name: 'node', type: 'symlink', linkname: 'missing' }],
    [{ name: 'node/link', type: 'symlink', linkname: '..' }],
    [{ name: 'node/hard', type: 'hardlink', linkname: 'missing' }],
    [{ name: 'node/link', type: 'symlink', linkname: '..' }, { name: 'node/link/escape', type: 'symlink', linkname: '../../x' }],
    // Inside the staging top, but outside the install once node is renamed: it re-enters through the top's own name.
    [{ name: 'node', type: 'dir' }, { name: 'node/x', data: 'x' }, { name: 'node/link', type: 'symlink', linkname: '../node/x' }],
  ];
  for (const entries of members) assertToolchainRefused(toolchainIn(scratch(t), toolchainFrames(tarballOf(scratch(t), entries))));
  // Links data_filter never writes ('..' after a name, absolute), planted after extraction; both resolve in staging's top.
  for (const links of [[['s', '.'], ['escape', 's/../node-v1.2.3-linux-x64/bin/node']], [['abs', 'TOP/bin/node']]]) {
    assertToolchainRefused(toolchainIn(scratch(t), toolchainFrames(tarballOf(scratch(t))), `real = m.tarfile.TarFile.extractall
def planted(self, tree, **kwargs):
    real(self, tree, **kwargs)
    top = os.path.join(tree, 'node-v1.2.3-linux-x64')
    for name, target in ${JSON.stringify(links)}: os.symlink(target.replace('TOP', top), os.path.join(top, name))
m.tarfile.TarFile.extractall = planted`));
  }
  assert.equal(existsSync(outside), false);
});
test('TC5 existing installs stay untouched and absent data_filter fails closed', { skip: TOOLCHAIN_SKIP }, t => {
  const input = toolchainFrames(tarballOf(scratch(t)));
  for (const plant of [file => mkdirSync(file), file => writeFileSync(file, 'kept'), file => symlinkSync('missing', file)]) {
    const dir = scratch(t), target = path.join(dir, 'opt', 'toolchain');
    mkdirSync(path.dirname(target));
    plant(target);
    const before = lstatSync(target);
    const run = toolchainIn(dir, input);
    assert.deepEqual([run.status, run.stdout.length, lstatSync(target), readdirSync(path.dirname(target))], [73, 0, before, ['toolchain']]);
  }
  assertToolchainRefused(toolchainIn(scratch(t), input, 'del m.tarfile.data_filter'), 71);
  for (const call of ['fsync', 'rename']) {
    assertToolchainRefused(toolchainIn(scratch(t), input, `def fail(*a, **k):\n    raise OSError(5, 'injected')\nos.${call} = fail`), 74);
  }
  assertToolchainRefused(toolchainIn(scratch(t), input, "def fail(*a):\n    raise OSError(32, 'gone host')\nm.write_frame = fail"), 74);
  assertToolchainRefused(toolchainIn(scratch(t), toolchainFrames(tarballOf(scratch(t)), { sha256: 'b'.repeat(64) }),
    "def fail(*a, **k):\n    raise OSError(5, 'must not extract a mismatch')\nm.tarfile.open = fail"));
  for (const setup of ["os.geteuid = lambda: os.getuid() + 1",
    "real = m.tarfile.TarFile.extractall\ndef unsafe(self, tree, **kwargs):\n    real(self, tree, **kwargs)\n    os.chmod(os.path.join(tree, 'node-v1.2.3-linux-x64/bin/node'), 0o4777)\nm.tarfile.TarFile.extractall = unsafe"]) {
    assertToolchainRefused(toolchainIn(scratch(t), input, setup));
  }
});

function cachedToolchain(t, bytes) {
  const file = path.join(scratch(t), 'node.tar.xz');
  writeFileSync(file, bytes);
  return { file, sha256: sha(bytes), size: bytes.length, version: '1.2.3' };
}
test('TT1 toolchain streams exactly the verified bytes between mount checks', async t => {
  assert.equal(typeof installToolchain, 'function');
  const record = cachedToolchain(t, BIG), reads = {};
  const toolchain = Object.defineProperties({}, Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [key, { enumerable: true, get() { reads[key] = (reads[key] ?? 0) + 1; return value; } }])));
  const p = transferProvider(undefined, proc => proc.reply({ kind: 'installed', sha256: record.sha256 }));
  const run = p.provider.run;
  p.provider.run = (...args) => { writeFileSync(record.file, 'changed after verification'); return run(...args); };
  const result = await installToolchain({ name: GUEST, toolchain, provider: p.provider });
  assert.deepEqual(reads, { file: 1, sha256: 1, size: 1, version: 1 });
  assert.deepEqual(result, { instance: GUEST, sha256: record.sha256, version: '1.2.3', executionReady: false });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(p.proc.frames(), toolchainRows(BIG));
  assert.deepEqual([p.proc.before, p.guest.ids(), p.guest.unexpected], [['info', 'mountinfo'], ['info', 'mountinfo', 'info', 'mountinfo'], []]);
  assert.deepEqual([p.proc.calls, p.proc.kills], [[['multipass', snapshotArgv(GUEST, 'toolchain'), PIPES]], []]);
});
test('TT2 invalid input, cache drift, mounts and guest refusals have fixed codes', async t => {
  assert.equal(typeof installToolchain, 'function');
  const toolchain = cachedToolchain(t, Buffer.from('cache'));
  for (const record of [null, {}, { ...toolchain, extra: 1 }, ...[
    { file: undefined }, { file: 'relative' }, { file: '/bad\npath' }, { sha256: 'A'.repeat(64) }, { size: 0 }, { size: 134217729 },
    { sha256: `${toolchain.sha256}\n` }, { size: NaN }, { size: 1.5 }, { version: 'v1.2.3' }, { version: '1.2.3\n' },
  ].map(change => ({ ...toolchain, ...change }))]) {
    const p = transferProvider();
    await assert.rejects(installToolchain({ name: GUEST, toolchain: record, provider: p.provider }), transferRefused('TRANSFER_INPUT_INVALID'));
    assert.deepEqual([p.guest.calls, p.proc.calls], [[], []]);
  }
  for (const change of [{ name: 'primary' }, { timeoutMs: 0 }, { provider: { spawn: 3 } }]) {
    await assert.rejects(installToolchain({ name: GUEST, toolchain, ...change }), transferRefused('TRANSFER_INPUT_INVALID'));
  }
  for (const change of [{ size: 1 }, { sha256: 'b'.repeat(64) }, { file: `${toolchain.file}-missing` }]) {
    const p = transferProvider();
    await assert.rejects(installToolchain({ name: GUEST, toolchain: { ...toolchain, ...change }, provider: p.provider }), transferRefused('TRANSFER_TOOLCHAIN_MISMATCH'));
    assert.deepEqual([p.guest.calls, p.proc.calls], [[], []]);
  }
  const done = { kind: 'installed', sha256: toolchain.sha256 };
  for (const [frames, code, exit = 0] of [[[], 'TRANSFER_FRAME_INVALID'], [[done, done], 'TRANSFER_FRAME_INVALID'],
    [{ ...done, extra: true }, 'TRANSFER_FRAME_INVALID'], [{ ...done, kind: 'other' }, 'TRANSFER_FRAME_INVALID'],
    [{ ...done, sha256: 'b'.repeat(64) }, 'TRANSFER_DIGEST_MISMATCH'], [done, 'TRANSFER_EXIT_FAILED', 65]]) {
    const p = transferProvider(undefined, proc => proc.reply(frames, exit));
    await assert.rejects(installToolchain({ name: GUEST, toolchain, provider: p.provider }), transferRefused(code));
  }
  for (const info of [guestDetail({ mounts: HOST_MOUNT }), [guestDetail(), guestDetail({ mounts: HOST_MOUNT })]]) {
    const p = transferProvider({ info }, proc => proc.reply(done));
    await assert.rejects(installToolchain({ name: GUEST, toolchain, provider: p.provider }), transferRefused('TRANSFER_MOUNTS_PRESENT'));
    assert.equal(p.proc.calls.length, Array.isArray(info) ? 1 : 0);
  }
});
test('TT3 host to real supervisor installs a fixture and refuses replacement', { skip: TOOLCHAIN_SKIP, timeout: 60_000 }, async t => {
  assert.equal(typeof installToolchain, 'function');
  const toolchain = cachedToolchain(t, tarballOf(scratch(t)));
  const target = path.join(scratch(t), 'opt', 'toolchain'), guest = fakeGuest(), children = [];
  t.after(() => children.forEach(child => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')));
  const spawn = (exe, argv, options) => {
    assert.deepEqual(argv, snapshotArgv(GUEST, 'toolchain'));
    const code = `${PY_LOAD}sys.exit(m.install_toolchain(0, 1, sys.argv[2]))`;
    const child = spawnChild('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, target], options);
    children.push(child);
    return child;
  };
  const install = () => installToolchain({ name: GUEST, toolchain, provider: { run: guest.run, spawn } });
  assert.equal((await install()).sha256, toolchain.sha256);
  assertToolchainTree(target);
  await assert.rejects(install(), transferRefused('TRANSFER_EXIT_FAILED'));
  assert.deepEqual([children.length, children[1].exitCode], [2, 73]);
  assertToolchainTree(target);
});
test('TT4 a cache file growing after stat cannot cause an unbounded read', async t => {
  const toolchain = cachedToolchain(t, Buffer.from('cache')), p = transferProvider();
  const original = { stat: fsPromises.stat, readFile: fsPromises.readFile, open: fsPromises.open };
  let readBytes = 0;
  const grow = info => { writeFileSync(toolchain.file, Buffer.alloc(100)); return info; };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fsPromises, 'stat', async (...args) => grow(await original.stat(...args)));
  t.mock.method(fsPromises, 'readFile', async (...args) => { const bytes = await original.readFile(...args); readBytes += bytes.length; return bytes; });
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await original.open(...args), stat = handle.stat.bind(handle), read = handle.read.bind(handle);
    t.mock.method(handle, 'stat', async () => grow(await stat()));
    t.mock.method(handle, 'read', async (...args) => { const result = await read(...args); readBytes += result.bytesRead; return result; });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(installToolchain({ name: GUEST, toolchain, provider: p.provider }), transferRefused('TRANSFER_TOOLCHAIN_MISMATCH'));
  assert.deepEqual([p.guest.calls, p.proc.calls], [[], []]);
  assert.ok(readBytes <= toolchain.size + 1, `read ${readBytes} bytes for a ${toolchain.size}-byte pin`);
});

// CQ-R09 export rows: export() walks a workspace that materialize() built, changed as the agent would.
import { chmodSync, renameSync, truncateSync } from 'node:fs';

const EXPORT_BASE = [fileOf('a.txt', 'A'), fileOf('bin/run', '#!/bin/sh\n', true), fileOf('src/main.c', 'int main;\n'), fileOf('src/util.c', 'u')];
const exportData = bytes => Array.from({ length: Math.ceil(Buffer.from(bytes).length / 65_536) },
  (_, at) => ({ kind: 'data', data: Buffer.from(bytes).subarray(at * 65_536, (at + 1) * 65_536).toString('base64') }));
const mkfifo = file => assert.equal(spawnSync('mkfifo', [file]).status, 0);
function workspaceIn(t) {
  const run = materializeIn(scratch(t), framesOf([...hostFrames(workspaceEntries(snapshotOf(EXPORT_BASE)))]));
  assert.equal(run.status, 0, String(run.stderr));
  return run;
}
// export() into stdout with a no-op drop, or the real drop_to_agent when drop is null; setup runs first in the harness.
function exportIn(paths, setup = '', drop = 'lambda: None', ...extra) {
  const code = `${PY_LOAD}${setup}\nsys.exit(m.export(1, sys.argv[2], sys.argv[3]${drop ? `, ${drop}` : ''}))`;
  return spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, paths.workspace, paths.manifest, ...extra], { maxBuffer: 64 << 20, timeout: 60_000 });
}

test('X1 the supervisor CLI takes exactly export, only as root, and routes it to export(1)', { skip: NOT_POSIX }, () => {
  for (const args of [['export', 'x'], ['EXPORT']]) {
    const run = spawnSync('python3', ['-I', '-B', PY_SUPERVISOR, ...args]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0], `${args} ${run.stderr}`);
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}sys.exit(m.main(['export'], geteuid=lambda: 1000))`, PY_SUPERVISOR]);
  assert.deepEqual([run.status, run.stdout.length], [77, 0], String(run.stderr));
  const routed = `${PY_LOAD}m.export = lambda *a, **k: sys.stderr.write(repr((a, k))) and 42\nsys.exit(m.main(['export'], geteuid=lambda: 0))`;
  const root = spawnSync('python3', ['-I', '-B', '-c', routed, PY_SUPERVISOR]);
  assert.deepEqual([root.status, String(root.stderr), root.stdout.length], [42, '((1,), {})', 0]);
});

test('X2 export reports exactly the changed files, deletes, symlinks and specials, and no identity', { skip: NOT_POSIX }, t => {
  const edit = Buffer.alloc(150_000, 'e');
  const end = entries => ({ kind: 'end', entries });
  const file = (name, executable, size) => ({ kind: 'file', path: name, executable, size });
  for (const [label, change, frames, setup] of [
    ['unchanged', () => {}, [end(0)]],
    ['an edit', at => writeFileSync(at('src/main.c'), edit), [file('src/main.c', false, 150_000), ...exportData(edit), end(1)]],
    ['an edit read 1,000 bytes at a time still goes out in full chunks', at => writeFileSync(at('src/main.c'), edit),
      [file('src/main.c', false, 150_000), ...exportData(edit), end(1)], 'real = os.read\nos.read = lambda fd, n: real(fd, min(n, 1000))'],
    ['a same-size edit', at => writeFileSync(at('src/util.c'), 'v'), [file('src/util.c', false, 1), ...exportData('v'), end(1)]],
    ['a chmod +x', at => chmodSync(at('a.txt'), 0o755), [file('a.txt', true, 1), ...exportData('A'), end(1)]],
    ['a new nested empty file', at => { mkdirSync(at('new/deep'), { recursive: true }); writeFileSync(at('new/deep/x'), ''); },
      [file('new/deep/x', false, 0), end(1)]],
    ['a delete', at => rmSync(at('src/util.c')), [{ kind: 'delete', path: 'src/util.c' }, end(1)]],
    ['a symlink to a file', at => symlinkSync('src/main.c', at('link')), [{ kind: 'symlink', path: 'link' }, end(1)]],
    ['a symlink to a directory, never descended', at => symlinkSync('src', at('dir')), [{ kind: 'symlink', path: 'dir' }, end(1)]],
    ['a FIFO', at => mkfifo(at('pipe')), [{ kind: 'special', path: 'pipe' }, end(1)]],
    ['a file replaced by a directory', at => { rmSync(at('a.txt')); mkdirSync(at('a.txt')); writeFileSync(at('a.txt/in'), 'I'); },
      [file('a.txt/in', false, 1), ...exportData('I'), { kind: 'delete', path: 'a.txt' }, end(2)]],
  ]) {
    const paths = workspaceIn(t);
    change(name => path.join(paths.workspace, name));
    const run = exportIn(paths, setup);
    assert.deepEqual([run.status, createFrameDecoder().push(run.stdout)], [0, frames], `${label} ${run.stderr}`);
  }
});

test('X3 export refuses a bad manifest or root, drops to the agent before any entry, and fails closed on a bound or a swap', { skip: NOT_POSIX }, t => {
  const refused = (run, status, label) => assert.deepEqual([run.status, run.stdout.length], [status, 0], `${label} ${run.stderr}`);
  const rewrite = edit => paths => writeFileSync(paths.manifest, JSON.stringify(edit(JSON.parse(readFileSync(paths.manifest, 'utf8')))));
  const row = value => rewrite(stored => ({ ...stored, files: { ...stored.files, 'a.txt': value(stored.files['a.txt']) } }));
  const relink = file => { renameSync(file, `${file}.real`); symlinkSync(`${file}.real`, file); };
  for (const [label, change] of [
    ['a missing manifest', paths => rmSync(paths.manifest)], ['a symlinked manifest', paths => relink(paths.manifest)],
    ['a FIFO manifest', paths => { rmSync(paths.manifest); mkfifo(paths.manifest); }],
    ['an oversize manifest', paths => writeFileSync(paths.manifest, readFileSync(paths.manifest, 'utf8').padEnd(2 ** 24 + 1))],
    ['not JSON', paths => writeFileSync(paths.manifest, '{')], ['version 2', rewrite(stored => ({ ...stored, version: 2 }))],
    ['version true', rewrite(stored => ({ ...stored, version: true }))], ['an extra key', rewrite(stored => ({ ...stored, extra: 1 }))],
    ['an uppercase digest', rewrite(stored => ({ ...stored, digest: stored.digest.toUpperCase() }))],
    ['files as a list', rewrite(stored => ({ ...stored, files: [] }))],
    ['a numeric executable', row(([, size, sha256]) => [0, size, sha256])], ['a negative size', row(([executable, , sha256]) => [executable, -1, sha256])],
    ['a short sha256', row(([executable, size, sha256]) => [executable, size, sha256.slice(1)])], ['a fourth field', row(value => [...value, 0])],
    ['a missing workspace', paths => rmSync(paths.workspace, { recursive: true })], ['a symlinked workspace', paths => relink(paths.workspace)],
  ]) {
    const paths = workspaceIn(t);
    change(paths);
    refused(exportIn(paths), 65, label);
  }
  // The real drop_to_agent with the account lookup and set*id calls recorded: the manifest and root opens come first,
  // as root, then setgroups, setgid and setuid in that order, and only then any entry open.
  const recorder = `import atexit, json
log = []
real = os.open
os.open = lambda name, flags, mode=0o777, *, dir_fd=None: log.append('open' if dir_fd is None else 'at') or real(name, flags, mode, dir_fd=dir_fd)
for call in ('setgroups', 'setgid', 'setuid'):
    setattr(os, call, lambda value, call=call: log.append([call, value]))
m.pwd.getpwnam = lambda name: log.append(['getpwnam', name]) or m.types.SimpleNamespace(pw_uid=1234, pw_gid=5678)
atexit.register(lambda: sys.stderr.write(json.dumps(log)))`;
  const dropped = exportIn(workspaceIn(t), recorder, null);
  assert.deepEqual([dropped.status, createFrameDecoder().push(dropped.stdout), JSON.parse(dropped.stderr)], [0, [{ kind: 'end', entries: 0 }],
    ['open', 'open', ['getpwnam', 'moe-agent'], ['setgroups', []], ['setgid', 5678], ['setuid', 1234], ...Array(6).fill('at')]]);
  const deny = `os.setgroups = os.setgid = lambda value: None\nm.pwd.getpwnam = lambda name: m.types.SimpleNamespace(pw_uid=1234, pw_gid=5678)
def deny(value):\n    raise PermissionError(1, 'injected')\nos.setuid = deny`;
  for (const [label, setup] of [['no agent account', "m.AGENT_IDENTITY = 'moe-no-such-account'"], ['a refused setuid', deny]]) {
    refused(exportIn(workspaceIn(t), setup, null), 71, label);
  }
  // Bounds, with no end frame: 10,001 new entries stop after exactly 10,000 frames; a 64 GiB sparse file and a 1025-byte
  // path stop before their frame; WALK_LIMIT counts every name visited.
  const flood = workspaceIn(t);
  mkdirSync(path.join(flood.workspace, 'many'));
  for (let index = 0; index <= 10_000; index += 1) writeFileSync(path.join(flood.workspace, 'many', `${index}`), '');
  const many = exportIn(flood);
  const sent = createFrameDecoder().push(many.stdout);
  assert.deepEqual([many.status, sent.length, sent.every(frame => frame.kind === 'file')], [65, 10_000, true]);
  const sparse = workspaceIn(t);
  truncateSync(path.join(sparse.workspace, 'a.txt'), 2 ** 36);
  refused(exportIn(sparse), 65, 'a sparse file');
  if (process.platform !== 'darwin') { // macOS caps a whole path at 1024 bytes; the guest is Linux
    const deep = workspaceIn(t);
    const folder = path.join(deep.workspace, ...Array(4).fill('d'.repeat(250)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'f'.repeat(20)), '');
    const fits = exportIn(deep);
    assert.deepEqual([fits.status, Buffer.byteLength(createFrameDecoder().push(fits.stdout)[0].path)], [0, 1024]);
    renameSync(path.join(folder, 'f'.repeat(20)), path.join(folder, 'f'.repeat(21)));
    refused(exportIn(deep), 65, 'a 1025-byte path');
  }
  for (const [limit, status] of [[6, 0], [5, 65]]) assert.equal(exportIn(workspaceIn(t), `m.WALK_LIMIT = ${limit}`).status, status);
  // A name swapped between lstat and open, for a file from outside or a FIFO, and a file the agent made unreadable: 74.
  const swap = `real = os.lstat
def lstat(name, *, dir_fd=None):
    info = real(name, dir_fd=dir_fd)
    if name == 'a.txt':
        os.unlink(name, dir_fd=dir_fd)
        if sys.argv[4] == 'fifo':
            os.mkfifo(name, dir_fd=dir_fd)
        else:
            os.rename(sys.argv[4], name, dst_dir_fd=dir_fd)
    return info
os.lstat = lstat`;
  const outside = path.join(scratch(t), 'outside');
  writeFileSync(outside, 'host-only secret');
  for (const [label, setup, extra] of [['a swapped-in file', swap, outside], ['a swapped-in FIFO', swap, 'fifo'],
    ...(process.getuid() === 0 ? [] : [['an unreadable file', 'os.chmod(sys.argv[2] + "/a.txt", 0)', '']])]) {
    refused(exportIn(workspaceIn(t), setup, 'lambda: None', extra), 74, label);
  }
});

// CQ-R09 import rows: importCandidate over a fake guest; exportFrames is what the supervisor's export sends for entries.
import { importCandidate } from '../local-runner/snapshot-import.mjs';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, MAX_IMPORT_PATH_BYTES } from '../local-runner/source-snapshot.mjs';

const exportFrames = entries => [...entries.flatMap(entry => (entry.kind !== 'file' ? [entry]
  : [{ kind: 'file', path: entry.path, executable: entry.executable, size: entry.data.length }, ...exportData(entry.data)])),
{ kind: 'end', entries: entries.length }];

test('X4 a clean export resolves exactly what validateImport derives from the transferred bytes, between two mount checks', async () => {
  const entries = [fileOf('src/big.bin', BIG, true), fileOf('empty', ''), { kind: 'delete', path: 'old.txt' }];
  const t = transferProvider(undefined, proc => proc.reply(exportFrames(entries)));
  const result = await importCandidate({ name: GUEST, provider: t.provider });
  assert.deepEqual(result, { instance: GUEST, candidate: validateImport(entries), executionReady: false });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual([t.proc.before, t.guest.ids(), t.guest.unexpected], [['info', 'mountinfo'], ['info', 'mountinfo', 'info', 'mountinfo'], []]);
  assert.deepEqual([t.proc.calls, t.proc.kills, t.proc.written], [[['multipass', snapshotArgv(GUEST, 'export'), PIPES]], [], []]);
  await assert.rejects(importCandidate(), transferRefused('TRANSFER_INPUT_INVALID'));
  for (const [label, options, code] of [
    ['primary', { name: 'primary' }, 'TRANSFER_INPUT_INVALID'], ['provider', { provider: [] }, 'LIFECYCLE_INPUT_INVALID'],
    ['executable', { provider: { executable: 'a\tb' } }, 'PROVIDER_INPUT_INVALID'], ['spawn', { provider: { spawn: 'spawn' } }, 'IMPORT_INPUT_INVALID'],
    ...[0, 1.5, 600_001].map(timeoutMs => [`timeout ${timeoutMs}`, { timeoutMs }, 'IMPORT_INPUT_INVALID']),
  ]) {
    const refused = transferProvider();
    await assert.rejects(importCandidate({ name: GUEST, provider: refused.provider, ...options }), transferRefused(code), label);
    assert.deepEqual([refused.guest.calls, refused.proc.calls], [[], []], label);
  }
  for (const [label, options, code] of [['provider mount', { info: guestDetail({ mounts: HOST_MOUNT }) }, 'TRANSFER_MOUNTS_PRESENT'],
    ['unknown', { answers: healthy({ mountinfo: { code: 0, stdout: '' } }) }, 'TRANSFER_MOUNTS_UNKNOWN']]) {
    const early = transferProvider(options, proc => proc.reply(exportFrames(entries)));
    await assert.rejects(importCandidate({ name: GUEST, provider: early.provider }), transferRefused(code), label);
    assert.deepEqual([early.guest.ids(), early.proc.calls], [['info', 'mountinfo'], []], label);
  }
  const late = transferProvider({ answers: healthy({ mountinfo: [mountinfo(), mountinfo([...MOUNTS, SHARED_LINE('virtiofs')])] }) },
    proc => proc.reply(exportFrames(entries)));
  await assert.rejects(importCandidate({ name: GUEST, provider: late.provider }), transferRefused('TRANSFER_MOUNTS_PRESENT'));
  assert.deepEqual([late.proc.calls.length, late.guest.ids()], [1, ['info', 'mountinfo', 'info', 'mountinfo']]);
});

test('X5 a well-formed hostile export is refused by validateImport with its R09a code and no candidate', async () => {
  for (const [label, entries, code] of [
    ...['../x', '/abs', 'a/../b', 'a\\b', 'GIT~1/config', '\udcff'].map(name => [name, [fileOf(name, 'x')], 'SNAPSHOT_PATH_INVALID']),
    ...['.git/config', '.moe/x', 'sub/.Claude/settings.json'].map(name => [name, [fileOf(name, 'x')], 'SNAPSHOT_CONTROL_PATH']),
    ['a symlink', [{ kind: 'symlink', path: 'link' }], 'SNAPSHOT_SYMLINK_DENIED'], ['a special file', [{ kind: 'special', path: 'pipe' }], 'SNAPSHOT_ENTRY_INVALID'],
    ['case-folded duplicates', [fileOf('A', 'x'), fileOf('a', 'y')], 'SNAPSHOT_PATH_COLLISION'],
    ['an ancestor collision', [fileOf('a', 'x'), fileOf('a/b', 'y')], 'SNAPSHOT_PATH_COLLISION'],
  ]) {
    const t = transferProvider(undefined, proc => proc.reply(exportFrames(entries)));
    await assert.rejects(importCandidate({ name: GUEST, provider: t.provider }), transferRefused(code), label);
    assert.equal(t.proc.calls.length, 1, label);
  }
});

test('X6 a protocol violation or bound is refused at its frame, and a cut, failed or hung stream is refused, each with a fixed code', async () => {
  const head = (changes = {}) => ({ kind: 'file', path: 'a', executable: false, size: 1, ...changes });
  const data = text => ({ kind: 'data', data: text });
  const end = entries => ({ kind: 'end', entries });
  const deletes = count => Array.from({ length: count }, (_, at) => ({ kind: 'delete', path: `d${at}` }));
  const chunk = data(Buffer.alloc(65_536).toString('base64')); // one full data frame, so 1 byte of a 65,537-byte file is left
  const longest = `${'a/'.repeat(MAX_IMPORT_PATH_BYTES / 2 - 1)}ab`; // a valid multi-segment path of exactly MAX_IMPORT_PATH_BYTES
  // The guest writes these frames and then stalls, so only a refusal at the offending frame ends the import in time.
  for (const [label, frames, code = 'IMPORT_PROTOCOL_VIOLATION'] of [
    ['a sha256 key', [head({ sha256: sha('A') }), data('QQ=='), end(1)]], ['an oid key', [head({ oid: 'a'.repeat(40) }), data('QQ=='), end(1)]],
    ['data before a header', [data('QQ=='), head(), data('QQ=='), end(1)]], ['data past size', [head(), data('QUE=')]],
    ['a short data frame that is not the last', [head({ size: 2 }), data('QQ=='), data('QQ=='), end(1)]],
    ['a header inside a file', [head({ size: 65_537 }), chunk, head({ path: 'b' }), data('QQ=='), end(2)]],
    ['non-canonical base64', [head(), data('QR=='), end(1)]], ['empty data', [head(), data(''), data('QQ=='), end(1)]],
    ['an end count mismatch', [head(), data('QQ=='), end(2)]], ['a frame after end', [head(), data('QQ=='), end(1), end(1)]],
    ['an unknown kind', [{ kind: 'directory', path: 'd' }, end(1)]], ['an array kind', [{ kind: ['delete'], path: 'd' }, end(1)]],
    ['a numeric path', [{ kind: 'delete', path: 1 }, end(1)]], ['a numeric executable', [head({ executable: 1 }), data('QQ=='), end(1)]],
    ['a negative size', [head({ size: -1 })]], ['a string size', [head({ size: '1' }), data('QQ=='), end(1)]],
    ['a count over MAX_IMPORT_ENTRIES', [...deletes(MAX_IMPORT_ENTRIES + 1), end(MAX_IMPORT_ENTRIES + 1)], 'SNAPSHOT_LIMIT_EXCEEDED'],
    ['a declared size over MAX_IMPORT_BYTES', [head({ size: MAX_IMPORT_BYTES + 1 }), data('QQ==')], 'SNAPSHOT_LIMIT_EXCEEDED'],
    ...[{ kind: 'delete' }, { kind: 'symlink' }, { kind: 'special' }, head()].map(frame => [`a ${frame.kind} path over MAX_IMPORT_PATH_BYTES`,
      [{ ...frame, path: `${longest}b` }], 'SNAPSHOT_PATH_INVALID']),
    ['a path over MAX_IMPORT_PATH_BYTES in UTF-8 bytes only', [{ kind: 'delete', path: '\u00e9'.repeat(MAX_IMPORT_PATH_BYTES / 2 + 1) }], 'SNAPSHOT_PATH_INVALID'],
  ]) {
    const t = transferProvider(undefined, proc => proc.stdout.write(framesOf(frames)));
    await assert.rejects(importCandidate({ name: GUEST, provider: t.provider, timeoutMs: 2_000 }), transferRefused(code), label);
    assert.deepEqual([t.proc.kills, t.guest.ids()], [['SIGKILL'], ['info', 'mountinfo']], label);
  }
  const full = transferProvider(undefined, proc => proc.reply(exportFrames([...deletes(MAX_IMPORT_ENTRIES - 1), { kind: 'delete', path: longest }])));
  const admitted = (await importCandidate({ name: GUEST, provider: full.provider })).candidate.entries;
  assert.deepEqual([admitted.length, admitted[0].path], [MAX_IMPORT_ENTRIES, longest]); // both bounds admit their limit
  for (const [label, respond, code, timeoutMs = 5_000, kills = ['SIGKILL']] of [
    ['a stream ending mid-file', proc => proc.reply([head({ size: 65_537 }), chunk]), 'IMPORT_PROTOCOL_VIOLATION', undefined, []],
    ['a missing end', proc => proc.reply([head(), data('QQ==')]), 'IMPORT_PROTOCOL_VIOLATION', undefined, []],
    ['a nonzero exit', proc => proc.reply(exportFrames([]), 65), 'TRANSFER_EXIT_FAILED'], ['a hang', () => {}, 'TRANSFER_TIMEOUT', 50],
  ]) {
    const t = transferProvider(undefined, respond);
    await assert.rejects(importCandidate({ name: GUEST, provider: t.provider, timeoutMs }), transferRefused(code), label);
    assert.deepEqual(t.proc.kills, kills, label);
  }
});

// CQ-R09 round trip: the real R09b exporter, R09c transfer and supervisor, and importCandidate, over one fake guest each.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { exportSourceSnapshot } from '../local-runner/source-export.mjs';

const SEAM_CALLS = {
  materialize: 'm.materialize(0, 1, sys.argv[2], sys.argv[3], (os.getuid(), os.getgid()))',
  export: 'm.export(1, sys.argv[2], sys.argv[3], lambda: None)',
};
// A committed checkout with an executable, a nested path and a committed .moe/x, then a modified, an untracked and a deleted file.
function dirtyRepo(t) {
  const dir = realpathSync(scratch(t));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=moe', '-c', 'user.email=moe@test', '-c', 'core.autocrlf=false', ...args],
    { cwd: dir, env, stdio: 'pipe' }).toString().trim();
  const put = (name, data) => { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), data); };
  git('init', '-q');
  Object.entries({ 'run.sh': '#!/bin/sh\necho base\n', 'src/deep/lib.c': 'int lib;\n', 'README.md': 'base readme\n',
    'notes.txt': 'to be deleted\n', '.moe/x': 'control\n' }).forEach(([name, data]) => put(name, data));
  chmodSync(path.join(dir, 'run.sh'), 0o755);
  git('add', '-A');
  git('update-index', '--chmod=+x', 'run.sh');
  git('commit', '-q', '-m', 'base');
  put('README.md', 'dirty readme\n');
  put('src/new.c', 'int added;\n');
  rmSync(path.join(dir, 'notes.txt'));
  return { dir, head: git('rev-parse', 'HEAD') };
}

test('X7 end to end, a dirty checkout round-trips through the real supervisor and only the agent changes come back, never a refused one',
  { skip: NOT_POSIX, timeout: 120_000 }, async t => {
    const sessions = [];
    const stdout = [];
    t.after(() => sessions.flatMap(s => s.launches).forEach(({ child }) => child.exitCode === null && child.signalCode === null
      && child.kill('SIGKILL')));
    const { dir, head } = dirtyRepo(t);
    const snapshot = await exportSourceSnapshot({ repoDir: dir, commit: head });
    assert.deepEqual([snapshot.excluded, [...snapshot.base.entries, ...snapshot.overlay.entries].map(({ kind, path: name }) => [kind, name])],
      [1, [['file', 'README.md'], ['file', 'notes.txt'], ['file', 'run.sh'], ['file', 'src/deep/lib.c'],
        ['file', 'README.md'], ['delete', 'notes.txt'], ['file', 'src/new.c']]]);
    const merged = workspaceEntries(snapshot);
    // One fresh layout and fake guest per session. The spawn keeps only the argv's final mode and runs that real supervisor
    // function on the child's stdio, recording every guest stdout byte.
    const session = guestOptions => {
      const paths = layoutIn(scratch(t));
      const s = { guest: fakeGuest(guestOptions), launches: [], at: name => path.join(paths.workspace, name) };
      const spawn = (executable, argv, options) => {
        const code = `${PY_LOAD}sys.exit(${SEAM_CALLS[argv.at(-1)]})`;
        const child = spawnChild('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, paths.workspace, paths.manifest], options);
        child.stdout.on('data', chunk => stdout.push(chunk));
        s.launches.push({ call: [executable, argv, options], child });
        return child;
      };
      const provider = { run: s.guest.run, spawn };
      s.copy = () => materializeSnapshot({ name: GUEST, snapshot, provider, timeoutMs: 30_000 });
      s.take = () => importCandidate({ name: GUEST, provider, timeoutMs: 30_000 });
      sessions.push(s);
      return s;
    };
    const main = session();
    assert.deepEqual(await main.copy(), { instance: GUEST, digest: merged.digest, files: 4,
      bytes: merged.entries.reduce((sum, entry) => sum + entry.size, 0), executionReady: false });
    assert.equal(existsSync(main.at('.moe')), false);
    assert.deepEqual(await main.take(), { instance: GUEST, candidate: validateImport([]), executionReady: false });
    // The agent edits a file, adds a nested one, deletes one and makes one executable.
    writeFileSync(main.at('src/deep/lib.c'), 'int lib = 2;\n');
    mkdirSync(main.at('src/added/deep'), { recursive: true });
    writeFileSync(main.at('src/added/deep/file.txt'), 'added by agent\n');
    rmSync(main.at('README.md'));
    chmodSync(main.at('src/new.c'), 0o755);
    const changed = await main.take();
    assert.deepEqual(changed, { instance: GUEST, executionReady: false, candidate: validateImport([fileOf('src/deep/lib.c', 'int lib = 2;\n'),
      fileOf('src/added/deep/file.txt', 'added by agent\n'), { kind: 'delete', path: 'README.md' }, fileOf('src/new.c', 'int added;\n', true)]) });
    assert.deepEqual(changed.candidate.entries.map(({ kind, path: name, executable, sha256 }) => [kind, name, executable, sha256]), [
      ['delete', 'README.md', undefined, undefined], ['file', 'src/added/deep/file.txt', false, sha('added by agent\n')],
      ['file', 'src/deep/lib.c', false, sha('int lib = 2;\n')], ['file', 'src/new.c', true, sha('int added;\n')]]);
    // Each attack plants one thing in a freshly materialized workspace; the guest reports it and the host refuses it.
    const SECRET = 'host-only-secret-0123456';
    const hostOnly = path.join(scratch(t), 'host-only.txt');
    writeFileSync(hostOnly, SECRET);
    for (const [label, plant, code] of [
      ['a symlink to /etc/passwd', at => symlinkSync('/etc/passwd', at('passwd')), 'SNAPSHOT_SYMLINK_DENIED'],
      ['a symlink to a host-only file', at => symlinkSync(hostOnly, at('src/leak')), 'SNAPSHOT_SYMLINK_DENIED'],
      ['a written .git/config', at => { mkdirSync(at('.git')); writeFileSync(at('.git/config'), '[core]\n'); }, 'SNAPSHOT_CONTROL_PATH'],
      ['a written .moe/state.json', at => { mkdirSync(at('.moe')); writeFileSync(at('.moe/state.json'), '{}'); }, 'SNAPSHOT_CONTROL_PATH'],
      ['a backslash name', at => writeFileSync(at('a\\b.txt'), 'x'), 'SNAPSHOT_PATH_INVALID'],
      ...(process.platform === 'darwin' ? [] : [['a non-UTF-8 name', // APFS refuses one; the guest is Linux
        at => writeFileSync(Buffer.concat([Buffer.from(at('bad-')), Buffer.from([0xff])]), 'x'), 'SNAPSHOT_PATH_INVALID']]),
      ['a FIFO', at => mkfifo(at('pipe')), 'SNAPSHOT_ENTRY_INVALID'],
    ]) {
      const attacked = session();
      await attacked.copy();
      plant(attacked.at);
      await assert.rejects(attacked.take(), transferRefused(code), label);
      assert.deepEqual(attacked.launches.map(({ call }) => call[1].at(-1)), ['materialize', 'export'], label);
    }
    const late = session({ info: [guestDetail(), guestDetail(), guestDetail({ mounts: HOST_MOUNT })] });
    await late.copy();
    await assert.rejects(late.take(), transferRefused('TRANSFER_MOUNTS_PRESENT'));
    assert.deepEqual(late.launches.map(({ call }) => call[1].at(-1)), ['materialize']);
    // The host-only bytes never crossed, while the agent's bytes did (so the capture saw the data frames).
    const seen = Buffer.concat(stdout);
    assert.deepEqual([SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from('added by agent\n').toString('base64')]
      .map(needle => seen.includes(needle)), [false, false, true]);
    // DoD 3 across every run: only info, the mountinfo probe and the two supervisor argvs, each exec unmapped, no mount or transfer.
    const launches = sessions.flatMap(s => s.launches);
    assert.deepEqual([sessions.flatMap(s => s.guest.unexpected), new Set(sessions.flatMap(s => s.guest.ids())), launches.length],
      [[], new Set(['info', 'mountinfo']), process.platform === 'darwin' ? 16 : 18]);
    for (const { call: [executable, argv, options], child } of launches) {
      assert.deepEqual([executable, argv, options, child.exitCode], ['multipass', snapshotArgv(GUEST, argv.at(-1)), PIPES, 0]);
    }
    for (const argv of [...sessions.flatMap(s => s.guest.calls.map(({ executable, args }) => [executable, ...args])),
      ...launches.map(({ call: [executable, argv] }) => [executable, ...argv])]) {
      assert.equal(argv[0], 'multipass');
      assert.equal(argv[1] === 'info' || (argv[1] === 'exec' && argv[2] === '--no-map-working-directory'), true, argv.join(' '));
      assert.equal(argv.some(arg => ['mount', 'umount', 'transfer'].includes(arg)), false, argv.join(' '));
    }
  });

// CQ-R12 host admission rows: admitCandidate over scratch repositories built with the test's own git.
import { admitCandidate } from '../local-runner/admission.mjs';

const WIN = process.platform === 'win32';
// An absolute git (admission refuses a bare 'git'): Git's own exec-path copy, else the first one on PATH.
const GIT_BIN = [execFileSync('git', ['--exec-path']).toString().trim(), ...(process.env.PATH ?? '').split(path.delimiter)]
  .filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, WIN ? 'git.exe' : 'git')).find(file => existsSync(file));
const deleteOf = name => ({ kind: 'delete', path: name });
// Sets process.env keys for one test (undefined deletes one) and restores them after it.
function withEnv(t, changes) {
  const apply = values => Object.entries(values).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)));
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  t.after(() => apply(saved));
  apply(changes);
}
// Points os.tmpdir() at a fresh dir and lists what admission left there. Make every other scratch dir first.
const isolateTmp = t => {
  const dir = scratch(t);
  withEnv(t, { TMPDIR: dir, TEMP: dir, TMP: dir });
  return { dir, left: () => readdirSync(dir) };
};
// POSIX only: a git that logs each argv with its GIT_* environment, then execs the real git (R09b's E2 technique).
function logGit(t) {
  const dir = scratch(t);
  const log = path.join(dir, 'log');
  writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s | %s\\n' "$(env | grep '^GIT_' | sort | tr '\\n' ' ')" "$*" >> '${log}'\n`
    + `exec '${GIT_BIN}' "$@"\n`, { mode: 0o755 });
  return { git: path.join(dir, 'git'), lines: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}
// A committed scratch repository, driven by the test's own git with system and global config masked.
function admitRepo(t, files, init = []) {
  const dir = realpathSync(scratch(t));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: WIN ? 'NUL' : '/dev/null' };
  const git = (args, input) => execFileSync(GIT_BIN, ['-c', 'user.name=moe', '-c', 'user.email=moe@test', ...args],
    { cwd: dir, env, input, stdio: 'pipe' }).toString().replace(/\n$/, '');
  git(['init', '-q', ...init]);
  const put = ([name, data]) => { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), data); };
  Object.entries(files).forEach(put);
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  return { dir, git, tree: () => git(['rev-parse', 'HEAD^{tree}']), bytes: args => execFileSync(GIT_BIN, args, { cwd: dir, env }) };
}
// [mode, path, bytes or gitlink id] of every leaf of a tree, in Git's order.
const leaves = (repo, tree) => repo.git(['ls-tree', '-r', '-z', tree]).split('\0').filter(Boolean).map(record => {
  const [, mode, oid, name] = /^([0-7]{6}) [a-z]+ ([0-9a-f]+)\t(.+)$/s.exec(record);
  return [mode, name, mode === '160000' ? oid : repo.bytes(['cat-file', 'blob', oid])];
});
const asLeaves = entries => validateImport(entries).entries.filter(({ kind }) => kind === 'file')
  .map(({ path: name, executable, data }) => [executable ? '100755' : '100644', name, Buffer.from(data)]);
// [name, sha256 or 'dir'] of every entry below dir that keep() admits.
const filesUnder = (dir, keep) => readdirSync(dir, { recursive: true }).filter(keep).sort()
  .map(name => [name, statSync(path.join(dir, name)).isFile() ? sha(readFileSync(path.join(dir, name))) : 'dir']);
// The worktree, .git minus objects/ (index, HEAD, refs, packed-refs, logs, config) and the refs, which admission never changes.
const repoState = repo => [filesUnder(repo.dir, name => name.split(path.sep)[0] !== '.git'),
  filesUnder(path.join(repo.dir, '.git'), name => name.split(path.sep)[0] !== 'objects'), repo.git(['for-each-ref'])];
const admitIn = (repo, entries, extra = {}) => admitCandidate({ repoDir: repo.dir, baseTree: repo.tree(), candidate: validateImport(entries),
  git: GIT_BIN, ...extra });

test('A1 invalid input is refused before any temp dir or Git process: a bare git, a relative repo, a forged candidate', async t => {
  const repo = admitRepo(t, { a: 'a\n' });
  const logged = WIN ? null : logGit(t);
  const { left } = isolateTmp(t);
  const good = validateImport([fileOf('a', 'new\n')]);
  const edited = validateImport([fileOf('a', 'new\n')]);
  edited.entries[0].data[0] = 0x4e; // A TypedArray cannot be frozen.
  const forged = (entries, digest = good.digest) => Object.freeze({ entries: Object.freeze(entries), digest });
  const base = { repoDir: repo.dir, baseTree: repo.tree(), candidate: good, git: logged?.git ?? GIT_BIN };
  const planted = path.join(repo.dir, 'git'); // Repository code though absolute; a relative git the cwd resolves is refused too.
  writeFileSync(planted, readFileSync(base.git), { mode: 0o755 });
  const changes = [{ git: 'git' }, { git: path.relative(process.cwd(), fileURLToPath(import.meta.url)) }, { git: '' }, { git: 7 },
    { git: `${base.git}\n` }, { git: planted }, { git: path.join(repo.dir, 'missing') },
    { repoDir: 'relative' }, { repoDir: `${repo.dir}\u0000` }, { baseTree: base.baseTree.slice(1) }, { baseTree: base.baseTree.toUpperCase() },
    { baseTree: 'HEAD' }, { baseTree: `${base.baseTree}\n` }, { timeoutMs: 0 }, { timeoutMs: 600_001 }, { timeoutMs: 1.5 },
    { candidate: { ...good } }, { candidate: Object.freeze({ ...good, extra: 1 }) }, { candidate: Object.freeze({ entries: good.entries }) },
    { candidate: Object.freeze({ entries: [...good.entries], digest: good.digest }) }, { candidate: forged(good.entries, '0'.repeat(64)) },
    { candidate: forged([Object.freeze({ ...good.entries[0], sha256: '0'.repeat(64) })]) },
    { candidate: forged([Object.freeze({ ...good.entries[0], size: 9 })]) }, { candidate: edited }, { candidate: null }];
  for (const input of [null, 'x', [], ...changes.map(change => ({ ...base, ...change }))]) {
    await assert.rejects(admitCandidate(input), transferRefused('ADMISSION_INPUT_INVALID'), JSON.stringify(input));
  }
  // validateImport's own refusals pass through with their R09a code.
  await assert.rejects(admitCandidate({ ...base, candidate: forged([Object.freeze({ kind: 'symlink', path: 'l' })]) }),
    transferRefused('SNAPSHOT_SYMLINK_DENIED'));
  assert.deepEqual([logged?.lines() ?? [], left()], [[], []]);
  assert.equal((await admitCandidate(base)).digest, good.digest, 'positive control');
  assert.deepEqual([logged === null || logged.lines().length > 0, left()], [true, []]);
});

test('A2 a candidate must fit its base: a delete names a base blob, and a file never replaces, covers or sits beneath a non-blob', async t => {
  const repo = admitRepo(t, { a: 'a\n', 'd/x': 'x\n' });
  // m is a gitlink and l a symlink, staged without touching the worktree.
  const links = [`160000,${repo.git(['rev-parse', 'HEAD'])},m`, `120000,${repo.git(['hash-object', '-w', '--stdin'], 'a')},l`];
  for (const info of links) repo.git(['update-index', '--add', '--cacheinfo', info]);
  repo.git(['commit', '-q', '-m', 'links']);
  const conflicts = [[deleteOf('nope')], [deleteOf('d')], [deleteOf('m')], [deleteOf('l')], [fileOf('m', 'x')], [fileOf('m/x', 'x')],
    [fileOf('l', 'x')], [fileOf('l/x', 'x')], [fileOf('a/b', 'x')], [fileOf('d', 'x')]];
  for (const entries of conflicts) {
    await assert.rejects(admitIn(repo, entries), transferRefused('ADMISSION_ENTRY_CONFLICT'), JSON.stringify(entries.map(e => e.path)));
  }
  // A directory/file swap never reaches admission: validateImport refuses a delete above or below a file.
  assert.throws(() => validateImport([deleteOf('a'), fileOf('a/b', 'x')]), { code: 'SNAPSHOT_PATH_COLLISION' });
  await admitIn(repo, [deleteOf('d/x'), fileOf('a', 'A'), fileOf('d/y', 'y'), fileOf('n/e/w', 'w')]);
  const wide = admitRepo(t, { a: 'a\n' }, ['--object-format=sha256']);
  const ids = ['a'.repeat(64), repo.git(['rev-parse', 'HEAD:a']), repo.git(['rev-parse', 'HEAD']), 'f'.repeat(40)];
  for (const [at, baseTree] of [...ids.map(id => [repo, id]), [wide, repo.tree()], [wide, wide.git(['rev-parse', 'HEAD'])]]) {
    await assert.rejects(admitIn(at, [], { baseTree }), transferRefused('ADMISSION_BASE_INVALID'), baseTree);
  }
  await assert.rejects(admitIn(repo, [], { repoDir: path.join(repo.dir, 'd') }), transferRefused('ADMISSION_REPOSITORY_UNSUPPORTED'));
  repo.git(['config', 'extensions.worktreeConfig', 'true']); // `config --local` would skip .git/config.worktree.
  repo.git(['config', '--worktree', 'filter.x.clean', 'cat']);
  await assert.rejects(admitIn(repo, []), transferRefused('ADMISSION_REPOSITORY_UNSUPPORTED'));
});

test('A3 the admitted tree is the base minus deletes plus files, byte for byte, with no autocrlf, eol or ident conversion', async t => {
  const repo = admitRepo(t, { '.gitattributes': '* text eol=crlf ident\n', a: 'a\n', 'd/x': 'x\n', 'd/z': 'z\n', 'run.sh': 'echo\n' });
  repo.git(['config', 'core.autocrlf', 'true']);
  const crlf = Buffer.from('one\r\ntwo\r\n$Id: 0123456789abcdef $\r\n');
  const candidate = [fileOf('a', crlf), deleteOf('d/x'), fileOf('d/new', 'n\n'), fileOf('e/f/g', ''), fileOf('run.sh', 'echo\r\n', true)];
  const admitted = await admitIn(repo, candidate);
  assert.deepEqual([Object.keys(admitted), admitted.baseTree, admitted.digest, Object.isFrozen(admitted)],
    [['baseTree', 'tree', 'digest'], repo.tree(), validateImport(candidate).digest, true]);
  assert.deepEqual(leaves(repo, admitted.tree), [['100644', '.gitattributes', Buffer.from('* text eol=crlf ident\n')],
    ['100644', 'a', crlf], ['100644', 'd/new', Buffer.from('n\n')], ['100644', 'd/z', Buffer.from('z\n')], ['100644', 'e/f/g', Buffer.alloc(0)],
    ['100755', 'run.sh', Buffer.from('echo\r\n')]]);
  assert.equal((await admitIn(repo, [])).tree, repo.tree(), 'an empty candidate is the base itself');
  const both = await Promise.all(['c1', 'c2'].map(name => admitIn(repo, [fileOf(name, name)])));
  assert.deepEqual(both.map(({ tree }) => leaves(repo, tree).map(([, name]) => name).filter(name => /^c\d$/.test(name))), [['c1'], ['c2']]);
  const wide = admitRepo(t, { a: 'a\n' }, ['--object-format=sha256']);
  const sha256 = await admitIn(wide, [fileOf('b', 'b\r\n', true)]);
  assert.deepEqual([sha256.tree.length, leaves(wide, sha256.tree)], [64, asLeaves([fileOf('a', 'a\n'), fileOf('b', 'b\r\n', true)])]);
});

test('A4 admission changes no ref, index or worktree byte and runs no candidate file: the active controller stays in place', async t => {
  const controller = ['scripts/moe-agent.sh', 'scripts/local-runner/admission.mjs'];
  const source = name => fileURLToPath(new URL(`../../${name}`, import.meta.url));
  const repo = admitRepo(t, Object.fromEntries(controller.map(name => [name, readFileSync(source(name))])));
  for (const args of [['tag', 'v1'], ['branch', 'side'], ['pack-refs', '--all'], ['branch', 'loose']]) repo.git(args);
  const marker = path.join(scratch(t), 'ran');
  const hostile = `#!/bin/sh\ntouch '${marker}'\n`;
  const state = () => [...repoState(repo), sha(readFileSync(source(controller[1])))];
  const before = state();
  const candidate = [fileOf(controller[0], hostile, true), fileOf(controller[1], `import '${marker}';\n`), fileOf('scripts/postinstall.sh', hostile, true)];
  const { tree } = await admitIn(repo, candidate);
  assert.deepEqual([state(), existsSync(marker), leaves(repo, tree)], [before, false, asLeaves(candidate)]);
  // The module imports only node: built-ins and its two ./ siblings, never dynamically.
  const text = readFileSync(source('scripts/local-runner/admission.mjs'), 'utf8');
  assert.deepEqual([...text.matchAll(/^import [^;]* from '([^']+)';$/gm)].map(([, spec]) => spec),
    ['node:crypto', 'node:fs/promises', 'node:os', 'node:path', './source-export.mjs', './source-snapshot.mjs']);
  assert.equal(/\bimport\s*\(|\brequire\s*\(/.test(text), false);
});

test('A5 hostile hooks, fsmonitor, package scripts, inherited GIT_* and a hostile HOME never run or redirect admission', async t => {
  const marks = mkdtempSync(path.join(tmpdir(), 'moe-marks-')); // No space: Git runs core.fsmonitor through the shell.
  t.after(() => rmSync(marks, { recursive: true, force: true }));
  const ran = () => readdirSync(marks).filter(name => name.startsWith('ran-'));
  const touch = label => `#!/bin/sh\ntouch '${path.join(marks, `ran-${label}`)}'\n`;
  const script = label => {
    writeFileSync(path.join(marks, `${label}.sh`), touch(label), { mode: 0o755 });
    return path.join(marks, `${label}.sh`);
  };
  const scripts = Object.fromEntries(['test', 'prepare', 'postinstall'].map(name => [name, touch(name).split('\n')[1]]));
  const repo = admitRepo(t, { a: 'a\n', 'package.json': JSON.stringify({ name: 'hostile', scripts }) });
  const decoy = admitRepo(t, { a: 'decoy\n' });
  const hooksPath = path.join(marks, 'hooks');
  mkdirSync(hooksPath);
  const hooks = ['post-index-change', 'reference-transaction', 'pre-commit', 'post-commit', 'post-checkout', 'fsmonitor-watchman'];
  for (const [at, dir] of [path.join(repo.dir, '.git', 'hooks'), hooksPath].entries()) {
    for (const hook of hooks) writeFileSync(path.join(dir, hook), touch(`${hook}-${at}`), { mode: 0o755 });
  }
  repo.git(['config', 'core.hooksPath', hooksPath]);
  repo.git(['config', 'core.fsmonitor', script('fsmonitor')]);
  const home = path.join(marks, 'home');
  const hostileConfig = `[core]\n\thooksPath = ${hooksPath}\n\tfsmonitor = ${script('global-fsmonitor')}\n[filter "x"]\n\tclean = ${script('filter')}\n`;
  mkdirSync(path.join(home, 'xdg', 'git'), { recursive: true });
  for (const file of [path.join(home, '.gitconfig'), path.join(home, 'xdg', 'git', 'config')]) writeFileSync(file, hostileConfig);
  if (!WIN) { // Positive control: outside the envelope this repository's fsmonitor and hooksPath hooks do run.
    repo.git(['status']);
    repo.git(['read-tree', 'HEAD']);
    assert.deepEqual(ran(), ['ran-fsmonitor', 'ran-post-index-change-1']);
    ran().forEach(name => rmSync(path.join(marks, name)));
  }
  const before = repoState(repo);
  withEnv(t, { GIT_DIR: path.join(decoy.dir, '.git'), GIT_WORK_TREE: decoy.dir, GIT_INDEX_FILE: path.join(repo.dir, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(decoy.dir, '.git', 'objects'), GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooksPath}'`,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: script('env-fsmonitor'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_SYSTEM: path.join(home, '.gitconfig'), HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg') });
  const candidate = [fileOf('a', 'admitted\n'), fileOf('b/c', 'c\n')];
  const { tree } = await admitIn(repo, candidate);
  assert.deepEqual([ran(), repoState(repo), leaves(repo, tree).slice(0, 2)], [[], before, asLeaves(candidate)]);
  assert.throws(() => decoy.git(['cat-file', '-e', tree]), 'the tree went to the right repository only');
  repo.git(['config', 'filter.x.clean', script('local-filter')]);
  const filtered = repoState(repo);
  await assert.rejects(admitIn(repo, candidate), transferRefused('ADMISSION_REPOSITORY_UNSUPPORTED'));
  assert.deepEqual([ran(), repoState(repo)], [[], filtered]);
});

test('A6 every Git call runs in the admission envelope with plumbing subcommands only, and the temp dir goes',
  { skip: WIN && 'needs a POSIX /bin/sh git wrapper' }, async t => {
    const repo = admitRepo(t, { a: 'a\n', 'd/x': 'x\n' });
    const logged = logGit(t);
    const tmp = isolateTmp(t);
    await admitIn(repo, [fileOf('a', 'A'), deleteOf('d/x'), fileOf('n', 'n', true)], { git: logged.git });
    const lines = logged.lines();
    const key = `GIT_INDEX_FILE=${path.join(tmp.dir, 'moe-admission-')}`;
    const temp = path.join(tmp.dir, `moe-admission-${lines[0].split(key)[1]?.slice(0, 6)}`);
    const prefix = `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_INDEX_FILE=${path.join(temp, 'index')} GIT_NO_LAZY_FETCH=1 `
      + 'GIT_TERMINAL_PROMPT=0  | --no-optional-locks --no-replace-objects -c protocol.allow=never -c core.fsmonitor=false '
      + `-c safe.directory=${repo.dir} -c core.hooksPath=${path.join(temp, 'hooks')} -c core.splitIndex=false -c index.sparse=false `;
    assert.deepEqual(lines.filter(line => !line.startsWith(prefix)), []);
    assert.deepEqual([...new Set(lines.map(line => line.slice(prefix.length).split(' ')[0]))],
      ['rev-parse', 'config', 'ls-tree', 'hash-object', 'read-tree', 'update-index', 'write-tree']);
    assert.deepEqual([existsSync(temp), tmp.left()], [false, []]);
  });

// CQ-R10 isolated agent lifecycle: runAgentJob over fakeGuest plus scripted PKILL/PGREP exits, a spawn-compatible bridge
// and a fake daemon forward. The rows are AJ1-AJ6, since CQ-R12's admission rows own A1-A6.
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { runAgentJob } from '../local-runner/agent-lifecycle.mjs';
import { bridgeArgv, jobFrame } from '../local-runner/guest-bridge.mjs';
import { MAX_RESPONSE_BYTES } from '../local-runner/guest-session.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before } from 'node:test';
// Start without a late top-level await: earlier rows could finish and run root teardown during that await.
// before() still waits for the bind, which an AJ row run on its own (a name filter or a rerun) would otherwise outrun.
const AGENT_PROJECT = mkdtempSync(path.join(AGENT_TMP_ROOT, 'moe-agent-session-'));
const AGENT_DAEMON = path.join(AGENT_PROJECT, '.moe', 'daemon.json');
mkdirSync(path.dirname(AGENT_DAEMON));
const agentHealth = createServer((req, res) => res.end(JSON.stringify({ status: 'healthy', projectPath: AGENT_PROJECT, bindHost: '127.0.0.1' })))
  .listen(0, '127.0.0.1');
before(() => (agentHealth.listening ? undefined : once(agentHealth, 'listening')));
after(() => { agentHealth.closeAllConnections(); agentHealth.close(); rmSync(AGENT_PROJECT, { recursive: true, force: true }); });

const AGENT_KEY = 'sk-R10-agent!~'.padEnd(32, 'k');
const JOB = { cli: 'claude', credential: { name: 'ANTHROPIC_API_KEY', value: AGENT_KEY } };
const AGENT = { role: 'worker', workerId: 'worker-1', ...owner };
const PKILL = ['exec', '--no-map-working-directory', GUEST, '--', 'sudo', '-n', 'pkill', '-KILL', '-U', 'moe-agent'];
const PGREP = ['exec', '--no-map-working-directory', GUEST, '--', 'sudo', '-n', 'pgrep', '-c', '-U', 'moe-agent'];
const ACQUIRED = '2026-10-29T12:00:00.000Z';
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const leaseOf = (changes = {}) => mcp({ success: true, granted: true, resourceId: GUEST,
  lease: { taskId: owner.taskId, workerId: 'worker-1', acquiredAt: ACQUIRED, expiresAt: '2026-10-30T12:00:00.000Z', ...changes } });
const BUSY = mcp({ success: true, granted: false, resourceId: GUEST, position: 1, queueLength: 1 });
const releasedOf = (holders = [{ taskId: owner.taskId, workerId: 'worker-1', acquiredAt: ACQUIRED }]) =>
  mcp({ success: true, resourceId: GUEST, released: holders.map(({ taskId }) => taskId), releasedHolders: holders });
const EXITED = { kind: 'observation', type: 'exit', code: 0, signal: null };
const GUEST_REQUESTS = [{ tool: 'moe.get_context', args: {} }, { tool: 'moe.start_step', args: { stepId: 'step-1' } }];
const SESSION_SHAPE = /^worker-1@\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z#[0-9a-f]{16}$/;
const agentRefused = code => error => error?.code === code && !error.message.includes(AGENT_KEY) && !/[\\/]/.test(error.message);

// After the job frame it sends hello, then each request once the previous one is answered, then frames and exit `exit`.
// Like the supervisor it exits 74 when stdin closes first.
function fakeBridge({ requests = GUEST_REQUESTS, frames = [EXITED], exit = 0 } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], written: [], kill: () => true });
  const send = list => proc.stdout.write(Buffer.concat(list.map(frame => encodeFrame(frame))));
  const end = code => { if (!proc.stdout.writableEnded) proc.stdout.once('close', () => proc.emit('close', code, null)).end(); };
  proc.stdin = new Writable({ write(chunk, encoding, done) {
    const answered = proc.written.push(chunk) - 1;
    if (answered === 0) send([{ kind: 'hello', protocol: 1 }]);
    if (answered < requests.length) send([{ kind: 'request', id: answered + 1, ...requests[answered] }]);
    else setImmediate(() => { send(frames); end(exit); }); // once the last reply's write has completed
    done();
  } });
  proc.stdin.once('close', () => end(74));
  proc.spawn = (...args) => { proc.calls.push(args); return proc; };
  proc.frames = () => createFrameDecoder(MAX_HOST_FRAME_BYTES).push(Buffer.concat(proc.written));
  return proc;
}

// One seat's fakes. log holds every provider command and 'spawn', in order; pkill and pgrep list exit codes (or errors),
// the last repeating. Each spawn gets a fresh bridge, bridge(index) when a function. The forward refuses a call whose
// signal is already aborted.
function agentHarness(t, { guest, pkill = [0], pgrep = [1], bridge, acquire = leaseOf(), release = releasedOf(), onCall } = {}) {
  const h = { log: [], forwarded: [], outputs: [], observations: [], slept: [], fake: fakeGuest(guest), procs: [] };
  const take = list => (list.length > 1 ? list.shift() : list[0]);
  const run = async (executable, args, options) => {
    h.log.push(args);
    const kill = isDeepStrictEqual(args, PKILL);
    if (!kill && !isDeepStrictEqual(args, PGREP)) return h.fake.run(executable, args, options);
    const code = take(kill ? pkill : pgrep);
    if (code === 0) return { stdout: kill ? '' : '1\n', stderr: '' };
    throw code instanceof Error ? code : Object.assign(new Error('Command failed'), { code, stdout: code === 1 && !kill ? '0\n' : '', stderr: '' });
  };
  const answer = value => (typeof value === 'function' ? value() : value);
  const forward = (tool, args, { signal }) => {
    h.forwarded.push({ tool, args, signal });
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    onCall?.(tool);
    return tool === 'moe.acquire_resource' ? answer(acquire) : tool === 'moe.release_resource' ? answer(release) : mcp({ tool });
  };
  const daemonInfoPath = AGENT_DAEMON;
  writeFileSync(daemonInfoPath, JSON.stringify({ port: agentHealth.address().port, pid: 1, projectPath: '/p' }));
  h.input = { name: GUEST, binding: AGENT, job: JOB, daemonInfoPath, forward, timeoutMs: 1_000, sleep: async ms => { h.slept.push(ms); },
    onOutput: (stream, data) => h.outputs.push([stream, data]), onObservation: frame => h.observations.push(frame),
    provider: { run, spawn: (...args) => {
      h.log.push('spawn');
      const proc = fakeBridge(typeof bridge === 'function' ? bridge(h.procs.length) : bridge);
      h.procs.push(proc);
      return proc.spawn(...args);
    } } };
  h.calls = () => h.forwarded.map(({ tool, args }) => [tool, args]);
  return h;
}
const ACQUIRE_CALL = ['moe.acquire_resource', { resourceId: GUEST, taskId: owner.taskId, workerId: 'worker-1' }];
const RELEASE_CALL = (ifAcquiredAt = ACQUIRED) =>
  ['moe.release_resource', { resourceId: GUEST, workerId: 'worker-1', taskId: owner.taskId, ifHolderWorkerId: 'worker-1', ifAcquiredAt }];
const CLEAN_LOG = [PKILL, PGREP, infoArgs(GUEST), execArgs('mountinfo'), 'spawn', PKILL, PGREP];
const ALLOWED = CLEAN_LOG.filter(entry => entry !== 'spawn').map(argv => JSON.stringify(argv));
// No delete, stop, purge, restart, mount, transfer, materialize or export: only these commands and the bridge argv.
const onlyAllowed = h => assert.deepEqual([h.log.filter(args => args !== 'spawn' && !ALLOWED.includes(JSON.stringify(args))),
  h.procs.flatMap(proc => proc.calls).filter(([, argv]) => !isDeepStrictEqual(argv, bridgeArgv(GUEST)))], [[], []]);
const OUT = { kind: 'output', stream: 'stdout', data: 'QQ==' };

test('AJ1 invalid input, a caller session id and an aborted signal refuse before any daemon or provider call', async t => {
  const valued = value => ({ job: { cli: 'claude', credential: { name: 'ANTHROPIC_API_KEY', value } } });
  const invalid = [{ name: 'primary' }, { binding: { ...AGENT, role: 'architect' } }, { binding: null }, { job: { cli: 'claude' } },
    { job: { ...JOB, role: 'worker' } }, { job: { ...JOB, cli: 'gemini' } }, { job: { ...JOB, credential: { ...JOB.credential, note: 1 } } },
    { job: { cli: 'claude', credential: { name: 'OPENAI_API_KEY', value: AGENT_KEY } } }, ...['', 'k'.repeat(4097), 'a b', 'a\u0001b'].map(valued),
    { daemonInfoPath: 'daemon.json' }, { daemonInfoPath: '/p/daemon.json\n' }, ...['forward', 'onOutput', 'onObservation', 'sleep'].map(key => ({ [key]: 1 })),
    { onObservation: undefined }, { provider: null }, { provider: { spawn: 'x' } }, { provider: { run: 'x' } }, { provider: { executable: ' ' } },
    ...[0, 60_001, '100', 1.5].map(timeoutMs => ({ timeoutMs })), { signal: {} }, { sessionId: 'worker-1@2026-10-29T00:00:00.000Z' },
    { binding: { ...AGENT, generation: 0 } }, { binding: { ...AGENT, workerId: '\u{1F600}'.repeat(128) } }];
  for (const [index, [code, options]] of [...invalid.map(options => ['AGENT_INPUT_INVALID', options]),
    ['AGENT_ABORTED', { signal: AbortSignal.abort() }]].entries()) {
    const h = agentHarness(t);
    await assert.rejects(runAgentJob({ ...h.input, ...options }), agentRefused(code), `case ${index}`);
    assert.deepEqual([h.forwarded, h.log, h.procs], [[], [], []], `case ${index}`);
  }
});

test('AJ2 a busy, unreadable or hung acquire rejects after its one call, under its own signal, and releases nothing', async t => {
  const caller = new AbortController().signal;
  for (const [index, [code, acquire, hangs = false]] of [['AGENT_LEASE_BUSY', BUSY],
    ...[() => Promise.reject(new Error(AGENT_KEY)), () => { throw new Error(AGENT_KEY); }, { ...leaseOf(), isError: true },
      { content: [...leaseOf().content, ...leaseOf().content] }, { content: [{ type: 'text', text: '{' }] }, leaseOf({ taskId: 'task-other' }),
      leaseOf({ workerId: 'worker-2' }), leaseOf({ acquiredAt: '2026-10-29T12:00:00Z' }),
      { content: [{ type: 'text', text: leaseOf().content[0].text.padEnd(MAX_RESPONSE_BYTES + 1) }] }].map(acquire => ['AGENT_LEASE_UNAVAILABLE', acquire]),
    ['AGENT_LEASE_UNAVAILABLE', () => new Promise(() => {}), true]].entries()) {
    const h = agentHarness(t, { acquire });
    await assert.rejects(runAgentJob({ ...h.input, signal: caller, timeoutMs: 50 }), agentRefused(code), `case ${index}`);
    await wait(60); // past timeoutMs: only the hung call's signal is aborted, a settled call's timer was cleared
    assert.deepEqual([h.calls(), h.log, h.procs], [[ACQUIRE_CALL], [], []], `case ${index}`);
    const { signal } = h.forwarded[0];
    assert.deepEqual([signal instanceof AbortSignal, signal !== caller, signal.aborted], [true, true, hangs], `case ${index}`);
  }
  let grant;
  const h = agentHarness(t, { acquire: () => (grant ? BUSY : new Promise(resolve => { grant = resolve; })) });
  const first = runAgentJob(h.input);
  await assert.rejects(runAgentJob(h.input), agentRefused('AGENT_BUSY'));
  assert.equal(h.forwarded.length, 1);
  grant(BUSY);
  await assert.rejects(first, agentRefused('AGENT_LEASE_BUSY'));
  await assert.rejects(runAgentJob(h.input), agentRefused('AGENT_LEASE_BUSY'));
  assert.deepEqual([h.calls(), h.log], [[ACQUIRE_CALL, ACQUIRE_CALL], []]);
});

test('AJ3 a clean job: lease, verified sweep, no mounts, one bridge session with the job frame first, verified sweep, release', async t => {
  const h = agentHarness(t);
  const result = await runAgentJob(h.input);
  const { sessionId } = result;
  assert.match(sessionId, SESSION_SHAPE);
  assert.deepEqual(result, { sessionId, observation: EXITED, failure: null, terminationVerified: true, lease: 'released', executionReady: false });
  assert.deepEqual([Object.isFrozen(result), h.observations, h.log, h.fake.unexpected], [true, [EXITED], CLEAN_LOG, []]);
  const [proc] = h.procs;
  assert.deepEqual(h.procs.flatMap(({ calls }) => calls), [['multipass', bridgeArgv(GUEST), PIPES]]);
  const [job, ...replies] = proc.frames();
  assert.deepEqual(job, { kind: 'job', version: 1, cli: 'claude', role: 'worker', credential: JOB.credential });
  assert.equal(proc.written[0].equals(jobFrame({ cli: 'claude', role: 'worker', credential: JOB.credential })), true);
  assert.deepEqual(replies.map(({ kind, id, ok }) => [kind, id, ok]), [['response', 1, true], ['response', 2, true]]);
  const stamped = { taskId: owner.taskId, workerId: 'worker-1' };
  assert.deepEqual(h.calls(), [ACQUIRE_CALL, ['moe.get_context', { ...stamped, sessionId }],
    ['moe.start_step', { stepId: 'step-1', ...stamped, attemptId: owner.attemptId, generation: owner.generation, sessionId }], RELEASE_CALL()]);
  for (const seen of [h.calls(), h.log, proc.calls, result]) assert.equal(JSON.stringify(seen).includes(AGENT_KEY), false);
  onlyAllowed(h);
});

test('AJ4 a crashed or killed job is data, lingering descendants are swept again and output arrives as bytes', async t => {
  for (const observation of [{ ...EXITED, code: null, signal: 'SIGSEGV' }, { ...EXITED, code: 137 }]) {
    const h = agentHarness(t, { bridge: { frames: [observation] } });
    const { observation: seen, failure, lease } = await runAgentJob(h.input);
    assert.deepEqual([seen, failure, lease, h.log, h.calls().at(-1)], [observation, null, 'released', CLEAN_LOG, RELEASE_CALL()]);
    onlyAllowed(h);
  }
  const h = agentHarness(t, { pgrep: [1, 0, 1], bridge: { frames: [OUT, { ...OUT, stream: 'stderr', data: 'Qg==' }, EXITED] } });
  const result = await runAgentJob(h.input);
  assert.deepEqual([result.failure, result.terminationVerified, result.lease, h.log, h.slept], [null, true, 'released', [...CLEAN_LOG, PKILL, PGREP], [1_000]]);
  assert.deepEqual(h.outputs, [['stdout', Buffer.from('A')], ['stderr', Buffer.from('B')]]);
  onlyAllowed(h);
});

test('AJ5 a failed session, an unverified sweep, mounts or a refused release keep or release only the pinned lease', async t => {
  const caller = new AbortController();
  const leases = h => h.calls().filter(([tool]) => tool.endsWith('_resource'));
  for (const [code, options, outputs = []] of [['SESSION_PROVIDER_FAILED', { bridge: { frames: [OUT], exit: 3 } }, [['stdout', Buffer.from('A')]]],
    ['SESSION_PROTOCOL_VIOLATION', { bridge: { frames: [{ kind: 'hello', protocol: 1 }] } }],
    ['SESSION_ABORTED', { onCall: tool => tool === 'moe.get_context' && caller.abort() }]]) {
    const h = agentHarness(t, options);
    const result = await runAgentJob({ ...h.input, signal: caller.signal });
    assert.deepEqual([result.failure, result.observation, result.terminationVerified, result.lease, h.log, leases(h), h.outputs],
      [code, null, true, 'released', CLEAN_LOG, [ACQUIRE_CALL, RELEASE_CALL()], outputs], code);
    onlyAllowed(h);
  }
  const ENOENT = failWith({ code: 'ENOENT' });
  for (const [failure, options] of [['AGENT_TERMINATION_UNVERIFIED', { pgrep: [1, 0] }], ['AGENT_TERMINATION_UNVERIFIED', { pgrep: [1, 2] }],
    ['AGENT_TERMINATION_UNVERIFIED', { pkill: [0, ENOENT] }], ['SESSION_PROVIDER_FAILED', { pgrep: [1, 0], bridge: { exit: 3 } }]]) {
    const h = agentHarness(t, options);
    const result = await runAgentJob(h.input);
    assert.deepEqual([result.failure, result.terminationVerified, result.lease, leases(h)], [failure, false, 'kept', [ACQUIRE_CALL]]);
    onlyAllowed(h);
  }
  for (const options of [{ pgrep: [0] }, { pgrep: [2] }, { pkill: [ENOENT] }]) {
    const h = agentHarness(t, options);
    const result = await runAgentJob(h.input);
    assert.deepEqual([result.failure, result.observation, result.lease, h.calls(), h.log.filter(args => !ALLOWED.slice(0, 2).includes(JSON.stringify(args)))],
      ['AGENT_TERMINATION_UNVERIFIED', null, 'kept', [ACQUIRE_CALL], []]);
  }
  for (const [failure, guest] of [['TRANSFER_MOUNTS_PRESENT', { info: guestDetail({ mounts: HOST_MOUNT }) }],
    ['TRANSFER_MOUNTS_PRESENT', { answers: healthy({ mountinfo: mountinfo([...MOUNTS, SHARED_LINE('9p')]) }) }],
    ['TRANSFER_MOUNTS_UNKNOWN', { answers: healthy({ mountinfo: { code: 0, stdout: '' } }) }]]) {
    const h = agentHarness(t, { guest });
    const result = await runAgentJob(h.input);
    assert.deepEqual([result.failure, result.lease, h.log, h.calls()], [failure, 'released', CLEAN_LOG.filter(entry => entry !== 'spawn'),
      [ACQUIRE_CALL, RELEASE_CALL()]]);
  }
  for (const [release, timeoutMs = 1_000] of [[{ ...releasedOf(), isError: true }], [releasedOf([])],
    [releasedOf([{ taskId: owner.taskId, workerId: 'worker-1', acquiredAt: '2026-10-29T11:00:00.000Z' }])],
    [() => Promise.reject(new Error(AGENT_KEY))], [() => new Promise(() => {}), 50]]) {
    const h = agentHarness(t, { release });
    const result = await runAgentJob({ ...h.input, timeoutMs });
    assert.deepEqual([result.failure, result.lease, leases(h)], [null, 'release-failed', [ACQUIRE_CALL, RELEASE_CALL()]]);
  }
});

test('AJ6 a reconnect is a new job under a fresh session id, after a verified sweep, on the renewed lease', async t => {
  const h = agentHarness(t, { pgrep: [1, 0, 0, 0, 1], bridge: index => (index === 0 ? { exit: 3 } : {}) });
  const first = await runAgentJob(h.input);
  assert.deepEqual([first.failure, first.lease], ['SESSION_PROVIDER_FAILED', 'kept']);
  const mark = h.log.length;
  const runs = [first, await runAgentJob(h.input)];
  assert.deepEqual([runs[1].failure, runs[1].lease, h.log.slice(mark), h.procs.length], [null, 'released', CLEAN_LOG, 2]);
  for (let run = 2; run < 5; run += 1) runs.push(await runAgentJob(h.input));
  const ids = runs.map(({ sessionId }) => sessionId);
  assert.deepEqual([ids.filter(id => SESSION_SHAPE.test(id)).length, new Set(ids.map(id => id.slice(-16))).size, h.procs.length], [5, 5, 5]);
  assert.deepEqual(h.calls().filter(([tool]) => !tool.endsWith('_resource')).map(([, args]) => args.sessionId), ids.flatMap(id => [id, id]));
  assert.deepEqual(h.calls().filter(([tool]) => tool.endsWith('_resource')),
    [ACQUIRE_CALL, ACQUIRE_CALL, RELEASE_CALL(), ...Array(3).fill([ACQUIRE_CALL, RELEASE_CALL()]).flat()]);
  onlyAllowed(h);
});

// CQ-R11 isolated check lifecycle: deleteOwned ends one fresh check VM with its run. runCheckJob rows CJ1-CJ7 inject every
// step and record it in one ordered log ('removed' once the delete settled); CJ6 also runs the real runCheckSession over a
// fake supervisor, and CJ8 composes the real provisionGuest and deleteOwned over fakeVm.
import { checkEnvironment, evidenceStatus } from '../local-runner/check-evidence.mjs';
import { runCheckJob } from '../local-runner/check-lifecycle.mjs';
import { MAX_BUDGET_MS } from '../local-runner/check-session.mjs';
import { checkArgv, checkFrame } from '../local-runner/guest-bridge.mjs';
import { deleteOwned, validOwner } from '../local-runner/lifecycle.mjs';
import { transferError } from '../local-runner/snapshot-transfer.mjs';

test('deleteOwned purges only its owner\'s launched record, never an unlaunched one, and is idempotent', async t => {
  const purge = [infoArgs(nameAt(1)), ['delete', '--purge', nameAt(1)], infoArgs(nameAt(1))];
  const remove = (h, who = owner) => deleteOwned({ ledger: h.ledger, name: nameAt(1), owner: who, provider: h.provider });
  for (const [phase, argv = purge] of [['launching'], ['owned'], ['absent'], ['failed'], ['absent', [infoArgs(nameAt(1))]]]) {
    const h = harness(t, [...(argv === purge ? [[nameAt(1), 'Running']] : []), ...FOREIGNERS]);
    await seed(h.ledger, phase);
    // The second call is idempotent: no provider call.
    assert.deepEqual([await remove(h), await phasesOf(h.ledger), h.fake.argv(), await remove(h), h.fake.calls.length],
      ['deleted', ['deleted'], argv, 'deleted', argv.length], phase);
    assertScoped(h.fake, [nameAt(1)]);
  }
  for (const [phase, who, expected] of [['reserved', owner, 'not-launched'], ['collision', owner, 'not-launched'],
    ...[{ ...owner, taskId: 'task-other' }, { ...owner, attemptId: 'attempt-other' }, { ...owner, generation: 4 }, null].map(who => ['owned', who, 'LIFECYCLE_NOT_OWNER'])]) {
    const h = harness(t, [[nameAt(1), 'Running']]);
    await seed(h.ledger, phase);
    const seen = await remove(h, who).catch(error => assertSanitized(error, 'LIFECYCLE_NOT_OWNER') && error.code);
    assert.deepEqual([seen, await phasesOf(h.ledger), h.fake.calls.length, h.fake.present.get(nameAt(1))], [expected, [phase], 0, 'Running'], phase);
  }
  for (const script of [args => (args[0] === 'delete' ? { stdout: '' } : undefined),
    args => (args[0] === 'delete' ? { error: failWith({ code: 1, stderr: 'secret' }) } : undefined)]) {
    const h = harness(t, [[nameAt(1), 'Running']], script);
    await seed(h.ledger, 'owned');
    await assert.rejects(remove(h), error => assertSanitized(error, 'LIFECYCLE_STATE_UNKNOWN'));
    assert.deepEqual([await phasesOf(h.ledger), h.fake.argv()], [['owned'], purge]);
  }
  await assert.rejects(deleteOwned({ ledger: null, name: nameAt(1), owner }), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  assert.deepEqual([owner, { ...owner, generation: 0 }, { ...owner, taskId: 'task-' }, null].map(validOwner), [true, false, false, false]);
});

const CHECK = Object.freeze({ id: 'unit', command: 'python3 -m unittest', protected: Object.freeze([Object.freeze({ path: 'tests/a.py', oid: 'e'.repeat(40) })]) });
const CHECK_SNAPSHOT = snapshotOf([fileOf('tests/a.py', 'pass\n')], [fileOf('src/a.py', 'A')]);
const identityOf = ({ source = SOURCE.sha256, image = PROVIDER_HASH, supervisor = BOOTSTRAP.supervisorSha256 } = {}) =>
  checkEnvironment({ sourceImageSha256: source, providerImageHash: image, supervisorSha256: supervisor, resources: GUEST_RESOURCES });
const PASSED_RUN = { outcome: 'passed', exitCode: 0, signal: null, outputTail: 'ok\n' };
const FULL_LOG = ['provision', 'reserve', 'materialize', 'onReady', 'session', 'verify', 'remove', 'removed'];
const UNVERIFIED_LOG = FULL_LOG.filter(name => name !== 'verify'); // only a passed session is verified (CQ-R11f)
const readyGuest = (changes = {}) => ({ provisioned: true, instance: GUEST, bootstrapReady: true, executionReady: false, prerequisites: READY_ITEMS,
  image: { source: SOURCE, provider: { imageHash: PROVIDER_HASH, imageRelease: '24.04 LTS' } }, supervisorSha256: BOOTSTRAP.supervisorSha256, failures: [], ...changes });
// A provision step that reserves through the ledger it was given, then resolves value, or throws it when it is an Error.
const reserving = value => async ({ ledger, owner: who }) => { await ledger.reserve(who); if (value instanceof Error) throw value; return value; };
const checkRefused = code => error => error?.code === code && error.message === `Check job failed: ${code}.`;
const stopped = (failure, changes = {}) => ({ outcome: 'infra-failure', exitCode: null, signal: null, outputTail: '', environment: null,
  workspace: 'unverified', instance: GUEST, vm: 'deleted', failure, executionReady: false, ...changes });
// The harness verify answers 'intact', and only a passed session is verified.
const ranWith = (run, changes = {}) => ({ ...run, environment: identityOf(), workspace: run.outcome === 'passed' ? 'intact' : 'unverified', instance: GUEST, vm: 'deleted', failure: null,
  executionReady: false, ...changes });

function checkHarness({ provision = reserving(readyGuest()), materialize = () => {}, onReady = () => {}, session = () => PASSED_RUN, verify = () => 'intact',
  remove = () => 'deleted' } = {}) {
  const h = { log: [], seen: {} };
  const step = (name, behave) => async options => { h.log.push(name); h.seen[name] = options; return behave(options); };
  h.ledger = { read: async () => assert.fail('read'), update: async () => assert.fail('update'), recordImage: async () => assert.fail('recordImage'),
    reserve: async who => { h.log.push('reserve'); h.seen.reserve = who; return { instance: GUEST }; } };
  h.deps = { provision: step('provision', provision), materialize: step('materialize', materialize), session: step('session', session), verify: step('verify', verify),
    remove: step('remove', async options => { await wait(1); try { return await remove(options); } finally { h.log.push('removed'); } }) };
  h.input = { platform: onWindows(), ledger: h.ledger, owner, cacheDir: '/var/cache/moe', supervisor: SUPERVISOR, credential: CREDENTIAL,
    snapshot: CHECK_SNAPSHOT, check: CHECK, budgetMs: 60_000, provider: { run: async () => assert.fail('provider') }, timeoutMs: 1_000,
    onReady: environment => { h.log.push('onReady'); h.seen.onReady = environment; return onReady(environment); } };
  return h;
}

test('CJ1 invalid input or an aborted signal refuses before any ledger or provider call', async () => {
  const MISSING = Symbol('missing');
  const check = changes => ({ check: { ...CHECK, ...changes } });
  const entry = path => ({ path, oid: 'e'.repeat(40) });
  const invalid = [{ extra: 1 }, { sessionId: 'worker-1@x' }, check({ id: '' }), check({ command: ' ' }), check({ command: 'a\u0000b' }),
    check({ note: 1 }), check({ protected: [entry('b'), entry('a')] }), check({ protected: [entry('../a')] }), check({ protected: null }), { check: null },
    { snapshot: null }, { snapshot: { ...CHECK_SNAPSHOT, version: 2 } }, { snapshot: snapshotOf([fileOf('a', 'A')], [fileOf('a/x', 'X')]) },
    ...[0, MAX_BUDGET_MS + 1, 1.5, '1000', undefined].map(budgetMs => ({ budgetMs })), ...[0, 60_001, '100'].map(timeoutMs => ({ timeoutMs })),
    ...[1, null, undefined].map(onReady => ({ onReady })), { owner: { ...owner, generation: 0 } }, { owner: { ...owner, taskId: 'x' } }, { owner: null },
    { ledger: null }, { ledger: { reserve: async () => ({}) } }, ...[null, [], 'x'].map(provider => ({ provider })), { signal: {} },
    ...['platform', 'check', 'snapshot', 'onReady'].map(key => ({ [key]: MISSING }))];
  for (const [index, changes] of invalid.entries()) {
    const h = checkHarness();
    const input = Object.fromEntries(Object.entries({ ...h.input, ...changes }).filter(([, value]) => value !== MISSING));
    await assert.rejects(runCheckJob(input, h.deps), checkRefused('CHECK_JOB_INPUT_INVALID'), `case ${index}`);
    assert.deepEqual(h.log, [], `case ${index}`);
  }
  for (const input of [null, [], 'x']) await assert.rejects(runCheckJob(input, checkHarness().deps), checkRefused('CHECK_JOB_INPUT_INVALID'));
  const h = checkHarness();
  await assert.rejects(runCheckJob({ ...h.input, signal: AbortSignal.abort() }, h.deps), checkRefused('CHECK_ABORTED'));
  assert.deepEqual(h.log, []);
});

test('CJ2 a clean run provisions, materializes, reports the environment, runs the approved check and deletes its own VM', async () => {
  const signal = new AbortController().signal;
  const h = checkHarness();
  const result = await runCheckJob({ ...h.input, signal }, h.deps);
  assert.deepEqual([result, Object.isFrozen(result), h.log, h.seen.onReady], [ranWith(PASSED_RUN), true, FULL_LOG, identityOf()]);
  const { ledger, ...provisioned } = h.seen.provision;
  assert.deepEqual(provisioned, { platform: h.input.platform, owner, cacheDir: '/var/cache/moe', supervisor: SUPERVISOR, credential: CREDENTIAL, provider: h.input.provider });
  assert.deepEqual([ledger === h.ledger, h.seen.reserve, h.seen.remove], [false, owner, { ledger, name: GUEST, owner, provider: h.input.provider }]);
  assert.deepEqual(h.seen.materialize, { name: GUEST, snapshot: CHECK_SNAPSHOT, provider: h.input.provider });
  assert.deepEqual(h.seen.session, { name: GUEST, check: CHECK, provider: h.input.provider, budgetMs: 60_000, timeoutMs: 1_000, signal });
  assert.deepEqual([h.seen.session.signal === signal, h.seen.session.provider === h.seen.materialize.provider], [true, true]);
  // Two concurrent runs of one owner each reserve, check and delete only their own VM.
  const names = [nameAt(1), nameAt(2)];
  const used = [];
  const deps = { provision: async ({ ledger: own, owner: who }) => readyGuest({ instance: (await own.reserve(who)).instance }), materialize: async () => {},
    session: async ({ name }) => { used.push(['session', name]); await wait(1); return PASSED_RUN; },
    remove: async ({ name }) => { used.push(['remove', name]); return 'deleted'; } };
  const twins = await Promise.all([0, 1].map(() => runCheckJob({ ...h.input, ledger: { ...h.ledger, reserve: async () => ({ instance: names.shift() }) } }, deps)));
  assert.deepEqual(twins.map(run => [run.instance, run.outcome, run.vm]), [[nameAt(1), 'passed', 'deleted'], [nameAt(2), 'passed', 'deleted']]);
  assert.deepEqual(used.sort(), [['remove', nameAt(1)], ['remove', nameAt(2)], ['session', nameAt(1)], ['session', nameAt(2)]]);
});

test('CJ3 nothing runs in the VM unless it is provisioned and cleanly ready, and a reserved VM is still deleted', async () => {
  const unreserved = (failure, provision) => [failure, provision, stopped(failure, { instance: null, vm: 'none' }), ['provision']];
  for (const [label, provision, expected, log = ['provision', 'reserve', 'remove', 'removed']] of [
    ['credential readable', reserving(readyGuest({ bootstrapReady: false, failures: ['CREDENTIAL_EXPOSED'] })), stopped('CHECK_GUEST_NOT_READY')],
    ['a failure despite bootstrapReady', reserving(readyGuest({ failures: ['CREDENTIAL_EXPOSED'] })), stopped('CHECK_GUEST_NOT_READY')],
    ['bootstrapReady not exactly true', reserving(readyGuest({ bootstrapReady: 'true' })), stopped('CHECK_GUEST_NOT_READY')],
    ['failures not an array', reserving(readyGuest({ failures: undefined })), stopped('CHECK_GUEST_NOT_READY')],
    ['another instance', reserving(readyGuest({ instance: nameAt(2) })), stopped('CHECK_PROVISION_FAILED')],
    ['no supervisor identity', reserving(readyGuest({ supervisorSha256: undefined })), stopped('CHECK_ENVIRONMENT_UNKNOWN')],
    ['no provider image identity', reserving(readyGuest({ image: { source: SOURCE, provider: null } })), stopped('CHECK_ENVIRONMENT_UNKNOWN')],
    ['a throw after reserving', reserving(failWith({ code: 'LIFECYCLE_RETRY_EXHAUSTED' })), stopped('LIFECYCLE_RETRY_EXHAUSTED')],
    ['an unknown code after reserving', reserving(failWith({ code: 'EACCES' })), stopped('CHECK_PROVISION_FAILED')],
    ['a code carrying a path', reserving(failWith({ code: 'PROVIDER_/private/secret' })), stopped('CHECK_PROVISION_FAILED')],
    unreserved('CHECK_PROVISION_FAILED', async () => readyGuest()),
    unreserved('CHECK_PROVISION_UNAVAILABLE', async () => ({ provisioned: false, bootstrapReady: false, executionReady: false })),
    unreserved('PRIMARY_NAME_CONFLICT', async () => { throw failWith({ code: 'PRIMARY_NAME_CONFLICT' }); }),
  ]) {
    const h = checkHarness({ provision });
    const result = await runCheckJob(h.input, h.deps);
    assert.deepEqual([result, h.log, /secret|private/.test(JSON.stringify(result))], [expected, log, false], label);
  }
});

test('CJ4 a refused no-mount materialization stops the run before the hook and the session, and still deletes the VM', async () => {
  for (const [error, failure] of [...['TRANSFER_MOUNTS_PRESENT', 'TRANSFER_MOUNTS_UNKNOWN', 'TRANSFER_DIGEST_MISMATCH'].map(code => [transferError(code), code]),
    [failWith({ code: 'SNAPSHOT_PATH_INVALID' }), 'CHECK_MATERIALIZE_FAILED'], [new Error('/private/secret'), 'CHECK_MATERIALIZE_FAILED']]) {
    const h = checkHarness({ materialize: () => { throw error; } });
    assert.deepEqual([await runCheckJob(h.input, h.deps), h.log],
      [stopped(failure, { environment: identityOf() }), ['provision', 'reserve', 'materialize', 'remove', 'removed']], failure);
  }
});

test('CJ5 the onReady hook gates the session; its error, a timeout or an abort settles only after the delete', async () => {
  const gated = UNVERIFIED_LOG.filter(name => name !== 'session');
  const boom = new Error('caller hook');
  for (const [hook, thrown] of [[() => { throw boom; }, boom], [() => Promise.reject(boom), boom], [() => { throw 'not an error'; }, 'not an error']]) {
    const h = checkHarness({ onReady: hook });
    await assert.rejects(runCheckJob(h.input, h.deps), error => error === thrown && h.log.at(-1) === 'removed');
    assert.deepEqual(h.log, gated);
  }
  const hung = checkHarness({ onReady: () => new Promise(() => {}) });
  await assert.rejects(runCheckJob({ ...hung.input, timeoutMs: 20 }, hung.deps), error => checkRefused('CHECK_READY_TIMEOUT')(error) && hung.log.at(-1) === 'removed');
  assert.deepEqual(hung.log, gated);
  const during = new AbortController();
  const aborted = checkHarness({ onReady: () => { during.abort(); return new Promise(() => {}); } });
  assert.deepEqual([await runCheckJob({ ...aborted.input, signal: during.signal }, aborted.deps), aborted.log],
    [stopped('CHECK_ABORTED', { environment: identityOf() }), gated]);
  for (const [at, log] of [['provision', ['provision', 'reserve', 'remove', 'removed']], ['materialize', ['provision', 'reserve', 'materialize', 'remove', 'removed']]]) {
    const controller = new AbortController();
    const abortAfter = behave => async options => { const value = await behave(options); controller.abort(); return value; };
    const h = checkHarness(at === 'provision' ? { provision: abortAfter(reserving(readyGuest())) } : { materialize: abortAfter(() => {}) });
    assert.deepEqual([await runCheckJob({ ...h.input, signal: controller.signal }, h.deps), h.log], [stopped('CHECK_ABORTED', { environment: identityOf() }), log], at);
  }
});

test('CJ6 outcomes pass through after the delete, the approved protected list reaches the guest frame unchanged, and an undeleted pass is inconclusive', async () => {
  const failed = { outcome: 'code-failure', exitCode: 1, signal: null, outputTail: 'boom\n' };
  const undeleted = vm => ranWith(PASSED_RUN, { outcome: 'inconclusive', vm, failure: 'CHECK_VM_DELETE_FAILED' });
  for (const run of [failed, ...['timeout', 'skipped', 'infra-failure'].map(outcome => ({ outcome, exitCode: null, signal: null, outputTail: 'x' })),
    { outcome: 'inconclusive', exitCode: 0, signal: null, outputTail: 'ok\n' }]) {
    const h = checkHarness({ session: () => run });
    assert.deepEqual([await runCheckJob(h.input, h.deps), h.log], [ranWith(run), UNVERIFIED_LOG], run.outcome);
  }
  for (const [session, remove, expected, log = UNVERIFIED_LOG] of [[() => PASSED_RUN, () => { throw failWith({ code: 'LIFECYCLE_STATE_UNKNOWN' }); }, undeleted('delete-failed'), FULL_LOG],
    [() => PASSED_RUN, () => 'gone', undeleted('delete-failed'), FULL_LOG], [() => PASSED_RUN, () => 'not-launched', undeleted('not-launched'), FULL_LOG],
    [() => failed, () => { throw new Error('x'); }, ranWith(failed, { vm: 'delete-failed', failure: 'CHECK_VM_DELETE_FAILED' })],
    [() => { throw failWith({ code: 'CHECK_SESSION_INPUT_INVALID' }); }, () => 'deleted', stopped('CHECK_SESSION_FAILED', { environment: identityOf() })],
    [() => ({ ...PASSED_RUN, outcome: 'pass' }), () => 'deleted', stopped('CHECK_SESSION_FAILED', { environment: identityOf() })]]) {
    const h = checkHarness({ session, remove });
    assert.deepEqual([await runCheckJob(h.input, h.deps), h.log], [expected, log]);
  }
  // The real runCheckSession over a fake supervisor: the frame is the approved check even when the caller edits its object
  // during onReady, and supervisor exits 79 and 80 classify as skipped and inconclusive.
  const HELLO = { kind: 'hello', protocol: 1 };
  for (const [code, frames, outcome, exitCode] of [[79, [], 'skipped', null], [80, [HELLO, EXITED], 'inconclusive', 0], [0, [HELLO, EXITED], 'passed', 0]]) {
    const check = structuredClone(CHECK);
    const h = checkHarness({ onReady: () => { check.command = 'true'; check.protected.length = 0; } });
    const procs = [];
    const spawn = (executable, argv) => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, argv, written: [] });
      proc.stdin = new Writable({ write(chunk, encoding, done) {
        proc.written.push(chunk);
        setImmediate(() => proc.stdout.once('close', () => proc.emit('close', code, null)).end(Buffer.concat(frames.map(frame => encodeFrame(frame)))));
        done();
      } });
      return procs.push(proc) && proc;
    };
    const { session, ...deps } = h.deps;
    const result = await runCheckJob({ ...h.input, check, provider: { spawn } }, deps);
    assert.deepEqual([result.outcome, result.exitCode, result.vm, result.failure], [outcome, exitCode, 'deleted', null], String(code));
    assert.deepEqual(procs.map(proc => [proc.argv, Buffer.concat(proc.written).equals(checkFrame(CHECK))]), [[checkArgv(GUEST), true]]);
  }
});

test('CJ7 a changed image or supervisor gives a new environment, and evidence observed in the old one is stale', async () => {
  const runWith = async changes => {
    const h = checkHarness({ provision: reserving(readyGuest(changes)) });
    const { environment } = await runCheckJob(h.input, h.deps);
    return { environment, treeSha: 'f'.repeat(40), definitionDigest: `sha256:${'d'.repeat(64)}`, planRevision: 1 };
  };
  const first = await runWith({});
  assert.deepEqual([first.environment, evidenceStatus(first, await runWith({}))], [identityOf(), 'fresh']);
  const provider = { imageHash: 'ef'.repeat(32), imageRelease: '24.04 LTS' };
  for (const [changes, identity] of [[{ image: { source: SOURCE, provider } }, { image: provider.imageHash }], [{ supervisorSha256: 'ab'.repeat(32) }, { supervisor: 'ab'.repeat(32) }],
    [{ image: { source: { ...SOURCE, sha256: '12'.repeat(32) }, provider: { imageHash: PROVIDER_HASH } } }, { source: '12'.repeat(32) }]]) {
    const next = await runWith(changes);
    assert.deepEqual([next.environment, next.environment !== first.environment, evidenceStatus(first, next)], [identityOf(identity), true, 'stale']);
  }
});

test('CJ8 the real provisionGuest and deleteOwned purge exactly the VM this run reserved, and nothing foreign', async t => {
  const exhausted = { launch: () => ({ error: failWith({ code: 1, stderr: 'secret' }), create: false }) };
  for (const [label, fakeOptions, expected, taken = false] of [['ready', {}, ranWith(PASSED_RUN)],
    ['the check identity can read the credential', { answers: healthy({ 'readCredential:moe-check': { code: 0, stdout: '' } }) }, stopped('CHECK_GUEST_NOT_READY')],
    ['launch retries exhausted', exhausted, stopped('LIFECYCLE_RETRY_EXHAUSTED')],
    ['a name collision', {}, stopped('LIFECYCLE_NAME_COLLISION', { vm: 'not-launched' }), true]]) {
    const h = provisionHarness(t, fakeOptions);
    const order = [0xa1, 0xa2, 1];
    h.ledger = createLedger(h.ledgerDir, { random: size => Buffer.from(hexOf(order.shift()).repeat(size), 'hex') });
    await seed(h.ledger, 'owned', 1, { ...owner, attemptId: 'attempt-other' });
    await seed(h.ledger, 'collision');
    for (const name of [nameAt(0xa1), nameAt(0xa2), ...(taken ? [GUEST] : [])]) h.fake.present.set(name, 'Running');
    const purged = [];
    const run = (executable, args, options) => (args[0] !== 'delete' ? h.fake.run(executable, args, options)
      : Promise.resolve(purged.push(args[2]) && h.fake.present.delete(args[2]) && { stdout: '', stderr: '' }));
    const result = await runCheckJob({ ...checkHarness().input, ledger: h.ledger, cacheDir: h.cacheDir, provider: { run }, onReady: () => {} }, {
      provision: options => provisionGuest({ ...options, fetch: h.download.fetch, digest: h.digest, sleep: async () => {} }),
      materialize: async () => {}, session: async () => PASSED_RUN, verify: async () => 'intact' });
    const records = Object.fromEntries((await h.ledger.list()).records.map(record => [record.instance, record.phase]));
    assert.deepEqual([result, purged.filter(name => name !== GUEST), records, [GUEST, nameAt(0xa1), nameAt(0xa2)].map(name => h.fake.present.has(name))],
      [expected, [], { [nameAt(0xa1)]: 'owned', [nameAt(0xa2)]: 'collision', [GUEST]: taken ? 'collision' : 'deleted' }, [taken, true, true]], label);
  }
});

// CQ-R11f workspace integrity: VR rows run the real supervisor's verify() over a workspace materialize() built (EXPORT_BASE:
// a.txt, bin/run +x, src/main.c, src/util.c), changed as a check job would; VH rows fake its stream; CJ9/CJ10 runCheckJob.
import { linkSync } from 'node:fs';
import { verifyWorkspace } from '../local-runner/snapshot-transfer.mjs';

const VERIFIED = changed => ({ kind: 'verified', changed });
function verifyIn(paths, setup = '', out = '1') {
  const code = `${PY_LOAD}${setup}\nsys.exit(m.verify(${out}, sys.argv[2], sys.argv[3]))`;
  return spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, paths.workspace, paths.manifest], { timeout: 60_000 });
}
const verified = run => [run.status, createFrameDecoder().push(run.stdout)];
// The name moved aside and replaced by a relative symlink to that identical copy.
const twin = (at, name) => { renameSync(at(name), at(`${name}.real`)); symlinkSync(`${path.basename(name)}.real`, at(name)); };
const JOB_EDITS = [
  ['new bytes', at => writeFileSync(at('src/main.c'), 'int main(void);\n'), 1], ['same-size bytes', at => writeFileSync(at('src/util.c'), 'v'), 1],
  ['a delete', at => rmSync(at('src/util.c')), 1], ['a chmod +x', at => chmodSync(at('a.txt'), 0o755), 1],
  ['a chmod -x', at => chmodSync(at('bin/run'), 0o644), 1], ['a symlink to an identical copy', at => twin(at, 'a.txt'), 1],
  ['an ancestor symlinked to an identical tree', at => twin(at, 'src'), 2], ['a hard link', at => linkSync(at('a.txt'), at('alias')), 1],
  ['a directory in its place', at => { rmSync(at('a.txt')); mkdirSync(at('a.txt')); }, 1],
  ['a FIFO in its place', at => { rmSync(at('a.txt')); mkfifo(at('a.txt')); }, 1],
  ['four at once', at => { writeFileSync(at('src/main.c'), 'x'); rmSync(at('src/util.c')); chmodSync(at('a.txt'), 0o700); twin(at, 'bin/run'); }, 4],
];
// Each os.open as [name, O_NOFOLLOW set, read-only flags], on stderr at exit.
const OPEN_RECORDER = `import atexit, json
opened, real = [], os.open
os.open = lambda name, flags, mode=0o777, *, dir_fd=None: opened.append([os.fsdecode(name), flags & os.O_NOFOLLOW != 0,
    flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND) == 0]) or real(name, flags, mode, dir_fd=dir_fd)
atexit.register(lambda: sys.stderr.write(json.dumps(opened)))`;

test('VR1 an untouched workspace verifies as exactly one {kind: verified, changed: 0} frame', { skip: NOT_POSIX }, t => {
  const run = verifyIn(workspaceIn(t));
  assert.deepEqual(verified(run), [0, [VERIFIED(0)]], String(run.stderr));
});

test('VR2 a changed, deleted, chmod-flipped, linked or replaced manifest file counts once, and no link is followed', { skip: NOT_POSIX }, t => {
  for (const [label, edit, changed] of JOB_EDITS) {
    const paths = workspaceIn(t);
    edit(name => path.join(paths.workspace, name));
    const run = verifyIn(paths);
    assert.deepEqual(verified(run), [0, [VERIFIED(changed)]], `${label} ${run.stderr}`);
  }
  // a.txt grows by a byte once its manifest size is hashed: chunks reads the manifest first, then a.txt.
  const grow = `real, reads = m.chunks, []\ndef chunks(fd, size):\n    yield from real(fd, size)\n    reads.append(fd)
    if len(reads) == 2:\n        with open(sys.argv[2] + '/a.txt', 'ab') as file:\n            file.write(b'+')\nm.chunks = chunks`;
  const grown = verifyIn(workspaceIn(t), grow);
  assert.deepEqual(verified(grown), [0, [VERIFIED(1)]], String(grown.stderr));
  if (process.getuid() !== 0) { // an unreadable directory hides its files, so they count as changed; the guest's root reads through
    const paths = workspaceIn(t);
    chmodSync(path.join(paths.workspace, 'src'), 0);
    const run = verifyIn(paths);
    chmodSync(path.join(paths.workspace, 'src'), 0o755);
    assert.deepEqual(verified(run), [0, [VERIFIED(2)]], String(run.stderr));
  }
});

test('VR3 only manifest names are opened, each without following a link, so new files, directories and mode-000 entries leave it intact',
  { skip: NOT_POSIX }, t => {
    const paths = workspaceIn(t);
    const at = name => path.join(paths.workspace, name);
    mkdirSync(at('out/deep'), { recursive: true, mode: 0o700 });
    writeFileSync(at('out/deep/report.log'), 'r', { mode: 0o600 });
    writeFileSync(at('src/added.c'), '');
    writeFileSync(at('locked'), 'L', { mode: 0 });
    mkdirSync(at('sealed'));
    writeFileSync(at('sealed/in'), 'S');
    chmodSync(at('sealed'), 0);
    const run = verifyIn(paths, OPEN_RECORDER);
    chmodSync(at('sealed'), 0o700);
    const opened = [paths.manifest, paths.workspace, 'a.txt', 'bin', 'run', 'src', 'main.c', 'src', 'util.c'].map(name => [name, true, true]);
    assert.deepEqual([...verified(run), JSON.parse(run.stderr)], [0, [VERIFIED(0)], opened]);
  });

test('VR4 verify writes, chowns and chmods nothing, and its one frame carries only kind and changed', { skip: NOT_POSIX }, t => {
  const paths = workspaceIn(t);
  const at = name => path.join(paths.workspace, name);
  writeFileSync(at('src/main.c'), 'int main(void);\n');
  chmodSync(at('a.txt'), 0o755);
  linkSync(at('bin/run'), at('bin/alias'));
  writeFileSync(at('new.txt'), 'N', { mode: 0o600 });
  const stateOf = () => readdirSync(paths.lib, { recursive: true }).sort().map(name => {
    const file = path.join(paths.lib, name);
    const info = lstatSync(file, { bigint: true });
    return [name, info.mode, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs, info.isFile() ? sha(readFileSync(file)) : null];
  });
  const before = stateOf();
  const refuse = `def refuse(*args, **kwargs):\n    raise AssertionError('verify changed the filesystem')
for call in ('chmod', 'fchmod', 'chown', 'fchown', 'lchown', 'unlink', 'rename', 'replace', 'mkdir', 'rmdir', 'symlink', 'link', 'utime',
             'truncate', 'ftruncate'):
    setattr(os, call, refuse)
real_write = os.write
os.write = lambda fd, data: real_write(fd, data) if fd == 1 else refuse()`;
  const run = verifyIn(paths, refuse);
  assert.deepEqual([...verified(run), stateOf()], [0, [VERIFIED(3)], before], String(run.stderr));
  assert.deepEqual(Object.keys(createFrameDecoder().push(run.stdout)[0]).sort(), ['changed', 'kind']);
});

test('VR5 a missing or malformed manifest or workspace exits 65, and a gone host 74, each with no frame', { skip: NOT_POSIX }, t => {
  const rewrite = edit => paths => writeFileSync(paths.manifest, JSON.stringify(edit(JSON.parse(readFileSync(paths.manifest, 'utf8')))));
  const extra = name => rewrite(stored => ({ ...stored, files: { ...stored.files, [name]: stored.files['a.txt'] } }));
  for (const [label, change] of [['a missing manifest', paths => rmSync(paths.manifest)], ['not JSON', paths => writeFileSync(paths.manifest, '{')],
    ['a short row', rewrite(stored => ({ ...stored, files: { 'a.txt': stored.files['a.txt'].slice(1) } }))],
    // '../workspace/a.txt' is a.txt itself, reached from outside the workspace root.
    ...['../workspace/a.txt', 'src/../a.txt', './a.txt', '/a.txt', 'src//main.c', ''].map(name => [JSON.stringify(name), extra(name)]),
    ['a missing workspace', paths => rmSync(paths.workspace, { recursive: true })],
    ['a symlinked workspace', paths => { renameSync(paths.workspace, `${paths.workspace}.real`); symlinkSync(`${paths.workspace}.real`, paths.workspace); }],
  ]) {
    const paths = workspaceIn(t);
    change(paths);
    const run = verifyIn(paths);
    assert.deepEqual([run.status, run.stdout.length], [65, 0], `${label} ${run.stderr}`);
  }
  const gone = verifyIn(workspaceIn(t), 'out, gone = os.pipe()\nos.close(out)', 'gone');
  assert.deepEqual([gone.status, gone.stdout.length], [74, 0], String(gone.stderr));
});

test('VR6 the supervisor CLI takes exactly verify, only as root, and routes it to verify(1)', { skip: NOT_POSIX }, () => {
  for (const args of [['verify', 'x'], ['VERIFY']]) {
    const run = spawnSync('python3', ['-I', '-B', PY_SUPERVISOR, ...args]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0], `${args} ${run.stderr}`);
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}sys.exit(m.main(['verify'], geteuid=lambda: 1000))`, PY_SUPERVISOR]);
  assert.deepEqual([run.status, run.stdout.length], [77, 0], String(run.stderr));
  const routed = `${PY_LOAD}m.verify = lambda *a, **k: sys.stderr.write(repr((a, k))) and 42\nsys.exit(m.main(['verify'], geteuid=lambda: 0))`;
  const root = spawnSync('python3', ['-I', '-B', '-c', routed, PY_SUPERVISOR]);
  assert.deepEqual([root.status, String(root.stderr), root.stdout.length], [42, '((1,), {})', 0]);
});

test('VH1 verifyWorkspace sends no input and maps its one frame to intact or changed, between two mount checks', async () => {
  for (const [changed, expected] of [[0, 'intact'], [1, 'changed'], [10_000, 'changed']]) {
    const t = transferProvider(undefined, proc => proc.reply(VERIFIED(changed)));
    assert.equal(await verifyWorkspace({ name: GUEST, provider: t.provider, timeoutMs: 5_000 }), expected);
    assert.deepEqual([t.proc.before, t.guest.ids(), t.guest.unexpected, t.proc.calls, t.proc.written, t.proc.kills],
      [['info', 'mountinfo'], ['info', 'mountinfo', 'info', 'mountinfo'], [], [['multipass', snapshotArgv(GUEST, 'verify'), PIPES]], [], []]);
  }
});

test('VH2 any other stream, mount state, provider failure or input is a fixed refusal', async () => {
  const done = VERIFIED(0);
  for (const [label, respond, code, kills = ['SIGKILL']] of [
    ['no frame', proc => proc.reply([]), 'TRANSFER_FRAME_INVALID', []], ['two frames', proc => proc.reply([done, done]), 'TRANSFER_FRAME_INVALID'],
    ['a path key', proc => proc.reply({ ...done, path: 'a.txt' }), 'TRANSFER_FRAME_INVALID'],
    ['no count', proc => proc.reply({ kind: 'verified' }), 'TRANSFER_FRAME_INVALID'],
    ['another kind', proc => proc.reply({ ...done, kind: 'materialized' }), 'TRANSFER_FRAME_INVALID'],
    ...[-1, 1.5, '0', null, true, 2 ** 53].map(changed => [`changed ${changed}`, proc => proc.reply({ ...done, changed }), 'TRANSFER_FRAME_INVALID']),
    ['a nonzero exit', proc => proc.reply(done, 74), 'TRANSFER_EXIT_FAILED'], ['a hang', () => {}, 'TRANSFER_TIMEOUT'],
  ]) {
    const t = transferProvider(undefined, respond);
    await assert.rejects(verifyWorkspace({ name: GUEST, provider: t.provider, timeoutMs: label === 'a hang' ? 50 : 5_000 }), transferRefused(code), label);
    assert.deepEqual([t.proc.kills, t.proc.calls.length], [kills, 1], label);
  }
  for (const [label, options, code, spawned] of [['a provider mount', { info: guestDetail({ mounts: HOST_MOUNT }) }, 'TRANSFER_MOUNTS_PRESENT', 0],
    ['unknown mounts', { answers: healthy({ mountinfo: { code: 0, stdout: '' } }) }, 'TRANSFER_MOUNTS_UNKNOWN', 0],
    ['a provider failure', { info: { error: failWith({ code: 'ENOENT' }) } }, 'PROVIDER_NOT_FOUND', 0],
    ['a late mount', { answers: healthy({ mountinfo: [mountinfo(), mountinfo([...MOUNTS, SHARED_LINE('virtiofs')])] }) }, 'TRANSFER_MOUNTS_PRESENT', 1]]) {
    const t = transferProvider(options, proc => proc.reply(done));
    await assert.rejects(verifyWorkspace({ name: GUEST, provider: t.provider }), transferRefused(code), label);
    assert.equal(t.proc.calls.length, spawned, label);
  }
  const guest = fakeGuest();
  await assert.rejects(verifyWorkspace({ name: GUEST, provider: { run: guest.run, spawn: () => { throw new Error('/private/secret'); } } }),
    transferRefused('TRANSFER_SPAWN_FAILED'));
  for (const [label, options] of [['no options', undefined], ['primary', { name: 'primary' }], ['timeout', { timeoutMs: 600_001 }],
    ['spawn', { provider: { run: guest.run, spawn: 'spawn' } }], ['provider', { provider: null }]]) {
    const t = transferProvider(undefined, proc => proc.reply(done));
    await assert.rejects(verifyWorkspace(options && { name: GUEST, provider: t.provider, ...options }), transferRefused('TRANSFER_INPUT_INVALID'), label);
    assert.deepEqual([t.guest.calls, t.proc.calls], [[], []], label);
  }
});

test('CJ9 only a passed session is verified, after it and before the delete, and a refused verify leaves the workspace unverified', async () => {
  for (const state of ['intact', 'changed']) {
    const h = checkHarness({ verify: async () => { await wait(2); h.log.push('verified'); return state; } });
    assert.deepEqual([await runCheckJob(h.input, h.deps), h.log, h.seen.verify],
      [ranWith(PASSED_RUN, { workspace: state }), [...UNVERIFIED_LOG.slice(0, -2), 'verify', 'verified', 'remove', 'removed'],
        { name: GUEST, provider: h.input.provider, timeoutMs: 1_000 }], state);
  }
  for (const verify of [() => { throw transferError('TRANSFER_MOUNTS_PRESENT'); }, () => Promise.reject(new Error('/private/secret')), () => { throw 'x'; },
    ...['INTACT', 'unverified', undefined, { state: 'intact' }].map(value => () => value)]) {
    const h = checkHarness({ verify });
    assert.deepEqual([await runCheckJob(h.input, h.deps), h.log], [ranWith(PASSED_RUN, { workspace: 'unverified' }), FULL_LOG]);
  }
  for (const outcome of ['code-failure', 'timeout', 'skipped', 'infra-failure', 'inconclusive']) {
    const h = checkHarness({ session: () => ({ ...PASSED_RUN, outcome }), verify: () => assert.fail('verify') });
    assert.deepEqual([(await runCheckJob(h.input, h.deps)).workspace, h.log], ['unverified', UNVERIFIED_LOG], outcome);
  }
});

test('CJ10 end to end, the real supervisor verify reports a passed job\'s edits as changed, and its own new files as intact',
  { skip: NOT_POSIX, timeout: 120_000 }, async t => {
    const guest = fakeGuest();
    const created = at => { mkdirSync(at('out/deep'), { recursive: true, mode: 0o700 }); writeFileSync(at('out/deep/r.log'), 'r', { mode: 0o600 }); };
    for (const [label, edit, expected] of [['no edit', () => {}, 'intact'], ['new 0600 files under 0700 directories', created, 'intact'],
      ...JOB_EDITS.map(([name, change]) => [name, change, 'changed'])]) {
      const paths = workspaceIn(t);
      // A spawn that keeps only the argv's final mode and runs that real supervisor function on the child's stdio.
      const spawn = (executable, argv, options) => spawnChild('python3', ['-I', '-B', '-c',
        `${PY_LOAD}sys.exit(m.${argv.at(-1)}(1, sys.argv[2], sys.argv[3]))`, PY_SUPERVISOR, paths.workspace, paths.manifest], options);
      const h = checkHarness({ session: () => { edit(name => path.join(paths.workspace, name)); return PASSED_RUN; } });
      const { verify, ...deps } = h.deps; // the default, verifyWorkspace
      const result = await runCheckJob({ ...h.input, provider: { run: guest.run, spawn }, timeoutMs: 30_000 }, deps);
      assert.deepEqual([result.outcome, result.workspace, result.vm, typeof verify], ['passed', expected, 'deleted', 'function'], label);
    }
    assert.deepEqual(guest.unexpected, []);
  });

// CQ-R10d3a agents install rows: the real supervisor's install_agents() into <dir>/agents, owned by the test user (the owner seam).
import { MAX_AGENT_BINARY_BYTES } from '../local-runner/agent-cache.mjs';

function agentsIn(dir, input, setup = '', ...extra) {
  const agents = path.join(dir, 'agents');
  const code = `${PY_LOAD}${setup}\nsys.exit(m.install_agents(0, 1, sys.argv[2], (os.getuid(), os.getgid())))`;
  return Object.assign(spawnSync('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, agents, ...extra],
    { input, maxBuffer: 64 << 20, timeout: 60_000 }), { agents });
}
const agentOf = (cli, bytes, changes = {}) => ({ kind: 'agent', cli, size: bytes.length, sha256: sha(bytes), ...changes });
const binaryOf = (cli, bytes) => [agentOf(cli, bytes), ...dataFrames(bytes)];
const AGENTS_END = { kind: 'end' };
// <agents> as sorted [name, bytes or 'dir', mode] rows, staging directories included.
const agentsState = agents => readdirSync(agents).sort().map(name => {
  const file = path.join(agents, name);
  return [name, statSync(file).isDirectory() ? 'dir' : readFileSync(file), modeOf(file)];
});
// A 0755 agents directory already holding an older 0555 claude, so 'installs nothing' is observable.
const OLD_AGENTS = [['claude', Buffer.from('old'), 0o555]];
function seededAgents(t) {
  const dir = scratch(t);
  mkdirSync(path.join(dir, 'agents'));
  chmodSync(path.join(dir, 'agents'), 0o755);
  writeFileSync(path.join(dir, 'agents', 'claude'), 'old', { mode: 0o555 });
  return dir;
}

test('AI1 the supervisor CLI takes exactly agents, only as root, and routes it to install_agents(0, 1) with root /opt/moe/agents defaults', { skip: NOT_POSIX }, () => {
  for (const args of [['agents', 'x'], ['AGENTS']]) {
    const run = spawnSync('python3', ['-I', '-B', PY_SUPERVISOR, ...args]);
    assert.deepEqual([run.status, run.stdout.length], [64, 0], `${args} ${run.stderr}`);
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}sys.exit(m.main(['agents'], geteuid=lambda: 1000))`, PY_SUPERVISOR]);
  assert.deepEqual([run.status, run.stdout.length], [77, 0], String(run.stderr));
  const routed = `${PY_LOAD}m.install_agents = lambda *a, **k: sys.stderr.write(repr((a, k))) and 42\nsys.exit(m.main(['agents'], geteuid=lambda: 0))`;
  const root = spawnSync('python3', ['-I', '-B', '-c', routed, PY_SUPERVISOR]);
  assert.deepEqual([root.status, String(root.stderr), root.stdout.length], [42, '((0, 1), {})', 0]);
  // Every JOBS executable lives in AGENTS, the size cap mirrors agent-cache.mjs, and production installs are root:root.
  const pins = `${PY_LOAD}import inspect, json
p = inspect.signature(m.install_agents).parameters
print(json.dumps([m.AGENTS, sorted({os.path.dirname(job[0]) for job in m.JOBS.values()}), m.MAX_AGENT_BYTES, p['agents'].default, repr(p['owner'].default)]))`;
  const pinned = spawnSync('python3', ['-I', '-B', '-c', pins, PY_SUPERVISOR]);
  assert.equal(pinned.status, 0, String(pinned.stderr));
  assert.deepEqual(JSON.parse(pinned.stdout), ['/opt/moe/agents', ['/opt/moe/agents'], MAX_AGENT_BINARY_BYTES, '/opt/moe/agents', '(0, 0)']);
});

test('AI2 a clean stream installs each binary at <agents>/<cli> as 0555 with its exact bytes in a 0755 dir, and answers once', { skip: NOT_POSIX }, t => {
  const claude = BIG.subarray(0, SNAPSHOT_CHUNK_BYTES + 3); // two data frames
  const codex = Buffer.from('#!/bin/sh\ncodex\n');
  const run = agentsIn(scratch(t), framesOf([...binaryOf('claude', claude), ...binaryOf('codex', codex), AGENTS_END]));
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(createFrameDecoder().push(run.stdout), [{ kind: 'installed', count: 2 }]);
  assert.deepEqual(agentsState(run.agents), [['claude', claude, 0o555], ['codex', codex, 0o555]]); // no staging left
  const uids = ['claude', 'codex'].map(cli => statSync(path.join(run.agents, cli)).uid);
  assert.deepEqual([modeOf(run.agents), uids], [0o755, [process.getuid(), process.getuid()]]);
});

test('AI3 a reinstall replaces an older binary by rename, never in place, and forces the agents dir to 0755', { skip: NOT_POSIX }, t => {
  const dir = seededAgents(t);
  const agents = path.join(dir, 'agents');
  chmodSync(agents, 0o777);
  linkSync(path.join(agents, 'claude'), path.join(dir, 'kept')); // an in-place write would show through this link
  const fresh = Buffer.from('new claude');
  const run = agentsIn(dir, framesOf([...binaryOf('claude', fresh), AGENTS_END]));
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(createFrameDecoder().push(run.stdout), [{ kind: 'installed', count: 1 }]);
  assert.deepEqual([agentsState(agents), modeOf(agents), String(readFileSync(path.join(dir, 'kept')))], [[['claude', fresh, 0o555]], 0o755, 'old']);
});

test('AI4 a malformed, mismatched or partial stream exits 65 with no frame and installs nothing', { skip: NOT_POSIX }, t => {
  const claude = Buffer.from('claude!');
  const codex = Buffer.from('codex');
  const bit = Buffer.from('c');
  const data = bytes => ({ kind: 'data', data: Buffer.from(bytes).toString('base64') });
  const C = agentOf('claude', claude);
  const X = data(claude);
  const one = (header, ...frames) => [header, ...(frames.length ? frames : [X]), AGENTS_END];
  const both = [C, X, agentOf('codex', codex), data(codex), AGENTS_END];
  // A row's third element is harness setup; each size row is a whole, hash-correct binary, so only the size rule refuses it.
  for (const [label, frames, setup] of [
    ['an unknown cli', one({ ...C, cli: 'gemini' })], ...[['claude'], 7, null].map(cli => [`cli ${JSON.stringify(cli)}`, one({ ...C, cli })]),
    ['a duplicate cli', [C, X, C, X, AGENTS_END]],
    ['size 0', [agentOf('claude', Buffer.alloc(0)), AGENTS_END]], ['size true', one(agentOf('claude', bit, { size: true }), data(bit))],
    ['a size above the cap', one(C), `m.MAX_AGENT_BYTES = ${claude.length - 1}`],
    ...[C.sha256.toUpperCase(), C.sha256.slice(1), 7].map(sha256 => [`sha256 ${sha256}`, one({ ...C, sha256 })]),
    ['a wrong hash', one({ ...C, sha256: sha(Buffer.from('claude?')) })],
    ['short data', one(C, data('cla'))], ['a chunk past the size', one(C, data('cla'), data('ude!x'))],
    ['an empty data frame', one(C, data(''), X)], ['non-canonical base64', one(agentOf('claude', Buffer.from('A')), { kind: 'data', data: 'QR==' })],
    ['a non-string data', one(C, { kind: 'data', data: 7 })],
    ['an extra header key', one({ ...C, mode: 365 })], ['an extra data key', one(C, { ...X, size: 7 })],
    ['data before a header', [X, C, X, AGENTS_END]], ['a zero-byte stream', []], ['an end before any agent', [AGENTS_END]],
    ['EOF before end', [C, X]], ['a second end', [...one(C), AGENTS_END]],
    ['a partial frame after end', [...one(C), encodeFrame(AGENTS_END).subarray(0, 5)]],
    ['a valid claude then a bad codex', [C, X, agentOf('codex', codex, { sha256: sha(claude) }), data(codex), AGENTS_END]],
  ]) {
    const run = agentsIn(seededAgents(t), framesOf(frames), setup);
    assert.deepEqual([run.status, run.stdout.length, agentsState(run.agents), modeOf(run.agents)], [65, 0, OLD_AGENTS, 0o755], `${label} ${run.stderr}`);
  }
  // Each row breaks exactly one rule: the base streams install, in either order, and so does a size at either bound.
  const pair = [['claude', claude, 0o555], ['codex', codex, 0o555]];
  for (const [label, frames, setup, installed] of [['claude first', both, '', pair],
    ['codex first', [...both.slice(2, 4), ...both.slice(0, 2), AGENTS_END], '', pair],
    ['size 1', one(agentOf('claude', bit), data(bit)), '', [['claude', bit, 0o555]]],
    ['size == cap', one(C), `m.MAX_AGENT_BYTES = ${claude.length}`, [['claude', claude, 0o555]]]]) {
    const run = agentsIn(seededAgents(t), framesOf(frames), setup);
    assert.deepEqual([run.status, agentsState(run.agents)], [0, installed], `${label} ${run.stderr}`);
  }
});

test('AI5 an agents path that is a symlink or a file, or a failed fsync or rename, exits 74 with no frame and installs nothing', { skip: NOT_POSIX }, t => {
  const frames = framesOf([...binaryOf('claude', Buffer.from('new')), ...binaryOf('codex', Buffer.from('codex')), AGENTS_END]);
  const outside = scratch(t); // mkdtemp's 0700: a followed link would be forced to 0755
  const linked = scratch(t);
  symlinkSync(outside, path.join(linked, 'agents'));
  const viaLink = agentsIn(linked, frames);
  assert.deepEqual([viaLink.status, viaLink.stdout.length, lstatSync(viaLink.agents).isSymbolicLink(), readdirSync(outside), modeOf(outside)],
    [74, 0, true, [], 0o700], String(viaLink.stderr));
  const filed = scratch(t);
  writeFileSync(path.join(filed, 'agents'), 'a file');
  const viaFile = agentsIn(filed, frames);
  assert.deepEqual([viaFile.status, viaFile.stdout.length, readdirSync(filed), String(readFileSync(viaFile.agents))],
    [74, 0, ['agents'], 'a file'], String(viaFile.stderr));
  for (const call of ['fsync', 'rename']) {
    const failed = agentsIn(seededAgents(t), frames, `def fail(*args, **kwargs):\n    raise OSError(5, 'injected')\nos.${call} = fail`);
    assert.deepEqual([failed.status, failed.stdout.length, agentsState(failed.agents)], [74, 0, OLD_AGENTS], `${call} ${failed.stderr}`);
  }
});

// CQ-R10d3 host agent install and readiness: installAgents over a scratch cache of stand-in binaries (rows AH, since AI is R10d3a's).
import { loadAgentManifest } from '../local-runner/agent-cache.mjs';
import { installAgents } from '../local-runner/snapshot-transfer.mjs';

const CODEX = Buffer.from('#!/bin/sh\ncodex\n');
const INSTALLED = { kind: 'installed', count: 2 };
// A cacheDir of <sha256>.bin stand-ins (claude is BIG, codex a short script), the installed manifest with its x64 pins
// re-pinned to them, and a fetch seam that records and refuses, so a verified cache hit never downloads.
async function agentCache(t) {
  const manifest = structuredClone(await loadAgentManifest());
  const cacheDir = scratch(t);
  Object.assign(manifest.binaries.claude.x64, { sha256: sha(BIG), size: BIG.length });
  Object.assign(manifest.binaries.codex.x64, { memberSha256: sha(CODEX), memberSize: CODEX.length });
  const file = bytes => path.join(cacheDir, `${sha(bytes)}.bin`);
  for (const bytes of [BIG, CODEX]) writeFileSync(file(bytes), bytes);
  const fetches = [];
  return { cacheDir, fetches, file, seams: { manifest, fetch: async url => { fetches.push(url); throw failWith({ code: 'ECONNREFUSED' }); } } };
}
const agentInstall = (cache, p, change = {}) => installAgents({ name: GUEST, arch: 'x64', cacheDir: cache.cacheDir, provider: p.provider, ...change }, cache.seams);
const installer = respond => transferProvider(undefined, proc => proc.reply(respond ?? INSTALLED));

test('AH1 a clean install streams both cache-verified binaries between two mount checks and resolves the frozen result', async t => {
  const cache = await agentCache(t);
  const p = installer();
  const result = await agentInstall(cache, p);
  assert.deepEqual(result, { instance: GUEST, agents: 2, bytes: BIG.length + CODEX.length, executionReady: false });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual([p.proc.before, p.guest.ids(), p.guest.unexpected, cache.fetches], [['info', 'mountinfo'], ['info', 'mountinfo', 'info', 'mountinfo'], [], []]);
  assert.deepEqual([p.proc.calls, p.proc.kills], [[['multipass', snapshotArgv(GUEST, 'agents'), PIPES]], []]);
  assert.deepEqual(p.proc.frames(), [binaryOf('claude', BIG), binaryOf('codex', CODEX), [AGENTS_END]].flat());
  assert.ok(p.proc.peak <= encodeFrame(dataFrames(BIG)[0]).length + p.proc.stdin.writableHighWaterMark, String(p.proc.peak));
});

test('AH2 every refusal is a fixed code, input errors touch neither provider nor cache, and a cache file that drifts after verification is never completed', async t => {
  const cache = await agentCache(t);
  const listing = readdirSync(cache.cacheDir).sort();
  for (const [label, change, code] of [
    ['null options', null, 'TRANSFER_INPUT_INVALID'], ['primary', { name: 'primary' }, 'TRANSFER_INPUT_INVALID'],
    ['timeout', { timeoutMs: 600_001 }, 'TRANSFER_INPUT_INVALID'], ['spawn', { provider: { spawn: 'spawn' } }, 'TRANSFER_INPUT_INVALID'],
    ['arch', { arch: 'mips' }, 'AGENT_BINARY_INPUT_INVALID'], ['relative cacheDir', { cacheDir: 'cache' }, 'AGENT_BINARY_INPUT_INVALID'],
    ['a bad name and a bad arch: the stream options come first', { name: 'primary', arch: 'mips' }, 'TRANSFER_INPUT_INVALID'],
  ]) {
    const p = installer();
    await assert.rejects(change === null ? installAgents(null, cache.seams) : agentInstall(cache, p, change), transferRefused(code), label);
    assert.deepEqual([p.guest.ids(), p.proc.calls, readdirSync(cache.cacheDir).sort(), cache.fetches], [[], [], listing, []], label);
  }
  const empty = installer();
  await assert.rejects(agentInstall({ ...cache, cacheDir: scratch(t) }, empty), transferRefused('AGENT_BINARY_DOWNLOAD_FAILED'));
  assert.deepEqual([empty.guest.ids(), empty.proc.calls, cache.fetches.length], [[], [], 1]);
  // The mount checks: a mount before the stream means no spawn, and one that appears during it refuses the result.
  const before = transferProvider({ info: guestDetail({ mounts: HOST_MOUNT }) }, proc => proc.reply(INSTALLED));
  await assert.rejects(agentInstall(cache, before), transferRefused('TRANSFER_MOUNTS_PRESENT'));
  assert.deepEqual([before.guest.ids(), before.proc.calls], [['info', 'mountinfo'], []]);
  const during = transferProvider({ info: [guestDetail(), guestDetail({ mounts: HOST_MOUNT })] }, proc => proc.reply(INSTALLED));
  await assert.rejects(agentInstall(cache, during), transferRefused('TRANSFER_MOUNTS_PRESENT'));
  assert.equal(during.proc.calls.length, 1);
  for (const [label, reply, code] of [
    ['no frame', [], 'TRANSFER_FRAME_INVALID'], ['another kind', { ...INSTALLED, kind: 'verified' }, 'TRANSFER_FRAME_INVALID'],
    ['count 1', { ...INSTALLED, count: 1 }, 'TRANSFER_FRAME_INVALID'], ['an extra key', { ...INSTALLED, extra: 1 }, 'TRANSFER_FRAME_INVALID'],
    ['two frames', [INSTALLED, INSTALLED], 'TRANSFER_FRAME_INVALID'],
  ]) await assert.rejects(agentInstall(cache, installer(reply)), transferRefused(code), label);
  const failed = transferProvider(undefined, proc => proc.reply(INSTALLED, 65));
  await assert.rejects(agentInstall(cache, failed), transferRefused('TRANSFER_EXIT_FAILED'));
  // The spawn hook runs after fetchAgentBinary verified the file: the host re-hash stops the stream at codex's header.
  const linked = path.join(scratch(t), 'copy');
  const atCodex = [binaryOf('claude', BIG), agentOf('codex', CODEX)].flat();
  for (const [label, bytes, drift, sent] of [
    ['rewritten in place', CODEX, file => writeFileSync(file, Buffer.alloc(CODEX.length, 1)), atCodex],
    ['truncated', CODEX, file => truncateSync(file, 3), atCodex],
    // A short read of claude's second chunk stops the stream there, not after its last data frame.
    ['claude truncated mid-binary', BIG, file => truncateSync(file, SNAPSHOT_CHUNK_BYTES + 5), [agentOf('claude', BIG), dataFrames(BIG)[0]]],
    ...(process.platform === 'win32' ? [] : [['replaced by a link to the same bytes', CODEX, file => { rmSync(file); writeFileSync(linked, CODEX); symlinkSync(linked, file); }, atCodex]]),
  ]) {
    for (const original of [BIG, CODEX]) { rmSync(cache.file(original), { force: true }); writeFileSync(cache.file(original), original); }
    const p = installer();
    const provider = { ...p.provider, spawn: (...args) => { drift(cache.file(bytes)); return p.provider.spawn(...args); } };
    await assert.rejects(agentInstall(cache, p, { provider }), transferRefused('TRANSFER_INPUT_INVALID'), label);
    assert.deepEqual([p.proc.kills, p.proc.frames()], [['SIGKILL'], sent], label);
  }
  assert.deepEqual(cache.fetches.length, 1);
});

test('AH3 end to end, installAgents installs both stand-ins as 0555 through the real supervisor', { skip: NOT_POSIX, timeout: 60_000 }, async t => {
  const cache = await agentCache(t);
  const agents = path.join(scratch(t), 'agents');
  const guest = fakeGuest();
  const children = [];
  t.after(() => children.forEach(child => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')));
  const spawn = (executable, argv, options) => {
    const code = `${PY_LOAD}sys.exit(m.install_agents(0, 1, sys.argv[2], (os.getuid(), os.getgid())))`;
    children.push(spawnChild('python3', ['-I', '-B', '-c', code, PY_SUPERVISOR, agents], options));
    return children.at(-1);
  };
  const result = await agentInstall(cache, { provider: { run: guest.run, spawn } }, { timeoutMs: 30_000 });
  assert.deepEqual(result, { instance: GUEST, agents: 2, bytes: BIG.length + CODEX.length, executionReady: false });
  assert.deepEqual([readdirSync(agents).sort(), guest.ids(), guest.unexpected, cache.fetches], [['claude', 'codex'], ['info', 'mountinfo', 'info', 'mountinfo'], [], []]);
  assert.deepEqual(agentsState(agents), [['claude', BIG, 0o555], ['codex', CODEX, 0o555]]);
});

// checkAgents (after installAgents, never at bootstrap): one fixed sha256sum probe compared with the installed manifest's pins.
import { checkAgents } from '../local-runner/guest-readiness.mjs';

test('RA checkAgents reports AGENT_MISSING for an absent binary and AGENT_HASH_MISMATCH for a changed one, from the installed pins only', async () => {
  const { binaries } = await loadAgentManifest();
  const pinned = { claude: binaries.claude.x64.sha256, codex: binaries.codex.x64.memberSha256 };
  const line = (cli, digest = pinned[cli]) => `${digest}  /opt/moe/agents/${cli}\n`;
  const both = line('claude') + line('codex');
  const other = 'ef'.repeat(32);
  const check = async (answer, arch = 'x64') => {
    const fake = fakeGuest({ answers: { agentHashes: answer } });
    const report = await checkAgents({ name: GUEST, arch, provider: { run: fake.run } });
    assert.deepEqual([fake.ids(), fake.unexpected], [['agentHashes'], []]);
    return report;
  };
  for (const [label, answer, failures, arch] of [
    ['both pinned', { code: 0, stdout: both }, []], ['only claude', { code: 1, stdout: line('claude') }, ['AGENT_MISSING']],
    ['claude changed', { code: 0, stdout: line('claude', other) + line('codex') }, ['AGENT_HASH_MISMATCH']],
    ['an uppercase digest', { code: 0, stdout: line('claude', pinned.claude.toUpperCase()) + line('codex') }, ['AGENT_HASH_MISMATCH']],
    ['a digest the pin is only a prefix of', { code: 0, stdout: line('claude', `${pinned.claude}ab`) + line('codex') }, ['AGENT_HASH_MISMATCH']],
    ['codex shows its archive sha256, not the member', { code: 0, stdout: line('claude') + line('codex', binaries.codex.x64.sha256) }, ['AGENT_HASH_MISMATCH']],
    ['x64 lines checked as arm64', { code: 0, stdout: both }, ['AGENT_HASH_MISMATCH'], 'arm64'],
    ['empty stdout', { code: 1, stdout: '' }, ['AGENT_MISSING']],
    ['claude changed and codex missing', { code: 1, stdout: line('claude', other) }, ['AGENT_HASH_MISMATCH', 'AGENT_MISSING']],
    ['a non-zero exit with both lines pinned', { code: 1, stdout: both }, ['PROBE_UNKNOWN']],
    ['the probe failing', { error: failWith({ code: 'ENOENT' }) }, ['PROVIDER_NOT_FOUND']],
  ]) assert.deepEqual(await check(answer, arch), { instance: GUEST, agentsReady: failures.length === 0, executionReady: false, failures }, label);
  let calls = 0;
  const counting = { run: async () => { calls++; return { stdout: '', stderr: '' }; } };
  await assert.rejects(checkAgents({ name: GUEST, arch: 'mips', provider: counting }), error => assertSanitized(error, 'BOOTSTRAP_INPUT_INVALID'));
  await assert.rejects(checkAgents({ name: 'primary', arch: 'x64', provider: counting }), error => assertSanitized(error, 'LIFECYCLE_INPUT_INVALID'));
  assert.equal(calls, 0);
});

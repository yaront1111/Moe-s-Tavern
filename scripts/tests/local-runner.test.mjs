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

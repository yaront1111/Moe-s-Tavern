import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECK_BOUNDARIES, checkEnvironment, evidenceStatus } from '../local-runner/check-evidence.mjs';
import { MAX_HOST_FRAME_BYTES, createFrameDecoder, encodeFrame, parseGuestFrame } from '../local-runner/guest-bridge.mjs';

const MESSAGE = 'Check environment input was invalid.';
const sha = text => createHash('sha256').update(text).digest('hex');
const caught = fn => { try { fn(); } catch (error) { return error; } return assert.fail('expected a refusal'); };
const deepFreeze = value => {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
};
const nodesOf = value => [value, ...Object.values(value).filter(child => child !== null && typeof child === 'object').flatMap(nodesOf)];
// The documented v1 identity, recomputed independently of the module: sorted keys at every depth, no whitespace.
const canon = value => Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}` : JSON.stringify(value);
const oracle = (boundaries, inputs) => `moe-local-vm-v1:${sha(canon({ boundaries, inputs }))}`;
const reversed = value => Object.fromEntries(Object.entries(value).reverse());

const VALID = deepFreeze({
  sourceImageSha256: '0123456789abcdef'.repeat(4),
  providerImageHash: 'fedcba9876543210'.repeat(4),
  supervisorSha256: '00ff11ee22dd33cc'.repeat(4),
  resources: { cpus: 2, memoryBytes: 4294967296, diskBytes: 21474836480 },
});
const HASHES = ['sourceImageSha256', 'providerImageHash', 'supervisorSha256'];
const RESOURCES = ['cpus', 'memoryBytes', 'diskBytes'];
const fresh = () => structuredClone(VALID);
const refusal = (fn, label) => {
  const error = caught(fn);
  assert.ok(error instanceof Error, label);
  assert.equal(error.code, 'CHECK_INPUT_INVALID', label);
  assert.equal(error.message, MESSAGE, label);
};
const refuses = (input, label) => refusal(() => checkEnvironment(input), label);

// Retyped on purpose: the test must not import the values back from the module or from guest-bootstrap.
const LITERAL = {
  identity: { user: 'moe-check', supplementaryGroups: [], noNewPrivileges: true, umask: '077' },
  network: { namespace: 'private', interfaces: ['lo'] },
  resources: {
    vm: { cpus: 2, memoryBytes: 4294967296, diskBytes: 21474836480 },
    rlimits: { RLIMIT_CORE: 0, RLIMIT_FSIZE: 1073741824, RLIMIT_NOFILE: 4096, RLIMIT_NPROC: 2048 },
  },
  process: { group: 'session', teardown: 'killed-and-reaped', vm: 'deleted-after-run' },
  filesystem: {
    vm: 'fresh-owned-per-run',
    home: { fresh: true, mode: '0700' },
    protectedPaths: { owner: 'root', verified: ['before-run', 'after-run'] },
    supervisorCredential: { path: '/etc/moe/supervisor.credential', owner: 'root', mode: '0400', jobIdentities: 'readiness-denied' },
  },
  time: { budget: 'host-enforced' },
};

test('E1 CHECK_BOUNDARIES is deeply frozen and pins the exact boundary content', () => {
  assert.deepStrictEqual(CHECK_BOUNDARIES, LITERAL);
  const nodes = nodesOf(CHECK_BOUNDARIES);
  assert.ok(nodes.length >= 12);
  for (const node of nodes) {
    assert.ok(Object.isFrozen(node));
    assert.throws(() => { node.added = 1; }, TypeError);
    for (const key of Object.keys(node)) assert.throws(() => { node[key] = 'changed'; }, TypeError);
    if (Array.isArray(node)) assert.throws(() => node.push('extra'), TypeError);
  }
  assert.throws(() => { CHECK_BOUNDARIES.identity.umask = '000'; }, TypeError);
});

test('E2 checkEnvironment is the sha256 of the sorted-key canonical encoding of boundaries and inputs', () => {
  const identity = checkEnvironment(VALID);
  assert.equal(identity, oracle(CHECK_BOUNDARIES, VALID));
  assert.match(identity, /^moe-local-vm-v1:[0-9a-f]{64}$/);
  assert.equal(identity.length, 80);
  assert.equal(checkEnvironment(VALID), identity);
  assert.equal(checkEnvironment(fresh()), identity);
  assert.equal(checkEnvironment({ ...reversed(VALID), resources: reversed(VALID.resources) }), identity);
});

test('E3 any input change gives a different identity', () => {
  const base = checkEnvironment(VALID);
  const seen = new Set([base]);
  const note = (input, label) => {
    const identity = checkEnvironment(input);
    assert.notEqual(identity, base, label);
    seen.add(identity);
  };
  for (const key of HASHES) {
    const input = fresh();
    input[key] = `${input[key][0] === 'a' ? 'b' : 'a'}${input[key].slice(1)}`;
    note(input, key);
  }
  for (const key of RESOURCES) {
    const input = fresh();
    input.resources[key] += 1;
    note(input, key);
  }
  note({ ...fresh(), sourceImageSha256: VALID.providerImageHash, providerImageHash: VALID.sourceImageSha256 }, 'swapped source/provider');
  note({ ...fresh(), providerImageHash: VALID.supervisorSha256, supervisorSha256: VALID.providerImageHash }, 'swapped provider/supervisor');
  assert.equal(seen.size, 1 + HASHES.length + RESOURCES.length + 2);
});

// Every leaf, array and object of a clone of the boundaries, changed one at a time.
const boundaryMutants = () => {
  const paths = (value, prefix = []) => [prefix, ...(value !== null && typeof value === 'object'
    ? Object.keys(value).flatMap(key => paths(value[key], [...prefix, key])) : [])];
  const at = (root, path) => path.reduce((node, key) => node[key], root);
  const out = [];
  for (const path of paths(CHECK_BOUNDARIES)) {
    const node = at(CHECK_BOUNDARIES, path);
    const mutate = (label, change) => {
      const clone = structuredClone(CHECK_BOUNDARIES);
      change(at(clone, path), at(clone, path.slice(0, -1)), path.at(-1));
      out.push([`${path.join('.')}: ${label}`, clone]);
    };
    if (node === null || typeof node !== 'object') {
      mutate('leaf', (_, parent, key) => { parent[key] = typeof node === 'string' ? `${node}x` : typeof node === 'number' ? node + 1 : !node; });
    } else if (Array.isArray(node)) {
      mutate('append', target => target.push('extra'));
      if (node.length > 0) mutate('drop last', target => target.pop());
    } else {
      mutate('add key', target => { target.extra = 1; });
      for (const key of Object.keys(node)) mutate(`delete ${key}`, target => { delete target[key]; });
    }
  }
  return out;
};

test('E4 every CHECK_BOUNDARIES leaf, array and object is part of the identity', () => {
  const base = checkEnvironment(VALID);
  const mutants = boundaryMutants();
  assert.ok(mutants.length >= 60, `walked ${mutants.length} mutants`);
  const seen = new Set();
  for (const [label, mutant] of mutants) {
    assert.notDeepStrictEqual(mutant, CHECK_BOUNDARIES, label);
    const identity = oracle(mutant, VALID);
    assert.notEqual(identity, base, label);
    seen.add(identity);
  }
  assert.equal(seen.size, mutants.length);
});

test('E5 invalid or extra-key input refuses with CHECK_INPUT_INVALID and fixed text', () => {
  refusal(() => checkEnvironment(), 'no argument');
  for (const input of [null, undefined, 'x', 42, [], Object.assign([], VALID)]) refuses(input, `input ${String(input)}`);
  for (const key of [...HASHES, 'resources']) {
    const missing = fresh();
    delete missing[key];
    refuses(missing, `missing ${key}`);
    const hidden = fresh();
    Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false, writable: true, configurable: true });
    refuses(hidden, `non-enumerable ${key}`);
    hidden.extra = 1;
    refuses(hidden, `non-enumerable ${key} plus assigned extra`);
  }
  refuses({ ...fresh(), extra: 1 }, 'extra key');
  refuses({ ...fresh(), constructor: 1 }, 'extra constructor key');
  for (const key of HASHES) {
    const valid = VALID[key];
    const bad = [valid.toUpperCase(), valid.slice(1), `${valid}0`, `${valid.slice(1)}g`, `${valid}\n`, '', undefined, null, 42, new String(valid)];
    for (const value of bad) refuses({ ...fresh(), [key]: value }, `${key}=${String(value)}`);
  }
  for (const value of [null, undefined, [], Object.assign([], VALID.resources), 'x', 42]) refuses({ ...fresh(), resources: value }, 'resources');
  for (const key of RESOURCES) {
    const missing = fresh();
    delete missing.resources[key];
    refuses(missing, `resources missing ${key}`);
    const hidden = fresh();
    Object.defineProperty(hidden.resources, key, { value: hidden.resources[key], enumerable: false, writable: true, configurable: true });
    hidden.resources.extra = 1;
    refuses(hidden, `resources non-enumerable ${key} plus assigned extra`);
    for (const value of [0, -1, 1.5, NaN, Infinity, '2', 2n, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      const input = fresh();
      input.resources[key] = value;
      refuses(input, `resources.${key}=${String(value)}`);
    }
  }
  refuses({ ...fresh(), resources: { ...fresh().resources, extra: 1 } }, 'resources extra key');
});

test('E5 the hashed value is the validated value: each field is read exactly once', () => {
  const reads = {};
  const spy = (target, key, first, later) => Object.defineProperty(target, key, {
    enumerable: true,
    get: () => { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? first : later; },
  });
  const input = {};
  spy(input, 'sourceImageSha256', VALID.sourceImageSha256, 'z');
  spy(input, 'providerImageHash', VALID.providerImageHash, VALID.supervisorSha256);
  spy(input, 'supervisorSha256', VALID.supervisorSha256, 'not hex');
  const resources = {};
  spy(resources, 'cpus', VALID.resources.cpus, -1);
  spy(resources, 'memoryBytes', VALID.resources.memoryBytes, 0);
  spy(resources, 'diskBytes', VALID.resources.diskBytes, 1.5);
  spy(input, 'resources', resources, null);
  assert.equal(checkEnvironment(input), checkEnvironment(VALID));
  assert.deepEqual(reads, { sourceImageSha256: 1, providerImageHash: 1, supervisorSha256: 1, resources: 1, cpus: 1, memoryBytes: 1, diskBytes: 1 });
});

const OBSERVED = deepFreeze({ environment: checkEnvironment(VALID), treeSha: 'ab12'.repeat(10), definitionDigest: 'cd34'.repeat(16), planRevision: 3 });
const STRINGS = ['environment', 'treeSha', 'definitionDigest'];
const FIELDS = [...STRINGS, 'planRevision'];
const copy = (patch = {}) => ({ ...OBSERVED, ...patch });
const without = key => { const out = copy(); delete out[key]; return out; };
const [FRESH, STALE] = ['fresh', 'stale'];

test('E6 evidenceStatus is fresh only for an exact match of environment, treeSha, definitionDigest and planRevision', () => {
  assert.equal(evidenceStatus(copy(), copy()), FRESH);
  assert.equal(evidenceStatus(OBSERVED, OBSERVED), FRESH);
  assert.equal(evidenceStatus(copy({ outcome: 'passed', exitCode: 0 }), copy({ unrelated: [1] })), FRESH);
  assert.equal(evidenceStatus(copy({ planRevision: 1 }), copy({ planRevision: 1 })), FRESH);
  assert.equal(evidenceStatus(copy({ planRevision: Number.MAX_SAFE_INTEGER }), copy({ planRevision: Number.MAX_SAFE_INTEGER })), FRESH);
});

test('E7 evidenceStatus is stale for any change, missing, blank, malformed or inherited field', () => {
  const stale = (observation, current, label) => assert.equal(evidenceStatus(observation, current), STALE, label);
  for (const key of FIELDS) {
    const changed = key === 'planRevision' ? OBSERVED.planRevision + 1 : `${OBSERVED[key].slice(0, -1)}x`;
    stale(copy({ [key]: changed }), copy(), `${key} changed on the observation`);
    stale(copy(), copy({ [key]: changed }), `${key} changed on current`);
    stale(without(key), copy(), `${key} missing on the observation`);
    stale(copy(), without(key), `${key} missing on current`);
    stale(without(key), without(key), `${key} missing on both`);
    stale(copy({ [key]: undefined }), copy({ [key]: undefined }), `${key} undefined on both`);
  }
  for (const key of STRINGS) for (const value of ['', null, 7]) stale(copy({ [key]: value }), copy({ [key]: value }), `${key}=${String(value)} on both`);
  for (const value of [0, -1, 1.5, NaN, Infinity, '1', null, 7n, Number.MAX_SAFE_INTEGER + 1]) {
    stale(copy({ planRevision: value }), copy({ planRevision: value }), `planRevision=${String(value)} on both`);
  }
  stale(copy({ planRevision: 1 }), copy({ planRevision: '1' }), 'planRevision 1 vs "1"');
  stale(copy({ planRevision: '1' }), copy({ planRevision: 1 }), 'planRevision "1" vs 1');
  stale(copy({ treeSha: 'ABCD' }), copy({ treeSha: 'abcd' }), 'treeSha differs only in case');
  stale(copy({ treeSha: ' abcd' }), copy({ treeSha: 'abcd' }), 'treeSha differs only in leading space');
  stale(Object.create(OBSERVED), copy(), 'every field inherited on the observation');
  stale(copy(), Object.create(OBSERVED), 'every field inherited on current');
  stale(Object.create(OBSERVED), Object.create(OBSERVED), 'every field inherited on both');
  for (const key of FIELDS) stale(Object.assign(Object.create({ [key]: OBSERVED[key] }), without(key)), copy(), `${key} inherited alone`);
  for (const bad of [null, undefined, 'x', 42, true, []]) {
    stale(bad, copy(), `observation ${String(bad)}`);
    stale(copy(), bad, `current ${String(bad)}`);
    stale(bad, bad, `both ${String(bad)}`);
  }
  assert.equal(evidenceStatus(), STALE);
});

test('E7 evidenceStatus never throws and reads each field at most once per record', () => {
  const throwing = { ...OBSERVED };
  Object.defineProperty(throwing, 'treeSha', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(evidenceStatus(throwing, copy()), STALE);
  assert.equal(evidenceStatus(copy(), throwing), STALE);
  const reads = {};
  const spy = {};
  for (const key of FIELDS) {
    Object.defineProperty(spy, key, { enumerable: true, get: () => { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? OBSERVED[key] : 'changed'; } });
  }
  assert.equal(evidenceStatus(spy, copy()), FRESH);
  assert.deepEqual(reads, { environment: 1, treeSha: 1, definitionDigest: 1, planRevision: 1 });
});

test('E8 the CI local-runner step runs this file', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const line = ci.split('\n').find(text => text.trimStart().startsWith('run: node --test scripts/tests/local-runner.test.mjs'));
  assert.ok(line, 'the local-runner CI step exists');
  assert.match(line, /\sscripts\/tests\/local-runner-check\.test\.mjs(?:\s|$)/);
});

test('E5 a throwing accessor or Proxy trap refuses with the fixed refusal and carries no input text', () => {
  const secret = 'secret-from-the-hostile-input';
  const boom = () => { throw new Error(secret); };
  for (const key of [...HASHES, 'resources']) {
    const input = fresh();
    Object.defineProperty(input, key, { enumerable: true, get: boom });
    refuses(input, `throwing ${key}`);
  }
  for (const key of RESOURCES) {
    const input = fresh();
    Object.defineProperty(input.resources, key, { enumerable: true, get: boom });
    refuses(input, `throwing resources.${key}`);
  }
  refuses(new Proxy(fresh(), { ownKeys: boom }), 'throwing ownKeys trap');
  refuses(new Proxy(fresh(), { get: boom }), 'throwing get trap');
  assert.doesNotMatch(caught(() => checkEnvironment(new Proxy(fresh(), { get: boom }))).message, new RegExp(secret));
});

// CQ-R11a: the guest supervisor's check mode. The real guest-supervisor.py runs under the host's python3 -I -B, loaded
// with importlib as R09c's PY_LOAD does (-B: a __pycache__ in scripts/local-runner would ship in both IDE bundles).
const NO_GUEST = process.platform === 'win32' && 'the guest supervisor runs only in the Linux guest (POSIX python3)';
const SUPERVISOR = fileURLToPath(new URL('../local-runner/guest-supervisor.py', import.meta.url));
const PY_LOAD = `import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location('moe_supervisor', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
// A fresh dir holds ws, a regular file and a link to ws; sessions does not exist yet.
const CHECK_DIRS = `os.umask(0o022)  # sudo's, under which the guest supervisor runs
base = sys.argv[2]
workspace, sessions = os.path.join(base, sys.argv[3]), os.path.join(base, 'sessions')
os.makedirs(os.path.join(base, 'ws'))
open(os.path.join(base, 'file'), 'w').close()
os.symlink(os.path.join(base, 'ws'), os.path.join(base, 'link'))
`;
// m.pwd answers every name with the test user. The recorders stand in for relay() and wrap os.chown; they write only to
// stderr, so stdout is the supervisor's own.
const CHECK_RECORD = `asked = []
m.pwd = types.SimpleNamespace(getpwnam=lambda name: asked.append(name) or types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
def record(argv, out_fd=1, in_fd=0, agent_socket=None, agent_uid=None, peer_uid=None, *, job):
    call = {'argv': argv, 'out_fd': out_fd, 'in_fd': in_fd, 'agent_socket': agent_socket, 'agent_uid': agent_uid, 'job': job}
    print('RELAY ' + json.dumps(call), file=sys.stderr)
    return 42
m.relay = record
os.chown = lambda path, uid, gid, chown=os.chown: print('CHOWN ' + json.dumps([path, uid, gid]), file=sys.stderr) or chown(path, uid, gid)
`;
const GONE = 'def gone(name):\n    raise KeyError(name)\nm.pwd = types.SimpleNamespace(getpwnam=gone)\n';
const CHECK = Object.freeze({ kind: 'check', version: 1, id: 'unit-1', command: 'true', protected: [] });
const checkFrame = value => encodeFrame(value, MAX_HOST_FRAME_BYTES);
const header = length => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(length); return bytes; };
const framed = body => Buffer.concat([header(Buffer.byteLength(body)), Buffer.from(body)]);
const TAGGED = /^(RELAY|ASKED|CHOWN|OWNED) /;

function checkRun(input, { workspace = 'ws', setup = '', seams = '', call = "['check'], geteuid=lambda: 0" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moe-r11a-'));
  const code = `${PY_LOAD}${CHECK_DIRS}${CHECK_RECORD}${setup}
code = m.main(${call}, workspace=workspace, sessions=sessions${seams})
print('ASKED ' + json.dumps(asked), file=sys.stderr)
sys.exit(code)
`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, SUPERVISOR, dir, workspace], { input, maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
  const lines = String(run.stderr).split('\n').filter(Boolean);
  const tagged = tag => lines.filter(line => line.startsWith(`${tag} `)).map(line => JSON.parse(line.slice(tag.length + 1)));
  const sessions = join(dir, 'sessions');
  return Object.assign(run, { dir, sessions, homes: existsSync(sessions) ? readdirSync(sessions) : [], relays: tagged('RELAY'),
    asked: tagged('ASKED')[0], chowns: tagged('CHOWN'), owned: tagged('OWNED'), stray: lines.filter(line => !TAGGED.test(line)) });
}

test('K1 a malformed, disallowed or cut check frame, or no account, workspace or home, fails before hello with no frame, job or home',
  { skip: NO_GUEST, timeout: 120_000 }, t => {
    const patched = patch => checkFrame({ ...CHECK, ...patch });
    const job = { kind: 'job', version: 1, cli: 'claude', role: 'worker', credential: { name: 'ANTHROPIC_API_KEY', value: 'sk-R11a' } };
    const malformed = [header(0), header(MAX_HOST_FRAME_BYTES + 1), framed('{'), framed('['.repeat(100_000) + ']'.repeat(100_000)),
      framed(Buffer.concat([Buffer.from('{"kind":"'), Buffer.from([0xff]), Buffer.from('"}')])), checkFrame(job),
      framed(JSON.stringify(CHECK).replace('"version":1', '"version":1.0')),
      ...[{ extra: 1 }, { protected: undefined }, { kind: 'checks' }, ...[2, true, '1'].map(version => ({ version })),
        ...['', '-a', 'a b', '\u00e9', 'a\n', 7, 'a'.repeat(65)].map(id => ({ id })),
        ...['', '   ', '\ufeff', 7, null, 'x'.repeat(1001), '\u{1F600}'.repeat(501), 'a\ud800b',
          ...['\x00', '\n', '\x1f', '\x7f', '\x9f', '\u2028', '\u2029'].map(control => `a${control}b`)].map(command => ({ command })),
        ...[null, {}, 'x', [{ path: 'a.txt', oid: '0'.repeat(40) }]].map(value => ({ protected: value }))].map(patched)];
    const cases = [...malformed.map(input => [65, input, {}]),
      [74, Buffer.alloc(0), {}], [74, header(9).subarray(0, 2), {}], [74, checkFrame(CHECK).subarray(0, 20), {}], [74, Buffer.alloc(0), { workspace: 'absent' }],
      [71, checkFrame(CHECK), { setup: GONE }], [71, checkFrame(CHECK), { setup: GONE, workspace: 'absent' }],
      ...['absent', 'file', 'link'].map(workspace => [66, checkFrame(CHECK), { workspace }]),
      ...['0o730', '0o703'].map(mode => [71, checkFrame(CHECK), { setup: `os.mkdir(sessions)\nos.chmod(sessions, ${mode})\n` }]),
      [77, checkFrame(CHECK), { call: "['check'], geteuid=lambda: 1000" }]];
    for (const [status, input, options] of cases) {
      const run = checkRun(input, options);
      t.after(() => rmSync(run.dir, { recursive: true, force: true }));
      // The frame comes first and the account next: a refusal before the account lookup asks for no name.
      const asked = [66, 71].includes(status) && options.setup !== GONE ? ['moe-check'] : [];
      assert.deepEqual([run.status, run.stdout.length, run.relays, run.homes, run.asked, run.stray], [status, 0, [], [], asked, []],
        `${status} ${input.subarray(0, 80)} ${JSON.stringify(options)} ${run.stderr}`);
    }
    for (const args of [['check', 'x'], ['CHECK'], ...(process.getuid() === 0 ? [] : [['check']])]) {
      const run = spawnSync('python3', ['-I', '-B', SUPERVISOR, ...args], { input: checkFrame(CHECK), timeout: 30_000, killSignal: 'SIGKILL' });
      assert.deepEqual([run.status, run.stdout.length], [args.length === 1 && args[0] === 'check' ? 77 : 64, 0], `${args} ${run.stderr}`);
    }
    for (const patch of [{ id: 'a'.padEnd(64, '9._-Z') }, { command: 'x'.repeat(1000) }, { command: '\u{1F600}'.repeat(500) }, { command: 'a\xa0b' }]) {
      const run = checkRun(patched(patch));
      t.after(() => rmSync(run.dir, { recursive: true, force: true }));
      assert.deepEqual([run.status, run.stdout.length, run.stray, run.relays.length], [42, 0, [], 1], `${JSON.stringify(patch)} ${run.stderr}`);
      const [{ argv, job: { env } }] = run.relays;
      assert.deepEqual([argv[2], env.MOE_CHECK_ID], [patch.command ?? CHECK.command, patch.id ?? CHECK.id]);
    }
  });

test('K2 main() routes a root check to relay as sh -c command under the CHECK_BOUNDARIES identity, rlimits and private network, with no agent socket',
  { skip: NO_GUEST, timeout: 30_000 }, t => {
    const command = 'npm test -- --grep "a b" && echo $HOME';
    const run = checkRun(checkFrame({ ...CHECK, command }));
    t.after(() => rmSync(run.dir, { recursive: true, force: true }));
    assert.deepEqual([run.status, run.stdout.length, run.stray, run.relays.length], [42, 0, [], 1], String(run.stderr));
    const [{ job, ...call }] = run.relays;
    assert.deepEqual(call, { argv: ['/bin/sh', '-c', command], out_fd: 1, in_fd: 0, agent_socket: null, agent_uid: null });
    // Drift: every enforced boundary is read from CHECK_BOUNDARIES, never retyped; R11d's E1 pins its literal values.
    const { identity, network, resources } = CHECK_BOUNDARIES;
    const [uid, gid, home] = [process.getuid(), process.getgid(), job.env.HOME];
    assert.deepEqual(job, {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, USER: identity.user, LOGNAME: identity.user, LANG: 'C.UTF-8', MOE_CHECK_ID: CHECK.id },
      spawn: { user: uid, group: gid, extra_groups: identity.supplementaryGroups, umask: parseInt(identity.umask, 8), cwd: join(run.dir, 'ws'),
        rlimits: resources.rlimits, netns: network.namespace === 'private' },
    });
    assert.deepEqual(run.asked, [identity.user]);
    assert.deepEqual([dirname(home), run.homes, run.chowns], [run.sessions, [basename(home)], [[home, uid, gid]]]);
    const info = statSync(home);
    assert.deepEqual([info.isDirectory(), info.mode & 0o7777, info.uid], [true, 0o700, uid]);
  });

// The recorder wraps os.fchown: one OWNED line per call, the fd's [st_dev, st_ino] as strings (an inode number can pass
// 2 ** 53) and the uid and gid. Call number `fail` raises PermissionError instead; 0 fails none.
const OWN_RECORDER = fail => `calls = []
def fchown(fd, uid, gid, real=os.fchown):
    calls.append(fd)
    if len(calls) == ${fail}:
        raise PermissionError('denied')
    info = os.fstat(fd)
    print('OWNED ' + json.dumps([str(info.st_dev), str(info.st_ino), uid, gid]), file=sys.stderr)
    real(fd, uid, gid)
os.fchown = fchown
`;
const TREE = `for name in ('a.txt', 'bin/run', 'src/lib/deep.c'):
    os.makedirs(os.path.dirname(os.path.join(workspace, name)), exist_ok=True)
    open(os.path.join(workspace, name), 'w').close()
os.chmod(os.path.join(workspace, 'bin', 'run'), 0o755)
os.mkdir(os.path.join(workspace, 'empty'))
os.makedirs(os.path.join(base, 'outdir'))
open(os.path.join(base, 'outdir', 'secret'), 'w').close()
`;
// A file whose workspace-relative path is exactly MAX_PATH_BYTES + extra bytes: 200-byte directories, then the rest.
const DEEP = extra => `parts, left = [], m.MAX_PATH_BYTES + ${extra}
while left > 255:
    parts.append('d' * 200)
    left -= 201
os.makedirs(os.path.join(workspace, *parts))
open(os.path.join(workspace, *parts, 'f' * left), 'w').close()
`;
const inode = path => { const info = lstatSync(path, { bigint: true }); return `${info.dev} ${info.ino}`; };

test('K4 the workspace is re-owned through directory fds, each entry once, and a planted link, FIFO or over-long path is refused unfollowed',
  { skip: NO_GUEST, timeout: 60_000 }, t => {
    const ran = (setup, fail = 0) => {
      const run = checkRun(checkFrame(CHECK), { setup: `${TREE}${setup}${OWN_RECORDER(fail)}`, seams: ', identity=(os.getuid(), os.getgid(), None)' });
      t.after(() => rmSync(run.dir, { recursive: true, force: true }));
      return Object.assign(run, { inodes: run.owned.map(([dev, ino]) => `${dev} ${ino}`) });
    };
    const refused = (run, status, label) => assert.deepEqual([run.status, run.stdout.length, run.relays, run.homes, run.stray],
      [status, 0, [], [], []], `${label} ${run.stderr}`);
    const run = ran('');
    assert.deepEqual([run.status, run.stdout.length, run.stray, run.relays.length], [42, 0, [], 1], String(run.stderr));
    const entries = ['', 'a.txt', 'bin', 'bin/run', 'src', 'src/lib', 'src/lib/deep.c', 'empty'].map(name => inode(join(run.dir, 'ws', name)));
    assert.deepEqual([...run.inodes].sort(), [...entries].sort());
    assert.deepEqual(run.owned.map(([, , ...ids]) => ids), entries.map(() => [process.getuid(), process.getgid()]));
    assert.ok(String(run.stderr).lastIndexOf('OWNED ') < String(run.stderr).indexOf('RELAY '), 'every entry is re-owned before relay()');
    const planted = ["os.symlink(os.path.join(base, 'file'), os.path.join(workspace, 'src', 'link'))\n",
      "os.symlink(os.path.join(base, 'outdir'), os.path.join(workspace, 'dlink'))\n",
      "os.link(os.path.join(base, 'file'), os.path.join(workspace, 'bin', 'hard'))\n", "os.mkfifo(os.path.join(workspace, 'fifo'))\n"];
    for (const setup of planted) {
      const plant = ran(setup);
      refused(plant, 65, setup);
      const outside = ['file', 'outdir', 'outdir/secret'].map(name => inode(join(plant.dir, name)));
      assert.deepEqual(plant.inodes.filter(id => outside.includes(id)), [], setup);
    }
    // An entry swapped between its lstat and its open: the opened inode is not the one lstat saw.
    refused(ran(`open(os.path.join(workspace, 'swap.txt'), 'w').close()
def swapping(path, flags, mode=0o777, *, dir_fd=None, real=os.open):
    if path == 'a.txt' and dir_fd is not None:
        os.replace('swap.txt', 'a.txt', src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    return real(path, flags, mode, dir_fd=dir_fd)
os.open = swapping
`), 65, 'a swapped entry');
    if (process.platform !== 'darwin') { // macOS caps a whole path at 1024 bytes (PATH_MAX), so tmpdir cannot hold one this deep
      const exact = ran(DEEP(0));
      assert.deepEqual([exact.status, exact.relays.length, exact.stray], [42, 1, []], String(exact.stderr));
      refused(ran(DEEP(1)), 65, 'one byte over MAX_PATH_BYTES');
    }
    refused(ran('', 2), 71, 'a failing fchown');
  });

// The probe reports on the job. dash forks the last command of sh -c and exports PWD to it, so the job is the probe's
// parent: its /proc environ is the environment it was started with.
const PROBE = `import json, os
job = os.getppid()
def read(name):
    return open('/proc/%d/%s' % (job, name), 'rb').read().decode()
print(json.dumps({'cmdline': read('cmdline').split('\\0')[:-1], 'cwd': os.readlink('/proc/%d/cwd' % job),
                  'env': dict(entry.split('=', 1) for entry in read('environ').split('\\0') if entry),
                  'status': [line for line in read('status').splitlines() if line.startswith(('Umask:', 'NoNewPrivs:'))],
                  'limits': read('limits').splitlines()}))
`;
// The harness is the supervisor: it moves stdin into a pipe whose write end it keeps, so relay() sees no host EOF. A
// non-root runner cannot setgroups or unshare, so it passes groups None and netns False; K2 pins the production values.
const HELD = `data = b''.join(iter(lambda: os.read(0, 65536), b''))
r, w = os.pipe()
os.write(w, data)
os.dup2(r, 0)
with open(os.path.join(workspace, 'probe.py'), 'w') as f:
    f.write(sys.argv[4])
sys.exit(m.main(['check'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, identity=(os.getuid(), os.getgid(), None), netns=False))
`;
const LIMIT_ROWS = { RLIMIT_CORE: 'Max core file size', RLIMIT_FSIZE: 'Max file size', RLIMIT_NOFILE: 'Max open files', RLIMIT_NPROC: 'Max processes' };
// RLIMIT_NPROC counts every task of the job's real uid, here the test user's, against the job's own fork.
const userTasks = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).reduce((sum, pid) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return Number(/^Uid:\s+(\d+)/m.exec(status)[1]) === process.getuid() ? sum + Number(/^Threads:\s+(\d+)/m.exec(status)[1]) : sum;
  } catch { return sum; } // the task has exited
}, 0);

test('K3 a real check job is sh -c command with exactly the allowlisted environment, the workspace, umask 077, NoNewPrivs and CHECK_BOUNDARIES rlimits',
  { skip: NO_GUEST || (process.platform !== 'linux' && 'the job probes read /proc'), timeout: 30_000 }, t => {
    const { identity, resources: { rlimits } } = CHECK_BOUNDARIES;
    const tasks = userTasks();
    if (tasks >= 1792) return t.skip(`the test user already runs ${tasks} tasks, too near RLIMIT_NPROC ${rlimits.RLIMIT_NPROC}`);
    const dir = mkdtempSync(join(tmpdir(), 'moe-r11a-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const command = 'python3 -I probe.py';
    const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}${CHECK_DIRS}${HELD}`, SUPERVISOR, dir, 'ws', PROBE],
      { input: checkFrame({ ...CHECK, command }), maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, String(run.error ?? run.stderr));
    const decoder = createFrameDecoder();
    const frames = decoder.push(run.stdout).map(parseGuestFrame);
    decoder.end();
    assert.deepEqual([frames[0], frames.at(-1)], [{ kind: 'hello', protocol: 1 }, { kind: 'observation', type: 'exit', code: 0, signal: null }]);
    const outputs = frames.slice(1, -1);
    assert.deepEqual(outputs.filter(frame => frame.kind !== 'output'), []);
    const text = stream => Buffer.concat(outputs.filter(frame => frame.stream === stream).map(frame => frame.data)).toString();
    assert.equal(text('stderr'), '');
    const probe = JSON.parse(text('stdout'));
    const homes = readdirSync(join(dir, 'sessions'));
    assert.equal(homes.length, 1);
    assert.deepEqual(probe.cmdline, ['/bin/sh', '-c', command]);
    assert.deepEqual(probe.env, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(dir, 'sessions', homes[0]), USER: identity.user,
      LOGNAME: identity.user, LANG: 'C.UTF-8', MOE_CHECK_ID: CHECK.id });
    assert.deepEqual([probe.cwd, probe.status], [realpathSync(join(dir, 'ws')), [`Umask:\t0${identity.umask}`, 'NoNewPrivs:\t1']]);
    for (const [name, value] of Object.entries(rlimits)) {
      const row = probe.limits.find(line => line.startsWith(`${LIMIT_ROWS[name]} `));
      assert.deepEqual(row?.slice(LIMIT_ROWS[name].length).trim().split(/\s+/).slice(0, 2), [String(value), String(value)], `${name}: ${row}`);
    }
  });

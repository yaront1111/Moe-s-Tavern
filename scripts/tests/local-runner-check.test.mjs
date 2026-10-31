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
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { checkArgv, checkFrame as hostCheckFrame } from '../local-runner/guest-bridge.mjs';
import {
  DEPENDENCIES_CANDIDATE_INVALID, DEPENDENCIES_FAILED, MAX_BUDGET_MS, MAX_CHECK_TAIL_BYTES, PROTECTED_CHANGED, PROTECTED_MISMATCH, runCheckSession,
} from '../local-runner/check-session.mjs';
import { ownedInstanceName } from '../local-runner/lifecycle.mjs';
import {
  MAX_DEPENDENCY_BYTES, MAX_DEPENDENCY_PACKAGES, MAX_LOCKFILE_BYTES, MAX_LOCKFILES, MAX_PACKAGE_BYTES, OFFLINE_INSTALL_ARGS, admitLockfiles,
  buildDependencyCache, dependencyError,
} from '../local-runner/dependency-cache.mjs';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, validateImport } from '../local-runner/source-snapshot.mjs';

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
  toolchainSha256: '7a7a5b5b6c6c7d7d'.repeat(4),
  dependencyDigest: 'de11de22de33de44'.repeat(4),
});
const HASHES = ['sourceImageSha256', 'providerImageHash', 'supervisorSha256', 'toolchainSha256'];
const INPUT_HASHES = [...HASHES, 'dependencyDigest']; // dependencyDigest may also be null: no dependency phase
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
    toolchain: { owner: 'root', writable: false, identity: 'host-pinned-sha256' },
  },
  dependencies: {
    source: 'host-offline-cache', integrity: 'lockfile-sha512', scripts: 'ignored', network: 'none',
    failure: { candidate: 'code-failure', infrastructure: 'infra-failure' },
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
  assert.equal(checkEnvironment({ ...fresh(), dependencyDigest: null }), oracle(CHECK_BOUNDARIES, { ...VALID, dependencyDigest: null }));
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
  note({ ...fresh(), dependencyDigest: 'ef'.repeat(32) }, 'dependencyDigest alone');
  note({ ...fresh(), dependencyDigest: null }, 'no dependency phase');
  note({ ...fresh(), toolchainSha256: VALID.dependencyDigest, dependencyDigest: VALID.toolchainSha256 }, 'swapped toolchain/dependencies');
  assert.equal(seen.size, 1 + HASHES.length + RESOURCES.length + 5);
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

test('E10 the dependencies failure boundary splits candidate refusal from infrastructure failure, and the old descriptor is another identity', () => {
  assert.deepStrictEqual(CHECK_BOUNDARIES.dependencies.failure, { candidate: 'code-failure', infrastructure: 'infra-failure' });
  assert.deepStrictEqual(Object.keys(CHECK_BOUNDARIES.dependencies).sort(), ['failure', 'integrity', 'network', 'scripts', 'source']);
  const current = checkEnvironment(VALID);
  assert.equal(current, oracle(LITERAL, VALID));
  const withFailure = failure => { const clone = structuredClone(LITERAL); clone.dependencies.failure = failure; return clone; };
  // The pre-82 descriptor: every dependency failure was infrastructure. Fresh evidence must not carry over from it.
  for (const inputs of [VALID, { ...VALID, dependencyDigest: null }]) {
    assert.notEqual(oracle(withFailure('infra-failure'), inputs), checkEnvironment(inputs));
  }
  for (const failure of [{ candidate: 'infra-failure', infrastructure: 'infra-failure' }, { candidate: 'code-failure', infrastructure: 'code-failure' },
    { candidate: 'infra-failure', infrastructure: 'code-failure' }, { candidate: 'code-failure' }, { infrastructure: 'infra-failure' }]) {
    assert.notEqual(oracle(withFailure(failure), VALID), current, JSON.stringify(failure));
  }
  // Same inputs under the old descriptor are stale against the new identity, and the same descriptor stays fresh.
  const stale = { environment: oracle(withFailure('infra-failure'), VALID), treeSha: 't', definitionDigest: 'd', planRevision: 1 };
  assert.equal(evidenceStatus(stale, { ...stale, environment: current }), 'stale');
  assert.equal(evidenceStatus({ ...stale, environment: current }, { ...stale, environment: checkEnvironment(fresh()) }), 'fresh');
});

test('E5 invalid or extra-key input refuses with CHECK_INPUT_INVALID and fixed text', () => {
  refusal(() => checkEnvironment(), 'no argument');
  for (const input of [null, undefined, 'x', 42, [], Object.assign([], VALID)]) refuses(input, `input ${String(input)}`);
  for (const key of [...INPUT_HASHES, 'resources']) {
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
  for (const key of INPUT_HASHES) {
    const valid = VALID[key];
    const bad = [valid.toUpperCase(), valid.slice(1), `${valid}0`, `${valid.slice(1)}g`, `${valid}\n`, '', undefined, null, 42, new String(valid)];
    for (const value of bad.filter(value => key !== 'dependencyDigest' || value !== null)) refuses({ ...fresh(), [key]: value }, `${key}=${String(value)}`);
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
  spy(input, 'toolchainSha256', VALID.toolchainSha256, VALID.supervisorSha256);
  spy(input, 'dependencyDigest', VALID.dependencyDigest, null);
  const resources = {};
  spy(resources, 'cpus', VALID.resources.cpus, -1);
  spy(resources, 'memoryBytes', VALID.resources.memoryBytes, 0);
  spy(resources, 'diskBytes', VALID.resources.diskBytes, 1.5);
  spy(input, 'resources', resources, null);
  assert.equal(checkEnvironment(input), checkEnvironment(VALID));
  assert.deepEqual(reads, { sourceImageSha256: 1, providerImageHash: 1, supervisorSha256: 1, toolchainSha256: 1, dependencyDigest: 1, resources: 1, cpus: 1,
    memoryBytes: 1, diskBytes: 1 });
});

const OBSERVED = deepFreeze({ environment: oracle(CHECK_BOUNDARIES, VALID), treeSha: 'ab12'.repeat(10), definitionDigest: 'cd34'.repeat(16), planRevision: 3 });
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

test('E9 evidence observed under another toolchain or dependency set is stale, and identical inputs stay fresh', () => {
  const observed = inputs => copy({ environment: checkEnvironment(inputs) });
  for (const [label, changes] of [['toolchain', { toolchainSha256: 'ab'.repeat(32) }], ['dependency digest', { dependencyDigest: 'cd'.repeat(32) }],
    ['no dependency phase', { dependencyDigest: null }]]) {
    const other = { ...fresh(), ...changes };
    assert.deepEqual([evidenceStatus(observed(VALID), observed(other)), evidenceStatus(observed(other), observed(VALID)),
      evidenceStatus(observed(other), observed({ ...fresh(), ...changes }))], [STALE, STALE, FRESH], label);
  }
  assert.equal(evidenceStatus(observed(VALID), observed(fresh())), FRESH);
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
  for (const key of [...INPUT_HASHES, 'resources']) {
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
        ...[null, {}, 'x'].map(value => ({ protected: value }))].map(patched)];
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
      env: { PATH: '/opt/moe/toolchain/bin:/usr/local/bin:/usr/bin:/bin', HOME: home, USER: identity.user, LOGNAME: identity.user, LANG: 'C.UTF-8', MOE_CHECK_ID: CHECK.id },
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
    assert.deepEqual(probe.env, { PATH: '/opt/moe/toolchain/bin:/usr/local/bin:/usr/bin:/bin', HOME: join(dir, 'sessions', homes[0]), USER: identity.user,
      LOGNAME: identity.user, LANG: 'C.UTF-8', MOE_CHECK_ID: CHECK.id });
    assert.deepEqual([probe.cwd, probe.status], [realpathSync(join(dir, 'ws')), [`Umask:\t0${identity.umask}`, 'NoNewPrivs:\t1']]);
    for (const [name, value] of Object.entries(rlimits)) {
      const row = probe.limits.find(line => line.startsWith(`${LIMIT_ROWS[name]} `));
      assert.deepEqual(row?.slice(LIMIT_ROWS[name].length).trim().split(/\s+/).slice(0, 2), [String(value), String(value)], `${name}: ${row}`);
    }
  });

// CQ-R11b: protected check definitions, the daemon's RequiredCheckSnapshot entries, sorted by UTF-8 bytes. blobOid is
// Git's blob id, recomputed here. MOUNTS stands in for protect_mounts; it and NOOP_OWN's fchmod recorder write tagged
// stderr lines, which protectedRun moves out of stray.
const blobOid = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const sorted = list => [...list].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
const entriesOf = spec => sorted(Object.entries(spec).map(([path, text]) => ({ path, oid: blobOid(text) })));
const PLANT = spec => `for name, text in ${JSON.stringify(Object.entries(spec))}:
    os.makedirs(os.path.dirname(os.path.join(workspace, name)), exist_ok=True)
    with open(os.path.join(workspace, name), 'w') as f:
        f.write(text)
`;
const MOUNTS = `def protect_mounts(workspace, paths):
    print('MOUNT ' + json.dumps([workspace, paths]), file=sys.stderr)
m.protect_mounts = protect_mounts
`;
function protectedRun(t, entries, setup = '', { stub = MOUNTS, ...options } = {}) {
  const run = checkRun(checkFrame({ ...CHECK, protected: entries }), { ...options, setup: `${stub}${setup}` });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  const lines = String(run.stderr).split('\n').filter(Boolean);
  const tagged = tag => lines.filter(line => line.startsWith(`${tag} `)).map(line => JSON.parse(line.slice(tag.length + 1)));
  return Object.assign(run, { mounts: tagged('MOUNT'), modes: tagged('MODE'), stray: run.stray.filter(line => !/^(MOUNT|MODE) /.test(line)) });
}

test('K5 a malformed protected list, entry, oid or path, or paths out of UTF-8 byte order, fail before hello with 65',
  { skip: NO_GUEST, timeout: 120_000 }, t => {
    const oid = blobOid('A');
    const entry = (patch = {}) => ({ path: 'a.txt', oid, ...patch });
    const many = count => Array.from({ length: count }, (_, i) => entry({ path: `p${String(i).padStart(4, '0')}` }));
    const lists = [{}, null, 'a.txt', many(2001), [entry({ mode: '100644' })], [{ path: 'a.txt' }], [{ oid }], ['a.txt'], [null],
      ...['ABCDEF0123'.repeat(4), '0'.repeat(39), '0'.repeat(41), 'g'.repeat(40), 7, null].map(value => [entry({ oid: value })]),
      ...['', '/a', 'a/', 'a//b', './a', '.', '..', 'a/../b', 'a\\b', 'a\x00b', 'a\nb', 'a\x9fb', 'a\u2028b', '\ufffd', ' ', ' a', 'a ',
        'a\ufeff', '\ud800', 'a\udc00b', 'a'.repeat(501), `a${'\u{1F600}'.repeat(250)}`, 7, null].map(path => [entry({ path })]),
      [entry({ path: 'b' }), entry({ path: 'a' })], [entry({ path: 'a' }), entry({ path: 'a' })], [entry({ path: 'a/b' }), entry({ path: 'a.b' })]];
    for (const list of lists) {
      const run = protectedRun(t, list);
      assert.deepEqual([run.status, run.stdout.length, run.relays, run.homes, run.asked, run.mounts, run.stray], [65, 0, [], [], [], [], []],
        `${JSON.stringify(list)?.slice(0, 120)} ${run.stderr}`);
    }
    // At its limits a list passes the shape check, and verification then refuses the absent files with 79.
    for (const list of [many(2000), [entry({ path: 'a'.repeat(500) })], [entry({ path: '\u{1F600}'.repeat(250) })], [entry({ path: 'a.b' }), entry({ path: 'a/b' })]]) {
      const run = protectedRun(t, list);
      assert.deepEqual([run.status, run.stdout.length, run.relays, run.mounts, run.stray], [79, 0, [], [], []], `${list.length} ${run.stderr}`);
    }
  });

// The recorder replaces os.fchown and os.fchmod: OWNED and MODE lines carry the fd's [st_dev, st_ino]. No real call is
// made, so the injected identity need not exist, and session_home is stubbed for the same reason.
const NOOP_OWN = `def fchown(fd, uid, gid):
    info = os.fstat(fd)
    print('OWNED ' + json.dumps([str(info.st_dev), str(info.st_ino), uid, gid]), file=sys.stderr)
def fchmod(fd, mode):
    info = os.fstat(fd)
    print('MODE ' + json.dumps([str(info.st_dev), str(info.st_ino), mode]), file=sys.stderr)
os.fchown, os.fchmod = fchown, fchmod
m.session_home = lambda sessions, uid, gid: '/unused-home'
`;
// The file being verified changes between its fstat and its read.
const RESIZE = change => `real_chunks = m.chunks
def resized(fd, size):
    ${change}
    return real_chunks(fd, size)
m.chunks = resized
`;

test('K6 a protected path that is missing, not a regular file, reached through a link or of another blob oid fails before hello with 79; matching files stay root-owned and read-only',
  { skip: NO_GUEST, timeout: 120_000 }, t => {
    assert.equal(blobOid(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'); // git hash-object /dev/null
    const spec = { 'a.txt': 'A\n', 'dir/b.txt': 'B\n', 'dir/empty': '', 'real/c.txt': 'C\n' };
    const good = entriesOf(spec);
    const plant = `${PLANT({ ...spec, 'other.txt': 'O\n' })}os.chmod(os.path.join(workspace, 'real', 'c.txt'), 0o755)\n`;
    const flipped = good.map((entry, i) => i < good.length - 1 ? entry : { ...entry, oid: entry.oid.slice(0, -1) + (entry.oid.endsWith('0') ? '1' : '0') });
    const ws = "os.path.join(workspace, 'a.txt')";
    const refusals = [[flipped, '', 'the last oid flipped'], [entriesOf({ ...spec, 'dir/c.txt': 'C\n' }), '', 'a missing file'],
      [sorted([...good, { path: 'real', oid: blobOid('') }]), '', 'a directory'],
      [sorted([...good, { path: 'link.txt', oid: blobOid('A\n') }]), "os.symlink('a.txt', os.path.join(workspace, 'link.txt'))\n", 'a symlink to a matching copy'],
      [sorted([...good, { path: 'via/c.txt', oid: blobOid('C\n') }]), "os.symlink('real', os.path.join(workspace, 'via'))\n", 'an ancestor symlink'],
      [sorted([...good, { path: 'fifo', oid: blobOid('') }]), "os.mkfifo(os.path.join(workspace, 'fifo'))\n", 'a FIFO'],
      [entriesOf({ 'a.txt': 'A\n' }), RESIZE(`open(${ws}, 'a').write('+')`), 'a file that grows'],
      [entriesOf({ 'a.txt': 'A\n' }), RESIZE(`os.truncate(${ws}, 1)`), 'a file that shrinks']];
    for (const [entries, setup, label] of refusals) {
      const run = protectedRun(t, entries, `${plant}${setup}`);
      assert.deepEqual([run.status, run.stdout.length, run.relays, run.homes, run.asked, run.mounts, run.stray],
        [79, 0, [], [], ['moe-check'], [], []], `${label} ${run.stderr}`);
      assert.equal(lstatSync(join(run.dir, 'ws', 'a.txt')).mode & 0o7777, 0o644, `${label}: verified before any re-own`);
    }
    const run = protectedRun(t, good, plant);
    assert.deepEqual([run.status, run.stdout.length, run.relays.length, run.stray], [42, 0, 1, []], String(run.stderr));
    const modes = Object.fromEntries(['a.txt', 'dir/b.txt', 'dir/empty', 'real/c.txt', 'other.txt']
      .map(name => [name, lstatSync(join(run.dir, 'ws', name)).mode & 0o7777]));
    assert.deepEqual(modes, { 'a.txt': 0o444, 'dir/b.txt': 0o444, 'dir/empty': 0o444, 'real/c.txt': 0o555, 'other.txt': 0o644 });
    // Recorded: each protected file is handed to this euid (root in the guest) once and made read-only; nothing else is.
    const recorded = protectedRun(t, good, `${plant}${NOOP_OWN}`, { seams: ', identity=(12345, 12346, None)' });
    assert.deepEqual([recorded.status, recorded.relays.length, recorded.stray], [42, 1, []], String(recorded.stderr));
    const names = ['', 'a.txt', 'dir', 'dir/b.txt', 'dir/empty', 'other.txt', 'real', 'real/c.txt'];
    const ids = Object.fromEntries(names.map(name => [inode(join(recorded.dir, 'ws', name)), name]));
    const isProtected = name => good.some(entry => entry.path === name);
    assert.deepEqual(recorded.owned.map(([dev, ino, ...owner]) => [ids[`${dev} ${ino}`], ...owner]).sort(),
      names.map(name => [name, ...isProtected(name) ? [process.geteuid(), process.getegid()] : [12345, 12346]]).sort());
    assert.deepEqual(recorded.modes.map(([dev, ino, mode]) => [ids[`${dev} ${ino}`], mode]).sort(),
      [['a.txt', 0o444], ['dir/b.txt', 0o444], ['dir/empty', 0o444], ['real/c.txt', 0o555]]);
  });

// The recorders stand in for os.unshare and the ctypes mount(); call number `fail` of either raises instead.
const NS_RECORDER = (failUnshare, failMount) => `ns_calls = {'unshare': 0, 'mount': 0}
def record_unshare(flags):
    ns_calls['unshare'] += 1
    print('MOUNT ' + json.dumps(['unshare', flags]), file=sys.stderr)
    if ns_calls['unshare'] == ${failUnshare}:
        raise PermissionError(1, 'unshare')
def record_mount(source, target, flags):
    ns_calls['mount'] += 1
    print('MOUNT ' + json.dumps(['mount', source and source.decode(), target.decode(), flags]), file=sys.stderr)
    if ns_calls['mount'] == ${failMount}:
        raise OSError(16, 'mount')
os.unshare, m.mount = record_unshare, record_mount
`;

test('K7 root check_job requests a private mount namespace, self binds of every ancestor, then read-only self binds of every protected file, and fails closed',
  { skip: NO_GUEST, timeout: 60_000 }, t => {
    const spec = { 'a/b/c.txt': 'C\n', 'a/d.txt': 'D\n', 'e.txt': 'E\n' };
    const ran = (setup, options) => protectedRun(t, entriesOf(spec), `${PLANT(spec)}${setup}`, { stub: '', ...options });
    const run = ran(NS_RECORDER(0, 0));
    assert.deepEqual([run.status, run.stdout.length, run.relays.length, run.stray], [42, 0, 1, []], String(run.stderr));
    const W = join(run.dir, 'ws');
    const file = name => [['mount', join(W, name), join(W, name), 4096], ['mount', null, join(W, name), 4096 | 32 | 1]];
    assert.deepEqual(run.mounts, [['unshare', 0x20000], ['mount', null, '/', 16384 | 262144],
      ['mount', join(W, 'a'), join(W, 'a'), 4096], ['mount', join(W, 'a/b'), join(W, 'a/b'), 4096],
      ...file('a/b/c.txt'), ...file('a/d.txt'), ...file('e.txt')]);
    assert.ok(String(run.stderr).lastIndexOf('MOUNT ') < String(run.stderr).indexOf('RELAY '), 'every mount is in place before relay()');
    // A refused unshare or mount ends the run before hello: no frame, no job, and no mount after the failure.
    for (const [setup, calls, label] of [[NS_RECORDER(1, 0), 1, 'a refused unshare'], [NS_RECORDER(0, 3), 4, 'a refused third mount']]) {
      const refused = ran(setup);
      assert.deepEqual([refused.status, refused.stdout.length, refused.relays, refused.mounts.length, refused.stray], [71, 0, [], calls, []],
        `${label} ${refused.stderr}`);
    }
    // The real calls as a non-root user, where unshare is EPERM (or, off Linux, unavailable).
    if (process.getuid() !== 0) {
      const real = ran('');
      assert.deepEqual([real.status, real.stdout.length, real.relays, real.stray], [71, 0, [], []], String(real.stderr));
    }
    // An empty protected list never enters a mount namespace.
    const empty = protectedRun(t, [], NS_RECORDER(0, 0), { stub: '' });
    assert.deepEqual([empty.status, empty.relays.length, empty.mounts, empty.stray], [42, 1, [], []], String(empty.stderr));
  });

test('K7 mount() raises the errno of a refused mount(2)', { skip: process.platform !== 'linux' && 'mount(2) through ctypes is Linux only', timeout: 30_000 }, () => {
  const code = `${PY_LOAD}import errno
try:
    m.mount(None, os.fsencode(os.path.join(sys.argv[2], 'absent')), m.MS_BIND)
except OSError as error:
    print(errno.errorcode[error.errno], error.strerror)
`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, SUPERVISOR, tmpdir()], { timeout: 30_000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(String(run.stdout), /^(EPERM|ENOENT) mount\n$/);
});

// K9 runs the real mounts. The job is root, so no permission check can explain a refusal: only the mounts can.
const MOUNT_PROBE = `import errno, json, os
def attempt(call):
    try:
        call()
        return 'ok'
    except OSError as error:
        return errno.errorcode[error.errno]
print(json.dumps([attempt(lambda: open('dir/p.txt', 'a').close()), attempt(lambda: os.chmod('dir/p.txt', 0o644)),
                  attempt(lambda: os.rename('dir/p.txt', 'dir/q.txt')), attempt(lambda: os.unlink('dir/p.txt')),
                  attempt(lambda: open('dir/new.txt', 'w').close()), attempt(lambda: os.rename('dir/new.txt', 'dir/p.txt')),
                  attempt(lambda: os.rename('dir', 'moved'))]))
`;
const ROOT_HELD = `data = b''.join(iter(lambda: os.read(0, 65536), b''))
r, w = os.pipe()
os.write(w, data)
os.dup2(r, 0)
os.makedirs(os.path.join(workspace, 'dir'))
with open(os.path.join(workspace, 'dir', 'p.txt'), 'w') as f:
    f.write('P\\n')
with open(os.path.join(workspace, 'probe.py'), 'w') as f:
    f.write(sys.argv[4])
sys.exit(m.main(['check'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, identity=(0, 0, None), netns=False))
`;

test('K9 under the real mounts a root check job cannot write, chmod, rename, replace or unlink a protected file, nor rename its directory',
  { skip: (process.platform !== 'linux' || process.getuid() !== 0) && 'needs root for a mount namespace; CQ-R13 certifies it on real guests', timeout: 30_000 }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'moe-r11b-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const command = 'python3 -I probe.py';
    const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}${CHECK_DIRS}${ROOT_HELD}`, SUPERVISOR, dir, 'ws', MOUNT_PROBE],
      { input: checkFrame({ ...CHECK, command, protected: [{ path: 'dir/p.txt', oid: blobOid('P\n') }] }), maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, String(run.error ?? run.stderr));
    const decoder = createFrameDecoder();
    const frames = decoder.push(run.stdout).map(parseGuestFrame);
    decoder.end();
    assert.deepEqual(frames.at(-1), { kind: 'observation', type: 'exit', code: 0, signal: null });
    const text = stream => Buffer.concat(frames.filter(frame => frame.kind === 'output' && frame.stream === stream).map(frame => frame.data)).toString();
    assert.equal(text('stderr'), '');
    assert.deepEqual(JSON.parse(text('stdout')), ['EROFS', 'EROFS', 'EBUSY', 'EBUSY', 'ok', 'EBUSY', 'EBUSY']);
    assert.deepEqual([readFileSync(join(dir, 'ws', 'dir', 'p.txt'), 'utf8'), existsSync(join(dir, 'ws', 'dir', 'new.txt'))], ['P\n', true]);
    // The namespace was private: none of its mounts reached this process's namespace.
    assert.ok(!readFileSync('/proc/self/mountinfo', 'utf8').includes(dir), 'a workspace mount propagated out');
  });

// A stand-in relay: it writes its observation sentinel first, then changes the workspace as a job could, and returns.
const FAKE_RELAY = (statements, code = 0) => `def fake_relay(argv, out_fd=1, in_fd=0, agent_socket=None, agent_uid=None, peer_uid=None, *, job):
    os.write(out_fd, b'OBS')
    W = lambda *names: os.path.join(workspace, *names)
    ${statements.join('\n    ')}
    return ${code}
m.relay = fake_relay
`;

test('K8 a protected path that changes during the job ends the supervisor with 80 after the observation; an unchanged one exits 0',
  { skip: NO_GUEST, timeout: 60_000 }, t => {
    const spec = { 'a.txt': 'A\n', 'dir/b.txt': 'B\n' };
    const rows = [[['pass'], 0, 'unchanged'],
      [["os.chmod(W('dir', 'b.txt'), 0o644)", "open(W('dir', 'b.txt'), 'w').write('X\\n')"], 80, 'the last file rewritten'],
      [["os.unlink(W('a.txt'))"], 80, 'deleted'],
      [["os.rename(W('a.txt'), W('copy.txt'))", "os.symlink('copy.txt', W('a.txt'))"], 80, 'a symlink to an identical copy'],
      [["os.unlink(W('a.txt'))", "os.mkdir(W('a.txt'))"], 80, 'a directory'],
      [["os.rename(W('dir'), W('moved'))", "os.symlink('moved', W('dir'))"], 80, 'an ancestor swapped for a symlinked identical tree'],
      [["os.rename(workspace, workspace + '.gone')"], 80, 'a workspace that cannot be re-read'],
      // Invisible afterwards, which is why the mounts are the boundary (K7, K9).
      [["os.rename(W('dir'), W('moved'))", "os.rename(W('moved'), W('dir'))"], 0, 'an ancestor renamed away and back']];
    for (const [statements, status, label] of rows) {
      const run = protectedRun(t, entriesOf(spec), `${PLANT(spec)}${FAKE_RELAY(statements)}`);
      t.after(() => rmSync(`${join(run.dir, 'ws')}.gone`, { recursive: true, force: true }));
      assert.deepEqual([run.status, String(run.stdout), run.mounts.length, run.stray], [status, 'OBS', 1, []], `${label} ${run.stderr}`);
    }
    // A failed relay keeps its own code, and an empty list is never re-checked.
    const failed = protectedRun(t, entriesOf(spec), `${PLANT(spec)}${FAKE_RELAY(["os.unlink(W('a.txt'))"], 74)}`);
    assert.deepEqual([failed.status, String(failed.stdout), failed.stray], [74, 'OBS', []], String(failed.stderr));
    const empty = protectedRun(t, [], `${PLANT(spec)}${FAKE_RELAY(["os.rename(workspace, workspace + '.gone')"])}`);
    t.after(() => rmSync(`${join(empty.dir, 'ws')}.gone`, { recursive: true, force: true }));
    assert.deepEqual([empty.status, String(empty.stdout), empty.mounts, empty.stray], [0, 'OBS', [], []], String(empty.stderr));
  });

test('K8 a real check job that removes its protected file is observed exiting 0, and the supervisor then exits 80',
  { skip: NO_GUEST || (process.platform !== 'linux' && 'the busy-host guard reads /proc'), timeout: 30_000 }, t => {
    const tasks = userTasks();
    if (tasks >= 1792) return t.skip(`the test user already runs ${tasks} tasks, too near RLIMIT_NPROC`);
    const dir = mkdtempSync(join(tmpdir(), 'moe-r11b-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const setup = `${PLANT({ 'a.txt': 'A\n' })}m.protect_mounts = lambda workspace, paths: None\n`;
    const run = spawnSync('python3', ['-I', '-B', '-c', `${PY_LOAD}${CHECK_DIRS}${setup}${HELD}`, SUPERVISOR, dir, 'ws', ''],
      { input: checkFrame({ ...CHECK, command: 'rm -f a.txt', protected: entriesOf({ 'a.txt': 'A\n' }) }), maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 80, String(run.error ?? run.stderr));
    const decoder = createFrameDecoder();
    const frames = decoder.push(run.stdout).map(parseGuestFrame);
    decoder.end();
    assert.deepEqual(frames, [{ kind: 'hello', protocol: 1 }, { kind: 'observation', type: 'exit', code: 0, signal: null }]);
    assert.equal(existsSync(join(dir, 'ws', 'a.txt')), false);
  });

// CQ-R11e5: the check mode's offline dependency install phase. The fake toolchain's node, a /bin/sh script, logs one line
// per install: pid, cwd, umask, open-file limit, NoNewPrivs, PATH, HOME and argv. It then hangs if its cwd holds `hang`,
// else exits with the status in `status` (default 0). The real GUARD runs it as the test user (groups None, netns False);
// relay() stays CHECK_RECORD's recorder, and `logged` hands it the installs logged by then.
const FAKE_NODE = `#!/bin/sh
echo "$$|$PWD|$(umask)|$(ulimit -n)|$(grep -c '^NoNewPrivs:.1' /proc/$$/status)|$PATH|$HOME|$*" >> BASE/install.log
[ -e hang ] && exec sleep 30
[ -e status ] && read s < status && exit $s
exit 0
`;
// Each planted directory holds a valid project whose lockfile root entry mirrors package.json's install metadata, as npm
// writes it. pyFiles renders name -> a JSON value, a Buffer, or a Python bytes expression (a string) for INSTALL's plant().
const PROJECT = Object.freeze({ name: 'fixture', version: '1.0.0', dependencies: Object.freeze({ dep: '1.0.0' }) });
const lockOf = (root, lockfileVersion = 3) => ({ lockfileVersion, packages: { '': root } });
const PROJECT_FILES = Object.freeze({ 'package.json': PROJECT, 'package-lock.json': lockOf(PROJECT) });
const bytesOf = value => Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
const pyBytes = value => `bytes.fromhex('${bytesOf(value).toString('hex')}')`;
const pyFiles = files => `{${Object.entries(files).map(([name, value]) => `${JSON.stringify(name)}: ${typeof value === 'string' ? value : pyBytes(value)}`).join(', ')}}`;
const INSTALL = (list, dirs, more, manifest) => `log, tc, deps = (os.path.join(base, name) for name in ('install.log', 'tc', 'deps'))
for sub in ('tc/bin', 'tc/lib/node_modules/npm/bin', 'deps'):
    os.makedirs(os.path.join(base, sub))
open(os.path.join(tc, 'lib/node_modules/npm/bin/npm-cli.js'), 'w').close()
with open(os.path.join(tc, 'bin/node'), 'w') as f:
    f.write(${JSON.stringify(FAKE_NODE)}.replace('BASE', base))
os.chmod(os.path.join(tc, 'bin/node'), 0o755)
def plant(path, files):
    os.makedirs(path, exist_ok=True)
    for name, data in files.items():
        os.makedirs(os.path.dirname(os.path.join(path, name)), exist_ok=True)
        with open(os.path.join(path, name), 'wb') as f:
            f.write(data)
for name in ${JSON.stringify(dirs)}:
    plant(os.path.join(workspace, name), ${pyFiles(PROJECT_FILES)})
${list === null ? '' : `with open(os.path.join(deps, 'moe-dependencies.json'), 'w') as f:\n    f.write(${JSON.stringify(list)})\n`}${manifest ? "open(os.path.join(base, 'deps.manifest'), 'w').close()\n" : ''}def logged(argv, *args, job, record=m.relay):
    job['logged'] = len(open(log).read().splitlines()) if os.path.exists(log) else 0
    return record(argv, *args, job=job)
m.relay = logged
${more}`;
const dirList = dirs => JSON.stringify({ version: 1, dirs });
const lockDirs = count => Array.from({ length: count }, (_, i) => `d${String(i).padStart(2, '0')}`);
function installRun(t, list, dirs, { more = '', timeout = 2, toolchain = 'tc', manifest = true, check = CHECK } = {}) {
  const seams = `, identity=(os.getuid(), os.getgid(), None), netns=False, toolchain=${toolchain}, dependencies=deps,
    dependencies_manifest=os.path.join(base, 'deps.manifest'), install_timeout=${timeout}`;
  const run = checkRun(checkFrame(check), { setup: INSTALL(list, dirs, more, manifest), seams });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  const log = join(run.dir, 'install.log');
  return Object.assign(run, { installs: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('|')) : [] });
}
// task-42e9990c: a refusal the candidate's own files cause exits 82 (DEPENDENCIES_CANDIDATE_INVALID), any other 81; both
// before hello, with no frame, relay or stray stderr.
const CANDIDATE = DEPENDENCIES_CANDIDATE_INVALID;
const refusedInstall = (run, label, code = DEPENDENCIES_FAILED) => assert.deepEqual([run.status, run.stdout.length, run.relays, run.stray], [code, 0, [], []], `${label} ${run.stderr}`);
const INSTALLS_RUN = NO_GUEST || (process.platform !== 'linux' && 'the fake toolchain reads /proc');
const busy = t => {
  const tasks = userTasks();
  if (tasks >= 1792) t.skip(`the test user already runs ${tasks} tasks, too near RLIMIT_NPROC`);
  return tasks >= 1792;
};

test('KI1 each listed directory installs in list order before relay(), under the check spawn, with the toolchain first on PATH',
  { skip: INSTALLS_RUN, timeout: 60_000 }, t => {
    if (busy(t)) return;
    const expected = (run, names) => {
      assert.deepEqual([run.status, run.stdout.length, run.stray, run.relays.length], [42, 0, [], 1], String(run.stderr));
      const [{ argv, job }] = run.relays;
      const [ws, tc] = [join(run.dir, 'ws'), join(run.dir, 'tc')];
      const path = `${join(tc, 'bin')}:/usr/local/bin:/usr/bin:/bin`;
      // OFFLINE_INSTALL_ARGS is dependency-cache.mjs's list, so this also pins the supervisor's mirror of it.
      const args = [join(tc, 'lib/node_modules/npm/bin/npm-cli.js'), 'ci', ...OFFLINE_INSTALL_ARGS, '--cache', join(run.dir, 'deps')].join(' ');
      assert.deepEqual(run.installs.map(([, ...fields]) => fields),
        names.map(name => [realpathSync(name === '.' ? ws : join(ws, name)), '0077', '4096', '1', path, job.env.HOME, args]));
      assert.deepEqual([argv, job.env.PATH, job.logged, job.spawn.cwd], [['/bin/sh', '-c', CHECK.command], path, names.length, ws]);
    };
    expected(installRun(t, dirList(['pkg', '.']), ['.', 'pkg']), ['pkg', '.']);
    // The bounds: 16 directories in a list of exactly 65536 bytes.
    const sixteen = lockDirs(16).reverse();
    expected(installRun(t, dirList(sixteen).padEnd(65536), sixteen), sixteen);
  });

test('KI2 an install that fails, cannot start or outlives install_timeout exits 81 before hello, with nothing installed after it',
  { skip: INSTALLS_RUN, timeout: 60_000 }, t => {
    if (busy(t)) return;
    const status = installRun(t, dirList(['.', 'pkg', 'zz']), ['.', 'pkg', 'zz'], { more: "open(os.path.join(workspace, 'pkg', 'status'), 'w').write('3\\n')\n" });
    refusedInstall(status, 'a non-zero status');
    assert.deepEqual(status.installs.map(fields => fields[1]), ['ws', 'ws/pkg'].map(name => realpathSync(join(status.dir, name))));
    for (const [label, options] of [['no toolchain', { toolchain: "os.path.join(base, 'absent')" }], ['a guard hung before it starts the job', { more: "m.GUARD = 'import time\\ntime.sleep(30)'\n", timeout: 1 }],
      ['a hung install', { more: "open(os.path.join(workspace, 'hang'), 'w').close()\n", timeout: 1 }]]) {
      const started = Date.now();
      const run = installRun(t, dirList(['.']), ['.'], options);
      refusedInstall(run, label);
      assert.ok(Date.now() - started < 6_000, label);
      assert.deepEqual(run.installs.length, label === 'a hung install' ? 1 : 0, label);
      for (const [pid] of run.installs) { // killed with its group: gone, or a zombie its new parent has yet to reap
        assert.ok(!existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z', label);
      }
    }
  });

// reown (K4) already refuses any link or FIFO in the workspace with 65; without it the install preflight's own walk still
// follows no link and reads no FIFO. OUTSIDE plants a valid project beside the workspace, for a link to reach.
const NO_REOWN = 'm.reown = lambda *args, **kwargs: None\n';
const OUTSIDE = `plant(os.path.join(base, 'out'), ${pyFiles(PROJECT_FILES)})\n`;

test('KI3 a malformed dependency list or a missing, non-regular or symlinked lockfile exits 81, and no package.json, a shrinkwrap or .npmrc 82, before any install or frame',
  { skip: NO_GUEST, timeout: 60_000 }, t => {
    const planted = ['.', ...lockDirs(17)];
    const lists = [null, 'nope', '[]', JSON.stringify({ version: 1, dirs: ['.'], extra: 1 }), '{"version":1.0,"dirs":["."]}',
      ...[2, true, '1'].map(version => JSON.stringify({ version, dirs: ['.'] })), JSON.stringify({ version: 1, dirs: '.' }),
      dirList([]), dirList(['.', '.']), dirList(lockDirs(17)), dirList(['.']).padEnd(65537),
      ...['', '/abs', 'a/../b', 'a//b', './d00', 'd00/', 'a\u0000b', '\ud800', 7, null].map(dir => dirList([dir]))];
    for (const list of lists) {
      const run = installRun(t, list, planted);
      refusedInstall(run, list?.slice(0, 80));
      assert.deepEqual(run.installs, [], list?.slice(0, 80));
    }
    const PKG = `plant(os.path.join(workspace, 'pkg'), ${pyFiles({ 'package.json': PROJECT })})\n`;
    for (const [label, dirs, locks, more, code] of [['a missing lockfile', ['.', 'pkg'], ['.'], PKG],
      ['a lockfile that is a directory', ['pkg'], [], `os.makedirs(os.path.join(workspace, 'pkg', 'package-lock.json'))\n${PKG}`],
      ['a symlinked lockfile', ['pkg'], [], `${NO_REOWN}${OUTSIDE}os.makedirs(os.path.join(workspace, 'pkg'))
os.symlink(os.path.join(base, 'out', 'package-lock.json'), os.path.join(workspace, 'pkg', 'package-lock.json'))\n${PKG}`],
      ['a directory reached through a symlink', ['pkg'], [], `${NO_REOWN}${OUTSIDE}os.symlink(os.path.join(base, 'out'), os.path.join(workspace, 'pkg'))\n`],
      // npm ci would install from these over the approved lockfile, or walk up from a directory with no package.json.
      // The protected lockfile is approved; these are the candidate's own files, so the refusal is the candidate's.
      ['no package.json', ['.', 'pkg'], ['.', 'pkg'], "os.unlink(os.path.join(workspace, 'pkg', 'package.json'))\n", CANDIDATE],
      ...['npm-shrinkwrap.json', '.npmrc'].map(file => [`a planted ${file}`, ['.', 'pkg'], ['.', 'pkg'], `open(os.path.join(workspace, 'pkg', '${file}'), 'w').close()\n`, CANDIDATE])]) {
      const run = installRun(t, dirList(dirs), locks, { more });
      refusedInstall(run, label, code);
      assert.deepEqual(run.installs, [], label);
    }
    const linked = installRun(t, dirList(['pkg']), [], { more: "os.symlink(os.path.join(base, 'file'), os.path.join(workspace, 'pkg'))\n" });
    assert.deepEqual([linked.status, linked.stdout.length, linked.relays, linked.installs], [65, 0, [], []], String(linked.stderr));
  });

test('KI4 with no dependency manifest the check reaches relay() as before, with no install, whatever the list holds',
  { skip: NO_GUEST, timeout: 30_000 }, t => {
    const run = installRun(t, 'nope', ['.'], { manifest: false });
    assert.deepEqual([run.status, run.stdout.length, run.stray, run.installs, run.relays.length], [42, 0, [], [], 1], String(run.stderr));
    const [{ argv, job: { env, logged } }] = run.relays;
    assert.deepEqual([argv, logged, env.PATH], [['/bin/sh', '-c', CHECK.command], 0, `${join(run.dir, 'tc', 'bin')}:/usr/local/bin:/usr/bin:/bin`]);
  });

// task-5ed445ca: npm ci builds the root's dependency edges from package.json, then checks the tree against the lockfile
// by version only, so a same-version file: spec or alias in an unprotected package.json installs bytes the lockfile
// does not name for that dependency. Install metadata must equal the approved lockfile's root entry. Each row plants a
// valid '.' first and the refused pkg second: the all-directories preflight then starts neither install, and pkg's
// planted bytes stay as they were.
const STUB_TGZ = 'file:../stub/dep-1.0.0.tgz'; // the locked dep's own name and version, from candidate bytes
const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const omit = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const pkgRun = (t, files, more = '') => installRun(t, dirList(['.', 'pkg']), ['.', 'pkg'],
  { more: `${more}plant(os.path.join(workspace, 'pkg'), ${pyFiles(files)})\n` });
function refusedPkg(t, label, files, more, code) {
  const run = pkgRun(t, files, more);
  refusedInstall(run, label, code);
  assert.deepEqual(run.installs, [], label);
  for (const [name, value] of Object.entries(files)) {
    if (typeof value !== 'string') assert.deepEqual(readFileSync(join(run.dir, 'ws', 'pkg', name)), bytesOf(value), label);
  }
}

test('KI5 install metadata that differs from the lockfile root, or overrides, bundled dependencies or workspaces, exit 82 before any install or frame; a malformed lockfile root 81',
  { skip: NO_GUEST, timeout: 120_000 }, t => {
    const peer = optional => ({ ...PROJECT, peerDependencies: { dep: '1.0.0' }, peerDependenciesMeta: { dep: optional } });
    // A row whose malformed value is on both sides fails on the approved lockfile root first, which is never the candidate's.
    for (const [label, manifest, root = PROJECT, code = CANDIDATE] of [
      ...DEPENDENCY_MAPS.flatMap(key => [STUB_TGZ, 'file:../stub'].map(spec => [`${spec} in ${key}`, { ...PROJECT, [key]: { ...PROJECT[key], dep: spec } }])),
      ['a changed range', { ...PROJECT, dependencies: { dep: '^1.0.0' } }],
      ['an npm alias', { ...PROJECT, dependencies: { dep: 'npm:dep@1.0.0' } }],
      ['an added dependency', { ...PROJECT, dependencies: { ...PROJECT.dependencies, extra: '1.0.0' } }],
      ['a removed dependency', omit(PROJECT, 'dependencies')],
      ['a dependency the lockfile root lacks', PROJECT, omit(PROJECT, 'dependencies')],
      ['a non-string spec on both sides', { ...PROJECT, dependencies: { dep: 1 } }, { ...PROJECT, dependencies: { dep: 1 } }, DEPENDENCIES_FAILED],
      ...[null, [], 'x'].map(value => [`a ${JSON.stringify(value)} map for an absent one`, { ...PROJECT, devDependencies: value }]),
      ['another name', { ...PROJECT, name: 'other' }],
      ['no name', omit(PROJECT, 'name')],
      ['a null name for an absent one', { ...PROJECT, name: null }, omit(PROJECT, 'name')],
      ['another version', { ...PROJECT, version: '1.0.1' }],
      ['no version', omit(PROJECT, 'version')],
      ['a numeric version on both sides', { ...PROJECT, version: 1 }, { ...PROJECT, version: 1 }, DEPENDENCIES_FAILED],
      ['peerDependenciesMeta the lockfile root lacks', peer({ optional: true }), omit(peer(), 'peerDependenciesMeta')],
      ['optional 1 for true', peer({ optional: 1 }), peer({ optional: true })],
      ['optional "true" for true', peer({ optional: 'true' }), peer({ optional: true })],
      ['a peerDependenciesMeta entry that is no object, on both sides', peer(true), peer(true), DEPENDENCIES_FAILED],
      ...[{ dep: STUB_TGZ }, { other: { dep: STUB_TGZ } }, { dep: '$dep' }, {}, null, 'x'].map(overrides => [`overrides ${JSON.stringify(overrides)}`, { ...PROJECT, overrides }]),
      ...['bundleDependencies', 'bundledDependencies'].flatMap(key => [['dep'], true, []].map(value => [`${key} ${JSON.stringify(value)}`, { ...PROJECT, [key]: value }])),
      ['workspaces', { ...PROJECT, workspaces: ['stub'] }],
      ['an array', [PROJECT]],
    ]) {
      refusedPkg(t, label, { 'package.json': manifest, 'package-lock.json': lockOf(root) }, '', code);
    }
  });

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const EMPTY_MAPS = Object.freeze({ devDependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} });
const META = Object.freeze({ name: 'fixture', version: '1.0.0', dependencies: { dep: '1.0.0', other: '^2.0.0' }, devDependencies: { tool: '~3.1.0' },
  optionalDependencies: { opt: '4.0.0' }, peerDependencies: { a: '>=1', b: '2.x' }, peerDependenciesMeta: { a: { optional: true }, b: { optional: false, note: [1, { x: null }] } } });
const deepReversed = value => value?.constructor === Object ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, deepReversed(entry)])) : value;

test('KI6 install metadata equal to the lockfile root still installs every directory, whatever else package.json changes',
  { skip: INSTALLS_RUN, timeout: 60_000 }, t => {
    if (busy(t)) return;
    const npmShaped = { ...PROJECT, description: 'd', license: 'MIT', engines: { node: '>=20' }, devDependencies: { tool: '3.1.0' } };
    for (const [label, files] of [
      ['script, description and private edits', { 'package.json': { ...PROJECT, scripts: { test: 'node t.js', postinstall: 'exit 1' }, description: 'd', private: true } }],
      ['a lockfileVersion 2 lockfile, with its legacy dependencies section', { 'package-lock.json': { ...lockOf(PROJECT, 2), dependencies: { dep: { version: '1.0.0' } } } }],
      ['a lockfile root with the other fields npm writes', { 'package.json': npmShaped, 'package-lock.json': { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { ...omit(npmShaped, 'description'), hasInstallScript: true }, 'node_modules/dep': { version: '1.0.0', license: 'MIT' } } } }],
      ['empty maps for absent ones', { 'package.json': { ...PROJECT, ...EMPTY_MAPS } }],
      ['absent maps for empty ones', { 'package-lock.json': lockOf({ ...PROJECT, ...EMPTY_MAPS }) }],
      ['every map, in another key order at every depth', { 'package.json': META, 'package-lock.json': lockOf(deepReversed(META)) }],
      ['no name or version on either side', { 'package.json': omit(PROJECT, 'name', 'version'), 'package-lock.json': lockOf(omit(PROJECT, 'name', 'version')) }],
      ['one BOM before each file', { 'package.json': Buffer.concat([BOM, bytesOf(PROJECT)]), 'package-lock.json': Buffer.concat([BOM, bytesOf(lockOf(PROJECT))]) }],
      ['each file at its byte bound', { 'package.json': `${pyBytes(PROJECT)}.ljust(1048576)`, 'package-lock.json': `${pyBytes(lockOf(PROJECT))}.ljust(16777216)` }],
    ]) {
      const run = pkgRun(t, files);
      assert.deepEqual([run.status, run.stdout.length, run.stray, run.installs.length, run.relays.length], [42, 0, [], 2, 1], `${label} ${run.stderr}`);
    }
  });

// Both files are read strictly, so npm and the preflight never read one file two ways: each row breaks one file of pkg,
// whose other file still matches it. text is a file's valid JSON; at(middle) puts middle where 0 is in {...good, x: 0}.
const RESIZE_PKG = (name, change) => `target = os.path.join(workspace, 'pkg', '${name}')
real_chunks = m.chunks
def resized(fd, size):
    if os.path.samestat(os.fstat(fd), os.stat(target)):
        ${change}
    return real_chunks(fd, size)
m.chunks = resized
`;
function strictRows(name, good, bound) {
  const text = JSON.stringify(good);
  const marked = JSON.stringify({ ...good, x: 0 });
  const at = middle => Buffer.concat([Buffer.from(marked.slice(0, -2)), Buffer.from(middle), Buffer.from(marked.slice(-1))]);
  const [key] = Object.keys(good);
  const target = `os.path.join(workspace, 'pkg', '${name}')`;
  // package.json is the candidate's own file and the lockfile the approved one. A file that changes while it is read
  // says nothing about its bytes: nothing of the candidate's runs before the install, so that stays infrastructure.
  const own = name === 'package.json' ? CANDIDATE : DEPENDENCIES_FAILED;
  return [
    ['malformed JSON', Buffer.from(text.slice(0, -1))],
    ['trailing data', Buffer.from(`${text} x`)],
    ['a repeated key, with the same value', Buffer.from(`{${JSON.stringify(key)}:${JSON.stringify(good[key])},${text.slice(1)}`)],
    ['a repeated nested key, with the same value', Buffer.from(text.replace('"dep":"1.0.0"', '"dep":"1.0.0","dep":"1.0.0"'))],
    ...['NaN', 'Infinity', '-Infinity'].map(constant => [constant, at(constant)]),
    ['invalid UTF-8', at([0x22, 0xff, 0x22])],
    ['an encoded surrogate', at([0x22, 0xed, 0xa0, 0x80, 0x22])],
    ['two BOMs', Buffer.concat([BOM, BOM, Buffer.from(text)])],
    ['nesting past the recursion limit', `${pyBytes(Buffer.from(marked.slice(0, -2)))} + b'[' * 100000 + b']' * 100000 + b'}'`],
    ['one byte over its bound', `${pyBytes(good)}.ljust(${bound + 1})`],
  ].map(([label, bytes]) => [label, { [name]: bytes }, '', own]).concat([
    ['a FIFO', `${NO_REOWN}os.unlink(${target})\nos.mkfifo(${target})\n`, own],
    ['a directory', `os.unlink(${target})\nos.makedirs(${target})\n`, own],
    ['a symlink to a matching copy', `${NO_REOWN}${OUTSIDE}os.unlink(${target})\nos.symlink(os.path.join(base, 'out', '${name}'), ${target})\n`, own],
    ['a file that grows while it is read', RESIZE_PKG(name, "open(target, 'a').write(' ')"), DEPENDENCIES_FAILED],
    ['a file that shrinks while it is read', RESIZE_PKG(name, 'os.truncate(target, 1)'), DEPENDENCIES_FAILED],
  ].map(([label, more, code]) => [label, {}, more, code])).map(([label, ...row]) => [`${name}: ${label}`, ...row]);
}

test('KI7 a package.json that is malformed, oversized or not regular exits 82, and a lockfile that is, one with no v2/v3 root entry, or either file resized while read 81, before any install or frame',
  { skip: NO_GUEST, timeout: 120_000 }, t => {
    const shapes = [
      ...[1, 4, true, '3', null].map(version => [`lockfileVersion ${JSON.stringify(version)}`, lockOf(PROJECT, version)]),
      ['lockfileVersion 3.0', Buffer.from(JSON.stringify(lockOf(PROJECT)).replace('"lockfileVersion":3', '"lockfileVersion":3.0'))],
      ['no lockfileVersion', omit(lockOf(PROJECT), 'lockfileVersion')],
      ['no packages', omit(lockOf(PROJECT), 'packages')],
      ...[[PROJECT], null].map(packages => [`packages ${JSON.stringify(packages)?.slice(0, 20)}`, { lockfileVersion: 3, packages }]),
      ['no root entry', { lockfileVersion: 3, packages: { 'node_modules/dep': { version: '1.0.0' } } }],
      ...[[PROJECT], null, 'x'].map(root => [`a root entry ${JSON.stringify(root).slice(0, 20)}`, { lockfileVersion: 3, packages: { '': root } }]),
      ['an array', [lockOf(PROJECT)]],
    ].map(([label, lock]) => [`package-lock.json: ${label}`, { 'package-lock.json': lock }]);
    for (const [label, files, more, code] of [...strictRows('package.json', PROJECT, 1048576), ...strictRows('package-lock.json', lockOf(PROJECT), 16777216), ...shapes,
      ...[null, 'x', 1].map(manifest => [`package.json: ${JSON.stringify(manifest)}`, { 'package.json': bytesOf(manifest) }, '', CANDIDATE])]) {
      refusedPkg(t, label, files, more, code);
    }
  });

// task-42e9990c: which cause wins. Every listed directory is checked before any install, and a fault that is not the
// candidate's, in any of them, outranks a candidate refusal in another: only a run whose every fault is the candidate's
// own files exits 82. A package.json read error other than a missing file (EACCES or EIO, injected once the preflight
// starts, after reown) proves nothing about the candidate. The earlier phases keep their codes: 79, then reown's 65.
const NPMRC = dir => `open(os.path.join(workspace, '${dir}', '.npmrc'), 'w').close()\n`;
const READ_ERROR = name => `import errno
real_open, real_dirs = os.open, m.dependency_dirs
def failing(path, flags, *args, dir_fd=None, **kwargs):
    if path == 'package.json' and dir_fd is not None:
        raise OSError(errno.${name}, 'injected')
    return real_open(path, flags, *args, dir_fd=dir_fd, **kwargs)
def arming(tree):
    os.open = failing
    return real_dirs(tree)
m.dependency_dirs = arming
`;

test('KI9 a fault that is not the candidate\'s in any directory, or a package.json read error, exits 81 over a candidate refusal, and 79 and 65 still come first',
  { skip: NO_GUEST, timeout: 60_000 }, t => {
    const noLock = "os.unlink(os.path.join(workspace, 'pkg', 'package-lock.json'))\n";
    for (const [label, list, more, code, options = {}] of [
      ['a candidate refusal in both directories', dirList(['.', 'pkg']), `${NPMRC('.')}${NPMRC('pkg')}`, CANDIDATE],
      ['a candidate refusal first, a missing lockfile second', dirList(['.', 'pkg']), `${NPMRC('.')}${noLock}`, DEPENDENCIES_FAILED],
      ['a missing lockfile first, a candidate refusal second', dirList(['pkg', '.']), `${NPMRC('.')}${noLock}`, DEPENDENCIES_FAILED],
      ['a candidate refusal under a malformed dependency list', 'nope', NPMRC('.'), DEPENDENCIES_FAILED],
      ...['EACCES', 'EIO'].map(name => [`package.json read ${name}`, dirList(['.']), READ_ERROR(name), DEPENDENCIES_FAILED]),
      ['package.json read ENOENT, through the same injection', dirList(['.']), READ_ERROR('ENOENT'), CANDIDATE],
      // The preflight starts no install, so a toolchain that cannot run never hides a candidate refusal.
      ['a candidate refusal with no toolchain', dirList(['.']), NPMRC('.'), CANDIDATE, { toolchain: "os.path.join(base, 'absent')" }],
    ]) {
      const run = installRun(t, list, ['.', 'pkg'], { more, ...options });
      refusedInstall(run, label, code);
      assert.deepEqual(run.installs, [], label);
    }
    const mismatch = installRun(t, dirList(['.']), ['.'], { more: NPMRC('.'), check: { ...CHECK, protected: [{ path: 'package.json', oid: 'a'.repeat(40) }] } });
    const linked = installRun(t, dirList(['.']), ['.'], { more: `${NPMRC('.')}os.symlink(os.path.join(base, 'file'), os.path.join(workspace, 'link'))\n` });
    for (const [run, code] of [[mismatch, PROTECTED_MISMATCH], [linked, 65]]) {
      assert.deepEqual([run.status, run.stdout.length, run.relays, run.installs], [code, 0, [], []], String(run.stderr));
    }
  });

// CQ-R11c: the host check session. C1-C2 cover guest-bridge.mjs's checkArgv and checkFrame, C3-C6 runCheckSession through
// a spawn-compatible fake provider, and C7 runCheckSession through the real supervisor's check mode.
const NAME = ownedInstanceName({ random: () => Buffer.alloc(10, 0xab) });
const OID = 'a'.repeat(40);
const HOST_CHECK = Object.freeze({ id: 'unit-1', command: 'npm test', protected: Object.freeze([{ path: 'a.txt', oid: OID }, { path: 'dir/b.txt', oid: 'b'.repeat(40) }]) });
const withCheck = patch => ({ ...HOST_CHECK, ...patch });
const entries = (...paths) => paths.map(path => ({ path, oid: OID }));
const many = count => entries(...Array.from({ length: count }, (_, i) => `p${String(i).padStart(4, '0')}`));
const literalFrame = check => framed(JSON.stringify({ kind: 'check', version: 1, id: check.id, command: check.command, protected: check.protected }));

test('C1 checkArgv is the fixed check argv for owned names only, and checkFrame is the exact check frame or BRIDGE_INPUT_INVALID', () => {
  const argv = checkArgv(NAME);
  assert.deepEqual(argv, ['exec', '--no-map-working-directory', NAME, '--', 'sudo', '-n', '/opt/moe/bin/moe-supervisor', 'check']);
  assert.ok(Object.isFrozen(argv));
  for (const name of ['vm', '', 'moe-x', `${NAME}0`, 42, undefined]) assert.throws(() => checkArgv(name), { code: 'BRIDGE_INPUT_INVALID' }, String(name));
  assert.deepEqual(hostCheckFrame(HOST_CHECK), literalFrame(HOST_CHECK));
  for (const check of [withCheck({ id: 'a'.padEnd(64, '9._-Z') }), withCheck({ command: 'x'.repeat(1000) }), withCheck({ command: ' a\xa0b ' }),
    ...[many(2000), [], entries('a'.repeat(500)), entries('\u{1F600}'.repeat(250)), entries('a.b', 'a/b'), entries('\uffff', '\u{10000}')]
      .map(list => withCheck({ protected: list }))]) {
    assert.deepEqual(hostCheckFrame(check), literalFrame(check), `${check.id} ${check.command.length} ${check.protected.length}`);
  }
  // The bytes come from a copy: a getter is read once, and the frame keeps the key order whatever the input's.
  let reads = 0;
  const entry = { oid: OID, get path() { reads += 1; return reads === 1 ? 'a.txt' : 'a\nb'; } };
  assert.deepEqual(hostCheckFrame({ protected: [entry], command: 'npm test', id: 'unit-1' }), literalFrame(withCheck({ protected: entries('a.txt') })));
  assert.equal(reads, 1);
  const throwing = { get id() { throw new Error('secret'); }, command: 'x', protected: [] };
  const refused = [null, [], 'x', Object.create(HOST_CHECK), { id: 'a', command: 'x' }, withCheck({ extra: 1 }), throwing,
    ...['', '-a', 'a b', 'a'.repeat(65), '\u00e9', 'a\n', 7].map(id => withCheck({ id })),
    ...['', '   ', '\ufeff', '\u3000', 'x'.repeat(1001), '\u{1F600}'.repeat(501), 'a\ud800b', 7,
      ...['\x00', '\n', '\x1f', '\x7f', '\x9f', '\u2028', '\u2029'].map(control => `a${control}b`)].map(command => withCheck({ command })),
    ...[null, {}, 'a.txt', many(2001), [null], [{ path: 'a.txt' }], [{ ...entries('a')[0], mode: 1 }],
      ...['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 7].map(oid => [{ path: 'a', oid }]),
      ...['', '/a', 'a/', 'a//b', '.', '..', 'a/./b', 'a/../b', 'a\\b', '\ufffd', 'a\x00b', 'a\x9fb', 'a\u2028b', ' a', 'a ', 'a\u00a0',
        '\ufeffa', '\ud800', 'a\udc00b', 'a'.repeat(501), `a${'\u{1F600}'.repeat(250)}`, 7].map(path => entries(path)),
      entries('b', 'a'), entries('a', 'a'), entries('a/b', 'a.b'), entries('\u{10000}', '\uffff')].map(list => withCheck({ protected: list }))];
  for (const [index, input] of refused.entries()) {
    assert.throws(() => hostCheckFrame(input), error => error?.code === 'BRIDGE_INPUT_INVALID' && error.message === 'Bridge input was invalid.', `row ${index}`);
  }
});

test('C2 checkFrame accepts exactly the check frames the supervisor read_check accepts, and the exit codes match', { skip: NO_GUEST, timeout: 30_000 }, () => {
  const rows = [...['a'.repeat(64), 'a'.repeat(65)].map(id => withCheck({ id })),
    ...['x'.repeat(1000), 'x'.repeat(1001), 'a\x9fb', 'a\xa0b', '\u3000', ' a ', 'a\u2028b', 'a\ud800b'].map(command => withCheck({ command })),
    ...['a'.repeat(500), 'a'.repeat(501), '\u{1F600}'.repeat(250), '.', '..', '', 'a\\b', ' a', 'a\u205f', '\ud800'].map(path => withCheck({ protected: entries(path) })),
    ...[many(2000), many(2001), entries('\uffff', '\u{10000}'), entries('\u{10000}', '\uffff')].map(list => withCheck({ protected: list }))];
  const accepted = rows.map(row => { try { return Buffer.isBuffer(hostCheckFrame(row)); } catch { return false; } });
  assert.ok(accepted.includes(true) && accepted.includes(false));
  // Host-refused rows are framed by hand from the same JSON, so read_check judges the very input checkFrame refused.
  const input = Buffer.concat(rows.map((row, index) => (accepted[index] ? hostCheckFrame(row) : literalFrame(row))));
  const code = `${PY_LOAD}for _ in range(int(sys.argv[2])):
    try:
        m.read_check(0)
        print('accepted')
    except ValueError:
        print('refused')
print(m.PROTECTED_MISMATCH, m.PROTECTED_CHANGED, m.DEPENDENCIES_FAILED, m.DEPENDENCIES_CANDIDATE_INVALID)
`;
  const run = spawnSync('python3', ['-I', '-B', '-c', code, SUPERVISOR, String(rows.length)], { input, maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, String(run.stderr));
  const lines = String(run.stdout).trim().split('\n');
  assert.deepEqual(lines.slice(0, -1), accepted.map(ok => (ok ? 'accepted' : 'refused')));
  assert.deepEqual([lines.at(-1), DEPENDENCIES_FAILED, DEPENDENCIES_CANDIDATE_INVALID],
    [`${PROTECTED_MISMATCH} ${PROTECTED_CHANGED} ${DEPENDENCIES_FAILED} ${DEPENDENCIES_CANDIDATE_INVALID}`, 81, 82]);
});

// A spawn-compatible fake provider of real Node streams. Like the supervisor it exits 74 on host EOF unless it is hung,
// and kill() closes it asynchronously, as Node does. Every stdin write is kept in written.
function checkProvider({ hung = false, write = (chunk, done) => done() } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), calls: [], kills: [], written: [] });
  proc.stdin = new Writable({ write(chunk, encoding, done) { proc.written.push(chunk); write(chunk, done); } });
  proc.exit = (code = 0) => { if (!proc.stdout.writableEnded) proc.stdout.once('close', () => proc.emit('close', code, null)).end(); };
  if (!hung) proc.stdin.once('close', () => proc.exit(74));
  proc.kill = signal => { proc.kills.push(signal); setImmediate(() => proc.emit('close', null, signal)); return true; };
  proc.spawn = (...args) => { proc.calls.push(args); return proc; };
  proc.send = (...frames) => proc.stdout.write(Buffer.concat(frames.map(frame => (Buffer.isBuffer(frame) ? frame : encodeFrame(frame)))));
  return proc;
}
const HELLO = { kind: 'hello', protocol: 1 };
const exited = (code, signal = null) => ({ kind: 'observation', type: 'exit', code, signal });
const OBS = exited(0);
const out = (data, stream = 'stdout') => ({ kind: 'output', stream, data: Buffer.from(data).toString('base64') });
const ended = (outcome, exitCode = null, signal = null, outputTail = '') => ({ outcome, exitCode, signal, outputTail });
const hostCheck = (proc, options = {}) => runCheckSession({ name: NAME, check: HOST_CHECK, provider: { spawn: proc.spawn }, budgetMs: 5_000, timeoutMs: 1_000, ...options });

test('C3 invalid input rejects with CHECK_SESSION_INPUT_INVALID before any spawn; an abort, spawn failure or bad child is infra-failure', async () => {
  const provider = patch => spawn => ({ provider: { spawn, ...patch } });
  const rows = [{ name: 'vm' }, { name: undefined }, { check: withCheck({ id: '' }) }, { check: null }, { provider: null }, { provider: 'multipass' },
    provider({ spawn: 'spawn' }), provider({ executable: ' ' }), provider({ executable: 'multi\npass' }), provider({ executable: 7 }),
    ...[0, 1.5, '1', MAX_BUDGET_MS + 1, undefined].map(budgetMs => ({ budgetMs })), ...[0, 60_001, null].map(timeoutMs => ({ timeoutMs })), { signal: {} }];
  for (const [index, row] of rows.entries()) {
    const proc = checkProvider();
    await assert.rejects(hostCheck(proc, typeof row === 'function' ? row(proc.spawn) : row),
      error => error?.code === 'CHECK_SESSION_INPUT_INVALID' && error.message === 'Check session input was invalid.', `row ${index}`);
    assert.equal(proc.calls.length, 0, `row ${index}`);
  }
  for (const input of [undefined, null]) await assert.rejects(runCheckSession(input), { code: 'CHECK_SESSION_INPUT_INVALID' });
  const aborted = checkProvider();
  assert.deepEqual(await hostCheck(aborted, { signal: AbortSignal.abort() }), ended('infra-failure'));
  assert.equal(aborted.calls.length, 0);
  for (const spawn of [() => { throw new Error('ENOENT'); }, () => null, () => ({ ...checkProvider(), kill: undefined }), () => ({ ...checkProvider(), stderr: null })]) {
    assert.deepEqual(await hostCheck(checkProvider(), { provider: { spawn } }), ended('infra-failure'));
  }
});

test('C4 the check frame is the first and only stdin write, under the fixed argv, and stdin stays open while the job runs', async () => {
  const proc = checkProvider();
  const { signal } = new AbortController(); // never aborted: its listener must still be removed
  const promise = hostCheck(proc, { signal, budgetMs: MAX_BUDGET_MS, timeoutMs: 60_000 });
  proc.send(HELLO, out('ok\n'), OBS);
  await new Promise(setImmediate);
  assert.deepEqual([proc.stdin.writableEnded, proc.stdin.destroyed], [false, false]);
  proc.exit(0);
  assert.deepEqual(await promise, ended('passed', 0, null, 'ok\n'));
  assert.deepEqual(proc.calls, [['multipass', checkArgv(NAME), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]]);
  assert.deepEqual([proc.written, proc.kills, getEventListeners(signal, 'abort').length], [[hostCheckFrame(HOST_CHECK)], [], 0]);
});

test('C5 each outcome arises only from its condition, and only hello, one observation of code 0, EOF and exit 0 is passed', { timeout: 30_000 }, async () => {
  const clean = (code = 0, ...frames) => proc => { proc.send(HELLO, ...frames, OBS); proc.exit(code); };
  const after = (...frames) => proc => { proc.send(HELLO, OBS, ...frames); proc.exit(0); };
  const never = (chunk, done) => {};
  const rows = [['passed', clean(), ended('passed', 0)],
    ['code 3', proc => { proc.send(HELLO, exited(3)); proc.exit(0); }, ended('code-failure', 3)],
    ['SIGKILL', proc => { proc.send(HELLO, exited(null, 'SIGKILL')); proc.exit(0); }, ended('code-failure', null, 'SIGKILL')],
    ...[0, 3].map(code => [`80 after ${code}`, proc => { proc.send(HELLO, exited(code)); proc.exit(80); }, ended('inconclusive', code)]),
    ['79, no frame', proc => proc.exit(79), ended('skipped')], ['81, no frame', proc => proc.exit(DEPENDENCIES_FAILED)], ['close before EOF', proc => { proc.send(HELLO, OBS); setImmediate(() => proc.emit('close', 0, null)); }],
    ['79 after hello', proc => { proc.send(HELLO); proc.exit(79); }], ['79 after the observation', clean(79)],
    ['80 without observation', proc => { proc.send(HELLO); proc.exit(80); }], ...[74, 71, 1].map(code => [`exit ${code}`, clean(code)]),
    ['hello only', proc => { proc.send(HELLO); proc.exit(0); }], ['no frame, exit 0', proc => proc.exit(0)],
    ['a request', clean(0, { kind: 'request', id: 1, tool: 'moe.get_context', args: {} })], ['double hello', clean(0, HELLO)],
    ['output first', proc => { proc.send(out('x'), HELLO, OBS); proc.exit(0); }], ['observation first', proc => { proc.send(OBS, HELLO, OBS); proc.exit(0); }],
    ['output after', after(out('x'))], ['second observation', after(OBS)], ['garbage', after(framed('nope'))], ['truncated', after(header(9))],
    ['child error', proc => { clean()(proc); proc.emit('error', new Error('x')); }],
    ['stdin error', proc => { proc.stdin.emit('error', new Error('x')); clean()(proc); }],
    ['stdout error', proc => { proc.stdout.emit('error', new Error('x')); clean()(proc); }],
    ['abort', (proc, controller) => { proc.send(HELLO, OBS); controller.abort(); proc.exit(0); }],
    ['write error', clean(), undefined, {}, { write: (chunk, done) => done(new Error('EPIPE')) }],
    ['write never completes', clean(), undefined, {}, { write: never }],
    ['write throws', clean(), undefined, {}, { prepare: proc => { proc.stdin.write = () => { throw new Error('x'); }; } }],
    ['write hangs, then the write deadline', () => {}, undefined, {}, { write: never }],
    ['EOF, then a hung provider killed', proc => { proc.send(HELLO, OBS); proc.stdout.end(); }, undefined, {}, { hung: true }],
    ['killed after a protocol stop', proc => proc.send(HELLO, { kind: 'request', id: 1, tool: 'moe.get_context', args: {} }), undefined, {}, { hung: true }],
    ['budget mid-job', proc => proc.send(HELLO), ended('timeout'), { budgetMs: 100 }],
    ['budget after the observation', proc => proc.send(HELLO, OBS), ended('timeout'), { budgetMs: 100 }],
    ['budget, then a hung provider killed', proc => proc.send(HELLO), ended('timeout'), { budgetMs: 100 }, { hung: true }]];
  const procs = [];
  for (const [label, script, expected = ended('infra-failure'), options = {}, fake = {}] of rows) {
    const proc = checkProvider(fake);
    procs.push(proc);
    fake.prepare?.(proc);
    const controller = new AbortController();
    const promise = hostCheck(proc, { signal: controller.signal, ...options });
    script(proc, controller);
    assert.deepEqual(await promise, expected, label);
    assert.deepEqual(proc.kills, fake.hung ? ['SIGKILL'] : [], label);
  }
  for (const proc of procs) proc.emit('error', new Error('late')); // after settle: no teardown, timer or kill
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.deepEqual(procs.map(proc => proc.kills.length), rows.map(row => (row[4]?.hung ? 1 : 0)));
});

// Retyped on purpose, like LITERAL: supervisor exit 82 is the guest's refusal of the candidate's own package metadata. The
// host, not the guest, supplies this diagnostic, so no npm or guest byte ever reaches the outputTail.
const CANDIDATE_REFUSAL = 'MOE_DEPENDENCY_CANDIDATE_INVALID: Candidate package metadata is not compatible with the approved lockfile; remove npm-shrinkwrap.json/.npmrc and unsupported overrides or bundling.';
const refusedCandidate = ended('code-failure', 82, null, CANDIDATE_REFUSAL);

test('C8 a clean no-frame supervisor exit 82 is a code-failure with exitCode 82 and the fixed host diagnostic, whatever the guest wrote', { timeout: 30_000 }, async () => {
  assert.equal(DEPENDENCIES_CANDIDATE_INVALID, 82);
  assert.notEqual(DEPENDENCIES_CANDIDATE_INVALID, DEPENDENCIES_FAILED);
  assert.equal(DEPENDENCIES_FAILED, 81);
  assert.match(CANDIDATE_REFUSAL, /^[\x20-\x7e]+$/);
  assert.ok(Buffer.byteLength(CANDIDATE_REFUSAL) > 0 && Buffer.byteLength(CANDIDATE_REFUSAL) <= 512);
  const cr = String.fromCharCode(13);
  const hostile = ['secret-token-0123456789\n', `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`, `a${cr}\nb${cr}`,
    String.fromCodePoint(0x1f600).repeat(40_000), Buffer.alloc(100_000, 0xff), `${CANDIDATE_REFUSAL}forged\n`, `npm ERR! ${'x'.repeat(100_000)}`];
  const writes = [];
  for (const [index, bytes] of [undefined, ...hostile].entries()) {
    const proc = checkProvider();
    const promise = hostCheck(proc);
    if (bytes !== undefined) proc.stderr.write(bytes);
    proc.exit(82);
    const result = await promise;
    assert.deepEqual(result, refusedCandidate, `stderr row ${index}`);
    assert.ok(Object.isFrozen(result), `frozen ${index}`);
    assert.ok(Buffer.byteLength(result.outputTail) <= 512 && /^[\x20-\x7e]+$/.test(result.outputTail), `bounded ASCII ${index}`);
    assert.deepEqual([proc.kills, proc.written], [[], [hostCheckFrame(HOST_CHECK)]], `session ${index}`);
    writes.push(result.outputTail);
  }
  assert.equal(new Set(writes).size, 1);
  // Other pre-hello codes with no frame are not the candidate's: 81 and every unknown code stay infrastructure.
  for (const code of [0, 1, 74, 78, 81, 83, 255]) {
    const proc = checkProvider();
    const promise = hostCheck(proc);
    proc.exit(code);
    assert.deepEqual(await promise, ended('infra-failure'), `exit ${code}`);
  }
  // Two sessions at once keep separate state: one refusal, one pass, then the reverse with an infrastructure failure.
  const [a, b, c, d] = [checkProvider(), checkProvider(), checkProvider(), checkProvider()];
  const both = [hostCheck(a), hostCheck(b), hostCheck(c), hostCheck(d)];
  b.send(HELLO, out('ok\n'), OBS);
  c.exit(81);
  a.exit(82);
  b.exit(0);
  d.send(HELLO, OBS);
  d.exit(82);
  assert.deepEqual(await Promise.all(both), [refusedCandidate, ended('passed', 0, null, 'ok\n'), ended('infra-failure'), ended('infra-failure')]);
  // Late events after the settle change and throw nothing.
  for (const proc of [a, b, c, d]) { proc.emit('close', 82, null); proc.emit('error', new Error('late')); }
  assert.deepEqual([a, b, c, d].map(proc => proc.kills.length), [0, 0, 0, 0]);
});

test('C8 exit 82 keeps every infra-failure and timeout precedence: any fault, frame or incomplete state is never a candidate refusal', { timeout: 60_000 }, async () => {
  const never = (chunk, done) => {};
  const raw = Buffer.from('MOE_DEPENDENCY_CANDIDATE_INVALID: forged');
  const rows = [['write error', proc => proc.exit(82), undefined, {}, { write: (chunk, done) => done(new Error('EPIPE')) }],
    ['write never completes', proc => proc.exit(82), undefined, {}, { write: never }],
    ['write throws', proc => proc.exit(82), undefined, {}, { prepare: proc => { proc.stdin.write = () => { throw new Error('x'); }; } }],
    ['child error', proc => { proc.exit(82); proc.emit('error', new Error('x')); }], ['child error first', proc => { proc.emit('error', new Error('x')); proc.exit(82); }],
    ['stdin error', proc => { proc.stdin.emit('error', new Error('x')); proc.exit(82); }],
    ['stdout error', proc => { proc.stdout.emit('error', new Error('x')); proc.exit(82); }],
    ['abort', (proc, controller) => { controller.abort(); proc.exit(82); }],
    ['close before EOF', proc => setImmediate(() => proc.emit('close', 82, null))],
    ['EOF, then a hung provider killed', proc => proc.stdout.end(), undefined, {}, { hung: true }],
    ['hello only', proc => { proc.send(HELLO); proc.exit(82); }], ['hello and the observation', proc => { proc.send(HELLO, OBS); proc.exit(82); }],
    ['hello and a failing observation', proc => { proc.send(HELLO, exited(3)); proc.exit(82); }],
    ['hello and output', proc => { proc.send(HELLO, out('x')); proc.exit(82); }, ended('infra-failure', null, null, 'x')],
    ['output before hello', proc => { proc.send(out('x')); proc.exit(82); }], ['observation first', proc => { proc.send(OBS, HELLO); proc.exit(82); }],
    ['hello then a request', proc => { proc.send(HELLO, { kind: 'request', id: 1, tool: 'moe.get_context', args: {} }); proc.exit(82); }],
    ['double hello', proc => { proc.send(HELLO, HELLO); proc.exit(82); }], ['garbage frame', proc => { proc.send(framed('nope')); proc.exit(82); }],
    ['truncated header', proc => { proc.send(header(9)); proc.exit(82); }], ['raw bytes, no frame', proc => { proc.send(raw); proc.exit(82); }],
    ['budget before the exit', proc => setTimeout(() => proc.exit(82), 300), ended('timeout'), { budgetMs: 100 }, { hung: true }]];
  const procs = [];
  for (const [label, script, expected = ended('infra-failure'), options = {}, fake = {}] of rows) {
    const proc = checkProvider(fake);
    procs.push(proc);
    fake.prepare?.(proc);
    const controller = new AbortController();
    const promise = hostCheck(proc, { signal: controller.signal, ...options });
    script(proc, controller);
    assert.deepEqual(await promise, expected, label);
    assert.deepEqual(proc.kills, label === 'EOF, then a hung provider killed' ? ['SIGKILL'] : [], label);
  }
  for (const proc of procs) proc.emit('error', new Error('late'));
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.deepEqual(procs.map(proc => proc.kills.length), rows.map(row => (row[0] === 'EOF, then a hung provider killed' ? 1 : 0)));
});

test('C6 outputTail is the last 16384 UTF-8 bytes of the combined output, starting on a whole character, for every outcome', { timeout: 30_000 }, async () => {
  const ascii = (length, seed = 0) => Buffer.from(Array.from({ length }, (_, i) => 0x21 + ((seed + i) % 90)));
  const big = Array.from({ length: 32 }, (_, i) => ascii(65_536, i));
  const odd = Array.from({ length: 7 }, (_, i) => ascii(9_999, i * 7));
  const lastOf = chunks => Buffer.concat(chunks).subarray(-MAX_CHECK_TAIL_BYTES).toString();
  const rows = [[[], ''], [['a'.repeat(16_384)], 'a'.repeat(16_384)], [[`b${'a'.repeat(16_384)}`], 'a'.repeat(16_384)],
    [[`\u00e9${'a'.repeat(16_383)}`], 'a'.repeat(16_383)], [[`\u{1F600}${'a'.repeat(16_381)}`], 'a'.repeat(16_381)],
    [['A', ['B', 'stderr'], 'C'], 'ABC'], [[Buffer.of(0xc3), [Buffer.of(0xa9), 'stderr']], '\u00e9'], [[Buffer.of(0xff, 0x41)], '\ufffdA'],
    [[Buffer.alloc(20_000, 0xff)], '\ufffd'.repeat(5_461)], [big, lastOf(big)], [odd, lastOf(odd)]];
  for (const [chunks, tail] of rows) {
    const proc = checkProvider();
    const promise = hostCheck(proc);
    proc.send(HELLO, ...chunks.map(chunk => (Array.isArray(chunk) ? out(...chunk) : out(chunk))), OBS);
    proc.exit(0);
    const result = await promise;
    assert.deepEqual(result, ended('passed', 0, null, tail), `${chunks.length} ${tail.slice(0, 20)}`);
    assert.ok(Buffer.byteLength(result.outputTail) <= MAX_CHECK_TAIL_BYTES);
  }
  const timedOut = checkProvider();
  const promise = hostCheck(timedOut, { budgetMs: 100 });
  timedOut.send(HELLO, out('so far\n'));
  assert.deepEqual(await promise, ended('timeout', null, null, 'so far\n'));
});

// C7's harness is the supervisor's own main(), as root, with the test user as the check identity and no mounts. Its stdin
// is the session's pipe, which stays open, so the check frame really travels as the session's first write.
const SESSION_HARNESS = `${PLANT({ 'a.txt': 'A\n' })}m.protect_mounts = lambda workspace, paths: None
sys.exit(m.main(['check'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, identity=(os.getuid(), os.getgid(), None), netns=False))
`;

test('C7 through the real supervisor check mode, real exit codes give passed, code-failure, skipped and inconclusive',
  { skip: NO_GUEST || (process.platform !== 'linux' && 'the busy-host guard reads /proc'), timeout: 60_000 }, async t => {
    const tasks = userTasks();
    if (tasks >= 1792) return t.skip(`the test user already runs ${tasks} tasks, too near RLIMIT_NPROC`);
    const good = blobOid('A\n');
    const flipped = `${good[0] === '0' ? '1' : '0'}${good.slice(1)}`;
    const children = [];
    t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    for (const [command, list, expected, homes] of [['exit 0', [], ended('passed', 0), 1], ['echo boom; exit 3', [], ended('code-failure', 3, null, 'boom\n'), 1],
      ['exit 0', [{ path: 'a.txt', oid: flipped }], ended('skipped'), 0], ['rm -f a.txt', [{ path: 'a.txt', oid: good }], ended('inconclusive', 0), 1]]) {
      const dir = mkdtempSync(join(tmpdir(), 'moe-r11c-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const calls = [];
      const spawn = (executable, argv, options) => {
        calls.push([executable, argv, options]);
        const child = spawnChild('python3', ['-I', '-B', '-c', `${PY_LOAD}${CHECK_DIRS}${SESSION_HARNESS}`, SUPERVISOR, dir, 'ws'], { stdio: 'pipe' });
        children.push(child);
        return child;
      };
      const result = await runCheckSession({ name: NAME, check: { id: 'unit-1', command, protected: list }, provider: { spawn }, budgetMs: 20_000, timeoutMs: 5_000 });
      assert.deepEqual(result, expected, command);
      assert.deepEqual(calls.map(([executable, argv]) => [executable, argv]), [['multipass', checkArgv(NAME)]]);
      assert.deepEqual(existsSync(join(dir, 'sessions')) ? readdirSync(join(dir, 'sessions')).length : 0, homes, command);
    }
  });

// task-42e9990c: the dependency phase through C7's real supervisor main() and the real runCheckSession. INSTALL plants an
// honest project in '.' and the fake toolchain, and each row breaks one thing. The harness writes hostile bytes to the
// supervisor's stderr first, and the candidate rows carry them in their own files too: a candidate refusal is still the
// host's fixed literal. The check command leaves a marker only if it runs.
const [ESC, CR] = [String.fromCharCode(27), String.fromCharCode(13)];
const HOSTILE = `npm_secretToken0123456789${CR}\n${ESC}[31mred${ESC}[0m ${String.fromCodePoint(0x1f600).repeat(5000)}`;
const DEPENDENCY_SESSION = more => `${INSTALL(dirList(['.']), ['.'], more, true)}m.protect_mounts = lambda workspace, paths: None
sys.stderr.buffer.write(bytes.fromhex('${Buffer.from(HOSTILE).toString('hex')}') + bytes.fromhex('ff') * 100000)
sys.stderr.buffer.flush()
sys.exit(m.main(['check'], geteuid=lambda: 0, workspace=workspace, sessions=sessions, identity=(os.getuid(), os.getgid(), None), netns=False,
                toolchain=tc, dependencies=deps, dependencies_manifest=os.path.join(base, 'deps.manifest'), install_timeout=2))
`;

test('C9 through the real supervisor, a candidate dependency refusal is code-failure 82 with the fixed host text and an environment fault infra-failure, and neither runs the check',
  { skip: INSTALLS_RUN, timeout: 120_000 }, async t => {
    if (busy(t)) return;
    const children = [];
    t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const plant = files => `plant(workspace, ${pyFiles(files)})\n`;
    const list = text => `with open(os.path.join(deps, 'moe-dependencies.json'), 'w') as f:\n    f.write(${JSON.stringify(text)})\n`;
    const infra = ended('infra-failure');
    for (const [label, more, expected, installs] of [
      ['the honest project', '', ended('passed', 0, null, 'ok\n'), 1],
      ['a hostile name in package.json', plant({ 'package.json': { ...PROJECT, name: HOSTILE } }), refusedCandidate, 0],
      ['an .npmrc holding a token', plant({ '.npmrc': Buffer.from(`//registry.npmjs.org/:_authToken=${HOSTILE}\n`) }), refusedCandidate, 0],
      ['an npm-shrinkwrap.json', plant({ 'npm-shrinkwrap.json': lockOf(PROJECT) }), refusedCandidate, 0],
      ['an override', plant({ 'package.json': { ...PROJECT, overrides: { dep: STUB_TGZ } } }), refusedCandidate, 0],
      ['no package.json', "os.unlink(os.path.join(workspace, 'package.json'))\n", refusedCandidate, 0],
      ['no toolchain', "tc = os.path.join(base, 'absent')\n", infra, 0],
      ['an install that exits 3', "open(os.path.join(workspace, 'status'), 'w').write('3\\n')\n", infra, 1],
      ['an install that outlives install_timeout', "open(os.path.join(workspace, 'hang'), 'w').close()\n", infra, 1],
      ['a package.json read that fails with EIO', READ_ERROR('EIO'), infra, 0],
      ['an .npmrc beside a missing lockfile', `${NPMRC('.')}os.unlink(os.path.join(workspace, 'package-lock.json'))\n`, infra, 0],
      ['an .npmrc under a malformed dependency list', `${NPMRC('.')}${list('nope')}`, infra, 0],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'moe-42e9-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const calls = [];
      const spawn = (executable, argv, options) => {
        calls.push([executable, argv, options]);
        const child = spawnChild('python3', ['-I', '-B', '-c', `${PY_LOAD}${CHECK_DIRS}${DEPENDENCY_SESSION(more)}`, SUPERVISOR, dir, 'ws'], { stdio: 'pipe' });
        children.push(child);
        return child;
      };
      const result = await runCheckSession({ name: NAME, check: { id: 'unit-1', command: 'touch ran; echo ok', protected: [] }, provider: { spawn }, budgetMs: 20_000, timeoutMs: 5_000 });
      assert.deepEqual(result, expected, label);
      assert.ok(Buffer.byteLength(result.outputTail) <= 512 && /^[\x20-\x7e\n]*$/.test(result.outputTail), label);
      const log = join(dir, 'install.log');
      assert.deepEqual([calls.map(([executable, argv]) => [executable, argv]), existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0,
        existsSync(join(dir, 'ws', 'ran'))], [[['multipass', checkArgv(NAME)]], installs, label === 'the honest project'], label);
    }
  });

// CQ-R11e3a: lockfile admission. Pure, so nothing here touches a network or a filesystem except the one real lockfile.
const sri = seed => `sha512-${createHash('sha512').update(seed).digest('base64')}`;
const regUrl = (name, version = '1.0.0') => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
const ok = (name, extra) => ({ version: '1.0.0', resolved: regUrl(name), integrity: sri(name), ...extra });
const lock = (packages, lockfileVersion = 3) => Buffer.from(JSON.stringify({ lockfileVersion, packages: { '': { name: 'fixture' }, ...packages } }));
const admit = (lockfiles, cpu = 'x64') => admitLockfiles({ lockfiles, cpu });
const refused = (fn, code, ...secrets) => {
  const error = caught(fn);
  assert.equal(error.code, code, secrets.join(' '));
  assert.equal(error.message, dependencyError(code).message, secrets.join(' '));
  for (const secret of secrets) assert.ok(!error.message.includes(String(secret)), `message echoed ${secret}`);
};
const GOOD_BYTES = lock({});

test('DA1 input refusals are fixed DEPENDENCY_INPUT_INVALID, and every property is read exactly once', () => {
  const good = { dir: '.', bytes: GOOD_BYTES };
  class Sub extends Array {}
  const throwing = new Error('getter-secret');
  const cases = [
    ['null', null], ['array', [good]], ['string', 'x'], ['extra key', { lockfiles: [good], cpu: 'x64', extra: 1 }],
    ['no cpu', { lockfiles: [good] }], ['no lockfiles', { cpu: 'x64' }],
    ...['ia32', 'X64', 'x86_64', 1, new String('x64')].map(cpu => [`cpu ${String(cpu)}`, { lockfiles: [good], cpu }]),
    ...[{}, 'x', null, Sub.from([good]), [], Array.from({ length: MAX_LOCKFILES + 1 }, (_, i) => ({ dir: `d${i}`, bytes: GOOD_BYTES })),
      new Proxy([good], { get: (target, key, receiver) => (key === 'length' ? 1e9 : Reflect.get(target, key, receiver)) }),
      new Proxy([good], { get() { throw throwing; } })].map((lockfiles, i) => [`lockfiles #${i}`, { lockfiles, cpu: 'x64' }]),
    ...[null, 5, 'x', [good], { dir: '.', bytes: GOOD_BYTES, extra: 1 }, { dir: '.' }, { bytes: GOOD_BYTES }]
      .map((element, i) => [`element #${i}`, { lockfiles: [element], cpu: 'x64' }]),
    ...['', '/abs', '../x', 'a/../b', './x', '.moe/x', 'a\\b', 5].map(dir => [`dir ${String(dir)}`, { lockfiles: [{ dir, bytes: GOOD_BYTES }], cpu: 'x64' }]),
    ...['.', 'sub'].map(dir => [`duplicate ${dir}`, { lockfiles: [{ dir, bytes: GOOD_BYTES }, { dir, bytes: GOOD_BYTES }], cpu: 'x64' }]),
    ...['x', new ArrayBuffer(8), new DataView(new ArrayBuffer(8)), new Uint16Array(4), 7, null]
      .map((bytes, i) => [`bytes #${i}`, { lockfiles: [{ dir: '.', bytes }], cpu: 'x64' }]),
    ['cpu getter', { lockfiles: [good], get cpu() { throw throwing; } }],
    ['bytes getter', { lockfiles: [{ dir: '.', get bytes() { throw throwing; } }], cpu: 'x64' }],
  ];
  for (const [label, input] of cases) refused(() => admitLockfiles(input), 'DEPENDENCY_INPUT_INVALID', label, 'getter-secret');
  const reads = [];
  const spy = (target, label) => new Proxy(target, { get: (t, key, receiver) => (reads.push(`${label}.${String(key)}`), Reflect.get(t, key, receiver)) });
  const lockfiles = spy([spy({ dir: '.', bytes: GOOD_BYTES }, 'e0'), spy({ dir: 'sub', bytes: GOOD_BYTES }, 'e1')], 'lf');
  assert.deepEqual(admitLockfiles(spy({ lockfiles, cpu: 'x64' }, 'in')).dirs, ['.', 'sub']);
  assert.deepEqual(reads.sort(), ['e0.bytes', 'e0.dir', 'e1.bytes', 'e1.dir', 'in.cpu', 'in.lockfiles', 'lf.0', 'lf.1', 'lf.length']);
});

test('DA2 lockfile refusals are fixed DEPENDENCY_LOCKFILE_INVALID, and a BOM is tolerated', () => {
  const one = bytes => () => admit([{ dir: '.', bytes }]);
  const json = value => Buffer.from(JSON.stringify(value));
  // The invalid byte sits in the ROOT entry's name: a lenient decoder would admit this file, so only fatal decoding refuses it.
  const badUtf8 = Buffer.concat([Buffer.from('{"lockfileVersion":3,"packages":{"":{"name":"x'), Buffer.from([0xff]), Buffer.from('"}}}')]);
  const bad = [badUtf8, Buffer.from('not json'), ...['null', '[]', '5'].map(text => Buffer.from(text)),
    ...[1, '3', 4, undefined].map(lockfileVersion => json({ lockfileVersion, packages: {} })),
    ...[undefined, null, [], 'x'].map(packages => json({ lockfileVersion: 3, packages })),
    lock({ 'node_modules/a': 5 }), lock({ 'node_modules/a': null })];
  bad.forEach((bytes, i) => refused(one(bytes), 'DEPENDENCY_LOCKFILE_INVALID', `lockfile #${i}`));
  assert.deepEqual(one(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lock({ 'node_modules/a': ok('a') })]))().packages.length, 1);
});

test('DA3 entry refusals use one fixed code per kind and never echo the entry', () => {
  const refuseEntry = (key, entry, code) => refused(() => admit([{ dir: 'secret-dir', bytes: lock({ 'node_modules/first': ok('first'), [key]: entry }) }]),
    code, key, 'secret-dir', JSON.stringify(entry));
  const b = extra => ok('b', extra);
  const url = regUrl('b');
  for (const key of ['src/x', 'node_modules', 'node_modules/', 'node_modules/@s', 'node_modules/@s/', 'node_modules/a/b', 'node_modules/../x',
    'node_modules/./x', 'node_modules/.bin', 'node_modules/_x', 'node_modules/a/node_modules', 'node_modules/a//node_modules/b', 'packages/ws',
    'node_modules/a\\b', 'node_modules/a b', 'node_modules/%2e%2e']) refuseEntry(key, b(), 'DEPENDENCY_LOCATION_INVALID');
  // npm 12.2.0 still creates a link entry's symlink when it is flagged inBundle or optional, so no flag may skip the refusal.
  const sources = [['node_modules/b', b({ link: true })], ['node_modules/b', { link: true, inBundle: true, resolved: 'target' }],
    ['node_modules/b', b({ link: true, optional: true, os: ['darwin'] })],
    ...['git+https://github.com/x/a.git#abc', 'git+ssh://git@github.com/x/a.git', 'file:../a', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz',
      'https://registry.yarnpkg.com/a/-/a-1.0.0.tgz', url.replace('https://', 'https://u:p@'), url.replace('.org', '.org:443'), `${url}?x=1`,
      `${url}#x`, url.replace('registry', 'REGISTRY')].map(resolved => ['node_modules/b', b({ resolved })]),
    ['node_modules/a', b()], ['node_modules/a', ok('a', { name: 'real' })], ['node_modules/b', b({ resolved: regUrl('b', '1.0.1') })],
    ['node_modules/b', b({ resolved: undefined })], ['node_modules/b', b({ version: undefined })],
    ...['latest', '1.0'].map(version => ['node_modules/b', b({ version, resolved: regUrl('b', version) })]),
    ['node_modules/b', b({ name: '../x' })], ['node_modules/b', b({ name: 5 })]];
  for (const [key, entry] of sources) refuseEntry(key, entry, 'DEPENDENCY_SOURCE_UNSUPPORTED');
  const body = sri('b').slice(7, -2);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // The last of the 86 characters carries 2 data bits and 4 padding bits; setting a padding bit decodes to the same bytes.
  const loose = `sha512-${body.slice(0, -1)}${alphabet[alphabet.indexOf(body.at(-1)) | 1]}==`;
  assert.notEqual(loose, sri('b'));
  assert.deepEqual(Buffer.from(loose.slice(7), 'base64'), Buffer.from(sri('b').slice(7), 'base64'));
  const sha1 = `sha1-${createHash('sha1').update('b').digest('base64')}`;
  for (const integrity of [undefined, sha1, `sha256-${createHash('sha256').update('b').digest('base64')}`, `${sri('b')} ${sha1}`, `${sri('b')} ${sri('c')}`,
    `sha512-${body.slice(0, 85)}==`, `sha512-${body}`, ` ${sri('b')}`, sri('b').replace('sha512', 'SHA512'), loose]) {
    refuseEntry('node_modules/b', b({ integrity }), 'DEPENDENCY_INTEGRITY_INVALID');
  }
});

test('DA4 admits registry entries once per integrity, skips root, bundled and platform-excluded optional ones, and is deterministic', () => {
  const packages = () => ({
    '': { resolved: 'garbage', integrity: 'garbage' },
    'node_modules/@s/b': ok('@s/b'), 'node_modules/a/node_modules/c': ok('c'), 'node_modules/alias': ok('real', { name: 'real' }),
    'node_modules/constructor': ok('constructor'), 'node_modules/toString': ok('toString'), 'node_modules/bundled': { inBundle: true },
    'node_modules/darwin-only': ok('darwin-only', { optional: true, os: ['darwin'] }),
    'node_modules/not-win': ok('not-win', { optional: true, os: ['!win32'] }), 'node_modules/linux-str': ok('linux-str', { optional: true, os: 'linux' }),
    'node_modules/os-any': ok('os-any', { optional: true, os: ['any'] }), 'node_modules/arm-only': ok('arm-only', { optional: true, cpu: ['arm64'] }),
    'node_modules/not-arm': ok('not-arm', { optional: true, cpu: ['!arm64'] }), 'node_modules/musl': ok('musl', { optional: true, libc: ['musl'] }),
    'node_modules/req-darwin': ok('req-darwin', { os: ['darwin'] }), 'node_modules/dev-opt': ok('dev-opt', { devOptional: true, os: ['darwin'] }),
    'node_modules/zz': ok('zz', { integrity: sri('shared') }), 'node_modules/aa': ok('aa', { integrity: sri('shared') }),
  });
  const files = (order = x => x) => order([{ dir: '.', bytes: lock(order(packages())) }, { dir: 'sub', bytes: lock({ 'node_modules/zz': ok('zz', { integrity: sri('shared') }) }, 2) }]);
  const want = (cpuOnly) => {
    const pkg = (seed, name) => { const d = createHash('sha512').update(seed).digest(); return { integrity: `sha512-${d.toString('base64')}`, sha512: d.toString('hex'), url: regUrl(name) }; };
    const names = ['@s/b', 'c', 'real', 'constructor', 'toString', 'not-win', 'linux-str', 'os-any', 'musl', 'req-darwin', 'dev-opt', cpuOnly];
    return [...names.map(name => pkg(name, name)), pkg('shared', 'aa')].sort((a, b) => (a.sha512 < b.sha512 ? -1 : 1));
  };
  for (const [cpu, extra] of [['x64', 'not-arm'], ['arm64', 'arm-only']]) {
    const result = admit(files(), cpu);
    assert.deepEqual(result, { dirs: ['.', 'sub'], packages: want(extra) }, cpu);
    for (const node of [result, result.dirs, result.packages, ...result.packages]) assert.ok(Object.isFrozen(node));
    for (const { sha512 } of result.packages) assert.match(sha512, /^[0-9a-f]{128}$/);
    const flipped = x => (Array.isArray(x) ? [...x].reverse() : reversed(x));
    assert.deepEqual(admit(files(flipped), cpu), result, `${cpu} order`);
  }
  // UTF-8 byte order, not UTF-16: U+FF5E sorts before U+10000 in UTF-8 but after it in UTF-16.
  assert.deepEqual(admit(['b', 'a', '.', '\u{10000}', '～'].map(dir => ({ dir, bytes: GOOD_BYTES }))).dirs, ['.', 'a', 'b', '～', '\u{10000}']);
});

test('DA5 bounds refuse with fixed codes, and the repository lockfile is admitted', () => {
  assert.equal(MAX_LOCKFILES, 16);
  assert.equal(MAX_LOCKFILE_BYTES, 16_777_216);
  assert.equal(MAX_DEPENDENCY_PACKAGES, MAX_IMPORT_ENTRIES - 1);
  const base = lock({ 'node_modules/a': ok('a') });
  const padded = size => Buffer.concat([base, Buffer.alloc(size - base.length, 0x20)]);
  const lockfile = bytes => [{ dir: '.', bytes }];
  assert.equal(admit(lockfile(padded(MAX_LOCKFILE_BYTES))).packages.length, 1);
  refused(() => admit(lockfile(padded(MAX_LOCKFILE_BYTES + 1))), 'DEPENDENCY_LIMIT_EXCEEDED');
  // Undecodable bytes: the size bound must refuse first. A spoofed own byteLength must not hide the real size.
  const huge = Buffer.alloc(MAX_LOCKFILE_BYTES + 1, 0xff);
  Object.defineProperty(huge, 'byteLength', { value: 1 });
  refused(() => admit(lockfile(huge)), 'DEPENDENCY_LIMIT_EXCEEDED');
  const many = count => lock(Object.fromEntries(Array.from({ length: count }, (_, i) => [`node_modules/p${i}`, ok(`p${i}`)])));
  const max = many(MAX_DEPENDENCY_PACKAGES);
  assert.equal(admit(lockfile(max)).packages.length, MAX_DEPENDENCY_PACKAGES);
  assert.equal(admit([{ dir: '.', bytes: max }, { dir: 'sub', bytes: max }]).packages.length, MAX_DEPENDENCY_PACKAGES);
  refused(() => admit(lockfile(many(MAX_DEPENDENCY_PACKAGES + 1))), 'DEPENDENCY_LIMIT_EXCEEDED');
  const real = admit(lockfile(readFileSync(new URL('../../packages/moe-daemon/package-lock.json', import.meta.url))));
  assert.ok(real.packages.length > 0);
  for (const { url, sha512 } of real.packages) {
    assert.ok(url.startsWith('https://registry.npmjs.org/'), url);
    assert.match(sha512, /^[0-9a-f]{128}$/);
  }
});

// task-adbab50d: shapes that passed admission and made the pinned npm 11.19.1's offline npm ci install workspace bytes. A
// non-registry spec in any entry's dependency maps (the root's too, which package.json must equal): npm re-resolves an
// edge the locked node does not satisfy from its spec. A bundled entry naming its own resolved or legacy _resolved: npm
// fetches it when the root bundles it or its bundler's tarball lacks it. A truthy hasShrinkwrap or _hasShrinkwrap: npm
// installs what the tarball's own npm-shrinkwrap.json names.
const NON_REGISTRY = ['file:stub/a-1.0.0.tgz', 'FILE:a', './a', '../a', '.', '.a', '/a', '~/a', 'C:a', 'stub/a', 'a-1.0.0.tgz', '1.0.0-x.TAR',
  'a.tar.gz', 'github:x/a', 'git+file:///ws/a.git', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', 'link:a', 'workspace:*', 'x@y', 'a#b', '%41',
  'NPM:a@1.0.0', '\t1.0.0', 'a\\b'];
const REGISTRY = ['', '*', 'latest', '1.0.0', '^1.2.3', '~1.2.3', '>=1 <2', '1.2.3 - 2.3.4', '^1 || ^2', '1.x', 'v1.0.0', '=1.0.0',
  '1.0.0-beta.1+build.5', ' 1.0.0', 'npm:a@^1.0.0', 'npm:@s/a@1.0.0', 'npm:a'];
// The labels are JSON, never a bare spec: a secret such as '.' or 'a' occurs in the fixed message itself.
const unsupported = (packages, label) => refused(() => admit([{ dir: 'secret-dir', bytes: lock(packages) }]), 'DEPENDENCY_SOURCE_UNSUPPORTED',
  JSON.stringify(label), 'secret-dir');
// Where DA6 and DA7 put one dependency map, beside the registry entries a and b: the root, a fetched entry, a bundled entry
// (nested, and bundled by the root) and an optional entry skipped for its os or for its cpu. npm re-resolves an unmet edge
// from any node, bundled and skipped ones included, so admission checks every entry's maps before it skips the entry.
const PLACES = {
  '': { name: 'fixture' }, 'node_modules/a': ok('a'), 'node_modules/a/node_modules/e': { version: '1.0.0', inBundle: true },
  'node_modules/e': { version: '1.0.0', inBundle: true }, 'node_modules/o': ok('o', { optional: true, os: ['darwin'] }),
  'node_modules/p': ok('p', { optional: true, cpu: ['arm64'] }),
};
const placed = (where, map, value) => ({ 'node_modules/a': ok('a'), 'node_modules/b': ok('b'), [where]: { ...PLACES[where], [map]: value } });

test('DA6 a non-registry or malformed dependency spec in any entry, the root, bundled and platform-skipped ones included, refuses with DEPENDENCY_SOURCE_UNSUPPORTED', () => {
  for (const where of Object.keys(PLACES)) {
    for (const map of DEPENDENCY_MAPS) {
      // One bad value refuses the whole map, in either key order beside a registry spec.
      for (const bad of [...NON_REGISTRY, 5, true, null, ['1.0.0'], {}]) {
        for (const value of [{ b: bad }, { a: '1.0.0', b: bad }, { b: bad, a: '1.0.0' }]) unsupported(placed(where, map, value), [where, map, value]);
      }
      for (const value of [null, [], 'b', 5]) unsupported(placed(where, map, value), [where, map, value]);
    }
  }
  for (const root of [5, null, [], 'x']) refused(() => admit([{ dir: '.', bytes: lock({ '': root }) }]), 'DEPENDENCY_LOCKFILE_INVALID', JSON.stringify(root));
});

test('DA7 registry-only or empty dependency maps on any entry, bundled entries with no resolved and a registry name@version, and falsy shrinkwrap flags are admitted, with the same packages', () => {
  const plain = { 'node_modules/a': ok('a'), 'node_modules/b': ok('b'),
    'node_modules/a/node_modules/c': { version: '1.0.0', inBundle: true, integrity: sri('c'), dependencies: { d: '^1.0.0' } } };
  const want = admit([{ dir: '.', bytes: lock(plain) }]);
  assert.deepEqual(want.packages.map(({ url }) => url).sort(), [regUrl('a'), regUrl('b')]);
  for (const map of DEPENDENCY_MAPS) {
    for (const spec of REGISTRY) {
      const packages = { ...plain, '': { name: 'fixture', [map]: { a: spec } }, 'node_modules/a': ok('a', { [map]: { b: spec } }) };
      assert.deepEqual(admit([{ dir: '.', bytes: lock(packages) }]), want, JSON.stringify([map, spec]));
    }
  }
  // Every DA6 placement admits as before with no map, an empty map or a multi-key map of registry specs only.
  const all = Object.fromEntries(REGISTRY.map((spec, i) => [`k${i}`, spec]));
  for (const where of Object.keys(PLACES)) {
    for (const map of DEPENDENCY_MAPS) {
      for (const value of [undefined, {}, { a: '^1.0.0', b: 'latest', c: 'npm:x@1.0.0' }, all]) {
        assert.deepEqual(admit([{ dir: '.', bytes: lock(placed(where, map, value)) }]), want, JSON.stringify([where, map, value]));
      }
    }
  }
  for (const key of ['hasShrinkwrap', '_hasShrinkwrap']) {
    for (const flag of [false, 0, '', null]) assert.deepEqual(admit([{ dir: '.', bytes: lock({ ...plain, 'node_modules/b': ok('b', { [key]: flag }) }) }]), want, `${key} ${flag}`);
  }
  // An npm alias keeps its real name; a version near a tarball suffix is still a registry version.
  for (const extra of [{}, { name: 'string-width', version: '4.2.3' }, { name: '@s/c', version: '1.0.0' }, { version: '1.0.0-tgz' },
    { version: '1.0.0-x.tgz.1+build.5' }]) {
    assert.deepEqual(admit([{ dir: '.', bytes: lock({ ...plain, 'node_modules/a/node_modules/c': { inBundle: true, ...extra } }) }]), want, JSON.stringify(extra));
  }
});

test('DA8 a bundled entry naming a resolved or _resolved, or a shrinkwrapped entry, refuses before any fetch or cache write', async t => {
  const bundled = extra => ({ version: '1.0.0', integrity: sri('stub'), inBundle: true, ...extra });
  const parent = { 'node_modules/a': ok('a', { dependencies: { e: '1.0.0' } }) };
  const rows = [];
  // node_modules/e is bundled by the root, so npm fetches it; node_modules/a/node_modules/e when a's tarball lacks it.
  for (const key of ['node_modules/e', 'node_modules/a/node_modules/e']) {
    for (const extra of [{ resolved: 'file:stub/e-1.0.0.tgz' }, { resolved: regUrl('e') }, { resolved: null }, { resolved: '' },
      { _resolved: 'file:stub/e-1.0.0.tgz' }, { _resolved: regUrl('e') }, { resolved: 'file:stub/e-1.0.0.tgz', optional: true, os: ['darwin'] }]) {
      rows.push({ ...parent, [key]: bundled(extra) });
    }
  }
  for (const key of ['hasShrinkwrap', '_hasShrinkwrap']) {
    for (const value of [true, 1, 'yes', {}, []]) {
      rows.push({ 'node_modules/a': ok('a', { [key]: value }) }, { ...parent, 'node_modules/a/node_modules/e': bundled({ [key]: value }) },
        { 'node_modules/o': ok('o', { optional: true, os: ['darwin'], [key]: value }) });
    }
  }
  // The two routes as filed: a lock root (and the matching package.json) naming a file: spec, and a root-level bundled file: entry.
  const filed = [{ '': { name: 'moe-kir', version: '1.0.0', dependencies: { a: 'file:stub/a-1.0.0.tgz' } }, 'node_modules/a': ok('a') },
    { '': { name: 'moe-kir', version: '1.0.0', dependencies: { a: '1.0.0' } }, 'node_modules/a': bundled({ resolved: 'file:stub/a-1.0.0.tgz' }) }];
  for (const packages of [...rows, ...filed]) unsupported(packages, packages);
  for (const packages of filed) {
    const server = fixtureFetch(servedBy({ a: tarball('a') }));
    const cacheDir = join(scratchDir(t), 'cache');
    await assert.rejects(buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lock(packages) }], cpu: 'x64', cacheDir }, { fetch: server.fetch }),
      dependencyRefusal('DEPENDENCY_SOURCE_UNSUPPORTED'));
    assert.deepEqual([server.calls, existsSync(cacheDir)], [[], false]);
  }
});

// task-adbab50d review: shapes the rules above still admitted, each measured installing workspace bytes with the pinned npm.
// npm fetches a root-bundled or bundle-missing entry naming no resolved from `${name}@${version}`, which a file: version, a
// name carrying a spec, or a semver version ending in a tarball suffix makes a file spec. npm-install-checks reads an
// empty os or cpu as no constraint, so the optional entry carrying one is installed and must not be skipped.
test('DA11 a bundled entry whose name@version is no registry spec, or an optional entry with an empty os or cpu, refuses with DEPENDENCY_SOURCE_UNSUPPORTED', () => {
  const parent = { 'node_modules/a': ok('a', { dependencies: { e: '*' } }) };
  for (const key of ['node_modules/e', 'node_modules/a/node_modules/e']) {
    for (const version of ['file:stub/e-1.0.0.tgz', '1.0.0-x.tgz', '1.0.0+b.tar', '1.0.0-a.tar.gz', '1.0.0-X.TGZ', ['file:stub/e-1.0.0.tgz'], ['1.0.0'], 1, null]) {
      unsupported({ ...parent, [key]: { version, inBundle: true } }, [key, version]);
    }
    for (const name of ['e@file:stub/x', 'e@file:stub/e-1.0.0.tgz#', 'e@1.0.0', 'stub/e', '../e', ['e@file:stub/x'], ['e'], null]) {
      unsupported({ ...parent, [key]: { name, version: '1.0.0', inBundle: true } }, [key, name]);
    }
  }
  for (const extra of [{ os: '' }, { cpu: '' }, { os: '', cpu: ['x64'] }, { os: ['linux'], cpu: '' }]) {
    unsupported({ 'node_modules/o': ok('o', { optional: true, resolved: 'file:stub/o-1.0.0.tgz', ...extra }) }, extra);
  }
});

// task-adbab50d review: three routes the earlier rows missed. With the pinned npm, each installed workspace bytes over a
// hoisted registry f once a mutant admission let it through: a file: spec beside a registry spec in the root's map, and one
// on a bundled entry or on a platform-skipped optional entry. Each must refuse before any fetch or cache write, though every
// registry tarball is served and the same lockfile with a registry spec there builds a tree.
test('DA12 a file: spec beside a registry spec, or on a bundled or platform-skipped entry, refuses before any fetch or cache write', async t => {
  const tarballs = Object.fromEntries(['a', 'f', 'o', 'x'].map(name => [name, tarball(name)]));
  const reg = (name, extra) => entryOf(name, tarballs[name], extra);
  const routes = [
    ['a mixed root map', 2, { '': { name: 'moe-mixed', version: '1.0.0', dependencies: { f: 'file:stub/f-1.0.0.tgz', x: '1.0.0' } },
      'node_modules/f': reg('f'), 'node_modules/x': reg('x') }],
    ['a bundled entry', 2, { '': { name: 'moe-bundled', version: '1.0.0', dependencies: { a: '1.0.0', f: '1.0.0' } },
      'node_modules/a': reg('a', { dependencies: { e: '1.0.0' }, bundleDependencies: ['e'] }), 'node_modules/f': reg('f'),
      'node_modules/a/node_modules/e': { version: '1.0.0', inBundle: true, dependencies: { f: 'file:../../../../stub/f-1.0.0.tgz' } } }],
    ['a platform-skipped entry', 1, { '': { name: 'moe-skipped', version: '1.0.0', dependencies: { f: '1.0.0' }, optionalDependencies: { o: '1.0.0' } },
      'node_modules/f': reg('f'), 'node_modules/o': reg('o', { optional: true, os: ['darwin'], dependencies: { f: 'file:../../stub/f-1.0.0.tgz' } }) }],
  ];
  for (const [label, fetched, packages] of routes) {
    unsupported(packages, label);
    const server = fixtureFetch(servedBy(tarballs));
    const cacheDir = join(scratchDir(t), 'cache');
    await assert.rejects(buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lock(packages) }], cpu: 'x64', cacheDir }, { fetch: server.fetch }),
      dependencyRefusal('DEPENDENCY_SOURCE_UNSUPPORTED'), label);
    assert.deepEqual([server.calls, existsSync(cacheDir)], [[], false], label);
    const honest = JSON.parse(JSON.stringify(packages).replace(/"file:[^"]*"/, '"1.0.0"'));
    const built = await buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lock(honest) }], cpu: 'x64', cacheDir }, { fetch: server.fetch });
    assert.deepEqual([built.packages, server.calls.length], [fetched, fetched], label);
  }
});

// CQ-R11e1: the host's pinned Node toolchain cache (rows TC1-TC7). Bodies come from an injected fetch over fixture
// routes, never the network; test manifests keep the shipped fixed URLs and swap in fixture sizes and hashes.
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchPinnedFile, MAX_AGENT_BINARY_BYTES } from '../local-runner/agent-cache.mjs';
import { fetchNodeToolchain, loadToolchainManifest, MAX_TOOLCHAIN_BYTES, validateToolchainManifest } from '../local-runner/toolchain-cache.mjs';

const RUNNER_DIR = fileURLToPath(new URL('../local-runner/', import.meta.url));
const TOOLCHAIN = JSON.parse(readFileSync(join(RUNNER_DIR, 'toolchain.json'), 'utf8'));
const FIXTURE_HOST = 'https://cdn.fixture.test';
const NODE_BYTES = Buffer.from('#!fixture node toolchain tarball\n'.repeat(64));
const TOOLCHAIN_MESSAGES = {
  TOOLCHAIN_INPUT_INVALID: 'The toolchain request was invalid.',
  TOOLCHAIN_MANIFEST_INVALID: 'The installed toolchain manifest is invalid or unavailable.',
  TOOLCHAIN_DOWNLOAD_FAILED: 'The pinned toolchain could not be downloaded.',
  TOOLCHAIN_CHECKSUM_MISMATCH: 'The toolchain did not match its pinned checksum.',
  TOOLCHAIN_TOO_LARGE: 'The toolchain exceeded its pinned size.',
  TOOLCHAIN_UNREADABLE: 'The cached toolchain could not be read.',
};
const PINNED_MESSAGES = {
  PINNED_INPUT_INVALID: 'The pinned download request was invalid.',
  PINNED_DOWNLOAD_FAILED: 'The pinned file could not be downloaded.',
  PINNED_CHECKSUM_MISMATCH: 'The pinned file did not match its checksum.',
  PINNED_TOO_LARGE: 'The pinned file exceeded its size bound.',
  PINNED_UNREADABLE: 'The cached pinned file could not be read.',
};
// A refusal carries only its fixed code and text, never a URL, a path or body bytes.
const refusedAs = (code, messages) => error => assert.deepEqual([error.code, error.message, Object.keys(error)], [code, messages[code], ['code']]) ?? true;
const scratchDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'moe-toolchain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const nodeUrl = arch => TOOLCHAIN.node[arch].url;
const flip = (bytes, at = 9) => { const copy = Buffer.from(bytes); copy[at] ^= 1; return copy; };

// An injected fetch over fixture routes: url -> [status, body chunks (an Error chunk fails the stream) or a thrown Error,
// headers, the response's final url (as if the fetch had followed redirects itself)]. Each call is [url, redirect, signal?].
function fixtureFetch(table) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url, init.redirect, init.signal instanceof AbortSignal]);
    const [status = 404, chunks = [], headers = {}, final = url] = table[url] ?? [];
    if (chunks instanceof Error) throw chunks;
    const queue = [...chunks];
    const body = new ReadableStream({ pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close(); else if (next instanceof Error) controller.error(next); else controller.enqueue(new Uint8Array(next));
    } }, { highWaterMark: 0 });
    return { ok: status >= 200 && status < 300, status, url: final, headers: new Headers(headers), body };
  };
  return { fetch, calls };
}
// url -> FIXTURE_HOST/hop/1 -> ... -> FIXTURE_HOST/hop/count, which serves chunks; every Location after the first is relative.
function redirected(url, count, chunks) {
  const stops = [url, ...Array.from({ length: count }, (_, at) => `${FIXTURE_HOST}/hop/${at + 1}`)];
  return Object.fromEntries(stops.map((stop, at) => [stop, at === count ? [200, chunks] : [302, [], { location: at ? `/hop/${at + 1}` : stops[1] }]]));
}
// The shipped manifest with one arch's sha256 and size swapped for the fixture's; its url stays the real template.
function toolchainAt(arch, bytes) {
  const manifest = structuredClone(TOOLCHAIN);
  Object.assign(manifest.node[arch], { sha256: sha(bytes), size: bytes.length });
  return manifest;
}
const keptAt = (cacheDir, bytes) => ({ file: join(cacheDir, `${sha(bytes)}.tar.xz`), sha256: sha(bytes), size: bytes.length, version: TOOLCHAIN.node.x64.version });
function toolchainCall(t, arch, manifest, table, cacheDir = join(scratchDir(t), 'toolchain cache')) {
  const server = fixtureFetch(table);
  return { server, cacheDir, result: fetchNodeToolchain({ arch, cacheDir }, { fetch: server.fetch, manifest }) };
}

test('TC1 the shipped toolchain manifest loads deep-frozen at the fixed nodejs.org template, on CI\'s Node major', async () => {
  const manifest = await loadToolchainManifest();
  assert.deepEqual(manifest, TOOLCHAIN);
  for (const node of [manifest, manifest.node, manifest.node.x64, manifest.node.arm64]) assert.ok(Object.isFrozen(node));
  const { version } = manifest.node.x64;
  for (const arch of ['x64', 'arm64']) {
    const entry = manifest.node[arch];
    assert.deepEqual([Object.keys(entry), entry.version], [['version', 'url', 'sha256', 'size'], version], arch);
    assert.equal(entry.url, `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz`, arch);
    assert.ok(entry.size <= MAX_TOOLCHAIN_BYTES, arch);
  }
  assert.equal(MAX_TOOLCHAIN_BYTES, 134_217_728);
  // The human's 2026-10-30 decision: the check VM runs CI's Node line, so every CI node-version is the pinned major.
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const lines = [...ci.matchAll(/node-version:\s*(\S+)/g)].map(match => match[1]);
  assert.ok(lines.length > 0);
  assert.deepEqual(lines, lines.map(() => `'${version.split('.')[0]}'`));
});

test('TC2 every off-shape toolchain manifest is TOOLCHAIN_MANIFEST_INVALID, through the validator, the fetch seam and the 64 KiB loader', async t => {
  const set = (key, value, arch = 'x64') => m => { m.node[arch][key] = value; };
  const url = nodeUrl('x64');
  const template = (bad, arch) => `https://nodejs.org/dist/v${bad}/node-v${bad}-linux-${arch}.tar.xz`;
  const versions = (bad, arches = ['x64', 'arm64']) => m => { for (const arch of arches) Object.assign(m.node[arch], { version: bad, url: template(bad, arch) }); };
  const cases = [
    ['an array', () => []], ['null', () => null], ['a string', () => 'manifest'], ['schemaVersion 2', m => { m.schemaVersion = 2; }],
    ['an extra top-level key', m => { m.mirror = FIXTURE_HOST; }], ['no node', m => { delete m.node; }], ['an extra tool', m => { m.npm = m.node; }],
    ['a missing arch', m => { delete m.node.arm64; }], ['an extra arch', m => { m.node.ia32 = m.node.x64; }],
    ...['version', 'url', 'sha256', 'size'].map(key => [`no ${key}`, m => { delete m.node.x64[key]; }]), ['an extra entry key', set('mirror', FIXTURE_HOST)],
    ['an http url', set('url', url.replace('https:', 'http:'))], ['another host', set('url', url.replace('nodejs.org', 'nodejs.org.fixture.test'))],
    ['another version in the url', set('url', url.replace(`/v${TOOLCHAIN.node.x64.version}/`, '/v1.0.0/'))], ['a .tar.gz', set('url', url.replace('.tar.xz', '.tar.gz'))],
    ['a query string', set('url', `${url}?x=1`)], ['a trailing slash', set('url', `${url}/`)], ["another arch's url", set('url', nodeUrl('arm64'))],
    ...['v24.22.2', '24.22', '24.22.2-rc.1', '024.1.0', '24.22.2/..'].map(bad => [`version ${bad}`, versions(bad)]),
    ['x64 and arm64 on different versions', versions('24.0.0', ['arm64'])],
    ['an uppercase sha256', set('sha256', TOOLCHAIN.node.x64.sha256.toUpperCase())], ['a 63-char sha256', set('sha256', 'a'.repeat(63))],
    ...[0, -1, 1.5, '1', MAX_TOOLCHAIN_BYTES + 1].map(size => [`size ${JSON.stringify(size)}`, set('size', size)]),
  ];
  for (const [label, change] of cases) {
    const manifest = structuredClone(TOOLCHAIN);
    const replaced = change(manifest);
    const bad = replaced === undefined ? manifest : replaced;
    assert.throws(() => validateToolchainManifest(bad), refusedAs('TOOLCHAIN_MANIFEST_INVALID', TOOLCHAIN_MESSAGES), label);
    const seam = toolchainCall(t, 'x64', bad, {});
    await assert.rejects(seam.result, refusedAs('TOOLCHAIN_MANIFEST_INVALID', TOOLCHAIN_MESSAGES), label);
    assert.deepEqual([seam.server.calls, existsSync(seam.cacheDir)], [[], false], label);
  }
  const dir = join(scratchDir(t), 'local-runner');
  cpSync(RUNNER_DIR, dir, { recursive: true });
  const copy = await import(pathToFileURL(join(dir, 'toolchain-cache.mjs')).href);
  const text = JSON.stringify(TOOLCHAIN);
  for (const [label, bytes, loads] of [['exactly 64 KiB', text.padEnd(65_536), true], ['64 KiB + 1', text.padEnd(65_537)], ['not JSON', 'pinned: no'], ['missing']]) {
    if (bytes === undefined) rmSync(join(dir, 'toolchain.json')); else writeFileSync(join(dir, 'toolchain.json'), bytes);
    if (loads) assert.deepEqual(await copy.loadToolchainManifest(), TOOLCHAIN, label);
    else await assert.rejects(copy.loadToolchainManifest(), refusedAs('TOOLCHAIN_MANIFEST_INVALID', TOOLCHAIN_MESSAGES), label);
  }
});

test('TC3 a tarball matching its pins is kept whole at <cacheDir>/<sha256>.tar.xz, after at most 5 https-only manual redirects', async t => {
  for (const [arch, hops, chunks] of [['x64', 0, [NODE_BYTES]], ['arm64', 5, [NODE_BYTES.subarray(0, 7), NODE_BYTES.subarray(7)]]]) {
    const table = redirected(nodeUrl(arch), hops, chunks);
    const { server, cacheDir, result } = toolchainCall(t, arch, toolchainAt(arch, NODE_BYTES), table);
    const want = keptAt(cacheDir, NODE_BYTES);
    const got = await result;
    assert.deepEqual([got, Object.keys(got), Object.isFrozen(got)], [want, ['file', 'sha256', 'size', 'version'], true], arch);
    assert.deepEqual(server.calls, Object.keys(table).map(stop => [stop, 'manual', true]), arch);
    assert.deepEqual([readdirSync(cacheDir), readFileSync(want.file)], [[`${want.sha256}.tar.xz`], NODE_BYTES], arch);
    if (process.platform !== 'win32') assert.deepEqual([statSync(want.file).mode & 0o777, statSync(cacheDir).mode & 0o777], [0o600, 0o700], arch);
  }
});

test('TC4 a mismatched, oversized, redirected-to-http or interrupted download fails closed and leaves no file', async t => {
  const url = nodeUrl('x64');
  const http = url.replace('https:', 'http:');
  for (const [label, table, code] of [
    ['bytes missing the sha256', { [url]: [200, [flip(NODE_BYTES)]] }, 'TOOLCHAIN_CHECKSUM_MISMATCH'],
    ['a short body', { [url]: [200, [NODE_BYTES.subarray(1)]] }, 'TOOLCHAIN_CHECKSUM_MISMATCH'],
    ['a declared length over the pin', { [url]: [200, [NODE_BYTES], { 'content-length': String(NODE_BYTES.length + 1) }] }, 'TOOLCHAIN_TOO_LARGE'],
    ['a streamed body over the pin', { [url]: [200, [NODE_BYTES, Buffer.from('x')]] }, 'TOOLCHAIN_TOO_LARGE'],
    ['a redirect to http', { [url]: [301, [], { location: http }], [http]: [200, [NODE_BYTES]] }, 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a redirect chain over 5', redirected(url, 6, [NODE_BYTES]), 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a redirect without a Location', { [url]: [302, []] }, 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a 404', {}, 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a thrown fetch', { [url]: [200, Object.assign(new Error(`${url} secret`), { code: 'ECONNRESET' })] }, 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a body that errors midway', { [url]: [200, [NODE_BYTES.subarray(0, 9), new Error(`${url} secret`)]] }, 'TOOLCHAIN_DOWNLOAD_FAILED'],
    ['a response whose url is http', { [url]: [200, [NODE_BYTES], {}, http] }, 'TOOLCHAIN_DOWNLOAD_FAILED'],
  ]) {
    const { server, cacheDir, result } = toolchainCall(t, 'x64', toolchainAt('x64', NODE_BYTES), table);
    await assert.rejects(result, refusedAs(code, TOOLCHAIN_MESSAGES), label);
    assert.deepEqual(readdirSync(cacheDir), [], label);
    assert.deepEqual(server.calls.filter(([target]) => !target.startsWith('https://')), [], label);
  }
});

test('TC5 a cache hit is re-verified without a fetch, a corrupt entry is refetched once, and a directory or symlink is never followed', async t => {
  const cacheDir = join(scratchDir(t), 'toolchain cache');
  const want = keptAt(cacheDir, NODE_BYTES);
  const get = (body = NODE_BYTES) => toolchainCall(t, 'x64', toolchainAt('x64', NODE_BYTES), { [nodeUrl('x64')]: [200, [body]] }, cacheDir);
  mkdirSync(cacheDir);
  writeFileSync(want.file, NODE_BYTES);
  const hit = get();
  assert.deepEqual([await hit.result, hit.server.calls.length], [want, 0]);
  for (const corrupt of [flip(NODE_BYTES), NODE_BYTES.subarray(1), Buffer.concat([NODE_BYTES, Buffer.from('x')])]) {
    writeFileSync(want.file, corrupt);
    const repair = get();
    assert.deepEqual([await repair.result, repair.server.calls.length, readFileSync(want.file), readdirSync(cacheDir)], [want, 1, NODE_BYTES, [`${want.sha256}.tar.xz`]]);
  }
  writeFileSync(want.file, flip(NODE_BYTES));
  const tampered = get(flip(NODE_BYTES));
  await assert.rejects(tampered.result, refusedAs('TOOLCHAIN_CHECKSUM_MISMATCH', TOOLCHAIN_MESSAGES));
  assert.deepEqual([tampered.server.calls.length, readdirSync(cacheDir)], [1, []]);
  // Two concurrent calls each write their own .part and rename atomically.
  const both = [1, 2].map(() => get());
  assert.deepEqual(await Promise.all(both.map(call => call.result)), [want, want]);
  assert.deepEqual([readdirSync(cacheDir), readFileSync(want.file), both.map(call => call.server.calls.length)], [[`${want.sha256}.tar.xz`], NODE_BYTES, [1, 1]]);
  rmSync(want.file);
  mkdirSync(want.file);
  const dir = get();
  await assert.rejects(dir.result, refusedAs('TOOLCHAIN_INPUT_INVALID', TOOLCHAIN_MESSAGES));
  assert.deepEqual([dir.server.calls.length, statSync(want.file).isDirectory()], [0, true]);
  if (process.platform === 'win32') return;
  rmSync(want.file, { recursive: true });
  const outside = join(cacheDir, '..', 'outside.tar.xz');
  writeFileSync(outside, NODE_BYTES);
  symlinkSync(outside, want.file);
  const link = get();
  await assert.rejects(link.result, refusedAs('TOOLCHAIN_INPUT_INVALID', TOOLCHAIN_MESSAGES));
  assert.deepEqual([link.server.calls.length, lstatSync(want.file).isSymbolicLink(), readFileSync(outside)], [0, true, NODE_BYTES]);
});

test('TC6 fetchPinnedFile verifies sha512 within maxBytes when size is null, and validates every option before any I/O', async t => {
  const blob = Buffer.from('fixture registry tarball\n'.repeat(40));
  const hex = bytes => createHash('sha512').update(bytes).digest('hex');
  const url = `${FIXTURE_HOST}/pkg/-/pkg-1.0.0.tgz`;
  const pinCall = (table, patch = {}, extra = {}) => {
    const dir = scratchDir(t);
    const server = fixtureFetch(table);
    const options = { url, file: join(dir, `${hex(blob)}.tgz`), size: null, maxBytes: blob.length + 7, algorithm: 'sha512', digest: hex(blob), ...patch };
    return { dir, server, options, result: fetchPinnedFile(options, { fetch: server.fetch, ...extra }) };
  };
  const kept = pinCall({ [url]: [200, [blob.subarray(0, 5), blob.subarray(5)]] });
  const got = await kept.result;
  assert.deepEqual([got, Object.keys(got), Object.isFrozen(got)], [{ file: kept.options.file, size: blob.length }, ['file', 'size'], true]);
  assert.deepEqual([readdirSync(kept.dir), readFileSync(kept.options.file), kept.server.calls], [[`${hex(blob)}.tgz`], blob, [[url, 'manual', true]]]);
  const hit = pinCall({}, { file: kept.options.file });
  assert.deepEqual([await hit.result, hit.server.calls.length], [got, 0]);
  // A cached file over a lowered maxBytes is no hit, even with its digest: it is removed and the refetch refused.
  const shrunk = pinCall({ [url]: [200, [blob]] }, { file: kept.options.file, maxBytes: blob.length - 1 });
  await assert.rejects(shrunk.result, refusedAs('PINNED_TOO_LARGE', PINNED_MESSAGES));
  assert.deepEqual([shrunk.server.calls.length, readdirSync(kept.dir)], [1, []]);
  const exact = pinCall({ [url]: [200, [blob]] }, { size: blob.length, maxBytes: blob.length });
  assert.deepEqual(await exact.result, { file: exact.options.file, size: blob.length });
  const over = Buffer.concat([blob, Buffer.alloc(8, 0x20)]);
  for (const [label, table, code, patch] of [
    ['a body over maxBytes', { [url]: [200, [over]] }, 'PINNED_TOO_LARGE', { digest: hex(over) }],
    ['a declared length over maxBytes', { [url]: [200, [blob], { 'content-length': String(blob.length + 8) }] }, 'PINNED_TOO_LARGE'],
    ['another digest', { [url]: [200, [flip(blob)]] }, 'PINNED_CHECKSUM_MISMATCH'],
    ['a body short of an exact size', { [url]: [200, [blob.subarray(1)]] }, 'PINNED_CHECKSUM_MISMATCH', { size: blob.length }],
    ['a 404', {}, 'PINNED_DOWNLOAD_FAILED'],
  ]) {
    const call = pinCall(table, patch);
    await assert.rejects(call.result, refusedAs(code, PINNED_MESSAGES), label);
    assert.deepEqual(readdirSync(call.dir), [], label);
  }
  for (const [label, patch, extra] of [
    ['an http url', { url: url.replace('https:', 'http:') }], ['a URL object', { url: new URL(url) }], ['a relative file', { file: 'pkg.tgz' }],
    ['a file with a control character', { file: join(tmpdir(), 'pkg\n.tgz') }], ['algorithm md5', { algorithm: 'md5' }],
    ['a sha256-length digest', { digest: sha(blob) }], ['an uppercase digest', { digest: hex(blob).toUpperCase() }],
    ['size over maxBytes', { size: blob.length + 8 }], ['size 0', { size: 0 }], ['an undefined size', { size: undefined }],
    ['maxBytes 0', { maxBytes: 0 }], ['maxBytes over MAX_AGENT_BINARY_BYTES', { maxBytes: MAX_AGENT_BINARY_BYTES + 1 }],
    ['a fetch that is not a function', {}, { fetch: url }],
  ]) {
    const call = pinCall({ [url]: [200, [blob]] }, patch, extra);
    await assert.rejects(call.result, refusedAs('PINNED_INPUT_INVALID', PINNED_MESSAGES), label);
    assert.deepEqual([call.server.calls, readdirSync(call.dir)], [[], []], label);
  }
  for (const options of [undefined, null, 'options']) await assert.rejects(fetchPinnedFile(options), refusedAs('PINNED_INPUT_INVALID', PINNED_MESSAGES));
});

test('TC7 invalid toolchain input is refused before any fetch or mkdir', async t => {
  const cacheDir = join(scratchDir(t), 'toolchain cache');
  const server = fixtureFetch({});
  const valid = { arch: 'x64', cacheDir };
  for (const [input, options] of [
    [undefined, {}], [null, {}], ['x64', {}], [[valid], {}], [{ ...valid, arch: 'ia32' }, {}], [{ ...valid, arch: 'constructor' }, {}],
    [{ ...valid, cacheDir: 'relative cache' }, {}], [{ ...valid, cacheDir: `${cacheDir}\n` }, {}], [valid, { fetch: nodeUrl('x64') }],
  ]) {
    await assert.rejects(fetchNodeToolchain(input, { fetch: server.fetch, manifest: toolchainAt('x64', NODE_BYTES), ...options }),
      refusedAs('TOOLCHAIN_INPUT_INVALID', TOOLCHAIN_MESSAGES), JSON.stringify([input, options]));
  }
  assert.deepEqual([server.calls, existsSync(cacheDir)], [[], false]);
});

// CQ-R11e3: the host's offline npm dependency cache (rows DC1-DC5). Tarballs come from an injected fetch over fixture
// routes; only DC5 runs the host's own npm, against a counting loopback registry that must see no request.
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter } from 'node:path';
import { gzipSync } from 'node:zlib';

// A minimal ustar archive (name, mode, size, typeflag, magic and checksum; two zero blocks at the end), gzipped.
const tgz = files => gzipSync(Buffer.concat([...Object.entries(files).flatMap(([name, text]) => {
  const [head, data] = [Buffer.alloc(512), Buffer.from(text)];
  head.write(name, 0);
  head.write('0000644\0', 100);
  head.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  head.write('0', 156);
  head.write('ustar\x0000', 257);
  head.fill(0x20, 148, 156);
  head.write(`${head.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return [head, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}), Buffer.alloc(1024)]));
const manifestOf = name => JSON.stringify({ name, version: '1.0.0' });
const tarball = name => tgz({ 'package/package.json': manifestOf(name) });
const sha512Hex = bytes => createHash('sha512').update(bytes).digest('hex');
const entryOf = (name, bytes, extra) => ok(name, { integrity: sri(bytes), ...extra });
const servedBy = tarballs => Object.fromEntries(Object.entries(tarballs).map(([name, bytes]) => [regUrl(name), [200, [bytes]]]));
const dependencyRefusal = code => refusedAs(code, { [code]: dependencyError(code).message });
const listing = dir => Object.fromEntries(readdirSync(dir, { recursive: true }).sort()
  .map(name => [name, statSync(join(dir, name)).isDirectory() ? 'dir' : sha(readFileSync(join(dir, name)))]));

test('DC1 input and admission refusals reach the caller before any fetch or cache write', async t => {
  const cacheDir = join(scratchDir(t), 'cache');
  const server = fixtureFetch({});
  const withEntry = entry => [{ dir: '.', bytes: lock({ 'node_modules/moe-fixture-a': ok('moe-fixture-a'), ...entry }) }];
  const good = { lockfiles: withEntry({}), cpu: 'x64', cacheDir };
  const sha1 = `sha1-${createHash('sha1').update('s').digest('base64')}`;
  for (const [label, input, code = 'DEPENDENCY_INPUT_INVALID', fetch = server.fetch] of [
    ['null', null], ['an array', [good]], ['an extra key', { ...good, extra: 1 }], ['no cacheDir', { lockfiles: good.lockfiles, cpu: 'x64' }],
    ['a relative cacheDir', { ...good, cacheDir: 'cache' }], ['an empty cacheDir', { ...good, cacheDir: '' }],
    ['a cacheDir with a control character', { ...good, cacheDir: `${cacheDir}\n` }], ['a fetch that is not a function', good, undefined, 'fetch'],
    ['a git entry', { ...good, lockfiles: withEntry({ 'node_modules/g': ok('g', { resolved: 'git+https://github.com/moe/g.git#0123abc' }) }) }, 'DEPENDENCY_SOURCE_UNSUPPORTED'],
    ['a sha1 integrity', { ...good, lockfiles: withEntry({ 'node_modules/s': ok('s', { integrity: sha1 }) }) }, 'DEPENDENCY_INTEGRITY_INVALID'],
    ['a key outside node_modules', { ...good, lockfiles: withEntry({ 'src/x': ok('x') }) }, 'DEPENDENCY_LOCATION_INVALID'],
  ]) {
    await assert.rejects(buildDependencyCache(input, { fetch }), dependencyRefusal(code), label);
  }
  await assert.rejects(buildDependencyCache(good, { get fetch() { throw new Error('getter-secret'); } }), dependencyRefusal('DEPENDENCY_INPUT_INVALID'));
  assert.deepEqual([server.calls, existsSync(cacheDir)], [[], false]);
});

test('DC2 a mismatched, oversized, http-redirected or interrupted tarball fails closed, keeps nothing and poisons nothing', async t => {
  const name = 'moe-fixture-a';
  const [url, bytes, chunk] = [regUrl(name), tarball(name), Buffer.alloc(2 ** 20, 0x61)];
  const http = url.replace('https:', 'http:');
  const build = (cacheDir, route) => buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lock({ [`node_modules/${name}`]: entryOf(name, bytes) }) }], cpu: 'x64', cacheDir },
    { fetch: fixtureFetch({ [url]: route, [http]: [200, [bytes]] }).fetch });
  for (const [label, route, code] of [
    ['another tarball', [200, [tarball('moe-fixture-c')]], 'DEPENDENCY_CHECKSUM_MISMATCH'],
    ['a declared length over the bound', [200, [bytes], { 'content-length': String(MAX_PACKAGE_BYTES + 1) }], 'DEPENDENCY_TOO_LARGE'],
    ['a streamed body over the bound', [200, Array(MAX_PACKAGE_BYTES / chunk.length + 1).fill(chunk)], 'DEPENDENCY_TOO_LARGE'],
    ['a redirect to http', [302, [], { location: http }], 'DEPENDENCY_DOWNLOAD_FAILED'],
    ['a body that errors after its first chunk', [200, [bytes.subarray(0, 9), new Error(`${url} secret`)]], 'DEPENDENCY_DOWNLOAD_FAILED'],
  ]) {
    const cacheDir = join(scratchDir(t), 'cache');
    await assert.rejects(build(cacheDir, route), error => {
      for (const secret of ['http', 'registry', cacheDir]) assert.ok(!error.message.includes(secret), label);
      return dependencyRefusal(code)(error);
    }, label);
    assert.deepEqual(readdirSync(cacheDir), [], label);
    assert.equal((await build(cacheDir, [200, [bytes]])).packages, 1, label);
  }
});

test('DC3 the tree is exactly the verified content-v2 files plus moe-dependencies.json, deterministic, deduplicated and reused', async t => {
  const tarballs = Object.fromEntries(['moe-fixture-a', '@moe-fixture/b', 'moe-fixture-c'].map(name => [name, tarball(name)]));
  const [a, b, c] = Object.values(tarballs);
  const lockfiles = [
    { dir: '.', bytes: lock({ 'node_modules/moe-fixture-a': entryOf('moe-fixture-a', a), 'node_modules/@moe-fixture/b': entryOf('@moe-fixture/b', b) }) },
    { dir: 'sub', bytes: lock({ 'node_modules/moe-fixture-c': entryOf('moe-fixture-c', c), 'node_modules/moe-fixture-c/node_modules/@moe-fixture/b': entryOf('@moe-fixture/b', b) }) },
  ];
  const cacheDir = join(scratchDir(t), 'cache');
  const build = (files, fetch) => buildDependencyCache({ lockfiles: files, cpu: 'x64', cacheDir }, { fetch });
  const content = data => ({ kind: 'file', executable: false, data, path: ((h) => `_cacache/content-v2/sha512/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4)}`)(sha512Hex(data)) });
  const tree = validateImport([...[a, b, c].map(content), { kind: 'file', path: 'moe-dependencies.json', executable: false, data: Buffer.from('{"version":1,"dirs":[".","sub"]}') }]);
  const want = { tree, digest: tree.digest, packages: 3, bytes: tree.entries.reduce((sum, { size }) => sum + size, 0) };
  const first = fixtureFetch(servedBy(tarballs));
  const result = await build(lockfiles, first.fetch);
  assert.deepEqual([result, first.calls.length], [want, 3]);
  for (const node of [result, result.tree, result.tree.entries, ...result.tree.entries]) assert.ok(Object.isFrozen(node));
  assert.deepEqual(readdirSync(cacheDir).sort(), [a, b, c].map(data => `${sha512Hex(data)}.tgz`).sort());
  if (process.platform !== 'win32') assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
  let offline = 0;
  assert.deepEqual(await build([...lockfiles].reverse(), async () => { offline += 1; throw new Error('offline'); }), want);
  assert.equal(offline, 0);
  // A kept file swapped for other bytes never reaches the tree: the downloader re-verifies it and refetches it once.
  writeFileSync(join(cacheDir, `${sha512Hex(b)}.tgz`), c);
  const repair = fixtureFetch(servedBy(tarballs));
  assert.deepEqual([await build(lockfiles, repair.fetch), repair.calls.map(([target]) => target)], [want, [regUrl('@moe-fixture/b')]]);
  // A kept entry that is no regular file is a cache failure, never followed and never refetched over.
  rmSync(join(cacheDir, `${sha512Hex(b)}.tgz`));
  mkdirSync(join(cacheDir, `${sha512Hex(b)}.tgz`));
  const blocked = fixtureFetch(servedBy(tarballs));
  await assert.rejects(build(lockfiles, blocked.fetch), dependencyRefusal('DEPENDENCY_CACHE_FAILED'));
  assert.deepEqual([blocked.calls, statSync(join(cacheDir, `${sha512Hex(b)}.tgz`)).isDirectory()], [[], true]);
});

test('DC4 OFFLINE_INSTALL_ARGS is the frozen offline npm ci flag set, and the byte bounds are fixed', () => {
  assert.deepEqual(OFFLINE_INSTALL_ARGS, ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--logs-max=0', '--workspaces=false']);
  assert.ok(Object.isFrozen(OFFLINE_INSTALL_ARGS));
  assert.deepEqual([MAX_PACKAGE_BYTES, MAX_DEPENDENCY_BYTES], [67_108_864, MAX_IMPORT_BYTES - 65_536]);
});

const NPM_CLI = join(dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['..', 'lib']), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const NO_NPM = (!existsSync(NPM_CLI) && 'the host has no npm-cli.js beside its node')
  || (!['x64', 'arm64'].includes(process.arch) && 'the guest cpu is x64 or arm64 only');

test('DC5 the host npm installs the fixture offline from the read-only tree, with no registry request and no script run', { skip: NO_NPM, timeout: 180_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'moe-dc5-'));
  const treeDir = join(base, 'tree');
  const chmodTree = (file, folder) => {
    for (const name of readdirSync(treeDir, { recursive: true })) chmodSync(join(treeDir, name), statSync(join(treeDir, name)).isDirectory() ? folder : file);
    chmodSync(treeDir, folder);
  };
  t.after(() => {
    if (existsSync(treeDir)) chmodTree(0o644, 0o755);
    rmSync(base, { recursive: true, force: true });
  });
  const tarballs = Object.fromEntries(['moe-fixture-a', '@moe-fixture/b', 'moe-fixture-aix'].map(name => [name, tarball(name)]));
  const [dependencies, optionalDependencies] = [{ 'moe-fixture-a': '1.0.0', '@moe-fixture/b': '1.0.0' }, { 'moe-fixture-aix': '1.0.0' }];
  const scripts = { postinstall: `node -e "require('fs').writeFileSync('root-ran.txt','x')"` };
  // The fixture project, optionally depending on more tarballs than the cache was built from.
  const fixture = (more = {}) => {
    const project = { name: 'moe-dc5', version: '1.0.0', dependencies: { ...dependencies, ...more }, optionalDependencies };
    const all = { ...tarballs, ...Object.fromEntries(Object.keys(more).map(name => [name, tarball(name)])) };
    return [{ ...project, scripts }, lock({ '': project, ...Object.fromEntries(Object.entries(all).map(([name, data]) => [`node_modules/${name}`,
      entryOf(name, data, name.endsWith('aix') ? { optional: true, os: ['aix'] } : {})])) })];
  };
  const [, bytes] = fixture();
  const { tree } = await buildDependencyCache({ lockfiles: [{ dir: '.', bytes }], cpu: process.arch, cacheDir: join(base, 'cache') }, { fetch: fixtureFetch(servedBy(tarballs)).fetch });
  for (const { path, data } of tree.entries) {
    mkdirSync(dirname(join(treeDir, path)), { recursive: true });
    writeFileSync(join(treeDir, path), data);
  }
  if (process.platform !== 'win32') chmodTree(0o444, 0o555);
  const before = listing(treeDir);
  const requests = [];
  const registry = createServer((request, response) => { requests.push(request.url); response.statusCode = 500; response.end(); });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => { registry.closeAllConnections(); registry.close(); });
  const home = join(base, 'home');
  mkdirSync(home);
  const win32 = process.platform === 'win32';
  const env = {
    PATH: [dirname(process.execPath), ...(win32 ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter),
    HOME: home, npm_config_registry: `http://127.0.0.1:${registry.address().port}/`,
    npm_config_userconfig: join(base, 'no-userconfig'), npm_config_globalconfig: join(base, 'no-globalconfig'),
    ...(win32 ? { USERPROFILE: home, TEMP: home, TMP: home, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  // Async on purpose: spawnSync would block the in-process registry, so a request would hang instead of being counted.
  const install = (name, args, more) => new Promise((resolve, reject) => {
    const [cwd, [project, lockfile]] = [join(base, name), fixture(more)];
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(project));
    writeFileSync(join(cwd, 'package-lock.json'), lockfile);
    const child = spawnChild(process.execPath, [NPM_CLI, 'ci', ...args, '--cache', treeDir], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ cwd, code, output }));
  });
  const plain = await install('project', OFFLINE_INSTALL_ARGS);
  assert.equal(plain.code, 0, plain.output);
  const installed = name => readFileSync(join(plain.cwd, 'node_modules', name, 'package.json'), 'utf8');
  assert.deepEqual([installed('moe-fixture-a'), installed('@moe-fixture/b'), existsSync(join(plain.cwd, 'node_modules', 'moe-fixture-aix'))],
    [manifestOf('moe-fixture-a'), manifestOf('@moe-fixture/b'), false]);
  assert.deepEqual([existsSync(join(plain.cwd, 'root-ran.txt')), requests, listing(treeDir)], [false, [], before]);
  // Positive control: without --ignore-scripts the root postinstall does run, so the marker's absence above is not vacuous.
  const control = await install('control', OFFLINE_INSTALL_ARGS.filter(arg => arg !== '--ignore-scripts'));
  assert.equal(control.code, 0, control.output);
  assert.deepEqual([existsSync(join(control.cwd, 'root-ran.txt')), requests, listing(treeDir)], [true, [], before]);
  // A tarball missing from the tree fails the install with still no registry request: --offline never falls back to it.
  const missing = await install('missing', OFFLINE_INSTALL_ARGS, { 'moe-fixture-c': '1.0.0' });
  assert.notEqual(missing.code, 0, missing.output);
  assert.deepEqual([requests, listing(treeDir)], [[], before]);
});

// task-5ed445ca with the real npm: the supervisor's own run_install and GUARD run the host's node and npm (the pinned
// toolchain in the gate) as the test user, netns False, over a tree buildDependencyCache built from an unchanged registry
// lock in which a depends on b, nested under it. A same-version candidate tarball named by a file: spec for a, or by an
// override for b, exits 82 with nothing installed, whether or not the tree holds the locked tarballs. Unguarded, npm
// 11.19.1 installs the file: spec's tarball. Under the override it kept the locked bytes (it refuses an override of a
// direct dependency and resolves the spec from a's folder), but overrides are refused outright all the same. The honest
// manifest installs the cached registry bytes, and no planted file changes.
test('KI8 with the real npm, a file: spec or override naming a same-version candidate tarball installs nothing, and the honest manifest installs the cached bytes',
  { skip: INSTALLS_RUN || NO_NPM, timeout: 180_000 }, async t => {
    if (busy(t)) return;
    const [a, b] = ['moe-fixture-a', 'moe-fixture-b'];
    const at = { [a]: ['node_modules', a], [b]: ['node_modules', a, 'node_modules', b] };
    const manifestA = JSON.stringify({ name: a, version: '1.0.0', dependencies: { [b]: '1.0.0' } });
    const cached = { [a]: tgz({ 'package/package.json': manifestA }), [b]: tarball(b) };
    const stubOf = name => tgz({ 'package/package.json': JSON.stringify({ name, version: '1.0.0', scripts: { postinstall: `node -e "require('fs').writeFileSync('../../stub-ran.txt','x')"` } }),
      'package/stub.txt': 'candidate bytes\n' });
    const project = { name: 'moe-ki8', version: '1.0.0', dependencies: { [a]: '1.0.0' } };
    const lockBytes = lock({ '': project, [at[a].join('/')]: entryOf(a, cached[a], { dependencies: { [b]: '1.0.0' } }), [at[b].join('/')]: entryOf(b, cached[b]) });
    const { tree } = await buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lockBytes }], cpu: process.arch, cacheDir: join(scratchDir(t), 'cache') },
      { fetch: fixtureFetch(servedBy(cached)).fetch });
    const full = Object.fromEntries(tree.entries.map(({ path, data }) => [path, Buffer.from(data)]));
    const run = (manifest, cache) => {
      const files = { 'package.json': bytesOf(manifest), 'package-lock.json': lockBytes, ...Object.fromEntries([a, b].map(name => [`stub/${name}-1.0.0.tgz`, stubOf(name)])) };
      const result = installRun(t, null, [], { toolchain: JSON.stringify(dirname(dirname(process.execPath))), timeout: 25,
        more: `plant(deps, ${pyFiles(cache)})\nplant(workspace, ${pyFiles(files)})\n` });
      const ws = join(result.dir, 'ws');
      const listed = name => existsSync(join(ws, ...at[name])) ? readdirSync(join(ws, ...at[name])).filter(file => file !== 'node_modules').sort() : null;
      return Object.assign(result, { kept: Object.entries(files).every(([file, bytes]) => readFileSync(join(ws, file)).equals(bytes)),
        installed: existsSync(join(ws, 'node_modules')) ? [a, b].map(listed) : null, ran: existsSync(join(ws, 'stub-ran.txt')),
        manifests: [a, b].map(name => listed(name) && readFileSync(join(ws, ...at[name], 'package.json'), 'utf8')) });
    };
    const honest = run(project, full);
    assert.deepEqual([honest.status, honest.stray, honest.relays.length, honest.kept, honest.installed, honest.manifests, honest.ran],
      [42, [], 1, true, [['package.json'], ['package.json']], [manifestA, manifestOf(b)], false], String(honest.stderr));
    const empty = { 'moe-dependencies.json': full['moe-dependencies.json'] };
    for (const [label, manifest] of [['a file: spec', { ...project, dependencies: { [a]: `file:stub/${a}-1.0.0.tgz` } }],
      ['an override', { ...project, overrides: { [b]: `file:../../stub/${b}-1.0.0.tgz` } }]]) {
      for (const [cacheLabel, cache] of [['the tree', full], ['an empty tree', empty]]) {
        const refused = run(manifest, cache);
        refusedInstall(refused, `${label} over ${cacheLabel}`, CANDIDATE);
        assert.deepEqual([refused.kept, refused.installed, refused.ran], [true, null, false], `${label} over ${cacheLabel}`);
      }
    }
    // task-42e9990c: the honest manifest over a tree missing its tarballs fails npm itself, offline: an infrastructure 81.
    const uncached = run(project, empty);
    refusedInstall(uncached, 'the honest manifest over an empty tree');
    assert.deepEqual([uncached.kept, uncached.ran], [true, false]);
  });

// task-adbab50d's oracle: every dependency spec, and every bundled entry's name@version, admission accepts resolves to the
// registry, or is refused, under the host npm's own npm-package-arg (13.0.2 in the pinned npm 11.19.1), over the fixed
// lists and a seeded spread of risky spellings.
import { createRequire } from 'node:module';
const npa = (() => { try { return createRequire(NPM_CLI)('npm-package-arg'); } catch { return null; } })();
test('DA9 a spec that admission accepts, as an edge or a bundled entry\'s name@version, is a registry spec, or one npm refuses, under the host npm\'s npm-package-arg', { skip: !npa && 'the host npm has no npm-package-arg' }, () => {
  const accepted = spec => { try { return admit([{ dir: '.', bytes: lock({ '': { name: 'fixture', dependencies: { a: spec } } }) }]) !== null; } catch { return false; } };
  const registry = spec => { try { return npa.resolve('a', spec, '/ws').registry === true; } catch { return true; } };
  let state = 0x9e3779b9;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const alphabet = "abvxX019.-_+*^~<>=| !'()tgzr/:@#%\\";
  const spread = Array.from({ length: 4000 }, () => Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join('') + (next() % 16 ? '' : '.tgz'));
  assert.deepEqual([REGISTRY.filter(spec => !accepted(spec)), NON_REGISTRY.filter(accepted)], [[], []]);
  assert.deepEqual([...REGISTRY, ...NON_REGISTRY, ...spread].filter(spec => accepted(spec) && !registry(spec)), []);
  assert.ok(spread.filter(accepted).length > 1000);
  // npm extracts a root-bundled or bundle-missing entry naming no resolved from `${name}@${version}`.
  const bundled = (name, version) => { try { return admit([{ dir: '.', bytes: lock({ 'node_modules/e': { name, version, inBundle: true } }) }]) !== null; } catch { return false; } };
  const fromRegistry = (name, version) => { try { return npa(`${name}@${version}`, '/ws').registry === true; } catch { return true; } };
  const ids = ['x', 'a', '1', '0', 'tgz', 'tar', 'gz', 'TGZ', 'Tar'];
  const id = () => Array.from({ length: 1 + (next() % 3) }, () => ids[next() % ids.length]).join('.');
  const semverish = Array.from({ length: 400 }, () => `${next() % 2}.${next() % 2}.${next() % 2}${['', `-${id()}`, `+${id()}`, `-${id()}+${id()}`][next() % 4]}`);
  const pairs = ['e', '@s/e', 'E', '~e', 'e.tgz', 'x.tar', 'e-1.0.0.tgz', '@s/e.tar.gz', 'e@file:stub/x', 'e@1.0.0', 'stub/e', '../e', 'file:e']
    .flatMap(name => [...REGISTRY, ...NON_REGISTRY, ...semverish].map(version => [name, version]));
  const admitted = pairs.filter(([name, version]) => bundled(name, version));
  assert.deepEqual(admitted.filter(([name, version]) => !fromRegistry(name, version)), []);
  assert.ok(admitted.length > 1000);
});

// task-adbab50d with the real npm: a registry tarball that bundles its dependency, the one bundled shape admission keeps
// (an inBundle entry with no resolved and a registry name@version), installs offline from the admitted tree through the
// supervisor's own run_install.
test('DA10 with the real npm, a bundled dependency inside an admitted tarball installs offline from the tree', { skip: INSTALLS_RUN || NO_NPM, timeout: 180_000 }, async t => {
  if (busy(t)) return;
  const [a, e] = ['moe-fixture-a', 'moe-fixture-e'];
  const bundler = tgz({ 'package/package.json': JSON.stringify({ name: a, version: '1.0.0', dependencies: { [e]: '^1.0.0' }, bundleDependencies: [e] }),
    [`package/node_modules/${e}/package.json`]: manifestOf(e), [`package/node_modules/${e}/bundled.txt`]: 'inside a\n' });
  const project = { name: 'moe-da10', version: '1.0.0', dependencies: { [a]: '1.0.0' } };
  const lockBytes = lock({ '': project, [`node_modules/${a}`]: entryOf(a, bundler, { dependencies: { [e]: '^1.0.0' }, bundleDependencies: [e] }),
    [`node_modules/${a}/node_modules/${e}`]: { version: '1.0.0', inBundle: true } });
  const { tree } = await buildDependencyCache({ lockfiles: [{ dir: '.', bytes: lockBytes }], cpu: process.arch, cacheDir: join(scratchDir(t), 'cache') },
    { fetch: fixtureFetch(servedBy({ [a]: bundler })).fetch });
  const full = Object.fromEntries(tree.entries.map(({ path, data }) => [path, Buffer.from(data)]));
  const files = { 'package.json': bytesOf(project), 'package-lock.json': lockBytes };
  const result = installRun(t, null, [], { toolchain: JSON.stringify(dirname(dirname(process.execPath))), timeout: 25,
    more: `plant(deps, ${pyFiles(full)})\nplant(workspace, ${pyFiles(files)})\n` });
  const bundled = join(result.dir, 'ws', 'node_modules', a, 'node_modules', e, 'bundled.txt');
  assert.deepEqual([result.status, result.relays.length, tree.entries.length, existsSync(bundled) && readFileSync(bundled, 'utf8')], [42, 1, 2, 'inside a\n'],
    String(result.stderr));
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECK_BOUNDARIES, checkEnvironment, evidenceStatus } from '../local-runner/check-evidence.mjs';

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

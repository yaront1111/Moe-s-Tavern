// Check environment identity for the isolated local-runner check path. CHECK_BOUNDARIES is the contract that the
// guest check mode (CQ-R11a/R11b) implements: a descriptor, not a measurement. Nothing here claims isolation;
// executionReady stays false and verified-local stays unavailable. Pure functions only: no provider call, no file
// read, no clock.
import { createHash } from 'node:crypto';
import { GUEST_LAYOUT, GUEST_RESOURCES, JOB_IDENTITIES } from './guest-bootstrap.mjs';

const ENVIRONMENT_PREFIX = 'moe-local-vm-v1:';
const INPUT_KEYS = ['providerImageHash', 'resources', 'sourceImageSha256', 'supervisorSha256'];
const RESOURCE_KEYS = Object.keys(GUEST_RESOURCES);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MESSAGE = 'Check environment input was invalid.';
const FRESHNESS_KEYS = ['environment', 'treeSha', 'definitionDigest', 'planRevision'];

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

// Each rlimit is both the soft and the hard limit; CQ-R11a applies exactly these through Python's resource module and
// its drift test pins them. There is no RLIMIT_AS, because V8 reserves large virtual ranges and the VM's memory size
// already bounds RAM. There is no RLIMIT_CPU, because the host enforces the wall-clock budget.
export const CHECK_BOUNDARIES = deepFreeze({
  identity: { user: JOB_IDENTITIES[1], supplementaryGroups: [], noNewPrivileges: true, umask: '077' },
  network: { namespace: 'private', interfaces: ['lo'] },
  resources: {
    vm: { ...GUEST_RESOURCES },
    rlimits: { RLIMIT_CORE: 0, RLIMIT_FSIZE: 1073741824, RLIMIT_NOFILE: 4096, RLIMIT_NPROC: 2048 },
  },
  process: { group: 'session', teardown: 'killed-and-reaped', vm: 'deleted-after-run' },
  filesystem: {
    vm: 'fresh-owned-per-run',
    home: { fresh: true, mode: '0700' },
    protectedPaths: { owner: 'root', verified: ['before-run', 'after-run'] },
    supervisorCredential: { path: GUEST_LAYOUT.credential, owner: 'root', mode: '0400', jobIdentities: 'readiness-denied' },
  },
  time: { budget: 'host-enforced' },
});

function refuse() { return Object.assign(new Error(MESSAGE), { code: 'CHECK_INPUT_INVALID' }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
// Compare the enumerable key SET, never count + hasOwn: a non-enumerable required key plus an enumerable extra key
// would otherwise pass.
function exactKeys(value, expected) {
  const own = Object.keys(value);
  return own.length === expected.length && expected.every(key => own.includes(key));
}
// typeof matters: the regex would coerce a String object.
function sha256Hex(value) { return typeof value === 'string' && SHA256_HEX.test(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 1; }

// Arrays keep their order; record keys are sorted by code unit at every depth; no whitespace.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A fresh, validated copy of the inputs, or null. Each value is read exactly once; only these locals are validated
// and hashed.
function validatedInputs(inputs) {
  if (!record(inputs) || !exactKeys(inputs, INPUT_KEYS)) return null;
  const { providerImageHash, resources, sourceImageSha256, supervisorSha256 } = inputs;
  if (!record(resources) || !exactKeys(resources, RESOURCE_KEYS)) return null;
  const { cpus, diskBytes, memoryBytes } = resources;
  if (![providerImageHash, sourceImageSha256, supervisorSha256].every(sha256Hex) || ![cpus, diskBytes, memoryBytes].every(count)) return null;
  return { providerImageHash, resources: { cpus, diskBytes, memoryBytes }, sourceImageSha256, supervisorSha256 };
}

/**
 * The exact environment identity of one check observation: a sha256 over CHECK_BOUNDARIES and the observed image,
 * supervisor and VM size. It fits CheckRun.environment, an opaque value the daemon compares exactly. The size is
 * shape-checked only, because the orchestrator may pass the observed size rather than GUEST_RESOURCES.
 */
export function checkEnvironment(inputs) {
  let checked = null;
  // An accessor or Proxy trap that throws is refused like any other bad input, without its message.
  try { checked = validatedInputs(inputs); } catch { /* refused below */ }
  if (checked === null) throw refuse();
  return ENVIRONMENT_PREFIX + createHash('sha256').update(canonicalJson({ boundaries: CHECK_BOUNDARIES, inputs: checked })).digest('hex');
}

// The four freshness fields of one record, or null when any is missing. Only own properties count, each is read once,
// and a hostile accessor that throws makes the record missing rather than crashing the caller.
function freshnessFields(value) {
  if (value === null || value === undefined) return null;
  try {
    const fields = [];
    for (const key of FRESHNESS_KEYS) {
      if (!Object.hasOwn(value, key)) return null;
      const field = value[key];
      if (key === 'planRevision' ? !count(field) : typeof field !== 'string' || field === '') return null;
      fields.push(field);
    }
    return fields;
  } catch {
    return null;
  }
}

/**
 * 'fresh' only when environment, treeSha, definitionDigest and planRevision are all present on both records and
 * strictly equal. Anything else is 'stale', which means new evidence is required. Never throws; extra keys such as
 * outcome or exitCode are ignored. treeSha and definitionDigest are opaque and compared exactly, like CheckRun's.
 */
export function evidenceStatus(observation, current) {
  const seen = freshnessFields(observation);
  const wanted = freshnessFields(current);
  return seen !== null && wanted !== null && seen.every((field, index) => field === wanted[index]) ? 'fresh' : 'stale';
}

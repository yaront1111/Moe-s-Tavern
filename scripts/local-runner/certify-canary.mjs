// Canary certify check (CQ-R13g): 'canary-check' runs a real check end to end in fresh check VMs, beside certify's main VM,
// which it never touches: the pinned Node toolchain, an offline install of ONE pinned registry package from a lockfile, the
// approved `npm test`, then the outcome and the environment identity. The project is generated in memory, since the bundles
// exclude fixtures/, and the package's resolved URL and sha512 integrity are literal pins. The native operator run needs host
// network for the toolchain and the one tarball. Certification is not activation: executionReady stays false and
// verified-local stays unavailable. Every outcome is a fixed code, and no guest byte, path or credential reaches the report.
import { createHash, randomBytes } from 'node:crypto';
import { checkEnvironment } from './check-evidence.mjs';
import { runCheckJob } from './check-lifecycle.mjs';
import { runCheckSession } from './check-session.mjs';
import { buildDependencyCache } from './dependency-cache.mjs';
import { GUEST_RESOURCES, IMAGE_ARCHES } from './guest-bootstrap.mjs';
import { provisionGuest } from './provision.mjs';
import { validateImport } from './source-snapshot.mjs';
import { loadToolchainManifest } from './toolchain-cache.mjs';

/** is-number@7.0.0: no dependencies, no install script, no os or cpu field; its tarball is 3730 bytes. */
export const CANARY_PACKAGE = Object.freeze({ name: 'is-number', version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
  integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==' });
export const CANARY_CHECK = Object.freeze({ id: 'certify-canary', command: 'npm test', protected: Object.freeze([]) });
export const CANARY_BUDGET_MS = 600_000;
const ROOT = Object.freeze({ name: 'moe-certify-canary', version: '1.0.0' });
const DEPENDENCIES = Object.freeze({ [CANARY_PACKAGE.name]: CANARY_PACKAGE.version });
// The pinned digest with its first byte flipped: well-formed, so admission accepts it, and only the tarball re-hash can refuse it.
const ALTERED = (() => {
  const digest = Buffer.from(CANARY_PACKAGE.integrity.slice('sha512-'.length), 'base64');
  digest[0] ^= 0x01;
  return `sha512-${digest.toString('base64')}`;
})();
// [the test's assertion, the lockfile's integrity] per variant.
const VARIANTS = Object.freeze({ pass: ['true', CANARY_PACKAGE.integrity], fail: ['false', CANARY_PACKAGE.integrity], altered: ['true', ALTERED] });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const passed = Object.freeze({ result: 'passed', code: null });
const failed = code => Object.freeze({ result: 'failed', code });

/** A fresh version-1 SourceSnapshot of the canary project, 'pass', 'fail' (its test asserts false) or 'altered' (a wrong integrity). */
export function canarySnapshot(variant) {
  if (!Object.hasOwn(VARIANTS, variant)) throw new TypeError('Unknown canary variant.');
  const [assertion, integrity] = VARIANTS[variant];
  const { name, version, resolved } = CANARY_PACKAGE;
  const files = {
    'package.json': json({ ...ROOT, private: true, scripts: { test: 'node canary.test.js' }, dependencies: DEPENDENCIES }),
    // The root '' entry mirrors package.json, as `npm ci` requires.
    'package-lock.json': json({ ...ROOT, lockfileVersion: 3, requires: true, packages: { '': { ...ROOT, dependencies: DEPENDENCIES },
      [`node_modules/${name}`]: { version, resolved, integrity } } }),
    'canary.test.js': `'use strict';\nconst assert = require('node:assert');\nconst isNumber = require('is-number');\nassert.strictEqual(isNumber(42), ${assertion});\n`,
  };
  return Object.freeze({ version: 1, overlay: validateImport([]),
    base: validateImport(Object.entries(files).map(([path, text]) => ({ kind: 'file', path, executable: false, data: Buffer.from(text) }))) });
}

// One run of `variant` in its own fresh check VM, with a fresh owner and credential. context: platform (observed), ledger (the
// base one), cacheDir, supervisor (the real bytes), provider. deps.canary = { runCheckJob, steps } is a test-only seam, absent
// natively. runCheckJob's provision, dependencies and session steps pass through wrappers that change no argument, result or
// rejection, so `seen` holds this run's own verified guest, dependency cache and session count.
async function observedRun(c, variant) {
  const seen = { guest: null, cache: null, sessions: 0 };
  const base = c.deps?.canary?.steps ?? {};
  const job = c.deps?.canary?.runCheckJob ?? runCheckJob;
  const steps = {
    provision: async input => (seen.guest = await (base.provision ?? provisionGuest)(input)),
    dependencies: async input => (seen.cache = await (base.dependencies ?? buildDependencyCache)(input)),
    session: input => { seen.sessions += 1; return (base.session ?? runCheckSession)(input); },
  };
  const result = await job({ platform: c.platform, ledger: c.ledger, owner: { taskId: 'task-certify', attemptId: `attempt-${randomBytes(16).toString('hex')}`, generation: 1 },
    cacheDir: c.cacheDir, supervisor: c.supervisor, credential: randomBytes(32), snapshot: canarySnapshot(variant), check: CANARY_CHECK, budgetMs: CANARY_BUDGET_MS,
    onReady: async () => {}, dependencies: ['.'], provider: c.provider }, steps);
  return { result, seen };
}

// The identity runCheckJob must have hashed for this run: its own verified image, the real supervisor's sha256 (bootstrap installs
// exactly those bytes and readiness verifies them), the launch size, the pinned toolchain for the guest's arch and the installed
// tree's digest. null, which never matches, when the guest has no known arch or no dependency digest was seen.
async function expected(c, { guest, cache }) {
  try {
    const arch = guest?.image?.source?.arch;
    if (!IMAGE_ARCHES.includes(arch) || typeof cache?.digest !== 'string') return null;
    return checkEnvironment({ sourceImageSha256: guest.image.source.sha256, providerImageHash: guest.image.provider.imageHash,
      supervisorSha256: createHash('sha256').update(c.supervisor).digest('hex'), resources: GUEST_RESOURCES,
      toolchainSha256: (await loadToolchainManifest()).node[arch].sha256, dependencyDigest: cache.digest });
  } catch { return null; }
}

// Each run's verdict: a fixed code, or null when it holds.
const VERDICTS = [
  ['pass', async (result, seen, c) => {
    if (result?.outcome !== 'passed') return 'CERTIFY_CANARY_NOT_PASSED';
    if (result?.workspace !== 'intact') return 'CERTIFY_CANARY_WORKSPACE_NOT_INTACT';
    const identity = await expected(c, seen);
    return typeof identity === 'string' && result?.environment === identity ? null : 'CERTIFY_CANARY_ENVIRONMENT_MISMATCH';
  }],
  ['fail', async result => (result?.outcome === 'code-failure' ? null : 'CERTIFY_CANARY_FAILURE_NOT_DETECTED')],
  // Exactly the re-hash refusal, before any session: a download failure or an admission code proves nothing about integrity.
  ['altered', async (result, seen) => (result?.outcome === 'infra-failure' && result?.failure === 'DEPENDENCY_CHECKSUM_MISMATCH' && seen.sessions === 0 ? null
    : 'CERTIFY_CANARY_INTEGRITY_NOT_REFUSED')],
];

// The runs in order; the first that does not hold stops the check, since each costs a VM lifecycle. A runCheckJob rejection
// keeps its own code, which certify records.
async function canary(c) {
  for (const [variant, verdict] of VERDICTS) {
    const { result, seen } = await observedRun(c, variant);
    if (result?.vm !== 'deleted') return failed('CERTIFY_CANARY_VM_NOT_DELETED');
    const code = await verdict(result, seen, c);
    if (code !== null) return failed(code);
  }
  return passed;
}

/** Spliced into certify.mjs's BODY after LIFECYCLE_CHECKS, before 'teardown'. */
export const CANARY_CHECKS = Object.freeze([Object.freeze({ id: 'canary-check', run: canary })]);

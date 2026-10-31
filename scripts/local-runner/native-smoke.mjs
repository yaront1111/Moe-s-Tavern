// Native provider smoke: the ONLY evidence that can establish a platform's provider support. It provisions one
// owned guest through this host's own platform module, then always deletes it by its exact owned name (other
// attempts' records in the workDir are preserved). It launches a real VM and may download the ~600 MB pinned
// image, so it is operator-invoked on real hardware, never CI; CQ-R13 consumes its evidence. Mocks and skips
// cannot establish support: the injectable core always reports 'injected', and the native entry takes exactly
// { workDir }. A passed smoke is provider support evidence, never isolation certification (no executionReady).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { platformFor } from './cli.mjs';
import { cleanupOwned, createLedger } from './lifecycle.mjs';
import { provisionGuest } from './provision.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;
const SUPERVISOR = Buffer.from('#!/bin/sh\nexit 0\n');
const MESSAGES = { NATIVE_SMOKE_INPUT_INVALID: 'Native smoke options must be exactly { workDir: <absolute path> }.',
  NATIVE_SMOKE_UNSUPPORTED_HOST: 'This host has no platform module; provider support cannot be established here.' };
const smokeError = code => Object.assign(new Error(MESSAGES[code]), { code });
const stableCode = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'NATIVE_SMOKE_FAILED');

async function smoke(platform, workDir, deps, native) {
  const ledger = createLedger(path.join(workDir, 'ledger'), { random: deps.random });
  // A synthetic identity per run.
  const owner = { taskId: 'task-nativesmoke', attemptId: `attempt-${randomBytes(16).toString('hex')}`, generation: 1 };
  const provider = { ...deps.provider, executable: deps.provider?.executable ?? platform.executable };
  let arch = platform.arch ?? null;
  // Records the arch this run's prerequisites detected (macOS reads its hardware).
  const observed = { ...platform, prerequisites: async options => { const pre = await platform.prerequisites(options); arch = pre?.arch ?? arch; return pre; } };
  let [outcome, failures] = [null, []];
  try {
    outcome = await provisionGuest({ platform: observed, ledger, owner, cacheDir: path.join(workDir, 'images'), supervisor: SUPERVISOR,
      credential: randomBytes(32), provider, fetch: deps.fetch, digest: deps.digest, sleep: deps.sleep });
    if (Array.isArray(outcome?.failures)) failures = [...outcome.failures];
  } catch (error) { failures = [stableCode(error)]; }
  // Always runs: only this run's attempt is closed, so other records in the workDir are preserved.
  const cleanup = await cleanupOwned({ ledger, provider, attemptPhase: id => (id === owner.attemptId ? 'closed' : null), leaseHeld: () => false })
    .then(report => (report.errors.length > 0 ? 'failed' : report.deleted.length > 0 ? 'deleted' : 'none'), () => 'failed');
  const result = outcome === null ? 'failed' : outcome?.provisioned !== true ? 'blocked' : outcome.bootstrapReady === true ? 'passed' : 'failed';
  const passed = result === 'passed';
  return {
    kind: 'native-provider-smoke', platform: platform.id, arch, result, transport: native ? 'native' : 'injected',
    supportEstablished: native && passed && cleanup === 'deleted', bootstrapReady: passed,
    image: passed ? { sourceSha256: outcome.image?.source?.sha256 ?? null, providerImageHash: outcome.image?.provider?.imageHash ?? null } : null,
    failures, cleanup,
  };
}

/** Injected transports (tests): {provider, fetch, digest, sleep, random}. Its evidence can never establish support. */
export function nativeSmokeCore({ platform, workDir, deps = {} } = {}) {
  return smoke(platform, workDir, deps, false);
}

/** The operator's native run on this host's own platform module; options are exactly { workDir }. */
export async function runNativeProviderSmoke(options) {
  const keys = options !== null && typeof options === 'object' && !Array.isArray(options) ? Reflect.ownKeys(options) : [];
  const workDir = keys.length === 1 && keys[0] === 'workDir' ? options.workDir : undefined;
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir) || CONTROL.test(workDir)) throw smokeError('NATIVE_SMOKE_INPUT_INVALID');
  const platform = platformFor(process.platform);
  if (!platform) throw smokeError('NATIVE_SMOKE_UNSUPPORTED_HOST');
  return smoke(platform, workDir, {}, true);
}

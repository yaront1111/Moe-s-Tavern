import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';
import * as profile from './executionProfile.js';
import * as policy from './policy.js';

const PROFILES = ['legacy', 'observe', 'verified-local'] as const;
const POLICIES = ['legacy', 'local-branch', 'remote-push', 'merged-pull-request', 'manual-artifact'] as const;
const V1_KEYS = ['version', 'profile', 'planRevision'];
const V2_KEYS = ['version', 'profile', 'planRevision', 'deliveryPolicy'];
const COMBOS = PROFILES.flatMap(p => POLICIES.map(d => [p, d] as const));

type Raw = Record<string, unknown>;
const v1 = (overrides: Raw = {}): Raw => ({ version: 1, profile: 'verified-local', planRevision: 3, ...overrides });
const v2 = (overrides: Raw = {}): Raw =>
  ({ version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch', ...overrides });

function withoutKey(key: string): Raw {
  const snapshot = v2();
  delete snapshot[key];
  return snapshot;
}

function nonEnumerable(key: string): Raw {
  const snapshot = withoutKey(key);
  Object.defineProperty(snapshot, key, { value: v2()[key], enumerable: false });
  return snapshot;
}

/** Enumerable key count stays exact while a required key is hidden: only the enumerable set may count. */
function hidingExtra(key: string): Raw {
  const snapshot = nonEnumerable(key);
  snapshot.ready = true;
  return snapshot;
}

class SnapshotLike {
  version = 2;
  profile = 'legacy';
  planRevision = 0;
  deliveryPolicy = 'legacy';
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

afterEach(() => vi.unstubAllEnvs());

describe('v2 execution policy snapshot decoding', () => {
  it.each(COMBOS)('accepts exact v2 %s / %s across the revision domain', (p, d) => {
    for (const planRevision of [0, Number.MAX_SAFE_INTEGER]) {
      const input = { version: 2, profile: p, planRevision, deliveryPolicy: d };
      const decoded = profile.readExecutionPolicySnapshot(input);
      expect(decoded).toStrictEqual({ version: 2, profile: p, planRevision, deliveryPolicy: d });
      expect(decoded).not.toBe(input);
      expect(Object.keys(decoded!)).toEqual(V2_KEYS);
    }
  });

  it('accepts a null-prototype exact v2 and returns a plain copy', () => {
    const input = Object.assign(Object.create(null) as Raw, v2());
    const decoded = profile.readExecutionPolicySnapshot(input);
    expect(decoded).toStrictEqual(v2());
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  const malformed: Array<[string, unknown, string]> = [
    ['deliveryPolicy missing', withoutKey('deliveryPolicy'), 'executionPolicySnapshot'],
    ['deliveryPolicy null', v2({ deliveryPolicy: null }), 'executionPolicySnapshot.deliveryPolicy'],
    ['deliveryPolicy own undefined', v2({ deliveryPolicy: undefined }), 'executionPolicySnapshot.deliveryPolicy'],
    ...['', 'LOCAL-BRANCH', ' local-branch', 'toString', 'hasOwnProperty', 'constructor', 1, true, {}, []]
      .map((d): [string, unknown, string] => [`deliveryPolicy ${JSON.stringify(d)}`, v2({ deliveryPolicy: d }), 'executionPolicySnapshot.deliveryPolicy']),
    ['deliveryPolicy non-enumerable', nonEnumerable('deliveryPolicy'), 'executionPolicySnapshot'],
    ['non-enumerable deliveryPolicy hiding an extra key', hidingExtra('deliveryPolicy'), 'executionPolicySnapshot'],
    ['non-enumerable planRevision hiding an extra key', hidingExtra('planRevision'), 'executionPolicySnapshot'],
    ['profile null', v2({ profile: null }), 'executionPolicySnapshot.profile'],
    ['profile VERIFIED-LOCAL', v2({ profile: 'VERIFIED-LOCAL' }), 'executionPolicySnapshot.profile'],
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3', null]
      .map((r): [string, unknown, string] => [`planRevision ${String(r)}`, v2({ planRevision: r }), 'executionPolicySnapshot.planRevision']),
    ...['ready', 'approved', 'certified', 'verified', 'requiredCheck', 'destination']
      .map((k): [string, unknown, string] => [`extra ${k}`, { ...v2(), [k]: true }, 'executionPolicySnapshot']),
    ...[0, 3, '2', 1.5, null, true]
      .map((v): [string, unknown, string] => [`version ${JSON.stringify(v)}`, v2({ version: v }), 'executionPolicySnapshot.version']),
    ['version absent', withoutKey('version'), 'executionPolicySnapshot.version'],
    ['inherited fields', Object.create(v2()), 'executionPolicySnapshot'],
    ['class instance', new SnapshotLike(), 'executionPolicySnapshot'],
  ];

  it.each(malformed)('fails closed on %s, never defaulting to legacy', (_label, snapshot, field) => {
    expect(() => profile.readExecutionPolicySnapshot(snapshot)).toThrow(field);
    expect(() => profile.resolveTaskExecutionProfile({ executionProfile: 'legacy' }, snapshot)).toThrow('executionPolicySnapshot');
  });
});

describe('v1 snapshot compatibility', () => {
  it.each(PROFILES)('decodes exact v1 %s without a deliveryPolicy', p => {
    const decoded = profile.readExecutionPolicySnapshot(v1({ profile: p }));
    expect(decoded).toStrictEqual({ version: 1, profile: p, planRevision: 3 });
    expect(Object.keys(decoded!)).toEqual(V1_KEYS);
    expect(Object.prototype.hasOwnProperty.call(decoded, 'deliveryPolicy')).toBe(false);
  });

  it.each([...POLICIES, null, undefined])('rejects a version-1 snapshot carrying deliveryPolicy %j', d => {
    expect(() => profile.readExecutionPolicySnapshot(v1({ deliveryPolicy: d }))).toThrow('executionPolicySnapshot');
  });
});

describe('no manufactured delivery identity', () => {
  it.each(POLICIES)('a v1 verified-local snapshot stays policy-less under live deliveryPolicy %s', deliveryPolicy => {
    const settings = Object.freeze({ executionProfile: 'legacy', deliveryPolicy });
    const snapshot = v1();
    expect(profile.readExecutionPolicySnapshot(snapshot)).toStrictEqual(v1());
    expect(profile.readCapturedDeliveryPolicy(snapshot)).toBeUndefined();
    expect(profile.resolveTaskExecutionProfile(settings, snapshot)).toBe('verified-local');
  });

  it('reads no captured policy for an absent snapshot and takes no settings', () => {
    expect(profile.readCapturedDeliveryPolicy(undefined)).toBeUndefined();
    expect(profile.readCapturedDeliveryPolicy.length).toBe(1);
  });

  it.each(COMBOS)('reads exactly the captured v2 %s / %s policy', (p, d) => {
    expect(profile.readCapturedDeliveryPolicy(v2({ profile: p, deliveryPolicy: d }))).toBe(d);
  });

  it.each([null, {}, v2({ deliveryPolicy: null }), withoutKey('deliveryPolicy'), v1({ deliveryPolicy: 'legacy' })])(
    'fails closed reading a captured policy from %j', raw => {
      expect(() => profile.readCapturedDeliveryPolicy(raw)).toThrow('executionPolicySnapshot');
    });
});

describe('detached snapshot copies', () => {
  it.each([['frozen', true], ['unfrozen', false]] as const)('decoded copies never alias a %s original', (_label, freeze) => {
    for (const make of [() => v1(), () => v2()]) {
      const original = freeze ? Object.freeze(make()) : make();
      const decoded = profile.readExecutionPolicySnapshot(original) as unknown as Raw;
      expect(decoded).not.toBe(original);
      decoded.profile = 'legacy';
      decoded.planRevision = 99;
      decoded.deliveryPolicy = 'remote-push';
      decoded.extra = true;
      expect(original).toStrictEqual(make());
      expect(profile.readExecutionPolicySnapshot(original)).toStrictEqual(make());
    }
  });

  it('captures distinct objects without touching frozen settings', () => {
    const settings = Object.freeze({ executionProfile: 'observe', deliveryPolicy: 'local-branch' });
    const first = policy.captureExecutionPolicySnapshot(settings, 4);
    const second = policy.captureExecutionPolicySnapshot(settings, 4);
    expect(first).not.toBe(second);
    (first as unknown as Raw).deliveryPolicy = 'remote-push';
    first.planRevision = 9;
    (first as unknown as Raw).extra = true;
    expect(second).toStrictEqual({ version: 2, profile: 'observe', planRevision: 4, deliveryPolicy: 'local-branch' });
    expect(settings).toStrictEqual({ executionProfile: 'observe', deliveryPolicy: 'local-branch' });
  });

  it('does not copy symbol keys from an input', () => {
    const tag = Symbol('tag');
    const decoded = profile.readExecutionPolicySnapshot({ ...v2(), [tag]: 'x' })!;
    expect(Object.getOwnPropertySymbols(decoded)).toEqual([]);
    expect(decoded).toStrictEqual(v2());
  });
});

describe('captureExecutionPolicySnapshot', () => {
  it.each([undefined, null, {}, { deliveryPolicy: null }])('captures absent configuration %j as the live defaults', settings => {
    expect(policy.captureExecutionPolicySnapshot(settings, 0))
      .toStrictEqual({ version: 2, profile: 'legacy', planRevision: 0, deliveryPolicy: 'legacy' });
  });

  it.each(COMBOS)('captures %s / %s exactly from frozen settings', (p, d) => {
    const captured = policy.captureExecutionPolicySnapshot(Object.freeze({ executionProfile: p, deliveryPolicy: d }), 7);
    expect(captured).toStrictEqual({ version: 2, profile: p, planRevision: 7, deliveryPolicy: d });
    expect(Object.keys(captured)).toEqual(V2_KEYS);
    expect(profile.readExecutionPolicySnapshot(JSON.parse(JSON.stringify(captured)))).toStrictEqual(captured);
  });

  it('refuses an unknown live deliveryPolicy with the existing message', () => {
    expect(thrownMessage(() => policy.captureExecutionPolicySnapshot({ deliveryPolicy: 'strict' }, 0))).toBe(
      '[INVALID_INPUT] Invalid deliveryPolicy: must be one of legacy, local-branch, remote-push, merged-pull-request, manual-artifact (got "strict")');
  });

  it.each([null, 'VERIFIED'])('refuses a malformed live executionProfile %j', executionProfile => {
    expect(() => policy.captureExecutionPolicySnapshot({ executionProfile }, 0)).toThrow('executionProfile');
  });

  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, '1'])('refuses planRevision %s instead of deriving one', planRevision => {
    expect(() => policy.captureExecutionPolicySnapshot({}, planRevision as number)).toThrow('executionPolicySnapshot.planRevision');
  });
});

describe('live delivery policy stays unchanged', () => {
  const stubState = (settings: Raw) => ({ project: { settings } }) as unknown as StateManager;
  const reviewTask = (snapshot: unknown) =>
    ({ id: 'task-snapshot', status: 'REVIEW', commits: [], executionPolicySnapshot: snapshot }) as unknown as Task;

  it('keeps one shared, unfrozen vocabulary and the legacy default', () => {
    expect(policy.DELIVERY_POLICIES).toEqual([...POLICIES]);
    expect(policy.DELIVERY_POLICIES).toBe(profile.DELIVERY_POLICIES);
    expect(Object.isFrozen(policy.DELIVERY_POLICIES)).toBe(false);
    expect(policy.DEFAULT_DELIVERY_POLICY).toBe('legacy');
    expect(profile.DEFAULT_DELIVERY_POLICY).toBe('legacy');
  });

  it.each([undefined, null, {}, { deliveryPolicy: null }])('resolves absent/null configuration %j to legacy', settings => {
    expect(policy.resolveDeliveryPolicy(settings)).toBe('legacy');
  });

  it('recognises exactly the five delivery policies', () => {
    for (const d of POLICIES) expect(profile.isDeliveryPolicy(d)).toBe(true);
    for (const value of [undefined, null, '', 'LOCAL-BRANCH', 'toString', 'constructor', 'hasOwnProperty', 1, {}, []]) {
      expect(profile.isDeliveryPolicy(value)).toBe(false);
    }
  });

  it.each([['observe', 'legacy'], ['observe', 'manual-artifact'], ['legacy', 'legacy'], ['legacy', 'manual-artifact']])(
    'live local-branch ignores a v2 %s snapshot capturing %s', (p, d) => {
      const result = policy.evaluateDeliveryEvidence(stubState({ deliveryPolicy: 'local-branch' }), reviewTask(v2({ profile: p, deliveryPolicy: d })));
      expect(result).toStrictEqual({ policy: 'local-branch', satisfied: false, missingEvidence: ['completion-commit'] });
    });

  it.each([['v2 observe remote-push', v2({ profile: 'observe', deliveryPolicy: 'remote-push' })], ['v1 observe', v1({ profile: 'observe' })]])(
    'a live absent policy ignores a %s snapshot', (_label, snapshot) => {
      expect(policy.evaluateDeliveryEvidence(stubState({}), reviewTask(snapshot)))
        .toStrictEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
    });

  it.each(PROFILES)('v2 legacy/observe snapshots keep the live %s profile while verified-local floors it', live => {
    for (const p of ['legacy', 'observe']) {
      for (const d of POLICIES) {
        expect(profile.resolveTaskExecutionProfile({ executionProfile: live }, v2({ profile: p, deliveryPolicy: d }))).toBe(live);
      }
    }
    expect(profile.resolveTaskExecutionProfile({ executionProfile: live }, v2())).toBe('verified-local');
  });
});

describe('captured configuration is not readiness', () => {
  const notReady = expect.objectContaining({ code: -32003, codeName: 'EXECUTION_PROFILE_NOT_READY' });

  it('records verified-local yet stays EXECUTION_PROFILE_NOT_READY under environment flags', () => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    vi.stubEnv('MOE_DISABLE_QUALITY_GATE', '1');
    const captured = policy.captureExecutionPolicySnapshot({ executionProfile: 'verified-local' }, 2);
    expect(captured).toStrictEqual({ version: 2, profile: 'verified-local', planRevision: 2, deliveryPolicy: 'legacy' });
    expect(() => profile.assertExecutionProfileReady(captured.profile)).toThrowError(notReady);
    expect(() => profile.assertExecutionProfileReady(profile.resolveTaskExecutionProfile({}, v2()))).toThrowError(notReady);
  });

  it('refuses a snapshot object as a readiness label', () => {
    expect(() => profile.assertExecutionProfileReady(v2())).toThrow('executionProfile');
  });
});

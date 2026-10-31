import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertExecutionProfileReady,
  readExecutionPolicySnapshot,
  resolveExecutionProfile,
  resolveTaskExecutionProfile,
} from './executionProfile.js';

const strictSnapshot = () => ({ version: 1, profile: 'verified-local', planRevision: 3 });
afterEach(() => vi.unstubAllEnvs());

describe('execution profile decoding', () => {
  it('defaults only an absent profile to legacy', () => {
    expect(resolveExecutionProfile()).toBe('legacy');
    expect(resolveExecutionProfile({})).toBe('legacy');
    expect(resolveExecutionProfile({ executionProfile: undefined })).toBe('legacy');
  });

  it.each(['legacy', 'observe', 'verified-local'] as const)('recognizes %s without claiming readiness', executionProfile => {
    expect(resolveExecutionProfile({ executionProfile })).toBe(executionProfile);
  });

  it.each([null, '', 'verified', 'VERIFIED-LOCAL', ' verified-local ', false, 0, [], {}].map(value => [value]))('fails closed on profile %j', executionProfile => {
    expect(() => resolveExecutionProfile({ executionProfile })).toThrow('executionProfile');
  });
});

describe('execution profile activation', () => {
  it.each(['legacy', 'observe'] as const)('allows the existing %s workflow', profile => {
    expect(assertExecutionProfileReady(profile)).toBeUndefined();
  });

  it('always refuses verified-local with stable concrete missing capabilities', () => {
    expect(() => assertExecutionProfileReady('verified-local')).toThrowError(expect.objectContaining({
      code: -32003,
      codeName: 'EXECUTION_PROFILE_NOT_READY',
      context: {
        executionProfile: 'verified-local',
        missingCapabilities: [
          'protected-host-control-plane',
          'isolated-agent-and-qa-vms',
          'isolated-check-vm',
          'authenticated-runner-evidence',
          'revision-bound-local-delivery',
        ],
      },
    }));
  });

  it('does not accept environment flags as certification', () => {
    vi.stubEnv('MOE_EXECUTION_PROFILE_READY', '1');
    vi.stubEnv('MOE_DISABLE_QUALITY_GATE', '1');
    expect(() => assertExecutionProfileReady('verified-local')).toThrowError(expect.objectContaining({ codeName: 'EXECUTION_PROFILE_NOT_READY' }));
  });

  it.each([undefined, null, true, 'verified-local '])('rejects an invalid explicit activation %j', profile => {
    expect(() => assertExecutionProfileReady(profile)).toThrow('executionProfile');
  });
});

describe('pure execution policy snapshot resolution', () => {
  it('does not invent a snapshot for an old task', () => {
    expect(readExecutionPolicySnapshot(undefined)).toBeUndefined();
    expect(resolveTaskExecutionProfile({ executionProfile: 'observe' })).toBe('observe');
  });

  it.each(['legacy', 'observe', 'verified-local'] as const)('preserves a verified snapshot under project profile %s', executionProfile => {
    expect(resolveTaskExecutionProfile({ executionProfile }, strictSnapshot())).toBe('verified-local');
  });

  it('does not let a legacy snapshot bypass newly selected strict requirements', () => {
    expect(resolveTaskExecutionProfile({ executionProfile: 'verified-local' }, { version: 1, profile: 'legacy', planRevision: 0 }))
      .toBe('verified-local');
  });

  it('returns detached validated snapshots without mutating caller state', () => {
    const original = Object.freeze(strictSnapshot());
    const decoded = readExecutionPolicySnapshot(original)!;
    expect(decoded).toEqual(original);
    expect(decoded).not.toBe(original);
    decoded.planRevision = 7;
    decoded.profile = 'legacy';
    expect(original).toEqual(strictSnapshot());
    expect(readExecutionPolicySnapshot(original)).toEqual(strictSnapshot());
  });

  it.each([null, [], {}, { ...strictSnapshot(), version: 2 }, { ...strictSnapshot(), profile: null },
    { ...strictSnapshot(), planRevision: -1 }, { ...strictSnapshot(), planRevision: 0.5 },
    { ...strictSnapshot(), planRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...strictSnapshot(), planRevision: NaN },
    { ...strictSnapshot(), planRevision: Infinity }, { ...strictSnapshot(), planRevision: '3' },
    { ...strictSnapshot(), ready: true },
  ].map(value => [value]))('fails closed on malformed snapshot %j', snapshot => {
    expect(() => readExecutionPolicySnapshot(snapshot)).toThrow('executionPolicySnapshot');
    expect(() => resolveTaskExecutionProfile({ executionProfile: 'legacy' }, snapshot)).toThrow('executionPolicySnapshot');
  });

  it('accepts the safe revision domain including legacy zero', () => {
    for (const planRevision of [0, Number.MAX_SAFE_INTEGER]) {
      expect(readExecutionPolicySnapshot({ ...strictSnapshot(), planRevision })?.planRevision).toBe(planRevision);
    }
  });

  it('refuses malformed current configuration even with a valid strict snapshot', () => {
    expect(() => resolveTaskExecutionProfile({ executionProfile: null }, strictSnapshot())).toThrow('executionProfile');
  });
});

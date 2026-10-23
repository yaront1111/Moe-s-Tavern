import type { ExecutionPolicySnapshot, ExecutionProfile } from '../types/schema.js';
import { invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';

const PROFILES: Record<ExecutionProfile, true> = Object.freeze({
  legacy: true,
  observe: true,
  'verified-local': true,
});
export const EXECUTION_PROFILES: readonly ExecutionProfile[] = Object.freeze(Object.keys(PROFILES) as ExecutionProfile[]);

type ProfileSettings = { executionProfile?: unknown } | null | undefined;

function decodeProfile(value: unknown, field: string): ExecutionProfile {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value)) return value as ExecutionProfile;
  throw invalidInput(field, `must be one of: ${EXECUTION_PROFILES.join(', ')}`);
}

/** Recognizing a requested profile does not certify that its execution path is ready. */
export function resolveExecutionProfile(settings?: ProfileSettings): ExecutionProfile {
  const raw = settings?.executionProfile;
  return raw === undefined ? 'legacy' : decodeProfile(raw, 'executionProfile');
}

/** Strictly read an optional snapshot, returning only fresh primitive-valued fields. */
export function readExecutionPolicySnapshot(raw: unknown): ExecutionPolicySnapshot | undefined {
  if (raw === undefined) return undefined;
  const field = 'executionPolicySnapshot';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidInput(field, 'must be an object');
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput(field, 'must be a plain object');
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !['version', 'profile', 'planRevision'].every(key => Object.prototype.hasOwnProperty.call(input, key))) {
    throw invalidInput(field, 'must contain only version, profile and planRevision');
  }
  if (input.version !== 1) throw invalidInput(`${field}.version`, 'must be 1');
  const profile = decodeProfile(input.profile, `${field}.profile`);
  const planRevision = input.planRevision;
  if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision < 0) {
    throw invalidInput(`${field}.planRevision`, 'must be a non-negative safe integer');
  }
  return { version: 1, profile, planRevision };
}

/** A project rollback cannot downgrade the requirements a verified task already owes. */
export function resolveTaskExecutionProfile(settings?: ProfileSettings, snapshot?: unknown): ExecutionProfile {
  const current = resolveExecutionProfile(settings);
  const stored = readExecutionPolicySnapshot(snapshot);
  return stored?.profile === 'verified-local' ? 'verified-local' : current;
}

/**
 * Unconditionally unavailable until the stronger execution path is certified.
 * No persisted readiness label, environment flag, or caller assertion grants it.
 */
export function assertExecutionProfileReady(profile: unknown): void {
  if (decodeProfile(profile, 'executionProfile') !== 'verified-local') return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    'Execution profile verified-local is not ready: protected local isolation, trusted evidence and revision-bound delivery are not certified.',
    {
      executionProfile: 'verified-local',
      missingCapabilities: [
        'protected-host-control-plane',
        'isolated-agent-and-qa-vms',
        'isolated-check-vm',
        'authenticated-runner-evidence',
        'revision-bound-local-delivery',
      ],
    },
    'EXECUTION_PROFILE_NOT_READY',
  );
}

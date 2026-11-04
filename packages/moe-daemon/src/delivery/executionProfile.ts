// A LEAF: runtime imports only util/errors and the readiness holder (which imports
// no state store), so a state store can import it without a cycle. It must never
// import delivery/policy.ts or any state store.
import type { DeliveryPolicy, ExecutionPolicySnapshot, ExecutionProfile } from '../types/schema.js';
import { invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { heldReadiness } from './readinessHolder.js';

/** Keyed by the type, so the recognised list cannot drift from DeliveryPolicy without a compile error. */
const POLICIES: Record<DeliveryPolicy, true> = {
  legacy: true,
  'local-branch': true,
  'remote-push': true,
  'merged-pull-request': true,
  'manual-artifact': true,
};

/** Every recognised deliveryPolicy, in documentation order. */
export const DELIVERY_POLICIES = Object.keys(POLICIES) as DeliveryPolicy[];

/** What an absent or null setting means: the soft NO-COMPLETION-COMMIT warning, approval always lands. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = 'legacy';

/** Membership only (own keys, so 'toString' is not a policy); absent/null defaulting stays in resolveDeliveryPolicy. */
export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, value);
}

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

const SNAPSHOT_KEYS = {
  1: { keys: ['version', 'profile', 'planRevision'], reason: 'must contain only version, profile and planRevision' },
  2: {
    keys: ['version', 'profile', 'planRevision', 'deliveryPolicy'],
    reason: 'must contain only version, profile, planRevision and deliveryPolicy',
  },
} as const;

/**
 * Strictly read an optional configuration snapshot, returning a fresh object with
 * only that version's primitive fields. Fails closed: a v2 deliveryPolicy is never
 * defaulted, and a v1 snapshot never gains one.
 */
export function readExecutionPolicySnapshot(raw: unknown): ExecutionPolicySnapshot | undefined {
  if (raw === undefined) return undefined;
  const field = 'executionPolicySnapshot';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidInput(field, 'must be an object');
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput(field, 'must be a plain object');
  const input = raw as Record<string, unknown>;
  const version = input.version;
  if (version !== 1 && version !== 2) throw invalidInput(`${field}.version`, 'must be 1 or 2');
  const { keys, reason } = SNAPSHOT_KEYS[version];
  // Compare the enumerable key set itself: a hidden required key must not let an extra one through.
  const own = Object.keys(input);
  if (own.length !== keys.length || !own.every(key => (keys as readonly string[]).includes(key))) {
    throw invalidInput(field, reason);
  }
  const profile = decodeProfile(input.profile, `${field}.profile`);
  const planRevision = input.planRevision;
  if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision < 0) {
    throw invalidInput(`${field}.planRevision`, 'must be a non-negative safe integer');
  }
  if (version === 1) return { version: 1, profile, planRevision };
  const deliveryPolicy = input.deliveryPolicy;
  if (!isDeliveryPolicy(deliveryPolicy)) {
    throw invalidInput(`${field}.deliveryPolicy`, `must be one of: ${DELIVERY_POLICIES.join(', ')}`);
  }
  return { version: 2, profile, planRevision, deliveryPolicy };
}

/**
 * The deliveryPolicy a snapshot captured: identity only, NOT the effective policy
 * (absent/legacy/observe tasks keep the live settings.deliveryPolicy). Absent or v1
 * answers undefined; it takes no settings, so it can never fill one in.
 */
export function readCapturedDeliveryPolicy(raw: unknown): DeliveryPolicy | undefined {
  const snapshot = readExecutionPolicySnapshot(raw);
  return snapshot?.version === 2 ? snapshot.deliveryPolicy : undefined;
}

/** A project rollback cannot downgrade the requirements a verified-local snapshot already records. */
export function resolveTaskExecutionProfile(settings?: ProfileSettings, snapshot?: unknown): ExecutionProfile {
  const current = resolveExecutionProfile(settings);
  const stored = readExecutionPolicySnapshot(snapshot);
  return stored?.profile === 'verified-local' ? 'verified-local' : current;
}

/** Today's refusal text, byte for byte, while the daemon has never held an evaluation. */
const NEVER_EVALUATED =
  'Execution profile verified-local is not ready: protected local isolation, trusted evidence and revision-bound delivery are not certified.';

/**
 * verified-local is ready only when the daemon's own latest readiness evaluation
 * (delivery/readinessHolder.ts) says so. No persisted readiness label, environment
 * flag, or caller assertion grants it. legacy and observe always pass.
 */
export function assertExecutionProfileReady(profile: unknown): void {
  if (decodeProfile(profile, 'executionProfile') !== 'verified-local') return;
  const held = heldReadiness();
  if (held.ready === true && held.missingCapabilities.length === 0) return;
  const missingCapabilities = [...held.missingCapabilities];
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    held.evaluatedAt === null
      ? NEVER_EVALUATED
      : `Execution profile verified-local is not ready: missing ${missingCapabilities.join(', ')}.`,
    { executionProfile: 'verified-local', missingCapabilities },
    'EXECUTION_PROFILE_NOT_READY',
  );
}

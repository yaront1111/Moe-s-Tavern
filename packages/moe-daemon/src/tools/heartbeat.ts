import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { AttemptPresenceKind, ExecutionAttempt, ExecutionAttemptPhase } from '../types/schema.js';
import { ATTEMPT_PRESENCE_KINDS, currentAttempt, recordAttemptPresence } from '../state/attemptStore.js';
import { invalidInput } from '../util/errors.js';

/**
 * Presence ping, and the channel that tells a runner it must reattach.
 *
 * ORIGINAL JOB, UNCHANGED: refresh a worker's lastActivityAt from a sidecar
 * process while the CLI subprocess it launched is blocked on a long silent
 * local step (a build, a test run) that makes no moe.* calls of its own.
 * Without it, the REVIEW self-heal sweep (and the 120s isWorkerAlive presence
 * window) can't tell "silently working" apart from "crashed" — both look
 * identical from the daemon's side, since moe-proxy opens a fresh connection
 * per RPC rather than holding one for the CLI's lifetime (see
 * WebSocketServer.cleanupMcpWorkers).
 *
 * WHAT WAS BROKEN: it acknowledged every ping, including one from a sidecar
 * whose worker record no longer exists. A daemon restart wipes worker records,
 * so that sidecar kept pinging happily forever and nothing ever told it to
 * re-register. Three conditions now answer reattach-required instead: no worker
 * record, no open attempt for that seat, and an attempt parked in `reconciling`
 * by a restart that lost sight of it.
 *
 * A RETURNED VALUE, NEVER A THROW. This fires every 60 seconds from every seat,
 * so a thrown refusal would turn a routine daemon restart into an error loop in
 * the wrapper log. It is also NOT `blocking:true` and takes no runExclusive:
 * tool dispatch is already serialized through the global state mutex, and the
 * handler has to stay cheap at fleet scale.
 *
 * A REPORTED PRESENCE KIND IS A CLAIM, NOT EVIDENCE (see AttemptPresenceKind).
 * Recording one proves nothing about liveness, and the daemon still never
 * infers death from silence.
 */

/** Which of the three conditions fired. Stable strings — wrappers branch on them. */
type ReattachReason = 'no-worker-record' | 'no-open-attempt' | 'attempt-reconciling';

interface HeartbeatAck {
  ok: true;
}

interface HeartbeatReattach {
  ok: false;
  reattachRequired: true;
  reason: ReattachReason;
  /** The tool to call next, by name, so a sidecar needs no out-of-band mapping. */
  reattachWith: 'moe.reattach_attempt';
  attemptId?: string;
  phase?: ExecutionAttemptPhase;
}

function reattachRequired(
  reason: ReattachReason,
  attempt?: ExecutionAttempt
): HeartbeatReattach {
  return {
    ok: false,
    reattachRequired: true,
    reason,
    reattachWith: 'moe.reattach_attempt',
    ...(attempt ? { attemptId: attempt.id, phase: attempt.phase } : {}),
  };
}

/**
 * Validated here as well as in the store, so a typo'd kind is refused on EVERY
 * path — including the ones that short-circuit to reattach-required before the
 * store is ever reached. A bad kind is a wrapper bug, not a fleet condition.
 */
function readPresenceKind(value: unknown): AttemptPresenceKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ATTEMPT_PRESENCE_KINDS.has(value as AttemptPresenceKind)) {
    throw invalidInput(
      'presenceKind',
      `must be one of ${Array.from(ATTEMPT_PRESENCE_KINDS).join(', ')} (got ${JSON.stringify(value)})`
    );
  }
  return value as AttemptPresenceKind;
}

/**
 * The caller's OWN open attempt, or null. An attempt held by another seat is
 * null on purpose: a ping must never record presence on a peer's execution, and
 * from this caller's side "not yours" and "not there" both mean re-register.
 */
function resolveOwnAttempt(
  state: StateManager,
  workerId: string,
  currentTaskId: string | null
): ExecutionAttempt | null {
  if (!currentTaskId) return null;
  const attempt = currentAttempt(state, currentTaskId);
  if (!attempt || attempt.workerId !== workerId) return null;
  return attempt;
}

export function heartbeatTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.heartbeat',
    description:
      'Presence ping: refreshes the calling worker\'s lastActivityAt and records an optional presence kind on its open execution attempt. Answers reattach-required (a returned value, never an error) when the worker record is gone, when the seat owns no open attempt, or when its attempt is parked in `reconciling` by a daemon restart — in which case the runner must call moe.reattach_attempt. Used by the agent wrapper sidecar during long silent steps; not intended to be called by agents directly. A presence kind is what the sidecar CLAIMS about itself, never verified liveness.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker to refresh.' },
        presenceKind: {
          type: 'string',
          enum: Array.from(ATTEMPT_PRESENCE_KINDS),
          description:
            'Optional self-report recorded on the open attempt: `process` (the CLI subprocess is still there), `provider` (it is in a provider call), `waiting` (parked on input), `progress` (the execution was observed to move). Omit it and the ping behaves exactly as before, writing nothing to the attempt.'
        }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId: string; presenceKind?: unknown };
      const presenceKind = readPresenceKind(params.presenceKind);

      // No record to refresh, and telling the sidecar to re-register is the
      // whole point — so this returns BEFORE touchWorker rather than no-opping
      // through it as the old handler did.
      const worker = state.getWorker(params.workerId);
      if (!worker) return reattachRequired('no-worker-record');

      // touchWorker no-ops on a DEAD record, so a heartbeat racing a legitimate
      // deregister/completion is still safe. It runs before the attempt checks
      // because keeping lastActivityAt fresh during a long silent build is this
      // tool's original job, and it is independent of whether a runner has to
      // reattach.
      await state.touchWorker(params.workerId);

      const attempt = resolveOwnAttempt(state, params.workerId, worker.currentTaskId);
      if (!attempt) return reattachRequired('no-open-attempt');
      // A runner that has not proven which process it is must not be able to
      // look present: no presence write on this path, so the reconcile window
      // the attempt is being measured against is left entirely alone.
      if (attempt.phase === 'reconciling') return reattachRequired('attempt-reconciling', attempt);

      // When and ONLY when a kind was supplied: an old-style ping from an
      // un-upgraded wrapper performs no extra write at all.
      if (presenceKind !== undefined) {
        await recordAttemptPresence(state, attempt.id, presenceKind);
      }
      const ack: HeartbeatAck = { ok: true };
      return ack;
    }
  };
}

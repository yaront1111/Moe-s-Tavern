// CQ-M07d: the read-only projection of the daemon's held verified-local readiness (mem:decision-cq-m07-verified-local-activation).
// Neither the MCP tool nor the /ws GET_EXECUTION_READINESS case writes state, appends activity or touches a worker. The only
// way a call reaches the held value is `refresh`, which re-runs the daemon's OWN evaluator through refreshReadiness with
// production inputs, awaited, single-flight and at most once per READINESS_REFRESH_WINDOW_MS. No caller field grants readiness.
import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { resolveExecutionProfile } from '../delivery/executionProfile.js';
import { heldReadiness, productionReadinessInputs, refreshReadiness } from '../delivery/readinessHolder.js';
import type { ExecutionProfile } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';

/** Exactly the four fields CQ-M07m/n/o/p plan against. Never add evidence, paths or versions. */
export interface ExecutionReadinessPayload {
  /** The live resolveExecutionProfile, or 'unreadable' for a malformed executionProfile setting. */
  profile: ExecutionProfile | 'unreadable';
  ready: boolean;
  missingCapabilities: string[];
  /** null: never evaluated, or the last evaluation failed (the held default). */
  evaluatedAt: string | null;
}

/** A refresh storm re-runs the evaluator at most once per window. */
export const READINESS_REFRESH_WINDOW_MS = 30_000;

/** A plain mutable seam so tests replace members with vi.spyOn; no test may reach the production refresh. */
export const readinessProjectionDeps = {
  now: (): number => Date.now(),
  refresh: (state: StateManager): Promise<unknown> =>
    refreshReadiness(productionReadinessInputs(state.projectPath, state.project?.settings)),
};

let lastStartedAt: number | null = null;
let inFlight: Promise<void> | null = null;

/** Clears the rate window and the in-flight promise. It can only allow the next refresh. */
export function _resetReadinessRefreshForTests(): void {
  lastStartedAt = null;
  inFlight = null;
}

function readRefresh(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalidInput('refresh', 'must be a boolean');
  return value;
}

/** Join a refresh in flight, else start one when the window has passed or the clock went backwards. Never rejects. */
async function refreshWithinWindow(state: StateManager): Promise<void> {
  if (inFlight) return inFlight;
  const now = readinessProjectionDeps.now();
  if (lastStartedAt !== null && now >= lastStartedAt && now - lastStartedAt < READINESS_REFRESH_WINDOW_MS) return;
  lastStartedAt = now; // recorded before awaiting: a rejecting refresh still counts as started
  const run = (async () => {
    try {
      await readinessProjectionDeps.refresh(state);
    } catch {
      // The holder already fails closed; a failed evaluation never fails the read.
    }
  })();
  const mine: Promise<void> = run.finally(() => { if (inFlight === mine) inFlight = null; });
  inFlight = mine;
  return mine;
}

function liveProfile(state: StateManager): ExecutionProfile | 'unreadable' {
  try {
    return resolveExecutionProfile(state.project?.settings);
  } catch {
    return 'unreadable';
  }
}

/** The held readiness plus the live profile, as fresh copies. `refresh` is the only input read. */
export async function readExecutionReadiness(
  state: StateManager, { refresh }: { refresh?: unknown } = {},
): Promise<ExecutionReadinessPayload> {
  const wantsRefresh = readRefresh(refresh);
  if (wantsRefresh) await refreshWithinWindow(state);
  const held = heldReadiness();
  return {
    profile: liveProfile(state),
    ready: held.ready,
    missingCapabilities: [...held.missingCapabilities],
    evaluatedAt: held.evaluatedAt,
  };
}

export function getExecutionReadinessTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_execution_readiness',
    description:
      'Read-only. Reports whether the verified-local execution profile is ready and which capabilities are missing: { profile, ready, missingCapabilities, evaluatedAt }. profile is the project\'s live executionProfile setting, or "unreadable" when that setting is malformed. It grants nothing and changes nothing. refresh: true re-runs the daemon\'s own evaluator, awaited, at most once per 30 s.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Caller worker id (injected by the proxy; never read)' },
        refresh: { type: 'boolean', description: 'Re-run the daemon evaluator first (rate-limited to once per 30 s)' },
      },
      additionalProperties: false,
    },
    // Mutex opt-out (tools/index.ts ToolDefinition.blocking): the tool writes nothing, and a refresh awaits a bounded
    // evaluation (probe 10 s, guard 11 s) that must never hold the fleet-wide state mutex. It never parks or long-polls.
    blocking: true,
    handler: async (args, state) =>
      readExecutionReadiness(state, { refresh: (args as { refresh?: unknown } | undefined | null)?.refresh }),
  };
}

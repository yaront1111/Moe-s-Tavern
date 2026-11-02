// =============================================================================
// Project settings writes and the recorded executionProfile rollout controls
// (CQ-M05): observation, selected-project activation and audited rollback.
//
// Every enablement is per project: settings live in this project's project.json.
// There is no fleet switch and, by the user's 2026-10-24 decision, no new UI.
// Nothing here grants readiness. assertExecutionProfileReady
// (delivery/executionProfile.ts) stays the only readiness authority, and the
// capability gate below can only refuse. Each profile transition writes one
// PROJECT_SETTINGS_UPDATED activity record, read through moe.get_activity_log.
// No authorization path reads those records.
// =============================================================================

import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ExecutionProfile, Project, ProjectSettings } from '../types/schema.js';
import { validateSettingsUpdate } from './validators.js';
import { currentAttempt } from './attemptStore.js';
import { readExecutionPolicySnapshot, resolveExecutionProfile } from '../delivery/executionProfile.js';
import { heldReadiness } from '../delivery/readinessHolder.js';
import { decodeClientHello } from '../server/clientCapabilities.js';
import { atomicWriteJsonAsync } from '../util/atomicWrite.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';

export type ProfileTransition = 'observe' | 'activate' | 'rollback';
export type ActivationGap = { capability: 'vm' | 'client' | 'check'; reason: string };

const RANK: Record<ExecutionProfile, number> = { legacy: 0, observe: 1, 'verified-local': 2 };
/** moe.get_activity_log truncates any payload value over 500 chars; 10 task or attempt ids stay under it. */
const MAX_RECORDED_IDS = 10;
const REFUSED_ACTIVATIONS = new Set(['EXECUTION_PROFILE_NOT_READY', 'EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED']);

/** A verified-local request is 'activate'; an unreadable or higher stored profile is 'rollback'; equal is no transition. */
export function classifyProfileTransition(
  from: ExecutionProfile | 'unreadable', to: ExecutionProfile,
): ProfileTransition | null {
  if (to === 'verified-local') return 'activate';
  if (from === 'unreadable' || RANK[from] > RANK[to]) return 'rollback';
  return RANK[from] < RANK[to] ? 'observe' : null;
}

/** I01 grants a client verifiedLocal only if the server supports it; a throw counts as unsupported. */
function clientSupportsVerifiedLocal(): boolean {
  try {
    return decodeClientHello({ protocolVersion: 1, capabilities: { verifiedLocal: true } }).negotiatedCapabilities.verifiedLocal;
  } catch {
    return false;
  }
}

/**
 * What still blocks verified-local, ordered vm, client, check, as fresh objects on
 * every call. Daemon-owned facts only: never an env var, a persisted label or a
 * caller field. vm and check come from the daemon's held readiness evaluation
 * (delivery/readinessHolder.ts): each is listed while its isolation capability is
 * missing, which includes the never-evaluated default. client is the I01 gate.
 */
export function activationGaps(): ActivationGap[] {
  const missing = heldReadiness().missingCapabilities;
  const gaps: ActivationGap[] = [];
  if (missing.includes('isolated-agent-and-qa-vms')) gaps.push({ capability: 'vm', reason: 'vm-provisioning-uncertified' });
  if (!clientSupportsVerifiedLocal()) gaps.push({ capability: 'client', reason: 'client-contract-unsupported' });
  if (missing.includes('isolated-check-vm')) gaps.push({ capability: 'check', reason: 'check-runner-uncertified' });
  return gaps;
}

/** The refusal for any unsupported capability; null only when none is unsupported. */
export function activationUnsupported(gaps: readonly ActivationGap[]): MoeError | null {
  if (gaps.length === 0) return null;
  const listed = gaps.map((gap) => `${gap.capability} (${gap.reason})`).join(', ');
  return new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Execution profile verified-local cannot be activated: unsupported ${listed}.`,
    { executionProfile: 'verified-local', unsupportedCapabilities: gaps.map((gap) => ({ ...gap })) },
    'EXECUTION_PROFILE_ACTIVATION_UNSUPPORTED',
  );
}

export type StrictRetention = {
  retainedStrictTasks: number;
  retainedStrictTaskIds: string[];
  retainedStrictAttempts: number;
  retainedStrictAttemptIds: string[];
  unreadableSnapshots: number;
};

const isStrict = (snapshot: unknown) => readExecutionPolicySnapshot(snapshot)?.profile === 'verified-local';

/**
 * What a rollback leaves strict: tasks whose stored snapshot is verified-local and
 * open attempts whose own snapshot is. Counts are totals, ids are sorted and capped,
 * and an undecodable snapshot or attempt is only counted, never echoed. Never throws.
 * ponytail: O(tasks x attempts) through currentAttempt, once per profile change.
 */
export function strictRetention(state: StateManager): StrictRetention {
  const tasks: string[] = [];
  const attempts: string[] = [];
  let unreadableSnapshots = 0;
  for (const [id, task] of state.tasks) {
    try {
      if (isStrict(task.executionPolicySnapshot)) tasks.push(id);
    } catch {
      unreadableSnapshots++;
    }
    try {
      const open = currentAttempt(state, id);
      if (open && isStrict(open.executionPolicySnapshot)) attempts.push(open.id);
    } catch {
      unreadableSnapshots++;
    }
  }
  const ids = (list: string[]) => list.sort().slice(0, MAX_RECORDED_IDS);
  return {
    retainedStrictTasks: tasks.length,
    retainedStrictTaskIds: ids(tasks),
    retainedStrictAttempts: attempts.length,
    retainedStrictAttemptIds: ids(attempts),
    unreadableSnapshots,
  };
}

function storedProfile(settings: ProjectSettings): ExecutionProfile | 'unreadable' {
  try {
    return resolveExecutionProfile(settings);
  } catch (error) {
    if (error instanceof MoeError) return 'unreadable';
    throw error;
  }
}

/**
 * StateManager.updateSettings: validate, write project.json, record the profile
 * transition, then emit SETTINGS_UPDATED. The validator runs first and unchanged,
 * so its unconditional readiness refusal keeps its exact shape; the capability
 * gate runs after it and only refuses. A failed write leaves memory unchanged and
 * records nothing. The record is awaited, so it is on disk before the emit; an
 * append failure is logged and swallowed by the activity-log contract and never
 * fails or reverts the change.
 */
export async function updateProjectSettings(state: StateManager, input: Partial<ProjectSettings>): Promise<Project> {
  const project = state.project;
  if (!project) throw new Error('Project not loaded');
  const from = storedProfile(project.settings);
  const requested = input?.executionProfile === 'verified-local';
  const gaps = requested ? activationGaps() : [];
  const record = (payload: Record<string, unknown>) =>
    state.appendActivityAsync('PROJECT_SETTINGS_UPDATED', { setting: 'executionProfile', from, ...payload });

  let settings: ProjectSettings;
  try {
    settings = validateSettingsUpdate(project, input);
    const unsupported = requested ? activationUnsupported(gaps) : null;
    if (unsupported) throw unsupported;
  } catch (error) {
    if (requested && error instanceof MoeError && REFUSED_ACTIVATIONS.has(error.codeName)) {
      await record({ to: 'verified-local', transition: 'activate', outcome: 'refused', codeName: error.codeName, unsupportedCapabilities: gaps });
    }
    throw error;
  }

  const updated: Project = { ...project, settings, updatedAt: new Date().toISOString() };
  await atomicWriteJsonAsync(path.join(state.moePath, 'project.json'), updated);
  state.project = updated;

  const to = resolveExecutionProfile(settings);
  const transition = input.executionProfile === undefined ? null : classifyProfileTransition(from, to);
  if (transition) {
    await record({ to, transition, outcome: 'applied', ...(transition === 'rollback' ? strictRetention(state) : {}) });
  }
  state.emit({ type: 'SETTINGS_UPDATED', payload: updated });
  return updated;
}

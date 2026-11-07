import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { AttributionSettings, ProjectSettings, Task, Worker } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';
import { collectDeclaredPaths, collectTaskPathTiers, PathSet } from '../util/attributionTiers.js';
import { isWorkerAlive } from '../util/workerLiveness.js';
import { listAttempts } from '../state/attemptStore.js';
import { finalizingAttemptsByTask } from '../util/claimEligibility.js';
import { collectPeerDeclared, isPeerActive, sortedById } from '../util/peerMap.js';

const PHASES = ['preflight', 'postflight'] as const;
type ScopePhase = typeof PHASES[number];

/**
 * Whether a session that is not the assignee must leave the task's source paths
 * alone. False only for an unassigned task, or for an owner that is missing or
 * DEAD and holds no non-closed attempt of its own on this task. True otherwise:
 * a registered non-DEAD owner, or a non-closed attempt this owner opened.
 *
 * Presence is deliberately not used (no isWorkerAlive, no lastActivityAt): a
 * quiet build is not a death, and a stale heartbeat must never be permission to
 * land bytes a live owner is still writing. Fails closed on malformed records:
 * a non-string assignee id, a worker with no status and an unknown attempt phase
 * all count as protected. Read-only and independent of the caller.
 */
function isAssigneeProtected(state: StateManager, task: Task): boolean {
  const owner: unknown = task.assignedWorkerId;
  if (owner === null || owner === undefined || owner === '') return false;
  if (typeof owner !== 'string') return true;
  const record = state.getWorker(owner);
  if (record && record.status !== 'DEAD') return true;
  return listAttempts(state, task.id).some((attempt) => attempt.workerId === owner && attempt.phase !== 'closed');
}

export function getCommitScopeTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_commit_scope',
    description: 'Attribution scope the agent wrapper stages a task\'s commit from: the task\'s ASSERTED paths (completed steps\' modifiedFiles/affectedFiles, filesModified, declare_files, tool-written, previously committed), the DECLARED part of them (moe.declare_files: committed regardless of the pre-task baseline; the rest of ASSERTED only when this task produced the dirty bytes), its PLANNED paths (plan-declared only, committed when changed since the pre-task baseline), every other open task\'s declared paths (PEER map; while this task is not DONE/ARCHIVED, a peer that waits on it (dependsOn or blockedOnTaskIds, transitively) and has no active assignee and no open attempt contributes only its asserted paths, since it cannot have run yet; once this task is DONE/ARCHIVED, or while that peer has an active assignee or an open attempt, it counts like any other peer; each entry\'s peerActive is false only when, since `since`, no contributing task had an active assignee, an open attempt or an attempt phase change — always true without `since`; taskIds lists every contributing task in id order, taskId being the first; activeTaskIds lists the contributors that are active by the peerActive rule, in id order — every contributor without `since` — so peerActive is true exactly when it is non-empty; editingTaskIds lists the contributors with an IN_PROGRESS plan step naming the path that are active by the same rule, a subset of activeTaskIds — every such contributor without `since`), which workers are active (peersActive drives the attribution.undeclared policy), the board-state paths it may commit, and the project\'s commit policy. Read-only apart from a liveness touch; no ownership guard — an orphan-mode caller (workerId neither the assignee nor the holder of the task\'s finalizing attempt) is counted in activePeerIds — but assigneeProtected tells a caller that is not the assignee whether it must leave the task\'s source paths alone. finalizingAttempt names the task\'s finalizing attempt exactly as claim_next_task\'s finalizing hold selects it ({attemptId, workerId, generation}, whoever holds it, the caller included) or is null; a daemon older than the field omits it.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task whose commit scope to compute' },
        workerId: { type: 'string', description: 'Caller worker id (auto-injected by proxy). Excluded from livePeerIds; counted in activePeerIds when it is neither the assignee nor the holder of the task\'s finalizing attempt (the seat landing its own completion after complete_task cleared the assignee).' },
        sessionId: { type: 'string', description: '<workerId>@<preflight-iso> of the calling wrapper session (informational).' },
        phase: { type: 'string', enum: [...PHASES], description: 'preflight (baseline merge) or postflight (landing).' },
        since: { type: 'string', description: 'ISO instant (usually the session pre-flight time). Peers active at/after since−120s or registered after it count as active; omitted → the standard 120s presence window.' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        workerId?: string;
        sessionId?: string;
        phase?: ScopePhase;
        since?: string;
      };

      if (!params.taskId || typeof params.taskId !== 'string') throw missingRequired('taskId');
      if (params.phase !== undefined && !(PHASES as readonly string[]).includes(params.phase)) {
        throw invalidInput('phase', `must be one of: ${PHASES.join(', ')}`);
      }
      let sinceMs: number | null = null;
      if (params.since !== undefined) {
        if (typeof params.since !== 'string') throw invalidInput('since', 'must be an ISO timestamp string');
        const parsed = Date.parse(params.since);
        if (!Number.isFinite(parsed)) throw invalidInput('since', `not a parsable timestamp (got "${params.since}")`);
        sinceMs = parsed;
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const settings: Partial<ProjectSettings> = state.project?.settings ?? {};
      const attribution: AttributionSettings = settings.attribution ?? {};
      const caller = typeof params.workerId === 'string' && params.workerId.length > 0 ? params.workerId : null;
      const nowMs = Date.now();

      // ---- own tiers -------------------------------------------------------
      const tiers = collectTaskPathTiers(task);
      const declared = collectDeclaredPaths(task);
      const touchedFiles = new PathSet().addAll(task.touchedFiles).values();
      const inferredPaths = new PathSet().addAll(task.inferredPaths).values();
      const unattributedPaths = new PathSet().addAll(task.unattributedPaths).values();

      // ---- peers -----------------------------------------------------------
      // util/peerMap.ts holds the rules (shared with complete_task's landing preview).
      const peerDeclared = collectPeerDeclared(state, task, nowMs, sinceMs);

      // ---- liveness --------------------------------------------------------
      const livePeerIds: string[] = [];
      for (const worker of sortedById<Worker>(state.workers.values())) {
        if (caller !== null && worker.id === caller) continue;
        if (isPeerActive(worker, nowMs, sinceMs)) livePeerIds.push(worker.id);
      }
      // The finalizing hold claim_next_task enforces (util/claimEligibility.ts), named whoever
      // holds it: the wrapper's owner guard compares workerId instead of parsing .moe/attempts.
      const finalizing = finalizingAttemptsByTask(state).get(task.id);
      // Orphan mode: a caller that is not the assignee is itself a concurrent
      // actor on this task's paths, so it counts toward peersActive — the
      // policy then degrades to declared-only unless attribution.undeclared is
      // 'always'. The holder of the task's finalizing attempt is exempt: it is
      // the seat landing its own completion, and complete_task's REVIEW write
      // cleared its assignment before its wrapper's post-flight asks.
      const orphanCaller = caller !== null && caller !== task.assignedWorkerId && finalizing?.workerId !== caller;
      const activePeerIds = orphanCaller ? [...livePeerIds, caller] : [...livePeerIds];
      const assignee = task.assignedWorkerId ? state.getWorker(task.assignedWorkerId) : null;
      const assigneeAlive = assignee ? isWorkerAlive(assignee, nowMs) : false;
      const assigneeProtected = isAssigneeProtected(state, task);
      const livePeerSet = new Set(livePeerIds);

      // ---- board state -----------------------------------------------------
      // BOARD candidates the wrapper may stage (only when dirty): the task's own
      // record always, project.json, every epic record, and task records not
      // held by a live peer. A live peer's record is its own to land.
      const alwaysInclude: string[] = [];
      if (settings.commitBoardState !== false) {
        alwaysInclude.push(`.moe/tasks/${task.id}.json`);
        alwaysInclude.push('.moe/project.json');
        for (const epic of sortedById(state.epics.values())) {
          alwaysInclude.push(`.moe/epics/${epic.id}.json`);
        }
        for (const other of sortedById<Task>(state.tasks.values())) {
          if (other.id === task.id) continue;
          if (other.assignedWorkerId && livePeerSet.has(other.assignedWorkerId)) continue;
          alwaysInclude.push(`.moe/tasks/${other.id}.json`);
        }
      }

      // settings.attribution.exclude is validated on update_settings, but
      // project.json is hand-editable — re-normalize defensively and drop
      // anything the daemon would refuse to store.
      let excludePrefixes: string[] = [];
      try {
        excludePrefixes = normalizeAffectedFiles(
          Array.isArray(attribution.exclude) ? attribution.exclude.filter((e: unknown) => typeof e === 'string') : [],
          'attribution.exclude'
        );
      } catch {
        excludePrefixes = new PathSet().addAll(Array.isArray(attribution.exclude) ? attribution.exclude : []).values();
      }

      if (caller) {
        await state.touchWorker(caller);
      }

      return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        epicId: task.epicId,
        reopenCount: task.reopenCount ?? 0,
        assignedWorkerId: task.assignedWorkerId ?? null,
        assigneeAlive,
        assigneeProtected,
        // Additive: an older daemon omits it, and the wrapper then scans .moe/attempts itself.
        finalizingAttempt: finalizing
          ? { attemptId: finalizing.id, workerId: finalizing.workerId, generation: finalizing.generation }
          : null,
        asserted: tiers.asserted,
        // Additive: a wrapper that predates the field ignores it and keeps
        // committing every asserted path regardless of its baseline.
        declared,
        planned: tiers.planned,
        touchedFiles,
        inferredPaths,
        unattributedPaths,
        peerDeclared,
        livePeerIds,
        activePeerIds,
        peersActive: activePeerIds.length > 0,
        alwaysInclude,
        excludePrefixes,
        policy: {
          autoCommit: settings.autoCommit !== false,
          checkpointCommits: settings.checkpointCommits !== false,
          checkpointPush: settings.checkpointPush !== false,
          commitBoardState: settings.commitBoardState !== false,
          commitHooks: settings.commitHooks === true,
          undeclared: attribution.undeclared ?? 'solo',
          contested: attribution.contested ?? 'skip-untouched',
        },
        ...(params.phase ? { phase: params.phase } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      };
    }
  };
}

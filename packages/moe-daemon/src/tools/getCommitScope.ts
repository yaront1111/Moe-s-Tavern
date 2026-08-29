import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { AttributionSettings, ProjectSettings, Task, Worker } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';
import { collectPeerPaths, collectTaskPathTiers, PathSet } from '../util/attributionTiers.js';
import { isWorkerAlive, LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';

const PHASES = ['preflight', 'postflight'] as const;
type ScopePhase = typeof PHASES[number];

const TERMINAL_STATUSES = new Set<string>(['DONE', 'ARCHIVED']);

/**
 * A worker counts as an active peer for the attribution policy when it is not
 * DEAD and either (a) `since` was supplied and it was active at or after
 * `since − 120 s` or registered at/after `since`, or (b) no `since` was given
 * and it is inside the standard presence window (isWorkerAlive).
 */
function isPeerActive(worker: Worker, nowMs: number, sinceMs: number | null): boolean {
  if (worker.status === 'DEAD') return false;
  if (sinceMs === null) return isWorkerAlive(worker, nowMs);
  const last = Date.parse(worker.lastActivityAt);
  if (Number.isFinite(last) && last >= sinceMs - LIVENESS_TIMEOUT_MS) return true;
  const started = Date.parse(worker.startedAt);
  return Number.isFinite(started) && started >= sinceMs;
}

function sortedById<T extends { id: string }>(items: Iterable<T>): T[] {
  return Array.from(items).sort((a, b) => a.id.localeCompare(b.id));
}

export function getCommitScopeTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_commit_scope',
    description: 'Attribution scope the agent wrapper stages a task\'s commit from: the task\'s ASSERTED paths (completed steps\' modifiedFiles/affectedFiles, filesModified, declare_files, tool-written, previously committed), its PLANNED paths (plan-declared only, committed when changed since the pre-task baseline), every other open task\'s declared paths (PEER map), which workers are active (peersActive drives the attribution.undeclared policy), the board-state paths it may commit, and the project\'s commit policy. Read-only apart from a liveness touch; no ownership guard — an orphan-mode caller (workerId not the assignee) is counted in activePeerIds.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        workerId: { type: 'string', description: 'Caller worker id (auto-injected by proxy). Excluded from livePeerIds; counted in activePeerIds when it is not the assignee.' },
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
      const touchedFiles = new PathSet().addAll(task.touchedFiles).values();
      const inferredPaths = new PathSet().addAll(task.inferredPaths).values();
      const unattributedPaths = new PathSet().addAll(task.unattributedPaths).values();

      // ---- peers -----------------------------------------------------------
      // Deterministic: tasks visited in id order, first claimant of a path wins.
      const peerByKey = new Map<string, { path: string; taskId: string }>();
      const peerSet = new PathSet();
      for (const other of sortedById<Task>(state.tasks.values())) {
        if (other.id === task.id) continue;
        if (TERMINAL_STATUSES.has(other.status)) continue;
        for (const p of collectPeerPaths(other)) {
          if (peerSet.has(p)) continue;
          const stored = peerSet.add(p);
          if (stored === null) continue;
          peerByKey.set(stored, { path: stored, taskId: other.id });
        }
      }
      const peerDeclared = Array.from(peerByKey.values());

      // ---- liveness --------------------------------------------------------
      const livePeerIds: string[] = [];
      for (const worker of sortedById<Worker>(state.workers.values())) {
        if (caller !== null && worker.id === caller) continue;
        if (isPeerActive(worker, nowMs, sinceMs)) livePeerIds.push(worker.id);
      }
      // Orphan mode: a caller that is not the assignee is itself a concurrent
      // actor on this task's paths, so it counts toward peersActive — the
      // policy then degrades to declared-only unless attribution.undeclared is
      // 'always'.
      const orphanCaller = caller !== null && caller !== task.assignedWorkerId;
      const activePeerIds = orphanCaller ? [...livePeerIds, caller] : [...livePeerIds];
      const assignee = task.assignedWorkerId ? state.getWorker(task.assignedWorkerId) : null;
      const assigneeAlive = assignee ? isWorkerAlive(assignee, nowMs) : false;
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
        asserted: tiers.asserted,
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
          contested: attribution.contested ?? 'commit',
        },
        ...(params.phase ? { phase: params.phase } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      };
    }
  };
}

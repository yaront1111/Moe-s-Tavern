import { createHash } from 'node:crypto';
import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt, ExecutionPolicySnapshot, ExecutionProfile, Task, TaskCommit } from '../types/schema.js';
import { invalidInput, invalidState, notFound } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { contextNextAction } from '../util/contextNextAction.js';
import { collectAssertedPaths } from '../util/attributionTiers.js';
import { unmetDependsOn } from '../state/dependencyUnblock.js';
import { listCandidatesForTask } from '../state/candidateStore.js';
import { planReuseContext } from '../context/planReuseJob.js';
import { contextStatus } from '../util/contextStatus.js';
import { resolveWorkerRole } from '../util/workerRole.js';
import { routingInfo } from '../util/routing.js';
import { currentAttempt, readContextSessionId, recordContextReceipt } from '../state/attemptStore.js';
import { decodeStoredPlanRevision } from '../state/taskStore.js';
import { readRequiredCheckSnapshot } from '../delivery/requiredChecks.js';
import { isEpicFinalTask } from '../delivery/policy.js';
import {
  buildPacketManifest, MAX_PACKET_BUDGET_CHARS, MIN_PACKET_BUDGET_CHARS, readPacketBudgetChars,
} from '../context/contextPacket.js';
import { decideDelta, DeltaBaseStore, diffPackets, type ContextDelta, type DeltaRefusal } from '../context/contextDelta.js';
import {
  readExecutionPolicySnapshot,
  resolveExecutionProfile,
  resolveTaskExecutionProfile,
} from '../delivery/executionProfile.js';

/**
 * Sections dropped from a QA caller's default payload: no QA doc or skill reads
 * them (QA reviews the delivered bytes against DoD and plan), and together they
 * are ~20% of an average payload. view:"full" returns them for any role.
 */
// Default-view trims per role (view:"full" is never trimmed). routing is the
// planner's model/effort catalog: only architects and governors choose from it.
export const ROLE_OMITTED: Record<string, string[]> = {
  qa: ['task.epicSiblings', 'planningNotes', 'routing'],
  worker: ['routing'],
};

/** Newest commits surfaced per task (the ledger itself is capped at MAX_COMMITS_PER_TASK). */
const MAX_CONTEXT_COMMITS = 20;
/** Epic prerequisites (lower order) surfaced for the landed/not-landed check. */
const MAX_EPIC_SIBLINGS = 20;

function taskCommits(task: Pick<Task, 'commits'>): TaskCommit[] {
  return Array.isArray(task.commits) ? task.commits.filter((c) => c && typeof c.sha === 'string') : [];
}

function lastOfKind(commits: TaskCommit[], kind: TaskCommit['kind']): TaskCommit | undefined {
  for (let i = commits.length - 1; i >= 0; i--) {
    if (commits[i].kind === kind) return commits[i];
  }
  return undefined;
}

/** `landing` block: where the task's work last reached git, by kind. */
function buildLanding(commits: TaskCommit[]) {
  const completion = lastOfKind(commits, 'completion');
  const checkpoint = lastOfKind(commits, 'checkpoint');
  return {
    ...(completion
      ? { lastCompletion: { sha: completion.sha, ref: completion.ref, pushed: completion.pushed ?? null, recordedAt: completion.recordedAt } }
      : {}),
    ...(checkpoint ? { lastCheckpoint: { sha: checkpoint.sha, recordedAt: checkpoint.recordedAt } } : {}),
  };
}

/**
 * A prerequisite has "landed" when a completion commit for it was pushed, or
 * it is already in REVIEW/DONE (its worker session ended and the wrapper's
 * completion landing ran or is running).
 */
function taskLanded(task: Task, commits: TaskCommit[]): boolean {
  return commits.some((c) => c.kind === 'completion' && c.pushed === true)
    || task.status === 'REVIEW'
    || task.status === 'DONE';
}

/** get_context's `executionPolicy`; see executionPolicyContext. */
interface ExecutionPolicyContext {
  effectiveProfile: ExecutionProfile | null;
  taskSnapshot: ExecutionPolicySnapshot | null;
  attemptSnapshot: ExecutionPolicySnapshot | null;
  unreadable?: string[];
}

/** Decode one record; a failure is named in `unreadable` and served as null, never echoed or thrown. */
function decoded<T>(unreadable: string[], name: string, decode: () => T): T | null {
  try {
    return decode();
  } catch {
    unreadable.push(name);
    return null;
  }
}

/**
 * The task's execution-profile configuration identity: the profile that governs
 * it (the live setting floored by a stored verified-local snapshot, through the
 * one rule the progression backstop, claim admission and delivery selection
 * share), its plan-submission snapshot, and the snapshot of its open attempt
 * (running, finalizing or reconciling; null with none). Configuration identity
 * only: never approval, readiness, runner trust, delivery verification or
 * completion. effectiveProfile names the governing profile, not its readiness:
 * verified-local is unconditionally unavailable (assertExecutionProfileReady).
 * Never writes. Snapshots are decoded into fresh primitive-only objects, so the
 * response never aliases stored state.
 *
 * Undefined when the setting, the task snapshot and the open attempt's snapshot
 * are all absent, so a project that never used profiles sees a byte-identical
 * payload (the currentCandidate precedent).
 *
 * Error handling: each record is read on its own. One that does not decode is
 * served as null and named in `unreadable` ('settings.executionProfile',
 * 'taskSnapshot', 'attemptSnapshot'), so a hand-edited record never breaks the
 * read and its raw value and error text are never served. effectiveProfile is
 * null when the setting or the task snapshot is unreadable.
 */
function executionPolicyContext(state: StateManager, task: Task): ExecutionPolicyContext | undefined {
  const settings = state.project?.settings;
  const unreadable: string[] = [];
  const liveProfile = decoded(unreadable, 'settings.executionProfile', () => resolveExecutionProfile(settings));
  const taskSnapshot = decoded(unreadable, 'taskSnapshot', () => readExecutionPolicySnapshot(task.executionPolicySnapshot) ?? null);
  // currentAttempt copies the stored snapshot, which overflows on a hand-edited one nested too deep: read it under the guard.
  const attemptSnapshot = decoded(unreadable, 'attemptSnapshot',
    () => readExecutionPolicySnapshot(currentAttempt(state, task.id)?.executionPolicySnapshot) ?? null);
  if (
    settings?.executionProfile === undefined
    && task.executionPolicySnapshot === undefined
    && attemptSnapshot === null
    && unreadable.length === 0
  ) return undefined;
  const judged = liveProfile !== null && !unreadable.includes('taskSnapshot');
  return {
    effectiveProfile: judged ? resolveTaskExecutionProfile(settings, task.executionPolicySnapshot) : null,
    taskSnapshot,
    attemptSnapshot,
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };
}

type ReceiptStatus =
  | 'recorded' | 'record-failed' | 'identity-unreadable' | 'no-session' | 'no-running-attempt' | 'not-attempt-owner';

interface DeltaRequest { basePacketId?: string; contextEpoch?: number }
type ContextDeltaStatus = { served: 'delta' } | { served: 'full'; reason: DeltaRefusal | ReceiptStatus | 'diff-failed' };

const PACKET_ID = /^sha256:[0-9a-f]{64}$/;

/** Caller-shape check for CQ-C06's two delta fields; refused before any read or write. */
function readDeltaRequest(basePacketId: unknown, contextEpoch: unknown): DeltaRequest {
  if (basePacketId !== undefined && (typeof basePacketId !== 'string' || !PACKET_ID.test(basePacketId))) {
    throw invalidInput('basePacketId', 'must be a packetId: sha256: followed by 64 lowercase hex digits');
  }
  if (contextEpoch !== undefined && (typeof contextEpoch !== 'number' || !Number.isSafeInteger(contextEpoch) || contextEpoch < 0)) {
    throw invalidInput('contextEpoch', 'must be a non-negative safe integer');
  }
  return {
    ...(basePacketId !== undefined ? { basePacketId } : {}),
    ...(contextEpoch !== undefined ? { contextEpoch } : {}),
  };
}

// One acknowledged base per task, held in memory per StateManager: a restarted
// daemon (a new StateManager) holds none, so its first answer is a full packet.
const deltaBases = new WeakMap<StateManager, DeltaBaseStore>();

function deltaBaseStore(state: StateManager): DeltaBaseStore {
  let store = deltaBases.get(state);
  if (!store) {
    store = new DeltaBaseStore();
    deltaBases.set(state, store);
  }
  return store;
}

/**
 * CQ-C06: a recorded read that presented basePacketId or contextEpoch gets a
 * delta only when the stored base is that exact packet, served to this session
 * on this attempt, generation, runner and phase (a reattach moves lastPhaseAt),
 * under the same compaction epoch. Only a read with an epoch becomes the next
 * base; a recorded read without one clears it, so no later delta can follow.
 *
 * Error handling: never throws. A diff failure is logged and served as the
 * full packet with reason 'diff-failed'.
 */
function deltaAgainstBase(
  state: StateManager,
  taskId: string,
  attempt: ExecutionAttempt,
  request: DeltaRequest,
  served: { sessionId: string; packetId: string; text: string }
): { delta?: ContextDelta; contextDelta: ContextDeltaStatus } {
  const store = deltaBaseStore(state);
  const current = {
    attemptId: attempt.id, generation: attempt.generation, sessionId: served.sessionId, lastPhaseAt: attempt.lastPhaseAt,
    runner: attempt.processStartedAt && attempt.host ? `${attempt.processStartedAt}@${attempt.host}` : null,
  };
  const stored = store.get(taskId);
  const decision = decideDelta(request, current, stored);
  if (request.contextEpoch === undefined) store.delete(taskId);
  else store.set(taskId, { packetId: served.packetId, text: served.text, ...current, contextEpoch: request.contextEpoch });
  if (!decision.delta || !stored) return { contextDelta: { served: 'full', reason: decision.delta ? 'base-unavailable' : decision.reason } };
  try {
    return { delta: diffPackets(stored.packetId, stored.text, served.packetId, served.text), contextDelta: { served: 'delta' } };
  } catch (err) {
    logger.warn({ err, taskId, attemptId: attempt.id }, 'Failed to diff against the acknowledged base; serving the full packet');
    return { contextDelta: { served: 'full', reason: 'diff-failed' } };
  }
}

/**
 * get_context's `servedContext`: the task's revision and approved revision, its
 * open attempt and generation, and a durable receipt, recorded only with a
 * presented sessionId on a running attempt whose worker is the caller and the
 * task's assignee. A receipt records what was served to whom, never approval.
 * packetId is the sha256 of JSON.stringify(packet); a recorded read serves
 * JSON.parse of that text, or a delta against an acknowledged base (see
 * deltaAgainstBase). Other statuses hash and write nothing. servedContext
 * carries contextDelta only when the caller presented a delta field.
 *
 * Error handling: never throws. An unreadable revision or attempt is served as
 * null; a failed write is logged and served as 'record-failed' with no ids.
 */
async function servedContextIdentity<P extends object>(
  state: StateManager,
  task: Task,
  packet: P,
  caller: { view: 'default' | 'full'; workerId: string; sessionId: string | undefined; delta: DeltaRequest }
) {
  const unreadable: string[] = [];
  const planRevision = decoded(unreadable, 'planRevision', () => decodeStoredPlanRevision(task));
  // currentAttempt copies the stored record, which overflows on a hand-edited one nested too deep.
  const attempt = decoded(unreadable, 'attempt', () => currentAttempt(state, task.id));
  const approved = task.approvedPlanRevision;
  const identity = {
    taskId: task.id,
    planRevision,
    approvedPlanRevision: typeof approved === 'number' && Number.isSafeInteger(approved) && approved >= 0 ? approved : null,
    attemptId: attempt?.id ?? null,
    generation: attempt?.generation ?? null,
  };
  const presented = caller.delta.basePacketId !== undefined || caller.delta.contextEpoch !== undefined;
  const unrecorded = (receiptStatus: ReceiptStatus) => ({
    packet: packet as P | { delta: ContextDelta },
    servedContext: {
      ...identity, receiptStatus, receiptId: null as string | null, packetId: null as string | null,
      ...(presented ? { contextDelta: { served: 'full', reason: receiptStatus } as ContextDeltaStatus } : {}),
    },
  });
  if (unreadable.length > 0 || planRevision === null) return unrecorded('identity-unreadable');
  if (caller.sessionId === undefined) return unrecorded('no-session');
  if (!attempt || attempt.phase !== 'running') return unrecorded('no-running-attempt');
  const owner = caller.workerId;
  if (!owner || attempt.workerId !== owner || task.assignedWorkerId !== owner) return unrecorded('not-attempt-owner');
  try {
    const text = JSON.stringify(packet);
    const packetId = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const receipt = await recordContextReceipt(state, {
      attemptId: attempt.id, workerId: owner, sessionId: caller.sessionId, packetId, planRevision,
      ...(identity.approvedPlanRevision !== null ? { approvedPlanRevision: identity.approvedPlanRevision } : {}),
      view: caller.view,
    });
    const servedContext = { ...identity, receiptStatus: 'recorded' as ReceiptStatus, receiptId: receipt.id, packetId };
    if (!presented) return { packet: JSON.parse(text) as P, servedContext };
    const { delta, contextDelta } = deltaAgainstBase(state, task.id, attempt, caller.delta, { sessionId: caller.sessionId, packetId, text });
    return { packet: delta ? { delta } : JSON.parse(text) as P, servedContext: { ...servedContext, contextDelta } };
  } catch (err) {
    logger.warn({ err, taskId: task.id, attemptId: attempt.id }, 'Failed to record a served-context receipt; serving the context without one');
    return unrecorded('record-failed');
  }
}
import { DEFAULT_CHAT_CONTEXT_CHARS, DEFAULT_CHAT_CONTEXT_LIMIT, truncateChatMessage } from '../util/chatPayload.js';
import {
  compactTaskComments,
  DEFAULT_COMMENT_CONTENT_CHARS,
  DEFAULT_CONTEXT_COMMENTS_LIMIT,
  MAX_COMMENT_CONTENT_CHARS,
  MAX_CONTEXT_COMMENTS_LIMIT,
  normalizeIntegerOption,
} from '../util/taskPayload.js';
export function getContextTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_context',
    description: 'Read the working context for one task: project settings and global/epic/task rails, the epic, the task (plan and steps, definitionOfDone, executionContract when set, recent comments, verification, commits), its assigned worker, recent chat, planningNotes and a nextAction hint. Read-only. Fetch it after claiming and before planning, implementing or reviewing. Includes `routing` (the model catalog, efforts and tier defaults the architect picks from at submit_plan). Trimmed per role by default (a QA caller does not get task.epicSiblings, planningNotes or routing; a worker does not get routing; the response lists what was left out in `omitted`). That default is the complete read for the role: pass view:"full" only if you need a left-out section (any role may). view:"status" is a lighter delivery poll that does not count as having read the context. With a task, the default and view:"full" reads end with `servedContext`: the task\'s planRevision and approvedPlanRevision, its open attempt\'s attemptId and generation, and receiptStatus. Pass `sessionId` and such a read by the worker owning the task\'s running attempt records a durable served-context receipt (receiptId, and packetId: the sha256 of the payload without servedContext). A receipt records what was served to whom, never approval. Present basePacketId and contextEpoch and such a recorded read may answer with `delta` (changed JSON pointers and explicit removals) against that acknowledged base instead of the packet; a wrong or missing base, a restart, a reattach, a new attempt, another session or an epoch change gets the full packet, and servedContext.contextDelta says which and why. Those reads also carry `packetManifest`: the mandatory sections (rails, description, definitionOfDone, plan, executionContract), never role-trimmed or truncated and listed as missing when unset, each explicit omission with its reason and count, limitations, provenance, and a budget measured against packetBudgetChars that answers an overflow with an expand or restructure requirement; it never grants approval.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task to read' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' },
        view: {
          type: 'string', enum: ['full', 'status'],
          description: 'Omit for the normal read: the role-trimmed default, which counts as having read the context. "full" also returns the sections left out for your role; pass it only if you need one of them. "status" is a read-only delivery poll, excludes instructions and never counts as having read the context.'
        },
        commentsLimit: {
          type: 'number',
          description: 'Maximum recent task comments to include (default: 3, max: 50; 0 omits comments).'
        },
        commentsMaxChars: {
          type: 'number',
          description: 'Maximum chars per task comment (default: 1000, max: 10000; 0 returns full comment content).'
        },
        packetBudgetChars: {
          type: 'integer', minimum: MIN_PACKET_BUDGET_CHARS, maximum: MAX_PACKET_BUDGET_CHARS,
          description: `Character budget packetManifest measures the mandatory sections against (default 100000, ${MIN_PACKET_BUDGET_CHARS} to ${MAX_PACKET_BUDGET_CHARS}; anything else is refused). Never truncates: an overflow is reported with requirement expand or restructure.`
        },
        sessionId: {
          type: 'string',
          description: 'The receiving session\'s incarnation exactly as its runner names it, e.g. the agent wrapper\'s MOE_SESSION_ID `<workerId>@<preflight-iso>`; the daemon never derives it. With it, a default or view:"full" read by the worker that owns the task\'s running attempt records a durable served-context receipt on that attempt; view:"status" never does. Non-blank, at most 255 chars, no NUL or line breaks; anything else is refused.'
        },
        basePacketId: {
          type: 'string', pattern: '^sha256:[0-9a-f]{64}$',
          description: 'The servedContext.packetId of the packet this session holds. With contextEpoch, a recorded read answers with `delta` instead of the packet only when the daemon still holds that exact base for this session, attempt, generation, runner and phase; otherwise the full packet.'
        },
        contextEpoch: {
          type: 'integer', minimum: 0,
          description: 'The receiving session\'s compaction counter; the seat must advance it on every compaction. A read without it never gets a delta; one presenting basePacketId also clears the stored base.'
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        workerId?: string;
        view?: 'full' | 'status';
        commentsLimit?: number;
        commentsMaxChars?: number;
        sessionId?: unknown;
        packetBudgetChars?: unknown;
        basePacketId?: unknown;
        contextEpoch?: unknown;
      };
      const taskId = params.taskId || process.env.MOE_TASK_ID || '';
      const callerWorkerId = params.workerId || process.env.MOE_WORKER_ID || '';

      if (!state.project) {
        throw invalidState('Project', 'not loaded', 'loaded');
      }
      if (params.view !== undefined && params.view !== 'full' && params.view !== 'status') {
        throw invalidInput('view', 'must be one of: full, status');
      }
      // Presented by the caller only (never process.env), and refused in every
      // view before any write: a malformed id must not stamp contextFetchedBy.
      const sessionId = readContextSessionId(params.sessionId);
      const budgetChars = readPacketBudgetChars(params.packetBudgetChars);
      const deltaRequest = readDeltaRequest(params.basePacketId, params.contextEpoch);

      let task = taskId ? state.getTask(taskId) : null;
      let epic = task ? state.getEpic(task.epicId) : null;

      // An explicit taskId that names no task is NOT_FOUND, as in every other
      // tool. Falling through to the caller fallback below answered with a
      // DIFFERENT task (a short id like task-4566537d came back as the
      // caller's own claimed task) and stamped contextFetchedBy on it.
      if (!task && params.taskId) throw notFound('Task', params.taskId);

      if (!task) {
        // No explicit taskId (or a stale MOE_TASK_ID): fall back to the task
        // assigned to the caller (params.workerId, else MOE_WORKER_ID via
        // callerWorkerId).
        if (callerWorkerId) {
          const worker = state.getWorker(callerWorkerId);
          if (worker?.currentTaskId) {
            task = state.getTask(worker.currentTaskId);
            epic = task ? state.getEpic(task.epicId) : null;
          }
        }
      }

      // Find #general channel for chat context
      let generalChannelId: string | null = null;
      let recentChatMessages: Array<{
        id: string;
        sender: string;
        content: string;
        timestamp: string;
        contentTruncated?: boolean;
        contentOriginalLength?: number;
      }> = [];
      for (const ch of state.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          generalChannelId = ch.id;
          break;
        }
      }
      if (generalChannelId && DEFAULT_CHAT_CONTEXT_LIMIT > 0) {
        try {
          const msgs = await state.getMessages(generalChannelId, { limit: DEFAULT_CHAT_CONTEXT_LIMIT });
          recentChatMessages = msgs.map((m) => ({
            id: m.id,
            sender: m.sender,
            content: truncateChatMessage(m, DEFAULT_CHAT_CONTEXT_CHARS).content,
            timestamp: m.timestamp,
            ...(m.content.length > DEFAULT_CHAT_CONTEXT_CHARS
              ? {
                  contentTruncated: true,
                  contentOriginalLength: m.content.length,
                }
              : {})
          }));
        } catch { /* channel may have no messages yet */ }
      }

      const commentsLimit = normalizeIntegerOption(
        params.commentsLimit,
        'commentsLimit',
        DEFAULT_CONTEXT_COMMENTS_LIMIT,
        0,
        MAX_CONTEXT_COMMENTS_LIMIT
      );
      const commentsMaxChars = normalizeIntegerOption(
        params.commentsMaxChars,
        'commentsMaxChars',
        DEFAULT_COMMENT_CONTENT_CHARS,
        0,
        MAX_COMMENT_CONTENT_CHARS
      );

      // Polling is not reading the task's instructions: do not stamp
      // contextFetchedBy or update worker activity on this read-only path.
      if (params.view === 'status') return contextStatus(state, task, callerWorkerId);

      // Read planningNotes from task if present
      const planningNotes = task ? (task as unknown as Record<string, unknown>).planningNotes ?? null : null;
      const nextAction = contextNextAction(state, task, callerWorkerId);
      const compactedComments = task
        ? compactTaskComments(task.comments || [], commentsLimit, commentsMaxChars)
        : null;
      const assignedWorker = task?.assignedWorkerId
        ? state.getWorker(task.assignedWorkerId) ?? null
        : null;

      // Commit ledger + attribution evidence (moe.record_commit / declare_files).
      const commits = task ? taskCommits(task) : [];
      const commitProjection = commits.slice(-MAX_CONTEXT_COMMITS).map((c) => ({
        sha: c.sha,
        treeId: c.treeId ?? null,
        ref: c.ref,
        kind: c.kind,
        status: c.status ?? null,
        pushed: c.pushed ?? null,
        recordedAt: c.recordedAt,
        recordedBy: c.recordedBy,
        pathCount: Array.isArray(c.paths) ? c.paths.length : 0,
        inferredCount: Array.isArray(c.inferredPaths) ? c.inferredPaths.length : 0,
      }));
      const rescueRefs = commits.filter((c) => c.kind === 'rescue').map((c) => c.ref);
      const unattributedPaths = task && Array.isArray(task.unattributedPaths) ? task.unattributedPaths : [];
      // Declared prerequisites (dependsOn ∪ blockedOnTaskIds) bypass the
      // lower-order filter and the sibling cap, and carry the full evidence
      // block (verification/reviewSummary/completionSummary) so a dependent
      // task can READ what its prerequisite delivered from the board instead
      // of grepping HEAD.
      const declaredTargetIds = new Set<string>([
        ...(task && Array.isArray(task.dependsOn) ? task.dependsOn : []),
        ...(task && Array.isArray(task.blockedOnTaskIds) ? task.blockedOnTaskIds : []),
      ]);
      const siblingEntry = (t: Task) => {
        const siblingCommits = taskCommits(t);
        const landed = taskLanded(t, siblingCommits);
        const landing = buildLanding(siblingCommits);
        const declared = declaredTargetIds.has(t.id);
        return {
          id: t.id,
          title: t.title,
          order: t.order,
          status: t.status,
          landing: { ...(landing.lastCompletion ? { lastCompletion: landing.lastCompletion } : {}), merged: landed },
          landed,
          ...(declared
            ? {
                declaredDependency: true,
                // Always agent-reported, whatever the stored row claims (see the
                // primary task.verification projection).
                verification: t.verification
                  ? {
                      command: t.verification.command,
                      exitCode: t.verification.exitCode,
                      reportedAt: t.verification.reportedAt,
                      source: 'agent-reported',
                    }
                  : null,
                reviewSummary: t.reviewSummary ?? null,
                completionSummary: t.completionSummary ?? null,
              }
            : {}),
        };
      };
      // Prerequisites in the same epic (lower order), nearest first, bounded —
      // plus EVERY declared dependency target regardless of order/epic/cap.
      const lowerOrder = task
        ? Array.from(state.tasks.values()).filter((t) => t.epicId === task.epicId && t.id !== task.id && t.order < task.order)
        : [];
      const baseSiblings = lowerOrder
        .sort((a, b) => b.order - a.order)
        .slice(0, MAX_EPIC_SIBLINGS)
        .sort((a, b) => a.order - b.order);
      const baseSiblingIds = new Set(baseSiblings.map((t) => t.id));
      // Left out by the cap; a declared target past it is still served below.
      const siblingsBeyondCap = lowerOrder.filter((t) => !baseSiblingIds.has(t.id) && !declaredTargetIds.has(t.id)).length;
      const declaredExtras = task
        ? Array.from(declaredTargetIds)
            .filter((id) => id !== task.id && !baseSiblingIds.has(id))
            .map((id) => state.getTask(id))
            .filter((t): t is Task => Boolean(t))
            .sort((a, b) => a.order - b.order)
        : [];
      const epicSiblings = [...baseSiblings, ...declaredExtras].map(siblingEntry);
      // Epic-final: the epic's designated final task, else the highest-order
      // fallback (isEpicFinalTask, the one rule the delivery policy shares).
      // The wrapper prefers this daemon-provided value when present.
      const isEpicFinal = task ? isEpicFinalTask(state, task) : undefined;

      // Record ownership bookkeeping so start_step can enforce context-fetched ordering.
      if (task && callerWorkerId) {
        const existing = Array.isArray(task.contextFetchedBy) ? task.contextFetchedBy : [];
        if (!existing.includes(callerWorkerId)) {
          try {
            await state.updateTask(task.id, {
              contextFetchedBy: [...existing, callerWorkerId],
            });
          } catch (err) {
            logger.warn(
              { err, taskId: task.id, workerId: callerWorkerId },
              'Failed to record contextFetchedBy; continuing'
            );
          }
        }
      }
      if (callerWorkerId) {
        await state.touchWorker(callerWorkerId);
      }

      // The task's CURRENT candidate — the bytes a reviewer is being asked to
      // read, and the id qa_approve/qa_reject bind their decision to. Selection
      // is "last by createdAt then id", and it deliberately reuses
      // listCandidatesForTask rather than sorting again here: one definition of
      // "current", shared with the record_candidate side, so the two can never
      // drift. That helper already hands out copies, so nothing in the response
      // aliases stored state.
      //
      // Surfaced whenever a candidate exists, not only in REVIEW: a worker about
      // to record a second candidate needs it too, and a status gate would make
      // the field vanish exactly when a reviewer re-reads a reopened task.
      const taskCandidates = task ? listCandidatesForTask(state, task.id) : [];
      const currentCandidate = taskCandidates.length > 0 ? taskCandidates[taskCandidates.length - 1] : undefined;
      const executionPolicy = task ? executionPolicyContext(state, task) : undefined;
      // The approved protected-check overlay; readRequiredCheckSnapshot never throws
      // and answers null for a stale, forged or malformed snapshot, which is omitted.
      const requiredCheckSnapshot = task ? readRequiredCheckSnapshot(task) : null;
      // Served to every role, never role-trimmed: a refresh resume needs changedPaths, an architect the reasons.
      const planReuse = task ? planReuseContext(task) : null;
      // Role trim applies only to the default view; view:"full" is never gated by role.
      const callerRole = params.view !== 'full' && task && callerWorkerId
        ? resolveWorkerRole(state, callerWorkerId) : undefined;
      const omitted = (callerRole && ROLE_OMITTED[callerRole]) || [];
      const trimForQa = callerRole === 'qa';

      const body = {
        project: {
          id: state.project.id,
          name: state.project.name,
          globalRails: state.project.globalRails,
          settings: state.project.settings
        },
        epic: epic
          ? {
              id: epic.id,
              title: epic.title,
              description: epic.description,
              architectureNotes: epic.architectureNotes,
              epicRails: epic.epicRails,
              ...(typeof epic.finalTaskId === 'string' && epic.finalTaskId ? { finalTaskId: epic.finalTaskId } : {})
            }
          : null,
        task: task
          ? {
              id: task.id,
              title: task.title,
              description: task.description,
              definitionOfDone: task.definitionOfDone,
              taskRails: task.taskRails,
              // Mandatory execution context for workers and QA; never role-trimmed.
              ...(task.executionContract !== undefined && task.executionContract !== null
                ? { executionContract: task.executionContract } : {}),
              ...(planReuse ? { planReuse } : {}),
              ...(requiredCheckSnapshot ? { requiredCheckSnapshot } : {}),
              status: task.status,
              priority: task.priority,
              assignedWorkerId: task.assignedWorkerId,
              reopenCount: task.reopenCount,
              reopenReason: task.reopenReason,
              // Surfaced even when the row is no longer BLOCKED: the block
              // quartet below is status-gated, so without this a cleared block
              // leaves no readable trace and the claimer cannot tell a resolved
              // block from an erased one.
              ...(task.priorBlockedReason ? { priorBlockedReason: task.priorBlockedReason } : {}),
              rejectionDetails: task.rejectionDetails || null,
              // Epic-final flag (drives the wrapper's qualityGate scope) and
              // dependency surface: declared prerequisites plus, on a BLOCKED
              // task, the structured block bookkeeping.
              isEpicFinal,
              ...(Array.isArray(task.dependsOn) && task.dependsOn.length > 0
                ? { dependsOn: task.dependsOn, dependsOnUnmet: unmetDependsOn(state, task) }
                : {}),
              ...(task.status === 'BLOCKED'
                ? {
                    blockedReason: task.blockedReason ?? null,
                    blockedOnTaskIds: task.blockedOnTaskIds ?? null,
                    blockedResourceId: task.blockedResourceId ?? null,
                    blockedFromStatus: task.blockedFromStatus ?? null,
                    blockedAt: task.blockedAt ?? null,
                  }
                : {}),
              // Size pressure from the latest submit_plan (warn-zone only) —
              // an architect re-claiming after a size-critic block sees why.
              ...(task.planSizeWarnings && task.planSizeWarnings.length > 0
                ? { planSizeWarnings: task.planSizeWarnings }
                : {}),
              // Evidence surface for QA: what the worker ran to claim done,
              // its complete_task summary, the aggregated changed-file set, and
              // recent rejection history (newest-first) so repeat failures are
              // visible without digging.
              // Legacy verification is candidate-less agent attestation, so it is
              // always projected as agent-reported: a row predating the label, or
              // one hand-edited to claim runner-observed, is not upgraded by a
              // read. A fresh copy, so the label is never written back into state
              // and a caller mutating the response cannot reach the stored row.
              verification: task.verification ? { ...task.verification, source: 'agent-reported' } : null,
              ...(task.completionSummary ? { completionSummary: task.completionSummary } : {}),
              filesModified: task.filesModified || [],
              // Git landing evidence: what the wrapper recorded (moe.record_commit),
              // the ASSERTED attribution tier the next exit will commit, and the
              // paths the last session changed but could not attribute.
              commits: commitProjection,
              commitCount: commits.length,
              lastCommitOutcome: task.lastCommitOutcome ?? null,
              landing: buildLanding(commits),
              declaredPaths: collectAssertedPaths(task),
              inferredPaths: Array.isArray(task.inferredPaths) ? task.inferredPaths : [],
              unattributedPaths,
              ...(unattributedPaths.length > 0
                ? {
                    unattributedHint: `${unattributedPaths.length} path(s) were changed in an earlier session of this task but not attributed to it (peers active / declared-only policy): ${unattributedPaths.join(', ')}. If they are yours, call moe.declare_files { taskId: "${task.id}", paths: [...] } so the next exit commits them under this task.`
                  }
                : {}),
              ...(rescueRefs.length > 0
                ? {
                    rescueRefsHint: `Earlier sessions of this task left rescue checkpoints: ${rescueRefs.join(', ')}. Recover with \`git show <ref> --stat\` / \`git checkout <ref> -- <path>\` before redoing work.`
                  }
                : {}),
              ...(trimForQa ? {} : { epicSiblings }),
              ...(task.rejectionHistory && task.rejectionHistory.length > 0
                ? { rejectionHistory: task.rejectionHistory.slice(0, 5) }
                : {}),
              implementationPlan: task.implementationPlan,
              planSubmittedAt: task.planSubmittedAt || null,
              planApprovedAt: task.planApprovedAt || null,
              workStartedAt: task.workStartedAt || null,
              completedAt: task.completedAt || null,
              reviewStartedAt: task.reviewStartedAt || null,
              reviewCompletedAt: task.reviewCompletedAt || null,
              comments: compactedComments?.comments ?? [],
              commentSummary: compactedComments
                ? {
                    total: compactedComments.totalComments,
                    returned: compactedComments.returnedComments,
                    omitted: compactedComments.omittedComments,
                    truncated: compactedComments.truncatedComments,
                    hint: compactedComments.omittedComments > 0 || compactedComments.truncatedComments > 0
                      ? 'Task comments are compact. Increase commentsLimit or set commentsMaxChars: 0 when full comment text is needed.'
                      : undefined,
                  }
                : undefined,
              generalChannelId
            }
          : null,
        // Omitted entirely (not null) when the task has no candidate, so a
        // project that has never recorded one sees a byte-identical payload.
        ...(currentCandidate ? { currentCandidate } : {}),
        // Omitted entirely when no profile data exists (see executionPolicyContext).
        ...(executionPolicy ? { executionPolicy } : {}),
        worker: assignedWorker
          ? {
              id: assignedWorker.id,
              type: assignedWorker.type,
              status: assignedWorker.status,
              currentTaskId: assignedWorker.currentTaskId,
              lastActivityAt: assignedWorker.lastActivityAt,
              lastError: assignedWorker.lastError,
              errorCount: assignedWorker.errorCount,
              teamId: assignedWorker.teamId ?? null,
            }
          : null,
        allRails: {
          global: state.project.globalRails.requiredPatterns,
          epic: epic?.epicRails || [],
          task: task?.taskRails || []
        },
        ...(generalChannelId
          ? {
              chat: {
                channelId: generalChannelId,
                recentMessages: recentChatMessages,
                hint: 'Recent chat is compact. Use moe.chat_send to post updates/questions. Use moe.chat_read with maxContentChars: 0 for full history.'
              }
            }
          : {}),
        ...(trimForQa ? {} : { planningNotes }),
        ...(omitted.includes('routing') ? {} : { routing: routingInfo(state.project.settings) }),
        ...(nextAction ? { nextAction } : {}),
        ...(omitted.length > 0
          ? { omitted, omittedHint: `Left out for the ${callerRole} role, whose work does not read them; this is the complete read for the role. Pass view:"full" only if you need one of these sections.` }
          : {}),
      };
      if (!task) return body;
      // Appended before servedContextIdentity, so F06's packetId digest covers it.
      const packet = {
        ...body,
        packetManifest: buildPacketManifest(body, {
          planRevision: decoded([], 'planRevision', () => decodeStoredPlanRevision(task)),
          roleOmitted: omitted, siblingsBeyondCap, commitsTotal: commits.length,
          rejectionsTotal: Array.isArray(task.rejectionHistory) ? task.rejectionHistory.length : 0, budgetChars,
        }),
      };
      const view = params.view === 'full' ? 'full' : 'default';
      const served = await servedContextIdentity(state, task, packet, { view, workerId: callerWorkerId, sessionId, delta: deltaRequest });
      return { ...served.packet, servedContext: served.servedContext };
    }
  };
}

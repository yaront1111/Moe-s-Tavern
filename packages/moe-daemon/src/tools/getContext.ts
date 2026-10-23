import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskCommit } from '../types/schema.js';
import { invalidInput, invalidState, notFound } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { contextNextAction } from '../util/contextNextAction.js';
import { collectAssertedPaths } from '../util/attributionTiers.js';
import { unmetDependsOn } from '../state/dependencyUnblock.js';
import { listCandidatesForTask } from '../state/candidateStore.js';
import { contextStatus } from '../util/contextStatus.js';
import { resolveWorkerRole } from '../util/workerRole.js';
import { routingInfo } from '../util/routing.js';

/**
 * Sections dropped from a QA caller's default payload: no QA doc or skill reads
 * them (QA reviews the delivered bytes against DoD and plan), and together they
 * are ~20% of an average payload. view:"full" returns them for any role.
 */
// Default-view trims per role (view:"full" is never trimmed). routing is the
// planner's model/effort catalog: only architects and governors choose from it.
const ROLE_OMITTED: Record<string, string[]> = {
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
    description: 'Read the working context for one task: project settings and global/epic/task rails, the epic, the task (plan and steps, definitionOfDone, recent comments, verification, commits), its assigned worker, recent chat, planningNotes and a nextAction hint. Read-only. Fetch it after claiming and before planning, implementing or reviewing. Includes `routing` (the model catalog, efforts and tier defaults the architect picks from at submit_plan). Trimmed per role by default (a QA caller does not get task.epicSiblings, planningNotes or routing; a worker does not get routing; the response lists what was left out in `omitted`). That default is the complete read for the role: pass view:"full" only if you need a left-out section (any role may). view:"status" is a lighter delivery poll that does not count as having read the context.',
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
      };
      const taskId = params.taskId || process.env.MOE_TASK_ID || '';
      const callerWorkerId = params.workerId || process.env.MOE_WORKER_ID || '';

      if (!state.project) {
        throw invalidState('Project', 'not loaded', 'loaded');
      }
      if (params.view !== undefined && params.view !== 'full' && params.view !== 'status') {
        throw invalidInput('view', 'must be one of: full, status');
      }

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
      const baseSiblings = task
        ? Array.from(state.tasks.values())
            .filter((t) => t.epicId === task.epicId && t.id !== task.id && t.order < task.order)
            .sort((a, b) => b.order - a.order)
            .slice(0, MAX_EPIC_SIBLINGS)
            .sort((a, b) => a.order - b.order)
        : [];
      const baseSiblingIds = new Set(baseSiblings.map((t) => t.id));
      const declaredExtras = task
        ? Array.from(declaredTargetIds)
            .filter((id) => id !== task.id && !baseSiblingIds.has(id))
            .map((id) => state.getTask(id))
            .filter((t): t is Task => Boolean(t))
            .sort((a, b) => a.order - b.order)
        : [];
      const epicSiblings = [...baseSiblings, ...declaredExtras].map(siblingEntry);
      // Epic-final = highest `order` among the epic's non-ARCHIVED tasks (ties
      // count; missing epicId defaults to final — gate on the safe side). Same
      // rule the agent wrapper computes via list_tasks; the wrapper prefers
      // this daemon-provided value when present.
      const isEpicFinal = task
        ? !task.epicId
          ? true
          : (task.order ?? 0) >= Math.max(
              (task.order ?? 0),
              ...Array.from(state.tasks.values())
                .filter((t) => t.epicId === task.epicId && t.status !== 'ARCHIVED')
                .map((t) => (typeof t.order === 'number' && Number.isFinite(t.order) ? t.order : 0))
            )
        : undefined;

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
      // Role trim applies only to the default view; view:"full" is never gated by role.
      const callerRole = params.view !== 'full' && task && callerWorkerId
        ? resolveWorkerRole(state, callerWorkerId) : undefined;
      const omitted = (callerRole && ROLE_OMITTED[callerRole]) || [];
      const trimForQa = callerRole === 'qa';

      return {
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
              epicRails: epic.epicRails
            }
          : null,
        task: task
          ? {
              id: task.id,
              title: task.title,
              description: task.description,
              definitionOfDone: task.definitionOfDone,
              taskRails: task.taskRails,
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
    }
  };
}

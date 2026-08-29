import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskCommit } from '../types/schema.js';
import { invalidState } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { collectAssertedPaths } from '../util/attributionTiers.js';
import { unmetDependsOn } from '../state/dependencyUnblock.js';

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
    description: 'Get current project/epic/task context and rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        workerId: { type: 'string' },
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
        commentsLimit?: number;
        commentsMaxChars?: number;
      };
      const taskId = params.taskId || process.env.MOE_TASK_ID || '';
      const callerWorkerId = params.workerId || process.env.MOE_WORKER_ID || '';

      if (!state.project) {
        throw invalidState('Project', 'not loaded', 'loaded');
      }

      let task = taskId ? state.getTask(taskId) : null;
      let epic = task ? state.getEpic(task.epicId) : null;

      if (!task) {
        // Try fallback: find the task assigned to the caller (params.workerId,
        // else MOE_WORKER_ID via callerWorkerId).
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

      // Read planningNotes from task if present
      const planningNotes = task ? (task as unknown as Record<string, unknown>).planningNotes ?? null : null;
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
                verification: t.verification
                  ? {
                      command: t.verification.command,
                      exitCode: t.verification.exitCode,
                      reportedAt: t.verification.reportedAt,
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
              verification: task.verification || null,
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
              epicSiblings,
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
        planningNotes,
        // Suggest the role-appropriate next action based on the task's current column.
        ...(task
          ? {
              nextAction: (() => {
                if (task.status === 'PLANNING') {
                  return {
                    tool: 'moe.submit_plan',
                    args: { taskId: task.id, workerId: callerWorkerId || undefined },
                    reason: 'Plan this task and submit for approval.',
                    recommendedSkill: recommendSkillFor('architect', 'planning_entry')
                  };
                }
                if (task.status === 'WORKING') {
                  const nextStep = (task.implementationPlan || []).find(s => s.status === 'PENDING' || s.status === 'IN_PROGRESS');
                  // If reopened, point the worker at receiving-code-review first.
                  const reopenedSkill = (task.reopenCount || 0) > 0
                    ? recommendSkillFor('worker', 'reopened')
                    : undefined;
                  if (nextStep) {
                    const isFirstStep = (task.implementationPlan || []).every(
                      s => s.status === 'PENDING' || s.stepId === nextStep.stepId
                    );
                    return {
                      tool: 'moe.start_step',
                      args: { taskId: task.id, stepId: nextStep.stepId, workerId: callerWorkerId || undefined },
                      reason: `Begin step: ${nextStep.description.slice(0, 80)}`,
                      recommendedSkill: reopenedSkill
                        ?? (isFirstStep ? recommendSkillFor('worker', 'first_start_step') : undefined)
                    };
                  }
                  return {
                    tool: 'moe.complete_task',
                    args: { taskId: task.id, workerId: callerWorkerId || undefined },
                    reason: 'All steps complete; hand task off to QA.',
                    // Reopened tasks land here when QA rejected without resetting steps —
                    // point the worker at the rejection-reading skill before they re-finish.
                    recommendedSkill: reopenedSkill ?? recommendSkillFor('worker', 'before_complete_task')
                  };
                }
                if (task.status === 'REVIEW') {
                  return {
                    tool: 'moe.qa_approve',
                    args: { taskId: task.id, workerId: callerWorkerId || undefined },
                    reason: 'Verify DoD + rails; re-run the verification command from task.verification yourself; confirm a completion commit is recorded in task.commits (`git show <sha>`) before approving; approve or moe.qa_reject with actionable issues.',
                    recommendedSkill: recommendSkillFor('qa', 'review_entry')
                  };
                }
                return undefined;
              })()
            }
          : {}),
      };
    }
  };
}

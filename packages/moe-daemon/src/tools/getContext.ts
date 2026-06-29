import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidState } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
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
                    reason: 'Verify DoD + rails; approve or moe.qa_reject with actionable issues.',
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

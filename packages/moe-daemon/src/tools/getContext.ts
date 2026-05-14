import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { MEMORY_AUTO_INJECT_MODES, resolveMemorySettings, truncateForBudget } from '../util/memorySettings.js';
import { DEFAULT_CHAT_CONTEXT_CHARS, DEFAULT_CHAT_CONTEXT_LIMIT, truncateChatMessage } from '../util/chatPayload.js';
import {
  compactTaskComments,
  DEFAULT_COMMENT_CONTENT_CHARS,
  DEFAULT_CONTEXT_COMMENTS_LIMIT,
  MAX_COMMENT_CONTENT_CHARS,
  MAX_CONTEXT_COMMENTS_LIMIT,
  normalizeIntegerOption,
} from '../util/taskPayload.js';
import type { MemoryAutoInjectMode } from '../types/schema.js';

type MemoryContext = {
  mode: MemoryAutoInjectMode;
  relevant: Array<{
    id: string;
    type: string;
    confidence: number;
    preview?: string;
    content?: string;
    truncated?: boolean;
  }>;
  lastSession: unknown;
  hint?: string;
};

function oneLinePreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function appendWithinBudget<T extends { text: string; truncated: boolean }>(
  text: string,
  remainingBudget: number,
  mapper: (chunk: { text: string; truncated: boolean }) => T
): T {
  return mapper(truncateForBudget(text, Math.max(0, remainingBudget)));
}

export function getContextTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_context',
    description: 'Get current project/epic/task context and rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        workerId: { type: 'string' },
        memoryMode: {
          type: 'string',
          enum: MEMORY_AUTO_INJECT_MODES,
          description: 'Memory auto-injection mode for this call: off, summary, or full. Defaults to project settings.'
        },
        memoryLimit: { type: 'number', description: 'Override max auto-surfaced memories for this call.' },
        memoryMaxChars: { type: 'number', description: 'Override total memory character budget for this call.' },
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
        memoryMode?: MemoryAutoInjectMode;
        memoryLimit?: number;
        memoryMaxChars?: number;
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
        // Try fallback: find first task assigned to MOE_WORKER_ID
        const workerId = process.env.MOE_WORKER_ID;
        if (workerId) {
          const worker = state.getWorker(workerId);
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

      const memorySettings = resolveMemorySettings(state.project.settings);
      if (params.memoryMode !== undefined && !MEMORY_AUTO_INJECT_MODES.includes(params.memoryMode as MemoryAutoInjectMode)) {
        throw invalidInput('memoryMode', `must be one of: ${MEMORY_AUTO_INJECT_MODES.join(', ')}`);
      }
      const memoryMode = params.memoryMode ?? memorySettings.autoInject;
      const memoryLimit = normalizeIntegerOption(
        params.memoryLimit,
        'memoryLimit',
        memorySettings.maxAutoResults,
        0,
        10
      );
      const memoryMaxChars = normalizeIntegerOption(
        params.memoryMaxChars,
        'memoryMaxChars',
        memorySettings.maxAutoChars,
        0,
        10_000
      );
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

      // Auto-surface relevant memories from the knowledge base, but keep the
      // default token footprint small. Full memory content remains available
      // through explicit moe.recall.
      let memoryContext: MemoryContext = {
        mode: memoryMode,
        relevant: [],
        lastSession: null,
        hint: memoryMode === 'summary'
          ? 'Memory previews only. Call moe.recall with the memory id/query when full content is useful.'
          : memoryMode === 'off'
            ? 'Memory auto-injection disabled for this context.'
            : undefined,
      };

      if (task && memoryMode !== 'off' && memoryLimit > 0) {
        try {
          const mm = state.getMemoryManager();
          // Build a richer search query. In addition to title+description, include
          // signals that boost recall precision for reopened and constrained tasks:
          //   - reopenReason: explicit failure patterns from last QA rejection
          //   - rejectionDetails.failedDodItems: which DoD items failed
          //   - task rails: constraints that shape the solution space
          //   - epic architecture notes + epic rails: architectural context
          // All trimmed so the query stays bounded.
          const failedDod = (task.rejectionDetails?.failedDodItems || []).join(' ');
          const epicBits = epic
            ? [epic.architectureNotes || '', ...(epic.epicRails || [])].join(' ')
            : '';
          const searchTerms = [
            task.title,
            task.description,
            task.reopenReason || '',
            failedDod,
            ...(task.taskRails || []),
            epicBits,
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 4000); // cap to keep BM25 bounded
          const affectedFiles = task.implementationPlan
            ?.flatMap(s => s.affectedFiles || []) || [];

          let remainingBudget = memoryMaxChars;
          if (searchTerms) {
            const memories = await mm.search({
              query: searchTerms,
              files: affectedFiles,
              limit: memoryLimit,
              minConfidence: 0.4,
            });
            memoryContext.relevant = memories.map(r => {
              const base = {
                id: r.entry.id,
                type: r.entry.type,
                confidence: Math.round(r.entry.confidence * 10) / 10,
              };
              const sourceText = memoryMode === 'summary'
                ? oneLinePreview(r.entry.content)
                : r.entry.content;
              const chunk = appendWithinBudget(sourceText, remainingBudget, value => value);
              remainingBudget = Math.max(0, remainingBudget - chunk.text.length);
              return memoryMode === 'summary'
                ? { ...base, preview: chunk.text, truncated: chunk.truncated }
                : { ...base, content: chunk.text, truncated: chunk.truncated };
            });
          }

          const lastSession = mm.getLastSession(task.id);
          if (lastSession) {
            if (memoryMode === 'full') {
              const summary = truncateForBudget(lastSession.summary, remainingBudget);
              memoryContext.lastSession = {
                ...lastSession,
                summary: summary.text,
                truncated: summary.truncated,
              };
              remainingBudget = Math.max(0, remainingBudget - summary.text.length);
            } else {
              const summary = truncateForBudget(lastSession.summary, Math.min(remainingBudget, 500));
              memoryContext.lastSession = {
                id: lastSession.id,
                workerId: lastSession.workerId,
                taskId: lastSession.taskId,
                role: lastSession.role,
                summaryPreview: oneLinePreview(summary.text),
                truncated: summary.truncated,
                createdAt: lastSession.createdAt,
              };
              remainingBudget = Math.max(0, remainingBudget - summary.text.length);
            }
          }
        } catch { /* memory system failure should not break get_context */ }
      }

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
        memory: memoryContext,
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

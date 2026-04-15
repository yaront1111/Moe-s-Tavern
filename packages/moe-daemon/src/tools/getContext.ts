import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidState } from '../util/errors.js';

export function getContextTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_context',
    description: 'Get current project/epic/task context and rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string };
      const taskId = params.taskId || process.env.MOE_TASK_ID || '';

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
      let recentChatMessages: Array<{ sender: string; content: string; timestamp: string }> = [];
      for (const ch of state.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          generalChannelId = ch.id;
          break;
        }
      }
      if (generalChannelId) {
        try {
          const msgs = await state.getMessages(generalChannelId, { limit: 5 });
          recentChatMessages = msgs.map((m) => ({
            sender: m.sender,
            content: m.content,
            timestamp: m.timestamp
          }));
        } catch { /* channel may have no messages yet */ }
      }

      // Auto-surface relevant memories from the knowledge base
      let memoryContext: {
        relevant: Array<{ id: string; type: string; content: string; confidence: number }>;
        lastSession: unknown;
      } = { relevant: [], lastSession: null };

      if (task) {
        try {
          const mm = state.getMemoryManager();
          // Build search query from task context
          const searchTerms = [task.title, task.description].filter(Boolean).join(' ');
          const affectedFiles = task.implementationPlan
            ?.flatMap(s => s.affectedFiles || []) || [];

          if (searchTerms) {
            const memories = await mm.search({
              query: searchTerms,
              files: affectedFiles,
              limit: 5,
              minConfidence: 0.3,
            });
            memoryContext.relevant = memories.map(r => ({
              id: r.entry.id,
              type: r.entry.type,
              content: r.entry.content,
              confidence: Math.round(r.entry.confidence * 100) / 100,
            }));
          }

          memoryContext.lastSession = mm.getLastSession(task.id);
        } catch { /* memory system failure should not break get_context */ }
      }

      // Read planningNotes from task if present
      const planningNotes = task ? (task as unknown as Record<string, unknown>).planningNotes ?? null : null;

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
              comments: task.comments || [],
              generalChannelId
            }
          : null,
        worker: task?.assignedWorkerId ? state.getWorker(task.assignedWorkerId) ?? null : null,
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
                hint: 'Use moe.chat_send to post updates/questions. Use moe.chat_read for full history.'
              }
            }
          : {}),
        memory: memoryContext,
        planningNotes,
      };
    }
  };
}

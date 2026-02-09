import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function getPendingQuestionsTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_pending_questions',
    description: 'Get all tasks that have unanswered human questions. Returns the pending questions so agents can answer them.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'Optional epic ID filter' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string };

      const results: Array<{
        taskId: string;
        title: string;
        status: string;
        epicId: string;
        assignedWorkerId: string | null;
        questions: Array<{ commentId: string; content: string; timestamp: string }>;
      }> = [];

      for (const task of state.tasks.values()) {
        if (!task.hasPendingQuestion) continue;
        if (params.epicId && task.epicId !== params.epicId) continue;

        const comments = task.comments || [];

        // Find the index of the last agent/worker comment
        let lastAgentIdx = -1;
        for (let i = comments.length - 1; i >= 0; i--) {
          if (comments[i].author !== 'human') {
            lastAgentIdx = i;
            break;
          }
        }

        // Collect human comments after the last agent comment
        const questions = comments
          .slice(lastAgentIdx + 1)
          .filter((c) => c.author === 'human')
          .map((c) => ({ commentId: c.id, content: c.content, timestamp: c.timestamp }));

        if (questions.length > 0) {
          results.push({
            taskId: task.id,
            title: task.title,
            status: task.status,
            epicId: task.epicId,
            assignedWorkerId: task.assignedWorkerId,
            questions
          });
        }
      }

      return { count: results.length, tasks: results };
    }
  };
}

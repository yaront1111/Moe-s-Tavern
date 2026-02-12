import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { generateId } from '../util/ids.js';
import { missingRequired, notFound } from '../util/errors.js';

export function addCommentTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.add_comment',
    description: 'Add a comment to a task (for questions or responses)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to comment on' },
        content: { type: 'string', description: 'The comment text' },
        workerId: { type: 'string', description: 'The worker ID (used as author)' }
      },
      required: ['taskId', 'content'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; content?: string; workerId?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }
      if (!params.content || params.content.trim().length === 0) {
        throw missingRequired('content');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      const comment = {
        id: generateId('comment'),
        author: params.workerId || 'agent',
        content: params.content.trim(),
        timestamp: new Date().toISOString()
      };

      const comments = [...(task.comments || []), comment];
      const updated = await state.updateTask(params.taskId, { comments, hasPendingQuestion: false }, 'TASK_COMMENT_ADDED');

      return {
        success: true,
        taskId: updated.id,
        commentId: comment.id,
        totalComments: comments.length
      };
    }
  };
}

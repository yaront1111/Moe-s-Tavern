import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { MAX_COMMENTS_PER_TASK } from '../state/StateManager.js';
import { generateId } from '../util/ids.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';

export const MAX_TASK_COMMENT_LENGTH = 10_000;

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
      if (params.content === undefined) {
        throw missingRequired('content');
      }
      if (typeof params.content !== 'string') {
        throw invalidInput('content', 'must be a string');
      }

      const trimmedContent = params.content.trim();
      if (trimmedContent.length === 0) {
        throw missingRequired('content');
      }
      if (trimmedContent.length > MAX_TASK_COMMENT_LENGTH) {
        throw invalidInput('content', `must be ${MAX_TASK_COMMENT_LENGTH} characters or fewer`);
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      const comment = {
        id: generateId('comment'),
        author: params.workerId || 'agent',
        content: trimmedContent,
        timestamp: new Date().toISOString()
      };

      const existingComments = Array.isArray(task.comments) ? task.comments : [];
      const comments = [...existingComments, comment];
      const boundedComments = comments.length > MAX_COMMENTS_PER_TASK
        ? comments.slice(-MAX_COMMENTS_PER_TASK)
        : comments;
      const updated = await state.updateTask(
        params.taskId,
        { comments: boundedComments, hasPendingQuestion: false },
        'TASK_COMMENT_ADDED'
      );

      return {
        success: true,
        taskId: updated.id,
        commentId: comment.id,
        totalComments: Array.isArray(updated.comments) ? updated.comments.length : 0
      };
    }
  };
}

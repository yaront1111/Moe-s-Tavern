import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskComment } from '../types/schema.js';
import { MAX_COMMENTS_PER_TASK } from '../state/StateManager.js';
import { MAX_CHAT_MESSAGE_BYTES } from '../util/chatPayload.js';
import { generateId } from '../util/ids.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { logger } from '../util/logger.js';

export const MAX_TASK_COMMENT_LENGTH = 10_000;

type MentionRelay =
  | { routing: { messageId: string; channel: string; routingTargets: string[] } }
  | { routingError: string };

/** Who `content` would wake if `sender` posted it: the router's own parse, minus the sender. */
function routableMentions(state: StateManager, content: string, sender: string): string[] {
  const workers = Array.from(state.workers.values());
  return state.mentionRouter
    .parseMentions(content, workers.map((w) => w.id), workers, Array.from(state.teams.values()))
    .filter((id) => id !== sender);
}

/**
 * Relay a comment's routable @mentions into chat as ONE message, through the
 * same sendMessage path as moe.chat_send, so the named seats' chat_wait wakes.
 * A comment used to store its "@governor" and tell nobody: comment-acd0254f on
 * task-162a6061 (2026-10-20) waited ~2h for a governor that never woke.
 * Returns undefined when the comment addresses nobody, so it posts nothing.
 */
async function relayMentions(state: StateManager, task: Task, comment: TaskComment): Promise<MentionRelay | undefined> {
  // chat_send's sender lookup, done first so both parses below see the same workers.
  const registered = state.getWorker(comment.author) ?? state.tryLoadWorkerFromDisk(comment.author);
  const targets = routableMentions(state, comment.content, comment.author);
  if (targets.length === 0) return undefined;

  // Relay only as a registered worker, so the relay is one agent hop under the
  // loop guard. The router treats any other sender as a human, which resets
  // that guard; 'human' also wakes every unfiltered chat_wait; and 'system' is
  // daemon-only and bypasses the guard entirely.
  if (!registered) {
    return {
      routingError: `@mentions not relayed to chat: "${comment.author}" is not a registered worker (pass workerId, or use moe.chat_send)`,
    };
  }

  // The task's own channel (named by the task id) when there is one, else #general.
  const channel = state.resolveChannelRef(task.id) ?? state.resolveChannelRef('general');
  if (!channel) return { routingError: 'no task channel or #general to relay @mentions to' };

  // The header ends in a newline so the comment's first line still opens a
  // line: a leading "@governor" must keep its addressing position.
  const header = `💬 ${comment.author} on ${task.id} (${comment.id}):\n`;
  let content = header + comment.content;
  if (Buffer.byteLength(content, 'utf-8') > MAX_CHAT_MESSAGE_BYTES) {
    // Cutting the text could split a token or open a code fence and change who
    // is addressed, so name the routed seats outright and point at the comment.
    content = `${header}${targets.map((id) => `@${id}`).join(' ')} (too long to relay; read the comment on the task)`;
  }
  const sent = routableMentions(state, content, comment.author);
  if (sent.length !== targets.length || sent.some((id) => !targets.includes(id))) {
    return { routingError: 'relay would not address exactly the comment\'s @mentions; not sent' };
  }

  const { message, routingTargets } = await state.sendMessage({ channel: channel.id, sender: comment.author, content });
  return { routing: { messageId: message.id, channel: message.channel, routingTargets } };
}

export function addCommentTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.add_comment',
    description: 'Add a comment to a task (for questions or responses). A comment that @mentions a seat, posted with your registered workerId, is also relayed once to chat (the task channel, else #general) so that seat wakes; the result reports routing or routingError.',
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

      // Best-effort: the comment is already stored, so a chat failure is
      // logged and reported in the result, never thrown.
      let relay: MentionRelay | undefined;
      try {
        relay = await relayMentions(state, updated, comment);
      } catch (error) {
        logger.warn({ error, taskId: updated.id, commentId: comment.id }, 'Failed to relay comment @mentions to chat');
        relay = { routingError: error instanceof Error ? error.message : String(error) };
      }

      return {
        success: true,
        taskId: updated.id,
        commentId: comment.id,
        totalComments: Array.isArray(updated.comments) ? updated.comments.length : 0,
        ...relay
      };
    }
  };
}

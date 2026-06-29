import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import {
  DEFAULT_COMMENT_CONTENT_CHARS,
  DEFAULT_PENDING_QUESTION_LIMIT,
  DEFAULT_PENDING_QUESTIONS_PER_TASK,
  MAX_COMMENT_CONTENT_CHARS,
  MAX_PENDING_QUESTION_LIMIT,
  MAX_PENDING_QUESTIONS_PER_TASK,
  normalizeIntegerOption,
} from '../util/taskPayload.js';
import { truncateForBudget } from '../util/memorySettings.js';

function compactQuestion(
  question: { commentId: string; content: string; timestamp: string },
  maxContentChars: number
): {
  commentId: string;
  content: string;
  timestamp: string;
  contentTruncated?: boolean;
  contentOriginalLength?: number;
} {
  if (maxContentChars <= 0 || question.content.length <= maxContentChars) {
    return question;
  }
  const content = truncateForBudget(question.content, maxContentChars);
  return {
    ...question,
    content: content.text,
    contentTruncated: content.truncated,
    contentOriginalLength: question.content.length,
  };
}

export function getPendingQuestionsTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_pending_questions',
    description: 'Get all tasks that have unanswered human questions. Returns the pending questions so agents can answer them.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'Optional epic ID filter' },
        includeArchived: {
          type: 'boolean',
          description: 'Include ARCHIVED tasks (default false). Shelved tickets stay out of pending-question results unless explicitly requested.',
          default: false
        },
        limit: {
          type: 'number',
          description: 'Maximum number of task entries to return (default: 10, max: 50)',
          default: DEFAULT_PENDING_QUESTION_LIMIT
        },
        maxQuestionsPerTask: {
          type: 'number',
          description: 'Maximum unanswered human comments per task (default: 3, max: 20)',
          default: DEFAULT_PENDING_QUESTIONS_PER_TASK
        },
        maxContentChars: {
          type: 'number',
          description: 'Maximum question content length (default: 1000, max: 10000; 0 returns full content)',
          default: DEFAULT_COMMENT_CONTENT_CHARS
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        includeArchived?: boolean;
        limit?: number;
        maxQuestionsPerTask?: number;
        maxContentChars?: number;
      };
      const limit = normalizeIntegerOption(
        params.limit,
        'limit',
        DEFAULT_PENDING_QUESTION_LIMIT,
        1,
        MAX_PENDING_QUESTION_LIMIT
      );
      const maxQuestionsPerTask = normalizeIntegerOption(
        params.maxQuestionsPerTask,
        'maxQuestionsPerTask',
        DEFAULT_PENDING_QUESTIONS_PER_TASK,
        1,
        MAX_PENDING_QUESTIONS_PER_TASK
      );
      const maxContentChars = normalizeIntegerOption(
        params.maxContentChars,
        'maxContentChars',
        DEFAULT_COMMENT_CONTENT_CHARS,
        0,
        MAX_COMMENT_CONTENT_CHARS
      );

      const results: Array<{
        taskId: string;
        title: string;
        status: string;
        epicId: string;
        assignedWorkerId: string | null;
        questions: Array<{
          commentId: string;
          content: string;
          timestamp: string;
          contentTruncated?: boolean;
          contentOriginalLength?: number;
        }>;
        totalQuestions: number;
        omittedQuestions: number;
      }> = [];

      const tasks = Array.from(state.tasks.values())
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

      for (const task of tasks) {
        if (!task.hasPendingQuestion) continue;
        // Archiving a task does not clear hasPendingQuestion, so ARCHIVED tasks
        // would otherwise leak shelved tickets into agent context. Skip them by
        // default (mirrors list_tasks/search_tasks); opt in with includeArchived.
        if (task.status === 'ARCHIVED' && params.includeArchived !== true) continue;
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
          const visibleQuestions = questions
            .slice(0, maxQuestionsPerTask)
            .map((question) => compactQuestion(question, maxContentChars));
          results.push({
            taskId: task.id,
            title: task.title,
            status: task.status,
            epicId: task.epicId,
            assignedWorkerId: task.assignedWorkerId,
            questions: visibleQuestions,
            totalQuestions: questions.length,
            omittedQuestions: Math.max(0, questions.length - visibleQuestions.length)
          });
        }
      }

      const pagedResults = results.slice(0, limit);
      const truncatedQuestions = pagedResults
        .flatMap(task => task.questions)
        .filter(question => question.contentTruncated).length;

      return {
        count: pagedResults.length,
        totalMatches: results.length,
        tasks: pagedResults,
        pagination: {
          limit,
          returned: pagedResults.length,
          total: results.length,
          hasMore: pagedResults.length < results.length,
        },
        truncatedQuestions,
        hint: truncatedQuestions > 0 || pagedResults.some(task => task.omittedQuestions > 0)
          ? 'Pending-question payload is compact. Increase maxQuestionsPerTask or set maxContentChars: 0 when full text is needed.'
          : undefined,
      };
    }
  };
}

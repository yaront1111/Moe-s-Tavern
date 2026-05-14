import type { Task, TaskComment } from '../types/schema.js';
import { invalidInput } from './errors.js';
import { truncateForBudget } from './memorySettings.js';

export const TASK_DETAIL_MODES = ['summary', 'full'] as const;
export type TaskDetailMode = typeof TASK_DETAIL_MODES[number];

export const DEFAULT_TASK_LIST_LIMIT = 100;
export const MAX_TASK_LIST_LIMIT = 500;
export const DEFAULT_TASK_LIST_OFFSET = 0;

export const DEFAULT_TASK_PREVIEW_CHARS = 240;
export const MAX_TASK_PREVIEW_CHARS = 2000;

export const DEFAULT_CONTEXT_COMMENTS_LIMIT = 3;
export const MAX_CONTEXT_COMMENTS_LIMIT = 50;
export const DEFAULT_COMMENT_CONTENT_CHARS = 1000;
export const MAX_COMMENT_CONTENT_CHARS = 10_000;

export const DEFAULT_PENDING_QUESTION_LIMIT = 10;
export const MAX_PENDING_QUESTION_LIMIT = 50;
export const DEFAULT_PENDING_QUESTIONS_PER_TASK = 3;
export const MAX_PENDING_QUESTIONS_PER_TASK = 20;

export type TaskSummary = {
  id: string;
  epicId: string;
  title: string;
  status: Task['status'];
  priority: Task['priority'];
  order: number;
  assignedWorkerId: string | null;
  hasWorker: boolean;
  reopenCount: number;
  hasPendingQuestion: boolean;
  definitionOfDoneCount: number;
  planStepCount: number;
  completedStepCount: number;
  descriptionPreview?: string;
  descriptionTruncated?: boolean;
  descriptionOriginalLength?: number;
};

export type CompactTaskComment = TaskComment & {
  contentTruncated?: boolean;
  contentOriginalLength?: number;
};

export function normalizeIntegerOption(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput(field, 'must be a finite number');
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function normalizeTaskDetailMode(value: unknown, field = 'detail'): TaskDetailMode {
  if (value === undefined) return 'summary';
  if (typeof value !== 'string' || !TASK_DETAIL_MODES.includes(value as TaskDetailMode)) {
    throw invalidInput(field, `must be one of: ${TASK_DETAIL_MODES.join(', ')}`);
  }
  return value as TaskDetailMode;
}

function truncatePayloadText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return truncateForBudget(text, maxChars);
}

export function taskSummary(
  task: Task,
  options: {
    includeDescriptionPreview?: boolean;
    maxDescriptionChars?: number;
  } = {}
): TaskSummary {
  const summary: TaskSummary = {
    id: task.id,
    epicId: task.epicId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    order: task.order,
    assignedWorkerId: task.assignedWorkerId,
    hasWorker: Boolean(task.assignedWorkerId),
    reopenCount: task.reopenCount,
    hasPendingQuestion: Boolean(task.hasPendingQuestion),
    definitionOfDoneCount: task.definitionOfDone?.length ?? 0,
    planStepCount: task.implementationPlan?.length ?? 0,
    completedStepCount: task.implementationPlan?.filter(step => step.status === 'COMPLETED').length ?? 0,
  };

  if (options.includeDescriptionPreview) {
    const maxChars = options.maxDescriptionChars ?? DEFAULT_TASK_PREVIEW_CHARS;
    const preview = truncatePayloadText(task.description, maxChars);
    summary.descriptionPreview = preview.text;
    if (preview.truncated) {
      summary.descriptionTruncated = true;
      summary.descriptionOriginalLength = task.description.length;
    }
  }

  return summary;
}

export function compactTaskComment(comment: TaskComment, maxContentChars: number): CompactTaskComment {
  const content = truncatePayloadText(comment.content, maxContentChars);
  return {
    ...comment,
    content: content.text,
    ...(content.truncated
      ? {
          contentTruncated: true,
          contentOriginalLength: comment.content.length,
        }
      : {}),
  };
}

export function compactTaskComments(
  comments: TaskComment[],
  limit: number,
  maxContentChars: number
): {
  comments: CompactTaskComment[];
  totalComments: number;
  returnedComments: number;
  omittedComments: number;
  truncatedComments: number;
} {
  const safeLimit = Math.max(0, Math.trunc(limit));
  const visible = safeLimit === 0 ? [] : comments.slice(-safeLimit);
  const compacted = visible.map(comment => compactTaskComment(comment, maxContentChars));

  return {
    comments: compacted,
    totalComments: comments.length,
    returnedComments: compacted.length,
    omittedComments: Math.max(0, comments.length - compacted.length),
    truncatedComments: compacted.filter(comment => comment.contentTruncated).length,
  };
}

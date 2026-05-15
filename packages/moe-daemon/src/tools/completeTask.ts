import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted } from '../util/enforcement.js';
import { resolveMemorySettings } from '../util/memorySettings.js';
import { logger } from '../util/logger.js';

export function completeTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_task',
    description: 'Mark a task as complete (move to REVIEW)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prLink: { type: 'string' },
        summary: { type: 'string' },
        workerId: { type: 'string' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; prLink?: string; summary?: string; workerId?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }
      assertWorkerOwns(task, params.workerId);
      assertAllStepsCompleted(task);

      // Update worker to IDLE before status change (which clears assignedWorkerId).
      await state.touchWorker(task.assignedWorkerId || params.workerId, { status: 'IDLE', currentTaskId: null });

      const now = new Date().toISOString();
      const updated = await state.updateTask(
        task.id,
        { status: 'REVIEW', prLink: params.prLink || task.prLink, completedAt: now, reviewStartedAt: now },
        'TASK_COMPLETED'
      );

      if (params.prLink) {
        state.appendActivity('PR_OPENED', { prLink: params.prLink }, updated);
      }

      // Post system message to task channel
      try {
        await state.postSystemMessage(task.id, 'Task submitted for review');
      } catch { /* never block tool */ }

      // Safely handle implementationPlan which could be null/undefined or empty
      const implementationPlan = updated.implementationPlan || [];
      const completedSteps = implementationPlan.filter((s) => s.status === 'COMPLETED');
      const modified = completedSteps.flatMap((s) => s.modifiedFiles || s.affectedFiles || []);

      // Auto-extract memory only when explicitly enabled. Generic completion
      // summaries tend to be low-signal and burn tokens when surfaced later;
      // keep the default knowledge base focused on "good stuff" (manual
      // remembers, QA rejections, and reopened fixes).
      const memorySettings = resolveMemorySettings(state.project?.settings);
      if (params.workerId && memorySettings.autoSave.completedTask) {
        try {
          const mm = state.getMemoryManager();
          // Cap summary to 5000 chars BEFORE composing the content — avoids
          // leaking large rejection text / pasted stack traces into memory and
          // guarantees the hashed content matches what's persisted.
          const summary = (params.summary || '').trim().slice(0, 5000);
          const content = summary
            ? `Task "${updated.title}" completed. ${summary}`
            : `Task "${updated.title}" completed (${completedSteps.length}/${implementationPlan.length} steps).`;
          await mm.addEntry({
            workerId: params.workerId,
            type: 'insight',
            // epicId is a dedicated field on the entry; keep it out of tags to
            // avoid double-ranking on recall (tag match + epic filter).
            content,
            tags: ['completed-task'],
            files: Array.from(new Set(modified)).slice(0, 20),
            taskId: updated.id,
            epicId: updated.epicId,
          });
        } catch (err) {
          // Never block task completion on memory write.
          logger.warn({
            taskId: updated.id,
            error: err instanceof Error ? err.message : String(err),
          }, 'completeTask memory auto-extract failed');
        }
      }

      return {
        success: true,
        taskId: updated.id,
        status: 'REVIEW',
        stats: {
          stepsCompleted: completedSteps.length,
          totalSteps: implementationPlan.length,
          filesModified: Array.from(new Set(modified)),
          duration: 'n/a'
        },
        nextAction: {
          tool: 'moe.save_session_summary',
          args: {
            workerId: params.workerId,
            taskId: updated.id,
            summary: params.summary || `Completed ${completedSteps.length}/${implementationPlan.length} steps on "${updated.title}".`
          },
          reason: 'Task handed to QA; record session findings so the next worker benefits.'
        }
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState, MoeError, MoeErrorCode } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted } from '../util/enforcement.js';
import { resolveMemorySettings } from '../util/memorySettings.js';
import { matchesAppendOnlyPattern } from '../util/affectedFiles.js';
import { validateVerificationEvidence } from '../util/verificationEvidence.js';
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
        summary: { type: 'string', description: 'Deprecated alias for verificationEvidence. Prefer the explicit field.' },
        verificationEvidence: {
          type: 'string',
          description: 'Required. Concrete proof of verification: command(s) you ran and what they returned, plus what you manually inspected. Min 80 chars; placeholders rejected.'
        },
        workerId: { type: 'string' },
        currentBranch: {
          type: 'string',
          description: 'Branch the worker is on (e.g. "wip/2026-05-15"). When ProjectSettings.consolidationBranch is set, complete_task validates currentBranch matches and rejects with BRANCH-POLICY-FAIL on mismatch.'
        }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; prLink?: string; summary?: string; verificationEvidence?: string; workerId?: string; currentBranch?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }
      assertWorkerOwns(task, params.workerId);
      assertAllStepsCompleted(task);

      // Force the worker to prove verification before flipping to REVIEW.
      // No placeholders, no one-liners — daemon refuses anything that doesn't
      // reference a command, file, count, or verb. This is the single biggest
      // lever against "agent says done; QA discovers it isn't."
      const verificationEvidence = validateVerificationEvidence(
        params.verificationEvidence,
        'complete_task',
        params.summary, // accept legacy `summary` as the evidence carrier
      );

      // Branch policy gate. When the project sets a consolidation branch
      // pattern, the worker must declare currentBranch and it must match.
      // Mismatch = hard reject (BRANCH-POLICY-FAIL); missing = warn-only so
      // we don't break callers that haven't been updated yet.
      const policy = state.project?.settings.consolidationBranch;
      if (policy) {
        if (params.currentBranch) {
          if (!matchesAppendOnlyPattern(params.currentBranch, policy)) {
            throw new MoeError(
              MoeErrorCode.CONSTRAINT_VIOLATION,
              `BRANCH-POLICY-FAIL: complete_task called on branch "${params.currentBranch}" but project policy requires "${policy}". ` +
              `Move your commits onto the consolidation branch (or a branch matching the pattern) and re-call complete_task.`,
              { currentBranch: params.currentBranch, consolidationBranch: policy },
              'BRANCH-POLICY-FAIL'
            );
          }
        } else {
          try {
            await state.postToRoleChannel(
              'governors',
              `⚠️ task ${task.id} completed without currentBranch arg; consolidation policy "${policy}" cannot be verified.`
            );
          } catch { /* never block tool */ }
        }
      }

      // Capture the worker to IDLE *after* the task update so a failed updateTask
      // doesn't leave the worker idle while the task is still WORKING (half-applied state).
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      const now = new Date().toISOString();
      const updated = await state.updateTask(
        task.id,
        {
          status: 'REVIEW',
          prLink: params.prLink || task.prLink,
          completedAt: now,
          reviewStartedAt: now,
          completionEvidence: {
            evidence: verificationEvidence,
            providedBy: task.assignedWorkerId || params.workerId || 'unknown',
            providedAt: now,
          },
        },
        'TASK_COMPLETED'
      );

      // updateTask clears assignedWorkerId on WORKING -> REVIEW handoff; touchWorker
      // skips missing worker records and never blocks a successfully completed task.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

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

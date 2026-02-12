import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskPriority, WorkerType } from '../types/schema.js';
import { missingRequired, notAllowed, invalidState } from '../util/errors.js';

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
};

/**
 * Simple mutex to serialize claim operations.
 * Prevents race conditions where two workers try to claim the same task.
 */
class ClaimMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    }
  }
}

// Single mutex instance shared across all claim operations
const claimMutex = new ClaimMutex();

export function claimNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.claim_next_task',
    description: 'Claim the next task by status (assigns workerId if provided)',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string' } },
        epicId: { type: 'string' },
        workerId: { type: 'string' },
        replaceExisting: { type: 'boolean', description: 'Replace existing worker assignment if another worker is active' }
      },
      required: ['statuses'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      // Wrap entire claim operation in mutex to prevent race conditions
      return claimMutex.runExclusive(async () => {
        const params = (args || {}) as { statuses?: string[]; epicId?: string; workerId?: string; replaceExisting?: boolean };
        const statuses = params.statuses || [];
        if (statuses.length === 0) {
          throw missingRequired('statuses');
        }

        if (!state.project) {
          throw invalidState('StateManager', 'unloaded', 'loaded');
        }

        const tasks = Array.from(state.tasks.values())
        .filter((t) => statuses.includes(t.status))
        .filter((t) => (params.epicId ? t.epicId === params.epicId : true))
        .filter((t) => !t.assignedWorkerId) // Only claim unassigned tasks
        .sort((a, b) => {
          const pa = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.MEDIUM;
          const pb = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.MEDIUM;
          if (pa !== pb) return pa - pb;
          return a.order - b.order;
        });

      const task = tasks[0];
      if (!task) {
        return { hasNext: false };
      }

      // Enforce single worker per epic constraint - but allow different roles to work in parallel
      // Architects (claiming PLANNING) can work alongside workers (on WORKING)
      if (params.workerId) {
        const tasksInEpic = Array.from(state.tasks.values())
          .filter((t) => t.epicId === task.epicId && t.assignedWorkerId && t.assignedWorkerId !== params.workerId);

        // Only block if another worker is active on the SAME status type
        // This allows architects (PLANNING) and workers (WORKING) to work in parallel
        const claimingStatus = task.status;
        const activeWorkerOnSameStatus = tasksInEpic.find(
          (t) => t.status === claimingStatus
        );

        if (activeWorkerOnSameStatus && !params.replaceExisting) {
          // Team members can work in parallel on different tasks in the same epic
          const claimingWorkerTeam = state.getTeamForWorker(params.workerId);
          if (!claimingWorkerTeam) {
            // Solo worker -> keep original constraint
            throw notAllowed(
              'claim_next_task',
              `Epic already has an active worker (${activeWorkerOnSameStatus.assignedWorkerId}) on ${claimingStatus} tasks. Use replaceExisting:true to take over.`
            );
          }
          // Team member -> allow parallel claims (same-task conflicts already
          // prevented by the !t.assignedWorkerId filter on line 73)
        }

        // If replaceExisting is true, clear the previous worker's assignment
        if (activeWorkerOnSameStatus && params.replaceExisting) {
          await state.updateTask(activeWorkerOnSameStatus.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
        }

        await state.updateTask(task.id, { assignedWorkerId: params.workerId });

        // Auto-register or update worker entity
        const existingWorker = state.getWorker(params.workerId);
        if (!existingWorker) {
          const workerType: WorkerType = 'CLAUDE'; // Default; future: pass type from agent
          await state.createWorker({
            id: params.workerId,
            type: workerType,
            projectId: state.project!.id,
            epicId: task.epicId,
            currentTaskId: task.id,
            status: 'READING_CONTEXT'
          });
        } else {
          await state.updateWorker(params.workerId, {
            currentTaskId: task.id,
            epicId: task.epicId,
            status: 'READING_CONTEXT'
          });
        }
      }

      const epic = state.getEpic(task.epicId);
      return {
        hasNext: true,
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
        task: {
          id: task.id,
          epicId: task.epicId,
          title: task.title,
          description: task.description,
          definitionOfDone: task.definitionOfDone,
          taskRails: task.taskRails,
          status: task.status,
          priority: task.priority,
          assignedWorkerId: task.assignedWorkerId,
          implementationPlan: task.implementationPlan,
          reopenCount: task.reopenCount,
          reopenReason: task.reopenReason,
          rejectionDetails: task.rejectionDetails || null
        },
        ...(task.reopenCount > 0
          ? {
              reopenWarning: `WARNING: This task was rejected by QA (${task.reopenCount} time(s)). Read reopenReason and rejectionDetails carefully. Fix the identified issues before proceeding.`
            }
          : {}),
        allRails: {
          global: state.project.globalRails.requiredPatterns,
          epic: epic?.epicRails || [],
          task: task.taskRails
        }
      };
      });
    }
  };
}

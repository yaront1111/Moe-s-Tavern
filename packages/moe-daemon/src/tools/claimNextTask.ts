import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notAllowed, invalidState } from '../util/errors.js';

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
        .filter((t) =>
          // Use !t.assignedWorkerId to match both null and undefined
          params.workerId ? !t.assignedWorkerId || t.assignedWorkerId === params.workerId : true
        )
        .sort((a, b) => a.order - b.order);

      const task = tasks[0];
      if (!task) {
        return { hasNext: false };
      }

      // Enforce single worker per epic constraint - but allow different roles to work in parallel
      // Architects (claiming PLANNING) can work alongside workers (on WORKING)
      if (params.workerId && task.assignedWorkerId !== params.workerId) {
        const tasksInEpic = Array.from(state.tasks.values())
          .filter((t) => t.epicId === task.epicId && t.assignedWorkerId && t.assignedWorkerId !== params.workerId);

        // Only block if another worker is active on the SAME status type
        // This allows architects (PLANNING) and workers (WORKING) to work in parallel
        const claimingStatus = task.status;
        const activeWorkerOnSameStatus = tasksInEpic.find(
          (t) => t.status === claimingStatus
        );

        if (activeWorkerOnSameStatus && !params.replaceExisting) {
          throw notAllowed(
            'claim_next_task',
            `Epic already has an active worker (${activeWorkerOnSameStatus.assignedWorkerId}) on ${claimingStatus} tasks. Use replaceExisting:true to take over.`
          );
        }

        // If replaceExisting is true, clear the previous worker's assignment
        if (activeWorkerOnSameStatus && params.replaceExisting) {
          await state.updateTask(activeWorkerOnSameStatus.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
        }

        await state.updateTask(task.id, { assignedWorkerId: params.workerId });
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
          assignedWorkerId: task.assignedWorkerId,
          implementationPlan: task.implementationPlan
        },
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

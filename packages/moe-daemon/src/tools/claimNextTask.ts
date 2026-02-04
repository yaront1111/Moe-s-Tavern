import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function claimNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.claim_next_task',
    description: 'Claim the next task by status (assigns workerId if provided)',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string' } },
        epicId: { type: 'string' },
        workerId: { type: 'string' }
      },
      required: ['statuses'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { statuses?: string[]; epicId?: string; workerId?: string };
      const statuses = params.statuses || [];
      if (statuses.length === 0) {
        throw new Error('statuses is required');
      }

      if (!state.project) {
        throw new Error('Project not loaded');
      }

      const tasks = Array.from(state.tasks.values())
        .filter((t) => statuses.includes(t.status))
        .filter((t) => (params.epicId ? t.epicId === params.epicId : true))
        .filter((t) =>
          params.workerId ? t.assignedWorkerId === null || t.assignedWorkerId === params.workerId : true
        )
        .sort((a, b) => a.order - b.order);

      const task = tasks[0];
      if (!task) {
        return { hasNext: false };
      }

      if (params.workerId && task.assignedWorkerId !== params.workerId) {
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
    }
  };
}

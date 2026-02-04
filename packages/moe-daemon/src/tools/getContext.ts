import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function getContextTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_context',
    description: 'Get current project/epic/task context and rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string };
      const taskId = params.taskId || process.env.MOE_TASK_ID || '';

      if (!state.project) {
        throw new Error('Project not loaded');
      }

      let task = taskId ? state.getTask(taskId) : null;
      let epic = task ? state.getEpic(task.epicId) : null;

      if (!task) {
        // Try fallback: find first task assigned to MOE_WORKER_ID
        const workerId = process.env.MOE_WORKER_ID;
        if (workerId) {
          const worker = state.getWorker(workerId);
          if (worker?.currentTaskId) {
            task = state.getTask(worker.currentTaskId);
            epic = task ? state.getEpic(task.epicId) : null;
          }
        }
      }

      return {
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
        task: task
          ? {
              id: task.id,
              title: task.title,
              description: task.description,
              definitionOfDone: task.definitionOfDone,
              taskRails: task.taskRails,
              status: task.status,
              implementationPlan: task.implementationPlan
            }
          : null,
        worker: null,
        allRails: {
          global: state.project.globalRails.requiredPatterns,
          epic: epic?.epicRails || [],
          task: task?.taskRails || []
        }
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function joinTeamTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.join_team',
    description: 'Add a worker to a team. Auto-registers worker if not exists.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'The team ID to join' },
        workerId: { type: 'string', description: 'The worker ID' }
      },
      required: ['teamId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { teamId?: string; workerId?: string };

      if (!params.teamId) throw missingRequired('teamId');
      if (!params.workerId) throw missingRequired('workerId');

      const team = state.getTeam(params.teamId);
      if (!team) throw notFound('Team', params.teamId);

      // Auto-register worker if it doesn't exist
      if (!state.getWorker(params.workerId)) {
        await state.createWorker({
          id: params.workerId,
          type: 'CLAUDE',
          projectId: state.project!.id,
          epicId: '',
          currentTaskId: null,
          status: 'IDLE'
        });
      }

      const updated = await state.addTeamMember(params.teamId, params.workerId);

      return { team: updated };
    }
  };
}

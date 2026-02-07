import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function leaveTeamTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.leave_team',
    description: 'Remove a worker from a team',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'The team ID to leave' },
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

      const updated = await state.removeTeamMember(params.teamId, params.workerId);

      return { team: updated };
    }
  };
}

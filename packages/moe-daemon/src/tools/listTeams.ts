import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function listTeamsTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_teams',
    description: 'List all teams, optionally filtered by role',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Filter by role: architect, worker, or qa' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { role?: string };

      let teams = Array.from(state.teams.values());
      if (params.role) {
        teams = teams.filter((t) => t.role === params.role);
      }

      // Enrich with member details
      const enriched = teams.map((team) => ({
        ...team,
        members: team.memberIds
          .map((id) => state.getWorker(id))
          .filter((w) => w !== null)
          .map((w) => ({ id: w!.id, type: w!.type, status: w!.status }))
      }));

      return { teams: enriched };
    }
  };
}

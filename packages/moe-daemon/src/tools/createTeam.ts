import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TeamRole } from '../types/schema.js';
import { missingRequired, invalidInput } from '../util/errors.js';

const VALID_ROLES: TeamRole[] = ['architect', 'worker', 'qa'];

export function createTeamTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_team',
    description: 'Create a team or return existing team with same name+role (idempotent)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team display name (e.g. "Coders")' },
        role: { type: 'string', enum: VALID_ROLES, description: 'Team role: architect, worker, or qa' },
        maxSize: { type: 'number', description: 'Maximum number of members (default 10)' }
      },
      required: ['name', 'role'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { name?: string; role?: string; maxSize?: number };

      if (!params.name) throw missingRequired('name');
      if (!params.role) throw missingRequired('role');
      if (!VALID_ROLES.includes(params.role as TeamRole)) {
        throw invalidInput('role', `must be one of: ${VALID_ROLES.join(', ')}`);
      }

      // Idempotent: return existing team if name+role matches
      const existing = state.getTeamByNameAndRole(params.name, params.role as TeamRole);
      if (existing) {
        return { team: existing, created: false };
      }

      const team = await state.createTeam({
        name: params.name,
        role: params.role as TeamRole,
        maxSize: params.maxSize
      });

      return { team, created: true };
    }
  };
}

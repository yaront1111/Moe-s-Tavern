import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TeamRole } from '../types/schema.js';
import { missingRequired, invalidInput } from '../util/errors.js';

const VALID_ROLES: TeamRole[] = ['architect', 'worker', 'qa', 'governor'];

export function createTeamTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_team',
    description: 'Create a team or return existing team with same name+role (idempotent)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team display name (e.g. "Coders")' },
        role: { type: 'string', enum: VALID_ROLES, description: 'Team role: architect, worker, qa, or governor (optional)' },
        maxSize: { type: 'number', description: 'Maximum number of members (default 10)' }
      },
      required: ['name'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const raw = (args || {}) as Record<string, unknown>;
      // Proxy auto-injects workerId from MOE_WORKER_ID env into every tools/call;
      // create_team doesn't use it, so drop it before strict-field validation.
      delete raw.workerId;
      const allowedFields = new Set(['name', 'role', 'maxSize']);
      for (const field of Object.keys(raw)) {
        if (!allowedFields.has(field)) {
          throw invalidInput(field, 'is not a supported team field');
        }
      }

      const params = raw as { name?: string; role?: string; maxSize?: number };

      if (!params.name) throw missingRequired('name');
      let role: TeamRole | null = null;
      if (params.role !== undefined) {
        if (!VALID_ROLES.includes(params.role as TeamRole)) {
          throw invalidInput('role', `must be one of: ${VALID_ROLES.join(', ')}`);
        }
        role = params.role as TeamRole;
      }
      if (params.maxSize !== undefined) {
        if (typeof params.maxSize !== 'number' || !Number.isFinite(params.maxSize) || !Number.isInteger(params.maxSize) || params.maxSize < 1 || params.maxSize > 1000) {
          throw invalidInput('maxSize', 'must be an integer between 1 and 1000');
        }
      }

      // Idempotent: return existing team if name+role matches
      const existing = role === null
        ? state.getTeamByName(params.name)
        : state.getTeamByNameAndRole(params.name, role);
      if (existing) {
        return { team: existing, created: false };
      }

      const team = await state.createTeam({
        name: params.name,
        role,
        maxSize: params.maxSize
      });

      return { team, created: true };
    }
  };
}

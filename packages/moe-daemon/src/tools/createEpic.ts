import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { EpicStatus } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';
import { recommendSkillFor } from '../util/recommendSkill.js';

export function createEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_epic',
    description: 'Create a new epic',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Epic title' },
        description: { type: 'string', description: 'What the epic delivers' },
        architectureNotes: { type: 'string', description: 'Design notes shared with every task in the epic' },
        epicRails: { type: 'array', items: { type: 'string' }, description: 'Constraints every task in the epic must follow' },
        status: { type: 'string', description: 'PLANNED, ACTIVE, COMPLETED or ARCHIVED' },
        order: { type: 'number', description: 'Sort position among epics' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of EPIC_CREATED' }
      },
      required: ['title'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        title?: string;
        description?: string;
        architectureNotes?: string;
        epicRails?: string[];
        status?: EpicStatus;
        order?: number;
        workerId?: string;
      };

      if (!params.title) {
        throw missingRequired('title');
      }

      const epic = await state.createEpic({
        title: params.title,
        description: params.description,
        architectureNotes: params.architectureNotes,
        epicRails: params.epicRails,
        status: params.status,
        order: params.order
      }, params.workerId);

      return {
        success: true,
        epic,
        // Breakdown is where task sizing is decided — surface the slicing
        // skill at the moment the epic exists, before the first create_task.
        nextAction: {
          tool: 'moe.create_task',
          args: { epicId: epic.id },
          reason: 'Slice this epic into small tasks — typically 10-30, each one self-contained deliverable (about 30-60 human-minutes, 1-3 files, DoD of 3-7 runnable checks) — and end with an integration-and-hardening task.',
          recommendedSkill: recommendSkillFor('architect', 'epic_breakdown')
        }
      };
    }
  };
}

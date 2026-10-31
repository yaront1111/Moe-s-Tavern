import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { generateId } from '../util/ids.js';
import { notFound, invalidInput } from '../util/errors.js';
import { findRailIndex } from '../state/railChange.js';
import { MAX_EPIC_RAIL_CHARS, validateStringValue } from '../state/validators.js';

export function proposeRailTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.propose_rail',
    description: 'Propose a change to rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task the proposal came up in' },
        proposalType: { type: 'string', enum: ['ADD_RAIL', 'MODIFY_RAIL', 'REMOVE_RAIL'], description: 'Add a new rail, modify an existing one, or remove one' },
        targetScope: { type: 'string', enum: ['GLOBAL', 'EPIC', 'TASK'], description: 'Which rail list the change applies to' },
        currentValue: { type: 'string', description: 'The existing rail text (for MODIFY_RAIL / REMOVE_RAIL)' },
        proposedValue: { type: 'string', description: `The new rail text. For EPIC ADD_RAIL/MODIFY_RAIL it must be a single line of at most ${MAX_EPIC_RAIL_CHARS} characters; longer text is refused, never truncated` },
        reason: { type: 'string', description: 'Why the rail should change' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'proposalType', 'targetScope', 'proposedValue', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        proposalType: 'ADD_RAIL' | 'MODIFY_RAIL' | 'REMOVE_RAIL';
        targetScope: 'GLOBAL' | 'EPIC' | 'TASK';
        currentValue?: string;
        proposedValue: string;
        reason: string;
        workerId?: string;
      };

      const validProposalTypes = ['ADD_RAIL', 'MODIFY_RAIL', 'REMOVE_RAIL'];
      if (!validProposalTypes.includes(params.proposalType)) {
        throw invalidInput('proposalType', `must be one of: ${validProposalTypes.join(', ')}`);
      }

      const validScopes = ['GLOBAL', 'EPIC', 'TASK'];
      if (!validScopes.includes(params.targetScope)) {
        throw invalidInput('targetScope', `must be one of: ${validScopes.join(', ')}`);
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // Epic rails are stored under the same cap and approval refuses (never truncates)
      // an over-long one, so refuse it here instead of queueing an unapprovable proposal.
      if (params.targetScope === 'EPIC' && params.proposalType !== 'REMOVE_RAIL') {
        validateStringValue(params.proposedValue, 'proposedValue', { maxLength: MAX_EPIC_RAIL_CHARS });
      }

      const proposalId = generateId('prop');
      if (params.proposalType !== 'ADD_RAIL') {
        if (!params.currentValue) throw invalidInput('currentValue', 'required for MODIFY_RAIL or REMOVE_RAIL');
        const rails = params.targetScope === 'GLOBAL'
          ? state.project?.globalRails.customRules || []
          : params.targetScope === 'EPIC'
            ? state.getEpic(task.epicId)?.epicRails || []
            : task.taskRails || [];
        findRailIndex(rails, params.currentValue, proposalId);
      }

      const proposal = {
        id: proposalId,
        workerId: params.workerId || task.assignedWorkerId || 'unknown',
        taskId: task.id,
        proposalType: params.proposalType,
        targetScope: params.targetScope,
        currentValue: params.currentValue || null,
        proposedValue: params.proposedValue,
        reason: params.reason,
        status: 'PENDING' as const,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date().toISOString()
      };

      await state.createProposal(proposal);

      return {
        success: true,
        proposalId: proposal.id,
        status: 'PENDING',
        message: 'Proposal submitted for human review.'
      };
    }
  };
}

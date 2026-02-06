import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { generateId } from '../util/ids.js';
import { notFound, invalidInput } from '../util/errors.js';

export function proposeRailTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.propose_rail',
    description: 'Propose a change to rails',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        proposalType: { type: 'string', enum: ['ADD_RAIL', 'MODIFY_RAIL', 'REMOVE_RAIL'] },
        targetScope: { type: 'string', enum: ['GLOBAL', 'EPIC', 'TASK'] },
        currentValue: { type: 'string' },
        proposedValue: { type: 'string' },
        reason: { type: 'string' }
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

      const proposal = {
        id: generateId('prop'),
        workerId: task.assignedWorkerId || 'unknown',
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

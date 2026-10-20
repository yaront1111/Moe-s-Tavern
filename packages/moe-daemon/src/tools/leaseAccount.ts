import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { leaseAccount } from '../state/accountStore.js';
import { invalidInput } from '../util/errors.js';

/**
 * Wrapper-only: pick the Claude subscription account a seat's next claude
 * launch runs under (state/accountStore.ts). The wrapper starts the CLI with
 * the returned configDir as CLAUDE_CONFIG_DIR. Hidden from agents
 * (TOOL_AUDIENCE 'wrapper').
 */
export function leaseAccountTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.lease_account',
    description:
      'Wrapper-only. Picks the Claude subscription account for the calling seat\'s next claude launch from the machine\'s account list (Moe tool window > Accounts). Launches stay on the active account until a live usage window reaches the list\'s switchAtPercent (default 90), a launch on it is refused, or it is signed out; then they move to the next signed-in account. Returns rotation:false (with a reason when accounts exist but none can be used) to launch as before, accountId plus configDir to launch with CLAUDE_CONFIG_DIR=configDir, or accountId null plus retryAt/retryInSec when every signed-in account is spent. Not intended to be called by agents.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'The launching seat (MOE_WORKER_ID).' },
      },
      required: ['workerId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId?: unknown };
      if (typeof params.workerId !== 'string' || !params.workerId.trim()) {
        throw invalidInput('workerId', 'is required');
      }
      return leaseAccount(state, params.workerId);
    },
  };
}

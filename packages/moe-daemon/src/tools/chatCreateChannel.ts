import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput } from '../util/errors.js';

export function chatCreateChannelTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_create_channel',
    description: 'Create a custom chat channel for ad-hoc agent coordination.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name (required)' }
      },
      required: ['name'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        name?: string;
      };

      if (!params.name) throw missingRequired('name');
      if (typeof params.name !== 'string' || !params.name.trim()) {
        throw invalidInput('name', 'must be a non-empty string');
      }

      try {
        const channel = await state.createChannel({
          name: params.name.trim(),
          type: 'custom'
        });

        return {
          success: true,
          channel
        };
      } catch (error) {
        const err = error as Error;
        return {
          success: false,
          error: err.message
        };
      }
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function chatChannelsTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_channels',
    description: 'List all chat channels in the project.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    handler: async (_args, state) => {
      return {
        channels: state.getChannels()
      };
    }
  };
}

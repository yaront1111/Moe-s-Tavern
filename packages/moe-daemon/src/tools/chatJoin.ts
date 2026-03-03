import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function chatJoinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_join',
    description: 'Join a chat channel. Posts a system message and returns online workers.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID to join' },
        workerId: { type: 'string', description: 'Your worker ID' }
      },
      required: ['channel', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { channel?: string; workerId?: string };

      if (!params.channel) throw missingRequired('channel');
      if (!params.workerId) throw missingRequired('workerId');

      const channel = state.getChannel(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      // Post system join message
      await state.sendMessage({
        channel: params.channel,
        sender: 'system',
        content: `${params.workerId} joined #${channel.name}`
      });

      // Get online workers (active status or recent activity)
      const now = Date.now();
      const PRESENCE_TIMEOUT_MS = 120_000;
      const onlineWorkers: Array<{ id: string; status: string }> = [];
      for (const worker of state.workers.values()) {
        const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
        if (worker.status !== 'IDLE' && (now - lastActivity < PRESENCE_TIMEOUT_MS)) {
          onlineWorkers.push({ id: worker.id, status: worker.status });
        }
      }

      return {
        channel: params.channel,
        channelName: channel.name,
        onlineWorkers
      };
    }
  };
}

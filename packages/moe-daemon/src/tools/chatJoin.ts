import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';

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

      // Validate worker identity — prevent forged join messages for non-existent workers
      if (params.workerId !== 'human' && params.workerId !== 'system') {
        let worker = state.getWorker(params.workerId);
        if (!worker) {
          worker = state.tryLoadWorkerFromDisk(params.workerId);
        }
        if (!worker) {
          throw invalidInput('workerId', 'Unknown worker: workerId must be a registered worker, "human", or "system"');
        }
      }

      const channel = state.getChannel(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      // Idempotency: if a join message for this worker already exists in the
      // recent message window for this channel, skip the broadcast.
      let alreadyMember = false;
      try {
        const recent = await state.getMessages(params.channel, { limit: 200 });
        const joinMarker = `${params.workerId} joined #${channel.name}`;
        alreadyMember = recent.some((m) => m.sender === 'system' && m.content === joinMarker);
      } catch {
        // If we can't read recent messages, fall through to the normal join.
      }

      // Post system join message (skip if worker is already a member)
      if (!alreadyMember) {
        await state.sendMessage({
          channel: params.channel,
          sender: 'system',
          content: `${params.workerId} joined #${channel.name}`
        });
      }

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

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { isWorkerAlive } from '../util/workerLiveness.js';

export function chatJoinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_join',
    description: 'Join a chat channel. Posts a system message and returns online workers.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form' },
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

      // Resolve the reference (id, "general" or "#general") before any read or
      // write, so a refused join posts nothing. Everything below keys on the
      // canonical id; getChannel only matched the id and refused "#general".
      if (typeof params.channel !== 'string') throw invalidInput('channel', 'must be a string');
      const channel = state.resolveChannelRef(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      // Idempotency: if a join message for this worker already exists in the
      // recent message window for this channel, skip the broadcast.
      let alreadyMember = false;
      try {
        const recent = await state.getMessages(channel.id, { limit: 200 });
        const joinMarker = `${params.workerId} joined #${channel.name}`;
        alreadyMember = recent.some((m) => m.sender === 'system' && m.content === joinMarker);
      } catch {
        // If we can't read recent messages, fall through to the normal join.
      }

      // Post system join message (skip if worker is already a member)
      if (!alreadyMember) {
        await state.sendMessage({
          channel: channel.id,
          sender: 'system',
          content: `${params.workerId} joined #${channel.name}`
        });
      }

      // Online workers: the shared isWorkerAlive predicate (not DEAD, active
      // within the liveness window), the same one list_workers reports as isAlive.
      const now = Date.now();
      const onlineWorkers: Array<{ id: string; status: string }> = [];
      for (const worker of state.workers.values()) {
        if (isWorkerAlive(worker, now)) {
          onlineWorkers.push({ id: worker.id, status: worker.status });
        }
      }

      return {
        channel: channel.id,
        channelName: channel.name,
        onlineWorkers
      };
    }
  };
}

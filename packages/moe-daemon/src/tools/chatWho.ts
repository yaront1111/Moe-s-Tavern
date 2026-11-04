import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { activeChatWaiters } from './chatWait.js';
import { invalidInput, notFound } from '../util/errors.js';
import { isWorkerAlive } from '../util/workerLiveness.js';

export function chatWhoTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_who',
    description: 'List online workers. Optionally filter by channel participation.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Optional channel to filter by participation. Channel id, or name in either "general" or "#general" form'
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { channel?: string };
      const now = Date.now();

      // Resolve the reference ONCE, up front. chat_read saves cursors under the
      // canonical channel id and chat_wait's waiter sets hold canonical ids, so
      // both passes below must compare against channel.id: matching the raw
      // string listed nobody for "#general" and answered {online: []} for a
      // channel that does not exist, which reads as "nobody is here".
      let channelId: string | undefined;
      if (params.channel) {
        if (typeof params.channel !== 'string') throw invalidInput('channel', 'must be a string');
        const channel = state.resolveChannelRef(params.channel);
        if (!channel) throw notFound('Channel', params.channel);
        channelId = channel.id;
      }

      const seen = new Map<string, { source: 'cursor' | 'waiting' | 'both' }>();

      const online: Array<{
        workerId: string;
        type: string;
        status: string;
        lastActivity: string;
        currentTaskId: string | null;
        source: 'cursor' | 'waiting' | 'both';
      }> = [];

      // Pass 1: workers with chatCursors for the channel (existing logic)
      for (const worker of state.workers.values()) {
        if (!isWorkerAlive(worker, now)) continue;

        if (channelId) {
          const hasCursor = worker.chatCursors && worker.chatCursors[channelId];
          if (hasCursor) {
            seen.set(worker.id, { source: 'cursor' });
            online.push({
              workerId: worker.id,
              type: worker.type,
              status: worker.status,
              lastActivity: worker.lastActivityAt,
              currentTaskId: worker.currentTaskId,
              source: 'cursor'
            });
          }
        } else {
          // No channel filter — return all online workers
          online.push({
            workerId: worker.id,
            type: worker.type,
            status: worker.status,
            lastActivity: worker.lastActivityAt,
            currentTaskId: worker.currentTaskId,
            source: 'cursor'
          });
          seen.set(worker.id, { source: 'cursor' });
        }
      }

      // Pass 2: workers currently in chat_wait for the channel
      if (channelId) {
        for (const [workerId, waiter] of activeChatWaiters) {
          // Waiter is watching this channel if channels is null (all) or includes the channel
          const watchesChannel = !waiter.channels || waiter.channels.has(channelId);
          if (!watchesChannel) continue;

          const existing = seen.get(workerId);
          if (existing) {
            // Already in results from cursor pass — upgrade source to 'both'
            existing.source = 'both';
            const entry = online.find((o) => o.workerId === workerId);
            if (entry) entry.source = 'both';
          } else {
            // Not yet in results — a parked wait does not refresh activity, so a
            // waiter counts as present past the window, but never a DEAD record.
            const worker = state.workers.get(workerId);
            if (worker && worker.status !== 'DEAD') {
              seen.set(workerId, { source: 'waiting' });
              online.push({
                workerId: worker.id,
                type: worker.type,
                status: worker.status,
                lastActivity: worker.lastActivityAt,
                currentTaskId: worker.currentTaskId,
                source: 'waiting'
              });
            }
          }
        }
      }

      return { online };
    }
  };
}

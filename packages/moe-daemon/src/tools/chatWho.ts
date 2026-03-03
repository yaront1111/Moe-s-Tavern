import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { activeChatWaiters } from './chatWait.js';

const PRESENCE_TIMEOUT_MS = 120_000;

export function chatWhoTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_who',
    description: 'List online workers. Optionally filter by channel participation.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Optional channel ID to filter by participation' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { channel?: string };
      const now = Date.now();

      const seen = new Map<string, { source: 'cursor' | 'waiting' | 'both' }>();

      const online: Array<{
        workerId: string;
        status: string;
        lastActivity: string;
        currentTaskId: string | null;
        source: 'cursor' | 'waiting' | 'both';
      }> = [];

      // Pass 1: workers with chatCursors for the channel (existing logic)
      for (const worker of state.workers.values()) {
        const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
        if (isNaN(lastActivity) || (now - lastActivity > PRESENCE_TIMEOUT_MS)) continue;

        if (params.channel) {
          const hasCursor = worker.chatCursors && worker.chatCursors[params.channel];
          if (hasCursor) {
            seen.set(worker.id, { source: 'cursor' });
            online.push({
              workerId: worker.id,
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
            status: worker.status,
            lastActivity: worker.lastActivityAt,
            currentTaskId: worker.currentTaskId,
            source: 'cursor'
          });
          seen.set(worker.id, { source: 'cursor' });
        }
      }

      // Pass 2: workers currently in chat_wait for the channel
      if (params.channel) {
        for (const [workerId, waiter] of activeChatWaiters) {
          // Waiter is watching this channel if channels is null (all) or includes the channel
          const watchesChannel = !waiter.channels || waiter.channels.has(params.channel);
          if (!watchesChannel) continue;

          const existing = seen.get(workerId);
          if (existing) {
            // Already in results from cursor pass — upgrade source to 'both'
            existing.source = 'both';
            const entry = online.find((o) => o.workerId === workerId);
            if (entry) entry.source = 'both';
          } else {
            // Not yet in results — add from worker data if available
            const worker = state.workers.get(workerId);
            if (worker) {
              seen.set(workerId, { source: 'waiting' });
              online.push({
                workerId: worker.id,
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

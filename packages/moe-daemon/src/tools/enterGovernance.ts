import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatChannel } from '../types/schema.js';
import { missingRequired, notFound } from '../util/errors.js';

const GOVERNANCE_DUTIES = [
  'Watch #architects, #workers, #qa, #general for @mentions and questions.',
  'Reply to any @mention via moe.chat_send before any other tool call (Mention Response Protocol).',
  'Periodically scan moe.list_tasks {statuses:["WORKING","REVIEW"]} for plan drift; nudge workers in chat if drifting.',
  'When a new PLANNING task lands you will see it announced in #architects — call moe.claim_next_task to resume planning.',
  'For QA rejections that require a re-plan, use moe.set_task_status to flip the task back to PLANNING.',
];

export function enterGovernanceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.enter_governance',
    description: 'Architect enters governance mode after planning queue empties. Sets status to GOVERNING, broadcasts presence, returns chat_wait nextAction.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Architect worker ID' }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId?: string };
      if (!params.workerId) {
        throw missingRequired('workerId');
      }

      const worker = state.getWorker(params.workerId);
      if (!worker) {
        throw notFound('Worker', params.workerId);
      }

      await state.updateWorker(
        params.workerId,
        { status: 'GOVERNING', currentTaskId: null },
        'WORKER_GOVERNING'
      );

      const wantedNames = new Set(['general', 'architects', 'workers', 'qa']);
      const channels: { id: string; name: string }[] = [];
      for (const ch of state.channels.values() as Iterable<ChatChannel>) {
        if (ch.name && wantedNames.has(ch.name)) {
          channels.push({ id: ch.id, name: ch.name });
        }
      }

      const broadcast = `🧭 ${params.workerId} is now governing — @mention them on plan questions, drift, or rejections.`;
      try { await state.postToGeneral(broadcast); } catch { /* never block tool */ }
      try { await state.postToRoleChannel('architects', broadcast); } catch { /* never block tool */ }

      const channelIds = channels.map((c) => c.id);

      return {
        success: true,
        workerId: params.workerId,
        status: 'GOVERNING',
        channels,
        governanceDuties: GOVERNANCE_DUTIES,
        nextAction: {
          tool: 'moe.chat_wait',
          args: {
            workerId: params.workerId,
            channels: channelIds.length > 0 ? channelIds : undefined,
            timeoutMs: 300000
          },
          reason: 'Planning queue is empty. Watch chat for @mentions; resume planning when a new PLANNING task is announced in #architects.'
        }
      };
    }
  };
}

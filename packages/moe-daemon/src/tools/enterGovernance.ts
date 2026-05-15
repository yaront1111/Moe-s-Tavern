import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatChannel } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';

const GOVERNANCE_DUTIES = [
  'Watch #governors, #general, #architects, #workers, #qa for @mentions and oversight signals.',
  'Reply to any @mention via moe.chat_send before any other tool call (Mention Response Protocol).',
  'Triage stale-worker alerts (⚠️), QA rejections (❌), and block reports (🚧) as they cross-post to #governors.',
  'When a new PLANNING task lands you will see it cross-posted to #governors — @ping an architect to resume planning. Do NOT claim PLANNING tasks yourself.',
  'For QA rejection loops that require a re-plan, use moe.set_task_status to flip the task back to PLANNING; the architect picks it up.',
];

export function enterGovernanceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.enter_governance',
    description: 'Governor enters governance mode. Sets status to GOVERNING, broadcasts presence to #governors, returns chat_wait nextAction.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Governor worker ID' }
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

      // Role gate: only governors may enter governance mode. Architects plan,
      // workers code, qa verifies. Call moe.claim_next_task for your role
      // instead — architects on an empty PLANNING queue get a wait_for_task
      // nextAction.
      const team = state.getTeamForWorker(params.workerId);
      if (team?.role !== 'governor') {
        throw notAllowed(
          'enter_governance',
          'enter_governance is governor-only. Architects plan (use moe.claim_next_task with statuses:["PLANNING"], then moe.wait_for_task when empty); workers code; qa verifies. Join a governor team to govern.'
        );
      }

      await state.updateWorker(
        params.workerId,
        { status: 'GOVERNING', currentTaskId: null },
        'WORKER_GOVERNING'
      );

      const wantedNames = new Set(['general', 'architects', 'workers', 'qa', 'governors']);
      const channels: { id: string; name: string }[] = [];
      for (const ch of state.channels.values() as Iterable<ChatChannel>) {
        if (ch.name && wantedNames.has(ch.name)) {
          channels.push({ id: ch.id, name: ch.name });
        }
      }

      const broadcast = `🧭 ${params.workerId} is now governing — @mention them on stuck workers, rejections, or escalations.`;
      try { await state.postToGeneral(broadcast); } catch { /* never block tool */ }
      try { await state.postToRoleChannel('governors', broadcast); } catch { /* never block tool */ }

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
          reason: 'Watch #governors for stale-worker, rejection, and block alerts; respond to @mentions across all channels.'
        }
      };
    }
  };
}

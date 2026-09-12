import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatChannel } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';
import { releaseWorkerTasks } from '../state/workerLifecycle.js';
import { resolveWorkerRole } from '../util/workerRole.js';
import { healTeamMembership, resolveEffectiveTeam } from '../util/teamMembershipHeal.js';
import { logger } from '../util/logger.js';

const GOVERNANCE_DUTIES = [
  'Watch #governors, #general, #architects, #workers, #qa for @mentions and oversight signals.',
  'Reply to any @mention via moe.chat_send before any other tool call (Mention Response Protocol).',
  'Triage stale-worker alerts (⚠️), QA rejections (❌), and block reports (🚧) as they cross-post to #governors. On ⚠️: quiet ≠ dead (long builds/tests are silent) — ping the worker first; NEVER release a WORKING/PLANNING task on idle time alone.',
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

      // Resolve membership through the eviction tombstone as well as the live
      // record. Every daemon (re)start purges all worker records and empties
      // team memberIds, so a governor mid-session loses both — and unlike every
      // other role it has no way back: architects, workers and qa re-register
      // through the wrapper's claim_next_task pre-flight (which heals via
      // healTeamMembership), while the governor wrapper calls enter_governance
      // exactly once at spawn. Looking the worker up and throwing therefore
      // ended governance for the rest of the session. See
      // util/teamMembershipHeal.ts.
      const worker = state.getWorker(params.workerId);
      const team = resolveEffectiveTeam(state, params.workerId);
      if (!worker && !team) {
        throw notFound('Worker', params.workerId);
      }

      // Role gate: only governors may enter governance mode. Architects plan,
      // workers code, qa verifies. Call moe.claim_next_task for your role
      // instead — architects on an empty PLANNING queue get a wait_for_task
      // nextAction.
      //
      // MERGE NOTE: both sides of this gate are kept, because they fix two
      // DIFFERENT ways a genuine governor was refused.
      //
      // From main: membership is resolved through the eviction tombstone, so a
      // governor whose record the restart purge deleted can still re-enter. The
      // tombstone is durable state written by the purge, not caller input, so
      // honouring it does not widen who may govern.
      //
      // From this branch: when the effective team supplies no role at all, fall
      // back to util/workerRole, which reads the seat's id prefix, like every
      // other role-gated tool. That is not a widening either: as workerRole's
      // docblock records, this is a workflow guard rather than a security
      // boundary — join_team is unauthenticated, so a seat that wants the
      // governor role can already grant itself one with a single call. What the
      // bare `team?.role` read DID do is refuse a genuine governor on the
      // role-less project team the launcher registers every seat into, and then
      // tell it (below) to go join a governor team, which is the workaround for
      // that bug.
      //
      // Order matters: an explicit team role is the operator stating the seat's
      // role and must win over the id prefix.
      const effectiveRole = team?.role ?? resolveWorkerRole(state, params.workerId);
      if (effectiveRole !== 'governor') {
        throw notAllowed(
          'enter_governance',
          'enter_governance is governor-only. Architects plan (use moe.claim_next_task with statuses:["PLANNING"], then moe.wait_for_task when empty); workers code; qa verifies. Join a governor team to govern.'
        );
      }

      // Rebuild the record the purge deleted, then restore durable membership.
      // healTeamMembership needs the record to exist and is a quiet no-op when
      // membership is already live, so an ordinary re-entry emits no join.
      if (!worker) {
        await state.createWorker({
          id: params.workerId,
          type: 'CLAUDE',
          projectId: state.project!.id,
          epicId: '',
          currentTaskId: null,
          status: 'IDLE'
        });
        logger.info(
          // team is non-null here (the guard above throws when BOTH worker and team
          // are missing), but the role gate no longer narrows it for the compiler:
          // a governor can now pass via the id-prefix fallback with no team at all.
          { workerId: params.workerId, teamId: team?.id },
          'enter_governance rebuilt a purged governor record from its team tombstone'
        );
      }
      await healTeamMembership(state, params.workerId);

      // Hold the state mutex so concurrent enter_governance calls don't
      // double-broadcast or race on the worker update. We also re-check the
      // worker status inside the locked section so a second concurrent call
      // becomes a no-op.
      let alreadyGoverning = false;
      const wantedNames = new Set(['general', 'architects', 'workers', 'qa', 'governors']);
      const channels: { id: string; name: string }[] = [];
      await state.runExclusive(async () => {
        const fresh = state.getWorker(params.workerId!);
        // Release any task this worker still owns BEFORE nulling its
        // currentTaskId. A worker that switched to a governor team while
        // holding a WORKING task would otherwise leave it assigned to a live
        // GOVERNING worker — unclaimable (owner present, not DEAD) and never
        // self-healed (idle never releases WORKING): a permanent orphan until
        // deregister or daemon restart.
        const released = await releaseWorkerTasks(state, params.workerId!, 'enter_governance');
        if (released.length > 0) {
          logger.info({ workerId: params.workerId, released }, 'enter_governance released held tasks');
        }
        if (fresh?.status === 'GOVERNING') {
          alreadyGoverning = true;
        } else {
          await state.updateWorker(
            params.workerId!,
            { status: 'GOVERNING', currentTaskId: null },
            'WORKER_GOVERNING'
          );
        }
        for (const ch of state.channels.values() as Iterable<ChatChannel>) {
          if (ch.name && wantedNames.has(ch.name)) {
            channels.push({ id: ch.id, name: ch.name });
          }
        }
      });

      if (!alreadyGoverning) {
        const broadcast = `🧭 ${params.workerId} is now governing — @mention them on stuck workers, rejections, or escalations.`;
        try { await state.postToGeneral(broadcast); } catch { /* never block tool */ }
        try { await state.postToRoleChannel('governors', broadcast); } catch { /* never block tool */ }
      }

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
          reason: 'Watch #governors for stale-worker, rejection, and block alerts; respond to @mentions across all channels. Stale alerts are presence signals, not death certificates — never release a task on idle time alone.'
        }
      };
    }
  };
}

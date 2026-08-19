import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskPriority, WorkerType } from '../types/schema.js';
import { missingRequired, notAllowed, invalidState, notFound } from '../util/errors.js';
import { AGENT_CLAIMABLE_STATUSES, assertAgentClaimableStatuses } from '../util/claimableStatuses.js';
import { blockingHold, heldTaskRefusal } from '../util/claimEligibility.js';
import { assertNoLiveLease, claimLostRace } from '../util/claimGuards.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { computeFileCollisions, DEFAULT_APPEND_ONLY_FILES } from '../util/affectedFiles.js';
import { maybeApplyBudgetWarnings } from '../util/budget.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import {
  healTeamMembership,
  noTeamMembershipRefusal,
  resolveEffectiveTeam
} from '../util/teamMembershipHeal.js';

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
};

export function claimNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.claim_next_task',
    description: 'Claim a task: by id (taskId) or the next prioritized task matching statuses. Assigns workerId if provided. Agents claim only PLANNING (architect), WORKING (worker), or REVIEW (qa) — other columns are human-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: [...AGENT_CLAIMABLE_STATUSES] },
          description: 'Columns to claim from. Only PLANNING/WORKING/REVIEW are agent-claimable.'
        },
        epicId: { type: 'string' },
        workerId: { type: 'string' },
        replaceExisting: { type: 'boolean', description: 'Replace existing worker assignment if another worker is active' },
        taskId: { type: 'string', description: 'Claim this specific task (must be in one of the requested statuses). Skips priority/order ranking.' },
        preferAdjacentInEpic: {
          type: 'boolean',
          description: 'When true (default), prefer claimable tasks in the worker\'s current/last epic before falling through to global ranking. Lets a worker waiting on wait_for_task pick up the next claimable task in the same epic.'
        }
      },
      required: ['statuses'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      // Disk-state comparison inputs, stashed from inside the exclusive block
      // and consumed after it releases — recomputing the signature spawns a git
      // subprocess, which must never run under the global state mutex.
      let storedDiskState: string | undefined;
      let baseHandoffHint: string | undefined;

      // Use StateManager's mutex to prevent race conditions with plugin assignments
      const result = await state.runExclusive(async () => {
        const params = (args || {}) as {
          statuses?: string[];
          epicId?: string;
          workerId?: string;
          replaceExisting?: boolean;
          taskId?: string;
          preferAdjacentInEpic?: boolean;
        };
        const statuses = params.statuses || [];
        if (statuses.length === 0) {
          throw missingRequired('statuses');
        }

        if (!state.project) {
          throw invalidState('StateManager', 'unloaded', 'loaded');
        }

        // Governors never claim tasks — they oversee. Route them straight to
        // enter_governance. The role is derived from the worker's team, so a
        // fresh first-time caller without a registered worker falls through to
        // the normal claim path (so onboarding doesn't break).
        if (params.workerId) {
          const team = state.getTeamForWorker(params.workerId);
          if (team?.role === 'governor') {
            return {
              hasNext: false,
              nextAction: {
                tool: 'moe.enter_governance',
                args: { workerId: params.workerId },
                reason: 'Governors do not claim tasks. Enter governance to watch chat, drift, and rejections.'
              }
            };
          }
        }

        // Reject non-agent-claimable columns up front (after the governor
        // redirect so a confused governor still gets the gentler nudge). This
        // covers BOTH the ranked pool and the explicit-taskId path: without it,
        // claiming a BACKLOG task "succeeds" (assignment set, status untouched)
        // and permanently wedges the worker — no tool acts on BACKLOG, and
        // one-task-per-worker blocks every other claim until a release.
        assertAgentClaimableStatuses(statuses);

        // One task per worker: a worker already holding an active task
        // (PLANNING/WORKING/REVIEW/BLOCKED — see workerStore's active set) must
        // finish, release or unblock it before claiming another. Re-claiming
        // the SAME task is the resume path (fresh CLI respawn mid-task) and
        // stays allowed — both by explicit taskId and by steering the ranked
        // claim back to the held task.
        if (params.workerId) {
          // Same predicate wait_for_task uses, from the same held-task source:
          // if these two ever disagree, a worker is woken for work it will be
          // refused (see util/claimEligibility.ts).
          const hold = blockingHold(state, params.workerId, params.taskId);
          if (hold) {
            return heldTaskRefusal(hold, params.workerId);
          }
        }

        let tasks: Task[];
        if (params.taskId) {
          const requested = state.getTask(params.taskId);
          if (!requested) {
            throw notFound('Task', params.taskId);
          }
          if (!statuses.includes(requested.status)) {
            throw invalidState('Task', requested.status, statuses.join('|'));
          }
          if (params.epicId && requested.epicId !== params.epicId) {
            throw notAllowed(
              'claim',
              `Task ${requested.id} belongs to epic ${requested.epicId}, not ${params.epicId}`
            );
          }
          // A REVIEW task parked for a human is off-limits to agents even by
          // explicit taskId — mirrors the ranked-pool exclusion above.
          if (requested.status === 'REVIEW' && requested.needsHumanReview === true) {
            throw notAllowed(
              'claim',
              `Task ${requested.id} is parked for human review (reopen/critique budget exhausted). A human must reopen or approve it before it re-enters the QA queue.`
            );
          }
          // Re-claiming a task you already own is a resume, not a takeover.
          const ownedBySelf = Boolean(params.workerId) && requested.assignedWorkerId === params.workerId;
          if (!state.isTaskClaimable(requested) && !ownedBySelf && !params.replaceExisting) {
            throw notAllowed(
              'claim',
              `Task ${requested.id} is already assigned to ${requested.assignedWorkerId}. Pass replaceExisting:true to take over.`
            );
          }
          tasks = [requested];
        } else {
          // Compute the worker's preferred epic for adjacency: explicit
          // params.epicId wins, then their currently-recorded epic on the
          // worker entity (set when they last claimed a task in the same
          // wait loop). Default preferAdjacentInEpic to true.
          const preferAdjacent = params.preferAdjacentInEpic !== false;
          let adjacentEpicId: string | undefined = params.epicId;
          if (!adjacentEpicId && preferAdjacent && params.workerId) {
            const w = state.getWorker(params.workerId);
            adjacentEpicId = w?.epicId || undefined;
          }
          tasks = Array.from(state.tasks.values())
            .filter((t) => statuses.includes(t.status))
            .filter((t) => (params.epicId ? t.epicId === params.epicId : true))
            .filter((t) => state.isTaskClaimable(t))
            // A REVIEW task parked for a human (qa_reject hard cap / critique
            // block cap) is excluded from the QA queue until a human clears it.
            .filter((t) => !(t.status === 'REVIEW' && t.needsHumanReview === true))
            .sort((a, b) => {
              // When preferAdjacentInEpic is on and a hint epic is set,
              // rank in-epic candidates ahead of out-of-epic. This lets a
              // worker idling on wait_for_task pick up an adjacent task
              // whose dependencies just cleared, rather than dropping back
              // to the global pool.
              if (preferAdjacent && adjacentEpicId) {
                const aIn = a.epicId === adjacentEpicId ? 0 : 1;
                const bIn = b.epicId === adjacentEpicId ? 0 : 1;
                if (aIn !== bIn) return aIn - bIn;
              }
              const pa = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              const pb = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              if (pa !== pb) return pa - pb;
              return a.order - b.order;
            });
        }

      if (tasks.length === 0) {
        // No tasks available — block on wait_for_task regardless of role. Architects
        // on an empty PLANNING queue idle here too; governance is owned by the
        // separate governor role (which is short-circuited above before this point).
        return {
          hasNext: false,
          nextAction: {
            tool: 'moe.wait_for_task',
            args: { statuses, workerId: params.workerId, epicId: params.epicId },
            reason: 'No claimable task right now; block until one appears.'
          }
        };
      }

      // Try each candidate task in priority order; fall through on concurrency conflicts
      let task = tasks[0];
      let claimed = false;
      // Set when a candidate is skipped ONLY because the claimer has no team.
      // Without it the drained loop falls through to the concurrent-claim tail
      // and reports a race on a board where nothing raced.
      let skippedForNoTeam = false;
      for (const candidate of tasks) {
        task = candidate;

        // Enforce single worker per epic+status constraint — but allow different
        // roles (teams) to work in parallel.
        if (params.workerId) {
          // Resolve the candidate's CURRENT owner (mutually-exclusive branches on
          // one snapshot — an inactive owner is never also a live takeover):
          if (state.isTaskAssignedToInactiveWorker(candidate)) {
            // (1) Owner is gone / marked DEAD — clear the dangling assignment so
            // the optimistic-concurrency guard lets us reassign.
            await state.updateTask(candidate.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
          } else if (candidate.assignedWorkerId && candidate.assignedWorkerId !== params.workerId) {
            // (2) Owner is present AND alive — only reachable on an explicit taskId
            // claim (the ranked filter excludes live-owned tasks). Take over THIS
            // task with replaceExisting: evict its ACTUAL owner (never a bystander)
            // and idle it. Without replaceExisting it isn't claimable → next candidate.
            if (!params.replaceExisting) {
              continue;
            }
            // replaceExisting evicts a live owner — but not one who is mid-step.
            // A granted start_step has to be a LEASE, or a worker can lose the
            // row minutes into a build and only discover it at complete_step.
            assertNoLiveLease(candidate, false, params.workerId);
            const incumbent = candidate.assignedWorkerId;
            await state.updateTask(candidate.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
            await state.touchWorker(incumbent, { status: 'IDLE', currentTaskId: null });
          }

          // (3) Single-worker-per-epic-status: a DIFFERENT task in the same
          // epic+status already held by a live OTHER worker blocks a SOLO claim
          // (teams parallelize). This only BLOCKS — it never evicts the bystander
          // from its own task (replaceExisting overrides the block but still does
          // not touch other workers' tasks).
          const otherActiveOnSameStatus = Array.from(state.tasks.values()).find((t) =>
            t.id !== candidate.id &&
            t.epicId === candidate.epicId &&
            t.status === candidate.status &&
            t.assignedWorkerId &&
            t.assignedWorkerId !== params.workerId &&
            !state.isTaskAssignedToInactiveWorker(t)
          );
          if (otherActiveOnSameStatus && !params.replaceExisting) {
            // Effective, not live, membership: a worker whose record was evicted
            // still belongs to its team via the tombstone, and is rejoined for
            // real once its record is rebuilt below.
            const claimingWorkerTeam = resolveEffectiveTeam(state, params.workerId);
            if (!claimingWorkerTeam) {
              // Solo worker -> epic+status already taken, try next candidate
              skippedForNoTeam = true;
              continue;
            }
          }

          try {
            task = await state.updateTask(candidate.id, { assignedWorkerId: params.workerId });
          } catch (err: unknown) {
            // Optimistic concurrency failure — the row was claimed between our
            // eligibility snapshot and this write. Tell the caller it LOST, and
            // name the winner: silently moving on to another candidate hands
            // back a row the caller never asked for, and hides the contention
            // that a fleet-level timeline later has to reconstruct.
            if (err instanceof Error && err.message.startsWith('Task already assigned')) {
              const winner = state.getTask(candidate.id)?.assignedWorkerId;
              if (winner) throw claimLostRace(candidate.id, winner, params.workerId);
              continue; // Winner already gone — the row is free again, keep looking.
            }
            throw err; // Unexpected error — propagate
          }

          // Auto-register or update worker entity
          const existingWorker = state.getWorker(params.workerId);
          if (!existingWorker) {
            const workerType: WorkerType = 'CLAUDE';
            await state.createWorker({
              id: params.workerId,
              type: workerType,
              projectId: state.project!.id,
              epicId: candidate.epicId,
              currentTaskId: candidate.id,
              status: 'READING_CONTEXT'
            });

            try {
              // Prefer the worker's registered team role over inferring from
              // the requested statuses (a worker may legitimately claim
              // across multiple status sets).
              const team = state.getTeamForWorker(params.workerId);
              const roleLabel = team?.role
                ?? (statuses.includes('PLANNING')
                  ? 'architect'
                  : statuses.includes('REVIEW') ? 'qa' : 'worker');
              await state.postToGeneral(`${params.workerId} is online (${roleLabel})`);
            } catch { /* never block claim */ }
          } else {
            await state.updateWorker(params.workerId, {
              currentTaskId: candidate.id,
              epicId: candidate.epicId,
              status: 'READING_CONTEXT'
            });
          }

          // The record now exists (rebuilt above if eviction had deleted it),
          // so durable membership can be restored. No-op when membership is
          // already present, so an ordinary claim emits no join event.
          await healTeamMembership(state, params.workerId);
        }

        // Successfully claimed this task
        claimed = true;
        break;
      }

      if (!claimed) {
        // Two very different dead ends share this tail. Only one of them is a
        // race; reporting the other as one costs real diagnosis time.
        if (skippedForNoTeam && params.workerId) {
          return noTeamMembershipRefusal(params.workerId);
        }
        return {
          hasNext: false,
          nextAction: {
            tool: 'moe.wait_for_task',
            args: { statuses, workerId: params.workerId, epicId: params.epicId },
            reason: 'All candidate tasks were taken by concurrent workers; wait and retry.'
          }
        };
      }

      // Record firstClaimAt the first time a worker picks this task up, so
      // budget/aggregate metrics can compute wall-clock duration. Idempotent:
      // we never overwrite an existing timestamp.
      if (!task.metrics?.firstClaimAt) {
        const nextMetrics = { ...(task.metrics ?? {}), firstClaimAt: new Date().toISOString() };
        try {
          task = await state.updateTask(task.id, { metrics: nextMetrics });
        } catch { /* never block claim */ }
      }

      // Budget warn/escalate checks run on every WORKING-path tool call so
      // crossings get caught the next time the worker touches Moe — no separate
      // scheduler needed.
      task = await maybeApplyBudgetWarnings(state, task);

      // Compute file-collision warnings against every OTHER WORKING task.
      // Advisory only — never blocks the claim. We post a heads-up to
      // #workers if there's any overlap so peers can sync diffs.
      // Append-only files (CHANGELOG.md by default) are filtered out so the
      // expected shared-file overlap doesn't drown the real ones. `??` — never
      // `||` — because an explicit `[]` deliberately disables suppression.
      const appendOnlyFiles = state.project?.settings?.appendOnlyFiles ?? DEFAULT_APPEND_ONLY_FILES;
      const fileCollision = computeFileCollisions(task, state.tasks.values(), appendOnlyFiles);
      if (fileCollision.length > 0) {
        try {
          const summary = fileCollision
            .map((c) => `${c.task}: ${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? '…' : ''}`)
            .join(' | ');
          await state.postToRoleChannel(
            'workers',
            `⚠️ file collision on ${task.id}: ${summary}`
          );
        } catch { /* never block tool */ }
      }

      // Post system message to #general so the team sees who claimed it
      if (params.workerId) {
        try {
          await state.postToGeneral(`${params.workerId} claimed task: ${task.title}`);
        } catch { /* never block tool */ }
      }

      // Find #general and role channel IDs for the response
      let generalChannelId: string | null = null;
      let roleChannelId: string | null = null;
      const roleLabel = statuses.includes('PLANNING') ? 'architects'
        : statuses.includes('REVIEW') ? 'qa' : 'workers';
      for (const ch of state.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          generalChannelId = ch.id;
        }
        if (ch.type === 'role' && ch.name === roleLabel) {
          roleChannelId = ch.id;
        }
      }

      // Build chat hint pointing to the role channel
      let chatHint: string | undefined;
      const hintChannel = roleChannelId || generalChannelId;
      if (hintChannel) {
        if (task.reopenCount > 0) {
          chatHint = `REOPENED TASK — check #${roleLabel} for context and coordinate with your team: moe.chat_read { channel: "${hintChannel}", workerId: "${params.workerId || 'your-id'}" }`;
        } else {
          chatHint = `Join #${roleLabel} to coordinate with your team: moe.chat_read { channel: "${hintChannel}", workerId: "${params.workerId || 'your-id'}" }`;
        }
      }

      // Surface a priorHandoffs hint — workers picking up a released task
      // should pull the handoff history before assuming nothing's been done.
      const hasHandoffs = Array.isArray(task.priorHandoffs) && task.priorHandoffs.length > 0;
      const handoffHint = hasHandoffs
        ? `Previous worker(s) left ${task.priorHandoffs!.length} handoff note(s). Call moe.get_handoff_history { taskId: "${task.id}" } before starting.`
        : undefined;
      // Stash the newest handoff's disk-state signature for the post-mutex
      // comparison. Gating on a STORED signature keeps the common claim (no
      // handoffs at all) free of subprocesses — idle wrappers poll this tool.
      const newestDiskState = hasHandoffs ? task.priorHandoffs![0]?.diskState : undefined;
      if (typeof newestDiskState === 'string' && newestDiskState.length > 0) {
        storedDiskState = newestDiskState;
        baseHandoffHint = handoffHint;
      }

      return {
        hasNext: true,
        task: {
          id: task.id,
          epicId: task.epicId,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignedWorkerId: task.assignedWorkerId,
          reopenCount: task.reopenCount,
          reopenReason: task.reopenReason,
          rejectionDetails: task.rejectionDetails || null,
          roleChannelId,
          generalChannelId,
          priorHandoffCount: hasHandoffs ? task.priorHandoffs!.length : 0,
        },
        ...(task.reopenCount > 0
          ? {
              reopenWarning: `WARNING: This task was rejected by QA (${task.reopenCount} time(s)). Read reopenReason and rejectionDetails carefully. Fix the identified issues before proceeding.`
            }
          : {}),
        ...(chatHint ? { chatHint } : {}),
        ...(handoffHint ? { handoffHint } : {}),
        ...(fileCollision.length > 0 ? { fileCollision } : {}),
        nextAction: hasHandoffs
          ? {
              tool: 'moe.get_handoff_history',
              args: { taskId: task.id },
              reason: 'This task was released with handoff notes; read them before claiming work.',
            }
          : {
              tool: 'moe.get_context',
              args: { taskId: task.id },
              reason: 'Always fetch full task context (rails, DoD, memory) before acting.',
              // get_context will recommend the role-appropriate skill once it sees task.status,
              // so we don't pre-recommend here unless the task is reopened — the reopen
              // signal is exactly the situation receiving-code-review covers.
              ...(task.reopenCount > 0
                ? { recommendedSkill: recommendSkillFor('worker', 'reopened') }
                : {})
            }
      };
      });

      // The mutex is released — safe to shell out to git. Only runs when the
      // newest handoff carried a signature. Silence is the default: an absent
      // stored value, a failed recompute (undefined), or a match all leave the
      // response byte-identical to what it was before this feature. A false
      // "stale" alarm would teach workers to ignore the flag.
      if (storedDiskState === undefined) return result;
      // Belt-and-braces: the claim has ALREADY mutated state by this point, so
      // a throw here would report failure on a task the worker now owns. The
      // helper contracts never to throw; this catch makes that non-negotiable.
      let currentDiskState: string | undefined;
      try {
        currentDiskState = await computeDiskStateSignature(state.projectPath);
      } catch {
        return result;
      }
      if (typeof currentDiskState !== 'string' || currentDiskState.length === 0) return result;
      if (currentDiskState === storedDiskState) return result;

      const staleNotice =
        'The working tree has CHANGED since the newest handoff note was written, so that note describes a tree that no longer exists — re-verify its claims (especially any refusal or "blocked by" reason, e.g. "this file does not compile") against the current tree before trusting them.';
      return {
        ...result,
        handoffHint: baseHandoffHint ? `${baseHandoffHint} ${staleNotice}` : staleNotice,
        staleHandoffDiskState: true,
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { PlanCritiqueResult } from '../types/schema.js';
import { invalidInput, missingRequired, notFound, notAllowed } from '../util/errors.js';

const MAX_CONCERNS = 20;
const MAX_CONCERN_LEN = 1000;

export function submitPlanCritiqueTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.submit_plan_critique',
    description: 'Governor-only: record a critique of a submitted plan. verdict="pass" is informational; "block" flips the task back to PLANNING with concerns posted to #architects. Does NOT auto-approve — humans still own that.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'block'] },
        concerns: { type: 'array', items: { type: 'string' } },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'verdict'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        verdict?: string;
        concerns?: unknown;
        workerId?: string;
      };
      if (!params.taskId) throw missingRequired('taskId');
      if (!params.verdict) throw missingRequired('verdict');
      if (params.verdict !== 'pass' && params.verdict !== 'block') {
        throw invalidInput('verdict', 'must be "pass" or "block"');
      }

      // Role gate: critique is governor-only (mirrors enter_governance). A
      // missing/non-governor workerId has no governor team, so it's rejected —
      // otherwise any agent could 'block' a plan and evict an active peer.
      const team = state.getTeamForWorker(params.workerId || '');
      if (team?.role !== 'governor') {
        throw notAllowed(
          'submit_plan_critique',
          `governor role required (worker ${params.workerId || '(none)'} is not on a governor team)`
        );
      }

      let concerns: string[] | undefined;
      if (params.concerns !== undefined) {
        if (!Array.isArray(params.concerns)) {
          throw invalidInput('concerns', 'must be an array of strings');
        }
        concerns = [];
        for (const c of params.concerns.slice(0, MAX_CONCERNS)) {
          if (typeof c !== 'string') {
            throw invalidInput('concerns', 'each entry must be a string');
          }
          const trimmed = c.trim();
          if (trimmed.length > 0) {
            concerns.push(trimmed.slice(0, MAX_CONCERN_LEN));
          }
        }
        if (concerns.length === 0) concerns = undefined;
      }

      if (params.verdict === 'block' && (!concerns || concerns.length === 0)) {
        throw invalidInput('concerns', 'at least one concern is required when verdict is "block"');
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const reviewer = params.workerId || 'governor';
      const result: PlanCritiqueResult = {
        verdict: params.verdict,
        reviewedBy: reviewer,
        reviewedAt: new Date().toISOString(),
        ...(concerns && concerns.length > 0 ? { concerns } : {}),
      };

      const updates: Record<string, unknown> = {
        planCritiqueResult: result,
        // Clear pendingPlanCritique now that a critique has landed; idempotent.
        pendingPlanCritique: undefined,
      };

      // Capture the assignee before the flip: updateTask auto-clears
      // assignedWorkerId on the WORKING -> PLANNING transition, so we need it
      // to reset the now-stranded worker afterwards (mirrors qa_reject).
      const prevAssignee = task.assignedWorkerId;

      if (params.verdict === 'block') {
        // Block verdict flips back to PLANNING regardless of prior status,
        // BUT we don't override a task that has already advanced past
        // AWAITING_APPROVAL / WORKING — that means the human already
        // weighed in and we should leave it alone (critique becomes purely
        // advisory). DONE / ARCHIVED tasks are also untouchable.
        const flippable = task.status === 'AWAITING_APPROVAL' || task.status === 'WORKING';
        if (flippable) {
          updates.status = 'PLANNING';
          updates.reopenReason = `Plan blocked by governor critique: ${(concerns ?? []).slice(0, 3).join(' | ').slice(0, 500)}`;
        }
      }

      const updated = await state.updateTask(task.id, updates, 'TASK_UPDATED');

      // A block that flipped a WORKING task to PLANNING orphans the prior
      // worker — updateTask cleared the task's assignee but left the worker
      // entity pointing at an unowned task. Reset it to IDLE (best-effort;
      // touchWorker skips missing worker records).
      if (params.verdict === 'block' && prevAssignee) {
        try {
          await state.touchWorker(prevAssignee, { status: 'IDLE', currentTaskId: null });
        } catch { /* never block tool */ }
      }

      // Post to chat. Both verdicts get an entry — "pass" lets the human know
      // a governor has eyes on it; "block" tells the architect re-plan is needed.
      try {
        if (params.verdict === 'pass') {
          await state.postToRoleChannel(
            'governors',
            `✅ critique passed: ${updated.id} (${updated.title}) — reviewer ${reviewer}`
          );
        } else {
          const concernText = (concerns ?? []).map((c) => `• ${c}`).join('\n');
          await state.postToRoleChannel(
            'architects',
            `🚫 plan blocked on ${updated.id} (${updated.title}) by ${reviewer}.\nConcerns:\n${concernText}`
          );
          await state.postToRoleChannel(
            'governors',
            `🚫 critique blocked: ${updated.id} — flipped to ${updated.status}.`
          );
        }
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        verdict: params.verdict,
        concerns: concerns ?? [],
        planCritiqueResult: result,
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { PlanCritiqueCategory, PlanCritiqueResult } from '../types/schema.js';
import { MAX_CRITIQUE_BLOCKS_DEFAULT, PLAN_CRITIQUE_CATEGORIES } from '../types/schema.js';
import { invalidInput, missingRequired, notFound, notAllowed } from '../util/errors.js';
import { workerHasRole } from '../util/workerRole.js';

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
        category: {
          type: 'string',
          enum: [...PLAN_CRITIQUE_CATEGORIES],
          description: 'What kind of problem a "block" names (size|correctness|rails|dependency) — makes blocks countable. A block without one is counted as "uncategorized" and warned about.'
        },
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
        category?: string;
        concerns?: unknown;
        workerId?: string;
      };
      if (!params.taskId) throw missingRequired('taskId');
      if (!params.verdict) throw missingRequired('verdict');
      if (params.verdict !== 'pass' && params.verdict !== 'block') {
        throw invalidInput('verdict', 'must be "pass" or "block"');
      }
      if (params.category !== undefined
        && !(PLAN_CRITIQUE_CATEGORIES as readonly string[]).includes(params.category)) {
        throw invalidInput('category', `must be one of: ${PLAN_CRITIQUE_CATEGORIES.join(', ')}`);
      }
      const category = params.category as PlanCritiqueCategory | undefined;
      // WARN-when-missing, never hard-required: old governors don't send a
      // category yet, and a critique that fails on rollout is worse than an
      // uncategorized one. Their blocks are counted as 'uncategorized'.
      const uncategorizedBlock = params.verdict === 'block' && category === undefined;

      // Role gate: critique is governor-only (mirrors enter_governance). Role =
      // team role, else the `governor-` id prefix (util/workerRole). A
      // missing/non-governor workerId has neither, so it's rejected —
      // otherwise any agent could 'block' a plan and evict an active peer.
      if (!workerHasRole(state, params.workerId || '', 'governor')) {
        throw notAllowed(
          'submit_plan_critique',
          `governor role required (worker ${params.workerId || '(none)'} is not on a governor team and its id is not governor-prefixed)`
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
        ...(category
          ? { category }
          : uncategorizedBlock
            ? { category: 'uncategorized' as const }
            : {}),
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

      // Block verdict flips back to PLANNING regardless of prior status,
      // BUT we don't override a task that has already advanced past
      // AWAITING_APPROVAL / WORKING — that means the human already
      // weighed in and we should leave it alone (critique becomes purely
      // advisory). DONE / ARCHIVED tasks are also untouchable.
      //
      // Bound the block→re-plan→block loop: a governor can otherwise flip the
      // same task to PLANNING forever with no cap. After
      // MAX_CRITIQUE_BLOCKS_DEFAULT flips we stop flipping and leave the task in
      // AWAITING_APPROVAL/WORKING — that column already blocks on a human, so
      // resting there IS the escalation (no needsHumanReview flag: this task is
      // not in REVIEW, and the flag would wrongly follow it into REVIEW later).
      const flippable = task.status === 'AWAITING_APPROVAL' || task.status === 'WORKING';
      const wantsBlock = flippable && params.verdict === 'block';
      const blockCount = task.critiqueBlockCount ?? 0;
      const underCap = blockCount < MAX_CRITIQUE_BLOCKS_DEFAULT;
      const didFlip = wantsBlock && underCap;
      const blockedButCapped = wantsBlock && !underCap;
      if (didFlip) {
        updates.status = 'PLANNING';
        updates.critiqueBlockCount = blockCount + 1;
        updates.reopenReason = `Plan blocked by governor critique: ${(concerns ?? []).slice(0, 3).join(' | ').slice(0, 500)}`;
      }

      const updated = await state.updateTask(task.id, updates, 'TASK_UPDATED');

      // Only a block that actually flipped the task to PLANNING orphans the prior
      // worker — updateTask cleared the task's assignee but left the worker
      // entity pointing at an unowned task. Reset it to IDLE (best-effort;
      // touchWorker skips missing worker records). A non-flipping block (task
      // already past AWAITING_APPROVAL/WORKING) leaves an active QA/worker owning
      // its task, so we must NOT evict it.
      if (didFlip && prevAssignee) {
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
          if (didFlip) {
            await state.postToRoleChannel(
              'architects',
              `🚫 plan blocked on ${updated.id} (${updated.title}) by ${reviewer} — flipped to PLANNING for re-plan (block ${blockCount + 1}/${MAX_CRITIQUE_BLOCKS_DEFAULT}).\nConcerns:\n${concernText}`
            );
            await state.postToRoleChannel(
              'governors',
              `🚫 critique blocked: ${updated.id} — flipped to ${updated.status} (block ${blockCount + 1}/${MAX_CRITIQUE_BLOCKS_DEFAULT}).`
            );
          } else if (blockedButCapped) {
            // Cap reached: do NOT flip again. The task rests in its current
            // (human-gated) column; surface a hard human-decision nudge.
            const msg = `🛑 HUMAN DECISION REQUIRED — ${updated.id} (${updated.title}) hit the plan-critique block cap (${MAX_CRITIQUE_BLOCKS_DEFAULT}). Not auto-flipping again; it rests in ${updated.status} for a human to approve the plan or re-plan it.\nConcerns:\n${concernText}`;
            await state.postToRoleChannel('architects', msg);
            await state.postToRoleChannel('governors', msg);
          } else {
            // Block verdict on a task already past AWAITING_APPROVAL/WORKING —
            // advisory only (the human already weighed in); status unchanged.
            await state.postToRoleChannel(
              'architects',
              `🚫 plan critique (advisory) on ${updated.id} (${updated.title}) by ${reviewer} — task already in ${updated.status}, not flipping.\nConcerns:\n${concernText}`
            );
            await state.postToRoleChannel(
              'governors',
              `🚫 critique blocked (advisory): ${updated.id} — task in ${updated.status}.`
            );
          }
        }
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        verdict: params.verdict,
        ...(result.category ? { category: result.category } : {}),
        ...(uncategorizedBlock
          ? {
              warning:
                `Block verdict without a category — recorded as 'uncategorized'. Pass category (${PLAN_CRITIQUE_CATEGORIES.join('|')}) so blocks stay countable per failure kind.`
            }
          : {}),
        concerns: concerns ?? [],
        planCritiqueResult: result,
        flipped: didFlip,
        critiqueBlockCount: updated.critiqueBlockCount ?? blockCount,
        maxCritiqueBlocks: MAX_CRITIQUE_BLOCKS_DEFAULT,
        blockCapReached: blockedButCapped,
      };
    }
  };
}

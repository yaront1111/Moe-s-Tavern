import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { checkPlanRails } from '../util/rails.js';
import { notFound, invalidState, invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';

/** Tracks SPEED mode auto-approval timeouts by taskId so they can be cancelled. */
const speedModeTimeouts = new Map<string, NodeJS.Timeout>();

/** Cancel a specific SPEED mode timeout (e.g. on manual approve/reject). */
export function cancelSpeedModeTimeout(taskId: string): void {
  const timeout = speedModeTimeouts.get(taskId);
  if (timeout) {
    clearTimeout(timeout);
    speedModeTimeouts.delete(taskId);
  }
}

/** Cancel all SPEED mode timeouts (e.g. on daemon shutdown). */
export function clearAllSpeedModeTimeouts(): void {
  for (const timeout of speedModeTimeouts.values()) {
    clearTimeout(timeout);
  }
  speedModeTimeouts.clear();
}

export function submitPlanTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.submit_plan',
    description: 'Submit an implementation plan for a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              affectedFiles: { type: 'array', items: { type: 'string' } }
            },
            required: ['description'],
            additionalProperties: false
          }
        },
        workerId: { type: 'string' },
        planningNotes: {
          type: 'object',
          description: 'Architect reasoning notes for the worker (approaches considered, codebase insights, risks, key files)',
          properties: {
            approachesConsidered: { type: 'string', description: 'What alternatives were evaluated and why rejected' },
            codebaseInsights: { type: 'string', description: 'Patterns, conventions, architecture discovered' },
            risks: { type: 'string', description: 'Edge cases and potential issues the worker should watch for' },
            keyFiles: { type: 'array', items: { type: 'string' }, description: 'Critical files to understand' }
          },
          additionalProperties: false
        },
        budget: {
          type: 'object',
          description: 'Soft wall-clock budget (first-claim → DONE). Daemon warns at 80% and escalates at 100% in #governors.',
          properties: {
            wallClockMs: { type: 'number', description: 'Soft cap in milliseconds; must be > 0' }
          },
          additionalProperties: false
        }
      },
      required: ['taskId', 'steps'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        workerId?: string;
        steps: { description: string; affectedFiles?: string[] }[];
        planningNotes?: {
          approachesConsidered?: string;
          codebaseInsights?: string;
          risks?: string;
          keyFiles?: string[];
        };
        budget?: { wallClockMs?: number };
      };

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'PLANNING') {
        throw invalidState('Task', task.status, 'PLANNING');
      }

      assertWorkerOwns(task, params.workerId);
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      if (!params.steps || params.steps.length === 0) {
        throw invalidInput('steps', 'plan cannot be empty');
      }

      // Validate step count bounds
      if (params.steps.length > 100) {
        throw invalidInput('steps', 'maximum 100 steps allowed');
      }

      // Validate each step has a non-empty description + normalize affectedFiles.
      // Normalization happens up-front (before rails check) so the rail-text
      // built below sees canonical paths and the persisted plan matches what
      // the collision detector compares against.
      const normalizedSteps: { description: string; affectedFiles: string[] }[] = [];
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        if (!step.description || typeof step.description !== 'string' || step.description.trim().length === 0) {
          throw invalidInput('steps', `Step ${i + 1} has empty description`);
        }
        if (step.description.length > 2000) {
          throw invalidInput('steps', `Step ${i + 1} description too long (max 2000 chars)`);
        }
        if (step.affectedFiles !== undefined && !Array.isArray(step.affectedFiles)) {
          throw invalidInput('steps', `Step ${i + 1} affectedFiles must be a string[]`);
        }
        if (step.affectedFiles && step.affectedFiles.length > 50) {
          throw invalidInput('steps', `Step ${i + 1} has too many affected files (max 50)`);
        }
        const normalizedFiles = normalizeAffectedFiles(
          step.affectedFiles,
          `steps[${i}].affectedFiles`
        );
        normalizedSteps.push({ description: step.description, affectedFiles: normalizedFiles });
      }

      const epic = state.getEpic(task.epicId);
      const project = state.project;
      if (!project) throw notFound('Project', 'current');

      const planText = normalizedSteps
        .map((step) => `${step.description} ${step.affectedFiles.join(' ')}`)
        .join(' ');

      const railsCheck = checkPlanRails(planText, project.globalRails, epic, task);
      if (!railsCheck.ok) {
        // Steer the agent toward the escape hatch when the rail is wrong for
        // this task (rare but legitimate). The default path is still to fix
        // the plan — propose_rail is only for when the rail itself is the
        // bug, not when the plan skipped a required pattern.
        const v = railsCheck.violation || {};
        const message =
          `Rail violation: ${JSON.stringify(v)}. ` +
          `Default action: revise the plan to satisfy this rail and resubmit moe.submit_plan. ` +
          `Escape hatch: if this rail is genuinely wrong for task ${task.id} (e.g., a forbidden pattern that's a false positive, or a required phrase that doesn't fit), call ` +
          `moe.propose_rail { proposalType: "ADD_RAIL" | "MODIFY_RAIL" | "REMOVE_RAIL", targetScope: "GLOBAL" | "EPIC" | "TASK", taskId: "${task.id}", currentValue, proposedValue, reason, workerId } ` +
          `to request a human-approved rail change. Do NOT loop between resubmits if the rail is the real blocker — propose the change.`;
        throw new MoeError(
          MoeErrorCode.CONSTRAINT_VIOLATION,
          message,
          {
            violation: v,
            suggestedAction: {
              tool: 'moe.propose_rail',
              reason: 'Use this only if the rail itself is wrong for this task; otherwise fix the plan and resubmit.'
            }
          },
          'CONSTRAINT_VIOLATION'
        );
      }

      const implementationPlan = normalizedSteps.map((step, idx) => ({
        stepId: `step-${idx + 1}`,
        description: step.description,
        status: 'PENDING' as const,
        affectedFiles: step.affectedFiles
      }));

      // Carry forward existing metrics (firstClaimAt populated by claim path)
      // but refresh plannedStepCount whenever a new plan lands.
      const existingMetrics = task.metrics ?? {};
      const updatedMetrics = { ...existingMetrics, plannedStepCount: implementationPlan.length };

      const updatePayload: Record<string, unknown> = {
        implementationPlan,
        // A freshly-submitted plan supersedes any prior attempt's step ids — clear
        // stepsCompleted so it can't carry stale 'step-N' ids onto the new plan
        // (request_replan already does this; submit_plan is the other fresh-plan boundary).
        stepsCompleted: [],
        status: 'AWAITING_APPROVAL',
        planSubmittedAt: new Date().toISOString(),
        metrics: updatedMetrics,
      };
      if (params.planningNotes) {
        updatePayload.planningNotes = {
          approachesConsidered: params.planningNotes.approachesConsidered?.slice(0, 5000),
          codebaseInsights: params.planningNotes.codebaseInsights?.slice(0, 5000),
          risks: params.planningNotes.risks?.slice(0, 5000),
          keyFiles: params.planningNotes.keyFiles?.slice(0, 50),
        };
      }
      if (params.budget && typeof params.budget.wallClockMs === 'number') {
        if (!Number.isFinite(params.budget.wallClockMs) || params.budget.wallClockMs <= 0) {
          throw invalidInput('budget.wallClockMs', 'must be a positive number of milliseconds');
        }
        // Preserve existing warn/escalate marks if architect resubmits a plan.
        updatePayload.budget = {
          ...(task.budget ?? {}),
          wallClockMs: params.budget.wallClockMs,
        };
      }

      await state.updateTask(task.id, updatePayload, 'PLAN_SUBMITTED');
      // Use the captured assignee because updateTask clears assignedWorkerId on
      // PLANNING -> AWAITING_APPROVAL handoff. touchWorker skips missing worker
      // records and never blocks a successfully submitted plan.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      const approvalMode = project.settings.approvalMode;
      let finalStatus = 'AWAITING_APPROVAL';
      let message = 'Plan submitted. Awaiting human approval.';

      if (approvalMode === 'TURBO') {
        // Instant auto-approval
        await state.updateTask(task.id, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_AUTO_APPROVED');
        finalStatus = 'WORKING';
        message = 'Plan auto-approved (TURBO mode). Ready to work.';
      } else if (approvalMode === 'SPEED') {
        // Delayed auto-approval. Run the status re-check inside the state
        // mutex (via approveTask) to avoid a TOCTOU race with concurrent
        // manual approve/reject calls.
        const delayMs = project.settings.speedModeDelayMs || 2000;
        // Cancel any prior pending auto-approval for this task before scheduling a
        // new one (e.g. a plan resubmitted after an AWAITING_APPROVAL→PLANNING
        // bounce that didn't cancel the timer) — otherwise the old timer leaks.
        cancelSpeedModeTimeout(task.id);
        const timeoutId = setTimeout(async () => {
          try {
            // approveTask acquires the StateManager mutex and re-checks that
            // status === 'AWAITING_APPROVAL' inside the locked section.
            await state.runExclusive(async () => {
              const currentTask = state.getTask(task.id);
              if (!currentTask || currentTask.status !== 'AWAITING_APPROVAL') return;
              await state.updateTask(
                task.id,
                { status: 'WORKING', planApprovedAt: new Date().toISOString() },
                'PLAN_AUTO_APPROVED'
              );
            });
          } catch (error) {
            // Log error via activity log so task doesn't get stuck silently
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            state.appendActivity('TASK_BLOCKED' as import('../types/schema.js').ActivityEventType, {
              error: errorMessage,
              reason: 'SPEED mode auto-approval failed'
            }, state.getTask(task.id) ?? undefined);
          } finally {
            // Only clear the map entry if it still points at THIS timer — a
            // successor timer scheduled in the meantime must not be deleted
            // (which would leave it live-but-untracked / uncancellable).
            if (speedModeTimeouts.get(task.id) === timeoutId) {
              speedModeTimeouts.delete(task.id);
            }
          }
        }, delayMs);
        speedModeTimeouts.set(task.id, timeoutId);
        message = `Plan submitted. Auto-approval in ${delayMs}ms (SPEED mode).`;
      }

      // Post system message to task channel
      try {
        await state.postSystemMessage(task.id, `Implementation plan submitted (${implementationPlan.length} steps)`);
      } catch { /* never block tool */ }

      // CONTROL mode: post a structured critique request to #governors so a
      // governor can flag concerns before the human approves. Informational
      // — does not change approve semantics, does not block plan flow.
      if (approvalMode === 'CONTROL') {
        try {
          const dodList = (task.definitionOfDone || []).slice(0, 5);
          const dodSummary = dodList.length > 0
            ? dodList.map((d) => `• ${d.slice(0, 120)}`).join('\n')
            : '(no DoD items)';
          const summary = `📋 Plan ready for critique — ${task.title} (${task.id})\n`
            + `Steps: ${implementationPlan.length}\n`
            + `DoD:\n${dodSummary}\n`
            + `Call moe.submit_plan_critique { taskId: "${task.id}", verdict: "pass" | "block", concerns? } to weigh in.`;
          await state.postToRoleChannel('governors', summary);
        } catch { /* never block tool */ }
        // Set pendingPlanCritique if at least one governor is online so
        // downstream consumers (UI, get_handoff_history, etc.) can see the
        // task is parked awaiting critique. Active = registered with team
        // role 'governor'. We use a separate update to avoid clobbering the
        // status transition's worker-clearing logic.
        try {
          const governors: string[] = [];
          for (const team of state.teams.values()) {
            if (team.role !== 'governor') continue;
            for (const memberId of team.memberIds) {
              const w = state.getWorker(memberId);
              if (w) governors.push(memberId);
            }
          }
          if (governors.length > 0) {
            await state.updateTask(task.id, {
              pendingPlanCritique: {
                criticWorkerId: governors[0],
                requestedAt: new Date().toISOString(),
              },
            });
          }
        } catch { /* never block tool */ }
      }

      // If plan is already active (TURBO), the architect is done — point them at
      // the next PLANNING task. Otherwise point them at check_approval.
      const nextAction = finalStatus === 'WORKING'
        ? {
            tool: 'moe.wait_for_task',
            args: { statuses: ['PLANNING'], workerId: params.workerId },
            reason: 'Plan auto-approved (TURBO). Record any reusable planning insight with Serena write_memory, then block until the next PLANNING task arrives.'
          }
        : {
            tool: 'moe.check_approval',
            args: { taskId: task.id },
            reason: 'Plan submitted; poll approval status until approved or rejected.'
          };

      return {
        success: true,
        taskId: task.id,
        status: finalStatus,
        stepCount: implementationPlan.length,
        message,
        nextAction
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { checkPlanRails } from '../util/rails.js';
import { notFound, invalidState, invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';

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
      };

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'PLANNING') {
        throw invalidState('Task', task.status, 'PLANNING');
      }

      assertWorkerOwns(task, params.workerId);

      if (!params.steps || params.steps.length === 0) {
        throw invalidInput('steps', 'plan cannot be empty');
      }

      // Validate step count bounds
      if (params.steps.length > 100) {
        throw invalidInput('steps', 'maximum 100 steps allowed');
      }

      // Validate each step has a non-empty description
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        if (!step.description || typeof step.description !== 'string' || step.description.trim().length === 0) {
          throw invalidInput('steps', `Step ${i + 1} has empty description`);
        }
        if (step.description.length > 2000) {
          throw invalidInput('steps', `Step ${i + 1} description too long (max 2000 chars)`);
        }
        if (step.affectedFiles && step.affectedFiles.length > 50) {
          throw invalidInput('steps', `Step ${i + 1} has too many affected files (max 50)`);
        }
      }

      const epic = state.getEpic(task.epicId);
      const project = state.project;
      if (!project) throw notFound('Project', 'current');

      const planText = params.steps
        .map((step) => `${step.description} ${(step.affectedFiles || []).join(' ')}`)
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
          }
        );
      }

      const implementationPlan = params.steps.map((step, idx) => ({
        stepId: `step-${idx + 1}`,
        description: step.description,
        status: 'PENDING' as const,
        affectedFiles: step.affectedFiles || []
      }));

      const updatePayload: Record<string, unknown> = {
        implementationPlan,
        status: 'AWAITING_APPROVAL',
        planSubmittedAt: new Date().toISOString(),
      };
      if (params.planningNotes) {
        updatePayload.planningNotes = {
          approachesConsidered: params.planningNotes.approachesConsidered?.slice(0, 5000),
          codebaseInsights: params.planningNotes.codebaseInsights?.slice(0, 5000),
          risks: params.planningNotes.risks?.slice(0, 5000),
          keyFiles: params.planningNotes.keyFiles?.slice(0, 50),
        };
      }
      await state.updateTask(task.id, updatePayload, 'PLAN_SUBMITTED');

      const approvalMode = project.settings.approvalMode;
      let finalStatus = 'AWAITING_APPROVAL';
      let message = 'Plan submitted. Awaiting human approval.';

      if (approvalMode === 'TURBO') {
        // Instant auto-approval
        await state.updateTask(task.id, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_AUTO_APPROVED');
        finalStatus = 'WORKING';
        message = 'Plan auto-approved (TURBO mode). Ready to work.';
      } else if (approvalMode === 'SPEED') {
        // Delayed auto-approval
        const delayMs = project.settings.speedModeDelayMs || 2000;
        const timeoutId = setTimeout(async () => {
          try {
            const currentTask = state.getTask(task.id);
            // Only auto-approve if still in AWAITING_APPROVAL (not manually rejected/approved)
            if (currentTask && currentTask.status === 'AWAITING_APPROVAL') {
              await state.updateTask(task.id, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_AUTO_APPROVED');
            }
          } catch (error) {
            // Log error via activity log so task doesn't get stuck silently
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            state.appendActivity('TASK_BLOCKED' as import('../types/schema.js').ActivityEventType, {
              error: errorMessage,
              reason: 'SPEED mode auto-approval failed'
            }, state.getTask(task.id) ?? undefined);
          } finally {
            speedModeTimeouts.delete(task.id);
          }
        }, delayMs);
        speedModeTimeouts.set(task.id, timeoutId);
        message = `Plan submitted. Auto-approval in ${delayMs}ms (SPEED mode).`;
      }

      // Post system message to task channel
      try {
        await state.postSystemMessage(task.id, `Implementation plan submitted (${implementationPlan.length} steps)`);
      } catch { /* never block tool */ }

      // If plan is already active (TURBO), tell the architect the next move
      // is session summary — they're done. Otherwise point them at check_approval.
      const nextAction = finalStatus === 'WORKING'
        ? {
            tool: 'moe.save_session_summary',
            args: {
              workerId: params.workerId,
              taskId: task.id,
              summary: `Plan submitted for "${task.title}" (${implementationPlan.length} steps); TURBO auto-approved to WORKING.`
            },
            reason: 'Plan auto-approved; record architect findings then wait_for_task.'
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

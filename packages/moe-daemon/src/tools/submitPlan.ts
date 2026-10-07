import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Effort, ProjectSettings, TaskStatus } from '../types/schema.js';
import { MAX_CRITIQUE_BLOCKS_DEFAULT } from '../types/schema.js';
import { checkPlanRails } from '../util/rails.js';
import { notFound, invalidState, invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { normalizeAffectedFiles, findMissingPaths, pathKey } from '../util/affectedFiles.js';
import { cachedPlanRef, findCachedPlanPaths, type CachedPlanPaths } from '../util/cachedPlanPaths.js';
import { assessPlanSize, MAX_STEP_DESCRIPTION_CHARS } from '../util/planSize.js';
import {
  allowedEfforts, clampEffort, EFFORTS, effortFloor, isEffort, isLowEffortPlan, isTier, maxEffort, maxTier, modelsForTier,
  planSizeFloor, resolveLaunch,
} from '../util/routing.js';

/** Upper bound on a single plan step's description — a guard against runaway payloads, not a style limit. */
// The cap lives with the sanitizer's bound (util/planSize) so they cannot drift;
// re-exported here for callers/tests that import it from this module.
export { MAX_STEP_DESCRIPTION_CHARS };
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

/**
 * Arm (or re-arm) the SPEED-mode delayed auto-approval for a task. Cancels any
 * prior pending timer for the task before scheduling so the old timer can't leak,
 * then approves inside the StateManager mutex with a re-check that the task is
 * still AWAITING_APPROVAL (TOCTOU-safe against concurrent manual approve/reject).
 * A delayMs of 0 approves on the next tick. Shared by submit_plan and the
 * post-restart re-arm (rearmSpeedModeApprovals) so they can never diverge.
 */
function armSpeedModeApproval(state: StateManager, taskId: string, delayMs: number): void {
  // Cancel any prior pending auto-approval for this task before scheduling a
  // new one (e.g. a plan resubmitted after an AWAITING_APPROVAL→PLANNING bounce
  // that didn't cancel the timer) — otherwise the old timer leaks.
  cancelSpeedModeTimeout(taskId);
  // detachFromMutexContext: submit_plan runs under the state mutex (McpAdapter
  // dispatch), and a timer created inside that context inherits it — the
  // callback's runExclusive would then short-circuit as "reentrant" and run the
  // re-check + approval WITHOUT the lock, voiding the TOCTOU guarantee below.
  const timeoutId = state.detachFromMutexContext(() => setTimeout(async () => {
    try {
      // approveTask path acquires the StateManager mutex and re-checks that
      // status === 'AWAITING_APPROVAL' inside the locked section.
      await state.runExclusive(async () => {
        const currentTask = state.getTask(taskId);
        if (!currentTask || currentTask.status !== 'AWAITING_APPROVAL') return;
        await state.updateTask(
          taskId,
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
      }, state.getTask(taskId) ?? undefined);
    } finally {
      // Only clear the map entry if it still points at THIS timer — a successor
      // timer scheduled in the meantime must not be deleted (which would leave
      // it live-but-untracked / uncancellable).
      if (speedModeTimeouts.get(taskId) === timeoutId) {
        speedModeTimeouts.delete(taskId);
      }
    }
  }, delayMs));
  speedModeTimeouts.set(taskId, timeoutId);
}

/**
 * Re-arm SPEED-mode auto-approvals after a (re)start. The arming timer lives only
 * in process memory, so a daemon restart strands every AWAITING_APPROVAL task that
 * was waiting on a SPEED timer. Scan the current tasks and re-arm each one,
 * approving immediately (remaining delay 0) when its planSubmittedAt is already
 * older than the configured delay. No-op unless approvalMode === 'SPEED'. Skips
 * tasks that already have a live timer so it's safe to call more than once.
 */
export function rearmSpeedModeApprovals(state: StateManager): void {
  const project = state.project;
  if (!project || project.settings.approvalMode !== 'SPEED') return;
  const delayMs = project.settings.speedModeDelayMs || 2000;
  const now = Date.now();
  for (const task of state.tasks.values()) {
    if (task.status !== 'AWAITING_APPROVAL') continue;
    if (speedModeTimeouts.has(task.id)) continue; // already armed
    const submittedAt = task.planSubmittedAt ? Date.parse(task.planSubmittedAt) : NaN;
    const remaining = Number.isFinite(submittedAt)
      ? Math.max(0, delayMs - (now - submittedAt))
      : 0;
    armSpeedModeApproval(state, task.id, remaining);
  }
}

export function submitPlanTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.submit_plan',
    // Git fallback runs outside the fleet mutex; each validation/write attempt
    // below takes the mutex and revalidates current ownership/status/rails.
    blocking: true,
    description: 'Architect: submit the implementation plan for a PLANNING task and free your seat. CONTROL mode moves the task to AWAITING_APPROVAL for a human, SPEED auto-approves after a short delay, TURBO moves it straight to WORKING (moe.check_approval reports the state). Each step is one ordered unit the worker runs with start_step/complete_step. affectedFiles must already exist under the project root (or the cached origin ref), relative to the project root; put files the step creates in newFiles. Size limits (settings.taskSizing): warns past 8 steps or 5 distinct files, rejects past 12 steps or 10 files — split the task instead.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The PLANNING task this plan is for' },
        steps: {
          type: 'array',
          description: 'Ordered implementation steps; each has a description and the files it edits (affectedFiles) or creates (newFiles)',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              affectedFiles: { type: 'array', items: { type: 'string' } },
              newFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Paths this step will create; exempt from the existence check'
              }
            },
            required: ['description'],
            additionalProperties: false
          }
        },
        workerId: { type: 'string' },
        tier: {
          type: 'string',
          enum: ['light', 'standard', 'heavy'],
          description: 'How much model/effort the worker and QA sessions get. light = a mechanical, one-concern change; standard = normal work; heavy = cross-cutting or subtle. Omit to let the daemon pick from plan size; the daemon never goes below the plan-size tier.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Reasoning effort for the worker and QA sessions, picked for how hard the work is: high = routine work, xhigh = normal work and most coding, max = subtle or cross-cutting work. Only the allowed levels in get_context routing.efforts are used (default high, xhigh, max); anything else, or anything below the tier minimum (light/standard: high, heavy: xhigh), is raised and the response says so. Exception: a docs/tests-only plan (every file matches routing.lowEffort.files, decided from the plan) may also use low or medium when you pick it explicitly, and has no tier minimum. Omit for the tier default (light high, standard xhigh, heavy max), which a docs/tests-only plan gets too.'
        },
        model: {
          type: 'string',
          description: 'Claude model id for the worker and QA sessions, from get_context routing.models.claude (each entry says what it is for and which tiers it may run). Omit for the default. Rejected when the id is not in that catalog or not allowed for the task tier.'
        },
        codexModel: {
          type: 'string',
          description: 'Codex model id for the same sessions when a codex seat claims the task, from get_context routing.models.codex. You do not know which CLI will claim the task, so you may set both model and codexModel. Same validation as model.'
        },
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
      let cachedPaths: CachedPlanPaths | undefined;
      let lookupBranch: unknown;
      const submit = () => state.runExclusive(async () => {
        const params = args as {
          taskId: string;
          workerId?: string;
          tier?: unknown;
          effort?: unknown;
          model?: unknown;
          codexModel?: unknown;
          steps: { description: string; affectedFiles?: string[]; newFiles?: string[] }[];
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
        const normalizedSteps: { description: string; affectedFiles: string[]; newFiles: string[] }[] = [];
        for (let i = 0; i < params.steps.length; i++) {
          const step = params.steps[i];
          if (!step.description || typeof step.description !== 'string' || step.description.trim().length === 0) {
            throw invalidInput('steps', `Step ${i + 1} has empty description`);
          }
          if (step.description.length > MAX_STEP_DESCRIPTION_CHARS) {
            throw invalidInput('steps', `Step ${i + 1} description too long (max ${MAX_STEP_DESCRIPTION_CHARS} chars)`);
          }
          if (step.affectedFiles !== undefined && !Array.isArray(step.affectedFiles)) {
            throw invalidInput('steps', `Step ${i + 1} affectedFiles must be a string[]`);
          }
          if (step.affectedFiles && step.affectedFiles.length > 50) {
            throw invalidInput('steps', `Step ${i + 1} has too many affected files (max 50)`);
          }
          if (step.newFiles !== undefined && !Array.isArray(step.newFiles)) {
            throw invalidInput('steps', `Step ${i + 1} newFiles must be a string[]`);
          }
          if (step.newFiles && step.newFiles.length > 50) {
            throw invalidInput('steps', `Step ${i + 1} has too many new files (max 50)`);
          }
          const normalizedFiles = normalizeAffectedFiles(
            step.affectedFiles,
            `steps[${i}].affectedFiles`
          );
          // Same normalizer as affectedFiles, so absolute paths, drive letters
          // and traversal are rejected for newFiles too.
          const normalizedNewFiles = normalizeAffectedFiles(
            step.newFiles,
            `steps[${i}].newFiles`
          );
          normalizedSteps.push({
            description: step.description,
            affectedFiles: normalizedFiles,
            newFiles: normalizedNewFiles
          });
        }

        const epic = state.getEpic(task.epicId);
        const project = state.project;
        if (!project) throw notFound('Project', 'current');

        // newFiles are part of the plan's file surface — fold them into the rail
        // text so declaring a path as "new" can't smuggle it past a rail.
        const planText = normalizedSteps
          .map((step) => `${step.description} ${step.affectedFiles.join(' ')} ${step.newFiles.join(' ')}`)
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

        // Plan-size gate: oversized tasks fail at coin-flip rates and grind QA —
        // warn past the soft thresholds, hard-reject past the max thresholds so
        // the architect splits the TASK instead of shipping a 5-hour plan.
        // Configurable via settings.taskSizing; runs after rails so a rail
        // violation (a correctness problem) surfaces before a sizing one.
        // Count newFiles toward the distinct-file total too (the Set inside
        // countDistinctAffectedFiles dedupes a path listed in both), so the
        // exemption can't be used to dodge the sizing cap either.
        const planSize = assessPlanSize(
          normalizedSteps.map((step) => ({ affectedFiles: [...step.affectedFiles, ...step.newFiles] })),
          project.settings
        );
        if (planSize.violation) {
          throw new MoeError(
            MoeErrorCode.CONSTRAINT_VIOLATION,
            `${planSize.violation}. This task is too big for one worker session — do NOT merge steps to dodge the cap; split the work. ` +
              `Load the moe-epic-breakdown skill and cut along SPIDR axes (Spike/Path/Interface/Data/Rules): ` +
              `create smaller sibling tasks via moe.create_task (each <=${planSize.thresholds.warnSteps} steps, 1-3 files, one self-contained deliverable), ` +
              `then resubmit a narrow plan for task ${task.id} covering only its slice.`,
            {
              stepCount: planSize.stepCount,
              distinctFileCount: planSize.distinctFileCount,
              thresholds: planSize.thresholds,
              suggestedAction: {
                tool: 'moe.create_task',
                reason: 'Split this task into smaller siblings (moe-epic-breakdown / SPIDR), then resubmit a narrow plan for this one.'
              }
            },
            'CONSTRAINT_VIOLATION'
          );
        }

        // Affected-path existence gate. Runs AFTER the size gate so a cheap
        // size rejection never pays for disk I/O. Paths the plan declares as
        // newFiles (anywhere in the plan) are exempt — a file created in step 1
        // is legitimately cited as affected by step 2.
        const exemptKeys = new Set<string>();
        for (const step of normalizedSteps) {
          for (const file of step.newFiles) exemptKeys.add(pathKey(file));
        }
        const existenceCandidates: string[] = [];
        const candidateSeen = new Set<string>();
        for (const step of normalizedSteps) {
          for (const file of step.affectedFiles) {
            const key = pathKey(file);
            if (exemptKeys.has(key) || candidateSeen.has(key)) continue;
            candidateSeen.add(key);
            existenceCandidates.push(file);
          }
        }
        const diskMissing = await findMissingPaths(state.projectPath, existenceCandidates);
        lookupBranch = project.settings.consolidationBranch;
        const pathValidation = cachedPaths?.ref === cachedPlanRef(lookupBranch) ? cachedPaths : undefined;
        const cachedKeys = new Set((pathValidation?.paths ?? []).map(pathKey));
        const missingPaths = diskMissing.filter(p => !cachedKeys.has(pathKey(p)));
        if (missingPaths.length > 0) {
          const shown = missingPaths.slice(0, 10).join(', ');
          const extra = missingPaths.length > 10 ? ` (+${missingPaths.length - 10} more)` : '';
          throw new MoeError(
            MoeErrorCode.INVALID_INPUT,
            `Plan cites affectedFiles that do not exist under the project root ${state.projectPath}: ${shown}${extra}. ` +
              `If an existing file is absent from this checkout and the configured cached origin ref, provide a current source checkout to Moe. Never omit the path. ` +
              `(1) Check that affectedFiles paths are relative to the PROJECT ROOT, ` +
              `not to a package subdirectory — write "packages/moe-daemon/src/x.ts", not "src/x.ts". Correct the path and resubmit. ` +
              `(2) If this task will CREATE the file, list it in that step's "newFiles" array instead of (or in addition to) affectedFiles; ` +
              `newFiles are exempt from this check and still count toward the plan-size distinct-file total. ` +
              `Do NOT park files that already exist in "newFiles" just to silence this gate — that hides a wrong path from the next worker and from collision detection.`,
            {
              missingPaths,
              projectRoot: state.projectPath,
              suggestedAction: {
                tool: 'moe.submit_plan',
                reason: 'Correct the paths or declare the ones this task creates in step.newFiles, then resubmit.'
              }
            },
            'INVALID_INPUT'
          );
        }

        const implementationPlan = normalizedSteps.map((step, idx) => ({
          stepId: `step-${idx + 1}`,
          description: step.description,
          status: 'PENDING' as const,
          affectedFiles: step.affectedFiles,
          // Omit the key entirely when unused so tasks that never declare a new
          // file keep their current persisted JSON shape.
          ...(step.newFiles.length > 0 ? { newFiles: step.newFiles } : {})
        }));

        // Carry forward existing metrics (firstClaimAt populated by claim path)
        // but refresh the plan-size counters whenever a new plan lands.
        const existingMetrics = task.metrics ?? {};
        const updatedMetrics = {
          ...existingMetrics,
          plannedStepCount: implementationPlan.length,
          plannedDistinctFileCount: planSize.distinctFileCount,
        };

        // Launch tier: architect's pick, never below the plan-size floor, and
        // never below a tier a qa_reject escalation already raised (re-plan).
        const floor = planSizeFloor(normalizedSteps, project.settings);
        const tier = maxTier(maxTier(isTier(params.tier) ? params.tier : floor, floor), task.tier);
        // Effort: the planner's pick, raised to an allowed level and the tier
        // minimum, never below an effort a qa_reject escalation already set.
        // Omitted = the tier default. Only a docs/tests-only plan (decided from
        // its files, not the planner's word) may go below 'high'; a re-plan
        // recomputes it.
        if (params.effort !== undefined && !isEffort(params.effort)) {
          throw invalidInput('effort', `must be one of ${EFFORTS.join(', ')}`);
        }
        const lowEffortEligible = isLowEffortPlan(normalizedSteps, project.settings);
        const requestedEffort = params.effort as Effort | undefined;
        let effort = requestedEffort
          ? maxEffort(
              clampEffort(requestedEffort, project.settings, lowEffortEligible),
              effortFloor(tier, project.settings, lowEffortEligible)
            )
          : undefined;
        if (task.effort) {
          effort = clampEffort(effort ? maxEffort(effort, task.effort) : task.effort, project.settings, lowEffortEligible);
        }
        // Models (claude + codex): each must be its provider's catalog id allowed
        // for this tier. Omitted keeps a prior pick only while still allowed.
        const pickModel = (field: 'model' | 'codexModel', provider: 'claude' | 'codex'): string | undefined => {
          const allowed = modelsForTier(tier, project.settings, provider);
          const requested = params[field];
          if (requested !== undefined && (typeof requested !== 'string' || !allowed.includes(requested))) {
            throw invalidInput(field, `${JSON.stringify(requested)} is not allowed for a ${tier} task; allowed ${provider} models: ${allowed.join(', ')} (catalog: settings.routing.models)`);
          }
          const prior = task[field];
          return (requested as string | undefined) ?? (prior && allowed.includes(prior) ? prior : undefined);
        };
        const model = pickModel('model', 'claude');
        const codexModel = pickModel('codexModel', 'codex');

        const updatePayload: Record<string, unknown> = {
          implementationPlan,
          tier,
          effort,
          model,
          codexModel,
          lowEffortEligible: lowEffortEligible || undefined,
          // Persist warn-zone size warnings so boards/governors see size pressure
          // without reading chat; a compliant resubmit clears them.
          planSizeWarnings: planSize.warnings.length > 0 ? planSize.warnings : undefined,
          // A freshly-submitted plan supersedes any prior attempt's step ids — clear
          // stepsCompleted so it can't carry stale 'step-N' ids onto the new plan
          // (request_replan already does this; submit_plan is the other fresh-plan boundary).
          stepsCompleted: [],
          // A new plan is a new attempt: scrub the failed-DoD-item log so the
          // qa_reject "same item failed twice" net counts only within this
          // attempt, not against items that failed under the superseded plan.
          failedDodItems: [],
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
        // Keep the Task this write returned: its planRevision is the value that
        // was actually committed with this plan. Reading the cache later would
        // report a stamp a concurrent write had already moved past.
        const submitted = await state.updateTask(task.id, updatePayload, 'PLAN_SUBMITTED', params.workerId);
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
          armSpeedModeApproval(state, task.id, delayMs);
          message = `Plan submitted. Auto-approval in ${delayMs}ms (SPEED mode).`;
        }

        // Post system message to task channel
        try {
          await state.postSystemMessage(task.id, `Implementation plan submitted (${implementationPlan.length} steps)`
            + (pathValidation ? `\n${pathValidation.warning} Paths: ${pathValidation.paths.slice(0, 10).join(', ')}${pathValidation.paths.length > 10 ? ' (additional paths in tool response)' : ''}` : ''));
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
            const sizeWarningLines = planSize.warnings.length > 0
              ? `⚠️ ${planSize.warnings.join('\n⚠️ ')}\n`
              : '';
            const summary = `📋 Plan ready for critique — ${task.title} (${task.id})\n`
              + `Steps: ${implementationPlan.length} | Distinct files: ${planSize.distinctFileCount}\n`
              + sizeWarningLines
              + `Size rubric: block when steps > ${planSize.thresholds.maxSteps} or files > ${planSize.thresholds.maxDistinctFiles}; scrutinize anything past ${planSize.thresholds.warnSteps} steps / ${planSize.thresholds.warnDistinctFiles} files — oversized tasks should be split (SPIDR), not line-edited.\n`
              + `DoD:\n${dodSummary}\n`
              + `Call moe.submit_plan_critique { taskId: "${task.id}", verdict: "pass" | "block", concerns? } to weigh in.`;
            await state.postToRoleChannel('governors', summary);
          } catch { /* never block tool */ }
          // Set pendingPlanCritique if at least one governor is online so
          // downstream consumers (UI, get_handoff_history, etc.) can see the
          // task is parked awaiting critique. Active = registered with team
          // role 'governor'. We use a separate update to avoid clobbering the
          // status transition's worker-clearing logic.
          let governorOnline = false;
          try {
            const governors: string[] = [];
            for (const team of state.teams.values()) {
              if (team.role !== 'governor') continue;
              for (const memberId of team.memberIds) {
                const w = state.getWorker(memberId);
                if (w) governors.push(memberId);
              }
            }
            governorOnline = governors.length > 0;
            if (governorOnline) {
              await state.updateTask(task.id, {
                pendingPlanCritique: {
                  criticWorkerId: governors[0],
                  requestedAt: new Date().toISOString(),
                },
              });
            }
          } catch { /* never block tool */ }

          // Unsupervised size critique (opt-in, settings.taskSizing.autoCritique):
          // with no governor online there is nobody to block a warn-zone plan
          // before the human sees it, so the daemon itself files the critique —
          // reusing the governor block machinery and its cap so architect ↔
          // daemon can't loop forever. At the cap the task rests in
          // AWAITING_APPROVAL (human-gated) with a loud banner instead.
          if (!governorOnline && planSize.warnings.length > 0 && project.settings.taskSizing?.autoCritique === true) {
            const blockCount = task.critiqueBlockCount ?? 0;
            const concerns = planSize.warnings;
            const concernText = concerns.map((c) => `• ${c}`).join('\n');
            if (blockCount < MAX_CRITIQUE_BLOCKS_DEFAULT) {
              try {
                await state.updateTask(task.id, {
                  status: 'PLANNING',
                  critiqueBlockCount: blockCount + 1,
                  planCritiqueResult: {
                    verdict: 'block',
                    reviewedBy: 'moe-daemon-size-critic',
                    reviewedAt: new Date().toISOString(),
                    concerns,
                  },
                  pendingPlanCritique: undefined,
                  reopenReason: `Plan auto-blocked as oversized (no governor online): ${concerns.join(' | ').slice(0, 500)}`,
                }, 'TASK_UPDATED');
                finalStatus = 'PLANNING';
                message = 'Plan auto-blocked as oversized (size critic; no governor online). Split the task and resubmit a narrower plan.';
                try {
                  await state.postToRoleChannel(
                    'architects',
                    `🚫 plan auto-blocked on ${task.id} (${task.title}) by the daemon size critic — flipped to PLANNING (block ${blockCount + 1}/${MAX_CRITIQUE_BLOCKS_DEFAULT}).\nConcerns:\n${concernText}`
                  );
                } catch { /* never block tool */ }
              } catch { /* never block tool — plan stays AWAITING_APPROVAL on failure */ }
            } else {
              try {
                await state.postToRoleChannel(
                  'architects',
                  `🛑 HUMAN DECISION REQUIRED — ${task.id} (${task.title}) is still oversized after ${MAX_CRITIQUE_BLOCKS_DEFAULT} size-critic blocks. Not auto-flipping again; it rests in AWAITING_APPROVAL for a human to approve or re-plan.\nConcerns:\n${concernText}`
                );
              } catch { /* never block tool */ }
            }
          }
        }

        // If plan is already active (TURBO), the architect is done — point them at
        // the next PLANNING task. Auto-blocked plans route back to a re-plan.
        // Otherwise point them at check_approval.
        const nextAction = finalStatus === 'WORKING'
          ? {
              tool: 'moe.wait_for_task',
              args: { statuses: ['PLANNING'], workerId: params.workerId },
              reason: 'Plan auto-approved (TURBO). Record any reusable planning insight with Serena write_memory, then block until the next PLANNING task arrives.'
            }
          : finalStatus === 'PLANNING'
          ? {
              tool: 'moe.claim_next_task',
              args: { statuses: ['PLANNING'], taskId: task.id, workerId: params.workerId },
              reason: 'Plan auto-blocked as oversized. Re-claim the task, split it (create smaller sibling tasks), and resubmit a narrower plan.',
              recommendedSkill: { name: 'moe-epic-breakdown', reason: 'The size critic blocked this plan. Load this and split along SPIDR axes before resubmitting.' }
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
          // The revision committed alongside this plan — the token a later
          // approval check compares against, not a recomputed value.
          planRevision: submitted.planRevision,
          distinctFileCount: planSize.distinctFileCount,
          newFileCount: exemptKeys.size,
          tier,
          ...(effort && requestedEffort && effort !== requestedEffort
            ? {
                effortRaised: {
                  from: requestedEffort,
                  to: effort,
                  reason: lowEffortEligible
                    ? `raised to an allowed level (${allowedEfforts(project.settings, true).join(', ')})`
                    : `raised to an allowed level (${allowedEfforts(project.settings).join(', ')}) and the ${tier}-task minimum; only docs/tests-only plans may run below that`,
                },
              }
            : {}),
          ...(lowEffortEligible ? { lowEffort: 'docs/tests-only: low effort allowed' } : {}),
          ...(() => {
            const launch = resolveLaunch(
              { tier, effort, model, codexModel, lowEffortEligible, status: finalStatus as TaskStatus },
              project.settings
            );
            return launch ? { launch } : {};
          })(),
          ...(pathValidation ? { pathValidation } : {}),
          ...(planSize.warnings.length > 0 ? { warnings: planSize.warnings } : {}),
          message,
          nextAction
        };
      });
      try {
        return await submit();
      } catch (error) {
        // Only this pre-write refusal may retry. The first attempt performed
        // all normal validation, but made no task/worker/approval changes.
        if (!(error instanceof MoeError) || error.code !== MoeErrorCode.INVALID_INPUT
            || !Array.isArray(error.context?.missingPaths)) throw error;
        cachedPaths = await findCachedPlanPaths(state.projectPath, lookupBranch,
          error.context.missingPaths as string[]);
        if (!cachedPaths) throw error;
        // Re-read everything under the lock; never submit from a pre-Git task
        // snapshot if the owner/plan/rails changed while the lookup was running.
        return submit();
      }
    }
  };
}

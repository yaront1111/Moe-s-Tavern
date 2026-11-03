import type { GlobalRails, Epic, Task } from '../types/schema.js';
import { MoeError, MoeErrorCode } from './errors.js';

export interface RailsCheckResult {
  ok: boolean;
  violation?: string;
}

/** submit_plan's default retry sentence; amend_plan_step names its own. */
export const SUBMIT_PLAN_RAIL_ACTION = 'revise the plan to satisfy this rail and resubmit moe.submit_plan';

/**
 * The text the plan rails are checked against: each step's description plus its
 * affectedFiles and newFiles. newFiles are part of the plan's file surface, so
 * declaring a path as "new" can't smuggle it past a rail. A hand-edited
 * non-array file field contributes '' instead of throwing.
 */
export function planRailText(
  steps: ReadonlyArray<{ description: string; affectedFiles?: unknown; newFiles?: unknown }>
): string {
  const files = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : '');
  return steps
    .map((step) => `${step.description} ${files(step.affectedFiles)} ${files(step.newFiles)}`)
    .join(' ');
}

/**
 * Every global-rail violation in `planText`, in check order: each present
 * forbidden pattern, then each missing required pattern. Case-insensitive
 * substring matching; empty patterns are skipped.
 */
export function listPlanRailViolations(planText: string, projectRails: GlobalRails): string[] {
  const text = planText.toLowerCase();
  const violations: string[] = [];

  for (const forbidden of projectRails.forbiddenPatterns || []) {
    if (!forbidden) continue;
    if (text.includes(forbidden.toLowerCase())) {
      violations.push(`Forbidden pattern: ${forbidden}`);
    }
  }

  for (const req of projectRails.requiredPatterns || []) {
    if (!req) continue;
    if (!text.includes(req.toLowerCase())) {
      violations.push(`Required pattern missing: ${req}`);
    }
  }

  return violations;
}

export function checkPlanRails(
  planText: string,
  projectRails: GlobalRails,
  epic: Epic | null,
  task: Task | null
): RailsCheckResult {
  const violation = listPlanRailViolations(planText, projectRails)[0];

  // Note: Epic and task rails are provided as guidance to AI agents but are not
  // strictly enforced in plan text. This allows agents to address the intent of
  // rails without requiring verbatim quoting. Humans can verify during plan approval.
  // Only forbiddenPatterns and global requiredPatterns are strictly enforced.

  return violation === undefined ? { ok: true } : { ok: false, violation };
}

/**
 * Keep step and contract rail refusals identical, including the escape hatch.
 * `defaultAction` completes "Default action: revise ... " for the calling tool.
 */
export function assertPlanRails(
  railsCheck: RailsCheckResult,
  taskId: string,
  defaultAction: string = SUBMIT_PLAN_RAIL_ACTION
): void {
  if (!railsCheck.ok) {
    // Steer the agent toward the escape hatch when the rail is wrong for
    // this task (rare but legitimate). The default path is still to fix
    // the plan — propose_rail is only for when the rail itself is the
    // bug, not when the plan skipped a required pattern.
    const v = railsCheck.violation || {};
    // Only a GLOBAL MODIFY_RAIL/REMOVE_RAIL of the quoted entry can lift this
    // refusal: the check reads globalRails.forbiddenPatterns and requiredPatterns
    // only (never epicRails, taskRails or customRules), and propose_rail resolves
    // a GLOBAL currentValue in those lists (task-34e42a0a). Every violation is
    // built by listPlanRailViolations, so the entry is the text after its label.
    const entry = typeof v === 'string'
      ? /^(?:Forbidden pattern|Required pattern missing): ([\s\S]*)$/.exec(v)?.[1]
      : undefined;
    const currentValue = entry === undefined
      ? '<the exact forbiddenPatterns or requiredPatterns entry>'
      : JSON.stringify(entry);
    const message =
      `Rail violation: ${JSON.stringify(v)}. ` +
      `Default action: ${defaultAction}. ` +
      `Escape hatch: if this rail is genuinely wrong for task ${taskId} (e.g., a forbidden pattern that's a false positive, or a required phrase that doesn't fit), call ` +
      `moe.propose_rail { proposalType: "MODIFY_RAIL" | "REMOVE_RAIL", targetScope: "GLOBAL", taskId: "${taskId}", currentValue: ${currentValue}, proposedValue, reason, workerId } ` +
      `to request a human-approved change to that globalRails entry. Only that GLOBAL change can lift this refusal: the plan check enforces no other rail. ` +
      `Do NOT loop between resubmits if the rail is the real blocker — propose the change.`;
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
}

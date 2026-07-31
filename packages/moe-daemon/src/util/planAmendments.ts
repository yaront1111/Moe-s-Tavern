import type { ImplementationStep, StepAmendment } from '../types/schema.js';

/**
 * Cap on in-place revisions of a single step. A step amended this many times is
 * a re-plan wearing a disguise — moe.amend_plan_step points the caller at
 * moe.request_replan instead.
 */
export const MAX_AMENDMENTS_PER_STEP = 10;

/** A step as far as amendment resolution is concerned. */
type AmendableStep = Pick<ImplementationStep, 'description' | 'amendments' | 'activeAmendmentId'>;

function amendmentList(step: AmendableStep): StepAmendment[] {
  // .moe/tasks/*.json is hand-editable, so a non-array here is possible.
  return Array.isArray(step?.amendments) ? step.amendments : [];
}

/** Id for the next amendment on this step: `amend-1`, `amend-2`, … */
export function nextAmendmentId(step: AmendableStep): string {
  return `amend-${amendmentList(step).length + 1}`;
}

/**
 * The amendment currently in force, or null when the step has none. A dangling
 * `activeAmendmentId` (no matching entry) resolves to null rather than
 * throwing — losing an amendment is recoverable, wedging complete_step for the
 * whole task is not.
 */
export function activeAmendment(step: AmendableStep): StepAmendment | null {
  if (typeof step?.activeAmendmentId !== 'string' || step.activeAmendmentId.length === 0) return null;
  const found = amendmentList(step).find(
    (a) => a && typeof a.description === 'string' && a.amendmentId === step.activeAmendmentId
  );
  return found ?? null;
}

/**
 * The instructions a worker must actually follow: the active amendment's
 * replacement text when one is in force, else the step as originally planned.
 * This is the ONE resolution point — tools must not re-derive it.
 */
export function effectiveStepDescription(step: AmendableStep): string {
  return activeAmendment(step)?.description ?? step?.description ?? '';
}

import type { ProjectSettings, TaskSizingSettings } from '../types/schema.js';

/**
 * Plan-size assessment for moe.submit_plan.
 *
 * Why this exists: oversized tasks are the root cause behind both fleet
 * pathologies we see — QA-reject churn (frontier models complete ~30-60
 * human-minute tasks at 80%+ but multi-hour tasks at coin-flip rates) and
 * code-standards drift (compliance decays per function generated within one
 * session). Prompt guidance alone doesn't hold; this is the machine gate all
 * three agent CLIs share.
 *
 * Warn thresholds append advisory warnings to the submit_plan response;
 * max thresholds hard-reject the plan with "split the task" guidance.
 */

export const WARN_STEPS_DEFAULT = 8;
export const MAX_STEPS_DEFAULT = 12;
export const WARN_DISTINCT_FILES_DEFAULT = 5;
export const MAX_DISTINCT_FILES_DEFAULT = 10;

export interface ResolvedTaskSizing {
  warnSteps: number;
  maxSteps: number;
  warnDistinctFiles: number;
  maxDistinctFiles: number;
}

export interface PlanSizeAssessment {
  stepCount: number;
  distinctFileCount: number;
  /** Advisory messages when past a warn threshold (empty when within bounds). */
  warnings: string[];
  /** Set when past a max threshold — the plan must be rejected. */
  violation?: string;
  thresholds: ResolvedTaskSizing;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Resolve configured thresholds against defaults. A max below its warn is
 * lifted to the warn value so a partial settings edit can't invert the bands.
 */
export function resolveTaskSizing(sizing?: TaskSizingSettings): ResolvedTaskSizing {
  const warnSteps = positiveInt(sizing?.warnSteps, WARN_STEPS_DEFAULT);
  const warnDistinctFiles = positiveInt(sizing?.warnDistinctFiles, WARN_DISTINCT_FILES_DEFAULT);
  return {
    warnSteps,
    maxSteps: Math.max(warnSteps, positiveInt(sizing?.maxSteps, MAX_STEPS_DEFAULT)),
    warnDistinctFiles,
    maxDistinctFiles: Math.max(
      warnDistinctFiles,
      positiveInt(sizing?.maxDistinctFiles, MAX_DISTINCT_FILES_DEFAULT)
    ),
  };
}

/** Union of affectedFiles across steps (paths are already normalized by submit_plan). */
export function countDistinctAffectedFiles(steps: { affectedFiles: string[] }[]): number {
  const distinct = new Set<string>();
  for (const step of steps) {
    for (const file of step.affectedFiles) distinct.add(file);
  }
  return distinct.size;
}

export function assessPlanSize(
  steps: { affectedFiles: string[] }[],
  settings?: Pick<ProjectSettings, 'taskSizing'>
): PlanSizeAssessment {
  const thresholds = resolveTaskSizing(settings?.taskSizing);
  const stepCount = steps.length;
  const distinctFileCount = countDistinctAffectedFiles(steps);

  const overMax: string[] = [];
  if (stepCount > thresholds.maxSteps) {
    overMax.push(`${stepCount} steps (max ${thresholds.maxSteps})`);
  }
  if (distinctFileCount > thresholds.maxDistinctFiles) {
    overMax.push(`${distinctFileCount} distinct affected files (max ${thresholds.maxDistinctFiles})`);
  }

  const warnings: string[] = [];
  if (overMax.length === 0) {
    if (stepCount > thresholds.warnSteps) {
      warnings.push(
        `Plan has ${stepCount} steps (target <=${thresholds.warnSteps}); plans over ${thresholds.maxSteps} are rejected. Consider splitting the task before it grows.`
      );
    }
    if (distinctFileCount > thresholds.warnDistinctFiles) {
      warnings.push(
        `Plan touches ${distinctFileCount} distinct files (target <=${thresholds.warnDistinctFiles}); plans over ${thresholds.maxDistinctFiles} are rejected. Small file-disjoint tasks review better and parallelize.`
      );
    }
  }

  return {
    stepCount,
    distinctFileCount,
    warnings,
    ...(overMax.length > 0 ? { violation: `Plan too large: ${overMax.join(', ')}` } : {}),
    thresholds,
  };
}

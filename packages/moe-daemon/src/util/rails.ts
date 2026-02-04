import type { GlobalRails, Epic, Task } from '../types/schema.js';

export interface RailsCheckResult {
  ok: boolean;
  violation?: string;
}

export function checkPlanRails(
  planText: string,
  projectRails: GlobalRails,
  epic: Epic | null,
  task: Task | null
): RailsCheckResult {
  const text = planText.toLowerCase();

  for (const forbidden of projectRails.forbiddenPatterns || []) {
    if (!forbidden) continue;
    if (text.includes(forbidden.toLowerCase())) {
      return { ok: false, violation: `Forbidden pattern: ${forbidden}` };
    }
  }

  const required = projectRails.requiredPatterns || [];
  for (const req of required) {
    if (!req) continue;
    if (!text.includes(req.toLowerCase())) {
      return { ok: false, violation: `Required pattern missing: ${req}` };
    }
  }

  if (epic?.epicRails?.length) {
    for (const rail of epic.epicRails) {
      if (!rail) continue;
      if (!text.includes(rail.toLowerCase())) {
        return { ok: false, violation: `Epic rail missing: ${rail}` };
      }
    }
  }

  if (task?.taskRails?.length) {
    for (const rail of task.taskRails) {
      if (!rail) continue;
      if (!text.includes(rail.toLowerCase())) {
        return { ok: false, violation: `Task rail missing: ${rail}` };
      }
    }
  }

  return { ok: true };
}

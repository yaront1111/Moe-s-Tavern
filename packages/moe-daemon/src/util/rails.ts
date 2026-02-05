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

  // Note: Epic and task rails are provided as guidance to AI agents but are not
  // strictly enforced in plan text. This allows agents to address the intent of
  // rails without requiring verbatim quoting. Humans can verify during plan approval.
  // Only forbiddenPatterns and global requiredPatterns are strictly enforced.

  return { ok: true };
}

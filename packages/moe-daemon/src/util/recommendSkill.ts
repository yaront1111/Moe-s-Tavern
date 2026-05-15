/**
 * Skill recommendation lookup.
 *
 * Maps (role, phase-trigger) → curated skill recommendation. Tools call this
 * when shaping their `nextAction.recommendedSkill` field.
 *
 * Each recommendation carries a `reason` so the spawned agent sees WHY the
 * skill is being recommended right now, not just the name. The reason is
 * what lets the agent recognize itself in the condition ("oh, I'm about to
 * submit a plan — yes, I should load writing-plans first") instead of
 * rationalizing past a bare name ("moe-planning sounds like drafting, I'm
 * blocking, doesn't apply").
 *
 * Phases the daemon can detect from state machine position:
 *   - architect, fresh PLANNING task                    → moe-planning
 *   - architect, before submit_plan                     → writing-plans
 *   - worker,    on first start_step (unfamiliar code)  → explore-before-assume
 *   - worker,    on test-touching step                  → test-driven-development
 *   - worker,    on final step                          → adversarial-self-review
 *   - worker,    before complete_task                   → verification-before-completion
 *   - worker,    on BLOCKED / repeated failure          → systematic-debugging
 *   - worker,    after qa_reject (reopenCount > 0)      → receiving-code-review
 *   - qa,        on REVIEW status                       → moe-qa-loop
 *
 * Skill names match directory names under .moe/skills/<name>/SKILL.md.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   SHELL-QUOTING HAZARD — read before editing a `reason` string.
 * ─────────────────────────────────────────────────────────────────────────
 *   These strings are inlined into a bash double-quoted heredoc and a
 *   PowerShell `@"..."@` here-string by the agent wrappers. Inside those:
 *
 *     - `$FOO`   → the shell expands the variable (bash AND powershell).
 *     - `` ` ``  → bash interprets as command substitution.
 *     - `"`      → bash terminates the string; powershell treats as literal
 *                  inside `@"..."@` but only when not followed by `@`.
 *     - `\n`     → a literal newline in the source will corrupt the bash
 *                  parser (see scripts/moe-agent.sh split-on-newline logic).
 *
 *   Safe today: keep reasons single-line, no `$`, no backticks, no unescaped
 *   double quotes. If you genuinely need any of those, harden the wrappers
 *   first (sentinel-separated output, escape passes) — don't rely on the
 *   author remembering.
 */

import type { SkillRecommendation } from '../types/schema.js';

export type { SkillRecommendation } from '../types/schema.js';

export type Role = 'architect' | 'worker' | 'qa';

export type SkillTrigger =
  | 'planning_entry'           // architect, fresh PLANNING task
  | 'before_submit_plan'       // architect, plan drafted
  | 'first_start_step'         // worker, opening a step
  | 'test_step'                // worker, step touches tests
  | 'final_step'               // worker, last step before complete_step
  | 'before_complete_task'     // worker, all steps done
  | 'task_blocked'             // worker, set_task_status BLOCKED
  | 'reopened'                 // worker, reopenCount > 0
  | 'review_entry'             // qa, claiming REVIEW
  ;

const TABLE: Record<Role, Partial<Record<SkillTrigger, SkillRecommendation>>> = {
  architect: {
    planning_entry:     { name: 'moe-planning',                  reason: 'Fresh PLANNING task.' },
    before_submit_plan: { name: 'writing-plans',                 reason: 'Before submit_plan.' },
  },
  worker: {
    first_start_step:     { name: 'explore-before-assume',         reason: 'First step in unfamiliar code.' },
    test_step:            { name: 'test-driven-development',       reason: 'Step touches tests.' },
    final_step:           { name: 'adversarial-self-review',       reason: 'Final step before complete_step.' },
    before_complete_task: { name: 'verification-before-completion', reason: 'Before complete_task.' },
    task_blocked:         { name: 'systematic-debugging',          reason: 'Before blocking.' },
    reopened:             { name: 'receiving-code-review',         reason: 'Reopened by QA.' },
  },
  qa: {
    review_entry: { name: 'moe-qa-loop', reason: 'Claimed REVIEW.' },
  },
};

export function recommendSkillFor(role: Role, trigger: SkillTrigger): SkillRecommendation | undefined {
  return TABLE[role]?.[trigger];
}

/**
 * All skill names the daemon may surface via nextAction. Useful for tests +
 * the agent-wrapper "Available skills" manifest.
 *
 * Defensive: filter out any `undefined` that could slip in through a partial
 * roleMap (TypeScript can't catch that at compile time, so we guard at
 * module-load time rather than crashing on first daemon boot).
 */
export const RECOMMENDED_SKILLS: string[] = Object.values(TABLE)
  .flatMap((roleMap) => Object.values(roleMap))
  .filter((rec): rec is SkillRecommendation => !!rec && typeof rec.name === 'string')
  .map((rec) => rec.name)
  .filter((name, i, arr) => arr.indexOf(name) === i)
  .sort();

/**
 * Skill recommendation lookup.
 *
 * Maps (role, MCP tool name) → curated skill name. Tools call this when
 * shaping their `nextAction.recommendedSkill` field.
 *
 * Phases the daemon can detect from state machine position:
 *   - architect, after get_context (PLANNING)         → moe-planning
 *   - architect, before submit_plan                    → writing-plans
 *   - worker,    on first start_step (unfamiliar code) → explore-before-assume
 *   - worker,    on test-touching step                 → test-driven-development
 *   - worker,    on final step                         → adversarial-self-review
 *   - worker,    before complete_task                  → verification-before-completion
 *   - worker,    on BLOCKED / repeated failure         → systematic-debugging
 *   - worker,    after qa_reject (reopenCount > 0)     → receiving-code-review
 *   - qa,        on REVIEW status                      → moe-qa-loop
 *
 * Skill names match directory names under .moe/skills/<name>/SKILL.md.
 */

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

const TABLE: Record<Role, Partial<Record<SkillTrigger, string>>> = {
  architect: {
    planning_entry: 'moe-planning',
    before_submit_plan: 'writing-plans',
  },
  worker: {
    first_start_step: 'explore-before-assume',
    test_step: 'test-driven-development',
    final_step: 'adversarial-self-review',
    before_complete_task: 'verification-before-completion',
    task_blocked: 'systematic-debugging',
    reopened: 'receiving-code-review',
  },
  qa: {
    review_entry: 'moe-qa-loop',
  },
};

export function recommendSkillFor(role: Role, trigger: SkillTrigger): string | undefined {
  return TABLE[role]?.[trigger];
}

/**
 * All skills the daemon may surface via nextAction. Useful for tests + the
 * agent-wrapper "Available skills" injection.
 */
export const RECOMMENDED_SKILLS = Object.values(TABLE)
  .flatMap((roleMap) => Object.values(roleMap))
  .filter((s): s is string => typeof s === 'string')
  .filter((s, i, arr) => arr.indexOf(s) === i)
  .sort();

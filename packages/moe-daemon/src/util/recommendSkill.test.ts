import { describe, it, expect } from 'vitest';
import { recommendSkillFor, RECOMMENDED_SKILLS } from './recommendSkill.js';

describe('recommendSkillFor', () => {
  it('recommends moe-planning for architect entering PLANNING', () => {
    expect(recommendSkillFor('architect', 'planning_entry')).toMatchObject({
      name: 'moe-planning',
      reason: expect.any(String),
    });
  });

  it('recommends writing-plans for architect before submit_plan', () => {
    expect(recommendSkillFor('architect', 'before_submit_plan')).toMatchObject({
      name: 'writing-plans',
      reason: expect.any(String),
    });
  });

  it('recommends explore-before-assume for worker on first start_step', () => {
    expect(recommendSkillFor('worker', 'first_start_step')).toMatchObject({
      name: 'explore-before-assume',
      reason: expect.any(String),
    });
  });

  it('recommends test-driven-development for worker on a test step', () => {
    expect(recommendSkillFor('worker', 'test_step')).toMatchObject({
      name: 'test-driven-development',
      reason: expect.any(String),
    });
  });

  it('recommends adversarial-self-review for worker on the final step', () => {
    expect(recommendSkillFor('worker', 'final_step')).toMatchObject({
      name: 'adversarial-self-review',
      reason: expect.any(String),
    });
  });

  it('recommends verification-before-completion for worker before complete_task', () => {
    expect(recommendSkillFor('worker', 'before_complete_task')).toMatchObject({
      name: 'verification-before-completion',
      reason: expect.any(String),
    });
  });

  it('recommends systematic-debugging for worker when task is BLOCKED', () => {
    expect(recommendSkillFor('worker', 'task_blocked')).toMatchObject({
      name: 'systematic-debugging',
      reason: expect.any(String),
    });
  });

  it('recommends receiving-code-review for worker after qa_reject', () => {
    expect(recommendSkillFor('worker', 'reopened')).toMatchObject({
      name: 'receiving-code-review',
      reason: expect.any(String),
    });
  });

  it('recommends moe-qa-loop for QA on REVIEW entry', () => {
    expect(recommendSkillFor('qa', 'review_entry')).toMatchObject({
      name: 'moe-qa-loop',
      reason: expect.any(String),
    });
  });

  it('every reason string is non-empty (anti-rationalization cue)', () => {
    // The reason field is what lets a spawned agent latch onto "why now" — if it
    // drifts to empty the JIT system-reminder in the wrapper degenerates to a
    // bare name, which is exactly the failure mode this change fixes.
    const triggers: Array<[Parameters<typeof recommendSkillFor>[0], Parameters<typeof recommendSkillFor>[1]]> = [
      ['architect', 'planning_entry'],
      ['architect', 'before_submit_plan'],
      ['worker', 'first_start_step'],
      ['worker', 'test_step'],
      ['worker', 'final_step'],
      ['worker', 'before_complete_task'],
      ['worker', 'task_blocked'],
      ['worker', 'reopened'],
      ['qa', 'review_entry'],
    ];
    for (const [role, trigger] of triggers) {
      const rec = recommendSkillFor(role, trigger);
      expect(rec?.reason, `${role}/${trigger} reason`).toBeTruthy();
      expect(rec?.reason.length ?? 0, `${role}/${trigger} reason length`).toBeGreaterThan(20);
    }
  });

  it('returns undefined for combinations the daemon does not surface', () => {
    expect(recommendSkillFor('qa', 'planning_entry' as never)).toBeUndefined();
    expect(recommendSkillFor('architect', 'review_entry' as never)).toBeUndefined();
  });

  it('exports a deduplicated, sorted list of all recommended skill names', () => {
    expect(RECOMMENDED_SKILLS).toEqual([
      'adversarial-self-review',
      'explore-before-assume',
      'moe-planning',
      'moe-qa-loop',
      'receiving-code-review',
      'systematic-debugging',
      'test-driven-development',
      'verification-before-completion',
      'writing-plans',
    ]);
  });
});

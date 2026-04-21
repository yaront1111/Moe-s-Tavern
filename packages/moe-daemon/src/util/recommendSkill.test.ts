import { describe, it, expect } from 'vitest';
import { recommendSkillFor, RECOMMENDED_SKILLS } from './recommendSkill.js';

describe('recommendSkillFor', () => {
  it('recommends moe-planning for architect entering PLANNING', () => {
    expect(recommendSkillFor('architect', 'planning_entry')).toBe('moe-planning');
  });

  it('recommends writing-plans for architect before submit_plan', () => {
    expect(recommendSkillFor('architect', 'before_submit_plan')).toBe('writing-plans');
  });

  it('recommends explore-before-assume for worker on first start_step', () => {
    expect(recommendSkillFor('worker', 'first_start_step')).toBe('explore-before-assume');
  });

  it('recommends test-driven-development for worker on a test step', () => {
    expect(recommendSkillFor('worker', 'test_step')).toBe('test-driven-development');
  });

  it('recommends adversarial-self-review for worker on the final step', () => {
    expect(recommendSkillFor('worker', 'final_step')).toBe('adversarial-self-review');
  });

  it('recommends verification-before-completion for worker before complete_task', () => {
    expect(recommendSkillFor('worker', 'before_complete_task')).toBe('verification-before-completion');
  });

  it('recommends systematic-debugging for worker when task is BLOCKED', () => {
    expect(recommendSkillFor('worker', 'task_blocked')).toBe('systematic-debugging');
  });

  it('recommends receiving-code-review for worker after qa_reject', () => {
    expect(recommendSkillFor('worker', 'reopened')).toBe('receiving-code-review');
  });

  it('recommends moe-qa-loop for QA on REVIEW entry', () => {
    expect(recommendSkillFor('qa', 'review_entry')).toBe('moe-qa-loop');
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

import { describe, it, expect } from 'vitest';
import { checkPlanRails } from './rails.js';
import type { GlobalRails, Epic, Task } from '../types/schema.js';

describe('checkPlanRails', () => {
  const emptyRails: GlobalRails = {};

  it('passes when there are no rails', () => {
    const result = checkPlanRails('Any plan text', emptyRails, null, null);
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  describe('forbidden patterns', () => {
    it('fails when plan contains a forbidden pattern', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['delete production', 'drop database'],
      };
      const result = checkPlanRails('I will delete production data', rails, null, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Forbidden pattern: delete production');
    });

    it('is case-insensitive', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['DELETE PRODUCTION'],
      };
      const result = checkPlanRails('i will delete production data', rails, null, null);
      expect(result.ok).toBe(false);
    });

    it('passes when forbidden patterns are not found', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['delete production'],
      };
      const result = checkPlanRails('I will update the staging environment', rails, null, null);
      expect(result.ok).toBe(true);
    });

    it('skips empty forbidden patterns', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['', 'bad thing'],
      };
      const result = checkPlanRails('This is fine', rails, null, null);
      expect(result.ok).toBe(true);
    });
  });

  describe('required patterns', () => {
    it('fails when required pattern is missing', () => {
      const rails: GlobalRails = {
        requiredPatterns: ['test coverage'],
      };
      const result = checkPlanRails('I will implement the feature', rails, null, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Required pattern missing: test coverage');
    });

    it('passes when all required patterns are present', () => {
      const rails: GlobalRails = {
        requiredPatterns: ['test coverage', 'documentation'],
      };
      const result = checkPlanRails(
        'I will add test coverage and update documentation',
        rails,
        null,
        null
      );
      expect(result.ok).toBe(true);
    });

    it('is case-insensitive', () => {
      const rails: GlobalRails = {
        requiredPatterns: ['TEST COVERAGE'],
      };
      const result = checkPlanRails('Add test coverage for the feature', rails, null, null);
      expect(result.ok).toBe(true);
    });
  });

  describe('epic rails (guidance only, not enforced)', () => {
    // Epic rails are provided as guidance to AI agents but are not strictly enforced.
    // This allows agents to address the intent of rails without requiring verbatim quoting.
    // Humans verify compliance during plan approval.

    it('passes even when epic rail text is not literally present', () => {
      const epic: Epic = {
        id: 'epic-1',
        title: 'Test Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
        epicRails: ['must use typescript'],
      };
      // Plan doesn't contain literal "must use typescript" but that's OK
      const result = checkPlanRails('I will use javascript', emptyRails, epic, null);
      expect(result.ok).toBe(true);
    });

    it('passes when epic rails are present (still valid)', () => {
      const epic: Epic = {
        id: 'epic-1',
        title: 'Test Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
        epicRails: ['typescript', 'unit tests'],
      };
      const result = checkPlanRails(
        'I will use TypeScript and add unit tests',
        emptyRails,
        epic,
        null
      );
      expect(result.ok).toBe(true);
    });

    it('handles epic without rails', () => {
      const epic: Epic = {
        id: 'epic-1',
        title: 'Test Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
      };
      const result = checkPlanRails('Any plan', emptyRails, epic, null);
      expect(result.ok).toBe(true);
    });
  });

  describe('task rails (guidance only, not enforced)', () => {
    // Task rails are provided as guidance to AI agents but are not strictly enforced.
    // This allows agents to address the intent of rails without requiring verbatim quoting.
    // Humans verify compliance during plan approval.

    it('passes even when task rail text is not literally present', () => {
      const task: Task = {
        id: 'task-1',
        epicId: 'epic-1',
        title: 'Test Task',
        description: 'Desc',
        status: 'PLANNING',
        order: 1,
        createdAt: new Date().toISOString(),
        taskRails: ['no breaking changes'],
      };
      // Plan doesn't contain literal "no breaking changes" but that's OK
      const result = checkPlanRails('I will refactor everything', emptyRails, null, task);
      expect(result.ok).toBe(true);
    });

    it('passes when task rails are present (still valid)', () => {
      const task: Task = {
        id: 'task-1',
        epicId: 'epic-1',
        title: 'Test Task',
        description: 'Desc',
        status: 'PLANNING',
        order: 1,
        createdAt: new Date().toISOString(),
        taskRails: ['backward compatible'],
      };
      const result = checkPlanRails(
        'I will make backward compatible changes',
        emptyRails,
        null,
        task
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('combined rails', () => {
    it('enforces only forbidden and required patterns, not epic/task rails', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['rm -rf'],
        requiredPatterns: ['backup'],
      };
      const epic: Epic = {
        id: 'epic-1',
        title: 'Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
        epicRails: ['safe deployment'],
      };
      const task: Task = {
        id: 'task-1',
        epicId: 'epic-1',
        title: 'Task',
        description: 'Desc',
        status: 'PLANNING',
        order: 1,
        createdAt: new Date().toISOString(),
        taskRails: ['rollback plan'],
      };

      // Plan has required "backup" but doesn't have epic/task rail text
      // Should pass because epic/task rails are not enforced
      const result = checkPlanRails(
        'I will backup data before making changes',
        rails,
        epic,
        task
      );
      expect(result.ok).toBe(true);
    });

    it('fails on forbidden pattern even with epic/task rails present', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['dangerous'],
        requiredPatterns: ['safe'],
      };
      // Contains forbidden pattern - should fail
      const result = checkPlanRails('This is dangerous but safe', rails, null, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Forbidden pattern: dangerous');
    });

    it('fails on missing required pattern even if epic/task rails are satisfied', () => {
      const rails: GlobalRails = {
        requiredPatterns: ['backup'],
      };
      const epic: Epic = {
        id: 'epic-1',
        title: 'Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
        epicRails: ['safe'],
      };
      // Plan has epic rail text but missing required pattern
      const result = checkPlanRails('I will make it safe', rails, epic, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Required pattern missing: backup');
    });
  });
});

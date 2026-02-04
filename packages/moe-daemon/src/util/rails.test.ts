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

  describe('epic rails', () => {
    it('fails when epic rail is missing from plan', () => {
      const epic: Epic = {
        id: 'epic-1',
        title: 'Test Epic',
        description: 'Desc',
        status: 'ACTIVE',
        order: 1,
        createdAt: new Date().toISOString(),
        epicRails: ['must use typescript'],
      };
      const result = checkPlanRails('I will use javascript', emptyRails, epic, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Epic rail missing: must use typescript');
    });

    it('passes when all epic rails are present', () => {
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

  describe('task rails', () => {
    it('fails when task rail is missing from plan', () => {
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
      const result = checkPlanRails('I will refactor everything', emptyRails, null, task);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Task rail missing: no breaking changes');
    });

    it('passes when all task rails are present', () => {
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
    it('checks all rail types together', () => {
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

      const result = checkPlanRails(
        'I will backup data, ensure safe deployment, and prepare a rollback plan',
        rails,
        epic,
        task
      );
      expect(result.ok).toBe(true);
    });

    it('fails on first violation found', () => {
      const rails: GlobalRails = {
        forbiddenPatterns: ['dangerous'],
        requiredPatterns: ['safe'],
      };
      // Contains forbidden pattern - should fail on that first
      const result = checkPlanRails('This is dangerous but safe', rails, null, null);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe('Forbidden pattern: dangerous');
    });
  });
});

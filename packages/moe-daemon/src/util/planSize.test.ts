import { describe, it, expect } from 'vitest';
import {
  assessPlanSize,
  resolveTaskSizing,
  countDistinctAffectedFiles,
  WARN_STEPS_DEFAULT,
  MAX_STEPS_DEFAULT,
  WARN_DISTINCT_FILES_DEFAULT,
  MAX_DISTINCT_FILES_DEFAULT,
} from './planSize.js';

function steps(count: number, files: string[][] = []): { affectedFiles: string[] }[] {
  return Array.from({ length: count }, (_, i) => ({ affectedFiles: files[i] || [] }));
}

describe('resolveTaskSizing', () => {
  it('returns defaults when no settings provided', () => {
    expect(resolveTaskSizing()).toEqual({
      warnSteps: WARN_STEPS_DEFAULT,
      maxSteps: MAX_STEPS_DEFAULT,
      warnDistinctFiles: WARN_DISTINCT_FILES_DEFAULT,
      maxDistinctFiles: MAX_DISTINCT_FILES_DEFAULT,
    });
  });

  it('honors configured overrides', () => {
    const resolved = resolveTaskSizing({ warnSteps: 4, maxSteps: 6, warnDistinctFiles: 2, maxDistinctFiles: 3 });
    expect(resolved).toEqual({ warnSteps: 4, maxSteps: 6, warnDistinctFiles: 2, maxDistinctFiles: 3 });
  });

  it('lifts a max below its warn up to the warn value', () => {
    const resolved = resolveTaskSizing({ warnSteps: 10, maxSteps: 5 });
    expect(resolved.maxSteps).toBe(10);
  });

  it('ignores non-integer / non-positive values', () => {
    const resolved = resolveTaskSizing({ warnSteps: -1, maxSteps: 2.5, warnDistinctFiles: 0 });
    expect(resolved.warnSteps).toBe(WARN_STEPS_DEFAULT);
    expect(resolved.maxSteps).toBe(MAX_STEPS_DEFAULT);
    expect(resolved.warnDistinctFiles).toBe(WARN_DISTINCT_FILES_DEFAULT);
  });
});

describe('countDistinctAffectedFiles', () => {
  it('deduplicates across steps', () => {
    expect(countDistinctAffectedFiles([
      { affectedFiles: ['a.ts', 'b.ts'] },
      { affectedFiles: ['b.ts', 'c.ts'] },
      { affectedFiles: [] },
    ])).toBe(3);
  });
});

describe('assessPlanSize', () => {
  it('is quiet within bounds', () => {
    const result = assessPlanSize(steps(8, [['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']]));
    expect(result.warnings).toEqual([]);
    expect(result.violation).toBeUndefined();
    expect(result.stepCount).toBe(8);
    expect(result.distinctFileCount).toBe(5);
  });

  it('warns past warnSteps but under maxSteps', () => {
    const result = assessPlanSize(steps(9));
    expect(result.violation).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('9 steps');
  });

  it('warns past warnDistinctFiles but under maxDistinctFiles', () => {
    const result = assessPlanSize(steps(2, [['a', 'b', 'c'], ['d', 'e', 'f']]));
    expect(result.violation).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('6 distinct files');
  });

  it('flags a violation past maxSteps', () => {
    const result = assessPlanSize(steps(13));
    expect(result.violation).toContain('13 steps (max 12)');
    expect(result.warnings).toEqual([]);
  });

  it('flags a violation past maxDistinctFiles', () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const result = assessPlanSize(steps(1, [files]));
    expect(result.violation).toContain('11 distinct affected files (max 10)');
  });

  it('reports both dimensions in one violation', () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const result = assessPlanSize(steps(13, [files]));
    expect(result.violation).toContain('13 steps');
    expect(result.violation).toContain('11 distinct affected files');
  });

  it('respects settings.taskSizing overrides', () => {
    const result = assessPlanSize(steps(5), { taskSizing: { warnSteps: 3, maxSteps: 4 } });
    expect(result.violation).toContain('5 steps (max 4)');
  });
});

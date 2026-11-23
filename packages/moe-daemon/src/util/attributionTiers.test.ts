import { describe, it, expect } from 'vitest';
import {
  collectAssertedPaths,
  collectDeclaredPaths,
  collectPeerPaths,
  collectTaskPathTiers,
  completedStepFiles,
} from './attributionTiers.js';
import type { Task } from '../types/schema.js';

const asTask = (fields: Record<string, unknown>): Task => fields as unknown as Task;

const JUNK: [string, unknown][] = [
  ['a number', 7],
  ['an object', { a: 1 }],
  ['a string', 'src/str.ts'],
];

const STEP_FIELDS = ['affectedFiles', 'newFiles', 'modifiedFiles'] as const;
const TASK_FIELDS = ['filesModified', 'declaredFiles', 'touchedFiles', 'inferredPaths'] as const;

describe('attributionTiers junk tolerance', () => {
  describe('pending step lists', () => {
    const cases = STEP_FIELDS.flatMap((field) => JUNK.map(([label, value]) => [field, label, value] as const));

    it.each(cases)('%s as %s contributes nothing and keeps the valid siblings', (field, _label, value) => {
      const step: Record<string, unknown> = {
        stepId: 's1', description: 'd', status: 'PENDING',
        affectedFiles: ['ok/a.ts'], newFiles: ['ok/n.ts'], modifiedFiles: ['ok/m.ts'],
      };
      step[field] = value;
      const task = asTask({ implementationPlan: [step] });

      expect(() => collectTaskPathTiers(task)).not.toThrow();
      const expected = STEP_FIELDS.filter((f) => f !== field).map((f) => (
        { affectedFiles: 'ok/a.ts', newFiles: 'ok/n.ts', modifiedFiles: 'ok/m.ts' }[f]
      ));
      const { planned, asserted } = collectTaskPathTiers(task);
      expect(planned.slice().sort()).toEqual(expected.slice().sort());
      expect(asserted).toEqual([]);
      for (const single of ['s', 'r', 'c', 't', '.', '/']) expect(planned).not.toContain(single);
    });
  });

  describe('completed step mirror of completeTask.ts', () => {
    const step = (fields: Record<string, unknown>) =>
      asTask({ implementationPlan: [{ stepId: 's1', description: 'd', status: 'COMPLETED', ...fields }] });

    it.each(JUNK)('junk modifiedFiles (%s) is selected and contributes nothing, with no affectedFiles fallback', (_l, value) => {
      const task = step({ modifiedFiles: value, affectedFiles: ['ok/b.ts'] });
      expect(() => collectAssertedPaths(task)).not.toThrow();
      expect(completedStepFiles(task)).toEqual([]);
      expect(collectAssertedPaths(task)).toEqual([]);
    });

    it.each(JUNK)('absent modifiedFiles with junk affectedFiles (%s) contributes nothing', (_l, value) => {
      const task = step({ affectedFiles: value });
      expect(() => collectAssertedPaths(task)).not.toThrow();
      expect(collectAssertedPaths(task)).toEqual([]);
    });

    it('valid modifiedFiles contributes exactly its entries', () => {
      const task = step({ modifiedFiles: ['ok/m1.ts', 'ok/m2.ts'], affectedFiles: ['ok/ignored.ts'] });
      expect(collectAssertedPaths(task)).toEqual(['ok/m1.ts', 'ok/m2.ts']);
    });

    it('falls back to affectedFiles when modifiedFiles is absent', () => {
      expect(collectAssertedPaths(step({ affectedFiles: ['ok/a.ts'] }))).toEqual(['ok/a.ts']);
    });
  });

  describe('task-level lists', () => {
    const cases = TASK_FIELDS.flatMap((field) => [...JUNK, ['abc', 'abc'] as [string, unknown]].map(
      ([label, value]) => [field, label, value] as const
    ));

    it.each(cases)('%s as %s contributes nothing and does not throw', (field, _label, value) => {
      const task = asTask({ [field]: value });
      expect(() => collectTaskPathTiers(task)).not.toThrow();
      expect(() => collectPeerPaths(task)).not.toThrow();
      expect(collectTaskPathTiers(task)).toEqual({ asserted: [], planned: [] });
      expect(collectPeerPaths(task)).toEqual([]);
    });

    it.each(JUNK)('collectDeclaredPaths returns [] for declaredFiles as %s', (_l, value) => {
      expect(collectDeclaredPaths(asTask({ declaredFiles: value }) as Pick<Task, 'declaredFiles'>)).toEqual([]);
    });

    it('keeps valid entries next to the junk lists', () => {
      const task = asTask({ declaredFiles: ['ok/d.ts'], filesModified: 7, touchedFiles: { a: 1 }, inferredPaths: 'ok/i.ts' });
      expect(collectTaskPathTiers(task)).toEqual({ asserted: ['ok/d.ts'], planned: [] });
    });
  });

  describe('commits', () => {
    it.each(JUNK)('a non-array commits value (%s) contributes nothing', (_l, value) => {
      const task = asTask({ commits: value });
      expect(() => collectAssertedPaths(task)).not.toThrow();
      expect(collectAssertedPaths(task)).toEqual([]);
    });

    it('skips non-object commits and junk path lists, keeping the valid commit', () => {
      const task = asTask({
        commits: [7, null, { paths: 'p.ts' }, { paths: ['ok/c.ts'], inferredPaths: 'ok/c.ts' }],
      });
      expect(() => collectAssertedPaths(task)).not.toThrow();
      expect(collectAssertedPaths(task)).toEqual(['ok/c.ts']);
    });

    it('still removes the paths a commit attributed by measurement only', () => {
      const task = asTask({ commits: [{ paths: ['ok/a.ts', 'ok/b.ts'], inferredPaths: ['ok/b.ts'] }] });
      expect(collectAssertedPaths(task)).toEqual(['ok/a.ts']);
    });
  });

  describe('plan shape', () => {
    it('skips non-object steps and keeps the valid one', () => {
      const task = asTask({
        implementationPlan: [null, 7, 'step', { status: 'COMPLETED', affectedFiles: ['ok/d.ts'] }],
      });
      expect(() => collectTaskPathTiers(task)).not.toThrow();
      expect(collectAssertedPaths(task)).toEqual(['ok/d.ts']);
      expect(collectTaskPathTiers(task)).toEqual({ asserted: ['ok/d.ts'], planned: [] });
    });

    it.each(JUNK)('a non-array implementationPlan (%s) contributes nothing', (_l, value) => {
      const task = asTask({ implementationPlan: value, declaredFiles: ['ok/x.ts'] });
      expect(() => collectTaskPathTiers(task)).not.toThrow();
      expect(collectTaskPathTiers(task)).toEqual({ asserted: ['ok/x.ts'], planned: [] });
    });
  });

  it('control: a well-formed task yields the exact asserted and planned tiers', () => {
    const task = asTask({
      implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/plan-a.ts'], modifiedFiles: ['./src/a.ts'] },
        { stepId: 's2', description: 'b', status: 'COMPLETED', affectedFiles: ['src\\b.ts'], newFiles: ['src/new-b.ts'] },
        { stepId: 's3', description: 'c', status: 'PENDING', affectedFiles: ['src/c.ts'], newFiles: ['src/new-c.ts'], modifiedFiles: ['src/c-mod.ts'] },
      ],
      filesModified: ['src/fm.ts'],
      declaredFiles: ['src/decl.ts'],
      touchedFiles: ['src/touched.ts'],
      inferredPaths: ['src/measured.ts'],
      commits: [{ paths: ['src/committed.ts', 'src/measured.ts'], inferredPaths: ['src/measured.ts'] }],
    });
    expect(collectTaskPathTiers(task)).toEqual({
      asserted: ['src/a.ts', 'src/b.ts', 'src/fm.ts', 'src/decl.ts', 'src/touched.ts', 'src/committed.ts'],
      planned: ['src/plan-a.ts', 'src/new-b.ts', 'src/c.ts', 'src/new-c.ts', 'src/c-mod.ts', 'src/measured.ts'],
    });
  });
});

describe('attributionTiers board state', () => {
  // A landing carries other tasks' records (the wrapper's BOARD tier) and
  // record_commit stores them in commits[].paths and filesModified. Kept in the
  // tiers, a peer's record read as contested and complete_task told the seat to
  // edit daemon-written state (2026-11-22).
  const BOARD = ['.moe/tasks/task-peer.json', '.moe/tasks/task-own.json', '.moe/epics/epic-1.json', '.moe/project.json'];

  it('drops every .moe/ path from the asserted, planned and declared tiers and keeps the source paths', () => {
    const task = asTask({
      id: 'task-own',
      implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/done.ts', ...BOARD] },
        { stepId: 's2', description: 'b', status: 'PENDING', affectedFiles: ['src/next.ts', ...BOARD], newFiles: ['src/new.ts', ...BOARD] },
      ],
      filesModified: ['src/fm.ts', ...BOARD],
      // Worker-typed spellings are judged after normalization.
      declaredFiles: ['src/decl.ts', ...BOARD, './.moe/tasks/task-peer.json', '.moe\\project.json'],
      touchedFiles: ['src/touched.ts', ...BOARD],
      inferredPaths: ['src/measured.ts', ...BOARD],
      // A nested .moe/ directory and a root name that merely starts with .moe are not the board.
      commits: [{ paths: ['src/committed.ts', ...BOARD, 'src/.moe/fixture.json', '.moerc.json'] }],
    });
    const asserted = ['src/done.ts', 'src/fm.ts', 'src/decl.ts', 'src/touched.ts', 'src/committed.ts', 'src/.moe/fixture.json', '.moerc.json'];
    const planned = ['src/next.ts', 'src/new.ts', 'src/measured.ts'];

    expect(collectAssertedPaths(task)).toEqual(asserted);
    expect(collectTaskPathTiers(task)).toEqual({ asserted, planned });
    expect(collectDeclaredPaths(task)).toEqual(['src/decl.ts']);
    expect(collectPeerPaths(task)).toEqual([...asserted, ...planned]);
  });
});

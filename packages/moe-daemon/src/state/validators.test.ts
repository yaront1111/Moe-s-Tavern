import { describe, it, expect } from 'vitest';
import { MAX_COMMITS_PER_TASK, MAX_EPIC_RAIL_CHARS, sanitizeImplementationPlan, sanitizeStepAmendments, trimCommits, validateEpicUpdates, validateSettingsUpdate, validateStringArrayValue } from './validators.js';
import { MAX_STEP_DESCRIPTION_CHARS, MAX_STEP_NOTE_CHARS } from '../util/planSize.js';
import type { Project, TaskCommit } from '../types/schema.js';
import { resolveAttemptWorkspace, resolveWorktreeMode, resolveWorktreeTarget } from './validators.js';
import { MoeErrorCode } from '../util/errors.js';

function project(settingsOverrides: Record<string, unknown> = {}): Project {
  return {
    id: 'proj-test',
    schemaVersion: 6,
    name: 'Test',
    rootPath: 'D:/tmp/proj',
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: {
      approvalMode: 'CONTROL',
      speedModeDelayMs: 2000,
      autoCreateBranch: true,
      branchPattern: 'moe/{epicId}/{taskId}',
      commitPattern: 'feat({epicId}): {taskTitle}',
      agentCommand: 'claude',
      enableAgentTeams: false,
      ...settingsOverrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('worktree mode', () => {
  it.each(['off', 'on'] as const)('accepts %s unchanged', (worktreeMode) => {
    expect(validateSettingsUpdate(project(), { worktreeMode })).toEqual({ ...project().settings, worktreeMode });
    expect(resolveWorktreeMode({ worktreeMode })).toEqual(worktreeMode);
  });

  it('leaves an omitted setting absent on unrelated updates', () => {
    expect(validateSettingsUpdate(project(), { autoCommit: false })).toEqual({ ...project().settings, autoCommit: false });
  });

  it.each(['yes', 'ON', ' on', '', true, 1, null, {}])('rejects invalid mode %j', (worktreeMode) => {
    expect(() => validateSettingsUpdate(project(), { worktreeMode } as never))
      .toThrow(/worktreeMode.*must be one of: off, on/);
    expect(() => resolveWorktreeMode({ worktreeMode }))
      .toThrow(expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT, message: expect.stringContaining('worktreeMode') }));
  });

  it.each([undefined, null, {}])('defaults absent settings %j to off', (settings) => {
    expect(resolveWorktreeMode(settings)).toEqual('off');
  });

  it.each([
    ['main', 'main'], ['moe/work-2026-10-24', 'moe/work-2026-10-24'], ['  release/v2  ', 'release/v2'],
    ['moe/work-*', 'main'], ['rel?ase', 'main'], ['feat[0-9]', 'main'], ['', 'main'], ['   ', 'main'],
    [undefined, 'main'], [42, 'main'], [null, 'main'], [[], 'main'], [{}, 'main'],
  ])('resolves target %j to %s', (consolidationBranch, expected) => {
    expect(resolveWorktreeTarget({ consolidationBranch })).toEqual(expected);
  });

  it.each([undefined, null, 42, [], {}])('tolerates malformed or absent settings %j', (settings) => {
    expect(resolveWorktreeTarget(settings as never)).toEqual('main');
    expect(resolveAttemptWorkspace({ taskId: 'task-1', workspace: '/work', workspaceMode: 'worktree' }, settings as never))
      .toEqual({ mode: 'worktree', path: '/work', branch: 'moe/task/task-1', target: 'main' });
  });

  it('uses pinned worktree identity and the live target', () => {
    expect(resolveAttemptWorkspace({ taskId: 'task-1', workspace: '/work', workspaceMode: 'worktree' },
      { consolidationBranch: '  release/v2  ' }))
      .toEqual({ mode: 'worktree', path: '/work', branch: 'moe/task/task-1', target: 'release/v2' });
  });

  it.each(['shared', undefined, 'bogus'])('reads mode %j as shared', (workspaceMode) => {
    const attempt = { taskId: 'task-1', workspace: '/control', ...(workspaceMode === undefined ? {} : { workspaceMode }) };
    expect(resolveAttemptWorkspace(attempt as never, { consolidationBranch: 'release/v2' }))
      .toEqual({ mode: 'shared', path: '/control', branch: null, target: null });
  });
});

describe('validateSettingsUpdate — wrapper landing settings', () => {
  it('accepts the boolean landing switches and stores them as supplied', () => {
    const next = validateSettingsUpdate(project(), {
      checkpointCommits: false,
      checkpointPush: false,
      commitBoardState: false,
      commitHooks: true,
    });
    expect(next.checkpointCommits).toBe(false);
    expect(next.checkpointPush).toBe(false);
    expect(next.commitBoardState).toBe(false);
    expect(next.commitHooks).toBe(true);
    // Untouched keys stay omitted (absence = default).
    expect(next.attribution).toBeUndefined();
    expect(next.autoCommit).toBeUndefined();
  });

  it('rejects non-boolean values for the landing switches', () => {
    for (const key of ['checkpointCommits', 'checkpointPush', 'commitBoardState', 'commitHooks'] as const) {
      expect(() => validateSettingsUpdate(project(), { [key]: 'yes' } as never)).toThrow(key);
      expect(() => validateSettingsUpdate(project(), { [key]: 1 } as never)).toThrow('must be a boolean');
    }
  });

  it('validates attribution.undeclared / contested enums and normalizes attribution.exclude', () => {
    const next = validateSettingsUpdate(project(), {
      attribution: { undeclared: 'never', contested: 'skip', exclude: ['./vendor/', 'build\\out', 'docs/generated'] },
    });
    expect(next.attribution).toEqual({
      undeclared: 'never',
      contested: 'skip',
      exclude: ['vendor', 'build/out', 'docs/generated'],
    });
  });

  it('merges attribution keys with the stored block instead of replacing it', () => {
    const stored = project({ attribution: { undeclared: 'always', exclude: ['vendor'] } });
    const next = validateSettingsUpdate(stored, { attribution: { contested: 'skip' } });
    expect(next.attribution).toEqual({ undeclared: 'always', exclude: ['vendor'], contested: 'skip' });
    // An explicit [] clears the extra exclusions.
    const cleared = validateSettingsUpdate(stored, { attribution: { exclude: [] } });
    expect(cleared.attribution?.exclude).toEqual([]);
  });

  it('accepts skip-untouched without discarding other attribution settings', () => {
    const stored = project({ attribution: { undeclared: 'never', exclude: ['vendor'] } });
    const next = validateSettingsUpdate(stored, { attribution: { contested: 'skip-untouched' } });
    expect(next.attribution).toEqual({ undeclared: 'never', exclude: ['vendor'], contested: 'skip-untouched' });
  });

  it('rejects bad attribution values before anything is returned', () => {
    expect(() => validateSettingsUpdate(project(), { attribution: { undeclared: 'sometimes' } as never })).toThrow('attribution.undeclared');
    expect(() => validateSettingsUpdate(project(), { attribution: { contested: 'merge' } as never })).toThrow('attribution.contested');
    expect(() => validateSettingsUpdate(project(), { attribution: { exclude: ['/abs/path'] } })).toThrow('project-relative');
    expect(() => validateSettingsUpdate(project(), { attribution: { exclude: ['../escape'] } })).toThrow('traversal');
    expect(() => validateSettingsUpdate(project(), { attribution: { exclude: 'vendor' } as never })).toThrow('attribution.exclude');
    expect(() => validateSettingsUpdate(project(), { attribution: { exclude: [''] } })).toThrow('attribution.exclude[0]');
    expect(() => validateSettingsUpdate(project(), { attribution: { bogus: true } as never })).toThrow('bogus');
    expect(() => validateSettingsUpdate(project(), { attribution: 'solo' } as never)).toThrow('must be an object');
  });

  it('still rejects the deferred (unimplemented) sweep settings as unsupported', () => {
    expect(() => validateSettingsUpdate(project(), { parkUnassignedBlocked: true } as never)).toThrow('parkUnassignedBlocked');
    expect(() => validateSettingsUpdate(project(), { recoverOrphanBaselines: true } as never)).toThrow('recoverOrphanBaselines');
  });

  it('accepts taskSizing.maxTasksPerEpic as a bounded integer and rejects garbage', () => {
    const next = validateSettingsUpdate(project(), { taskSizing: { maxTasksPerEpic: 25 } });
    expect(next.taskSizing?.maxTasksPerEpic).toBe(25);
    // Merges with the stored taskSizing block instead of replacing it.
    const stored = project({ taskSizing: { warnSteps: 6 } });
    const merged = validateSettingsUpdate(stored, { taskSizing: { maxTasksPerEpic: 30 } });
    expect(merged.taskSizing).toEqual({ warnSteps: 6, maxTasksPerEpic: 30 });

    expect(() => validateSettingsUpdate(project(), { taskSizing: { maxTasksPerEpic: 0 } })).toThrow('maxTasksPerEpic');
    expect(() => validateSettingsUpdate(project(), { taskSizing: { maxTasksPerEpic: 1001 } })).toThrow('maxTasksPerEpic');
    expect(() => validateSettingsUpdate(project(), { taskSizing: { maxTasksPerEpic: 'lots' } as never })).toThrow('maxTasksPerEpic');
  });
});

describe('trimCommits', () => {
  const commit = (i: number): TaskCommit => ({
    sha: `${i}`.padStart(7, '0'),
    ref: 'moe/work-x',
    kind: 'checkpoint',
    role: 'worker',
    sessionId: 's',
    paths: [],
    recordedBy: 'w',
    recordedAt: new Date(i).toISOString(),
  });

  it('keeps the newest MAX_COMMITS_PER_TASK entries and tolerates non-arrays', () => {
    expect(MAX_COMMITS_PER_TASK).toBeGreaterThan(0);
    expect(trimCommits(undefined)).toEqual([]);
    expect(trimCommits(null)).toEqual([]);
    const under = Array.from({ length: MAX_COMMITS_PER_TASK }, (_, i) => commit(i));
    expect(trimCommits(under)).toBe(under);
    const over = Array.from({ length: MAX_COMMITS_PER_TASK + 3 }, (_, i) => commit(i));
    const trimmed = trimCommits(over);
    expect(trimmed).toHaveLength(MAX_COMMITS_PER_TASK);
    expect(trimmed[0].sha).toBe(commit(3).sha);
    expect(trimmed[trimmed.length - 1].sha).toBe(commit(MAX_COMMITS_PER_TASK + 2).sha);
  });
});

describe('sanitizeImplementationPlan — bounds equal the tool caps', () => {
  // Observed defect: submit_plan accepted a 10000-char step, the sanitizer
  // sliced it to 5000 on the next write, and the worker read the approved
  // harness text cut mid-sentence at exactly 5000 chars.
  it('keeps a step description and note of the accepted maximum intact', () => {
    const description = 'd'.repeat(MAX_STEP_DESCRIPTION_CHARS);
    const note = 'n'.repeat(MAX_STEP_NOTE_CHARS);
    const [step] = sanitizeImplementationPlan([{ stepId: 'step-1', description, status: 'PENDING', affectedFiles: [], note }]);
    expect(step.description).toBe(description);
    expect(step.note).toBe(note);
    expect(MAX_STEP_DESCRIPTION_CHARS).toBeGreaterThan(5000);
  });

  it('bounds oversized text at the same cap the tools refuse above', () => {
    const [step] = sanitizeImplementationPlan([{ stepId: 'step-1', description: 'd'.repeat(MAX_STEP_DESCRIPTION_CHARS + 7), status: 'PENDING', affectedFiles: [], note: 'n'.repeat(MAX_STEP_NOTE_CHARS + 7) }]);
    expect(step.description.length).toBe(MAX_STEP_DESCRIPTION_CHARS);
    expect(step.note?.length).toBe(MAX_STEP_NOTE_CHARS);
  });

  it('keeps an amendment of the accepted maximum intact', () => {
    const description = 'a'.repeat(MAX_STEP_DESCRIPTION_CHARS);
    const [amendment] = sanitizeStepAmendments([{ amendmentId: 'amend-1', description, reason: 'r', amendedBy: 'architect-1', amendedAt: '2026-10-01T00:00:00.000Z' }]);
    expect(amendment.description).toBe(description);
  });
});


describe('validateSettingsUpdate — execution profile foundation', () => {
  it.each(['legacy', 'observe'] as const)('accepts %s without relaxing an existing strict deliveryPolicy', executionProfile => {
    const original = project({ deliveryPolicy: 'remote-push', qualityGate: 'npm test' });
    const next = validateSettingsUpdate(original, { executionProfile } as never);
    expect(next).toMatchObject({ executionProfile, deliveryPolicy: 'remote-push', qualityGate: 'npm test' });
    expect(original.settings).not.toHaveProperty('executionProfile');
  });

  it('keeps an omitted profile absent and preserves observe on unrelated updates', () => {
    expect(validateSettingsUpdate(project({ deliveryPolicy: 'local-branch' }), {})).not.toHaveProperty('executionProfile');
    expect(validateSettingsUpdate(project({ executionProfile: 'observe', deliveryPolicy: 'local-branch' }), { agentCommand: 'codex' }))
      .toMatchObject({ executionProfile: 'observe', deliveryPolicy: 'local-branch', agentCommand: 'codex' });
  });

  it.each([null, '', 'verified', 'VERIFIED-LOCAL', ' verified-local ', false, 1, [], {}].map(value => [value]))('refuses malformed profile %j', value => {
    expect(() => validateSettingsUpdate(project(), { executionProfile: value } as never)).toThrow('must be one of: legacy, observe, verified-local');
  });

  it('refuses verified-local before returning settings for persistence', () => {
    const original = project({ deliveryPolicy: 'remote-push' });
    expect(() => validateSettingsUpdate(original, { executionProfile: 'verified-local', agentCommand: 'codex' } as never))
      .toThrowError(expect.objectContaining({ codeName: 'EXECUTION_PROFILE_NOT_READY', code: -32003 }));
    expect(original.settings).toMatchObject({ deliveryPolicy: 'remote-push', agentCommand: 'claude' });
    expect(original.settings).not.toHaveProperty('executionProfile');
  });

  it('does not silently persist an already stored unavailable profile on an unrelated update', () => {
    expect(() => validateSettingsUpdate(project({ executionProfile: 'verified-local' }), { agentCommand: 'codex' }))
      .toThrowError(expect.objectContaining({ codeName: 'EXECUTION_PROFILE_NOT_READY' }));
  });

  it('permits an explicit project rollback without rewriting existing policy', () => {
    expect(validateSettingsUpdate(project({ executionProfile: 'verified-local', deliveryPolicy: 'local-branch' }), { executionProfile: 'observe' } as never))
      .toMatchObject({ executionProfile: 'observe', deliveryPolicy: 'local-branch' });
  });

  it.each(['ready', 'executionProfileReady', 'capabilities', 'executionPolicySnapshot'])('refuses caller readiness/policy injection through %s', key => {
    expect(() => validateSettingsUpdate(project(), { executionProfile: 'observe', [key]: true } as never))
      .toThrow('is not a supported project setting field');
  });
});

describe('validateStringArrayValue — truncate option', () => {
  it('still shortens an over-long entry by default (settings arrays keep their old behavior)', () => {
    expect(validateStringArrayValue(['a'.repeat(600)], 'appendOnlyFiles', 100, 500)).toEqual(['a'.repeat(500)]);
    const next = validateSettingsUpdate(project(), { attribution: { exclude: ['b'.repeat(600)] } });
    expect(next.attribution?.exclude).toEqual(['b'.repeat(500)]);
  });

  it('refuses instead of shortening when truncate is false, with the entry named', () => {
    expect(() => validateStringArrayValue(['ok', 'a'.repeat(501)], 'rails', 100, 500, false)).toThrow(/rails\[1\].*500 characters or fewer/);
    expect(validateStringArrayValue(['a'.repeat(500)], 'rails', 100, 500, false)).toEqual(['a'.repeat(500)]);
  });

  it('epicRails uses the strict cap while other epic text fields keep truncating', () => {
    expect(() => validateEpicUpdates({ epicRails: ['x'.repeat(MAX_EPIC_RAIL_CHARS + 1)] })).toThrow(/epicRails\[0\]/);
    expect(validateEpicUpdates({ title: 't'.repeat(600), epicRails: ['x'.repeat(MAX_EPIC_RAIL_CHARS)] }))
      .toMatchObject({ title: 't'.repeat(500), epicRails: ['x'.repeat(MAX_EPIC_RAIL_CHARS)] });
  });
});

import { describe, it, expect } from 'vitest';
import { MAX_COMMITS_PER_TASK, trimCommits, validateSettingsUpdate } from './validators.js';
import type { Project, TaskCommit } from '../types/schema.js';

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

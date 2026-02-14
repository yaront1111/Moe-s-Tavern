// =============================================================================
// Migration Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { runMigrations } from './index.js';
import { v1ToV2 } from './v1_to_v2.js';
import { v3ToV4 } from './v3_to_v4.js';
import { CURRENT_SCHEMA_VERSION } from '../types/schema.js';

describe('Schema Migrations', () => {
  describe('v1 to v2 migration', () => {
    it('should add schemaVersion field to project without one', () => {
      const v1Project = {
        id: 'proj-test',
        name: 'Test Project',
        rootPath: '/test',
        globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
        settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: true, branchPattern: '', commitPattern: '' }
        // No schemaVersion field
      };

      const result = v1ToV2.migrate(v1Project);

      expect(result.schemaVersion).toBe(2);
      expect(result.id).toBe('proj-test');
      expect(result.name).toBe('Test Project');
    });

    it('should preserve all existing fields', () => {
      const v1Project = {
        id: 'proj-123',
        name: 'My Project',
        rootPath: '/path/to/project',
        globalRails: {
          techStack: ['TypeScript', 'Node'],
          forbiddenPatterns: ['console.log'],
          requiredPatterns: [],
          formatting: 'prettier',
          testing: 'vitest',
          customRules: ['Rule 1']
        },
        settings: {
          approvalMode: 'SPEED',
          speedModeDelayMs: 5000,
          autoCreateBranch: false,
          branchPattern: 'feature/{taskId}',
          commitPattern: 'fix: {title}'
        },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z'
      };

      const result = v1ToV2.migrate(v1Project);

      expect(result.schemaVersion).toBe(2);
      expect(result.globalRails).toEqual(v1Project.globalRails);
      expect(result.settings).toEqual(v1Project.settings);
      expect(result.createdAt).toBe(v1Project.createdAt);
    });
  });

  describe('v3 to v4 migration', () => {
    it('should add empty columnLimits', () => {
      const v3Project = {
        id: 'proj-test',
        name: 'Test Project',
        schemaVersion: 3,
        settings: {
          approvalMode: 'CONTROL',
          speedModeDelayMs: 2000,
          autoCreateBranch: true,
          branchPattern: '',
          commitPattern: '',
          agentCommand: 'claude'
        }
      };

      const result = v3ToV4.migrate(v3Project);

      expect(result.schemaVersion).toBe(4);
      const settings = result.settings as Record<string, unknown>;
      expect(settings.columnLimits).toEqual({});
    });

    it('should preserve all existing settings fields', () => {
      const v3Project = {
        id: 'proj-123',
        name: 'My Project',
        schemaVersion: 3,
        settings: {
          approvalMode: 'SPEED',
          speedModeDelayMs: 5000,
          autoCreateBranch: false,
          branchPattern: 'feature/{taskId}',
          commitPattern: 'fix: {title}',
          agentCommand: 'codex'
        }
      };

      const result = v3ToV4.migrate(v3Project);

      expect(result.schemaVersion).toBe(4);
      const settings = result.settings as Record<string, unknown>;
      expect(settings.approvalMode).toBe('SPEED');
      expect(settings.speedModeDelayMs).toBe(5000);
      expect(settings.autoCreateBranch).toBe(false);
      expect(settings.agentCommand).toBe('codex');
      expect(settings.columnLimits).toEqual({});
    });
  });

  describe('runMigrations', () => {
    it('should migrate v1 project to current version', () => {
      const v1Project = {
        id: 'proj-old',
        name: 'Old Project'
      };

      const { data, result } = runMigrations(v1Project);

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(1);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.migrationsApplied).toContain('Add schemaVersion field to project.json');
      expect(result.migrationsApplied).toContain('Add teams support');
      expect(result.migrationsApplied).toContain('Add columnLimits to project settings');
      expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should skip migrations for current version projects', () => {
      const currentProject = {
        id: 'proj-new',
        name: 'New Project',
        schemaVersion: CURRENT_SCHEMA_VERSION
      };

      const { data, result } = runMigrations(currentProject);

      expect(result.success).toBe(true);
      expect(result.migrationsApplied).toHaveLength(0);
      expect(data).toEqual(currentProject);
    });

    it('should be idempotent - running twice produces same result', () => {
      const v1Project = {
        id: 'proj-idem',
        name: 'Idempotent Test'
      };

      const { data: firstRun } = runMigrations(v1Project);
      const { data: secondRun, result } = runMigrations(firstRun);

      expect(secondRun).toEqual(firstRun);
      expect(result.migrationsApplied).toHaveLength(0);
    });
  });
});

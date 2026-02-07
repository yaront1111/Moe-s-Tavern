// =============================================================================
// Migration Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { runMigrations } from './index.js';
import { v1ToV2 } from './v1_to_v2.js';
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

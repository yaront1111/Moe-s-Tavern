// =============================================================================
// Migration: v1 -> v2
// Adds schemaVersion field to project.json
// =============================================================================

import type { Migration } from './types.js';

export const v1ToV2: Migration = {
  fromVersion: 1,
  toVersion: 2,
  description: 'Add schemaVersion field to project.json',
  migrate: (projectData: Record<string, unknown>): Record<string, unknown> => {
    return {
      ...projectData,
      schemaVersion: 2
    };
  }
};

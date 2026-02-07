// =============================================================================
// Migration: v2 -> v3
// Adds teams support (schema version bump only; worker backfill in StateManager)
// =============================================================================

import type { Migration } from './types.js';

export const v2ToV3: Migration = {
  fromVersion: 2,
  toVersion: 3,
  description: 'Add teams support',
  migrate: (projectData: Record<string, unknown>): Record<string, unknown> => {
    return {
      ...projectData,
      schemaVersion: 3
    };
  }
};

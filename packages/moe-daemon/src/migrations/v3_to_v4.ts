// =============================================================================
// Migration: v3 -> v4
// Adds columnLimits to project settings
// =============================================================================

import type { Migration } from './types.js';

export const v3ToV4: Migration = {
  fromVersion: 3,
  toVersion: 4,
  description: 'Add columnLimits to project settings',
  migrate: (projectData: Record<string, unknown>): Record<string, unknown> => {
    const settings = (projectData.settings || {}) as Record<string, unknown>;
    return {
      ...projectData,
      schemaVersion: 4,
      settings: {
        ...settings,
        columnLimits: settings.columnLimits || {}
      }
    };
  }
};

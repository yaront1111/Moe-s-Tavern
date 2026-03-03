// =============================================================================
// Migration: v5 -> v6
// Removes chatAutoCreateChannels setting (replaced by role-based channels)
// =============================================================================

import type { Migration } from './types.js';

export const v5ToV6: Migration = {
  fromVersion: 5,
  toVersion: 6,
  description: 'Replace per-task/epic auto-channels with role-based channels',
  migrate: (projectData: Record<string, unknown>): Record<string, unknown> => {
    const settings = (projectData.settings || {}) as Record<string, unknown>;
    const { chatAutoCreateChannels: _removed, ...restSettings } = settings;
    return {
      ...projectData,
      schemaVersion: 6,
      settings: restSettings
    };
  }
};

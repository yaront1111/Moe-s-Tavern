// =============================================================================
// Migration: v4 -> v5
// Adds chat channels and messages support
// =============================================================================

import type { Migration } from './types.js';

export const v4ToV5: Migration = {
  fromVersion: 4,
  toVersion: 5,
  description: 'Add chat channels and messages',
  migrate: (projectData: Record<string, unknown>): Record<string, unknown> => {
    const settings = (projectData.settings || {}) as Record<string, unknown>;
    return {
      ...projectData,
      schemaVersion: 5,
      settings: {
        ...settings,
        chatEnabled: settings.chatEnabled ?? true,
        chatMaxAgentHops: settings.chatMaxAgentHops ?? 4,
        chatAutoCreateChannels: settings.chatAutoCreateChannels ?? true
      }
    };
  }
};

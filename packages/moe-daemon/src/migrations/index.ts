// =============================================================================
// Migration Runner
// =============================================================================

import type { Migration, MigrationResult } from './types.js';
import { v1ToV2 } from './v1_to_v2.js';
import { v2ToV3 } from './v2_to_v3.js';
import { logger } from '../util/logger.js';
import { CURRENT_SCHEMA_VERSION } from '../types/schema.js';

// Register all migrations in order
const migrations: Migration[] = [
  v1ToV2,
  v2ToV3
];

/**
 * Run all necessary migrations to bring project data to current schema version.
 * Returns the migrated data and migration result.
 */
export function runMigrations(
  projectData: Record<string, unknown>
): { data: Record<string, unknown>; result: MigrationResult } {
  const currentVersion = (projectData.schemaVersion as number) || 1;
  const migrationsApplied: string[] = [];
  let data = { ...projectData };

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return {
      data,
      result: {
        success: true,
        fromVersion: currentVersion,
        toVersion: currentVersion,
        migrationsApplied: []
      }
    };
  }

  logger.info({ from: currentVersion, to: CURRENT_SCHEMA_VERSION }, 'Running schema migrations');

  try {
    for (const migration of migrations) {
      const dataVersion = (data.schemaVersion as number) || 1;
      if (dataVersion === migration.fromVersion) {
        logger.info({ migration: migration.description }, 'Applying migration');
        data = migration.migrate(data);
        migrationsApplied.push(migration.description);
      }
    }

    return {
      data,
      result: {
        success: true,
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsApplied
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error }, 'Migration failed');
    return {
      data: projectData, // Return original data on failure
      result: {
        success: false,
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsApplied,
        error: errorMessage
      }
    };
  }
}

export { type Migration, type MigrationResult } from './types.js';

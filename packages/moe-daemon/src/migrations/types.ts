// =============================================================================
// Migration Types
// =============================================================================

export interface Migration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (projectData: Record<string, unknown>) => Record<string, unknown>;
}

export interface MigrationResult {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  migrationsApplied: string[];
  error?: string;
}

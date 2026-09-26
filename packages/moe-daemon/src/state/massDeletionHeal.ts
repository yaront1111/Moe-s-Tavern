// =============================================================================
// Mass-deletion self-heal for the .moe store
// =============================================================================
//
// The .moe store is gitignored and lives inside the project's working tree, so a
// repo-wide `git clean -fdx`, a sparse-checkout or an `rm -rf` deletes it while
// the daemon still holds every entity in memory. The FileWatcher then reloads
// from disk and replaces the board with an empty one. px4swarm lost its whole
// board that way twice (2026-09-25 sparse-checkout, 2026-09-26 `git clean -qfdx`).
//
// When many known entities vanish at once, the disk is the casualty, not the
// truth: write them back from memory and skip the reload. A small deletion (a
// deliberate hand edit of one or two files) still reloads exactly as before.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import { logger } from '../util/logger.js';

/** A deletion this small is treated as a deliberate edit and reloaded as before. */
export const MASS_DELETION_MIN = 3;
/** ...and so is any deletion below this fraction of the known entities. */
export const MASS_DELETION_FRACTION = 0.2;

const KINDS = ['tasks', 'epics', 'teams', 'workers', 'proposals'] as const;

/**
 * Re-persists every in-memory entity whose file is missing, when the missing
 * set is large enough to be a wipe. Returns the number rewritten; 0 means
 * "not a wipe", and the caller should reload from disk as usual.
 */
export async function healMassDeletion(state: StateManager): Promise<number> {
  return state.mutex.runExclusive(async () => {
    const missing: Array<[string, string, unknown]> = [];
    let known = 0;
    for (const kind of KINDS) {
      for (const [id, entity] of state[kind] as Map<string, unknown>) {
        known++;
        if (!fs.existsSync(path.join(state.moePath, kind, `${id}.json`))) missing.push([kind, id, entity]);
      }
    }
    if (missing.length < MASS_DELETION_MIN || missing.length < known * MASS_DELETION_FRACTION) return 0;
    for (const [kind, id, entity] of missing) await state.writeEntity(kind, id, entity);
    logger.error(
      { restored: missing.length, known },
      'Mass deletion of .moe entities detected; rewrote them from memory instead of reloading an empty store'
    );
    return missing.length;
  });
}

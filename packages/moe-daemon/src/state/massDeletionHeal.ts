// =============================================================================
// Mass-deletion self-heal for the .moe store
// =============================================================================
//
// A repo-wide `git clean -fdx`, `git stash --all`, a sparse-checkout or an
// `rm -rf` deletes .moe files while the daemon still holds every entity in
// memory. The FileWatcher then reloads from disk and replaces the board with an
// empty one. px4swarm lost its whole board that way twice (2026-09-25
// sparse-checkout, 2026-09-26 `git clean -qfdx`), when .moe was fully gitignored.
//
// A project that commits its board (settings.commitBoardState, the wrappers'
// default) loses less: .moe/tasks and .moe/epics are tracked, so `git clean -fdx`
// deletes only the ignored runtime dirs (workers, proposals, teams, resources,
// attempts, candidates, checks, reviews, receipts). That wipe is a small share of
// a mature board's entities, and the reload would still empty every runtime map.
//
// Two rules decide that the disk is the casualty, not the truth:
//   combined: at least MASS_DELETION_MIN of the tasks/epics/teams/workers/proposals
//             are missing, and at least MASS_DELETION_FRACTION of those together;
//   per kind: a runtime kind (anything except tasks and epics, which a git checkout
//             or pull changes on purpose) whose directory is gone while memory still
//             holds entries, or that lost at least MIN and FRACTION of its own entries.
// On either, every missing entity of every store load() replaces is written back
// from memory and the reload is skipped: rewriting only some kinds would let the
// next reload empty the rest. A small deliberate deletion (one or two files) still
// reloads exactly as before.
//
// Known gaps: messages/ and pins/ are not held in memory and cannot be restored;
// checks/dispatches and checks/observations load lazily (checkObservationStore)
// and load() does not replace them, so their files stay lost until the next write.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import { logger } from '../util/logger.js';

/** A deletion this small is treated as a deliberate edit and reloaded as before. */
export const MASS_DELETION_MIN = 3;
/** ...and so is any deletion below this fraction of the known entities. */
export const MASS_DELETION_FRACTION = 0.2;

/** Every map StateManager.load() replaces from disk, by its .moe directory. */
const STORES: ReadonlyArray<readonly [string, (state: StateManager) => Map<string, unknown>]> = [
  ['tasks', (s) => s.tasks],
  ['epics', (s) => s.epics],
  ['workers', (s) => s.workers],
  ['teams', (s) => s.teams],
  ['proposals', (s) => s.proposals],
  ['channels', (s) => s.channels],
  ['decisions', (s) => s.decisions],
  ['resources', (s) => s.resources],
  ['attempts', (s) => s.attempts],
  ['candidates', (s) => s.candidates],
  ['reviews', (s) => s.reviews],
  ['checks', (s) => s.checkRuns],
  ['receipts', (s) => s.receipts],
];

/** The kinds the combined rule counts. */
const COMBINED_KINDS: ReadonlySet<string> = new Set(['tasks', 'epics', 'teams', 'workers', 'proposals']);
/** Board kinds: committed under commitBoardState, so a git checkout changes them on purpose. */
const BOARD_KINDS: ReadonlySet<string> = new Set(['tasks', 'epics']);

const isWipe = (missing: number, total: number): boolean =>
  missing >= MASS_DELETION_MIN && missing >= total * MASS_DELETION_FRACTION;

interface Scan {
  /** Every in-memory entity whose file is missing, across all stores. */
  missing: Array<[dir: string, id: string, entity: unknown]>;
  /** Runtime kinds that tripped the per-kind rule. */
  wiped: string[];
  combinedKnown: number;
  combinedMissing: number;
}

/** One pass over every store: one existsSync per entity, plus one per directory. */
function scanStores(state: StateManager): Scan {
  const scan: Scan = { missing: [], wiped: [], combinedKnown: 0, combinedMissing: 0 };
  for (const [dir, entriesOf] of STORES) {
    const entries = entriesOf(state);
    if (entries.size === 0) continue; // nothing in memory to lose or restore
    const dirGone = !fs.existsSync(path.join(state.moePath, dir));
    let lost = 0;
    for (const [id, entity] of entries) {
      if (dirGone || !fs.existsSync(path.join(state.moePath, dir, `${id}.json`))) {
        scan.missing.push([dir, id, entity]);
        lost++;
      }
    }
    if (COMBINED_KINDS.has(dir)) {
      scan.combinedKnown += entries.size;
      scan.combinedMissing += lost;
    }
    if (!BOARD_KINDS.has(dir) && (dirGone || isWipe(lost, entries.size))) scan.wiped.push(dir);
  }
  return scan;
}

/**
 * Re-persists every in-memory entity whose file is missing, when the missing
 * set is large enough to be a wipe. Returns the number rewritten; 0 means
 * "not a wipe", and the caller should reload from disk as usual.
 */
export async function healMassDeletion(state: StateManager): Promise<number> {
  return state.mutex.runExclusive(async () => {
    const scan = scanStores(state);
    const combined = isWipe(scan.combinedMissing, scan.combinedKnown);
    if (!combined && scan.wiped.length === 0) return 0;

    const restoredByKind: Record<string, number> = {};
    for (const [dir, id, entity] of scan.missing) {
      await state.writeEntity(dir, id, entity);
      restoredByKind[dir] = (restoredByKind[dir] ?? 0) + 1;
    }
    logger.error(
      { restored: scan.missing.length, restoredByKind, rule: combined ? 'combined' : 'per-kind', wipedKinds: scan.wiped },
      'Mass deletion of .moe entities detected; rewrote them from memory instead of reloading an empty store'
    );
    return scan.missing.length;
  });
}

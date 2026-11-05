// =============================================================================
// Per-key index over the delivery stores
// =============================================================================
//
// The board snapshot projects every non-archived task (deliveryProjection), and
// each projection used to filter whole stores: candidates, check runs, receipts,
// attempts and reviews, once per task, so a snapshot cost tasks x records and
// grew for the life of the project. This memo buckets one store's ids by one
// field and is rebuilt only when the store may have changed shape: a new map
// (load), a stateVersion bump (every writeEntity and purge) or a size change
// (a write's map.set lands after its bump). Buckets hold ids, not records, so a
// replaced record is read fresh. The fields indexed are a record's links (its
// task, attempt or candidate), which no store rewrites; a bucket naming an id
// that is gone or no longer carries the key still forces a rebuild.

import type { StateManager } from './StateManager.js';

interface FieldIndex {
  version: number;
  size: number;
  ids: Map<string, string[]>;
}

type Stored = { readonly id: string };

const indexes = new WeakMap<ReadonlyMap<string, Stored>, Map<string, FieldIndex>>();

// Walks values() like the scans it replaces, so a store that cannot be read
// still throws out of the lookup (a record is keyed by its own id).
function build<T extends Stored>(map: ReadonlyMap<string, T>, field: keyof T & string, version: number): FieldIndex {
  const ids = new Map<string, string[]>();
  for (const record of map.values()) {
    const key = record[field];
    if (typeof key !== 'string') continue;
    const bucket = ids.get(key);
    if (bucket) bucket.push(record.id);
    else ids.set(key, [record.id]);
  }
  return { version, size: map.size, ids };
}

function collect<T extends Stored>(map: ReadonlyMap<string, T>, field: keyof T & string, key: string, index: FieldIndex): T[] | null {
  const out: T[] = [];
  for (const id of index.ids.get(key) ?? []) {
    const record = map.get(id);
    if (record === undefined || record[field] !== key) return null;
    out.push(record);
  }
  return out;
}

/**
 * The stored records of `map` whose `field` is `key`, in the map's insertion
 * order: what `Array.from(map.values()).filter((r) => r[field] === key)` returns,
 * without the scan. A fresh array of the stored objects; callers copy as before.
 */
export function recordsWhere<T extends Stored>(
  state: StateManager,
  map: ReadonlyMap<string, T>,
  field: keyof T & string,
  key: string
): T[] {
  let byField = indexes.get(map);
  if (!byField) indexes.set(map, (byField = new Map()));
  let index = byField.get(field);
  if (!index || index.version !== state.stateVersion || index.size !== map.size) {
    byField.set(field, (index = build(map, field, state.stateVersion)));
  }
  const found = collect(map, field, key, index);
  if (found) return found;
  byField.set(field, (index = build(map, field, state.stateVersion)));
  return collect(map, field, key, index) ?? [];
}

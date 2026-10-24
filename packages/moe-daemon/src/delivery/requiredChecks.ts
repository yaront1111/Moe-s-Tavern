// Pure helpers for VALIDATED definitions, consumed by V01b snapshot measurement
// and V01's delivery predicate. Never accept a caller's digest as evidence.
import { createHash } from 'node:crypto';
import type { ProtectedCheckDefinition } from '../types/schema.js';

export type ProtectedPathKind = 'configs' | 'scripts' | 'assertionRoots';
const PATH_KINDS: readonly ProtectedPathKind[] = ['configs', 'scripts', 'assertionRoots'];

export function definitionDigest(defs: readonly ProtectedCheckDefinition[]): string {
  const canonical = defs.map(d => [d.id, d.command, d.configs ?? [], d.scripts ?? [], d.assertionRoots ?? []]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function protectedPaths(defs: readonly ProtectedCheckDefinition[]): { path: string; kind: ProtectedPathKind }[] {
  const pairs: { path: string; kind: ProtectedPathKind }[] = [];
  for (const kind of PATH_KINDS) {
    const paths = new Set(defs.flatMap(d => d[kind] ?? []));
    for (const path of paths) pairs.push({ path, kind });
  }
  // Code-unit ordering is deterministic across host locales.
  return pairs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}

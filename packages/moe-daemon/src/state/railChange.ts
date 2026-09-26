/** Resolve an approved rail's original text without losing insignificant trailing whitespace. */
export function findRailIndex(rails: string[], value: string, proposalId: string): number {
  const exact = rails.indexOf(value);
  if (exact !== -1) return exact;

  const matches = rails.flatMap((rail, index) => rail.trimEnd() === value.trimEnd() ? [index] : []);
  if (matches.length === 0) throw new Error(`Rail not found for proposal ${proposalId}`);
  if (matches.length > 1) throw new Error(`Ambiguous rail match for proposal ${proposalId}`);
  return matches[0];
}

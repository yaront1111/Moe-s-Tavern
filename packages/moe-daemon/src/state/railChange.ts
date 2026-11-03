import type { GlobalRails, RailProposal } from '../types/schema.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';

/** The GLOBAL lists a MODIFY_RAIL or REMOVE_RAIL can reach. ADD_RAIL only appends to customRules. */
export const GLOBAL_RAIL_LISTS = ['customRules', 'forbiddenPatterns', 'requiredPatterns'] as const;
export type GlobalRailList = typeof GLOBAL_RAIL_LISTS[number];

/** The exact entry if one exists, else every entry equal once trailing whitespace is trimmed. */
function railMatches(rails: readonly string[], value: string): number[] {
  const exact = rails.indexOf(value);
  if (exact !== -1) return [exact];
  return rails.flatMap((rail, index) => rail.trimEnd() === value.trimEnd() ? [index] : []);
}

const railNotFound = (proposalId: string) =>
  new MoeError(MoeErrorCode.NOT_FOUND, `Rail not found for proposal ${proposalId}`, { proposalId });
const ambiguousRail = (proposalId: string, lists: readonly string[] = []) =>
  new MoeError(MoeErrorCode.INVALID_INPUT,
    `Ambiguous rail match for proposal ${proposalId}${lists.length ? ` (${lists.join(', ')})` : ''}`, { proposalId, lists });

/** Resolve an approved rail's original text without losing insignificant trailing whitespace. */
export function findRailIndex(rails: string[], value: string, proposalId: string): number {
  const matches = railMatches(rails, value);
  if (matches.length === 0) throw railNotFound(proposalId);
  if (matches.length > 1) throw ambiguousRail(proposalId);
  return matches[0];
}

/** The one GLOBAL list holding a MODIFY/REMOVE value. None, or several, is a coded refusal. */
export function resolveGlobalRail(
  rails: GlobalRails | undefined, value: string, proposalId: string
): { list: GlobalRailList; index: number } {
  const hits = GLOBAL_RAIL_LISTS.flatMap((list) => {
    const matches = railMatches(rails?.[list] ?? [], value);
    if (matches.length > 1) throw ambiguousRail(proposalId, [list]);
    return matches.length === 1 ? [{ list, index: matches[0] }] : [];
  });
  if (hits.length === 0) throw railNotFound(proposalId);
  if (hits.length > 1) throw ambiguousRail(proposalId, hits.map((hit) => hit.list));
  return hits[0];
}

/** The globalRails an approved GLOBAL proposal produces. Pure: the caller persists it. */
export function applyGlobalRailChange(rails: GlobalRails, proposal: RailProposal): GlobalRails {
  const next: GlobalRails = { ...rails };
  if (proposal.proposalType === 'ADD_RAIL') {
    next.customRules = [...(rails.customRules ?? []), proposal.proposedValue];
    return next;
  }
  const { list, index } = resolveGlobalRail(rails, proposal.currentValue ?? '', proposal.id);
  const edited = [...rails[list]];
  if (proposal.proposalType === 'MODIFY_RAIL') edited[index] = proposal.proposedValue;
  else edited.splice(index, 1);
  next[list] = edited;
  return next;
}

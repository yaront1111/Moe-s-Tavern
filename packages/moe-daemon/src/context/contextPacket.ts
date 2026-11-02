import type { SourceItemStatus } from './repositorySource.js';
import { invalidInput } from '../util/errors.js';

/**
 * get_context's packetManifest (CQ-C01): which mandatory sections a task read
 * serves, what it leaves out and why, its limitations, provenance and a budget
 * measurement. Pure: it reads the assembled response and never shortens it.
 * Paths, codes and counts only, never duplicated content. Never approval,
 * authorization or readiness: approval stays Task.approvedPlanRevision.
 */

/** Never role-trimmed or truncated; absent or empty is reported missing. */
export const MANDATORY_SECTIONS: readonly string[] = Object.freeze([
  'project.globalRails', 'allRails', 'task.description', 'task.definitionOfDone',
  'task.taskRails', 'task.implementationPlan', 'task.executionContract',
]);
/**
 * Conditional section -> the body path whose non-empty array makes it required.
 * The approved protected-check overlay is mandatory when served. When the served
 * contract declares requiredChecks but no bound snapshot is served (absent,
 * malformed or bound to other definitions) it is reported missing, reason
 * 'unbound-snapshot'. Without a declaration it is not listed at all.
 */
const CONDITIONAL_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  'task.requiredCheckSnapshot': 'task.executionContract.requiredChecks',
});

export const DEFAULT_PACKET_BUDGET_CHARS = 100_000;
export const MIN_PACKET_BUDGET_CHARS = 1_000;
export const MAX_PACKET_BUDGET_CHARS = 250_000;

export interface PacketSection {
  path: string;
  mandatory: boolean;
  status: Extract<SourceItemStatus, 'served' | 'truncated' | 'omitted' | 'missing'>;
  reason?: string;
  count?: number;
}

export interface PacketManifest {
  version: 1;
  provenance: {
    task: { id: string | null; planRevision: number | null };
    epic: { id: string } | null;
    project: { id: string | null };
    candidate?: { id: string };
  };
  sections: PacketSection[];
  complete: boolean;
  limitations: string[];
  budget: { limitChars: number; mandatoryChars: number; status: 'within' | 'overflow'; requirement?: 'expand' | 'restructure' };
}

export interface PacketInput {
  planRevision: number | null;
  roleOmitted: readonly string[];
  siblingsBeyondCap: number;
  commitsTotal: number;
  rejectionsTotal: number;
  budgetChars: number;
}

/** The optional packetBudgetChars input: refused, never clamped, outside [MIN, MAX]. */
export function readPacketBudgetChars(value: unknown): number {
  if (value === undefined) return DEFAULT_PACKET_BUDGET_CHARS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < MIN_PACKET_BUDGET_CHARS || value > MAX_PACKET_BUDGET_CHARS) {
    throw invalidInput('packetBudgetChars', `must be an integer from ${MIN_PACKET_BUDGET_CHARS} to ${MAX_PACKET_BUDGET_CHARS}`);
  }
  return value;
}

/** Own-property path read: an inherited or prototype-chain name reads as absent. */
function own(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function servable(path: string, value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 || path === 'task.taskRails';
  return typeof value === 'object' && value !== null;
}

/** Optional sections not served in full, each with its exact count. */
function omissions(body: Record<string, unknown>, input: PacketInput): PacketSection[] {
  const num = (path: string) => { const v = own(body, path); return typeof v === 'number' ? v : 0; };
  const list = (path: string) => { const v = own(body, path); return Array.isArray(v) ? v : []; };
  const counts: Array<[string, string, number]> = [
    ['task.comments', 'compacted', num('task.commentSummary.omitted') + num('task.commentSummary.truncated')],
    ['chat.recentMessages', 'compacted', list('chat.recentMessages').filter((m) => own(m, 'contentTruncated') === true).length],
    ['task.commits', 'capped', input.commitsTotal - list('task.commits').length],
    ['task.epicSiblings', 'capped', input.roleOmitted.includes('task.epicSiblings') ? 0 : input.siblingsBeyondCap],
    ['task.rejectionHistory', 'capped', input.rejectionsTotal - list('task.rejectionHistory').length],
  ];
  return [
    ...input.roleOmitted.map((path): PacketSection => ({ path, mandatory: false, status: 'omitted', reason: 'role-trim' })),
    ...counts.filter(([, , count]) => count > 0)
      .map(([path, reason, count]): PacketSection => ({ path, mandatory: false, status: 'truncated', reason, count })),
  ];
}

/**
 * Build the manifest for an assembled get_context body (without packetManifest
 * or servedContext). Error handling is reporting, never truncation: an odd
 * shape reads as missing, and an over-budget mandatory contract answers
 * expand (a larger packetBudgetChars holds it) or restructure (none can).
 */
export function buildPacketManifest(body: Record<string, unknown>, input: PacketInput): PacketManifest {
  const sections: PacketSection[] = [];
  let mandatoryChars = 0;
  for (const path of [...MANDATORY_SECTIONS, ...Object.keys(CONDITIONAL_SECTIONS)]) {
    const value = own(body, path);
    const declaredBy = Object.hasOwn(CONDITIONAL_SECTIONS, path) ? own(body, CONDITIONAL_SECTIONS[path]) : undefined;
    if (servable(path, value)) {
      sections.push({ path, mandatory: true, status: 'served' });
      mandatoryChars += JSON.stringify(value).length;
    } else if (!Object.hasOwn(CONDITIONAL_SECTIONS, path)) {
      sections.push({ path, mandatory: true, status: 'missing', reason: value === undefined || value === null ? 'not-set' : 'empty' });
    } else if (Array.isArray(declaredBy) && declaredBy.length > 0) {
      sections.push({ path, mandatory: true, status: 'missing', reason: 'unbound-snapshot' });
    }
  }
  sections.push(...omissions(body, input));
  sections.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const idOf = (path: string) => { const v = own(body, path); return typeof v === 'string' ? v : null; };
  const epicId = idOf('epic.id');
  const candidateId = idOf('currentCandidate.id');
  const within = mandatoryChars <= input.budgetChars;
  return {
    version: 1,
    provenance: {
      task: { id: idOf('task.id'), planRevision: input.planRevision },
      epic: epicId === null ? null : { id: epicId },
      project: { id: idOf('project.id') },
      ...(candidateId === null ? {} : { candidate: { id: candidateId } }),
    },
    sections,
    complete: sections.every((s) => s.status === 'served'),
    limitations: ['no-repository-source', ...(input.planRevision === null ? ['plan-revision-unreadable'] : [])],
    budget: {
      limitChars: input.budgetChars, mandatoryChars, status: within ? 'within' : 'overflow',
      ...(within ? {} : { requirement: mandatoryChars <= MAX_PACKET_BUDGET_CHARS ? 'expand' : 'restructure' }),
    },
  };
}

// =============================================================================
// State validators + sanitizers
// =============================================================================
//
// Extracted verbatim from StateManager. Two families with DELIBERATELY different
// contracts, and the split is load-bearing:
//   - validate*  — throw `invalidInput(...)` on bad input. Callers rely on the
//                  throw happening BEFORE anything reaches disk.
//   - sanitize*  — never throw. Malformed entries are dropped and strings are
//                  sliced, because they run on every write path (updateTask
//                  calls sanitizeImplementationPlan on every single update) and
//                  a throw here would break state mutation entirely.
//
// `validateSettingsUpdate`, `validateEpicUpdates` and `sanitizeImplementationPlan`
// are hardcoded field ALLOWLISTS. A field added to a schema type but not to the
// matching allowlist is silently dropped on write while the tool's own return
// value still looks correct — the hardest failure in this codebase to spot.

import type {
  Epic,
  ImplementationStep,
  Project,
  ProjectSettings,
  StepAmendment,
  StepStatus,
  Task,
  TaskComment,
  TaskCommit,
  Team,
  TeamRole,
} from '../types/schema.js';
import { invalidInput } from '../util/errors.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';
import { validateEntityId } from '../util/sanitize.js';
import { MAX_AMENDMENTS_PER_STEP } from '../util/planAmendments.js';

const MAX_COMMENTS_PER_TASK_DEFAULT = 200;
const MAX_COMMENTS_PER_TASK_ENV = parseInt(process.env.MOE_MAX_COMMENTS_PER_TASK || `${MAX_COMMENTS_PER_TASK_DEFAULT}`, 10);
const ACTIVITY_TEXT_PREVIEW_CHARS = 200;
const ACTIVITY_TRUNCATED_SUFFIX = ' [truncated]';

export const MAX_COMMENTS_PER_TASK = Number.isFinite(MAX_COMMENTS_PER_TASK_ENV) && MAX_COMMENTS_PER_TASK_ENV > 0
  ? MAX_COMMENTS_PER_TASK_ENV
  : MAX_COMMENTS_PER_TASK_DEFAULT;

// Cap on the per-task commit ledger written by moe.record_commit (newest kept).
// Same env-override pattern as MAX_COMMENTS_PER_TASK; bounds both the task
// file and the raw-updates activity payload updateTask logs on every record.
const MAX_COMMITS_PER_TASK_DEFAULT = 50;
const MAX_COMMITS_PER_TASK_ENV = parseInt(process.env.MOE_MAX_COMMITS_PER_TASK || `${MAX_COMMITS_PER_TASK_DEFAULT}`, 10);

export const MAX_COMMITS_PER_TASK = Number.isFinite(MAX_COMMITS_PER_TASK_ENV) && MAX_COMMITS_PER_TASK_ENV > 0
  ? MAX_COMMITS_PER_TASK_ENV
  : MAX_COMMITS_PER_TASK_DEFAULT;

export function trimCommits(commits: TaskCommit[] | null | undefined): TaskCommit[] {
  if (!Array.isArray(commits) || commits.length === 0) {
    return [];
  }
  if (commits.length <= MAX_COMMITS_PER_TASK) {
    return commits;
  }
  return commits.slice(-MAX_COMMITS_PER_TASK);
}

export function trimComments(comments: TaskComment[] | null | undefined): TaskComment[] {
  if (!Array.isArray(comments) || comments.length === 0) {
    return [];
  }

  if (comments.length <= MAX_COMMENTS_PER_TASK) {
    return comments;
  }

  return comments.slice(-MAX_COMMENTS_PER_TASK);
}

export function requirePlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput(fieldName, 'must be an object');
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownFields(input: Record<string, unknown>, allowedFields: readonly string[], objectName: string): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw invalidInput(field, `is not a supported ${objectName} field`);
    }
  }
}

export function validateStringValue(
  value: unknown,
  fieldName: string,
  options: { maxLength: number; allowEmpty?: boolean; trim?: boolean; truncate?: boolean; allowNewlines?: boolean } = { maxLength: 1000 }
): string {
  if (typeof value !== 'string') {
    throw invalidInput(fieldName, 'must be a string');
  }
  const normalized = options.trim ? value.trim() : value;
  if (!options.allowEmpty && normalized.trim().length === 0) {
    throw invalidInput(fieldName, 'cannot be empty');
  }
  if (normalized.includes('\u0000') || (!options.allowNewlines && /[\r\n]/.test(normalized))) {
    throw invalidInput(fieldName, 'cannot contain control characters');
  }
  if (normalized.length > options.maxLength) {
    if (options.truncate) {
      return normalized.substring(0, options.maxLength);
    }
    throw invalidInput(fieldName, `must be ${options.maxLength} characters or fewer`);
  }
  return normalized;
}

export function validateBooleanValue(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidInput(fieldName, 'must be a boolean');
  }
  return value;
}

export function validateIntegerValue(value: unknown, fieldName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalidInput(fieldName, 'must be an integer');
  }
  if (value < min || value > max) {
    throw invalidInput(fieldName, `must be between ${min} and ${max}`);
  }
  return value;
}

export function validateEnumValue<T extends string>(value: unknown, fieldName: string, allowedValues: readonly T[]): T {
  if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
    throw invalidInput(fieldName, `must be one of: ${allowedValues.join(', ')}`);
  }
  return value as T;
}

export function validateStringArrayValue(
  value: unknown,
  fieldName: string,
  maxItems: number,
  maxItemLength: number
): string[] {
  if (!Array.isArray(value)) {
    throw invalidInput(fieldName, 'must be an array');
  }
  if (value.length > maxItems) {
    throw invalidInput(fieldName, `must contain ${maxItems} items or fewer`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw invalidInput(`${fieldName}[${index}]`, 'must be a string');
    }
    return validateStringValue(item, `${fieldName}[${index}]`, {
      maxLength: maxItemLength,
      allowEmpty: false,
      trim: false,
      truncate: true,
    });
  });
}

export function validatePatternSetting(value: unknown, fieldName: string): string {
  const pattern = validateStringValue(value, fieldName, {
    maxLength: 256,
    allowEmpty: true,
    trim: false,
  });
  if (/[`$[\]|;&<>]/.test(pattern)) {
    throw invalidInput(fieldName, 'contains unsupported characters');
  }
  return pattern;
}

export function validateSettingsUpdate(project: Project, settings: Partial<ProjectSettings>): ProjectSettings {
  if (!project) {
    throw new Error('Project not loaded');
  }
  const input = requirePlainObject(settings, 'settings');
  rejectUnknownFields(input, [
    'approvalMode',
    'speedModeDelayMs',
    'autoCreateBranch',
    'branchPattern',
    'commitPattern',
    'agentCommand',
    'enableAgentTeams',
    'columnLimits',
    'chatEnabled',
    'chatMaxAgentHops',
    'autoCommit',
    'checkpointCommits',
    'checkpointPush',
    'commitBoardState',
    'commitHooks',
    'attribution',
    'taskSizing',
    'pacePerStepMs',
    'qualityGate',
    'qualityGateScope',
    'consolidationBranch',
    'appendOnlyFiles',
    'refusalCascadeAutoBacklog',
    'resources',
  ], 'project setting');

  const next: ProjectSettings = { ...project.settings };

  if (input.approvalMode !== undefined) {
    next.approvalMode = validateEnumValue(input.approvalMode, 'approvalMode', ['CONTROL', 'SPEED', 'TURBO'] as const);
  }
  if (input.speedModeDelayMs !== undefined) {
    next.speedModeDelayMs = validateIntegerValue(input.speedModeDelayMs, 'speedModeDelayMs', 0, 60000);
  }
  if (input.pacePerStepMs !== undefined) {
    // Avoid near-zero alert timing and typo-sized values that disable alerts.
    next.pacePerStepMs = validateIntegerValue(input.pacePerStepMs, 'pacePerStepMs', 1000, 86400000);
  }
  if (input.autoCreateBranch !== undefined) {
    next.autoCreateBranch = validateBooleanValue(input.autoCreateBranch, 'autoCreateBranch');
  }
  if (input.branchPattern !== undefined) {
    next.branchPattern = validatePatternSetting(input.branchPattern, 'branchPattern');
  }
  if (input.commitPattern !== undefined) {
    next.commitPattern = validatePatternSetting(input.commitPattern, 'commitPattern');
  }
  if (input.agentCommand !== undefined) {
    next.agentCommand = validateStringValue(input.agentCommand, 'agentCommand', {
      maxLength: 256,
      trim: true,
    });
  }
  if (input.enableAgentTeams !== undefined) {
    next.enableAgentTeams = validateBooleanValue(input.enableAgentTeams, 'enableAgentTeams');
  }
  if (input.chatEnabled !== undefined) {
    next.chatEnabled = validateBooleanValue(input.chatEnabled, 'chatEnabled');
  }
  if (input.chatMaxAgentHops !== undefined) {
    next.chatMaxAgentHops = validateIntegerValue(input.chatMaxAgentHops, 'chatMaxAgentHops', 1, 20);
  }
  if (input.autoCommit !== undefined) {
    next.autoCommit = validateBooleanValue(input.autoCommit, 'autoCommit');
  }
  // Wrapper landing switches. Stored as supplied (the wrapper and
  // get_commit_scope read `!== false` / `=== true`), so an explicit value
  // survives and an omitted key keeps its default.
  if (input.checkpointCommits !== undefined) {
    next.checkpointCommits = validateBooleanValue(input.checkpointCommits, 'checkpointCommits');
  }
  if (input.checkpointPush !== undefined) {
    next.checkpointPush = validateBooleanValue(input.checkpointPush, 'checkpointPush');
  }
  if (input.commitBoardState !== undefined) {
    next.commitBoardState = validateBooleanValue(input.commitBoardState, 'commitBoardState');
  }
  if (input.commitHooks !== undefined) {
    next.commitHooks = validateBooleanValue(input.commitHooks, 'commitHooks');
  }
  if (input.attribution !== undefined) {
    const incoming = requirePlainObject(input.attribution, 'attribution');
    rejectUnknownFields(incoming, ['undeclared', 'contested', 'exclude'], 'attribution setting');
    const merged: NonNullable<ProjectSettings['attribution']> = { ...(next.attribution || {}) };
    if (incoming.undeclared !== undefined) {
      merged.undeclared = validateEnumValue(incoming.undeclared, 'attribution.undeclared', ['solo', 'never', 'always'] as const);
    }
    if (incoming.contested !== undefined) {
      merged.contested = validateEnumValue(incoming.contested, 'attribution.contested', ['commit', 'skip'] as const);
    }
    if (incoming.exclude !== undefined) {
      // Bounded string array, then the affected-file canonicalization so the
      // stored DENY prefixes are project-relative, traversal-free and
      // forward-slashed. An explicit `[]` survives (no extra exclusions).
      const entries = validateStringArrayValue(incoming.exclude, 'attribution.exclude', 100, 500);
      merged.exclude = normalizeAffectedFiles(entries, 'attribution.exclude');
    }
    next.attribution = merged;
  }
  if (input.refusalCascadeAutoBacklog !== undefined) {
    // Stored as supplied: the release path reads `!== false`, so an explicit
    // false must survive as false and an omitted key must stay omitted
    // (absence = enabled, for projects created before this setting existed).
    next.refusalCascadeAutoBacklog = validateBooleanValue(
      input.refusalCascadeAutoBacklog,
      'refusalCascadeAutoBacklog'
    );
  }
  if (input.qualityGate !== undefined) {
    // A shell command the worker wrapper runs pre-commit (same trust model
    // as agentCommand). Empty string disables the gate.
    next.qualityGate = validateStringValue(input.qualityGate, 'qualityGate', {
      maxLength: 500,
      allowEmpty: true,
      trim: true,
    });
  }
  if (input.qualityGateScope !== undefined) {
    next.qualityGateScope = validateEnumValue(input.qualityGateScope, 'qualityGateScope', ['epicFinal', 'everyTask'] as const);
  }
  if (input.consolidationBranch !== undefined) {
    // Literal branch name or a `*` glob checked at complete_task. Empty
    // string is the documented off switch; the cap bounds the pattern that
    // gets compiled into a regex.
    next.consolidationBranch = validateStringValue(input.consolidationBranch, 'consolidationBranch', {
      maxLength: 200,
      allowEmpty: true,
      trim: true,
    });
  }
  if (input.appendOnlyFiles !== undefined) {
    // Bounded string array first (shape + length), then the affected-file
    // canonicalization so stored globs are project-relative, traversal-free
    // and forward-slashed. Both throw `invalidInput` before `next` is handed
    // back to updateSettings, so a bad list never reaches memory or disk.
    // An explicit `[]` survives untouched — it disables suppression.
    const entries = validateStringArrayValue(input.appendOnlyFiles, 'appendOnlyFiles', 100, 500);
    next.appendOnlyFiles = normalizeAffectedFiles(entries, 'appendOnlyFiles');
  }
  if (input.taskSizing !== undefined) {
    const incoming = requirePlainObject(input.taskSizing, 'taskSizing');
    rejectUnknownFields(incoming, [
      'warnSteps',
      'maxSteps',
      'warnDistinctFiles',
      'maxDistinctFiles',
      'maxTasksPerEpic',
      'autoCritique',
    ], 'taskSizing setting');
    const merged: NonNullable<ProjectSettings['taskSizing']> = { ...(next.taskSizing || {}) };
    if (incoming.warnSteps !== undefined) {
      merged.warnSteps = validateIntegerValue(incoming.warnSteps, 'taskSizing.warnSteps', 1, 100);
    }
    if (incoming.maxSteps !== undefined) {
      merged.maxSteps = validateIntegerValue(incoming.maxSteps, 'taskSizing.maxSteps', 1, 100);
    }
    if (incoming.warnDistinctFiles !== undefined) {
      merged.warnDistinctFiles = validateIntegerValue(incoming.warnDistinctFiles, 'taskSizing.warnDistinctFiles', 1, 100);
    }
    if (incoming.maxDistinctFiles !== undefined) {
      merged.maxDistinctFiles = validateIntegerValue(incoming.maxDistinctFiles, 'taskSizing.maxDistinctFiles', 1, 100);
    }
    if (incoming.maxTasksPerEpic !== undefined) {
      merged.maxTasksPerEpic = validateIntegerValue(incoming.maxTasksPerEpic, 'taskSizing.maxTasksPerEpic', 1, 1000);
    }
    if (incoming.autoCritique !== undefined) {
      merged.autoCritique = validateBooleanValue(incoming.autoCritique, 'taskSizing.autoCritique');
    }
    next.taskSizing = merged;
  }
  if (input.resources !== undefined) {
    // Shared-resource declarations. REPLACES the stored map (not a deep merge):
    // removing a resource must be possible, and per-key merge semantics would
    // make removal impossible from this path.
    const incoming = requirePlainObject(input.resources, 'resources');
    const validated: NonNullable<ProjectSettings['resources']> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) {
        throw invalidInput('resources', `invalid resource id "${key}" — use 1-64 chars of letters, digits, ".", "_", "-"`);
      }
      const spec = requirePlainObject(value, `resources.${key}`);
      rejectUnknownFields(spec, ['capacity', 'maxLeaseMs', 'description'], `resources.${key} setting`);
      const entry: NonNullable<ProjectSettings['resources']>[string] = {};
      if (spec.capacity !== undefined) {
        entry.capacity = validateIntegerValue(spec.capacity, `resources.${key}.capacity`, 1, 100);
      }
      if (spec.maxLeaseMs !== undefined) {
        entry.maxLeaseMs = validateIntegerValue(spec.maxLeaseMs, `resources.${key}.maxLeaseMs`, 60000, 604800000);
      }
      if (spec.description !== undefined) {
        entry.description = validateStringValue(spec.description, `resources.${key}.description`, {
          maxLength: 500,
          trim: true,
        });
      }
      validated[key] = entry;
    }
    next.resources = validated;
  }
  if (input.columnLimits !== undefined) {
    const incoming = requirePlainObject(input.columnLimits, 'columnLimits');
    const merged: Record<string, number> = { ...(next.columnLimits || {}) };
    for (const [key, value] of Object.entries(incoming)) {
      validateEnumValue(key, 'columnLimits key', ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'BLOCKED', 'DONE', 'ARCHIVED'] as const);
      merged[key] = validateIntegerValue(value, `columnLimits.${key}`, 1, 1000);
    }
    next.columnLimits = merged;
  }
  return next;
}

export function validateEpicUpdates(updates: Partial<Epic>): Partial<Epic> {
  const input = requirePlainObject(updates, 'updates');
  rejectUnknownFields(input, ['title', 'description', 'architectureNotes', 'epicRails', 'status', 'order'], 'epic update');

  const sanitized: Partial<Epic> = {};
  if (input.title !== undefined) {
    sanitized.title = validateStringValue(input.title, 'title', {
      maxLength: 500,
      trim: false,
      truncate: true,
    });
  }
  if (input.description !== undefined) {
    sanitized.description = validateStringValue(input.description, 'description', {
      maxLength: 10000,
      allowEmpty: true,
      trim: false,
      truncate: true,
      allowNewlines: true,
    });
  }
  if (input.architectureNotes !== undefined) {
    sanitized.architectureNotes = validateStringValue(input.architectureNotes, 'architectureNotes', {
      maxLength: 50000,
      allowEmpty: true,
      trim: false,
      truncate: true,
      allowNewlines: true,
    });
  }
  if (input.epicRails !== undefined) {
    sanitized.epicRails = validateStringArrayValue(input.epicRails, 'epicRails', 100, 1000);
  }
  if (input.status !== undefined) {
    sanitized.status = validateEnumValue(input.status, 'status', ['PLANNED', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const);
  }
  if (input.order !== undefined) {
    sanitized.order = validateIntegerValue(input.order, 'order', 0, Number.MAX_SAFE_INTEGER);
  }
  return sanitized;
}

export function activityStringPreview(value: string): string {
  if (value.length <= ACTIVITY_TEXT_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, ACTIVITY_TEXT_PREVIEW_CHARS)}${ACTIVITY_TRUNCATED_SUFFIX}`;
}

export function epicCreatedActivityPayload(epic: Epic): Record<string, unknown> {
  return {
    epicId: epic.id,
    title: activityStringPreview(epic.title),
    status: epic.status,
    order: epic.order,
  };
}

export function epicUpdatedActivityPayload(epic: Epic, updates: Partial<Epic>): Record<string, unknown> {
  const changedFields = Object.keys(updates);
  const payload: Record<string, unknown> = {
    epicId: epic.id,
    changedFields,
  };

  if (Object.prototype.hasOwnProperty.call(updates, 'title')) {
    payload.title = activityStringPreview(epic.title);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    payload.status = epic.status;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'order')) {
    payload.order = epic.order;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
    payload.descriptionLength = epic.description.length;
    payload.descriptionPreview = activityStringPreview(epic.description);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'architectureNotes')) {
    payload.architectureNotesLength = epic.architectureNotes.length;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'epicRails')) {
    payload.epicRailsCount = epic.epicRails.length;
  }

  return payload;
}

export function validateTeamName(value: unknown): string {
  return validateStringValue(value, 'name', {
    maxLength: 200,
    trim: true,
  });
}

export function validateTeamRole(value: unknown): TeamRole | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateEnumValue(value, 'role', ['architect', 'worker', 'qa', 'governor'] as const);
}

export function validateTeamMaxSize(value: unknown): number {
  return validateIntegerValue(value, 'maxSize', 1, 1000);
}

export function validateMemberIds(value: unknown, field = 'memberIds'): string[] {
  if (!Array.isArray(value)) {
    throw invalidInput(field, 'must be an array');
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const rawId of value) {
    const id = validateEntityId(rawId, field);
    if (seen.has(id)) {
      throw invalidInput(field, 'must not contain duplicate IDs');
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function validateCreateTeamInput(input: { name: string; role?: TeamRole | null; maxSize?: number }): { name: string; role: TeamRole | null; maxSize: number } {
  const raw = requirePlainObject(input, 'team');
  rejectUnknownFields(raw, ['name', 'role', 'maxSize'], 'team');
  const maxSize = raw.maxSize === undefined ? 10 : validateTeamMaxSize(raw.maxSize);
  return {
    name: validateTeamName(raw.name),
    role: validateTeamRole(raw.role),
    maxSize,
  };
}

export function validateTeamUpdates(team: Team, updates: Partial<Team>): Partial<Team> {
  const input = requirePlainObject(updates, 'updates');
  rejectUnknownFields(input, ['name', 'role', 'memberIds', 'formerMemberIds', 'maxSize'], 'team update');

  const sanitized: Partial<Team> = {};
  if (input.name !== undefined) {
    sanitized.name = validateTeamName(input.name);
  }
  if (input.role !== undefined) {
    sanitized.role = validateTeamRole(input.role);
  }
  if (input.memberIds !== undefined) {
    sanitized.memberIds = validateMemberIds(input.memberIds);
  }
  if (input.formerMemberIds !== undefined) {
    // Deliberately NOT bounded by maxSize: a tombstone records who was evicted,
    // it is not a seat on the team.
    sanitized.formerMemberIds = validateMemberIds(input.formerMemberIds, 'formerMemberIds');
  }
  if (input.maxSize !== undefined) {
    sanitized.maxSize = validateTeamMaxSize(input.maxSize);
  }

  const nextMemberIds = sanitized.memberIds ?? team.memberIds;
  const nextMaxSize = sanitized.maxSize ?? team.maxSize;
  if (nextMemberIds.length > nextMaxSize) {
    throw invalidInput('maxSize', 'must be at least the number of members');
  }

  return sanitized;
}

export function sanitizeStringIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.slice(0, 200);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * Rebuild a step's amendment history (moe.amend_plan_step). Same contract as
 * the rest of the plan sanitizer: never throw, just drop what is malformed.
 */
export function sanitizeStepAmendments(value: unknown): StepAmendment[] {
  if (!Array.isArray(value)) return [];
  const out: StepAmendment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.amendmentId !== 'string' || a.amendmentId.length === 0) continue;
    // An amendment with no replacement text carries no instructions — drop it
    // rather than let it resolve a step to an empty description.
    if (typeof a.description !== 'string' || a.description.trim().length === 0) continue;
    out.push({
      amendmentId: a.amendmentId.slice(0, 200),
      // 5000 matches the step-description cap above (submitPlan's 10000 limit
      // would be silently truncated here otherwise).
      description: a.description.slice(0, 5000),
      reason: typeof a.reason === 'string' ? a.reason.slice(0, 2000) : '',
      amendedBy: typeof a.amendedBy === 'string' ? a.amendedBy.slice(0, 200) : '',
      amendedAt: typeof a.amendedAt === 'string' ? a.amendedAt.slice(0, 64) : '',
    });
    if (out.length >= MAX_AMENDMENTS_PER_STEP) break;
  }
  return out;
}

export function sanitizeImplementationPlan(plan: unknown): ImplementationStep[] {
  if (!Array.isArray(plan)) return [];
  const VALID_STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];
  const capped = plan.slice(0, 50);
  const result: ImplementationStep[] = [];
  for (const step of capped) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    if (!s.description || typeof s.description !== 'string') continue;
    result.push({
      stepId: typeof s.stepId === 'string' ? s.stepId : `step-${result.length + 1}`,
      description: s.description.slice(0, 5000),
      status: (typeof s.status === 'string' && VALID_STEP_STATUSES.includes(s.status) ? s.status : 'PENDING') as StepStatus,
      affectedFiles: Array.isArray(s.affectedFiles) ? (s.affectedFiles as string[]).filter(f => typeof f === 'string').slice(0, 50) : [],
      ...(s.newFiles !== undefined ? { newFiles: Array.isArray(s.newFiles) ? (s.newFiles as string[]).filter(f => typeof f === 'string').slice(0, 50) : [] } : {}),
      ...(s.modifiedFiles !== undefined ? { modifiedFiles: Array.isArray(s.modifiedFiles) ? (s.modifiedFiles as string[]).filter(f => typeof f === 'string').slice(0, 50) : [] } : {}),
      ...(typeof s.note === 'string' ? { note: s.note.slice(0, 5000) } : {}),
      ...(typeof s.startedAt === 'string' ? { startedAt: s.startedAt } : {}),
      ...(typeof s.completedAt === 'string' ? { completedAt: s.completedAt } : {}),
      ...(s.amendments !== undefined ? { amendments: sanitizeStepAmendments(s.amendments) } : {}),
      ...(typeof s.activeAmendmentId === 'string' ? { activeAmendmentId: s.activeAmendmentId.slice(0, 200) } : {}),
    });
  }
  return result;
}

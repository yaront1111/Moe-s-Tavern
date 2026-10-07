import type { Effort, ModelProvider, ProjectSettings, RoutingModel, Task, TaskTier, TeamRole, TierLaunch } from '../types/schema.js';
import { countDistinctAffectedFiles, resolveTaskSizing } from './planSize.js';

/**
 * Per-task launch routing. The architect picks a tier, an effort and a model
 * at submit_plan; the plan size floors the tier and effort, and each qa_reject
 * escalates (model back to the strongest, tier and effort up one step). The
 * wrapper launches the task's CLI with the resolved model/effort, so easy tasks
 * stop paying for the strongest model at `--effort max`.
 *
 * settings.routing.models is the model catalog, strongest first per provider:
 * adding a new model is one entry in project.json. Each provider's first entry
 * is its default. A provider with no configured entries keeps the built-in ones.
 */

export const TIERS: readonly TaskTier[] = ['light', 'standard', 'heavy'];
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** settings.routing.efforts default: the levels the fleet may run at. */
export const DEFAULT_ALLOWED_EFFORTS: readonly Effort[] = ['high', 'xhigh', 'max'];
/** Extra levels only a docs/tests-only plan may use (settings.routing.lowEfforts). */
export const DEFAULT_LOW_EFFORTS: readonly Effort[] = ['low', 'medium'];
/** A plan is docs/tests-only when every file it touches matches one of these (settings.routing.lowEffortFiles). */
export const DEFAULT_LOW_EFFORT_FILES: readonly string[] = [
  '**/*.md', 'docs/**', '**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**',
];
const DEFAULT_EFFORT: Record<TaskTier, Effort> = {
  light: 'high',
  standard: 'xhigh',
  heavy: 'max',
};
/** A qa seat never reviews below this effort (settings.routing.qa.effort). */
export const DEFAULT_QA_EFFORT_FLOOR: Effort = 'xhigh';
/** Minimum effort per tier: a planner may lower effort, but not below this. */
const EFFORT_FLOOR: Record<TaskTier, Effort> = {
  light: 'high',
  standard: 'high',
  heavy: 'xhigh',
};
export const PROVIDERS: readonly ModelProvider[] = ['claude', 'codex'];
export const DEFAULT_MODELS: readonly RoutingModel[] = [
  { id: 'claude-opus-5-5', use: 'Default. Complex or open-ended work that needs sustained judgment.' },
  {
    id: 'claude-sonnet-5-5',
    use: 'Well-scoped everyday tasks and bug fixes; about half the cost of Opus 5.5.',
    tiers: ['light', 'standard'],
  },
  {
    id: 'gpt-6-astra',
    provider: 'codex',
    use: 'Default for codex seats. Most capable: complex work across code, apps and research.',
  },
  { id: 'gpt-6.1-sol', provider: 'codex', use: 'Near-Astra performance for complex work at lower cost.', tiers: ['light', 'standard'] },
  { id: 'gpt-6-luna', provider: 'codex', use: 'Most efficient: focused, high-volume tasks and focused coding.', tiers: ['light'] },
];

export function isTier(value: unknown): value is TaskTier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export function maxTier(a: TaskTier, b: TaskTier | undefined): TaskTier {
  return b && TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a;
}

export function bumpTier(tier: TaskTier): TaskTier {
  return TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)];
}

export function maxEffort(a: Effort, b: Effort | undefined): Effort {
  return b && EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a;
}

const validEfforts = (raw: unknown, fallback: readonly Effort[]): Effort[] => {
  const valid = EFFORTS.filter((e) => Array.isArray(raw) && raw.includes(e));
  return valid.length > 0 ? valid : [...fallback];
};

/**
 * Allowed levels, low→max: settings.routing.efforts (default high/xhigh/max),
 * plus settings.routing.lowEfforts (default low/medium) for a docs/tests-only plan.
 */
export function allowedEfforts(settings?: Pick<ProjectSettings, 'routing'>, lowEffortEligible = false): Effort[] {
  const allowed = validEfforts(settings?.routing?.efforts, DEFAULT_ALLOWED_EFFORTS);
  if (!lowEffortEligible) return allowed;
  const low = validEfforts(settings?.routing?.lowEfforts, DEFAULT_LOW_EFFORTS);
  return EFFORTS.filter((e) => allowed.includes(e) || low.includes(e));
}

/**
 * Raise an effort to the lowest allowed level at or above it. A level above
 * every allowed one (e.g. max when max isn't allowed) gets the highest allowed.
 */
export function clampEffort(effort: Effort, settings?: Pick<ProjectSettings, 'routing'>, lowEffortEligible = false): Effort {
  const allowed = allowedEfforts(settings, lowEffortEligible);
  return allowed.find((e) => EFFORTS.indexOf(e) >= EFFORTS.indexOf(effort)) ?? allowed[allowed.length - 1];
}

/** One allowed level up (max stays max). */
export function bumpEffort(effort: Effort, settings?: Pick<ProjectSettings, 'routing'>, lowEffortEligible = false): Effort {
  const next = EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)];
  return clampEffort(next, settings, lowEffortEligible);
}

/** Tier minimum; a docs/tests-only plan has none. */
export function effortFloor(
  tier: TaskTier,
  settings?: Pick<ProjectSettings, 'routing'>,
  lowEffortEligible = false
): Effort | undefined {
  return lowEffortEligible ? undefined : clampEffort(EFFORT_FLOOR[tier], settings);
}

// '**/' = any leading dirs (or none), '**' = anything, '*' = within one segment, '?' = one char.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.slice(0, 3) === '**/') { re += '(?:.*/)?'; i += 2; }
    else if (rest.slice(0, 2) === '**') { re += '.*'; i += 1; }
    else if (glob[i] === '*') re += '[^/]*';
    else if (glob[i] === '?') re += '[^/]';
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** settings.routing.lowEffortFiles (non-empty strings), else DEFAULT_LOW_EFFORT_FILES. */
export function lowEffortFiles(settings?: Pick<ProjectSettings, 'routing'>): string[] {
  const raw = settings?.routing?.lowEffortFiles;
  const globs = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : [];
  return globs.length > 0 ? globs : [...DEFAULT_LOW_EFFORT_FILES];
}

/** Docs/tests-only: the plan touches at least one file and every file matches lowEffortFiles. */
export function isLowEffortPlan(
  steps: { affectedFiles?: string[]; newFiles?: string[] }[],
  settings?: Pick<ProjectSettings, 'routing'>
): boolean {
  const files = steps.flatMap((step) => [...(step.affectedFiles ?? []), ...(step.newFiles ?? [])]);
  const globs = lowEffortFiles(settings).map(globToRegExp);
  return files.length > 0 && files.every((file) => globs.some((glob) => glob.test(file.replace(/\\/g, '/'))));
}

/** light: ≤3 steps and ≤2 files; standard: within the taskSizing warn band; heavy: past it. */
export function planSizeFloor(
  steps: { affectedFiles: string[]; newFiles?: string[] }[],
  settings?: Pick<ProjectSettings, 'taskSizing'>
): TaskTier {
  // newFiles count toward size exactly as in assessPlanSize.
  const files = countDistinctAffectedFiles(
    steps.map((step) => ({ affectedFiles: [...(step.affectedFiles ?? []), ...(step.newFiles ?? [])] }))
  );
  if (steps.length <= 3 && files <= 2) return 'light';
  const { warnSteps, warnDistinctFiles } = resolveTaskSizing(settings?.taskSizing);
  return steps.length <= warnSteps && files <= warnDistinctFiles ? 'standard' : 'heavy';
}

// project.json is hand-edited and bypasses validateSettingsUpdate, so bad
// routing values are ignored, never fatal.
function tierEntry(tier: TaskTier, settings?: Pick<ProjectSettings, 'routing'>): Partial<TierLaunch> {
  const entry = settings?.routing?.[tier];
  return entry && typeof entry === 'object' ? entry : {};
}

const providerOf = (model: RoutingModel): ModelProvider => model.provider ?? 'claude';

/**
 * The catalog for one provider (or all): configured valid entries, else the
 * built-in entries for any provider the configuration doesn't mention.
 */
export function modelCatalog(settings?: Pick<ProjectSettings, 'routing'>, provider?: ModelProvider): RoutingModel[] {
  const raw = settings?.routing?.models;
  const configured = (Array.isArray(raw) ? raw : []).flatMap((entry): RoutingModel[] => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') return [];
    if (entry.provider !== undefined && !(PROVIDERS as readonly unknown[]).includes(entry.provider)) return [];
    const tiers = Array.isArray(entry.tiers) ? entry.tiers.filter(isTier) : [];
    return [{
      id: entry.id.trim(),
      ...(entry.provider && entry.provider !== 'claude' ? { provider: entry.provider } : {}),
      ...(typeof entry.use === 'string' && entry.use.trim() ? { use: entry.use.trim() } : {}),
      ...(tiers.length > 0 ? { tiers } : {}),
    }];
  });
  return (provider ? [provider] : PROVIDERS).flatMap((p) => {
    const own = configured.filter((m) => providerOf(m) === p);
    return own.length > 0 ? own : DEFAULT_MODELS.filter((m) => providerOf(m) === p).map((m) => ({ ...m }));
  });
}

export function defaultModel(settings?: Pick<ProjectSettings, 'routing'>, provider: ModelProvider = 'claude'): string {
  return modelCatalog(settings, provider)[0].id;
}

/** A provider's catalog ids allowed to run a task of this tier (no `tiers` = every tier). */
export function modelsForTier(
  tier: TaskTier,
  settings?: Pick<ProjectSettings, 'routing'>,
  provider: ModelProvider = 'claude'
): string[] {
  return modelCatalog(settings, provider).filter((m) => !m.tiers || m.tiers.includes(tier)).map((m) => m.id);
}

/**
 * The tier's configured effort, else its default — raised to an allowed level.
 * A docs/tests-only plan gets it too: eligibility lets the planner pick
 * low/medium explicitly, never lowers the omitted default (a tests-only file
 * list can still be heavy work, e.g. writing a batch's tests and running every gate).
 */
export function tierEffort(tier: TaskTier, settings?: Pick<ProjectSettings, 'routing'>): Effort {
  const effort = tierEntry(tier, settings).effort;
  return clampEffort(isEffort(effort) ? effort : DEFAULT_EFFORT[tier], settings);
}

/**
 * What the planner sees in get_context: the catalog per provider (`model` picks
 * from claude, `codexModel` from codex), the efforts, and each tier's defaults.
 */
export function routingInfo(settings?: Pick<ProjectSettings, 'routing'>) {
  return {
    models: Object.fromEntries(PROVIDERS.map((p) => [p, modelCatalog(settings, p)])),
    efforts: allowedEfforts(settings),
    lowEffort: {
      files: lowEffortFiles(settings),
      efforts: allowedEfforts(settings, true),
      note: 'A plan whose every file matches these globs (docs/tests-only) may also run at these lower efforts when you pick one explicitly; omitted, it gets the tier default like any plan. The daemon decides eligibility from the plan.',
    },
    tierDefaults: Object.fromEntries(TIERS.map((tier) => [tier, {
      effort: tierEffort(tier, settings),
      effortFloor: effortFloor(tier, settings),
      models: Object.fromEntries(PROVIDERS.map((p) => [p, modelsForTier(tier, settings, p)])),
    }])),
  };
}

export interface ResolvedLaunch {
  tier: TaskTier;
  effort: Effort;
  /** Claude model for claude seats. */
  model: string;
  /** Model and effort for codex seats (same effort as the claude side). */
  codex: { model: string; effort: Effort };
}

/**
 * Launch hint for a claimed WORKING/REVIEW task. A `qa` seat reviews at no
 * less than settings.routing.qa.effort (default xhigh) and, when configured
 * and allowed for the tier, on settings.routing.qa.model: the reviewer never
 * runs weaker than the cheapest worker launch.
 */
export function resolveLaunch(
  task: Pick<Task, 'tier' | 'status' | 'effort' | 'model' | 'codexModel' | 'lowEffortEligible'>,
  settings?: Pick<ProjectSettings, 'routing'>,
  role?: TeamRole | null
): ResolvedLaunch | undefined {
  // The tier sizes the worker/QA sessions; planning keeps the role default.
  if (!isTier(task.tier) || settings?.routing?.enabled === false || task.status === 'PLANNING') return undefined;
  const low = task.lowEffortEligible === true;
  let effort = isEffort(task.effort) ? clampEffort(task.effort, settings, low) : tierEffort(task.tier, settings);
  const entryModel = tierEntry(task.tier, settings).model;
  let model = typeof task.model === 'string' && modelsForTier(task.tier, settings).includes(task.model)
    ? task.model
    : typeof entryModel === 'string' && entryModel.trim() !== '' ? entryModel.trim() : defaultModel(settings);
  if (role === 'qa') {
    const qa = settings?.routing?.qa;
    const qaEffort = qa?.effort;
    effort = maxEffort(effort, clampEffort(isEffort(qaEffort) ? qaEffort : DEFAULT_QA_EFFORT_FLOOR, settings));
    if (typeof qa?.model === 'string' && modelsForTier(task.tier, settings).includes(qa.model)) model = qa.model;
  }
  const codexModel = typeof task.codexModel === 'string' && modelsForTier(task.tier, settings, 'codex').includes(task.codexModel)
    ? task.codexModel
    : defaultModel(settings, 'codex');
  return { tier: task.tier, effort, model, codex: { model: codexModel, effort } };
}

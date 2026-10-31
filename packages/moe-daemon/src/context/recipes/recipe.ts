/**
 * Recipes (CQ-C08): versioned plan templates. A registered kind validates inputs, assesses committed source and builds
 * steps. Definitions (RECIPE_DEFINITIONS_PATH) are read ONLY from committed bytes at one pinned commit. The plan goes
 * through submit_plan's own validation and CONTROL/SPEED/TURBO approval as RECIPE_ACTOR; the definitions file joins
 * every required check's configs, so V01 pins its blob until a new approval. A failure is an ordinary-planning fallback
 * that writes nothing. Call OUTSIDE the state mutex; a locked caller uses state.detachFromMutexContext (activation's job).
 */
import { createHash } from 'node:crypto';
import type { StateManager } from '../../state/StateManager.js';
import type { RecipeDefinition, RecipeInstance, Task, TaskExecutionContract, TaskStatus } from '../../types/schema.js';
import { validateExecutionContract } from '../../state/validators.js';
import { submitRecipePlan } from '../../tools/submitPlan.js';
import { MoeError } from '../../util/errors.js';
import { capturePlanSourceBasis } from '../planReuseState.js';
import { readRepositorySource } from '../repositorySource.js';

/** Versioned project configuration a human commits: {version: 1, recipes: RecipeDefinition[]}. */
export const RECIPE_DEFINITIONS_PATH = '.moe/recipes.json';
export type RecipeInputs = Record<string, string | number | boolean>;
export interface RecipePlanStep { description: string; affectedFiles?: string[]; newFiles?: string[] }
type Refused = { ok: false; reason: string };
export interface RecipeKind {
  readonly name: string;
  /** null, or the refusal reason; validateDefinition checks def.params. */
  validateDefinition(def: RecipeDefinition): string | null;
  validateInputs(inputs: RecipeInputs, def: RecipeDefinition): string | null;
  /** Bounded and read-only, committed bytes only; never throws. */
  assessSource(projectRoot: string, commit: string, inputs: RecipeInputs, def: RecipeDefinition): Promise<{ ok: true; assessment: unknown } | Refused>;
  /** Deterministic, no IO. The framework owns requiredChecks. */
  instantiate(inputs: RecipeInputs, def: RecipeDefinition, assessment: unknown, commit: string):
    { ok: true; steps: RecipePlanStep[]; executionContract?: Omit<TaskExecutionContract, 'requiredChecks'> } | Refused;
  /** The hook a later post-patch consumer calls; nothing calls it yet. */
  assessPostpatch?(projectRoot: string, ctx: { taskId: string; instance: RecipeInstance; definition: RecipeDefinition;
    postCommit: string }): Promise<{ ok: true } | Refused>;
}
export interface RecipeRequest { taskId: string; recipeId: string; inputs: unknown }
type Refusal = { reason: string; detail?: string };
export type RecipeOutcome = { instantiated: true; status: TaskStatus; planRevision: number }
  | { instantiated: false; fallback: 'ordinary-planning' } & Refusal;
/** The kind registry. Kinds register themselves from their own modules; this module imports none. */
export const recipeKinds = new Map<string, RecipeKind>();
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DEF_KEYS = ['id', 'kind', 'version', 'requiredChecks', 'params'];
const INSTANCE_KEYS = ['version', 'recipeId', 'kind', 'recipeVersion', 'definitionDigest', 'commit', 'inputs', 'inputsDigest', 'planRevision'];
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isHex = (v: unknown, re = /^[0-9a-f]{64}$/): v is string => typeof v === 'string' && re.test(v);
const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
const clip = (text: string) => text.replace(new RegExp(CONTROL.source, 'g'), '?').slice(0, 300);
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The plain-object and prototype checks of fieldsOf in context/planReuseState.ts.
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const refused = (v: unknown): v is Refused => plain(v) && v.ok === false && typeof v.reason === 'string' && v.reason !== '';
export const recipeDefinitionDigest = (def: RecipeDefinition): string =>
  sha256([def.id, def.kind, def.version, def.requiredChecks, def.params ?? null]);
export const recipeInputsDigest = (def: RecipeDefinition, inputs: RecipeInputs): string =>
  sha256([def.id, def.kind, def.version, Object.keys(inputs).sort().map(key => [key, inputs[key]])]);

/** A detached copy of flat inputs: at most 32 keys of 1-64 chars, string/finite number/boolean values, <=16384 JSON chars. */
function flatInputs(value: unknown): RecipeInputs | null {
  if (!plain(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 32 || !entries.every(([key, v]) => key.length >= 1 && key.length <= 64 && !CONTROL.test(key)
      && (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))) return null;
  return JSON.stringify(value).length <= 16384 ? Object.fromEntries(entries) as RecipeInputs : null;
}

/** The current binding as a detached copy, or null when malformed or stale (a later plan revision). Never throws. */
export function readRecipeInstance(task: Pick<Task, 'recipeInstance' | 'planRevision'>): RecipeInstance | null {
  try {
    const v: unknown = task.recipeInstance;
    if (!plain(v) || Object.keys(v).length !== INSTANCE_KEYS.length || !INSTANCE_KEYS.every(k => Object.keys(v).includes(k))) return null;
    const { recipeId, kind, recipeVersion, definitionDigest, commit, inputsDigest } = v;
    const inputs = flatInputs(v.inputs);
    const planRevision = task.planRevision ?? 0;
    return v.version === 1 && isId(recipeId) && isId(kind) && isVersion(recipeVersion) && isHex(definitionDigest)
      && isHex(inputsDigest) && isHex(commit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) && inputs && v.planRevision === planRevision
      ? { version: 1, recipeId, kind, recipeVersion, definitionDigest, commit, inputs, inputsDigest, planRevision } : null;
  } catch { return null; }
}

function decodeDefinitions(text: string): RecipeDefinition[] | Refusal {
  const invalid = (detail: string): Refusal => ({ reason: 'recipe-definitions-invalid', detail });
  let file: unknown;
  try { file = JSON.parse(text); } catch (error) { return invalid(firstLine(error)); }
  if (!plain(file) || Object.keys(file).length !== 2 || file.version !== 1 || !Array.isArray(file.recipes)
      || file.recipes.length < 1 || file.recipes.length > 50) return invalid('expected {version: 1, recipes: 1-50 entries}');
  const defs: RecipeDefinition[] = [];
  for (const [index, entry] of (file.recipes as unknown[]).entries()) {
    const field = `recipes[${index}]`;
    if (!plain(entry) || !Object.keys(entry).every(k => DEF_KEYS.includes(k))) return invalid(`${field}: unknown keys`);
    const { id, kind, version, params } = entry;
    if (!isId(id) || defs.some(d => d.id === id)) return invalid(`${field}.id`);
    if (!isId(kind)) return invalid(`${field}.kind`);
    if (!isVersion(version)) return invalid(`${field}.version`);
    if (params !== undefined && !plain(params)) return invalid(`${field}.params`);
    let requiredChecks: RecipeDefinition['requiredChecks'] | undefined;
    try { requiredChecks = validateExecutionContract({ requiredChecks: entry.requiredChecks }, field)?.requiredChecks; }
    catch (error) { return invalid(firstLine(error)); }
    if (!requiredChecks?.length) return invalid(`${field}.requiredChecks`);
    defs.push({ id, kind, version, requiredChecks, ...(params !== undefined ? { params } : {}) });
  }
  return defs;
}
async function loadDefinitions(projectRoot: string, commit: string): Promise<RecipeDefinition[] | Refusal> {
  let item;
  try {
    [item] = (await readRepositorySource(projectRoot, commit,
      [{ id: 'recipes', purpose: 'config', op: 'read', path: RECIPE_DEFINITIONS_PATH }])).items;
  } catch (error) { return { reason: 'recipe-source-unavailable', detail: firstLine(error) }; }
  if (item?.status === 'missing') return { reason: 'recipe-definitions-missing' };
  if (!item || item.status === 'unavailable') return { reason: 'recipe-source-unavailable', detail: item?.reason };
  if (item.status !== 'served' || item.content === undefined) return { reason: 'recipe-definitions-refused', detail: item.reason ?? item.status };
  return decodeDefinitions(item.content);
}
/** The kind's hooks in order: a refusal stops them and passes verbatim; a throw or malformed result is recipe-kind-failed. */
async function runKind(kind: RecipeKind, root: string, commit: string, inputs: RecipeInputs, def: RecipeDefinition):
  Promise<{ steps: RecipePlanStep[]; executionContract?: Record<string, unknown> } | Refusal> {
  const failed = (detail: string): Refusal => ({ reason: 'recipe-kind-failed', detail });
  try {
    for (const check of [() => kind.validateDefinition(def), () => kind.validateInputs(inputs, def)]) {
      const verdict: unknown = check();
      if (verdict !== null) return typeof verdict === 'string' && verdict !== '' ? { reason: verdict } : failed('malformed validation result');
    }
    const source: unknown = await kind.assessSource(root, commit, inputs, def);
    if (refused(source)) return { reason: source.reason };
    if (!plain(source) || source.ok !== true) return failed('malformed assessSource result');
    const plan: unknown = kind.instantiate(inputs, def, source.assessment, commit);
    if (refused(plan)) return { reason: plan.reason };
    return plain(plan) && plan.ok === true && Array.isArray(plan.steps)
      && (plan.executionContract === undefined || plain(plan.executionContract))
      ? { steps: plan.steps as RecipePlanStep[], executionContract: plan.executionContract } : failed('malformed instantiate result');
  } catch (error) { return failed(firstLine(error)); }
}
/** One recipe instantiated into the task's plan, or an ordinary-planning fallback. Never throws. */
export async function instantiateRecipe(state: StateManager, request: RecipeRequest): Promise<RecipeOutcome> {
  const taskId: unknown = request?.taskId; const recipeId: unknown = request?.recipeId;
  const fallback = async ({ reason, detail }: Refusal): Promise<RecipeOutcome> => {
    const outcome = { instantiated: false, fallback: 'ordinary-planning', reason: clip(reason),
      ...(detail === undefined ? {} : { detail: clip(detail) }) } as const;
    if (typeof taskId === 'string') { // Best effort: the fallback stands without the notice.
      await state.runExclusive(() => state.postSystemMessage(taskId,
        `Recipe ${clip(String(recipeId))} not instantiated (${outcome.reason}): ordinary planning applies.`)).catch(() => undefined);
    }
    return outcome;
  };
  try {
    const inputs = flatInputs(request.inputs);
    if (!isId(recipeId) || !inputs) return fallback({ reason: 'recipe-request-invalid' });
    const basis = await capturePlanSourceBasis(state.projectPath);
    if (!basis) return fallback({ reason: 'recipe-source-unavailable' });
    const defs = await loadDefinitions(state.projectPath, basis.commit);
    if (!Array.isArray(defs)) return fallback(defs);
    const def = defs.find(d => d.id === recipeId);
    if (!def) return fallback({ reason: 'recipe-not-found' });
    const kind = recipeKinds.get(def.kind);
    if (!kind) return fallback({ reason: 'recipe-kind-unknown' });
    // Bound before the hooks run, so a kind cannot alter what the record and the checks name.
    const instance = { recipeId, kind: def.kind, recipeVersion: def.version, definitionDigest: recipeDefinitionDigest(def),
      commit: basis.commit, inputs: { ...inputs }, inputsDigest: recipeInputsDigest(def, inputs) };
    const requiredChecks = def.requiredChecks.map(check => ({ ...check, configs: [...new Set([...check.configs ?? [], RECIPE_DEFINITIONS_PATH])] }));
    const plan = await runKind(kind, state.projectPath, basis.commit, inputs, def);
    if ('reason' in plan) return fallback(plan);
    const submitted = await submitRecipePlan(state, { taskId, steps: plan.steps,
      executionContract: { ...plan.executionContract, requiredChecks }, requiredCheckRevision: basis.commit }, instance);
    return { instantiated: true, status: submitted.status, planRevision: submitted.planRevision };
  } catch (error) {
    // Only submit_plan throws MoeError here: ownership, status, rails, size, paths and contract refusals.
    return fallback(error instanceof MoeError ? { reason: `recipe-plan-refused:${error.codeName}`, detail: firstLine(error) }
      : { reason: 'recipe-instantiation-failed', detail: firstLine(error) });
  }
}

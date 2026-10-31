/**
 * The docs-literal-replace recipe kind (CQ-C09): replace one unique literal in one committed *.md file that the
 * definition's params.allowedPaths cover. Hooks read committed bytes only (readRepositorySource), never the worktree,
 * and never throw: every failure is a docs-replace-* refusal, so C08 falls back to ordinary planning.
 * Importing this module registers the kind.
 */
import { createHash } from 'node:crypto';
import type { RecipeDefinition, RecipeInstance } from '../../types/schema.js';
import { normalizeAffectedFile } from '../../util/affectedFiles.js';
import { openProjectGit } from '../../util/cachedPlanPaths.js';
import { MAX_STEP_DESCRIPTION_CHARS } from '../../util/planSize.js';
import { readRepositorySource, SOURCE_LIMITS, type SourceItem } from '../repositorySource.js';
import { recipeDefinitionDigest, recipeInputsDigest, recipeKinds, type RecipeInputs, type RecipeKind } from './recipe.js';

type Inputs = { path: string; originalSha256: string; oldText: string; newText: string };
type Assessment = { oid: string; offset: number; expectedSha256: string };
type Refusal = { ok: false; reason: string; detail?: string };
const INPUT_KEYS = ['newText', 'oldText', 'originalSha256', 'path'];
const MAX_TEXT_CHARS = 2000;
const MAX_ALLOWED_PATHS = 16;
const MAX_DIFF_BYTES = 1048576;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RAW_HEADER = /^:[0-7]{6} [0-7]{6} (?:[0-9a-f]{40} [0-9a-f]{40}|[0-9a-f]{64} [0-9a-f]{64}) [ADMTUX]$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const no = (reason: string, detail?: string): Refusal =>
  ({ ok: false, reason: `docs-replace-${reason}`, ...(detail === undefined ? {} : { detail }) });
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const wellFormed = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;
const isMoe = (p: string) => /^\.moe(?:\/|$)/i.test(p);
const replaceAt = (content: string, offset: number, { oldText, newText }: Inputs) =>
  content.slice(0, offset) + newText + content.slice(offset + oldText.length);

/** A canonical repo-relative path: what normalizeAffectedFile returns unchanged, with no control characters. */
function canonicalPath(p: unknown): p is string {
  try { return typeof p === 'string' && !CONTROL.test(p) && wellFormed(p) && normalizeAffectedFile(p) === p; } catch { return false; }
}
/** params is exactly {allowedPaths}: 1-16 canonical prefixes, none under .moe; else null. */
function allowedPaths(def: RecipeDefinition): string[] | null {
  const params = def.params;
  if (!params || Object.keys(params).join() !== 'allowedPaths' || !Array.isArray(params.allowedPaths)) return null;
  const list: unknown[] = params.allowedPaths;
  return list.length >= 1 && list.length <= MAX_ALLOWED_PATHS && list.every(p => canonicalPath(p) && !isMoe(p)) ? list as string[] : null;
}
/** The committed item at `path`, or null when Git or IO failed. */
async function readDoc(projectRoot: string, commit: string, path: string): Promise<SourceItem | null> {
  try {
    return (await readRepositorySource(projectRoot, commit, [{ id: 'doc', purpose: 'source', op: 'read', path }])).items[0] ?? null;
  } catch { return null; }
}
/** Whole UTF-8 text of a regular 100644 file; symlinks, gitlinks, binary, truncated and missing files have none. */
const textOf = (item: SourceItem | null) =>
  item?.status === 'served' && item.mode === '100644' && typeof item.content === 'string' ? item.content : null;

async function assessSource(projectRoot: string, commit: string, raw: RecipeInputs):
  Promise<{ ok: true; assessment: Assessment } | Refusal> {
  const inputs = raw as Inputs;
  const item = await readDoc(projectRoot, commit, inputs.path);
  const content = textOf(item);
  if (content === null || !item?.oid) return no('source-unavailable');
  // The provider decodes fatal UTF-8 and keeps a BOM, so re-encoding gives back the committed bytes.
  if (sha256(content) !== inputs.originalSha256) return no('hash-mismatch');
  const offset = content.indexOf(inputs.oldText);
  if (offset < 0) return no('old-text-missing');
  // From offset + 1, so an overlapping repeat ('aa' in 'aaa') counts too.
  if (content.indexOf(inputs.oldText, offset + 1) >= 0) return no('old-text-ambiguous');
  const patched = replaceAt(content, offset, inputs);
  // The post-patch check must be able to read the whole patched file.
  if (Buffer.byteLength(patched) > SOURCE_LIMITS.maxFileBytes) return no('source-unavailable');
  return { ok: true, assessment: { oid: item.oid, offset, expectedSha256: sha256(patched) } };
}

function instantiate(raw: RecipeInputs, def: RecipeDefinition, assessment: unknown, commit: string) {
  const { path, originalSha256, oldText, newText } = raw as Inputs;
  const { oid, offset, expectedSha256 } = assessment as Assessment;
  const commands = def.requiredChecks.map(check => check.command);
  const description = [
    `Replace the single literal ${JSON.stringify(oldText)} in ${path} with ${JSON.stringify(newText)} (UTF-16 offset ${offset}).`,
    `Afterwards ${path} must hash to sha256 ${expectedSha256}; change nothing else, in this file or any other.`,
    `For error handling: if ${path} no longer hashes to sha256 ${originalSha256}, or the literal is not in it exactly once, `
      + 'stop and call moe.report_blocked rather than edit.',
    `Then run each required test: ${commands.join('; ')}.`,
  ].join('\n');
  // Refuse rather than truncate: a clipped literal would instruct a different edit.
  if (description.length > MAX_STEP_DESCRIPTION_CHARS) return no('plan-too-large');
  return { ok: true as const, steps: [{ description, affectedFiles: [path] }], executionContract: {
    intendedBehavior: `Replace one literal in ${path}; every other byte stays as committed.`,
    acceptanceCriteria: [`${path} hashes to sha256 ${expectedSha256}.`, `No path other than ${path} changes.`],
    approvedScope: [path],
    sourceAssumptions: [`${path} at commit ${commit}: blob ${oid}, sha256 ${originalSha256}, the literal once at UTF-16 offset ${offset}.`],
    checkRefs: commands,
  } };
}

/** Every path that differs between two commits, or null when Git failed or printed anything unparsable. */
async function changedPaths(projectRoot: string, base: string, post: string): Promise<string[] | null> {
  try {
    const git = await openProjectGit(projectRoot);
    const raw = await git('diff-tree', ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', `${base}^{commit}`, `${post}^{commit}`], { maxBuffer: MAX_DIFF_BYTES });
    if (raw && !raw.endsWith('\0')) return null;
    const fields = raw ? raw.slice(0, -1).split('\0') : [];
    const paths = fields.filter((_, index) => index % 2 === 1);
    return fields.length % 2 === 0 && fields.every((field, index) => (index % 2 ? field !== '' : RAW_HEADER.test(field))) ? paths : null;
  } catch { return null; }
}

/**
 * The candidate postCommit against the bound instance. postCommit must hold only this task's changes on top of
 * instance.commit: two exact commits are compared, never a range, so interleaved peer commits fail closed as extra
 * edits. Only the task's own board record (.moe/tasks/<taskId>.json, which the wrapper lands with it) is ignored.
 */
async function assessPostpatch(projectRoot: string, ctx: { taskId: string; instance: RecipeInstance; definition: RecipeDefinition;
  postCommit: string }): Promise<{ ok: true } | Refusal> {
  try {
    const { taskId, instance, definition, postCommit } = ctx;
    if (definition.kind !== docsLiteralReplace.name || instance.kind !== definition.kind || instance.recipeId !== definition.id
        || instance.recipeVersion !== definition.version || instance.definitionDigest !== recipeDefinitionDigest(definition)) {
      return no('recipe-mismatch');
    }
    if (instance.inputsDigest !== recipeInputsDigest(definition, instance.inputs)
        || docsLiteralReplace.validateInputs(instance.inputs, definition) !== null) return no('inputs-changed');
    if (!COMMIT.test(postCommit) || !COMMIT.test(instance.commit)) return no('postpatch-unavailable');
    const inputs = instance.inputs as Inputs;
    const changed = await changedPaths(projectRoot, instance.commit, postCommit);
    if (!changed) return no('postpatch-unavailable');
    const extra = changed.filter(p => p !== inputs.path && p !== `.moe/tasks/${taskId}.json`);
    if (extra.length) return no('extra-edits', extra.slice(0, 20).join(', '));
    if (!changed.includes(inputs.path)) return no('patch-missing');
    const original = await assessSource(projectRoot, instance.commit, inputs);
    if (!original.ok) return no(original.reason === 'docs-replace-source-unavailable' ? 'postpatch-unavailable' : 'postpatch-mismatch');
    const post = await readDoc(projectRoot, postCommit, inputs.path);
    if (!post || post.status === 'unavailable') return no('postpatch-unavailable');
    const content = textOf(post);
    return content !== null && sha256(content) === original.assessment.expectedSha256 ? { ok: true } : no('postpatch-mismatch');
  } catch { return no('postpatch-unavailable'); }
}

export const docsLiteralReplace = {
  name: 'docs-literal-replace',
  validateDefinition: (def: RecipeDefinition) => (allowedPaths(def) ? null : 'docs-replace-definition-invalid'),
  validateInputs(inputs: RecipeInputs, def: RecipeDefinition): string | null {
    const prefixes = allowedPaths(def);
    if (!prefixes) return 'docs-replace-definition-invalid';
    if (Object.keys(inputs).sort().join() !== INPUT_KEYS.join() || !Object.values(inputs).every(v => typeof v === 'string')) {
      return 'docs-replace-inputs-invalid';
    }
    const { path, originalSha256, oldText, newText } = inputs as Inputs;
    if (!canonicalPath(path) || !/^[0-9a-f]{64}$/.test(originalSha256) || !oldText || oldText.length > MAX_TEXT_CHARS
        || newText.length > MAX_TEXT_CHARS || [oldText, newText].some(t => t.includes('\0') || !wellFormed(t)) || newText === oldText) {
      return 'docs-replace-inputs-invalid';
    }
    // Whole segments: 'docs' covers docs/a.md, never docsx/a.md.
    return path.endsWith('.md') && !isMoe(path) && prefixes.some(p => path === p || path.startsWith(`${p}/`))
      ? null : 'docs-replace-path-not-allowed';
  },
  assessSource,
  instantiate,
  assessPostpatch,
} satisfies RecipeKind;

recipeKinds.set(docsLiteralReplace.name, docsLiteralReplace);

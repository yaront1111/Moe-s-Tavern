// =============================================================================
// check-architecture — the CQ-V10 command over the pure architectureRules engine
// =============================================================================
//
// Run as a protected required check in the runner's frozen gate workspace: it
// evaluates the committed candidate (HEAD) against its base (HEAD^) through
// bounded read-only Git, reading committed bytes only — never the worktree or
// the index. Exit 0 passed, 1 failed, 2 inconclusive or unavailable: every
// uncertainty is a non-pass. The rules document and this checker are protected
// by V01 requiredChecks configs/scripts; a run alone cannot see their drift.

import { evaluateArchitecture, parseArchitectureRules, type ArchitectureRules } from '../delivery/architectureRules.js';
import { readRepositorySource, validateSourceRequest, type SourcePurpose } from '../context/repositorySource.js';
import { openProjectGit, runGit } from '../util/cachedPlanPaths.js';
import { MoeError } from '../util/errors.js';

export interface CheckArchitectureResult { exitCode: 0 | 1 | 2; report: Record<string, unknown> }
interface Args { rules: string; base?: string; tree: string }
interface Unreadable { path: string; status: string; reason: string }
type ProjectGit = Awaited<ReturnType<typeof openProjectGit>>;

const OPTIONS = ['--rules', '--base', '--tree'];
const GIT_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 10_000;
/** Four reads of at most 64 KiB fit readRepositorySource's 256 KiB total, so a served file is never omitted. */
const READ_BATCH = 4;
const DIFF_MAX_BYTES = 4 * 1024 * 1024;
const TREE_MAX_BYTES = 16 * 1024 * 1024;
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNREAD = 'import(unread);\n';

/** A named exit-2 refusal; `extra` lands in the report beside it. */
class Unavailable extends Error {
  constructor(readonly reason: string, readonly extra: Record<string, unknown> = {}) { super(reason); }
}
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 500);
function describe(error: unknown): string {
  const context = error instanceof MoeError ? error.context : undefined;
  return context && typeof context.field === 'string' ? `${context.field}: ${String(context.reason)}` : firstLine(error);
}
const usage = (detail: string) => new Unavailable('usage', { detail });

function parseArgv(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!OPTIONS.includes(flag) || values.has(flag)) throw usage(`unexpected argument ${JSON.stringify(flag).slice(0, 100)}`);
    // A leading '-' could reach Git as an option; revisions and paths never need one.
    if (value === undefined || value === '' || value.startsWith('-')) throw usage(`${flag} needs a value not starting with '-'`);
    values.set(flag, value);
  }
  const rules = values.get('--rules');
  if (rules === undefined) throw usage('--rules <repository path> is required');
  try {
    validateSourceRequest('0'.repeat(40), [{ id: 'rules', purpose: 'config', op: 'read', path: rules }]);
  } catch { throw usage('--rules must be an exact normalized repository-relative path'); }
  return { rules, base: values.get('--base'), tree: values.get('--tree') ?? 'HEAD' };
}

async function resolveRevisions(git: ProjectGit, args: Args): Promise<{ base: string; tree: string }> {
  const commitOf = async (rev: string) => {
    let id: string;
    try {
      id = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
    } catch (error) { throw new Unavailable('revision-unresolved', { detail: firstLine(error) }); }
    if (!COMMIT_ID.test(id)) throw new Unavailable('revision-unresolved', { detail: `${rev} did not resolve to one commit` });
    return id;
  };
  const tree = await commitOf(args.tree);
  return { base: await commitOf(args.base ?? `${tree}^1`), tree };
}

/** Added, modified and type-changed paths; a deletion cannot add an import. No rename pairing. */
async function changedPaths(git: ProjectGit, base: string, tree: string): Promise<string[]> {
  let output: string;
  try {
    output = await git('diff-tree', ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--name-status', base, tree], { maxBuffer: DIFF_MAX_BYTES });
  } catch (error) { throw new Unavailable('diff-unavailable', { detail: firstLine(error) }); }
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Unavailable('diff-unavailable', { detail: 'unparsable diff-tree output' });
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === 'D') continue;
    if (!['A', 'M', 'T'].includes(fields[i])) {
      throw new Unavailable('diff-unavailable', { detail: `unexpected status ${fields[i]} for ${fields[i + 1]}` });
    }
    paths.push(fields[i + 1]);
  }
  return paths;
}

async function treePaths(git: ProjectGit, tree: string): Promise<Set<string>> {
  try {
    const output = await git('ls-tree', ['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree], { maxBuffer: TREE_MAX_BYTES });
    return new Set(output.split('\0').filter(Boolean));
  } catch (error) { throw new Unavailable('tree-unavailable', { detail: firstLine(error) }); }
}

/** Committed bytes at `commit`; anything not served in full (cap, symlink, gitlink, binary, missing) is unreadable. */
async function readAll(cwd: string, commit: string, paths: string[], purpose: SourcePurpose) {
  const texts = new Map<string, string>();
  const unreadable: Unreadable[] = [];
  for (let start = 0; start < paths.length; start += READ_BATCH) {
    const batch = paths.slice(start, start + READ_BATCH);
    try {
      const queries = batch.map((path, i) => ({ id: `q${start + i}`, purpose, op: 'read' as const, path }));
      const { items } = await readRepositorySource(cwd, commit, queries, { limits: { timeBudgetMs: READ_BUDGET_MS } });
      items.forEach((item, i) => {
        if (item.status === 'served' && item.content !== undefined) texts.set(batch[i], item.content);
        else unreadable.push({ path: batch[i], status: item.status, reason: item.reason ?? 'not-served' });
      });
    } catch (error) {
      for (const path of batch) unreadable.push({ path, status: 'refused', reason: describe(error) });
    }
  }
  return { texts, unreadable };
}

/** Exactly the files evaluateArchitecture scans: a scanned extension under some rule's `from`. */
const scanned = (rules: ArchitectureRules, path: string) => SCANNED_EXTENSIONS.some(ext => path.endsWith(ext))
  && rules.rules.some(rule => rule.from.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));

async function check(args: Args, cwd: string): Promise<CheckArchitectureResult> {
  let git: ProjectGit;
  try { git = await openProjectGit(cwd, runGit, GIT_BUDGET_MS); }
  catch (error) { throw new Unavailable('repository-unavailable', { detail: firstLine(error) }); }
  const { base, tree } = await resolveRevisions(git, args);
  const where = { base, tree, rules: args.rules };
  const changed = await changedPaths(git, base, tree);
  const paths = await treePaths(git, tree);
  const rulesRead = await readAll(cwd, tree, [args.rules], 'config');
  if (rulesRead.unreadable.length) throw new Unavailable('rules-unreadable', { ...where, unreadable: rulesRead.unreadable });
  let rules: ArchitectureRules;
  try { rules = parseArchitectureRules(rulesRead.texts.get(args.rules)!); }
  catch (error) { throw new Unavailable('rules-invalid', { ...where, detail: describe(error) }); }
  const sources = await readAll(cwd, tree, changed.filter(path => scanned(rules, path)), 'source');
  if (sources.unreadable.length) throw new Unavailable('source-unreadable', { ...where, unreadable: sources.unreadable });
  let result: ReturnType<typeof evaluateArchitecture>;
  try {
    // An unread path only selects rules. Should the engine ever scan one, the sentinel is a dynamic import: inconclusive, never a pass.
    result = evaluateArchitecture(rules, changed.map(path => ({ path, text: sources.texts.get(path) ?? UNREAD })), paths);
  } catch (error) { throw new Unavailable('changed-invalid', { ...where, detail: describe(error) }); }
  const { outcome, selectedRules, violations, uncertain } = result;
  const reason = [...new Set(uncertain.map(entry => entry.reason))].sort().join(',');
  // Outcome last: a runner keeps the output's tail.
  return { exitCode: outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : 2,
    report: { ...where, selectedRules, violations, uncertain, outcome, ...(outcome === 'inconclusive' ? { reason } : {}) } };
}

/** Never throws: every Git, read or parse failure is exit 2 with a named `reason`. */
export async function runCheckArchitecture(argv: string[], cwd: string): Promise<CheckArchitectureResult> {
  try {
    return await check(parseArgv(argv), cwd);
  } catch (error) {
    const named = error instanceof Unavailable ? error : new Unavailable('internal', { detail: firstLine(error) });
    return { exitCode: 2, report: { ...named.extra, outcome: 'unavailable', reason: named.reason } };
  }
}

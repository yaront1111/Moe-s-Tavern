// Approved definitions and daemon-measured identity, never verification evidence.
import { createHash } from 'node:crypto';
import type { ProtectedCheckDefinition, RequiredCheckSnapshot, Task } from '../types/schema.js';
import { validateExecutionContract } from '../state/validators.js';
import { normalizeAffectedFile } from '../util/affectedFiles.js';
import { openProjectGit, runGit } from '../util/cachedPlanPaths.js';
import { invalidInput } from '../util/errors.js';

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

/**
 * The one architecture check a verified-local task may deliver on (task-efbf1742): the installed
 * `moe-daemon` bin, which the runner provisions from a trusted install built at the base revision
 * (CQ-V12 activation). Single spaces, and no quote, operator, variable, glob, redirection or newline,
 * so nothing can run before or after it or change what runs.
 */
export const INSTALLED_ARCHITECTURE_CHECK = /^moe-daemon check-architecture(?: [A-Za-z0-9._\/=:@+^~-]+)*$/;
const CHECKER_SOURCES = ['src/commands/checkArchitecture.ts', 'src/delivery/architectureRules.ts'];

/**
 * Ids, in definition order, of the architecture checks not in the installed form. `node
 * packages/moe-daemon/dist/index.js check-architecture` runs code the candidate builds: index.ts loads
 * every module the daemon imports, and a definition protects only the files it names, so an
 * unprotected import (repositorySource, cachedPlanPaths, logger, ...) could serve '' content or
 * override stdout and exitCode. A def is an architecture check when its command mentions the checker
 * or its engine, or it protects the checker's sources (an npm-script wrapper): a listed path, or one
 * of the approved snapshot's `entries` under a listed directory. Pure and never throws: a malformed
 * def counts as an architecture check that is not installed. policy.ts judges settings.qualityGate
 * here too, as a def that protects no files.
 */
export function untrustedArchitectureChecks(defs: readonly ProtectedCheckDefinition[], entries: readonly { path: string }[] = []): string[] {
  return defs.filter((def) => {
    const command: unknown = def?.command;
    const lists: unknown[] = PATH_KINDS.map((kind) => def?.[kind] ?? []);
    if (typeof command !== 'string' || !lists.every((l) => Array.isArray(l) && l.every((p) => typeof p === 'string'))) return true;
    const roots = (lists as string[][]).flat();
    const covered = entries.map((e) => e?.path).filter((p): p is string => typeof p === 'string' && roots.some((root) => covers(root, p)));
    const architecture = /check-?architecture|architecture-?rules/i.test(command)
      || [...roots, ...covered].some((p) => CHECKER_SOURCES.some((source) => p.endsWith(source)));
    return architecture && !INSTALLED_ARCHITECTURE_CHECK.test(command.trim());
  }).map((def) => String(def?.id));
}

const MAX_ENTRIES = 2000;
const OID = /^[0-9a-f]{40}$/;
export const requiredCheckGit = { run: runGit };
const comparePaths = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const covers = (root: string, file: string) => file === root || file.startsWith(`${root}/`);

function normalizedPath(value: unknown): value is string {
  try {
    // The shared Git reader decodes UTF-8. Reject replacement characters (even
    // literal ones) and lone surrogates rather than approve ambiguous names.
    return typeof value === 'string' && normalizeAffectedFile(value) === value
      && !value.includes('\ufffd') && Buffer.from(value).toString('utf8') === value
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
  } catch { return false; }
}

function parseEntries(listing: string): RequiredCheckSnapshot['entries'] {
  if (!listing) return [];
  if (!listing.endsWith('\0')) throw new Error('ls-tree: unterminated output');
  const records = listing.slice(0, -1).split('\0');
  if (records.length > MAX_ENTRIES) throw new Error('ls-tree: more than 2000 entries');
  const entries = records.map(record => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!match || !normalizedPath(match[3])) throw new Error('ls-tree: malformed blob record or path');
    return { path: match[3], oid: match[2] };
  }).sort((a, b) => comparePaths(a.path, b.path));
  if (entries.some((e, i) => i > 0 && e.path === entries[i - 1].path)) throw new Error('ls-tree: duplicate path');
  return entries;
}

/** Read-only, outside the state mutex. Pin a tree once; refuse on any uncertainty. */
export async function measureRequiredCheckSnapshot(
  projectRoot: string, defs: readonly ProtectedCheckDefinition[], revision = 'HEAD', run = requiredCheckGit.run,
): Promise<RequiredCheckSnapshot> {
  let field = 'executionContract.requiredChecks';
  if (revision !== 'HEAD' && !OID.test(revision)) throw invalidInput('requiredCheckRevision', 'expected a 40-hex commit or tree id');
  try {
    const validated = validateExecutionContract({ requiredChecks: defs })?.requiredChecks ?? [];
    const paths = protectedPaths(validated);
    const git = await openProjectGit(projectRoot, run, 5000);
    field = 'requiredCheckRevision';
    const tree = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${revision}^{tree}`])).trim();
    if (!OID.test(tree)) throw new Error('rev-parse --verify: revision did not resolve to a 40-hex tree id');
    field = 'executionContract.requiredChecks';
    // With no pathspec Git lists the ENTIRE tree, not an empty protected set.
    const listing = paths.length ? await git('ls-tree', ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree',
      tree, '--', ...new Set(paths.map(p => p.path))], { maxBuffer: 1024 * 1024 }) : '';
    const entries = parseEntries(listing);
    for (const p of paths) {
      if (p.kind !== 'assertionRoots' && !entries.some(e => covers(p.path, e.path))) {
        throw new Error(`ls-tree: protected ${p.kind} path ${p.path} has no blobs at the revision`);
      }
    }
    if (entries.some(e => !paths.some(p => covers(p.path, e.path)))) throw new Error('ls-tree: unexpected unprotected path');
    return { version: 1, revision: tree, definitionDigest: definitionDigest(validated), entries };
  } catch (error) {
    throw invalidInput(field, (error instanceof Error ? error.message : String(error)).split(/[\r\n]/)[0].slice(0, 500));
  }
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

/** Decode untrusted persisted state, and detach it. A stale/malformed snapshot is unusable. */
export function readRequiredCheckSnapshot(task: Task): RequiredCheckSnapshot | null {
  try {
    const defs = validateExecutionContract(task.executionContract)?.requiredChecks;
    const value: unknown = task.requiredCheckSnapshot;
    if (!defs?.length || !exactKeys(value, ['version', 'revision', 'definitionDigest', 'entries'])
        || value.version !== 1 || typeof value.revision !== 'string' || !OID.test(value.revision)
        || typeof value.definitionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.definitionDigest)
        || value.definitionDigest !== definitionDigest(defs) || !Array.isArray(value.entries)
        || value.entries.length > MAX_ENTRIES) return null;
    const entries: RequiredCheckSnapshot['entries'] = [];
    for (const entry of value.entries) {
      if (!exactKeys(entry, ['path', 'oid']) || !normalizedPath(entry.path)
          || typeof entry.oid !== 'string' || !OID.test(entry.oid)
          || (entries.length > 0 && comparePaths(entries[entries.length - 1].path, entry.path) >= 0)) return null;
      entries.push({ path: entry.path, oid: entry.oid });
    }
    return { version: 1, revision: value.revision, definitionDigest: value.definitionDigest, entries };
  } catch { return null; }
}

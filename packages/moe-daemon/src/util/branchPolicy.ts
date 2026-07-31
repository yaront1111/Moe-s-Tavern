/**
 * Branch policy matching for `settings.consolidationBranch`.
 *
 * Kept out of the tool so the glob has exactly one definition and can be unit
 * tested on its own — a bad matcher either waves through completions on the
 * wrong branch or blocks every completion, and both are expensive.
 */

/** Regex metacharacters that must not survive into the compiled pattern. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Bounds that keep the compiled pattern from becoming a ReDoS. `branch` is
 * caller-supplied over /mcp and otherwise unbounded, and a pattern with many
 * `*` compiles to many chained `.*` — the same ambiguity flagged for
 * appendOnlyFiles' `**` expansion. A real git branch is far under 255 chars and
 * real patterns carry one wildcard, so both caps only ever reject nonsense.
 */
const MAX_BRANCH_LENGTH = 255;
const MAX_GLOB_WILDCARDS = 10;

/**
 * Does `branch` satisfy `pattern`? `pattern` is either a literal branch name or
 * a glob whose only wildcard is `*` (matching any run of characters, including
 * an empty one). Matching is anchored at both ends and case-sensitive, because
 * git branch names are.
 *
 * Returns false — never throws — for a non-string, empty or over-long branch,
 * an empty pattern, a pattern with an absurd number of wildcards, or a pattern
 * that somehow fails to compile: neither a malformed setting nor a hostile
 * argument may crash or hang `complete_task`.
 */
export function matchesBranchPattern(branch: string, pattern: string): boolean {
  if (typeof branch !== 'string' || typeof pattern !== 'string') return false;
  if (!branch || !pattern) return false;
  if (branch.length > MAX_BRANCH_LENGTH) return false;
  if (!pattern.includes('*')) return branch === pattern;
  if ((pattern.match(/\*/g) || []).length > MAX_GLOB_WILDCARDS) return false;

  try {
    // Escape EVERY metacharacter first (this turns `*` into `\*`), then expand
    // only those placeholders. Expanding before escaping would let a pattern
    // like `release/v1.0-*` match `release/v1X0-a`, and an unescaped `(` would
    // throw at compile time. Adjacent wildcards collapse to one `.*` so `**`
    // cannot introduce an ambiguous star pair.
    const source = pattern
      .replace(REGEX_METACHARACTERS, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/(?:\.\*)+/g, '.*');
    return new RegExp(`^${source}$`).test(branch);
  } catch {
    return false;
  }
}

/**
 * The teaching message body for a branch-policy rejection. Lives here so the
 * tool and its tests cannot drift on the wording.
 */
export function describeBranchPolicyFailure(branch: string, pattern: string): string {
  return `this task was completed on branch "${branch}", but this project requires "${pattern}". `
    + 'Switch to the sanctioned branch (the agent wrapper post-flight peels onto '
    + 'moe/work-<YYYY-MM-DD> for you), move your commits onto it, then call moe.complete_task again.';
}

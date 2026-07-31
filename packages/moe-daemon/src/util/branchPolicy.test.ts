import { describe, it, expect } from 'vitest';
import { describeBranchPolicyFailure, matchesBranchPattern } from './branchPolicy.js';

describe('matchesBranchPattern', () => {
  it('matches a literal pattern exactly', () => {
    expect(matchesBranchPattern('main', 'main')).toBe(true);
    expect(matchesBranchPattern('develop', 'main')).toBe(false);
    expect(matchesBranchPattern('mainline', 'main')).toBe(false);
  });

  it('is case-sensitive, like git branch names', () => {
    expect(matchesBranchPattern('Main', 'main')).toBe(false);
    expect(matchesBranchPattern('MOE/Work-1', 'moe/work-*')).toBe(false);
  });

  it('matches the wrapper branch scheme with a trailing glob', () => {
    expect(matchesBranchPattern('moe/work-2026-07-31', 'moe/work-*')).toBe(true);
    // `*` may match empty, so the bare prefix WITH the separator matches...
    expect(matchesBranchPattern('moe/work-', 'moe/work-*')).toBe(true);
    // ...but the separator itself is still required.
    expect(matchesBranchPattern('moe/work', 'moe/work-*')).toBe(false);
  });

  it('anchors both ends so a prefixed branch does not sneak through', () => {
    expect(matchesBranchPattern('feature/moe/work-1', 'moe/work-*')).toBe(false);
    expect(matchesBranchPattern('moe/work-1/nested', 'moe/work-*')).toBe(true);
  });

  it('supports a leading glob', () => {
    expect(matchesBranchPattern('urgent-hotfix', '*-hotfix')).toBe(true);
    expect(matchesBranchPattern('-hotfix', '*-hotfix')).toBe(true);
    expect(matchesBranchPattern('hotfix', '*-hotfix')).toBe(false);
    expect(matchesBranchPattern('urgent-hotfix-2', '*-hotfix')).toBe(false);
  });

  it('escapes regex metacharacters instead of letting them widen the match', () => {
    expect(matchesBranchPattern('release/v1.0-rc1', 'release/v1.0-*')).toBe(true);
    expect(matchesBranchPattern('release/v1X0-a', 'release/v1.0-*')).toBe(false);
    expect(matchesBranchPattern('release/v1+0-a', 'release/v1.0-*')).toBe(false);
  });

  it('treats an empty branch or empty pattern as no match', () => {
    expect(matchesBranchPattern('', 'main')).toBe(false);
    expect(matchesBranchPattern('main', '')).toBe(false);
    expect(matchesBranchPattern('', '')).toBe(false);
    expect(matchesBranchPattern('', '*')).toBe(false);
  });

  it('matches any non-empty branch against a bare glob', () => {
    expect(matchesBranchPattern('main', '*')).toBe(true);
    expect(matchesBranchPattern('moe/work-2026-07-31', '*')).toBe(true);
  });

  it('rejects inputs that are not strings at all', () => {
    // `currentBranch` arrives over /mcp and settings can be hand-edited, so
    // neither side is guaranteed to be a string at runtime.
    expect(matchesBranchPattern(undefined as unknown as string, 'main')).toBe(false);
    expect(matchesBranchPattern('main', null as unknown as string)).toBe(false);
    expect(matchesBranchPattern(42 as unknown as string, '*')).toBe(false);
  });

  it('bounds the branch length and the wildcard count instead of backtracking', () => {
    const nasty = `${'a*'.repeat(40)}b`;
    const long = 'a'.repeat(4000);

    const started = Date.now();
    expect(matchesBranchPattern(long, 'moe/work-*')).toBe(false);
    expect(matchesBranchPattern('a'.repeat(200), nasty)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);

    // The caps are generous enough that real branches and patterns pass.
    expect(matchesBranchPattern('a'.repeat(255), '*')).toBe(true);
    expect(matchesBranchPattern('a'.repeat(256), '*')).toBe(false);
    expect(matchesBranchPattern('moe/work-a-b', 'moe/*/*-*')).toBe(false);
    expect(matchesBranchPattern('moe/work/a-b', 'moe/*/*-*')).toBe(true);
  });

  it('collapses adjacent wildcards rather than compiling an ambiguous star pair', () => {
    expect(matchesBranchPattern('moe/work-2026', 'moe/work-**')).toBe(true);
    expect(matchesBranchPattern('moe/work-', 'moe/work-**')).toBe(true);
    expect(matchesBranchPattern('moe/work', 'moe/work-**')).toBe(false);
  });

  it('never throws on a pattern that would be an invalid regex unescaped', () => {
    expect(() => matchesBranchPattern('anything', 'feat/(unclosed')).not.toThrow();
    expect(matchesBranchPattern('anything', 'feat/(unclosed')).toBe(false);
    // Literal comparison still works — no regex is compiled without a glob.
    expect(matchesBranchPattern('feat/(unclosed', 'feat/(unclosed')).toBe(true);
    // And with a glob, the escaped paren is matched literally.
    expect(matchesBranchPattern('feat/(unclosed-1', 'feat/(unclosed-*')).toBe(true);
    expect(matchesBranchPattern('feat/unclosed-1', 'feat/(unclosed-*')).toBe(false);
  });
});

describe('describeBranchPolicyFailure', () => {
  it('names both the actual branch and the expected pattern', () => {
    const message = describeBranchPolicyFailure('main', 'moe/work-*');
    expect(message).toContain('"main"');
    expect(message).toContain('"moe/work-*"');
    expect(message).toContain('moe.complete_task');
  });
});

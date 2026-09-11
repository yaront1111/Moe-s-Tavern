/**
 * CONTRACT TEST: does the codex descriptor still describe the launchers?
 *
 * WHAT IT PROVES. Every literal the descriptor declares is PRESENT in the
 * launcher it is attributed to, and every literal it marks as diverging is
 * present in one launcher and ABSENT from the other.
 *
 * WHAT IT CANNOT PROVE. That the launchers assemble those tokens in the declared
 * order, or that the resulting command line is the one the descriptor's `value`
 * prose describes. Neither wrapper has a dry-run or print-argv mode; the only
 * argv introspection is the codex probe, which appends --help to the REAL argv
 * and prints nothing about the command line. Text presence is the strongest
 * assertion available, and a reader must not upgrade "the strings are there"
 * into "the command line matches". The decision note repeats this limitation
 * in its recommendation, not in a footnote.
 *
 * HOW IT STAYS ANCHORED.
 * - Comment-stripped: each wrapper names the other's flag spelling in a
 *   comment, so raw-text matching would let a divergence assertion pass on prose.
 * - Site-scoped: whole-file matching was measured too weak -- on 2026-09-11,
 *   22 of 65 declared literals ([mcp_servers.moe], MOE_WORKER_ID, config.toml,
 *   --help ...) also occur in the grok writer, the argument parser or the
 *   attribution code, and would have stayed green with every codex block
 *   deleted. Presence is checked only inside the codex branches, except for
 *   the facts in GLOBAL_FACT_PATHS. Absence is still checked against the whole
 *   other file, the stronger direction.
 * - Emitter-pinned: site scoping alone was ALSO measured too weak. The bash
 *   codex writer's merge filter repeats its own table headers as `startswith`
 *   arguments and names a python variable after a TOML key, all inside the same
 *   branch, so deleting the line that actually emits `[mcp_servers.moe]` (or the
 *   startup_timeout_sec append) left the earlier version of this suite green.
 *   Every fact under EMITTER_PINNED_PREFIXES must therefore carry per-wrapper
 *   `emitterEvidence` -- literals only the emitting line can satisfy -- and that
 *   requirement is itself asserted, so a new config fact cannot skip it.
 * - Descriptor `value` prose is never asserted; only evidence literals are.
 *
 * WHAT IS PINNED ONLY WEAKLY, stated rather than hidden (see UNPINNED_NOTES):
 * bash repeats the per-seat `-c` overrides at three sites (two launches and the
 * argv probe), each pinned separately; PowerShell appends them once to a splatted
 * array, so a PowerShell deletion necessarily hits both modes together. Facts
 * outside EMITTER_PINNED_PREFIXES -- session-mode banners, the sandbox
 * vocabulary, resume, the failure escalation text -- are pinned by site presence
 * only, which is enough while each of those literals occurs once per branch, and
 * is not claimed to be more than that.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CODEX_DESCRIPTOR } from './codexDescriptor.js';
import { REQUIRED_FACETS, WRAPPER_FILES } from './providerDescriptor.js';
import type { DivergentFact, ProviderDescriptor, SharedFact, UnsupportedFact, WrapperId } from './providerDescriptor.js';

// <root>/packages/moe-daemon/src/providers/<this file>
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..', '..', '..');
const WRAPPER_IDS: readonly WrapperId[] = ['bash', 'powershell'];

/** A codex branch opens at `start` and runs until the next other-provider branch. */
const BRANCH_ANCHORS: Record<WrapperId, { readonly start: RegExp; readonly end: RegExp }> = {
  bash: {
    start: /^(el)?if \[ "\$CLI_TYPE" = "codex" \]; then$/,
    end: /^(el)?if \[ "\$CLI_TYPE" = "(gemini|grok|claude)" \]; then$/,
  },
  powershell: {
    start: /^(\} elseif|if) \(\$cliType -eq "codex"\) \{$/,
    end: /^(\} elseif|if) \(\$cliType -eq "(gemini|grok|claude)"\) \{$/,
  },
};
/** A branch longer than this means an end anchor was missed and the region swallowed unrelated code. */
const MAX_BRANCH_LINES = 400;

/**
 * Facts whose evidence genuinely lives OUTSIDE every provider branch. Each entry
 * weakens its fact to whole-file matching, so the suite pins the list's size and
 * growing it is a deliberate, reviewable act.
 */
const GLOBAL_FACT_PATHS: Readonly<Record<string, string>> = {
  'sessionMode.defaultPolicy': 'the TUI polling suppression is one block shared by codex, gemini and grok',
  'terminalHandoff.pollingSuppressed': 'the same shared TUI block',
  'sessionMode.modes[1].optIn': 'flags are parsed in the argument parser, before any provider branch',
  'resume.wrapperRelaunch': 'resume is wrapper-level and provider-agnostic',
};

/**
 * Facts whose evidence must be pinned to the EMITTING line, not merely present
 * in the branch. Everything the wrappers write into a config file or put on
 * argv: those are the facts a migration would have to reproduce exactly, and
 * the ones the merge filters' repeated headers were hiding.
 */
const EMITTER_PINNED_PREFIXES = ['config.', 'argv.tokensByMode.', 'argv.perSeatOverrides'] as const;

/**
 * Honest disclosure of what the emitter pin does NOT reach. These are claims
 * about the scripts' shape, so no assertion can verify them; the test below only
 * keeps them present and non-trivial, so the caveat cannot be quietly dropped
 * while the suite stays green. Repeated in the decision note.
 */
const UNPINNED_NOTES = [
  'PowerShell builds one $codexSeatArgs array and splats it into both launches, so its two modes cannot be pinned independently -- a token dropped there is caught, but not attributed to a mode.',
  'Facts outside EMITTER_PINNED_PREFIXES (banners, sandbox vocabulary, resume, escalation text) are pinned by branch presence only.',
] as const;

/**
 * Full-line comments only. Both shells use `#`, and moe-agent.ps1 has no `<# #>`
 * block comments (asserted below). Trailing inline comments survive -- a known,
 * stated weakness.
 */
function stripFullLineComments(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * bash splits a launch invocation over four lines with `\` continuations. Join
 * them so the whole command line is one matchable string and a dropped `-c`
 * breaks it. PowerShell's launches are already single lines, so its view is left
 * alone rather than run through a transform that could only add false matches.
 */
function joinBashContinuations(source: string): string {
  return source.replace(/[ \t]*\\\r?\n[ \t]*/g, ' ');
}

function loadWrapper(id: WrapperId): string {
  const abs = path.join(repoRoot, WRAPPER_FILES[id]);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `provider contract test cannot find the ${id} launcher at ${abs} (repo root resolved to ${repoRoot}). ` +
        'Refusing to pass vacuously -- fix the path before trusting this suite.',
    );
  }
  return fs.readFileSync(abs, 'utf8');
}

interface WrapperView {
  readonly raw: string;
  /** The whole file, comment-stripped. */
  readonly code: string;
  /** Only the codex branches, comment-stripped. */
  readonly site: string;
  readonly branchSpans: readonly number[];
}

function buildView(id: WrapperId): WrapperView {
  const raw = loadWrapper(id);
  const all = raw.split(/\r?\n/);
  const siteLines: string[] = [];
  const branchSpans: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (!BRANCH_ANCHORS[id].start.test(all[i].trim())) continue;
    let j = i + 1;
    while (j < all.length && !BRANCH_ANCHORS[id].end.test(all[j].trim())) j++;
    branchSpans.push(j - i);
    siteLines.push(...all.slice(i, j));
    i = j - 1;
  }
  const normalize = id === 'bash' ? joinBashContinuations : (s: string) => s;
  return {
    raw,
    code: normalize(stripFullLineComments(raw)),
    site: normalize(stripFullLineComments(siteLines.join('\n'))),
    branchSpans,
  };
}

const views: Record<WrapperId, WrapperView> = { bash: buildView('bash'), powershell: buildView('powershell') };

/** Literal (never regex) containment against the whole comment-stripped file. */
function contains(id: WrapperId, literal: string): boolean {
  return views[id].code.includes(literal);
}

/** Presence at the construction site: the codex branches, unless the fact is allowlisted as global. */
function presentAtSite(id: WrapperId, literal: string, factPath: string): boolean {
  return factPath in GLOBAL_FACT_PATHS ? contains(id, literal) : views[id].site.includes(literal);
}

type Fact = SharedFact<unknown> | DivergentFact<unknown> | UnsupportedFact;
interface Located<F> {
  readonly path: string;
  readonly fact: F;
}

function isFact(value: unknown): value is Fact {
  if (typeof value !== 'object' || value === null || !('agreement' in value)) return false;
  return value.agreement === 'shared' || value.agreement === 'divergent' || value.agreement === 'unsupported';
}

/** Walks the whole descriptor so no declared fact can be missed by a hand-written assertion. */
function collectFacts(node: unknown, at: string, out: Located<Fact>[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectFacts(child, `${at}[${i}]`, out));
  } else if (isFact(node)) {
    out.push({ path: at, fact: node });
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) collectFacts(child, at ? `${at}.${key}` : key, out);
  }
}

const facts: Located<Fact>[] = [];
collectFacts(CODEX_DESCRIPTOR, '', facts);
const shared = facts.flatMap((f) => (f.fact.agreement === 'shared' ? [{ path: f.path, fact: f.fact }] : []));
const divergent = facts.flatMap((f) => (f.fact.agreement === 'divergent' ? [{ path: f.path, fact: f.fact }] : []));
const unsupported = facts.flatMap((f) => (f.fact.agreement === 'unsupported' ? [{ path: f.path, fact: f.fact }] : []));

describe('provider descriptor contract: fixtures are real', () => {
  it('reads both launchers off disk and they are substantial', () => {
    for (const id of WRAPPER_IDS) {
      expect(views[id].raw.length, `${WRAPPER_FILES[id]} is empty`).toBeGreaterThan(100_000);
      expect(views[id].code.split('\n').length, `${WRAPPER_FILES[id]} stripped to nothing`).toBeGreaterThan(1_000);
    }
  });

  it('moe-agent.ps1 uses no block comments, so full-line stripping is sufficient', () => {
    expect(views.powershell.raw).not.toContain('<#');
  });

  it('finds the codex branches in both launchers, each one bounded', () => {
    for (const id of WRAPPER_IDS) {
      const { branchSpans, site } = views[id];
      expect(branchSpans.length, `no codex branch found in ${WRAPPER_FILES[id]}`).toBeGreaterThan(0);
      for (const span of branchSpans) {
        expect(span, `a codex branch in ${WRAPPER_FILES[id]} ran past its end anchor`).toBeLessThanOrEqual(MAX_BRANCH_LINES);
      }
      // An anchor that matched but captured almost nothing would fail every site check for the wrong reason.
      expect(site.split('\n').length).toBeGreaterThan(200);
    }
  });

  it('the global allowlist names only real facts and stays short', () => {
    const known = new Set(facts.map((f) => f.path));
    for (const factPath of Object.keys(GLOBAL_FACT_PATHS)) {
      expect(known.has(factPath), `GLOBAL_FACT_PATHS names ${factPath}, which the descriptor does not declare`).toBe(true);
    }
    expect(Object.keys(GLOBAL_FACT_PATHS)).toHaveLength(4);
  });

  it('the matcher rejects a string that is not in either launcher', () => {
    // A `contains` that trivially returned true would make every presence assertion meaningless.
    const sentinel = 'MOE_THIS_LITERAL_DOES_NOT_EXIST_IN_ANY_LAUNCHER';
    for (const id of WRAPPER_IDS) {
      expect(contains(id, sentinel)).toBe(false);
      expect(views[id].site.includes(sentinel)).toBe(false);
    }
  });

  it('covers exactly one provider', () => {
    expect(CODEX_DESCRIPTOR.providerId).toBe('codex');
    const populated = fs.readdirSync(thisDir).filter((f) => f.endsWith('Descriptor.ts') && f !== 'providerDescriptor.ts');
    expect(populated, 'migrating a second provider is a follow-up the decision note decides').toEqual(['codexDescriptor.ts']);
  });
});

describe('provider descriptor contract: every DoD facet is populated', () => {
  it.each(REQUIRED_FACETS)('declares the %s facet', (facet) => {
    expect(CODEX_DESCRIPTOR[facet as keyof ProviderDescriptor]).toBeDefined();
  });

  it('collected a meaningful number of facts from the descriptor tree', () => {
    // A walker that silently found nothing would make this whole file vacuous.
    // 30 shared / 14 divergent / 3 unsupported as transcribed on 2026-09-11.
    expect(shared.length).toBeGreaterThanOrEqual(25);
    expect(divergent.length).toBeGreaterThanOrEqual(14);
    expect(unsupported.length).toBe(3);
  });

  it('states, rather than hides, what the emitter pin does not reach', () => {
    expect(UNPINNED_NOTES.length).toBeGreaterThan(0);
    for (const note of UNPINNED_NOTES) expect(note.length).toBeGreaterThan(40);
  });
});

describe('provider descriptor contract: shared facts appear in BOTH launchers', () => {
  it('every shared literal is present at the codex construction site of moe-agent.sh and moe-agent.ps1', () => {
    const missing: string[] = [];
    for (const { path: at, fact } of shared) {
      expect(fact.presentInBoth.length, `${at} declares no evidence`).toBeGreaterThan(0);
      for (const literal of fact.presentInBoth) {
        expect(literal.length, `${at} declares a too-short literal`).toBeGreaterThanOrEqual(3);
        for (const id of WRAPPER_IDS) {
          if (!presentAtSite(id, literal, at)) {
            missing.push(`${at}: ${JSON.stringify(literal)} absent from the codex branches of ${WRAPPER_FILES[id]}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every emitted fact declares per-wrapper emitter evidence, and that evidence is at the emitting line', () => {
    // presentInBoth alone stayed green when the line that actually writes the
    // value was deleted. This is the assertion that closed that hole; the
    // delete-the-emitter mutations in the decision note are its proof.
    const problems: string[] = [];
    let checked = 0;
    for (const { path: at, fact } of shared) {
      if (!EMITTER_PINNED_PREFIXES.some((prefix) => at.startsWith(prefix))) continue;
      const evidence = fact.emitterEvidence;
      if (!evidence) {
        problems.push(`${at} writes a value but declares no emitterEvidence -- branch presence is not enough here`);
        continue;
      }
      for (const id of WRAPPER_IDS) {
        const literals = evidence[id] ?? [];
        if (literals.length === 0) {
          problems.push(`${at} declares no emitterEvidence for ${WRAPPER_FILES[id]}`);
          continue;
        }
        for (const literal of literals) {
          checked++;
          // Long enough that it cannot be a bare key the merge filter repeats.
          if (literal.length < 12) problems.push(`${at}: emitter literal ${JSON.stringify(literal)} is too short to pin an emission`);
          if (!views[id].site.includes(literal)) {
            problems.push(`${at}: emitter literal ${JSON.stringify(literal)} absent from the codex branches of ${WRAPPER_FILES[id]}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked, 'no emitter evidence was checked at all -- the prefix filter matched nothing').toBeGreaterThanOrEqual(30);
  });

  it('pins each session mode to its own whole launch invocation', () => {
    // Without this, a -c deleted from one mode is covered by the other mode's
    // copy of the same token. The literal is the command line as written.
    const byMode = CODEX_DESCRIPTOR.argv.tokensByMode;
    expect(Object.keys(byMode).sort()).toEqual(['exec-headless', 'interactive-tui']);
    const seen = new Set<string>();
    for (const [modeId, fact] of Object.entries(byMode)) {
      expect(fact.agreement, `${modeId} argv must be a wrapper fact`).not.toBe('unsupported');
      const evidence = fact.agreement === 'shared' ? fact.emitterEvidence : undefined;
      expect(evidence, `${modeId} declares no launch invocation`).toBeDefined();
      for (const id of WRAPPER_IDS) {
        for (const literal of evidence?.[id] ?? []) {
          // A launch literal shared by two modes would prove nothing about either.
          expect(seen.has(`${id}:${literal}`), `${modeId} reuses another mode's ${id} launch literal`).toBe(false);
          seen.add(`${id}:${literal}`);
          expect(literal, `${modeId} ${id} launch literal is not a command line`).toContain('$');
        }
      }
    }
    // bash: two launches; PowerShell: two launches. One literal each.
    expect(seen.size).toBe(4);
  });
});

describe('provider descriptor contract: divergent facts really do diverge', () => {
  it('each side-specific literal is at its own construction site and absent from the whole other launcher', () => {
    const problems: string[] = [];
    for (const { path: at, fact } of divergent) {
      expect(fact.onlyInBash.length, `${at} claims divergence with no bash evidence`).toBeGreaterThan(0);
      expect(fact.onlyInPowershell.length, `${at} claims divergence with no PowerShell evidence`).toBeGreaterThan(0);
      expect(fact.divergenceReason.length, `${at} diverges without saying why`).toBeGreaterThan(20);
      const sides: readonly [WrapperId, WrapperId, readonly string[]][] = [
        ['bash', 'powershell', fact.onlyInBash],
        ['powershell', 'bash', fact.onlyInPowershell],
      ];
      for (const [own, other, literals] of sides) {
        for (const literal of literals) {
          if (!presentAtSite(own, literal, at)) {
            problems.push(`${at}: ${JSON.stringify(literal)} missing from the codex branches of ${WRAPPER_FILES[own]}`);
          }
          if (contains(other, literal)) {
            problems.push(`${at}: ${JSON.stringify(literal)} is NOT ${own}-only -- it is also in ${WRAPPER_FILES[other]}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('provider descriptor contract: unsupported markers stay honest', () => {
  it('each carries a reason and declares no evidence', () => {
    for (const { path: at, fact } of unsupported) {
      expect(fact.reason.length, `${at} is unsupported without a reason`).toBeGreaterThan(20);
      // Text presence cannot prove an absence, so an unsupported facet must not
      // smuggle in evidence literals that would imply it had been verified.
      expect(Object.keys(fact).sort(), `${at} carries evidence it cannot have`).toEqual(['agreement', 'reason']);
    }
  });
});

describe('provider descriptor contract: negative direction', () => {
  it('declares no failure code the launchers do not contain', () => {
    // The failure-code vocabulary is the one set genuinely enumerable from the
    // scripts, so this is the only honest negative assertion available.
    const vocabulary = new Set<string>();
    for (const id of WRAPPER_IDS) {
      for (const match of views[id].code.matchAll(/\bMOE_[A-Z0-9_]+\b/g)) vocabulary.add(match[0]);
    }
    expect(vocabulary.size, 'extracted no MOE_* codes at all -- the subset check would be vacuous').toBeGreaterThan(20);
    const declared = CODEX_DESCRIPTOR.failures.classes.map((c) => c.code);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((code) => !vocabulary.has(code)), 'descriptor declares failure codes that exist in neither launcher').toEqual([]);
  });

  it('forbidden tokens appear in neither launcher', () => {
    const regressions: string[] = [];
    expect(CODEX_DESCRIPTOR.argv.forbiddenTokens.length).toBeGreaterThan(0);
    for (const { token, reason } of CODEX_DESCRIPTOR.argv.forbiddenTokens) {
      expect(reason.length, `forbidden token ${token} has no reason`).toBeGreaterThan(20);
      for (const id of WRAPPER_IDS) {
        if (contains(id, token)) regressions.push(`${token} is back in ${WRAPPER_FILES[id]}`);
      }
    }
    expect(regressions).toEqual([]);
  });
});

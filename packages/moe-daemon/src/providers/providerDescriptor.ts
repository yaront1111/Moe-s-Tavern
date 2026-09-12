/**
 * PROVIDER LAUNCH DESCRIPTOR -- SPIKE ARTIFACT, NOT A RUNTIME COMPONENT.
 *
 * WHY THIS FILE IS HERE, AND WHY THAT IS PROVISIONAL.
 * It lives in the daemon package for exactly one reason: TypeScript and the
 * vitest suite that pins it already live here. That is a convenience, not a
 * design decision. The daemon is state-only -- it does not launch agents and
 * never runs git, and it MUST NOT start doing either because a type describing
 * launches happens to sit in its tree. Where a provider registry belongs if a
 * staged migration ever happens is one of the questions answered -- as a
 * recommendation, not a decision -- in
 * docs/plans/2026-09-11-provider-registry-spike.md.
 *
 * NOTHING IN THE DAEMON IMPORTS THIS. The only consumers are codexDescriptor.ts
 * (the single populated provider) and providerDescriptor.contract.test.ts.
 * Before adding a third importer, read the decision note: the launchers still
 * own launch policy, and driving behaviour from this data while the scripts
 * also build it is the specific failure mode the spike was run to avoid.
 *
 * WHAT THIS IS. Types for pure DATA transcribing what scripts/moe-agent.sh and
 * scripts/moe-agent.ps1 build for one provider TODAY -- not what they ought to
 * build. There is deliberately no function here that assembles a command line
 * and no branching logic: a descriptor that could be executed would invite
 * exactly the premature migration the epic rails forbid.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not flatten a difference between
 * the two launchers into one value. Every fact is either `shared` (both
 * wrappers) or `divergent` (per-wrapper values plus the reason), because
 * whether launch policy generalises at all is the question the spike exists to
 * answer, and hiding a divergence would answer it falsely.
 */

/** The two launcher scripts, repo-relative. The contract test reads these off disk. */
export const WRAPPER_FILES = {
  bash: 'scripts/moe-agent.sh',
  powershell: 'scripts/moe-agent.ps1',
} as const;

export type WrapperId = keyof typeof WRAPPER_FILES;

/**
 * A fact both launchers build identically. `presentInBoth` must appear in BOTH files.
 *
 * `presentInBoth` alone is a WEAK pin, measured so on 2026-09-11: the bash codex
 * writer's merge filter repeats its own table headers as `startswith` arguments
 * and names a python variable after a TOML key, so deleting the line that
 * actually EMITS `[mcp_servers.moe]` left a site-scoped presence check green.
 * `emitterEvidence` is the fix: per-wrapper literals that only the emitting line
 * can satisfy. The contract test REQUIRES it for every fact the scripts emit
 * into a config file or onto argv, and proves it by deleting each emitter.
 */
export interface SharedFact<T> {
  readonly agreement: 'shared';
  readonly value: T;
  readonly presentInBoth: readonly string[];
  readonly emitterEvidence?: Readonly<Record<WrapperId, readonly string[]>>;
}

/**
 * A fact the two launchers build differently. `onlyInBash` must appear in
 * moe-agent.sh and be ABSENT from moe-agent.ps1, and vice versa -- that
 * asymmetry assertion is what stops the descriptor papering over a difference.
 */
export interface DivergentFact<T> {
  readonly agreement: 'divergent';
  readonly bash: T;
  readonly powershell: T;
  readonly onlyInBash: readonly string[];
  readonly onlyInPowershell: readonly string[];
  readonly divergenceReason: string;
}

/**
 * A facet the provider genuinely has no answer for. Carries a reason and NO
 * evidence literals on purpose: text presence cannot prove an absence, so the
 * descriptor must not pretend it can. Never use this to mean "not transcribed
 * yet" -- an untranscribed facet corrupts the finding.
 */
export interface UnsupportedFact {
  readonly agreement: 'unsupported';
  readonly reason: string;
}

export type WrapperFact<T> = SharedFact<T> | DivergentFact<T>;
export type MaybeFact<T> = WrapperFact<T> | UnsupportedFact;

/** Facet: session modes the provider can be launched in. */
export interface SessionModeSpec {
  readonly id: string;
  readonly isDefault: boolean;
  /** The wrapper flag that opts a seat into this mode; null for the default mode. */
  readonly optIn: WrapperFact<string> | null;
  /** Whether the mode hands the terminal to a long-lived REPL. */
  readonly holdsTerminal: boolean;
  readonly banner: WrapperFact<string>;
}

export interface SessionModeFacet {
  readonly modes: readonly SessionModeSpec[];
  readonly defaultModeId: string;
  readonly defaultPolicy: WrapperFact<string>;
}

/** A token that must appear in NEITHER launcher, with the reason it was removed. */
export interface ForbiddenToken {
  readonly token: string;
  readonly reason: string;
}

/** Facet: argv construction, per session mode. */
export interface ArgvFacet {
  /**
   * Argv tokens keyed by SessionModeSpec.id. Order is transcribed for the
   * reader; no wrapper has a dry-run or print-argv mode, so the contract test
   * cannot compare a real command line.
   *
   * What it CAN do, and does: each mode's `emitterEvidence` is the wrapper's
   * whole launch invocation as one literal (bash line continuations joined), so
   * dropping a single `-c` from one mode turns the suite red. That is text
   * matching on the exact source line, not argv equality -- it proves the
   * scripts still SAY this, never that codex RECEIVES it.
   *
   * Note an asymmetry the pin makes visible: bash repeats the per-seat `-c`
   * overrides inline at each launch site, so its two modes are independently
   * pinned. PowerShell builds one `$codexSeatArgs` array and splats it into
   * both launches, so a deletion there necessarily hits both modes at once --
   * not a blind spot, just the shape of that file.
   */
  readonly tokensByMode: Readonly<Record<string, WrapperFact<readonly string[]>>>;
  /** Per-seat `-c key=value` overrides passed on argv, not through the config file. */
  readonly perSeatOverrides: readonly WrapperFact<string>[];
  readonly forbiddenTokens: readonly ForbiddenToken[];
  readonly sandbox: {
    readonly envVar: WrapperFact<string>;
    readonly defaultMode: WrapperFact<string>;
    readonly modes: WrapperFact<readonly string[]>;
    readonly invalidWarning: WrapperFact<string>;
  };
  readonly promptDelivery: WrapperFact<string>;
}

/** Facet: config construction. */
export interface ConfigFacet {
  readonly format: 'toml';
  readonly pathFragments: WrapperFact<readonly string[]>;
  readonly topLevelKeys: readonly WrapperFact<string>[];
  readonly tables: readonly WrapperFact<string>[];
  readonly values: readonly WrapperFact<string>[];
  readonly envKeys: readonly WrapperFact<string>[];
  /** The sections this writer owns, strips on merge and re-emits every run. */
  readonly ownedSections: WrapperFact<readonly string[]>;
  readonly proxyCommand: WrapperFact<string>;
  readonly daemonHostUpsert: WrapperFact<string>;
}

/** Facet: machine-readable events the wrapper consumes from the CLI. */
export interface EventCapabilityFacet {
  readonly toolEventStream: MaybeFact<string>;
  readonly partialMessages: MaybeFact<string>;
}

/** Facet: resume support. */
export interface ResumeFacet {
  readonly cliSessionResume: MaybeFact<string>;
  readonly wrapperRelaunch: WrapperFact<string>;
}

/** Facet: terminal handoff. */
export interface TerminalHandoffFacet {
  readonly pollingSuppressed: WrapperFact<string>;
  readonly seatInstructionsFile: WrapperFact<string>;
  readonly seatInstructionsCleanup: WrapperFact<string>;
  readonly argvQuoteGuard: WrapperFact<string>;
}

/** Facet: failure classification. */
export interface FailureClassSpec {
  /** The MOE_* code the wrapper prints. Must exist in the launcher vocabulary. */
  readonly code: string;
  /** true = the seat exits; false = the wrapper retries or relaunches. */
  readonly terminal: boolean;
  readonly detection: WrapperFact<readonly string[]>;
  readonly escalation: WrapperFact<string>;
}

export interface FailureFacet {
  readonly classes: readonly FailureClassSpec[];
  readonly missingBinary: WrapperFact<string>;
  readonly disableProbe: WrapperFact<string>;
}

/**
 * The registry entry. Every member is required: a descriptor constructible with
 * a facet omitted would let a migration be greenlit on a partial transcription.
 */
export interface ProviderDescriptor {
  readonly providerId: string;
  readonly cliTypeToken: WrapperFact<string>;
  readonly sessionMode: SessionModeFacet;
  readonly argv: ArgvFacet;
  readonly config: ConfigFacet;
  readonly events: EventCapabilityFacet;
  readonly resume: ResumeFacet;
  readonly terminalHandoff: TerminalHandoffFacet;
  readonly failures: FailureFacet;
}

/** The facet names the Definition of Done requires. The contract test asserts all seven are populated. */
export const REQUIRED_FACETS = [
  'cliTypeToken',
  'sessionMode',
  'argv',
  'config',
  'events',
  'resume',
  'terminalHandoff',
  'failures',
] as const satisfies readonly (keyof ProviderDescriptor)[];

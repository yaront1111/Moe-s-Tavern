// CQ-M07c: the daemon's one held verified-local readiness value (mem:decision-cq-m07-verified-local-activation).
// assertExecutionProfileReady reads it synchronously. Only an evaluation (refreshReadiness, or the scheduler around it)
// holds a non-default value, and only after shape validation; every failure holds DEFAULT_READINESS (fail closed).
// No env var, persisted label, caller argument or project file reaches it: ProgramFiles only locates the win32 client.
// LEAF-SAFE: node built-ins, executionReadiness.ts, certificationEvidence.ts and runnerChannel.ts only. Never a state
// store, StateManager, policy.ts, executionProfile.ts or a logger.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readHostCertificationEvidence } from './certificationEvidence.js';
import {
  evaluateExecutionReadiness, READINESS_CAPABILITIES, READINESS_IDS,
  type ProbeRunner, type ReadinessId, type ReadinessInputs, type ReadinessSnapshot,
} from './executionReadiness.js';
import { runnerKeyPath } from '../server/runnerChannel.js';

export interface HeldReadiness {
  readonly ready: boolean;
  readonly missingCapabilities: readonly ReadinessId[];
  /** null only for DEFAULT_READINESS: never evaluated, or the last evaluation failed. */
  readonly evaluatedAt: string | null;
  readonly evidence: ReadinessSnapshot['evidence'];
}

/** Not ready, every capability missing: before any evaluation and after every failed one. */
export const DEFAULT_READINESS: HeldReadiness = Object.freeze({
  ready: false,
  missingCapabilities: Object.freeze([...READINESS_CAPABILITIES]),
  evaluatedAt: null,
  evidence: null,
});

/** evaluateExecutionReadiness, or a test's fake. Its result is validated, never trusted. */
export type ReadinessEvaluator = (inputs: ReadinessInputs) => Promise<unknown>;

let held: HeldReadiness = DEFAULT_READINESS;
/** Bumped by every refresh and clear, so only the last-started write lands. */
let sequence = 0;

/** The current held value, DEFAULT_READINESS at load. */
export function heldReadiness(): HeldReadiness {
  return held;
}

/** Back to DEFAULT_READINESS. It can only refuse, and it supersedes any in-flight refresh. */
export function clearReadiness(): void {
  sequence++;
  held = DEFAULT_READINESS;
}

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = ['arch', 'platform', 'providerVersion', 'reportSha256'];
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A strictly increasing READINESS_IDS filter: known ids, unique, in the stable order. */
function readIds(value: unknown): ReadinessId[] | null {
  if (!Array.isArray(value)) return null;
  const ids: unknown[] = [...value];
  let last = -1;
  for (const id of ids) {
    const index = (READINESS_IDS as readonly unknown[]).indexOf(id);
    if (index <= last) return null;
    last = index;
  }
  return ids as ReadinessId[];
}

function readEvidence(value: unknown): HeldReadiness['evidence'] | undefined {
  if (value === null) return null;
  if (!isPlain(value) || Reflect.ownKeys(value).length !== EVIDENCE_KEYS.length) return undefined;
  if (!EVIDENCE_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))) return undefined;
  const { reportSha256, platform, arch, providerVersion } = value;
  if (typeof reportSha256 !== 'string' || !SHA256.test(reportSha256) || typeof platform !== 'string') return undefined;
  if (!nullableString(arch) || !nullableString(providerVersion)) return undefined;
  return Object.freeze({ reportSha256, platform, arch, providerVersion });
}

const isIso = (value: unknown): value is string => typeof value === 'string' && new Date(value).toISOString() === value;

/** A deep-frozen copy of a well-formed snapshot, else null. Each field is read once. */
function wellFormed(value: unknown): HeldReadiness | null {
  try {
    if (!isPlain(value)) return null;
    const { ready, missingCapabilities, evaluatedAt, evidence } = value;
    const ids = readIds(missingCapabilities);
    if (ids === null || typeof ready !== 'boolean' || ready !== (ids.length === 0) || !isIso(evaluatedAt)) return null;
    const copy = readEvidence(evidence);
    if (copy === undefined) return null;
    return Object.freeze({ ready, missingCapabilities: Object.freeze(ids), evaluatedAt, evidence: copy });
  } catch {
    return null;
  }
}

/**
 * The ONLY way to hold a non-default value: evaluate, validate, store a frozen copy.
 * A throw, a rejection or a malformed snapshot holds DEFAULT_READINESS. A refresh
 * superseded by a later refresh or clear stores nothing. Never rejects.
 */
export async function refreshReadiness(
  inputs: ReadinessInputs, evaluate: ReadinessEvaluator = evaluateExecutionReadiness,
): Promise<HeldReadiness> {
  const mine = ++sequence;
  let next: HeldReadiness | null = null;
  try {
    next = wellFormed(await evaluate(inputs));
  } catch {
    next = null;
  }
  if (mine === sequence) held = next ?? DEFAULT_READINESS;
  return held;
}

/** Five minutes: a readiness change (a re-certify, a deliveryPolicy switch) shows within one interval. */
export const READINESS_INTERVAL_MS = 300_000;

export interface ReadinessSchedule {
  /** Called for every evaluation, so live settings are read each time. A throw holds DEFAULT_READINESS. */
  readonly inputs: () => ReadinessInputs;
  readonly evaluate?: ReadinessEvaluator;
  readonly intervalMs?: number;
  /** After an evaluation whose ready or missingCapabilities differ from the previous held value. A throw is swallowed. */
  readonly onChange?: (held: HeldReadiness) => void;
}
export interface ReadinessEvaluation {
  /** The immediate first evaluation. Never rejects. */
  readonly first: Promise<HeldReadiness>;
  /** Evaluate now, or join the evaluation in flight. Never rejects. */
  refresh(): Promise<HeldReadiness>;
  /** Clears the interval; idempotent. */
  stop(): void;
}

const sameIds = (a: readonly ReadinessId[], b: readonly ReadinessId[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Evaluate now and every intervalMs on an unref'd timer, single-flight. Never throws; nothing here awaits the caller. */
export function startReadinessEvaluation(schedule: ReadinessSchedule): ReadinessEvaluation {
  const evaluate = schedule.evaluate ?? evaluateExecutionReadiness;
  const requested = schedule.intervalMs;
  const period = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : READINESS_INTERVAL_MS;
  let inFlight: Promise<HeldReadiness> | null = null;
  const run = async (): Promise<HeldReadiness> => {
    const before = heldReadiness();
    let after: HeldReadiness;
    try {
      after = await refreshReadiness(schedule.inputs(), evaluate);
    } catch {
      clearReadiness(); // only inputs() can throw here: refreshReadiness never rejects
      after = heldReadiness();
    }
    if (after.ready !== before.ready || !sameIds(after.missingCapabilities, before.missingCapabilities)) {
      try { schedule.onChange?.(after); } catch { /* a listener never fails an evaluation */ }
    }
    return after;
  };
  const refresh = (): Promise<HeldReadiness> => (inFlight ??= run().finally(() => { inFlight = null; }));
  const first = refresh();
  const timer = setInterval(() => { void refresh(); }, period);
  timer.unref?.();
  return { first, refresh, stop: () => clearInterval(timer) };
}

function orEmpty(read: () => string): string {
  try { return read(); } catch { return ''; } // '' is not absolute, so its capability is refused
}

/** The production inputs: the daemon's own install, this project's runner key and this OS account's certification store. */
export function productionReadinessInputs(projectRoot: string, settings: unknown): ReadinessInputs {
  return {
    projectRoot,
    // The package root holding dist/ and node_modules/: from dist/delivery in a build, from src/delivery under vitest.
    daemonInstallDir: orEmpty(() => path.resolve(fileURLToPath(new URL('../..', import.meta.url)))),
    runnerKeyPath: orEmpty(() => runnerKeyPath(projectRoot)),
    settings,
    readCertification: () => readHostCertificationEvidence(projectRoot),
    runProbe: promisify(execFile) as ProbeRunner,
    programFiles: process.env.ProgramFiles,
    now: () => new Date(),
  };
}

// =============================================================================
// Usage windows: the claude CLI's own usage reports, parsed and merged
// =============================================================================
//
// The wrapper forwards what the claude CLI prints: a stream-json
// rate_limit_event (utilization as a 0-1 fraction) or the interactive
// statusline's rate_limits (a 0-100 percent). Neither format is a documented
// contract, so malformed entries are dropped, never refused: a format change
// must degrade to "no data", not to an error loop in every seat.
//
// A window is live until its resetsAt (one hour after its sample when the CLI
// gave no reset). An account is spent while a live window is at or past the
// switch percent, carries a blocking status, or a refusal is pending.
//
// Pure functions; accountStore.ts does the I/O.

export interface ParsedWindow {
  percent: number | null;
  resetsAtMs: number | null;
  status: string | null;
}

/** One usage window as stored in claude-usage/<id>.json. */
export interface UsageWindow {
  /** 0-100, one decimal; null when the CLI sent a status but no utilization. */
  percent: number | null;
  /** When the window resets; null when the CLI gave no time. */
  resetsAt: string | null;
  /** The CLI's status: allowed, allowed_warning, rejected, overage. */
  status: string | null;
  sampledAt: string;
}

/** claude-usage/<id>.json: usage numbers only, no credential and no path. */
export interface AccountUsage {
  id: string;
  windows: Record<string, UsageWindow>;
  /** A launch on this account was refused at its limit; spent until then. */
  refusedUntil: string | null;
  updatedAt: string;
}

export interface AccountSample {
  windows: Record<string, ParsedWindow>;
  refused: boolean;
}

/** Window names and statuses are the CLI's lower-case tokens ("five_hour", "allowed_warning"). */
const TOKEN_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_WINDOWS = 8;
/** A window the CLI gave no reset time for counts as live this long after its sample. */
export const UNKNOWN_RESET_MS = 3_600_000;
/** A refusal parks an account at least this long, so a bad reset time cannot cause a relaunch storm. */
const MIN_REFUSAL_BLOCK_MS = 300_000;
/** No subscription window is longer than a week; a reset further out is garbage. */
const MAX_RESET_AHEAD_MS = 8 * 86_400_000;
/** Two samples whose resets differ by less than this describe the same window. */
const SAME_WINDOW_SLACK_MS = 120_000;
/** A reset-less window is re-persisted this often, so it stays live while the account keeps reporting. */
const RESETLESS_REFRESH_MS = 1_800_000;
/** stream-json reports utilization as a fraction (0.59 = 59%); the statusline sends a percent. */
const UTILIZATION_TO_PERCENT = 100;
const MATERIAL_PERCENT_DELTA = 1;
/** Statuses that mean the window is spent whatever its percent says. */
const BLOCKING_STATUSES = new Set(['rejected', 'overage']);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Epoch seconds, epoch ms or an ISO string -> ms; null when absent, unparseable or past the longest window. */
function toResetMs(value: unknown, nowMs: number): number | null {
  let ms: number;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === 'string' && value.trim()) {
    ms = Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(ms) && ms <= nowMs + MAX_RESET_AHEAD_MS ? ms : null;
}

function toPercent(entry: Record<string, unknown>): number | null {
  let value: number;
  if (typeof entry.percent === 'number' && Number.isFinite(entry.percent)) {
    value = entry.percent;
  } else if (typeof entry.utilization === 'number' && Number.isFinite(entry.utilization)) {
    value = entry.utilization * UTILIZATION_TO_PERCENT;
  } else {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** The wrapper's `windows` object -> validated windows. Malformed entries and ones with neither percent nor status are dropped. */
export function parseUsageWindows(raw: unknown, nowMs: number): Record<string, ParsedWindow> {
  const out: Record<string, ParsedWindow> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_WINDOWS) break;
    if (!TOKEN_RE.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const status = typeof entry.status === 'string' && TOKEN_RE.test(entry.status) ? entry.status : null;
    const percent = toPercent(entry);
    if (percent === null && status === null) continue;
    out[name] = { percent, resetsAtMs: toResetMs(entry.resetsAt, nowMs), status };
  }
  return out;
}

function windowEnd(window: UsageWindow): number {
  return window.resetsAt ? Date.parse(window.resetsAt) : Date.parse(window.sampledAt) + UNKNOWN_RESET_MS;
}

function isLive(window: UsageWindow, nowMs: number): boolean {
  return windowEnd(window) > nowMs;
}

function isSpent(window: UsageWindow, threshold: number): boolean {
  return (window.status !== null && BLOCKING_STATUSES.has(window.status))
    || (window.percent !== null && window.percent >= threshold);
}

function mergeWindow(stored: UsageWindow | undefined, incoming: ParsedWindow, nowMs: number): UsageWindow {
  const sampledAt = iso(nowMs);
  const resetsAt = incoming.resetsAtMs === null ? null : iso(incoming.resetsAtMs);
  const fresh: UsageWindow = { percent: incoming.percent, resetsAt, status: incoming.status, sampledAt };
  if (!stored || !isLive(stored, nowMs)) return fresh;
  const storedReset = stored.resetsAt ? Date.parse(stored.resetsAt) : null;
  if (storedReset !== null && incoming.resetsAtMs !== null
    && Math.abs(storedReset - incoming.resetsAtMs) > SAME_WINDOW_SLACK_MS) {
    return fresh; // the window rolled over, so its usage starts again
  }
  // Same window: usage only grows inside it, so keep the higher reading.
  const percent = stored.percent === null ? incoming.percent
    : incoming.percent === null ? stored.percent
      : Math.max(stored.percent, incoming.percent);
  return { percent, resetsAt: stored.resetsAt ?? resetsAt, status: incoming.status ?? stored.status, sampledAt };
}

function windowChanged(stored: UsageWindow | undefined, merged: UsageWindow, threshold: number, nowMs: number): boolean {
  if (!stored || !isLive(stored, nowMs)) return true;
  if (stored.resetsAt !== merged.resetsAt || stored.status !== merged.status) return true;
  if ((stored.percent === null) !== (merged.percent === null)) return true;
  if (stored.percent !== null && merged.percent !== null) {
    if (Math.abs(merged.percent - stored.percent) >= MATERIAL_PERCENT_DELTA) return true;
    if ((stored.percent >= threshold) !== (merged.percent >= threshold)) return true;
  }
  return merged.resetsAt === null && nowMs - Date.parse(stored.sampledAt) >= RESETLESS_REFRESH_MS;
}

/** Highest percent across the live windows; null when none reported one. */
export function peakPercent(usage: AccountUsage, nowMs: number): number | null {
  let peak: number | null = null;
  for (const window of Object.values(usage.windows)) {
    if (window.percent === null || !isLive(window, nowMs)) continue;
    peak = peak === null ? window.percent : Math.max(peak, window.percent);
  }
  return peak;
}

/** When the account is eligible again, or null when usage does not block it now. */
export function blockedUntilMs(usage: AccountUsage, threshold: number, nowMs: number): number | null {
  let until: number | null = null;
  const refused = usage.refusedUntil ? Date.parse(usage.refusedUntil) : NaN;
  if (refused > nowMs) until = refused;
  for (const window of Object.values(usage.windows)) {
    if (isLive(window, nowMs) && isSpent(window, threshold)) until = Math.max(until ?? 0, windowEnd(window));
  }
  return until;
}

/** True when the account is blocked by a refusal or a blocking status rather than by crossing the switch percent. */
export function hitLimit(usage: AccountUsage, nowMs: number): boolean {
  const refused = usage.refusedUntil ? Date.parse(usage.refusedUntil) : NaN;
  return refused > nowMs || Object.values(usage.windows)
    .some((window) => isLive(window, nowMs) && window.status !== null && BLOCKING_STATUSES.has(window.status));
}

/** The live windows, for the views. */
export function liveWindows(usage: AccountUsage, nowMs: number): Record<string, { percent: number | null; resetsAt: string | null }> {
  const out: Record<string, { percent: number | null; resetsAt: string | null }> = {};
  for (const [name, window] of Object.entries(usage.windows)) {
    if (isLive(window, nowMs)) out[name] = { percent: window.percent, resetsAt: window.resetsAt };
  }
  return out;
}

/** A refusal lasts until the spent window resets: never under 5 minutes, an hour when no window says when. */
function refusalUntilMs(windows: Record<string, UsageWindow>, nowMs: number): number {
  let until: number | null = null;
  for (const window of Object.values(windows)) {
    if (isLive(window, nowMs) && isSpent(window, 100)) until = Math.max(until ?? 0, windowEnd(window));
  }
  return Math.max(until ?? nowMs + UNKNOWN_RESET_MS, nowMs + MIN_REFUSAL_BLOCK_MS);
}

/**
 * Merge one report into the stored usage. `changed` is true only when the
 * report materially changes a window or adds a refusal: every claude seat
 * reports about once a minute, and the file is rewritten only on a change.
 */
export function mergeSample(
  stored: AccountUsage | null,
  id: string,
  sample: AccountSample,
  threshold: number,
  nowMs: number
): { usage: AccountUsage; changed: boolean } {
  const base: AccountUsage = stored ?? { id, windows: {}, refusedUntil: null, updatedAt: iso(nowMs) };
  const windows: Record<string, UsageWindow> = { ...base.windows };
  let changed = false;
  for (const [name, incoming] of Object.entries(sample.windows)) {
    const merged = mergeWindow(base.windows[name], incoming, nowMs);
    if (!isLive(merged, nowMs)) continue;
    if (windowChanged(base.windows[name], merged, threshold, nowMs)) {
      windows[name] = merged;
      changed = true;
    }
  }

  let refusedUntil = base.refusedUntil;
  if (sample.refused) {
    const until = refusalUntilMs(windows, nowMs);
    const current = refusedUntil ? Date.parse(refusedUntil) : NaN;
    if (!(current > nowMs) || until > current + SAME_WINDOW_SLACK_MS) {
      refusedUntil = iso(until);
      changed = true;
    }
  }

  if (!changed) return { usage: base, changed: false };
  for (const [name, window] of Object.entries(windows)) {
    if (!isLive(window, nowMs)) delete windows[name];
  }
  return { usage: { id, windows, refusedUntil, updatedAt: iso(nowMs) }, changed: true };
}

function isWindow(value: unknown): value is UsageWindow {
  const window = value as UsageWindow | null;
  return !!window && typeof window === 'object'
    && (window.percent === null || (typeof window.percent === 'number' && Number.isFinite(window.percent)))
    && (window.resetsAt === null || (typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt))))
    && (window.status === null || typeof window.status === 'string')
    && typeof window.sampledAt === 'string' && Number.isFinite(Date.parse(window.sampledAt));
}

/** A usage file as written by any daemon on the machine; unusable windows are dropped, a wrong file gives null. */
export function validateUsage(raw: unknown, id: string): AccountUsage | null {
  const usage = raw as AccountUsage | null;
  if (!usage || typeof usage !== 'object' || usage.id !== id || !usage.windows || typeof usage.windows !== 'object') {
    return null;
  }
  const windows: Record<string, UsageWindow> = {};
  for (const [name, window] of Object.entries(usage.windows)) {
    if (TOKEN_RE.test(name) && isWindow(window)) windows[name] = window;
  }
  const refusedUntil = typeof usage.refusedUntil === 'string' && Number.isFinite(Date.parse(usage.refusedUntil))
    ? usage.refusedUntil
    : null;
  return { id, windows, refusedUntil, updatedAt: typeof usage.updatedAt === 'string' ? usage.updatedAt : iso(0) };
}

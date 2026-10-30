import fs from 'fs';
import path from 'path';

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  projectPath: string;
}

export interface DaemonInfoReadResult {
  info: DaemonInfo | null;
  error?: string;
  retryable: boolean;
}

const WINDOWS_FORM = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const WSL_SHARE = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i;
const MNT_DRIVE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

/**
 * The cross-platform project-path comparison contract. The key is the same
 * whatever OS computes it, and is comparison-only: never written anywhere.
 * The daemon's comparableProjectPath twin, JetBrains DaemonIdentityProbe and
 * the launchers follow it (scripts/tests/daemon-json-cap.test.mjs checks them).
 * - Drive (`D:\x`, `d:/x/`) and UNC (`\\srv\share\x`, `//srv/share/x`): `\` and
 *   `/` both separate, '..' never climbs past the drive or the UNC server and
 *   share, and case folds with toLowerCase (locale-independent, full Unicode:
 *   it over-folds U+212A and U+212B, which NTFS keeps apart, a fail-open same).
 * - `\\wsl$\<distro>\x` and `\\wsl.localhost\<distro>\x` name that distro's
 *   POSIX `/x`; the distro is not compared. The launchers still read a WSL
 *   share as plain UNC until task-3def0804.
 * - Any other path starting with `/` is POSIX: only `/` separates, '..' stops
 *   at the root, case is kept, and `/mnt/<d>[/x]` maps to `<d>:[/x]`.
 * The drive letter and the mount letter are ASCII-only. Only a relative input
 * is first resolved natively against the cwd.
 */
export function comparableProjectPath(projectPath: string): string {
  const raw = projectPath.trim();
  const abs = WINDOWS_FORM.test(raw) || raw.startsWith('/') ? raw : path.resolve(raw);
  if (!WINDOWS_FORM.test(abs)) return posixKey(abs);
  const s = abs.replace(/\\/g, '/');
  const share = WSL_SHARE.exec(s);
  if (share) return posixKey(share[1] ?? '/');
  const unc = s.startsWith('//');
  return ((unc ? '//' : '') + collapse(s, unc ? 2 : 1)).toLowerCase();
}

function posixKey(p: string): string {
  const key = '/' + collapse(p, 0);
  const mnt = MNT_DRIVE.exec(key);
  return mnt ? `${mnt[1]}:${mnt[2] ? `/${mnt[2]}` : ''}`.toLowerCase() : key;
}

/** Drops empty and '.' segments; '..' never pops the first `keep` (drive, or UNC server and share). */
function collapse(p: string, keep: number): string {
  const kept: string[] = [];
  for (const segment of p.split('/').filter((s) => s !== '' && s !== '.')) {
    if (segment !== '..') kept.push(segment);
    else if (kept.length > keep) kept.pop();
  }
  return kept.join('/');
}

function isSameProjectPath(a: string, b: string): boolean {
  return comparableProjectPath(a) === comparableProjectPath(b);
}

/**
 * Host the proxy connects to. Defaults to loopback; MOE_DAEMON_HOST overrides
 * for cross-boundary setups (WSL agent -> Windows daemon started with --host wsl).
 */
export function getDaemonHost(): string {
  return process.env.MOE_DAEMON_HOST || '127.0.0.1';
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

function isDaemonInfoShape(value: unknown): value is DaemonInfo {
  const info = value as Partial<DaemonInfo> | null;
  return !!info
    && isValidPort(info.port)
    && isValidPid(info.pid)
    && typeof info.projectPath === 'string'
    && info.projectPath.trim().length > 0
    && typeof info.startedAt === 'string';
}

/**
 * daemon.json is repository content (a repository can commit one), and a
 * wrapper RPC spawns a fresh proxy per call, so an oversize file would be
 * read again on every call. The cap matches the daemon and JetBrains readers.
 */
const MAX_DAEMON_JSON_BYTES = 64 * 1024;

/**
 * Read at most MAX + 1 bytes through one descriptor. Returns null when the
 * file holds more than MAX bytes. Size metadata is not trusted (a device
 * symlink reports 0), so the read itself is bounded; short reads are looped.
 */
function readBounded(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(MAX_DAEMON_JSON_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return total > MAX_DAEMON_JSON_BYTES ? null : buf.toString('utf-8', 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

export function readDaemonInfoResult(projectPath: string): DaemonInfoReadResult {
  const filePath = path.join(projectPath, '.moe', 'daemon.json');
  if (!fs.existsSync(filePath)) return { info: null, retryable: true };
  try {
    const raw = readBounded(filePath);
    if (raw === null) {
      return { info: null, retryable: false, error: 'daemon.json is larger than 64 KiB' };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isDaemonInfoShape(parsed)) {
      return {
        info: null,
        retryable: false,
        error: 'daemon.json contains invalid daemon connection details',
      };
    }
    if (!isSameProjectPath(parsed.projectPath, projectPath)) {
      return {
        info: null,
        retryable: false,
        error: 'daemon.json belongs to a different project',
      };
    }
    return { info: parsed, retryable: false };
  } catch {
    return {
      info: null,
      retryable: false,
      error: 'daemon.json contains invalid daemon connection details',
    };
  }
}

export function readDaemonInfo(projectPath: string): DaemonInfo | null {
  return readDaemonInfoResult(projectPath).info;
}

export function getProjectPath(): string {
  // Our own path names a directory on this host, so resolve it natively, as the
  // daemon does (canonicalProjectPath). Recorded and served paths stay compared as written.
  return path.resolve(process.env.MOE_PROJECT_PATH || process.cwd());
}

export function formatError(message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message }
  });
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tools whose `workerId` argument is a FILTER, not the caller's identity.
 *
 * Injecting the seat's own id into these silently narrows the query to the
 * caller and returns a confident WRONG answer rather than an error. Measured
 * 2026-09-02: `get_activity_log { taskId }` from a governor seat returned 0
 * events while 12 matched the task, because the proxy had added
 * `workerId: "governor-..."` and the daemon ANDs the two filters. A task audit
 * came back empty and looked authoritative.
 */
const WORKER_ID_IS_A_FILTER = new Set([
  // The daemon's wire name — the only spelling that reaches it. The alias
  // forms below are kept for a caller that bypasses resolveToolCallName.
  'moe.get_activity_log',
  'moe_get_activity_log',
  'get_activity_log',
]);

/**
 * Inject MOE_WORKER_ID into tools/call arguments when the caller omits workerId,
 * and into tools/list params so the daemon can list only this seat's role's tools.
 * Never touches initialize/ping, and never touches a tool that uses `workerId`
 * as a query filter.
 * An EMPTY or whitespace-only env value counts as unset: the grok MCP config
 * pins `MOE_WORKER_ID = "${MOE_WORKER_ID:-}"`, which grok expands to "" for a
 * human running `grok` by hand — injecting that would send `workerId: ""` to
 * the daemon instead of letting the call through unattributed.
 * Returns true if the parsed object was mutated. Never throws.
 */
export function injectWorkerId(
  parsed: unknown,
  envWorkerId: string | undefined
): boolean {
  try {
    if (typeof envWorkerId !== 'string' || envWorkerId.trim() === '') return false;
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;
    if (msg.method === 'tools/list') {
      if (msg.params !== undefined && (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params))) return false;
      const listParams = (msg.params ?? {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(listParams, 'workerId')) return false;
      listParams.workerId = envWorkerId;
      msg.params = listParams;
      return true;
    }
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') return false;
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (WORKER_ID_IS_A_FILTER.has(toolName)) return false;
    const args = params.arguments as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (Object.prototype.hasOwnProperty.call(args, 'workerId')) return false;
    args.workerId = envWorkerId;
    return true;
  } catch {
    return false;
  }
}

/** The one tool that records a runner identity: the claim that opens an attempt. */
const CLAIM_TOOL = new Set([
  'moe.claim_next_task',
  'moe_claim_next_task',
  'claim_next_task',
]);

/**
 * Inject the wrapper's runner identity (MOE_RUNNER_PROCESS_STARTED_AT +
 * MOE_RUNNER_HOST) into a moe.claim_next_task that carries neither key, so a
 * claim the agent makes inside its session records the same pair as the
 * wrapper's own pre-flight claim, and moe.reattach_attempt can match that
 * attempt after a daemon restart parks it in `reconciling`. The wrapper sets the
 * pair for architect, QA and governor seats only: an identity on a worker's
 * attempt hands its finalize to the wrapper, which finalizes only the attempt it
 * pinned. Both values or nothing (the daemon refuses half a pair); a blank value
 * counts as unset, as for MOE_WORKER_ID. Values are sent verbatim, because the
 * daemon compares exact strings. Returns true if the parsed object was mutated.
 * Never throws.
 */
export function injectRunnerIdentity(
  parsed: unknown,
  envProcessStartedAt: string | undefined,
  envHost: string | undefined
): boolean {
  try {
    if (typeof envProcessStartedAt !== 'string' || envProcessStartedAt.trim() === '') return false;
    if (typeof envHost !== 'string' || envHost.trim() === '') return false;
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') return false;
    if (typeof params.name !== 'string' || !CLAIM_TOOL.has(params.name)) return false;
    const args = params.arguments as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (Object.prototype.hasOwnProperty.call(args, 'processStartedAt')) return false;
    if (Object.prototype.hasOwnProperty.call(args, 'host')) return false;
    args.processStartedAt = envProcessStartedAt;
    args.host = envHost;
    return true;
  } catch {
    return false;
  }
}

/** The two tools that register a seat: the daemon records the reported worker type on either. */
const WORKER_TYPE_TOOLS = new Set([...CLAIM_TOOL, 'moe.join_team', 'moe_join_team', 'join_team']);

/**
 * Add the launcher's MOE_WORKER_TYPE, the agent CLI it started, as `workerType`
 * on moe.claim_next_task and moe.join_team, so the daemon records which CLI a
 * seat runs. Unlike injectWorkerId it does not bail when the call names its own
 * workerId (the wrapper's pre-flight claim and join always do) and it never
 * touches tools/list. A `workerType` key the caller already set wins whatever
 * its value, and a blank value counts as unset, as for MOE_WORKER_ID. The value
 * is sent verbatim: the daemon owns validation (CLAUDE, CODEX, GEMINI or GROK,
 * anything else registers as CLAUDE). Returns true if the parsed object was
 * mutated. Never throws.
 */
export function injectWorkerType(
  parsed: unknown,
  envWorkerType: string | undefined
): boolean {
  try {
    if (typeof envWorkerType !== 'string' || envWorkerType.trim() === '') return false;
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') return false;
    if (typeof params.name !== 'string' || !WORKER_TYPE_TOOLS.has(params.name)) return false;
    const args = params.arguments as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (Object.prototype.hasOwnProperty.call(args, 'workerType')) return false;
    args.workerType = envWorkerType;
    return true;
  } catch {
    return false;
  }
}

export interface ExecutionIdentityRefusal { code: number; codeName: string; message: string }

type IdentityGroup = 'attempt' | 'session';
type IdentityFields = Record<string, string | number>;
/** A group's env read: null when absent, a reason string when partial or malformed. */
type GroupRead = IdentityFields | string | null;

/** The tools that carry the session's execution identity, under every spelling. */
const EXECUTION_IDENTITY_TOOLS = new Map<string, readonly IdentityGroup[]>();
for (const [tool, groups] of [
  ['get_context', ['session']], ['start_step', ['attempt', 'session']],
  ['complete_step', ['attempt', 'session']], ['complete_task', ['attempt', 'session']],
  ['qa_approve', ['attempt', 'session']], ['qa_reject', ['attempt', 'session']],
] as const) {
  for (const name of [`moe.${tool}`, `moe_${tool}`, tool]) EXECUTION_IDENTITY_TOOLS.set(name, groups);
}

const IDENTITY_ENV: Record<string, string> = {
  attemptId: 'MOE_ATTEMPT_ID', generation: 'MOE_ATTEMPT_GENERATION', sessionId: 'MOE_SESSION_ID',
};

const nonBlank = (value: string | undefined) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** The daemon's sessionId rule (readContextSessionId): at most 255 UTF-16 units, no NUL, CR or LF. Verbatim. */
function readSessionGroup(env: Record<string, string | undefined>): GroupRead {
  const sessionId = nonBlank(env.MOE_SESSION_ID);
  if (sessionId === undefined) return null;
  if (sessionId.length > 255 || /[\u0000\r\n]/.test(sessionId)) {
    return 'MOE_SESSION_ID must be at most 255 characters with no NUL, CR or LF';
  }
  return { sessionId };
}

/** Both or neither; attemptId is the wrapper's pin_attempt_identity shape; generation is never trimmed or loosely parsed. */
function readAttemptGroup(env: Record<string, string | undefined>): GroupRead {
  const attemptId = nonBlank(env.MOE_ATTEMPT_ID);
  const generation = nonBlank(env.MOE_ATTEMPT_GENERATION);
  if (attemptId === undefined && generation === undefined) return null;
  if (attemptId === undefined || generation === undefined) {
    return 'MOE_ATTEMPT_ID and MOE_ATTEMPT_GENERATION must be set together';
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) {
    return 'MOE_ATTEMPT_ID must be 1-128 characters of A-Z, a-z, 0-9, _ or -';
  }
  const value = Number(generation);
  if (!/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(value)) {
    return 'MOE_ATTEMPT_GENERATION must be a positive safe integer in plain decimal digits';
  }
  return { attemptId, generation: value };
}

const GROUP_READERS: Record<IdentityGroup, (env: Record<string, string | undefined>) => GroupRead> = {
  attempt: readAttemptGroup, session: readSessionGroup,
};

/**
 * CQ-F09, CQ-F12a, CQ-V06a: stamp the session's execution identity onto
 * moe.get_context (sessionId) and onto moe.start_step, moe.complete_step,
 * moe.complete_task, moe.qa_approve and moe.qa_reject
 * (attemptId, generation, sessionId). The
 * runner (the wrapper's env), never the CLI caller, owns that identity: the
 * same transport as injectRunnerIdentity, except the caller can never
 * override it. A presented field must equal the env value exactly, and a
 * malformed or partial env group refuses the calls that carry it. With no
 * identity env this is the legacy proxy: returns false and the daemon decides.
 * Returns true when the checked object must be forwarded (stamped or already
 * equal), or a refusal; it never mutates on refusal, never echoes a value and
 * never throws (an unexpected error fails closed).
 */
export function stampExecutionIdentity(
  parsed: unknown,
  env: Record<string, string | undefined>
): boolean | ExecutionIdentityRefusal {
  try {
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') return false;
    const tool = params.name;
    const groups = typeof tool === 'string' ? EXECUTION_IDENTITY_TOOLS.get(tool) : undefined;
    if (!groups) return false;
    const args = params.arguments as Record<string, unknown> | undefined;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const stamp: IdentityFields = {};
    for (const group of groups) {
      const read = GROUP_READERS[group](env);
      if (typeof read === 'string') {
        return { code: -32602, codeName: 'EXECUTION_IDENTITY_INVALID', message: `${tool}: ${read}; fix the session environment` };
      }
      if (read) Object.assign(stamp, read);
    }
    const fields = Object.keys(stamp);
    if (fields.length === 0) return false;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(args, field) && args[field] !== stamp[field]) {
        return {
          code: -32003,
          codeName: 'EXECUTION_IDENTITY_SUBSTITUTED',
          message: `${tool}: ${field} differs from this session's ${IDENTITY_ENV[field]}; omit ${field} so the proxy supplies the session's own value`,
        };
      }
    }
    Object.assign(args, stamp);
    return true;
  } catch {
    return { code: -32602, codeName: 'EXECUTION_IDENTITY_INVALID', message: 'execution identity could not be checked' };
  }
}

export function parseJsonLines(buffer: string): { lines: string[]; remaining: string } {
  const lines: string[] = [];
  let remaining = buffer;
  let index: number;

  while ((index = remaining.indexOf('\n')) >= 0) {
    const line = remaining.slice(0, index).trim();
    remaining = remaining.slice(index + 1);
    if (line) {
      lines.push(line);
    }
  }

  return { lines, remaining };
}

// -----------------------------------------------------------------------------
// Tool-name style
// -----------------------------------------------------------------------------

/**
 * How the proxy spells tool names to its MCP client.
 *
 * The daemon names every tool `moe.<name>`. Claude Code sanitises that itself
 * (`mcp__moe__moe_<name>`), codex/gemini pass it through, but Grok Build
 * DROPS any MCP tool whose name contains a dot — it namespaces tools as
 * `<server>__<tool>` and validates the result — so the whole `moe` server
 * shows up as "connected, 0 tools" and is then reported as failed to connect
 * (measured 2026-09-05, grok 1.0.13). With `MOE_TOOL_NAME_STYLE=underscore`
 * (the launchers pin it in grok's `[mcp_servers.moe.env]`) the proxy exposes
 * `moe_<name>` in `tools/list` and maps the alias back on `tools/call`, so the
 * daemon never sees the alias.
 */
export type ToolNameStyle = 'dot' | 'underscore';

export function toolNameStyleFromEnv(value: string | undefined): ToolNameStyle {
  return typeof value === 'string' && value.trim().toLowerCase() === 'underscore' ? 'underscore' : 'dot';
}

/** The name a tool is exposed under for the given style. */
export function exposeToolName(name: string, style: ToolNameStyle): string {
  if (style !== 'underscore') return name;
  return name.replace(/\./g, '_');
}

/**
 * Rewrite a `tools/list` result in place for the style, recording every alias
 * in `aliases` (alias → daemon name) so `tools/call` can map it back exactly.
 * Returns true when anything changed. Never throws on an odd shape.
 */
export function rewriteToolsListResult(
  parsed: unknown,
  style: ToolNameStyle,
  aliases: Map<string, string>
): boolean {
  if (style !== 'underscore') return false;
  if (!parsed || typeof parsed !== 'object') return false;
  const result = (parsed as { result?: { tools?: unknown } }).result;
  if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) return false;
  let changed = false;
  for (const tool of result.tools as Array<{ name?: unknown }>) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') continue;
    const exposed = exposeToolName(tool.name, style);
    if (exposed === tool.name) continue;
    aliases.set(exposed, tool.name);
    tool.name = exposed;
    changed = true;
  }
  return changed;
}

/**
 * Map an aliased `tools/call` name back to the daemon's name, in place.
 * A recorded alias wins; otherwise the `moe_<name>` → `moe.<name>` prefix rule
 * applies REGARDLESS of style — no daemon tool is spelled `moe_…`, and role
 * docs already describe the wire name as `moe_<name>`, so a client that
 * guesses that form gets the tool instead of "Tool not found".
 * Returns true when the name was changed.
 */
export function resolveToolCallName(parsed: unknown, aliases: Map<string, string>): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const msg = parsed as { method?: unknown; params?: { name?: unknown } };
  if (msg.method !== 'tools/call') return false;
  const params = msg.params;
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') return false;
  const alias = params.name;
  const recorded = aliases.get(alias);
  if (recorded !== undefined) {
    if (recorded === alias) return false;
    params.name = recorded;
    return true;
  }
  if (alias.startsWith('moe_')) {
    params.name = 'moe.' + alias.slice('moe_'.length);
    return true;
  }
  return false;
}

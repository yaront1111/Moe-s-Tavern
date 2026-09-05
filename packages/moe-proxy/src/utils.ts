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

/**
 * Reduce a project path to a form comparable across the Windows/WSL boundary.
 * A Windows daemon records `D:\projexts\app` in daemon.json while a WSL-side
 * proxy resolves the same directory as `/mnt/d/projexts/app`; both reduce to
 * `d:/projexts/app`. Paths without a drive-letter equivalent keep the old
 * behavior (resolve; case-insensitive only on win32).
 */
export function comparableProjectPath(projectPath: string): string {
  const raw = projectPath.trim();

  // Both special forms are detected on the RAW string: path.resolve would
  // mangle a Windows-drive path on Linux (treated as relative) and a /mnt
  // path on Windows (prefixed with the cwd drive).
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    return normalizeWindowsDrivePath(raw);
  }
  const wslMatch = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(raw);
  if (wslMatch) {
    const rest = (wslMatch[2] ?? '').replace(/\/+$/, '');
    return `${wslMatch[1]}:${rest ? `/${rest}` : ''}`.toLowerCase();
  }

  const resolved = path.resolve(raw);
  if (/^[a-zA-Z]:[\\/]/.test(resolved)) {
    return normalizeWindowsDrivePath(resolved);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeWindowsDrivePath(drivePath: string): string {
  return path.win32.normalize(drivePath)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isSameProjectPath(a: string, b: string): boolean {
  return comparableProjectPath(a) === comparableProjectPath(b);
}

/**
 * Host the proxy connects to. Defaults to loopback; MOE_DAEMON_HOST overrides
 * for cross-boundary setups (WSL agent -> Windows daemon bound to 0.0.0.0).
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

export function readDaemonInfoResult(projectPath: string): DaemonInfoReadResult {
  const filePath = path.join(projectPath, '.moe', 'daemon.json');
  if (!fs.existsSync(filePath)) return { info: null, retryable: true };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
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
  return process.env.MOE_PROJECT_PATH || process.cwd();
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
  'moe_get_activity_log',
  'get_activity_log',
]);

/**
 * Inject MOE_WORKER_ID into tools/call arguments when the caller omits workerId.
 * Only runs for MCP tools/call requests — never touches initialize/tools/list/ping,
 * and never touches a tool that uses `workerId` as a query filter.
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

import fs from 'fs';
import path from 'path';

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  projectPath: string;
}

export function readDaemonInfo(projectPath: string): DaemonInfo | null {
  const filePath = path.join(projectPath, '.moe', 'daemon.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
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
 * Inject MOE_WORKER_ID into tools/call arguments when the caller omits workerId.
 * Only runs for MCP tools/call requests — never touches initialize/tools/list/ping.
 * Returns true if the parsed object was mutated. Never throws.
 */
export function injectWorkerId(
  parsed: unknown,
  envWorkerId: string | undefined
): boolean {
  try {
    if (!envWorkerId) return false;
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') return false;
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

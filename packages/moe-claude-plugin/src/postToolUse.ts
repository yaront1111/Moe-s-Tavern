// =============================================================================
// postToolUse - PostToolUse hook entry point
// =============================================================================
//
// Claude Code invokes this hook after every tool call with a JSON payload on
// stdin. We forward only moe.* MCP tool events to the daemon's /ws endpoint
// so the JetBrains/VS Code plugins can observe agent activity in real time.
//
// Fail-open: any error here must NEVER block the agent's tool call. Errors
// are logged to stderr and swallowed.

import crypto from 'node:crypto';
import { postEvent } from './daemonClient.js';

export interface PostToolUseInput {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  duration_ms?: number;
  // Tolerant of unknown fields — Claude Code adds new ones over time.
  [key: string]: unknown;
}

const MOE_TOOL_PREFIX_RE = /^(mcp__moe__|moe\.)/i;

export function isMoeToolName(name: unknown): boolean {
  return typeof name === 'string' && MOE_TOOL_PREFIX_RE.test(name);
}

export function normalizeToolName(name: string): string {
  // Claude Code mangles MCP tool names: mcp__moe__moe_list_tasks → moe.list_tasks
  if (name.startsWith('mcp__moe__')) {
    const rest = name.slice('mcp__moe__'.length);
    return rest.startsWith('moe_') ? 'moe.' + rest.slice(4) : 'moe.' + rest;
  }
  return name;
}

export function resolveWorkerId(input: PostToolUseInput): string | null {
  const fromEnv = process.env.MOE_WORKER_ID;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  if (typeof input.session_id === 'string' && input.session_id.length > 0) {
    const hash = crypto.createHash('sha1').update(input.session_id).digest('hex').slice(0, 10);
    return `claude-${hash}`;
  }
  return null;
}

/**
 * Run the hook. Reads stdin, parses, forwards if relevant. Always exits 0.
 *
 * Returns a structured result for tests.
 */
export async function runPostToolUseHook(input: PostToolUseInput): Promise<{
  forwarded: boolean;
  reason?: string;
}> {
  if (process.env.MOE_DISABLE_TOOL_HOOK === '1') {
    return { forwarded: false, reason: 'disabled' };
  }
  const toolName = input.tool_name;
  if (!isMoeToolName(toolName)) {
    return { forwarded: false, reason: 'non-moe-tool' };
  }
  const workerId = resolveWorkerId(input);
  if (!workerId) {
    return { forwarded: false, reason: 'no-worker-id' };
  }
  const payload = {
    type: 'AGENT_TOOL_EVENT',
    payload: {
      workerId,
      tool: normalizeToolName(String(toolName)),
      args: input.tool_input ?? null,
      result: input.tool_response ?? null,
      durationMs: typeof input.duration_ms === 'number' ? input.duration_ms : null,
      sessionId: typeof input.session_id === 'string' ? input.session_id : null,
      timestamp: new Date().toISOString(),
    },
  };
  try {
    await postEvent(payload, { projectPath: typeof input.cwd === 'string' ? input.cwd : undefined });
    return { forwarded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[moe-claude-plugin] PostToolUse hook failed: ${message}\n`);
    return { forwarded: false, reason: 'send-failed' };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let input: PostToolUseInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim().length > 0) {
      input = JSON.parse(raw) as PostToolUseInput;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[moe-claude-plugin] Could not parse hook stdin: ${message}\n`);
    process.exit(0);
  }
  try {
    await runPostToolUseHook(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[moe-claude-plugin] Hook error (swallowed): ${message}\n`);
  }
  process.exit(0);
}

// Only run main() when this file is the entry point, not when imported in tests.
const isEntry = typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('postToolUse.js') || process.argv[1].endsWith('post-tool-use.js'));
if (isEntry) {
  void main();
}

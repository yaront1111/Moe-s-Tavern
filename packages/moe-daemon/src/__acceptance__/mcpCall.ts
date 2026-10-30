// =============================================================================
// Acceptance harness: reach daemon tools ONLY through the real MCP registry.
//
// This is the CQ-V11 rule. A handler-level test imports a tool module and calls
// its handler, so it mirrors the implementation and stays green when the tool is
// unregistered, renamed or wrapped wrongly. An acceptance fixture goes through
// registration and dispatch, the path agents use: McpAdapter.handle(tools/call),
// which owns the registry lookup, the state mutex and the error mapping.
//
// Nothing here imports a tool module or invokes a handler. A test that needs an
// unregistered tool deletes the entry from its own adapter instance (see
// producerConsumer.acceptance.test.ts); McpAdapter itself is never modified.
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import { McpAdapter } from '../server/McpAdapter.js';

/** JSON-RPC internal error: the code for a reply this harness cannot read. */
const MALFORMED_REPLY = -32603;

/** A refused or malformed tool call. `codeName` is the daemon's MoeError codeName, when it names one. */
export class McpCallError extends Error {
  readonly code: number;
  readonly codeName?: string;

  constructor(message: string, code: number, codeName?: string) {
    super(message);
    this.name = 'McpCallError';
    this.code = code;
    if (codeName !== undefined) this.codeName = codeName;
  }
}

export interface McpCaller {
  /** tools/call through the registry; resolves to the parsed JSON of the tool's result. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** The tool names tools/list serves. */
  listTools(): Promise<string[]>;
}

function codeNameOf(data: unknown): string | undefined {
  const codeName = (data as { codeName?: unknown } | null | undefined)?.codeName;
  return typeof codeName === 'string' ? codeName : undefined;
}

/** The single response to `request`; a missing or batch reply is malformed, never a pass. */
async function exchange(adapter: McpAdapter, method: string, params: unknown, id: number): Promise<unknown> {
  const reply = await adapter.handle({ jsonrpc: '2.0', id, method, params });
  if (reply === null || Array.isArray(reply)) {
    throw new McpCallError(`${method}: expected one JSON-RPC response`, MALFORMED_REPLY);
  }
  if (reply.error) throw new McpCallError(reply.error.message, reply.error.code, codeNameOf(reply.error.data));
  if (reply.result === undefined) throw new McpCallError(`${method}: response has neither result nor error`, MALFORMED_REPLY);
  return reply.result;
}

/** Parses result.content[0].text, the one place a tool's answer travels. */
function parseToolResult(name: string, result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  if (typeof text !== 'string') throw new McpCallError(`${name}: result has no text content`, MALFORMED_REPLY);
  try {
    return JSON.parse(text);
  } catch {
    throw new McpCallError(`${name}: result text is not JSON`, MALFORMED_REPLY);
  }
}

/**
 * A caller bound to one adapter. The default adapter is built over `state`;
 * pass your own to unwire or wrap a registry entry for one test. The rate
 * limiter is per adapter instance, so each test gets a fresh budget.
 */
export function createMcpCaller(state: StateManager, adapter: McpAdapter = new McpAdapter(state)): McpCaller {
  let nextId = 0;
  return {
    async call(name, args = {}) {
      const result = await exchange(adapter, 'tools/call', { name, arguments: args }, ++nextId);
      return parseToolResult(name, result);
    },
    async listTools() {
      const result = (await exchange(adapter, 'tools/list', {}, ++nextId)) as { tools?: Array<{ name?: unknown }> } | null;
      if (!Array.isArray(result?.tools)) throw new McpCallError('tools/list: result has no tools array', MALFORMED_REPLY);
      return result.tools.map((tool) => String(tool.name));
    },
  };
}

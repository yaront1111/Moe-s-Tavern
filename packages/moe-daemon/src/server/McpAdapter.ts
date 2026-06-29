// =============================================================================
// McpAdapter - handles MCP JSON-RPC requests (from proxy)
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import { getTools } from '../tools/index.js';
import { logger } from '../util/logger.js';
import { MoeError } from '../util/errors.js';

// Rate limiter configuration (configurable via environment variables)
const RATE_LIMIT_ENABLED = process.env.MOE_RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.MOE_RATE_LIMIT_MAX_REQUESTS || '100', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.MOE_RATE_LIMIT_WINDOW_MS || '1000', 10);
const DEFAULT_MCP_MAX_BATCH_SIZE = 25;

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  logger.warn({ name, value, fallback }, 'Invalid numeric environment configuration; using fallback');
  return fallback;
}

export const MAX_MCP_BATCH_SIZE = parsePositiveIntegerEnv(
  process.env.MOE_MCP_MAX_BATCH_SIZE,
  DEFAULT_MCP_MAX_BATCH_SIZE,
  'MOE_MCP_MAX_BATCH_SIZE'
);

/**
 * Simple sliding window rate limiter.
 * Uses O(1) memory by tracking only current window start and request count.
 */
export class RateLimiter {
  private windowStartMs: number;
  private requestCount = 0;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    const normalizedMaxRequests =
      Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : 1;
    const normalizedWindowMs =
      Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 1000;

    if (normalizedMaxRequests !== maxRequests || normalizedWindowMs !== windowMs) {
      logger.warn(
        { maxRequests, windowMs, normalizedMaxRequests, normalizedWindowMs },
        'Invalid rate limiter configuration; using safe defaults'
      );
    }

    this.maxRequests = normalizedMaxRequests;
    this.windowMs = normalizedWindowMs;

    const now = Date.now();
    this.windowStartMs = Number.isFinite(now) ? now : 0;
  }

  private getCurrentTimeMs(): number {
    const now = Date.now();
    if (!Number.isFinite(now) || Number.isNaN(now)) {
      logger.warn({ now }, 'Received invalid current time for rate limiter');
      return this.windowStartMs;
    }
    return now;
  }

  private resetWindowIfNeeded(now: number): void {
    if (now < this.windowStartMs || now - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = now;
      this.requestCount = 0;
    }
  }

  /**
   * Check if request is allowed under rate limit.
   * @returns true if allowed, false if rate limited
   */
  checkLimit(): boolean {
    const now = this.getCurrentTimeMs();
    this.resetWindowIfNeeded(now);

    if (this.requestCount >= this.maxRequests) {
      return false;
    }

    this.requestCount += 1;
    return true;
  }

  /**
   * Get current usage stats for monitoring.
   */
  getStats(): { current: number; max: number; windowMs: number } {
    const now = this.getCurrentTimeMs();
    this.resetWindowIfNeeded(now);
    return { current: this.requestCount, max: this.maxRequests, windowMs: this.windowMs };
  }
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpHandleOptions {
  shouldContinue?: () => boolean;
}

export class McpAdapter {
  private readonly tools = new Map<string, ReturnType<typeof getTools>[number]>();
  private readonly rateLimiter: RateLimiter | null;

  constructor(private readonly state: StateManager) {
    for (const tool of getTools(state)) {
      this.tools.set(tool.name, tool);
    }

    // Initialize rate limiter if enabled
    if (RATE_LIMIT_ENABLED) {
      this.rateLimiter = new RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
      logger.info(
        { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
        'Rate limiter enabled'
      );
    } else {
      this.rateLimiter = null;
      logger.info('Rate limiter disabled');
    }
  }

  // Returns null when the request (or every request in a batch) is a
  // JSON-RPC notification — notifications have no `id` and produce no response.
  async handle(
    request: JsonRpcRequest | JsonRpcRequest[],
    options: McpHandleOptions = {}
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(request)) {
      if (request.length === 0) {
        return this.errorResponse(null, -32600, 'Invalid Request: batch must contain at least one request');
      }
      if (request.length > MAX_MCP_BATCH_SIZE) {
        logger.warn({ batchSize: request.length, maxBatchSize: MAX_MCP_BATCH_SIZE }, 'MCP batch size limit exceeded');
        return this.errorResponse(
          null,
          -32000,
          `Batch size limit exceeded: maximum ${MAX_MCP_BATCH_SIZE} requests`
        );
      }

      const responses: JsonRpcResponse[] = [];
      for (const req of request) {
        if (options.shouldContinue && !options.shouldContinue()) {
          logger.info('Aborting remaining MCP batch requests because the client disconnected');
          break;
        }
        const response = await this.handleSingleWithRateLimit(req);
        if (response !== null) {
          responses.push(response);
        }
      }
      return responses.length > 0 ? responses : null;
    }
    return this.handleSingleWithRateLimit(request);
  }

  private async handleSingleWithRateLimit(request: unknown): Promise<JsonRpcResponse | null> {
    const id = this.getRequestId(request);

    // A JSON-RPC notification is a valid request with no `id` member; it produces
    // no response. Detect it BEFORE rate-limiting / shape checks so a rate-limited
    // or otherwise rejected notification never yields an errorResponse(null, …)
    // (which would be an illegal response to a notification). Mirrors handleSingle.
    if (this.isNotification(request)) {
      return null;
    }

    if (this.rateLimiter && !this.rateLimiter.checkLimit()) {
      const stats = this.rateLimiter.getStats();
      logger.warn({ stats }, 'Rate limit exceeded');
      return this.errorResponse(
        id,
        -32000,
        `Rate limit exceeded: ${stats.max} requests per ${stats.windowMs}ms`
      );
    }

    if (!this.isJsonRpcRequest(request)) {
      return this.errorResponse(id, -32600, 'Invalid Request');
    }

    return this.handleSingle(request);
  }

  // An MCP notification is a well-formed request whose method is in the
  // `notifications/*` namespace (e.g. notifications/initialized, .../cancelled);
  // it produces no response. We key on the method — matching handleSingle's own
  // notifications/initialized handling — rather than merely on a missing `id`,
  // so a malformed-but-non-notification request (e.g. a `tools/list` that omits
  // its id) still gets a normal id:null response instead of being silently
  // swallowed. An invalid object (no `method`) is NOT a notification — it still
  // gets the -32600 invalid-request response below.
  private isNotification(request: unknown): boolean {
    return this.isJsonRpcRequest(request) && request.method.startsWith('notifications/');
  }

  private isJsonRpcRequest(request: unknown): request is JsonRpcRequest {
    return Boolean(
      request &&
      typeof request === 'object' &&
      !Array.isArray(request) &&
      typeof (request as { method?: unknown }).method === 'string'
    );
  }

  private getRequestId(request: unknown): JsonRpcId {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
    const id = (request as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
  }

  private async handleSingle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id: JsonRpcId = request.id ?? null;

    try {
      // MCP lifecycle: initialize handshake
      if (request.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'moe-daemon', version: '0.1.0' }
          }
        };
      }

      // MCP lifecycle: initialized notification (no response expected)
      if (request.method === 'notifications/initialized') {
        return null;
      }

      // MCP lifecycle: ping keepalive
      if (request.method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (request.method === 'tools/list') {
        const tools = Array.from(this.tools.values()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));

        return {
          jsonrpc: '2.0',
          id,
          result: { tools }
        };
      }

      if (request.method === 'tools/call') {
        const params = request.params as { name: string; arguments?: unknown };
        if (!params?.name) {
          return this.errorResponse(id, -32602, 'Invalid params: missing tool name');
        }

        const tool = this.tools.get(params.name);
        if (!tool) {
          return this.errorResponse(id, -32601, `Tool not found: ${params.name}`);
        }

        try {
          // Serialize state-mutating tools through the global state mutex so
          // concurrent MCP calls on the same entity can't lose updates (the
          // handlers do read-modify-write and were previously unprotected).
          // Blocking tools opt out — they'd hold the lock for minutes. The
          // mutex is reentrant, so tools that already call runExclusive
          // internally (claim_next_task, submit_plan, …) are safe to wrap.
          const invoke = () => tool.handler(params.arguments, this.state);
          const result = tool.blocking ? await invoke() : await this.state.runExclusive(invoke);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
          };
        } catch (toolError) {
          if (toolError instanceof MoeError) {
            logger.warn({ toolName: params.name, error: toolError.toLogObject() }, 'Tool rejected request');
            return this.errorResponse(
              id,
              toolError.code,
              toolError.message,
              { tool: params.name, codeName: toolError.codeName }
            );
          }
          const message = toolError instanceof Error ? toolError.message : 'Tool execution failed';
          // Log full error with stack for debugging, but don't expose stack to clients
          logger.error({ toolName: params.name, error: toolError }, 'Tool failed');
          // Only include tool name in error data, not stack trace (security)
          return this.errorResponse(id, -32000, message, { tool: params.name });
        }
      }

      return this.errorResponse(id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Log full error for debugging but don't expose stack to clients
      logger.error({ error }, 'Request handler error');
      // Only include structured details if available, not stack trace
      const details = (error as { details?: unknown }).details;
      const data = details && typeof details === 'object' ? details : undefined;
      return this.errorResponse(id, -32000, message, data);
    }
  }

  private errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
    const error = { code, message } as { code: number; message: string; data?: unknown };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
  }
}

// =============================================================================
// McpAdapter - handles MCP JSON-RPC requests (from proxy)
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import { getTools } from '../tools/index.js';
import { logger } from '../util/logger.js';

// Rate limiter configuration (configurable via environment variables)
const RATE_LIMIT_ENABLED = process.env.MOE_RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.MOE_RATE_LIMIT_MAX_REQUESTS || '100', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.MOE_RATE_LIMIT_WINDOW_MS || '1000', 10);

/**
 * Simple sliding window rate limiter.
 * Tracks request timestamps and rejects requests exceeding the limit.
 */
class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if request is allowed under rate limit.
   * @returns true if allowed, false if rate limited
   */
  checkLimit(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /**
   * Get current usage stats for monitoring.
   */
  getStats(): { current: number; max: number; windowMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const current = this.timestamps.filter(t => t >= windowStart).length;
    return { current, max: this.maxRequests, windowMs: this.windowMs };
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

  async handle(request: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    // Check rate limit for tool calls
    if (this.rateLimiter && !this.rateLimiter.checkLimit()) {
      const stats = this.rateLimiter.getStats();
      logger.warn({ stats }, 'Rate limit exceeded');

      // For arrays, return rate limit error for all requests
      if (Array.isArray(request)) {
        return request.map(req => this.errorResponse(
          req.id ?? null,
          -32000,
          `Rate limit exceeded: ${stats.max} requests per ${stats.windowMs}ms`
        ));
      }

      return this.errorResponse(
        request.id ?? null,
        -32000,
        `Rate limit exceeded: ${stats.max} requests per ${stats.windowMs}ms`
      );
    }

    if (Array.isArray(request)) {
      const results = await Promise.all(request.map((req) => this.handleSingle(req)));
      const responses = results.filter((r): r is JsonRpcResponse => r !== null);
      return responses.length > 0 ? responses : null;
    }
    return this.handleSingle(request);
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
          const result = await tool.handler(params.arguments, this.state);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            }
          };
        } catch (toolError) {
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

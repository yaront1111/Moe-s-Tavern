// =============================================================================
// McpAdapter - handles MCP JSON-RPC requests (from proxy)
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import { getTools } from '../tools/index.js';
import { logger } from '../util/logger.js';

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

  constructor(private readonly state: StateManager) {
    for (const tool of getTools(state)) {
      this.tools.set(tool.name, tool);
    }
  }

  async handle(request: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    if (Array.isArray(request)) {
      const responses = await Promise.all(request.map((req) => this.handleSingle(req)));
      return responses;
    }
    return this.handleSingle(request);
  }

  private async handleSingle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id: JsonRpcId = request.id ?? null;

    try {
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
          // Preserve stack trace for tool errors
          const message = toolError instanceof Error ? toolError.message : 'Tool execution failed';
          const stack = toolError instanceof Error ? toolError.stack : undefined;
          logger.error({ toolName: params.name, error: toolError }, 'Tool failed');
          return this.errorResponse(id, -32000, message, { tool: params.name, stack });
        }
      }

      return this.errorResponse(id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      const details = (error as { details?: unknown }).details;
      const data: Record<string, unknown> = { stack };
      if (details && typeof details === 'object') {
        Object.assign(data, details);
      }
      return this.errorResponse(id, -32000, message, data);
    }
  }

  private errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
    const error = { code, message } as { code: number; message: string; data?: unknown };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
  }
}

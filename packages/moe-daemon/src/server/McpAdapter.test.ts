import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpAdapter, type JsonRpcRequest, type JsonRpcResponse } from './McpAdapter.js';
import type { StateManager } from '../state/StateManager.js';

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  getTools: () => [
    {
      name: 'moe.test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      handler: vi.fn(async (args: { message: string }) => ({
        echo: args.message,
      })),
    },
    {
      name: 'moe.failing_tool',
      description: 'A tool that always fails',
      inputSchema: { type: 'object' },
      handler: vi.fn(async () => {
        throw new Error('Tool intentionally failed');
      }),
    },
  ],
}));

describe('McpAdapter', () => {
  let adapter: McpAdapter;
  let mockState: StateManager;

  beforeEach(() => {
    mockState = {} as StateManager;
    adapter = new McpAdapter(mockState);
  });

  describe('tools/list', () => {
    it('returns list of available tools', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as { tools: Array<{ name: string; description: string }> };
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe('moe.test_tool');
      expect(result.tools[0].description).toBe('A test tool');
    });

    it('handles null id', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;
      expect(response.id).toBeNull();
    });
  });

  describe('tools/call', () => {
    it('calls tool handler with arguments', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'moe.test_tool',
          arguments: { message: 'hello world' },
        },
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.echo).toBe('hello world');
    });

    it('returns error for missing tool name', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {},
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toBe('Invalid params: missing tool name');
    });

    it('returns error for unknown tool', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'moe.unknown_tool' },
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Tool not found: moe.unknown_tool');
    });

    it('handles tool execution errors', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'moe.failing_tool', arguments: {} },
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32000);
      expect(response.error?.message).toBe('Tool intentionally failed');
      expect((response.error?.data as { tool: string })?.tool).toBe('moe.failing_tool');
    });
  });

  describe('unknown methods', () => {
    it('returns method not found error', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 6,
        method: 'unknown/method',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Method not found: unknown/method');
    });
  });

  describe('batch requests', () => {
    it('handles array of requests', async () => {
      const requests: JsonRpcRequest[] = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'moe.test_tool', arguments: { message: 'batch' } },
        },
      ];

      const responses = (await adapter.handle(requests)) as JsonRpcResponse[];

      expect(Array.isArray(responses)).toBe(true);
      expect(responses).toHaveLength(2);
      expect(responses[0].id).toBe(1);
      expect(responses[1].id).toBe(2);
      expect(responses[0].error).toBeUndefined();
      expect(responses[1].error).toBeUndefined();
    });

    it('handles mixed success and error in batch', async () => {
      const requests: JsonRpcRequest[] = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'moe.test_tool', arguments: { message: 'ok' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'moe.unknown' },
        },
      ];

      const responses = (await adapter.handle(requests)) as JsonRpcResponse[];

      expect(responses[0].error).toBeUndefined();
      expect(responses[1].error).toBeDefined();
    });
  });

  describe('JSON-RPC compliance', () => {
    it('always returns jsonrpc: 2.0', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 'string-id',
        method: 'tools/list',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;
      expect(response.jsonrpc).toBe('2.0');
    });

    it('preserves string ids', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 'my-string-id',
        method: 'tools/list',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;
      expect(response.id).toBe('my-string-id');
    });

    it('preserves numeric ids', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/list',
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;
      expect(response.id).toBe(42);
    });
  });
});

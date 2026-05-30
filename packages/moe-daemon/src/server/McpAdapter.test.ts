import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpAdapter, RateLimiter, type JsonRpcRequest, type JsonRpcResponse } from './McpAdapter.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, invalidState, notAllowed, notFound } from '../util/errors.js';

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

describe('RateLimiter', () => {
  it('keeps bounded O(1) memory and enforces max requests', () => {
    const limiter = new RateLimiter(1000, 60_000);

    for (let i = 0; i < 1000; i++) {
      expect(limiter.checkLimit()).toBe(true);
    }
    expect(limiter.checkLimit()).toBe(false);

    const stats = limiter.getStats();
    expect(stats).toEqual({ current: 1000, max: 1000, windowMs: 60_000 });

    const internal = limiter as unknown as Record<string, unknown>;
    expect(Array.isArray(internal.timestamps)).toBe(false);
    expect(typeof internal.requestCount).toBe('number');
    expect(typeof internal.windowStartMs).toBe('number');
  });

  it('resets request count when window expires', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const limiter = new RateLimiter(2, 100);
    expect(limiter.checkLimit()).toBe(true);
    expect(limiter.checkLimit()).toBe(true);
    expect(limiter.checkLimit()).toBe(false);

    now = 1_101;
    expect(limiter.checkLimit()).toBe(true);
    expect(limiter.getStats().current).toBe(1);
  });
});

describe('McpAdapter', () => {
  let adapter: McpAdapter;
  let mockState: StateManager;

  beforeEach(() => {
    // Real StateManager serializes mutating MCP tool calls through its mutex;
    // the adapter calls state.runExclusive. Pass it through in the mock.
    mockState = {
      runExclusive: <T>(fn: () => Promise<T>) => fn(),
    } as unknown as StateManager;
    adapter = new McpAdapter(mockState);
  });

  function installThrowingTool(name: string, error: Error): void {
    const tools = (adapter as unknown as {
      tools: Map<string, { name: string; description: string; inputSchema: object; handler: () => Promise<unknown> }>;
    }).tools;
    tools.set(name, {
      name,
      description: 'throws a configured error',
      inputSchema: { type: 'object' },
      handler: vi.fn(async () => {
        throw error;
      }),
    });
  }

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

    it('preserves MoeError invalid-input JSON-RPC code without stack data', async () => {
      installThrowingTool('moe.invalid_tool', invalidInput('taskId', 'must be safe'));
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'moe.invalid_tool', arguments: {} },
      };

      const response = (await adapter.handle(request)) as JsonRpcResponse;

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('[INVALID_INPUT]');
      expect(response.error?.data).toEqual({ tool: 'moe.invalid_tool', codeName: 'INVALID_INPUT' });
      expect(JSON.stringify(response.error?.data)).not.toContain('stack');
    });

    it('preserves MoeError not-allowed, not-found, and invalid-state JSON-RPC codes', async () => {
      installThrowingTool('moe.not_allowed_tool', notAllowed('complete_task', 'owned by another worker'));
      installThrowingTool('moe.not_found_tool', notFound('Task', 'task-missing'));
      installThrowingTool('moe.invalid_state_tool', invalidState('Task', 'BACKLOG', 'WORKING'));

      const notAllowedResponse = (await adapter.handle({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'moe.not_allowed_tool', arguments: {} },
      })) as JsonRpcResponse;
      const notFoundResponse = (await adapter.handle({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'moe.not_found_tool', arguments: {} },
      })) as JsonRpcResponse;
      const invalidStateResponse = (await adapter.handle({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'moe.invalid_state_tool', arguments: {} },
      })) as JsonRpcResponse;

      expect(notAllowedResponse.error?.code).toBe(-32003);
      expect(notAllowedResponse.error?.message).toContain('[NOT_ALLOWED]');
      expect(notFoundResponse.error?.code).toBe(-32001);
      expect(notFoundResponse.error?.message).toContain('[TASK_NOT_FOUND]');
      expect(invalidStateResponse.error?.code).toBe(-32002);
      expect(invalidStateResponse.error?.message).toContain('[INVALID_STATE]');
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
    it('rejects oversized batches without executing tool handlers or echoing payloads', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const tools = (adapter as unknown as {
        tools: Map<string, { name: string; description: string; inputSchema: object; handler: typeof handler }>;
      }).tools;
      tools.set('moe.counted_tool', {
        name: 'moe.counted_tool',
        description: 'counts invocations',
        inputSchema: { type: 'object' },
        handler,
      });

      const requests: JsonRpcRequest[] = Array.from({ length: 101 }, (_, idx) => ({
        jsonrpc: '2.0',
        id: idx + 1,
        method: 'tools/call',
        params: { name: 'moe.counted_tool', arguments: { payload: `item-${idx}` } },
      }));

      const response = await adapter.handle(requests);

      expect(Array.isArray(response)).toBe(false);
      const errorResponse = response as JsonRpcResponse;
      expect(errorResponse.error?.code).toBe(-32000);
      expect(errorResponse.error?.message).toContain('Batch size limit exceeded');
      expect(JSON.stringify(errorResponse)).not.toContain('item-100');
      expect(handler).not.toHaveBeenCalled();
    });

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

    it('returns compact errors for malformed batch members without dropping later responses', async () => {
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        null,
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      ] as unknown as JsonRpcRequest[];

      const responses = (await adapter.handle(requests)) as JsonRpcResponse[];

      expect(responses).toHaveLength(3);
      expect(responses[0].error).toBeUndefined();
      expect(responses[1].id).toBeNull();
      expect(responses[1].error?.code).toBe(-32600);
      expect(responses[1].error?.message).toBe('Invalid Request');
      expect(JSON.stringify(responses[1])).not.toContain('Cannot read');
      expect(responses[2].error).toBeUndefined();
    });

    it('charges rate limiting per request in a batch', async () => {
      (adapter as unknown as { rateLimiter: RateLimiter | null }).rateLimiter = new RateLimiter(2, 60_000);
      const requests: JsonRpcRequest[] = [1, 2, 3, 4].map((id) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
      }));

      const responses = (await adapter.handle(requests)) as JsonRpcResponse[];

      expect(responses).toHaveLength(4);
      expect(responses[0].error).toBeUndefined();
      expect(responses[1].error).toBeUndefined();
      expect(responses[2].error?.code).toBe(-32000);
      expect(responses[2].error?.message).toContain('Rate limit exceeded');
      expect(responses[3].error?.code).toBe(-32000);
    });

    it('serializes tools/call items in a batch to avoid concurrent state mutation', async () => {
      let inFlight = 0;
      let sawConcurrentExecution = false;
      const completionOrder: string[] = [];
      const handler = vi.fn(async (args: { label: string }) => {
        inFlight += 1;
        if (inFlight > 1) sawConcurrentExecution = true;
        await Promise.resolve();
        completionOrder.push(args.label);
        inFlight -= 1;
        return { label: args.label };
      });
      const tools = (adapter as unknown as {
        tools: Map<string, { name: string; description: string; inputSchema: object; handler: typeof handler }>;
      }).tools;
      tools.set('moe.serial_tool', {
        name: 'moe.serial_tool',
        description: 'detects concurrent execution',
        inputSchema: { type: 'object' },
        handler,
      });

      const responses = (await adapter.handle([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'moe.serial_tool', arguments: { label: 'first' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'moe.serial_tool', arguments: { label: 'second' } },
        },
      ])) as JsonRpcResponse[];

      expect(responses).toHaveLength(2);
      expect(responses[0].error).toBeUndefined();
      expect(responses[1].error).toBeUndefined();
      expect(sawConcurrentExecution).toBe(false);
      expect(completionOrder).toEqual(['first', 'second']);
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

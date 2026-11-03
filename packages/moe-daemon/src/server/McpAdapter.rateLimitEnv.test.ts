import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { McpAdapter, RateLimiter } from './McpAdapter.js';

describe('McpAdapter rate-limit environment configuration', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    // Fresh logger imports need no development transport workers or exit hooks.
    vi.stubEnv('NODE_ENV', 'production');
    for (const name of [
      'MOE_RATE_LIMIT_ENABLED', 'MOE_RATE_LIMIT_MAX_REQUESTS',
      'MOE_RATE_LIMIT_WINDOW_MS', 'MOE_MCP_MAX_BATCH_SIZE',
    ]) vi.stubEnv(name, undefined);
    h.init();
    h.setupMoeFolder();
    await h.state.load();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    h.cleanup();
  });

  async function loadAdapter() {
    vi.resetModules();
    // A static logger import would spy on the instance discarded by resetModules.
    const { logger } = await import('../util/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    const { McpAdapter, RateLimiter } = await import('./McpAdapter.js');
    return { adapter: new McpAdapter(h.state), RateLimiter, warn };
  }

  function limiter(adapter: McpAdapter): RateLimiter | null {
    return (adapter as unknown as { rateLimiter: RateLimiter | null }).rateLimiter;
  }

  it.each(['abc', '0', '-5', ''])('(r1) defaults invalid max requests %j', async (value) => {
    vi.stubEnv('MOE_RATE_LIMIT_MAX_REQUESTS', value);
    const { adapter, warn } = await loadAdapter();

    expect(limiter(adapter)?.getStats()).toStrictEqual({ current: 0, max: 100, windowMs: 1000 });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { name: 'MOE_RATE_LIMIT_MAX_REQUESTS', value, fallback: 100 },
      'Invalid numeric environment configuration; using fallback',
    );
  });

  it.each(['abc', '0', '-5', ''])('(r2) defaults invalid window %j', async (value) => {
    vi.stubEnv('MOE_RATE_LIMIT_WINDOW_MS', value);
    const { adapter, warn } = await loadAdapter();

    expect(limiter(adapter)?.getStats()).toStrictEqual({ current: 0, max: 100, windowMs: 1000 });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { name: 'MOE_RATE_LIMIT_WINDOW_MS', value, fallback: 1000 },
      'Invalid numeric environment configuration; using fallback',
    );
  });

  it.each([undefined, '2000'])('(r3) enforces valid overrides (window %j)', async (window) => {
    vi.stubEnv('MOE_RATE_LIMIT_MAX_REQUESTS', '5');
    vi.stubEnv('MOE_RATE_LIMIT_WINDOW_MS', window);
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const { adapter, warn } = await loadAdapter();
    const windowMs = window === undefined ? 1000 : 2000;

    expect(limiter(adapter)?.getStats()).toStrictEqual({ current: 0, max: 5, windowMs });
    for (let id = 1; id <= 5; id++) {
      expect(await adapter.handle({ jsonrpc: '2.0', id, method: 'ping' }))
        .toStrictEqual({ jsonrpc: '2.0', id, result: {} });
    }
    expect(await adapter.handle({ jsonrpc: '2.0', id: 6, method: 'ping' })).toStrictEqual({
      jsonrpc: '2.0', id: 6,
      error: { code: -32000, message: `Rate limit exceeded: 5 requests per ${windowMs}ms` },
    });
    expect(warn.mock.calls.filter(([fields]) => (
      typeof fields === 'object' && fields !== null && 'name' in fields
      && String(fields.name).startsWith('MOE_RATE_LIMIT_')
    ))).toHaveLength(0);
  });

  it('(r4) disables the limiter for literal false', async () => {
    vi.stubEnv('MOE_RATE_LIMIT_ENABLED', 'false');
    vi.stubEnv('MOE_RATE_LIMIT_MAX_REQUESTS', '1');
    const { adapter } = await loadAdapter();

    expect(limiter(adapter)).toBeNull();
    for (let id = 1; id <= 5; id++) {
      expect(await adapter.handle({ jsonrpc: '2.0', id, method: 'ping' }))
        .toStrictEqual({ jsonrpc: '2.0', id, result: {} });
    }
  });

  it('(r5) uses the same defaults for invalid constructor arguments', async () => {
    const { RateLimiter } = await loadAdapter();
    expect(new RateLimiter(Number.NaN, -1).getStats())
      .toStrictEqual({ current: 0, max: 100, windowMs: 1000 });
  });

  it('uses silent defaults for unset variables', async () => {
    const { adapter, warn } = await loadAdapter();
    expect(limiter(adapter)?.getStats()).toStrictEqual({ current: 0, max: 100, windowMs: 1000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves base-10 parseInt behavior for valid prefixes and fractions', async () => {
    vi.stubEnv('MOE_RATE_LIMIT_MAX_REQUESTS', '5.9requests');
    vi.stubEnv('MOE_RATE_LIMIT_WINDOW_MS', '2000ms');
    const { adapter, warn } = await loadAdapter();
    expect(limiter(adapter)?.getStats()).toStrictEqual({ current: 0, max: 5, windowMs: 2000 });
    expect(warn).not.toHaveBeenCalled();
  });
});

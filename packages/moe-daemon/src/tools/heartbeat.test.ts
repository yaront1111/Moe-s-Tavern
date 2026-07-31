import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { heartbeatTool } from './heartbeat.js';
import { ToolTestHarness } from './toolTestHarness.js';

const h = new ToolTestHarness();
beforeEach(() => h.init());
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

describe('moe.heartbeat', () => {
  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('refreshes lastActivityAt for a live worker', async () => {
    await h.state.createWorker({
      id: 'worker-hb',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'REVIEWING',
    });
    const before = h.state.getWorker('worker-hb')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = heartbeatTool(h.state);
    const result = await tool.handler({ workerId: 'worker-hb' }, h.state) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(new Date(h.state.getWorker('worker-hb')!.lastActivityAt).getTime())
      .toBeGreaterThan(new Date(before).getTime());
  });

  it('is a no-op for an unknown worker (never throws)', async () => {
    const tool = heartbeatTool(h.state);
    await expect(tool.handler({ workerId: 'worker-does-not-exist' }, h.state))
      .resolves.toEqual({ ok: true });
  });

  it('does not resurrect a DEAD worker', async () => {
    await h.state.createWorker({
      id: 'worker-hb-dead',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'DEAD',
    });
    const before = h.state.getWorker('worker-hb-dead')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = heartbeatTool(h.state);
    await tool.handler({ workerId: 'worker-hb-dead' }, h.state);

    expect(h.state.getWorker('worker-hb-dead')!.lastActivityAt).toBe(before);
    expect(h.state.getWorker('worker-hb-dead')!.status).toBe('DEAD');
  });
});

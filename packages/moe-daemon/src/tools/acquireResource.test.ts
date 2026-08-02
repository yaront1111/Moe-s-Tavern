import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { acquireResourceTool } from './acquireResource.js';
import { releaseResourceTool } from './releaseResource.js';
import { listResourcesTool } from './listResources.js';

describe('moe.acquire_resource / release_resource / list_resources', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: 'worker-2' });
    h.createWorker({ id: 'worker-1' });
    h.createWorker({ id: 'worker-2' });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  });

  it('validates inputs', async () => {
    const tool = acquireResourceTool(h.state);
    await expect(tool.handler({ taskId: 'task-1', workerId: 'worker-1' }, h.state)).rejects.toThrow(/resourceId/);
    await expect(tool.handler({ resourceId: 'box', workerId: 'worker-1' }, h.state)).rejects.toThrow(/taskId/);
    await expect(tool.handler({ resourceId: 'box', taskId: 'task-1' }, h.state)).rejects.toThrow(/workerId/);
    await expect(tool.handler({ resourceId: 'bad id!', taskId: 'task-1', workerId: 'worker-1' }, h.state)).rejects.toThrow(/resourceId/);
    await expect(tool.handler({ resourceId: 'box', taskId: 'task-nope', workerId: 'worker-1' }, h.state)).rejects.toThrow(/not found/i);
    // Ownership: worker-2 may not acquire for worker-1's task.
    await expect(tool.handler({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-2' }, h.state)).rejects.toThrow();
  });

  it('grant → queue → release → next waiter granted', async () => {
    const acquire = acquireResourceTool(h.state);
    const release = releaseResourceTool(h.state);

    const first = await acquire.handler(
      { resourceId: 'box', taskId: 'task-1', workerId: 'worker-1', note: 'suite A' }, h.state
    ) as Record<string, unknown>;
    expect(first.granted).toBe(true);

    const second = await acquire.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2' }, h.state
    ) as Record<string, unknown>;
    expect(second.granted).toBe(false);
    expect(second.position).toBe(1);
    // Queued response steers to report_blocked with the resourceId, which is
    // what enables auto-unblock-on-grant.
    expect(second.nextAction).toMatchObject({
      tool: 'moe.report_blocked',
      args: { taskId: 'task-2', resourceId: 'box' },
    });

    const released = await release.handler(
      { resourceId: 'box', workerId: 'worker-1' }, h.state
    ) as Record<string, unknown>;
    expect(released.released).toEqual(['task-1']);
    expect(released.grantedTo).toEqual(['task-2']);
  });

  it('list_resources shows declared config, holders and ordered queue', async () => {
    await h.state.updateSettings({ resources: { box: { capacity: 1, maxLeaseMs: 3600000, description: 'benchmark box' } } });
    const acquire = acquireResourceTool(h.state);
    await acquire.handler({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' }, h.state);
    await acquire.handler({ resourceId: 'box', taskId: 'task-2', workerId: 'worker-2' }, h.state);

    const list = listResourcesTool(h.state);
    const result = await list.handler({}, h.state) as { resources: Array<Record<string, unknown>> };
    expect(result.resources).toHaveLength(1);
    const box = result.resources[0];
    expect(box.id).toBe('box');
    expect(box.capacity).toBe(1);
    expect(box.maxLeaseMs).toBe(3600000);
    expect(box.description).toBe('benchmark box');
    expect((box.holders as Array<{ taskId: string }>).map((x) => x.taskId)).toEqual(['task-1']);
    expect((box.queue as Array<{ taskId: string; position: number }>)[0]).toMatchObject({ taskId: 'task-2', position: 1 });
  });

  it('list_resources shows declared-but-idle resources', async () => {
    await h.state.updateSettings({ resources: { 'gpu-a': { capacity: 2 } } });
    const list = listResourcesTool(h.state);
    const result = await list.handler({}, h.state) as { resources: Array<Record<string, unknown>> };
    expect(result.resources.map((r) => r.id)).toEqual(['gpu-a']);
    expect(result.resources[0].capacity).toBe(2);
  });

  it('settings validator rejects malformed resource declarations', async () => {
    await expect(h.state.updateSettings({ resources: { 'bad id!': {} } })).rejects.toThrow(/resource id/);
    await expect(h.state.updateSettings({ resources: { box: { capacity: 0 } } })).rejects.toThrow(/capacity/);
    await expect(h.state.updateSettings({ resources: { box: { maxLeaseMs: 5 } } })).rejects.toThrow(/maxLeaseMs/);
    await expect(h.state.updateSettings({ resources: { box: { unknown: 1 } } })).rejects.toThrow(/not a supported/);
  });
});

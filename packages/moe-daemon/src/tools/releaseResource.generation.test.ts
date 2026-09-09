import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { acquireResourceTool } from './acquireResource.js';
import { releaseResourceTool } from './releaseResource.js';

// Regression for a live incident (2026-09-09): a governor read list_resources,
// saw a 12h lease held by a deregistered worker, paused ~17 minutes on a
// human-in-the-loop question, then force-released with `taskId` set. In the
// interval the lease had legitimately changed hands twice, so the force tore
// off a live QA lease acquired 5 minutes earlier. `taskId` scopes a TASK, not a
// lease generation, and the result named only task ids — so the mistake was
// invisible both before and after the call.
describe('moe.release_resource generation preconditions', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createWorker({ id: 'worker-1' });
    h.createWorker({ id: 'worker-2' });
    h.createWorker({ id: 'governor-1' });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  });

  /**
   * Put task-1's lease in worker-N's hands, releasing any prior holder first.
   * The row is reassigned too: acquire_resource enforces that the caller owns
   * the task, and the incident's real handovers were row reassignments.
   */
  async function handOver(to: string) {
    const acquire = acquireResourceTool(h.state);
    const release = releaseResourceTool(h.state);
    await release.handler({ resourceId: 'gate', workerId: 'governor-1', taskId: 'task-1', force: true }, h.state);
    const task = h.state.getTask('task-1')!;
    task.assignedWorkerId = to;
    const got = await acquire.handler({ resourceId: 'gate', taskId: 'task-1', workerId: to }, h.state) as Record<string, unknown>;
    expect(got.granted).toBe(true);
  }

  it('refuses a forced release when the lease changed hands since it was read', async () => {
    const release = releaseResourceTool(h.state);
    await handOver('worker-1');

    // The generation the caller measured.
    const measured = h.state.getResource('gate')!.holders[0];
    expect(measured.workerId).toBe('worker-1');

    // Time passes; the lease legitimately moves to worker-2.
    await handOver('worker-2');

    await expect(release.handler(
      { resourceId: 'gate', workerId: 'governor-1', taskId: 'task-1', force: true, ifHolderWorkerId: 'worker-1' },
      h.state
    )).rejects.toThrow(/worker-2/);

    // Nothing was released: worker-2 still holds it.
    expect(h.state.getResource('gate')!.holders.map((l) => l.workerId)).toEqual(['worker-2']);
  });

  it('refuses when the same worker re-acquired a NEW lease generation', async () => {
    const release = releaseResourceTool(h.state);
    await handOver('worker-1');
    const firstAcquiredAt = h.state.getResource('gate')!.holders[0].acquiredAt;

    vi.setSystemTime(new Date(Date.parse(firstAcquiredAt) + 60_000));
    await handOver('worker-1');
    const secondAcquiredAt = h.state.getResource('gate')!.holders[0].acquiredAt;
    expect(secondAcquiredAt).not.toBe(firstAcquiredAt);

    // ifHolderWorkerId alone passes (same worker) — only ifAcquiredAt catches this.
    await expect(release.handler(
      { resourceId: 'gate', workerId: 'governor-1', taskId: 'task-1', force: true, ifAcquiredAt: firstAcquiredAt },
      h.state
    )).rejects.toThrow(/re-acquired|acquired at/i);

    expect(h.state.getResource('gate')!.holders).toHaveLength(1);
  });

  it('proceeds when the precondition still holds, and names the holder it tore off', async () => {
    const release = releaseResourceTool(h.state);
    await handOver('worker-1');

    const res = await release.handler(
      { resourceId: 'gate', workerId: 'governor-1', taskId: 'task-1', force: true, ifHolderWorkerId: 'worker-1' },
      h.state
    ) as Record<string, unknown>;

    expect(res.released).toEqual(['task-1']);
    // The identity that was missing from the result during the incident.
    expect(res.releasedHolders).toMatchObject([{ taskId: 'task-1', workerId: 'worker-1' }]);
    expect(String(res.message)).toMatch(/worker-1/);
    expect(h.state.getResource('gate')!.holders).toHaveLength(0);
  });

  it('refuses rather than silently no-opping when the asserted lease is gone entirely', async () => {
    const release = releaseResourceTool(h.state);
    await handOver('worker-1');
    await release.handler({ resourceId: 'gate', workerId: 'worker-1', taskId: 'task-1' }, h.state);
    expect(h.state.getResource('gate')!.holders).toHaveLength(0);

    // Release is normally idempotent, but a stated precondition that cannot be
    // true is a caller error, not a no-op.
    await expect(release.handler(
      { resourceId: 'gate', workerId: 'governor-1', taskId: 'task-1', force: true, ifHolderWorkerId: 'worker-1' },
      h.state
    )).rejects.toThrow(/no holders/i);
  });

  it('leaves the unconditional path idempotent for exit traps', async () => {
    const release = releaseResourceTool(h.state);
    const res = await release.handler(
      { resourceId: 'gate', workerId: 'worker-1', taskId: 'task-1' }, h.state
    ) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(res.released).toEqual([]);
    expect(res.releasedHolders).toEqual([]);
  });
});

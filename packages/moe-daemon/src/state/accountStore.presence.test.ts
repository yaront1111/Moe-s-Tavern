import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { leaseAccountTool } from '../tools/leaseAccount.js';
import { reportAccountUsageTool } from '../tools/reportAccountUsage.js';
import { runBlockedTimeoutSweep } from './sweeps.js';
import { addAccount, recordSignIn } from '../accounts/registry.js';
import type { Worker } from '../types/schema.js';

// A seat's presence (lastActivityAt) comes from its own calls and heartbeats.
// A wrapper parked in MOE_ACCOUNT_WAIT (every signed-in account spent) runs no
// CLI and no heartbeat sidecar: its moe.lease_account polls, at most
// MOE_ACCOUNT_RETRY_SEC apart, are its only presence. Before this fix
// settleLease touched the seat only when its accountId changed, so every
// all-spent reply (accountId null) left lastActivityAt alone and the REVIEW
// self-heal released a waiting QA seat's row after reviewStaleTimeoutMs
// (2026-11-03: three QA wrappers then reviewed the same row).

const VITEST_ACCOUNTS_FILE = process.env.MOE_ACCOUNTS_FILE;
const STALE = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

describe('moe.lease_account counts as presence for the calling seat', () => {
  const h = new ToolTestHarness();
  let accountsFile: string;

  beforeEach(async () => {
    h.init();
    accountsFile = path.join(h.testDir, 'machine', 'claude-accounts.json');
    process.env.MOE_ACCOUNTS_FILE = accountsFile;
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-review', status: 'REVIEW', assignedWorkerId: 'qa-wait' });
    h.createWorker({ id: 'qa-wait', currentTaskId: 'task-review', status: 'READING_CONTEXT', lastActivityAt: STALE });
    await h.state.load();
    // Absorbs the all-spent #governors alert.
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (VITEST_ACCOUNTS_FILE === undefined) delete process.env.MOE_ACCOUNTS_FILE;
    else process.env.MOE_ACCOUNTS_FILE = VITEST_ACCOUNTS_FILE;
    h.cleanup();
  });

  const lease = (id = 'qa-wait') => leaseAccountTool(h.state).handler({ workerId: id }, h.state) as Promise<Record<string, unknown>>;
  // The real REVIEW self-heal (state/sweeps.ts), under the mutex the daemon's timer takes.
  const sweep = () => h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));
  const seat = (id = 'qa-wait'): Worker => h.state.getWorker(id)!;
  const hasOwnAccountId = (worker: Worker): boolean => Object.prototype.hasOwnProperty.call(worker, 'accountId');
  const stampMs = (worker: Worker): number => Date.parse(worker.lastActivityAt);

  function signIn(): void {
    addAccount(accountsFile, 'One');
    addAccount(accountsFile, 'Two');
    recordSignIn(accountsFile, 'acct-1', 'subscription');
    recordSignIn(accountsFile, 'acct-2', 'subscription');
  }

  /**
   * Both accounts past the switch percent. The reports name NO seat: a report
   * that names qa-wait learns its account back through settleLease and touches
   * the seat, which would mask the control case.
   */
  async function spendAll(): Promise<void> {
    signIn();
    for (const accountId of ['acct-1', 'acct-2']) {
      await reportAccountUsageTool(h.state).handler({
        accountId,
        windows: { five_hour: { utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed' } },
      }, h.state);
    }
  }

  it('(p1) an all-spent reply refreshes lastActivityAt, writes no accountId, and the REVIEW self-heal keeps the row', async () => {
    await spendAll();
    const before = Date.now();
    const reply = await lease();
    expect(reply).toMatchObject({ rotation: true, accountId: null, switchAtPercent: 90 });
    expect(typeof reply.retryAt).toBe('string');
    expect(reply.retryInSec as number).toBeGreaterThan(0);
    expect(stampMs(seat())).toBeGreaterThanOrEqual(before);
    expect(hasOwnAccountId(seat())).toBe(false);

    await sweep();
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-wait' });
    expect(seat().currentTaskId).toBe('task-review');
  });

  it('(p2) control: the same stale seat without a lease loses its REVIEW row to the self-heal', async () => {
    await spendAll();
    expect(Date.now() - stampMs(seat())).toBeGreaterThan(h.state.reviewStaleTimeoutMs);
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-wait' });

    await sweep();
    // The Layer-3 prune deletes the stale seat in the same sweep, so it is not read here.
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
  });

  it('(p3) a rotation:false reply refreshes lastActivityAt, writes no accountId, and the row stays held', async () => {
    const before = Date.now();
    expect(await lease()).toEqual({ rotation: false, reason: null });
    expect(stampMs(seat())).toBeGreaterThanOrEqual(before);
    expect(hasOwnAccountId(seat())).toBe(false);

    await sweep();
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-wait' });
  });

  it('(p4) a repeat lease of the same account refreshes lastActivityAt and keeps the accountId', async () => {
    signIn();
    expect(await lease()).toMatchObject({ rotation: true, accountId: 'acct-1' });
    expect(seat().accountId).toBe('acct-1');

    // updateWorker keeps an explicit lastActivityAt: make the seat stale again.
    await h.state.updateWorker('qa-wait', { lastActivityAt: STALE });
    const before = Date.now();
    expect(await lease()).toMatchObject({ rotation: true, accountId: 'acct-1' });
    expect(seat().accountId).toBe('acct-1');
    expect(stampMs(seat())).toBeGreaterThanOrEqual(before);

    await sweep();
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-wait' });
  });

  it('(p5) a lease for an unknown workerId creates no worker record, in memory or on disk', async () => {
    await spendAll();
    expect(await lease('qa-ghost')).toMatchObject({ rotation: true, accountId: null });
    expect(h.state.getWorker('qa-ghost')).toBeNull();
    expect(fs.existsSync(path.join(h.moePath, 'workers', 'qa-ghost.json'))).toBe(false);
  });

  it('(p6) a lease for a DEAD seat leaves its stored lastActivityAt and status unchanged', async () => {
    await h.state.createWorker({ id: 'qa-dead', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE' });
    // Stale first, THEN DEAD: the DEAD flip keeps the stored time.
    await h.state.updateWorker('qa-dead', { lastActivityAt: STALE });
    await h.state.updateWorker('qa-dead', { status: 'DEAD' });
    expect(seat('qa-dead')).toMatchObject({ status: 'DEAD', lastActivityAt: STALE });

    await spendAll();
    expect(await lease('qa-dead')).toMatchObject({ rotation: true, accountId: null });
    expect(seat('qa-dead')).toMatchObject({ status: 'DEAD', lastActivityAt: STALE });
  });
});

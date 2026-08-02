import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from './StateManager.js';
import {
  DEFAULT_MAX_LEASE_MS,
  getQueuePosition,
} from './resourceStore.js';
import type { Project, Task } from '../types/schema.js';

describe('resourceStore', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function writeTask(id: string, overrides: Partial<Task> = {}): void {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: id, description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: `worker-${id}`, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  }

  function setupMoe(settingsOverrides: Record<string, unknown> = {}): void {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages', 'resources']) {
      fs.mkdirSync(path.join(moePath, sub), { recursive: true });
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
        ...settingsOverrides,
      } as Project['settings'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-resource-store-'));
    moePath = path.join(testDir, '.moe');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function loadState(settingsOverrides: Record<string, unknown> = {}): Promise<void> {
    setupMoe(settingsOverrides);
    state = new StateManager({ projectPath: testDir });
    await state.load();
    vi.spyOn(state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(state, 'postSystemMessage').mockResolvedValue();
  }

  it('grants immediately when capacity is free and persists the lease', async () => {
    await loadState();
    writeTask('t1');
    await state.load();
    const result = await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    expect(result.granted).toBe(true);
    expect(result.lease!.taskId).toBe('t1');
    expect(Date.parse(result.lease!.expiresAt) - Date.parse(result.lease!.acquiredAt)).toBe(DEFAULT_MAX_LEASE_MS);
    // Persisted to .moe/resources/box.json.
    const onDisk = JSON.parse(fs.readFileSync(path.join(moePath, 'resources', 'box.json'), 'utf-8'));
    expect(onDisk.holders).toHaveLength(1);
    expect(onDisk.holders[0].taskId).toBe('t1');
  });

  it('is idempotent per task: re-acquire renews the lease instead of queueing', async () => {
    await loadState();
    writeTask('t1');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    const again = await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1', note: 'still running' });
    expect(again.granted).toBe(true);
    expect(state.getResource('box')!.holders).toHaveLength(1);
    expect(state.getResource('box')!.queue).toHaveLength(0);
    expect(state.getResource('box')!.holders[0].note).toBe('still running');
  });

  it('queues when capacity is taken and reports 1-based position', async () => {
    await loadState();
    writeTask('t1'); writeTask('t2'); writeTask('t3');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    const q1 = await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    const q2 = await state.acquireResource({ resourceId: 'box', taskId: 't3', workerId: 'w3' });
    expect(q1.granted).toBe(false);
    expect(q1.position).toBe(1);
    expect(q2.position).toBe(2);
    expect(getQueuePosition(state, 'box', 't3')).toBe(2);
  });

  it('orders the queue by task priority then FIFO', async () => {
    await loadState();
    writeTask('t1');
    writeTask('t-low', { priority: 'LOW' });
    writeTask('t-crit', { priority: 'CRITICAL' });
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't-low', workerId: 'w2' });
    await state.acquireResource({ resourceId: 'box', taskId: 't-crit', workerId: 'w3' });
    // CRITICAL jumps the earlier-queued LOW.
    expect(getQueuePosition(state, 'box', 't-crit')).toBe(1);
    expect(getQueuePosition(state, 'box', 't-low')).toBe(2);
    const releaseResult = await state.releaseResource({ resourceId: 'box', workerId: 'w1' });
    expect(releaseResult.granted.map((l) => l.taskId)).toEqual(['t-crit']);
  });

  it('respects declared capacity > 1', async () => {
    await loadState({ resources: { box: { capacity: 2 } } });
    writeTask('t1'); writeTask('t2'); writeTask('t3');
    await state.load();
    const a = await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    const b = await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    const c = await state.acquireResource({ resourceId: 'box', taskId: 't3', workerId: 'w3' });
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(c.granted).toBe(false);
    expect(c.position).toBe(1);
  });

  it('release grants to the next waiter and auto-unblocks its BLOCKED task', async () => {
    await loadState();
    writeTask('t1');
    writeTask('t2', {
      status: 'BLOCKED',
      blockedReason: 'waiting for box',
      blockedResourceId: 'box',
      blockedFromStatus: 'WORKING',
      blockedAt: new Date().toISOString(),
    });
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });

    const result = await state.releaseResource({ resourceId: 'box', workerId: 'w1' });
    expect(result.released.map((l) => l.taskId)).toEqual(['t1']);
    expect(result.granted.map((l) => l.taskId)).toEqual(['t2']);
    const t2 = state.getTask('t2')!;
    expect(t2.status).toBe('WORKING');
    expect(t2.blockedResourceId).toBeNull();
    expect(t2.blockedReason).toBeNull();
    expect(t2.blockedFromStatus).toBeNull();
    expect(t2.blockedAt).toBeNull();
  });

  it('grant restores blockedFromStatus (a blocked QA task returns to REVIEW)', async () => {
    await loadState();
    writeTask('t1');
    writeTask('t2', {
      status: 'BLOCKED',
      blockedResourceId: 'box',
      blockedFromStatus: 'REVIEW',
      blockedAt: new Date().toISOString(),
    });
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    await state.releaseResource({ resourceId: 'box', workerId: 'w1' });
    expect(state.getTask('t2')!.status).toBe('REVIEW');
  });

  it('the task\'s CURRENT assignee can release a lease acquired under a purged workerId', async () => {
    // REGRESSION GUARD: leases are task-keyed to survive daemon-restart worker
    // purges — the successor wrapper session (fresh workerId) re-claims the
    // task and must be able to release the predecessor's lease.
    await loadState();
    writeTask('t1', { assignedWorkerId: 'w1-respawn' });
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1-original' });
    const result = await state.releaseResource({ resourceId: 'box', workerId: 'w1-respawn', taskId: 't1' });
    expect(result.released.map((l) => l.taskId)).toEqual(['t1']);
    expect(state.getResource('box')!.holders).toHaveLength(0);
  });

  it('release is idempotent: releasing nothing is a no-op, not an error', async () => {
    await loadState();
    writeTask('t1');
    await state.load();
    const result = await state.releaseResource({ resourceId: 'box', workerId: 'w-nobody' });
    expect(result.released).toEqual([]);
    expect(result.granted).toEqual([]);
  });

  it('non-force release only touches the caller\'s own lease', async () => {
    await loadState({ resources: { box: { capacity: 2 } } });
    writeTask('t1'); writeTask('t2');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    // Wrong worker, no force: t1's lease survives.
    const result = await state.releaseResource({ resourceId: 'box', workerId: 'w2', taskId: 't1' });
    expect(result.released).toEqual([]);
    expect(state.getResource('box')!.holders).toHaveLength(2);
    // force releases regardless of ownership.
    const forced = await state.releaseResource({ resourceId: 'box', workerId: 'w2', taskId: 't1', force: true });
    expect(forced.released.map((l) => l.taskId)).toEqual(['t1']);
  });

  it('reaper force-releases an expired lease and grants onward', async () => {
    await loadState();
    writeTask('t1'); writeTask('t2');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    const reaped = await state.reapResources(Date.now() + DEFAULT_MAX_LEASE_MS + 1000);
    expect(reaped).toBe(1);
    expect(state.getResource('box')!.holders.map((h) => h.taskId)).toEqual(['t2']);
  });

  it('reaper drops leases and queue entries whose task left the active statuses', async () => {
    await loadState();
    writeTask('t1', { status: 'DONE' });
    writeTask('t2');
    writeTask('t3', { status: 'ARCHIVED' });
    await state.load();
    // Force the state in directly (t1 finished after acquiring).
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    await state.acquireResource({ resourceId: 'box', taskId: 't2', workerId: 'w2' });
    await state.acquireResource({ resourceId: 'box', taskId: 't3', workerId: 'w3' });
    const reaped = await state.reapResources();
    // t1's lease (DONE) and t3's queue entry (ARCHIVED) reaped; t2 granted.
    expect(reaped).toBe(2);
    expect(state.getResource('box')!.holders.map((h) => h.taskId)).toEqual(['t2']);
    expect(state.getResource('box')!.queue).toHaveLength(0);
  });

  it('leases survive a reload (task-keyed persistence)', async () => {
    await loadState();
    writeTask('t1');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    const reloaded = new StateManager({ projectPath: testDir });
    await reloaded.load();
    expect(reloaded.getResource('box')!.holders.map((h) => h.taskId)).toEqual(['t1']);
    reloaded.clearEmitter();
  });

  it('getSnapshot exposes resources', async () => {
    await loadState();
    writeTask('t1');
    await state.load();
    await state.acquireResource({ resourceId: 'box', taskId: 't1', workerId: 'w1' });
    const snapshot = state.getSnapshot();
    expect(snapshot.resources.map((r) => r.id)).toEqual(['box']);
  });
});

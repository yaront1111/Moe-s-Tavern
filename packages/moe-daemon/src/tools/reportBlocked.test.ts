import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { reportBlockedTool } from './reportBlocked.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';
import { runDependencyUnblock } from '../state/dependencyUnblock.js';
import type { Epic, Project, Task, TeamRole } from '../types/schema.js';

describe('moe.report_blocked', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let generalPosts: string[];
  let rolePosts: Array<[string, string]>;

  function setupMoe(): void {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO',
        speedModeDelayMs: 2000,
        autoCreateBranch: false,
        branchPattern: '',
        commitPattern: '',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));

    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));

    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'worker-1', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
  }

  /** Register `workerId`, put it on a team with `role`, then stamp its freshness. */
  async function addWorker(workerId: string, role: TeamRole | null, secondsAgo: number): Promise<void> {
    await state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    if (role) {
      let team = Array.from(state.teams.values()).find(t => t.role === role);
      if (!team) team = await state.createTeam({ name: `${role}s`, role });
      // addTeamMember updates the worker (and therefore bumps lastActivityAt),
      // so the freshness stamp has to come after the join, never before.
      await state.addTeamMember(team.id, workerId);
    }
    await state.updateWorker(workerId, {
      lastActivityAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    });
  }

  async function report(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const tool = reportBlockedTool(state);
    return await tool.handler(
      { taskId: 'task-1', reason: 'npm install fails behind the proxy', workerId: 'worker-1', ...args },
      state
    ) as Record<string, unknown>;
  }

  /** General-channel posts that carry an @mention (postSystemMessage's copy does not). */
  function mentionedGeneralPosts(): string[] {
    return generalPosts.filter(content => content.startsWith('@'));
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-report-blocked-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
    await state.load();
    await addWorker('worker-1', 'worker', 1);

    generalPosts = [];
    rolePosts = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => {
      generalPosts.push(content);
    });
    vi.spyOn(state, 'postToRoleChannel').mockImplementation(async (role: string, content: string) => {
      rolePosts.push([role, content]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('direct-mentions the single live architect in #general and #architects', async () => {
    await addWorker('architect-a', 'architect', 5);

    const result = await report();

    expect(result.notified).toEqual({ target: 'architect-a', via: 'freshest-live-architect' });
    expect(result.message).toBe('Task blocked; seat freed — claim other work. Pinged architect-a (freshest live architect).');

    // Exactly one general copy is prefixed — postSystemMessage forwards to the
    // same channel, so a second prefixed copy would page architect-a twice.
    expect(mentionedGeneralPosts()).toHaveLength(1);
    expect(mentionedGeneralPosts()[0]).toMatch(/^@architect-a 🚧 worker-1 blocked on task-1: /);
    // Three unprefixed+prefixed general posts total: the taskStore's
    // "Task moved to BLOCKED" status-change message (report_blocked now flips
    // the task), postSystemMessage's general forward, and the mentioned copy.
    expect(generalPosts).toHaveLength(3);

    expect(rolePosts).toContainEqual(['architects', mentionedGeneralPosts()[0]]);
  });

  it('mentions the architect with the freshest lastActivityAt', async () => {
    await addWorker('architect-a', 'architect', 90);
    await addWorker('architect-b', 'architect', 4);
    await addWorker('architect-c', 'architect', 45);

    const result = await report();

    expect(result.notified).toEqual({ target: 'architect-b', via: 'freshest-live-architect' });
    expect(mentionedGeneralPosts()[0]).toMatch(/^@architect-b /);
  });

  it('falls back to @governors when every architect is stale or DEAD', async () => {
    await addWorker('architect-stale', 'architect', LIVENESS_TIMEOUT_MS / 1000 + 60);
    await addWorker('architect-dead', 'architect', 2);
    // Marking DEAD preserves lastActivityAt, so this one is fresh but terminal.
    await state.updateWorker('architect-dead', { status: 'DEAD' });

    const result = await report();

    expect(result.notified).toEqual({ target: '@governors', via: 'governors-fallback' });
    expect(result.message).toBe('Task blocked; seat freed — claim other work. No live architect — escalated to @governors.');
    expect(mentionedGeneralPosts()[0]).toMatch(/^@governors /);
    // Nobody to page in #architects — the escalation carries the mention instead.
    expect(rolePosts.map(([role]) => role)).not.toContain('architects');
    expect(rolePosts.find(([role]) => role === 'governors')![1]).toMatch(/^@governors /);
  });

  it('falls back to @governors when no architect team exists at all', async () => {
    const result = await report();

    expect(result.notified).toEqual({ target: '@governors', via: 'governors-fallback' });
    expect(mentionedGeneralPosts()[0]).toMatch(/^@governors /);
  });

  it('never pings the blocked worker itself, even when it is the only live architect', async () => {
    // An architect blocked on its own PLANNING task: self-mention would
    // dead-end the escalation.
    const team = await state.createTeam({ name: 'architects', role: 'architect' });
    await state.addTeamMember(team.id, 'worker-1');
    await state.updateWorker('worker-1', { lastActivityAt: new Date().toISOString() });

    const result = await report();

    expect(result.notified).toEqual({ target: '@governors', via: 'governors-fallback' });
    expect(mentionedGeneralPosts()[0]).not.toContain('@worker-1');
  });

  it('always posts to #governors, with or without a live architect', async () => {
    await addWorker('architect-a', 'architect', 5);
    await report();
    // Governors keep visibility of the block without being paged for it.
    expect(rolePosts.find(([role]) => role === 'governors')![1]).toMatch(/^🚧 worker-1 blocked on task-1: /);

    rolePosts = [];
    await state.updateWorker('architect-a', { lastActivityAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    // A DIFFERENT reason on purpose: this arm's subject is the @governors
    // mention once no architect is live, and a byte-identical repeat is now
    // deliberately silent (it writes nothing, so it pages nobody).
    await report({ reason: 'proxy still down, and the mirror is gone too' });
    expect(rolePosts.find(([role]) => role === 'governors')![1]).toMatch(/^@governors 🚧 /);
  });

  it('still succeeds and still frees the seat when every chat post rejects', async () => {
    await addWorker('architect-a', 'architect', 5);
    vi.spyOn(state, 'postSystemMessage').mockRejectedValue(new Error('chat down'));
    vi.mocked(state.postToGeneral).mockRejectedValue(new Error('chat down'));
    vi.mocked(state.postToRoleChannel).mockRejectedValue(new Error('chat down'));

    const result = await report();

    expect(result.success).toBe(true);
    expect(result.notified).toEqual({ target: 'architect-a', via: 'freshest-live-architect' });
    // Non-resource block: the seat is freed even when chat is down.
    expect(state.getWorker('worker-1')!.status).toBe('IDLE');
    expect(state.getTask('task-1')!.status).toBe('BLOCKED');
  });

  it('keeps the validation contract, flips the task to BLOCKED and FREES the seat (non-resource)', async () => {
    await expect(report({ reason: '   ' })).rejects.toThrow(/reason/);
    await expect(report({ reason: 'x'.repeat(2001) })).rejects.toThrow(/too long/);
    await expect(report({ taskId: 'task-nope' })).rejects.toThrow(/not found|NOT_FOUND/i);
    await expect(report({ blockedOnTaskIds: 'task-2' })).rejects.toThrow(/blockedOnTaskIds/);
    await expect(report({ blockedOnTaskIds: [42] })).rejects.toThrow(/blockedOnTaskIds/);

    const result = await report();
    expect(result.success).toBe(true);
    // The task itself parks — but unlike a resource block, the SEAT IS FREED:
    // the deadlock the old hold+idle design produced was a fleet where every
    // seat held a blocked task and starved. The wrapper checkpointed the work
    // at block time (bf3f8fa), so any worker can resume from the landed bytes.
    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.seatFreed).toBe(true);
    expect(result.workerStatus).toBe('IDLE');
    const task = state.getTask('task-1')!;
    expect(task.status).toBe('BLOCKED');
    // Seat-freeing contract: assignment cleared, worker IDLE with no task
    // pointer, task keeps its block bookkeeping (release_task semantics).
    expect(task.assignedWorkerId).toBeNull();
    expect(state.getWorker('worker-1')!.status).toBe('IDLE');
    expect(state.getWorker('worker-1')!.currentTaskId).toBeNull();
    expect(task.blockedFromStatus).toBe('WORKING');
    expect(task.blockedReason).toBe('npm install fails behind the proxy');
    expect(task.blockedResourceId).toBeNull();
    expect(task.blockedAt).toEqual(expect.any(String));
    // The freed worker is pointed at OTHER work, not at waiting on this task.
    expect(result.nextAction).toMatchObject({
      tool: 'moe.claim_next_task',
      args: { workerId: 'worker-1', statuses: ['WORKING'] },
    });
  });

  it('resourceId: grants a free resource instead of blocking', async () => {
    const result = await report({ resourceId: 'benchmark-box' });
    expect(result.granted).toBe(true);
    expect(result.lease).toMatchObject({ taskId: 'task-1', workerId: 'worker-1' });
    // Nothing blocked anywhere: the resource was free, so work proceeds.
    expect(result.taskStatus).toBe('WORKING');
    expect(state.getTask('task-1')!.status).toBe('WORKING');
    expect(state.getWorker('worker-1')!.status).not.toBe('BLOCKED');
    expect(state.getResource('benchmark-box')!.holders).toHaveLength(1);
  });

  it('resourceId: queues behind a holder, parks the task, and auto-unblocks on grant', async () => {
    // Another task holds the box.
    const now = new Date().toISOString();
    const holderTask = {
      id: 'task-holder', epicId: 'epic-1', title: 'Holder', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING' as const, assignedWorkerId: 'worker-holder', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN' as const, parentTaskId: null,
      priority: 'MEDIUM' as const, order: 2, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-holder.json'), JSON.stringify(holderTask, null, 2));
    await state.load();
    await addWorker('worker-holder', 'worker', 1);
    // load() re-created maps; re-stub the chat spies' target state object.
    vi.spyOn(state, 'postToGeneral').mockImplementation(async () => {});
    vi.spyOn(state, 'postToRoleChannel').mockImplementation(async () => {});
    await state.acquireResource({ resourceId: 'benchmark-box', taskId: 'task-holder', workerId: 'worker-holder' });

    const result = await report({ resourceId: 'benchmark-box' });
    expect(result.granted).toBe(false);
    expect(result.taskStatus).toBe('BLOCKED');
    // Resource blocks emit NO nextAction: ending the session is the correct
    // next step (the wrapper idles; the daemon auto-unblocks on grant).
    expect(result.nextAction).toBeUndefined();
    // Resource blocks KEEP the seat — the grant path returns the task to the
    // same parked worker by design (seat-freeing is non-resource only).
    expect(result.seatFreed).toBe(false);
    const blocked = state.getTask('task-1')!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.assignedWorkerId).toBe('worker-1');
    expect(blocked.blockedResourceId).toBe('benchmark-box');
    expect(blocked.blockedFromStatus).toBe('WORKING');

    // Holder releases → lease granted to task-1 → task auto-unblocks BACK TO
    // ITS PARKED WORKER (assignment must survive both status flips).
    await state.releaseResource({ resourceId: 'benchmark-box', workerId: 'worker-holder' });
    const unblocked = state.getTask('task-1')!;
    expect(unblocked.status).toBe('WORKING');
    expect(unblocked.assignedWorkerId).toBe('worker-1');
    expect(unblocked.blockedResourceId).toBeNull();
    expect(unblocked.blockedReason).toBeNull();
    expect(unblocked.blockedAt).toBeNull();
    expect(state.getResource('benchmark-box')!.holders.map((h) => h.taskId)).toEqual(['task-1']);
  });

  it('resourceId on an UNASSIGNED task still enqueues, so the grant can un-block it', async () => {
    // Holder occupies the box; task-1 is released (unassigned) mid-block.
    const now = new Date().toISOString();
    const holderTask = {
      id: 'task-holder', epicId: 'epic-1', title: 'Holder', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING' as const, assignedWorkerId: 'worker-holder', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN' as const, parentTaskId: null,
      priority: 'MEDIUM' as const, order: 2, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-holder.json'), JSON.stringify(holderTask, null, 2));
    await state.load();
    await state.updateTask('task-1', { assignedWorkerId: null });
    vi.spyOn(state, 'postToGeneral').mockImplementation(async () => {});
    vi.spyOn(state, 'postToRoleChannel').mockImplementation(async () => {});
    await state.acquireResource({ resourceId: 'benchmark-box', taskId: 'task-holder', workerId: 'worker-holder' });

    // Operator flow: no workerId on the call, task unassigned.
    const tool = reportBlockedTool(state);
    const result = await tool.handler(
      { taskId: 'task-1', reason: 'needs the box', resourceId: 'benchmark-box' }, state
    ) as Record<string, unknown>;
    expect(result.taskStatus).toBe('BLOCKED');
    // The queue entry exists even though nobody is assigned — without it the
    // grant path could never auto-unblock this task.
    expect(state.getResource('benchmark-box')!.queue.map((q) => q.taskId)).toEqual(['task-1']);

    await state.releaseResource({ resourceId: 'benchmark-box', workerId: 'worker-holder' });
    const unblocked = state.getTask('task-1')!;
    expect(unblocked.status).toBe('WORKING');
    expect(unblocked.assignedWorkerId).toBeNull();
  });

  // ---- structured dependency ids (blockedOnTaskIds) ----

  it('records validated blockedOnTaskIds, auto-parses ids out of the reason, and reports ignored strays', async () => {
    const depA = await state.createTask({ epicId: 'epic-1', title: 'Dep A', status: 'WORKING' });
    const depB = await state.createTask({ epicId: 'epic-1', title: 'Dep B', status: 'BACKLOG' });

    const result = await report({
      reason: `BUILD-ORDER BLOCK on ${depA.id}; also mentions task-eeeeee which was deleted, and itself task-1`,
      blockedOnTaskIds: [depB.id, depB.id, 'task-nope'],
    }) as Record<string, unknown>;

    const task = state.getTask('task-1')!;
    // Supplied ids first, then reason-parsed ids; deduped; own id and unknown
    // ids never stored (a missing id counts as satisfied anyway).
    expect(task.blockedOnTaskIds).toEqual([depB.id, depA.id]);
    expect(result.blockedOnTaskIds).toEqual([depB.id, depA.id]);
    // Only EXPLICITLY supplied unknown ids are reported back; parsed strays
    // (deleted rows) vanish silently.
    expect(result.ignoredBlockedOnTaskIds).toEqual(['task-nope']);
  });

  it('a repeat carrying NEW blockedOnTaskIds is not an identical repeat — ids union, provenance survives', async () => {
    const depA = await state.createTask({ epicId: 'epic-1', title: 'Dep A', status: 'WORKING' });
    const depB = await state.createTask({ epicId: 'epic-1', title: 'Dep B', status: 'WORKING' });

    await report({ reason: 'waiting on upstream', blockedOnTaskIds: [depA.id] });
    const firstBlockedAt = state.getTask('task-1')!.blockedAt;
    expect(state.getTask('task-1')!.blockedOnTaskIds).toEqual([depA.id]);

    // Same reason + a NEW id: a write, not a no-op.
    const second = await report({ reason: 'waiting on upstream', blockedOnTaskIds: [depB.id] });
    expect(second.alreadyBlocked).toBe(true);
    expect(second.reasonUpdated).toBe(true);
    const corrected = state.getTask('task-1')!;
    // UNION — the correction must never lose earlier ids.
    expect(corrected.blockedOnTaskIds).toEqual([depA.id, depB.id]);
    expect(corrected.blockedAt).toBe(firstBlockedAt);
    expect(corrected.blockedFromStatus).toBe('WORKING');

    // Same reason + same ids (order/dupes irrelevant): identical repeat again.
    const third = await report({ reason: 'waiting on upstream', blockedOnTaskIds: [depB.id, depA.id] });
    expect(third.alreadyBlocked).toBe(true);
    expect(third.reasonUpdated).toBe(false);
  });

  it('caps the union at 20 dependency ids', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const t = await state.createTask({ epicId: 'epic-1', title: `Dep ${i}`, status: 'BACKLOG' });
      ids.push(t.id);
    }
    await report({ reason: 'waiting on the world', blockedOnTaskIds: ids });
    expect(state.getTask('task-1')!.blockedOnTaskIds).toHaveLength(20);
  });

  it('does NOT block when every named prerequisite is already DONE/ARCHIVED (no claim-thrash livelock)', async () => {
    // The measured moe-next pattern: "blocks point at tasks that are now DONE
    // and the block still stands". With the auto-unblock live, recording an
    // instantly-satisfied list is a livelock (flip → scan restores → next
    // worker claims → same wall → flip). Mirror the resource arm instead:
    // nothing to wait on → not blocked, nothing written, nobody paged.
    const done = await state.createTask({ epicId: 'epic-1', title: 'Landed', status: 'DONE' });
    const archived = await state.createTask({ epicId: 'epic-1', title: 'Shelved', status: 'ARCHIVED' });
    await addWorker('architect-a', 'architect', 5);

    const result = await report({
      reason: `cannot proceed until ${done.id} lands`,
      blockedOnTaskIds: [archived.id],
    });

    expect(result.success).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.dependenciesSatisfied).toBe(true);
    expect(result.satisfiedBlockedOnTaskIds).toEqual([archived.id, done.id]);
    expect(result.taskStatus).toBe('WORKING');
    expect(result.seatFreed).toBeUndefined();
    expect(result.notified).toEqual({ target: null, via: 'not-blocked-dependencies-satisfied' });
    // The "continue" pointer: read the landed prerequisites' evidence and go on.
    expect(result.nextAction).toMatchObject({
      tool: 'moe.get_context',
      args: { taskId: 'task-1', workerId: 'worker-1' },
    });
    // Nothing written: status, seat and block fields untouched; nobody paged.
    const task = state.getTask('task-1')!;
    expect(task.status).toBe('WORKING');
    expect(task.assignedWorkerId).toBe('worker-1');
    expect(task.blockedOnTaskIds ?? null).toBeNull();
    expect(task.blockedReason ?? null).toBeNull();
    expect(state.getWorker('worker-1')!.status).not.toBe('BLOCKED');
    expect(generalPosts).toHaveLength(0);
    expect(rolePosts).toHaveLength(0);
  });

  it('a partially-landed list blocks on the UNMET ids only and reports the satisfied ones', async () => {
    const done = await state.createTask({ epicId: 'epic-1', title: 'Landed', status: 'DONE' });
    const open = await state.createTask({ epicId: 'epic-1', title: 'Open', status: 'WORKING' });

    const result = await report({ reason: 'waiting on both', blockedOnTaskIds: [done.id, open.id] });

    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.dependenciesSatisfied).toBeUndefined();
    expect(result.blockedOnTaskIds).toEqual([open.id]);
    expect(result.satisfiedBlockedOnTaskIds).toEqual([done.id]);
    expect(state.getTask('task-1')!.blockedOnTaskIds).toEqual([open.id]);
  });

  it('the reason-update arm on an already-BLOCKED row KEEPS satisfied ids — the backfill path the sweep repairs', async () => {
    const done = await state.createTask({ epicId: 'epic-1', title: 'Landed', status: 'DONE' });
    await report({ reason: 'needs a human decision' }); // dep-less block, seat freed
    expect(state.getTask('task-1')!.status).toBe('BLOCKED');

    const second = await report({ reason: `BUILD-ORDER BLOCK on ${done.id}` });
    expect(second.alreadyBlocked).toBe(true);
    expect(second.reasonUpdated).toBe(true);
    expect(state.getTask('task-1')!.blockedOnTaskIds).toEqual([done.id]);

    // The next dependency scan (sweep backstop / any DONE transition) repairs it.
    expect(await runDependencyUnblock(state)).toEqual(['task-1']);
    expect(state.getTask('task-1')!.status).toBe('WORKING');
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  it('drops an id that would close a dependency cycle (dependsOn ∪ blockedOnTaskIds), warns, and alerts #governors', async () => {
    // x is BLOCKED waiting on task-1; y (WORKING) declares dependsOn [task-1];
    // z is an honest prerequisite. Blocking task-1 on x or y closes a loop.
    const x = await state.createTask({ epicId: 'epic-1', title: 'X', status: 'WORKING' });
    await state.updateTask(x.id, {
      status: 'BLOCKED', blockedReason: 'waits on task-1', blockedOnTaskIds: ['task-1'],
      blockedFromStatus: 'WORKING', blockedAt: new Date().toISOString(),
    });
    const y = await state.createTask({ epicId: 'epic-1', title: 'Y', status: 'WORKING', dependsOn: ['task-1'] });
    const z = await state.createTask({ epicId: 'epic-1', title: 'Z', status: 'WORKING' });

    const result = await report({ reason: `needs ${x.id} and ${z.id}`, blockedOnTaskIds: [y.id] });

    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.droppedCycleBlockedOnTaskIds).toEqual([y.id, x.id]);
    expect(result.blockedOnTaskIds).toEqual([z.id]);
    expect(state.getTask('task-1')!.blockedOnTaskIds).toEqual([z.id]);
    const warnings = result.warnings as string[];
    expect(warnings.some((w) => w.includes('DEPENDENCY_CYCLE') && w.includes(`task-1 → ${y.id} → task-1`))).toBe(true);
    expect(warnings.some((w) => w.includes('DEPENDENCY_CYCLE') && w.includes(`task-1 → ${x.id} → task-1`))).toBe(true);
    expect(rolePosts.some(([role, msg]) =>
      role === 'governors' && msg.includes('dependency cycle') && msg.includes(y.id) && msg.includes(x.id)
    )).toBe(true);
  });

  it('auto-parse is boundary-anchored: "sub<task-id>" never records the embedded id, a punctuated mention does', async () => {
    const real = await state.createTask({ epicId: 'epic-1', title: 'Real', status: 'WORKING' });

    const embedded = await report({ reason: `cleaning up after the sub${real.id} refactor fallout` });
    expect(embedded.blockedOnTaskIds).toBeUndefined();
    expect(state.getTask('task-1')!.blockedOnTaskIds ?? null).toBeNull();

    const punctuated = await report({ reason: `waiting on ${real.id}, then done.` });
    expect(punctuated.blockedOnTaskIds).toEqual([real.id]);
  });

  it('seat-freeing never wipes a worker pointer that references a DIFFERENT task (dangling assignment)', async () => {
    // worker-1 is CODING `other` (its own pointer) while task-1 still dangles
    // assigned to it (a partial release failure). Freeing task-1's seat must
    // not force the worker IDLE mid-step on the task it is actually coding.
    const other = await state.createTask({ epicId: 'epic-1', title: 'Other', status: 'WORKING', assignedWorkerId: 'worker-1' });
    await state.updateWorker('worker-1', { status: 'CODING', currentTaskId: other.id });

    const result = await report();

    expect(result.seatFreed).toBe(true);
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
    const worker = state.getWorker('worker-1')!;
    expect(worker.status).toBe('CODING');
    expect(worker.currentTaskId).toBe(other.id);
  });

  // ---- repeat report_blocked on an already-BLOCKED task ----
  // A correction used to return success:true while storing nothing, so the next
  // claimer was served the STALE recipe. These arms pin the store, not the
  // response: an assertion that only reads the returned object cannot tell an
  // overwrite from the no-op that shipped.

  it('overwrites the stored reason on a repeat report and preserves the block provenance', async () => {
    const first = await report({ reason: 'bump 93 -> 94, one constant' });
    const blocked = state.getTask('task-1')!;
    expect(blocked.blockedReason).toBe('bump 93 -> 94, one constant');
    const firstBlockedAt = blocked.blockedAt;
    expect(firstBlockedAt).toEqual(expect.any(String));

    const second = await report({ reason: 'CORRECTED: bump 93 -> 96, three constants' });

    // STORE FIRST, deliberately: the shipped defect returned a perfectly
    // truthful-looking response while storing nothing, so an assertion order
    // that reads the response first would redden on the flags and never prove
    // the durable write.
    const corrected = state.getTask('task-1')!;
    expect(corrected.blockedReason).toBe('CORRECTED: bump 93 -> 96, three constants');

    // The correction must NOT re-stamp the block's provenance: blockedFromStatus
    // is the restore target, and writing it here (task.status is now BLOCKED)
    // would wedge the task in BLOCKED forever on unblock.
    expect(corrected.blockedFromStatus).toBe('WORKING');
    expect(corrected.blockedAt).toBe(firstBlockedAt);
    // Seat freed on the original non-resource flip; the correction never
    // re-assigns.
    expect(corrected.assignedWorkerId).toBeNull();
    expect(corrected.status).toBe('BLOCKED');

    // Only then the response shape: a caller must be able to tell a first block
    // (alreadyBlocked:false) from a correction (true), and a correction that
    // changed the stored reason (reasonUpdated:true) from one that did not.
    expect(first.alreadyBlocked).toBe(false);
    expect(first.reasonUpdated).toBe(true);
    expect(second.success).toBe(true);
    expect(second.alreadyBlocked).toBe(true);
    expect(second.reasonUpdated).toBe(true);
    expect(second.taskStatus).toBe('BLOCKED');
  });

  it('block -> correct -> unblock restores the ORIGINAL pre-block status', async () => {
    // REVIEW, not WORKING: set_task_status falls back through effectiveFrom,
    // so a WORKING fixture would stay green even if the correction wiped the
    // restore target.
    await state.updateTask('task-1', { status: 'REVIEW', assignedWorkerId: 'worker-1' });

    await report({ reason: 'first reason' });
    const correction = await report({ reason: 'corrected reason' });
    expect(state.getTask('task-1')!.blockedFromStatus).toBe('REVIEW');
    // Seat was freed on the flip, so the correction has no held worker to
    // steer — no nextAction (matches the old unassigned-task contract).
    expect(correction.nextAction).toBeUndefined();
    expect(correction.alreadyBlocked).toBe(true);
    expect(correction.reasonUpdated).toBe(true);

    // The new-world unblock for a seat-freed block is set_task_status (or a
    // governor); restoring to blockedFromStatus clears every blocked field.
    await setTaskStatusTool(state).handler({ taskId: 'task-1', status: 'REVIEW' }, state);

    const restored = state.getTask('task-1')!;
    expect(restored.status).toBe('REVIEW');
    expect(restored.blockedReason).toBeNull();
    expect(restored.blockedFromStatus).toBeNull();
  });

  it('unblock_worker keeps its untouched semantics on a legacy still-assigned hold', async () => {
    // Legacy-shaped hold (pre-seat-freeing rows still exist on live boards):
    // task BLOCKED and still assigned, worker parked BLOCKED.
    await state.updateTask('task-1', {
      status: 'BLOCKED',
      assignedWorkerId: 'worker-1',
      blockedReason: 'waiting on the schema decision',
      blockedFromStatus: 'WORKING',
      blockedAt: new Date().toISOString(),
    });
    await state.updateWorker('worker-1', { status: 'BLOCKED', currentTaskId: 'task-1' });

    const result = await unblockWorkerTool(state).handler(
      { workerId: 'worker-1', resolution: 'seat freed for other work' }, state
    ) as { resolveBlocks: boolean; stillBlockedTaskIds: string[]; unblockedTaskIds?: string[] };

    const still = state.getTask('task-1')!;
    expect(still.status).toBe('BLOCKED');
    expect(still.blockedReason).toBe('waiting on the schema decision');
    expect(still.blockedFromStatus).toBe('WORKING');
    expect(still.assignedWorkerId).toBeNull();
    expect(state.getWorker('worker-1')!.status).toBe('IDLE');
    expect(result.resolveBlocks).toBe(false);
    expect(result.stillBlockedTaskIds).toEqual(['task-1']);
    expect(result.unblockedTaskIds).toBeUndefined();
  });

  it('warns ALL_STEPS_COMPLETE and points at complete_task when every step is done', async () => {
    await state.updateTask('task-1', {
      implementationPlan: [
        { stepId: 'step-1', description: 'a', status: 'COMPLETED', affectedFiles: [] },
        { stepId: 'step-2', description: 'b', status: 'COMPLETED', affectedFiles: [] },
      ],
    });

    const result = await report({ reason: 'not sure how to hand off' }) as {
      success: boolean; taskStatus: string; warning?: string;
      nextAction?: { tool: string; args: Record<string, unknown> };
    };

    // Still blocks — warn-only.
    expect(result.success).toBe(true);
    expect(result.taskStatus).toBe('BLOCKED');
    expect(state.getTask('task-1')!.status).toBe('BLOCKED');
    expect(result.warning).toBe(
      'ALL_STEPS_COMPLETE: BLOCKED is a wait state, not a terminal — if the work is delivered call moe.complete_task with verification'
    );
    expect(result.nextAction?.tool).toBe('moe.complete_task');
    expect(result.nextAction?.args).toMatchObject({ taskId: 'task-1', workerId: 'worker-1' });
  });

  it('does not warn ALL_STEPS_COMPLETE while steps remain or when waiting on a resource', async () => {
    await state.updateTask('task-1', {
      implementationPlan: [
        { stepId: 'step-1', description: 'a', status: 'COMPLETED', affectedFiles: [] },
        { stepId: 'step-2', description: 'b', status: 'PENDING', affectedFiles: [] },
      ],
    });
    const partial = await report({ reason: 'stuck on step 2' }) as { warning?: string; nextAction?: { tool: string } };
    expect(partial.warning).toBeUndefined();
    // Seat freed on a non-resource block: the worker is pointed at other work.
    expect(partial.nextAction?.tool).toBe('moe.claim_next_task');

    // Resource waits are auto-unblocked on grant; no complete_task nudge.
    await state.updateTask('task-1', {
      status: 'WORKING',
      assignedWorkerId: 'worker-1',
      blockedReason: null,
      blockedFromStatus: null,
      blockedAt: null,
      implementationPlan: [
        { stepId: 'step-1', description: 'a', status: 'COMPLETED', affectedFiles: [] },
      ],
    });
    // Occupy the resource so the report queues instead of being granted.
    await state.acquireResource({ resourceId: 'bench', taskId: 'task-other', workerId: 'worker-9' });
    const queued = await report({ reason: 'need the bench', resourceId: 'bench' }) as { warning?: string; nextAction?: unknown };
    expect(queued.warning).toBeUndefined();
    expect(queued.nextAction).toBeUndefined();
  });

  it('an identical-reason repeat reports reasonUpdated:false and writes nothing', async () => {
    const reason = 'npm install fails behind the proxy';
    await report({ reason });
    await state.flushActivityLog();
    const eventsBefore = state.getActivityLog(500).length;
    const generalBefore = generalPosts.length;
    const roleBefore = rolePosts.length;
    const updatedAtBefore = state.getTask('task-1')!.updatedAt;

    const repeat = await report({ reason });

    await state.flushActivityLog();
    // A retried identical report must not churn the activity log or re-page
    // #governors — the caller that fires twice is the common case. Asserted
    // before the response flags so this arm reddens on the WRITE, not the shape.
    expect(state.getActivityLog(500)).toHaveLength(eventsBefore);
    expect(generalPosts).toHaveLength(generalBefore);
    expect(rolePosts).toHaveLength(roleBefore);
    expect(state.getTask('task-1')!.updatedAt).toBe(updatedAtBefore);

    expect(repeat.success).toBe(true);
    expect(repeat.alreadyBlocked).toBe(true);
    expect(repeat.reasonUpdated).toBe(false);
  });

  it('a correction records blockedResourceId only when the repeat supplies one', async () => {
    const now = new Date().toISOString();
    const holderTask = {
      id: 'task-holder', epicId: 'epic-1', title: 'Holder', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING' as const, assignedWorkerId: 'worker-holder', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN' as const, parentTaskId: null,
      priority: 'MEDIUM' as const, order: 2, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-holder.json'), JSON.stringify(holderTask, null, 2));
    await state.load();
    await addWorker('worker-holder', 'worker', 1);
    // load() re-created the maps; re-stub the chat spies' target state object.
    vi.spyOn(state, 'postToGeneral').mockImplementation(async () => {});
    vi.spyOn(state, 'postToRoleChannel').mockImplementation(async () => {});
    await state.acquireResource({ resourceId: 'benchmark-box', taskId: 'task-holder', workerId: 'worker-holder' });

    await report({ reason: 'plain block, no resource' });
    expect(state.getTask('task-1')!.blockedResourceId).toBeNull();

    // Repeat that DOES supply a (busy) resource: the correction records it.
    const queued = await report({ reason: 'now waiting on the box', resourceId: 'benchmark-box' });
    const withResource = state.getTask('task-1')!;
    expect(withResource.blockedReason).toBe('now waiting on the box');
    expect(withResource.blockedResourceId).toBe('benchmark-box');
    expect(withResource.blockedFromStatus).toBe('WORKING');
    expect(queued.alreadyBlocked).toBe(true);
    expect(queued.reasonUpdated).toBe(true);

    // Repeat that omits it must RETAIN it — nulling would strand the task
    // outside the queue's auto-unblock path.
    await report({ reason: 'reason moved on, still queued' });
    const retained = state.getTask('task-1')!;
    expect(retained.blockedReason).toBe('reason moved on, still queued');
    expect(retained.blockedResourceId).toBe('benchmark-box');
  });

  it('a correction lands even when the repeat also acquires a FREE resource', async () => {
    // The resource path takes the lease FIRST and returns early on a grant. That
    // early return used to sit ABOVE the correction branch, so this exact input --
    // a repeat carrying a corrected reason AND a resource that happens to be free --
    // dropped the correction, answered with both flags undefined, and told the
    // caller "task NOT blocked" about a task the store still reads as BLOCKED.
    // The busy-resource arm above never reaches this branch: it queues instead.
    await report({ reason: 'STALE-93-94' });
    const first = state.getTask('task-1')!;
    expect(first.status).toBe('BLOCKED');
    expect(first.blockedResourceId).toBeNull();
    const firstBlockedAt = first.blockedAt;

    // benchmark-box has no holder, so this acquire is GRANTED.
    const granted = await report({ reason: 'CORRECTED-93-96', resourceId: 'benchmark-box' });

    // STORE FIRST: the shipped bug returned a response that read as success, so
    // asserting the flags first would redden on the shape and never prove the
    // durable write.
    const corrected = state.getTask('task-1')!;
    expect(corrected.blockedReason).toBe('CORRECTED-93-96');
    // REASON ONLY. blockedResourceId means "parked in this resource's QUEUE",
    // and sweeps.ts:238 skips the blocked-timeout sweep for any task carrying
    // it. This task HOLDS the lease, so no grant is coming to auto-unblock it;
    // stamping the field here would exempt it from that sweep forever.
    expect(corrected.blockedResourceId).toBeNull();
    // Provenance survives a correction taken on the grant path too: writing
    // blockedFromStatus here (task.status is BLOCKED by now) would wedge the
    // task in BLOCKED forever on unblock.
    expect(corrected.blockedFromStatus).toBe('WORKING');
    expect(corrected.blockedAt).toBe(firstBlockedAt);
    // Seat freed by the original non-resource flip; the grant-path correction
    // never re-assigns.
    expect(corrected.assignedWorkerId).toBeNull();
    expect(corrected.status).toBe('BLOCKED');

    // The lease is still handed over -- the fix must not cost the caller its grant.
    expect(granted.granted).toBe(true);
    expect(granted.lease).toMatchObject({ taskId: 'task-1', workerId: 'worker-1' });
    expect(state.getResource('benchmark-box')!.holders).toHaveLength(1);

    // ...and the response tells the truth about BOTH facts.
    expect(granted.alreadyBlocked).toBe(true);
    expect(granted.reasonUpdated).toBe(true);
    expect(granted.taskStatus).toBe('BLOCKED');
    expect(String(granted.message)).toMatch(/remains BLOCKED/i);
    expect(String(granted.message)).not.toMatch(/task NOT blocked/i);
  });

  it('a same-reason repeat on the grant path writes nothing and says so', async () => {
    await report({ reason: 'same reason' });
    await state.flushActivityLog();
    const eventsBefore = state.getActivityLog(500).length;
    const updatedAtBefore = state.getTask('task-1')!.updatedAt;

    // Same reason, free resource: the lease is still granted, but the task file
    // must not move -- otherwise a retrying caller churns the store on every hit.
    const repeat = await report({ reason: 'same reason', resourceId: 'benchmark-box' });

    await state.flushActivityLog();
    const after = state.getTask('task-1')!;
    expect(after.updatedAt).toBe(updatedAtBefore);
    expect(after.blockedReason).toBe('same reason');
    expect(after.blockedResourceId).toBeNull();
    expect(after.status).toBe('BLOCKED');
    // RESOURCE_ACQUIRED is the only new event; no task write rode along.
    expect(state.getActivityLog(500).length).toBe(eventsBefore + 1);

    expect(repeat.granted).toBe(true);
    expect(repeat.alreadyBlocked).toBe(true);
    expect(repeat.reasonUpdated).toBe(false);
    expect(String(repeat.message)).toMatch(/remains BLOCKED/i);
    expect(String(repeat.message)).not.toMatch(/task NOT blocked/i);
  });

  it('re-reads the task after the acquire, so a concurrent unblock is not resurrected', async () => {
    await report({ reason: 'first reason' });
    expect(state.getTask('task-1')!.status).toBe('BLOCKED');

    // acquireResource is awaited, so anything the daemon does in that window is
    // real: here a peer unblocks the task while the lease is being taken. Every
    // flag and the write itself must come from the POST-await task, or this call
    // stamps a dead blockedReason back onto a task that is running again.
    const realAcquire = state.acquireResource.bind(state);
    vi.spyOn(state, 'acquireResource').mockImplementation(async (p) => {
      await state.updateTask('task-1', {
        status: 'WORKING', assignedWorkerId: 'worker-1',
        blockedReason: null, blockedFromStatus: null, blockedAt: null,
      });
      return realAcquire(p);
    });

    const late = await report({ reason: 'late correction', resourceId: 'benchmark-box' });

    const after = state.getTask('task-1')!;
    expect(after.status).toBe('WORKING');
    expect(after.blockedReason).toBeNull();

    expect(late.granted).toBe(true);
    expect(late.taskStatus).toBe('WORKING');
    expect(late.alreadyBlocked).toBe(false);
    expect(late.reasonUpdated).toBe(false);
    expect(String(late.message)).toMatch(/task NOT blocked/i);
  });

  it('re-blocks from the post-await task when a queued acquire races an unblock', async () => {
    const now = new Date().toISOString();
    const holderTask: Task = {
      id: 'task-holder', epicId: 'epic-1', title: 'Holder', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'worker-holder', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 2, comments: [], createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', holderTask.id + '.json'), JSON.stringify(holderTask, null, 2));
    await state.load();
    await addWorker('worker-holder', 'worker', 1);
    vi.spyOn(state, 'postToGeneral').mockImplementation(async () => {});
    vi.spyOn(state, 'postToRoleChannel').mockImplementation(async () => {});
    await state.acquireResource({ resourceId: 'benchmark-box', taskId: holderTask.id, workerId: 'worker-holder' });

    await report({ reason: 'first reason' });
    expect(state.getTask('task-1')!.status).toBe('BLOCKED');

    const realAcquire = state.acquireResource.bind(state);
    vi.spyOn(state, 'acquireResource').mockImplementation(async (params) => {
      const queued = await realAcquire(params);
      expect(queued).toMatchObject({
        granted: false, resourceId: 'benchmark-box', position: 1, queueLength: 1,
      });
      await state.updateTask('task-1', {
        status: 'WORKING', assignedWorkerId: 'worker-1', blockedReason: null,
        blockedResourceId: null, blockedFromStatus: null, blockedAt: null,
      });
      return queued;
    });

    const late = await report({ reason: 'late correction', resourceId: 'benchmark-box' });

    const blocked = state.getTask('task-1')!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockedReason).toBe('late correction');
    expect(blocked.blockedResourceId).toBe('benchmark-box');
    expect(blocked.blockedFromStatus).toBe('WORKING');
    expect(blocked.blockedAt).toEqual(expect.any(String));
    expect(blocked.assignedWorkerId).toBe('worker-1');
    expect(state.getResource('benchmark-box')!.queue.map((entry) => entry.taskId)).toEqual(['task-1']);

    expect(late).toMatchObject({
      success: true, granted: false, resourceId: 'benchmark-box', taskStatus: 'BLOCKED',
      alreadyBlocked: false, reasonUpdated: true, workerStatus: 'BLOCKED',
    });
    expect(late.nextAction).toBeUndefined();

    const released = await state.releaseResource({ resourceId: 'benchmark-box', workerId: 'worker-holder' });
    expect(released.granted.map((lease) => lease.taskId)).toEqual(['task-1']);
    const restored = state.getTask('task-1')!;
    expect(restored.status).toBe('WORKING');
    expect(restored.assignedWorkerId).toBe('worker-1');
    expect(restored.blockedReason).toBeNull();
    expect(restored.blockedResourceId).toBeNull();
    expect(restored.blockedFromStatus).toBeNull();
    expect(restored.blockedAt).toBeNull();
    expect(state.getResource('benchmark-box')!.holders.map((holder) => holder.taskId)).toEqual(['task-1']);
  });
});

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';

describe('moe.report_blocked', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: 'worker-1', status: 'WORKING' });
    h.createWorker();
    await h.state.load();
  });

  it('a workerId-less (third-party) block on an ASSIGNED task keeps the hold — the live worker is never yanked', async () => {
    // assertWorkerOwns permits the missing-workerId call (human/plugin flow),
    // but freeing a LIVE worker's seat from the outside would unassign the
    // task under a running session: the auto-unblock would then hand it to a
    // second worker while the first is still editing the same files.
    await h.state.updateWorker('worker-1', { status: 'CODING', currentTaskId: 'task-1' });
    const tool = reportBlockedTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Need clarification',
    }, h.state) as { success: boolean; workerStatus: string; seatFreed?: boolean; taskStatus: string; nextAction?: { tool: string } };

    expect(result.success).toBe(true);
    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.seatFreed).toBe(false);
    expect(result.workerStatus).toBe('BLOCKED');
    expect(result.nextAction?.tool).toBe('moe.wait_for_task');

    // Old hold semantics: assignment kept, worker marked BLOCKED, pointer intact.
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-1');
    const worker = h.state.getWorker('worker-1');
    expect(worker?.status).toBe('BLOCKED');
    expect(worker?.currentTaskId).toBe('task-1');
  });

  it('parks the task and frees the seat when the ASSIGNEE reports a non-resource block', async () => {
    await h.state.updateWorker('worker-1', { status: 'CODING', currentTaskId: 'task-1' });
    const tool = reportBlockedTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Need clarification',
      workerId: 'worker-1',
    }, h.state) as { success: boolean; workerStatus: string; seatFreed?: boolean; taskStatus: string };

    expect(result.success).toBe(true);
    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.seatFreed).toBe(true);
    expect(result.workerStatus).toBe('IDLE');

    // The task parks unassigned; the worker stays free to claim other work.
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBeNull();
    const worker = h.state.getWorker('worker-1');
    expect(worker?.status).toBe('IDLE');
    expect(worker?.currentTaskId).toBeNull();
  });

  it('a workerId-less block on an UNASSIGNED task frees nothing but still parks the task', async () => {
    await h.state.updateTask('task-1', { assignedWorkerId: null });
    const tool = reportBlockedTool(h.state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'Need clarification' }, h.state) as {
      taskStatus: string; seatFreed?: boolean;
    };
    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.seatFreed).toBe(true);
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBeNull();
    expect(h.state.getWorker('worker-1')?.status).toBe('IDLE');
  });

  it('throws for non-existent task', async () => {
    const tool = reportBlockedTool(h.state);
    await expect(
      tool.handler({ taskId: 'nonexistent', reason: 'test' }, h.state)
    ).rejects.toThrow('Task not found');
  });
});

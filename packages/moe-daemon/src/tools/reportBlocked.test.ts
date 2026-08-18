import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { reportBlockedTool } from './reportBlocked.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';
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
    expect(result.message).toBe('Worker marked as blocked. Pinged architect-a (freshest live architect).');

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
    expect(result.message).toBe('Worker marked as blocked. No live architect — escalated to @governors.');
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

  it('still succeeds and still marks the worker BLOCKED when every chat post rejects', async () => {
    await addWorker('architect-a', 'architect', 5);
    vi.spyOn(state, 'postSystemMessage').mockRejectedValue(new Error('chat down'));
    vi.mocked(state.postToGeneral).mockRejectedValue(new Error('chat down'));
    vi.mocked(state.postToRoleChannel).mockRejectedValue(new Error('chat down'));

    const result = await report();

    expect(result.success).toBe(true);
    expect(result.notified).toEqual({ target: 'architect-a', via: 'freshest-live-architect' });
    expect(state.getWorker('worker-1')!.status).toBe('BLOCKED');
    expect(state.getWorker('worker-1')!.lastError).toBe('npm install fails behind the proxy');
  });

  it('keeps the validation contract and flips the task to BLOCKED', async () => {
    await expect(report({ reason: '   ' })).rejects.toThrow(/reason/);
    await expect(report({ reason: 'x'.repeat(2001) })).rejects.toThrow(/too long/);
    await expect(report({ taskId: 'task-nope' })).rejects.toThrow(/not found|NOT_FOUND/i);

    const result = await report();
    expect(result.success).toBe(true);
    // The task itself parks: this is what stops the wrapper's resume-loop
    // churn (claim_next_task answers alreadyAssigned{status:BLOCKED} and the
    // wrapper skips the CLI relaunch).
    expect(result.taskStatus).toBe('BLOCKED');
    expect(result.workerStatus).toBe('BLOCKED');
    const task = state.getTask('task-1')!;
    expect(task.status).toBe('BLOCKED');
    // REGRESSION GUARD: updateTask clears assignment on any status change when
    // the caller omits it — the flip must pass it explicitly, or the parked
    // worker loses its hold, alreadyAssigned{BLOCKED} never fires and the
    // wrapper suppression is dead code.
    expect(task.assignedWorkerId).toBe('worker-1');
    expect(task.blockedFromStatus).toBe('WORKING');
    expect(task.blockedReason).toBe('npm install fails behind the proxy');
    expect(task.blockedResourceId).toBeNull();
    expect(task.blockedAt).toEqual(expect.any(String));
    // Non-resource block keeps the wait_for_task hint (statuses from the
    // pre-flip status, since BLOCKED itself is not waitable).
    expect(result.nextAction).toMatchObject({
      tool: 'moe.wait_for_task',
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
    expect(corrected.assignedWorkerId).toBe('worker-1');
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
    // REVIEW, not WORKING: unblock_worker falls back to 'WORKING' when
    // blockedFromStatus is missing, so a WORKING fixture would stay green even
    // if the correction wiped the restore target.
    await state.updateTask('task-1', { status: 'REVIEW', assignedWorkerId: 'worker-1' });

    await report({ reason: 'first reason' });
    const correction = await report({ reason: 'corrected reason' });
    expect(state.getTask('task-1')!.blockedFromStatus).toBe('REVIEW');
    // The repeat's OWN status is BLOCKED, which is not agent-claimable, so a
    // hint resolved from it would tell a REVIEW-blocked owner to wait on
    // WORKING -- a wait its own task can never satisfy.
    expect(correction.nextAction).toMatchObject({ args: { statuses: ['REVIEW'] } });

    const unblock = unblockWorkerTool(state);
    await unblock.handler(
      { workerId: 'worker-1', resolution: 'blocker resolved', retryTask: true }, state
    );

    const restored = state.getTask('task-1')!;
    expect(restored.status).toBe('REVIEW');
    expect(restored.blockedReason).toBeNull();
    expect(restored.blockedFromStatus).toBeNull();
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
    expect(corrected.assignedWorkerId).toBe('worker-1');
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
    h.createTask({ assignedWorkerId: 'worker-1' });
    h.createWorker();
    await h.state.load();
  });

  it('marks worker as blocked', async () => {
    const tool = reportBlockedTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Need clarification',
    }, h.state) as { success: boolean; workerStatus: string };

    expect(result.success).toBe(true);
    expect(result.workerStatus).toBe('BLOCKED');

    const worker = h.state.getWorker('worker-1');
    expect(worker?.status).toBe('BLOCKED');
    expect(worker?.lastError).toBe('Need clarification');
  });

  it('throws for non-existent task', async () => {
    const tool = reportBlockedTool(h.state);
    await expect(
      tool.handler({ taskId: 'nonexistent', reason: 'test' }, h.state)
    ).rejects.toThrow('Task not found');
  });
});

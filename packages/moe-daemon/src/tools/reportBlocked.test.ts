import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { reportBlockedTool } from './reportBlocked.js';
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
    expect(generalPosts).toHaveLength(2);

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
    await report();
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

  it('keeps the existing validation and nextAction contract', async () => {
    await expect(report({ reason: '   ' })).rejects.toThrow(/reason/);
    await expect(report({ reason: 'x'.repeat(2001) })).rejects.toThrow(/too long/);
    await expect(report({ taskId: 'task-nope' })).rejects.toThrow(/not found|NOT_FOUND/i);

    const result = await report();
    expect(result.success).toBe(true);
    expect(result.taskStatus).toBe('WORKING');
    expect(result.workerStatus).toBe('BLOCKED');
    expect(result.nextAction).toMatchObject({
      tool: 'moe.wait_for_task',
      args: { workerId: 'worker-1', statuses: ['WORKING'] },
    });
  });
});

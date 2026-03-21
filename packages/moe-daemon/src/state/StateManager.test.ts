import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import { cancelSpeedModeTimeout } from '../tools/submitPlan.js';
import type { Task, Epic, Project, RailProposal, ChatChannel } from '../types/schema.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';

vi.mock('../tools/submitPlan.js', () => ({
  cancelSpeedModeTimeout: vi.fn(),
}));

describe('StateManager', () => {
  const DAY_IN_MS = 24 * 60 * 60 * 1000;
  const PROPOSAL_PURGE_AGE_MS = 7 * DAY_IN_MS;

  let testDir: string;
  let moePath: string;
  let stateManager: StateManager;

  // Helper to create a minimal .moe structure
  function setupMoeFolder(projectOverrides: Partial<Project> = {}) {
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'epics'), { recursive: true });
    fs.mkdirSync(path.join(moePath, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(moePath, 'workers'), { recursive: true });
    fs.mkdirSync(path.join(moePath, 'proposals'), { recursive: true });

    const project = {
      id: 'proj-test123',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: ['typescript'],
        forbiddenPatterns: [],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...projectOverrides,
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    return project;
  }

  function createTestEpic(overrides: Partial<Epic> = {}): Epic {
    const epic: Epic = {
      id: 'epic-test123',
      projectId: 'proj-test123',
      title: 'Test Epic',
      description: 'A test epic',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${epic.id}.json`), JSON.stringify(epic, null, 2));
    return epic;
  }

  function createTestTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      id: 'task-test123',
      epicId: 'epic-test123',
      title: 'Test Task',
      description: 'A test task',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [],
      status: 'BACKLOG',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  function createTestProposal(overrides: Partial<RailProposal> = {}): RailProposal {
    return {
      id: 'proposal-test123',
      workerId: 'worker-test123',
      taskId: 'task-test123',
      proposalType: 'ADD_RAIL',
      targetScope: 'GLOBAL',
      currentValue: null,
      proposedValue: 'Always add regression tests',
      reason: 'Test proposal',
      status: 'PENDING',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-test-'));
    moePath = path.join(testDir, '.moe');
    stateManager = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('throws if .moe folder does not exist', async () => {
      await expect(stateManager.load()).rejects.toThrow('.moe folder not found');
    });

    it('loads project from project.json', async () => {
      const project = setupMoeFolder();
      await stateManager.load();
      expect(stateManager.project?.id).toBe(project.id);
      expect(stateManager.project?.name).toBe('Test Project');
    });

    it('normalizes project with missing fields', async () => {
      fs.mkdirSync(moePath, { recursive: true });
      fs.mkdirSync(path.join(moePath, 'epics'));
      fs.mkdirSync(path.join(moePath, 'tasks'));
      fs.mkdirSync(path.join(moePath, 'workers'));
      fs.mkdirSync(path.join(moePath, 'proposals'));
      fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({ name: 'Minimal' }));

      await stateManager.load();
      expect(stateManager.project?.name).toBe('Minimal');
      expect(stateManager.project?.globalRails).toBeDefined();
      expect(stateManager.project?.settings.approvalMode).toBe('CONTROL');
    });

    it('loads epics from epics folder', async () => {
      setupMoeFolder();
      const epic = createTestEpic();
      await stateManager.load();
      expect(stateManager.epics.size).toBe(1);
      expect(stateManager.getEpic(epic.id)?.title).toBe('Test Epic');
    });

    it('loads tasks from tasks folder', async () => {
      setupMoeFolder();
      createTestEpic();
      const task = createTestTask();
      await stateManager.load();
      expect(stateManager.tasks.size).toBe(1);
      expect(stateManager.getTask(task.id)?.title).toBe('Test Task');
    });

    it('purges stale resolved proposals on load and starts purge interval', async () => {
      setupMoeFolder();

      const staleProposal = createTestProposal({
        id: 'proposal-stale-on-load',
        status: 'APPROVED',
        resolvedAt: new Date(Date.now() - PROPOSAL_PURGE_AGE_MS - DAY_IN_MS).toISOString(),
        resolvedBy: 'HUMAN',
      });

      fs.writeFileSync(
        path.join(moePath, 'proposals', `${staleProposal.id}.json`),
        JSON.stringify(staleProposal, null, 2),
      );

      await stateManager.load();

      expect(stateManager.proposals.has(staleProposal.id)).toBe(false);
      expect(fs.existsSync(path.join(moePath, 'proposals', `${staleProposal.id}.json`))).toBe(false);
      expect(
        (stateManager as unknown as { proposalPurgeInterval?: NodeJS.Timeout }).proposalPurgeInterval,
      ).toBeDefined();

      stateManager.clearEmitter();
      expect(
        (stateManager as unknown as { proposalPurgeInterval?: NodeJS.Timeout }).proposalPurgeInterval,
      ).toBeUndefined();
    });
  });

  describe('getSnapshot', () => {
    it('throws if project not loaded', () => {
      expect(() => stateManager.getSnapshot()).toThrow('Project not loaded');
    });

    it('returns sorted epics and tasks', async () => {
      setupMoeFolder();
      createTestEpic({ id: 'epic-1', order: 2 });
      createTestEpic({ id: 'epic-2', order: 1 });
      createTestTask({ id: 'task-1', epicId: 'epic-1', order: 2 });
      createTestTask({ id: 'task-2', epicId: 'epic-1', order: 1 });
      await stateManager.load();

      const snapshot = stateManager.getSnapshot();
      expect(snapshot.epics[0].id).toBe('epic-2');
      expect(snapshot.epics[1].id).toBe('epic-1');
      expect(snapshot.tasks[0].id).toBe('task-2');
      expect(snapshot.tasks[1].id).toBe('task-1');
    });

    it('filters stale resolved proposals from snapshot but keeps pending and recent resolved', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();

      const staleResolved = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-stale-snapshot',
          status: 'APPROVED',
          resolvedAt: new Date(Date.now() - (2 * DAY_IN_MS)).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );
      const recentResolved = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-recent-snapshot',
          status: 'REJECTED',
          resolvedAt: new Date(Date.now() - (6 * 60 * 60 * 1000)).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );
      const pendingProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-pending-snapshot',
          status: 'PENDING',
          resolvedAt: null,
          resolvedBy: null,
        }),
      );

      const snapshot = stateManager.getSnapshot();
      const proposalIds = snapshot.proposals.map((proposal) => proposal.id);

      expect(proposalIds).not.toContain(staleResolved.id);
      expect(proposalIds).toContain(recentResolved.id);
      expect(proposalIds).toContain(pendingProposal.id);
    });
  });

  describe('createTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();
    });

    it('throws if project not loaded', async () => {
      const fresh = new StateManager({ projectPath: testDir });
      await expect(fresh.createTask({ epicId: 'epic-test123' })).rejects.toThrow('Project not loaded');
    });

    it('throws if epicId is missing', async () => {
      await expect(stateManager.createTask({})).rejects.toThrow('epicId is required');
    });

    it('creates task with defaults', async () => {
      const task = await stateManager.createTask({ epicId: 'epic-test123' });
      expect(task.id).toMatch(/^task-/);
      expect(task.title).toBe('Untitled task');
      expect(task.status).toBe('BACKLOG');
      expect(task.order).toBe(1);
    });

    it('creates task with provided values', async () => {
      const task = await stateManager.createTask({
        epicId: 'epic-test123',
        title: 'Custom Task',
        description: 'Custom description',
        status: 'PLANNING',
      });
      expect(task.title).toBe('Custom Task');
      expect(task.description).toBe('Custom description');
      expect(task.status).toBe('PLANNING');
    });

    it('writes task to disk', async () => {
      const task = await stateManager.createTask({ epicId: 'epic-test123', title: 'Persisted' });
      const filePath = path.join(moePath, 'tasks', `${task.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.title).toBe('Persisted');
    });

    it('emits TASK_CREATED event', async () => {
      const events: string[] = [];
      stateManager.setEmitter((e) => events.push(e.type));
      await stateManager.createTask({ epicId: 'epic-test123' });
      expect(events).toContain('TASK_CREATED');
    });

    it('does not change memory when writeEntity fails', async () => {
      const initialTaskCount = stateManager.tasks.size;
      vi.spyOn(stateManager as unknown as { writeEntity: () => Promise<void> }, 'writeEntity')
        .mockRejectedValueOnce(new Error('disk write failed'));

      await expect(stateManager.createTask({ epicId: 'epic-test123' })).rejects.toThrow('disk write failed');
      expect(stateManager.tasks.size).toBe(initialTaskCount);
    });

    it('auto-increments order for tasks in same epic', async () => {
      const task1 = await stateManager.createTask({ epicId: 'epic-test123' });
      const task2 = await stateManager.createTask({ epicId: 'epic-test123' });
      expect(task1.order).toBe(1);
      expect(task2.order).toBe(2);
    });
  });

  describe('updateTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();
    });

    it('throws if task not found', async () => {
      await expect(stateManager.updateTask('nonexistent', {})).rejects.toThrow('Task not found');
    });

    it('updates task fields', async () => {
      const updated = await stateManager.updateTask('task-test123', {
        title: 'Updated Title',
        status: 'WORKING',
      });
      expect(updated.title).toBe('Updated Title');
      expect(updated.status).toBe('WORKING');
    });

    it('updates updatedAt timestamp', async () => {
      const before = stateManager.getTask('task-test123')!.updatedAt;
      await new Promise((r) => setTimeout(r, 10));
      const updated = await stateManager.updateTask('task-test123', { title: 'New' });
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it('persists changes to disk', async () => {
      await stateManager.updateTask('task-test123', { title: 'Persisted Update' });
      const filePath = path.join(moePath, 'tasks', 'task-test123.json');
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.title).toBe('Persisted Update');
    });

    it('emits TASK_UPDATED event', async () => {
      const events: string[] = [];
      stateManager.setEmitter((e) => events.push(e.type));
      await stateManager.updateTask('task-test123', { title: 'Trigger Event' });
      expect(events).toContain('TASK_UPDATED');
    });

    it('does not change memory when writeEntity fails', async () => {
      const originalTask = stateManager.getTask('task-test123');
      vi.spyOn(stateManager as unknown as { writeEntity: () => Promise<void> }, 'writeEntity')
        .mockRejectedValueOnce(new Error('disk write failed'));

      await expect(stateManager.updateTask('task-test123', { title: 'Should Fail' })).rejects.toThrow('disk write failed');
      expect(stateManager.getTask('task-test123')).toEqual(originalTask);
    });
  });

  describe('deleteTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();
    });

    it('throws if task not found', async () => {
      await expect(stateManager.deleteTask('nonexistent')).rejects.toThrow('Task not found');
    });

    it('removes task from memory', async () => {
      await stateManager.deleteTask('task-test123');
      expect(stateManager.getTask('task-test123')).toBeNull();
    });

    it('cancels speed mode timeout on task deletion', async () => {
      await stateManager.deleteTask('task-test123');
      expect(vi.mocked(cancelSpeedModeTimeout)).toHaveBeenCalledWith('task-test123');
    });

    it('removes task file from disk', async () => {
      const filePath = path.join(moePath, 'tasks', 'task-test123.json');
      expect(fs.existsSync(filePath)).toBe(true);
      await stateManager.deleteTask('task-test123');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('emits TASK_DELETED event', async () => {
      const events: string[] = [];
      stateManager.setEmitter((e) => events.push(e.type));
      await stateManager.deleteTask('task-test123');
      expect(events).toContain('TASK_DELETED');
    });

    it('keeps task in memory when task file deletion fails', async () => {
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        const error = new Error('unlink failed') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });

      await expect(stateManager.deleteTask('task-test123')).rejects.toThrow('unlink failed');
      expect(stateManager.getTask('task-test123')).not.toBeNull();
    });
  });

  describe('deleteTeam rollback semantics', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await stateManager.load();
    });

    it('keeps team in memory when team file deletion fails', async () => {
      const team = await stateManager.createTeam({ name: 'Ops Team' });

      vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
        const error = new Error('team unlink failed') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });

      await expect(stateManager.deleteTeam(team.id)).rejects.toThrow('team unlink failed');
      expect(stateManager.getTeam(team.id)).not.toBeNull();
    });
  });

  describe('updateSettings rollback semantics', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await stateManager.load();
    });

    it('does not update in-memory project when project write fails', async () => {
      const originalProject = JSON.parse(JSON.stringify(stateManager.project)) as Project;

      vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('settings write failed'));

      await expect(stateManager.updateSettings({ agentCommand: 'codex' })).rejects.toThrow('settings write failed');
      expect(stateManager.project).toEqual(originalProject);
    });
  });

  describe('deleteEpic rollback semantics', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();
    });

    it('keeps epic in memory when epic file deletion fails', async () => {
      vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
        const error = new Error('epic unlink failed') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });

      await expect(stateManager.deleteEpic('epic-test123')).rejects.toThrow('epic unlink failed');
      expect(stateManager.getEpic('epic-test123')).not.toBeNull();
    });
  });

  describe('createEpic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await stateManager.load();
    });

    it('creates epic with defaults', async () => {
      const epic = await stateManager.createEpic({});
      expect(epic.id).toMatch(/^epic-/);
      expect(epic.title).toBe('Untitled epic');
      expect(epic.status).toBe('PLANNED');
    });

    it('emits EPIC_CREATED event', async () => {
      const events: string[] = [];
      stateManager.setEmitter((e) => events.push(e.type));
      await stateManager.createEpic({ title: 'New Epic' });
      expect(events).toContain('EPIC_CREATED');
    });
  });

  describe('updateEpic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();
    });

    it('throws if epic not found', async () => {
      await expect(stateManager.updateEpic('nonexistent', {})).rejects.toThrow('Epic not found');
    });

    it('updates epic fields', async () => {
      const updated = await stateManager.updateEpic('epic-test123', {
        title: 'Updated Epic',
        status: 'COMPLETED',
      });
      expect(updated.title).toBe('Updated Epic');
      expect(updated.status).toBe('COMPLETED');
    });
  });

  describe('approveTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'AWAITING_APPROVAL' });
      await stateManager.load();
    });

    it('sets task status to WORKING', async () => {
      const task = await stateManager.approveTask('task-test123');
      expect(task.status).toBe('WORKING');
    });

    it('throws if task not found', async () => {
      await expect(stateManager.approveTask('nonexistent')).rejects.toThrow('Task not found');
    });
  });

  describe('rejectTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'AWAITING_APPROVAL' });
      await stateManager.load();
    });

    it('sets task status to PLANNING with reason', async () => {
      const task = await stateManager.rejectTask('task-test123', 'Needs more detail');
      expect(task.status).toBe('PLANNING');
      expect(task.reopenReason).toBe('Needs more detail');
    });
  });

  describe('reopenTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'DONE', reopenCount: 0 });
      await stateManager.load();
    });

    it('sets status to BACKLOG and increments reopenCount', async () => {
      const task = await stateManager.reopenTask('task-test123', 'Bug found');
      expect(task.status).toBe('BACKLOG');
      expect(task.reopenCount).toBe(1);
      expect(task.reopenReason).toBe('Bug found');
    });
  });

  describe('approveProposal', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();
    });

    it('writes APPROVED status before applying rail changes', async () => {
      const proposal = await stateManager.createProposal(createTestProposal());

      const applyRailChangeSpy = vi
        .spyOn(stateManager as unknown as { applyRailChange: (proposal: RailProposal) => Promise<void> }, 'applyRailChange')
        .mockImplementation(async () => {
          const inMemoryProposal = stateManager.proposals.get(proposal.id);
          expect(inMemoryProposal?.status).toBe('APPROVED');

          const proposalFile = path.join(moePath, 'proposals', `${proposal.id}.json`);
          const savedProposal = JSON.parse(fs.readFileSync(proposalFile, 'utf-8')) as RailProposal;
          expect(savedProposal.status).toBe('APPROVED');

          throw new Error('rail apply failed');
        });

      const approved = await stateManager.approveProposal(proposal.id);

      expect(applyRailChangeSpy).toHaveBeenCalledOnce();
      expect(approved.status).toBe('APPROVED');
      expect(stateManager.proposals.get(proposal.id)?.status).toBe('APPROVED');
    });
  });

  describe('purgeResolvedProposals', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();
    });

    it('does not purge pending proposals', async () => {
      const pendingProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-pending-keep',
          status: 'PENDING',
          resolvedAt: new Date(Date.now() - (30 * DAY_IN_MS)).toISOString(),
          resolvedBy: null,
        }),
      );

      const purgedCount = await stateManager.purgeResolvedProposals();

      expect(purgedCount).toBe(0);
      expect(stateManager.proposals.has(pendingProposal.id)).toBe(true);
    });

    it('purges approved proposals older than 7 days from memory and disk', async () => {
      const approvedProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-approved-stale',
          status: 'APPROVED',
          resolvedAt: new Date(Date.now() - PROPOSAL_PURGE_AGE_MS - DAY_IN_MS).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );

      const proposalPath = path.join(moePath, 'proposals', `${approvedProposal.id}.json`);
      expect(fs.existsSync(proposalPath)).toBe(true);

      const purgedCount = await stateManager.purgeResolvedProposals();

      expect(purgedCount).toBe(1);
      expect(stateManager.proposals.has(approvedProposal.id)).toBe(false);
      expect(fs.existsSync(proposalPath)).toBe(false);
    });

    it('purges rejected proposals older than 7 days', async () => {
      const rejectedProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-rejected-stale',
          status: 'REJECTED',
          resolvedAt: new Date(Date.now() - PROPOSAL_PURGE_AGE_MS - DAY_IN_MS).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );

      const purgedCount = await stateManager.purgeResolvedProposals();

      expect(purgedCount).toBe(1);
      expect(stateManager.proposals.has(rejectedProposal.id)).toBe(false);
    });

    it('does not purge recently resolved proposals', async () => {
      const recentProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-recent-keep',
          status: 'APPROVED',
          resolvedAt: new Date(Date.now() - (2 * DAY_IN_MS)).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );

      const purgedCount = await stateManager.purgeResolvedProposals();

      expect(purgedCount).toBe(0);
      expect(stateManager.proposals.has(recentProposal.id)).toBe(true);
    });

    it('handles file deletion errors gracefully without crashing', async () => {
      const staleProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-stale-delete-fail',
          status: 'APPROVED',
          resolvedAt: new Date(Date.now() - PROPOSAL_PURGE_AGE_MS - DAY_IN_MS).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );

      vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
        if (String(filePath).includes(staleProposal.id)) {
          const error = new Error('cannot delete file') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
      });

      await expect(stateManager.purgeResolvedProposals()).resolves.toBe(0);
      expect(stateManager.proposals.has(staleProposal.id)).toBe(true);
    });

    it('logs PROPOSAL_PURGED activity events', async () => {
      const staleProposal = await stateManager.createProposal(
        createTestProposal({
          id: 'proposal-stale-log',
          status: 'APPROVED',
          resolvedAt: new Date(Date.now() - PROPOSAL_PURGE_AGE_MS - DAY_IN_MS).toISOString(),
          resolvedBy: 'HUMAN',
        }),
      );

      const appendActivitySpy = vi.spyOn(stateManager, 'appendActivity');

      await stateManager.purgeResolvedProposals();

      expect(appendActivitySpy).toHaveBeenCalledWith(
        'PROPOSAL_PURGED',
        expect.objectContaining({ proposalId: staleProposal.id }),
      );
    });
  });

  describe('reorderTask', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ id: 'task-1', order: 1 });
      createTestTask({ id: 'task-2', order: 2 });
      createTestTask({ id: 'task-3', order: 3 });
      await stateManager.load();
    });

    it('reorders task between two others', async () => {
      // Move task-3 between task-1 and task-2
      const task = await stateManager.reorderTask('task-3', 'task-1', 'task-2');
      expect(task.order).toBe(1.5);
    });

    it('reorders task to beginning', async () => {
      const task = await stateManager.reorderTask('task-3', null, 'task-1');
      expect(task.order).toBeLessThan(1);
    });

    it('reorders task to end', async () => {
      const task = await stateManager.reorderTask('task-1', 'task-3', null);
      expect(task.order).toBeGreaterThan(3);
    });
  });

  describe('nextTaskOrder', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createTestEpic({ id: 'epic-1' });
      createTestEpic({ id: 'epic-2' });
      await stateManager.load();
    });

    it('returns 1 for empty epic', () => {
      expect(stateManager.nextTaskOrder('epic-1')).toBe(1);
    });

    it('returns max order + 1', async () => {
      await stateManager.createTask({ epicId: 'epic-1' });
      await stateManager.createTask({ epicId: 'epic-1' });
      expect(stateManager.nextTaskOrder('epic-1')).toBe(3);
    });

    it('scopes order to specific epic', async () => {
      await stateManager.createTask({ epicId: 'epic-1' });
      await stateManager.createTask({ epicId: 'epic-1' });
      expect(stateManager.nextTaskOrder('epic-2')).toBe(1);
    });
  });

  describe('event emitter', () => {
    it('emits events to registered listener', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const events: Array<{ type: string; id?: string }> = [];
      stateManager.setEmitter((e) => events.push({ type: e.type, id: (e.payload as { id?: string }).id }));

      const task = await stateManager.createTask({ epicId: 'epic-test123' });
      await stateManager.updateTask(task.id, { title: 'Updated' });

      // createTask emits TASK_CREATED, updateTask emits TASK_UPDATED
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('TASK_CREATED');
      expect(events[1].type).toBe('TASK_UPDATED');
    });

    it('auto-removes subscribers after 3 consecutive errors', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const failingSubscriber = vi.fn(() => {
        throw new Error('subscriber boom');
      });
      stateManager.subscribe(failingSubscriber);

      await stateManager.createTask({ epicId: 'epic-test123', title: 'task-1' });
      await stateManager.createTask({ epicId: 'epic-test123', title: 'task-2' });
      await stateManager.createTask({ epicId: 'epic-test123', title: 'task-3' });
      await stateManager.createTask({ epicId: 'epic-test123', title: 'task-4' });

      expect(failingSubscriber).toHaveBeenCalledTimes(3);
      const errorCounts = (stateManager as unknown as {
        subscriberErrorCounts: Map<unknown, number>;
      }).subscriberErrorCounts;
      expect(errorCounts.has(failingSubscriber)).toBe(false);
    });
  });

  describe('getActivityLog tool', () => {
    function writeActivityEvents(count: number, overrides: Partial<Record<string, unknown>> = {}) {
      const logPath = path.join(moePath, 'activity.log');
      for (let i = 0; i < count; i++) {
        const event = {
          id: `evt-test-${i}`,
          timestamp: new Date(Date.now() - (count - i) * 1000).toISOString(),
          projectId: 'proj-test123',
          epicId: overrides.epicId || 'epic-test123',
          taskId: overrides.taskId || `task-${i}`,
          workerId: overrides.workerId || 'worker-test',
          event: overrides.event || 'STEP_COMPLETED',
          payload: overrides.payload || { step: i, description: `Step ${i}` }
        };
        fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
      }
    }

    async function setupLogEnv(eventCount = 10) {
      setupMoeFolder();
      createTestEpic();
      fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
      fs.mkdirSync(path.join(moePath, 'messages'), { recursive: true });
      // Create activity.log before load
      fs.writeFileSync(path.join(moePath, 'activity.log'), '');
      writeActivityEvents(eventCount);
      await stateManager.load();
    }

    it('truncates large payload strings', async () => {
      await setupLogEnv(0);
      const bigPayload = { bigField: 'x'.repeat(5000), small: 'ok' };
      writeActivityEvents(1, { payload: bigPayload });

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);
      const result = await tool.handler({ limit: 10 }, stateManager) as Record<string, unknown>;
      const events = result.events as Array<{ payload: Record<string, unknown> }>;

      // Find our event (skip migration events)
      const evt = events.find(e => typeof e.payload.bigField === 'string');
      expect(evt).toBeDefined();
      expect((evt!.payload.bigField as string).length).toBeLessThanOrEqual(520);
      expect((evt!.payload.bigField as string)).toContain('[truncated]');
      expect(evt!.payload.small).toBe('ok');
    });

    it('does not truncate when maxPayloadChars=0', async () => {
      await setupLogEnv(0);
      const bigValue = 'y'.repeat(5000);
      writeActivityEvents(1, { payload: { bigField: bigValue } });

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);
      const result = await tool.handler({ limit: 10, maxPayloadChars: 0 }, stateManager) as Record<string, unknown>;
      const events = result.events as Array<{ payload: Record<string, unknown> }>;
      const evt = events.find(e => typeof e.payload.bigField === 'string');
      expect(evt).toBeDefined();
      expect(evt!.payload.bigField).toBe(bigValue);
    });

    it('offset pagination returns non-overlapping windows', async () => {
      await setupLogEnv(10);

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);

      const page1 = await tool.handler({ limit: 3, offset: 0, maxPayloadChars: 0 }, stateManager) as { events: Array<{ id: string }> };
      const page2 = await tool.handler({ limit: 3, offset: 3, maxPayloadChars: 0 }, stateManager) as { events: Array<{ id: string }> };

      expect(page1.events.length).toBe(3);
      expect(page2.events.length).toBe(3);

      const ids1 = new Set(page1.events.map(e => e.id));
      const ids2 = new Set(page2.events.map(e => e.id));
      // No overlap
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it('hasMore is true when more events exist beyond window', async () => {
      await setupLogEnv(10);

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);

      const result = await tool.handler({ limit: 3, offset: 0, maxPayloadChars: 0 }, stateManager) as { hasMore: boolean };
      expect(result.hasMore).toBe(true);
    });

    it('hasMore is false at end of events', async () => {
      await setupLogEnv(3);

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);

      const result = await tool.handler({ limit: 50, offset: 0, maxPayloadChars: 0 }, stateManager) as { hasMore: boolean };
      expect(result.hasMore).toBe(false);
    });

    it('truncates object payload values', async () => {
      await setupLogEnv(0);
      const bigObject = { nested: { data: 'z'.repeat(3000) } };
      writeActivityEvents(1, { payload: { complexField: bigObject } });

      const { getActivityLogTool } = await import('../tools/getActivityLog.js');
      const tool = getActivityLogTool(stateManager);
      const result = await tool.handler({ limit: 10 }, stateManager) as Record<string, unknown>;
      const events = result.events as Array<{ payload: Record<string, unknown> }>;
      const evt = events.find(e => typeof e.payload.complexField === 'string');
      expect(evt).toBeDefined();
      expect((evt!.payload.complexField as string)).toContain('[truncated]');
    });
  });

  describe('claimNextTask chat integration', () => {
    // Migration auto-creates #general + task/epic channels during load()
    async function setupChatEnv() {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'WORKING' });
      // Create channels + messages dirs (migration will populate them)
      fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
      fs.mkdirSync(path.join(moePath, 'messages'), { recursive: true });
      await stateManager.load();
    }

    function findGeneralChannel(): ChatChannel | null {
      for (const ch of stateManager.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') return ch;
      }
      return null;
    }


    it('posts to #general on new worker creation', async () => {
      await setupChatEnv();
      const generalCh = findGeneralChannel();
      expect(generalCh).toBeDefined();

      const tool = claimNextTaskTool(stateManager);
      await tool.handler({ statuses: ['WORKING'], workerId: 'agent-new' }, stateManager);

      // Check #general messages for announcement
      const messages = await stateManager.getMessages(generalCh!.id);
      const announcement = messages.find((m) => m.content.includes('agent-new') && m.content.includes('online'));
      expect(announcement).toBeDefined();
      expect(announcement!.content).toContain('worker');
    });

    it('does NOT post to #general for existing worker', async () => {
      await setupChatEnv();
      const generalCh = findGeneralChannel();
      expect(generalCh).toBeDefined();

      // Pre-register the worker
      await stateManager.createWorker({
        id: 'agent-existing',
        type: 'CLAUDE',
        projectId: 'proj-test123',
        epicId: 'epic-test123',
        currentTaskId: null,
        status: 'IDLE'
      });

      const messagesBefore = await stateManager.getMessages(generalCh!.id);
      const tool = claimNextTaskTool(stateManager);
      await tool.handler({ statuses: ['WORKING'], workerId: 'agent-existing' }, stateManager);

      const messagesAfter = await stateManager.getMessages(generalCh!.id);
      // System posts "claimed this task" but NOT "is online"
      const onlineAnnouncements = messagesAfter
        .slice(messagesBefore.length)
        .filter((m) => m.content.includes('is online'));
      expect(onlineAnnouncements).toHaveLength(0);
    });


    it('response includes generalChannelId when #general exists', async () => {
      await setupChatEnv();
      const generalCh = findGeneralChannel();
      expect(generalCh).toBeDefined();

      const tool = claimNextTaskTool(stateManager);
      const result = await tool.handler({ statuses: ['WORKING'], workerId: 'agent-gen' }, stateManager) as Record<string, unknown>;

      expect(result.hasNext).toBe(true);
      const task = result.task as Record<string, unknown>;
      expect(task.generalChannelId).toBe(generalCh!.id);
    });

    it('generalChannelId is null when no #general channel exists', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'WORKING' });
      fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
      fs.mkdirSync(path.join(moePath, 'messages'), { recursive: true });
      // Pre-create a non-general channel to prevent migration from creating one
      // by putting a dummy channel file in place
      const dummyChanId = 'chan-dummy';
      fs.writeFileSync(path.join(moePath, 'channels', `${dummyChanId}.json`), JSON.stringify({
        id: dummyChanId, name: 'task-test', type: 'task', linkedEntityId: 'task-test123', createdAt: new Date().toISOString()
      }));
      fs.writeFileSync(path.join(moePath, 'messages', `${dummyChanId}.jsonl`), '');
      await stateManager.load();

      // Delete general channel if migration created one despite the dummy
      for (const ch of stateManager.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          stateManager.channels.delete(ch.id);
        }
      }

      const tool = claimNextTaskTool(stateManager);
      const result = await tool.handler({ statuses: ['WORKING'], workerId: 'agent-nogen' }, stateManager) as Record<string, unknown>;

      expect(result.hasNext).toBe(true);
      const task = result.task as Record<string, unknown>;
      expect(task.generalChannelId).toBeNull();
    });
  });

  describe('race condition fixes', () => {
    it('deleteWorker clears assignedWorkerId on tasks', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ assignedWorkerId: 'worker-to-delete', status: 'WORKING' });
      await stateManager.load();

      // Create the worker
      await stateManager.createWorker({
        id: 'worker-to-delete',
        type: 'CLAUDE',
        projectId: 'proj-test123',
        epicId: 'epic-test123',
        currentTaskId: 'task-test123',
        status: 'CODING'
      });

      await stateManager.deleteWorker('worker-to-delete');

      const task = stateManager.getTask('task-test123');
      expect(task).toBeDefined();
      expect(task!.assignedWorkerId).toBeNull();
      expect(stateManager.getWorker('worker-to-delete')).toBeNull();
    });

    it('concurrent sendMessage calls produce valid JSONL', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      // Create a channel
      const channel = await stateManager.createChannel({ name: 'test-concurrent', type: 'custom' });
      await stateManager.createWorker({
        id: 'sender-1',
        type: 'CLAUDE',
        projectId: 'proj-test123',
        epicId: 'epic-test123',
        currentTaskId: null,
        status: 'IDLE'
      });

      // Send 10 messages in parallel
      const promises = Array.from({ length: 10 }, (_, i) =>
        stateManager.sendMessage({ channel: channel.id, sender: 'sender-1', content: `msg-${i}` })
      );
      await Promise.all(promises);

      // Verify all messages are readable
      const messages = await stateManager.getMessages(channel.id);
      expect(messages.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(messages.some(m => m.content === `msg-${i}`)).toBe(true);
      }
    });

    it('concurrent pinMessage calls - only one succeeds', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const channel = await stateManager.createChannel({ name: 'pin-test', type: 'custom' });
      await stateManager.createWorker({
        id: 'pinner',
        type: 'CLAUDE',
        projectId: 'proj-test123',
        epicId: 'epic-test123',
        currentTaskId: null,
        status: 'IDLE'
      });

      const { message } = await stateManager.sendMessage({ channel: channel.id, sender: 'pinner', content: 'pin me' });

      // Try to pin same message twice concurrently
      const results = await Promise.allSettled([
        stateManager.pinMessage(channel.id, message.id, 'pinner'),
        stateManager.pinMessage(channel.id, message.id, 'pinner')
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });

    it('flushActivityLog waits for pending writes', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();

      // Trigger some activity writes
      await stateManager.updateTask('task-test123', { title: 'Updated for flush test' });

      // Flush should complete without hanging
      await stateManager.flushActivityLog();

      // Verify activity log has entries
      const logPath = path.join(moePath, 'activity.log');
      const content = fs.readFileSync(logPath, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
    });

    it('updateTask rejects double-assignment via optimistic concurrency check', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ assignedWorkerId: 'worker-A', status: 'WORKING' });
      await stateManager.load();

      // Try to assign a different worker while already assigned
      await expect(
        stateManager.updateTask('task-test123', { assignedWorkerId: 'worker-B' })
      ).rejects.toThrow('Task already assigned to worker-A');

      // Original assignment should be preserved
      const task = stateManager.getTask('task-test123');
      expect(task!.assignedWorkerId).toBe('worker-A');
    });

    it('updateTask allows re-assignment when clearing first', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ assignedWorkerId: 'worker-A', status: 'WORKING' });
      await stateManager.load();

      // Clear assignment first, then re-assign
      await stateManager.updateTask('task-test123', { assignedWorkerId: null });
      await stateManager.updateTask('task-test123', { assignedWorkerId: 'worker-B' });

      const task = stateManager.getTask('task-test123');
      expect(task!.assignedWorkerId).toBe('worker-B');
    });

    it('updateTask allows same worker to re-assign (idempotent)', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ assignedWorkerId: 'worker-A', status: 'WORKING' });
      await stateManager.load();

      // Same worker re-assigning should not throw
      await stateManager.updateTask('task-test123', { assignedWorkerId: 'worker-A' });

      const task = stateManager.getTask('task-test123');
      expect(task!.assignedWorkerId).toBe('worker-A');
    });
  });

  describe('chat system fixes', () => {
    it('getMessages returns empty array for invalid sinceId', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const channel = await stateManager.createChannel({ name: 'test-stale', type: 'custom' });
      await stateManager.createWorker({
        id: 'w1', type: 'CLAUDE', projectId: 'proj-test123',
        epicId: 'epic-test123', currentTaskId: null, status: 'IDLE'
      });

      await stateManager.sendMessage({ channel: channel.id, sender: 'w1', content: 'hello' });
      await stateManager.sendMessage({ channel: channel.id, sender: 'w1', content: 'world' });

      // Use a sinceId that doesn't exist — should return empty, not all messages
      const msgs = await stateManager.getMessages(channel.id, { sinceId: 'msg-nonexistent' });
      expect(msgs).toEqual([]);
    });

    it('messageExistsInChannel finds messages regardless of age', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const channel = await stateManager.createChannel({ name: 'pin-age-test', type: 'custom' });
      await stateManager.createWorker({
        id: 'w1', type: 'CLAUDE', projectId: 'proj-test123',
        epicId: 'epic-test123', currentTaskId: null, status: 'IDLE'
      });

      const { message: firstMsg } = await stateManager.sendMessage({ channel: channel.id, sender: 'w1', content: 'old msg' });

      // Verify the message can be found
      expect(stateManager.messageExistsInChannel(channel.id, firstMsg.id)).toBe(true);
      expect(stateManager.messageExistsInChannel(channel.id, 'msg-fake')).toBe(false);
    });

    it('updateWorkerCursors merges atomically', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      await stateManager.createWorker({
        id: 'cursor-worker', type: 'CLAUDE', projectId: 'proj-test123',
        epicId: 'epic-test123', currentTaskId: null, status: 'IDLE'
      });

      // Set initial cursors
      await stateManager.updateWorkerCursors('cursor-worker', { 'chan-a': 'msg-1' });
      let worker = stateManager.getWorker('cursor-worker');
      expect(worker!.chatCursors).toEqual({ 'chan-a': 'msg-1' });

      // Merge additional cursor without losing the first
      await stateManager.updateWorkerCursors('cursor-worker', { 'chan-b': 'msg-2' });
      worker = stateManager.getWorker('cursor-worker');
      expect(worker!.chatCursors).toEqual({ 'chan-a': 'msg-1', 'chan-b': 'msg-2' });

      // Overwrite existing cursor
      await stateManager.updateWorkerCursors('cursor-worker', { 'chan-a': 'msg-3' });
      worker = stateManager.getWorker('cursor-worker');
      expect(worker!.chatCursors).toEqual({ 'chan-a': 'msg-3', 'chan-b': 'msg-2' });
    });

    it('updateWorkerCursors silently skips nonexistent worker', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      // Should not throw
      await stateManager.updateWorkerCursors('nonexistent-worker', { 'chan-a': 'msg-1' });
    });
  });

  describe('input validation fixes (B27-B31)', () => {
    it('updateTask truncates oversized title (B27)', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();

      const longTitle = 'x'.repeat(501);
      const updated = await stateManager.updateTask('task-test123', { title: longTitle });
      expect(updated.title.length).toBe(500);
    });

    it('updateTask rejects invalid priority (B27)', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask();
      await stateManager.load();

      await expect(stateManager.updateTask('task-test123', { priority: 'INVALID' as any })).rejects.toThrow('Invalid priority');
    });

    it('createTask truncates plan to 50 steps (B28)', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      const bigPlan = Array.from({ length: 60 }, (_, i) => ({
        stepId: `step-${i + 1}`,
        description: `Step ${i + 1}`,
        status: 'PENDING' as const,
        affectedFiles: [],
      }));

      const task = await stateManager.createTask({
        epicId: 'epic-test123',
        title: 'Plan test',
        implementationPlan: bigPlan,
      });

      expect(task.implementationPlan.length).toBe(50);
    });

    it('clears assignedWorkerId on any status change unless explicitly set', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'WORKING', assignedWorkerId: 'worker-1' });
      await stateManager.load();

      // Moving columns clears worker so a new role can claim
      const updated = await stateManager.updateTask('task-test123', { status: 'REVIEW' });
      expect(updated.assignedWorkerId).toBeNull();
    });

    it('preserves assignedWorkerId when explicitly set during status change', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'PLANNING', assignedWorkerId: null });
      await stateManager.load();

      // claimNextTask sets both status and assignedWorkerId together
      const updated = await stateManager.updateTask('task-test123', { status: 'WORKING', assignedWorkerId: 'worker-2' });
      expect(updated.assignedWorkerId).toBe('worker-2');
    });

    it('clears assignedWorkerId on transition to BACKLOG (B29)', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'WORKING', assignedWorkerId: 'worker-1' });
      await stateManager.load();

      const updated = await stateManager.updateTask('task-test123', { status: 'BACKLOG' });
      expect(updated.assignedWorkerId).toBeNull();
    });

    it('deleteTask clears orphaned parentTaskId (B30)', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ id: 'task-parent' });
      createTestTask({ id: 'task-child', parentTaskId: 'task-parent' });
      await stateManager.load();

      await stateManager.deleteTask('task-parent');

      const child = stateManager.getTask('task-child');
      expect(child).not.toBeNull();
      expect(child!.parentTaskId).toBeNull();
    });
  });

  describe('createChannel concurrency', () => {
    it('concurrent createChannel with same name creates exactly one channel', async () => {
      setupMoeFolder();
      createTestEpic();
      await stateManager.load();

      // Fire two concurrent createChannel calls with the same name
      const results = await Promise.allSettled([
        stateManager.createChannel({ name: 'dup-test', type: 'custom' }),
        stateManager.createChannel({ name: 'dup-test', type: 'custom' }),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Exactly one should succeed, one should fail with 'already exists'
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already exists');

      // Verify only one channel exists
      const channels = stateManager.getChannels().filter(c => c.name === 'dup-test');
      expect(channels).toHaveLength(1);
    });
  });

  describe('runExclusive serialization', () => {
    it('concurrent runExclusive calls on same task produce consistent state', async () => {
      setupMoeFolder();
      createTestEpic();
      createTestTask({ status: 'WORKING', assignedWorkerId: 'worker-1' });
      await stateManager.load();

      // Simulate concurrent plugin updateTask + MCP updateTask via runExclusive
      // Both try to update the same task's description concurrently
      const results = await Promise.allSettled([
        stateManager.runExclusive(async () => {
          return stateManager.updateTask('task-test123', { description: 'Updated by plugin' });
        }),
        stateManager.runExclusive(async () => {
          return stateManager.updateTask('task-test123', { description: 'Updated by MCP' });
        }),
      ]);

      // Both should succeed (serialized, not racing)
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);

      // The task should have one consistent description (whichever ran last wins)
      const task = stateManager.getTask('task-test123');
      expect(task).not.toBeNull();
      expect(['Updated by plugin', 'Updated by MCP']).toContain(task!.description);
    });
  });
});

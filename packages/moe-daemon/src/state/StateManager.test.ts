import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('StateManager', () => {
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

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-test-'));
    moePath = path.join(testDir, '.moe');
    stateManager = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
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

      expect(events.length).toBe(2);
      expect(events[0].type).toBe('TASK_CREATED');
      expect(events[1].type).toBe('TASK_UPDATED');
    });
  });
});

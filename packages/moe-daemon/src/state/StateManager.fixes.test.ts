import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import type { Epic, Project, Worker } from '../types/schema.js';

// submitPlan is imported transitively for speed-mode timer cleanup; mock it so
// these tests don't schedule real timers.
vi.mock('../tools/submitPlan.js', () => ({
  cancelSpeedModeTimeout: vi.fn(),
}));

describe('StateManager hardening fixes', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

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

  function writeEpic(overrides: Partial<Epic> = {}): Epic {
    const epic: Epic = {
      id: 'epic-test123',
      projectId: 'proj-test123',
      title: 'Test Epic',
      description: '',
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

  function writeWorker(overrides: Partial<Worker> = {}): Worker {
    const worker: Worker = {
      id: 'worker-test123',
      type: 'CLAUDE',
      projectId: 'proj-test123',
      epicId: 'epic-test123',
      currentTaskId: null,
      status: 'IDLE',
      branch: '',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
      teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-fixes-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // H2: forward paging after a cursor must return the OLDEST slice so repeated
  // reads (each advancing the cursor) walk the whole backlog in order.
  describe('getMessages forward paging (H2)', () => {
    it('returns the oldest slice after a cursor so the backlog is never skipped', async () => {
      setupMoeFolder();
      await state.load();
      const channel = await state.createChannel({ name: 'h2', type: 'custom' });

      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const { message } = await state.sendMessage({ channel: channel.id, sender: 'human', content: `m${i}` });
        ids.push(message.id);
      }

      // Cursor at m1 (ids[0]), limit 2 -> oldest two after the cursor: m2, m3.
      const firstPage = await state.getMessages(channel.id, { sinceId: ids[0], limit: 2 });
      expect(firstPage.map((m) => m.content)).toEqual(['m2', 'm3']);

      // Advance the cursor to the last returned id (what chat_read does) and read
      // again -> the next chronological slice, with no gap.
      const secondPage = await state.getMessages(channel.id, { sinceId: firstPage[firstPage.length - 1].id, limit: 2 });
      expect(secondPage.map((m) => m.content)).toEqual(['m4', 'm5']);
    });

    it('returns the most recent window for a fresh read (no cursor)', async () => {
      setupMoeFolder();
      await state.load();
      const channel = await state.createChannel({ name: 'h2b', type: 'custom' });
      for (let i = 1; i <= 5; i++) {
        await state.sendMessage({ channel: channel.id, sender: 'human', content: `m${i}` });
      }

      const page = await state.getMessages(channel.id, { limit: 2 });
      expect(page.map((m) => m.content)).toEqual(['m4', 'm5']);
    });
  });

  // H3: normalizeProject must preserve user settings keys outside its validated
  // allowlist (autoCommit, models) across a load/normalize/write cycle.
  describe('normalizeProject settings round-trip (H3)', () => {
    it('preserves autoCommit and models through load + persisted normalization', async () => {
      setupMoeFolder({
        settings: {
          approvalMode: 'CONTROL',
          speedModeDelayMs: 2000,
          autoCreateBranch: true,
          branchPattern: 'moe/{epicId}/{taskId}',
          commitPattern: 'feat({epicId}): {taskTitle}',
          agentCommand: 'claude',
          autoCommit: false,
          models: { architect: 'claude-opus-4-8', worker: 'claude-opus-4-8' },
        } as unknown as Project['settings'],
      });

      await state.load();

      const settings = state.project!.settings as unknown as Record<string, unknown>;
      expect(settings.autoCommit).toBe(false);
      expect(settings.models).toEqual({ architect: 'claude-opus-4-8', worker: 'claude-opus-4-8' });

      // load() persists the normalized object when it differs — the on-disk copy
      // must still carry the user keys, not the stripped allowlist.
      const persisted = JSON.parse(fs.readFileSync(path.join(moePath, 'project.json'), 'utf-8'));
      expect(persisted.settings.autoCommit).toBe(false);
      expect(persisted.settings.models).toEqual({ architect: 'claude-opus-4-8', worker: 'claude-opus-4-8' });
    });
  });

  // L4: touchWorker must no-op on a DEAD worker so an in-flight tool call can't
  // reset its prune clock or resurrect it.
  describe('touchWorker DEAD no-op (L4)', () => {
    it('does not refresh or revive a DEAD worker', async () => {
      setupMoeFolder();
      const oldActivity = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      writeWorker({ status: 'DEAD', lastActivityAt: oldActivity });
      await state.load();

      const result = await state.touchWorker('worker-test123', { status: 'IDLE' });
      expect(result).toBeNull();

      const worker = state.getWorker('worker-test123');
      expect(worker?.status).toBe('DEAD');
      expect(worker?.lastActivityAt).toBe(oldActivity);
    });

    it('still refreshes a live worker', async () => {
      setupMoeFolder();
      const oldActivity = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      writeWorker({ status: 'IDLE', lastActivityAt: oldActivity });
      await state.load();

      const result = await state.touchWorker('worker-test123');
      expect(result).not.toBeNull();
      expect(state.getWorker('worker-test123')?.lastActivityAt).not.toBe(oldActivity);
    });
  });

  // L29: createTask must refuse to add tasks to an ARCHIVED epic.
  describe('createTask archived-epic rejection (L29)', () => {
    it('rejects task creation on an ARCHIVED epic', async () => {
      setupMoeFolder();
      writeEpic({ status: 'ARCHIVED' });
      await state.load();

      await expect(state.createTask({ epicId: 'epic-test123', title: 'nope' }))
        .rejects.toThrow(/un-archive the epic first/);
    });

    it('allows task creation on an active epic', async () => {
      setupMoeFolder();
      writeEpic({ status: 'ACTIVE' });
      await state.load();

      const task = await state.createTask({ epicId: 'epic-test123', title: 'ok' });
      expect(task.epicId).toBe('epic-test123');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTaskTool } from './createTask.js';
import type { Task } from '../types/schema.js';

describe('moe.create_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('creates a new task', async () => {
    const tool = createTaskTool(h.state);
    const result = await tool.handler({
      epicId: 'epic-1',
      title: 'New Task',
      description: 'Task desc',
    }, h.state) as { success: boolean; task: Task };

    expect(result.success).toBe(true);
    expect(result.task.title).toBe('New Task');
    expect(result.task.createdBy).toBe('WORKER');
  });

  it('throws for missing epicId', async () => {
    const tool = createTaskTool(h.state);
    await expect(tool.handler({ title: 'Test' }, h.state)).rejects.toThrow('Missing required field: epicId');
  });

  it('throws for missing title', async () => {
    const tool = createTaskTool(h.state);
    await expect(tool.handler({ epicId: 'epic-1' }, h.state)).rejects.toThrow('Missing required field: title');
  });
});


// ---------------------------------------------------------------------------
// Creation guardrails — ALL ADVISORY. The one non-negotiable property in every
// arm below: creation NEVER hard-fails on a guardrail. Attribution: workerId's
// team role resolves into the widened createdBy.
// ---------------------------------------------------------------------------
describe('moe.create_task guardrails + attribution', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function addRoleWorker(workerId: string, role: 'architect' | 'governor' | 'qa' | 'worker'): Promise<void> {
    await h.state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    let team = Array.from(h.state.teams.values()).find((t) => t.role === role);
    if (!team) team = await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, workerId);
  }

  interface CreateResult { success: boolean; task: Task; warnings?: string[] }

  async function create(args: Record<string, unknown>): Promise<CreateResult> {
    return await createTaskTool(h.state).handler({ epicId: 'epic-1', ...args }, h.state) as CreateResult;
  }

  describe('role attribution', () => {
    beforeEach(async () => {
      h.setupMoeFolder();
      h.createEpic();
      await h.state.load();
    });

    it('resolves the caller team role into createdBy (ARCHITECT/GOVERNOR/QA/WORKER)', async () => {
      await addRoleWorker('architect-1', 'architect');
      await addRoleWorker('governor-1', 'governor');
      await addRoleWorker('qa-1', 'qa');

      expect((await create({ title: 'A', workerId: 'architect-1' })).task.createdBy).toBe('ARCHITECT');
      expect((await create({ title: 'B', workerId: 'governor-1' })).task.createdBy).toBe('GOVERNOR');
      expect((await create({ title: 'C', workerId: 'qa-1' })).task.createdBy).toBe('QA');
      // Role resolution WINS over a self-declared createdBy.
      expect((await create({ title: 'D', workerId: 'governor-1', createdBy: 'HUMAN' })).task.createdBy).toBe('GOVERNOR');
    });

    it('falls back to the explicit createdBy, then WORKER, for team-less callers', async () => {
      expect((await create({ title: 'E', createdBy: 'HUMAN' })).task.createdBy).toBe('HUMAN');
      expect((await create({ title: 'F', workerId: 'worker-unknown' })).task.createdBy).toBe('WORKER');
      expect((await create({ title: 'G' })).task.createdBy).toBe('WORKER');
    });
  });

  describe('advisory guardrails (creation NEVER hard-fails)', () => {
    it('warns — does not throw — when the target column is at its WIP limit', async () => {
      h.setupMoeFolder({
        settings: {
          approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: true,
          branchPattern: '', commitPattern: '', agentCommand: 'claude',
          columnLimits: { PLANNING: 1 },
        } as never,
      });
      h.createEpic();
      h.createTask({ id: 'task-in-col', status: 'PLANNING' });
      await h.state.load();

      const result = await create({ title: 'Over the limit', status: 'PLANNING' });
      expect(result.success).toBe(true);
      expect(h.state.getTask(result.task.id)!.status).toBe('PLANNING');
      expect(result.warnings!.some((w) => w.includes('WIP limit of 1'))).toBe(true);
    });

    it('warns on a meta-titled row when the epic already carries a hardening row, naming the consolidation target', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-harden', title: 'Epic hardening & verification gate', status: 'BACKLOG', order: 40 });
      await h.state.load();

      const result = await create({ title: 'Security evidence for R3 spinoff' });
      expect(result.success).toBe(true);
      const warning = result.warnings!.find((w) => w.includes('task-harden'));
      expect(warning).toBeDefined();
      expect(warning).toContain('Consolidate');

      // A non-meta title next to the same hardening row warns about nothing meta.
      const plain = await create({ title: 'Implement the parser' });
      expect((plain.warnings ?? []).every((w) => !w.includes('task-harden'))).toBe(true);
    });

    it('warns past settings.taskSizing.maxTasksPerEpic (default 40) without blocking creation', async () => {
      h.setupMoeFolder({
        settings: {
          approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: true,
          branchPattern: '', commitPattern: '', agentCommand: 'claude',
          taskSizing: { maxTasksPerEpic: 2 },
        } as never,
      });
      h.createEpic();
      h.createTask({ id: 'task-e1', title: 'one', order: 1 });
      h.createTask({ id: 'task-e2', title: 'two', order: 2 });
      await h.state.load();

      const result = await create({ title: 'three' });
      expect(result.success).toBe(true);
      expect(result.warnings!.some((w) => w.includes('maxTasksPerEpic') && w.includes('3'))).toBe(true);

      // Under the ceiling: no such warning.
      h.cleanup(); h.init();
      h.setupMoeFolder();
      h.createEpic();
      await h.state.load();
      const under = await create({ title: 'first row' });
      expect((under.warnings ?? []).every((w) => !w.includes('maxTasksPerEpic'))).toBe(true);
    });

    it('drops unknown dependsOn ids with a warning and stores the known ones', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-real11', status: 'WORKING' });
      await h.state.load();

      const result = await create({ title: 'dependent', dependsOn: ['task-real11', 'task-fake99', 'task-real11'] });
      expect(result.success).toBe(true);
      expect(h.state.getTask(result.task.id)!.dependsOn).toEqual(['task-real11']);
      expect(result.warnings!.some((w) => w.includes('task-fake99'))).toBe(true);

      // A fully-known list stores silently.
      const clean = await create({ title: 'dependent 2', dependsOn: ['task-real11'] });
      expect(h.state.getTask(clean.task.id)!.dependsOn).toEqual(['task-real11']);
    });

    it('names the dependsOn ids dropped past the 20-id cap instead of vanishing them', async () => {
      h.setupMoeFolder();
      h.createEpic();
      const ids: string[] = [];
      for (let i = 0; i < 22; i++) {
        const id = `task-c${String(i).padStart(5, '0')}`;
        h.createTask({ id, title: `prereq ${i}`, status: 'WORKING', order: i + 1 });
        ids.push(id);
      }
      await h.state.load();

      const result = await create({ title: 'wide dependent', dependsOn: ids });
      expect(result.success).toBe(true);
      expect(h.state.getTask(result.task.id)!.dependsOn).toEqual(ids.slice(0, 20));
      const capWarning = result.warnings!.find((w) => w.includes('capped at 20'));
      expect(capWarning).toBeDefined();
      expect(capWarning).toContain(ids[20]);
      expect(capWarning).toContain(ids[21]);
      expect(capWarning).toContain('moe.set_task_dependencies');
    });
  });
});

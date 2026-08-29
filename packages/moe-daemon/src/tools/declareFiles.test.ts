import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { declareFilesTool } from './declareFiles.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { getActivityLogTool } from './getActivityLog.js';
import { getTools } from './index.js';

interface DeclareResult {
  success: boolean;
  taskId: string;
  declaredFiles: string[];
  addedPaths: string[];
  alreadyDeclared: string[];
  note?: string;
  message: string;
}

describe('moe.declare_files', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function declare(args: Record<string, unknown>): Promise<DeclareResult> {
    return await declareFilesTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as DeclareResult;
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-owner', declaredFiles: ['src/already.ts'] });
    h.createWorker({ id: 'gov-1', status: 'GOVERNING', lastActivityAt: '2020-01-01T00:00:00.000Z' });
    await h.state.load();
  });

  it('is registered in getTools()', () => {
    expect(getTools(h.state).map((t) => t.name)).toContain('moe.declare_files');
  });

  it('unions normalized paths into task.declaredFiles and reports what was new', async () => {
    const sys = vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue(undefined);
    const result = await declare({
      paths: ['./src/new.ts', 'src\\other.ts', 'src/already.ts', 'src/new.ts'],
      workerId: 'gov-1',
      note: 'edited by the b54b5609 session, never reported',
    });

    expect(result.success).toBe(true);
    expect(result.addedPaths).toEqual(['src/new.ts', 'src/other.ts']);
    expect(result.alreadyDeclared).toEqual(['src/already.ts']);
    expect(result.declaredFiles).toEqual(['src/already.ts', 'src/new.ts', 'src/other.ts']);
    expect(result.note).toBe('edited by the b54b5609 session, never reported');
    expect(h.state.getTask('task-1')!.declaredFiles).toEqual(['src/already.ts', 'src/new.ts', 'src/other.ts']);
    expect(sys).toHaveBeenCalledWith('task-1', expect.stringContaining('gov-1 declared 3 path(s) on task-1 (2 new)'));
    // Liveness touch.
    expect(Date.parse(h.state.getWorker('gov-1')!.lastActivityAt)).toBeGreaterThan(Date.parse('2021-01-01T00:00:00.000Z'));
  });

  it('logs TASK_FILES_DECLARED even when nothing was new', async () => {
    const result = await declare({ paths: ['src/already.ts'] });
    expect(result.addedPaths).toEqual([]);
    expect(result.message).toContain('already declared');
    await h.state.flushActivityLog();
    const log = await getActivityLogTool(h.state).handler({ eventTypes: ['TASK_FILES_DECLARED'] }, h.state) as {
      events: Array<{ event: string; taskId?: string }>;
    };
    expect(log.events.find((e) => e.event === 'TASK_FILES_DECLARED')?.taskId).toBe('task-1');
  });

  it('has no ownership guard and works in any status', async () => {
    await h.state.updateTask('task-1', { status: 'DONE' });
    const result = await declare({ paths: ['src/late.ts'], workerId: 'not-the-owner' });
    expect(result.addedPaths).toEqual(['src/late.ts']);
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  it('feeds the ASSERTED tier of get_commit_scope', async () => {
    await declare({ paths: ['src/declared-later.ts'] });
    const scope = await getCommitScopeTool(h.state).handler({ taskId: 'task-1' }, h.state) as { asserted: string[] };
    expect(scope.asserted).toContain('src/declared-later.ts');
    expect(scope.asserted).toContain('src/already.ts');
  });

  it('rejects absolute/traversal paths, empty lists and malformed input without writing', async () => {
    await expect(declare({ paths: ['/etc/passwd'] })).rejects.toThrow('project-relative');
    await expect(declare({ paths: ['../up.ts'] })).rejects.toThrow('traversal');
    await expect(declare({ paths: [] })).rejects.toThrow('at least one path');
    await expect(declare({ paths: 'src/a.ts' })).rejects.toThrow('array');
    await expect(declare({})).rejects.toThrow('Missing required field: paths');
    await expect(declare({ paths: ['a.ts'], note: 42 })).rejects.toThrow('note');
    await expect(declareFilesTool(h.state).handler({ paths: ['a.ts'] }, h.state)).rejects.toThrow('Missing required field: taskId');
    await expect(declare({ taskId: 'nope', paths: ['a.ts'] })).rejects.toThrow('Task not found');
    expect(h.state.getTask('task-1')!.declaredFiles).toEqual(['src/already.ts']);
  });
});

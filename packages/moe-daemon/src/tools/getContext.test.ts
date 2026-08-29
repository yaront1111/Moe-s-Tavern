import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getContextTool } from './getContext.js';
import type { TaskCommit } from '../types/schema.js';

describe('moe.get_context', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  it('returns project context without task', async () => {
    h.setupMoeFolder();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({}, h.state) as { project: { name: string }; task: null };

    expect(result.project.name).toBe('Test Project');
    expect(result.task).toBeNull();
  });

  it('returns task context when taskId provided', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { task: { id: string }; epic: { id: string } };

    expect(result.task?.id).toBe('task-1');
    expect(result.epic?.id).toBe('epic-1');
  });

  it('throws if project not loaded', async () => {
    const tool = getContextTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('not loaded state, expected loaded');
  });

  it('returns worker when task has assignedWorkerId', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({
      id: 'worker-ctx',
      status: 'CODING',
      lastError: 'prev error',
      errorCount: 2,
      chatCursors: { 'chan-heavy': 'msg-heavy' },
    });
    h.createTask({ assignedWorkerId: 'worker-ctx' });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      worker: {
        id: string;
        status: string;
        lastError: string | null;
        errorCount: number;
        chatCursors?: unknown;
        branch?: unknown;
        modifiedFiles?: unknown;
      } | null;
    };

    expect(result.worker).not.toBeNull();
    expect(result.worker!.id).toBe('worker-ctx');
    expect(result.worker!.status).toBe('CODING');
    expect(result.worker!.lastError).toBe('prev error');
    expect(result.worker!.errorCount).toBe(2);
    expect(result.worker!.chatCursors).toBeUndefined();
    expect(result.worker!.branch).toBeUndefined();
    expect(result.worker!.modifiedFiles).toBeUndefined();
  });

  it('returns null worker when task has no assignedWorkerId', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: null });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { worker: null };

    expect(result.worker).toBeNull();
  });

  it('returns null worker when no task provided', async () => {
    h.setupMoeFolder();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({}, h.state) as { worker: null };

    expect(result.worker).toBeNull();
  });

  it('records contextFetchedBy when workerId provided and task is claimed', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: 'worker-ctx' });
    await h.state.load();
    const tool = getContextTool(h.state);

    await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

    // Duplicate call does not produce duplicate entries
    await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

    // Different worker is appended
    await tool.handler({ taskId: 'task-1', workerId: 'worker-qa' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx', 'worker-qa']);
  });

  it('does not record contextFetchedBy when workerId is missing', async () => {
    const prev = process.env.MOE_WORKER_ID;
    delete process.env.MOE_WORKER_ID;
    try {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ assignedWorkerId: 'worker-ctx' });
      await h.state.load();
      const tool = getContextTool(h.state);
      await tool.handler({ taskId: 'task-1' }, h.state);
      expect(h.state.getTask('task-1')?.contextFetchedBy).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.MOE_WORKER_ID;
      else process.env.MOE_WORKER_ID = prev;
    }
  });

  it('returns step notes in implementationPlan', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      implementationPlan: [
        { stepId: 'step-1', description: 'First', status: 'COMPLETED', affectedFiles: ['a.ts'], note: 'Design decision: used factory pattern', modifiedFiles: ['a.ts', 'b.ts'] },
        { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      task: { implementationPlan: Array<{ stepId: string; note?: string; modifiedFiles?: string[] }> };
    };

    const step1 = result.task.implementationPlan.find(s => s.stepId === 'step-1');
    expect(step1?.note).toBe('Design decision: used factory pattern');
    expect(step1?.modifiedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('does not auto-inject recent chat by default', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask();
    await h.state.load();
    const general = h.state.getChannels().find((channel) => channel.name === 'general');
    expect(general).toBeDefined();
    await h.state.sendMessage({
      channel: general!.id,
      sender: 'human',
      content: 'Long general chat message '.repeat(80),
    });

    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      chat?: { recentMessages: unknown[] };
    };

    expect(result.chat?.recentMessages ?? []).toEqual([]);
  });

  it('keeps task comments compact in get_context and exposes summary metadata', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      comments: [
        { id: 'c1', author: 'human', content: 'old comment', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'c2', author: 'human', content: 'A'.repeat(1200), timestamp: '2024-01-01T00:01:00Z' },
        { id: 'c3', author: 'worker-1', content: 'latest comment', timestamp: '2024-01-01T00:02:00Z' },
      ],
    });
    await h.state.load();
    const tool = getContextTool(h.state);

    const compact = await tool.handler({
      taskId: 'task-1',
      commentsLimit: 2,
      commentsMaxChars: 100,
    }, h.state) as {
      task: {
        comments: Array<{
          id: string;
          content: string;
          contentTruncated?: boolean;
          contentOriginalLength?: number;
        }>;
        commentSummary: { total: number; returned: number; omitted: number; truncated: number };
      };
    };

    expect(compact.task.comments.map(comment => comment.id)).toEqual(['c2', 'c3']);
    expect(compact.task.comments[0].content.length).toBeLessThanOrEqual(100);
    expect(compact.task.comments[0].contentTruncated).toBe(true);
    expect(compact.task.comments[0].contentOriginalLength).toBe(1200);
    expect(compact.task.commentSummary).toMatchObject({
      total: 3,
      returned: 2,
      omitted: 1,
      truncated: 1,
    });

    const fullComment = await tool.handler({
      taskId: 'task-1',
      commentsLimit: 1,
      commentsMaxChars: 0,
    }, h.state) as { task: { comments: Array<{ content: string; contentTruncated?: boolean }> } };
    expect(fullComment.task.comments[0].content).toBe('latest comment');
    expect(fullComment.task.comments[0].contentTruncated).toBeUndefined();
  });

  describe('commit ledger + attribution surface', () => {
    interface ContextTask {
      commits: Array<{
        sha: string; treeId: string | null; ref: string; kind: string; status: string | null; pushed: boolean | null;
        recordedAt: string; recordedBy: string; pathCount: number; inferredCount: number;
      }>;
      commitCount: number;
      lastCommitOutcome: unknown;
      landing: { lastCompletion?: { sha: string; ref: string; pushed: boolean | null; recordedAt: string }; lastCheckpoint?: { sha: string; recordedAt: string } };
      declaredPaths: string[];
      inferredPaths: string[];
      unattributedPaths: string[];
      unattributedHint?: string;
      rescueRefsHint?: string;
      epicSiblings: Array<{ id: string; title: string; order: number; status: string; landed: boolean; landing: { merged: boolean; lastCompletion?: { sha: string } } }>;
    }

    function commit(overrides: Partial<TaskCommit>): TaskCommit {
      return {
        sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', kind: 'completion', role: 'worker',
        sessionId: 'w@t', paths: ['src/a.ts', 'src/m.ts'], inferredPaths: ['src/m.ts'], pushed: true,
        recordedBy: 'worker-1', recordedAt: '2026-08-28T10:05:00.000Z', ...overrides,
      };
    }

    it('surfaces bounded commits, landing, tiers, hints and the REVIEW audit nudge', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({
        id: 'task-1',
        status: 'REVIEW',
        order: 5,
        implementationPlan: [
          { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/plan.ts'], modifiedFiles: ['src/step.ts'] },
          { stepId: 's2', description: 'b', status: 'PENDING', affectedFiles: ['src/pending.ts'] },
        ],
        filesModified: ['src/fm.ts'],
        declaredFiles: ['src/decl.ts'],
        touchedFiles: ['src/touched.ts'],
        inferredPaths: ['src/m.ts'],
        unattributedPaths: ['src/foreign.ts'],
        lastCommitOutcome: { outcome: 'committed', kind: 'completion', sessionId: 'w@t', at: '2026-08-28T10:05:00.000Z' },
        commits: [
          commit({ kind: 'checkpoint', sha: 'c0ffee1c0ffee1', recordedAt: '2026-08-28T09:00:00.000Z', pushed: false, treeId: 'deadbeefdeadbeef' }),
          commit({ kind: 'rescue', sha: 'e5c4e0e5c4e0e5', ref: 'refs/moe/rescue/task-1/20260828T093000Z', recordedAt: '2026-08-28T09:30:00.000Z', pushed: false }),
          commit({}),
        ],
      });
      await h.state.load();

      const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
        task: ContextTask; nextAction: { tool: string; reason: string };
      };
      const t = result.task;
      expect(t.commitCount).toBe(3);
      expect(t.commits).toHaveLength(3);
      expect(t.commits[0]).toEqual({
        sha: 'c0ffee1c0ffee1', treeId: 'deadbeefdeadbeef', ref: 'moe/work-2026-08-28', kind: 'checkpoint', status: null,
        pushed: false, recordedAt: '2026-08-28T09:00:00.000Z', recordedBy: 'worker-1', pathCount: 2, inferredCount: 1,
      });
      // Projection only — never the raw path arrays.
      expect((t.commits[0] as unknown as { paths?: unknown }).paths).toBeUndefined();
      expect(t.landing).toEqual({
        lastCompletion: { sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', pushed: true, recordedAt: '2026-08-28T10:05:00.000Z' },
        lastCheckpoint: { sha: 'c0ffee1c0ffee1', recordedAt: '2026-08-28T09:00:00.000Z' },
      });
      expect(t.lastCommitOutcome).toMatchObject({ outcome: 'committed', kind: 'completion' });
      // ASSERTED tier: completed step's modifiedFiles, filesModified, declared, touched, committed non-inferred.
      expect([...t.declaredPaths].sort()).toEqual(['src/a.ts', 'src/decl.ts', 'src/fm.ts', 'src/step.ts', 'src/touched.ts']);
      expect(t.declaredPaths).not.toContain('src/m.ts');
      expect(t.declaredPaths).not.toContain('src/pending.ts');
      expect(t.inferredPaths).toEqual(['src/m.ts']);
      expect(t.unattributedPaths).toEqual(['src/foreign.ts']);
      expect(t.unattributedHint).toContain('moe.declare_files { taskId: "task-1"');
      expect(t.unattributedHint).toContain('src/foreign.ts');
      expect(t.rescueRefsHint).toContain('refs/moe/rescue/task-1/20260828T093000Z');
      expect(t.rescueRefsHint).toContain('git checkout <ref> -- <path>');
      expect(result.nextAction.tool).toBe('moe.qa_approve');
      expect(result.nextAction.reason).toContain('confirm a completion commit is recorded in task.commits (`git show <sha>`) before approving');
    });

    it('returns empty evidence for a task without a ledger', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING' });
      await h.state.load();

      const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as { task: ContextTask };
      expect(result.task.commits).toEqual([]);
      expect(result.task.commitCount).toBe(0);
      expect(result.task.landing).toEqual({});
      expect(result.task.lastCommitOutcome).toBeNull();
      expect(result.task.declaredPaths).toEqual([]);
      expect(result.task.inferredPaths).toEqual([]);
      expect(result.task.unattributedPaths).toEqual([]);
      expect(result.task.unattributedHint).toBeUndefined();
      expect(result.task.rescueRefsHint).toBeUndefined();
      expect(result.task.epicSiblings).toEqual([]);
    });

    it('lists lower-order epic siblings with a landed flag (pushed completion or REVIEW/DONE)', async () => {
      h.setupMoeFolder();
      h.createEpic({ id: 'epic-1' });
      h.createEpic({ id: 'epic-2' });
      h.createTask({ id: 'task-1', status: 'WORKING', order: 4 });
      // Landed via a pushed completion commit.
      h.createTask({ id: 'task-a', title: 'A', status: 'WORKING', order: 1, commits: [commit({ sha: 'aaaaaaaaaaaaaa' })] });
      // Landed by status alone.
      h.createTask({ id: 'task-b', title: 'B', status: 'DONE', order: 2 });
      // Unpushed completion + WORKING → not landed.
      h.createTask({ id: 'task-c', title: 'C', status: 'WORKING', order: 3, commits: [commit({ sha: 'cccccccccccccc', pushed: false })] });
      // Higher order, other epic: excluded.
      h.createTask({ id: 'task-later', status: 'BACKLOG', order: 9 });
      h.createTask({ id: 'task-other-epic', epicId: 'epic-2', status: 'DONE', order: 1 });
      await h.state.load();

      const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as { task: ContextTask };
      expect(result.task.epicSiblings.map((s) => s.id)).toEqual(['task-a', 'task-b', 'task-c']);
      const byId = new Map(result.task.epicSiblings.map((s) => [s.id, s]));
      expect(byId.get('task-a')).toMatchObject({ order: 1, status: 'WORKING', landed: true, landing: { merged: true, lastCompletion: { sha: 'aaaaaaaaaaaaaa' } } });
      expect(byId.get('task-b')).toMatchObject({ status: 'DONE', landed: true, landing: { merged: true } });
      expect(byId.get('task-b')!.landing.lastCompletion).toBeUndefined();
      expect(byId.get('task-c')).toMatchObject({ landed: false, landing: { merged: false, lastCompletion: { sha: 'cccccccccccccc' } } });
    });
  });
});


// ---------------------------------------------------------------------------
// Dependency surface: declared dependsOn/blockedOnTaskIds targets appear in
// epicSiblings regardless of the lower-order filter and the 20-cap, carrying
// the prerequisite's evidence (verification/reviewSummary/completionSummary)
// so dependents read the board instead of grepping HEAD. Plus isEpicFinal.
// ---------------------------------------------------------------------------
describe('moe.get_context dependency surface + isEpicFinal', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  interface DepSibling {
    id: string;
    order: number;
    status: string;
    declaredDependency?: boolean;
    verification?: { command: string; exitCode: number; reportedAt?: string } | null;
    reviewSummary?: string | null;
    completionSummary?: string | null;
  }

  it('includes higher-order and cross-epic declared targets, enriched with their evidence', async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createEpic({ id: 'epic-2' });
    // Declared dep with HIGHER order (the lower-order filter would drop it).
    h.createTask({
      id: 'task-dep-hi', status: 'DONE', order: 9,
      verification: { command: 'npm test', exitCode: 0, outputTail: 'tail', reportedAt: '2026-08-28T10:00:00.000Z' },
      reviewSummary: 'QA re-ran npm test',
      completionSummary: 'Shipped the schema change',
    });
    // Declared block target in ANOTHER epic (the epic filter would drop it).
    h.createTask({ id: 'task-dep-far', epicId: 'epic-2', status: 'WORKING', order: 1 });
    // Ordinary lower-order sibling — present but NOT enriched.
    h.createTask({ id: 'task-plain', status: 'DONE', order: 1 });
    h.createTask({
      id: 'task-1', status: 'WORKING', order: 5,
      dependsOn: ['task-dep-hi'],
      blockedOnTaskIds: ['task-dep-far'],
    });
    await h.state.load();

    const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
      task: {
        epicSiblings: DepSibling[];
        dependsOn?: string[];
        dependsOnUnmet?: string[];
        isEpicFinal: boolean;
      };
    };

    const ids = result.task.epicSiblings.map((s) => s.id);
    expect(ids).toContain('task-plain');
    expect(ids).toContain('task-dep-hi');
    expect(ids).toContain('task-dep-far');

    const byId = new Map(result.task.epicSiblings.map((s) => [s.id, s]));
    expect(byId.get('task-dep-hi')).toMatchObject({
      declaredDependency: true,
      verification: { command: 'npm test', exitCode: 0, reportedAt: '2026-08-28T10:00:00.000Z' },
      reviewSummary: 'QA re-ran npm test',
      completionSummary: 'Shipped the schema change',
    });
    // Projection only — outputTail stays off the sibling payload.
    expect((byId.get('task-dep-hi')!.verification as Record<string, unknown>).outputTail).toBeUndefined();
    expect(byId.get('task-dep-far')).toMatchObject({ declaredDependency: true, verification: null });
    expect(byId.get('task-plain')!.declaredDependency).toBeUndefined();

    // Task projection carries the declared deps and which are still unmet.
    expect(result.task.dependsOn).toEqual(['task-dep-hi']);
    expect(result.task.dependsOnUnmet).toEqual([]);
    // task-dep-hi has order 9 > 5 → not epic-final.
    expect(result.task.isEpicFinal).toBe(false);
  });

  it('declared targets bypass the 20-sibling cap', async () => {
    h.setupMoeFolder();
    h.createEpic();
    for (let i = 1; i <= 25; i++) {
      h.createTask({ id: `task-fill-${i}`, status: 'DONE', order: i });
    }
    // The declared dep has the LOWEST order — exactly the row the nearest-first
    // cap would evict.
    h.createTask({ id: 'task-dep-old', status: 'DONE', order: 0 });
    h.createTask({ id: 'task-1', status: 'WORKING', order: 99, dependsOn: ['task-dep-old'] });
    await h.state.load();

    const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
      task: { epicSiblings: DepSibling[] };
    };
    const dep = result.task.epicSiblings.find((s) => s.id === 'task-dep-old');
    expect(dep).toBeDefined();
    expect(dep!.declaredDependency).toBe(true);
  });

  it('isEpicFinal: highest order wins, ties count, ARCHIVED siblings are ignored', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-mid', status: 'WORKING', order: 5 });
    h.createTask({ id: 'task-tie', status: 'WORKING', order: 7 });
    h.createTask({ id: 'task-last', status: 'REVIEW', order: 7 });
    // ARCHIVED with a higher order must NOT steal finality.
    h.createTask({ id: 'task-zomb', status: 'ARCHIVED', order: 11 });
    await h.state.load();

    const read = async (taskId: string) => (await getContextTool(h.state).handler({ taskId }, h.state) as {
      task: { isEpicFinal: boolean };
    }).task.isEpicFinal;

    expect(await read('task-mid')).toBe(false);
    expect(await read('task-tie')).toBe(true);
    expect(await read('task-last')).toBe(true);
  });

  it('surfaces the structured block bookkeeping on a BLOCKED task', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-dep111', status: 'WORKING', order: 1 });
    h.createTask({
      id: 'task-1', status: 'BLOCKED', order: 2,
      blockedReason: 'waiting on task-dep111',
      blockedOnTaskIds: ['task-dep111'],
      blockedFromStatus: 'WORKING',
      blockedAt: '2026-08-28T10:00:00.000Z',
    });
    await h.state.load();

    const result = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
      task: {
        blockedReason: string | null;
        blockedOnTaskIds: string[] | null;
        blockedFromStatus: string | null;
      };
    };
    expect(result.task.blockedReason).toBe('waiting on task-dep111');
    expect(result.task.blockedOnTaskIds).toEqual(['task-dep111']);
    expect(result.task.blockedFromStatus).toBe('WORKING');
  });
});

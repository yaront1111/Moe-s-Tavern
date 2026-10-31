import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolTestHarness } from './toolTestHarness.js';
import { getContextTool } from './getContext.js';
import { getTools } from './index.js';
import { updateEpicTool } from './updateEpic.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { createTaskTool } from './createTask.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { closeOpenAttempts, currentAttempt, openAttempt } from '../state/attemptStore.js';
import type { ExecutionPolicySnapshot } from '../types/schema.js';
import type { Task, TaskCommit, TaskVerification } from '../types/schema.js';

describe('moe.get_context workspace', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init(); h.setupMoeFolder(); h.createEpic(); h.createTask({ status: 'WORKING' });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function read(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return await getContextTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as Record<string, unknown>;
  }

  async function claim(): Promise<Record<string, unknown>> {
    return await claimNextTaskTool(h.state).handler(
      { statuses: ['WORKING'], workerId: 'worker-1' }, h.state) as Record<string, unknown>;
  }

  it.each([undefined, 'full'] as const)('returns the claim workspace with pinned mode (view %s)', async (view) => {
    await h.state.updateSettings({ worktreeMode: 'on', consolidationBranch: 'trunk' });
    const claimed = await claim();
    const attempt = currentAttempt(h.state, 'task-1')!;
    expect(attempt.workspace).toBe(path.join(h.state.projectPath, '.worktrees', 'task-1'));
    expect(attempt.workspace).not.toBe(h.state.projectPath);
    const ctx = await read({ view });
    expect(ctx.workspace).toStrictEqual(claimed.workspace);
    expect(ctx.workspace).toStrictEqual({ mode: 'worktree', path: attempt.workspace, branch: 'moe/task/task-1', target: 'trunk' });
    h.state.project!.settings.worktreeMode = 'off';
    expect((await read({ view })).workspace).toStrictEqual(claimed.workspace);
    // A hand-edited live mode must not be decoded by a read of the pinned attempt.
    Object.assign(h.state.project!.settings, { worktreeMode: 'invalid' });
    expect((await read({ view })).workspace).toStrictEqual(claimed.workspace);
  });

  it('returns the shared claim workspace when the setting is absent', async () => {
    const claimed = await claim();
    const ctx = await read();
    expect(ctx.workspace).toStrictEqual(claimed.workspace);
    expect(ctx.workspace).toStrictEqual({ mode: 'shared', path: h.state.projectPath, branch: null, target: null });
  });

  it('reads an attempt without workspaceMode as shared', async () => {
    await openAttempt(h.state, { taskId: 'task-1', workerId: 'worker-1', runnerId: 'worker-1', workspace: h.state.projectPath });
    expect((await read()).workspace).toStrictEqual({ mode: 'shared', path: h.state.projectPath, branch: null, target: null });
  });

  it('omits workspace before any claim', async () => {
    expect(await read()).not.toHaveProperty('workspace');
  });

  it('omits workspace when every attempt is closed', async () => {
    await claim();
    await closeOpenAttempts(h.state, 'task-1');
    expect(await read()).not.toHaveProperty('workspace');
  });

  it('omits workspace without a task', async () => {
    expect(await read({ taskId: undefined })).not.toHaveProperty('workspace');
  });

  it('omits workspace when copying a corrupt attempt overflows', async () => {
    const claimed = await claim();
    const attempt = h.state.attempts.get(String(claimed.attemptId))!;
    let snapshot: unknown = {};
    for (let i = 0; i < 20000; i++) snapshot = { nested: snapshot };
    attempt.executionPolicySnapshot = snapshot as ExecutionPolicySnapshot;
    const ctx = await read();
    expect(ctx).not.toHaveProperty('workspace');
    expect(ctx.servedContext).toMatchObject({ receiptStatus: 'identity-unreadable' });
  });
});

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

  it.each([undefined, 'status' as const])('rejects an unknown explicit taskId instead of answering with the caller task (view %s)', async (view) => {
    h.setupMoeFolder();
    h.createEpic();
    const held = 'task-67b4604f6c8b4a98ad9eee7b49d0c8f5';
    h.createWorker({ id: 'architect-own', currentTaskId: held });
    h.createTask({ id: held, status: 'PLANNING', assignedWorkerId: 'architect-own' });
    h.createTask({ id: 'task-4566537d0d264ddc91811889fe1ac636', status: 'WORKING' });
    await h.state.load();
    const tool = getContextTool(h.state);

    // A short prefix of a real id is not an id: it must not resolve to the
    // caller's own task, and must not stamp that task as context-fetched.
    await expect(tool.handler({ taskId: 'task-4566537d', workerId: 'architect-own', view }, h.state))
      .rejects.toThrow('Task not found: task-4566537d');
    expect(h.state.getTask(held)?.contextFetchedBy).toBeUndefined();
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

      const result = await getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'qa-ledger' }, h.state) as {
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

// ---------------------------------------------------------------------------
// Epic-final follows the epic's designated final task (Epic.finalTaskId), not
// the board position: `order` is a per-column sort position that drags,
// set_task_status moves and create_task rewrite. An epic with no valid
// designation falls back to the highest order, ties counting.
// ---------------------------------------------------------------------------
describe('moe.get_context isEpicFinal follows the designated final task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const read = async (taskId: string) => (await getContextTool(h.state).handler({ taskId }, h.state) as {
    task: { isEpicFinal: boolean };
  }).task.isEpicFinal;
  const finals = async (ids: string[]): Promise<Record<string, boolean>> => {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = await read(id);
    return out;
  };
  const designate = (finalTaskId: string, epicId = 'epic-1') =>
    updateEpicTool(h.state).handler({ epicId, finalTaskId }, h.state);
  const seedThree = async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-a', status: 'BACKLOG', order: 1 });
    h.createTask({ id: 'task-b', status: 'WORKING', order: 2 });
    h.createTask({ id: 'task-final', status: 'BACKLOG', order: 3 });
    await h.state.load();
  };
  const ROWS = ['task-a', 'task-b', 'task-final'];
  const ONLY_FINAL = { 'task-a': false, 'task-b': false, 'task-final': true };

  it('a designated final task stays epic-final across board drags, set_task_status moves and new rows', async () => {
    await seedThree();
    await designate('task-final');

    // (1) A JetBrains board drag: UPDATE_TASK {status, order} at the column end.
    await h.state.updateTask('task-b', { order: 3.5 });
    expect(await finals(ROWS)).toEqual(ONLY_FINAL);

    // (2) A set_task_status move, then the board's end-of-column order.
    await setTaskStatusTool(h.state).handler({ taskId: 'task-a', status: 'PLANNING' }, h.state);
    await h.state.updateTask('task-a', { order: 4.5 });
    expect(h.state.getTask('task-a')).toMatchObject({ status: 'PLANNING', order: 4.5 });
    expect(await finals(ROWS)).toEqual(ONLY_FINAL);

    // (3) REORDER_TASK to the end of a column.
    expect((await h.state.reorderTask('task-b', 'task-a', null)).order).toBe(5.5);
    expect(await finals(ROWS)).toEqual(ONLY_FINAL);

    // (4) create_task appends at the epic's max order + 1.
    const created = await createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'late bug row' }, h.state) as { task: Task };
    expect(created.task.order).toBe(6.5);
    expect(await finals([...ROWS, created.task.id])).toEqual({ ...ONLY_FINAL, [created.task.id]: false });
  });

  it('without a designation the same drag moves epic-final to the dragged row (the fallback drifts)', async () => {
    await seedThree();
    expect(await finals(ROWS)).toEqual(ONLY_FINAL);

    await h.state.updateTask('task-b', { order: 3.5 });

    expect(await finals(ROWS)).toEqual({ 'task-a': false, 'task-b': true, 'task-final': false });
  });

  it.each<[string, unknown]>([
    ['a missing task', 'task-gone'],
    ['a task of another epic', 'task-far'],
    ['an ARCHIVED task', 'task-zomb'],
    ['a hand-edited null', null],
    ['a hand-edited number', 42],
  ])('ignores a stored designation naming %s and falls back to the highest order, ties counting', async (_label, finalTaskId) => {
    h.setupMoeFolder();
    h.createEpic({ finalTaskId: finalTaskId as string });
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-low', order: 1 });
    h.createTask({ id: 'task-tie-a', order: 4 });
    h.createTask({ id: 'task-tie-b', order: 4 });
    h.createTask({ id: 'task-zomb', order: 9, status: 'ARCHIVED' });
    h.createTask({ id: 'task-far', epicId: 'epic-2', order: 0 });
    await h.state.load();

    expect(await finals(['task-low', 'task-tie-a', 'task-tie-b', 'task-zomb', 'task-far'])).toEqual({
      'task-low': false,
      'task-tie-a': true,
      'task-tie-b': true,
      // An ARCHIVED row is outside the max but still compares its own order.
      'task-zomb': true,
      'task-far': true,
    });
  });

  it('clearing the designation with update_epic "" restores the highest-order fallback', async () => {
    await seedThree();
    await designate('task-a');
    expect(await finals(ROWS)).toEqual({ 'task-a': true, 'task-b': false, 'task-final': false });

    await designate('');

    expect(h.state.getEpic('epic-1')?.finalTaskId).toBeUndefined();
    expect(await finals(ROWS)).toEqual(ONLY_FINAL);
  });

  it('projects epic.finalTaskId only when a task is designated', async () => {
    await seedThree();
    const epicOf = async () => (await getContextTool(h.state).handler({ taskId: 'task-a' }, h.state) as {
      epic: Record<string, unknown>;
    }).epic;

    expect(Object.prototype.hasOwnProperty.call(await epicOf(), 'finalTaskId')).toBe(false);
    await designate('task-final');
    expect((await epicOf()).finalTaskId).toBe('task-final');
  });

  // The six CQ epics' non-ARCHIVED rows on the 2026-10-26 board, as [label, order].
  // Drags and late bug rows had pushed the highest order past every hardening row
  // except I06 and M06, so the fallback flagged the wrong row in four epics.
  const CQ_EPICS: Array<{ epic: string; final: string; highest: string; rows: Array<[string, number]> }> = [
    { epic: 'CQ-F', final: 'F12', highest: 'bug-bc84', rows: [['F04', 40], ['F05', 50], ['F07', 70], ['F08', 80], ['F09', 90], ['F10', 100], ['F11', 110], ['F06', 221.5], ['F03', 225.5], ['bug-a982', 226.5], ['F04c', 230.1], ['F04d', 230.2], ['F04e', 230.3], ['F04b', 230.5], ['bug-aa79', 233.5], ['F12a', 234.2], ['F12b', 234.3], ['F12', 234.5], ['bug-bc84', 249.5]] },
    { epic: 'CQ-R', final: 'R13', highest: 'bug-6f50', rows: [['R03', 30], ['R04', 40], ['R05', 50], ['R06', 60], ['R07', 70], ['R09a', 85], ['R10', 100], ['R11', 110], ['R12', 120], ['R13', 130], ['R08a', 222.2], ['R08b', 222.3], ['R08c', 222.4], ['R08', 222.5], ['R01', 226.5], ['bug-ab6a', 227.5], ['bug-333f', 229.5], ['R09', 235.5], ['bug-6b60', 236.5], ['bug-c42d', 237.5], ['bug-d72f', 238.5], ['bug-6f50', 248.5]] },
    { epic: 'CQ-V', final: 'V12', highest: 'V06', rows: [['V07', 70], ['V08', 80], ['V09', 90], ['V10', 100], ['V11', 110], ['V12', 120], ['V02', 225.5], ['V03', 226.5], ['V01a', 227.3], ['V01b', 227.4], ['V01c', 227.45], ['V01', 227.5], ['V04', 242.5], ['V05', 243.5], ['V06', 244.5]] },
    { epic: 'CQ-C', final: 'C11', highest: 'C06', rows: [['C07', 70], ['C08', 80], ['C09', 90], ['C10', 100], ['C11', 110], ['C01', 221.5], ['C02', 222.5], ['C02b', 223.5], ['C03', 224.5], ['C04', 239.5], ['C05', 240.5], ['C06', 241.5]] },
    { epic: 'CQ-I', final: 'I06', highest: 'I06', rows: [['I02', 227.5], ['I03', 228.5], ['I01', 228.5], ['I04', 245.5], ['I05', 246.5], ['I06', 247.5]] },
    { epic: 'CQ-M', final: 'M06', highest: 'M06', rows: [['M03', 30], ['M04', 40], ['M01e', 217.5], ['M01f', 218.5], ['M01', 219.5], ['bug-9c86', 220.5], ['M04b', 223.5], ['M04c', 224.5], ['M05', 229.5], ['M06', 230.5]] },
  ];
  const cqEpicId = (epic: string) => `epic-${epic.toLowerCase()}`;
  const cqTaskId = (label: string) => `task-cq-${label.toLowerCase()}`;

  it('designated CQ hardening rows are epic-final and every sibling is not', async () => {
    h.setupMoeFolder();
    for (const cq of CQ_EPICS) {
      h.createEpic({ id: cqEpicId(cq.epic), title: cq.epic });
      for (const [label, order] of cq.rows) h.createTask({ id: cqTaskId(label), epicId: cqEpicId(cq.epic), order });
    }
    await h.state.load();

    for (const cq of CQ_EPICS) {
      // The bug: before a designation the highest-order row is final.
      expect(await read(cqTaskId(cq.highest)), `${cq.epic} ${cq.highest} before designation`).toBe(true);
      if (cq.highest !== cq.final) {
        expect(await read(cqTaskId(cq.final)), `${cq.epic} ${cq.final} before designation`).toBe(false);
      }

      await designate(cqTaskId(cq.final), cqEpicId(cq.epic));

      for (const [label] of cq.rows) {
        expect(await read(cqTaskId(label)), `${cq.epic} ${label}`).toBe(label === cq.final);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy verification provenance (task-95a1d08e). task.verification is the
// completing agent's own claim with no candidate or runner behind it, so both
// projections label it agent-reported: rows written before the label existed
// and labels hand-edited into a task file (runner-observed included) alike.
// The label goes on fresh copies at read time. The stored row is never
// rewritten, and a caller mutating the response cannot reach it.
// ---------------------------------------------------------------------------
describe('moe.get_context — legacy verification provenance', () => {
  const h = new ToolTestHarness();
  const REPORTED_AT = '2026-09-01T10:00:00.000Z';
  const PRIMARY = { command: 'npm test', exitCode: 0, outputTail: '12 passed', reportedAt: REPORTED_AT, source: 'agent-reported' };
  const COMPACT = { command: 'npm test', exitCode: 0, reportedAt: REPORTED_AT, source: 'agent-reported' };
  const LABELLED_PREREQUISITES = ['task-dep-legacy', 'task-dep-runner', 'task-dep-labelled', 'task-dep-null-label'];
  const EMPTY_PREREQUISITES = ['task-dep-null', 'task-dep-missing'];

  interface ProvenanceContext {
    task: {
      verification: Record<string, unknown> | null;
      epicSiblings: Array<{ id: string; declaredDependency?: boolean; verification?: Record<string, unknown> | null }>;
    };
  }

  beforeEach(() => {
    h.init();
    // Seats export MOE_WORKER_ID and get_context treats it as the caller, which
    // records contextFetchedBy and touches that worker. That bookkeeping has its
    // own tests; stubbing the caller away isolates the projection here.
    vi.stubEnv('MOE_WORKER_ID', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  /** A stored verification row, including labels the schema does not allow. */
  function stored(overrides: Record<string, unknown> = {}): TaskVerification {
    return { command: 'npm test', exitCode: 0, outputTail: '12 passed', reportedAt: REPORTED_AT, ...overrides } as unknown as TaskVerification;
  }

  /** task-1, one declared prerequisite per stored shape, and one ordinary lower-order sibling. */
  async function seed(primary: Partial<Task>): Promise<void> {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-plain', status: 'DONE', order: 1, verification: stored() });
    h.createTask({ id: 'task-dep-legacy', status: 'DONE', order: 2, verification: stored({ outputTail: 'prerequisite tail' }) });
    h.createTask({ id: 'task-dep-labelled', status: 'DONE', order: 3, verification: stored({ source: 'agent-reported' }) });
    h.createTask({ id: 'task-dep-null-label', status: 'REVIEW', order: 4, verification: stored({ source: null }) });
    h.createTask({ id: 'task-dep-null', status: 'WORKING', order: 6, verification: null as unknown as TaskVerification });
    h.createTask({ id: 'task-dep-missing', status: 'WORKING', order: 7 });
    h.createTask({ id: 'task-dep-runner', status: 'DONE', order: 9, verification: stored({ source: 'runner-observed' }) });
    h.createTask({
      id: 'task-1',
      status: 'REVIEW',
      order: 5,
      dependsOn: ['task-dep-legacy', 'task-dep-runner', 'task-dep-null'],
      blockedOnTaskIds: ['task-dep-labelled', 'task-dep-null-label', 'task-dep-missing'],
      ...primary,
    });
    await h.state.load();
  }

  async function read(): Promise<ProvenanceContext> {
    return await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as ProvenanceContext;
  }

  // Stored primary rows by source label: none at all (the legacy rows the label
  // exists for), the label itself, and labels hand-edited into a task file.
  const STORED_PRIMARY_LABELS: Array<[string, Record<string, unknown>]> = [
    ['a row written before the label existed', {}],
    ['a row already labelled agent-reported', { source: 'agent-reported' }],
    ['a hand-edited runner-observed label', { source: 'runner-observed' }],
    ['a null label', { source: null }],
  ];

  it.each(STORED_PRIMARY_LABELS)('labels the primary verification agent-reported for %s', async (_label, label) => {
    await seed({ verification: stored(label) });

    const result = await read();

    expect(result.task.verification?.source).toBe('agent-reported');
    expect(result.task.verification).toStrictEqual(PRIMARY);
  });

  it('adds no outputTail to a primary row stored without one', async () => {
    await seed({ verification: stored({ outputTail: undefined }) });

    expect((await read()).task.verification).toStrictEqual({
      command: 'npm test', exitCode: 0, reportedAt: REPORTED_AT, source: 'agent-reported',
    });
  });

  it.each([
    ['missing', {}],
    ['null', { verification: null as unknown as TaskVerification }],
  ])('keeps a %s primary verification null instead of fabricating one', async (_label, primary) => {
    await seed(primary);

    expect((await read()).task.verification).toBeNull();
  });

  it('labels declared prerequisites agent-reported without outputTail and leaves ordinary siblings bare', async () => {
    await seed({ verification: stored() });

    const result = await read();
    const siblings = new Map(result.task.epicSiblings.map((s) => [s.id, s]));

    for (const id of LABELLED_PREREQUISITES) {
      expect(siblings.get(id)?.declaredDependency, id).toBe(true);
      expect(siblings.get(id)?.verification?.source, id).toBe('agent-reported');
      expect(siblings.get(id)?.verification, id).toStrictEqual(COMPACT);
    }
    for (const id of EMPTY_PREREQUISITES) {
      expect(siblings.get(id)?.declaredDependency, id).toBe(true);
      expect(siblings.get(id)?.verification, id).toBeNull();
    }
    expect(siblings.has('task-plain')).toBe(true);
    expect(siblings.get('task-plain')).not.toHaveProperty('declaredDependency');
    expect(siblings.get('task-plain')).not.toHaveProperty('verification');
    // No candidate was ever recorded, so none is projected either.
    expect(result).not.toHaveProperty('currentCandidate');
  });

  it.each(STORED_PRIMARY_LABELS)('never rewrites or aliases the stored rows it labels, across repeated reads, for %s', async (_label, label) => {
    await seed({ verification: stored(label) });
    const taskDir = path.join(h.moePath, 'tasks');
    const rows = () => new Map(fs.readdirSync(taskDir).map((file) => [file, fs.readFileSync(path.join(taskDir, file), 'utf8')]));
    const ids = ['task-1', ...LABELLED_PREREQUISITES, ...EMPTY_PREREQUISITES];
    const storedRows = () => ids.map((id) => h.state.getTask(id)?.verification);
    const rowsBefore = rows();
    const storedBefore = structuredClone(storedRows());
    // The primary is loaded in exactly the shape under test: a legacy row has no source key at all.
    expect(storedBefore[0]).toStrictEqual(stored(label));
    const updateTask = vi.spyOn(h.state, 'updateTask');
    const touchWorker = vi.spyOn(h.state, 'touchWorker');

    const first = await read();
    expect(first.task.verification).toStrictEqual(PRIMARY);
    expect(first.task.verification).not.toBe(h.state.getTask('task-1')!.verification);
    // Tamper with every labelled object this caller was handed.
    Object.assign(first.task.verification!, { source: 'runner-observed', command: 'tampered' });
    for (const sibling of first.task.epicSiblings) {
      if (sibling.verification) Object.assign(sibling.verification, { source: 'runner-observed', command: 'tampered' });
    }
    const second = await read();

    expect(second.task.verification).toStrictEqual(PRIMARY);
    expect(second.task.verification).not.toBe(h.state.getTask('task-1')!.verification);
    expect(second.task.epicSiblings.find((s) => s.id === 'task-dep-runner')?.verification).toStrictEqual(COMPACT);
    expect(h.state.getTask('task-1')!.verification).toStrictEqual(stored(label));
    expect(storedRows()).toStrictEqual(storedBefore);
    expect(rows()).toStrictEqual(rowsBefore);
    expect(updateTask).not.toHaveBeenCalled();
    expect(touchWorker).not.toHaveBeenCalled();
    expect(h.state.getTask('task-1')!.contextFetchedBy).toBeUndefined();
  });
});

describe('moe.get_context role trim', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function setup() {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-a', title: 'A', status: 'DONE', order: 1 });
    h.createTask({ id: 'task-1', status: 'REVIEW', order: 2, planningNotes: { risks: 'r' } } as Partial<Task>);
    await h.state.load();
  }
  const call = (args: Record<string, unknown>) =>
    getContextTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as Promise<Record<string, any>>;
  // nextAction is derived from the caller's role by design; everything else must match.
  const withoutNextAction = ({ nextAction: _n, ...rest }: Record<string, any>) => rest;

  it('drops epicSiblings and planningNotes for a qa caller by default and says so', async () => {
    await setup();
    const r = await call({ workerId: 'qa-1' });
    expect(r.task.epicSiblings).toBeUndefined();
    expect(r).not.toHaveProperty('planningNotes');
    expect(r.omitted).toEqual(['task.epicSiblings', 'planningNotes', 'routing']);
    // Names the escape hatch without inviting it: the trimmed read is the complete one for the role.
    expect(r.omittedHint).toContain('view:"full"');
    expect(r.omittedHint).toContain('only if you need');
  });

  // qa.md said "Audit task.commits from full get_context", written when `full`
  // was the default view. Agents took it literally once view:"full" came to
  // mean untrimmed: measured on a live fleet 2026-09-30, QA passed it on 19 of
  // 23 context reads. view:"full" itself stays a legal phrase (the escape hatch).
  it('no role doc or tool description says "full context" for the normal read', () => {
    const FULL_READ = /full[- ](?:task )?context|full `?get_context/i;
    // src/tools -> src -> moe-daemon -> packages -> repo root
    const rolesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'roles');
    const docs = fs.readdirSync(rolesDir).filter((file) => file.endsWith('.md'));
    // A scan that finds no docs would pass vacuously.
    expect(docs).toEqual(expect.arrayContaining(['qa.md', 'worker.md', 'architect.md', 'governor.md']));

    const docHits = docs.flatMap((file) =>
      fs.readFileSync(path.join(rolesDir, file), 'utf-8').split(/\r?\n/)
        .flatMap((line, i) => (FULL_READ.test(line) ? [`${file}:${i + 1}`] : [])));
    const toolHits = getTools(h.state)
      .filter((tool) => FULL_READ.test(tool.description) || FULL_READ.test(JSON.stringify(tool.inputSchema)))
      .map((tool) => tool.name);

    expect([...docHits, ...toolHits]).toEqual([]);
  });

  it('view:"full" returns the untrimmed payload for a qa caller', async () => {
    await setup();
    const r = await call({ workerId: 'qa-1', view: 'full' });
    expect(r.task.epicSiblings.map((s: { id: string }) => s.id)).toEqual(['task-a']);
    expect(r.planningNotes).toEqual({ risks: 'r' });
    expect(r).not.toHaveProperty('omitted');
  });

  it('a worker-role caller with view:"full" gets the same payload as an unknown-role caller', async () => {
    await setup();
    const worker = await call({ workerId: 'worker-1', view: 'full' });
    const unknown = await call({ workerId: 'human-1' });
    expect(withoutNextAction(worker)).toEqual(withoutNextAction(unknown));
    expect(worker.task.epicSiblings).toHaveLength(1);
  });

  it('shows the routing catalog to an architect, not to a worker by default', async () => {
    await setup();
    const architect = await call({ workerId: 'architect-1' });
    expect(architect.routing.models.claude.map((m: { id: string }) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(architect.routing.models.codex[0].id).toBe('gpt-6-astra');
    expect(architect.routing.efforts).toEqual(['high', 'xhigh', 'max']);
    expect(architect.routing.tierDefaults.heavy).toEqual({
      effort: 'max', effortFloor: 'xhigh', models: { claude: ['claude-opus-5-5'], codex: ['gpt-6-astra'] },
    });
    const worker = await call({ workerId: 'worker-1' });
    expect(worker).not.toHaveProperty('routing');
    expect(worker.omitted).toEqual(['routing']);
    expect((await call({ workerId: 'worker-1', view: 'full' })).routing).toBeDefined();
  });
});

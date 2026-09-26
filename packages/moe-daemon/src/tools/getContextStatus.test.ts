import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, Task, TaskCommit } from '../types/schema.js';
import { getContextTool } from './getContext.js';
import { startStepTool } from './startStep.js';
import { ToolTestHarness } from './toolTestHarness.js';

type StatusContext = {
  contextScope: string;
  requiresFullContext: boolean;
  task: {
    id: string;
    status: Task['status'];
    assignedWorkerId: string | null;
    reopenCount: number;
    updatedAt: string;
    reviewStartedAt: string | null;
    commits: Array<Pick<TaskCommit, 'sha' | 'kind' | 'ref' | 'pushed' | 'recordedAt'>>;
    commitCount: number;
    lastCommitOutcome: Task['lastCommitOutcome'] | null;
  } | null;
  currentCandidate?: Candidate;
  nextAction: { tool: string; args: Record<string, unknown>; reason: string };
};

describe('moe.get_context status polling', () => {
  const h = new ToolTestHarness();
  beforeEach(() => {
    h.init();
    vi.stubEnv('MOE_TASK_ID', '');
    vi.stubEnv('MOE_WORKER_ID', '');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  async function load(overrides: Partial<Task> = {}) {
    h.setupMoeFolder();
    h.createEpic({ epicRails: ['Preserve the epic contract'] });
    h.createWorker({ id: 'worker-status', currentTaskId: 'task-1' });
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-status', taskRails: ['Preserve task assertions'],
      implementationPlan: [{ stepId: 'step-1', description: 'Implement the approved behavior', status: 'PENDING' }],
      ...overrides,
    });
    await h.state.load();
  }

  async function status(args: Record<string, unknown> = {}) {
    return await getContextTool(h.state).handler({ taskId: 'task-1', view: 'status', ...args }, h.state) as StatusContext;
  }

  function commit(index: number): TaskCommit {
    return {
      sha: index.toString(16).padStart(40, '0'), treeId: 'a'.repeat(40), ref: 'moe/work-test',
      kind: 'completion', role: 'worker', sessionId: 'worker-status@session', paths: ['file.ts'],
      pushed: index % 2 === 0, recordedBy: 'worker-status', recordedAt: `2026-09-26T12:00:${String(index).padStart(2, '0')}Z`,
    };
  }

  it('returns delivery identities with an explicit full-context requirement', async () => {
    const lastCommitOutcome = { outcome: 'committed' as const, kind: 'completion' as const, sessionId: 's1', at: '2026-09-26T12:00:00Z' };
    await load({ status: 'REVIEW', reopenCount: 2, commits: [commit(1)], lastCommitOutcome });
    const result = await status({ workerId: 'worker-status' });

    expect(result).toMatchObject({
      contextScope: 'status', requiresFullContext: true,
      task: { id: 'task-1', status: 'REVIEW', assignedWorkerId: 'worker-status', reopenCount: 2, commitCount: 1, lastCommitOutcome },
      nextAction: { tool: 'moe.get_context', args: { taskId: 'task-1', workerId: 'worker-status', view: 'full' } },
    });
    expect(result.nextAction.reason).toMatch(/before.*reviewing|before.*acting/i);
    expect(result.task!.commits[0]).toMatchObject({ sha: commit(1).sha, treeId: 'a'.repeat(40), kind: 'completion', pushed: false });
    expect(result).not.toHaveProperty('project');
    expect(result).not.toHaveProperty('allRails');
    expect(result.task).not.toHaveProperty('implementationPlan');
    expect(result.task!.commits[0]).not.toHaveProperty('paths');
  });

  it('does not mutate state or satisfy the full-context prerequisite for execution', async () => {
    await load();
    const beforeTask = structuredClone(h.state.getTask('task-1'));
    const beforeWorker = structuredClone(h.state.getWorker('worker-status'));
    const update = vi.spyOn(h.state, 'updateTask');
    const touch = vi.spyOn(h.state, 'touchWorker');

    await status({ workerId: 'worker-status' });

    expect(update).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(h.state.getTask('task-1')).toEqual(beforeTask);
    expect(h.state.getWorker('worker-status')).toEqual(beforeWorker);
    await expect(startStepTool(h.state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-status' }, h.state))
      .rejects.toThrow(/get_context/);
    await getContextTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-status', view: 'full' }, h.state);
    await expect(startStepTool(h.state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-status' }, h.state))
      .resolves.toMatchObject({ success: true });
  });

  it('returns newly arrived commits and bounds the ledger without hiding its count', async () => {
    await load();
    expect((await status()).task).toMatchObject({ commits: [], commitCount: 0 });
    await h.state.updateTask('task-1', { status: 'REVIEW', commits: Array.from({ length: 25 }, (_, i) => commit(i)) });
    const result = await status();
    expect(result.task).toMatchObject({ status: 'REVIEW', commitCount: 25 });
    expect(result.task!.commits).toHaveLength(20);
    expect(result.task!.commits[0].sha).toBe(commit(5).sha);
    expect(result.task!.commits.at(-1)!.sha).toBe(commit(24).sha);
  });

  it('uses the same newest candidate as full context and never aliases stored data', async () => {
    await load();
    const base: Candidate = {
      id: 'candidate-a', attemptId: 'attempt-a', taskId: 'task-1', baseRevision: 'b'.repeat(40),
      treeSha: 'c'.repeat(40), deliveryTarget: 'refs/heads/test', createdAt: '2026-09-26T12:00:00Z',
    };
    h.state.candidates.set('candidate-z', { ...base, id: 'candidate-z', treeSha: 'd'.repeat(40) });
    h.state.candidates.set(base.id, base);
    const result = await status();
    const full = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as { currentCandidate: Candidate };
    expect(result.currentCandidate).toEqual(full.currentCandidate);
    expect(result.currentCandidate!.id).toBe('candidate-z');
    expect(result.currentCandidate).not.toBe(h.state.candidates.get('candidate-z'));
  });

  it('preserves complete default context when full is explicitly selected', async () => {
    await load();
    const tool = getContextTool(h.state);
    const original = await tool.handler({ taskId: 'task-1' }, h.state);
    const explicit = await tool.handler({ taskId: 'task-1', view: 'full' }, h.state);
    expect(explicit).toEqual(original);
    expect(explicit).toMatchObject({
      allRails: { epic: ['Preserve the epic contract'], task: ['Preserve task assertions'] },
      task: { definitionOfDone: ['Tests pass', 'Code reviewed'], implementationPlan: [{ description: 'Implement the approved behavior' }] },
    });
    expect(explicit).not.toHaveProperty('contextScope');
  });

  it.each(['summary', '', null, 7, true, {}])('rejects invalid view %j', async (view) => {
    await load();
    await expect(status({ view })).rejects.toThrow(/view/);
    expect(h.state.getTask('task-1')!.contextFetchedBy).toBeUndefined();
  });

  it.each([{ commentsLimit: 'bad' }, { commentsMaxChars: NaN }])('still validates comment options in status mode: %j', async (args) => {
    await load();
    await expect(status(args)).rejects.toThrow(/must be a finite number/);
  });

  it('resolves the caller task through the existing environment fallback', async () => {
    await load();
    vi.stubEnv('MOE_WORKER_ID', 'worker-status');
    const result = await getContextTool(h.state).handler({ view: 'status' }, h.state) as StatusContext;
    expect(result.task!.id).toBe('task-1');
    expect(result.nextAction.args).toEqual({ taskId: 'task-1', workerId: 'worker-status', view: 'full' });
    expect(h.state.getTask('task-1')!.contextFetchedBy).toBeUndefined();
  });

  it('handles a taskless status query without implying complete context', async () => {
    h.setupMoeFolder();
    await h.state.load();
    const result = await status();
    expect(result).toMatchObject({ contextScope: 'status', requiresFullContext: true, task: null });
    expect(result).not.toHaveProperty('currentCandidate');
    expect(result.nextAction).toMatchObject({ tool: 'moe.get_context', args: { view: 'full' } });
  });
});

import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';
import { listCandidatesForTask } from '../state/candidateStore.js';

/** Delivery polling identities only; a recorded commit is not approval evidence. */
function taskStatus(task: Task) {
  const commits = Array.isArray(task.commits)
    ? task.commits.filter(commit => commit && typeof commit.sha === 'string')
    : [];
  return {
    id: task.id,
    status: task.status,
    assignedWorkerId: task.assignedWorkerId,
    reopenCount: task.reopenCount,
    updatedAt: task.updatedAt,
    reviewStartedAt: task.reviewStartedAt ?? null,
    commits: commits.slice(-20).map(commit => ({
      sha: commit.sha,
      treeId: commit.treeId ?? null,
      ref: commit.ref,
      kind: commit.kind,
      status: commit.status ?? null,
      pushed: commit.pushed ?? null,
      recordedAt: commit.recordedAt,
    })),
    commitCount: commits.length,
    lastCommitOutcome: task.lastCommitOutcome ? { ...task.lastCommitOutcome } : null,
  };
}

/** Never marks full context fetched or returns an action that assumes it was. */
export function contextStatus(state: StateManager, task: Task | null | undefined, workerId: string) {
  const candidates = task ? listCandidatesForTask(state, task.id) : [];
  const currentCandidate = candidates[candidates.length - 1];
  return {
    contextScope: 'status',
    requiresFullContext: true,
    task: task ? taskStatus(task) : null,
    ...(currentCandidate ? { currentCandidate } : {}),
    nextAction: {
      tool: 'moe.get_context',
      args: {
        ...(task ? { taskId: task.id } : {}),
        ...(workerId ? { workerId } : {}),
        view: 'full',
      },
      reason: 'Status polling omits rails, DoD, plan, amendments and verification. Bounded status polling may continue while waiting; fetch full context when the wait ends or status/ownership changes, before reviewing or acting beyond polling. Commit and candidate identities alone do not prove delivery or approval.',
    },
  };
}

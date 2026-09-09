import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';
import { recommendSkillFor } from './recommendSkill.js';
import { resolveWorkerRole } from './workerRole.js';

/** Reading a peer's task is oversight, not a claim or a change of role. */
export function contextNextAction(state: StateManager, task: Task | null, workerId: string) {
  if (resolveWorkerRole(state, workerId) === 'governor') {
    const watchedNames = new Set(['general', 'architects', 'workers', 'qa', 'governors']);
    const channels = [...state.channels.values()]
      .filter(channel => watchedNames.has(channel.name))
      .map(channel => channel.id);
    return {
      tool: 'moe.chat_wait',
      args: { workerId, channels: channels.length ? channels : undefined, timeoutMs: 300000 },
      reason: 'Continue governance: triage signals and reply to mentions; inspecting a task does not claim it or authorize planning, implementation, or a QA verdict.',
    };
  }
  if (!task) return undefined;

  if (task.status === 'PLANNING') {
    return {
      tool: 'moe.submit_plan',
      args: { taskId: task.id, workerId: workerId || undefined },
      reason: 'Plan this task and submit for approval.',
      recommendedSkill: recommendSkillFor('architect', 'planning_entry'),
    };
  }
  if (task.status === 'WORKING') {
    const nextStep = (task.implementationPlan || []).find(s => s.status === 'PENDING' || s.status === 'IN_PROGRESS');
    const reopenedSkill = (task.reopenCount || 0) > 0
      ? recommendSkillFor('worker', 'reopened')
      : undefined;
    if (nextStep) {
      const isFirstStep = (task.implementationPlan || []).every(
        s => s.status === 'PENDING' || s.stepId === nextStep.stepId,
      );
      return {
        tool: 'moe.start_step',
        args: { taskId: task.id, stepId: nextStep.stepId, workerId: workerId || undefined },
        reason: `Begin step: ${nextStep.description.slice(0, 80)}`,
        recommendedSkill: reopenedSkill
          ?? (isFirstStep ? recommendSkillFor('worker', 'first_start_step') : undefined),
      };
    }
    return {
      tool: 'moe.complete_task',
      args: { taskId: task.id, workerId: workerId || undefined },
      reason: 'All steps complete; hand task off to QA.',
      // QA may reject without resetting steps; retain the rejection-reading hint.
      recommendedSkill: reopenedSkill ?? recommendSkillFor('worker', 'before_complete_task'),
    };
  }
  if (task.status === 'REVIEW') {
    return {
      tool: 'moe.qa_approve',
      args: { taskId: task.id, workerId: workerId || undefined },
      reason: 'Verify DoD + rails; re-run the verification command from task.verification yourself; confirm a completion commit is recorded in task.commits (`git show <sha>`) before approving; approve or moe.qa_reject with actionable issues.',
      recommendedSkill: recommendSkillFor('qa', 'review_entry'),
    };
  }
  return undefined;
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskCommit } from '../types/schema.js';
import { missingRequired, notFound, invalidState, invalidInput } from '../util/errors.js';
import { assertWorkerOwns, assertContextFetched } from '../util/enforcement.js';
import { listAttempts } from '../state/attemptStore.js';
import { attemptFinalizingRefusal } from '../util/claimGuards.js';
import { recordReview, resolveReviewedCandidate } from '../state/reviewStore.js';

/** Upper bound on the approval summary — mirrors qa_reject's reason cap. */
const MAX_SUMMARY_CHARS = 2000;

/** Compact commit projection returned as approval evidence. */
function commitEvidenceEntry(c: TaskCommit) {
  return { sha: c.sha, ref: c.ref, pushed: c.pushed ?? null, recordedAt: c.recordedAt };
}

export function qaApproveTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_approve',
    description: 'QA approves a task in REVIEW status, moving it to DONE. Requires a summary of what was verified. HARD candidate gate: pass candidateId (from get_context.currentCandidate) — if it is not the task\'s current candidate the approval is refused with CANDIDATE_MISMATCH so an approval can never bless bytes nobody read. Soft commit gate: when settings.autoCommit is on and no completion commit is recorded in task.commits after reviewStartedAt, the approval still lands but the response carries a NO-COMPLETION-COMMIT warning (also posted to #governors) — audit task.commits with `git show <sha>` before approving.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to approve' },
        summary: { type: 'string', description: 'What was verified: commands re-run, DoD items checked, diff size. Required — an approval without evidence is a rubber stamp.' },
        candidateId: { type: 'string', description: 'The candidate you actually reviewed (get_context.currentCandidate.id). Refused with CANDIDATE_MISMATCH if the task has moved on to a different candidate. Optional only for projects that record no candidates; omitting it on a task that has one approves with a warning.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'summary'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; summary?: string; candidateId?: string; workerId?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      if (task.status !== 'REVIEW') {
        throw invalidState('Task', task.status, 'REVIEW');
      }

      // The artifact boundary. complete_task hands the task to QA but leaves its
      // attempt open in `finalizing`, because the wrapper only lands the bytes
      // after the CLI exits — so an approval arriving in the same second would
      // drive DONE over work that has not landed anywhere. Refuse until
      // moe.finalize_attempt closes it.
      //
      // Scoped by TASK, never by worker: the IDE/human approval path carries no
      // workerId at all (and the WORKING->REVIEW handoff already cleared
      // assignedWorkerId), so a worker-scoped lookup would leave exactly the
      // fast-QA race open on the one path that matters most.
      //
      // Fires HERE, before every mutation, every touchWorker and every chat
      // side effect, so a refused approval moves not one byte.
      const finalizing = listAttempts(state, task.id).find((a) => a.phase === 'finalizing');
      if (finalizing) {
        throw attemptFinalizingRefusal({
          attemptId: finalizing.id,
          generation: finalizing.generation,
          taskId: finalizing.taskId,
          workerId: finalizing.workerId,
        });
      }

      assertWorkerOwns(task, params.workerId);
      // QA must read the task (DoD + rails + diff) before signing off. This is
      // the last gate — approving blind is the highest-impact way to skip the
      // review workflow. No-ops on the human path (assignedWorkerId null).
      assertContextFetched(task, params.workerId, 'qa_approve');
      // Symmetric with qa_reject's required `reason`: an approval must say what
      // was actually verified (commands re-run, DoD items checked) so DONE
      // tasks carry an audit trail instead of a rubber stamp. Checked after the
      // ownership/context guards so those errors keep precedence.
      if (typeof params.summary !== 'string' || params.summary.trim().length === 0) {
        throw missingRequired('summary');
      }
      if (params.summary.length > MAX_SUMMARY_CHARS) {
        throw invalidInput('summary', `too long (max ${MAX_SUMMARY_CHARS} chars)`);
      }
      const reviewSummary = params.summary.trim();
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      // THE HARD GATE. An approval must apply to the bytes the reviewer read, so
      // the candidate they name is checked against the task's CURRENT candidate
      // and a mismatch is refused outright (CANDIDATE_MISMATCH). Placed after the
      // read/summary guards so those keep their precedence, but still before the
      // Review write, the updateTask, the touchWorker and every chat side effect
      // — a refused approval moves not one byte, and leaves .moe/reviews empty.
      //
      // A task with no candidate at all resolves to no binding and behaves
      // exactly as it did before this gate existed: adoption is incremental.
      const binding = resolveReviewedCandidate(state, task.id, params.candidateId, 'qa_approve');

      // Soft commit gate. A completion commit counts only when recorded at or
      // after reviewStartedAt (stamped by complete_task, cleared by reopen), so
      // a stale attempt-#1 commit can never satisfy attempt #2. Warn-only: the
      // wrapper lands the commit seconds AFTER complete_task, so a fast QA in
      // SPEED/TURBO can legitimately arrive first; blocking here would wedge
      // every approval on a race. Both ISO strings come from toISOString(), so
      // the lexicographic compare is exact.
      const commits: TaskCommit[] = Array.isArray(task.commits) ? task.commits : [];
      const reviewStartedAt = task.reviewStartedAt;
      const completionCommits = commits.filter(
        (c) => c.kind === 'completion' && (!reviewStartedAt || c.recordedAt >= reviewStartedAt)
      );
      const checkpointCommits = commits.filter((c) => c.kind === 'checkpoint');
      const rescueCommits = commits.filter((c) => c.kind === 'rescue');
      const autoCommitOn = state.project?.settings?.autoCommit !== false;
      const warning = completionCommits.length === 0 && autoCommitOn
        ? `NO-COMPLETION-COMMIT: task ${task.id} has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging`
        : undefined;
      // The array collects every soft signal; `warning`, the singular key, stays
      // the commit-evidence one it has always been, and so does `message`.
      const warnings = [
        ...(warning ? [warning] : []),
        ...(binding.warning ? [binding.warning] : []),
      ];

      // Capture metrics: doneAt + wallClockMs (first claim → DONE). If no
      // firstClaimAt was recorded (legacy task), wallClockMs stays undefined.
      const nowIso = new Date().toISOString();
      const priorMetrics = task.metrics ?? {};
      const nextMetrics: typeof priorMetrics = { ...priorMetrics, doneAt: nowIso };
      if (priorMetrics.firstClaimAt) {
        const start = Date.parse(priorMetrics.firstClaimAt);
        const end = Date.parse(nowIso);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          nextMetrics.wallClockMs = end - start;
        }
      }

      // Persist the binding BEFORE the status flip, and only once the candidate
      // check has passed. A DONE task with no Review is the exact hole this gate
      // closes; a Review whose later status write failed is merely a truthful
      // record that the decision was made. The write is awaited and never
      // swallowed — if it fails, the approval fails with it and nothing is DONE.
      if (binding.candidateId) {
        await recordReview(state, {
          taskId: task.id,
          candidateId: binding.candidateId,
          reviewerId: params.workerId || 'human',
          decision: 'approve',
          summary: reviewSummary,
        });
      }

      const updated = await state.updateTask(
        params.taskId,
        // completedAt now means "task finished" — stamped here at DONE, the only
        // true completion point (reviewCompletedAt/metrics.doneAt mark the same
        // moment for review-timing/metrics). Clear the escalation latches so a
        // future reopen of this task starts from a clean budget.
        {
          status: 'DONE',
          completedAt: nowIso,
          reviewCompletedAt: nowIso,
          reviewSummary,
          metrics: nextMetrics,
          needsHumanReview: undefined,
          critiqueBlockCount: undefined,
        },
        'QA_APPROVED'
      );

      // Use the captured assignee because updateTask clears assignedWorkerId on
      // REVIEW -> DONE handoff. touchWorker skips missing worker records.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      // Post system message to task channel
      try {
        await state.postSystemMessage(params.taskId, 'QA approved — task complete');
      } catch { /* never block tool */ }

      // After the DONE write has landed: the approval is never held hostage to
      // chat, and a governor sees the gap even if QA ignores the response.
      if (warning) {
        try {
          await state.postToRoleChannel('governors', `⚠️ ${warning}`);
        } catch { /* never block tool */ }
      }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        summary: reviewSummary,
        ...(warning ? { warning } : {}),
        warnings,
        commitEvidence: {
          completion: completionCommits.map(commitEvidenceEntry),
          checkpoint: checkpointCommits.map(commitEvidenceEntry),
          rescue: rescueCommits.map(commitEvidenceEntry),
        },
        message: `Task ${updated.id} approved and moved to DONE${warning ? ' (WARNING: no completion commit recorded — see warnings)' : ''}`,
        nextAction: {
          tool: 'moe.wait_for_task',
          args: {
            statuses: ['REVIEW'],
            workerId: params.workerId,
          },
          reason: 'Task approved. If the review surfaced a reusable pattern, record it with Serena write_memory (pattern-<area>), then block until the next REVIEW task arrives.'
        }
      };
    }
  };
}

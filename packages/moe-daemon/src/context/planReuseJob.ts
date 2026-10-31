/**
 * Approved-plan reuse job (CQ-C07): the only writer of plan-reuse decisions. A PLANNING row whose current approved
 * plan awaits its source assessment is assessed outside the state mutex (CQ-C07b), then, under the lock and only if
 * the row is unchanged, resumed to WORKING on reuse or refresh, or recorded for an architect on reassess. The resume
 * reuses the existing approval of exactly this revision; it never creates or changes one. Started only from the
 * claim pool and wait matcher (awaitingPlanReuse): no timer, queue or scheduler.
 */
import type { StateManager } from '../state/StateManager.js';
import type { PlanReuseRecord, Task } from '../types/schema.js';
import { listCandidatesForTask } from '../state/candidateStore.js';
import { updateTask } from '../state/taskStore.js';
import { MoeError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { assessPlanSource, decidePlanReuse, planReuseView, planSourcePaths } from './planReuse.js';
import type { PlanReuseResult, PlanSourcePaths } from './planReuse.js';
import { readPlanningEntry, readPlanReuseRecord, readPlanSourceBasis } from './planReuseState.js';

interface Snapshot {
  taskId: string;
  planRevision: number;
  approvedPlanRevision: number | undefined;
  entrySeq: number;
  basisCommit: string;
  paths: PlanSourcePaths;
  candidate?: { baseRevision: string; deliveryTarget: string };
}

const jobsByState = new WeakMap<StateManager, Map<string, Promise<void>>>();
const revisionOf = (task: Task) => task.planRevision ?? 0;
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 200);

/** The planReuse value claim_next_task and get_context serve: the current record, else the live view, else null. */
export function planReuseContext(task: Task): PlanReuseRecord | NonNullable<ReturnType<typeof planReuseView>> | null {
  const view = planReuseView(task);
  if (!view) return null;
  const record = readPlanReuseRecord(task);
  const current = record && record.planRevision === revisionOf(task)
    && (task.status !== 'PLANNING' || record.entrySeq === readPlanningEntry(task)?.seq);
  return current ? record : view;
}

/**
 * True for an unassigned PLANNING row whose approved plan awaits its assessment: claim_next_task's pool and
 * wait_for_task's matcher withhold it from planners. A side-effecting filter by design: evaluating such a row starts
 * its assessment (deduped), which is the ONE trigger, so no timer, queue or scheduler exists (epic rail).
 */
export function awaitingPlanReuse(state: StateManager, task: Task): boolean {
  if (task.status !== 'PLANNING' || task.assignedWorkerId || planReuseView(task)?.decision !== 'pending') return false;
  ensurePlanReuseAssessment(state, task);
  return true;
}

/** Start the row's assessment unless one is already running or the row is not pending. Never throws. */
export function ensurePlanReuseAssessment(state: StateManager, task: Task): void {
  try {
    const jobs = jobsByState.get(state) ?? new Map<string, Promise<void>>();
    jobsByState.set(state, jobs);
    const basisCommit = readPlanSourceBasis(task)?.commit; const entrySeq = readPlanningEntry(task)?.seq;
    if (jobs.has(task.id) || planReuseView(task)?.decision !== 'pending' || !basisCommit || entrySeq === undefined) return;
    const current = listCandidatesForTask(state, task.id).at(-1);
    // Taken synchronously, under the caller's lock, and detached from the live row.
    const snap: Snapshot = structuredClone({ taskId: task.id, planRevision: revisionOf(task),
      approvedPlanRevision: task.approvedPlanRevision, entrySeq, basisCommit, paths: planSourcePaths(task),
      ...(current ? { candidate: { baseRevision: current.baseRevision, deliveryTarget: current.deliveryTarget } } : {}) });
    // Mandatory detach: claim_next_task runs inside the lock's async context (it is not blocking), so a job
    // started there would see its later runExclusive as reentrant and write without the lock.
    const job: Promise<void> = state.detachFromMutexContext(() => assess(state, snap))
      .finally(() => { if (jobs.get(snap.taskId) === job) jobs.delete(snap.taskId); });
    jobs.set(snap.taskId, job);
  } catch (error) {
    logger.warn({ taskId: task.id, error: firstLine(error) }, 'Plan reuse: could not start the assessment');
  }
}

/** Resolves once every assessment running for this state has finished (tests). */
export async function settlePlanReuseAssessments(state: StateManager): Promise<void> {
  const jobs = jobsByState.get(state);
  while (jobs && jobs.size > 0) await Promise.all(jobs.values());
}

async function assess(state: StateManager, snap: Snapshot): Promise<void> {
  let result: PlanReuseResult;
  try {
    const { basisCommit, paths, candidate } = snap;
    result = decidePlanReuse(paths, await assessPlanSource(state.projectPath, { basisCommit, paths, candidate }));
  } catch (error) {
    // A row must never stay pending because its job failed.
    result = { decision: 'reassess', reasons: [`assessment-failed: ${firstLine(error)}`], changedPaths: [] };
  }
  const record: PlanReuseRecord = { version: 1, decision: result.decision, planRevision: snap.planRevision,
    entrySeq: snap.entrySeq, reasons: result.reasons, assessedAt: new Date().toISOString(), basisCommit: snap.basisCommit,
    ...(result.headCommit ? { headCommit: result.headCommit } : {}),
    ...(result.changedPaths.length > 0 ? { changedPaths: result.changedPaths } : {}),
    ...(result.candidate ? { candidate: result.candidate } : {}) };
  try {
    await state.runExclusive(() => apply(state, snap, record));
  } catch (error) {
    // The row stays pending; the next claim or wait evaluation starts a new assessment.
    logger.warn({ taskId: snap.taskId, error: firstLine(error) }, 'Plan reuse: could not record the assessment');
  }
}

/** Under the lock: write only if the row is still the one assessed, still unassigned and still pending. */
async function apply(state: StateManager, snap: Snapshot, record: PlanReuseRecord): Promise<void> {
  const task = state.getTask(snap.taskId);
  if (!task || task.status !== 'PLANNING' || task.assignedWorkerId || revisionOf(task) !== snap.planRevision
    || task.approvedPlanRevision !== snap.approvedPlanRevision || readPlanningEntry(task)?.seq !== snap.entrySeq
    || readPlanSourceBasis(task)?.commit !== snap.basisCommit || planReuseView(task)?.decision !== 'pending') return;
  let written = record;
  if (record.decision === 'reassess') {
    await updateTask(state, task.id, {}, 'TASK_UPDATED', undefined, { planReuse: record });
  } else {
    try {
      await updateTask(state, task.id, { status: 'WORKING', contextFetchedBy: [] }, 'TASK_UPDATED', undefined,
        { planReuse: record });
    } catch (error) {
      // e.g. EXECUTION_PROFILE_NOT_READY from the store's progression backstop.
      if (!(error instanceof MoeError)) throw error;
      written = { ...record, decision: 'reassess', reasons: [`resume-refused:${error.codeName}`] };
      await updateTask(state, task.id, {}, 'TASK_UPDATED', undefined, { planReuse: written });
    }
  }
  const reasons = written.reasons.slice(0, 3).join(', ') || 'source unchanged';
  state.postSystemMessage(task.id, `Plan reuse: ${written.decision} (plan revision ${written.planRevision}): ${reasons}`)
    .catch(() => {});
}

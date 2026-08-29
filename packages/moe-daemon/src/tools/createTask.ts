import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskStatus, TaskPriority } from '../types/schema.js';
import { missingRequired, invalidInput } from '../util/errors.js';
import { MAX_TASK_DEPENDENCY_IDS } from '../state/taskStore.js';
import { resolveMaxTasksPerEpic } from '../util/planSize.js';
import { findDependencyPath, formatDependencyCycle } from '../state/dependencyUnblock.js';

/**
 * Titles that read as meta/evidence/hardening rows — the shape behind measured
 * board inflation (119/632 rows on the moe-next board). Matching is a WARNING
 * trigger only, never a gate.
 */
export const META_TITLE_RE = /security|evidence|verif|harden|audit|acceptance|quality|proof|gate/i;

/** create_task's team-role → createdBy attribution mapping. */
const ROLE_TO_CREATED_BY: Record<string, Task['createdBy']> = {
  architect: 'ARCHITECT',
  qa: 'QA',
  governor: 'GOVERNOR',
  worker: 'WORKER',
};

export function createTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_task',
    description: 'Create a new task in an epic. Guardrails (column WIP limits, per-epic task ceiling, meta-title consolidation, DoD shape) are ALL ADVISORY — creation never hard-fails; read `warnings` in the response. Pass workerId so the row is attributed to your role (createdBy).',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        definitionOfDone: { type: 'array', items: { type: 'string' } },
        taskRails: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'] },
        priority: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
        parentTaskId: { type: 'string' },
        order: { type: 'number' },
        createdBy: { type: 'string', enum: ['HUMAN', 'WORKER', 'ARCHITECT', 'QA', 'GOVERNOR'], description: 'Overridden by the workerId team-role resolution when a workerId is supplied.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy) — resolves your team role into createdBy for attribution.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids this task depends on. Gates WORKING-status claims only (planning may proceed); unknown ids are dropped with a warning; capped at 20. Editable later via moe.set_task_dependencies.'
        }
      },
      required: ['epicId', 'title'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        title?: string;
        description?: string;
        definitionOfDone?: string[];
        taskRails?: string[];
        status?: TaskStatus;
        priority?: TaskPriority;
        parentTaskId?: string;
        order?: number;
        createdBy?: Task['createdBy'];
        workerId?: string;
        dependsOn?: unknown;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }
      if (!params.title) {
        throw missingRequired('title');
      }

      const validStatuses = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
      if (params.status && !validStatuses.includes(params.status)) {
        throw invalidInput('status', `must be one of: ${validStatuses.join(', ')}`);
      }

      const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      if (params.priority && !validPriorities.includes(params.priority)) {
        throw invalidInput('priority', `must be one of: ${validPriorities.join(', ')}`);
      }

      const warnings: string[] = [];

      // dependsOn: shape errors throw (a malformed param is a caller bug), but
      // unknown ids are DROPPED with a warning — creation never fails on a
      // typo'd id, and a missing id would count as satisfied anyway.
      let dependsOn: string[] | undefined;
      if (params.dependsOn !== undefined) {
        if (!Array.isArray(params.dependsOn)) throw invalidInput('dependsOn', 'must be an array of task ids');
        for (const id of params.dependsOn) {
          if (typeof id !== 'string') throw invalidInput('dependsOn', 'each entry must be a string');
        }
        const seen = new Set<string>();
        const known: string[] = [];
        const unknown: string[] = [];
        const overflow: string[] = [];
        for (const raw of params.dependsOn as string[]) {
          const id = raw.trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          if (!state.getTask(id)) {
            unknown.push(id);
            continue;
          }
          // Past the cap the ids are dropped — but NAMED: a silently vanished
          // prerequisite makes the row claimable before it actually may run.
          if (known.length < MAX_TASK_DEPENDENCY_IDS) known.push(id);
          else overflow.push(id);
        }
        if (unknown.length > 0) {
          warnings.push(
            `dependsOn ids not on the board were dropped: ${unknown.join(', ')}. Declare dependencies on existing tasks only (moe.set_task_dependencies to fix later).`
          );
        }
        if (overflow.length > 0) {
          warnings.push(
            `dependsOn capped at ${MAX_TASK_DEPENDENCY_IDS}; dropped: ${overflow.join(', ')} — a task with this many prerequisites is usually several tasks (split it), or edit the list via moe.set_task_dependencies.`
          );
        }
        dependsOn = known.length > 0 ? known : undefined;
      }

      // Role attribution: resolve the caller's team role into createdBy
      // (pattern: submit_plan_critique's role gate — but soft: an unknown or
      // team-less caller just falls back to the explicit param / WORKER).
      const team = params.workerId ? state.getTeamForWorker(params.workerId) : null;
      const resolvedCreatedBy: Task['createdBy'] =
        (team?.role && ROLE_TO_CREATED_BY[team.role]) || params.createdBy || 'WORKER';

      // Column WIP limit at creation — WARNING ONLY. The transition path
      // (set_task_status / board) throws at the limit, but a creation must
      // never hard-fail: a full column cannot be allowed to wedge a
      // rail-mandated spinoff; the anti-stuck duty is carried by seat-freeing
      // and dependency auto-unblock, not by creation brakes.
      const creationStatus: TaskStatus = params.status || 'BACKLOG';
      const columnLimits = state.project?.settings?.columnLimits;
      if (columnLimits && typeof columnLimits[creationStatus] === 'number') {
        const limit = columnLimits[creationStatus];
        const currentCount = Array.from(state.tasks.values())
          .filter((t) => t.status === creationStatus && t.status !== 'ARCHIVED').length;
        if (currentCount >= limit) {
          warnings.push(
            `Column ${creationStatus} is at its WIP limit of ${limit} (${currentCount} tasks). Creation is allowed (advisory), but consider finishing in-flight work before adding more — or file into BACKLOG.`
          );
        }
      }

      let task = await state.createTask({
        epicId: params.epicId,
        title: params.title,
        description: params.description,
        definitionOfDone: params.definitionOfDone,
        taskRails: params.taskRails,
        status: params.status,
        priority: params.priority,
        parentTaskId: params.parentTaskId,
        order: params.order,
        createdBy: resolvedCreatedBy,
        ...(dependsOn ? { dependsOn } : {}),
      });

      // Cycle check (dependsOn ∪ blockedOnTaskIds), the same invariant
      // set_task_dependencies rejects on and report_blocked drops on. The id
      // is only known after creation, and a fresh id is referenced by nothing
      // yet, so this cannot fire today — it is kept so all three dependency
      // writers share one rule. Advisory like every other create_task
      // guardrail: offending ids are dropped with a warning, never a throw.
      if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
        const cyclic: string[] = [];
        for (const id of task.dependsOn) {
          const cycle = findDependencyPath(state, id, task.id);
          if (cycle) {
            cyclic.push(id);
            warnings.push(
              `dependsOn id ${id} was dropped: it would close a dependency cycle (${formatDependencyCycle(task.id, cycle)}).`
            );
          }
        }
        if (cyclic.length > 0) {
          const kept = task.dependsOn.filter((id) => !cyclic.includes(id));
          task = await state.updateTask(task.id, { dependsOn: kept });
        }
      }

      // Advisory sizing feedback at creation time — the hard gate lives in
      // submit_plan (step/file counts are only machine-visible there), but
      // surfacing shape problems now is cheaper than bouncing a plan later.
      const dodCount = params.definitionOfDone?.filter((d) => typeof d === 'string' && d.trim().length > 0).length ?? 0;
      if (dodCount === 0) {
        warnings.push(
          'definitionOfDone is empty (a placeholder was substituted). Give every task 3-7 mechanically checkable items — a command to run or a test to pass — so the worker has a stopping condition and QA has a rubric.'
        );
      } else if (dodCount > 7) {
        warnings.push(
          `definitionOfDone has ${dodCount} items (target 3-7). A DoD this wide usually means the task is several tasks — split it (moe-epic-breakdown / SPIDR) before planning; oversized plans are rejected at submit_plan.`
        );
      }
      if (/\band\b/i.test(params.title)) {
        warnings.push(
          'Title contains "and" — often two tasks wearing one title. Split unless the halves genuinely cannot land independently.'
        );
      }

      // Meta-title consolidation: an epic is supposed to carry ONE hardening/
      // evidence row (the epic-final integration task). Filing another
      // meta-titled row next to an existing one is the measured inflation
      // pattern — warn (never block) and name the consolidation target.
      const epicTasks = Array.from(state.tasks.values())
        .filter((t) => t.epicId === params.epicId && t.id !== task.id && t.status !== 'ARCHIVED');
      if (META_TITLE_RE.test(params.title)) {
        const metaSiblings = epicTasks
          .filter((t) => META_TITLE_RE.test(t.title) && t.status !== 'DONE')
          .sort((a, b) => b.order - a.order);
        if (metaSiblings.length > 0) {
          const target = metaSiblings[0];
          warnings.push(
            `Meta/hardening row detected ("${params.title}") but this epic already has one: ${target.id} ("${target.title}", order ${target.order}). Consolidate the checks into that row (extend its DoD) instead of adding another — per-topic evidence rows are the measured board-inflation pattern.`
          );
        }
      }

      // Per-epic task ceiling (settings.taskSizing.maxTasksPerEpic, default
      // 40) — advisory: past it the epic likely needs re-slicing, not more rows.
      const maxTasksPerEpic = resolveMaxTasksPerEpic(state.project?.settings?.taskSizing);
      const epicCount = epicTasks.length + 1; // include the row just created
      if (epicCount > maxTasksPerEpic) {
        warnings.push(
          `Epic ${params.epicId} now has ${epicCount} non-archived tasks (advisory ceiling ${maxTasksPerEpic}, settings.taskSizing.maxTasksPerEpic). Epics this wide review and parallelize poorly — consider re-slicing into multiple epics (moe-epic-breakdown / SPIDR).`
        );
      }

      return { success: true, task, ...(warnings.length > 0 ? { warnings } : {}) };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';
import { invalidInput, missingRequired, notAllowed, notFound } from '../util/errors.js';
import { MAX_TASK_DEPENDENCY_IDS } from '../state/taskStore.js';
import { findDependencyPath, formatDependencyCycle, unmetDependsOn } from '../state/dependencyUnblock.js';
import { workerHasRole } from '../util/workerRole.js';

/**
 * moe.set_task_dependencies — the architect/governor escape hatch for
 * dependsOn. dependsOn gates WORKING-status claims, so a mis-declared id
 * could otherwise stick a row until someone edits JSON by hand (forbidden).
 * `dependsOn` REPLACES the array (pass [] to clear); `addDependsOn` /
 * `removeDependsOn` edit it in place. Added ids are hard-validated here —
 * unlike create_task this is a deliberate correction tool, so a typo'd id is
 * an error to surface, not something to silently drop.
 *
 * Why the in-place edit exists: a row such as a verification batch collects
 * its dependsOn from many seats, each registering its own task. A
 * read-then-replace loses whatever another seat added between the read and
 * the write (px4swarm, 2026-10-26: a union registering task-5cd5a712 on
 * VERIFY-BATCH-C98 dropped task-f5c577d1, which another seat had added
 * seconds earlier). The edit is applied to the list in force when the handler
 * runs, and McpAdapter runs non-blocking handlers under the state mutex, so a
 * concurrent edit cannot interleave.
 */
export function setTaskDependenciesTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.set_task_dependencies',
    description: 'Architect/governor-only: edit a task\'s dependsOn. Pass dependsOn to REPLACE the array ([] clears), or addDependsOn/removeDependsOn to edit the list in force when the call runs, so seats registering on the same row never drop each other\'s ids. dependsOn gates WORKING-status claims until every listed task is DONE/ARCHIVED — this tool is the escape hatch for a mis-declared dependency. Added ids must exist on the board; capped at 20; an id that would close a dependency cycle (through dependsOn or blockedOnTaskIds) is rejected with the path.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task whose dependsOn list to edit' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of task ids (empty array clears all dependencies). Not combinable with addDependsOn/removeDependsOn.' },
        addDependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids to add to the current list; an id already listed is left as is. Use this instead of read-then-replace when other seats edit the same row.' },
        removeDependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids to drop from the current list; an id not listed is ignored.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); must be on an architect or governor team.' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        dependsOn?: unknown;
        addDependsOn?: unknown;
        removeDependsOn?: unknown;
        workerId?: string;
      };
      if (!params.taskId) throw missingRequired('taskId');
      const replacing = params.dependsOn !== undefined;
      const editing = params.addDependsOn !== undefined || params.removeDependsOn !== undefined;
      if (replacing && editing) {
        throw invalidInput('dependsOn', 'pass either dependsOn (full replacement) or addDependsOn/removeDependsOn (in-place edit), not both');
      }
      if (!replacing && !editing) throw missingRequired('dependsOn (or addDependsOn/removeDependsOn)');
      const replacement = replacing ? idList('dependsOn', params.dependsOn) : [];
      const additions = params.addDependsOn === undefined ? [] : idList('addDependsOn', params.addDependsOn);
      const removals = params.removeDependsOn === undefined ? [] : idList('removeDependsOn', params.removeDependsOn);
      const inBoth = additions.filter((id) => removals.includes(id));
      if (inBoth.length > 0) {
        throw invalidInput('addDependsOn', `ids in both addDependsOn and removeDependsOn: ${inBoth.join(', ')}`);
      }

      // Role gate (mirrors submit_plan_critique): a missing/role-less workerId
      // is rejected — dependency edits reshape what the fleet may claim.
      if (!workerHasRole(state, params.workerId || '', 'architect', 'governor')) {
        throw notAllowed(
          'set_task_dependencies',
          `architect or governor role required (worker ${params.workerId || '(none)'} is on neither team and its id declares neither role)`
        );
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const previous = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      let dependsOn: string[];
      const added: string[] = [];
      if (replacing) {
        for (const id of replacement) assertDependencyTarget(state, task, 'dependsOn', id);
        dependsOn = replacement;
      } else {
        // Removed ids need not exist: a prerequisite deleted from the board
        // must still be removable from the list.
        dependsOn = previous.filter((id) => !removals.includes(id));
        for (const id of additions) {
          if (dependsOn.includes(id)) continue;
          assertDependencyTarget(state, task, 'addDependsOn', id);
          dependsOn.push(id);
          added.push(id);
        }
      }
      if (dependsOn.length > MAX_TASK_DEPENDENCY_IDS) {
        throw invalidInput(replacing ? 'dependsOn' : 'addDependsOn', `too many ids (${dependsOn.length}); maximum ${MAX_TASK_DEPENDENCY_IDS}`);
      }
      const removed = previous.filter((id) => !dependsOn.includes(id));

      if (!replacing && added.length === 0 && removed.length === 0) {
        // Nothing to write: every added id was already listed and no removed
        // one was. No activity event and no chat line for a no-op.
        return {
          success: true,
          taskId: task.id,
          dependsOn: previous,
          previousDependsOn: previous,
          added,
          removed,
          dependsOnUnmet: unmetDependsOn(state, task).length,
          message: `Dependencies unchanged on ${task.id}: every addDependsOn id was already listed and no removeDependsOn id was.`
        };
      }

      const updated = await state.updateTask(task.id, { dependsOn }, 'TASK_DEPENDENCIES_SET');
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }

      const unmet = unmetDependsOn(state, updated);
      const who = params.workerId || 'human';
      const verb = replacing ? 'replaced' : 'edited';
      try {
        const delta = replacing ? '' : ` (+[${added.join(', ') || 'none'}] -[${removed.join(', ') || 'none'}])`;
        await state.postSystemMessage(
          task.id,
          `🔗 ${who} ${replacing ? 'set' : 'edited'} dependencies on ${task.id}${delta}: [${dependsOn.join(', ') || 'none'}] (was [${previous.join(', ') || 'none'}])`
        );
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        dependsOn: updated.dependsOn ?? [],
        previousDependsOn: previous,
        ...(replacing ? {} : { added, removed }),
        dependsOnUnmet: unmet.length,
        message: dependsOn.length === 0
          ? `Dependencies cleared on ${task.id}; it is claim-gated by nothing.`
          : unmet.length === 0
            ? `Dependencies ${verb} on ${task.id}; all ${dependsOn.length} are already DONE/ARCHIVED — the task is claimable now.`
            : `Dependencies ${verb} on ${task.id}; ${unmet.length} unmet (${unmet.join(', ')}) — WORKING claims stay gated until they are DONE/ARCHIVED.`
      };
    }
  };
}

/** Trimmed, deduped, non-empty ids from a caller-supplied array. */
function idList(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidInput(field, 'must be an array of task ids');
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw invalidInput(field, 'each entry must be a string');
    const id = raw.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Hard validation for an id about to enter task.dependsOn: no self-edge, the
 * id is on the board, and the edge closes no cycle over dependsOn ∪
 * blockedOnTaskIds. A cycle's members can never all reach DONE — both rows
 * would sit claim-gated forever with nothing (no sweep, no alert, no wrapper
 * path) ever looking at them — so it is rejected outright, naming the path:
 * this tool's posture is hard validation, and a cycle is the one edit that
 * wedges two rows at once.
 */
function assertDependencyTarget(state: StateManager, task: Task, field: string, id: string): void {
  if (id === task.id) throw invalidInput(field, `a task cannot depend on itself (${id})`);
  if (!state.getTask(id)) throw invalidInput(field, `unknown task id: ${id}`);
  const cycle = findDependencyPath(state, id, task.id);
  if (cycle) {
    throw invalidInput(field, `would close a dependency cycle: ${formatDependencyCycle(task.id, cycle)}`);
  }
}

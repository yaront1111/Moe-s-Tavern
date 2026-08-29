import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, missingRequired, notAllowed, notFound } from '../util/errors.js';
import { MAX_TASK_DEPENDENCY_IDS } from '../state/taskStore.js';
import { findDependencyPath, formatDependencyCycle, unmetDependsOn } from '../state/dependencyUnblock.js';

/**
 * moe.set_task_dependencies — the architect/governor escape hatch for
 * dependsOn. dependsOn gates WORKING-status claims, so a mis-declared id
 * could otherwise stick a row until someone edits JSON by hand (forbidden).
 * REPLACES the array (pass [] to clear); ids are hard-validated here — unlike
 * create_task this is a deliberate correction tool, so a typo'd id is an error
 * to surface, not something to silently drop.
 */
export function setTaskDependenciesTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.set_task_dependencies',
    description: 'Architect/governor-only: REPLACE a task\'s dependsOn array (pass [] to clear). dependsOn gates WORKING-status claims until every listed task is DONE/ARCHIVED — this tool is the escape hatch for a mis-declared dependency. Ids must exist on the board; capped at 20; an id that would close a dependency cycle (through dependsOn or blockedOnTaskIds) is rejected with the path.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of task ids (empty array clears all dependencies).' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); must be on an architect or governor team.' }
      },
      required: ['taskId', 'dependsOn'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        dependsOn?: unknown;
        workerId?: string;
      };
      if (!params.taskId) throw missingRequired('taskId');
      if (params.dependsOn === undefined) throw missingRequired('dependsOn');
      if (!Array.isArray(params.dependsOn)) throw invalidInput('dependsOn', 'must be an array of task ids');

      // Role gate (mirrors submit_plan_critique): a missing/role-less workerId
      // is rejected — dependency edits reshape what the fleet may claim.
      const team = state.getTeamForWorker(params.workerId || '');
      if (team?.role !== 'architect' && team?.role !== 'governor') {
        throw notAllowed(
          'set_task_dependencies',
          `architect or governor role required (worker ${params.workerId || '(none)'} is on neither team)`
        );
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const seen = new Set<string>();
      const dependsOn: string[] = [];
      for (const raw of params.dependsOn) {
        if (typeof raw !== 'string') throw invalidInput('dependsOn', 'each entry must be a string');
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (id === task.id) throw invalidInput('dependsOn', `a task cannot depend on itself (${id})`);
        if (!state.getTask(id)) throw invalidInput('dependsOn', `unknown task id: ${id}`);
        // Cycle check over dependsOn ∪ blockedOnTaskIds: if THIS task is
        // reachable from the candidate, recording the edge closes a cycle
        // whose members can never all reach DONE — both rows would sit
        // claim-gated forever with nothing (no sweep, no alert, no wrapper
        // path) ever looking at them. Rejected outright, naming the path:
        // this tool's posture is hard validation, and a cycle is the one edit
        // that wedges two rows at once.
        const cycle = findDependencyPath(state, id, task.id);
        if (cycle) {
          throw invalidInput('dependsOn', `would close a dependency cycle: ${formatDependencyCycle(task.id, cycle)}`);
        }
        dependsOn.push(id);
      }
      if (dependsOn.length > MAX_TASK_DEPENDENCY_IDS) {
        throw invalidInput('dependsOn', `too many ids (${dependsOn.length}); maximum ${MAX_TASK_DEPENDENCY_IDS}`);
      }

      const previous = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      const updated = await state.updateTask(task.id, { dependsOn }, 'TASK_DEPENDENCIES_SET');
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }

      const unmet = unmetDependsOn(state, updated);
      const who = params.workerId || 'human';
      try {
        await state.postSystemMessage(
          task.id,
          `🔗 ${who} set dependencies on ${task.id}: [${dependsOn.join(', ') || 'none'}] (was [${previous.join(', ') || 'none'}])`
        );
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        dependsOn: updated.dependsOn ?? [],
        previousDependsOn: previous,
        dependsOnUnmet: unmet.length,
        message: dependsOn.length === 0
          ? `Dependencies cleared on ${task.id}; it is claim-gated by nothing.`
          : unmet.length === 0
            ? `Dependencies replaced on ${task.id}; all ${dependsOn.length} are already DONE/ARCHIVED — the task is claimable now.`
            : `Dependencies replaced on ${task.id}; ${unmet.length} unmet (${unmet.join(', ')}) — WORKING claims stay gated until they are DONE/ARCHIVED.`
      };
    }
  };
}

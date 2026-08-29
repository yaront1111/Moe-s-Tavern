import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';
import { unionPaths } from '../util/attributionTiers.js';

const MAX_DECLARED_PATHS_PER_CALL = 500;
const MAX_NOTE_CHARS = 2000;

export function declareFilesTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.declare_files',
    description: 'Declare project-relative paths as this task\'s own work (ASSERTED attribution tier): the agent wrapper commits them under the task id on its next exit regardless of the pre-task baseline. Use it for paths a step forgot to report in complete_step.modifiedFiles, for get_context.unattributedPaths that are yours, or — as a governor — to attribute stranded dirty sources to the live task that edited them instead of hand-landing a chore commit. Unions into task.declaredFiles; no ownership guard; allowed in every status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths (forward slashes; no absolute paths or ..).' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' },
        note: { type: 'string', description: 'Why these paths belong to the task (kept in the activity log and task channel).' }
      },
      required: ['taskId', 'paths'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        paths?: unknown;
        workerId?: string;
        note?: unknown;
      };

      if (!params.taskId || typeof params.taskId !== 'string') throw missingRequired('taskId');
      if (params.paths === undefined || params.paths === null) throw missingRequired('paths');
      if (!Array.isArray(params.paths)) throw invalidInput('paths', 'must be an array of strings');
      if (params.paths.length === 0) throw invalidInput('paths', 'must contain at least one path');
      if (params.paths.length > MAX_DECLARED_PATHS_PER_CALL) {
        throw invalidInput('paths', `must contain ${MAX_DECLARED_PATHS_PER_CALL} items or fewer`);
      }
      let note: string | undefined;
      if (params.note !== undefined) {
        if (typeof params.note !== 'string') throw invalidInput('note', 'must be a string');
        note = params.note.trim();
        if (note.length > MAX_NOTE_CHARS) throw invalidInput('note', `too long (max ${MAX_NOTE_CHARS} chars)`);
        if (note.length === 0) note = undefined;
      }

      // Strict: agent-typed input, so an absolute or traversing path is a
      // caller mistake to fix, not something to store.
      const paths = normalizeAffectedFiles(params.paths, 'paths');

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const { merged, added } = unionPaths(task.declaredFiles, paths);
      const alreadyDeclared = paths.filter((p) => !added.includes(p));

      // Written even when nothing is new so the TASK_FILES_DECLARED event (with
      // the note) is on record for the audit trail.
      const updated = await state.updateTask(task.id, { declaredFiles: merged }, 'TASK_FILES_DECLARED');
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }

      const who = params.workerId || 'human';
      try {
        await state.postSystemMessage(
          task.id,
          `📎 ${who} declared ${paths.length} path(s) on ${task.id} (${added.length} new): ${paths.join(', ')}${note ? ` — ${note}` : ''}`
        );
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        declaredFiles: updated.declaredFiles ?? merged,
        addedPaths: added,
        alreadyDeclared,
        ...(note ? { note } : {}),
        message: added.length > 0
          ? `Declared ${added.length} new path(s) on ${task.id}; the wrapper commits them under the task on its next exit.`
          : `All ${paths.length} path(s) were already declared on ${task.id}.`
      };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Epic, EpicStatus } from '../types/schema.js';
import { invalidInput, missingRequired } from '../util/errors.js';
import { validateEpicUpdates } from '../state/validators.js';
import { archiveEpicTool } from './archiveEpic.js';

/**
 * Refuses, before any write, a designation that could never be epic-final: an id
 * naming no task, a task of another epic, or an ARCHIVED task. Blank (clear) and
 * non-string values pass through to validateEpicUpdates, as does a missing epic,
 * which keeps state.updateEpic's `Epic not found` error.
 */
function assertDesignatable(state: StateManager, epicId: string, finalTaskId: unknown): void {
  if (typeof finalTaskId !== 'string' || !state.getEpic(epicId)) return;
  const id = finalTaskId.trim();
  if (id === '') return;
  const task = state.getTask(id);
  if (!task) throw invalidInput('finalTaskId', `names no task: ${id}`);
  if (task.epicId !== epicId) {
    throw invalidInput('finalTaskId', `task ${id} belongs to epic ${task.epicId}, not ${epicId}`);
  }
  if (task.status === 'ARCHIVED') {
    throw invalidInput('finalTaskId', `task ${id} is ARCHIVED and can never be epic-final`);
  }
}

/**
 * The one epic-update path of moe.update_epic and the board's /ws UPDATE_EPIC.
 * Moving an epic that is not ARCHIVED yet to ARCHIVED runs moe.archive_epic
 * instead of a bare status write: its in-flight refusal, its holder rule for a
 * caller with a workerId, its finalizing hold, and every task archived with a
 * TASK_ARCHIVED event. The call's other fields are validated before any write
 * and applied after the archive. Every other update, an already-ARCHIVED epic
 * included, stays a plain state.updateEpic.
 */
export async function applyEpicUpdate(
  state: StateManager,
  epicId: string,
  updates: Record<string, unknown>,
  workerId?: string
): Promise<Epic> {
  const epic = state.getEpic(epicId);
  if (!epic || updates?.status !== 'ARCHIVED' || epic.status === 'ARCHIVED') {
    return state.updateEpic(epicId, updates as Partial<Epic>, workerId);
  }
  const { status: _archived, ...rest } = updates;
  const hasRest = Object.keys(rest).length > 0;
  if (hasRest) validateEpicUpdates(rest as Partial<Epic>); // a bad companion field is refused before any write
  await archiveEpicTool(state).handler(workerId === undefined ? { epicId } : { epicId, workerId }, state);
  return hasRest ? state.updateEpic(epicId, rest as Partial<Epic>, workerId) : state.getEpic(epicId)!;
}

export function updateEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.update_epic',
    description: 'Update an existing epic. status ARCHIVED on an epic that is not archived yet runs moe.archive_epic first (refused while any task is PLANNING, AWAITING_APPROVAL or WORKING, or, for a caller with a workerId, while another worker holds a BLOCKED task; otherwise every task is archived), then applies the other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'The ID of the epic to update' },
        title: { type: 'string', description: 'New title for the epic' },
        description: { type: 'string', description: 'New description' },
        architectureNotes: { type: 'string', description: 'Architecture notes and technical guidance' },
        epicRails: { type: 'array', items: { type: 'string' }, description: 'Constraints that apply to all tasks in this epic' },
        status: { type: 'string', enum: ['PLANNED', 'ACTIVE', 'COMPLETED', 'ARCHIVED'], description: 'Epic status. ARCHIVED follows moe.archive_epic (see the tool description).' },
        order: { type: 'number', description: 'Display order' },
        finalTaskId: {
          type: 'string',
          description: "Designate the epic's final (integration-and-hardening) task by id. get_context isEpicFinal and the epicFinal quality-gate scope follow it whatever the board order. An empty string clears it, and the epic falls back to the highest order."
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of EPIC_UPDATED, never stored on the epic' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      // The proxy injects the caller's workerId into every tools/call: it is the
      // EPIC_UPDATED actor, never an epic field, so split it off before the strict check.
      const { workerId, ...raw } = (args || {}) as Record<string, unknown>;
      const allowedFields = new Set(['epicId', 'title', 'description', 'architectureNotes', 'epicRails', 'status', 'order', 'finalTaskId']);
      for (const field of Object.keys(raw)) {
        if (!allowedFields.has(field)) {
          throw invalidInput(field, 'is not a supported epic update field');
        }
      }

      const params = raw as {
        epicId?: string;
        title?: string;
        description?: string;
        architectureNotes?: string;
        epicRails?: string[];
        status?: EpicStatus;
        order?: number;
        finalTaskId?: string;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }
      assertDesignatable(state, params.epicId, params.finalTaskId);

      const updates: Partial<{
        title: string;
        description: string;
        architectureNotes: string;
        epicRails: string[];
        status: EpicStatus;
        order: number;
        finalTaskId: string;
      }> = {};

      if (params.title !== undefined) updates.title = params.title;
      if (params.description !== undefined) updates.description = params.description;
      if (params.architectureNotes !== undefined) updates.architectureNotes = params.architectureNotes;
      if (params.epicRails !== undefined) updates.epicRails = params.epicRails;
      if (params.status !== undefined) updates.status = params.status;
      if (params.order !== undefined) updates.order = params.order;
      if (params.finalTaskId !== undefined) updates.finalTaskId = params.finalTaskId;

      const epic = await applyEpicUpdate(state, params.epicId, updates, workerId as string | undefined);

      return { success: true, epic };
    }
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { recordCheckObservation, type RecordCheckObservationParams } from '../state/checkObservationStore.js';
import { CHECK_OUTCOMES, MAX_CHECK_LOG_BYTES } from '../state/checkRunStore.js';
import { runnerToolCall } from './recordCheckDispatch.js';
import { applyRepairDecision, decideCheckRepair } from '../delivery/repairActivation.js';
import type { RepairDecision } from '../delivery/repairPolicy.js';
import type { CheckRun } from '../types/schema.js';
import { logger } from '../util/logger.js';

// =============================================================================
// moe.record_check_observation: the one result of a recorded check dispatch
// =============================================================================
//
// Puts the observation half of state/checkObservationStore.ts on the wire.
// The run's candidate, tree, command, plan revision and environment come from
// the RECORDED dispatch and its runnerId from the channel (runnerToolCall), so
// no argument can retarget it. A superseded dispatch stays answerable against
// its own binding: that is the only recovery. Only such a run, with its marker,
// passes isAuthenticatedCheckRun; a moe.record_check_run report never does.
//
// RECORDING, NOT APPROVAL. Not `blocking`: dispatch serializes the tool under
// the state mutex, which keeps one marker per dispatch.
//
// REPAIR (CQ-V05b): a verified-local task's run then gets CQ-V05's decision, in
// the same mutex-held call (delivery/repairActivation.ts), applied only once.
// =============================================================================

const TOOL_NAME = 'moe.record_check_observation';
const FIELDS = new Set(['id', 'dispatchId', 'exitCode', 'outcome', 'outputTail', 'environment', 'workerId']);

export function recordCheckObservationTool(_state: StateManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Record the one result an authenticated runner observed for a RECORDED check dispatch, as a runner-observed CheckRun at .moe/checks/<id>.json plus a marker at .moe/checks/observations/<dispatchId>.json. ' +
      'Runner channel only: a call over /mcp or /ws is refused (RUNNER_CHANNEL_REQUIRED) before anything is read, and runnerId comes from the channel, never from an argument. ' +
      'The candidate, tree, command, plan revision and environment come from the dispatch and can never be retargeted: runnerId, source, candidateId, treeSha, command, planRevision ' +
      'and any other argument are refused by name (INVALID_INPUT). A superseded dispatch is still answered against its own binding. ' +
      'Refusals: an unrecorded dispatch (CHECK_DISPATCH_NOT_FOUND), another runner\'s dispatch (CHECK_RUNNER_MISMATCH), another environment (CHECK_ENVIRONMENT_MISMATCH), ' +
      'a second result for the dispatch (CHECK_DISPATCH_ALREADY_OBSERVED) and a same-id run that differs (CHECK_RUN_IMMUTABLE). An identical same-id call returns the stored run with duplicate:true ' +
      'and completes a marker a crash left unwritten. Recorded, never approved: a run marks nothing DONE and releases nothing. ' +
      'On a verified-local task the result may carry `repair` (CQ-V05\'s decision, applied once, never on a duplicate) or `repairError`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The check-run id (letters, digits, - and _; at most 128 chars). Required: reuse it to retry after a crash. Use an unguessable id.',
        },
        dispatchId: { type: 'string', description: 'The recorded dispatch this run answers.' },
        exitCode: { type: 'integer', description: 'The exit code: any safe integer. passed requires 0 and code-failure a nonzero one.' },
        outcome: { type: 'string', enum: [...CHECK_OUTCOMES], description: 'How the run ended. Never inferred from exitCode.' },
        outputTail: {
          type: 'string',
          description: `Optional end of the output. Stored as its final ${MAX_CHECK_LOG_BYTES} UTF-8 bytes, starting on a whole character; absent is stored as "".`,
        },
        environment: { type: 'string', description: 'The environment the run used. Must equal the dispatch\'s environment exactly.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy). Not evidence and not stored.' },
      },
      required: ['id', 'dispatchId', 'exitCode', 'outcome', 'environment'],
      additionalProperties: false,
    },
    handler: async (args, state, context) => {
      const { runner, params } = runnerToolCall(TOOL_NAME, 'check observation', FIELDS, args, context);
      const { checkRun, duplicate } = await recordCheckObservation(state, runner, params as RecordCheckObservationParams);
      return { success: true, checkRun, duplicate, ...(await activateRepair(state, checkRun, duplicate)) };
    },
  };
}

/** The repair fields: none when the run is not judged. Never fails the persisted observation, so a runner retry cannot loop on it. */
async function activateRepair(state: StateManager, checkRun: CheckRun, duplicate: boolean): Promise<{ repair?: RepairDecision; repairError?: string }> {
  let judged: ReturnType<typeof decideCheckRepair> = null;
  try {
    judged = decideCheckRepair(state, checkRun);
    if (judged && !duplicate) await applyRepairDecision(state, judged.task, judged.decision);
    return judged ? { repair: judged.decision } : {};
  } catch (error) {
    logger.warn({ taskId: judged?.task.id, checkRunId: checkRun.id, error }, 'Repair activation failed; the observation stays recorded');
    return { ...(judged ? { repair: judged.decision } : {}), repairError: error instanceof Error ? error.message : String(error) };
  }
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { CheckOutcome, CheckRunSource } from '../types/schema.js';
import { MAX_CHECK_LOG_BYTES, recordCheckRun, validateCheckRunParams } from '../state/checkRunStore.js';
import { MAX_REQUIRED_CHECK_COMMAND_CHARS } from '../state/validators.js';

// =============================================================================
// moe.record_check_run — a check result reported against one candidate's tree
// =============================================================================
//
// Puts state/checkRunStore.ts on the wire. Every rule lives in that store, not
// here: the input shape, the candidate existing, the reported tree being exactly
// the candidate's, same-id immutability and the UTF-8 bound on the output tail.
//
// RECORDING, NOT APPROVAL. success:true acknowledges that the run was persisted,
// a failing exit code included. Nothing is approved, no task is marked DONE and
// no dependent is released: whether this exact candidate, tree, command and
// source satisfy a gate is decided later, by policy.
//
// DECLARED PROVENANCE. `source` is what the caller says. The daemon never runs
// the command and does not authenticate the caller, so source is never inferred
// from workerId and never defaulted. workerId is the proxy-injected caller, not
// evidence, and it is not stored.
//
// No ownership, status or attempt gate: the runner reports after complete_task,
// when QA may already hold the task and the attempt may be closed. The candidate
// and its tree are the binding; an optional attemptId is checked for referential
// integrity only (an attempt of the candidate's task). NOT `blocking`: dispatch serializes every
// non-blocking tool under the state mutex, and the store's same-id
// check-then-write relies on exactly that.
// =============================================================================

const TOOL_NAME = 'moe.record_check_run';

/** Exhaustive by type: a CheckRunSource missing here, or an extra key, fails to compile. */
const SOURCES: Record<CheckRunSource, true> = { 'runner-observed': true, 'agent-reported': true };
/** Exhaustive by type, like SOURCES. */
const OUTCOMES: Record<CheckOutcome, true> = {
  passed: true, 'code-failure': true, 'infra-failure': true, timeout: true, skipped: true, inconclusive: true,
};

export function recordCheckRunTool(_state: StateManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Record a CheckRun: the result a check REPORTED for one command run against one Candidate\'s exact tree, persisted immutably as one file per run at .moe/checks/<id>.json (a candidate accumulates runs). ' +
      'Recorded, never approved: success:true acknowledges persistence, even for a nonzero exitCode, and marks nothing DONE and releases nothing. ' +
      'source (runner-observed | agent-reported) is DECLARED provenance: required, never defaulted, never inferred from workerId. The daemon never runs the command and does not authenticate the reporter. ' +
      'Bound before anything is written: candidateId must exist (CANDIDATE_NOT_FOUND) and treeSha must be exactly its tree (CHECK_RUN_TREE_MISMATCH). ' +
      'Immutable: a same-id report that differs after normalization is refused (CHECK_RUN_IMMUTABLE), while an identical one returns the stored run with duplicate:true and writes nothing, so supply your own id and reuse it to retry after a crash. ' +
      'The execution identities (outcome, planRevision, environment, dispatchId, attemptId) are optional, REPORTED provenance; only outcome passed, or a legacy report without an outcome at exit 0, can ever satisfy a gate. ' +
      'attemptId must name an attempt of the candidate\'s task (ATTEMPT_NOT_FOUND / ATTEMPT_ID_TASK_MISMATCH), the reviewer\'s included. ' +
      `outputTail keeps its final ${MAX_CHECK_LOG_BYTES} UTF-8 bytes. Other refusals: INVALID_INPUT / MISSING_REQUIRED. No ownership, status or attempt fencing gate.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Optional check-run id (letters, digits, - and _; at most 128 chars). Supply one and reuse it so a retry after a crash is idempotent; omit it and the daemon generates check-<32 hex>.',
        },
        candidateId: {
          type: 'string',
          description: 'The Candidate whose bytes were checked (letters, digits, - and _; at most 128 chars). Must already exist; none is ever created for the caller.',
        },
        treeSha: {
          type: 'string',
          description: 'Tree the check ran against (7-40 hex), as reported. Must equal the candidate\'s treeSha exactly: no prefix match, no case folding.',
        },
        command: {
          type: 'string',
          maxLength: MAX_REQUIRED_CHECK_COMMAND_CHARS,
          description: `The command that was run, recorded verbatim: never trimmed, and never run by the daemon. Non-blank, at most ${MAX_REQUIRED_CHECK_COMMAND_CHARS} UTF-16 code units.`,
        },
        exitCode: {
          type: 'integer',
          description: 'Its exit code: any safe integer, negative included. Zero is not required; a failing run is recorded like a passing one.',
        },
        outputTail: {
          type: 'string',
          description: `Optional end of the output. Stored as its final ${MAX_CHECK_LOG_BYTES} UTF-8 bytes (bytes, not characters), starting on a whole character; absent is stored as "".`,
        },
        runnerId: {
          type: 'string',
          description: 'The runner the report names (letters, digits, - and _; at most 128 chars). Reported, not authenticated; it need not be a registered worker.',
        },
        source: {
          type: 'string',
          enum: Object.keys(SOURCES),
          description: 'Where the result says it came from. Required, never defaulted or inferred: declared provenance, not proof that the command ran.',
        },
        outcome: {
          type: 'string',
          enum: Object.keys(OUTCOMES),
          description: 'Optional: how the run ended. passed requires exitCode 0 and code-failure a nonzero one. Never inferred from exitCode.',
        },
        planRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Optional: the task plan revision the check ran under, as reported.',
        },
        environment: {
          type: 'string',
          description: 'Optional opaque execution-environment identity (e.g. an image digest): at most 255 chars, no control characters, kept verbatim.',
        },
        dispatchId: {
          type: 'string',
          description: 'Optional: the dispatch request this run answers (letters, digits, - and _; at most 128 chars).',
        },
        attemptId: {
          type: 'string',
          description: 'Optional: the attempt the check ran under, the producer\'s or a reviewer\'s. Must belong to the candidate\'s task.',
        },
        workerId: {
          type: 'string',
          description: 'Caller worker ID (auto-injected by proxy). Not evidence of provenance and not stored on the check run.',
        },
      },
      required: ['candidateId', 'treeSha', 'command', 'exitCode', 'runnerId', 'source'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      // The store owns the rules: validating here only yields typed params, and
      // recordCheckRun re-validates idempotently. Errors propagate unchanged; the
      // MCP adapter maps them, so a refusal or failed write is never a success.
      const params = validateCheckRunParams(args);
      const { checkRun, duplicate } = await recordCheckRun(state, params);
      return { success: true, checkRun, duplicate };
    },
  };
}

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { MAX_PUSH_RESULT_CHARS, recordDeliveryReceipt, validateDeliveryReceiptParams } from '../state/receiptStore.js';

// =============================================================================
// moe.record_delivery_receipt — where the wrapper says a candidate's bytes landed
// =============================================================================
//
// Puts state/receiptStore.ts on the wire. Every rule lives in that store, not
// here: the input shape, one receipt per candidate, the identical-replay no-op,
// the refusal of a contradicting report and the candidate having to exist.
//
// WRAPPER-CALLED, NOT FOR AGENTS. The agent wrapper is the only git actor: it
// moves the target ref, then reports the landing here. A coding agent has no
// landing to report, and a receipt it sent would record one nobody performed.
//
// REPORTED, NOT VERIFIED. The daemon runs no git and reads no ref, so a receipt
// is what the wrapper said about a landing it performed, not proof that the
// bytes are where it says.
//
// `duplicate` IS THE REPLAY SIGNAL. false: this call recorded the landing.
// true: the candidate's receipt already said exactly this, and nothing was
// written. A wrapper recovering from a crash between its ref update and this
// call re-sends the same report and reads duplicate:true as "already recorded",
// never as a reason to land again. Inferring that from a missing error instead
// is the ambiguity that makes crash recovery land twice.
//
// No ownership, status or attempt gate: the wrapper lands after complete_task,
// when QA may already hold the task and the attempt may be closed, so the
// candidate is the binding. NOT `blocking`.
// =============================================================================

const TOOL_NAME = 'moe.record_delivery_receipt';

export function recordDeliveryReceiptTool(_state: StateManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Wrapper-called; not for agents. Record a DeliveryReceipt: where the agent wrapper REPORTS one Candidate\'s bytes landed (target ref, where it pointed before and after, the landed revision, and the push result or null when no push was required), as one file at .moe/receipts/<id>.json. ' +
      'At most one receipt per candidate, never rewritten: an identical repeat report returns the stored receipt with duplicate:true and writes nothing, which is how a wrapper replaying a landing after a crash recognizes it as already recorded. A report that differs in any field is refused (DELIVERY_RECEIPT_CONFLICT), as is a candidate that already has two receipts on disk (DELIVERY_RECEIPT_AMBIGUOUS). ' +
      'A new receipt needs an existing candidate (CANDIDATE_NOT_FOUND). The daemon never runs git and verifies nothing about the target: a receipt is a reported landing, not proof. ' +
      `Revisions must be 40 hex; pushResult at most ${MAX_PUSH_RESULT_CHARS} chars. Other refusals: INVALID_INPUT / MISSING_REQUIRED. No ownership, status or attempt gate.`,
    inputSchema: {
      type: 'object',
      properties: {
        candidateId: {
          type: 'string',
          description: 'The Candidate whose bytes landed (letters, digits, - and _; at most 128 chars). It is the receipt\'s key: one receipt per candidate. A new receipt needs the candidate to exist; none is created for the caller.',
        },
        target: {
          type: 'string',
          description: 'The ref the wrapper landed on, e.g. refs/heads/wave1-pilot. Non-blank, no surrounding whitespace or control characters, at most 255 chars. Recorded as reported, even when it is not the candidate\'s deliveryTarget.',
        },
        targetBefore: {
          type: 'string',
          description: 'Where the target pointed before the landing: 40 hex, git\'s all-zero id when the ref did not exist. Recorded as reported; the daemon never reads the ref.',
        },
        targetAfter: {
          type: 'string',
          description: 'Where the target pointed after the landing: 40 hex. Recorded as reported; the daemon never reads the ref.',
        },
        landedRevision: {
          type: 'string',
          description: 'The revision the wrapper landed: 40 hex, never an abbreviation or a ref name. Recorded as reported.',
        },
        pushResult: {
          type: 'string',
          description: `Optional push result, recorded verbatim: non-blank, at most ${MAX_PUSH_RESULT_CHARS} chars. Omit it or send null when the delivery policy required no push; both are stored as null.`,
        },
        workerId: {
          type: 'string',
          description: 'Caller worker ID (auto-injected by proxy). Not evidence of anything, and not stored on the receipt.',
        },
      },
      required: ['candidateId', 'target', 'targetBefore', 'targetAfter', 'landedRevision'],
      additionalProperties: false,
    },
    // The whole body holds the state mutex. Under MCP dispatch that is a
    // reentrant no-op; for any caller that bypasses dispatch it is what stops two
    // reports interleaving between the store's lookup and its write, which would
    // leave two receipts for one candidate. Errors propagate unchanged and the
    // MCP adapter maps them, so a refusal or a failed write is never a success.
    handler: async (args, state) =>
      state.runExclusive(async () => {
        const params = validateDeliveryReceiptParams(args);
        const { receipt, duplicate } = await recordDeliveryReceipt(state, params);
        return { success: true, receipt, duplicate };
      }),
  };
}

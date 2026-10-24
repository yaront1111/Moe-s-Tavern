import { appendFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizeUsage } from './prompt-cache-usage.mjs';

// Only bounded identifiers/configuration are persisted. Provider text, tool
// arguments, prompts, environment values and nominal API costs are excluded.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : null;
const oneOf = (value, allowed) => allowed.includes(value) ? value : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The one context allowlist shared by usage-session.mjs, this writer and
// usage-report.mjs; nothing outside it is ever persisted. The CQ-M02 additions
// (planRevision .. workKind) are optional diagnostic correlation, never trusted
// runner, approval, check or delivery evidence. planRevision and runnerId are
// the canonical Task/ExecutionAttempt values usage-session.mjs snapshots at
// launch preparation; packet, source retrieval, planner, candidate, delivery
// receipt and workKind are observations a producer supplied. Missing or
// invalid values are null (unknown), never 0 or a fabricated id, so receipts
// written before these fields existed remain valid version-1 receipts.
export function normalizeUsageContext(raw) {
  const context = object(raw) ? raw : {};
  return {
    taskId: identifier(context.taskId), workerId: identifier(context.workerId),
    role: oneOf(context.role, ['architect', 'worker', 'qa', 'governor']),
    attemptId: identifier(context.attemptId), launchId: identifier(context.launchId),
    requestedModel: identifier(context.requestedModel), requestedEffort: identifier(context.requestedEffort),
    launchMode: oneOf(context.launchMode, ['headless', 'interactive']),
    planRevision: Number.isSafeInteger(context.planRevision) && context.planRevision >= 0 ? context.planRevision : null,
    packetId: identifier(context.packetId), sourceRetrievalId: identifier(context.sourceRetrievalId),
    plannerInvocationId: identifier(context.plannerInvocationId), runnerId: identifier(context.runnerId),
    candidateId: identifier(context.candidateId), deliveryReceiptId: identifier(context.deliveryReceiptId),
    workKind: oneOf(context.workKind, ['planning', 'context', 'implementation', 'repair', 'qa']),
  };
}

function readContext(raw) {
  let context;
  try { context = typeof raw === 'string' && raw.length <= 16384 ? JSON.parse(raw) : {}; }
  catch { context = {}; }
  return normalizeUsageContext(context);
}

// Read-only diagnostic lookup of one daemon-owned .moe/<kind>/<id>.json. The id
// must be a plain file name (no dot, slash or drive colon, so no traversal) and
// the record a bounded regular file whose own id matches; anything else,
// including any read or parse error, is null and never reported with its path.
const recordId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
export function readMoeRecord(project, kind, id) {
  if (typeof id !== 'string' || !recordId.test(id)) return null;
  try {
    const file = path.join(project, '.moe', kind, `${id}.json`);
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) return null;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return object(record) && record.id === id ? record : null;
  } catch { return null; }
}

function outcome(provider, event) {
  if (!event) return 'unknown';
  if (provider === 'codex') return event.type === 'turn.completed' ? 'success' : 'error';
  if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error_'))) return 'error';
  return event.subtype === 'success' || event.is_error === false ? 'success' : 'unknown';
}

// One writer per stream. PowerShell may invoke it with a single final result;
// identity therefore comes from that result and the wrapper's launch metadata.
// Consumers must also deduplicate receipts by launch/session/event identifiers
// when combining files or receipts emitted by separate helper processes.
export function createUsageReceiptWriter(provider, env = process.env) {
  const file = env.MOE_USAGE_RECEIPT_FILE;
  const context = readContext(env.MOE_USAGE_CONTEXT_JSON);
  const seen = new Set();
  let warned = false;
  let reported = false;
  let pendingTurn = false;
  let finished = false;
  let turnIndex = 0;
  let threadId = null;
  function append(event, coverage = event ? 'reported' : 'missing') {
    if (!file) return;
    try {
      const sessionId = identifier(event?.session_id) ?? (provider === 'codex' ? threadId : null);
      const eventId = identifier(event?.uuid) ?? identifier(event?.turn_id);
      const models = event?.modelUsage;
      const reportedModels = provider === 'claude' && models && typeof models === 'object' && !Array.isArray(models)
        ? Object.keys(models).filter(model => identifier(model)).sort().slice(0, 32) : [];
      const normalizedUsage = normalizeUsage(provider, event?.usage);
      const reportedOutcome = outcome(provider, event);
      const identity = provider === 'claude' ? eventId ?? sessionId : eventId;
      if (event && identity) {
        // Preserve changed variants so aggregation can flag contradictory
        // cumulative counters. Anonymous events have no deduplication proof.
        const key = JSON.stringify([sessionId, eventId, reportedModels, coverage, reportedOutcome, normalizedUsage]);
        if (seen.has(key)) return;
        seen.add(key);
      }
      const receipt = {
        version: 1, timestamp: new Date().toISOString(), provider, ...context,
        sessionId, eventId, reportedModels, scope: provider === 'claude' ? 'session' : 'turn',
        ...(provider === 'codex' ? { turnIndex: event || pendingTurn ? ++turnIndex : null } : {}),
        coverage, outcome: reportedOutcome, usage: normalizedUsage,
      };
      appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Observability must never fail a coding session or leak the destination
      // path / provider data through an exception message.
      if (!warned) {
        warned = true;
        console.error('[usage-receipt] MOE_USAGE_RECEIPT_WRITE_FAILED; usage receipt unavailable.');
      }
    }
  }
  return {
    start() { append(null, 'pending'); },
    event(event) {
      if (provider === 'codex' && event?.type === 'thread.started') threadId = identifier(event.thread_id);
      if (provider === 'codex' && event?.type === 'turn.started') pendingTurn = true;
      if ((provider === 'claude' && event?.type === 'result') ||
          (provider === 'codex' && ['turn.completed', 'turn.failed'].includes(event?.type))) {
        reported = true;
        append(event);
        pendingTurn = false;
      }
    },
    finish() {
      if (!finished && (!reported || pendingTurn)) append(null);
      finished = true;
    },
  };
}

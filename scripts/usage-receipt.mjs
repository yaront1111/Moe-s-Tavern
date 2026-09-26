import { appendFileSync } from 'node:fs';
import { normalizeUsage } from './prompt-cache-usage.mjs';

// Only bounded identifiers/configuration are persisted. Provider text, tool
// arguments, prompts, environment values and nominal API costs are excluded.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : null;
const oneOf = (value, allowed) => allowed.includes(value) ? value : null;
function readContext(raw) {
  let context;
  try { context = typeof raw === 'string' && raw.length <= 16384 ? JSON.parse(raw) : {}; }
  catch { context = {}; }
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
  return {
    taskId: identifier(context.taskId), workerId: identifier(context.workerId),
    role: oneOf(context.role, ['architect', 'worker', 'qa', 'governor']),
    attemptId: identifier(context.attemptId), launchId: identifier(context.launchId),
    requestedModel: identifier(context.requestedModel), requestedEffort: identifier(context.requestedEffort),
    launchMode: oneOf(context.launchMode, ['headless', 'interactive']),
  };
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

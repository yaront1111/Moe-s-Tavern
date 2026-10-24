import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeUsageContext, readMoeRecord } from './usage-receipt.mjs';

const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (...values) => JSON.stringify(values);
const metadataFields = ['roles', 'requestedModels', 'requestedEfforts', 'reportedModels'];
const metadata = rows => Object.fromEntries(metadataFields.map(field =>
  [field, [...new Set(rows.flatMap(row => row[field]))].sort()]));
// CQ-M02 correlation stays whole observed tuples (explicit nulls included), never
// independent ID lists, so no association is made that one receipt did not carry.
const tupleFields = ['role', 'workerId', 'attemptId', 'runnerId', 'planRevision', 'workKind', 'packetId',
  'sourceRetrievalId', 'plannerInvocationId', 'candidateId', 'deliveryReceiptId'];
const MAX_LISTED = 32;
const tupleOf = row => { const context = normalizeUsageContext(row); return Object.fromEntries(tupleFields.map(field => [field, context[field]])); };
const uniqueTuples = tuples => [...new Map(tuples.map(tuple => [key(...tupleFields.map(field => tuple[field])), tuple]))]
  .sort(([a], [b]) => a.localeCompare(b)).map(([, tuple]) => tuple);

function normalizeUsage(raw, stats) {
  const usage = {};
  for (const field of fields) {
    usage[field] = count(raw[field]) ? raw[field] : null;
    if (raw[field] != null && usage[field] === null) stats.invalidCounters++;
  }
  if (usage.reasoningTokens !== null && usage.outputTokens !== null && usage.reasoningTokens > usage.outputTokens) {
    usage.reasoningTokens = null; stats.invalidCounters++;
  }
  if (usage.cacheReadTokens !== null && usage.inputTokens !== null && usage.cacheReadTokens > usage.inputTokens) {
    usage.cacheReadTokens = null; stats.invalidCounters++;
  }
  const sum = usage.inputTokens === null || usage.outputTokens === null ? null : usage.inputTokens + usage.outputTokens;
  if (usage.totalTokens !== null && (!count(sum) || usage.totalTokens !== sum)) {
    usage.totalTokens = null; stats.invalidCounters++;
  }
  return usage;
}

function readReceipts(directory, stats) {
  let names;
  try { names = readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') stats.unreadableFiles++; return []; }
  const records = [];
  for (const name of names) {
    stats.files++;
    let body;
    try { body = readFileSync(path.join(directory, name), 'utf8'); }
    catch { stats.unreadableFiles++; continue; }
    if (!body.trim()) stats.emptyFiles++;
    for (const line of body.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())) {
      let row;
      try { row = JSON.parse(line); } catch { stats.malformedLines++; continue; }
      if (!object(row) || row.version !== 1 || !['claude', 'codex'].includes(row.provider)
        || row.scope !== (row.provider === 'claude' ? 'session' : 'turn')
        || !['success', 'error', 'unknown'].includes(row.outcome) || !object(row.usage)) {
        stats.invalidRecords++; continue;
      }
      records.push({ provider: row.provider, scope: row.scope, outcome: row.outcome, coverage: row.coverage,
        taskId: text(row.taskId), launchId: text(row.launchId), sessionId: text(row.sessionId), eventId: text(row.eventId),
        roles: ['architect', 'worker', 'qa', 'governor'].includes(row.role) ? [row.role] : [],
        requestedModels: [text(row.requestedModel)].filter(Boolean), requestedEfforts: [text(row.requestedEffort)].filter(Boolean),
        reportedModels: Array.isArray(row.reportedModels) ? row.reportedModels.map(text).filter(Boolean) : [],
        correlations: [tupleOf(row)], usage: normalizeUsage(row.usage, stats) });
    }
  }
  return records;
}

function supersedeInitial(records, stats) {
  const initial = row => row.coverage === 'pending' && row.outcome === 'unknown' && !row.eventId && !row.sessionId
    && fields.every(field => row.usage[field] === null);
  const observed = new Set(records.filter(row => !initial(row) && row.launchId).map(row => key(row.provider, row.launchId)));
  const unknownLaunches = new Set();
  return records.filter(row => {
    if (!initial(row) || !row.launchId) return true;
    const id = key(row.provider, row.launchId);
    if (observed.has(id)) { stats.supersededUnknownRecords++; return false; }
    if (unknownLaunches.has(id)) { stats.duplicateRecords++; return false; }
    unknownLaunches.add(id);
    return true;
  });
}

function identifiedGroups(records, stats) {
  const identities = new Map();
  const groups = new Set();
  for (const row of records) {
    const ids = [];
    // Missing usage belongs to that failed/incomplete launch, never to an older
    // measured cumulative result for a resumed Claude session.
    if (row.scope === 'session' && row.sessionId && !['missing', 'pending'].includes(row.coverage)) {
      ids.push(key(row.provider, 'session', row.sessionId));
    }
    if (row.eventId) ids.push(key(row.provider, row.scope, row.coverage === 'missing' ? 'missing-event' : 'event', row.eventId));
    if (!ids.length) stats.unidentifiedRecords++;
    const matched = new Set(ids.map(id => identities.get(id)).filter(Boolean));
    const group = { rows: [row], ids: new Set(ids) };
    for (const prior of matched) {
      group.rows.push(...prior.rows);
      for (const id of prior.ids) group.ids.add(id);
      groups.delete(prior);
    }
    for (const id of group.ids) identities.set(id, group);
    groups.add(group);
  }
  return [...groups].map(group => mergeGroup(group.rows, stats));
}

function mergeGroup(rows, stats) {
  stats.duplicateRecords += rows.length - 1;
  const usage = {};
  let conflict = false;
  for (const field of fields) {
    const values = new Set(rows.map(row => row.usage[field]).filter(value => value !== null));
    usage[field] = values.size === 1 ? [...values][0] : null;
    if (values.size > 1) conflict = true;
  }
  // An input/output disagreement also invalidates any derived total.
  if (usage.inputTokens === null || usage.outputTokens === null) usage.totalTokens = null;
  const tasks = new Set(rows.map(row => row.taskId).filter(Boolean));
  const outcomes = new Set(rows.map(row => row.outcome).filter(value => value !== 'unknown'));
  if (tasks.size > 1 || outcomes.size > 1) conflict = true;
  if (conflict) stats.conflictingGroups++;
  // Differing correlation on one deduplicated observation stays visible as several
  // tuples; it neither picks a latest value nor invalidates valid counters.
  const correlations = uniqueTuples(rows.flatMap(row => row.correlations));
  if (correlations.length > 1) stats.ambiguousCorrelationGroups++;
  return { provider: rows[0].provider, taskId: tasks.size === 1 ? [...tasks][0] : null,
    launches: [...new Set(rows.map(row => row.launchId).filter(Boolean))],
    outcome: outcomes.size === 1 ? [...outcomes][0] : 'unknown', ...metadata(rows), correlations, usage };
}

function aggregate(rows) {
  const usage = {};
  const overflowFields = [];
  for (const field of fields) {
    const values = rows.map(row => row.usage[field]).filter(value => value !== null);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!count(total)) overflowFields.push(field);
    usage[field] = { observedTokens: values.length && count(total) ? total : null,
      unknownRecords: rows.length - values.length };
  }
  return { records: rows.length, launches: new Set(rows.flatMap(row => row.launches)).size,
    errors: rows.filter(row => row.outcome === 'error').length,
    unknownOutcomes: rows.filter(row => row.outcome === 'unknown').length, ...metadata(rows), usage, overflowFields };
}

function taskRecords(project, warnings) {
  const directory = path.join(project, '.moe/tasks');
  const tasks = new Map();
  let names;
  try { names = readdirSync(directory).filter(name => name.endsWith('.json')).sort(); }
  catch (error) {
    if (error.code !== 'ENOENT') warnings.push('Task records could not be read; task status is unknown.');
    return tasks;
  }
  for (const name of names) {
    try {
      const task = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      if (!object(task) || !text(task.id) || tasks.has(task.id)) throw new Error('invalid task record');
      tasks.set(task.id, { evidence: 'record-only', status: text(task.status),
        reopenCount: count(task.reopenCount) ? task.reopenCount : null,
        metricsReopenCount: count(task.metrics?.reopenCount) ? task.metrics.reopenCount : null,
        recordedQaRejections: Array.isArray(task.rejectionHistory) ? task.rejectionHistory.length : null,
        hasRecordedCompletionCommit: Array.isArray(task.commits)
          ? task.commits.some(commit => object(commit) && commit.kind === 'completion' && text(commit.sha)) : null });
    } catch { warnings.push('A task record is unreadable, invalid, or duplicated; task metadata may be incomplete.'); }
  }
  return tasks;
}

function grouped(rows, taskMap) {
  const groups = new Map();
  for (const row of rows) {
    const id = key(row.provider, row.taskId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups.values()].map(entries => ({ provider: entries[0].provider, taskId: entries[0].taskId,
    ...aggregate(entries), taskRecord: entries[0].taskId ? taskMap.get(entries[0].taskId) ?? null : null }))
    .sort((a, b) => key(a.provider, a.taskId).localeCompare(key(b.provider, b.taskId)));
}

// Delivery is joined read-only at report time (landing follows the provider
// receipt). Only ids and landedRevision leave here, never targets, push results
// or paths; a receipt is the wrapper's report (record-only), not proof.
function deliveryRecords(project) {
  let incomplete = false;
  const read = kind => {
    try { return readdirSync(path.join(project, '.moe', kind)).filter(name => name.endsWith('.json')).sort()
      .map(name => readMoeRecord(project, kind, name.slice(0, -5))); }
    catch (error) { if (error.code !== 'ENOENT') incomplete = true; return []; }
  };
  const listed = read('candidates');
  const candidates = listed.filter(candidate => candidate && text(candidate.taskId) && text(candidate.attemptId));
  if (candidates.length < listed.length) incomplete = true;
  const receipts = new Map();
  for (const receipt of read('receipts')) {
    if (typeof receipt?.landedRevision !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(receipt.landedRevision) || !text(receipt.candidateId)) { incomplete = true; continue; }
    receipts.set(receipt.candidateId, [...(receipts.get(receipt.candidateId) ?? []), receipt]);
  }
  return { candidates, receipts, incomplete };
}

// Joins candidates only through attempts observed in this task's tuples. Bad
// records, a candidate naming another task, two receipts for one candidate or
// an unconfirmed claimed id are incomplete; no observed attempt is unknown.
// DONE status and completion commits are never read as delivery.
function taskDelivery(taskId, rows, records) {
  const tuples = rows.flatMap(row => row.correlations);
  const attempts = new Set(tuples.map(tuple => tuple.attemptId).filter(Boolean));
  let incomplete = records.incomplete;
  const joined = [];
  for (const candidate of records.candidates) {
    if (!attempts.has(candidate.attemptId)) continue;
    if (candidate.taskId !== taskId) { incomplete = true; continue; }
    const receipts = records.receipts.get(candidate.id) ?? [];
    if (receipts.length > 1) incomplete = true;
    const receipt = receipts.length === 1 ? receipts[0] : null;
    joined.push({ candidateId: candidate.id, attemptId: candidate.attemptId, deliveryReceiptId: receipt?.id ?? null, landedRevision: receipt?.landedRevision ?? null });
  }
  const candidateIds = new Set(joined.map(row => row.candidateId));
  const receiptIds = new Set(joined.map(row => row.deliveryReceiptId).filter(Boolean));
  if (tuples.some(tuple => (tuple.candidateId && !candidateIds.has(tuple.candidateId)) || (tuple.deliveryReceiptId && !receiptIds.has(tuple.deliveryReceiptId)))) incomplete = true;
  const status = !attempts.size ? 'unknown' : incomplete ? 'incomplete' : receiptIds.size ? 'recorded' : 'not-recorded';
  return { evidence: 'record-only', status, candidates: joined.slice(0, MAX_LISTED), omittedCandidates: Math.max(0, joined.length - MAX_LISTED) };
}

// One row per taskId across roles and providers, from already-deduplicated
// observations: retries never add tokens, separate planning/context/repair
// sessions do. Coverage is observed log records only (not proof that every
// participant was captured); a cumulative session is never split by phase.
function wholeTasks(rows, taskMap, records) {
  const groups = new Map();
  for (const row of rows) if (row.taskId) groups.set(row.taskId, [...(groups.get(row.taskId) ?? []), row]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, entries]) => {
    const tuples = uniqueTuples(entries.flatMap(row => row.correlations));
    return { taskId, providers: [...new Set(entries.map(row => row.provider))].sort(), ...aggregate(entries), coverageScope: 'observed-log-records-only',
      correlation: { tuples: tuples.slice(0, MAX_LISTED), omittedTuples: Math.max(0, tuples.length - MAX_LISTED),
        ambiguousRecords: entries.filter(row => row.correlations.length > 1).length,
        unknownRecords: Object.fromEntries(tupleFields.map(field => [field, entries.filter(row => row.correlations.every(tuple => tuple[field] === null)).length])) },
      delivery: taskDelivery(taskId, entries, records), taskRecord: taskMap.get(taskId) ?? null };
  });
}

export function buildUsageReport(project) {
  const warnings = [];
  const stats = { files: 0, emptyFiles: 0, malformedLines: 0, invalidRecords: 0, unreadableFiles: 0, invalidCounters: 0,
    supersededUnknownRecords: 0, duplicateRecords: 0, unidentifiedRecords: 0, conflictingGroups: 0, ambiguousCorrelationGroups: 0 };
  const rows = identifiedGroups(supersedeInitial(readReceipts(path.join(project, 'logs/moe-usage'), stats), stats), stats);
  const summary = { ...stats, ...aggregate(rows), coverageScope: 'observed-log-records-only' };
  const hasCodex = rows.some(row => row.provider === 'codex');
  summary.codexStreamCoverage = hasCodex ? 'unconfirmed' : 'not-observed';
  summary.coverageComplete = rows.length > 0 && !hasCodex && summary.usage.totalTokens.unknownRecords === 0
    && !summary.overflowFields.length && !stats.malformedLines && !stats.invalidRecords && !stats.unreadableFiles
    && !stats.invalidCounters && !stats.unidentifiedRecords && !stats.conflictingGroups && !summary.unknownOutcomes && !stats.emptyFiles;
  if (!rows.length) warnings.push('No usage receipts are available; consumption is unknown, not zero.');
  if (stats.malformedLines || stats.invalidRecords || stats.unreadableFiles) warnings.push('Malformed, invalid, or unreadable usage logs leave coverage incomplete.');
  if (stats.emptyFiles) warnings.push('Some usage receipt files are empty; their consumption is unknown.');
  if (stats.invalidCounters) warnings.push('Invalid or inconsistent counters were treated as unknown.');
  if (stats.unidentifiedRecords) warnings.push('Some records lack durable event/session identity and cannot be safely deduplicated.');
  if (stats.conflictingGroups) warnings.push('Conflicting identified receipts leave counters, outcomes, or task attribution unknown.');
  if (summary.overflowFields.length) warnings.push('Aggregate counters overflowed; affected totals are unknown.');
  if (summary.usage.totalTokens.unknownRecords) warnings.push('Some records have unknown usage; observed totals exclude that unmeasured consumption.');
  if (hasCodex) warnings.push('Codex completed turns do not prove the usage stream closed; launch/stream coverage is unconfirmed.');
  const taskMap = taskRecords(project, warnings);
  const groups = grouped(rows, taskMap);
  const whole = wholeTasks(rows, taskMap, deliveryRecords(project));
  if (stats.ambiguousCorrelationGroups) warnings.push('Some deduplicated records carry conflicting correlation metadata; their revision, packet, attempt or work-kind association is ambiguous.');
  if (whole.some(task => task.delivery.status === 'incomplete')) warnings.push('Delivery correlation is incomplete: candidate or delivery receipt records are unreadable, malformed, conflicting, or mismatched.');
  const providers = [...new Set(rows.map(row => row.provider))].sort().map(provider =>
    ({ provider, ...aggregate(rows.filter(row => row.provider === provider)) }));
  return { version: 1, project: path.resolve(project), summary, providers,
    tasks: groups.filter(group => group.taskId), unattributed: groups.filter(group => !group.taskId), wholeTasks: whole, warnings };
}

export function formatUsageReport(report) {
  const display = metric => `${metric.observedTokens ?? 'unknown'}${metric.unknownRecords ? ` (+${metric.unknownRecords} unknown records)` : ''}`;
  const lines = [`Usage records: ${report.summary.records}; observed log coverage: ${report.summary.coverageComplete ? 'complete' : 'incomplete'}`,
    `Observed total tokens: ${display(report.summary.usage.totalTokens)}`,
    `Reasoning tokens (subset of output): ${display(report.summary.usage.reasoningTokens)}`,
    'Task status and completion commits are record-only; delivery and QA acceptance are not independently verified.'];
  for (const row of report.tasks) {
    lines.push(`${row.provider} ${row.taskId}: ${display(row.usage.totalTokens)} tokens; launches=${row.launches}; status=${row.taskRecord?.status ?? 'unknown'}; recorded completion=${row.taskRecord?.hasRecordedCompletionCommit ?? 'unknown'}`);
    lines.push(`  roles=${row.roles.join(',') || 'unknown'}; reported models=${row.reportedModels.join(',') || 'unknown'}; requested models (intent)=${row.requestedModels.join(',') || 'unknown'}; requested effort (intent)=${row.requestedEfforts.join(',') || 'unknown'}`);
  }
  for (const row of report.unattributed) lines.push(`Unattributed ${row.provider}: ${display(row.usage.totalTokens)} tokens; launches=${row.launches}`);
  for (const row of report.wholeTasks) {
    lines.push(`Whole task ${row.taskId}: ${display(row.usage.totalTokens)} tokens; providers=${row.providers.join(',')}; roles=${row.roles.join(',') || 'unknown'}; launches=${row.launches}; delivery=${row.delivery.status} (record-only)`);
    lines.push(`  correlation tuples=${row.correlation.tuples.length + row.correlation.omittedTuples}; ambiguous records=${row.correlation.ambiguousRecords}; unknown plan revision records=${row.correlation.unknownRecords.planRevision}`);
  }
  if (report.wholeTasks.length) lines.push('Whole-task rows cover observed log records only: planning, context or repair participation may be missing, and a cumulative session is never split between phases or revisions.');
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push('Token observations do not establish subscription quota consumption or monetary cost.');
  return lines.join('\n');
}

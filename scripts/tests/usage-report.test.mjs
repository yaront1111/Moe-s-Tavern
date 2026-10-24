import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../analyze-usage.mjs', import.meta.url));
const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens'];
const measured = { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100,
  uncachedInputTokens: 100, outputTokens: 200, reasoningTokens: 50, totalTokens: 1200 };
const unknown = Object.fromEntries(fields.map(key => [key, null]));
const receipt = (overrides = {}) => ({ version: 1, timestamp: '2026-09-26T12:00:00Z', provider: 'claude',
  taskId: 'task-A', workerId: 'worker-A', role: 'worker', attemptId: 'attempt-A', launchId: 'launch-A',
  requestedModel: 'strong-model', requestedEffort: 'max', launchMode: 'headless',
  sessionId: 'session-A', eventId: 'event-A', reportedModels: ['strong-model'],
  scope: 'session', coverage: 'reported', outcome: 'success', usage: { ...measured }, ...overrides });

function fixture(t, files = {}, tasks = []) {
  const project = mkdtempSync(path.join(tmpdir(), 'moe usage report '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const logs = path.join(project, 'logs/moe-usage');
  mkdirSync(logs, { recursive: true });
  for (const [name, rows] of Object.entries(files)) {
    writeFileSync(path.join(logs, name), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  }
  if (tasks.length) {
    mkdirSync(path.join(project, '.moe/tasks'), { recursive: true });
    for (const task of tasks) writeFileSync(path.join(project, '.moe/tasks', `${task.id}.json`), JSON.stringify(task));
  }
  return { project, logs };
}

function run(project, json = true) {
  const result = spawnSync(process.execPath, [cli, '--project', project, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

test('groups measured usage by provider and task without adding the reasoning subset', t => {
  const codex = receipt({ provider: 'codex', scope: 'turn', launchId: 'launch-B', sessionId: 'thread-B',
    eventId: 'turn-B', usage: { ...measured, cacheWriteTokens: null, uncachedInputTokens: 200 } });
  const { project } = fixture(t, { 'one.jsonl': [receipt()], 'two.jsonl': [codex] });
  const report = run(project);
  assert.equal(report.tasks.length, 2);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 2400, unknownRecords: 0 });
  assert.deepEqual(report.summary.usage.reasoningTokens, { observedTokens: 100, unknownRecords: 0 });
  assert.deepEqual(report.summary.usage.cacheWriteTokens, { observedTokens: 100, unknownRecords: 1 });
  assert.equal(report.summary.coverageComplete, false, 'completed Codex turns cannot establish a closed stream');
  assert.equal(report.providers.length, 2);
  assert.equal(report.unattributed.length, 0);
});

test('supersedes initial unknown receipts per launch but preserves a failed resumed launch', t => {
  const initial = receipt({ sessionId: null, eventId: null, reportedModels: [], coverage: 'pending', outcome: 'unknown', usage: unknown });
  const failedResume = { ...initial, launchId: 'launch-resume' };
  const { project } = fixture(t, { 'first.jsonl': [initial, receipt()], 'resume.jsonl': [failedResume] });
  const report = run(project);
  assert.equal(report.summary.supersededUnknownRecords, 1);
  assert.equal(report.summary.records, 2);
  assert.equal(report.tasks[0].launches, 2);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 1200, unknownRecords: 1 });
  assert.equal(report.summary.coverageComplete, false);
});

test('deduplicates cumulative Claude sessions across files and enriches missing fields', t => {
  const partial = receipt({ usage: { ...measured, reasoningTokens: null, cacheWriteTokens: null } });
  const { project } = fixture(t, { 'one.jsonl': [partial, receipt()],
    'copied.jsonl': [receipt({ eventId: 'different-final-id', launchId: 'launch-B' })] });
  const report = run(project);
  assert.equal(report.summary.duplicateRecords, 2);
  assert.equal(report.summary.records, 1);
  assert.equal(report.tasks[0].launches, 2);
  assert.equal(report.summary.usage.totalTokens.observedTokens, 1200);
  assert.equal(report.summary.usage.reasoningTokens.observedTokens, 50);
});

test('conflicting cumulative counters remain unknown and cannot become a complete report', t => {
  const conflict = receipt({ usage: { ...measured, inputTokens: 1100, totalTokens: 1300 } });
  const { project } = fixture(t, { 'one.jsonl': [receipt(), conflict, receipt()] });
  const report = run(project);
  assert.equal(report.summary.conflictingGroups, 1);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: null, unknownRecords: 1 });
  assert.equal(report.summary.coverageComplete, false);
  assert.match(report.warnings.join(' '), /conflict/i);
});

test('Codex turn indexes cannot deduplicate legitimate unidentified turns', t => {
  const turn = receipt({ provider: 'codex', scope: 'turn', sessionId: 'thread-A', eventId: null, turnIndex: 1,
    usage: { ...measured, cacheWriteTokens: null, uncachedInputTokens: 200 } });
  const identified = { ...turn, eventId: 'turn-known' };
  const { project } = fixture(t, { 'a.jsonl': [turn, identified], 'b.jsonl': [turn, identified] });
  const report = run(project);
  assert.equal(report.summary.records, 3);
  assert.equal(report.summary.duplicateRecords, 1);
  assert.equal(report.summary.unidentifiedRecords, 2);
  assert.equal(report.summary.usage.totalTokens.observedTokens, 3600);
  assert.equal(report.summary.coverageComplete, false);
});

test('keeps unattributed usage separate and presents task state as record-only', t => {
  const task = { id: 'task-A', status: 'DONE', reopenCount: 2, metrics: { reopenCount: 3 },
    rejectionHistory: [{ rejectedAt: '2026-09-20' }], commits: [{ kind: 'checkpoint', sha: 'abc' }] };
  const { project } = fixture(t, { 'a.jsonl': [receipt(), receipt({ taskId: null, sessionId: 'other', eventId: 'other-event' })] }, [task]);
  const report = run(project);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.unattributed.length, 1);
  assert.deepEqual(report.tasks[0].taskRecord, { evidence: 'record-only', status: 'DONE', reopenCount: 2,
    metricsReopenCount: 3, recordedQaRejections: 1, hasRecordedCompletionCommit: false });
  assert.doesNotMatch(JSON.stringify(report), /costPer|acceptedDelivered|quotaSaved/);
  const text = run(project, false);
  assert.match(text, /record-only/);
  assert.match(text, /Unattributed/);
});

test('malformed and invalid log records expose coverage gaps while preserving valid observations', t => {
  const { project } = fixture(t, { 'a.jsonl': [receipt(), '{broken', { version: 2 }, 'null'] });
  const report = run(project);
  assert.equal(report.summary.malformedLines, 1);
  assert.equal(report.summary.invalidRecords, 2);
  assert.equal(report.summary.usage.totalTokens.observedTokens, 1200);
  assert.equal(report.summary.coverageComplete, false);
  assert.match(report.warnings.join(' '), /malformed|invalid/);
});

test('invalid and inconsistent counters stay unknown and overflow never creates a total', t => {
  const bad = receipt({ usage: { ...measured, inputTokens: -1, reasoningTokens: 201, totalTokens: 1200 } });
  const huge = receipt({ sessionId: 'huge-A', eventId: 'huge-event-A', usage: { ...unknown, inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER } });
  const { project } = fixture(t, { 'a.jsonl': [bad, huge, { ...huge, sessionId: 'huge-B', eventId: 'huge-event-B' }] });
  const report = run(project);
  assert.ok(report.summary.invalidCounters > 0);
  assert.equal(report.summary.usage.totalTokens.observedTokens, null);
  assert.ok(report.summary.overflowFields.includes('totalTokens'));
  assert.equal(report.summary.coverageComplete, false);
});

test('missing logs are unknown and inspection never writes project files', t => {
  const { project, logs } = fixture(t, { 'a.jsonl': [receipt()] });
  const before = readFileSync(path.join(logs, 'a.jsonl'), 'utf8');
  run(project);
  assert.deepEqual(readdirSync(logs), ['a.jsonl']);
  assert.equal(readFileSync(path.join(logs, 'a.jsonl'), 'utf8'), before);
  rmSync(logs, { recursive: true });
  const empty = run(project);
  assert.equal(empty.summary.records, 0);
  assert.equal(empty.summary.usage.totalTokens.observedTokens, null);
  assert.equal(empty.summary.coverageComplete, false);
  assert.match(empty.warnings.join(' '), /no usage receipts/i);
});

test('conflicting task attribution for one session moves its usage to unattributed', t => {
  const { project } = fixture(t, { 'a.jsonl': [receipt(), receipt({ taskId: 'task-B' })] });
  const report = run(project);
  assert.equal(report.tasks.length, 0);
  assert.equal(report.unattributed.length, 1);
  assert.equal(report.summary.conflictingGroups, 1);
  assert.equal(report.summary.coverageComplete, false);
});

test('terminal missing Codex usage survives a successful earlier turn from the same launch', t => {
  const pending = receipt({ provider: 'codex', scope: 'turn', coverage: 'pending', outcome: 'unknown',
    sessionId: null, eventId: null, usage: unknown });
  const complete = receipt({ provider: 'codex', scope: 'turn', sessionId: 'thread-A', eventId: 'turn-A',
    usage: { ...measured, cacheWriteTokens: null, uncachedInputTokens: 200 } });
  const missing = { ...pending, coverage: 'missing', turnIndex: 2 };
  const { project } = fixture(t, { 'a.jsonl': [pending, complete, missing] });
  const report = run(project);
  assert.equal(report.summary.supersededUnknownRecords, 1);
  assert.equal(report.summary.records, 2);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 1200, unknownRecords: 1 });
  assert.equal(report.summary.coverageComplete, false);
});

test('missing usage on a resumed Claude launch is never filled from the prior successful launch', t => {
  const missing = receipt({ launchId: 'launch-resume', eventId: null, coverage: 'missing', outcome: 'unknown', usage: unknown });
  const { project } = fixture(t, { 'a.jsonl': [receipt()], 'b.jsonl': [missing] });
  const report = run(project);
  assert.equal(report.summary.records, 2);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 1200, unknownRecords: 1 });
  assert.equal(report.summary.coverageComplete, false);
});

test('empty receipt files preserve an explicit coverage gap', t => {
  const { project } = fixture(t, { 'a.jsonl': [receipt()], 'crashed.jsonl': [] });
  const report = run(project);
  assert.equal(report.summary.emptyFiles, 1);
  assert.equal(report.summary.coverageComplete, false);
  assert.match(report.warnings.join(' '), /empty/);
});

test('retains observed roles and separates requested models from provider-reported models', t => {
  const qa = receipt({ role: 'qa', requestedModel: 'configured-alias', requestedEffort: 'xhigh',
    reportedModels: ['provider-primary', 'provider-secondary'] });
  const { project } = fixture(t, { 'a.jsonl': [receipt(), qa] });
  const report = run(project);
  assert.deepEqual(report.tasks[0].roles, ['qa', 'worker']);
  assert.deepEqual(report.tasks[0].requestedModels, ['configured-alias', 'strong-model']);
  assert.deepEqual(report.tasks[0].requestedEfforts, ['max', 'xhigh']);
  assert.deepEqual(report.tasks[0].reportedModels, ['provider-primary', 'provider-secondary', 'strong-model']);
  assert.equal(report.summary.usage.totalTokens.observedTokens, 1200);
  assert.equal(report.summary.coverageScope, 'observed-log-records-only');
  assert.match(run(project, false), /requested models \(intent\)/);
});

test('an unreadable receipt beside a successful receipt leaves log coverage incomplete', t => {
  const { project, logs } = fixture(t, { 'a.jsonl': [receipt()] });
  mkdirSync(path.join(logs, 'unreadable.jsonl'));
  const report = run(project);
  assert.equal(report.summary.unreadableFiles, 1);
  assert.equal(report.summary.coverageComplete, false);
});

test('a Codex crash after its first result cannot imply a closed usage stream', t => {
  const pending = receipt({ provider: 'codex', scope: 'turn', coverage: 'pending', outcome: 'unknown',
    sessionId: null, eventId: null, usage: unknown });
  const complete = receipt({ provider: 'codex', scope: 'turn', sessionId: 'thread-A', eventId: 'turn-A',
    usage: { ...measured, cacheWriteTokens: null, uncachedInputTokens: 200 } });
  // The process dies during another turn; neither finish() nor a terminal missing receipt runs.
  const { project } = fixture(t, { 'crashed.jsonl': [pending, complete] });
  const report = run(project);
  assert.equal(report.summary.supersededUnknownRecords, 1);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 1200, unknownRecords: 0 });
  assert.equal(report.summary.codexStreamCoverage, 'unconfirmed');
  assert.equal(report.summary.coverageComplete, false);
  assert.match(report.warnings.join(' '), /completed turns.*closed|completed turn.*closed/i);
});

// CQ-M02 whole-task correlation. Fixtures use the receipt writer's additive
// fields; absent producers remain null and delivery joins stay record-only.
const tupleFields = ['role', 'workerId', 'attemptId', 'runnerId', 'planRevision', 'workKind', 'packetId',
  'sourceRetrievalId', 'plannerInvocationId', 'candidateId', 'deliveryReceiptId'];
const blank = Object.fromEntries(tupleFields.slice(1).map(field => [field, null]));
const row = (overrides = {}) => receipt({ ...blank, workerId: 'worker-1', ...overrides });
const tokens = (input, output, extra = {}) => ({ ...unknown, inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra });
const tuple = values => Object.fromEntries(tupleFields.map(field => [field, values[field] ?? null]));
const hex = 'a'.repeat(40);
function writeRecords(project, kind, records) {
  mkdirSync(path.join(project, '.moe', kind), { recursive: true });
  for (const [name, body] of Object.entries(records)) {
    writeFileSync(path.join(project, '.moe', kind, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
}

test('whole-task rows combine every participating role and provider after retry deduplication', t => {
  const plan = row({ role: 'architect', workerId: 'architect-1', attemptId: null, launchId: 'launch-plan', sessionId: 'session-plan',
    eventId: 'event-plan', planRevision: 1, plannerInvocationId: 'planner-1', workKind: 'planning', usage: tokens(800, 200) });
  const pendingPlan = { ...plan, sessionId: null, eventId: null, coverage: 'pending', outcome: 'unknown', usage: unknown };
  const worker = { role: 'worker', attemptId: 'attempt-1', runnerId: 'runner-1', planRevision: 2, packetId: 'packet-1' };
  const context = row({ ...worker, launchId: 'launch-context', sessionId: 'session-context', eventId: 'event-context',
    sourceRetrievalId: 'retrieval-1', workKind: 'context', usage: tokens(250, 50) });
  const implementation = row({ ...worker, launchId: 'launch-impl', sessionId: 'session-impl', eventId: 'event-impl',
    workKind: 'implementation', usage: tokens(4000, 1000) });
  const repair = { provider: 'codex', scope: 'turn', role: 'worker', attemptId: 'attempt-2', runnerId: 'runner-2', planRevision: 3,
    workKind: 'repair', launchId: 'launch-repair', sessionId: 'thread-repair', requestedModel: 'codex-model', reportedModels: [] };
  const turn1 = row({ ...repair, eventId: 'turn-1', usage: tokens(1500, 500, { cacheReadTokens: 1000, uncachedInputTokens: 500 }) });
  const turn2 = row({ ...repair, eventId: 'turn-2', usage: tokens(600, 400) });
  const anonymous = row({ ...repair, eventId: null, turnIndex: 3, usage: tokens(90, 10) });
  const qa = { role: 'qa', workerId: 'qa-1', attemptId: null, planRevision: 3, workKind: 'qa' };
  const review = row({ ...qa, launchId: 'launch-qa', sessionId: 'session-qa', eventId: 'event-qa', usage: tokens(600, 100) });
  const crashed = row({ ...qa, launchId: 'launch-qa-crash', sessionId: null, eventId: null, coverage: 'missing', outcome: 'unknown', usage: unknown });
  const secrets = { prompt: 'SECRET prompt', toolArguments: { command: 'SECRET' }, costUSD: 42 };
  const { project } = fixture(t, {
    'plan.jsonl': [pendingPlan, { ...plan, ...secrets }], 'context.jsonl': [context],
    'impl.jsonl': [implementation], 'retry.jsonl': [{ ...implementation, launchId: 'launch-impl-retry' }],
    'repair.jsonl': [turn1, turn2, anonymous], 'qa.jsonl': [review, crashed], 'copy.jsonl': [plan, turn1],
    'other.jsonl': [row({ taskId: 'task-other', sessionId: 'session-other', eventId: 'event-other', usage: tokens(900, 99) }),
      row({ taskId: null, sessionId: 'session-none', eventId: 'event-none', usage: tokens(40, 10) })],
  });
  const report = run(project);
  assert.equal(report.summary.supersededUnknownRecords, 1);
  assert.equal(report.summary.duplicateRecords, 3, 'plan copy, retry launch and copied Codex turn');
  assert.equal(report.summary.unidentifiedRecords, 2);
  assert.deepEqual(report.summary.usage.totalTokens, { observedTokens: 11149, unknownRecords: 1 });
  assert.deepEqual(report.wholeTasks.map(task => task.taskId), ['task-A', 'task-other']);
  const taskA = report.wholeTasks.find(task => task.taskId === 'task-A');
  assert.deepEqual(taskA.providers, ['claude', 'codex']);
  assert.deepEqual(taskA.roles, ['architect', 'qa', 'worker']);
  assert.equal(taskA.records, 8);
  assert.equal(taskA.launches, 7);
  assert.equal(taskA.unknownOutcomes, 1);
  assert.deepEqual(taskA.usage.totalTokens, { observedTokens: 10100, unknownRecords: 1 });
  assert.deepEqual(taskA.usage.cacheReadTokens, { observedTokens: 1000, unknownRecords: 7 });
  assert.deepEqual(taskA.usage.outputTokens, { observedTokens: 2260, unknownRecords: 1 });
  assert.equal(taskA.coverageScope, 'observed-log-records-only');
  assert.deepEqual(taskA.correlation.tuples, [
    tuple({ role: 'architect', workerId: 'architect-1', planRevision: 1, workKind: 'planning', plannerInvocationId: 'planner-1' }),
    tuple({ role: 'qa', workerId: 'qa-1', planRevision: 3, workKind: 'qa' }),
    tuple({ ...worker, workerId: 'worker-1', workKind: 'context', sourceRetrievalId: 'retrieval-1' }),
    tuple({ ...worker, workerId: 'worker-1', workKind: 'implementation' }),
    tuple({ role: 'worker', workerId: 'worker-1', attemptId: 'attempt-2', runnerId: 'runner-2', planRevision: 3, workKind: 'repair' }),
  ].sort((a, b) => JSON.stringify(Object.values(a)).localeCompare(JSON.stringify(Object.values(b)))));
  assert.equal(taskA.correlation.omittedTuples, 0);
  assert.equal(taskA.correlation.ambiguousRecords, 0);
  assert.deepEqual([taskA.correlation.unknownRecords.planRevision, taskA.correlation.unknownRecords.runnerId,
    taskA.correlation.unknownRecords.packetId, taskA.correlation.unknownRecords.candidateId], [0, 3, 6, 8]);
  assert.deepEqual(report.wholeTasks.find(task => task.taskId === 'task-other').usage.totalTokens, { observedTokens: 999, unknownRecords: 0 });
  // Legacy per-provider task rows and their fields are retained beside the whole-task view.
  assert.deepEqual(report.tasks.filter(task => task.taskId === 'task-A').map(task => [task.provider, task.usage.totalTokens]),
    [['claude', { observedTokens: 7000, unknownRecords: 1 }], ['codex', { observedTokens: 3100, unknownRecords: 0 }]]);
  assert.equal(report.unattributed.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|toolArguments|costUSD|prompt/);
  const text = run(project, false);
  assert.match(text, /Whole task task-A: 10100 \(\+1 unknown records\) tokens; providers=claude,codex; roles=architect,qa,worker; launches=7/);
  assert.match(text, /observed log records only/i);
  assert.match(text, /record-only/);
  assert.match(text, /launch\/stream coverage is unconfirmed/);
  assert.match(text, /do not establish subscription quota consumption or monetary cost/);
});

test('conflicting correlation stays visibly ambiguous without splitting or inventing counters', t => {
  const retried = row({ sessionId: 'session-amb', eventId: 'event-amb', launchId: 'launch-1', planRevision: 1, packetId: 'packet-1' });
  const resumed = row({ sessionId: 'session-resume', eventId: 'event-r1', launchId: 'launch-3', planRevision: 2, workKind: 'implementation' });
  const { project } = fixture(t, { 'a.jsonl': [
    retried, { ...retried, launchId: 'launch-2', planRevision: 2, packetId: 'packet-2' },
    resumed, { ...resumed, eventId: 'event-r2', launchId: 'launch-4', planRevision: 3, workKind: 'repair', usage: tokens(2000, 500) },
    row({ sessionId: 'session-tui', eventId: 'tui-1' }), row({ taskId: 'task-B', sessionId: 'session-tui', eventId: 'tui-2', usage: tokens(10, 5) }),
  ] });
  const report = run(project);
  assert.equal(report.summary.conflictingGroups, 2, 'resumed counters and multi-task session');
  assert.equal(report.summary.ambiguousCorrelationGroups, 2, 'identical tuples across tasks are a task conflict, not correlation ambiguity');
  assert.deepEqual(report.wholeTasks.map(task => task.taskId), ['task-A'], 'a multi-task session is never apportioned');
  const [task] = report.wholeTasks;
  assert.equal(task.records, 2);
  assert.deepEqual(task.usage.totalTokens, { observedTokens: 1200, unknownRecords: 1 });
  assert.equal(task.correlation.tuples.length, 4);
  assert.equal(task.correlation.ambiguousRecords, 2);
  assert.equal(task.correlation.unknownRecords.planRevision, 0);
  assert.equal(report.unattributed.length, 1);
  assert.match(report.warnings.join(' '), /correlation .*ambiguous/i);
});

test('delivery correlation joins only the matching candidate and attempt as record-only evidence', t => {
  const { project } = fixture(t, { 'a.jsonl': [
    row({ taskId: 'task-D', attemptId: 'attempt-D1', sessionId: 's-D1', eventId: 'e-D1' }),
    row({ taskId: 'task-D', attemptId: 'attempt-D2', sessionId: 's-D2', eventId: 'e-D2', candidateId: 'cand-D2', deliveryReceiptId: 'receipt-D2' }),
    row({ taskId: 'task-D', attemptId: null, role: 'qa', sessionId: 's-Dqa', eventId: 'e-Dqa' }),
    row({ taskId: 'task-E', attemptId: 'attempt-E1', sessionId: 's-E1', eventId: 'e-E1' }),
    row({ taskId: 'task-F', attemptId: 'attempt-F1', sessionId: 's-F1', eventId: 'e-F1', candidateId: 'cand-D2' }),
    row({ taskId: 'task-G', attemptId: 'attempt-G1', sessionId: 's-G1', eventId: 'e-G1' }),
    row({ taskId: 'task-H', attemptId: null, sessionId: 's-H1', eventId: 'e-H1' }),
  ] }, [{ id: 'task-G', status: 'DONE', commits: [{ kind: 'completion', sha: 'abc' }] }]);
  const candidate = (id, taskId, attemptId) => ({ id, taskId, attemptId, baseRevision: 'b'.repeat(40), treeSha: 'c'.repeat(40),
    deliveryTarget: 'refs/heads/SECRET-TARGET', createdAt: '2026-10-24T00:00:00Z' });
  writeRecords(project, 'candidates', { 'cand-D1': candidate('cand-D1', 'task-D', 'attempt-D1'),
    'cand-D2': candidate('cand-D2', 'task-D', 'attempt-D2'), 'cand-D3': candidate('cand-D3', 'task-D', 'attempt-unobserved'),
    'cand-E1': candidate('cand-E1', 'task-Z', 'attempt-E1') });
  const delivered = (id, candidateId) => ({ id, candidateId, target: 'refs/heads/SECRET-TARGET', targetBefore: '0'.repeat(40),
    targetAfter: hex, landedRevision: hex, pushResult: 'SECRET-PUSH' });
  writeRecords(project, 'receipts', { 'receipt-D2': delivered('receipt-D2', 'cand-D2'), 'receipt-D3': delivered('receipt-D3', 'cand-D3') });
  const report = run(project);
  const delivery = id => report.wholeTasks.find(task => task.taskId === id).delivery;
  assert.deepEqual(delivery('task-D'), { evidence: 'record-only', status: 'recorded', omittedCandidates: 0, candidates: [
    { candidateId: 'cand-D1', attemptId: 'attempt-D1', deliveryReceiptId: null, landedRevision: null },
    { candidateId: 'cand-D2', attemptId: 'attempt-D2', deliveryReceiptId: 'receipt-D2', landedRevision: hex }] });
  assert.deepEqual(delivery('task-E'), { evidence: 'record-only', status: 'incomplete', omittedCandidates: 0, candidates: [] });
  assert.equal(delivery('task-F').status, 'incomplete', 'a claimed candidate from another task is a mismatch');
  assert.equal(delivery('task-G').status, 'not-recorded', 'DONE and completion commits never imply delivery');
  assert.equal(delivery('task-H').status, 'unknown', 'no observed attempt to join through');
  assert.equal(report.wholeTasks.find(task => task.taskId === 'task-G').taskRecord.status, 'DONE');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|pushResult|deliveryTarget|baseRevision|treeSha|targetAfter/);
  assert.match(report.warnings.join(' '), /delivery correlation/i);
  assert.match(run(project, false), /delivery=recorded \(record-only\)/);
});

test('malformed, conflicting or unreadable delivery records leave delivery incomplete with generic warnings', t => {
  const rows = [row({ taskId: 'task-M', attemptId: 'attempt-M1', sessionId: 's-M', eventId: 'e-M' }),
    row({ taskId: 'task-N', attemptId: 'attempt-N1', sessionId: 's-N', eventId: 'e-N' })];
  const { project } = fixture(t, { 'a.jsonl': rows });
  writeRecords(project, 'candidates', { 'cand-M1': { id: 'cand-M1', taskId: 'task-M', attemptId: 'attempt-M1' },
    'cand-broken': '{SECRET broken', 'cand-renamed': { id: 'cand-other', taskId: 'task-N', attemptId: 'attempt-N1' } });
  writeRecords(project, 'receipts', { 'receipt-M1a': { id: 'receipt-M1a', candidateId: 'cand-M1', landedRevision: hex },
    'receipt-M1b': { id: 'receipt-M1b', candidateId: 'cand-M1', landedRevision: 'b'.repeat(40) },
    'receipt-bad': { id: 'receipt-bad', candidateId: 'cand-M1', landedRevision: 'SECRET-not-hex' } });
  const report = run(project);
  const delivery = id => report.wholeTasks.find(task => task.taskId === id).delivery;
  assert.deepEqual(delivery('task-M').candidates, [{ candidateId: 'cand-M1', attemptId: 'attempt-M1', deliveryReceiptId: null, landedRevision: null }]);
  assert.equal(delivery('task-M').status, 'incomplete', 'two receipts for one candidate are ambiguous');
  assert.deepEqual(delivery('task-N'), { evidence: 'record-only', status: 'incomplete', omittedCandidates: 0, candidates: [] });
  const warnings = report.warnings.join(' ');
  assert.match(warnings, /delivery correlation/i);
  assert.ok(!warnings.includes(project));
  assert.doesNotMatch(JSON.stringify(report), /SECRET|cand-broken|cand-other|receipt-M1a|receipt-bad/);
  rmSync(path.join(project, '.moe/candidates'), { recursive: true });
  writeFileSync(path.join(project, '.moe/candidates'), 'not a directory');
  rmSync(path.join(project, '.moe/receipts'), { recursive: true });
  assert.deepEqual(run(project).wholeTasks.map(task => task.delivery.status), ['incomplete', 'incomplete']);
});

test('legacy receipts without correlation report unknown values, not zero, and keep usage intact', t => {
  const { project } = fixture(t, { 'a.jsonl': [receipt()] });
  const report = run(project);
  const [task] = report.wholeTasks;
  assert.deepEqual(task.usage.totalTokens, { observedTokens: 1200, unknownRecords: 0 });
  assert.deepEqual(task.correlation.tuples, [tuple({ role: 'worker', workerId: 'worker-A', attemptId: 'attempt-A' })]);
  assert.equal(task.correlation.unknownRecords.planRevision, 1);
  assert.deepEqual(task.delivery, { evidence: 'record-only', status: 'not-recorded', omittedCandidates: 0, candidates: [] });
  assert.equal(report.summary.ambiguousCorrelationGroups, 0);
  assert.deepEqual(report.tasks[0].usage.totalTokens, { observedTokens: 1200, unknownRecords: 0 });
});

test('each isolated delivery-record defect is incomplete, never a recorded delivery', t => {
  const joined = { 'cand-R1': { id: 'cand-R1', taskId: 'task-R', attemptId: 'attempt-R1' } };
  const landed = (id, landedRevision) => ({ id, candidateId: 'cand-R1', landedRevision });
  const cases = [
    ['non-string revision', joined, { 'receipt-R1': landed('receipt-R1', [hex]) }, null],
    ['two receipts for one candidate', joined, { 'receipt-R1': landed('receipt-R1', hex), 'receipt-R2': landed('receipt-R2', hex) }, null],
    ['malformed sibling candidate', { ...joined, 'cand-bad': { id: 'cand-bad', taskId: 'task-R' } }, { 'receipt-R1': landed('receipt-R1', hex) }, 'receipt-R1'],
  ];
  for (const [name, candidates, receipts, receiptId] of cases) {
    const { project } = fixture(t, { 'a.jsonl': [row({ taskId: 'task-R', attemptId: 'attempt-R1', sessionId: 's-R', eventId: 'e-R' })] });
    writeRecords(project, 'candidates', candidates);
    writeRecords(project, 'receipts', receipts);
    const [task] = run(project).wholeTasks;
    assert.deepEqual(task.delivery, { evidence: 'record-only', status: 'incomplete', omittedCandidates: 0, candidates: [{
      candidateId: 'cand-R1', attemptId: 'attempt-R1', deliveryReceiptId: receiptId, landedRevision: receiptId && hex }] }, name);
  }
});

// CQ-M04 baseline outcome report. Acceptance comes only from the held-out
// assessment; Moe status, QA counts and tokens are record-only. Unknown stays null.
import * as baseline from '../baseline-report.mjs';
import { buildUsageReport } from '../usage-report.mjs';
import { statSync } from 'node:fs';

const baselineCli = fileURLToPath(new URL('../analyze-baseline.mjs', import.meta.url));
const digestOf = char => `sha256:${char.repeat(64)}`;
const commitA = '35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71';
const DROP = Symbol('drop');
const categoryOf = id => ['maintenance', 'defect', 'refactor', 'non-routine'].find(category => id.startsWith(`${category}-`));
function setAt(target, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key], target);
  if (value === DROP) delete parent[last]; else parent[last] = value;
}
function outcome(id = 'maintenance-a', edits = {}) {
  const value = {
    version: 1,
    workload: { id, category: categoryOf(id), caseDigest: digestOf('1'), snapshotDigest: digestOf('2'), corpusVersion: 1 },
    run: { moeCommit: commitA, startedAt: '2026-10-24T10:00:00.000Z', endedAt: '2026-10-24T10:30:00.000Z',
      wallClockMs: 1800000, wallClockCapMs: 3600000, status: 'completed', repetition: 1, repetitionsPlanned: 1,
      platform: 'linux-x64', nodeVersion: 'v24.21.0', cliVersion: null,
      roles: [{ role: 'architect', cli: 'claude', model: 'claude-opus-5-5', effort: 'max', launches: 1 },
        { role: 'worker', cli: 'claude', model: 'claude-opus-5-5', effort: 'max', launches: 2 },
        { role: 'qa', cli: 'claude', model: null, effort: null, launches: null }],
      usageTaskId: `task-${id}`, failureReason: null },
    moeOutcome: { finalStatus: 'DONE', qaApprovals: 1, qaRejections: 0, reopenCount: 0, plannerSessions: 1, repairAttempts: null },
    assessment: { ran: true, exitCode: 0, criteria: [{ id: 'held-out-behavior', result: 'pass' }, { id: 'unchanged-callers', result: 'pass' }], reason: null },
    latency: { firstCodeChangeMs: 600000, endToEndMs: 1800000 },
    retrieval: { sourceRetrievals: null, retrievedBytes: null },
    notes: ['fixture run'],
  };
  for (const [dotted, edit] of Object.entries(edits)) setAt(value, dotted, edit);
  return value;
}
const notRun = reason => ({ 'assessment.ran': false, 'assessment.exitCode': null, 'assessment.reason': reason,
  'assessment.criteria.0.result': 'not-run', 'assessment.criteria.1.result': 'not-run' });
const usageRows = (id, input, output, extra = {}) =>
  [row({ taskId: `task-${id}`, sessionId: `s-${id}`, eventId: `e-${id}`, launchId: `launch-${id}`, usage: tokens(input, output), ...extra })];
function writeUsage(root, projects) {
  for (const [id, rows] of Object.entries(projects)) {
    const logs = path.join(root, id, 'logs/moe-usage');
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, 'a.jsonl'), rows.map(entry => JSON.stringify(entry)).join('\n'));
  }
  return Object.fromEntries(Object.keys(projects).map(id => [id, buildUsageReport(path.join(root, id))]));
}
function scratch(t, label) {
  const root = mkdtempSync(path.join(tmpdir(), `moe baseline ${label} `));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const metric = (observedTokens, unknownRecords) => ({ observedTokens, unknownRecords });
const observedUsage = (id, input, output, unknownRecords = 0, records = 1) => ({ status: 'observed', reason: null, taskId: `task-${id}`,
  records, launches: records, providers: ['claude'], totals: { inputTokens: metric(input, unknownRecords),
    cacheReadTokens: metric(null, records), cacheWriteTokens: metric(null, records), uncachedInputTokens: metric(null, records),
    outputTokens: metric(output, unknownRecords), reasoningTokens: metric(null, records), totalTokens: metric(input + output, unknownRecords) },
  coverageScope: 'observed-log-records-only', codexStreamCoverage: 'not-observed' });
const unknownUsage = (taskId, reason) => ({ status: 'unknown', reason, taskId, records: null, launches: null, providers: [],
  totals: Object.fromEntries(fields.map(field => [field, metric(null, null)])), coverageScope: null, codexStreamCoverage: null });
const manifestOf = ids => ({ corpusVersion: 1, workloads: ids.map(id => ({ id, category: categoryOf(id), caseDigest: digestOf('1') })) });
const RECORD_ONLY = 'Moe task status, QA approvals, rejections and reopen counts are record-only; acceptance comes only from the held-out assessment.';

test('baseline record contract returns a detached deep-frozen copy and keeps unknown counters null', () => {
  assert.equal(baseline.BASELINE_RECORD_VERSION, 1);
  assert.deepEqual(baseline.BASELINE_STATUSES, ['completed', 'capped', 'failed', 'aborted']);
  assert.deepEqual(baseline.BASELINE_ROLES, ['architect', 'worker', 'qa']);
  assert.deepEqual(baseline.ASSESSMENT_RESULTS, ['pass', 'fail', 'not-run']);
  const raw = outcome('maintenance-a', { 'run.status': 'capped', 'run.wallClockMs': 3600000, 'run.endedAt': '2026-10-24T11:00:00.000Z',
    'moeOutcome.qaApprovals': null, 'latency.endToEndMs': null, ...notRun('capped before assessment') });
  const read = baseline.readBaselineRecord(raw);
  assert.deepEqual(read, raw);
  assert.notEqual(read, raw);
  assert.notEqual(read.run.roles[2], raw.run.roles[2]);
  for (const node of [read, read.workload, read.run, read.run.roles, read.run.roles[2], read.assessment.criteria[0], read.notes]) assert.ok(Object.isFrozen(node));
  assert.deepEqual([read.moeOutcome.qaApprovals, read.moeOutcome.repairAttempts, read.latency.endToEndMs, read.retrieval.sourceRetrievals,
    read.run.roles[2].launches, read.run.cliVersion], [null, null, null, null, null, null]);
  raw.run.status = 'failed';
  assert.equal(read.run.status, 'capped');
  assert.equal(baseline.readBaselineRecord(Object.assign(Object.create(null), outcome())).workload.id, 'maintenance-a');
  assert.equal(baseline.readBaselineRecord(outcome('defect-a', { 'run.wallClockMs': 3600000, 'assessment.criteria': [], 'notes': [] })).run.wallClockMs, 3600000);
  assert.equal(baseline.readBaselineRecord(outcome('refactor-a', { 'run.status': 'failed', 'run.wallClockMs': 3600001, 'run.roles': [outcome().run.roles[1]] })).run.roles.length, 1);
});

test('baseline record contract rejects every malformed field, naming its path without echoing content', () => {
  const long = 'S'.repeat(501);
  const cases = [
    [{ version: 2 }, /^version: /],
    [{ notes: DROP }, /^notes: is required/],
    [{ prompt: 'SECRET prompt' }, /^prompt: is not an allowed key/],
    [{ 'run.toolArguments': { command: 'SECRET' } }, /^run\.toolArguments: is not an allowed key/],
    [{ 'run.roles.0.costUSD': 1 }, /^run\.roles\[0\]\.costUSD: is not an allowed key/],
    [{ 'assessment.criteria.0.prompt': 'SECRET' }, /^assessment\.criteria\[0\]\.prompt: is not an allowed key/],
    [{ 'workload.snapshotDigest': DROP }, /^workload\.snapshotDigest: is required/],
    [{ ['k'.repeat(100)]: 1 }, /^k{40}: is not an allowed key/],
    [{ 'workload.category': 'feature' }, /^workload\.category: must be one of/],
    [{ 'workload.id': 'defect-a' }, /^workload\.id: /],
    [{ 'workload.id': 'maintenance_Bad' }, /^workload\.id: /],
    [{ 'workload.id': `maintenance-${'a'.repeat(69)}` }, /^workload\.id: /],
    [{ 'workload.caseDigest': 'sha256:ABC' }, /^workload\.caseDigest: /],
    [{ 'workload.snapshotDigest': 'f'.repeat(64) }, /^workload\.snapshotDigest: /],
    [{ 'workload.corpusVersion': 0 }, /^workload\.corpusVersion: /],
    [{ 'run.moeCommit': 'abc123' }, /^run\.moeCommit: /],
    [{ 'run.moeCommit': 'A'.repeat(40) }, /^run\.moeCommit: /],
    [{ 'run.startedAt': '2026-10-24' }, /^run\.startedAt: /],
    [{ 'run.endedAt': 'SECRET not a date' }, /^run\.endedAt: /],
    [{ 'run.endedAt': '2026-10-24T09:59:59.999Z' }, /^run\.endedAt: must not be before startedAt/],
    [{ 'run.wallClockCapMs': 0 }, /^run\.wallClockCapMs: /],
    [{ 'moeOutcome.qaRejections': -1 }, /^moeOutcome\.qaRejections: /],
    [{ 'latency.endToEndMs': 1.5 }, /^latency\.endToEndMs: /],
    [{ 'retrieval.retrievedBytes': 2 ** 53 }, /^retrieval\.retrievedBytes: /],
    [{ 'moeOutcome.reopenCount': '0' }, /^moeOutcome\.reopenCount: /],
    [{ 'run.status': 'timeout' }, /^run\.status: must be one of completed, capped, failed, aborted/],
    [{ 'run.roles.0.role': 'governor' }, /^run\.roles\[0\]\.role: must be one of/],
    [{ 'assessment.criteria.0.result': 'skipped' }, /^assessment\.criteria\[0\]\.result: must be one of/],
    [{ 'run.roles.1.role': 'architect' }, /^run\.roles\[1\]\.role: is a duplicate/],
    [{ 'assessment.criteria.1.id': 'held-out-behavior' }, /^assessment\.criteria\[1\]\.id: is a duplicate/],
    [{ 'assessment.criteria.0.id': 'Held Out' }, /^assessment\.criteria\[0\]\.id: /],
    [{ 'run.status': 'capped' }, /^run\.wallClockMs: .*capped/],
    [{ 'run.wallClockMs': 3600001 }, /^run\.wallClockMs: .*completed/],
    [{ 'run.repetition': 2 }, /^run\.repetition: /],
    [{ 'run.repetitionsPlanned': 0 }, /^run\.repetitionsPlanned: /],
    [{ 'run.roles': [] }, /^run\.roles: /],
    [{ 'run.usageTaskId': 'task/../x' }, /^run\.usageTaskId: /],
    [{ 'run.cliVersion': long }, /^run\.cliVersion: /],
    [{ 'run.platform': 'linux\nx64' }, /^run\.platform: /],
    [{ 'run.platform': '   ' }, /^run\.platform: /],
    [{ 'run.roles.0.model': '' }, /^run\.roles\[0\]\.model: /],
    [{ 'run.failureReason': long }, /^run\.failureReason: /],
    [{ 'assessment.ran': 'yes' }, /^assessment\.ran: /],
    [{ 'assessment.exitCode': 1.5 }, /^assessment\.exitCode: /],
    [{ 'assessment.ran': false }, /^assessment\.exitCode: /],
    [{ ...notRun('x'), 'assessment.criteria.1.result': 'pass' }, /^assessment\.criteria\[1\]\.result: /],
    [{ ...notRun(null) }, /^assessment\.reason: /],
    [{ 'assessment.criteria': Array.from({ length: 33 }, (_, i) => ({ id: `c-${i}`, result: 'pass' })) }, /^assessment\.criteria: /],
    [{ notes: Array.from({ length: 11 }, () => 'n') }, /^notes: /],
    [{ 'notes.0': 'S'.repeat(301) }, /^notes\[0\]: /],
    [{ run: new Map() }, /^run: must be a plain object/],
    [{ 'run.roles.0': [] }, /^run\.roles\[0\]: must be a plain object/],
    [{ 'moeOutcome.finalStatus': 'S'.repeat(33) }, /^moeOutcome\.finalStatus: /],
  ];
  for (const [edits, pattern] of cases) {
    let message;
    assert.throws(() => baseline.readBaselineRecord(outcome('maintenance-a', edits)), error => { message = error.message; return pattern.test(message); },
      `${Object.keys(edits).join(',')} -> ${message}`);
    assert.ok(message.length <= 200, message);
    assert.doesNotMatch(message, /SECRET|S{41}|k{41}/);
  }
  for (const root of [null, [], 'record', 7, new (class Record {})()]) {
    assert.throws(() => baseline.readBaselineRecord(root), { message: /^record: must be a plain object/ });
  }
});

test('acceptance comes only from the held-out assessment, never from Moe status, QA approval or tokens', t => {
  const records = [
    outcome('maintenance-a', { 'assessment.criteria.1.result': 'fail', 'assessment.exitCode': 1 }),
    outcome('maintenance-b', notRun('assessment not run')),
    outcome('maintenance-c', { 'moeOutcome.finalStatus': 'WORKING', 'moeOutcome.qaApprovals': 0, 'moeOutcome.qaRejections': 3 }),
    outcome('maintenance-d', { 'assessment.exitCode': 2 }),
    outcome('maintenance-e', { 'assessment.criteria': [] }),
    outcome('maintenance-f', { 'assessment.criteria.1.result': 'not-run' }),
    outcome('maintenance-g', { 'assessment.exitCode': null }),
  ];
  const root = scratch(t, 'acceptance');
  const huge = writeUsage(path.join(root, 'one'), { 'maintenance-a': usageRows('maintenance-a', 9000000, 1), 'maintenance-c': usageRows('maintenance-c', 0, 0) });
  const swapped = writeUsage(path.join(root, 'two'), { 'maintenance-a': usageRows('maintenance-a', 0, 0), 'maintenance-c': usageRows('maintenance-c', 9000000, 1) });
  const first = baseline.buildBaselineReport({ records, usageByWorkload: huge });
  const second = baseline.buildBaselineReport({ records, usageByWorkload: swapped });
  const verdicts = [['maintenance-a', 'rejected'], ['maintenance-b', 'not-assessed'], ['maintenance-c', 'accepted'],
    ['maintenance-d', 'not-assessed'], ['maintenance-e', 'not-assessed'], ['maintenance-f', 'not-assessed'], ['maintenance-g', 'not-assessed']];
  assert.deepEqual(first.rows.map(entry => [entry.id, entry.acceptance]), verdicts);
  assert.deepEqual(second.rows.map(entry => [entry.id, entry.acceptance]), verdicts);
  assert.deepEqual(first.rows.map(entry => entry.usage.totals.totalTokens.observedTokens).slice(0, 3), [9000001, null, 0]);
  assert.deepEqual(second.rows.map(entry => entry.usage.totals.totalTokens.observedTokens).slice(0, 3), [0, null, 9000001]);
  assert.deepEqual(first.summary.acceptance, { accepted: 1, rejected: 1, notAssessed: 5 });
  assert.deepEqual(first.rows[0].moeOutcome, { recordOnly: true, finalStatus: 'DONE', qaApprovals: 1 });
  assert.deepEqual(first.rows[2].repair, { qaRejections: 3, reopenCount: 0, repairAttempts: null });
  assert.deepEqual(first.rows[2].planning, { plannerSessions: 1 });
  assert.deepEqual(first.summary.efficiency, { observedTokens: 9000001, acceptedChanges: 1, observedTokensPerAcceptedChange: 9000001, complete: false });
  assert.ok(first.limitations.includes(RECORD_ONLY));
  assert.ok(first.limitations.includes('5 workload(s) were not assessed; they count as neither accepted nor rejected.'));
});

test('capped, failed, aborted and missing runs stay visible while duplicates and digest mismatches are refused', t => {
  const ids = ['maintenance-a', 'defect-capped', 'refactor-failed', 'non-routine-aborted', 'non-routine-missing'];
  const records = [
    outcome('non-routine-aborted', { 'run.status': 'aborted', 'run.failureReason': 'operator stopped the run', ...notRun('run aborted') }),
    outcome('refactor-failed', { 'run.status': 'failed', 'run.failureReason': 'agent CLI exited 1', 'assessment.exitCode': 1, 'assessment.criteria.1.result': 'fail' }),
    outcome('defect-capped', { 'run.status': 'capped', 'run.wallClockMs': 3600000, 'run.endedAt': '2026-10-24T11:00:00.000Z',
      'moeOutcome.finalStatus': 'WORKING', 'moeOutcome.qaApprovals': 0, 'latency.firstCodeChangeMs': 1200000, 'latency.endToEndMs': null, ...notRun('capped before delivery') }),
    outcome('maintenance-a'),
  ];
  const usage = writeUsage(scratch(t, 'capped'), { 'defect-capped': usageRows('defect-capped', 2000, 300) });
  const report = baseline.buildBaselineReport({ records, usageByWorkload: usage, expected: manifestOf(ids) });
  assert.deepEqual(report.rows.map(entry => [entry.id, entry.status, entry.capped, entry.acceptance]), [
    ['maintenance-a', 'completed', false, 'accepted'], ['defect-capped', 'capped', true, 'not-assessed'],
    ['refactor-failed', 'failed', false, 'rejected'], ['non-routine-aborted', 'aborted', false, 'not-assessed'],
    ['non-routine-missing', 'missing', false, 'not-assessed']]);
  assert.deepEqual(report.summary.byStatus, { completed: 1, capped: 1, failed: 1, aborted: 1, missing: 1 });
  assert.deepEqual(report.summary.byCategory, { maintenance: { workloads: 1, accepted: 1, rejected: 0, notAssessed: 0 },
    defect: { workloads: 1, accepted: 0, rejected: 0, notAssessed: 1 }, refactor: { workloads: 1, accepted: 0, rejected: 1, notAssessed: 0 },
    'non-routine': { workloads: 2, accepted: 0, rejected: 0, notAssessed: 2 } });
  const capped = report.rows[1];
  assert.deepEqual([capped.wallClockMs, capped.wallClockCapMs, capped.moeOutcome, capped.latency],
    [3600000, 3600000, { recordOnly: true, finalStatus: 'WORKING', qaApprovals: 0 }, { firstCodeChangeMs: 1200000, endToEndMs: null }]);
  assert.deepEqual(capped.usage, observedUsage('defect-capped', 2000, 300));
  assert.equal(report.rows[2].failureReason, 'agent CLI exited 1');
  assert.deepEqual(report.rows[4], { id: 'non-routine-missing', category: 'non-routine', caseDigest: digestOf('1'), snapshotDigest: null,
    corpusVersion: 1, moeCommit: null, wallClockCapMs: null, roles: [], status: 'missing', capped: false, wallClockMs: null, failureReason: null,
    acceptance: 'not-assessed', assessment: null, moeOutcome: { recordOnly: true, finalStatus: null, qaApprovals: null },
    repair: { qaRejections: null, reopenCount: null, repairAttempts: null }, planning: { plannerSessions: null },
    retrieval: { sourceRetrievals: null, retrievedBytes: null }, latency: { firstCodeChangeMs: null, endToEndMs: null },
    usage: unknownUsage(null, 'no-record') });
  assert.ok(report.limitations.includes('Runs not completed: 1 capped, 1 failed, 1 aborted, 1 missing; every run is reported as a row and capped runs keep partial counters.'));
  const build = (list, expected = manifestOf(ids)) => () => baseline.buildBaselineReport({ records: list, expected });
  assert.throws(build([outcome('maintenance-a'), outcome('maintenance-a')], null), /maintenance-a.*n=1/);
  assert.throws(build([outcome('defect-extra')]), /defect-extra.*not in the expected manifest/);
  assert.throws(build([outcome('maintenance-a', { 'workload.caseDigest': digestOf('9') })]), /maintenance-a.*caseDigest differs/);
  assert.throws(build([outcome('maintenance-a', { 'workload.corpusVersion': 2 })]), /maintenance-a.*corpusVersion differs/);
  assert.throws(build([outcome('maintenance-a', { 'run.status': 'timeout' })]), { message: /^records\[0\]: run\.status: / });
  const manifest = manifestOf(['maintenance-a', 'defect-b']);
  assert.throws(build([], { ...manifest, workloads: [manifest.workloads[0], manifest.workloads[0]] }), { message: /^expected\.workloads\[1\]\.id: is a duplicate/ });
  assert.throws(build([], { ...manifest, workloads: [{ ...manifest.workloads[0], category: 'defect' }] }), { message: /^expected\.workloads\[0\]\.id: / });
  assert.throws(build([], { ...manifest, workloads: [] }), { message: /^expected\.workloads: / });
  assert.throws(build([], { ...manifest, note: 'x' }), { message: /^expected\.note: is not an allowed key/ });
  assert.throws(build([], { ...manifest, workloads: [{ ...manifest.workloads[0], caseDigest: 'sha256:x' }] }), { message: /^expected\.workloads\[0\]\.caseDigest: / });
  assert.throws(() => baseline.buildBaselineReport({ records: {} }), { message: /^records: must be an array/ });
});

test('usage joins each workload project by usageTaskId and never turns unknown usage into zero', t => {
  const root = scratch(t, 'usage');
  const crashed = row({ taskId: 'task-defect-b', launchId: 'launch-crash', sessionId: null, eventId: null, coverage: 'missing', outcome: 'unknown', usage: unknown });
  const usage = writeUsage(root, { 'maintenance-a': usageRows('maintenance-a', 1000, 200),
    'defect-b': [...usageRows('defect-b', 3000, 500), crashed], 'non-routine-d': usageRows('other-task', 50, 5) });
  const records = [outcome('maintenance-a'), outcome('defect-b', { 'assessment.criteria.0.result': 'fail', 'assessment.exitCode': 1 }),
    outcome('refactor-c'), outcome('non-routine-d'), outcome('refactor-e', { 'run.usageTaskId': null })];
  const report = baseline.buildBaselineReport({ records, usageByWorkload: usage });
  const usageOf = id => report.rows.find(entry => entry.id === id).usage;
  assert.deepEqual(usageOf('maintenance-a'), observedUsage('maintenance-a', 1000, 200));
  const defect = observedUsage('defect-b', 3000, 500, 1, 2);
  assert.deepEqual(usageOf('defect-b'), defect);
  assert.deepEqual(usageOf('refactor-c'), unknownUsage('task-refactor-c', 'no-usage-project'));
  assert.deepEqual(usageOf('non-routine-d'), unknownUsage('task-non-routine-d', 'task-not-in-usage-project'));
  assert.deepEqual(usageOf('refactor-e'), unknownUsage(null, 'no-usage-task-id'));
  assert.deepEqual(report.summary.usage, { unknownWorkloads: 3, codexStreamUnconfirmed: 0, totals: {
    inputTokens: metric(4000, 1), cacheReadTokens: metric(null, 3), cacheWriteTokens: metric(null, 3), uncachedInputTokens: metric(null, 3),
    outputTokens: metric(700, 1), reasoningTokens: metric(null, 3), totalTokens: metric(4700, 1) } });
  assert.deepEqual(report.summary.efficiency, { observedTokens: 4700, acceptedChanges: 4, observedTokensPerAcceptedChange: 1175, complete: false });
  assert.ok(report.limitations.includes('Usage is unknown for 3 workload(s); observed totals exclude them and are not zero.'));
  const clean = baseline.buildBaselineReport({ records: [records[0]], usageByWorkload: usage });
  assert.deepEqual(clean.summary.efficiency, { observedTokens: 1200, acceptedChanges: 1, observedTokensPerAcceptedChange: 1200, complete: true });
  const none = baseline.buildBaselineReport({ records: [records[1]], usageByWorkload: usage });
  assert.deepEqual(none.summary.efficiency, { observedTokens: 3500, acceptedChanges: 0, observedTokensPerAcceptedChange: null, complete: false });
  const blind = baseline.buildBaselineReport({ records: [records[2]] });
  assert.deepEqual([blind.summary.usage.totals.totalTokens, blind.summary.efficiency],
    [metric(null, 0), { observedTokens: null, acceptedChanges: 1, observedTokensPerAcceptedChange: null, complete: false }]);
  const text = baseline.formatBaselineReport(blind);
  assert.match(text, /Observed total tokens: unknown; workloads with unknown usage: 1/);
  assert.match(text, /Observed tokens per accepted change: unknown/);
  assert.match(text, /^\| refactor-c \| refactor \| completed \| accepted \|.* \| unknown \|$/m);
});

test('report lists reproducible inputs and every variability and coverage limitation', t => {
  const usage = writeUsage(scratch(t, 'inputs'), { 'maintenance-a': [row({ provider: 'codex', scope: 'turn', taskId: 'task-maintenance-a',
    sessionId: 'thread-a', eventId: 'turn-a', usage: tokens(100, 20) })] });
  const records = [outcome('maintenance-a'), outcome('defect-b', { 'run.moeCommit': 'b'.repeat(40), 'run.wallClockCapMs': 1800000,
    'workload.corpusVersion': 2, 'workload.snapshotDigest': digestOf('3'), 'run.cliVersion': '2.1.0',
    'run.roles.1.model': 'claude-sonnet-5-5', 'run.roles.1.effort': 'high', 'latency.firstCodeChangeMs': null })];
  const report = baseline.buildBaselineReport({ records, usageByWorkload: usage });
  assert.deepEqual(report.inputs, { recordVersion: 1, expected: null, corpusVersions: [1, 2], moeCommits: [commitA, 'b'.repeat(40)],
    wallClockCapsMs: [1800000, 3600000], repetitionsPlanned: [1], platforms: ['linux-x64'], nodeVersions: ['v24.21.0'], cliVersions: ['2.1.0', null],
    roles: [{ role: 'architect', cli: 'claude', model: 'claude-opus-5-5', effort: 'max' }, { role: 'worker', cli: 'claude', model: 'claude-opus-5-5', effort: 'max' },
      { role: 'worker', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, { role: 'qa', cli: 'claude', model: null, effort: null }],
    workloads: [{ id: 'defect-b', caseDigest: digestOf('1'), snapshotDigest: digestOf('3') }, { id: 'maintenance-a', caseDigest: digestOf('1'), snapshotDigest: digestOf('2') }] });
  assert.deepEqual(report.limitations, [
    'One run per workload (n=1): no variability or confidence estimate is possible.',
    'Runs not completed: 0 capped, 0 failed, 0 aborted, 0 missing; every run is reported as a row and capped runs keep partial counters.',
    'Usage is unknown for 1 workload(s); observed totals exclude them and are not zero.',
    'Usage covers observed log records only; participation that was not logged is missing, not zero.',
    'Codex usage stream coverage is unconfirmed for 1 workload(s); completed turns do not prove the stream closed.',
    'Retrieval counters are unknown for 2 workload(s).',
    'Latency counters are unknown for 1 workload(s).',
    'Runs used 2 different Moe commits; they are not matched on the commit under test.',
    'Runs used 2 different wall-clock caps.',
    'Runs used 2 different corpus versions.',
    RECORD_ONLY,
    'Token observations are not monetary cost or quota.']);
  assert.equal(report.summary.usage.codexStreamUnconfirmed, 1);
  assert.equal(report.summary.efficiency.complete, false);
  const text = baseline.formatBaselineReport(report);
  for (const line of ['Acceptance = held-out assessment only; Moe task status is record-only.', 'Token observations are not monetary cost or quota.',
    '## Inputs', '## Workloads', '## Summary', '## Limitations', '- CLI versions: 2.1.0, unknown', '- Corpus versions: 1, 2',
    `- Moe commits: ${commitA}, ${'b'.repeat(40)}`, '  - qa claude model=unknown effort=unknown',
    `  - defect-b: case ${digestOf('1')}, snapshot ${digestOf('3')}`, '- Runs used 2 different corpus versions.']) {
    assert.ok(text.split('\n').includes(line), line);
  }
  assert.match(text, /\| defect-b \| defect \| completed \| accepted \| 2\/2 \| DONE \| 0 \| 0 \| unknown \| 1 \| unknown \| 1800000 \| unknown \| unknown \|/);
  assert.match(text, /\| maintenance-a \| maintenance \| completed \| accepted \| 2\/2 \| DONE \| 0 \| 0 \| unknown \| 1 \| unknown \| 1800000 \| 600000 \| 120 \|/);
  assert.doesNotMatch(text, /null|undefined|NaN/);
});

test('baseline report is deterministic and follows manifest order, else workload id order', t => {
  const usage = writeUsage(scratch(t, 'order'), { 'maintenance-a': usageRows('maintenance-a', 10, 1) });
  const a = outcome('maintenance-a'), b = outcome('defect-b', { 'moeOutcome.finalStatus': 'A|B' });
  const forward = baseline.buildBaselineReport({ records: [a, b], usageByWorkload: usage });
  const backward = baseline.buildBaselineReport({ records: [b, a], usageByWorkload: usage });
  assert.deepEqual(forward.rows.map(entry => entry.id), ['defect-b', 'maintenance-a']);
  assert.equal(JSON.stringify(backward), JSON.stringify(forward));
  assert.equal(baseline.formatBaselineReport(backward), baseline.formatBaselineReport(forward));
  assert.deepEqual(JSON.parse(JSON.stringify(forward)), forward);
  assert.match(baseline.formatBaselineReport(forward), /\| A\\\|B \|/);
  const manifest = manifestOf(['maintenance-a', 'defect-b']);
  const ordered = baseline.buildBaselineReport({ records: [b, a], usageByWorkload: usage, expected: manifest });
  assert.deepEqual(ordered.rows.map(entry => entry.id), ['maintenance-a', 'defect-b']);
  assert.equal(JSON.stringify(baseline.buildBaselineReport({ records: [a, b], usageByWorkload: usage, expected: manifest })), JSON.stringify(ordered));
  assert.deepEqual(ordered.inputs.expected, { corpusVersion: 1, workloads: 2 });
});

test('analyze-baseline CLI prints the report read-only and fails closed with bounded file-and-field errors', t => {
  const root = scratch(t, 'cli');
  const records = path.join(root, 'records');
  const projects = path.join(root, 'projects');
  mkdirSync(records);
  const a = outcome('maintenance-a');
  const b = outcome('defect-b', { 'assessment.criteria.0.result': 'fail', 'assessment.exitCode': 1 });
  for (const record of [a, b]) writeFileSync(path.join(records, `${record.workload.id}.json`), JSON.stringify(record));
  writeFileSync(path.join(records, 'README.txt'), 'ignored');
  const usage = writeUsage(projects, { 'maintenance-a': usageRows('maintenance-a', 1000, 200) });
  const expected = manifestOf(['maintenance-a', 'defect-b']);
  const expectedFile = path.join(root, 'expected.json');
  writeFileSync(expectedFile, JSON.stringify(expected));
  const tree = () => readdirSync(root, { recursive: true }).sort().map(name => {
    const file = path.join(root, name);
    return [name, statSync(file).isFile() ? readFileSync(file, 'base64') : 'directory'];
  });
  const before = tree();
  const runBaseline = args => spawnSync(process.execPath, [baselineCli, ...args], { encoding: 'utf8' });
  const report = baseline.buildBaselineReport({ records: [b, a], usageByWorkload: usage, expected });
  const json = runBaseline(['--records', records, '--project', projects, '--expected', expectedFile, '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(report)));
  const text = runBaseline(['--records', records, '--project', projects, '--expected', expectedFile]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, `${baseline.formatBaselineReport(report)}\n`);
  const blind = runBaseline(['--records', records, '--json']);
  assert.equal(blind.status, 0, blind.stderr);
  assert.deepEqual(JSON.parse(blind.stdout).rows.map(entry => entry.usage.reason), ['no-usage-project', 'no-usage-project']);
  assert.deepEqual(tree(), before, 'the CLI never writes');
  const fails = (args, pattern) => {
    const result = runBaseline(args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /SECRET/);
    assert.ok(result.stderr.length <= 320 && result.stderr.trim().split('\n').length === 1, result.stderr);
  };
  fails([], /^analyze-baseline: Usage: .*--records DIR/);
  fails(['--records', records, '--bogus'], /Usage: /);
  fails(['--records', records, '--json', '--json'], /Usage: /);
  fails(['--records', path.join(root, 'nope')], /^analyze-baseline: --records: /);
  fails(['--records', records, '--project', path.join(root, 'nope')], /^analyze-baseline: --project: /);
  fails(['--records', records, '--expected', path.join(root, 'nope.json')], /^analyze-baseline: nope\.json: is unreadable/);
  const bad = (name, body, pattern, args = []) => {
    const directory = mkdtempSync(path.join(root, 'bad-'));
    writeFileSync(path.join(directory, name), body);
    fails(['--records', directory, ...args], pattern);
  };
  bad('zz-bad.json', '{"SECRET-CONTENT": broken', /^analyze-baseline: zz-bad\.json: is not valid JSON\n$/);
  bad('maintenance-a.json', JSON.stringify(outcome('maintenance-a', { 'run.status': 'timeout', notes: ['SECRET-CONTENT'] })),
    /^analyze-baseline: maintenance-a\.json: run\.status: must be one of completed, capped, failed, aborted\n$/);
  bad('defect-b.json', '[]', /^analyze-baseline: defect-b\.json: record: must be a plain object\n$/);
  bad('big.json', ' '.repeat(1024 * 1024 + 1), /^analyze-baseline: big\.json: exceeds 1048576 bytes\n$/);
  bad('defect-x.json', JSON.stringify(outcome('defect-x')), /^analyze-baseline: defect-x\.json: workload defect-x is not in the expected manifest\n$/, ['--expected', expectedFile]);
  const badExpected = path.join(root, 'bad-expected.json');
  writeFileSync(badExpected, JSON.stringify({ ...expected, workloads: [] }));
  fails(['--records', records, '--expected', badExpected], /^analyze-baseline: bad-expected\.json: expected\.workloads: /);
  mkdirSync(path.join(records, 'zz-directory.json'));
  fails(['--records', records], /^analyze-baseline: zz-directory\.json: is not a regular file/);
});

test('an overflowed workload total stays unknown in the baseline summary instead of being skipped', () => {
  const task = (taskId, total, providers = ['claude']) => ({ taskId, records: 1, launches: 1, providers, coverageScope: 'observed-log-records-only',
    usage: Object.fromEntries(fields.map(field => [field, field === 'totalTokens' ? metric(total, 0) : metric(null, 1)])) });
  const records = [outcome('maintenance-a'), outcome('defect-b')];
  const build = (a, b, providers) => baseline.buildBaselineReport({ records, usageByWorkload: {
    'maintenance-a': { wholeTasks: [task('task-maintenance-a', a)] }, 'defect-b': { wholeTasks: [task('task-defect-b', b, providers)] } } });
  for (const report of [build(10, null), build(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]) {
    assert.deepEqual(report.summary.usage.totals.totalTokens, metric(null, 0));
    assert.deepEqual(report.summary.efficiency, { observedTokens: null, acceptedChanges: 2, observedTokensPerAcceptedChange: null, complete: false });
    assert.match(baseline.formatBaselineReport(report), /Observed total tokens: unknown;/);
  }
  assert.deepEqual(build(10, 5).summary.efficiency, { observedTokens: 15, acceptedChanges: 2, observedTokensPerAcceptedChange: 7.5, complete: true });
  assert.deepEqual(build(10, 5, ['codex']).summary.efficiency, { observedTokens: 15, acceptedChanges: 2, observedTokensPerAcceptedChange: 7.5, complete: false });
});

// CQ-M04c archived baseline: the committed n=1 execution under docs/baselines/cq-m04.
import { normalizeUsageContext as m04cContext } from '../usage-receipt.mjs';
import { normalizeUsage as m04cUsage } from '../prompt-cache-usage.mjs';

const m04cDir = fileURLToPath(new URL('../../docs/baselines/cq-m04/', import.meta.url));
const m04cRead = (...parts) => readFileSync(path.join(m04cDir, ...parts), 'utf8');
const m04cManifest = baseline.readExpectedManifest(JSON.parse(m04cRead('expected.json')));
const m04cArgs = ['--records', path.join(m04cDir, 'records'), '--project', path.join(m04cDir, 'usage'),
  '--expected', path.join(m04cDir, 'expected.json')];

test('CQ-M04c archived baseline: expected manifest and records cover exactly the 20 frozen ids', () => {
  assert.equal(m04cManifest.workloads.length, 20);
  for (const category of baseline.BASELINE_CATEGORIES) {
    assert.equal(m04cManifest.workloads.filter(item => item.category === category).length, 5);
  }
  assert.deepEqual(readdirSync(path.join(m04cDir, 'records')).sort(),
    m04cManifest.workloads.map(item => `${item.id}.json`).sort());
  const counts = {};
  for (const item of m04cManifest.workloads) {
    const record = baseline.readBaselineRecord(JSON.parse(m04cRead('records', `${item.id}.json`)));
    assert.equal(record.workload.id, item.id);
    assert.equal(record.workload.category, item.category);
    assert.equal(record.workload.caseDigest, item.caseDigest);
    assert.equal(record.run.repetition, 1);
    assert.equal(record.run.repetitionsPlanned, 1);
    assert.equal(record.run.wallClockCapMs, 3600000);
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  assert.deepEqual(counts, { maintenance: 5, defect: 5, refactor: 5, 'non-routine': 5 });
});

test('CQ-M04c archived baseline: usage receipts hold only allowlisted fields', () => {
  const contextKeys = Object.keys(m04cContext({}));
  const allowed = new Set(['version', 'timestamp', 'provider', ...contextKeys, 'sessionId', 'eventId',
    'reportedModels', 'scope', 'turnIndex', 'coverage', 'outcome', 'usage']);
  const usageKeys = new Set(Object.keys(m04cUsage('claude', undefined)));
  assert.deepEqual(readdirSync(path.join(m04cDir, 'usage')).sort(), m04cManifest.workloads.map(item => item.id).sort());
  for (const item of m04cManifest.workloads) {
    const dir = path.join(m04cDir, 'usage', item.id, 'logs', 'moe-usage');
    const files = readdirSync(dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(file.endsWith('.jsonl'), file);
      const lines = readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        const row = JSON.parse(line);
        for (const key of Object.keys(row)) assert.ok(allowed.has(key), `${item.id}: ${key}`);
        const normalized = m04cContext(row);
        for (const key of contextKeys) assert.deepEqual(row[key], normalized[key], `${item.id}: ${key}`);
        for (const key of Object.keys(row.usage)) assert.ok(usageKeys.has(key), `${item.id}: usage.${key}`);
      }
    }
  }
});

test('CQ-M04c archived baseline: the CLI reproduces report.json and report.md byte-for-byte', () => {
  const json = spawnSync(process.execPath, [baselineCli, ...m04cArgs, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0);
  assert.equal(json.stdout, m04cRead('report.json'));
  const markdown = spawnSync(process.execPath, [baselineCli, ...m04cArgs], { encoding: 'utf8' });
  assert.equal(markdown.status, 0);
  assert.equal(markdown.stdout, m04cRead('report.md'));
});

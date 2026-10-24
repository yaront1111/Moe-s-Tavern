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

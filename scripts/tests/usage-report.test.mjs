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

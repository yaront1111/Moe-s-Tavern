// CQ-M04 baseline outcome report builder over the strict per-workload record
// contract in baseline-record.mjs (re-exported here).
//
// Acceptance comes ONLY from the held-out assessment. The Moe task status, QA
// approvals, rejections and reopen counts are record-only, and token totals
// never change acceptance. Unknown usage, latency and retrieval stay null in
// JSON and 'unknown' in markdown, never 0; capped, failed, aborted and missing
// runs are always reported as rows.
import { BASELINE_CATEGORIES as CATEGORIES, BASELINE_RECORD_VERSION, BASELINE_ROLES, BASELINE_STATUSES, fail, freeze,
  readBaselineRecord, readExpectedManifest } from './baseline-record.mjs';

export { ASSESSMENT_RESULTS, BASELINE_CATEGORIES, BASELINE_RECORD_VERSION, BASELINE_ROLES, BASELINE_STATUSES, readBaselineRecord,
  readExpectedManifest } from './baseline-record.mjs';

const USAGE_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'];
const RECORD_ONLY = 'Moe task status, QA approvals, rejections and reopen counts are record-only; acceptance comes only from the held-out assessment.';
const NOT_COST = 'Token observations are not monetary cost or quota.';
// Locale-independent order with null last, so output bytes never depend on the host.
const order = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
const distinct = values => [...new Set(values)].sort(order);
const nulls = keys => Object.fromEntries(keys.map(key => [key, null]));
const metric = (observedTokens, unknownRecords) => ({ observedTokens, unknownRecords });
const unknownUsage = (taskId, reason) => ({ status: 'unknown', reason, taskId, records: null, launches: null, providers: [],
  totals: Object.fromEntries(USAGE_FIELDS.map(field => [field, metric(null, null)])), coverageScope: null, codexStreamCoverage: null });

// Joins the workload's own usage project on run.usageTaskId; anything else is unknown, never 0.
function usageOf(record, usageByWorkload) {
  const taskId = record.run.usageTaskId;
  if (taskId === null) return unknownUsage(null, 'no-usage-task-id');
  if (!usageByWorkload || !Object.hasOwn(usageByWorkload, record.workload.id)) return unknownUsage(taskId, 'no-usage-project');
  const task = usageByWorkload[record.workload.id].wholeTasks.find(entry => entry.taskId === taskId);
  if (!task) return unknownUsage(taskId, 'task-not-in-usage-project');
  return { status: 'observed', reason: null, taskId, records: task.records, launches: task.launches, providers: [...task.providers],
    totals: Object.fromEntries(USAGE_FIELDS.map(field => [field, metric(task.usage[field].observedTokens, task.usage[field].unknownRecords)])),
    coverageScope: task.coverageScope, codexStreamCoverage: task.providers.includes('codex') ? 'unconfirmed' : 'not-observed' };
}

// Held-out assessment only: Moe status, QA counts and tokens are never read here.
function acceptanceOf(assessment) {
  if (!assessment?.ran) return 'not-assessed';
  if (assessment.criteria.some(entry => entry.result === 'fail')) return 'rejected';
  const passed = assessment.exitCode === 0 && assessment.criteria.length > 0 && assessment.criteria.every(entry => entry.result === 'pass');
  return passed ? 'accepted' : 'not-assessed';
}

function rowOf(workload, record, usage) {
  const run = record?.run;
  const outcome = record?.moeOutcome;
  return { id: workload.id, category: workload.category, caseDigest: workload.caseDigest, snapshotDigest: record?.workload.snapshotDigest ?? null,
    corpusVersion: workload.corpusVersion, moeCommit: run?.moeCommit ?? null, wallClockCapMs: run?.wallClockCapMs ?? null, roles: run?.roles ?? [],
    status: run?.status ?? 'missing', capped: run?.status === 'capped', wallClockMs: run?.wallClockMs ?? null, failureReason: run?.failureReason ?? null,
    acceptance: acceptanceOf(record?.assessment), assessment: record?.assessment ?? null,
    moeOutcome: { recordOnly: true, finalStatus: outcome?.finalStatus ?? null, qaApprovals: outcome?.qaApprovals ?? null },
    repair: { qaRejections: outcome?.qaRejections ?? null, reopenCount: outcome?.reopenCount ?? null, repairAttempts: outcome?.repairAttempts ?? null },
    planning: { plannerSessions: outcome?.plannerSessions ?? null },
    retrieval: record?.retrieval ?? nulls(['sourceRetrievals', 'retrievedBytes']),
    latency: record?.latency ?? nulls(['firstCodeChangeMs', 'endToEndMs']), usage };
}

function readRecords(records, manifest) {
  if (!Array.isArray(records)) fail('records', 'must be an array');
  const wanted = new Map(manifest?.workloads.map(entry => [entry.id, entry]));
  const byId = new Map();
  records.forEach((raw, index) => {
    const at = `records[${index}]`;
    let record;
    try { record = readBaselineRecord(raw); } catch (error) { fail(at, error.message); }
    const { id, caseDigest, corpusVersion } = record.workload;
    if (byId.has(id)) fail(at, `workload ${id} has more than one record; the baseline is n=1 per workload`);
    if (manifest && !wanted.has(id)) fail(at, `workload ${id} is not in the expected manifest`);
    if (manifest && wanted.get(id).caseDigest !== caseDigest) fail(at, `workload ${id} caseDigest differs from the expected manifest`);
    if (manifest && manifest.corpusVersion !== corpusVersion) fail(at, `workload ${id} corpusVersion differs from the expected manifest`);
    byId.set(id, record);
  });
  return byId;
}

function summaryOf(rows) {
  const tally = list => Object.fromEntries([['accepted', 'accepted'], ['rejected', 'rejected'], ['notAssessed', 'not-assessed']]
    .map(([key, value]) => [key, list.filter(row => row.acceptance === value).length]));
  const observed = rows.filter(row => row.usage.status === 'observed');
  const totals = Object.fromEntries(USAGE_FIELDS.map(field => {
    const metrics = observed.map(row => row.usage.totals[field]);
    const values = metrics.map(entry => entry.observedTokens).filter(value => value !== null);
    const sum = values.reduce((total, value) => total + value, 0);
    // A row whose own total overflowed (null with no unknown records) makes the field unknown, never silently skipped.
    const overflowed = metrics.some(entry => entry.observedTokens === null && entry.unknownRecords === 0);
    return [field, metric(values.length && !overflowed && Number.isSafeInteger(sum) ? sum : null, metrics.reduce((total, entry) => total + entry.unknownRecords, 0))];
  }));
  const usage = { unknownWorkloads: rows.length - observed.length,
    codexStreamUnconfirmed: observed.filter(row => row.usage.codexStreamCoverage === 'unconfirmed').length, totals };
  const acceptance = tally(rows);
  const observedTokens = totals.totalTokens.observedTokens;
  return { workloads: rows.length,
    byStatus: Object.fromEntries([...BASELINE_STATUSES, 'missing'].map(status => [status, rows.filter(row => row.status === status).length])),
    acceptance, byCategory: Object.fromEntries(CATEGORIES.map(category => {
      const list = rows.filter(row => row.category === category);
      return [category, { workloads: list.length, ...tally(list) }];
    })),
    usage, efficiency: { observedTokens, acceptedChanges: acceptance.accepted,
      observedTokensPerAcceptedChange: acceptance.accepted && observedTokens !== null ? observedTokens / acceptance.accepted : null,
      complete: !usage.unknownWorkloads && !usage.codexStreamUnconfirmed && observedTokens !== null && totals.totalTokens.unknownRecords === 0 } };
}

function inputsOf(records, manifest) {
  const runs = records.map(record => record.run);
  const roles = new Map(runs.flatMap(run => run.roles).map(({ role, cli, model, effort }) => [JSON.stringify([role, cli, model, effort]), { role, cli, model, effort }]));
  const rank = (a, b) => BASELINE_ROLES.indexOf(a.role) - BASELINE_ROLES.indexOf(b.role) || order(a.cli, b.cli) || order(a.model, b.model) || order(a.effort, b.effort);
  const of = key => distinct(runs.map(run => run[key]));
  return { recordVersion: BASELINE_RECORD_VERSION, expected: manifest && { corpusVersion: manifest.corpusVersion, workloads: manifest.workloads.length },
    corpusVersions: distinct(records.map(record => record.workload.corpusVersion)), moeCommits: of('moeCommit'), wallClockCapsMs: of('wallClockCapMs'),
    repetitionsPlanned: of('repetitionsPlanned'), platforms: of('platform'), nodeVersions: of('nodeVersion'), cliVersions: of('cliVersion'),
    roles: [...roles.values()].sort(rank),
    workloads: records.map(({ workload }) => ({ id: workload.id, caseDigest: workload.caseDigest, snapshotDigest: workload.snapshotDigest })) };
}

function limitationsOf(rows, summary, inputs) {
  const { byStatus, acceptance, usage } = summary;
  const unknownIn = group => rows.filter(row => Object.values(row[group]).includes(null)).length;
  const [retrieval, latency] = [unknownIn('retrieval'), unknownIn('latency')];
  const mixed = (values, what, suffix = '') => values.length > 1 && `Runs used ${values.length} different ${what}${suffix}.`;
  return ['One run per workload (n=1): no variability or confidence estimate is possible.',
    `Runs not completed: ${byStatus.capped} capped, ${byStatus.failed} failed, ${byStatus.aborted} aborted, ${byStatus.missing} missing; every run is reported as a row and capped runs keep partial counters.`,
    acceptance.notAssessed > 0 && `${acceptance.notAssessed} workload(s) were not assessed; they count as neither accepted nor rejected.`,
    usage.unknownWorkloads > 0 && `Usage is unknown for ${usage.unknownWorkloads} workload(s); observed totals exclude them and are not zero.`,
    'Usage covers observed log records only; participation that was not logged is missing, not zero.',
    usage.codexStreamUnconfirmed > 0 && `Codex usage stream coverage is unconfirmed for ${usage.codexStreamUnconfirmed} workload(s); completed turns do not prove the stream closed.`,
    retrieval > 0 && `Retrieval counters are unknown for ${retrieval} workload(s).`,
    latency > 0 && `Latency counters are unknown for ${latency} workload(s).`,
    mixed(inputs.moeCommits, 'Moe commits', '; they are not matched on the commit under test'),
    mixed(inputs.wallClockCapsMs, 'wall-clock caps'), mixed(inputs.corpusVersions, 'corpus versions'),
    RECORD_ONLY, NOT_COST].filter(Boolean);
}

// Builds the n=1 baseline report: one row per record, plus a 'missing' row for every
// manifest workload without one. Rows follow the manifest, else workload id order.
export function buildBaselineReport({ records, usageByWorkload = null, expected = null }) {
  const manifest = expected == null ? null : readExpectedManifest(expected);
  const byId = readRecords(records, manifest);
  const ids = manifest ? manifest.workloads.map(entry => entry.id) : [...byId.keys()].sort(order);
  const rows = ids.map(id => {
    const record = byId.get(id);
    if (record) return rowOf(record.workload, record, usageOf(record, usageByWorkload));
    const entry = manifest.workloads.find(workload => workload.id === id);
    return rowOf({ ...entry, corpusVersion: manifest.corpusVersion }, null, unknownUsage(null, 'no-record'));
  });
  const summary = summaryOf(rows);
  const inputs = inputsOf(ids.filter(id => byId.has(id)).map(id => byId.get(id)), manifest);
  return freeze({ version: 1, inputs, rows, summary, limitations: limitationsOf(rows, summary, inputs) });
}

const shown = value => value ?? 'unknown';
const cell = value => String(shown(value)).replace(/\|/g, '\\|');
const tokensShown = entry => `${shown(entry.observedTokens)}${entry.unknownRecords ? ` (+${entry.unknownRecords} unknown records)` : ''}`;
const verdicts = entry => `accepted ${entry.accepted}, rejected ${entry.rejected}, not assessed ${entry.notAssessed}`;

function rowLine(row) {
  const criteria = row.assessment && `${row.assessment.criteria.filter(entry => entry.result === 'pass').length}/${row.assessment.criteria.length}`;
  return `| ${[row.id, row.category, row.status, row.acceptance, criteria, row.moeOutcome.finalStatus, row.repair.qaRejections, row.repair.reopenCount,
    row.repair.repairAttempts, row.planning.plannerSessions, row.retrieval.sourceRetrievals, row.latency.endToEndMs, row.latency.firstCodeChangeMs,
    tokensShown(row.usage.totals.totalTokens)].map(cell).join(' | ')} |`;
}

function summaryLines({ workloads, byStatus, acceptance, byCategory, usage: { totals, unknownWorkloads }, efficiency }) {
  return [`- Workloads: ${workloads}; ${Object.entries(byStatus).map(([status, count]) => `${status} ${count}`).join(', ')}`,
    `- Acceptance (held-out assessment): ${verdicts(acceptance)}`,
    ...Object.entries(byCategory).map(([category, entry]) => `- ${category}: ${entry.workloads} workload(s); ${verdicts(entry)}`),
    `- Observed total tokens: ${tokensShown(totals.totalTokens)}; workloads with unknown usage: ${unknownWorkloads}`,
    `- Observed input ${tokensShown(totals.inputTokens)}; cache read ${tokensShown(totals.cacheReadTokens)}; cache write ${tokensShown(totals.cacheWriteTokens)}; uncached input ${tokensShown(totals.uncachedInputTokens)}; output ${tokensShown(totals.outputTokens)}; reasoning (subset of output) ${tokensShown(totals.reasoningTokens)}`,
    `- Observed tokens per accepted change: ${shown(efficiency.observedTokensPerAcceptedChange)}${efficiency.complete ? '' : ' (incomplete usage coverage)'}`];
}

export function formatBaselineReport(report) {
  const { inputs } = report;
  const listed = values => values.map(shown).join(', ') || 'none';
  const expected = inputs.expected ? `corpus version ${inputs.expected.corpusVersion}, ${inputs.expected.workloads} workload(s)` : 'none';
  return ['# Baseline outcome report', '', 'Acceptance = held-out assessment only; Moe task status is record-only.', NOT_COST, '',
    '## Inputs', `- Record version: ${inputs.recordVersion}`, `- Expected manifest: ${expected}`, `- Corpus versions: ${listed(inputs.corpusVersions)}`,
    `- Moe commits: ${listed(inputs.moeCommits)}`, `- Wall-clock caps (ms): ${listed(inputs.wallClockCapsMs)}`,
    `- Repetitions planned: ${listed(inputs.repetitionsPlanned)}`, `- Platforms: ${listed(inputs.platforms)}`,
    `- Node versions: ${listed(inputs.nodeVersions)}`, `- CLI versions: ${listed(inputs.cliVersions)}`,
    '- Roles:', ...inputs.roles.map(entry => `  - ${entry.role} ${entry.cli} model=${shown(entry.model)} effort=${shown(entry.effort)}`),
    '- Workloads:', ...inputs.workloads.map(entry => `  - ${entry.id}: case ${entry.caseDigest}, snapshot ${entry.snapshotDigest}`), '',
    '## Workloads', '| Workload | Category | Status | Acceptance | Criteria passed | Moe status (record-only) | QA rejections | Reopens | Repair attempts | Planner sessions | Source retrievals | End-to-end ms | First code change ms | Observed total tokens |',
    `|${' --- |'.repeat(14)}`, ...report.rows.map(rowLine), '',
    '## Summary', ...summaryLines(report.summary), '', '## Limitations', ...report.limitations.map(entry => `- ${entry}`)].join('\n');
}

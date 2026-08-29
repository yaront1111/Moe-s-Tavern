#!/usr/bin/env node
// Task-size vs outcome analysis over git-tracked .moe/tasks/*.json.
//
// The plan-size gates (submit_plan warn/reject thresholds) and the small-task
// slicing rules are built on external evidence; this script closes the loop on
// THIS fleet's data: it buckets tasks by planned size and reports reopen/reject
// rates per bucket, so threshold changes can be argued from numbers instead of
// vibes. Read-only — safe to run any time, no daemon required.
//
// Usage:
//   node scripts/analyze-task-metrics.mjs [--project <path>] [--json]
//   node scripts/analyze-task-metrics.mjs --commits [--project <path>] [--json]
//
// --commits switches to the land-on-every-exit audit: it buckets the wrapper's
// commits per task (`feat|fix` completions / `wip` checkpoints / `rescue`
// snapshots) from `git log --format='%H %s' --grep='Moe-Task:'` joined with
// the daemon ledger (`task.commits` / `task.lastCommitOutcome`), flags tasks
// whose last landing reported a non-`nothing` outcome with no commit to show
// for it, and lists unrecovered `refs/moe/rescue/*` refs.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}
const projectPath = path.resolve(argValue('--project') || process.env.MOE_PROJECT_PATH || process.cwd());
const asJson = args.includes('--json');
const commitsMode = args.includes('--commits');

const tasksDir = path.join(projectPath, '.moe', 'tasks');
if (!fs.existsSync(tasksDir)) {
  console.error(`No .moe/tasks directory under ${projectPath} (use --project <path>)`);
  process.exit(1);
}

const tasks = [];
for (const file of fs.readdirSync(tasksDir)) {
  if (!file.endsWith('.json')) continue;
  try {
    tasks.push(JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8')));
  } catch {
    console.error(`skip unparsable ${file}`);
  }
}

if (commitsMode) {
  // ---- land-on-every-exit audit (--commits) --------------------------------
  function git(gitArgs) {
    try {
      return execFileSync('git', ['-C', projectPath, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
  }
  const logOut = git(['log', '--format=%H %s', '--grep=Moe-Task:']);
  if (logOut === null) {
    console.error(`git log failed under ${projectPath} — not a git repo, or git is unavailable`);
    process.exit(1);
  }
  // Subject shapes are grep-stable: feat(<taskId>): … | fix(<taskId>): … (retry
  // after qa_reject #N) | wip(<taskId>): … | rescue(<taskId>): … [reason=…]
  const perTask = new Map();
  const bucketFor = (id) => {
    if (!perTask.has(id)) perTask.set(id, { completion: 0, wip: 0, rescue: 0, ledger: 0 });
    return perTask.get(id);
  };
  for (const line of logOut.split('\n')) {
    const m = line.match(/^[0-9a-f]{40} (feat|fix|wip|rescue)\(([^)]+)\):/);
    if (!m) continue;
    const b = bucketFor(m[2]);
    if (m[1] === 'wip') b.wip += 1;
    else if (m[1] === 'rescue') b.rescue += 1;
    else b.completion += 1;
  }
  for (const t of tasks) {
    if (Array.isArray(t.commits) && t.commits.length > 0) bucketFor(t.id).ledger = t.commits.length;
  }
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // The §13.3 check: a landing that reported committed/refused/failed but no
  // commit is anywhere to be found (neither on this branch nor in the ledger).
  const silent = tasks.filter((t) => {
    const outcome = t.lastCommitOutcome?.outcome;
    if (!outcome || outcome === 'nothing') return false;
    const b = perTask.get(t.id);
    return !b || (b.completion + b.wip + b.rescue + b.ledger) === 0;
  });
  const rescueRefsOut = git(['for-each-ref', '--format=%(refname) %(objectname:short) %(subject)', 'refs/moe/rescue/']) || '';
  const rescueRefs = rescueRefsOut.split('\n').filter((l) => l.trim());
  const report = {
    project: projectPath,
    tasksWithCommits: Array.from(perTask.entries()).map(([id, b]) => ({
      taskId: id,
      completion: b.completion,
      wip: b.wip,
      rescue: b.rescue,
      ledgerEntries: b.ledger,
      status: taskById.get(id)?.status ?? null,
      lastCommitOutcome: taskById.get(id)?.lastCommitOutcome ?? null,
    })),
    silentLandings: silent.map((t) => ({ taskId: t.id, status: t.status, lastCommitOutcome: t.lastCommitOutcome })),
    unrecoveredRescueRefs: rescueRefs,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  console.log(`Wrapper landings per task — ${projectPath}`);
  console.log(`(git log --grep 'Moe-Task:' on the current branch, joined with task.commits)\n`);
  const cHeaders = ['taskId', 'feat|fix', 'wip', 'rescue', 'ledger', 'status', 'last outcome'];
  const cTable = report.tasksWithCommits.map((r) => [
    r.taskId, r.completion, r.wip, r.rescue, r.ledgerEntries, r.status ?? '?',
    r.lastCommitOutcome ? `${r.lastCommitOutcome.outcome}${r.lastCommitOutcome.code ? ` (${r.lastCommitOutcome.code})` : ''}` : '-',
  ]);
  if (cTable.length === 0) {
    console.log('No Moe-Task commits on this branch and no task.commits ledger entries.');
  } else {
    const cWidths = cHeaders.map((h, i) => Math.max(h.length, ...cTable.map((row) => String(row[i]).length)));
    const cFmt = (row) => row.map((c, i) => String(c).padEnd(cWidths[i])).join('  ');
    console.log(cFmt(cHeaders));
    console.log(cWidths.map((w) => '-'.repeat(w)).join('  '));
    for (const row of cTable) console.log(cFmt(row));
  }
  console.log(`\n${silent.length} task(s) with a non-nothing lastCommitOutcome and no commit found` +
    (silent.length ? `: ${silent.map((t) => t.id).join(', ')}` : ' — the land-on-every-exit invariant holds.'));
  if (rescueRefs.length) {
    console.log(`\n${rescueRefs.length} unrecovered rescue ref(s) — review weekly, recover with git checkout <ref> -- <path>, then delete the ref:`);
    for (const l of rescueRefs) console.log(`  ${l}`);
  } else {
    console.log('\nNo refs/moe/rescue/* refs outstanding.');
  }
  process.exit(0);
}

// Only tasks that ever had a plan carry a size signal.
const planned = tasks.filter((t) => (t.metrics?.plannedStepCount ?? (t.implementationPlan?.length || 0)) > 0);

function stepCount(t) {
  return t.metrics?.plannedStepCount ?? t.implementationPlan?.length ?? 0;
}
function distinctFiles(t) {
  if (typeof t.metrics?.plannedDistinctFileCount === 'number') return t.metrics.plannedDistinctFileCount;
  const set = new Set();
  for (const s of t.implementationPlan || []) for (const f of s.affectedFiles || []) set.add(f);
  return set.size;
}
function rejects(t) {
  return t.rejectionHistory?.length ?? t.metrics?.rejectCount ?? 0;
}

const BUCKETS = [
  { label: '1-4 steps', min: 1, max: 4 },
  { label: '5-8 steps', min: 5, max: 8 },
  { label: '9-12 steps', min: 9, max: 12 },
  { label: '13+ steps', min: 13, max: Infinity },
];

const rows = BUCKETS.map((b) => {
  const inBucket = planned.filter((t) => stepCount(t) >= b.min && stepCount(t) <= b.max);
  const done = inBucket.filter((t) => t.status === 'DONE');
  const totalReopens = inBucket.reduce((n, t) => n + (t.reopenCount || 0), 0);
  const totalRejects = inBucket.reduce((n, t) => n + rejects(t), 0);
  const reopened = inBucket.filter((t) => (t.reopenCount || 0) > 0);
  const parked = inBucket.filter((t) => t.needsHumanReview);
  const avgFiles = inBucket.length
    ? inBucket.reduce((n, t) => n + distinctFiles(t), 0) / inBucket.length
    : 0;
  const withVerification = inBucket.filter((t) => t.verification?.command);
  return {
    bucket: b.label,
    tasks: inBucket.length,
    done: done.length,
    reopenedPct: inBucket.length ? Math.round((reopened.length / inBucket.length) * 100) : 0,
    reopensPerTask: inBucket.length ? +(totalReopens / inBucket.length).toFixed(2) : 0,
    rejectsPerTask: inBucket.length ? +(totalRejects / inBucket.length).toFixed(2) : 0,
    parked: parked.length,
    avgDistinctFiles: +avgFiles.toFixed(1),
    withVerification: withVerification.length,
  };
});

const summary = {
  project: projectPath,
  totalTasks: tasks.length,
  plannedTasks: planned.length,
  buckets: rows,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`Task-size vs outcome — ${projectPath}`);
console.log(`${tasks.length} tasks on disk, ${planned.length} with a submitted plan\n`);
const headers = ['bucket', 'tasks', 'done', 'reopened%', 'reopens/task', 'rejects/task', 'parked', 'avg files', 'w/ verification'];
const table = rows.map((r) => [
  r.bucket, r.tasks, r.done, r.reopenedPct + '%', r.reopensPerTask, r.rejectsPerTask, r.parked, r.avgDistinctFiles, r.withVerification,
]);
const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => String(row[i]).length)));
const fmt = (row) => row.map((c, i) => String(c).padEnd(widths[i])).join('  ');
console.log(fmt(headers));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(fmt(row));
console.log('\nReading it: if reopens/task and rejects/task climb with bucket size, the small-task thresholds are earning their keep; tune settings.taskSizing accordingly.');

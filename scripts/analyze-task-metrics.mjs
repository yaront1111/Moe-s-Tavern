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

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}
const projectPath = path.resolve(argValue('--project') || process.env.MOE_PROJECT_PATH || process.cwd());
const asJson = args.includes('--json');

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

// analyze-task-metrics.mjs counts a bucket's `done` with the daemon's delivered rule
// (packages/moe-daemon/src/util/metrics.ts isDelivered, task-83cf11f5): a DONE row,
// or an ARCHIVED row that reached DONE (non-blank metrics.doneAt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'analyze-task-metrics.mjs');
const DONE_AT = '2026-11-01T11:00:00.000Z';

function plan(n) {
  return Array.from({ length: n }, (_, i) => ({ stepId: `step-${i + 1}`, status: 'COMPLETED', affectedFiles: [`f${i}.ts`] }));
}

function withProject(t, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'atm-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.moe', 'tasks');
  mkdirSync(dir, { recursive: true });
  const write = (id, status, metrics, steps = 2) => {
    const rec = { id, status, reopenCount: 0, implementationPlan: plan(steps) };
    if (metrics !== undefined) rec.metrics = metrics;
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  };
  return fn(root, write);
}

// A clean env keeps the seat's MOE_PROJECT_PATH out of the run.
function run(root, extra = []) {
  return execFileSync(process.execPath, [script, '--project', root, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
}
const runJson = (root) => JSON.parse(run(root, ['--json']));

test('done counts DONE plus ARCHIVED rows that reached DONE, not shelved ones', (t) => {
  withProject(t, (root, write) => {
    write('task-done', 'DONE', { plannedStepCount: 2, doneAt: DONE_AT });
    write('task-cleared', 'ARCHIVED', { plannedStepCount: 2, doneAt: DONE_AT });
    write('task-shelved', 'ARCHIVED', { plannedStepCount: 2 });
    const b = runJson(root).buckets[0];
    assert.equal(b.tasks, 3);
    assert.equal(b.done, 2);
  });
});

test('all-ARCHIVED rows with doneAt give done === tasks in every non-empty bucket', (t) => {
  withProject(t, (root, write) => {
    for (const n of [2, 6, 10, 14]) write(`task-a${n}`, 'ARCHIVED', { plannedStepCount: n, doneAt: DONE_AT }, n);
    const { buckets } = runJson(root);
    for (const b of buckets) {
      assert.equal(b.tasks, 1, b.bucket);
      assert.equal(b.done, b.tasks, b.bucket);
    }
  });
});

test('blank doneAt, a missing metrics object and a non-object metrics are not delivered', (t) => {
  withProject(t, (root, write) => {
    write('task-blank', 'ARCHIVED', { plannedStepCount: 2, doneAt: '  ' });
    write('task-nometrics', 'ARCHIVED', undefined);
    write('task-stringmetrics', 'ARCHIVED', 'x');
    write('task-nullmetrics', 'ARCHIVED', null);
    write('task-numdoneat', 'ARCHIVED', { plannedStepCount: 2, doneAt: 5 });
    write('task-review-stale', 'REVIEW', { plannedStepCount: 2, doneAt: DONE_AT });
    write('task-done-nometrics', 'DONE', undefined);
    const b = runJson(root).buckets[0];
    assert.equal(b.tasks, 7);
    assert.equal(b.done, 1, 'only the DONE row without metrics is delivered');
  });
});

test('the table shows the same done value and keeps the done column header', (t) => {
  withProject(t, (root, write) => {
    write('task-done', 'DONE', { plannedStepCount: 2, doneAt: DONE_AT });
    write('task-cleared', 'ARCHIVED', { plannedStepCount: 2, doneAt: DONE_AT });
    write('task-shelved', 'ARCHIVED', { plannedStepCount: 2 });
    const lines = run(root).split('\n');
    const header = lines.find((l) => l.startsWith('bucket'));
    const row = lines.find((l) => l.startsWith('1-4 steps'));
    assert.ok(header && row);
    const cols = (l) => l.trim().split(/\s{2,}/);
    assert.equal(cols(header)[2], 'done');
    assert.equal(cols(row)[2], '2');
  });
});

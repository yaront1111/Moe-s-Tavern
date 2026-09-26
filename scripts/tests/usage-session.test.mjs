import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../usage-session.mjs', import.meta.url));
function run(project, context) {
  return spawnSync(process.execPath, [helper, project], {
    encoding: 'utf8', env: { ...process.env, MOE_USAGE_CONTEXT_JSON: context },
  });
}

test('each launch gets a private new receipt with its own metadata', t => {
  const project = mkdtempSync(path.join(tmpdir(), 'moe usage 漢字 '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const context = JSON.stringify({ taskId: 'task-A', requestedModel: 'claude-opus-5-5', launchId: 'stale' });
  const launches = [run(project, context), run(project, context)].map(result => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.notEqual(launches[0].file, launches[1].file);
  for (const launch of launches) {
    assert.equal(path.dirname(launch.file), path.join(project, 'logs', 'moe-usage'));
    assert.equal(readFileSync(launch.file, 'utf8'), '');
    assert.notEqual(launch.context.launchId, 'stale');
    assert.equal(launch.context.taskId, 'task-A');
    assert.equal(launch.context.requestedModel, 'claude-opus-5-5');
    if (process.platform !== 'win32') assert.equal(statSync(launch.file).mode & 0o777, 0o600);
  }
});

test('preparation fails without exposing malformed metadata or file paths', t => {
  const project = mkdtempSync(path.join(tmpdir(), 'moe usage '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const invalid of ['{private-prompt', '[]', 'null']) {
    const result = run(project, invalid);
    assert.equal(result.status, 0, 'diagnostics must not fail the provider launch');
    assert.equal(result.stdout.trim(), '');
    assert.match(result.stderr, /MOE_USAGE_REPORT_UNAVAILABLE/);
    assert.ok(!result.stderr.includes(project));
    assert.ok(!result.stderr.includes('private-prompt'));
  }
  writeFileSync(path.join(project, 'logs'), 'occupied');
  const result = run(project, '{}');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /MOE_USAGE_REPORT_UNAVAILABLE/);
});

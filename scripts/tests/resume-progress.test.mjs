import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Execute the real resume-budget blocks of both wrappers, not a duplicated
// fixture. Do not launch the full wrapper: that would contact a daemon and claim work.
const read = name => readFileSync(new URL(`../moe-agent.${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing block boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const shBlock = between(read('sh'), '# Resume budget vs real progress', '# Launch-failure tracking');
const psBlock = between(read('ps1'), '# Resume budget vs real progress', '# Launch-failure tracking');
const windows = process.platform === 'win32';
const engines = windows
  ? [['bash', 'C:/Program Files/Git/bin/bash.exe'], ['powershell', 'powershell.exe'], ['pwsh', 'pwsh.exe']]
  : [['bash', '/bin/bash']];

const TASK = 'task-fixture';
const context = (statuses, id = TASK) => JSON.stringify({
  task: { id, implementationPlan: statuses.map((status, i) => ({ stepId: `step-${i}`, status })) },
});

// One wrapper session: the pre-launch get_context, the CLI exit, the
// post-session get_context. Returns the pre-launch mark and the budget after.
function session(engine, executable, { before, after, attempts, escalated }) {
  let script;
  if (engine === 'bash') {
    script = `PYTHON_CMD=${windows ? 'python' : 'python3'}; GREEN=''; NC=''
PREFLIGHT_TASK_ID=${TASK}; RESUME_ATTEMPTS=${attempts}; RESUME_ESCALATED=${escalated}
${shBlock}
PREFLIGHT_PROGRESS_MARK="$(plan_progress_mark "$MOE_FIXTURE_BEFORE" "$PREFLIGHT_TASK_ID")"
rearm_resume_on_progress "$MOE_FIXTURE_AFTER"
printf '\\036%s\\036%s\\036%s' "$PREFLIGHT_PROGRESS_MARK" "$RESUME_ATTEMPTS" "$RESUME_ESCALATED"
`;
  } else {
    // Invoke-MoeRpc hands the wrapper parsed JSON; anything else arrives as text.
    script = `\ufeff$ErrorActionPreference = 'Stop'
$script:ResumeAttempts = ${attempts}; $script:ResumeEscalated = $${escalated}
${psBlock}
function Get-Fixture([string]$Text) { if (-not $Text) { return $null }; try { return ($Text | ConvertFrom-Json) } catch { return $Text } }
$script:PreflightProgressMark = Get-PlanProgressMark -Context (Get-Fixture $env:MOE_FIXTURE_BEFORE) -TaskId '${TASK}'
Update-ResumeBudgetOnProgress -Context (Get-Fixture $env:MOE_FIXTURE_AFTER) -TaskId '${TASK}'
[Console]::Write(([char]30).ToString() + $script:PreflightProgressMark + [char]30 + $script:ResumeAttempts + [char]30 + $script:ResumeEscalated.ToString().ToLower())
`;
  }
  // A file, not -c: real blocks carry quotes that native argument forwarding rewrites.
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-resume-'));
  const file = path.join(dir, engine === 'bash' ? 'resume.sh' : 'resume.ps1');
  let result;
  try {
    writeFileSync(file, script);
    const args = engine === 'bash'
      ? ['--noprofile', '--norc', file.replaceAll('\\', '/')]
      : ['-NoProfile', '-NonInteractive', '-File', file];
    result = spawnSync(executable, args, {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, MOE_FIXTURE_BEFORE: before, MOE_FIXTURE_AFTER: after },
    });
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parts = result.stdout.split('\x1e');
  assert.equal(parts.length, 4, result.stdout);
  return { mark: parts[1], attempts: Number(parts[2]), escalated: parts[3].trim(), log: parts[0] };
}

for (const [engine, executable] of engines) {
  test(`${engine}: a session that completed a plan step re-arms the resume budget`, () => {
    const r = session(engine, executable, {
      before: context(['COMPLETED', 'COMPLETED', 'IN_PROGRESS', 'PENDING']),
      after: context(['COMPLETED', 'COMPLETED', 'COMPLETED', 'IN_PROGRESS']),
      attempts: 4, escalated: true,
    });
    assert.equal(r.mark, '2');
    assert.equal(r.attempts, 0);
    assert.equal(r.escalated, 'false', 'a later death loop must be able to page the governor again');
    assert.match(r.log, /completed 1 plan step\(s\) this session \(2 -> 3\)/);
    assert.match(r.log, /resume budget re-armed/);
  });

  // The cap's purpose survives: anything short of a completed step keeps counting.
  for (const [name, before, after] of [
    ['no step completed', context(['COMPLETED', 'IN_PROGRESS']), context(['COMPLETED', 'IN_PROGRESS'])],
    ['a step reopened', context(['COMPLETED', 'COMPLETED']), context(['COMPLETED', 'PENDING'])],
    ['the post-session payload names another task', context(['IN_PROGRESS']), context(['COMPLETED'], 'task-other')],
    ['the post-session payload is not JSON', context(['IN_PROGRESS']), 'not json'],
    ['the post-session payload is missing', context(['IN_PROGRESS']), ''],
    ['the pre-launch payload is missing', '', context(['COMPLETED', 'COMPLETED'])],
    ['the pre-launch payload names another task', context([], 'task-other'), context(['COMPLETED'])],
  ]) {
    test(`${engine}: ${name} keeps the resume count`, () => {
      const r = session(engine, executable, { before, after, attempts: 3, escalated: true });
      assert.equal(r.attempts, 3);
      assert.equal(r.escalated, 'true');
      assert.doesNotMatch(r.log, /re-armed/);
    });
  }

  test(`${engine}: a first session's progress stays quiet when nothing was counted`, () => {
    const r = session(engine, executable, {
      before: context(['IN_PROGRESS', 'PENDING']), after: context(['COMPLETED', 'IN_PROGRESS']),
      attempts: 0, escalated: false,
    });
    assert.equal(r.mark, '0');
    assert.equal(r.attempts, 0);
    assert.doesNotMatch(r.log, /re-armed/);
  });
}

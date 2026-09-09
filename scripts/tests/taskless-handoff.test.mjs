import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Execute the real prompt-building blocks, not a duplicated prompt fixture.
// Do not launch the full wrapper: that would contact a daemon and claim work.
const read = name => readFileSync(new URL(`../moe-agent.${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing prompt boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const ps = read('ps1');
const sh = read('sh');
const psContext = between(ps, '    $dynamicContext = ""', '    # -------- Pre-flight baseline');
const psBody = between(ps, '    $claimPromptBody = $null', '    $script:CliLaunchedAt = Get-Date');
const shPrompt = between(sh, '    DYNAMIC_CONTEXT=""', '    # -------- Pre-flight landing: recovery');
const windows = process.platform === 'win32';
const engines = windows
  ? [['bash', 'C:/Program Files/Git/bin/bash.exe'], ['powershell', 'powershell.exe'], ['pwsh', 'pwsh.exe']]
  : [['bash', '/bin/bash']];

function render(engine, executable, options = {}) {
  const o = { role: 'worker', cli: 'claude', interactive: false, loop: true, auto: true, claimed: false, noTask: true, resume: false, ...options };
  const bool = value => String(value);
  let script;
  if (engine === 'bash') {
    const setup = `ROLE=${o.role}; CLI_TYPE=${o.cli}; WORKER_ID=worker-fixture
CLAUDE_INTERACTIVE=${bool(o.interactive)}; GROK_INTERACTIVE=false
LOOP_ENABLED=${bool(o.loop)}; AUTO_CLAIM=${bool(o.auto)}
PREFLIGHT_OK=${bool(o.claimed)}; PREFLIGHT_NO_TASK=${bool(o.noTask)}
PREFLIGHT_IS_RESUME=${bool(o.resume)}; PREFLIGHT_TASK_ID=${o.claimed ? 'task-fixture' : ''}
PREFLIGHT_ROUTED_MENTIONS_COUNT=1; PREFLIGHT_ROUTED_MENTIONS_JSON='[{"content":"reply-fixture"}]'
STATUSES='["WORKING"]'; PROJECT=/nonexistent-moe-prompt-fixture
`;
    script = setup + shPrompt + '\nprintf "\\036%s\\036%s" "$DYNAMIC_CONTEXT" "$PROMPT_BODY"';
  } else {
    const setup = `$ErrorActionPreference = 'Stop'
$Role='${o.role}'; $cliType='${o.cli}'; $WorkerId='worker-fixture'
$Interactive=$${bool(o.interactive)}; $grokInteractive=$false
$loopEnabled=$${bool(o.loop)}; $AutoClaim=$${bool(o.auto)}
$preflightOk=$${bool(o.claimed)}; $preflightNoTask=$${bool(o.noTask)}
$preflightIsResume=$${bool(o.resume)}; $preflightTaskId='${o.claimed ? 'task-fixture' : ''}'
$preflightRoutedMentions=@([pscustomobject]@{content='reply-fixture'})
$statuses=@('WORKING'); $serenaProject=[IO.Path]::GetTempPath()
`;
    script = '\ufeff' + setup + psContext + psBody + '\n[Console]::Write(([char]30).ToString() + $dynamicContext + [char]30 + $claimPromptBody)';
  }
  // Real scripts exceed Windows argv limits; a file also avoids bash -c quote
  // rewriting by native argument forwarding. Nothing is written in a project.
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-prompt-'));
  const file = path.join(dir, engine === 'bash' ? 'prompt.sh' : 'prompt.ps1');
  let result;
  try {
    writeFileSync(file, script);
    const args = engine === 'bash'
      ? ['--noprofile', '--norc', file.replaceAll('\\', '/')]
      : ['-NoProfile', '-NonInteractive', '-File', file];
    result = spawnSync(executable, args, { encoding: 'utf8', timeout: 20000 });
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parts = result.stdout.split('\x1e');
  assert.equal(parts.length, 3, result.stdout);
  return { context: parts[1], body: parts[2], combined: parts.slice(1).join('\n') };
}

for (const [engine, executable] of engines) {
  for (const role of ['worker', 'qa', 'architect']) {
    test(`${engine}: taskless headless ${role} replies then returns ownership to wrapper`, () => {
      const rendered = render(engine, executable, { role });
      for (const [part, prompt] of Object.entries({ context: rendered.context, body: rendered.body })) {
        assert.match(prompt, /notification-only session/, `${part} must not invite an untracked claim`);
        assert.match(prompt, /moe\.chat_send/);
        assert.match(prompt, /Do NOT call moe\.wait_for_task or moe\.claim_next_task/);
        assert.match(prompt, /end your turn/i);
        assert.match(prompt, /baseline/i);
        assert.doesNotMatch(prompt, /When it (?:returns|wakes).*hasNext:true|FIRST action MUST be moe\.wait_for_task/);
      }
      assert.doesNotMatch(rendered.combined, /End your turn only after your terminal moe/,
        'a taskless notification must not require a task terminal call before exit');
    });
  }
  for (const [name, options, expected] of [
    ['interactive', { interactive: true }, /FIRST action MUST be moe\.wait_for_task/],
    ['no-loop', { loop: false }, /FIRST action MUST be moe\.wait_for_task/],
    ['other CLI', { cli: 'codex' }, /FIRST action MUST be moe\.wait_for_task/],
    ['governor', { role: 'governor' }, /moe\.chat_wait/],
    ['claimed', { claimed: true, noTask: false }, /Task task-fixture is claimed/],
    ['resume', { claimed: true, noTask: false, resume: true }, /RESUME:.*task-fixture/],
    ['preflight failure', { noTask: false }, /Then (?:use the MCP tool|call) moe\.claim_next_task/],
    ['manual launch', { auto: false }, /FIRST action MUST be moe\.wait_for_task/],
  ]) {
    test(`${engine}: preserves ${name} prompt contract`, () => {
      const rendered = render(engine, executable, options);
      assert.doesNotMatch(rendered.combined, /notification-only session/);
      assert.match(rendered.combined, expected);
    });
  }
}

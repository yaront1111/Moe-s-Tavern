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
  const o = { role: 'worker', cli: 'claude', interactive: false, loop: true, auto: true, claimed: false, noTask: true, resume: false, claimFailed: false, ...options };
  const bool = value => String(value);
  let script;
  if (engine === 'bash') {
    const setup = `ROLE=${o.role}; CLI_TYPE=${o.cli}; WORKER_ID=worker-fixture
CLAUDE_INTERACTIVE=${bool(o.interactive)}; GROK_INTERACTIVE=false
LOOP_ENABLED=${bool(o.loop)}; AUTO_CLAIM=${bool(o.auto)}
PREFLIGHT_OK=${bool(o.claimed)}; PREFLIGHT_NO_TASK=${bool(o.noTask)}
PREFLIGHT_IS_RESUME=${bool(o.resume)}; PREFLIGHT_TASK_ID=${o.claimed ? 'task-fixture' : ''}
PREFLIGHT_CLAIM_FAILED=${bool(o.claimFailed)}
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
$preflightClaimFailed=$${bool(o.claimFailed)}
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
  // Every taskless launch a CLAIMING role can reach under AutoClaim is
  // chat-only. The wrapper does the waiting and the claiming now, so a session
  // that may edit code is never launched without a task bound -- which is the
  // only way it can have the per-task baseline, the live-session marker and the
  // post-flight landing, all of which key on the pre-flight task id. These four
  // shapes used to render the claim invitation and are the reproduction.
  for (const [name, options] of [
    ['interactive', { interactive: true }],
    ['no-loop', { loop: false }],
    ['other CLI', { cli: 'codex' }],
    ['claim RPC failure', { noTask: false, claimFailed: true }],
  ]) {
    test(`${engine}: taskless ${name} launch is chat-only and never claims`, () => {
      const rendered = render(engine, executable, options);
      for (const [part, prompt] of Object.entries({ context: rendered.context, body: rendered.body })) {
        assert.match(prompt, /notification-only session/, `${part} must not invite an untracked claim`);
        assert.match(prompt, /moe\.chat_send/, `${part} must still route the mention reply`);
        assert.match(prompt, /Do NOT call moe\.wait_for_task or moe\.claim_next_task/,
          `${part} must forbid claiming: this session has no baseline`);
        assert.match(prompt, /edit project files/, `${part} must forbid editing without a baseline`);
      }
      assert.doesNotMatch(rendered.combined, /FIRST action MUST be moe\.wait_for_task/);
      assert.doesNotMatch(rendered.combined, /When it (?:returns|wakes) (?:with )?hasNext:true/);
    });
  }
  for (const [name, options, expected] of [
    ['governor', { role: 'governor' }, /moe\.chat_wait/],
    ['claimed', { claimed: true, noTask: false }, /Task task-fixture is claimed/],
    ['resume', { claimed: true, noTask: false, resume: true }, /RESUME:.*task-fixture/],
    // AutoClaim=false is the operator opting OUT of wrapper claiming, baseline
    // and landing altogether, so the in-CLI claim chain is still correct there
    // -- and it renders no PROMPT_BODY at all, only the dynamic context.
    ['manual launch', { auto: false }, /FIRST action MUST be moe\.wait_for_task/],
  ]) {
    test(`${engine}: preserves ${name} prompt contract`, () => {
      const rendered = render(engine, executable, options);
      assert.doesNotMatch(rendered.combined, /notification-only session/);
      assert.match(rendered.combined, expected);
    });
  }
}

// ---- Wrapper-side wait + adoption boundary: assert the GUARDS, in both
// wrappers. These live outside the rendered prompt slices (pre-flight and
// post-flight), and a fix that lands in only one wrapper is the failure mode
// this repository has shipped before, so every case is checked twice.
const wrappers = [['moe-agent.ps1', ps], ['moe-agent.sh', sh]];
for (const [name, src] of wrappers) {
  // The wait is a bounded CLAIM poll, not moe.wait_for_task: the wrappers pipe
  // one JSON line into a fresh moe-proxy and close stdin, and the proxy errors
  // every still-open request ~2s after EOF, so a blocking long-poll cannot
  // survive that transport. A looping run's wait is its own relaunch loop; a
  // single-shot run does the waiting here.
  test(`${name}: a single-shot run waits in the wrapper instead of in the CLI`, () => {
    assert.ok(src.includes('in the wrapper (single-shot run) rather than launching a CLI without one.'),
      'a --no-loop taskless run must keep re-claiming in the wrapper, not hand an unbound CLI the claim');
    assert.ok(src.includes('the wrapper polls again in'),
      'a looping taskless run must say the wrapper (not the CLI) will retry');
  });
  test(`${name}: a taskless iteration never launches an unbound editing CLI`, () => {
    for (const reason of ['reason=idle', 'reason=claim-failed']) {
      assert.ok(src.includes(`MOE_TASKLESS_NO_LAUNCH ${reason}`),
        `missing the suppressed-launch outcome "${reason}" -- every taskless exit of the wait must be named, not silent`);
    }
  });
  // The alarm for a path nobody wrote: a session launched WITHOUT a task that
  // ends holding one has no pre-edit baseline, so it must refuse to land under
  // a named code rather than exit silently. Behaviour is proven end-to-end by
  // scenario AB in scripts/tests/postflight.{sh,ps1}; this only pins that both
  // wrappers carry the code (parity-check enforces the MOE_COMMIT_ family too).
  test(`${name}: an adopted task with no baseline has a named refusal`, () => {
    assert.ok(src.includes('MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE'),
      'an adopted task with a dirty tree must produce a named refusal, not silence');
  });
}

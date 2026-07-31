param()
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$wrapper = Join-Path $root 'scripts\moe-agent.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('moe-postflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host 'SKIP postflight.ps1: node is not available'
        exit 0
    }

    # Prefer pwsh (CI), fall back to Windows PowerShell 5.1 — the wrapper
    # targets 5.1, so either engine is a valid harness host.
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

    $conflictOut = Join-Path $tempRoot 'conflict.out'
    # Windows PowerShell 5.1 wraps a child's stderr lines into ErrorRecords
    # when redirected, which $ErrorActionPreference='Stop' escalates to a
    # throw even though the child exited as expected. Relax EAP around child
    # invocations; exit codes are checked explicitly.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $psExe -NoProfile -File $wrapper -Loop -NoLoop *> $conflictOut
    $conflictCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($conflictCode -ne 2) {
        Get-Content $conflictOut -ErrorAction SilentlyContinue | Write-Error
        throw "Expected -Loop -NoLoop to exit 2; got $conflictCode"
    }

    $projectDir = Join-Path $tempRoot 'project'
    $homeDir = Join-Path $tempRoot 'home'
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir '.moe\messages') | Out-Null
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    Set-Content -Path (Join-Path $projectDir '.moe\project.json') -Value '{"id":"proj-smoke","name":"postflight-smoke","settings":{"autoCommit":false}}' -Encoding UTF8
    Set-Content -Path (Join-Path $projectDir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8

    $fakeProxy = Join-Path $tempRoot 'fake-proxy.js'
    Set-Content -Path $fakeProxy -Encoding UTF8 -Value @'
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(0, 'utf8').trim();
const req = raw ? JSON.parse(raw) : { id: 1, params: { name: '', arguments: {} } };
const tool = String(req.params?.name || '').replace(/^moe\./, '');
const args = req.params?.arguments || {};
const project = process.env.MOE_PROJECT_PATH || process.cwd();
const moe = path.join(project, '.moe');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ok(payload) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: req.id || 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }) + '\n');
}
switch (tool) {
  case 'create_team': ok({ team: { id: 'team-smoke', name: args.name || 'Smoke' } }); break;
  case 'join_team': ok({ success: true }); break;
  case 'chat_channels': ok({ channels: [{ id: 'chan-general', name: 'general', type: 'general' }] }); break;
  case 'chat_join': ok({ success: true }); break;
  case 'chat_read': ok({ messages: [], cursor: null, truncated: 0 }); break;
  case 'get_pending_questions': ok({ count: 0, tasks: [] }); break;
  case 'claim_next_task': {
    if (process.env.FAKE_CLAIM_MODE === 'resume') {
      // One-task-per-worker guard shape (claimNextTask.ts): the worker already
      // holds an active task from a CLI session that died mid-task.
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: 'REVIEW' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume (REVIEW).' }
      });
    } else {
      ok({ hasNext: true, task: { id: 'task-postflight', title: 'Postflight smoke', status: 'WORKING', chatChannel: 'chan-task' } });
    }
    break;
  }
  case 'get_context': {
    // Mirrors getContext.ts: the task projection carries NO epicId and NO order
    // (the resolved epic comes back alongside it instead), and an unresolvable
    // taskId falls back to the CALLER's currentTaskId rather than erroring --
    // so a stale id silently answers with a different task.
    // 'empty'    => daemon answered but carried no task.
    // 'mismatch' => the real fallback: some OTHER task comes back.
    if (process.env.FAKE_GET_CONTEXT_FAIL === 'empty') { ok({}); break; }
    const ctxTaskId = process.env.FAKE_GET_CONTEXT_FAIL === 'mismatch'
      ? 'task-someone-elses'
      : (args.taskId || 'task-postflight');
    ok({
      task: {
        id: ctxTaskId,
        status: process.env.FAKE_TASK_STATUS || 'WORKING',
        reopenCount: 0,
        implementationPlan: [],
        definitionOfDone: []
      },
      project: {}, epic: { id: 'epic-1', title: 'Smoke epic' }, nextAction: { tool: 'moe.start_step' }
    });
    break;
  }
  case 'list_tasks': {
    const epicTasks = [
      { id: 'task-postflight', status: process.env.FAKE_TASK_STATUS || 'WORKING', reopenCount: 0, epicId: 'epic-1', order: 1 },
      ...(process.env.FAKE_SIBLING_ORDER
        ? [{ id: 'task-sibling', status: 'BACKLOG', reopenCount: 0, epicId: 'epic-1', order: Number(process.env.FAKE_SIBLING_ORDER) }]
        : [])
    ];
    // An epic-scoped query asks about one epic's siblings, so it is bounded by
    // construction and always answers in full.
    if (args.epicId) { ok({ tasks: epicTasks.filter((t) => t.epicId === args.epicId) }); break; }
    // FAKE_LIST_TASKS_TRUNCATED models the real daemon behaviour that made the
    // production auto-commit path inert: an UNSCOPED list_tasks is capped at
    // DEFAULT_TASK_LIST_LIMIT and, once the project outgrows one page, the
    // just-completed task is simply not in the rows that come back.
    if (process.env.FAKE_LIST_TASKS_TRUNCATED === '1') {
      ok({
        tasks: [{ id: 'task-other', status: 'BACKLOG', reopenCount: 0, epicId: 'epic-other', order: 1 }],
        pagination: { limit: 1, offset: 0, returned: 1, total: 2, hasMore: true }
      });
      break;
    }
    ok({ tasks: epicTasks });
    break;
  }
  case 'chat_send': {
    const dir = path.join(moe, 'messages');
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, `${args.channel}.jsonl`), JSON.stringify({ sender: args.workerId, content: args.content }) + '\n');
    ok({ success: true });
    break;
  }
  case 'heartbeat': {
    fs.appendFileSync(path.join(moe, 'heartbeat.log'), `${new Date().toISOString()} ${args.workerId}\n`);
    ok({ ok: true });
    break;
  }
  default: ok({ success: true });
}
'@

    $trueCmd = Join-Path $tempRoot 'true.cmd'
    Set-Content -Path $trueCmd -Encoding ASCII -Value "@echo off`r`nexit /b 0`r`n"

    # A "slow" fake CLI that sleeps a few seconds before exiting, standing in
    # for a long silent verification step with no moe.* calls of its own —
    # exactly the scenario the heartbeat sidecar exists to cover.
    $slowCmd = Join-Path $tempRoot 'slow.cmd'
    Set-Content -Path $slowCmd -Encoding ASCII -Value "@echo off`r`nping -n 6 127.0.0.1 >nul`r`nexit /b 0`r`n"

    $oldProxy = $env:MOE_PROXY_PATH
    $oldUserProfile = $env:USERPROFILE
    $oldTemp = $env:TEMP
    $env:MOE_PROXY_PATH = $fakeProxy
    $env:USERPROFILE = $homeDir
    $env:TEMP = $tempRoot
    $wrapperOut = Join-Path $tempRoot 'wrapper.out'
    $wrapperResumeOut = Join-Path $tempRoot 'wrapper-resume.out'
    try {
        $ErrorActionPreference = 'Continue'
        & $psExe -NoProfile -File $wrapper `
            -Project $projectDir `
            -WorkerId worker-postflight `
            -Role worker `
            -Team Smoke `
            -NoStartDaemon `
            -Command $trueCmd `
            -Loop `
            -PollInterval 0 `
            *> $wrapperOut
        $wrapperCode = $LASTEXITCODE

        # --- Resume path: a worker that already holds an active task (its
        # previous CLI died mid-task) gets hasNext:false + alreadyAssigned from
        # claim_next_task. The wrapper must treat that as a claim and relaunch
        # the CLI instead of idle-looping on "No claimable task". ---
        $env:FAKE_CLAIM_MODE = 'resume'
        try {
            & $psExe -NoProfile -File $wrapper `
                -Project $projectDir `
                -WorkerId qa-postflight `
                -Role qa `
                -Team Smoke `
                -NoStartDaemon `
                -Command $trueCmd `
                -Loop `
                -PollInterval 0 `
                *> $wrapperResumeOut
            $resumeCode = $LASTEXITCODE
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
        }

        # --- Heartbeat sidecar: the CLI invocation blocks the wrapper with no
        # moe.* calls of its own for the CLI's whole runtime, so a long silent
        # step (a build, a test run) risks the REVIEW self-heal sweep evicting
        # a still-alive session. $slowCmd stands in for that — it sleeps ~5s
        # making zero tool calls. With a 1s heartbeat interval the sidecar
        # should ping several times DURING that window, and stop promptly once
        # the CLI (and the wrapper) exits — not leak an orphaned process. ---
        $heartbeatLogFile = Join-Path $projectDir '.moe\heartbeat.log'
        $wrapperHeartbeatOut = Join-Path $tempRoot 'wrapper-heartbeat.out'
        $env:MOE_HEARTBEAT_INTERVAL_SEC = '1'
        $env:MOE_HEARTBEAT_MAX_DURATION_SEC = '30'
        try {
            & $psExe -NoProfile -File $wrapper `
                -Project $projectDir `
                -WorkerId qa-heartbeat `
                -Role qa `
                -Team Smoke `
                -NoStartDaemon `
                -Command $slowCmd `
                -NoLoop `
                *> $wrapperHeartbeatOut
            $heartbeatWrapperCode = $LASTEXITCODE
        } finally {
            Remove-Item Env:MOE_HEARTBEAT_INTERVAL_SEC -ErrorAction SilentlyContinue
            Remove-Item Env:MOE_HEARTBEAT_MAX_DURATION_SEC -ErrorAction SilentlyContinue
        }
        $countAtExit = if (Test-Path $heartbeatLogFile) { (Get-Content $heartbeatLogFile | Measure-Object -Line).Lines } else { 0 }
        # The wrapper process (and any Start-Job it spawned) has already
        # exited by the time the call above returns. If Stop-HeartbeatSidecar
        # didn't run, the job would keep pinging past that point — confirm it
        # didn't by checking the count is stable a few seconds later.
        Start-Sleep -Seconds 3
        $countAfterWait = if (Test-Path $heartbeatLogFile) { (Get-Content $heartbeatLogFile | Measure-Object -Line).Lines } else { 0 }

        # --- Quality gate (settings.qualityGate): the post-flight runs the
        # configured command before auto-commit. Failing gate => no commit,
        # PUSH-BLOCKED chat message; passing gate => commit lands;
        # MOE_DISABLE_QUALITY_GATE=1 => gate skipped even when the command
        # would fail. Requires git in PATH. ---
        $gateAvailable = [bool](Get-Command git -ErrorAction SilentlyContinue)
        if ($gateAvailable) {
            function New-GateProject([string]$dir, [string]$gateCmd) {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\messages') | Out-Null
                $cfg = @{ id = 'proj-gate'; name = 'postflight-gate'; settings = @{ qualityGate = $gateCmd } } | ConvertTo-Json -Depth 5
                Set-Content -Path (Join-Path $dir '.moe\project.json') -Value $cfg -Encoding UTF8
                Set-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
                & git -C $dir init -q 2>$null | Out-Null
                & git -C $dir config user.email 'moe@test.local' 2>$null | Out-Null
                & git -C $dir config user.name 'Moe Test' 2>$null | Out-Null
                Set-Content -Path (Join-Path $dir 'seed.txt') -Value 'seed'
                & git -C $dir add seed.txt 2>$null | Out-Null
                & git -C $dir commit -qm init 2>$null | Out-Null
                # Leave a dirty file for the post-flight `git add -A` to pick up.
                Set-Content -Path (Join-Path $dir 'work.txt') -Value 'dirty'
            }
            function Invoke-GateWrapper([string]$dir, [string]$outFile) {
                & $psExe -NoProfile -File $wrapper `
                    -Project $dir `
                    -WorkerId worker-gate `
                    -Role worker `
                    -Team Smoke `
                    -NoStartDaemon `
                    -Command $trueCmd `
                    -NoLoop `
                    -PollInterval 0 `
                    *> $outFile
                return $LASTEXITCODE
            }
            $env:FAKE_TASK_STATUS = 'REVIEW'
            try {
                $gateFailDir = Join-Path $tempRoot 'gate-fail'
                New-GateProject $gateFailDir 'exit 3'
                $wrapperGateFailOut = Join-Path $tempRoot 'wrapper-gate-fail.out'
                $gateFailCode = Invoke-GateWrapper $gateFailDir $wrapperGateFailOut

                $gatePassDir = Join-Path $tempRoot 'gate-pass'
                New-GateProject $gatePassDir 'exit 0'
                $wrapperGatePassOut = Join-Path $tempRoot 'wrapper-gate-pass.out'
                $gatePassCode = Invoke-GateWrapper $gatePassDir $wrapperGatePassOut

                $gateSkipDir = Join-Path $tempRoot 'gate-skip'
                New-GateProject $gateSkipDir 'exit 7'
                $wrapperGateSkipOut = Join-Path $tempRoot 'wrapper-gate-skip.out'
                $env:MOE_DISABLE_QUALITY_GATE = '1'
                try {
                    $gateSkipCode = Invoke-GateWrapper $gateSkipDir $wrapperGateSkipOut
                } finally {
                    Remove-Item Env:MOE_DISABLE_QUALITY_GATE -ErrorAction SilentlyContinue
                }

                # Mid-epic task (sibling with higher order) defers the gate under
                # the default scope=epicFinal — a failing gate must not block.
                $gateMidDir = Join-Path $tempRoot 'gate-midepic'
                New-GateProject $gateMidDir 'exit 9'
                $wrapperGateMidOut = Join-Path $tempRoot 'wrapper-gate-midepic.out'
                $env:FAKE_SIBLING_ORDER = '99'
                try {
                    $gateMidCode = Invoke-GateWrapper $gateMidDir $wrapperGateMidOut
                } finally {
                    Remove-Item Env:FAKE_SIBLING_ORDER -ErrorAction SilentlyContinue
                }

                # REGRESSION: the post-flight must not resolve the task's final
                # status through an UNSCOPED list_tasks. The daemon caps that
                # call at DEFAULT_TASK_LIST_LIMIT, so past one page of tasks the
                # just-completed task is absent from the rows, the status comes
                # back empty, and the whole auto-commit block is skipped in total
                # silence. The lookup must key on the task id instead, which
                # cannot be paginated away.
                $gateTruncDir = Join-Path $tempRoot 'gate-truncated'
                New-GateProject $gateTruncDir ''
                $wrapperGateTruncOut = Join-Path $tempRoot 'wrapper-gate-truncated.out'
                $env:FAKE_LIST_TASKS_TRUNCATED = '1'
                try {
                    $gateTruncCode = Invoke-GateWrapper $gateTruncDir $wrapperGateTruncOut
                } finally {
                    Remove-Item Env:FAKE_LIST_TASKS_TRUNCATED -ErrorAction SilentlyContinue
                }

                # A status lookup that fails outright is an ERROR, not a quiet
                # "the task isn't in REVIEW". It must warn on stdout AND escalate
                # to chat — that distinction is the whole reason this failure
                # went unnoticed for a day.
                $gateLookupDir = Join-Path $tempRoot 'gate-lookupfail'
                New-GateProject $gateLookupDir ''
                $wrapperGateLookupOut = Join-Path $tempRoot 'wrapper-gate-lookupfail.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'empty'
                try {
                    $gateLookupCode = Invoke-GateWrapper $gateLookupDir $wrapperGateLookupOut
                } finally {
                    Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue
                }

                # get_context's real miss behaviour: getContext.ts falls back to
                # the caller's currentTaskId, so a stale/deleted id answers with
                # a DIFFERENT task. Auto-committing on another task's REVIEW
                # status would be worse than not committing at all.
                $gateMismatchDir = Join-Path $tempRoot 'gate-mismatch'
                New-GateProject $gateMismatchDir ''
                $wrapperGateMismatchOut = Join-Path $tempRoot 'wrapper-gate-mismatch.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'mismatch'
                try {
                    $gateMismatchCode = Invoke-GateWrapper $gateMismatchDir $wrapperGateMismatchOut
                } finally {
                    Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue
                }

                $gateFailCommits = [int](& git -C $gateFailDir rev-list --count HEAD 2>$null)
                $gateTruncCommits = [int](& git -C $gateTruncDir rev-list --count HEAD 2>$null)
                $gateLookupCommits = [int](& git -C $gateLookupDir rev-list --count HEAD 2>$null)
                $gateMismatchCommits = [int](& git -C $gateMismatchDir rev-list --count HEAD 2>$null)
                $gateLookupMessages = Get-Content -Raw -Path (Join-Path $gateLookupDir '.moe\messages\chan-general.jsonl')
                $gatePassCommits = [int](& git -C $gatePassDir rev-list --count HEAD 2>$null)
                $gateSkipCommits = [int](& git -C $gateSkipDir rev-list --count HEAD 2>$null)
                $gateMidCommits = [int](& git -C $gateMidDir rev-list --count HEAD 2>$null)
                $gateFailMessages = Get-Content -Raw -Path (Join-Path $gateFailDir '.moe\messages\chan-general.jsonl')
            } finally {
                Remove-Item Env:FAKE_TASK_STATUS -ErrorAction SilentlyContinue
            }
        }
    } finally {
        $ErrorActionPreference = $prevEap
        $env:MOE_PROXY_PATH = $oldProxy
        $env:USERPROFILE = $oldUserProfile
        $env:TEMP = $oldTemp
    }
    if ($wrapperCode -ne 0) {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Wrapper exited with $wrapperCode"
    }
    if ($resumeCode -ne 0) {
        Get-Content $wrapperResumeOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Resume wrapper exited with $resumeCode"
    }
    if ($heartbeatWrapperCode -ne 0) {
        Get-Content $wrapperHeartbeatOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Heartbeat wrapper exited with $heartbeatWrapperCode"
    }
    if ($countAtExit -lt 2) {
        Get-Content $wrapperHeartbeatOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Expected the heartbeat sidecar to ping at least twice during a ~5s silent CLI step; got $countAtExit"
    }
    if ($countAfterWait -ne $countAtExit) {
        throw "Heartbeat sidecar kept pinging ($countAfterWait calls) after the wrapper exited ($countAtExit at exit) - Stop-HeartbeatSidecar cleanup failed"
    }

    # Post-flight no longer writes a session-summary file (cross-session memory
    # moved to Serena). The post-flight chat message remains the session signal.
    $messagesFile = Join-Path $projectDir '.moe\messages\chan-general.jsonl'
    $messages = Get-Content -Raw -Path $messagesFile
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0)*') {
        throw 'Expected post-flight chat message not found'
    }
    # The quiet half of the same decision: this run's task resolves cleanly to a
    # non-REVIEW status, which is a legitimate no-op. It must NOT be reported as
    # a failed lookup — collapsing those two back together is what hid the defect.
    if ((Get-Content -Raw -Path $wrapperOut) -like '*post-flight status lookup failed*') {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw 'A resolved non-REVIEW status must stay a quiet no-op, not warn as a lookup failure'
    }

    $resumeOutText = Get-Content -Raw -Path $wrapperResumeOut
    if ($resumeOutText -notlike '*Pre-flight complete. Resuming: task-resume*') {
        Write-Host $resumeOutText
        throw 'Expected resume pre-flight banner not found'
    }
    if ($messages -notlike '*qa session ended: task=task-resume (CLI exit=0)*') {
        throw 'Expected resume post-flight chat message not found'
    }

    if ($gateAvailable) {
        if ($gateFailCode -ne 0) {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-fail wrapper exited with $gateFailCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateFailOut) -notlike '*qualityGate failed (exit 3)*') {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected qualityGate failure log not found'
        }
        if ($gateFailCommits -ne 1) {
            throw "Failing qualityGate must block the auto-commit (found $gateFailCommits commits)"
        }
        if ($gateFailMessages -notlike '*PUSH-BLOCKED: qualityGate failed for task task-postflight*') {
            Write-Host $gateFailMessages
            throw 'Expected PUSH-BLOCKED chat message not found'
        }
        if ($gatePassCode -ne 0) {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-pass wrapper exited with $gatePassCode"
        }
        if ((Get-Content -Raw -Path $wrapperGatePassOut) -notlike '*qualityGate passed*') {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected qualityGate pass log not found'
        }
        if ($gatePassCommits -ne 2) {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Passing qualityGate should allow the auto-commit (found $gatePassCommits commits)"
        }
        if ($gateSkipCode -ne 0) {
            Get-Content $wrapperGateSkipOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-skip wrapper exited with $gateSkipCode"
        }
        if ($gateSkipCommits -ne 2) {
            Get-Content $wrapperGateSkipOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "MOE_DISABLE_QUALITY_GATE=1 should skip the gate and allow the commit (found $gateSkipCommits commits)"
        }
        if ($gateMidCode -ne 0) {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-midepic wrapper exited with $gateMidCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateMidOut) -notlike '*qualityGate deferred*') {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected mid-epic qualityGate deferral log not found'
        }
        if ($gateMidCommits -ne 2) {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Mid-epic task should commit without running the gate (found $gateMidCommits commits)"
        }
        if ($gateTruncCode -ne 0) {
            Get-Content $wrapperGateTruncOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-truncated wrapper exited with $gateTruncCode"
        }
        if ($gateTruncCommits -ne 2) {
            Get-Content $wrapperGateTruncOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "A truncated list_tasks page must NOT stop the auto-commit: the REVIEW status has to be resolved by exact task-id lookup (found $gateTruncCommits commits)"
        }
        if ($gateLookupCode -ne 0) {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-lookupfail wrapper exited with $gateLookupCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateLookupOut) -notlike '*post-flight status lookup failed for task task-postflight*') {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected a [WARN] naming the task when the post-flight status lookup fails'
        }
        if ($gateLookupMessages -notlike '*PUSH-BLOCKED: post-flight status lookup failed for task task-postflight*') {
            Write-Host $gateLookupMessages
            throw 'Expected a chat escalation when the post-flight status lookup fails'
        }
        if ($gateLookupCommits -ne 1) {
            throw "An unresolved status must NOT commit (found $gateLookupCommits commits)"
        }
        if ($gateMismatchCode -ne 0) {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-mismatch wrapper exited with $gateMismatchCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateMismatchOut) -notlike '*get_context resolved a different task (task-someone-elses)*') {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected the wrapper to reject a get_context fallback onto a different task'
        }
        if ($gateMismatchCommits -ne 1) {
            throw "A get_context fallback onto a different task must NOT auto-commit (found $gateMismatchCommits commits)"
        }
    } else {
        Write-Host 'SKIP qualityGate cases: git not available'
    }

    Write-Host 'PASS postflight.ps1'
} catch {
    Write-Error $_
    exit 1
} finally {
    Remove-Item -Recurse -Force -LiteralPath $tempRoot -ErrorAction SilentlyContinue
}

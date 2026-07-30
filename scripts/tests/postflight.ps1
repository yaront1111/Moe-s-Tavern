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
  case 'get_context': ok({ task: { id: args.taskId || 'task-postflight', implementationPlan: [], definitionOfDone: [] }, project: {}, epic: {}, nextAction: { tool: 'moe.start_step' } }); break;
  case 'list_tasks': ok({ tasks: [
    { id: 'task-postflight', status: process.env.FAKE_TASK_STATUS || 'WORKING', reopenCount: 0, epicId: 'epic-1', order: 1 },
    ...(process.env.FAKE_SIBLING_ORDER
      ? [{ id: 'task-sibling', status: 'BACKLOG', reopenCount: 0, epicId: 'epic-1', order: Number(process.env.FAKE_SIBLING_ORDER) }]
      : [])
  ] }); break;
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

                $gateFailCommits = [int](& git -C $gateFailDir rev-list --count HEAD 2>$null)
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

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

    # The child wrapper runs on the SAME engine as this harness: run the
    # harness under `powershell` to test the wrapper on Windows PowerShell 5.1
    # (the fleet host) and under `pwsh` to test it on 7.x. Both must pass.
    $psExe = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
    Write-Host "postflight.ps1 host=$($PSVersionTable.PSVersion) child=$psExe"

    # Every wrapper invocation runs under a per-invocation timeout: a wrapper
    # that fails to `break` out of its loop, or hangs in a git prompt, must
    # fail the scenario (exit 124) instead of hanging the harness. The default
    # is 60 s — one invocation spawns ~10 node RPC round-trips plus git plus a
    # child PowerShell, and on a loaded box the nominal ~5 s stretches past 30
    # (same slow-spawn pattern as the claudeHook tests). Override with
    # MOE_POSTFLIGHT_TIMEOUT_SEC. stdout and stderr are captured to $OutFile
    # (stderr appended after exit) so string assertions see both streams, as
    # `*>` used to.
    $wrapperTimeoutSec = 60
    if ($env:MOE_POSTFLIGHT_TIMEOUT_SEC -match '^\d+$') { $wrapperTimeoutSec = [int]$env:MOE_POSTFLIGHT_TIMEOUT_SEC }
    function Invoke-WrapperProcess([string[]]$WrapperArgs, [string]$OutFile, [int]$TimeoutSec = 0) {
        if ($TimeoutSec -le 0) { $TimeoutSec = $wrapperTimeoutSec }
        $quoted = @('-NoProfile', '-File', ('"' + $wrapper + '"'))
        foreach ($a in $WrapperArgs) {
            if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') } else { $quoted += $a }
        }
        $errFile = "$OutFile.err"
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        $p = Start-Process -FilePath $psExe -ArgumentList $quoted -RedirectStandardOutput $OutFile -RedirectStandardError $errFile -PassThru -NoNewWindow
        # 5.1 only caches the exit code when the handle was touched before exit.
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null } catch {}
            $p.WaitForExit(5000) | Out-Null
            Add-Content -Path $OutFile -Value "HARNESS: wrapper killed after ${TimeoutSec}s timeout"
            return 124
        }
        $code = $p.ExitCode
        if (Test-Path -LiteralPath $errFile) {
            Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue | Add-Content -Path $OutFile
            Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        }
        return $code
    }

    $conflictOut = Join-Path $tempRoot 'conflict.out'
    # Windows PowerShell 5.1 wraps a child's stderr lines into ErrorRecords
    # when redirected, which $ErrorActionPreference='Stop' escalates to a
    # throw even though the child exited as expected. Relax EAP around child
    # invocations; exit codes are checked explicitly.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $conflictCode = Invoke-WrapperProcess @('-Loop', '-NoLoop') $conflictOut
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

    # Fake daemon+proxy: one node process per RPC, steered only by FAKE_* env
    # vars. Twin of the script in postflight.sh — keep the two in step.
    #   FAKE_CLAIM_MODE=resume|blocked   claim_next_task returns alreadyAssigned
    #   FAKE_TASK_STATUS                 status get_context/list_tasks report
    #   FAKE_GET_CONTEXT_FAIL=empty|mismatch
    #   FAKE_SIBLING_ORDER, FAKE_LIST_TASKS_TRUNCATED   (epic-final / pagination)
    #   FAKE_CTX_IS_EPIC_FINAL=true|false                daemon-computed
    #                                    isEpicFinal in get_context (unset =
    #                                    old daemon); FAKE_CTX_IS_EPIC_FINAL_AT=top
    #                                    serves it top-level instead of task-level
    #   FAKE_SCOPE_ASSERTED / FAKE_SCOPE_PLANNED         comma lists overriding
    #                                    the on-disk record's declared sets
    #   FAKE_SCOPE_PEER_DECLARED         "path:taskId,..." overriding the peer
    #                                    union read from the other records
    #   FAKE_SCOPE_PEERS_ACTIVE=1        another worker is live (livePeerIds)
    #   FAKE_SCOPE_ASSIGNED              assignedWorkerId reported by the scope
    # Side effects: chat_send -> .moe/messages/<channel>.jsonl, heartbeat ->
    # .moe/heartbeat.log, record_commit -> .moe/record_commit.jsonl.
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
function readTask(id) {
  // Set-Content -Encoding UTF8 on Windows PowerShell 5.1 writes a BOM, which
  // JSON.parse rejects — strip it.
  try { return JSON.parse(fs.readFileSync(path.join(moe, 'tasks', `${id}.json`), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function strList(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []; }
function declaredSets(task) {
  const asserted = new Set();
  const planned = new Set();
  for (const s of (task.implementationPlan || [])) {
    if (!s) continue;
    if (s.status === 'COMPLETED') for (const p of (s.modifiedFiles || s.affectedFiles || [])) asserted.add(p);
    for (const p of [...strList(s.affectedFiles), ...strList(s.newFiles), ...strList(s.modifiedFiles)]) planned.add(p);
  }
  for (const p of [...strList(task.filesModified), ...strList(task.declaredFiles), ...strList(task.touchedFiles)]) asserted.add(p);
  for (const p of strList(task.inferredPaths)) planned.add(p);
  for (const p of asserted) planned.delete(p);
  return { asserted: [...asserted], planned: [...planned] };
}
function csv(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }
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
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: process.env.FAKE_TASK_STATUS || 'REVIEW' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume.' }
      });
    } else if (process.env.FAKE_CLAIM_MODE === 'blocked') {
      // BLOCKED hold: the daemon parked the held task via report_blocked; the
      // wrapper must suppress the relaunch (and land any lingering baseline).
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: 'BLOCKED', blockedReason: 'waiting on a peer' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume (BLOCKED).' }
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
    const ctxPayload = {
      task: {
        id: ctxTaskId,
        status: process.env.FAKE_TASK_STATUS || 'WORKING',
        reopenCount: 0,
        implementationPlan: [],
        definitionOfDone: []
      },
      project: {}, epic: { id: 'epic-1', title: 'Smoke epic' }, nextAction: { tool: 'moe.start_step' }
    };
    // FAKE_CTX_IS_EPIC_FINAL=true|false models the newer daemon that computes
    // epic-final board-side; unset = an old daemon that doesn't serve the
    // field. FAKE_CTX_IS_EPIC_FINAL_AT=top places it top-level (beside the
    // epic) instead of on the task projection -- the wrapper accepts both.
    const fakeIef = process.env.FAKE_CTX_IS_EPIC_FINAL;
    if (fakeIef === 'true' || fakeIef === 'false') {
      const iefVal = fakeIef === 'true';
      if (process.env.FAKE_CTX_IS_EPIC_FINAL_AT === 'top') ctxPayload.isEpicFinal = iefVal;
      else ctxPayload.task.isEpicFinal = iefVal;
    }
    ok(ctxPayload);
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
  case 'get_commit_scope': {
    // Mirrors tools/getCommitScope.ts: ASSERTED = completed steps' modifiedFiles
    // ?? affectedFiles + filesModified + declaredFiles + touchedFiles; PLANNED =
    // every step's affected/new/modified + inferredPaths minus ASSERTED; PEER =
    // the same union over every other non-DONE/ARCHIVED record on disk.
    const taskId = args.taskId || 'task-postflight';
    const rec = readTask(taskId);
    const sets = rec ? declaredSets(rec) : { asserted: [], planned: [] };
    const asserted = process.env.FAKE_SCOPE_ASSERTED !== undefined ? csv(process.env.FAKE_SCOPE_ASSERTED) : sets.asserted;
    const planned = process.env.FAKE_SCOPE_PLANNED !== undefined ? csv(process.env.FAKE_SCOPE_PLANNED) : sets.planned;
    let peerDeclared = [];
    if (process.env.FAKE_SCOPE_PEER_DECLARED !== undefined) {
      peerDeclared = csv(process.env.FAKE_SCOPE_PEER_DECLARED).map((e) => { const i = e.lastIndexOf(':'); return { path: e.slice(0, i), taskId: e.slice(i + 1) }; });
    } else {
      let files = [];
      try { files = fs.readdirSync(path.join(moe, 'tasks')).filter((f) => f.endsWith('.json')); } catch {}
      for (const f of files) {
        const other = readTask(f.replace(/\.json$/, ''));
        if (!other || other.id === taskId || other.status === 'DONE' || other.status === 'ARCHIVED') continue;
        const os = declaredSets(other);
        for (const p of [...os.asserted, ...os.planned, ...strList(other.touchedFiles)]) peerDeclared.push({ path: p, taskId: other.id });
      }
    }
    const peersActive = process.env.FAKE_SCOPE_PEERS_ACTIVE === '1';
    ok({
      taskId,
      title: rec ? rec.title : 'Postflight smoke',
      status: process.env.FAKE_TASK_STATUS || (rec ? rec.status : 'WORKING'),
      epicId: 'epic-1',
      reopenCount: rec && rec.reopenCount ? rec.reopenCount : 0,
      assignedWorkerId: process.env.FAKE_SCOPE_ASSIGNED !== undefined ? process.env.FAKE_SCOPE_ASSIGNED : (args.workerId || ''),
      assigneeAlive: true,
      asserted, planned,
      touchedFiles: rec ? strList(rec.touchedFiles) : [],
      inferredPaths: rec ? strList(rec.inferredPaths) : [],
      unattributedPaths: rec ? strList(rec.unattributedPaths) : [],
      peerDeclared,
      livePeerIds: peersActive ? ['worker-peer'] : [],
      activePeerIds: peersActive ? ['worker-peer'] : [],
      peersActive,
      alwaysInclude: [],
      excludePrefixes: [],
      policy: { autoCommit: true, checkpointCommits: true, checkpointPush: true, commitBoardState: true, commitHooks: false, undeclared: 'solo', contested: 'commit' }
    });
    break;
  }
  case 'record_commit': {
    ensureDir(moe);
    fs.appendFileSync(path.join(moe, 'record_commit.jsonl'), JSON.stringify(args) + '\n');
    ok({ success: true, taskId: args.taskId, sha: args.sha, kind: args.kind, outcome: args.outcome, commitCount: 1, filesModified: strList(args.paths), addedPaths: strList(args.paths) });
    break;
  }
  case 'declare_files': ok({ success: true, taskId: args.taskId, declaredFiles: strList(args.paths) }); break;
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

    # Fake Grok Build CLI, literally named grok.cmd: the wrapper strips the
    # extension before matching the basename, so this shim takes the grok
    # launch branch. It records its argv to FAKE_GROK_ARGV_FILE (and its cwd
    # to <that>.cwd), copies the --prompt-file (argv 2 in headless mode) to
    # FAKE_GROK_PROMPT_COPY when set, dirties .grok/config.toml mid-session
    # when FAKE_GROK_TOUCH_CONFIG=1 (the DENY-tier discriminator: a config
    # changed since the baseline would otherwise be MEASURED-committed), and
    # exits with FAKE_GROK_EXIT (0 by default).
    $grokCmd = Join-Path $tempRoot 'grok.cmd'
    Set-Content -Path $grokCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo %* > `"%FAKE_GROK_ARGV_FILE%`"`r`n" +
        "echo %CD%> `"%FAKE_GROK_ARGV_FILE%.cwd`"`r`n" +
        "if defined FAKE_GROK_PROMPT_COPY copy /y `"%~2`" `"%FAKE_GROK_PROMPT_COPY%`" >nul`r`n" +
        "if defined FAKE_GROK_TOUCH_CONFIG echo # touched by the session>> `"%MOE_PROJECT_PATH%\.grok\config.toml`"`r`n" +
        "if defined FAKE_GROK_EXIT exit /b %FAKE_GROK_EXIT%`r`n" +
        "exit /b 0`r`n")

    # File-creating fake CLIs. The ps1 claude launch does NOT cd into the
    # project (it binds via MOE_PROJECT_PATH), so every path is written via
    # %MOE_PROJECT_PATH% — a relative path would land in the harness cwd.
    $createFileCmd = Join-Path $tempRoot 'create-file.cmd'
    Set-Content -Path $createFileCmd -Encoding ASCII -Value "@echo off`r`necho new> `"%MOE_PROJECT_PATH%\session-new.txt`"`r`nexit /b 0`r`n"
    $createPeerCmd = Join-Path $tempRoot 'create-peer.cmd'
    Set-Content -Path $createPeerCmd -Encoding ASCII -Value "@echo off`r`necho new> `"%MOE_PROJECT_PATH%\session-new.txt`"`r`necho peer> `"%MOE_PROJECT_PATH%\peer-plan.txt`"`r`nexit /b 0`r`n"
    # Rewrites the task's OWN board record and a peer's record mid-session
    # (what the daemon does on every tool call).
    $touchBoardCmd = Join-Path $tempRoot 'touch-board.cmd'
    Set-Content -Path $touchBoardCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo {`"id`":`"task-postflight`",`"title`":`"Postflight smoke`",`"status`":`"WORKING`",`"filesModified`":[`"owned-a.txt`"],`"touchedBySession`":1}> `"%MOE_PROJECT_PATH%\.moe\tasks\task-postflight.json`"`r`n" +
        "echo {`"id`":`"task-peer`",`"title`":`"Peer task`",`"status`":`"WORKING`",`"assignedWorkerId`":`"worker-peer`",`"filesModified`":[`"peer-plan.txt`"],`"touchedBySession`":1}> `"%MOE_PROJECT_PATH%\.moe\tasks\task-peer.json`"`r`n" +
        "exit /b 0`r`n")
    # Stream-json emitter: a synthetic content_block_start/delta/stop sequence
    # for a Write tool_use on tool-written.txt (absolute path, as Claude Code
    # emits it) plus a non-streamed `assistant` message carrying a full Edit
    # tool_use.input on tool-edited.txt — and it writes both files.
    $streamJsonCmd = Join-Path $tempRoot 'stream-json.cmd'
    Set-Content -Path $streamJsonCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo tool> `"%MOE_PROJECT_PATH%\tool-written.txt`"`r`n" +
        "echo tool> `"%MOE_PROJECT_PATH%\tool-edited.txt`"`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_start`",`"content_block`":{`"type`":`"tool_use`",`"id`":`"t1`",`"name`":`"Write`"}}}`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_delta`",`"delta`":{`"type`":`"input_json_delta`",`"partial_json`":`"{\`"file_path\`":\`"%MOE_PROJECT_PATH:\=/%/tool-written.txt\`",\`"content\`":\`"tool\`"}`"}}}`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_stop`"}}`r`n" +
        "echo {`"type`":`"assistant`",`"message`":{`"content`":[{`"type`":`"tool_use`",`"id`":`"t2`",`"name`":`"Edit`",`"input`":{`"file_path`":`"%MOE_PROJECT_PATH:\=/%/tool-edited.txt`",`"old_string`":`"a`",`"new_string`":`"b`"}}]}}`r`n" +
        "exit /b 0`r`n")
    # CAS-contention hook (MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF): moves the
    # branch tip between commit-tree and update-ref by committing a peer file.
    $hookPeerCmd = Join-Path $tempRoot 'hook-peer.cmd'
    Set-Content -Path $hookPeerCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo peer-hook> `"%MOE_PROJECT_PATH%\peer-hook.txt`"`r`n" +
        "git -C `"%MOE_PROJECT_PATH%`" add peer-hook.txt`r`n" +
        "git -C `"%MOE_PROJECT_PATH%`" commit -qm peer-hook`r`n" +
        "exit /b 0`r`n")

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
        $wrapperCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'worker-postflight', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '0') $wrapperOut

        # --- Resume path: a worker that already holds an active task (its
        # previous CLI died mid-task) gets hasNext:false + alreadyAssigned from
        # claim_next_task. The wrapper must treat that as a claim and relaunch
        # the CLI instead of idle-looping on "No claimable task". ---
        $env:FAKE_CLAIM_MODE = 'resume'
        try {
            $resumeCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'qa-postflight', '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '0') $wrapperResumeOut
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
            $heartbeatWrapperCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'qa-heartbeat', '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $slowCmd, '-NoLoop') $wrapperHeartbeatOut
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
        # configured command before a COMPLETION commit. Failing gate => no
        # branch commit (the edits go to a rescue ref), PUSH-BLOCKED chat
        # message, wrapper stops; passing gate => commit lands;
        # MOE_DISABLE_QUALITY_GATE=1 => gate skipped even when the command
        # would fail. Requires git in PATH. ---
        $gateAvailable = [bool](Get-Command git -ErrorAction SilentlyContinue)
        if ($gateAvailable) {
            # Writes the durable task record the post-flight (and the fake
            # get_commit_scope) reads to derive its commit pathspec. The fake
            # proxy claims `task-postflight`, and the daemon stores a task at
            # `.moe/tasks/<taskId>.json` — the id ALREADY carries the `task-`
            # prefix, so the on-disk name is `task-postflight.json` and never
            # `task-task-postflight.json`. Getting that resolution wrong is
            # silent: the record simply never loads.
            function Write-TaskRecord([string]$dir, [string[]]$filesModified, [string]$status = 'REVIEW', $implementationPlan = $null, [string]$id = 'task-postflight', [string]$title = 'Postflight smoke') {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\tasks') | Out-Null
                $rec = [ordered]@{
                    id = $id
                    title = $title
                    status = $status
                    filesModified = @($filesModified)
                }
                if ($null -ne $implementationPlan) { $rec.implementationPlan = @($implementationPlan) }
                $json = $rec | ConvertTo-Json -Depth 8
                # PS 5.1 unwraps a one-element array; keep filesModified an array.
                if ($filesModified.Count -eq 1) { $json = $json -replace '"filesModified":\s*"([^"]*)"', '"filesModified": ["$1"]' }
                Set-Content -Path (Join-Path $dir ".moe\tasks\$id.json") -Value $json -Encoding UTF8
            }
            # A LIVE peer's record: another WORKING task (assigned to
            # worker-peer) whose plan names peer-plan.txt.
            function Write-PeerTaskRecord([string]$dir) {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\tasks') | Out-Null
                $json = '{"id":"task-peer","title":"Peer task","status":"WORKING","assignedWorkerId":"worker-peer","implementationPlan":[{"stepId":"s1","title":"peer step","status":"PENDING","affectedFiles":["peer-plan.txt"]}],"filesModified":["peer-plan.txt"]}'
                Set-Content -Path (Join-Path $dir '.moe\tasks\task-peer.json') -Value $json -Encoding UTF8
            }
            function New-GateProject([string]$dir, [string]$gateCmd) {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\messages') | Out-Null
                $cfg = @{ id = 'proj-gate'; name = 'postflight-gate'; settings = @{ qualityGate = $gateCmd } } | ConvertTo-Json -Depth 5
                Set-Content -Path (Join-Path $dir '.moe\project.json') -Value $cfg -Encoding UTF8
                Write-TaskRecord $dir @('work.txt')
                Set-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
                & git -C $dir init -q 2>$null | Out-Null
                & git -C $dir config user.email 'moe@test.local' 2>$null | Out-Null
                & git -C $dir config user.name 'Moe Test' 2>$null | Out-Null
                Set-Content -Path (Join-Path $dir 'seed.txt') -Value 'seed'
                & git -C $dir add seed.txt 2>$null | Out-Null
                & git -C $dir commit -qm init 2>$null | Out-Null
                # Leave the task's own owned path dirty for the post-flight to commit.
                Set-Content -Path (Join-Path $dir 'work.txt') -Value 'dirty'
            }
            # Used by gate AND scope cases. STATUS is what the fake daemon reports
            # for the task after the CLI exits; COMMAND is the fake CLI.
            function Invoke-GateWrapper([string]$dir, [string]$outFile, [string]$Status = 'REVIEW', [string]$Command = '', [string]$Role = 'worker', [string]$WorkerId = 'worker-gate', [switch]$LoopOneSecond) {
                if (-not $Command) { $Command = $trueCmd }
                $prevStatus = $env:FAKE_TASK_STATUS
                $env:FAKE_TASK_STATUS = $Status
                try {
                    $loopArgs = @('-NoLoop', '-PollInterval', '0')
                    if ($LoopOneSecond) { $loopArgs = @('-Loop', '-PollInterval', '1') }
                    return (Invoke-WrapperProcess (@('-Project', $dir, '-WorkerId', $WorkerId, '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $Command) + $loopArgs) $outFile)
                } finally {
                    if ($null -ne $prevStatus) { $env:FAKE_TASK_STATUS = $prevStatus } else { Remove-Item Env:FAKE_TASK_STATUS -ErrorAction SilentlyContinue }
                }
            }
            function Get-RescueRefs([string]$dir, [string]$taskId = 'task-postflight') {
                return @(& git -C $dir for-each-ref --format='%(refname)' "refs/moe/rescue/$taskId/" 2>$null | Where-Object { $_ })
            }
            function Get-HeadSubject([string]$dir, [string]$rev = 'HEAD') {
                return ((& git -C $dir log -1 --format=%s $rev 2>$null) -join '')
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

                # Daemon-provided isEpicFinal: newer daemons compute epic-final
                # board-side and serve it in get_context; when present the
                # wrapper must PREFER it over the list_tasks fallback (the
                # mid-epic case above, which runs with the field absent, keeps
                # pinning the fallback for old daemons). Two directions, each a
                # discriminator against silently using the fallback.
                # b1: daemon says false (task-level) with NO sibling knob — the
                # fallback would compute final=true and run the failing gate;
                # the daemon value must defer it, so the commit lands.
                $gateDaemonMidDir = Join-Path $tempRoot 'gate-daemonmid'
                New-GateProject $gateDaemonMidDir 'exit 9'
                $wrapperGateDaemonMidOut = Join-Path $tempRoot 'wrapper-gate-daemonmid.out'
                $env:FAKE_CTX_IS_EPIC_FINAL = 'false'
                try {
                    $gateDaemonMidCode = Invoke-GateWrapper $gateDaemonMidDir $wrapperGateDaemonMidOut
                } finally {
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL -ErrorAction SilentlyContinue
                }
                # b2: daemon says true (top-level placement) while the sibling
                # page says mid-epic — the fallback would defer; the daemon
                # value must run the failing gate, which blocks the commit.
                $gateDaemonFinalDir = Join-Path $tempRoot 'gate-daemonfinal'
                New-GateProject $gateDaemonFinalDir 'exit 3'
                $wrapperGateDaemonFinalOut = Join-Path $tempRoot 'wrapper-gate-daemonfinal.out'
                $env:FAKE_CTX_IS_EPIC_FINAL = 'true'
                $env:FAKE_CTX_IS_EPIC_FINAL_AT = 'top'
                $env:FAKE_SIBLING_ORDER = '99'
                try {
                    $gateDaemonFinalCode = Invoke-GateWrapper $gateDaemonFinalDir $wrapperGateDaemonFinalOut
                } finally {
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL_AT -ErrorAction SilentlyContinue
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
                # went unnoticed for a day. The task id itself is certain, so
                # the work still lands as a CHECKPOINT with status=UNKNOWN.
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
                # a DIFFERENT task. Treating another task's REVIEW as this one's
                # completion would be worse than not committing at all — it is
                # a status-UNKNOWN checkpoint, never a completion.
                $gateMismatchDir = Join-Path $tempRoot 'gate-mismatch'
                New-GateProject $gateMismatchDir ''
                $wrapperGateMismatchOut = Join-Path $tempRoot 'wrapper-gate-mismatch.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'mismatch'
                try {
                    $gateMismatchCode = Invoke-GateWrapper $gateMismatchDir $wrapperGateMismatchOut
                } finally {
                    Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue
                }

                # --- Completion-hook COMMIT SCOPE, scenarios A-E, then the
                # land-on-every-exit scenarios F-V and X, then the grok CLI
                # scenario Y ------------------------------------------------
                # Twin of the same scenarios in postflight.sh (W is bash-only:
                # kill -INT). The twins drift easily, so these are matched case
                # by case against that scenario list rather than by reading the
                # two files side by side. Two distinct leaks are covered by A-E
                # and they are NOT the same bug: staging scope (`git add -A`
                # when the task record did not load) and commit scope (a BARE
                # `git commit` commits the SHARED INDEX, so a peer's
                # already-staged file rides along). Scenario B is the only one
                # that discriminates the second. Every scenario runs against a
                # disposable repo under $tempRoot — a post-flight test that
                # commits into a live tree reproduces the defect it is meant
                # to test.
                $scopeScenariosRun = 0
                function New-ScopeProject([string]$dir, [string[]]$filesModified, [hashtable]$Settings = $null, [switch]$NoSeed, [string]$Status = 'REVIEW', $ImplementationPlan = $null) {
                    New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\messages') | Out-Null
                    $st = @{}
                    if ($Settings) { $st = $Settings }
                    $cfg = @{ id = 'proj-scope'; name = 'postflight-scope'; settings = $st } | ConvertTo-Json -Depth 5
                    Set-Content -Path (Join-Path $dir '.moe\project.json') -Value $cfg -Encoding UTF8
                    Write-TaskRecord $dir $filesModified $Status $ImplementationPlan
                    Set-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
                    & git -C $dir init -q 2>$null | Out-Null
                    & git -C $dir config user.email 'moe@test.local' 2>$null | Out-Null
                    & git -C $dir config user.name 'Moe Test' 2>$null | Out-Null
                    if (-not $NoSeed) {
                        Set-Content -Path (Join-Path $dir 'seed.txt') -Value 'seed'
                        # The task's own record is TRACKED and clean at the seed,
                        # as in a real project (.moe/tasks/ is committed; the
                        # daemon rewrites records during a session). A dirty own
                        # record is ALWAYS a board candidate, so only scenarios
                        # that dirty it on purpose (P) — or skip the seed (U) —
                        # expect it in the commit. Same fixture as postflight.sh.
                        & git -C $dir add seed.txt .moe/tasks/task-postflight.json 2>$null | Out-Null
                        & git -C $dir commit -qm init 2>$null | Out-Null
                    }
                }
                function Get-CommittedPaths([string]$dir, [string]$rev = 'HEAD') {
                    return (@(& git -C $dir show --pretty=format: --name-only $rev 2>$null |
                        Where-Object { $_ } | Sort-Object) -join ' ')
                }
                function Assert-ScopeRun([string]$name, [int]$code, [string]$outFile) {
                    if ($code -ne 0) {
                        Get-Content $outFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                        throw "SCENARIO ${name} FAILED: wrapper exited with $code"
                    }
                }
                function Get-RecordCommitLines([string]$dir) {
                    $f = Join-Path $dir '.moe\record_commit.jsonl'
                    if (-not (Test-Path $f)) { return @() }
                    return @(Get-Content $f | Where-Object { $_ })
                }

                # Scenario A — dirty peer. Owned X and Y commit; a peer's
                # MODIFIED tracked file and a peer's UNTRACKED file must both
                # survive the completion untouched.
                Write-Host '[scenario A] dirty peer files are never captured'
                $scopeADir = Join-Path $tempRoot 'scope-a'
                New-ScopeProject $scopeADir @('owned-a.txt', 'owned-b.txt')
                Set-Content -Path (Join-Path $scopeADir 'peer-mod.txt') -Value 'peer-base'
                & git -C $scopeADir add peer-mod.txt 2>$null | Out-Null
                & git -C $scopeADir commit -qm peer-base 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeADir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeADir 'owned-b.txt') -Value 'owned-b'
                Set-Content -Path (Join-Path $scopeADir 'peer-mod.txt') -Value 'peer-dirty'
                Set-Content -Path (Join-Path $scopeADir 'peer-untracked.txt') -Value 'peer-new'
                $scopeAOut = Join-Path $tempRoot 'scope-a.out'
                Assert-ScopeRun 'A' (Invoke-GateWrapper $scopeADir $scopeAOut) $scopeAOut
                $scopeAFiles = Get-CommittedPaths $scopeADir
                if ($scopeAFiles -ne 'owned-a.txt owned-b.txt') {
                    Get-Content $scopeAOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO A FAILED: commit must contain EXACTLY the owned paths; got [$scopeAFiles]"
                }
                $scopeAStatus = @(& git -C $scopeADir status --porcelain 2>$null)
                if ($scopeAStatus -notcontains ' M peer-mod.txt') {
                    throw "SCENARIO A FAILED: peer-mod.txt must still be modified-and-unstaged; status was [$($scopeAStatus -join '|')]"
                }
                if ($scopeAStatus -notcontains '?? peer-untracked.txt') {
                    throw "SCENARIO A FAILED: peer-untracked.txt must still be untracked; status was [$($scopeAStatus -join '|')]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario A] ok'

                # Scenario B — pre-staged foreign index. The discriminating case:
                # a peer stages Z into the SHARED INDEX before the hook runs.
                # Pathspec STAGING cannot help here; only a pathspec-scoped
                # COMMIT keeps Z out.
                Write-Host "[scenario B] a peer's pre-staged index entry never rides along"
                $scopeBDir = Join-Path $tempRoot 'scope-b'
                New-ScopeProject $scopeBDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeBDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeBDir 'peer-staged.txt') -Value 'peer-staged'
                & git -C $scopeBDir add peer-staged.txt 2>$null | Out-Null
                $scopeBOut = Join-Path $tempRoot 'scope-b.out'
                Assert-ScopeRun 'B' (Invoke-GateWrapper $scopeBDir $scopeBOut) $scopeBOut
                $scopeBFiles = Get-CommittedPaths $scopeBDir
                if ($scopeBFiles -ne 'owned-a.txt') {
                    Get-Content $scopeBOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO B FAILED: commit must contain ONLY owned-a.txt; got [$scopeBFiles]"
                }
                & git -C $scopeBDir cat-file -e HEAD:peer-staged.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Get-Content $scopeBOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO B FAILED: the peer's pre-staged file reached HEAD — the commit is still index-scoped"
                }
                if (@(& git -C $scopeBDir diff --cached --name-only 2>$null) -notcontains 'peer-staged.txt') {
                    throw "SCENARIO B FAILED: the peer's file must remain STAGED and uncommitted"
                }
                $scopeScenariosRun++
                Write-Host '[scenario B] ok'

                # Scenario C — empty filesModified. Fails CLOSED under its own
                # stable code and commits nothing. The dirty peer file is
                # load-bearing: without it a restored `git add -A` would have
                # nothing to sweep and this would pass while testing nothing.
                Write-Host '[scenario C] empty owned-path set refuses with MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                $scopeCDir = Join-Path $tempRoot 'scope-c'
                New-ScopeProject $scopeCDir @()
                Set-Content -Path (Join-Path $scopeCDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeCHead = (& git -C $scopeCDir rev-parse HEAD 2>$null)
                $scopeCOut = Join-Path $tempRoot 'scope-c.out'
                Assert-ScopeRun 'C' (Invoke-GateWrapper $scopeCDir $scopeCOut) $scopeCOut
                $scopeCText = Get-Content -Raw -Path $scopeCOut
                if ($scopeCText -notlike '*MOE_COMMIT_REFUSED_NO_OWNED_PATHS*') {
                    Write-Host $scopeCText
                    throw 'SCENARIO C FAILED: expected the literal reason code MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                }
                if ($scopeCText -like '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeCText
                    throw 'SCENARIO C FAILED: an empty owned-path set must NOT report the missing-path code — the two causes are distinct'
                }
                if ((& git -C $scopeCDir rev-parse HEAD 2>$null) -ne $scopeCHead) {
                    throw 'SCENARIO C FAILED: a refusal must commit NOTHING; HEAD moved'
                }
                $scopeScenariosRun++
                Write-Host '[scenario C] ok'

                # Scenario D — every declared owned path is absent from disk.
                # Distinct cause, distinct code: collapsing it into C would make
                # a later guard change invisible.
                Write-Host '[scenario D] all owned paths missing refuses with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                $scopeDDir = Join-Path $tempRoot 'scope-d'
                New-ScopeProject $scopeDDir @('ghost-owned.txt')
                Set-Content -Path (Join-Path $scopeDDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeDHead = (& git -C $scopeDDir rev-parse HEAD 2>$null)
                $scopeDOut = Join-Path $tempRoot 'scope-d.out'
                Assert-ScopeRun 'D' (Invoke-GateWrapper $scopeDDir $scopeDOut) $scopeDOut
                $scopeDText = Get-Content -Raw -Path $scopeDOut
                if ($scopeDText -notlike '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeDText
                    throw 'SCENARIO D FAILED: expected the literal reason code MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                }
                if ($scopeDText -like '*MOE_COMMIT_REFUSED_NO_OWNED_PATHS*') {
                    Write-Host $scopeDText
                    throw 'SCENARIO D FAILED: a declared-but-absent path must NOT report the empty-set code'
                }
                if ((& git -C $scopeDDir rev-parse HEAD 2>$null) -ne $scopeDHead) {
                    throw 'SCENARIO D FAILED: a refusal must commit NOTHING; HEAD moved'
                }
                $scopeScenariosRun++
                Write-Host '[scenario D] ok'

                # Scenario E — a GLOB in filesModified. A git pathspec is a glob
                # by default, so an entry of `*` walks straight back out to a
                # whole-tree stage through the very "explicit pathspec" route
                # this fix installs. Measured on a throwaway repo:
                # `git add -- '*'` staged every file; `git add -- ':(literal)*'`
                # matched nothing. Only this scenario can catch that escape.
                Write-Host '[scenario E] a glob in filesModified cannot widen the commit'
                $scopeEDir = Join-Path $tempRoot 'scope-e'
                New-ScopeProject $scopeEDir @('*')
                Set-Content -Path (Join-Path $scopeEDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeEHead = (& git -C $scopeEDir rev-parse HEAD 2>$null)
                $scopeEOut = Join-Path $tempRoot 'scope-e.out'
                Assert-ScopeRun 'E' (Invoke-GateWrapper $scopeEDir $scopeEOut) $scopeEOut
                $scopeEText = Get-Content -Raw -Path $scopeEOut
                if ($scopeEText -notlike '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeEText
                    throw 'SCENARIO E FAILED: a glob must match NO literal path and refuse with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                }
                if ((& git -C $scopeEDir rev-parse HEAD 2>$null) -ne $scopeEHead) {
                    throw 'SCENARIO E FAILED: a glob owned path swept the tree into a commit; HEAD moved'
                }
                if (@(& git -C $scopeEDir status --porcelain 2>$null) -notcontains '?? peer-untracked.txt') {
                    throw 'SCENARIO E FAILED: peer-untracked.txt must still be untracked'
                }
                $scopeScenariosRun++
                Write-Host '[scenario E] ok'

                # Scenario F — BLOCKED exit lands a checkpoint. The stranded-
                # source pattern: report_blocked ended the session with the
                # edits uncommitted forever. Exactly one wip(...) commit on the
                # peeled branch, only owned paths, peer file untouched, no
                # refusal code, and a checkpoint-kind ledger entry.
                Write-Host '[scenario F] a BLOCKED exit lands a wip checkpoint'
                $scopeFDir = Join-Path $tempRoot 'scope-f'
                New-ScopeProject $scopeFDir @('owned-a.txt') -Status 'BLOCKED'
                Set-Content -Path (Join-Path $scopeFDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeFDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeFOut = Join-Path $tempRoot 'scope-f.out'
                Assert-ScopeRun 'F' (Invoke-GateWrapper $scopeFDir $scopeFOut -Status 'BLOCKED') $scopeFOut
                $scopeFText = Get-Content -Raw -Path $scopeFOut
                if ([int](& git -C $scopeFDir rev-list --count HEAD 2>$null) -ne 2) {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: expected exactly one checkpoint commit on top of init"
                }
                $scopeFSubject = Get-HeadSubject $scopeFDir
                if ($scopeFSubject -ne 'wip(task-postflight): Postflight smoke [status=BLOCKED role=worker cli-exit=0]') {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: unexpected checkpoint subject [$scopeFSubject]"
                }
                if ((& git -C $scopeFDir symbolic-ref --short HEAD 2>$null) -notlike 'moe/work-*') {
                    throw 'SCENARIO F FAILED: the checkpoint must land on the peeled moe/work-* branch'
                }
                if ((Get-CommittedPaths $scopeFDir) -ne 'owned-a.txt') {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: checkpoint must contain only the owned path; got [$(Get-CommittedPaths $scopeFDir)]"
                }
                if (@(& git -C $scopeFDir status --porcelain 2>$null) -notcontains '?? peer-untracked.txt') {
                    throw 'SCENARIO F FAILED: peer-untracked.txt must still be untracked'
                }
                if ($scopeFText -like '*MOE_COMMIT_REFUSED_*') {
                    Write-Host $scopeFText
                    throw 'SCENARIO F FAILED: a checkpoint must not emit a refusal code'
                }
                $scopeFRecords = Get-RecordCommitLines $scopeFDir
                if (-not ($scopeFRecords | Where-Object { $_ -like '*"kind":"checkpoint"*' -and $_ -like '*"outcome":"committed"*' })) {
                    Write-Host ($scopeFRecords -join "`n")
                    throw 'SCENARIO F FAILED: record_commit.jsonl must carry a committed checkpoint entry'
                }
                $scopeScenariosRun++
                Write-Host '[scenario F] ok'

                # Scenario G — solo measured attribution: a file the session
                # created but never reported lands alongside the owned path
                # (no other worker is live), and the ledger marks it inferred.
                Write-Host '[scenario G] a solo session-created file is committed as inferred'
                $scopeGDir = Join-Path $tempRoot 'scope-g'
                New-ScopeProject $scopeGDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeGDir 'owned-a.txt') -Value 'owned-a'
                $scopeGOut = Join-Path $tempRoot 'scope-g.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '0'
                try {
                    Assert-ScopeRun 'G' (Invoke-GateWrapper $scopeGDir $scopeGOut -Command $createFileCmd) $scopeGOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeGDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeGOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO G FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeGDir)]"
                }
                $scopeGRecords = Get-RecordCommitLines $scopeGDir
                if (-not ($scopeGRecords | Where-Object { $_.Contains('"inferredPaths":["session-new.txt"]') })) {
                    Write-Host ($scopeGRecords -join "`n")
                    throw 'SCENARIO G FAILED: record_commit must list session-new.txt under inferredPaths'
                }
                if ((& git -C $scopeGDir log -1 --format=%B 2>$null | Out-String) -notlike '*Moe-Inferred: 1*') {
                    throw 'SCENARIO G FAILED: the commit message must carry Moe-Inferred: 1'
                }
                $scopeScenariosRun++
                Write-Host '[scenario G] ok'

                # Scenario H — pre-existing dirt is never swept: a tracked file
                # modified and an untracked file created BEFORE the session
                # stay put even though the session itself creates a file that
                # IS committed. The baseline file records them and is pruned
                # of the landed paths.
                Write-Host '[scenario H] pre-existing dirty paths are excluded by the baseline'
                $scopeHDir = Join-Path $tempRoot 'scope-h'
                New-ScopeProject $scopeHDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeHDir 'baseline-mod.txt') -Value 'base'
                & git -C $scopeHDir add baseline-mod.txt 2>$null | Out-Null
                & git -C $scopeHDir commit -qm baseline-mod 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeHDir 'baseline-mod.txt') -Value 'dirty-before'
                Set-Content -Path (Join-Path $scopeHDir 'baseline-new.txt') -Value 'new-before'
                Set-Content -Path (Join-Path $scopeHDir 'owned-a.txt') -Value 'owned-a'
                $scopeHOut = Join-Path $tempRoot 'scope-h.out'
                Assert-ScopeRun 'H' (Invoke-GateWrapper $scopeHDir $scopeHOut -Command $createFileCmd) $scopeHOut
                if ((Get-CommittedPaths $scopeHDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeHOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO H FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeHDir)]"
                }
                $scopeHStatus = @(& git -C $scopeHDir status --porcelain 2>$null)
                if ($scopeHStatus -notcontains ' M baseline-mod.txt') { throw "SCENARIO H FAILED: baseline-mod.txt must stay modified; status [$($scopeHStatus -join '|')]" }
                if ($scopeHStatus -notcontains '?? baseline-new.txt') { throw "SCENARIO H FAILED: baseline-new.txt must stay untracked; status [$($scopeHStatus -join '|')]" }
                & git -C $scopeHDir cat-file -e HEAD:baseline-new.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw 'SCENARIO H FAILED: baseline-new.txt reached HEAD' }
                $scopeHBaseline = Join-Path $scopeHDir '.git\moe\baseline\task-postflight.tsv'
                if (-not (Test-Path $scopeHBaseline)) { throw 'SCENARIO H FAILED: the baseline file must persist under .git/moe/baseline/ until the task is DONE' }
                $scopeHBaselineText = Get-Content -Raw -Path $scopeHBaseline
                if ($scopeHBaselineText -notlike '*baseline-mod.txt*' -or $scopeHBaselineText -notlike '*baseline-new.txt*') {
                    Write-Host $scopeHBaselineText
                    throw 'SCENARIO H FAILED: the baseline must still record the pre-existing dirty paths'
                }
                if ($scopeHBaselineText -like '*owned-a.txt*') {
                    Write-Host $scopeHBaselineText
                    throw 'SCENARIO H FAILED: landed paths must be pruned from the baseline'
                }
                $scopeScenariosRun++
                Write-Host '[scenario H] ok'

                # Scenario I — a path named by another LIVE task's plan is never
                # swept, even when this session created it and would otherwise
                # be attributed by measurement.
                Write-Host "[scenario I] a peer-declared path stays untracked"
                $scopeIDir = Join-Path $tempRoot 'scope-i'
                New-ScopeProject $scopeIDir @('owned-a.txt')
                Write-PeerTaskRecord $scopeIDir
                Set-Content -Path (Join-Path $scopeIDir 'owned-a.txt') -Value 'owned-a'
                $scopeIOut = Join-Path $tempRoot 'scope-i.out'
                Assert-ScopeRun 'I' (Invoke-GateWrapper $scopeIDir $scopeIOut -Command $createPeerCmd) $scopeIOut
                if ((Get-CommittedPaths $scopeIDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeIOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO I FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeIDir)]"
                }
                if (@(& git -C $scopeIDir status --porcelain 2>$null) -notcontains '?? peer-plan.txt') { throw 'SCENARIO I FAILED: peer-plan.txt must stay untracked' }
                & git -C $scopeIDir cat-file -e HEAD:peer-plan.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw 'SCENARIO I FAILED: peer-plan.txt reached HEAD' }
                if ((Get-Content -Raw -Path $scopeIOut) -notlike '*MOE_ATTR_PEER_DECLARED(task-peer)*') {
                    Get-Content $scopeIOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO I FAILED: expected a [skip] line with MOE_ATTR_PEER_DECLARED(task-peer)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario I] ok'

                # Scenario J — peers active: an undeclared, non-tool-written
                # file is reported, never staged (attribution.undeclared=solo).
                Write-Host '[scenario J] with a live peer an undeclared file is reported as unattributed'
                $scopeJDir = Join-Path $tempRoot 'scope-j'
                New-ScopeProject $scopeJDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeJDir 'owned-a.txt') -Value 'owned-a'
                $scopeJOut = Join-Path $tempRoot 'scope-j.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'J' (Invoke-GateWrapper $scopeJDir $scopeJOut -Command $createFileCmd) $scopeJOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeJDir) -ne 'owned-a.txt') {
                    Get-Content $scopeJOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO J FAILED: only owned-a.txt may land; got [$(Get-CommittedPaths $scopeJDir)]"
                }
                if (@(& git -C $scopeJDir status --porcelain 2>$null) -notcontains '?? session-new.txt') { throw 'SCENARIO J FAILED: session-new.txt must stay untracked' }
                if ((Get-Content -Raw -Path $scopeJOut) -notlike '*MOE_ATTRIBUTION_UNRESOLVED*') {
                    Get-Content $scopeJOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO J FAILED: expected MOE_ATTRIBUTION_UNRESOLVED in the log'
                }
                if (-not (Get-RecordCommitLines $scopeJDir | Where-Object { $_.Contains('"unattributedPaths":["session-new.txt"]') })) {
                    Write-Host ((Get-RecordCommitLines $scopeJDir) -join "`n")
                    throw 'SCENARIO J FAILED: record_commit must carry session-new.txt under unattributedPaths'
                }
                $scopeScenariosRun++
                Write-Host '[scenario J] ok'

                # Scenario K — tool-written evidence beats the peers-active rule:
                # the stream-json harvest saw Write/Edit tool_use on the files.
                Write-Host '[scenario K] tool-written files are committed even with peers active'
                $scopeKDir = Join-Path $tempRoot 'scope-k'
                New-ScopeProject $scopeKDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeKDir 'owned-a.txt') -Value 'owned-a'
                $scopeKOut = Join-Path $tempRoot 'scope-k.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'K' (Invoke-GateWrapper $scopeKDir $scopeKOut -Command $streamJsonCmd) $scopeKOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeKDir) -ne 'owned-a.txt tool-edited.txt tool-written.txt') {
                    Get-Content $scopeKOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO K FAILED: expected owned-a.txt + tool-edited.txt + tool-written.txt; got [$(Get-CommittedPaths $scopeKDir)]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario K] ok'

                # Scenario L — declaration tiers. An ASSERTED path that was
                # already dirty at baseline and never changed is still committed
                # (declaration wins); a PLANNED-only path in the same state is
                # pre-existing debris and skipped with MOE_ATTR_PREEXISTING.
                Write-Host '[scenario L] asserted-unchanged commits; planned-unchanged is pre-existing'
                $scopeLDir = Join-Path $tempRoot 'scope-l'
                $scopeLPlan = @(@{ stepId = 's1'; title = 'planned step'; status = 'PENDING'; affectedFiles = @('planned.txt') })
                New-ScopeProject $scopeLDir @('owned-a.txt') -ImplementationPlan $scopeLPlan
                Set-Content -Path (Join-Path $scopeLDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeLDir 'planned.txt') -Value 'planned-before'
                $scopeLOut = Join-Path $tempRoot 'scope-l.out'
                Assert-ScopeRun 'L' (Invoke-GateWrapper $scopeLDir $scopeLOut) $scopeLOut
                if ((Get-CommittedPaths $scopeLDir) -ne 'owned-a.txt') {
                    Get-Content $scopeLOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO L FAILED: only the asserted path may land; got [$(Get-CommittedPaths $scopeLDir)]"
                }
                if (@(& git -C $scopeLDir status --porcelain 2>$null) -notcontains '?? planned.txt') { throw 'SCENARIO L FAILED: planned.txt must stay untracked' }
                if (-not (Get-Content -Raw -Path $scopeLOut).Contains('[skip] planned.txt MOE_ATTR_PREEXISTING')) {
                    Get-Content $scopeLOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO L FAILED: expected [skip] planned.txt MOE_ATTR_PREEXISTING'
                }
                $scopeScenariosRun++
                Write-Host '[scenario L] ok'

                # Scenario M — a lingering baseline (the previous session never
                # landed: Ctrl+C, window close, crash) is recovered at the NEXT
                # pre-flight of the task, before the CLI launches — on the
                # resume path and on the BLOCKED-hold idle path alike.
                Write-Host '[scenario M] a lingering baseline is recovered before launch'
                $scopeMDir = Join-Path $tempRoot 'scope-m'
                New-ScopeProject $scopeMDir @('owned-a.txt')
                Write-TaskRecord $scopeMDir @('resume-owned.txt') 'WORKING' $null 'task-resume' 'Resume smoke'
                Set-Content -Path (Join-Path $scopeMDir 'resume-owned.txt') -Value 'left-behind'
                $scopeMBaselineDir = Join-Path $scopeMDir '.git\moe\baseline'
                New-Item -ItemType Directory -Force -Path $scopeMBaselineDir | Out-Null
                $scopeMHead = (& git -C $scopeMDir rev-parse HEAD 2>$null)
                # A realistic lingering baseline: the .moe/ records were already
                # dirty when the dead session started (B rows with their blobs),
                # while resume-owned.txt is that session's own unlanded edit.
                $scopeMLines = @("#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head=$scopeMHead")
                foreach ($p in @('.moe/project.json', '.moe/messages/chan-general.jsonl', '.moe/tasks/task-postflight.json', '.moe/tasks/task-resume.json')) {
                    $h = ((& git -C $scopeMDir hash-object -- $p 2>$null) -join '').Trim()
                    $scopeMLines += "B`t$h`t$p"
                }
                [System.IO.File]::WriteAllText((Join-Path $scopeMBaselineDir 'task-resume.tsv'), (($scopeMLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                $scopeMOut = Join-Path $tempRoot 'scope-m.out'
                $env:FAKE_CLAIM_MODE = 'resume'
                try {
                    Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMDir $scopeMOut -Status 'WORKING') $scopeMOut
                } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                $scopeMText = Get-Content -Raw -Path $scopeMOut
                if ($scopeMText -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') {
                    Write-Host $scopeMText
                    throw 'SCENARIO M FAILED: expected MOE_CHECKPOINT_RECOVERED before the launch'
                }
                if ($scopeMText.IndexOf('MOE_CHECKPOINT_RECOVERED') -gt $scopeMText.IndexOf('Command: ')) {
                    throw 'SCENARIO M FAILED: the recovery must run BEFORE the CLI launch'
                }
                $scopeMSubject = Get-HeadSubject $scopeMDir
                if ($scopeMSubject -ne 'wip(task-resume): Resume smoke [status=WORKING role=worker cli-exit=0] recovered') {
                    Write-Host $scopeMText
                    throw "SCENARIO M FAILED: unexpected recovered-checkpoint subject [$scopeMSubject]"
                }
                # The own record was dirty-but-baselined-unchanged: it must STILL
                # land (board: own task record always while dirty) — the exact
                # set pins the board contract in BOTH harness twins.
                if ((Get-CommittedPaths $scopeMDir) -ne '.moe/tasks/task-resume.json resume-owned.txt') { throw "SCENARIO M FAILED: recovery must land EXACTLY the own record + resume-owned.txt; got [$(Get-CommittedPaths $scopeMDir)]" }
                # Second half: the BLOCKED-hold idle path (no CLI launched for the
                # held task) recovers the same way.
                Set-Content -Path (Join-Path $scopeMDir 'resume-owned.txt') -Value 'left-behind-again'
                # Run 1's post-flight completed a landing, so the baseline header
                # now says landed=1 — and a landed baseline is deliberately NOT
                # re-recovered (same semantics as moe-agent.sh). Simulate another
                # session dying mid-task by flipping the flag back to landed=0.
                $scopeMBaselineFile = Join-Path $scopeMBaselineDir 'task-resume.tsv'
                $scopeMBlText = [System.IO.File]::ReadAllText($scopeMBaselineFile)
                if ($scopeMBlText -notlike '*landed=1*') { throw 'SCENARIO M FAILED: run 1 must have marked its baseline landed=1' }
                [System.IO.File]::WriteAllText($scopeMBaselineFile, ($scopeMBlText -replace 'landed=1', 'landed=0'), (New-Object System.Text.UTF8Encoding($false)))
                $scopeMOut2 = Join-Path $tempRoot 'scope-m-blocked.out'
                $env:FAKE_CLAIM_MODE = 'blocked'
                try {
                    Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMDir $scopeMOut2 -Status 'BLOCKED') $scopeMOut2
                } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                $scopeMText2 = Get-Content -Raw -Path $scopeMOut2
                if (-not $scopeMText2.Contains('[blocked] task-resume is BLOCKED')) { Write-Host $scopeMText2; throw 'SCENARIO M FAILED: the BLOCKED hold suppression must still fire' }
                if ($scopeMText2 -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') { Write-Host $scopeMText2; throw 'SCENARIO M FAILED: the idle path must recover the lingering baseline' }
                if ((Get-HeadSubject $scopeMDir) -ne 'wip(task-resume): Resume smoke [status=BLOCKED role=worker cli-exit=0] recovered') {
                    throw "SCENARIO M FAILED: unexpected idle-path subject [$(Get-HeadSubject $scopeMDir)]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario M] ok'

                # Scenario N — plumbing keeps the shared index intact: a peer's
                # pre-staged entry survives (B under plumbing) AND the landed
                # path reads clean in `git status` after the index refresh.
                Write-Host "[scenario N] peer's staged entry survives and landed paths read clean"
                $scopeNDir = Join-Path $tempRoot 'scope-n'
                New-ScopeProject $scopeNDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeNDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeNDir 'peer-staged.txt') -Value 'peer-staged'
                & git -C $scopeNDir add peer-staged.txt 2>$null | Out-Null
                $scopeNOut = Join-Path $tempRoot 'scope-n.out'
                Assert-ScopeRun 'N' (Invoke-GateWrapper $scopeNDir $scopeNOut) $scopeNOut
                if ((Get-CommittedPaths $scopeNDir) -ne 'owned-a.txt') { throw "SCENARIO N FAILED: commit must contain ONLY owned-a.txt; got [$(Get-CommittedPaths $scopeNDir)]" }
                if (@(& git -C $scopeNDir diff --cached --name-only 2>$null) -notcontains 'peer-staged.txt') { throw "SCENARIO N FAILED: the peer's file must remain STAGED" }
                & git -C $scopeNDir cat-file -e HEAD:peer-staged.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw "SCENARIO N FAILED: the peer's staged file reached HEAD" }
                $scopeNStatus = @(& git -C $scopeNDir status --porcelain 2>$null)
                if ($scopeNStatus | Where-Object { $_ -like '*owned-a.txt' }) {
                    Write-Host ($scopeNStatus -join '|')
                    throw 'SCENARIO N FAILED: owned-a.txt must read clean after the index refresh'
                }
                $scopeScenariosRun++
                Write-Host '[scenario N] ok'

                # Scenario O — compare-and-swap retry: a peer moves the branch
                # tip between commit-tree and update-ref (the test seam). The
                # wrapper must rebuild on the new tip: two commits, ours on top,
                # both paths present in HEAD's tree.
                Write-Host '[scenario O] update-ref CAS retries when the branch moves under us'
                $scopeODir = Join-Path $tempRoot 'scope-o'
                New-ScopeProject $scopeODir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeODir 'owned-a.txt') -Value 'owned-a'
                $scopeOOut = Join-Path $tempRoot 'scope-o.out'
                $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $hookPeerCmd
                try {
                    Assert-ScopeRun 'O' (Invoke-GateWrapper $scopeODir $scopeOOut) $scopeOOut
                } finally { Remove-Item Env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF -ErrorAction SilentlyContinue }
                if ([int](& git -C $scopeODir rev-list --count HEAD 2>$null) -ne 3) {
                    Get-Content $scopeOOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO O FAILED: expected init + peer-hook + ours"
                }
                if ((Get-HeadSubject $scopeODir) -notlike 'feat(task-postflight): *') { throw "SCENARIO O FAILED: ours must be on top; HEAD is [$(Get-HeadSubject $scopeODir)]" }
                if ((Get-HeadSubject $scopeODir 'HEAD~1') -ne 'peer-hook') { throw "SCENARIO O FAILED: the peer's commit must be HEAD~1; got [$(Get-HeadSubject $scopeODir 'HEAD~1')]" }
                & git -C $scopeODir cat-file -e HEAD:peer-hook.txt 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'SCENARIO O FAILED: peer-hook.txt must be present in HEAD (rebuilt on the new tip)' }
                & git -C $scopeODir cat-file -e HEAD:owned-a.txt 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'SCENARIO O FAILED: owned-a.txt must be present in HEAD' }
                if ((Get-Content -Raw -Path $scopeOOut) -notlike '*moved under us*') { throw 'SCENARIO O FAILED: expected the CAS retry log line' }
                $scopeScenariosRun++
                Write-Host '[scenario O] ok'

                # Scenario P — board state: the task's OWN record (rewritten by
                # the daemon during the session) is committed with the task; a
                # live peer's record is not.
                Write-Host "[scenario P] own board record commits with the task; a live peer's does not"
                $scopePDir = Join-Path $tempRoot 'scope-p'
                New-ScopeProject $scopePDir @('owned-a.txt')
                Write-PeerTaskRecord $scopePDir
                Set-Content -Path (Join-Path $scopePDir 'owned-a.txt') -Value 'owned-a'
                $scopePOut = Join-Path $tempRoot 'scope-p.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'P' (Invoke-GateWrapper $scopePDir $scopePOut -Command $touchBoardCmd) $scopePOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopePDir) -ne '.moe/tasks/task-postflight.json owned-a.txt') {
                    Get-Content $scopePOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO P FAILED: expected the own record + owned-a.txt; got [$(Get-CommittedPaths $scopePDir)]"
                }
                & git -C $scopePDir cat-file -e HEAD:.moe/tasks/task-peer.json 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw "SCENARIO P FAILED: the live peer's record reached HEAD" }
                $scopeScenariosRun++
                Write-Host '[scenario P] ok'

                # Scenario Q — gate failure parks the work on a RESCUE REF: HEAD
                # unchanged, refs/moe/rescue/<task>/* holds the owned paths,
                # MOE_RESCUE_REF + PUSH-BLOCKED in log and chat, and the wrapper
                # STOPS (with -Loop -PollInterval 1 a non-stopping wrapper
                # would claim again and hit the 30 s timeout).
                Write-Host '[scenario Q] a failing quality gate yields a rescue ref and stops the wrapper'
                $scopeQDir = Join-Path $tempRoot 'scope-q'
                New-GateProject $scopeQDir 'exit 3'
                $scopeQHead = (& git -C $scopeQDir rev-parse HEAD 2>$null)
                $scopeQOut = Join-Path $tempRoot 'scope-q.out'
                Assert-ScopeRun 'Q' (Invoke-GateWrapper $scopeQDir $scopeQOut -LoopOneSecond) $scopeQOut
                $scopeQText = Get-Content -Raw -Path $scopeQOut
                if ((& git -C $scopeQDir rev-parse HEAD 2>$null) -ne $scopeQHead) { Write-Host $scopeQText; throw 'SCENARIO Q FAILED: HEAD must not move on a gate failure' }
                $scopeQRefs = @(Get-RescueRefs $scopeQDir)
                if ($scopeQRefs.Count -ne 1) { Write-Host $scopeQText; throw "SCENARIO Q FAILED: expected exactly one rescue ref; got [$($scopeQRefs -join ',')]" }
                # The gate project's own record is untracked-dirty (same fixture
                # as postflight.sh's make_gate_project), so the rescue parks it
                # too — the own record is always a board candidate while dirty.
                if ((Get-CommittedPaths $scopeQDir $scopeQRefs[0]) -ne '.moe/tasks/task-postflight.json work.txt') { throw "SCENARIO Q FAILED: the rescue ref must hold the own record + work.txt; got [$(Get-CommittedPaths $scopeQDir $scopeQRefs[0])]" }
                if ((Get-HeadSubject $scopeQDir $scopeQRefs[0]) -notmatch '^rescue\(task-postflight\): .* \[reason=gate-failed\]$') { throw "SCENARIO Q FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeQDir $scopeQRefs[0])]" }
                if ($scopeQText -notlike '*MOE_RESCUE_REF task=task-postflight ref=refs/moe/rescue/task-postflight/*reason=gate-failed*') { Write-Host $scopeQText; throw 'SCENARIO Q FAILED: expected the MOE_RESCUE_REF log line' }
                $scopeQChat = Get-Content -Raw -Path (Join-Path $scopeQDir '.moe\messages\chan-general.jsonl')
                if ($scopeQChat -notlike '*MOE_RESCUE_REF task=task-postflight*') { Write-Host $scopeQChat; throw 'SCENARIO Q FAILED: expected MOE_RESCUE_REF in chat' }
                if ($scopeQChat -notlike '*PUSH-BLOCKED: qualityGate failed for task task-postflight*') { Write-Host $scopeQChat; throw 'SCENARIO Q FAILED: expected PUSH-BLOCKED in chat' }
                if ($scopeQText -like '*Agent idle, checking for tasks*') { throw 'SCENARIO Q FAILED: the wrapper must stop after a gate failure, not keep polling' }
                if (-not (Test-Path (Join-Path $scopeQDir '.git\moe\baseline\task-postflight.tsv'))) { throw 'SCENARIO Q FAILED: the baseline must be kept after a gate failure' }
                # Ledger: the rescue's committed/rescue record AND an
                # unconditional failed record — task.lastCommitOutcome must read
                # failed/MOE_COMMIT_FAILED_GATE on both wrappers.
                $scopeQRecords = @(Get-RecordCommitLines $scopeQDir)
                if (-not ($scopeQRecords | Where-Object { $_ -like '*"kind":"rescue"*' })) {
                    Write-Host ($scopeQRecords -join "`n")
                    throw 'SCENARIO Q FAILED: record_commit.jsonl must carry a kind=rescue entry'
                }
                if ($scopeQRecords.Count -eq 0 -or $scopeQRecords[-1] -notlike '*"outcome":"failed"*' -or $scopeQRecords[-1] -notlike '*MOE_COMMIT_FAILED_GATE*') {
                    Write-Host ($scopeQRecords -join "`n")
                    throw 'SCENARIO Q FAILED: the LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_GATE (sent even when the rescue succeeded)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario Q] ok'

                # Scenario R — peel failure (a branch literally named `moe`
                # blocks moe/work-<date>): rescue ref, `break`, exit 0. Both
                # wrappers must break here (the ps1 used to `continue`).
                Write-Host '[scenario R] a branch-peel failure yields a rescue ref and stops the wrapper'
                $scopeRDir = Join-Path $tempRoot 'scope-r'
                New-ScopeProject $scopeRDir @('owned-a.txt')
                & git -C $scopeRDir branch moe 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeRDir 'owned-a.txt') -Value 'owned-a'
                $scopeRHead = (& git -C $scopeRDir rev-parse HEAD 2>$null)
                $scopeROut = Join-Path $tempRoot 'scope-r.out'
                Assert-ScopeRun 'R' (Invoke-GateWrapper $scopeRDir $scopeROut -LoopOneSecond) $scopeROut
                $scopeRText = Get-Content -Raw -Path $scopeROut
                if ((& git -C $scopeRDir rev-parse HEAD 2>$null) -ne $scopeRHead) { Write-Host $scopeRText; throw 'SCENARIO R FAILED: HEAD must not move when the peel fails' }
                $scopeRRefs = @(Get-RescueRefs $scopeRDir)
                if ($scopeRRefs.Count -ne 1) { Write-Host $scopeRText; throw "SCENARIO R FAILED: expected exactly one rescue ref; got [$($scopeRRefs -join ',')]" }
                if ((Get-HeadSubject $scopeRDir $scopeRRefs[0]) -notmatch '\[reason=peel-failed\]$') { throw "SCENARIO R FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeRDir $scopeRRefs[0])]" }
                if ($scopeRText -notlike '*MOE_RESCUE_REF task=task-postflight*reason=peel-failed*') { Write-Host $scopeRText; throw 'SCENARIO R FAILED: expected the MOE_RESCUE_REF log line' }
                if ($scopeRText -like '*Agent idle, checking for tasks*') { throw 'SCENARIO R FAILED: the wrapper must stop after a peel failure' }
                $scopeRRecords = @(Get-RecordCommitLines $scopeRDir)
                if ($scopeRRecords.Count -eq 0 -or $scopeRRecords[-1] -notlike '*"outcome":"failed"*' -or $scopeRRecords[-1] -notlike '*MOE_COMMIT_FAILED_PEEL*') {
                    Write-Host ($scopeRRecords -join "`n")
                    throw 'SCENARIO R FAILED: the LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_PEEL (sent even when the rescue succeeded)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario R] ok'

                # Scenario S — DONE at exit (QA raced ahead) is a completion, not
                # a silent skip; the baseline is dropped once the task is DONE.
                Write-Host '[scenario S] a DONE status still lands a completion commit'
                $scopeSDir = Join-Path $tempRoot 'scope-s'
                New-ScopeProject $scopeSDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeSDir 'owned-a.txt') -Value 'owned-a'
                $scopeSOut = Join-Path $tempRoot 'scope-s.out'
                Assert-ScopeRun 'S' (Invoke-GateWrapper $scopeSDir $scopeSOut -Status 'DONE') $scopeSOut
                if ((Get-HeadSubject $scopeSDir) -ne 'feat(task-postflight): Postflight smoke') { Get-Content $scopeSOut | ForEach-Object { Write-Host $_ }; throw "SCENARIO S FAILED: expected a completion subject; got [$(Get-HeadSubject $scopeSDir)]" }
                if ((& git -C $scopeSDir log -1 --format=%B 2>$null | Out-String) -notlike '*Moe-Status: DONE*') { throw 'SCENARIO S FAILED: the trailer must carry Moe-Status: DONE' }
                if (Test-Path (Join-Path $scopeSDir '.git\moe\baseline\task-postflight.tsv')) { throw 'SCENARIO S FAILED: the baseline must be dropped once the task is DONE' }
                $scopeScenariosRun++
                Write-Host '[scenario S] ok'

                # Scenario T — architect sessions checkpoint their edits under
                # the task id with role=architect in the subject.
                Write-Host '[scenario T] an architect session lands a wip checkpoint'
                $scopeTDir = Join-Path $tempRoot 'scope-t'
                New-ScopeProject $scopeTDir @('owned-a.txt') -Status 'WORKING'
                Set-Content -Path (Join-Path $scopeTDir 'owned-a.txt') -Value 'owned-a'
                $scopeTOut = Join-Path $tempRoot 'scope-t.out'
                Assert-ScopeRun 'T' (Invoke-GateWrapper $scopeTDir $scopeTOut -Status 'WORKING' -Role 'architect' -WorkerId 'architect-gate') $scopeTOut
                if ((Get-HeadSubject $scopeTDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=architect cli-exit=0]') {
                    Get-Content $scopeTOut | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO T FAILED: unexpected subject [$(Get-HeadSubject $scopeTDir)]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario T] ok'

                # Scenario U — unborn HEAD (fresh init, zero commits): the commit
                # lands with no parent and no <old> in the CAS.
                Write-Host '[scenario U] an unborn-HEAD repo still lands the commit'
                $scopeUDir = Join-Path $tempRoot 'scope-u'
                New-ScopeProject $scopeUDir @('owned-a.txt') -NoSeed
                Set-Content -Path (Join-Path $scopeUDir 'owned-a.txt') -Value 'owned-a'
                $scopeUOut = Join-Path $tempRoot 'scope-u.out'
                Assert-ScopeRun 'U' (Invoke-GateWrapper $scopeUDir $scopeUOut) $scopeUOut
                if ([int](& git -C $scopeUDir rev-list --count HEAD 2>$null) -ne 1) { Get-Content $scopeUOut | ForEach-Object { Write-Host $_ }; throw 'SCENARIO U FAILED: expected exactly one (root) commit' }
                # No seed commit, so the own record is untracked-dirty and rides
                # as a board candidate — same exact set as postflight.sh.
                if ((Get-CommittedPaths $scopeUDir) -ne '.moe/tasks/task-postflight.json owned-a.txt') { throw "SCENARIO U FAILED: expected the owned path + board record; got [$(Get-CommittedPaths $scopeUDir)]" }
                if ((& git -C $scopeUDir log -1 --format=%P 2>$null | Out-String).Trim()) { throw 'SCENARIO U FAILED: the root commit must have no parent' }
                if ((& git -C $scopeUDir symbolic-ref --short HEAD 2>$null) -notlike 'moe/work-*') { throw 'SCENARIO U FAILED: the commit must land on the peeled moe/work-* branch' }
                $scopeScenariosRun++
                Write-Host '[scenario U] ok'

                # Scenario V — status lookup failure: the task id is certain, so
                # the work lands as a status=UNKNOWN checkpoint, and the loud
                # PUSH-BLOCKED lookup escalation is kept.
                Write-Host '[scenario V] a status lookup failure lands a status=UNKNOWN checkpoint'
                $scopeVDir = Join-Path $tempRoot 'scope-v'
                New-ScopeProject $scopeVDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeVDir 'owned-a.txt') -Value 'owned-a'
                $scopeVOut = Join-Path $tempRoot 'scope-v.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'empty'
                try {
                    Assert-ScopeRun 'V' (Invoke-GateWrapper $scopeVDir $scopeVOut) $scopeVOut
                } finally { Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue }
                if ((Get-HeadSubject $scopeVDir) -ne 'wip(task-postflight): Postflight smoke [status=UNKNOWN role=worker cli-exit=0]') {
                    Get-Content $scopeVOut | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO V FAILED: unexpected subject [$(Get-HeadSubject $scopeVDir)]"
                }
                if ((Get-Content -Raw -Path (Join-Path $scopeVDir '.moe\messages\chan-general.jsonl')) -notlike '*PUSH-BLOCKED: post-flight status lookup failed for task task-postflight*') {
                    throw 'SCENARIO V FAILED: the lookup-failure chat escalation must be kept'
                }
                $scopeScenariosRun++
                Write-Host '[scenario V] ok'

                # Scenario X — commitHooks=true routes completions through
                # porcelain `git commit`; a rejecting pre-commit hook yields a
                # rescue ref [reason=commit-failed] and HEAD stays put.
                Write-Host '[scenario X] commitHooks=true + rejecting pre-commit hook yields a rescue ref'
                $scopeXDir = Join-Path $tempRoot 'scope-x'
                New-ScopeProject $scopeXDir @('owned-a.txt') -Settings @{ commitHooks = $true }
                $scopeXHook = Join-Path $scopeXDir '.git\hooks\pre-commit'
                [System.IO.File]::WriteAllText($scopeXHook, "#!/bin/sh`nexit 1`n", (New-Object System.Text.UTF8Encoding($false)))
                Set-Content -Path (Join-Path $scopeXDir 'owned-a.txt') -Value 'owned-a'
                $scopeXHead = (& git -C $scopeXDir rev-parse HEAD 2>$null)
                $scopeXOut = Join-Path $tempRoot 'scope-x.out'
                Assert-ScopeRun 'X' (Invoke-GateWrapper $scopeXDir $scopeXOut) $scopeXOut
                $scopeXText = Get-Content -Raw -Path $scopeXOut
                if ((& git -C $scopeXDir rev-parse HEAD 2>$null) -ne $scopeXHead) { Write-Host $scopeXText; throw 'SCENARIO X FAILED: HEAD must not move when the hook rejects' }
                $scopeXRefs = @(Get-RescueRefs $scopeXDir)
                if ($scopeXRefs.Count -ne 1) { Write-Host $scopeXText; throw "SCENARIO X FAILED: expected exactly one rescue ref; got [$($scopeXRefs -join ',')]" }
                if ((Get-HeadSubject $scopeXDir $scopeXRefs[0]) -notmatch '\[reason=commit-failed\]$') { throw "SCENARIO X FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeXDir $scopeXRefs[0])]" }
                if ((Get-CommittedPaths $scopeXDir $scopeXRefs[0]) -ne 'owned-a.txt') { throw "SCENARIO X FAILED: the rescue ref must hold owned-a.txt; got [$(Get-CommittedPaths $scopeXDir $scopeXRefs[0])]" }
                $scopeScenariosRun++
                Write-Host '[scenario X] ok'

                # Scenario Y — grok CLI. A fake grok.cmd takes the grok launch
                # branch (-GrokExec = headless). Run 1: .grok/config.toml is
                # written (moe + serena, since MOE_SERENA_PATH resolves) with
                # the LITERAL ${MOE_WORKER_ID:-} template and no top-level
                # keys; argv carries --prompt-file/--yolo/--cwd; the prompt
                # file holds role doc + session context + directive under
                # $env:TEMP (removed on exit); the fake's exit 3 propagates
                # into the post-flight (chat line + checkpoint subject); the
                # config never lands. Run 2: byte-identical config, explicit
                # MOE_GROK_MODEL/MOE_GROK_EFFORT reach argv. Run 3: Serena
                # "uninstalled" strips its block while a user [permission]
                # table survives, and a config dirtied MID-SESSION (changed
                # since the baseline, so only the DENY tier keeps it out)
                # still never lands.
                Write-Host '[scenario Y] grok: config.toml written idempotently, headless argv, exit propagated, config never landed'
                $scopeYDir = Join-Path $tempRoot 'scope-y'
                New-ScopeProject $scopeYDir @('owned-a.txt') -Status 'WORKING'
                Set-Content -Path (Join-Path $scopeYDir 'owned-a.txt') -Value 'owned-a'
                $scopeYConfig = Join-Path $scopeYDir '.grok\config.toml'
                $scopeYArgv = Join-Path $tempRoot 'scope-y-argv.txt'
                $scopeYPrompt = Join-Path $tempRoot 'scope-y-prompt.md'
                function Invoke-GrokWrapper([string]$outFile) {
                    Remove-Item -LiteralPath $scopeYArgv -Force -ErrorAction SilentlyContinue
                    return (Invoke-WrapperProcess @('-Project', $scopeYDir, '-WorkerId', 'worker-grok', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $grokCmd, '-GrokExec', '-NoLoop', '-PollInterval', '0') $outFile)
                }
                $scopeYPrevSerena = $env:MOE_SERENA_PATH
                $scopeYPrevKey = $env:XAI_API_KEY
                # Operator env that would change run 1's argv/TOML (documented
                # MOE_GROK_* knobs, WSL MOE_DAEMON_HOST): snapshot, clear, restore.
                $scopeYPrevOperatorEnv = @{}
                # GROK_HOME too: the wrapper writes grok's trust store under it,
                # and the harness must never touch the operator's real store.
                foreach ($name in @('MOE_GROK_MODEL', 'MOE_GROK_EFFORT', 'MOE_GROK_MCP_STARTUP_TIMEOUT_SEC', 'MOE_GROK_MCP_TOOL_TIMEOUT_SEC', 'MOE_DAEMON_HOST', 'GROK_HOME')) {
                    $scopeYPrevOperatorEnv[$name] = [Environment]::GetEnvironmentVariable($name)
                    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
                }
                $env:FAKE_TASK_STATUS = 'WORKING'
                $env:FAKE_GROK_ARGV_FILE = $scopeYArgv
                $env:FAKE_GROK_PROMPT_COPY = $scopeYPrompt
                # Any existing file passes the writer's Test-Path; the shim is
                # never executed as Serena. USERPROFILE is the empty $homeDir,
                # so ~/.grok/auth.json is absent and the auth WARN must fire.
                $env:MOE_SERENA_PATH = $trueCmd
                Remove-Item Env:XAI_API_KEY -ErrorAction SilentlyContinue
                try {
                    # Run 1: fresh config, fake exit 3.
                    $env:FAKE_GROK_EXIT = '3'
                    $scopeYOut = Join-Path $tempRoot 'scope-y.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut) $scopeYOut
                    } finally { Remove-Item Env:FAKE_GROK_EXIT -ErrorAction SilentlyContinue }
                    $scopeYText = Get-Content -Raw -Path $scopeYOut
                    if (-not (Test-Path -LiteralPath $scopeYConfig)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: .grok/config.toml was not written' }
                    $scopeYToml = [System.IO.File]::ReadAllText($scopeYConfig)
                    $scopeYBytes1 = [System.IO.File]::ReadAllBytes($scopeYConfig)
                    if ($scopeYBytes1.Length -ge 3 -and $scopeYBytes1[0] -eq 0xEF -and $scopeYBytes1[1] -eq 0xBB -and $scopeYBytes1[2] -eq 0xBF) { throw 'SCENARIO Y FAILED: .grok/config.toml must be written without a BOM' }
                    foreach ($needle in @('[mcp_servers.moe]', '[mcp_servers.moe.env]', 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"', 'MOE_TOOL_NAME_STYLE = "underscore"', 'startup_timeout_sec = 120', 'tool_timeout_sec = 120', 'moe_wait_for_task = 720', '[mcp_servers.serena]', '"--context", "agent"')) {
                        if (-not $scopeYToml.Contains($needle)) { Write-Host $scopeYToml; throw "SCENARIO Y FAILED: .grok/config.toml must contain [$needle]" }
                    }
                    if ($scopeYToml -match '(?m)^(model_reasoning_effort|developer_instructions|model_instructions_file|project_doc_fallback_filenames)\s*=') { Write-Host $scopeYToml; throw 'SCENARIO Y FAILED: a grok project config must carry NO top-level keys' }
                    if ($scopeYToml.Contains('\')) { Write-Host $scopeYToml; throw 'SCENARIO Y FAILED: paths in .grok/config.toml must be forward-slashed' }
                    foreach ($banner in @('Grok MCP config written to:', 'Grok folder trust granted:', 'Grok mode: headless (--prompt-file --yolo)', '[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing - grok will fail to authenticate.', 'Command: ')) {
                        if (-not $scopeYText.Contains($banner)) { Write-Host $scopeYText; throw "SCENARIO Y FAILED: expected [$banner] in the wrapper output" }
                    }
                    # -- folder trust (USERPROFILE is the harness home, so this is the harness store) --
                    $scopeYTrust = Join-Path $homeDir '.grok\trusted_folders.toml'
                    if (-not (Test-Path -LiteralPath $scopeYTrust)) { Write-Host $scopeYText; throw "SCENARIO Y FAILED: expected grok trust store $scopeYTrust to be written at pre-flight" }
                    $scopeYTrustText = [System.IO.File]::ReadAllText($scopeYTrust)
                    $scopeYTrustTables = ([regex]::Matches($scopeYTrustText, "(?m)^\[folders\.'")).Count
                    if ($scopeYTrustTables -ne 1 -or -not $scopeYTrustText.Contains('trusted = true')) { Write-Host $scopeYTrustText; throw "SCENARIO Y FAILED: expected exactly one trusted [folders.'…'] table in $scopeYTrust" }
                    if (-not (Test-Path -LiteralPath $scopeYArgv)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: the fake grok was never launched (no argv file)' }
                    $scopeYArgvText = Get-Content -Raw -Path $scopeYArgv
                    foreach ($flag in @('--prompt-file', '--yolo', '--cwd', '--no-auto-update', '--output-format plain')) {
                        if (-not $scopeYArgvText.Contains($flag)) { Write-Host $scopeYArgvText; throw "SCENARIO Y FAILED: grok argv must carry $flag" }
                    }
                    if ($scopeYArgvText -match '(^|\s)-m(\s|$)' -or $scopeYArgvText.Contains('--effort') -or $scopeYArgvText.Contains('claude-opus')) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: without an explicit model/effort there must be no -m / --effort on argv (and never the claude fallback model)' }
                    if ($scopeYArgvText.Contains('--prompt ') -or $scopeYArgvText.Contains('--print')) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: grok has no --prompt / --print flag' }
                    if ($scopeYArgvText.IndexOf($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: the prompt file must live under $env:TEMP, never in the project' }
                    $scopeYCwd = (Get-Content -Raw -Path "$scopeYArgv.cwd").Trim()
                    if ((Get-Item -LiteralPath $scopeYCwd).FullName.TrimEnd('\') -ne (Get-Item -LiteralPath $scopeYDir).FullName.TrimEnd('\')) { throw "SCENARIO Y FAILED: grok must run with cwd = project; got [$scopeYCwd]" }
                    if (-not (Test-Path -LiteralPath $scopeYPrompt)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: the --prompt-file path was not readable by the fake grok' }
                    $scopeYPromptText = Get-Content -Raw -Path $scopeYPrompt
                    foreach ($needle in @('Role: worker', '# Session Context (per-iteration)', '<claimed_task_context>', 'Task task-postflight is claimed')) {
                        if (-not $scopeYPromptText.Contains($needle)) { Write-Host $scopeYPromptText; throw "SCENARIO Y FAILED: the grok prompt file must contain [$needle]" }
                    }
                    if (@(Get-ChildItem -Path $tempRoot -Filter 'moe-grok-prompt-*.md' -File -ErrorAction SilentlyContinue).Count -ne 0) { throw 'SCENARIO Y FAILED: the wrapper must remove its grok prompt file on exit' }
                    if (Test-Path -LiteralPath (Join-Path $scopeYDir 'AGENTS.md')) { throw 'SCENARIO Y FAILED: the wrapper must not write AGENTS.md into the project' }
                    $scopeYChat = Get-Content -Raw -Path (Join-Path $scopeYDir '.moe\messages\chan-general.jsonl')
                    if ($scopeYChat -notlike '*worker session ended: task=task-postflight (CLI exit=3)*') { Write-Host $scopeYChat; throw 'SCENARIO Y FAILED: the fake grok exit 3 must propagate into the session-ended line' }
                    if ((Get-HeadSubject $scopeYDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=3]') { Write-Host $scopeYText; throw "SCENARIO Y FAILED: unexpected checkpoint subject [$(Get-HeadSubject $scopeYDir)]" }
                    if ((Get-CommittedPaths $scopeYDir) -ne 'owned-a.txt') { Write-Host $scopeYText; throw "SCENARIO Y FAILED: only owned-a.txt may land; got [$(Get-CommittedPaths $scopeYDir)]" }
                    $scopeYHash1 = (Get-FileHash -Algorithm SHA256 -LiteralPath $scopeYConfig).Hash

                    # Run 2: byte-identical re-write; an explicit model + effort
                    # reach argv; nothing new to land.
                    $env:MOE_GROK_MODEL = 'grok-4-fast'
                    $env:MOE_GROK_EFFORT = 'high'
                    $scopeYOut2 = Join-Path $tempRoot 'scope-y-2.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut2) $scopeYOut2
                    } finally {
                        Remove-Item Env:MOE_GROK_MODEL -ErrorAction SilentlyContinue
                        Remove-Item Env:MOE_GROK_EFFORT -ErrorAction SilentlyContinue
                    }
                    $scopeYHash2 = (Get-FileHash -Algorithm SHA256 -LiteralPath $scopeYConfig).Hash
                    if ($scopeYHash1 -ne $scopeYHash2) { Write-Host ([System.IO.File]::ReadAllText($scopeYConfig)); throw 'SCENARIO Y FAILED: a second run must leave .grok/config.toml byte-identical' }
                    $scopeYArgvText2 = Get-Content -Raw -Path $scopeYArgv
                    if (-not $scopeYArgvText2.Contains('-m grok-4-fast') -or -not $scopeYArgvText2.Contains('--effort high')) { Write-Host $scopeYArgvText2; throw 'SCENARIO Y FAILED: MOE_GROK_MODEL / MOE_GROK_EFFORT must reach argv as -m / --effort' }
                    if ([int](& git -C $scopeYDir rev-list --count HEAD 2>$null) -ne 2) { Get-Content $scopeYOut2 | ForEach-Object { Write-Host $_ }; throw 'SCENARIO Y FAILED: an unchanged tree must not land a second commit' }

                    # Run 3: Serena "uninstalled" (MOE_SERENA_PATH points at
                    # nothing) strips its block, a user [permission] table
                    # survives, and the config dirtied mid-session never lands.
                    $env:MOE_SERENA_PATH = Join-Path $tempRoot 'no-such-serena.exe'
                    [System.IO.File]::AppendAllText($scopeYConfig, "`n[permission]`nmode = `"auto`"`n", (New-Object System.Text.UTF8Encoding($false)))
                    Set-Content -Path (Join-Path $scopeYDir 'owned-a.txt') -Value 'owned-a-again'
                    $env:FAKE_GROK_TOUCH_CONFIG = '1'
                    $scopeYOut3 = Join-Path $tempRoot 'scope-y-3.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut3) $scopeYOut3
                    } finally { Remove-Item Env:FAKE_GROK_TOUCH_CONFIG -ErrorAction SilentlyContinue }
                    $scopeYToml3 = [System.IO.File]::ReadAllText($scopeYConfig)
                    if ($scopeYToml3.Contains('[mcp_servers.serena]')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: a stale serena block must be stripped when Serena is not installed' }
                    if (-not $scopeYToml3.Contains('[permission]') -or -not $scopeYToml3.Contains('mode = "auto"')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: a user [permission] table must survive the merge' }
                    if (([regex]::Matches($scopeYToml3, '\[mcp_servers\.moe\]')).Count -ne 1) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: exactly one [mcp_servers.moe] block must remain after the merge' }
                    if (-not $scopeYToml3.Contains('# touched by the session')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: the shim did not dirty the config, so the DENY discriminator is inert' }
                    if ((Get-HeadSubject $scopeYDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=0]') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw "SCENARIO Y FAILED: unexpected run-3 subject [$(Get-HeadSubject $scopeYDir)]" }
                    if ((Get-CommittedPaths $scopeYDir) -ne 'owned-a.txt') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw "SCENARIO Y FAILED: a mid-session-dirtied .grok/config.toml must never land; got [$(Get-CommittedPaths $scopeYDir)]" }
                    & git -C $scopeYDir cat-file -e HEAD:.grok/config.toml 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) { throw 'SCENARIO Y FAILED: .grok/config.toml reached HEAD' }
                    if (@(& git -C $scopeYDir status --porcelain --untracked-files=all 2>$null) -notcontains '?? .grok/config.toml') { throw 'SCENARIO Y FAILED: .grok/config.toml must still be untracked' }
                    if ((Get-Content -Raw -Path $scopeYOut3) -notlike '*MOE_ATTR_EXCLUDED*') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw 'SCENARIO Y FAILED: the dirtied config must be reported under MOE_ATTR_EXCLUDED' }
                } finally {
                    Remove-Item Env:FAKE_GROK_ARGV_FILE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_PROMPT_COPY -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_EXIT -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_TOUCH_CONFIG -ErrorAction SilentlyContinue
                    if ($null -ne $scopeYPrevSerena) { $env:MOE_SERENA_PATH = $scopeYPrevSerena } else { Remove-Item Env:MOE_SERENA_PATH -ErrorAction SilentlyContinue }
                    if ($null -ne $scopeYPrevKey) { $env:XAI_API_KEY = $scopeYPrevKey }
                    foreach ($name in $scopeYPrevOperatorEnv.Keys) {
                        if ($null -ne $scopeYPrevOperatorEnv[$name]) { [Environment]::SetEnvironmentVariable($name, $scopeYPrevOperatorEnv[$name]) } else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                    }
                    $env:FAKE_TASK_STATUS = 'REVIEW'
                }
                $scopeScenariosRun++
                Write-Host '[scenario Y] ok'

                # A harness that silently generated zero scenarios exits 0 and
                # reads as green.
                Write-Host "commit-scope scenarios run: $scopeScenariosRun"
                if ($scopeScenariosRun -ne 24) {
                    throw "Expected 24 commit-scope scenarios (A-V, X, Y); ran $scopeScenariosRun"
                }

                $gateFailCommits = [int](& git -C $gateFailDir rev-list --count HEAD 2>$null)
                $gateFailRescueRefs = @(Get-RescueRefs $gateFailDir)
                $gateTruncCommits = [int](& git -C $gateTruncDir rev-list --count HEAD 2>$null)
                $gateLookupCommits = [int](& git -C $gateLookupDir rev-list --count HEAD 2>$null)
                $gateLookupSubject = Get-HeadSubject $gateLookupDir
                $gateMismatchCommits = [int](& git -C $gateMismatchDir rev-list --count HEAD 2>$null)
                $gateMismatchSubject = Get-HeadSubject $gateMismatchDir
                $gateLookupMessages = Get-Content -Raw -Path (Join-Path $gateLookupDir '.moe\messages\chan-general.jsonl')
                $gatePassCommits = [int](& git -C $gatePassDir rev-list --count HEAD 2>$null)
                $gateSkipCommits = [int](& git -C $gateSkipDir rev-list --count HEAD 2>$null)
                $gateMidCommits = [int](& git -C $gateMidDir rev-list --count HEAD 2>$null)
                $gateDaemonMidCommits = [int](& git -C $gateDaemonMidDir rev-list --count HEAD 2>$null)
                $gateDaemonFinalCommits = [int](& git -C $gateDaemonFinalDir rev-list --count HEAD 2>$null)
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
    # moved to Serena). The post-flight chat message remains the session signal;
    # it now carries the landing summary after the CLI exit code.
    $messagesFile = Join-Path $projectDir '.moe\messages\chan-general.jsonl'
    $messages = Get-Content -Raw -Path $messagesFile
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0)*') {
        throw 'Expected post-flight chat message not found'
    }
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0) commit=none kind=none*') {
        Write-Host $messages
        throw 'Expected the session-ended line to carry the commit=<sha|none> kind=<k> landing summary'
    }
    # The quiet half of the same decision: this run's task resolves cleanly to a
    # non-REVIEW status, which is a legitimate no-op. It must NOT be reported as
    # a failed lookup — collapsing those two back together is what hid the defect.
    if ((Get-Content -Raw -Path $wrapperOut) -like '*post-flight status lookup failed*') {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw 'A resolved non-REVIEW status must stay a quiet no-op, not warn as a lookup failure'
    }
    # autoCommit=false is no longer silent: the skip is logged.
    if ((Get-Content -Raw -Path $wrapperOut) -notlike '*settings.autoCommit=false*') {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw 'Expected an [info] line naming settings.autoCommit=false'
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
            throw "Failing qualityGate must block the branch commit (found $gateFailCommits commits)"
        }
        if ($gateFailRescueRefs.Count -ne 1) {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Failing qualityGate must park the work on exactly one rescue ref (found $($gateFailRescueRefs.Count))"
        }
        if ((Get-Content -Raw -Path $wrapperGateFailOut) -notlike '*MOE_RESCUE_REF task=task-postflight*reason=gate-failed*') {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected the MOE_RESCUE_REF log line after a gate failure'
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
        if ($gateDaemonMidCode -ne 0) {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-daemonmid wrapper exited with $gateDaemonMidCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateDaemonMidOut) -notlike '*qualityGate deferred*') {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'A daemon isEpicFinal=false must defer the gate even when the sibling page would say epic-final'
        }
        if ($gateDaemonMidCommits -ne 2) {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Daemon-deferred gate must not block the commit (found $gateDaemonMidCommits commits)"
        }
        if ($gateDaemonFinalCode -ne 0) {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-daemonfinal wrapper exited with $gateDaemonFinalCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateDaemonFinalOut) -notlike '*qualityGate failed (exit 3)*') {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'A daemon isEpicFinal=true must run the gate even when the sibling page says mid-epic'
        }
        if ($gateDaemonFinalCommits -ne 1) {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "The daemon-final failing gate must block the commit (found $gateDaemonFinalCommits commits)"
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
        # Updated expectation (scenario V): the id is certain, so the work still
        # lands — as a status=UNKNOWN checkpoint, never as a completion.
        if ($gateLookupCommits -ne 2 -or $gateLookupSubject -notmatch '^wip\(task-postflight\): .*\[status=UNKNOWN ') {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "An unresolved status must land a status=UNKNOWN checkpoint (found $gateLookupCommits commits, HEAD [$gateLookupSubject])"
        }
        if ($gateMismatchCode -ne 0) {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-mismatch wrapper exited with $gateMismatchCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateMismatchOut) -notlike '*get_context resolved a different task (task-someone-elses)*') {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected the wrapper to reject a get_context fallback onto a different task'
        }
        if ($gateMismatchCommits -ne 2 -or $gateMismatchSubject -notmatch '^wip\(task-postflight\): .*\[status=UNKNOWN ') {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "A get_context fallback onto a different task must land a status=UNKNOWN checkpoint, never a completion (found $gateMismatchCommits commits, HEAD [$gateMismatchSubject])"
        }
    } else {
        Write-Host 'SKIP qualityGate cases: git not available'
    }

    Write-Host 'PASS postflight.ps1'
} catch {
    Write-Error $_
    exit 1
} finally {
    # MOE_POSTFLIGHT_KEEP_TEMP=1 keeps the throwaway repos + wrapper logs for
    # post-mortem inspection of a failing scenario.
    if ($env:MOE_POSTFLIGHT_KEEP_TEMP -eq '1') {
        Write-Host "postflight.ps1: temp kept at $tempRoot"
    } else {
        Remove-Item -Recurse -Force -LiteralPath $tempRoot -ErrorAction SilentlyContinue
    }
}

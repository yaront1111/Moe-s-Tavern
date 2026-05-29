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

    $conflictOut = Join-Path $tempRoot 'conflict.out'
    & pwsh -NoProfile -File $wrapper -Loop -NoLoop *> $conflictOut
    $conflictCode = $LASTEXITCODE
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
  case 'claim_next_task': ok({ hasNext: true, task: { id: 'task-postflight', title: 'Postflight smoke', status: 'WORKING', chatChannel: 'chan-task' } }); break;
  case 'get_context': ok({ task: { id: 'task-postflight', implementationPlan: [], definitionOfDone: [] }, project: {}, epic: {}, nextAction: { tool: 'moe.start_step' } }); break;
  case 'list_tasks': ok({ tasks: [{ id: 'task-postflight', status: 'WORKING', reopenCount: 0 }] }); break;
  case 'chat_send': {
    const dir = path.join(moe, 'messages');
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, `${args.channel}.jsonl`), JSON.stringify({ sender: args.workerId, content: args.content }) + '\n');
    ok({ success: true });
    break;
  }
  default: ok({ success: true });
}
'@

    $trueCmd = Join-Path $tempRoot 'true.cmd'
    Set-Content -Path $trueCmd -Encoding ASCII -Value "@echo off`r`nexit /b 0`r`n"

    $oldProxy = $env:MOE_PROXY_PATH
    $oldUserProfile = $env:USERPROFILE
    $oldTemp = $env:TEMP
    $env:MOE_PROXY_PATH = $fakeProxy
    $env:USERPROFILE = $homeDir
    $env:TEMP = $tempRoot
    $wrapperOut = Join-Path $tempRoot 'wrapper.out'
    try {
        & pwsh -NoProfile -File $wrapper `
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
    } finally {
        $env:MOE_PROXY_PATH = $oldProxy
        $env:USERPROFILE = $oldUserProfile
        $env:TEMP = $oldTemp
    }
    if ($wrapperCode -ne 0) {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Wrapper exited with $wrapperCode"
    }

    # Post-flight no longer writes a session-summary file (cross-session memory
    # moved to Serena). The post-flight chat message remains the session signal.
    $messagesFile = Join-Path $projectDir '.moe\messages\chan-general.jsonl'
    $messages = Get-Content -Raw -Path $messagesFile
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0)*') {
        throw 'Expected post-flight chat message not found'
    }

    Write-Host 'PASS postflight.ps1'
} catch {
    Write-Error $_
    exit 1
} finally {
    Remove-Item -Recurse -Force -LiteralPath $tempRoot -ErrorAction SilentlyContinue
}

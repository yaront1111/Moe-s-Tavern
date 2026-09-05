param()
# Parity check for the two agent wrappers (scripts/moe-agent.ps1 and
# scripts/moe-agent.sh). Both must emit the SAME reason codes, chat prefixes,
# log prefixes, commit-message trailers, settings keys and env names, so an
# operator grepping either transcript (or git log) finds the same strings.
# Twin: scripts/tests/parity-check.sh. Exit 1 on any asymmetry.
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$ps1Path = Join-Path $root 'scripts\moe-agent.ps1'
$shPath = Join-Path $root 'scripts\moe-agent.sh'
if (-not (Test-Path -LiteralPath $ps1Path)) { Write-Host "FAIL parity-check.ps1: missing $ps1Path"; exit 1 }
if (-not (Test-Path -LiteralPath $shPath)) { Write-Host "FAIL parity-check.ps1: missing $shPath"; exit 1 }
$ps1 = Get-Content -Raw -LiteralPath $ps1Path
$sh = Get-Content -Raw -LiteralPath $shPath

$failures = New-Object System.Collections.Generic.List[string]

# 1. Dynamic symmetry: every reason-code token found in either file must be
#    present in the other (catches a code added to one wrapper only).
$dynamicPatterns = @(
    'MOE_COMMIT_[A-Z_]+',
    'MOE_ATTR_[A-Z_]+',
    'MOE_CHECKPOINT_[A-Z_]+',
    'MOE_ATTRIBUTION_[A-Z_]+',
    'MOE_RESCUE_REF'
)
# NOTE: the sh wrapper's internal MOE_LAND_* names (env plumbing between bash
# and its inline python attribution) are deliberately NOT compared — they are
# internal, not operator-facing. The MOE_ATTR_*/MOE_COMMIT_* namespaces are the
# contract and any spill into them is flagged.
# moe-agent.sh bridges its attribution policy to an inline python snippet via
# process-env names that share the MOE_ATTR_/MOE_COMMIT_ prefixes but are never
# emitted to a transcript, chat, or commit. They are exempt from the symmetry
# rule; everything the operator can grep for still is compared.
$internalPlumbing = @('MOE_ATTR_UNDECLARED', 'MOE_ATTR_EXCLUDE', 'MOE_ATTR_POLICY_OVERRIDE', 'MOE_COMMIT_BOARD_STATE')
foreach ($pat in $dynamicPatterns) {
    $inPs1 = @([regex]::Matches($ps1, $pat) | ForEach-Object { $_.Value } | Sort-Object -Unique | Where-Object { $internalPlumbing -notcontains $_ })
    $inSh = @([regex]::Matches($sh, $pat) | ForEach-Object { $_.Value } | Sort-Object -Unique | Where-Object { $internalPlumbing -notcontains $_ })
    foreach ($t in $inPs1) { if ($inSh -notcontains $t) { $failures.Add("token '$t' is in moe-agent.ps1 but not in moe-agent.sh") } }
    foreach ($t in $inSh) { if ($inPs1 -notcontains $t) { $failures.Add("token '$t' is in moe-agent.sh but not in moe-agent.ps1") } }
}

# 2. Required literals: the contract every operator runbook greps for. Each
#    must appear in BOTH wrappers.
$required = [ordered]@{
    'reason codes' = @(
        'MOE_COMMIT_REFUSED_NO_OWNED_PATHS', 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING', 'MOE_COMMIT_NOTHING_TO_COMMIT',
        'MOE_COMMIT_FAILED_REF_CONTENTION', 'MOE_COMMIT_INDEX_REFRESH_FAILED',
        'MOE_ATTR_EXCLUDED', 'MOE_ATTR_CONTESTED', 'MOE_ATTR_PEER_DECLARED', 'MOE_ATTR_PREEXISTING', 'MOE_ATTR_MISSING', 'MOE_ATTR_CONCURRENT',
        'MOE_CHECKPOINT_RECOVERED', 'MOE_RESCUE_REF', 'MOE_ATTRIBUTION_UNRESOLVED'
    )
    'chat prefixes' = @('PUSH-BLOCKED:', 'PUSH FAILED', 'CHECKPOINT-UNPUSHED', 'MOE_RESCUE_REF task=')
    'log prefixes' = @('[attribution]', '[skip]', '[rescue]', '[branch]')
    'commit trailers' = @('Moe-Task:', 'Moe-Kind:', 'Moe-Session:', 'Moe-Status:', 'Moe-Paths:', 'Moe-Inferred:', 'Moe-Contested:', 'Moe-Reason:')
    'commit subjects' = @('wip(', 'rescue(', 'Completed via Moe worker session.', 'not a completion.', 'Checkpoint via Moe', 'Rescue snapshot via Moe', 'refs/moe/rescue/', 'retry after qa_reject #')
    'settings keys' = @('autoCommit', 'checkpointCommits', 'checkpointPush', 'commitBoardState', 'commitHooks', 'attribution', 'undeclared', 'contested', 'exclude', 'qualityGate', 'qualityGateScope', 'consolidationBranch')
    'env names' = @('GIT_TERMINAL_PROMPT', 'MOE_DISABLE_CHECKPOINT', 'MOE_ATTRIBUTION', 'MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF', 'MOE_DISABLE_QUALITY_GATE', 'MOE_RESUME_MAX_ATTEMPTS',
        'MOE_GROK_MODEL', 'MOE_GROK_EFFORT', 'MOE_GROK_MCP_STARTUP_TIMEOUT_SEC', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED', 'GROK_DISABLE_AUTOUPDATER', 'MOE_TOOL_NAME_STYLE', 'MOE_GROK_MCP_TOOL_TIMEOUT_SEC')
    'baseline / index' = @('#moe-baseline v1', 'moe/baseline', ':(literal)', '--porcelain=v1 -z --untracked-files=all --no-renames', 'hash-object --stdin-paths')
    'RPC tools' = @('get_commit_scope', 'record_commit')
    'context fields' = @('isEpicFinal')
    'blocked-hold prose' = @('only resource-lease waits and third-party blocks hold a seat now')
    # Agent-CLI parity: every CLI the launchers support is wired the same way in
    # both wrappers - its config dir is a DENY-tier attribution prefix, its
    # cliType literal exists, and its mode/config banners are grep-stable.
    'cli config dirs' = @('.codex/', '.gemini/', '.grok/')
    'cli types' = @('"grok"')
    'cli banners' = @('Grok MCP config written to:', 'Grok mode: headless', 'Grok mode: interactive', 'Grok folder trust granted:', 'trusted_folders.toml', 'moe__moe_<name>', 'tool_timeouts = { moe_wait_for_task = 720, moe_chat_wait = 720, moe_wait_for_resource = 720 }')
}
foreach ($group in $required.Keys) {
    foreach ($lit in $required[$group]) {
        $inPs1 = $ps1.IndexOf($lit, [System.StringComparison]::Ordinal) -ge 0
        $inSh = $sh.IndexOf($lit, [System.StringComparison]::Ordinal) -ge 0
        if (-not $inPs1 -and -not $inSh) { $failures.Add("[$group] '$lit' is missing from BOTH wrappers") }
        elseif (-not $inPs1) { $failures.Add("[$group] '$lit' is missing from moe-agent.ps1") }
        elseif (-not $inSh) { $failures.Add("[$group] '$lit' is missing from moe-agent.sh") }
    }
}

# 3. Deferred features must not be advertised by either wrapper.
foreach ($deferred in @('recoverOrphanBaselines', 'parkUnassignedBlocked')) {
    if ($ps1.IndexOf($deferred, [System.StringComparison]::Ordinal) -ge 0) { $failures.Add("deferred setting '$deferred' is referenced by moe-agent.ps1") }
    if ($sh.IndexOf($deferred, [System.StringComparison]::Ordinal) -ge 0) { $failures.Add("deferred setting '$deferred' is referenced by moe-agent.sh") }
}

if ($failures.Count -gt 0) {
    Write-Host "FAIL parity-check.ps1: $($failures.Count) asymmetry(ies) between moe-agent.ps1 and moe-agent.sh"
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}
Write-Host 'PASS parity-check.ps1'
exit 0

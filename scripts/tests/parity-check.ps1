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
# UTF-8 explicitly: PS 5.1 reads a BOM-less file (moe-agent.sh) as ANSI, which
# garbles every non-ASCII needle below.
$ps1 = Get-Content -Raw -Encoding UTF8 -LiteralPath $ps1Path
$sh = Get-Content -Raw -Encoding UTF8 -LiteralPath $shPath

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
    # The gate-failure line's marker (the status-lookup line carries none in
    # either), spelled by code point: this file has no BOM for PS 5.1 to go by.
    'chat prefixes' = @("$([char]::ConvertFromUtf32(0x1F6AB)) PUSH-BLOCKED:", 'PUSH FAILED', 'CHECKPOINT-UNPUSHED', 'MOE_RESCUE_REF task=')
    'log prefixes' = @('[attribution]', '[skip]', '[rescue]', '[branch]')
    'commit trailers' = @('Moe-Task:', 'Moe-Kind:', 'Moe-Session:', 'Moe-Status:', 'Moe-Paths:', 'Moe-Inferred:', 'Moe-Contested:', 'Moe-Reason:')
    'commit subjects' = @('wip(', 'rescue(', 'Completed via Moe worker session.', 'not a completion.', 'Checkpoint via Moe', 'Rescue snapshot via Moe', 'refs/moe/rescue/', 'retry after qa_reject #')
    'settings keys' = @('autoCommit', 'checkpointCommits', 'checkpointPush', 'commitBoardState', 'commitHooks', 'attribution', 'undeclared', 'contested', 'exclude', 'qualityGate', 'qualityGateScope', 'consolidationBranch')
    'env names' = @('GIT_TERMINAL_PROMPT', 'MOE_DISABLE_CHECKPOINT', 'MOE_ATTRIBUTION', 'MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF', 'MOE_DISABLE_QUALITY_GATE', 'MOE_RESUME_MAX_ATTEMPTS',
        'MOE_GROK_MODEL', 'MOE_GROK_EFFORT', 'MOE_GROK_MCP_STARTUP_TIMEOUT_SEC', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED', 'GROK_DISABLE_AUTOUPDATER', 'MOE_TOOL_NAME_STYLE', 'MOE_GROK_MCP_TOOL_TIMEOUT_SEC',
        'MOE_CODEX_SANDBOX', 'MOE_CODEX_REASONING_EFFORT', 'MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC')
    'launch-failure prose' = @('run the printed Command by hand', 'a CLI auto-update dropped a flag the wrapper passes')
    'baseline / index' = @('#moe-baseline v1', 'moe/baseline', ':(literal)', '--porcelain=v1 -z --untracked-files=all --no-renames', 'hash-object --stdin-paths', 'update-index --no-assume-unchanged --no-skip-worktree -z --stdin')
    'RPC tools' = @('get_commit_scope', 'record_commit', 'record_candidate', 'record_check_run', 'finalize_attempt')
    'candidate evidence fields' = @('attemptId', 'generation', 'candidateId', 'treeSha', 'runnerId', 'runner-observed')
    # The landing outcomes finalize_attempt carries: both wrappers map every exit
    # (the interrupted one included) onto the same words. 'failed' is too common a
    # word to be a needle; the teardown-no-baseline arm proves it on both engines.
    'finalize outcomes' = @('landed', 'nothing-to-commit', 'rescued')
    'context fields' = @('isEpicFinal')
    'blocked-hold prose' = @('only resource-lease waits and third-party blocks hold a seat now')
    # Attempt finalize ladder, candidate-evidence and gate-cleanup prose.
    'attempt/gate prose' = @('[finalize] no finalizing attempt for this seat on task', 'has no pinned identity; not acknowledging.', 'finalize_attempt acknowledgement exhausted; stopping new-task loop', 'qualityGate not run: candidate evidence unavailable', 'Cannot remove owned qualityGate workspace', 'cleanup will be retried',
        'Attempt identity unavailable:', 'Missing/stale attempt identity; candidate completion will fail closed.')
    # Agent-CLI parity: every CLI the launchers support is wired the same way in
    # both wrappers - its config dir is a DENY-tier attribution prefix, its
    # cliType literal exists, and its mode/config banners are grep-stable.
    'cli config dirs' = @('.codex/', '.gemini/', '.grok/')
    'cli types' = @('"grok"', '"codex"')
    # Codex headless launch vocabulary: the sandbox modes MOE_CODEX_SANDBOX
    # accepts and the fallback warning, spelled identically.
    'codex vocabulary' = @('read-only', 'workspace-write', 'danger-full-access', 'approvals_reviewer=user', 'MOE_CLI_ARGV_REJECTED', 'MOE_DISABLE_ARGV_PROBE', 'is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access.', 'default_tools_approval_mode = "approve"', "rejects the wrapper's launch argv")
    'cli banners' = @('Grok MCP config written to:', 'Grok mode: headless', 'Grok mode: interactive', 'Grok folder trust granted:', 'trusted_folders.toml', 'moe__moe_<name>', 'tool_timeouts = { moe_wait_for_task = 720, moe_chat_wait = 720, moe_wait_for_resource = 720 }')
    # Delivery receipts: the journal, the receipt call, its crash replay, the push
    # result it reports and the reused-gate line, spelled identically in both.
    'delivery receipt' = @('moe/receipt', '[receipt]', 'record_delivery_receipt', 'DELIVERY_RECEIPT_CONFLICT', 'targetBefore', 'targetAfter', 'landedRevision', 'pushResult', 'Moe-Kind: completion')
    'delivery receipt prose' = @('delivery receipt not recorded for candidate', 'for the next pre-flight to replay.', 'already has a delivery receipt that differs from this report; keeping the recorded one, not retrying.', 'a crash before the receipt would leave this landing without one.', 'replaying the delivery receipt of task', 'that landing never moved the ref; dropping', 'kept: malformed journal', 'is still finalizing after its replayed receipt; its finalizing holds stay until it closes.', 'recording the owed ledger row of task', 'did not record the owed ledger row', 'a pull --rebase rewrote', 'push result unknown: the landing stopped before its push finished', 'no git remote configured; push skipped, the commit stays local on', 'push failed: ', 'git push failed', 'qualityGate result reused: the rebuilt candidate has the same tree and base.')
    # Runner identity and reattach: the identity line and its warning, the reattach
    # call and its three outcomes, and the heartbeat's other reasons, spelled
    # identically in both.
    'runner reattach' = @('reattach_attempt', 'processStartedAt', 'attempt-reconciling', 'reattachRequired', '[reattach]')
    'runner reattach prose' = @('Runner identity: processStartedAt=', 'Runner identity unavailable (', 'claims carry no processStartedAt/host, so this seat cannot reattach after a daemon restart.', 'is running again after a daemon restart.', 'moe.reattach_attempt refused for attempt', '; not retrying it.', 'moe.reattach_attempt got no answer for attempt', '; retrying later.', 'heartbeat asks for reattachment (', 'but this wrapper pinned no such reconciling attempt; nothing to reattach.')
    # Hot reload: the restart announcement an operator sees and the deregister
    # reason both postflight hot-reload cases assert, spelled identically in both.
    'hot reload' = @('wrapper source changed on disk; restarting to load it', 'wrapper_restart')
    'claimed prompt contract' = @('the wrapper will pick up the next task in a fresh session', 'INTERACTIVE session: this TUI stays open after you stop')
    # Serena TOOL-tier tools: the editing calls whose successful result is TOOL
    # evidence (old names kept for older Serena installs), and the
    # replace_in_files summary header both wrappers parse.
    'Serena TOOL-tier tools' = @('replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'create_text_file', 'replace_regex',
        'replace_content', 'replace_in_files', 'rename_symbol', 'safe_delete_symbol', 'delete_lines', 'replace_lines', 'insert_at_line', 'occurrence(s) in')
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

# 4. Flags the installed CLIs no longer accept must not come back in either
#    wrapper (comment lines exempt): codex-cli 0.147+ rejects `--full-auto`
#    with exit 2 before any work, and the launch-failure backoff then
#    relaunches forever.
$ps1Code = @(Get-Content -LiteralPath $ps1Path | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
$shCode = @(Get-Content -LiteralPath $shPath | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
foreach ($gone in @('--full-auto')) {
    if ($ps1Code.IndexOf($gone, [System.StringComparison]::Ordinal) -ge 0) { $failures.Add("removed codex flag '$gone' is still passed by moe-agent.ps1") }
    if ($shCode.IndexOf($gone, [System.StringComparison]::Ordinal) -ge 0) { $failures.Add("removed codex flag '$gone' is still passed by moe-agent.sh") }
}

if ($failures.Count -gt 0) {
    Write-Host "FAIL parity-check.ps1: $($failures.Count) asymmetry(ies) between moe-agent.ps1 and moe-agent.sh"
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}
Write-Host 'PASS parity-check.ps1'
exit 0

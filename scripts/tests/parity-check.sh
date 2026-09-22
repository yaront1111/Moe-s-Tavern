#!/usr/bin/env bash
# parity-check.sh -- the two agent wrappers (scripts/moe-agent.sh and
# scripts/moe-agent.ps1) must stay in lock-step on every operator-visible
# string of the land-on-every-exit machinery: reason codes, chat prefixes, log
# prefixes, settings keys and env names. An operator grepping either
# transcript, a governor triaging chat, or the daemon parsing a record must
# find the same spelling regardless of which wrapper ran. This greps both files
# for the full vocabulary and fails on ANY asymmetry (a code present in one
# wrapper and absent from the other, or a fixed-list item missing from either).
# Twin: scripts/tests/parity-check.ps1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH="$ROOT_DIR/scripts/moe-agent.sh"
PS1="$ROOT_DIR/scripts/moe-agent.ps1"
[ -f "$SH" ] || { echo "missing $SH" >&2; exit 1; }
[ -f "$PS1" ] || { echo "missing $PS1" >&2; exit 1; }

failures=0
fail() { echo "PARITY FAIL: $*" >&2; failures=$((failures + 1)); }

# ---- 1. Code families: extract the full set from each file, diff them. -------
# Word-bounded so MOE_COMMIT_FAILED is not satisfied by MOE_COMMIT_FAILED_REF_CONTENTION.
# The sh wrapper's internal env-plumbing names that share a prefix (bash ->
# inline-python bridging from an earlier revision) are exempt from the symmetry
# rule — same allowlist as parity-check.ps1; the operator-facing vocabulary is
# fully compared.
INTERNAL_PLUMBING='^(MOE_ATTR_UNDECLARED|MOE_ATTR_EXCLUDE|MOE_ATTR_POLICY_OVERRIDE|MOE_COMMIT_BOARD_STATE)$'
extract_codes() { # $1 = file, $2 = prefix regex
  grep -oE "\b$2[A-Z0-9_]*\b" "$1" 2>/dev/null | grep -vE "$INTERNAL_PLUMBING" | sort -u || true
}
for prefix in 'MOE_COMMIT_' 'MOE_ATTR_' 'MOE_CHECKPOINT_' 'MOE_ATTRIBUTION_'; do
  sh_set="$(extract_codes "$SH" "$prefix")"
  ps_set="$(extract_codes "$PS1" "$prefix")"
  only_sh="$(comm -23 <(printf '%s\n' "$sh_set") <(printf '%s\n' "$ps_set") | sed '/^$/d' || true)"
  only_ps="$(comm -13 <(printf '%s\n' "$sh_set") <(printf '%s\n' "$ps_set") | sed '/^$/d' || true)"
  [ -z "$only_sh" ] || fail "$prefix* codes only in moe-agent.sh: $(echo "$only_sh" | tr '\n' ' ')"
  [ -z "$only_ps" ] || fail "$prefix* codes only in moe-agent.ps1: $(echo "$only_ps" | tr '\n' ' ')"
  [ -n "$sh_set" ] || fail "no $prefix* codes found in moe-agent.sh at all"
done

# ---- 2. Fixed vocabulary: every item must appear in BOTH files. --------------
require_both() { # $1 = label, $2 = literal string
  local label="$1" needle="$2" in_sh=0 in_ps=0
  grep -Fq -- "$needle" "$SH" && in_sh=1
  grep -Fq -- "$needle" "$PS1" && in_ps=1
  if [ "$in_sh" -ne 1 ] || [ "$in_ps" -ne 1 ]; then
    fail "$label '$needle' missing from: $([ "$in_sh" -eq 1 ] || printf 'moe-agent.sh ')$([ "$in_ps" -eq 1 ] || printf 'moe-agent.ps1')"
  fi
}

# Reason / outcome codes named by the design (spelled identically in both).
for code in \
  MOE_COMMIT_REFUSED_NO_OWNED_PATHS MOE_COMMIT_REFUSED_OWNED_PATH_MISSING MOE_COMMIT_NOTHING_TO_COMMIT \
  MOE_COMMIT_FAILED_REF_CONTENTION MOE_COMMIT_INDEX_REFRESH_FAILED \
  MOE_ATTR_EXCLUDED MOE_ATTR_CONTESTED MOE_ATTR_PEER_DECLARED MOE_ATTR_PREEXISTING MOE_ATTR_MISSING MOE_ATTR_CONCURRENT \
  MOE_CHECKPOINT_RECOVERED MOE_RESCUE_REF MOE_ATTRIBUTION_UNRESOLVED; do
  require_both "code" "$code"
done

# Chat prefixes (daemon-visible lines a governor triages on). The gate-failure
# line carries the marker in both wrappers (the status-lookup line in neither).
for chat in '🚫 PUSH-BLOCKED:' 'PUSH FAILED' 'CHECKPOINT-UNPUSHED' 'MOE_RESCUE_REF task='; do
  require_both "chat prefix" "$chat"
done

# Claimed-prompt contract: one task per CLI session in both wrappers, and an
# interactive TUI (which never exits on its own) is told to hand control back.
for prompt in 'the wrapper will pick up the next task in a fresh session'   'INTERACTIVE session: this TUI stays open after you stop'; do
  require_both "claimed prompt contract" "$prompt"
done

# Log prefixes.
for log in '[attribution]' '[skip]' '[rescue]' '[branch]'; do
  require_both "log prefix" "$log"
done

# Grep-stable commit-message vocabulary.
for msg in 'Moe-Task:' 'Moe-Kind:' 'Moe-Session:' 'Moe-Status:' 'Moe-Paths:' 'Moe-Inferred:' 'Moe-Contested:' 'Moe-Reason:' \
  'Completed via Moe worker session.' 'not a completion.' 'Checkpoint via Moe' 'Rescue snapshot via Moe' \
  'refs/moe/rescue/' 'retry after qa_reject #' 'wip(' 'rescue('; do
  require_both "commit vocabulary" "$msg"
done

# Baseline / temp-index plumbing (identical file formats and git invocations).
for lit in '#moe-baseline v1' 'moe/baseline' ':(literal)' \
  '--porcelain=v1 -z --untracked-files=all --no-renames' 'hash-object --stdin-paths' \
  'update-index --no-assume-unchanged --no-skip-worktree -z --stdin'; do
  require_both "baseline/index" "$lit"
done

# Settings keys read from project.json.
for key in autoCommit checkpointCommits checkpointPush commitBoardState commitHooks attribution undeclared contested exclude \
  qualityGate qualityGateScope consolidationBranch; do
  require_both "settings key" "$key"
done

# Env names.
for env_name in GIT_TERMINAL_PROMPT MOE_DISABLE_CHECKPOINT MOE_ATTRIBUTION MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF \
  MOE_DISABLE_QUALITY_GATE MOE_RESUME_MAX_ATTEMPTS \
  MOE_CODEX_SANDBOX MOE_CODEX_REASONING_EFFORT MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC; do
  require_both "env name" "$env_name"
done

# Launch-failure prose (the operator reads the same diagnosis from either wrapper).
for prose in 'run the printed Command by hand' 'a CLI auto-update dropped a flag the wrapper passes'; do
  require_both "launch-failure prose" "$prose"
done

# Agent-CLI vocabulary (claude / codex / gemini / grok): the per-CLI config
# dirs (also the attribution DENY prefixes), the grok cliType value, the grok
# env names and the grok banners must be spelled identically in both wrappers.
for cfg_dir in '.codex/' '.gemini/' '.grok/'; do
  require_both "cli config dir" "$cfg_dir"
done
for cli_type in '"grok"' '"codex"'; do
  require_both "cli type" "$cli_type"
done
# Codex headless launch vocabulary: the sandbox modes MOE_CODEX_SANDBOX accepts
# and the fallback warning, spelled identically.
for codex_lit in 'read-only' 'workspace-write' 'danger-full-access' 'approvals_reviewer=user' MOE_CLI_ARGV_REJECTED MOE_DISABLE_ARGV_PROBE \
  'is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access.' \
  'default_tools_approval_mode = "approve"' \
  'rejects the wrapper'"'"'s launch argv'; do
  require_both "codex vocabulary" "$codex_lit"
done
# Flags the installed CLIs no longer accept must not come back in either
# wrapper (comment lines exempt): codex-cli 0.147+ rejects `--full-auto` with
# exit 2 before any work, and the launch-failure backoff then relaunches forever.
# Count instead of `grep -q`: under `pipefail` a -q reader exits on the first
# match while the comment-stripping grep is still writing ~250 KB, the writer
# dies with SIGPIPE (141), the pipeline status is 141 and the `if` is silently
# false -- the guard would pass in exactly the case it exists for (measured
# 0/40 detections for an injection at line 300 of either wrapper).
count_code_hits() { # $1 = file, $2 = literal
  grep -vE '^[[:space:]]*#' "$1" | grep -Fc -- "$2" || true
}
for gone in '--full-auto'; do
  sh_hits="$(count_code_hits "$SH" "$gone")"
  ps_hits="$(count_code_hits "$PS1" "$gone")"
  [ "${sh_hits:-0}" -eq 0 ] || fail "removed codex flag '$gone' is still passed by moe-agent.sh ($sh_hits non-comment line(s))"
  [ "${ps_hits:-0}" -eq 0 ] || fail "removed codex flag '$gone' is still passed by moe-agent.ps1 ($ps_hits non-comment line(s))"
done
for env_name in MOE_GROK_MODEL MOE_GROK_EFFORT MOE_GROK_MCP_STARTUP_TIMEOUT_SEC \
  GROK_CLAUDE_MCPS_ENABLED GROK_CURSOR_MCPS_ENABLED GROK_DISABLE_AUTOUPDATER MOE_TOOL_NAME_STYLE \
  MOE_GROK_MCP_TOOL_TIMEOUT_SEC; do
  require_both "env name" "$env_name"
done
for banner in 'Grok MCP config written to:' 'Grok mode: headless' 'Grok mode: interactive' \
  'Grok folder trust granted:' 'trusted_folders.toml' 'moe__moe_<name>' \
  'tool_timeouts = { moe_wait_for_task = 720, moe_chat_wait = 720, moe_wait_for_resource = 720 }'; do
  require_both "grok banner" "$banner"
done

# MCP tools the wrappers call for the ledger.
for tool in get_commit_scope record_commit record_candidate record_check_run finalize_attempt; do
  require_both "RPC tool" "$tool"
done

for field in attemptId generation candidateId treeSha runnerId runner-observed; do
  require_both "candidate evidence field" "$field"
done

# The landing outcomes finalize_attempt carries: both wrappers map every exit
# (the interrupted one included) onto the same words. 'failed' is too common a
# word to be a needle; the teardown-no-baseline arm proves it on both engines.
for outcome in landed nothing-to-commit rescued; do
  require_both "finalize outcome" "$outcome"
done

# Daemon get_context fields both wrappers must consume identically (the
# daemon-computed epic-final preferred over the list_tasks fallback).
for fld in isEpicFinal; do
  require_both "context field" "$fld"
done

# BLOCKED-hold prose: with daemon seat-freeing only resource blocks hold a
# seat; both wrappers must state it in the same words.
for prose in 'only resource-lease waits and third-party blocks hold a seat now'; do
  require_both "blocked-hold prose" "$prose"
done

# Attempt finalize ladder, candidate-evidence and gate-cleanup prose: an operator
# reading either transcript must see the same diagnosis for the same state.
for prose in '[finalize] no finalizing attempt for this seat on task' 'has no pinned identity; not acknowledging.'   'finalize_attempt acknowledgement exhausted; stopping new-task loop' 'qualityGate not run: candidate evidence unavailable'   'Cannot remove owned qualityGate workspace' 'cleanup will be retried'   'Attempt identity unavailable:' 'Missing/stale attempt identity; candidate completion will fail closed.' 'uses the sha256 object format; Moe'; do
  require_both "attempt/gate prose" "$prose"
done

# Delivery receipts: the journal, the receipt call, its crash replay, the push
# result it reports and the reused-gate line, spelled identically in both.
for lit in 'moe/receipt' '[receipt]' record_delivery_receipt DELIVERY_RECEIPT_CONFLICT targetBefore targetAfter landedRevision pushResult 'Moe-Kind: completion'; do
  require_both "delivery receipt" "$lit"
done
for prose in 'delivery receipt not recorded for candidate' 'for the next pre-flight to replay.' 'already has a delivery receipt that differs from this report; keeping the recorded one, not retrying.' 'a crash before the receipt would leave this landing without one.' 'replaying the delivery receipt of task' 'that landing never moved the ref; dropping' 'kept: malformed journal' 'is still finalizing after its replayed receipt; its finalizing holds stay until it closes.' 'recording the owed ledger row of task' 'did not record the owed ledger row' 'a pull --rebase rewrote' 'push result unknown: the landing stopped before its push finished' 'no git remote configured; push skipped, the commit stays local on' 'push failed: ' 'git push failed' 'qualityGate result reused: the rebuilt candidate has the same tree and base.'; do
  require_both "delivery receipt prose" "$prose"
done

# Runner identity and reattach: the identity line and its warning, the reattach
# call and its three outcomes, and the heartbeat's other reasons, spelled
# identically in both.
for lit in reattach_attempt processStartedAt attempt-reconciling reattachRequired '[reattach]'; do
  require_both "runner reattach" "$lit"
done
for prose in 'Runner identity: processStartedAt=' 'Runner identity unavailable (' 'claims carry no processStartedAt/host, so this seat cannot reattach after a daemon restart.' 'is running again after a daemon restart.' 'moe.reattach_attempt refused for attempt' '; not retrying it.' 'moe.reattach_attempt got no answer for attempt' '; retrying later.' 'heartbeat asks for reattachment (' 'but this wrapper pinned no such reconciling attempt; nothing to reattach.'; do
  require_both "runner reattach prose" "$prose"
done

# Hot reload: the restart announcement an operator sees and the deregister
# reason both postflight hot-reload cases assert, spelled identically in both.
for lit in 'wrapper source changed on disk; restarting to load it' wrapper_restart; do
  require_both "hot reload" "$lit"
done

# Serena TOOL-tier tools: the editing calls whose successful result is TOOL
# evidence (old names kept for older Serena installs), and the replace_in_files
# summary header both wrappers parse.
for tool in replace_symbol_body insert_after_symbol insert_before_symbol create_text_file replace_regex \
  replace_content replace_in_files rename_symbol safe_delete_symbol delete_lines replace_lines insert_at_line \
  'occurrence(s) in'; do
  require_both "Serena TOOL-tier tools" "$tool"
done

# Per-role claude default models must match (a one-sided edit once left the sh
# worker/qa seats on the old model while the ps1 moved on).
for role in architect worker qa governor; do
  sh_model="$(tr -d '\r' < "$SH" | sed -nE "s/^[[:space:]]+$role\)[[:space:]]+RESOLVED_MODEL=\"([^\"]+)\".*/\1/p")"
  ps_model="$(tr -d '\r' < "$PS1" | sed -nE "s/^[[:space:]]+$role[[:space:]]+= \"([^\"]+)\"\$/\1/p")"
  if [ -z "$sh_model" ] || [ "$sh_model" != "$ps_model" ]; then
    fail "default $role model differs: moe-agent.sh '$sh_model' vs moe-agent.ps1 '$ps_model'"
  fi
done

# Deferred features must not be advertised by either wrapper.
for deferred in recoverOrphanBaselines parkUnassignedBlocked; do
  if grep -Fq -- "$deferred" "$SH"; then fail "deferred setting '$deferred' is referenced by moe-agent.sh"; fi
  if grep -Fq -- "$deferred" "$PS1"; then fail "deferred setting '$deferred' is referenced by moe-agent.ps1"; fi
done

if [ "$failures" -ne 0 ]; then
  echo "FAIL parity-check.sh: $failures asymmetr$([ "$failures" -eq 1 ] && echo y || echo ies) between moe-agent.sh and moe-agent.ps1" >&2
  exit 1
fi
echo "PASS parity-check.sh"

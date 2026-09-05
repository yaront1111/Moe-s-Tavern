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

# Chat prefixes (daemon-visible lines a governor triages on).
for chat in 'PUSH-BLOCKED:' 'PUSH FAILED' 'CHECKPOINT-UNPUSHED' 'MOE_RESCUE_REF task='; do
  require_both "chat prefix" "$chat"
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
  '--porcelain=v1 -z --untracked-files=all --no-renames' 'hash-object --stdin-paths'; do
  require_both "baseline/index" "$lit"
done

# Settings keys read from project.json.
for key in autoCommit checkpointCommits checkpointPush commitBoardState commitHooks attribution undeclared contested exclude \
  qualityGate qualityGateScope consolidationBranch; do
  require_both "settings key" "$key"
done

# Env names.
for env_name in GIT_TERMINAL_PROMPT MOE_DISABLE_CHECKPOINT MOE_ATTRIBUTION MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF \
  MOE_DISABLE_QUALITY_GATE MOE_RESUME_MAX_ATTEMPTS; do
  require_both "env name" "$env_name"
done

# Agent-CLI vocabulary (claude / codex / gemini / grok): the per-CLI config
# dirs (also the attribution DENY prefixes), the grok cliType value, the grok
# env names and the grok banners must be spelled identically in both wrappers.
for cfg_dir in '.codex/' '.gemini/' '.grok/'; do
  require_both "cli config dir" "$cfg_dir"
done
for cli_type in '"grok"'; do
  require_both "cli type" "$cli_type"
done
for env_name in MOE_GROK_MODEL MOE_GROK_EFFORT MOE_GROK_MCP_STARTUP_TIMEOUT_SEC \
  GROK_CLAUDE_MCPS_ENABLED GROK_CURSOR_MCPS_ENABLED GROK_DISABLE_AUTOUPDATER MOE_TOOL_NAME_STYLE; do
  require_both "env name" "$env_name"
done
for banner in 'Grok MCP config written to:' 'Grok mode: headless' 'Grok mode: interactive' \
  'Grok folder trust granted:' 'trusted_folders.toml' 'moe__moe_<name>'; do
  require_both "grok banner" "$banner"
done

# MCP tools the wrappers call for the ledger.
for tool in get_commit_scope record_commit; do
  require_both "RPC tool" "$tool"
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

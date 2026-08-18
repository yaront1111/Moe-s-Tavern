#!/usr/bin/env bash
# Routed-@mention delivery provenance harness (bash twin).
#
# Assembles a REAL session context with scripts/moe-agent.sh in a disposable
# throwaway project -- never a live board, because a provenance test that writes
# into real channels reproduces the defect under test -- and asserts that every
# body delivered in <routed_mentions> is byte-identical to the record stored in
# .moe/messages/<channel>.jsonl.
#
# Cases, assertions and the independent store read all live in
# mention-provenance-seed.py so this twin and the PowerShell twin cannot drift.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/moe-agent.sh"
SEED_PY="$ROOT_DIR/scripts/tests/mention-provenance-seed.py"
FAKE_PROXY="$ROOT_DIR/scripts/tests/mention-provenance-proxy.js"
CHANNEL="chan-provenance"
WORKER_ID="worker-provenance"

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t moe-mention)"
cleanup() {
  if [ -n "${MOE_PROVENANCE_KEEP:-}" ]; then
    echo "[keep] $TMP_DIR"
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP mention-provenance.sh: timeout command is not available"
  exit 0
fi
PY="$(command -v python3 2>/dev/null || true)"
if [ -z "$PY" ]; then
  case "$(python --version 2>&1)" in
    "Python 3."*) PY="$(command -v python)" ;;
    *) echo "SKIP mention-provenance.sh: python 3 is not available"; exit 0 ;;
  esac
fi
NODE_BIN="${MOE_NODE_COMMAND:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" --version >/dev/null 2>&1; then
  echo "SKIP mention-provenance.sh: runnable node is not available"
  exit 0
fi
# The wrapper calls bare `node`; shim it so an explicit MOE_NODE_COMMAND wins.
mkdir -p "$TMP_DIR/bin"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$NODE_BIN" > "$TMP_DIR/bin/node"
chmod +x "$TMP_DIR/bin/node"
# find_python() probes `python3 --version` first and otherwise falls back to the
# PEP 397 launcher string "py -3" -- which the wrapper then invokes QUOTED, as a
# single word, so it dies with "py -3: command not found". On such a box the
# mention extraction fails on every session. Pin a runnable python3 so the
# provenance modes measure delivery rather than that unrelated breakage; the
# failure modes below then reproduce a broken extraction deliberately.
#
# The same shim can fail exactly ONE of the wrapper's two python calls on
# the mention path, so each silent-drop closure is exercised on its own:
#   MOE_PROVENANCE_FAIL=extract -> the extraction itself dies (sh:2045, the
#     `2>/dev/null || true` swallow that turned a failure into an empty block).
#   MOE_PROVENANCE_FAIL=count   -> extraction succeeds but the count parse dies
#     (sh:2086, the `|| echo 0` that read an unparseable count as "no mentions"
#     and additionally made the wrapper skip the CLI launch entirely).
# Each discriminator is the call's exact argv shape. The wrapper also feeds
# MCP-config scripts on stdin as `- <7 more args>`; failing those would kill
# startup long before any mention is assembled.
cat > "$TMP_DIR/bin/python3" <<FAILEOF
#!/usr/bin/env bash
case "\${MOE_PROVENANCE_FAIL:-}" in
  extract)
    if [ "\$1" = "-" ] && [ "\$#" -eq 3 ] && [ "\$2" = "$WORKER_ID" ]; then
      echo "provenance: forced extraction failure" >&2
      exit 1
    fi
    ;;
  count)
    if [ "\$1" = "-c" ] && [[ "\$2" == *"get('count'"* ]]; then
      echo "provenance: forced count-parse failure" >&2
      exit 1
    fi
    ;;
esac
exec "$PY" "\$@"
FAILEOF
chmod +x "$TMP_DIR/bin/python3"

PROJECT_DIR="$TMP_DIR/project"
HOME_DIR="$TMP_DIR/home"
mkdir -p "$PROJECT_DIR/.moe/messages" "$HOME_DIR"
printf '{"id":"proj-provenance","name":"provenance","settings":{"autoCommit":false}}\n' \
  > "$PROJECT_DIR/.moe/project.json"

CASE_COUNT="$("$PY" "$SEED_PY" seed "$PROJECT_DIR" "$CHANNEL" "$WORKER_ID")"
if [ "${CASE_COUNT:-0}" -lt 8 ]; then
  echo "Seed produced $CASE_COUNT cases; a sweep that generates nothing must not pass" >&2
  exit 1
fi
echo "[seed] $CASE_COUNT stored cases + 2 synthetic delivery-failure cases"

# Capture stands in for the CLI. The assembled context reaches the CLI either as
# the last argv element or, when Windows' command-line cap forces the overflow
# path, inside the --append-system-prompt-file file. Capture BOTH: reading only
# argv would silently miss the exact path that carries a worker's real prompt.
CAPTURE_CMD="$TMP_DIR/bin/claude"
cat > "$CAPTURE_CMD" <<'CAPEOF'
#!/usr/bin/env bash
out="$MOE_PROVENANCE_CAPTURE"
: > "$out"
prev=""
for a in "$@"; do
  printf '%s\n' "$a" >> "$out"
  if [ "$prev" = "--append-system-prompt-file" ] && [ -f "$a" ]; then
    cat "$a" >> "$out"
    printf '\n' >> "$out"
  fi
  prev="$a"
done
exit 0
CAPEOF
chmod +x "$CAPTURE_CMD"

run_mode() {
  local mode="$1"
  local capture="$TMP_DIR/capture-$mode.txt"
  local wrapper_out="$TMP_DIR/wrapper-$mode.out"
  # Re-seed per mode: the wrapper's post-flight appends its own session-ended
  # message to the same #general jsonl, so a second run would otherwise read a
  # fixture the first run had already grown.
  "$PY" "$SEED_PY" seed "$PROJECT_DIR" "$CHANNEL" "$WORKER_ID" >/dev/null
  local fail_kind=""
  case "$mode" in
    extractfail) fail_kind="extract" ;;
    countfail)   fail_kind="count" ;;
  esac
  set +e
  PATH="$TMP_DIR/bin:$PATH" \
  HOME="$HOME_DIR" \
  MOE_PROXY_PATH="$FAKE_PROXY" \
  MOE_PROVENANCE_MODE="$mode" \
  MOE_PROVENANCE_WORKER="$WORKER_ID" \
  MOE_PROVENANCE_CHANNEL="$CHANNEL" \
  MOE_PROVENANCE_CAPTURE="$capture" \
  MOE_PROVENANCE_FAIL="$fail_kind" \
  timeout 60s "$WRAPPER" \
    --project "$PROJECT_DIR" \
    --worker-id "$WORKER_ID" \
    --role worker \
    --no-start-daemon \
    --command "$CAPTURE_CMD" \
    --loop \
    --poll-interval 0 \
    >"$wrapper_out" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    tail -n 40 "$wrapper_out" >&2 || true
    echo "FAIL mode=$mode: wrapper exited $rc" >&2
    return 1
  fi
  if [ ! -s "$capture" ]; then
    tail -n 40 "$wrapper_out" >&2 || true
    echo "FAIL mode=$mode: CLI was never launched, nothing captured" >&2
    return 1
  fi
  local expect_reason=""
  case "$mode" in
    extractfail) expect_reason="MOE_MENTION_EXTRACTION_FAILED" ;;
    countfail)   expect_reason="MOE_MENTION_COUNT_UNPARSEABLE" ;;
  esac
  set +e
  if [ -n "$expect_reason" ]; then
    "$PY" "$SEED_PY" verify-marker-only "$PROJECT_DIR" "$CHANNEL" "$capture" "$expect_reason"
  else
    "$PY" "$SEED_PY" verify "$PROJECT_DIR" "$CHANNEL" "$capture" "$mode"
  fi
  local vrc=$?
  set -e
  return $vrc
}

status=0
# faithful: the RPC carries the true bodies, truncated at maxContentChars like
# the real chat_read. substitute: the RPC carries the impersonation payload,
# reproducing the reported defect while the store stays correct. extractfail /
# countfail: each of the two silent-drop paths dies in turn, and each must
# surface its OWN reason code rather than an empty block.
for mode in faithful substitute extractfail countfail; do
  echo "== mode=$mode =="
  if ! run_mode "$mode"; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "mention-provenance.sh FAILED"
  exit 1
fi
echo "mention-provenance.sh PASSED ($CASE_COUNT stored cases + 2 synthetic delivery-failure cases, 4 modes)"

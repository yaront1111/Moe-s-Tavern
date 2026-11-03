#!/usr/bin/env bash
# CQ-M07m1: the verified-local route gate of scripts/moe-agent.sh. A worker or QA
# iteration reads moe.get_execution_readiness once, before any claim. Only a
# well-formed verified-local reply refuses (MOE_VERIFIED_LOCAL_*, exit 1, no
# claim, no CLI); every other answer keeps today's launch unchanged. Run by
# postflight.sh, or alone: bash scripts/tests/postflight-vm-route.sh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/moe-agent.sh"
POSTFLIGHT_TIMEOUT_SEC=60
case "${MOE_POSTFLIGHT_TIMEOUT_SEC:-}" in ''|*[!0-9]*) : ;; *) POSTFLIGHT_TIMEOUT_SEC="$MOE_POSTFLIGHT_TIMEOUT_SEC" ;; esac
NODE="${MOE_NODE_COMMAND:-$(command -v node 2>/dev/null || true)}"
# A seat's own MOE_WORKER_ID, MOE_SESSION_ID and the rest leak into nested wrappers.
for v in $(compgen -e); do case "$v" in MOE_*|FAKE_*|CLAUDE*) unset "$v" ;; esac; done
export MOE_ACCOUNT_ROTATION=off
# From a task worktree the wrapper copy refuses without this seam (postflight.sh sets it too).
export MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER=1

if ! command -v timeout >/dev/null 2>&1; then echo "SKIP postflight-vm-route.sh: timeout command is not available"; exit 0; fi
if [ -z "$NODE" ] || ! "$NODE" --version >/dev/null 2>&1; then echo "SKIP postflight-vm-route.sh: runnable node is not available in this shell"; exit 0; fi
# postflight.sh's python check, so this file never SKIPs inside it.
if ! command -v python3 >/dev/null 2>&1; then
  case "$(python --version 2>&1)" in "Python 3."*) : ;; *) echo "SKIP postflight-vm-route.sh: python 3 is not available in this shell"; exit 0 ;; esac
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t moe-vm-route)"
trap 'rm -rf "$TMP_DIR"' EXIT
BIN="$TMP_DIR/bin"; SHIM="$TMP_DIR/shim"; PROJECT="$TMP_DIR/project"; RUN_TMP="$TMP_DIR/tmp"
REC="$TMP_DIR/cli-record.json"; CALLS="$TMP_DIR/calls.jsonl"; OUT="$TMP_DIR/wrapper.out"
FAKE_PROXY="$TMP_DIR/fake-proxy.js"
mkdir -p "$BIN" "$SHIM"
cp "$ROOT_DIR/scripts/tests/postflight-fake-proxy.js" "$FAKE_PROXY"
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$NODE" > "$SHIM/node"
printf '%s\n' "require('fs').appendFileSync('$TMP_DIR/daemon-ran','ran\\n');process.exit(1);" > "$TMP_DIR/fake-daemon.js"
# Each fake CLI writes {cli, argv, cwd, env} to the one record file baked in here.
for cli in claude codex gemini grok; do
  printf '#!/usr/bin/env bash\nexec %q -e %q %q %q "$@"\n' "$NODE" \
    'const [rec,cli,...argv]=process.argv.slice(1);require("fs").writeFileSync(rec,JSON.stringify({cli,argv,cwd:process.cwd(),env:process.env}));' \
    "$REC" "$cli" > "$BIN/$cli"
  chmod +x "$BIN/$cli"
done
chmod +x "$SHIM/node"

# vmr_run ROW ROLE CLI READINESS WTMODE SEAM [VAR=VALUE...]. READINESS and SEAM
# '-' leave FAKE_READINESS and MOE_POSTFLIGHT_WSL unset. WTMODE: on, off, '-'
# (no key), gate (no key, a non-blank qualityGate) or a raw JSON value. A set
# VMR_CMD replaces the absolute fake CLI path for this one run (P1's bare name).
VMR_CMD=""
vmr_run() {
  local row="$1" role="$2" cli="$3" readiness="$4" wt="$5" seam="$6" settings='"autoCommit":false'; shift 6
  case "$wt" in -) ;; gate) settings="$settings,\"qualityGate\":\"true\"" ;; on|off) settings="$settings,\"worktreeMode\":\"$wt\"" ;; *) settings="$settings,\"worktreeMode\":$wt" ;; esac
  rm -rf "$PROJECT" "$RUN_TMP" "$TMP_DIR/home" "$REC" "$CALLS" "$TMP_DIR/daemon-ran"
  mkdir -p "$PROJECT/.moe/messages" "$RUN_TMP" "$TMP_DIR/home"
  printf '{"id":"proj-vmr","name":"postflight-vm-route","settings":{%s}}\n' "$settings" > "$PROJECT/.moe/project.json"
  : > "$PROJECT/.moe/messages/chan-general.jsonl"
  printf '{"port":9876,"projectPath":"%s"}\n' "$PROJECT" > "$PROJECT/.moe/daemon.json"
  VMR_ROW="$row"
  set +e
  (
    cd "$PROJECT" || exit 97
    [ "$readiness" = - ] || export FAKE_READINESS="$readiness"
    [ "$seam" = - ] || export MOE_POSTFLIGHT_WSL="$seam"
    env PATH="$BIN:$SHIM:$PATH" HOME="$TMP_DIR/home" TMPDIR="$RUN_TMP" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CALL_LOG="$CALLS" \
      MOE_DISABLE_HEARTBEAT=1 MOE_TASKLESS_WAIT_SEC=5 "$@" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" "$WRAPPER" \
      --project "$PROJECT" --worker-id "$role-vmr" --role "$role" --team Smoke --no-start-daemon \
      --command "${VMR_CMD:-$BIN/$cli}" --no-loop --poll-interval 0
  ) >"$OUT" 2>&1
  VMR_CODE=$?
  VMR_CMD=""
  set -e
}
vmr_fail() { cat "$OUT" >&2 || true; echo "VM ROUTE FAILED ($1): $2" >&2; exit 1; }
# The tools the fake proxy saw, one per line, in call order.
vmr_calls() { [ ! -f "$CALLS" ] || "$NODE" -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) if (l) console.log(JSON.parse(l).tool)' "$CALLS"; }

# vmr_launched ROW: today's path. Exit 0, no MOE_VERIFIED_LOCAL_ text, the CLI
# ran, and get_execution_readiness was read before the claim.
vmr_launched() {
  local calls
  [ "$VMR_CODE" -eq 0 ] || vmr_fail "$1" "exit $VMR_CODE, expected 0"
  ! grep -q MOE_VERIFIED_LOCAL_ "$OUT" || vmr_fail "$1" "today's path printed a MOE_VERIFIED_LOCAL_ line"
  [ -f "$REC" ] || vmr_fail "$1" "the CLI never ran"
  calls=" $(vmr_calls | tr '\n' ' ')"
  [[ "$calls" == *" claim_next_task "* && "${calls%%" claim_next_task "*} " == *" get_execution_readiness "* ]] \
    || vmr_fail "$1" "no get_execution_readiness before the claim:$calls"
}
# The CLI record with per-run values masked, never dropped (FAKE_READINESS, the
# varied input itself, is the one removed entry). The masks, exactly the values
# two legacy runs were measured to differ in:
#   the run's MOE_SESSION_ID value (<workerId>@<preflight-iso>) -> <session>
#   mktemp names directly under the fixed TMPDIR (system prompt dir) -> <tmp>
#   uuids (MOE_USAGE_CONTEXT_JSON launchId, the usage receipt file) -> <uuid>
vmr_normalized() {
  "$NODE" -e '
const [file, tmp] = process.argv.slice(1);
const rec = JSON.parse(require("fs").readFileSync(file, "utf8"));
delete rec.env.FAKE_READINESS;
const sid = rec.env.MOE_SESSION_ID || "\u0000";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mask = (s) => s.split(sid).join("<session>")
  .replace(new RegExp(esc(tmp) + "/[^/\\s\"\x27]+", "g"), tmp + "/<tmp>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
const walk = (v) => typeof v === "string" ? mask(v) : Array.isArray(v) ? v.map(walk)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])])) : v;
process.stdout.write(JSON.stringify(walk(rec), null, 1));
' "$REC" "$RUN_TMP"
}

echo "[vm route] today's path: every non-verified-local answer launches the same CLI"
LEGACY='{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
vmr_run T-legacy worker claude "$LEGACY" - -
vmr_launched T-legacy
vmr_normalized > "$TMP_DIR/T-base.json"
"$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(r.argv.some((a)=>a.includes("task-postflight"))&&r.env.MOE_WORKER_ID==="worker-vmr"?0:1)' "$REC" \
  || vmr_fail T-legacy "the CLI record does not name task-postflight and MOE_WORKER_ID=worker-vmr"
vmr_run T-legacy2 worker claude "$LEGACY" - -
vmr_launched T-legacy2
vmr_normalized > "$TMP_DIR/T-again.json"
diff -u "$TMP_DIR/T-base.json" "$TMP_DIR/T-again.json" >&2 || vmr_fail T-legacy2 "two legacy runs differ after masking: the mask list is short"
T_ROWS=(
  'observe|{"profile":"observe","ready":false,"missingCapabilities":["x"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
  'unreadable|{"profile":"unreadable","ready":false,"missingCapabilities":[],"evaluatedAt":null}'
  'refuse|refuse' 'unknown|unknown' 'fail|fail'
  'malformed-ready|{"profile":"verified-local","ready":"true","missingCapabilities":[]}'
  'malformed-string|"not an object"'
)
for t in "${T_ROWS[@]}"; do
  vmr_run "T-${t%%|*}" worker claude "${t#*|}" - -
  vmr_launched "T-${t%%|*}"
  vmr_normalized > "$TMP_DIR/T-${t%%|*}.json"
  diff -u "$TMP_DIR/T-base.json" "$TMP_DIR/T-${t%%|*}.json" >&2 || vmr_fail "T-${t%%|*}" "the CLI launch differs from legacy's"
done
echo "[vm route] ok today's path (legacy x2, observe, unreadable, refuse, unknown, fail, 2 malformed)"

# vmr_refused ROW CODE DETAIL: exit 1 with exactly one MOE_VERIFIED_LOCAL_ line,
# `[ERROR] CODE: DETAIL` byte for byte; one readiness read, followed only by the
# exit trap's deregister_worker (no claim, chat read or pending-questions read);
# and no CLI ran.
vmr_refused() {
  local row="$1" code="$2" detail="$3" calls before after c
  [ "$VMR_CODE" -eq 1 ] || vmr_fail "$row" "exit $VMR_CODE, expected 1"
  [ "$(grep -c MOE_VERIFIED_LOCAL_ "$OUT")" -eq 1 ] && grep -Fxq -- "[ERROR] $code: $detail" "$OUT" \
    || vmr_fail "$row" "not exactly one line '[ERROR] $code: $detail'"
  calls=" $(vmr_calls | tr '\n' ' ')"
  [ "$(vmr_calls | grep -cx get_execution_readiness)" -eq 1 ] || vmr_fail "$row" "not one readiness read:$calls"
  before="${calls%% get_execution_readiness *} "
  [[ "$before" != *" chat_"* && "$before" != *" get_pending_questions "* && "$before" != *" claim_next_task "* ]] \
    || vmr_fail "$row" "a chat read or claim ran before the readiness read:$calls"
  after="${calls#* get_execution_readiness }"
  [ -n "$after" ] || vmr_fail "$row" "no deregister_worker after the refusal:$calls"
  for c in $after; do [ "$c" = deregister_worker ] || vmr_fail "$row" "$c ran after the refusal:$calls"; done
  [ ! -e "$REC" ] || vmr_fail "$row" "the $(cat "$REC" | head -c 40) CLI ran"
}
VL='this project runs verified-local'
VL_FALSE='{"profile":"verified-local","ready":false,"missingCapabilities":["isolated-check-vm"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
VL_TRUE='{"profile":"verified-local","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
SHARED="$VL, whose worker and QA seats run only in worktree mode; settings.worktreeMode"
NOT_READY="$VL, which is not ready; missing:"
# Drift guard: S3 and S4 follow resolveWorktreeMode's unset default as landed
# (validators.ts, WT-19: 'on' only with a non-blank qualityGate). A changed
# resolver fails here until vm_route_worktree_mode mirrors it again.
VALIDATORS="$ROOT_DIR/packages/moe-daemon/src/state/validators.ts"
grep -Fq "if (mode !== undefined) return validateEnumValue(mode, 'worktreeMode', WORKTREE_MODES);" "$VALIDATORS" 2>/dev/null \
  && grep -Fq "const WORKTREE_MODES: readonly WorktreeMode[] = ['off', 'on'];" "$VALIDATORS" \
  || vmr_fail S3 "resolveWorktreeMode's stored-value rule moved in $VALIDATORS; re-mirror vm_route_worktree_mode"
DEFAULTS="$(sed -n "s/^  return typeof gate === 'string' && gate.trim() !== '' ? '\([a-z]*\)' : '\([a-z]*\)';\$/\1 \2/p" "$VALIDATORS")"
case "$DEFAULTS" in
  'on off') S3_ROW="S3|worker|claude|$VL_FALSE|-|0|MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED|$SHARED is unset, which resolves to 'off' while settings.qualityGate is blank; refusing to start this seat."
            S4_ROW="S4|worker|claude|$VL_FALSE|gate|0|MOE_VERIFIED_LOCAL_NOT_READY|$NOT_READY isolated-check-vm; refusing to start this seat." ;;
  *) vmr_fail S3 "resolveWorktreeMode's unset default is no longer \"gate ? 'on' : 'off'\" ($DEFAULTS); re-mirror vm_route_worktree_mode" ;;
esac

echo "[vm route] verified-local refusals, in order: WSL, CLI, worktree mode, not ready, no VM route"
REFUSAL_ROWS=(
  "W1|worker|gemini|$VL_FALSE|off|1|MOE_VERIFIED_LOCAL_WSL_UNSUPPORTED|$VL, whose worker and QA seats run natively on Windows (moe-agent.ps1), never inside WSL; refusing to start this seat."
  "C1|worker|gemini|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED|$VL, whose worker and QA seats run only claude or codex; this seat runs gemini; refusing to start this seat."
  "C2|worker|grok|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED|$VL, whose worker and QA seats run only claude or codex; this seat runs grok; refusing to start this seat."
  "S1|worker|claude|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED|$SHARED is 'off'; refusing to start this seat."
  "S2|worker|claude|$VL_FALSE|\"ON\"|0|MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED|$SHARED is invalid (\"ON\"); refusing to start this seat."
  "$S3_ROW" "$S4_ROW"
  "N1|worker|codex|{\"profile\":\"verified-local\",\"ready\":false,\"missingCapabilities\":[\"revision-bound-local-delivery\",\"isolated-check-vm\",\"authenticated-runner-evidence\"]}|on|0|MOE_VERIFIED_LOCAL_NOT_READY|$NOT_READY revision-bound-local-delivery, isolated-check-vm, authenticated-runner-evidence; refusing to start this seat."
  "N2|worker|claude|{\"profile\":\"verified-local\",\"ready\":false,\"missingCapabilities\":[]}|on|0|MOE_VERIFIED_LOCAL_NOT_READY|$NOT_READY (none named); refusing to start this seat."
  "R1|worker|claude|$VL_TRUE|on|0|MOE_VERIFIED_LOCAL_VM_ROUTE_UNAVAILABLE|$VL and is ready, but this wrapper has no VM route yet and never runs the agent CLI on the host; refusing to start this seat."
  "R2|qa|codex|$VL_TRUE|on|0|MOE_VERIFIED_LOCAL_VM_ROUTE_UNAVAILABLE|$VL and is ready, but this wrapper has no VM route yet and never runs the agent CLI on the host; refusing to start this seat."
)
for r in "${REFUSAL_ROWS[@]}"; do
  IFS='|' read -r row role cli readiness wt seam code detail <<< "$r"
  vmr_run "$row" "$role" "$cli" "$readiness" "$wt" "$seam"
  vmr_refused "$row" "$code" "$detail"
done
echo "[vm route] ok refusals (W1, C1, C2, S1-S4, N1, N2, R1, R2)"

echo "[vm route] architect and governor seats never read readiness"
for r in A1:architect G1:governor; do
  vmr_run "${r%%:*}" "${r#*:}" claude "$VL_FALSE" off 1
  [ "$VMR_CODE" -eq 0 ] || vmr_fail "${r%%:*}" "exit $VMR_CODE, expected 0"
  ! grep -q MOE_VERIFIED_LOCAL_ "$OUT" || vmr_fail "${r%%:*}" "printed a MOE_VERIFIED_LOCAL_ line"
  [ -f "$REC" ] || vmr_fail "${r%%:*}" "the CLI never ran"
  [ "$(vmr_calls | grep -cx get_execution_readiness || true)" = 0 ] || vmr_fail "${r%%:*}" "called get_execution_readiness"
done
echo "[vm route] ok architect and governor"

# P1: under MOE_RUNTIME_PROTECTED=1 the seam is ignored on any host. It is set to
# the OPPOSITE of /proc/version, so honoring it would change the refusal. Run as
# [protected runtime]'s P9: absolute proxy and daemon files, claude by bare name
# from a PATH entry outside the project, a live daemon.json, --no-start-daemon.
echo "[vm route] the WSL seam is ignored under MOE_RUNTIME_PROTECTED=1"
if grep -qEi '(microsoft|wsl)' /proc/version 2>/dev/null; then
  P1_SEAM=0; P1_CODE=MOE_VERIFIED_LOCAL_WSL_UNSUPPORTED
  P1_DETAIL="$VL, whose worker and QA seats run natively on Windows (moe-agent.ps1), never inside WSL; refusing to start this seat."
else
  P1_SEAM=1; P1_CODE=MOE_VERIFIED_LOCAL_VM_ROUTE_UNAVAILABLE
  P1_DETAIL="$VL and is ready, but this wrapper has no VM route yet and never runs the agent CLI on the host; refusing to start this seat."
fi
VMR_CMD=claude
vmr_run P1 worker claude "$VL_TRUE" on "$P1_SEAM" MOE_RUNTIME_PROTECTED=1 MOE_DAEMON_PATH="$TMP_DIR/fake-daemon.js"
vmr_refused P1 "$P1_CODE" "$P1_DETAIL"
[ ! -e "$TMP_DIR/daemon-ran" ] || vmr_fail P1 "the protected daemon path ran"
# Static: the seam is read only inside vm_route_is_wsl(); is_wsl() never sees it.
SEAM_ALL="$(grep -c MOE_POSTFLIGHT_WSL "$WRAPPER" || true)"
SEAM_FN="$(sed -n '/^vm_route_is_wsl() {$/,/^}$/p' "$WRAPPER" | grep -c MOE_POSTFLIGHT_WSL || true)"
[ "$SEAM_ALL" -ge 1 ] && [ "$SEAM_ALL" = "$SEAM_FN" ] || vmr_fail P1 "MOE_POSTFLIGHT_WSL appears outside vm_route_is_wsl ($SEAM_FN of $SEAM_ALL)"
IS_WSL_BODY="$(sed -n '/^is_wsl() {$/,/^}$/p' "$WRAPPER")"
[[ "$IS_WSL_BODY" == *'/proc/version'* && "$IS_WSL_BODY" != *MOE_POSTFLIGHT_WSL* ]] \
  || vmr_fail P1 "is_wsl() no longer reads /proc/version alone"
echo "[vm route] ok protected seam (P1 seam=$P1_SEAM) and static seam scope"

echo "PASS postflight-vm-route.sh"

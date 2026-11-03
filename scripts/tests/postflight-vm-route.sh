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
VMR_ARGS=(--no-loop --poll-interval 0)
vmr_run() {
  local row="$1" role="$2" cli="$3" readiness="$4" wt="$5" seam="$6" settings='"autoCommit":false'; shift 6
  case "$wt" in -) ;; gate) settings="$settings,\"qualityGate\":\"true\"" ;; on|off) settings="$settings,\"worktreeMode\":\"$wt\"" ;; *) settings="$settings,\"worktreeMode\":$wt" ;; esac
  rm -rf "$PROJECT" "$RUN_TMP" "$TMP_DIR/home" "$REC" "$CALLS" "$TMP_DIR/daemon-ran"
  mkdir -p "$PROJECT/.moe/messages" "$RUN_TMP" "$TMP_DIR/home"
  printf '{"id":"proj-vmr","name":"postflight-vm-route","settings":{%s}}\n' "$settings" > "$PROJECT/.moe/project.json"
  : > "$PROJECT/.moe/messages/chan-general.jsonl"
  printf '{"port":9876,"projectPath":"%s"}\n' "$PROJECT" > "$PROJECT/.moe/daemon.json"
  if [ -n "${VMR_SETUP:-}" ]; then "$VMR_SETUP"; fi
  VMR_ROW="$row"
  set +e
  (
    cd "$PROJECT" || exit 97
    [ "$readiness" = - ] || export FAKE_READINESS="$readiness"
    [ "$seam" = - ] || export MOE_POSTFLIGHT_WSL="$seam"
    env PATH="$BIN:$SHIM:$PATH" HOME="$TMP_DIR/home" TMPDIR="$RUN_TMP" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CALL_LOG="$CALLS" \
      MOE_DISABLE_HEARTBEAT=1 MOE_TASKLESS_WAIT_SEC=5 "$@" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" "$WRAPPER" \
      --project "$PROJECT" --worker-id "$role-vmr" --role "$role" --team Smoke --no-start-daemon \
      --command "${VMR_CMD:-$BIN/$cli}" "${VMR_ARGS[@]}"
  ) >"$OUT" 2>&1
  VMR_CODE=$?
  VMR_CMD=""
  set -e
}
vmr_fail() { cat "$OUT" >&2 || true; echo "VM ROUTE FAILED ($1): $2" >&2; exit 1; }
# vmr_one_reason ROW REASON: a skipped taskless iteration prints exactly ONE
# MOE_TASKLESS_NO_LAUNCH line, and it names REASON.
vmr_one_reason() {
  local n
  n=$(grep -c 'MOE_TASKLESS_NO_LAUNCH reason=' "$OUT" || true)
  [ "$n" = 1 ] && grep -q "^MOE_TASKLESS_NO_LAUNCH reason=$2 role=" "$OUT" \
    || vmr_fail "$1" "expected exactly one MOE_TASKLESS_NO_LAUNCH reason=$2 line, saw $n"
}
# The tools the fake proxy saw, one per line, in call order.
vmr_calls() { [ ! -f "$CALLS" ] || "$NODE" -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) if (l) console.log(JSON.parse(l).tool)' "$CALLS"; }

# vmr_launched ROW: today's path. Exit 0, no MOE_VERIFIED_LOCAL_ text, the CLI
# ran, and get_execution_readiness was read before the claim.
vmr_launched() {
  local calls
  [ "$VMR_CODE" -eq 0 ] || vmr_fail "$1" "exit $VMR_CODE, expected 0"
  ! grep -q MOE_VERIFIED_LOCAL_ "$OUT" || vmr_fail "$1" "today's path printed a MOE_VERIFIED_LOCAL_ line"
  [ -f "$REC" ] || vmr_fail "$1" "the CLI never ran"
  "$NODE" -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")){const r=JSON.parse(l);if(r.tool==="claim_next_task"&&"executionRoute" in r.args)process.exit(1)}' "$CALLS" || vmr_fail "$1" 'legacy claim was marked'
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
# Legacy taskless lines: nothing to answer prints one reason=idle and no CLI; a
# routed mention launches the notification-only CLI and prints no no-launch line.
vmr_run T-taskless-idle worker claude "$LEGACY" - - FAKE_CLAIM_MODE=idle
[ "$VMR_CODE" = 0 ] && [ ! -e "$REC" ] || vmr_fail T-taskless-idle "exit $VMR_CODE or the CLI ran"
vmr_one_reason T-taskless-idle idle
vmr_run T-taskless-mention worker claude "$LEGACY" - - FAKE_CLAIM_MODE=idle FAKE_MENTION=1
vmr_launched T-taskless-mention
! grep -q 'MOE_TASKLESS_NO_LAUNCH' "$OUT" || vmr_fail T-taskless-mention 'a launching iteration printed a no-launch line'
echo "[vm route] ok today's path (legacy x2, observe, unreadable, refuse, unknown, fail, 2 malformed, taskless idle and mention)"

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

echo "[vm route] verified-local refusals, in order: WSL, CLI, worktree mode, not ready"
REFUSAL_ROWS=(
  "W1|worker|gemini|$VL_FALSE|off|1|MOE_VERIFIED_LOCAL_WSL_UNSUPPORTED|$VL, whose worker and QA seats run natively on Windows (moe-agent.ps1), never inside WSL; refusing to start this seat."
  "C1|worker|gemini|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED|$VL, whose worker and QA seats run only claude or codex; this seat runs gemini; refusing to start this seat."
  "C2|worker|grok|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED|$VL, whose worker and QA seats run only claude or codex; this seat runs grok; refusing to start this seat."
  "S1|worker|claude|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED|$SHARED is 'off'; refusing to start this seat."
  "S2|worker|claude|$VL_FALSE|\"ON\"|0|MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED|$SHARED is invalid (\"ON\"); refusing to start this seat."
  "$S3_ROW" "$S4_ROW"
  "N1|worker|codex|{\"profile\":\"verified-local\",\"ready\":false,\"missingCapabilities\":[\"revision-bound-local-delivery\",\"isolated-check-vm\",\"authenticated-runner-evidence\"]}|on|0|MOE_VERIFIED_LOCAL_NOT_READY|$NOT_READY revision-bound-local-delivery, isolated-check-vm, authenticated-runner-evidence; refusing to start this seat."
  "N2|worker|claude|{\"profile\":\"verified-local\",\"ready\":false,\"missingCapabilities\":[]}|on|0|MOE_VERIFIED_LOCAL_NOT_READY|$NOT_READY (none named); refusing to start this seat."
)
for r in "${REFUSAL_ROWS[@]}"; do
  IFS='|' read -r row role cli readiness wt seam code detail <<< "$r"
  vmr_run "$row" "$role" "$cli" "$readiness" "$wt" "$seam"
  vmr_refused "$row" "$code" "$detail"
done
echo "[vm route] ok refusals (W1, C1, C2, S1-S4, N1, N2; R1/R2 in the seat-job block)"

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
  P1_SEAM=1; P1_CODE=MOE_VERIFIED_LOCAL_NOT_READY
  P1_DETAIL="$NOT_READY isolated-check-vm; refusing to start this seat."
fi
VMR_CMD=claude
vmr_run P1 worker claude "$VL_FALSE" on "$P1_SEAM" MOE_RUNTIME_PROTECTED=1 MOE_DAEMON_PATH="$TMP_DIR/fake-daemon.js"
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

# --- [seat job] CQ-M07m3: real wrapper, fake VM, real vm-credential and Git. ----
(
VMR_SETUP=vmj_fixture
READY='{"profile":"verified-local","ready":true,"missingCapabilities":[]}'
TOKEN=sk-ant-oat01-vmCanaryMustNeverEscapePipes0123456789
VMJ_WORKSPACE=worktree; VMJ_QA=false
export MOE_AGENT_SEAT_PATH="$ROOT_DIR/scripts/tests/postflight-fake-agent-seat.js"
export MOE_ACCOUNT_ROTATION=on MOE_ACCOUNTS_FILE="$TMP_DIR/accounts/claude-accounts.json" FAKE_ACCOUNT_HOME="$TMP_DIR/accounts"
export GIT_AUTHOR_NAME=vmj GIT_AUTHOR_EMAIL=vmj@example.invalid GIT_COMMITTER_NAME=vmj GIT_COMMITTER_EMAIL=vmj@example.invalid
export ANTHROPIC_API_KEY=outer-a ANTHROPIC_AUTH_TOKEN=outer-b CLAUDE_CODE_OAUTH_TOKEN=outer-c OPENAI_API_KEY=outer-d CODEX_API_KEY=outer-e
vmj_fixture() {
  mkdir -p "$TMP_DIR/accounts/claude-vm-tokens" "$TMP_DIR/accounts/acct-1"
  printf %s "$TOKEN" > "$TMP_DIR/accounts/claude-vm-tokens/acct-1.token"
  printf '.moe/\n.worktrees/\n.mcp.json\n' > "$PROJECT/.gitignore"
  printf 'seed\n' > "$PROJECT/seed.txt"
  git -C "$PROJECT" init -q -b main
  git -C "$PROJECT" add .gitignore seed.txt; git -C "$PROJECT" commit -qm seed
  git -C "$PROJECT" checkout -qb moe/control
  "$NODE" -e 'const fs=require("fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p));Object.assign(d.settings,{autoCommit:true,checkpointPush:false,commitBoardState:false});fs.writeFileSync(p,JSON.stringify(d))' "$PROJECT/.moe/project.json"
  VMJ_BASE=$(git -C "$PROJECT" rev-parse HEAD)
  printf %s "$VMJ_BASE" > "$TMP_DIR/vmj-base"
  export FAKE_CLAIM_WORKSPACE="{\"mode\":\"$VMJ_WORKSPACE\",\"target\":\"main\"}"
  export FAKE_CTX_WORKSPACE="$FAKE_CLAIM_WORKSPACE" # alreadyAssigned resumes recover this from get_context.
  export FAKE_CTX_LANDING="{\"lastCompletion\":{\"sha\":\"$VMJ_BASE\"}}"
  if [ "$VMJ_QA" = true ]; then export FAKE_TASK_STATUS=REVIEW; else unset FAKE_TASK_STATUS; fi
}
vmj_rows() {
  "$NODE" - "$PROJECT" "$OUT" "$REC" "$TOKEN" "$1" <<'JS'
const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const [p,out,rec,token,mode]=process.argv.slice(2),file=p+'/.moe/evidence-rpcs.jsonl';
const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'', output=fs.readFileSync(out,'utf8');
const rows=raw.trim().split('\n').filter(Boolean).map(JSON.parse), seats=rows.filter(r=>r.tool==='agent-seat');
assert.equal(fs.existsSync(rec),false,'host CLI ran'); assert.ok(!raw.includes(token)&&!output.includes(token),'token leaked');
const job=seats.find(r=>r.args.cmd==='seat-job');
assert.deepEqual(seats.map(r=>r.args.cmd),mode==='shared'||mode==='taskless'?['seat-start','seat-stop']:mode==='none'?[]:['seat-start','seat-job','seat-stop']);
for(const r of seats) for(const k of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY']) assert.ok(!(k in r.args.env),k);
const claims=rows.filter(r=>r.tool==='claim_next_task');
if(mode==='none') { assert.equal(claims.length,0); process.exit(0); }
assert.ok(claims.length>0); for(const r of claims) assert.equal(r.args.executionRoute,'vm');
assert.ok(rows.indexOf(seats[0])<rows.indexOf(claims[0]));
assert.ok(rows.indexOf(seats.at(-1))<rows.findIndex(r=>r.tool==='deregister_worker'));
if(!job) process.exit(0);
const git=(...args)=>cp.execFileSync('git',['-C',p,...args],{encoding:'utf8'}).trim();
const base=fs.readFileSync(p+'/../vmj-base','utf8'),role=mode==='qa'?'qa':'worker';
const w=role==='qa'?p:p+'/.worktrees/task-postflight', identity=claims[0].args;
assert.deepEqual(job.args.argv,['seat-job','--project',p,'--worker',role+'-vmr','--runner',identity.processStartedAt,'--host',identity.host,
  '--instance',seats[0].args.instance,'--role',role,'--task','task-postflight','--attempt','attempt-postflight','--generation','7','--checkout',w,'--commit',base,'--cli','claude']);
assert.ok(output.includes('Runner identity: processStartedAt='+identity.processStartedAt+' host='+identity.host));
assert.equal(job.args.stdinName,'CLAUDE_CODE_OAUTH_TOKEN'); assert.equal(job.args.stdinSha256,crypto.createHash('sha256').update(token).digest('hex'));
if(role==='worker') assert.equal(job.args.clean,true,'host tooling dirtied W');
if(mode==='happy'||mode==='nonzero') {
  const tip=git('rev-parse','moe/task/task-postflight'); assert.equal(git('rev-parse',tip+'^'),base); assert.equal(git('rev-parse',tip+'^{tree}'),job.args.tree);
  assert.ok(git('log','-1','--format=%B',tip).includes('cli-exit='+(mode==='nonzero'?17:0)));
  assert.equal(rows.filter(r=>r.tool==='record_commit'&&r.args.outcome==='committed').length,1); assert.ok(output.includes('guest stdout')&&output.includes('guest stderr'));
  assert.equal((output.match(/MOE_VM_CANDIDATE_COMMITTED/g)||[]).length,1); assert.ok(!output.includes('Committed checkpoint'));
} else if(mode==='qa') assert.equal(cp.spawnSync('git',['-C',p,'rev-parse','--verify','moe/task/task-postflight']).status,128);
JS
}
vmj_wait() {
  local n=0
  until "$NODE" -e 'const fs=require("fs");try{const r=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);process.exit(r.filter(x=>x.tool==="agent-seat"&&x.args.cmd===process.argv[2]).length>=Number(process.argv[3])?0:1)}catch{process.exit(1)}' "$PROJECT/.moe/evidence-rpcs.jsonl" "$1" "${2:-1}"; do
    n=$((n+1)); [ "$n" -lt "$POSTFLIGHT_TIMEOUT_SEC" ] || vmr_fail wait "$1 never arrived"; sleep 1
  done
}
vmj_background() {
  rm -f "$TMP_DIR/bg.code"
  set -m
  (vmr_run "$@"; echo "$VMR_CODE" > "$TMP_DIR/bg.code") & VMJ_PID=$!
  set +m
}
vmj_wrapper_pid() { "$NODE" -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).find(r=>r.tool==="agent-seat"); const a=r.args.argv; console.log(a[a.indexOf("--runner")+1].split("@")[0])' "$PROJECT/.moe/evidence-rpcs.jsonl"; }

echo '[seat errors] capacity FULL/LOCK_BUSY retries before any claim; other failures stop'
VMR_ARGS=(--no-loop --poll-interval 1)
for start_case in capacity failure usage unreadable; do
  case "$start_case" in
    capacity) starts='[{"exit":75,"code":"SEAT_CAPACITY_FULL"},{"exit":75,"code":"SEAT_CAPACITY_LOCK_BUSY"}]' ;;
    failure) starts='[{"exit":1,"code":"SEAT_PROVISION_FAILED"}]' ;;
    usage) starts='[{"exit":2,"code":"SEAT_USAGE"}]' ;;
    unreadable) starts='[{"exit":1,"code":"never echo arbitrary text"}]' ;;
  esac
  vmr_run "VE-$start_case" worker claude "$READY" on 0 FAKE_SEAT_STARTS="$starts"
  "$NODE" - "$PROJECT/.moe/evidence-rpcs.jsonl" "$OUT" "$REC" "$start_case" "$VMR_CODE" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),[file,out,rec,mode,rc]=process.argv.slice(2);
const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),s=rows.filter(r=>r.tool==='agent-seat'),text=fs.readFileSync(out,'utf8');
a.equal(fs.existsSync(rec),false);
if(mode==='capacity') {
  a.equal(rc,'0'); a.deepEqual(s.map(r=>r.args.cmd),['seat-start','seat-start','seat-start','seat-job','seat-stop']);
  a.ok(rows.findIndex(r=>r.tool==='claim_next_task')>rows.indexOf(s[2]));
  for(const code of ['FULL','LOCK_BUSY']) a.ok(text.includes('MOE_SEAT_CAPACITY_WAIT: SEAT_CAPACITY_'+code));
} else {
  a.equal(rc,'1'); a.deepEqual(s.map(r=>r.args.cmd),['seat-start']); a.ok(!rows.some(r=>r.tool==='claim_next_task'));
  a.ok(text.includes('MOE_SEAT_START_FAILED: '+({failure:'SEAT_PROVISION_FAILED',usage:'SEAT_USAGE',unreadable:'exit 1'}[mode])));
}
JS
done
VMR_ARGS=(--no-loop --poll-interval 0)

echo '[seat credentials] codex pipe canary, fallback and missing key'
for key in OPENAI_API_KEY CODEX_API_KEY; do
  vmr_run "VE-$key" worker codex "$READY" on 0 OPENAI_API_KEY= CODEX_API_KEY= "$key=$TOKEN"
  [ "$VMR_CODE" = 0 ] || vmr_fail "$key" "exit $VMR_CODE"
  "$NODE" - "$PROJECT/.moe/evidence-rpcs.jsonl" "$OUT" "$REC" "$TOKEN" "$key" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),crypto=require('crypto'),[f,o,r,t,k]=process.argv.slice(2);
const raw=fs.readFileSync(f,'utf8'),rows=raw.trim().split('\n').map(JSON.parse),s=rows.filter(x=>x.tool==='agent-seat');
a.equal(fs.existsSync(r),false); a.ok(!raw.includes(t)&&!fs.readFileSync(o,'utf8').includes(t));
a.deepEqual(s.map(x=>x.args.cmd),['seat-start','seat-job','seat-stop']);
for(const x of s) for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']) a.ok(!(key in x.args.env));
a.equal(s[1].args.stdinName,k); a.equal(s[1].args.stdinSha256,crypto.createHash('sha256').update(t).digest('hex'));
a.equal(s[1].args.argv.at(-1),'codex');
JS
done
vmr_run VE-no-key worker codex "$READY" on 0 OPENAI_API_KEY= CODEX_API_KEY=
[ "$VMR_CODE" = 1 ] && grep -q MOE_VM_CREDENTIAL_UNAVAILABLE "$OUT" || vmr_fail VE-no-key 'not refused'
vmj_rows none
[ "$(vmr_calls | grep -cx chat_send)" = 1 ] || vmr_fail VE-no-key 'not one escalation'
echo '[seat credentials] claude waits holding the task; one escalation across repeated missing tokens'
vmj_missing_fixture() { vmj_fixture; rm -f "$TMP_DIR/accounts/claude-vm-tokens/acct-1.token"; }
VMR_SETUP=vmj_missing_fixture
vmj_background VE-missing worker claude "$READY" on 0 MOE_ACCOUNT_RETRY_SEC=1
for n in $(seq 1 "$POSTFLIGHT_TIMEOUT_SEC"); do
  [ "$(grep -c MOE_VM_CREDENTIAL_UNAVAILABLE "$OUT" 2>/dev/null || true)" -ge 2 ] 2>/dev/null && break
  sleep 1
done
[ "$(grep -c MOE_VM_CREDENTIAL_UNAVAILABLE "$OUT" || true)" -ge 2 ] || vmr_fail VE-missing 'did not retry'
printf %s "$TOKEN" > "$TMP_DIR/accounts/claude-vm-tokens/acct-1.token"
wait "$VMJ_PID"
[ "$(cat "$TMP_DIR/bg.code")" = 0 ] || vmr_fail VE-missing 'retry failed'; vmj_rows happy
"$NODE" - "$CALLS" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),r=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
a.equal(r.filter(x=>x.tool==='chat_send'&&x.args.content.includes('MOE_VM_CREDENTIAL_UNAVAILABLE')).length,1);
a.equal(r.filter(x=>x.tool==='claim_next_task').length,1); a.ok(r.filter(x=>x.tool==='lease_account').length>=3);
JS
VMR_SETUP=vmj_fixture

echo '[seat failures] failed or missing outcome stops VM, then resumes with a fresh instance'
VMR_ARGS=(--loop --poll-interval 1)
for job_case in failed missing false stop-failed streak; do
  jobs='[{"exit":1,"outcome":{"seatJob":1,"ok":false,"code":"SEAT_JOB_SESSION_FAILED","vm":"kept"}}]'
  case "$job_case" in
    missing) jobs='[{"exit":0}]' ;;
    false) jobs='[{"exit":0,"outcome":{"seatJob":1,"ok":false,"code":"SEAT_JOB_SESSION_FAILED","vm":"kept"}}]' ;;
    streak) jobs='[{"exit":1},{"exit":1},{"exit":1}]' ;;
  esac
  extra=(); [ "$job_case" != stop-failed ] || extra=(FAKE_SEAT_STOP_FAIL=1)
  limit=2; [ "$job_case" != streak ] || limit=4
  vmj_background "VE-$job_case" worker claude "$READY" on 0 FAKE_SEAT_JOBS="$jobs" FAKE_CLAIM_LIMIT="$limit" \
    MOE_LAUNCH_BACKOFF_BASE_SEC=1 MOE_LAUNCH_BACKOFF_MAX_SEC=1 "${extra[@]}"
  vmj_wait seat-job "$limit"; pid=$(vmj_wrapper_pid)
  vmj_wait seat-stop "$((limit-1))"
  # The last job is successful. Stop only after its checkpoint is durable.
  for n in $(seq 1 "$POSTFLIGHT_TIMEOUT_SEC"); do grep -q MOE_VM_CANDIDATE_COMMITTED "$OUT" && break; sleep 1; done
  kill -TERM "$pid"; wait "$VMJ_PID"
  "$NODE" - "$PROJECT" "$OUT" "$REC" "$limit" "$job_case" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),cp=require('child_process'),[p,out,rec,n,mode]=process.argv.slice(2);
const r=fs.readFileSync(p+'/.moe/evidence-rpcs.jsonl','utf8').trim().split('\n').map(JSON.parse),s=r.filter(x=>x.tool==='agent-seat'),text=fs.readFileSync(out,'utf8');
const calls=fs.readFileSync(p+'/../calls.jsonl','utf8').trim().split('\n').map(JSON.parse);
a.equal(fs.existsSync(rec),false); a.deepEqual(s.map(x=>x.args.cmd),Array(Number(n)).fill(['seat-start','seat-job','seat-stop']).flat());
a.equal(new Set(s.filter(x=>x.args.cmd==='seat-start').map(x=>x.args.instance)).size,Number(n));
const claims=r.filter(x=>x.tool==='claim_next_task'); for(let i=0;i<Number(n);i++) a.ok(r.indexOf(claims[i])>r.indexOf(s[3*i]));
a.equal((text.match(/MOE_SEAT_JOB_FAILED:/g)||[]).length,Number(n)-1); a.ok(text.includes('[resume]'));
a.equal(r.filter(x=>x.tool==='record_commit'&&x.args.outcome==='committed').length,1); a.ok(!calls.some(x=>x.tool==='release_task'));
if(mode==='streak') a.equal(calls.filter(x=>x.tool==='chat_send'&&x.args.content.includes('CLI exits within')).length,1);
if(mode==='stop-failed') a.ok(text.includes('MOE_SEAT_STOP_FAILED: SEAT_DELETE_FAILED'));
const git=(...args)=>cp.execFileSync('git',['-C',p,...args],{encoding:'utf8'}).trim(); a.equal(git('rev-parse','moe/task/task-postflight^'),fs.readFileSync(p+'/../vmj-base','utf8'));
JS
done
VMR_ARGS=(--no-loop --poll-interval 0)
echo '[seat failures] successful job with DIRTY helper refusal retains admitted tree on rescue ref'
vmr_run VE-rescue worker claude "$READY" on 0 FAKE_SEAT_DIRTY=1
[ "$VMR_CODE" = 1 ] || vmr_fail VE-rescue 'must hold on helper refusal'
"$NODE" - "$PROJECT" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),cp=require('child_process'),p=process.argv[2],git=(...args)=>cp.execFileSync('git',['-C',p,...args],{encoding:'utf8'}).trim();
const rows=fs.readFileSync(p+'/.moe/evidence-rpcs.jsonl','utf8').trim().split('\n').map(JSON.parse),job=rows.find(x=>x.tool==='agent-seat'&&x.args.cmd==='seat-job');
const ref=git('for-each-ref','--format=%(refname)','refs/moe/rescue/task-postflight/'); a.equal(ref.split('\n').length,1); a.ok(ref);
const base=fs.readFileSync(p+'/../vmj-base','utf8'); a.equal(git('rev-parse',ref+'^'),base); a.equal(git('rev-parse',ref+'^{tree}'),job.args.tree);
a.equal(git('rev-parse','moe/task/task-postflight'),base); a.equal(fs.readFileSync(p+'/.worktrees/task-postflight/untracked.txt','utf8'),'preserve me\n');
a.equal(rows.filter(x=>x.tool==='record_commit'&&x.args.kind==='rescue').length,1);
JS

echo '[seat waits] Ctrl+C during capacity and missing credentials; resume cap stays bounded'
for wait_case in capacity credential cap; do
  VMR_SETUP=vmj_fixture; VMR_ARGS=(--loop --poll-interval 1); extra=(); pattern=MOE_SEAT_CAPACITY_WAIT
  case "$wait_case" in
    capacity) extra=('FAKE_SEAT_STARTS=[{"exit":75,"code":"SEAT_CAPACITY_LOCK_BUSY"}]'); VMR_ARGS=(--loop --poll-interval 20) ;;
    credential) VMR_SETUP=vmj_missing_fixture; extra=(MOE_ACCOUNT_RETRY_SEC=20); pattern=MOE_VM_CREDENTIAL_UNAVAILABLE ;;
    cap) extra=('FAKE_SEAT_JOBS=[{"exit":1},{"exit":1},{"exit":1}]' MOE_LAUNCH_FAIL_SEC=0 MOE_RESUME_MAX_ATTEMPTS=1); pattern='Auto-resume cap reached' ;;
  esac
  vmj_background "VE-wait-$wait_case" worker claude "$READY" on 0 "${extra[@]}"
  vmj_wait seat-start; pid=$(vmj_wrapper_pid)
  for n in $(seq 1 "$POSTFLIGHT_TIMEOUT_SEC"); do grep -q "$pattern" "$OUT" && break; sleep 1; done
  grep -q "$pattern" "$OUT" || vmr_fail "$wait_case" 'wait was not reached'
  kill -INT "$pid"; wait "$VMJ_PID"
  [ "$(cat "$TMP_DIR/bg.code")" = 0 ] && [ ! -e "$REC" ] || vmr_fail "$wait_case" 'interrupted wait launched or failed'
  "$NODE" - "$PROJECT/.moe/evidence-rpcs.jsonl" "$CALLS" "$wait_case" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),[f,c,mode]=process.argv.slice(2),read=p=>fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
const rows=read(f),calls=read(c),seats=rows.filter(r=>r.tool==='agent-seat');
a.equal(seats.filter(r=>r.args.cmd==='seat-job').length,mode==='cap'?2:0);
a.equal(seats.filter(r=>r.args.cmd==='seat-stop').length,mode==='cap'?3:mode==='credential'?1:0);
if(mode==='capacity') a.ok(!calls.some(r=>r.tool==='claim_next_task'));
if(mode==='cap') a.equal(calls.filter(r=>r.tool==='chat_send'&&r.args.content.includes('pausing auto-resume')).length,1);
a.ok(!calls.some(r=>r.tool==='release_task'));
JS
done
VMR_SETUP=vmj_fixture; VMR_ARGS=(--no-loop --poll-interval 0)

echo '[seat job] VR-happy (replaces R1), credential confinement and candidate landing'
{ echo 'PYTHON_CMD=python3 ROLE=worker'; sed -n '/^seat_job_outcome() {$/,/^}$/p' "$WRAPPER"; echo 'seat_job_outcome "$1"'; } > "$TMP_DIR/outcome.sh"
"$NODE" - "$TMP_DIR/outcome.sh" <<'JS'
const a=require('node:assert/strict'),cp=require('node:child_process'),commit='a'.repeat(40);
const good={seatJob:1,ok:true,role:'worker',commit,baseTree:'b'.repeat(40),tree:'c'.repeat(40),exitCode:0};
for(const patch of [{},{seatJob:true},{seatJob:0},{ok:false},{role:'qa'},{commit:'d'.repeat(40)},{tree:'bad'}]){
  const r=cp.spawnSync('bash',[process.argv[2],commit],{input:JSON.stringify({...good,...patch}),encoding:'utf8',env:{...process.env,PYTHONOPTIMIZE:'1'}});
  a.equal(r.status===0,Object.keys(patch).length===0,JSON.stringify(patch));
}
for(const exitCode of [null,-1,256,true]){const r=cp.spawnSync('bash',[process.argv[2],commit],{input:JSON.stringify({...good,exitCode}),encoding:'utf8'});a.equal(r.status,0);a.equal(r.stdout.split(' ')[0],'1');}
JS
vmr_run VR-happy worker claude "$READY" on 0
[ "$VMR_CODE" = 0 ] || vmr_fail VR-happy "exit $VMR_CODE"; vmj_rows happy
echo '[seat job] nonzero guest exit still never invokes a host signin-state probe'
vmr_run VR-nonzero worker claude "$READY" on 0 FAKE_SEAT_EXIT_CODE=17
vmj_rows nonzero
echo '[seat job] R2 codex, no-auto-claim, QA settings guard, protected override'
vmr_run R2 qa codex "$READY" on 0 OPENAI_API_KEY= CODEX_API_KEY=
[ "$VMR_CODE" = 1 ] && grep -q MOE_VM_CREDENTIAL_UNAVAILABLE "$OUT" || vmr_fail R2 'not refused'; vmj_rows none
VMR_ARGS+=(--no-auto-claim)
vmr_run VR-noclaim worker claude "$READY" on 0
[ "$VMR_CODE" = 1 ] && [ "$(grep -c MOE_VERIFIED_LOCAL_NO_AUTO_CLAIM "$OUT")" = 1 ] || vmr_fail VR-noclaim 'not refused'; vmj_rows none
VMR_ARGS=(--no-loop --poll-interval 0)
vmr_run VR-qa-shared qa claude "$READY" off 0
[ "$VMR_CODE" = 1 ] && grep -q MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED "$OUT" || vmr_fail VR-qa-shared 'not refused'; vmj_rows none
VMR_CMD=claude
vmr_run VR-protected worker claude '{"profile":"verified-local","ready":false,"missingCapabilities":[]}' on 0 MOE_RUNTIME_PROTECTED=1 MOE_DAEMON_PATH="$TMP_DIR/fake-daemon.js"
[ "$VMR_CODE" = 1 ] && [ "$(grep -c MOE_VERIFIED_LOCAL_SEAT_PATH_IGNORED "$OUT")" = 1 ] || vmr_fail VR-protected 'override not ignored'
! grep -Fq "$MOE_AGENT_SEAT_PATH" "$OUT" || vmr_fail VR-protected 'override value printed'; vmj_rows none
echo '[seat job] VR-shared worker backstop and VR-qa landed commit'
VMJ_WORKSPACE=shared
vmr_run VR-shared worker claude "$READY" on 0
[ "$VMR_CODE" = 1 ] && [ "$(grep -c MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED "$OUT")" = 1 ] || vmr_fail VR-shared 'not refused'; vmj_rows shared
VMJ_QA=true
vmr_run VR-qa qa claude "$READY" on 0
[ "$VMR_CODE" = 0 ] || vmr_fail VR-qa "exit $VMR_CODE"; vmj_rows qa
VMJ_WORKSPACE=worktree; VMJ_QA=false
echo '[seat job] VR-sigint stops its VM before deregister'
vmj_background VR-sigint worker claude "$READY" on 0 FAKE_SEAT_JOB_SLEEP=3
vmj_wait seat-job; pid=$(vmj_wrapper_pid)
(sleep "$POSTFLIGHT_TIMEOUT_SEC"; kill -9 "$pid" 2>/dev/null || true) & watchdog=$!
kill -INT "$pid"
wait "$VMJ_PID"
kill "$watchdog" 2>/dev/null || true; wait "$watchdog" 2>/dev/null || true
[ "$(cat "$TMP_DIR/bg.code")" = 0 ] || vmr_fail VR-sigint 'INT did not exit 0'; vmj_rows sigint
echo '[seat job] VR-taskless: one accurate no-launch reason, no host CLI'
VMR_ARGS=(--no-loop --poll-interval 0)
vmr_run VR-taskless worker claude "$READY" on 0 FAKE_CLAIM_MODE=idle FAKE_MENTION=1
[ "$VMR_CODE" = 0 ] || vmr_fail VR-taskless "exit $VMR_CODE"
vmr_one_reason VR-taskless vm-route; vmj_rows taskless
vmr_run VR-taskless-teamless worker claude "$READY" on 0 FAKE_CLAIM_MODE=idle FAKE_MENTION=1 FAKE_JOIN_FULL=1
[ "$VMR_CODE" = 1 ] && [ "$(grep -c MOE_SEAT_UNREGISTERED "$OUT")" = 1 ] || vmr_fail VR-taskless-teamless "exit $VMR_CODE, expected the one-shot teamless exit 1"
# A seat whose join failed reads no chat, so it has no routed mention: the legacy
# teamless rule skipped first and its reason stands, once.
vmr_one_reason VR-taskless-teamless teamless; vmj_rows taskless
vmr_run VR-taskless-idle worker claude "$READY" on 0 FAKE_CLAIM_MODE=idle
[ "$VMR_CODE" = 0 ] || vmr_fail VR-taskless-idle "exit $VMR_CODE"
vmr_one_reason VR-taskless-idle idle; vmj_rows taskless
echo '[seat job] VR-reload: taskless mentions never launch, both instances stopped'
COPY="$TMP_DIR/reload"; mkdir -p "$COPY"; cp -R "$ROOT_DIR/scripts" "$COPY/"
git -C "$COPY" init -q -b main; git -C "$COPY" add scripts; git -C "$COPY" commit -qm wrapper
VMR_ARGS=(--loop --poll-interval 1)
WRAPPER="$COPY/scripts/moe-agent.sh" vmj_background VR-reload worker claude "$READY" on 0 FAKE_CLAIM_MODE=idle FAKE_MENTION=1
vmj_wait seat-start; pid=$(vmj_wrapper_pid)
printf '\n# committed reload test\n' >> "$COPY/scripts/moe-agent.sh"
git -C "$COPY" add scripts/moe-agent.sh; git -C "$COPY" commit -qm reload
vmj_wait seat-start 2; kill -TERM "$pid"; wait "$VMJ_PID"
[ "$(cat "$TMP_DIR/bg.code")" = 0 ] && grep -q 'MOE_TASKLESS_NO_LAUNCH reason=vm-route' "$OUT" && [ ! -e "$REC" ] || vmr_fail VR-reload 'taskless host launch or no reload'
[ "$(grep -c 'MOE_TASKLESS_NO_LAUNCH reason=' "$OUT" || true)" = "$(grep -c 'MOE_TASKLESS_NO_LAUNCH reason=vm-route ' "$OUT" || true)" ] \
  || vmr_fail VR-reload 'a taskless iteration printed a reason other than vm-route'
"$NODE" - "$PROJECT/.moe/evidence-rpcs.jsonl" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),r=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const s=r.filter(x=>x.tool==='agent-seat'); a.deepEqual(s.map(x=>x.args.cmd),['seat-start','seat-stop','seat-start','seat-stop']);
const d=r.filter(x=>x.tool==='deregister_worker'); a.equal(d[0].args.reason,'wrapper_restart'); a.equal(d.length,2);
for(let i=0;i<2;i++){a.ok(r.indexOf(s[i*2+1])<r.indexOf(d[i])); const v=s[i*2+1].args.argv; a.equal(v[v.indexOf('--instance')+1],s[i*2].args.instance);}
a.notEqual(s[0].args.instance,s[2].args.instance);
JS
echo '[seat job] PASS VR-happy, nonzero, R2, noclaim, qa-shared, protected, shared, qa, sigint, taskless, taskless-teamless, taskless-idle, reload'
)

# --- [vm candidate] CQ-M07m2: land_vm_candidate turns a VM job's admitted tree
# into ONE checkpoint commit on moe/task/<id>. The helper, with the wrapper's own
# write_commit_message and rescue_ref_from_commit, is sliced out of moe-agent.sh
# (postflight.sh's WT_SH_FUNCS approach) and run under set -e against a temp repo
# whose W is a real sparse linked worktree; record_commit_rpc and moe_rpc log
# their arguments. Every row also proves the control checkout's HEAD, index file
# and status and refs/heads/main never move.
for v in $(compgen -e); do case "$v" in GIT_*) unset "$v" ;; esac; done
VMC="$TMP_DIR/vmc"; VMC_TID=task-vmc; VMC_LOG="$VMC/rpc.log"; VMC_RESULT="$VMC/result"; VMC_OUT="$VMC/out"; VMC_SEC="$VMC/sec"
VMC_DRIVER="$VMC/driver.sh"; TAB=$'\t'; PY="$(command -v python3 || command -v python)"
mkdir -p "$VMC/home" "$VMC/hooks"
export HOME="$VMC/home" XDG_CONFIG_HOME="$VMC/home/.config" GIT_CONFIG_NOSYSTEM=1
git config --global user.name vmc && git config --global user.email vmc@example.invalid
printf '#!/bin/sh\nexit 1\n' > "$VMC/hooks/pre-commit" && cp "$VMC/hooks/pre-commit" "$VMC/hooks/commit-msg" && chmod +x "$VMC/hooks/"*
vmc_fail() { cat "$VMC_OUT" "$VMC_LOG" >&2 2>/dev/null || true; echo "VM CANDIDATE FAILED ($1): $2" >&2; exit 1; }
vmc_slice() { local f body; for f in "$@"; do body="$(sed -n "/^$f() {\$/,/^}\$/p" "$WRAPPER")"
  [ -n "$body" ] || vmc_fail slice "moe-agent.sh has no $f()"; printf '%s\n' "$body"; done; }
cat > "$VMC_DRIVER" <<'SH'
set -e
YELLOW= GREEN= BLUE= NC= MOE_TAB=$'\t' SECURE_TEMP_DIR="$VMC_SEC" LAND_OUTCOME= LAND_CODE= LAND_SHA=
record_commit_rpc() { printf '%s %s %s %s|%s\n' "$1" "$2" "$3" "$4" "$(tr '\0' '|' < "${8:-/dev/null}")" >> "$VMC_LOG"; }
moe_rpc() { printf 'moe_rpc %s\n' "$1" >> "$VMC_LOG"; }
trap 'printf "rc=%s outcome=%s code=%s sha=%s\n" "$?" "$LAND_OUTCOME" "$LAND_CODE" "$LAND_SHA" > "$VMC_RESULT"' EXIT
SH
vmc_slice land_vm_candidate vm_candidate_stop write_commit_message rescue_ref_from_commit create_secure_temp >> "$VMC_DRIVER"
printf '%s\n' 'land_vm_candidate "$VMC_C" "$VMC_BT" "$VMC_T"' >> "$VMC_DRIVER"

# vmc_tree BASE PATH CONTENT... -- BASE plus each PATH's blob (CONTENT '-' deletes
# it) through a private index, as admission.mjs writeTree builds an admitted tree.
vmc_tree() {
  local idx="$VMC/tree.idx" sha; rm -f "$idx"; GIT_INDEX_FILE="$idx" git -C "$R" read-tree "$1"; shift
  while [ "$#" -ge 2 ]; do
    if [ "$2" = - ]; then GIT_INDEX_FILE="$idx" git -C "$R" update-index --force-remove -- "$1"
    else sha="$(printf '%s\n' "$2" | git -C "$R" hash-object -w --stdin)"
      printf '100644 %s\t%s\n' "$sha" "$1" | GIT_INDEX_FILE="$idx" git -C "$R" update-index --index-info; fi
    shift 2
  done
  GIT_INDEX_FILE="$idx" git -C "$R" write-tree
}
# vmc_fixture: a control checkout R on main and W on moe/task/<id>, sparse '/*'
# '!/.moe/' like provision_worktree; C/BT the job's base, T base + src/a.txt=a2.
vmc_fixture() {
  R="$VMC/repo"; W="$R/.worktrees/$VMC_TID"; B="moe/task/$VMC_TID"
  rm -rf "$R" "$VMC_SEC" "$VMC/seam-ran"; mkdir -p "$R/src" "$R/lib" "$R/.moe/tasks" "$VMC_SEC"
  printf 'a\n' > "$R/src/a.txt"; printf 'keep\n' > "$R/lib/keep.txt"; printf '{}\n' > "$R/.moe/tasks/$VMC_TID.json"; printf '.worktrees/\n' > "$R/.gitignore"
  git -C "$R" init -q -b main && git -C "$R" add -A && git -C "$R" commit -qm base
  git -C "$R" worktree add -q --no-checkout -b "$B" "$W" main
  printf '%s\n' '/*' '!/.moe/' | git -C "$W" sparse-checkout set --no-cone --stdin
  git -C "$W" read-tree -mu HEAD
  C="$(git -C "$R" rev-parse main)"; BT="$(git -C "$R" rev-parse "main^{tree}")"; T="$(vmc_tree "$BT" src/a.txt a2)"
}
vmc_control() { git -C "$R" symbolic-ref -q HEAD; git -C "$R" rev-parse HEAD refs/heads/main; sha256sum < "$R/.git/index"
  git -C "$R" --no-optional-locks status --porcelain -uall -z | tr '\0' '\n'; }
vmc_refs() { git -C "$R" for-each-ref --format='%(refname) %(objectname)'; }
vmc_others() { vmc_refs | grep -v -e "^refs/heads/$B " -e '^refs/moe/rescue/' || true; }
vmc_wfiles() { git -C "$W" symbolic-ref -q HEAD; git -C "$W" ls-files -s -t
  (cd "$W" && find . -path ./.git -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum); }
vmc_windex() { sha256sum < "$(git -C "$W" rev-parse --absolute-git-dir)/index"; }
# vmc_run ROW [VAR=VALUE...] -- the driver as W's worker seat on C BT T; the
# control checkout and main must be byte-identical afterwards.
vmc_run() {
  local ctl; ctl="$(vmc_control)"; VMC_REFS0="$(vmc_refs)"; VMC_OTHERS0="$(vmc_others)"; VMC_W0="$(vmc_wfiles)"; VMC_I0="$(vmc_windex)"
  VMC_ROW="$1"; shift; : > "$VMC_LOG"; rm -f "$VMC_RESULT"
  set +e
  env ROLE=worker WORKER_ID=worker-vmc MOE_SID=worker-vmc@2026-11-03T00:00:00Z LAND_TASK_ID="$VMC_TID" LAND_TITLE='vm candidate' \
    LAND_STATUS=WORKING LAND_CLI_EXIT=0 MOE_WT_MODE=worktree MOE_WT_PATH="$W" MOE_WT_BRANCH="$B" VMC_C="$C" VMC_BT="$BT" VMC_T="$T" \
    VMC_LOG="$VMC_LOG" VMC_RESULT="$VMC_RESULT" VMC_SEC="$VMC_SEC" "$@" bash "$VMC_DRIVER" > "$VMC_OUT" 2>&1
  VMC_RC=$?
  set -e
  [ "$(vmc_control)" = "$ctl" ] || vmc_fail "$VMC_ROW" "the control checkout's HEAD, index, status or refs/heads/main moved"
}
vmc_untouched() {
  [ "$(vmc_refs)" = "$VMC_REFS0" ] || vmc_fail "$1" "a ref moved"
  [ "$(vmc_wfiles)" = "$VMC_W0" ] && [ "$(vmc_windex)" = "$VMC_I0" ] || vmc_fail "$1" "W's HEAD, index file, entries or files changed"
  [ ! -s "$VMC_LOG" ] || vmc_fail "$1" "a ledger row or rpc was sent"
}
# vmc_committed ROW PATHS LOG_PATHS: rc 0, the branch at ONE new commit (parent C,
# tree T) that W's index and files match, one committed checkpoint row, no rescue.
vmc_committed() {
  NEW="$(git -C "$R" rev-parse "refs/heads/$B")"
  [ "$VMC_RC" = 0 ] && grep -Fxq "rc=0 outcome=committed code= sha=$NEW" "$VMC_RESULT" || vmc_fail "$1" "exit $VMC_RC, $(cat "$VMC_RESULT" 2>/dev/null)"
  [ "$(git -C "$R" rev-list --parents -n 1 "$NEW")" = "$NEW $C" ] && [ "$(git -C "$R" rev-parse "$NEW^{tree}")" = "$T" ] \
    || vmc_fail "$1" "$B is not one commit with parent C and tree T"
  [ -z "$(git -C "$W" --no-optional-locks status --porcelain -uall)" ] && [ ! -e "$W/.moe" ] || vmc_fail "$1" "W does not match the new commit, or holds .moe"
  [ "$(cat "$VMC_LOG")" = "committed checkpoint $NEW refs/heads/$B|$3" ] || vmc_fail "$1" "not one committed checkpoint row"
  grep -Fxq "[OK] MOE_VM_CANDIDATE_COMMITTED task=$VMC_TID sha=$NEW paths=$2 branch=$B" "$VMC_OUT" || vmc_fail "$1" "no COMMITTED line"
  [ -z "$(git -C "$R" for-each-ref refs/moe/rescue)" ] && [ "$(vmc_others)" = "$VMC_OTHERS0" ] || vmc_fail "$1" "another ref moved"
}
# vmc_parked ROW CODE: rc 2 with CODE, the commit (parent C, tree T) on exactly one
# rescue ref and in the only ledger row, W's entries and files as before.
vmc_parked() {
  local rs; rs="$(git -C "$R" for-each-ref --format='%(refname)' "refs/moe/rescue/$VMC_TID/")"
  [ "$VMC_RC" = 2 ] && grep -q "^\[WARN\] MOE_VM_CANDIDATE_$2: task $VMC_TID -- " "$VMC_OUT" || vmc_fail "$1" "exit $VMC_RC, expected 2 with $2"
  [ -n "$rs" ] && [ "$(printf '%s\n' "$rs" | wc -l)" = 1 ] || vmc_fail "$1" "not one rescue ref: $rs"
  NEW="$(git -C "$R" rev-parse "$rs")"
  [ "$(git -C "$R" rev-list --parents -n 1 "$NEW")" = "$NEW $C" ] && [ "$(git -C "$R" rev-parse "$NEW^{tree}")" = "$T" ] || vmc_fail "$1" "the rescue ref is not the admitted commit"
  [ "$(vmc_wfiles)" = "$VMC_W0" ] || vmc_fail "$1" "W's entries or files are not as before"
  [ "$(cat "$VMC_LOG")" = "committed rescue $NEW $rs|WORKTREE${TAB}-${TAB}src/a.txt|" ] || vmc_fail "$1" "the only row is not the rescue row"
  [ "$(vmc_others)" = "$VMC_OTHERS0" ] || vmc_fail "$1" "another ref moved"
}

echo "[vm candidate] R1: one changed file becomes one checkpoint commit, hooks never run"
vmc_fixture; git -C "$R" config core.hooksPath "$VMC/hooks"
vmc_run R1 CS_COMMIT_HOOKS=true
vmc_committed R1 1 "WORKTREE${TAB}-${TAB}src/a.txt|"
[ "$(cat "$W/src/a.txt")" = a2 ] || vmc_fail R1 "W's file does not hold the admitted bytes"
[ "$(git -C "$R" log -1 --format=%B "$NEW")" = "$(printf 'wip(%s): vm candidate [status=WORKING role=worker cli-exit=0]\n\nCheckpoint via Moe worker session; not a completion.\n\nMoe-Task: %s\nMoe-Kind: checkpoint\nMoe-Session: worker-vmc@2026-11-03T00:00:00Z\nMoe-Status: WORKING\nMoe-Paths: 1\nMoe-Inferred: 0' "$VMC_TID" "$VMC_TID")" ] \
  || vmc_fail R1 "the message is not WT-07's checkpoint message"
echo "[vm candidate] R1u: a deletion and a new path with a space and Unicode"
vmc_fixture; T="$(vmc_tree "$BT" 'lib/n é w.txt' new lib/keep.txt -)"
vmc_run R1u
vmc_committed R1u 2 "WORKTREE${TAB}-${TAB}lib/keep.txt|WORKTREE${TAB}-${TAB}lib/n é w.txt|"
[ "$(cat "$W/lib/n é w.txt")" = new ] && [ ! -e "$W/lib/keep.txt" ] || vmc_fail R1u "W does not hold the admitted change"

echo "[vm candidate] R2-R5: refusals write nothing"
for r in R2a:NOT_WORKTREE R2b:NOT_WORKTREE R2c:NOT_WORKTREE R3a:HEAD_MOVED R3b:BASE_MISMATCH R4a:DIRTY R4b:DIRTY R5a:TREE_INVALID R5b:TREE_INVALID; do
  vmc_fixture; set --
  case "${r%%:*}" in
    R2a) set -- MOE_WT_MODE=shared MOE_WT_PATH= ;;
    R2b) set -- MOE_WT_PATH="$R" ;;
    R2c) set -- MOE_WT_BRANCH=moe/task/task-other ;;
    R3a) git -C "$W" update-ref "refs/heads/$B" "$(git -C "$W" commit-tree "$BT" -p "$C" -m next)" ;;
    R3b) set -- VMC_BT="$T" ;;
    R4a) printf 'edit\n' >> "$W/src/a.txt" ;;
    R4b) printf 'new\n' > "$W/untracked.txt" ;;
    R5a) set -- VMC_T=0123456789abcdef0123456789abcdef01234567 ;;
    R5b) set -- VMC_T="$(git -C "$R" rev-parse main:src/a.txt)" ;;
  esac
  vmc_run "${r%%:*}" "$@"
  [ "$VMC_RC" = 1 ] && [ "$(grep -c MOE_VM_CANDIDATE_ "$VMC_OUT")" = 1 ] \
    && grep -q "^\[WARN\] MOE_VM_CANDIDATE_${r#*:}: task $VMC_TID -- .*; nothing written\.\$" "$VMC_OUT" \
    || vmc_fail "${r%%:*}" "exit $VMC_RC, expected 1 and one MOE_VM_CANDIDATE_${r#*:} line"
  vmc_untouched "${r%%:*}"
done

echo "[vm candidate] R6: a lost CAS parks the commit and restores W"
vmc_fixture; OTHER="$(git -C "$R" commit-tree "$BT" -p "$C" -m other)"
vmc_run R6 MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF="git update-ref refs/heads/$B $OTHER"
vmc_parked R6 REF_CONTENTION
[ "$(git -C "$R" rev-parse "refs/heads/$B")" = "$OTHER" ] || vmc_fail R6 "the branch is not where the race left it"
echo "[vm candidate] R7: a failed W update parks the commit; the branch stays"
vmc_fixture; LOCK="$(git -C "$W" rev-parse --absolute-git-dir)/index.lock"; : > "$LOCK"
vmc_run R7; rm -f "$LOCK"
vmc_parked R7 SYNC_FAILED
[ "$(git -C "$R" rev-parse "refs/heads/$B")" = "$C" ] && [ "$(vmc_windex)" = "$VMC_I0" ] || vmc_fail R7 "the branch or W's index moved"
echo "[vm candidate] R8: an empty candidate writes nothing"
vmc_fixture; vmc_run R8 VMC_T="$BT"
[ "$VMC_RC" = 0 ] && grep -Fxq 'rc=0 outcome=nothing code=MOE_VM_CANDIDATE_EMPTY sha=' "$VMC_RESULT" \
  && grep -q "^\[info\] MOE_VM_CANDIDATE_EMPTY: task $VMC_TID -- " "$VMC_OUT" || vmc_fail R8 "exit $VMC_RC, expected 0 with MOE_VM_CANDIDATE_EMPTY"
vmc_untouched R8
echo "[vm candidate] R9: the test seam never runs under MOE_RUNTIME_PROTECTED"
vmc_fixture; OTHER="$(git -C "$R" commit-tree "$BT" -p "$C" -m other)"
vmc_run R9 RUNTIME_PROTECTED=1 MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF="touch $VMC/seam-ran; git update-ref refs/heads/$B $OTHER"
vmc_committed R9 1 "WORKTREE${TAB}-${TAB}src/a.txt|"
[ ! -e "$VMC/seam-ran" ] || vmc_fail R9 "the seam ran"
echo "[vm candidate] ok R1, R1u, R2a-R5b, R6-R9"

# --- [strong intent] wt_strong_intent M B (CQ-M07m2, CQ-V07): sliced with
# strong_landing_task and receipt_journal_path, on a scratch PROJECT and gitdir.
echo "[strong intent] a no-op for legacy; the strong profile needs the frozen candidate of exactly M on B"
GSI="$TMP_DIR/gsi"; GSI_DRIVER="$GSI/driver.sh"; mkdir -p "$GSI/project/.moe/attempts" "$GSI/gitdir"
{ printf '%s\n' 'set -e' 'LAND_OUTCOME=untouched LAND_CODE=untouched'; vmc_slice wt_strong_intent strong_landing_task receipt_journal_path
  printf '%s\n' 'rc=0; wt_strong_intent "$GSI_M" "$GSI_B" || rc=$?' 'echo "$rc $LAND_OUTCOME $LAND_CODE"'; } > "$GSI_DRIVER"
GSI_M=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; GSI_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OK_ALL="FROZEN_CANDIDATE_ID=cand-1 FROZEN_TREE=$GSI_M FROZEN_BASE=$GSI_B MOE_ATTEMPT_ID=attempt-1 PINNED_ATTEMPT_PLAN_REVISION=1"
PIN="PINNED_ATTEMPT_PROFILE=verified-local PREFLIGHT_TASK_ID=task-g"; NO='1 refused MOE_COMMIT_REFUSED_INTENT_INCOMPLETE'; YES='0 untouched untouched'
G_ROWS=("G1|$YES|" "G1b|$YES|PINNED_ATTEMPT_PROFILE=verified-local LAND_TASK_ID=" "G2|$NO|$PIN" "G3|$NO|ATTEMPTS"
  "G4|$NO|$PIN $OK_ALL FROZEN_TREE=$GSI_B" "G5|$NO|$PIN $OK_ALL FROZEN_BASE=$GSI_M" "G6a|$NO|$PIN $OK_ALL MOE_ATTEMPT_ID="
  "G6b|$NO|$PIN $OK_ALL PINNED_ATTEMPT_PLAN_REVISION=" "G6c|$NO|$PIN $OK_ALL FROZEN_CANDIDATE_ID=" "G7|$YES|$PIN $OK_ALL")
for r in "${G_ROWS[@]}"; do
  IFS='|' read -r row expect extra <<< "$r"; rm -f "$GSI/project/.moe/attempts/"*.json
  if [ "$extra" = ATTEMPTS ]; then
    printf '{"taskId":"task-g","generation":1,"executionPolicySnapshot":{"profile":"legacy"}}\n' > "$GSI/project/.moe/attempts/a1.json"
    printf '{"taskId":"task-g","generation":2,"executionPolicySnapshot":{"profile":"verified-local"}}\n' > "$GSI/project/.moe/attempts/a2.json"
    extra=""
  fi
  read -ra kv <<< "$extra" || true
  got="$(env PYTHON_CMD="$PY" PROJECT="$GSI/project" MOE_GITDIR="$GSI/gitdir" LAND_TASK_ID=task-g GSI_M="$GSI_M" GSI_B="$GSI_B" \
    PINNED_ATTEMPT_PROFILE= PREFLIGHT_TASK_ID= FROZEN_CANDIDATE_ID= FROZEN_TREE= FROZEN_BASE= PINNED_ATTEMPT_PLAN_REVISION= MOE_ATTEMPT_ID= \
    "${kv[@]}" bash "$GSI_DRIVER" 2>&1)" || vmc_fail "$row" "the driver failed: $got"
  [ "$got" = "$expect" ] || vmc_fail "$row" "got '$got', expected '$expect'"
done
# G8: wt_land_rounds calls it once per round, after the L6 gate, before L7-L9.
BODY="$(sed -n '/^wt_land_rounds() {$/,/^}$/p' "$WRAPPER")"
gline() { printf '%s\n' "$BODY" | grep -n -m 1 -F -e "$1" | cut -d: -f1 || true; }
SI="$(gline 'wt_strong_intent "$m" "$b" || return 1')"; LOOP_END="$(printf '%s\n' "$BODY" | grep -n -x '    done' | head -n 1 | cut -d: -f1)"
[ "$(printf '%s\n' "$BODY" | grep -c wt_strong_intent)" = 1 ] && [ -n "$SI" ] && [ -n "$LOOP_END" ] && [ "$SI" -lt "$LOOP_END" ] \
  || vmc_fail G8 "wt_land_rounds does not call 'wt_strong_intent \"\$m\" \"\$b\" || return 1' exactly once inside its round loop"
for k in 'for ((round = 1' 'run_frozen_gate worktree'; do [ "$(gline "$k")" -lt "$SI" ] || vmc_fail G8 "the call is not after '$k'"; done
for k in commit-tree wt_journal_write update-ref wt_publish; do [ "$SI" -lt "$(gline "$k")" ] || vmc_fail G8 "the call is not before the first $k"; done
echo "[strong intent] ok G1-G7 and G8"

echo "PASS postflight-vm-route.sh"

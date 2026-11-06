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
# With FAKE_RENEW_FILE set, a claude `-p … --tools` run is instead the sign-in
# renewal ([seat sign-in]): it rewrites the account's .credentials.json from that
# file's {accessToken, refreshToken}, 8 h left, as claude's refresh would, logs
# renew.jsonl beside the record, and never writes the record (no task CLI ran).
for cli in claude codex gemini grok; do
  printf '#!/usr/bin/env bash\nexec %q -e %q %q %q "$@"\n' "$NODE" \
    'const [rec,cli,...argv]=process.argv.slice(1),fs=require("fs"),e=process.env;if(cli==="claude"&&e.FAKE_RENEW_FILE&&argv.includes("-p")&&argv.includes("--tools")){const d=e.CLAUDE_CONFIG_DIR;fs.writeFileSync(d+"/.credentials.json",JSON.stringify({claudeAiOauth:{...JSON.parse(fs.readFileSync(e.FAKE_RENEW_FILE,"utf8")),expiresAt:Date.now()+288e5,scopes:["user:inference"],subscriptionType:"max"}}));fs.appendFileSync(require("path").dirname(rec)+"/renew.jsonl",JSON.stringify({argv,cwd:process.cwd(),configDir:d,hasMoeWorkerId:"MOE_WORKER_ID" in e,hasPluginDirs:"CLAUDE_CODE_PLUGIN_DIRS" in e})+"\n")}else fs.writeFileSync(rec,JSON.stringify({cli,argv,cwd:process.cwd(),env:process.env}));' \
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
  rm -rf "$PROJECT" "$RUN_TMP" "$TMP_DIR/home" "$REC" "$REC.copilot" "$CALLS" "$TMP_DIR/daemon-ran"
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
    # A gemini seat would run agy: MOE_AGY_COMMAND points it at the fake, never the host's real Antigravity.
    env PATH="$BIN:$SHIM:$PATH" HOME="$TMP_DIR/home" TMPDIR="$RUN_TMP" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CALL_LOG="$CALLS" \
      MOE_AGY_COMMAND="$BIN/gemini" MOE_DISABLE_HEARTBEAT=1 MOE_TASKLESS_WAIT_SEC=5 "$@" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" "$WRAPPER" \
      --project "$PROJECT" --worker-id "$role-vmr" --role "$role" --team Smoke --no-start-daemon \
      --command "${VMR_CMD:-$BIN/$cli}" "${VMR_ARGS[@]}"
  ) < "${VMR_STDIN:-/dev/null}" >"$OUT" 2>&1
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
# The usage receipt pair (its launchId uuids) no longer reaches the CLI (task-cd3887fe).
vmr_normalized() {
  "$NODE" -e '
const [file, tmp] = process.argv.slice(1);
const rec = JSON.parse(require("fs").readFileSync(file, "utf8"));
delete rec.env.FAKE_READINESS;
const sid = rec.env.MOE_SESSION_ID || "\u0000";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mask = (s) => s.split(sid).join("<session>")
  .replace(new RegExp(esc(tmp) + "/[^/\\s\"\x27]+", "g"), tmp + "/<tmp>");
const walk = (v) => typeof v === "string" ? mask(v) : Array.isArray(v) ? v.map(walk)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])])) : v;
process.stdout.write(JSON.stringify(walk(rec), null, 1));
' "$REC" "$RUN_TMP"
}

# --- [copilot]: only this fake reads stdin, and never for a TUI.
mkdir -p "$TMP_DIR/serena-bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP_DIR/serena-bin/serena"; chmod +x "$TMP_DIR/serena-bin/serena"
printf '#!/usr/bin/env bash\nexec %q -e %q %q "$@"\n' "$NODE" '
const fs=require("fs"),[rec,...argv]=process.argv.slice(1),i=argv.indexOf("-i"),kind=argv.includes("--version")?"version":argv.includes("--help")?"probe":"run";
const stdin=i<0?fs.readFileSync(0,"utf8"):"";
fs.appendFileSync(rec+".copilot",JSON.stringify({kind,argv,stdin})+"\n");
if(kind!=="run"){console.error(kind==="version"?"copilot-test 1.0\nignored version tail":(process.env.FAKE_CP_PROBE||"help")+"\nignored help tail");process.exit(Number(process.env[kind==="version"?"FAKE_CP_VERSION_EXIT":"FAKE_CP_PROBE_EXIT"]||0))}
const mcpFile=argv[argv.indexOf("--additional-mcp-config")+1].slice(1);
fs.writeFileSync(rec,JSON.stringify({cli:"copilot",argv,cwd:process.cwd(),env:process.env,mcpFile,mcp:JSON.parse(fs.readFileSync(mcpFile,"utf8")),stdin,pointerText:i<0?"":fs.readFileSync(argv[i+1].split(" is in ")[1].split(" - read it.")[0],"utf8")}));
const e=process.env,mode=e.FAKE_CP_LOG,dir=argv[argv.indexOf("--log-dir")+1],auth="[ERROR] No authentication information found.",n=fs.readFileSync(rec+".copilot","utf8").trim().split("\n").map(JSON.parse).filter(x=>x.kind==="run").length;
if(mode==="stdout")console.log(auth);
if(mode==="stale")fs.writeFileSync(require("path").dirname(dir)+"/stale.log",auth);
if(dir&&["auth","two","unrelated"].includes(mode))fs.writeFileSync(dir+"/process-test-"+process.pid+".log",mode==="unrelated"?"unrelated error":auth+"\nsecret-copilot-token");
process.exit(mode==="two"?(n===1?0:1):Number(e.FAKE_CP_EXIT||0));' "$REC" > "$BIN/copilot"
chmod +x "$BIN/copilot"; cp "$BIN/copilot" "$BIN/copilot.exe"; cp "$BIN/copilot" "$BIN/copilot.cmd"
cp_assert() {
  [ "$VMR_CODE" = 0 ] && [ -f "$REC" ] || vmr_fail "$VMR_ROW" "copilot did not launch: $VMR_CODE"
  "$NODE" - "$REC" "$PROJECT" "$1" "${2:-$PROJECT}" "$FAKE_PROXY" "$TMP_DIR/serena-bin/serena" "${3:-}" "${4:-}" <<'JS' || vmr_fail "$VMR_ROW" 'copilot contract'
const [file,project,mode,root,proxy,serena,model,effort]=process.argv.slice(2),fs=require('fs'),a=require('assert/strict'),r=JSON.parse(fs.readFileSync(file)),tui=mode==='tui';
a.equal(r.env.MOE_WORKER_TYPE,'COPILOT'); a.equal(r.cwd,root);
a.deepEqual(r.argv,[...(r.env.FAKE_CP_PREFIX?['--prefix-test']:[]),'-C',root,...(tui?[]:['--allow-all','--no-ask-user']),'--no-auto-update','--disable-builtin-mcps','--additional-mcp-config','@'+r.mcpFile,...(model?['--model',model]:[]),...(effort?['--reasoning-effort',effort]:[]),...(tui?['-i',r.argv.at(-1)]:['--log-dir',r.argv.at(-1)])]);
if(!tui)a.ok(!fs.existsSync(r.argv.at(-1)),'log cleanup');
const text=tui?r.pointerText:r.stdin;
for(const s of [r.env.FAKE_CLAIM_MODE==='resume'?'task-resume':'task-postflight','# Session Context (per-iteration)',tui?'INTERACTIVE session:':'One-shot session:']) a.ok(text.includes(s),s);
if(tui) a.ok(text.includes('This interactive session may plan up to')); else a.ok(text.includes('\u2014'));
if(mode==='worker') a.ok(text.startsWith('Role: worker.'));
const m=r.mcp.mcpServers.moe,e=m.env;
a.equal(m.type,'local'); a.deepEqual(m.tools,['*']); a.equal(m.timeout,780000); a.deepEqual(m.args,[proxy]); a.ok(m.command);
a.equal(e.MOE_PROJECT_PATH,project); a.equal(e.MOE_TOOL_NAME_STYLE,'underscore'); a.equal(e.MOE_WORKER_ID,r.env.MOE_WORKER_ID);
for(const k of ['MOE_WORKER_TYPE','MOE_SESSION_ID','MOE_RUNNER_PROCESS_STARTED_AT','MOE_RUNNER_HOST','MOE_DAEMON_HOST']) if(r.env[k]) a.equal(e[k],r.env[k]);
for(const k of ['MOE_ATTEMPT_ID','MOE_ATTEMPT_GENERATION']) a.equal(e[k],r.env.MOE_ATTEMPT_ID&&r.env.MOE_ATTEMPT_GENERATION?r.env[k]:undefined);
a.deepEqual(r.mcp.mcpServers.serena,{type:'local',command:serena,tools:['*'],args:['start-mcp-server','--context','agent','--project',root,'--enable-web-dashboard','false','--enable-gui-log-window','false']});
a.ok(!r.mcpFile.startsWith(project+'/')); a.ok(!fs.existsSync(r.mcpFile),'temp cleanup');
const calls=fs.readFileSync(file+'.copilot','utf8').trim().split('\n').map(JSON.parse),probes=calls.filter(c=>c.kind==='probe');
a.equal(probes.length,tui||r.env.MOE_DISABLE_ARGV_PROBE==='1'?0:1);
if(probes.length){a.equal(probes[0].stdin,'');a.deepEqual(probes[0].argv,[...r.argv,'--help']);}
JS
}
cp_rejected() {
  [ "$VMR_CODE" = 1 ] && [ ! -e "$REC" ] || vmr_fail "$VMR_ROW" 'rejection launched or wrong exit'
  "$NODE" - "$REC.copilot" "$OUT" "$CALLS" "$1" "$2" <<'JS' || vmr_fail "$VMR_ROW" 'rejection evidence'
const fs=require('fs'),a=require('assert/strict'),[f,o,c,phrase,version]=process.argv.slice(2),rows=p=>fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse),r=rows(f),text=fs.readFileSync(o,'utf8'),rpc=rows(c);
a.deepEqual(r.map(x=>x.kind),['probe','version']);a.equal(r[0].stdin,'');a.equal(r[1].stdin,'');
a.equal(text.split('\n').filter(l=>l.includes('MOE_CLI_ARGV_REJECTED')).length,1);a.ok(text.includes('copilot ('+version+')'));a.ok(text.includes(phrase));a.ok(!text.includes('ignored version tail'));a.ok(!text.includes('ignored help tail'));a.ok(!fs.existsSync(require('path').dirname(r[0].argv.at(-2))));
a.equal(rpc.filter(x=>x.tool==='chat_send'&&x.args.content.includes('MOE_CLI_ARGV_REJECTED')&&x.args.channel==='chan-general').length,1);a.ok(rpc.some(x=>x.tool==='deregister_worker'));a.ok(!text.includes('[launch-failure]'));
JS
}
cp_auth_assert() {
  "$NODE" - "$REC.copilot" "$OUT" "$CALLS" "$VMR_CODE" "$1" "$2" <<'JS' || vmr_fail "$VMR_ROW" 'auth lifecycle'
const fs=require('fs'),a=require('assert/strict'),p=require('path'),[f,o,c,code,fatal,count]=process.argv.slice(2),rows=p=>fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse),all=rows(f),r=all.filter(x=>x.kind==='run'),text=fs.readFileSync(o,'utf8'),rpc=rows(c),msg='MOE_COPILOT_SIGNED_OUT';
a.equal(Number(code),fatal==='1'?1:0);a.equal(r.length,Number(count));a.equal(all.filter(x=>x.kind==='probe').length,1);
a.equal(text.split('\n').filter(l=>l.includes(msg)).length,Number(fatal));a.equal(rpc.filter(x=>x.tool==='chat_send'&&x.args.content.includes(msg)&&x.args.channel==='chan-general').length,Number(fatal));a.ok(rpc.some(x=>x.tool==='deregister_worker'));
if(fatal==='1'){a.ok(!text.includes('[launch-failure]'));for(const s of ['copilot login','COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN','Windows and WSL sign in separately'])a.ok(text.includes(s));}
const dirs=r.map(x=>x.argv[x.argv.indexOf('--log-dir')+1]);a.equal(new Set(dirs).size,r.length);for(const d of dirs){a.ok(p.isAbsolute(d));a.ok(p.basename(d).startsWith('copilot-log.'));a.ok(!fs.existsSync(d));a.ok(!fs.existsSync(p.dirname(d)));}
if(r.length===2){a.equal(r[0].argv[r[0].argv.indexOf('--reasoning-effort')+1],'xhigh');a.ok(!r[1].argv.includes('--reasoning-effort'));a.ok(!r.some(x=>x.argv.includes('--model')));}
for(const s of ['secret-copilot-token','secret-gh-token','secret-github-token'])a.ok(!(text+fs.readFileSync(c,'utf8')).includes(s));
JS
}
cp_fixture() {
  printf '.moe/\n.worktrees/\n.mcp.json\n.serena/\n' > "$PROJECT/.gitignore"
  git -C "$PROJECT" init -q -b main; git -C "$PROJECT" add .gitignore
  git -C "$PROJECT" commit -qm seed; git -C "$PROJECT" checkout -qb moe/control
  mkdir -p "$PROJECT/.serena/memories"
  export FAKE_CLAIM_WORKSPACE='{"mode":"worktree","target":"main"}' FAKE_CTX_WORKSPACE='{"mode":"worktree","target":"main"}'
}
(
  export MOE_SERENA_PATH="$TMP_DIR/serena-bin/serena"
  RUN_TMP="$TMP_DIR/copilot temp"
  vmr_run CP-H worker copilot - off -; vmr_launched CP-H; cp_assert worker
  grep -Fq 'Copilot mode: headless (stdin prompt)' "$OUT" || vmr_fail CP-H banner
  for ext in exe cmd; do VMR_CMD="$BIN/copilot.$ext"; vmr_run CP-X worker copilot - off -; cp_assert worker; done
  VMR_ARGS=(--poll-interval 1); vmr_run CP-A architect copilot - off -; cp_assert tui
  grep -Fq 'Copilot mode: interactive' "$OUT" && grep -Fq 'Interactive mode: polling disabled' "$OUT" || vmr_fail CP-A polling
  VMR_ARGS=(--no-loop --poll-interval 0 --no-interactive); vmr_run CP-AN architect copilot - off -; cp_assert headless
  VMR_ARGS=(--no-loop --poll-interval 0)
  export FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING FAKE_CLAIM_LAUNCH='{"tier":"standard","effort":"xhigh","model":"claude-opus-5-5","codex":{"effort":"low"}}'
  vmr_run CP-route worker copilot - off -; cp_assert worker '' '' xhigh
  vmr_run CP-env worker copilot - off - MOE_COPILOT_MODEL=env-model MOE_COPILOT_EFFORT=max; cp_assert worker '' env-model max
  cp_models() { "$NODE" -e 'const f=process.argv[1],fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.settings.models={worker:"settings-model",architect:"settings-model"};fs.writeFileSync(f,JSON.stringify(p))' "$PROJECT/.moe/project.json"; }
  VMR_SETUP=cp_models
  vmr_run CP-settings worker copilot - off - MOE_COPILOT_MODEL=env-model MOE_COPILOT_EFFORT=none; cp_assert worker '' settings-model none
  VMR_ARGS+=(--model cli-model)
  VMR_CMD="$BIN/copilot --prefix-test"
  vmr_run CP-cli worker copilot - off - FAKE_CP_PREFIX=1 MOE_COPILOT_MODEL=env-model MOE_COPILOT_EFFORT=minimal; cp_assert worker '' cli-model minimal
  vmr_run CP-tui architect copilot - off - MOE_COPILOT_MODEL=env-model MOE_COPILOT_EFFORT=none; cp_assert tui '' cli-model none
  unset FAKE_CLAIM_MODE FAKE_TASK_STATUS FAKE_CLAIM_LAUNCH VMR_SETUP; VMR_ARGS=(--no-loop --poll-interval 0)
  printf 'inherited stdin sentinel' > "$TMP_DIR/cp-stdin"; VMR_STDIN="$TMP_DIR/cp-stdin"
  for phrase in 'Unexpected Argument' 'invalid value' 'unrecognized'; do
    vmr_run CP-reject worker copilot - off - FAKE_CP_PROBE="$phrase" FAKE_CP_PROBE_EXIT=1; cp_rejected "$phrase" 'copilot-test 1.0'
  done
  vmr_run CP-version worker copilot - off - FAKE_CP_PROBE=unrecognized FAKE_CP_PROBE_EXIT=1 FAKE_CP_VERSION_EXIT=1; cp_rejected unrecognized unknown
  for mode in skip accepted unrelated; do
    extra=(FAKE_CP_PROBE=unrecognized FAKE_CP_PROBE_EXIT=1)
    case "$mode" in skip) extra+=(MOE_DISABLE_ARGV_PROBE=1);; accepted) extra=(FAKE_CP_PROBE='invalid value' FAKE_CP_PROBE_EXIT=0);; unrelated) extra=(FAKE_CP_PROBE='network unavailable' FAKE_CP_PROBE_EXIT=1);; esac
    vmr_run "CP-$mode" worker copilot - off - "${extra[@]}"; cp_assert worker
    ! grep -q MOE_CLI_ARGV_REJECTED "$OUT" || vmr_fail "$VMR_ROW" 'false rejection'
  done
  unset VMR_STDIN
  export COPILOT_GITHUB_TOKEN=secret-copilot-token GH_TOKEN=secret-gh-token GITHUB_TOKEN=secret-github-token
  for mode in auth unrelated missing stdout stale; do
    vmr_run "CP-log-$mode" worker copilot - off - FAKE_CP_LOG="$mode" FAKE_CP_EXIT="$([ "$mode" = auth ] && echo 0 || echo 1)"; cp_auth_assert 0 1
  done
  VMR_ARGS=(--poll-interval 1)
  vmr_run CP-auth worker copilot - off - FAKE_CP_LOG=auth FAKE_CP_EXIT=1; cp_auth_assert 1 1
  vmr_run CP-two worker copilot - off - FAKE_CP_LOG=two FAKE_CLAIM_ONCE=1 FAKE_MENTION=1 FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING 'FAKE_CLAIM_LAUNCH={"tier":"standard","effort":"xhigh","model":"claude-opus-5-5"}'; cp_auth_assert 1 2
  unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; VMR_ARGS=(--no-loop --poll-interval 0)
  REAL_MKTEMP=$(command -v mktemp)
  cp_no_log() { printf '#!/bin/bash\ncase "$*" in *copilot-log*) exit 1;; esac\nexec %q "$@"\n' "$REAL_MKTEMP" > "$BIN/mktemp"; chmod +x "$BIN/mktemp"; }
  VMR_SETUP=cp_no_log; vmr_run CP-logfail worker copilot - off -
  [ "$VMR_CODE" = 1 ] && [ ! -e "$REC.copilot" ] && grep -Fq 'Cannot create private Copilot log directory; refusing to launch.' "$OUT" || vmr_fail CP-logfail 'directory failure launched'
  rm "$BIN/mktemp"; unset VMR_SETUP
  for name in copilot copilot.exe copilot.cmd; do
    missing="$TMP_DIR/missing/$name"; VMR_CMD="$missing"; vmr_run CP-NF worker copilot - off -
    [ "$VMR_CODE" = 1 ] && [ ! -e "$REC" ] && [ "$(grep -c MOE_COPILOT_NOT_FOUND "$OUT")" = 1 ] &&
      grep -Fq "MOE_COPILOT_NOT_FOUND: GitHub Copilot CLI not found: $missing. Install it (npm install -g @github/copilot), then sign in with copilot login." "$OUT" || vmr_fail CP-NF refusal
  done
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP_DIR/cp-gitconfig"
  printf '[user]\n name = Test\n email = test@example.com\n' > "$GIT_CONFIG_GLOBAL"
  VMR_SETUP=cp_fixture; vmr_run CP-W worker copilot - on -; cp_assert worker "$PROJECT/.worktrees/task-postflight"
)
echo '[copilot] ok CP-H, CP-X, CP-A, CP-AN, CP-NF, CP-W, routing, argv-probe, auth, two-launch, logfail'

echo "[vm route] today's path: every non-verified-local answer launches the same CLI"
LEGACY='{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
vmr_run T-legacy worker claude "$LEGACY" - -
vmr_launched T-legacy
vmr_normalized > "$TMP_DIR/T-base.json"
"$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(r.argv.some((a)=>a.includes("task-postflight"))&&r.env.MOE_WORKER_ID==="worker-vmr"?0:1)' "$REC" \
  || vmr_fail T-legacy "the CLI record does not name task-postflight and MOE_WORKER_ID=worker-vmr"
# The launch's own usage receipt, printed with only timestamp and launchId masked
# (the before/after evidence of task-cd3887fe), then pinned: the wrapper's pending
# and missing rows land, and the CLI never inherits the receipt pair.
"$NODE" -e '
const fs = require("fs"), path = require("path");
const [recFile, dir] = process.argv.slice(1);
const fail = (why) => { process.stderr.write(why); process.exit(1); };
let files = [];
try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch {}
if (files.length !== 1) fail(`expected one usage receipt file, saw ${files.length}`);
const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").split("\n").filter(Boolean);
console.log("[vm route] T-legacy usage receipt: " + lines.map((l) => l.replace(/"timestamp":"[^"]*"/g, "\"timestamp\":\"<ts>\"")
  .replace(/"launchId":"[^"]*"/g, "\"launchId\":\"<launch>\"")).join(" | "));
const rows = lines.map((l) => JSON.parse(l));
if (rows.length !== 2) fail(`expected 2 receipt rows, saw ${rows.length}`);
const coverage = rows.map((r) => r.coverage).join(",");
if (coverage !== "pending,missing") fail(`receipt coverage is ${coverage}, expected pending,missing`);
if (!rows[0].launchId || rows[1].launchId !== rows[0].launchId) fail("the receipt rows do not share one launchId");
const want = { provider: "claude", taskId: "task-postflight", workerId: "worker-vmr", role: "worker", launchMode: "headless" };
for (const r of rows) for (const [k, v] of Object.entries(want)) if (r[k] !== v) fail(`receipt ${k} is ${r[k]}, expected ${v}`);
const env = JSON.parse(fs.readFileSync(recFile, "utf8")).env;
for (const k of ["MOE_USAGE_RECEIPT_FILE", "MOE_USAGE_CONTEXT_JSON"]) if (k in env) fail(`the CLI env carries ${k}`);
' "$REC" "$PROJECT/logs/moe-usage" 2>"$TMP_DIR/receipt.why" || vmr_fail T-legacy "$(cat "$TMP_DIR/receipt.why")"
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
  "C3|worker|copilot|$VL_FALSE|off|0|MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED|$VL, whose worker and QA seats run only claude or codex; this seat runs copilot; refusing to start this seat."
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
echo "[vm route] ok refusals (W1, C1, C2, C3, S1-S4, N1, N2; R1/R2 in the seat-job block)"

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
  rm -f "$TMP_DIR/accounts/acct-1/.credentials.json" # only [seat sign-in] seeds one
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
vmj_missing_fixture() { vmj_fixture; rm -f "$TMP_DIR/accounts/claude-vm-tokens/acct-1.token"; }

# --- [seat sign-in] task-98053b89: no minted token, so the job runs on the leased
# account's own sign-in (slice A's real helper), renewed only by the host claude.
echo '[seat sign-in] a claude VM seat with no minted token uses the leased account sign-in'
REFRESH=sk-ant-ort01-vmRefreshCanaryNeverLeavesTheFile0123
OLD=sk-ant-oat01-vmOldAccessCanaryNeverReachesAJob01234
REFRESH2=sk-ant-ort01-vmRenewedRefreshCanaryNeverLeaves012
SIGNIN="$TMP_DIR/accounts/acct-1/.credentials.json"; RENEW_LOG="$TMP_DIR/renew.jsonl"; RENEW_PAIR="$TMP_DIR/renew-pair.json"
# si_write ACCESS REFRESH SECONDS-LEFT: claude's sign-in file shape, replaced in one rename.
si_write() {
  "$NODE" -e 'const fs=require("fs"),[f,a,r,s]=process.argv.slice(1);fs.writeFileSync(f+".tmp",JSON.stringify({claudeAiOauth:{accessToken:a,refreshToken:r,expiresAt:Date.now()+Number(s)*1000,scopes:["user:inference"],subscriptionType:"max"}}));fs.renameSync(f+".tmp",f)' "$SIGNIN" "$@"
}
si_sha() { "$NODE" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$SIGNIN"; }
# SI_FILE="ACCESS SECONDS-LEFT" seeds a sign-in file holding REFRESH too; empty seeds none.
si_fixture() {
  vmj_missing_fixture; rm -f "$RENEW_LOG"
  if [ -n "$SI_FILE" ]; then si_write "${SI_FILE% *}" "$REFRESH" "${SI_FILE#* }"; si_sha > "$TMP_DIR/si.sha"; fi
}
# si_clean ROW CANARY...: no canary in the wrapper output, the RPC, seat and chat
# records, the project, the run's temp or home. It names the file, never the value,
# and runs before any vmr_fail, which prints OUT.
si_clean() {
  local row="$1" c hits pats=(); shift
  for c in "$@"; do pats+=(-e "$c"); done
  hits=$(grep -rlF "${pats[@]}" -- "$OUT" "$CALLS" "$PROJECT" "$RUN_TMP" "$TMP_DIR/home" "$RENEW_LOG" 2>/dev/null || true)
  [ -z "$hits" ] || { echo "VM ROUTE FAILED ($row): a credential canary appears in: $(echo $hits)" >&2; exit 1; }
}
# si_wait_warn ROW LINE: at least two exact WARN lines, and no seat-job yet.
si_wait_warn() {
  local n
  for n in $(seq 1 "$POSTFLIGHT_TIMEOUT_SEC"); do
    [ "$(grep -Fxc -- "$2" "$OUT" 2>/dev/null || true)" -ge 2 ] 2>/dev/null && break
    sleep 1
  done
  [ "$(grep -Fxc -- "$2" "$OUT" || true)" -ge 2 ] || vmr_fail "$1" "fewer than two lines '$2'"
  ! grep -q '"cmd":"seat-job"' "$PROJECT/.moe/evidence-rpcs.jsonl" 2>/dev/null || vmr_fail "$1" 'a seat-job ran with no credential'
}
# si_calls NEEDLE...: one escalation holding every needle, one claim, a re-lease per wait.
si_calls() {
  "$NODE" - "$CALLS" "$@" <<'JS'
const fs=require('fs'),a=require('node:assert/strict'),[f,...needles]=process.argv.slice(2),r=fs.readFileSync(f,'utf8').trim().split('\n').map(JSON.parse);
const sent=r.filter(x=>x.tool==='chat_send'&&x.args.content.includes('MOE_VM_CREDENTIAL_UNAVAILABLE'));
a.equal(sent.length,1,'not one escalation'); for(const n of needles) a.ok(sent[0].args.content.includes(n),'escalation lacks '+n);
a.equal(r.filter(x=>x.tool==='claim_next_task').length,1); a.ok(r.filter(x=>x.tool==='lease_account').length>=3,'no re-lease per wait');
JS
}
VMR_SETUP=si_fixture

echo '[seat sign-in] SI-signin: the job gets the sign-in access token; no host claude, file unchanged'
SI_FILE="$TOKEN 7200"
vmr_run SI-signin worker claude "$READY" on 0
si_clean SI-signin "$TOKEN" "$REFRESH"
[ "$VMR_CODE" = 0 ] || vmr_fail SI-signin "exit $VMR_CODE"; vmj_rows happy
[ "$(si_sha)" = "$(cat "$TMP_DIR/si.sha")" ] || vmr_fail SI-signin 'the sign-in file changed'
grep -Eq '^\[seat\] VM credential account=acct-1 source=signin expires=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\.[0-9]{3}Z$' "$OUT" \
  || vmr_fail SI-signin 'no source=signin line'
[ ! -e "$RENEW_LOG" ] || vmr_fail SI-signin 'a renewal ran'

echo '[seat sign-in] SI-renew: a token 60 s from expiry is renewed by one host claude run first'
"$NODE" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({accessToken:process.argv[2],refreshToken:process.argv[3]}))' "$RENEW_PAIR" "$TOKEN" "$REFRESH2"
SI_FILE="$OLD 60"
vmr_run SI-renew worker claude "$READY" on 0 FAKE_RENEW_FILE="$RENEW_PAIR"
si_clean SI-renew "$TOKEN" "$OLD" "$REFRESH" "$REFRESH2"
[ "$VMR_CODE" = 0 ] || vmr_fail SI-renew "exit $VMR_CODE"; vmj_rows happy
"$NODE" - "$RENEW_LOG" "$PROJECT" "$TMP_DIR/accounts/acct-1" <<'JS' || vmr_fail SI-renew 'not one renewal run with the renewal argv, cwd and env'
const fs=require('fs'),path=require('path'),a=require('node:assert/strict'),[log,project,dir]=process.argv.slice(2);
const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse); a.equal(rows.length,1);
const r=rows[0],t=r.argv.indexOf('--tools'); a.ok(r.argv.includes('-p')&&t>=0&&r.argv[t+1]==='');
a.ok(!r.argv.some(x=>x.includes('task-postflight'))); const rel=path.relative(project,r.cwd); a.ok(rel.startsWith('..')||path.isAbsolute(rel));
a.equal(r.configDir,dir); a.equal(r.hasMoeWorkerId,false); a.equal(r.hasPluginDirs,false);
JS

echo '[seat sign-in] SI-none: no credential holds the task with one escalation; a sign-in then runs it'
SI_FILE=""
vmj_background SI-none worker claude "$READY" on 0 MOE_ACCOUNT_RETRY_SEC=1
si_wait_warn SI-none '[WARN] MOE_VM_CREDENTIAL_UNAVAILABLE account=acct-1 reason=no-signin-file; retrying in 1s (Ctrl+C to stop)'
si_write "$TOKEN" "$REFRESH" 7200
wait "$VMJ_PID"
si_clean SI-none "$TOKEN" "$REFRESH"
[ "$(cat "$TMP_DIR/bg.code")" = 0 ] || vmr_fail SI-none 'retry failed'; vmj_rows happy
si_calls 'reason=no-signin-file' 'sign the account in again' || vmr_fail SI-none 'escalation, claim or re-lease count'

echo '[seat sign-in] SI-short: under an hour left waits; no renewal at 10 minutes, the job never gets it'
SI_FILE="$OLD 600"
vmj_background SI-short worker claude "$READY" on 0 MOE_ACCOUNT_RETRY_SEC=1
si_wait_warn SI-short '[WARN] MOE_VM_CREDENTIAL_UNAVAILABLE account=acct-1 reason=short-life; retrying in 1s (Ctrl+C to stop)'
si_write "$TOKEN" "$REFRESH" 7200
wait "$VMJ_PID"
si_clean SI-short "$TOKEN" "$OLD" "$REFRESH"
[ "$(cat "$TMP_DIR/bg.code")" = 0 ] || vmr_fail SI-short 'retry failed'; vmj_rows happy
[ ! -e "$RENEW_LOG" ] || vmr_fail SI-short 'a renewal ran at 10 minutes'
si_calls 'reason=short-life' 'sign the account in again' || vmr_fail SI-short 'escalation, claim or re-lease count'
echo '[seat sign-in] ok SI-signin, SI-renew, SI-none, SI-short'
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
echo '[seat job] VR-outage: a legacy launch outage ends when the VM route engages (task-cc4213c0)'
# Three legacy iterations launch the notification-only host CLI, which fails
# fast; the third enters the outage. The 4th readiness read is verified-local.
# Rotation off: a failed rotated claude run relaunches and zeroes the streak.
mkdir -p "$TMP_DIR/outage-bin"
printf '#!/usr/bin/env bash\nprintf %%s\\\\n %q >> %q\nexit 1\n' '{"tool":"host-cli","args":{}}' "$CALLS" > "$TMP_DIR/outage-bin/outage-cli"
chmod +x "$TMP_DIR/outage-bin/outage-cli"
VMR_ARGS=(--poll-interval 0); VMR_CMD="$TMP_DIR/outage-bin/outage-cli"
vmr_run VR-outage worker claude "$LEGACY" on 0 FAKE_CLAIM_MODE=idle FAKE_MENTION=1 FAKE_READINESS_AFTER="3:$READY" \
  MOE_ACCOUNT_ROTATION=off MOE_LAUNCH_BACKOFF_BASE_SEC=1 MOE_LAUNCH_BACKOFF_MAX_SEC=1
VMR_ARGS=(--no-loop --poll-interval 0)
"$NODE" - "$CALLS" "$OUT" "$PROJECT/.moe/evidence-rpcs.jsonl" "$PROJECT/.moe/messages/chan-general.jsonl" "$VMR_CODE" <<'JS' || vmr_fail VR-outage 'see the assertion above'
const fs=require('fs'),a=require('node:assert/strict'),[calls,out,ev,chat,rc]=process.argv.slice(2);
const read=(f)=>fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const text=fs.readFileSync(out,'utf8').replace(/\x1b\[[0-9;]*m/g,''),c=read(calls);
a.equal(rc,'0','exit code');
a.ok(text.includes('entering launch outage mode'),'the legacy iterations never entered the outage');
a.equal(text.split('launch outage over, claiming resumes.').length-1,1,'expected one outage-over line');
a.ok(text.includes('The verified-local VM route runs this seat\'s sessions in its VM, never the host CLI: launch outage over'),'no VM-route clear line');
a.ok(!text.includes('MOE_LAUNCH_PROBE'),'printed MOE_LAUNCH_PROBE');
const flip=c.map((r,i)=>r.tool==='get_execution_readiness'?i:-1).filter(i=>i>=0)[3];
a.ok(flip!==undefined,'no 4th get_execution_readiness read');
const host=c.map((r,i)=>r.tool==='host-cli'?i:-1).filter(i=>i>=0);
a.equal(host.length,3,'expected 3 host CLI launches'); a.ok(host.every(i=>i<flip),'a host CLI launched after the flip');
const claims=c.map((r,i)=>[r,i]).filter(([r])=>r.tool==='claim_next_task');
const before=claims.filter(([,i])=>i<flip),after=claims.filter(([,i])=>i>flip);
a.ok(before.length>0,'no legacy claim'); for(const [r] of before) a.ok(!('executionRoute' in r.args),'legacy claim was marked');
a.ok(after.length>0,'no claim after the flip'); for(const [r] of after) a.equal(r.args.executionRoute,'vm');
a.deepEqual(read(ev).filter(r=>r.tool==='agent-seat').map(r=>r.args.cmd),['seat-start','seat-stop']);
a.ok(fs.readFileSync(chat,'utf8').includes('after 3 host launch failures. Launch outage over: claiming resumes.'),'no #general outage-over line');
JS
vmr_one_reason VR-outage vm-route
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
echo '[seat job] PASS VR-happy, nonzero, R2, noclaim, qa-shared, protected, shared, qa, sigint, taskless, taskless-teamless, taskless-idle, outage, reload'
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

# --- [strong gate] CQ-M07r: under verified-local a worktree completion's L6 runs
# the task's owed checks in check VMs, the dispatch CLI on the frozen candidate
# commit (tree M, sole parent B), never the qualityGate on this host. Real wrapper,
# fake seat VM, fake dispatch CLI (postflight-fake-check-dispatch.js), real Git.
# The qualityGate is the canary: a host run writes SG_WITNESS.
(
SG_FAKE="$ROOT_DIR/scripts/tests/postflight-fake-check-dispatch.js"; SG_WITNESS="$TMP_DIR/sg-witness"
SG_READY='{"profile":"verified-local","ready":true,"missingCapabilities":[]}'
export MOE_AGENT_SEAT_PATH="$ROOT_DIR/scripts/tests/postflight-fake-agent-seat.js"
export GIT_AUTHOR_NAME=sg GIT_AUTHOR_EMAIL=sg@example.invalid GIT_COMMITTER_NAME=sg GIT_COMMITTER_EMAIL=sg@example.invalid
# OPENAI_API_KEY is the codex seat's VM credential; none may reach the dispatch.
export ANTHROPIC_API_KEY=sg-a ANTHROPIC_AUTH_TOKEN=sg-b CLAUDE_CODE_OAUTH_TOKEN=sg-c OPENAI_API_KEY=sg-d CODEX_API_KEY=sg-e
sg_fixture() {
  printf '.moe/\n.worktrees/\n.mcp.json\n' > "$PROJECT/.gitignore"
  printf 'seed\n' > "$PROJECT/seed.txt"
  git -C "$PROJECT" init -q -b main
  git -C "$PROJECT" add .gitignore seed.txt; git -C "$PROJECT" commit -qm seed
  git -C "$PROJECT" checkout -qb moe/control
  "$NODE" -e 'const fs=require("fs"),[p,w]=process.argv.slice(1),d=JSON.parse(fs.readFileSync(p));Object.assign(d.settings,{autoCommit:true,checkpointPush:false,commitBoardState:false,qualityGate:"printf ran > \x27"+w+"\x27"});fs.writeFileSync(p,JSON.stringify(d))' "$PROJECT/.moe/project.json" "$SG_WITNESS"
  rm -f "$SG_WITNESS"
  git -C "$PROJECT" rev-parse HEAD > "$TMP_DIR/sg-base"
  export FAKE_CLAIM_WORKSPACE='{"mode":"worktree","target":"main"}' FAKE_CTX_WORKSPACE='{"mode":"worktree","target":"main"}' FAKE_TASK_STATUS=REVIEW
}
# pe_fixture: sg_fixture plus the protected-entries files (task-ee10405f) on moe/control and
# main; PE_GITLINK=1 adds a gitlink under tests/. The U+00E9 name is built from its bytes.
pe_fixture() {
  local seed f
  sg_fixture; seed="$(git -C "$PROJECT" rev-parse HEAD)"
  mkdir -p "$PROJECT/scripts" "$PROJECT/tests/sub"
  for f in package-lock.json scripts/lint.sh scripts/other.sh tests/B.txt 'tests/a b.txt' tests/a.txt tests/sub/c.txt "$(printf 'tests/\303\251.txt')" unprotected.txt; do
    printf '%s\n' "$f" > "$PROJECT/$f"; git -C "$PROJECT" add -- "$f"
  done
  [ -z "${PE_GITLINK:-}" ] || git -C "$PROJECT" update-index --add --cacheinfo "160000,$seed,tests/mod"
  git -C "$PROJECT" commit -qm protected; git -C "$PROJECT" branch -f main HEAD
  git -C "$PROJECT" rev-parse HEAD > "$TMP_DIR/sg-base"
}
VMR_SETUP=sg_fixture
# sg_check ROW KIND CODE [ENV] -- KIND pass (the check VMs passed: main moved to C),
# host (legacy, observe: the host qualityGate ran, no dispatch) or refused (the line
# names CODE, plus ` environment=ENV` for a well-formed stop id; nothing published).
# SG_PAYLOAD (task-ee10405f), the record_candidate args: today (default: today's 8 keys and
# no protected-entries WARN), empty (protectedEntries []), unmeasured (today's keys and one
# 'non-blob entry' WARN) or a JSON list of the paths protectedEntries names, in order.
sg_check() {
  "$NODE" - "$PROJECT" "$OUT" "$REC" "$CALLS" "$SG_WITNESS" "$TMP_DIR/sg-base" "$SG_FAKE" "${SG_PAYLOAD:-today}" "$VMR_CODE" "$@" <<'JS' || vmr_fail "$1" 'see the assertion above'
const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process');
const [p,out,rec,calls,witness,baseFile,fake,payload,rc,row,kind,code,env]=process.argv.slice(2);
const read=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const ev=p+'/.moe/evidence-rpcs.jsonl',raw=fs.existsSync(ev)?fs.readFileSync(ev,'utf8'):'',rows=read(ev),tools=read(calls).map(r=>r.tool);
const text=fs.readFileSync(out,'utf8').replace(/\x1b\[[0-9;]*m/g,''),lines=text.split('\n'),count=l=>lines.filter(x=>x===l).length;
const git=(...x)=>cp.execFileSync('git',['-C',p,...x],{encoding:'utf8'}).trim(),B=fs.readFileSync(baseFile,'utf8').trim();
const main=git('rev-parse','refs/heads/main'),of=t=>rows.filter(r=>r.tool===t);
a.equal(rc,'0',row+' exit code'); a.equal(fs.existsSync(rec),false,'a host CLI ran');
a.ok(!raw.includes('DISPATCH-CANARY')&&!text.includes('DISPATCH-CANARY'),'the dispatch reply or stderr leaked');
a.ok(!text.includes('MOE_CHECK_DISPATCH_PATH_IGNORED'),'an unprotected override was ignored');
const cand=of('record_candidate'),d=of('check-dispatch'),done=of('record_commit').filter(r=>r.args.kind==='completion'),fin=of('finalize_attempt');
a.equal(cand.length,1,'record_candidate rows'); const M=cand[0].args.treeSha; a.equal(cand[0].args.baseRevision,B);
a.equal(of('record_delivery_receipt').length,kind==='pass'?1:0,'record_delivery_receipt rows');
const ca=cand[0].args,today=['taskId','attemptId','generation','workerId','id','baseRevision','treeSha','deliveryTarget'];
const warn=lines.filter(l=>l.includes('record_candidate: the protected check files'));
a.deepEqual(today.map(k=>ca[k]),['task-postflight','attempt-postflight',7,'worker-vmr',ca.id,B,M,'refs/heads/main'],'record_candidate values');
a.match(ca.id,/^\S+$/,'record_candidate id');
if(payload==='today'||payload==='unmeasured'){
  a.deepEqual(Object.keys(ca),today,'record_candidate keys');
  a.deepEqual(warn,payload==='today'?[]:[`[WARN] record_candidate: the protected check files of task task-postflight were not measured on tree ${M} (non-blob entry); the candidate is recorded without protectedEntries, so qa_approve will report protected-checks-unmeasured.`]);
} else {
  a.deepEqual(Object.keys(ca),[...today,'protectedEntries'],'record_candidate keys'); a.deepEqual(warn,[],'a protected-entries WARN');
  const want=payload==='empty'?[]:JSON.parse(payload);
  a.deepEqual(ca.protectedEntries.map(e=>JSON.stringify(e)),want.map(f=>JSON.stringify({path:f,oid:git('rev-parse',M+':'+f)})),'protectedEntries');
}
if(kind==='host'){
  a.equal(d.length,0,'the dispatch ran'); a.equal(fs.readFileSync(witness,'utf8'),'ran');
  const runs=of('record_check_run'); a.equal(runs.length,1); a.equal(runs[0].args.outcome,'passed'); a.equal(count('[OK] qualityGate passed.'),1);
} else {
  a.equal(fs.existsSync(witness),false,'the qualityGate ran on the host'); a.equal(of('record_check_run').length,0,'a host CheckRun');
  a.ok(!text.includes('Post-flight: quality gate:'),'the host gate started');
  if(code==='MOE_CHECK_DISPATCH_UNAVAILABLE') a.equal(d.length,0,'a missing CLI ran');
  else {
    a.equal(d.length,1,'check-dispatch rows'); const x=d[0].args,X=x.argv[5];
    a.match(X,/^[0-9a-f]{40}$/); a.deepEqual(x.argv,['--project',p,'--task','task-postflight','--commit',X]);
    a.equal(x.entry,fake); a.equal(x.tree,M); a.deepEqual(x.parents,[B]); a.equal(x.heads['refs/heads/main'],B);
    a.equal(x.candidateId,cand[0].args.id); a.deepEqual(x.credentials,[]);
    a.equal(git('for-each-ref','--contains',X),'','a ref holds the frozen candidate commit');
    const term=of('check-dispatch-term'); a.deepEqual(term.map(r=>r.args.pid),code==='MOE_CHECK_DISPATCH_TIMEOUT'?[x.pid]:[]);
  }
}
if(kind==='refused'){
  const v=code+(env?' environment='+env:'');
  a.equal(main,B,'main moved');
  a.equal(done.length,1); a.equal(done[0].args.outcome,'failed'); a.equal(done[0].args.code,'MOE_COMMIT_FAILED_GATE'); a.equal(done[0].args.pushed,false);
  a.equal(fin.length,1); a.equal(fin[0].args.outcome,'unlanded'); a.equal(fin[0].args.unlandedReason,'gate');
  a.equal(fin[0].args.targetTip,B); a.equal(fin[0].args.landedRevision,null);
  const retry=JSON.parse(fs.readFileSync(p+'/.moe/landing-retry.json','utf8')); a.equal(retry.reason,'gate'); a.equal(retry.count,1);
  a.equal(git('rev-parse',retry.rescueRef),git('rev-parse','refs/heads/moe/task/task-postflight'));
  a.equal(JSON.parse(fs.readFileSync(p+'/.moe/attempts/attempt-postflight.json','utf8')).phase,'closed');
  for(const t of ['set_task_status','complete_task','release_task','report_blocked','qa_approve','qa_reject']) a.ok(!tools.includes(t),t);
  a.equal(lines.filter(l=>l.includes('MOE_CHECK_DISPATCH_REFUSED')).length,1); a.equal(count('[WARN] MOE_CHECK_DISPATCH_REFUSED: '+v),1);
  a.equal(count(`[WARN] MOE_COMMIT_FAILED_GATE: task task-postflight -- the merged tree ${M} on ${B} was not frozen, recorded and passed by the check VMs (${v}); main did not move and the task's bytes stay on moe/task/task-postflight.`),1);
} else {
  a.notEqual(main,B); a.deepEqual(git('rev-list','--parents','-n','1',main).split(' ').slice(1),[B]); a.equal(git('rev-parse',main+'^{tree}'),M);
  a.equal(done.length,1); a.equal(done[0].args.outcome,'committed'); a.equal(done[0].args.sha,main);
  a.equal(fin.length,1); a.equal(fin[0].args.outcome,'landed'); a.equal(fin[0].args.landedRevision,main);
  if(kind==='pass'){
    a.notEqual(main,d[0].args.argv[5]); a.ok(rows.indexOf(d[0])<rows.indexOf(done[0])&&rows.indexOf(done[0])<rows.indexOf(fin[0]),'dispatch order');
    a.equal(count(`[OK] check VMs passed every owed check of candidate ${cand[0].args.id}.`),1); a.ok(!text.includes('MOE_CHECK_DISPATCH_REFUSED'));
    a.equal(fs.existsSync(p+'/.git/moe/receipt/task-postflight.json'),false,'the receipt journal stayed');
  }
}
JS
}
SG_STRONG=(FAKE_ATTEMPT_PROFILE=verified-local MOE_CHECK_DISPATCH_PATH="$SG_FAKE")
echo '[strong gate] SG-pass: the check VMs pass the frozen candidate; main moves to C; the host qualityGate never runs'
vmr_run SG-pass worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass
sg_check SG-pass pass
echo '[strong gate] SG-legacy, SG-observe: the host qualityGate runs (run_frozen_gate worktree), the override unused'
# The protected-entries contract (task-ee10405f): served to SG-legacy and SG-observe, whose
# record_candidate must still send today's 8 keys, and to PE-pass and PE-unmeasured below.
PE='{"requiredChecks":[{"id":"gate","command":"npm test","configs":["package-lock.json","vm-job.txt"],"assertionRoots":["tests"]},{"id":"lint","command":"npm run lint","configs":["package-lock.json"],"scripts":["scripts/lint.sh","scripts/gone.sh"]}]}'
vmr_run SG-legacy worker codex "$SG_READY" on 0 MOE_CHECK_DISPATCH_PATH="$SG_FAKE" FAKE_CHECK_DISPATCH=pass FAKE_CTX_CONTRACT="$PE"
sg_check SG-legacy host
vmr_run SG-observe worker codex "$SG_READY" on 0 FAKE_ATTEMPT_PROFILE=observe MOE_CHECK_DISPATCH_PATH="$SG_FAKE" FAKE_CHECK_DISPATCH=pass FAKE_CTX_CONTRACT="$PE"
sg_check SG-observe host
echo '[strong gate] PE-pass, PE-empty, PE-unmeasured: a strong record_candidate carries the candidate tree'"'"'s protected entries'
VMR_SETUP=pe_fixture
vmr_run PE-pass worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_CTX_CONTRACT="$PE"
SG_PAYLOAD='["package-lock.json","scripts/lint.sh","tests/B.txt","tests/a b.txt","tests/a.txt","tests/sub/c.txt","tests/é.txt","vm-job.txt"]' \
  sg_check PE-pass pass
PE_GITLINK=1
vmr_run PE-unmeasured worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_CTX_CONTRACT="$PE"
SG_PAYLOAD=unmeasured sg_check PE-unmeasured pass
PE_GITLINK=""; VMR_SETUP=sg_fixture
vmr_run PE-empty worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_CTX_CONTRACT='{"requiredChecks":[{"id":"gate","command":"true"}]}'
SG_PAYLOAD=empty sg_check PE-empty pass
echo '[strong gate] every non-pass fails the round as MOE_COMMIT_FAILED_GATE: main stays at B, one fixed-code line'
SG_HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SG_ENV="moe-local-vm-v1:$SG_HEX"; SG_ENV_UPPER="moe-local-vm-v1:$(printf %s "$SG_HEX" | tr a-f A-F)"
# ROW|CODE|ENV|fake knobs. ENV is the environment id the line must name, if any.
SG_ROWS=("SG-nonzero|MOE_CHECK_DISPATCH_NOT_PASSED||FAKE_CHECK_DISPATCH=not-passed"
  "SG-stopped|RUNNER_VM_DELETE_FAILED||FAKE_CHECK_DISPATCH=stopped FAKE_CHECK_DISPATCH_CODE=RUNNER_VM_DELETE_FAILED"
  "SG-nothing-owed|RUNNER_NOTHING_OWED||FAKE_CHECK_DISPATCH=stopped FAKE_CHECK_DISPATCH_CODE=RUNNER_NOTHING_OWED"
  "SG-undeclared|RUNNER_DEPENDENCIES_UNDECLARED||FAKE_CHECK_DISPATCH=stopped FAKE_CHECK_DISPATCH_CODE=RUNNER_DEPENDENCIES_UNDECLARED"
  "SG-crash|MOE_CHECK_DISPATCH_NO_REPORT||FAKE_CHECK_DISPATCH=crash"
  "SG-unparsable|MOE_CHECK_DISPATCH_REPLY_INVALID||FAKE_CHECK_DISPATCH=garbage"
  "SG-env|RUNNER_ENVIRONMENT_NOT_APPROVED|$SG_ENV|FAKE_CHECK_DISPATCH=stopped FAKE_CHECK_DISPATCH_CODE=RUNNER_ENVIRONMENT_NOT_APPROVED FAKE_CHECK_DISPATCH_ENVIRONMENT=$SG_ENV"
  "SG-env-malformed|RUNNER_ENVIRONMENT_NOT_APPROVED||FAKE_CHECK_DISPATCH=stopped FAKE_CHECK_DISPATCH_CODE=RUNNER_ENVIRONMENT_NOT_APPROVED FAKE_CHECK_DISPATCH_ENVIRONMENT=$SG_ENV_UPPER")
for r in "${SG_ROWS[@]}"; do
  IFS='|' read -r row code env extra <<< "$r"; read -ra kv <<< "$extra"
  vmr_run "$row" worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" "${kv[@]}"
  sg_check "$row" refused "$code" "$env"
done
vmr_run SG-missing worker codex "$SG_READY" on 0 FAKE_ATTEMPT_PROFILE=verified-local MOE_CHECK_DISPATCH_PATH="$TMP_DIR/no-such-dispatch.js"
sg_check SG-missing refused MOE_CHECK_DISPATCH_UNAVAILABLE
SECONDS=0
vmr_run SG-timeout worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=hang MOE_CHECK_DISPATCH_TIMEOUT_SEC=2
[ "$SECONDS" -lt 60 ] || vmr_fail SG-timeout "the timed-out dispatch took ${SECONDS}s to stop"
sg_check SG-timeout refused MOE_CHECK_DISPATCH_TIMEOUT
echo '[strong gate] SG-protected: MOE_CHECK_DISPATCH_PATH is ignored under MOE_RUNTIME_PROTECTED=1, and never printed'
VMR_CMD=claude
vmr_run SG-protected worker claude '{"profile":"verified-local","ready":false,"missingCapabilities":[]}' on 0 MOE_RUNTIME_PROTECTED=1 \
  MOE_DAEMON_PATH="$TMP_DIR/fake-daemon.js" MOE_CHECK_DISPATCH_PATH="$SG_FAKE"
[ "$VMR_CODE" = 1 ] && [ "$(grep -c MOE_CHECK_DISPATCH_PATH_IGNORED "$OUT")" = 1 ] \
  && [ "$(grep -Fxc '[WARN] MOE_CHECK_DISPATCH_PATH_IGNORED: MOE_CHECK_DISPATCH_PATH is ignored under MOE_RUNTIME_PROTECTED=1; only the bundled local-runner/check-dispatch.mjs runs.' "$OUT")" = 1 ] \
  || vmr_fail SG-protected 'the override was not ignored with one warning'
! grep -Fq "$SG_FAKE" "$OUT" || vmr_fail SG-protected 'the override value was printed'
echo "[strong gate] ok SG-pass, legacy, observe, PE-pass, PE-unmeasured, PE-empty, nonzero, stopped, nothing-owed, undeclared, missing, crash, unparsable, env, env-malformed, timeout, protected"
echo '[strong gate] SG-interrupt: a wrapper TERMed mid-dispatch stops the dispatch from its EXIT trap (cleanup_temp), before finalize'
# The dispatch entry runs the hang fake, then TERMs its own parent, the wrapper,
# once and only while that is still the parent that spawned it (never a reaper).
printf '%s\n' 'const w = process.ppid; require(process.env.SG_FAKE_JS);' \
  'setTimeout(() => { if (w > 1 && process.ppid === w) process.kill(w, "SIGTERM"); }, 1000);' > "$TMP_DIR/sg-interrupt.js"
vmr_run SG-interrupt worker codex "$SG_READY" on 0 FAKE_ATTEMPT_PROFILE=verified-local MOE_CHECK_DISPATCH_PATH="$TMP_DIR/sg-interrupt.js" \
  SG_FAKE_JS="$SG_FAKE" FAKE_CHECK_DISPATCH=hang
SG_PID="$("$NODE" -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).find(x=>x.tool==="check-dispatch");console.log(r?r.args.pid:"")' "$PROJECT/.moe/evidence-rpcs.jsonl" 2>/dev/null || true)"
# A probe only: should the fake outlive the wrapper, this run's own recorded child is killed.
if [ -n "$SG_PID" ] && kill -0 "$SG_PID" 2>/dev/null; then kill -KILL "$SG_PID" 2>/dev/null || true; vmr_fail SG-interrupt "the dispatch $SG_PID outlived the wrapper"; fi
"$NODE" - "$PROJECT" "$OUT" "$SG_WITNESS" "$TMP_DIR/sg-base" "$VMR_CODE" <<'JS' || vmr_fail SG-interrupt 'see the assertion above'
const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process'),[p,out,witness,baseFile,rc]=process.argv.slice(2);
const rows=fs.readFileSync(p+'/.moe/evidence-rpcs.jsonl','utf8').trim().split('\n').map(JSON.parse),of=t=>rows.filter(r=>r.tool===t);
const d=of('check-dispatch'),term=of('check-dispatch-term'),fin=rows.findIndex(r=>r.tool==='finalize_attempt');
a.equal(rc,'0'); a.ok(fs.readFileSync(out,'utf8').split('\n').includes('Agent stopped.'),'the TERM trap did not run');
a.equal(d.length,1); a.deepEqual(term.map(r=>r.args.pid),[d[0].args.pid],'not one TERM to the dispatch');
a.ok(fin>=0&&rows.indexOf(term[0])<fin,'the attempt was not finalized after the dispatch stopped'); a.equal(fs.existsSync(witness),false,'the host gate ran');
a.equal(cp.execFileSync('git',['-C',p,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim(),fs.readFileSync(baseFile,'utf8').trim(),'main moved');
JS
echo "[strong gate] ok SG-interrupt"

echo '[strong gate] SGV: check_dispatch_verdict prints PASS or one fixed code, never the reply'
SGV="$TMP_DIR/sgv"; mkdir -p "$SGV"
{ printf '%s\n' 'set -e'; vmc_slice check_dispatch_verdict; printf '%s\n' 'check_dispatch_verdict "$1" "$2" task-v cand-v'; } > "$SGV/driver.sh"
# sgv ROW RC EXPECTED BYTES -- the reply file holds exactly BYTES; the dispatch exited RC.
sgv() {
  local got
  printf %s "$4" > "$SGV/reply"
  got="$(env PYTHON_CMD="$PY" bash "$SGV/driver.sh" "$SGV/reply" "$2" 2>&1)" || vmc_fail "$1" "the driver failed: $got"
  [ "$got" = "$3" ] || vmc_fail "$1" "got '$got', expected '$3'"
}
SGV_NL=$'\n'; SGV_BAD=MOE_CHECK_DISPATCH_REPLY_INVALID; SGV_ID="moe-local-vm-v1:$SG_HEX"
SGV_RESULT='{"command":"qualityGate","dispatchId":"dispatch-v","outcome":"passed","vm":"deleted","failure":null}'
SGV_PASS='{"taskId":"task-v","candidateId":"cand-v","results":['"$SGV_RESULT"']}'
sgv_env() { printf '{"taskId":"task-v","candidateId":"cand-v","results":[],"stopped":{"code":"RUNNER_ENVIRONMENT_NOT_APPROVED","environment":%s}}\n' "$1"; }
sgv V-empty 0 MOE_CHECK_DISPATCH_NO_REPORT ''
sgv V-empty-rc3 3 MOE_CHECK_DISPATCH_NO_REPORT ''
sgv V-not-json 0 "$SGV_BAD" "not json$SGV_NL"
sgv V-array 0 "$SGV_BAD" "[1]$SGV_NL"
sgv V-not-utf8 0 "$SGV_BAD" $'\377'"$SGV_NL"
sgv V-pass 0 PASS "$SGV_PASS$SGV_NL"
sgv V-pass-bare 0 PASS "$SGV_PASS"
sgv V-pass-rc2 2 MOE_CHECK_DISPATCH_NOT_PASSED "$SGV_PASS$SGV_NL"
sgv V-other-candidate 0 "$SGV_BAD" '{"taskId":"task-v","candidateId":"cand-other","results":['"$SGV_RESULT"']}'"$SGV_NL"
sgv V-other-task 0 "$SGV_BAD" '{"taskId":"task-other","candidateId":"cand-v","results":['"$SGV_RESULT"']}'"$SGV_NL"
sgv V-no-results 0 "$SGV_BAD" '{"taskId":"task-v","candidateId":"cand-v","results":[]}'"$SGV_NL"
sgv V-results-object 0 "$SGV_BAD" '{"taskId":"task-v","candidateId":"cand-v","results":{"outcome":"passed"}}'"$SGV_NL"
sgv V-log-line 0 "$SGV_BAD" "dispatch log$SGV_NL$SGV_PASS$SGV_NL"
# Two more one-line rules json.loads alone would let through: an indented reply, a CR.
sgv V-indented 0 "$SGV_BAD" '{"taskId":"task-v",'"$SGV_NL"'"candidateId":"cand-v","results":['"$SGV_RESULT"']}'"$SGV_NL"
sgv V-crlf 0 "$SGV_BAD" "$SGV_PASS"$'\r\n'
# Only ONE trailing newline is dropped, so a blank second line is still a second line.
sgv V-two-newlines 0 "$SGV_BAD" "$SGV_PASS$SGV_NL$SGV_NL"
sgv V-stop-beats-rc0 0 RUNNER_NOTHING_OWED '{"taskId":"task-v","candidateId":"cand-v","results":[],"stopped":{"code":"RUNNER_NOTHING_OWED"}}'"$SGV_NL"
sgv V-stop-lower 2 "$SGV_BAD" '{"stopped":{"code":"lower case"}}'"$SGV_NL"
sgv V-code 2 RUNNER_SEAM_UNAVAILABLE '{"code":"RUNNER_SEAM_UNAVAILABLE"}'"$SGV_NL"
sgv V-code-bad 2 "$SGV_BAD" '{"code":"bad code"}'"$SGV_NL"
sgv V-stop-and-code 2 RUNNER_CHECK_FAILED '{"code":"RUNNER_SEAM_UNAVAILABLE","stopped":{"code":"RUNNER_CHECK_FAILED"}}'"$SGV_NL"
sgv V-env 2 "RUNNER_ENVIRONMENT_NOT_APPROVED environment=$SGV_ID" "$(sgv_env "\"$SGV_ID\"")$SGV_NL"
# Per mem:decision-verified-local-check-gate item 5: a dropped anchor survives until a leading-text row exists.
for bad in "\"x$SGV_ID\"" "\"$SGV_ID\\n\"" "\"$SG_ENV_UPPER\"" "\"moe-local-vm-v1:${SG_HEX:1}\"" 7 null; do
  sgv "V-env-malformed $bad" 2 RUNNER_ENVIRONMENT_NOT_APPROVED "$(sgv_env "$bad")$SGV_NL"
done
# The 1 MiB bound: a pass padded with trailing spaces stays valid JSON when cut at
# the bound, so only the size rule refuses its one byte over.
sgv V-at-limit 0 PASS "$SGV_PASS$(printf '%*s' $((1048575 - ${#SGV_PASS})) '')$SGV_NL"
sgv V-oversize 0 "$SGV_BAD" "$SGV_PASS$(printf '%*s' $((1048576 - ${#SGV_PASS})) '')$SGV_NL"

echo '[strong gate] SGU: run_check_dispatch sliced: the bundled CLI, the override, the bound, the stop, the project top'
SGU="$TMP_DIR/sgu"; SGU_DRIVER="$SGU/driver.sh"; SGU_EV="$SGU/project/.moe/evidence-rpcs.jsonl"; SGU_STUB="$SGU/scripts/local-runner/check-dispatch.mjs"
mkdir -p "$SGU/project/.moe/candidates" "$SGU/sec" "$SGU/scripts/local-runner"
printf 'sgu\n' > "$SGU/project/a.txt"; git -C "$SGU/project" init -q; git -C "$SGU/project" add a.txt; git -C "$SGU/project" commit -qm sgu
SGU_C="$(git -C "$SGU/project" rev-parse HEAD)"
printf '{"id":"cand-sgu","taskId":"task-sgu","treeSha":"%s","createdAt":"2026-11-04T00:00:00.000Z"}\n' \
  "$(git -C "$SGU/project" rev-parse 'HEAD^{tree}')" > "$SGU/project/.moe/candidates/cand-sgu.json"
# The bundled path under SCRIPT_DIR: an ESM stub that runs the same fake, so its row's entry names the stub.
printf '%s\n' "import { createRequire } from 'node:module';" 'createRequire(import.meta.url)(process.env.SGU_FAKE);' > "$SGU_STUB"
{ printf '%s\n' 'set -e' 'CHECK_DISPATCH_GRACE_SEC="${SGU_GRACE:-120}"'
  vmc_slice resolve_check_dispatch_cli run_check_dispatch stop_check_dispatch check_dispatch_verdict heartbeat_sidecar_running land_lease_budget
  # The wrapper's own traps: INT and TERM exit 0, and the EXIT trap (cleanup_temp) stops a running dispatch.
  printf '%s\n' "trap 'exit 0' INT TERM" "trap 'stop_check_dispatch || true' EXIT" \
    'resolve_check_dispatch_cli; rc=0; run_check_dispatch || rc=$?; echo "rc=$rc code=$CHECK_DISPATCH_CODE"'; } > "$SGU_DRIVER"
SGU_ENV=(PYTHON_CMD="$PY" NODE_CMD="$NODE" PROJECT="$SGU/project" LAND_TASK_ID=task-sgu FROZEN_COMMIT="$SGU_C" FROZEN_CANDIDATE_ID=cand-sgu
  SCRIPT_DIR="$SGU/scripts" SECURE_TEMP_DIR="$SGU/sec" RUNTIME_PROTECTED=0 MOE_REL= BLUE= GREEN= NC= SGU_FAKE="$SG_FAKE")
# sgu ROW EXPECTED [VAR=VALUE...] -- one driver run (its output in $SGU/out); the last line must be EXPECTED.
sgu() {
  local row="$1" want="$2" got; shift 2
  rm -f "$SGU_EV"
  env "${SGU_ENV[@]}" "$@" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" bash "$SGU_DRIVER" > "$SGU/out" 2>&1 || vmc_fail "$row" "the driver failed: $(cat "$SGU/out")"
  got="$(tail -n 1 "$SGU/out")"
  [ "$got" = "$want" ] || vmc_fail "$row" "got '$got', expected '$want': $(cat "$SGU/out")"
}
# sgu_pid ROW -- the fake's recorded pid; sgu_terms -- how many SIGTERMs it recorded.
sgu_pid() { "$NODE" -e 'console.log(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).find(r=>r.tool==="check-dispatch").args.pid)' "$SGU_EV"; }
sgu_terms() { grep -c '"tool":"check-dispatch-term"' "$SGU_EV" || true; }
# sgu_dead ROW PID -- a probe only: the wrapper's stop must have ended the fake. Should
# it survive, this run's own recorded child is killed, so a failure leaks nothing.
sgu_dead() { if kill -0 "$2" 2>/dev/null; then kill -KILL "$2" 2>/dev/null || true; vmc_fail "$1" "the dispatch $2 outlived its stop"; fi; }
# sgu_row ROW ENTRY -- exactly one dispatch ran, from ENTRY, on FROZEN_COMMIT, with no credential.
sgu_row() {
  "$NODE" - "$SGU_EV" "$2" "$SGU/project" "$SGU_C" <<'JS' || vmc_fail "$1" 'see the assertion above'
const fs=require('node:fs'),a=require('node:assert/strict'),[ev,entry,p,c]=process.argv.slice(2);
const rows=fs.readFileSync(ev,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.tool==='check-dispatch');
a.equal(rows.length,1); a.equal(rows[0].args.entry,entry); a.deepEqual(rows[0].args.credentials,[]);
a.deepEqual(rows[0].args.argv,['--project',p,'--task','task-sgu','--commit',c]); a.equal(rows[0].args.candidateId,'cand-sgu');
JS
}
SGU_IGNORED='[WARN] MOE_CHECK_DISPATCH_PATH_IGNORED: MOE_CHECK_DISPATCH_PATH is ignored under MOE_RUNTIME_PROTECTED=1; only the bundled local-runner/check-dispatch.mjs runs.'
sgu U1 'rc=1 code=RUNNER_SEAM_UNAVAILABLE' FAKE_CHECK_DISPATCH=code FAKE_CHECK_DISPATCH_CODE=RUNNER_SEAM_UNAVAILABLE
sgu_row U1 "$SGU_STUB"; ! grep -q MOE_CHECK_DISPATCH_PATH_IGNORED "$SGU/out" || vmc_fail U1 'an IGNORED line without an override'
sgu U2 'rc=0 code=' MOE_CHECK_DISPATCH_PATH="$SG_FAKE" FAKE_CHECK_DISPATCH=pass
sgu_row U2 "$SG_FAKE"
[ "$(grep -Fxc '[OK] check VMs passed every owed check of candidate cand-sgu.' "$SGU/out")" = 1 ] || vmc_fail U2 'not one [OK] line'
sgu U3 'rc=0 code=' RUNTIME_PROTECTED=1 MOE_CHECK_DISPATCH_PATH="$SG_FAKE" FAKE_CHECK_DISPATCH=pass
sgu_row U3 "$SGU_STUB"
[ "$(grep -c MOE_CHECK_DISPATCH_PATH_IGNORED "$SGU/out")" = 1 ] && [ "$(grep -Fxc "$SGU_IGNORED" "$SGU/out")" = 1 ] \
  || vmc_fail U3 'not exactly one MOE_CHECK_DISPATCH_PATH_IGNORED line'
! grep -Fq "$SG_FAKE" "$SGU/out" || vmc_fail U3 'the override path was printed'
for bound in 0 -1 abc 86401 1.0001; do
  sgu "U4 $bound" 'rc=1 code=MOE_CHECK_DISPATCH_TIMEOUT_INVALID' MOE_CHECK_DISPATCH_TIMEOUT_SEC="$bound" FAKE_CHECK_DISPATCH=pass
  [ ! -e "$SGU_EV" ] || vmc_fail "U4 $bound" 'the dispatch ran'
done
SECONDS=0
sgu U5 'rc=1 code=MOE_CHECK_DISPATCH_TIMEOUT' SGU_GRACE=1 MOE_CHECK_DISPATCH_TIMEOUT_SEC=1 FAKE_CHECK_DISPATCH=hang-hard
sgu_dead U5 "$(sgu_pid)"; [ "$SECONDS" -le 15 ] || vmc_fail U5 "the TERM-ignoring dispatch took ${SECONDS}s to stop"
[ "$(sgu_terms)" = 1 ] || vmc_fail U5 "got $(sgu_terms) TERMs, expected one before the KILL"
# U7: TERM the wrapper (the driver) during the timeout's grace. Its EXIT trap still
# finishes the stop: no second TERM (check-dispatch.mjs handles one, and a second
# would end its VM deletion), then the KILL. Bounded by a watchdog on our own PID.
rm -f "$SGU_EV"
env "${SGU_ENV[@]}" SGU_GRACE=5 MOE_CHECK_DISPATCH_TIMEOUT_SEC=1 FAKE_CHECK_DISPATCH=hang-hard bash "$SGU_DRIVER" > "$SGU/out" 2>&1 & SGU_BG=$!
(sleep "$POSTFLIGHT_TIMEOUT_SEC"; kill -KILL "$SGU_BG" 2>/dev/null || true) >/dev/null 2>&1 & SGU_WATCH=$!
n=0; until [ "$(sgu_terms 2>/dev/null)" = 1 ]; do n=$((n + 1)); [ "$n" -lt "$POSTFLIGHT_TIMEOUT_SEC" ] || break; sleep 1; done
kill -TERM "$SGU_BG" 2>/dev/null || true; rc=0; wait "$SGU_BG" || rc=$?
kill "$SGU_WATCH" 2>/dev/null || true; wait "$SGU_WATCH" 2>/dev/null || true
sgu_dead U7 "$(sgu_pid)"
[ "$rc" = 0 ] && [ "$(sgu_terms)" = 1 ] || vmc_fail U7 "exit $rc and $(sgu_terms) TERMs, expected exit 0 and one: $(cat "$SGU/out")"
sgu U6 'rc=1 code=MOE_WORKTREE_PROJECT_NOT_TOP' MOE_REL=sub FAKE_CHECK_DISPATCH=pass
[ ! -e "$SGU_EV" ] || vmc_fail U6 'the dispatch ran'
[ "$(grep -Fxc '[WARN] MOE_WORKTREE_PROJECT_NOT_TOP: a worktree-mode qualityGate needs the project at the repository top; refusing branch commit.' "$SGU/out")" = 1 ] \
  || vmc_fail U6 'not one MOE_WORKTREE_PROJECT_NOT_TOP line'

echo '[strong gate] SG8: L6 takes the check VMs only for the strong profile, before wt_strong_intent'
sg8_line() { printf '%s\n' "$BODY" | grep -n -x -F -e "$1" | cut -d: -f1 || true; }
[ "$(printf '%s\n' "$BODY" | grep -c run_check_dispatch)" = 1 ] && [ "$(printf '%s\n' "$BODY" | grep -c strong_landing_task)" = 1 ] \
  || vmc_fail SG8 'wt_land_rounds does not name run_check_dispatch and strong_landing_task exactly once each'
SG8_IF="$(sg8_line '        if [ -n "${QUALITY_GATE:-}" ] && [ -n "${LAND_TASK_ID:-}" ] && strong_landing_task "$LAND_TASK_ID"; then')"
SG8_ELIF="$(sg8_line '        elif [ -n "${QUALITY_GATE:-}" ] && ! { freeze_candidate "$b" "$m" && run_frozen_gate worktree; }; then')"
SG8_RUN="$(gline run_check_dispatch)"; SG8_SI="$(gline 'wt_strong_intent "$m" "$b" || return 1')"
[[ "$SG8_IF" =~ ^[0-9]+$ && "$SG8_ELIF" =~ ^[0-9]+$ && "$SG8_RUN" =~ ^[0-9]+$ && "$SG8_SI" =~ ^[0-9]+$ ]] \
  && [ "$SG8_IF" -lt "$SG8_RUN" ] && [ "$SG8_RUN" -lt "$SG8_ELIF" ] && [ "$SG8_ELIF" -lt "$SG8_SI" ] \
  || vmc_fail SG8 "got strong=$SG8_IF run_check_dispatch=$SG8_RUN legacy=$SG8_ELIF intent=$SG8_SI, expected that order, each line exactly once"
echo "[strong gate] ok SGV, SGU U1-U7 and SG8"

# --- [strong receipt] CQ-M07t: a strong worktree landing sends its delivery receipt
# after the publish and before finalize_attempt; an unanswered one defers the
# finalize to the next pre-flight replay. Same fixture as [strong gate].
echo '[strong receipt] T1-T5: the receipt between the completion row and finalize_attempt, the deferral and its replay, the replay with its finalize refused or its attempt running, a conflict, the legacy control, a conflict with every finalize lost and its replay'
# sr_check ROW KIND -- KIND pass (T1), conflict (T3), deferred (T2's landing: the receipt
# refused), replay (T2's next pre-flight, run 1's RPC rows first), legacy (T4:
# finalize_attempt refused, so the journal it wrote today stays to be read), lost (T5:
# a conflict, then every finalize lost), lost-replay (T5's next pre-flight), or
# refused / running (T2's next pre-flight with the replayed finalize refused, or the kept
# attempt read as running; the journal stays either way).
sr_check() {
  "$NODE" - "$PROJECT" "$OUT" "$TMP_DIR/sg-base" "$VMR_CODE" "$@" <<'JS' || vmr_fail "$1" 'see the assertion above'
const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process'),[p,out,baseFile,rc,row,kind]=process.argv.slice(2);
const rows=fs.readFileSync(p+'/.moe/evidence-rpcs.jsonl','utf8').trim().split('\n').map(JSON.parse),of=t=>rows.filter(r=>r.tool===t),at=r=>rows.indexOf(r);
const lines=fs.readFileSync(out,'utf8').replace(/\x1b\[[0-9;]*m/g,'').split('\n'),count=f=>lines.filter(f).length;
const B=fs.readFileSync(baseFile,'utf8').trim(),C=cp.execFileSync('git',['-C',p,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim();
const jf=p+'/.git/moe/receipt/task-postflight.json',phase=JSON.parse(fs.readFileSync(p+'/.moe/attempts/attempt-postflight.json','utf8')).phase;
const cand=of('record_candidate'),done=of('record_commit').filter(r=>r.args.kind==='completion'),rec=of('record_delivery_receipt'),fin=of('finalize_attempt');
const today=['taskId','workerId','attemptId','generation','sessionId','workspaceMode','publicationMode','target','targetBefore','targetAfter','landedRevision','worktree','taskBranch','ledger'];
a.equal(rc,'0',row+' exit code'); a.equal(cand.length,1,'record_candidate rows'); a.notEqual(C,B,'main did not move');
a.equal(done[0].args.outcome,'committed'); a.equal(done[0].args.sha,C);
const deferred=count(l=>l.includes('MOE_FINALIZE_DEFERRED_RECEIPT')),kept=count(l=>l.startsWith('[WARN] receipt journal ')&&l.includes(' kept: '));
if(kind==='legacy'){
  a.equal(rec.length,0,'a non-strong landing sent a receipt'); a.ok(fin.length>0&&fin.every(r=>r.args.outcome==='landed')); a.equal(deferred,0);
  a.equal(count(l=>l.startsWith('[WARN] receipt journal ')&&l.endsWith(' kept: the completion row or finalize_attempt got no answer; the next pre-flight replays it.')),1);
  a.deepEqual(Object.keys(JSON.parse(fs.readFileSync(jf,'utf8'))),today,'the legacy journal keys');
  process.exit(0);
}
const id=cand[0].args.id,want={candidateId:id,target:'refs/heads/main',targetBefore:B,targetAfter:C,landedRevision:C,workerId:'worker-vmr'};
a.ok(rec.length>0,'no receipt'); a.deepEqual(rec[0].args,want,'the receipt'); a.ok(at(done[0])<at(rec[0]),'the receipt precedes the completion row');
const conflict='[WARN] candidate '+id+' already has a delivery receipt that differs from this report; keeping the recorded one, not retrying.';
a.equal(count(l=>l===conflict),['conflict','lost','lost-replay'].includes(kind)?1:0,'conflict lines');
const strongJournal=()=>{
  const j=JSON.parse(fs.readFileSync(jf,'utf8'));
  a.deepEqual(Object.keys(j),[...today,'candidateId','treeSha','baseRevision','planRevision','profile'],'the strong journal keys');
  a.deepEqual([j.candidateId,j.treeSha,j.baseRevision,j.planRevision,j.profile,j.targetBefore,j.targetAfter,j.landedRevision,j.target],
    [id,cand[0].args.treeSha,B,1,'verified-local',B,C,C,'refs/heads/main'],'the strong journal fields');
};
if(kind==='deferred'){
  a.equal(rec.length,1); a.equal(fin.length,0,'finalized before the receipt was recorded'); a.equal(phase,'finalizing'); a.equal(deferred,1); a.equal(kept,1);
  a.equal(count(l=>l==='[WARN] MOE_FINALIZE_DEFERRED_RECEIPT: task task-postflight -- the delivery receipt of '+C+' is not recorded; the attempt stays finalizing until a pre-flight replay records it, then finalizes.'),1);
  a.equal(count(l=>l.startsWith('[WARN] delivery receipt not recorded for candidate '+id+'; journal kept at ')),1);
  strongJournal();
  process.exit(0);
}
// lost (T5): a receipt conflict, then every finalize lost; the strong journal stays (task-a1f3723f).
if(kind==='lost'){
  a.equal(rec.length,1); a.equal(fin.length,3,'one exhausted finalize_attempt');
  a.ok(fin.every(r=>r.args.outcome==='landed'&&r.args.landedRevision===C),'the lost finalizes'); a.ok(at(rec[0])<at(fin[0]),'finalize_attempt precedes the receipt');
  a.equal(phase,'finalizing'); a.equal(deferred,0,'a conflict deferred the finalize');
  a.equal(count(l=>l.startsWith('[WARN] receipt journal ')&&l.endsWith(' kept: its completion row, delivery receipt or closed attempt is not recorded yet; the next pre-flight replays it.')),1);
  a.equal(count(l=>l==='[WARN] finalize_attempt acknowledgement exhausted; stopping new-task loop (no repeated Git effect).'),1);
  strongJournal(); a.equal(fs.existsSync(p+'/.moe/receipts/'+id+'.json'),false,'a conflict stored a receipt');
  process.exit(0);
}
// lost-replay (T5's next pre-flight): the conflict again, the finalize answered; the attempt closes and the journal goes.
if(kind==='lost-replay'){
  a.equal(rec.length,2); a.equal(JSON.stringify(rec[1].args),JSON.stringify(rec[0].args),'the replay did not re-send the journaled receipt');
  a.equal(count(l=>l.startsWith('[receipt] replaying the delivery receipt of task task-postflight from ')),1);
  a.equal(fin.length,4,'finalize_attempt rows'); const f=fin.at(-1).args,f0=fin[0].args;
  a.deepEqual([f.outcome,f.landedRevision,f.attemptId,f.generation,f.workerId],['landed',C,f0.attemptId,f0.generation,f0.workerId],'the replayed finalize');
  a.ok(at(rec.at(-1))<at(fin.at(-1)),'finalize_attempt precedes the replayed receipt'); a.equal(phase,'closed'); a.equal(fs.existsSync(jf),false,'the receipt journal stayed');
  a.equal(kept,0); a.equal(deferred,0); a.equal(of('check-dispatch').length,1,'the replay dispatched again');
  a.equal(fs.existsSync(p+'/.moe/receipts/'+id+'.json'),false,'a conflict stored a receipt');
  process.exit(0);
}
// refused / running (T2's next pre-flight with the finalize refused, or the attempt read as running): the
// receipt is re-sent and the strong journal stays byte for byte (task-9194f182).
if(kind==='refused'||kind==='running'){
  const keep=fs.readFileSync(require('node:path').dirname(baseFile)+'/sr-keep/.git/moe/receipt/task-postflight.json','utf8');
  const lost='[WARN] attempt attempt-postflight is still finalizing after its replayed receipt; its finalizing holds stay until it closes.';
  const open=count(l=>l.startsWith('[WARN] receipt journal ')&&l.endsWith(' kept: attempt attempt-postflight of task task-postflight is running, not closed; nothing finalized.'));
  a.equal(rec.length,2,'record_delivery_receipt rows'); a.equal(JSON.stringify(rec[1].args),JSON.stringify(rec[0].args),'the replay did not re-send the journaled receipt');
  a.equal(of('check-dispatch').length,1,'the replay dispatched again'); a.equal(deferred,0);
  a.equal(count(l=>l.startsWith('[receipt] replaying the delivery receipt of task task-postflight from ')),1);
  a.equal(fs.existsSync(jf)&&fs.readFileSync(jf,'utf8'),keep,'the strong journal was not kept byte for byte');
  if(kind==='refused'){
    a.equal(fin.length,3,'finalize_attempt tries'); a.ok(fin.every(r=>r.args.outcome==='landed'&&r.args.landedRevision===C));
    a.equal(phase,'finalizing'); a.equal(count(l=>l===lost),1); a.equal(count(l=>l.includes(' not closed; nothing finalized.')),0); a.equal(kept,0);
  } else {
    a.equal(fin.length,0,'finalized an attempt that is not finalizing'); a.equal(phase,'running'); a.equal(open,1); a.equal(kept,1); a.equal(count(l=>l===lost),0);
  }
  process.exit(0);
}
a.equal(rec.length,kind==='replay'?2:1,'record_delivery_receipt rows'); a.equal(fin.length,1); a.equal(fin[0].args.outcome,'landed'); a.equal(fin[0].args.landedRevision,C);
a.ok(at(rec.at(-1))<at(fin[0]),'finalize_attempt precedes the receipt'); a.equal(phase,'closed'); a.equal(fs.existsSync(jf),false,'the receipt journal stayed');
a.equal(deferred,0); a.equal(kept,0);
if(kind==='replay'){
  a.equal(JSON.stringify(rec[1].args),JSON.stringify(rec[0].args),'the replay did not re-send the journaled receipt');
  a.equal(of('check-dispatch').length,1,'the replay dispatched again');
  a.equal(count(l=>l.startsWith('[receipt] replaying the delivery receipt of task task-postflight from ')),1);
}
if(kind!=='conflict') a.equal(JSON.parse(fs.readFileSync(p+'/.moe/receipts/'+id+'.json','utf8')).pushResult,null);
JS
}
vmr_run SR-T1 worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass
sr_check SR-T1 pass
vmr_run SR-T2 worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_EVIDENCE_MODE=receipt-refused
sr_check SR-T2 deferred
# The replay is the same seat's next run on the same project: its claim is refused
# while the attempt is finalizing, and its pre-flight replays the kept journal.
rm -rf "$TMP_DIR/sr-keep"; cp -a "$PROJECT" "$TMP_DIR/sr-keep"
sr_restore() { rm -rf "$PROJECT"; cp -a "$TMP_DIR/sr-keep" "$PROJECT"; }
VMR_SETUP=sr_restore
vmr_run SR-T2-replay worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CLAIM_MODE=finalizing
VMR_SETUP=sg_fixture
sr_check SR-T2-replay replay
# SR-T2-refuse and SR-T2-running (task-9194f182): the same kept project replayed with
# the finalize lost. Refused: the replay warns 'still finalizing' and continues, so the
# strong journal stays by that path. Running: the kept attempt reads running, so the
# replay reaches the CQ-V08b keep ('not closed; nothing finalized.') and sends no finalize.
sr_running() { sr_restore; "$NODE" -e 'const fs=require("fs"),f=process.argv[1],a=JSON.parse(fs.readFileSync(f,"utf8"));if(a.phase!=="finalizing")throw new Error("the kept attempt is "+a.phase);a.phase="running";fs.writeFileSync(f,JSON.stringify(a))' "$PROJECT/.moe/attempts/attempt-postflight.json"; }
VMR_SETUP=sr_restore
vmr_run SR-T2-refuse worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CLAIM_MODE=finalizing FAKE_EVIDENCE_MODE=finalize_attempt-refuse
sr_check SR-T2-refuse refused
VMR_SETUP=sr_running
vmr_run SR-T2-running worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CLAIM_MODE=finalizing
sr_check SR-T2-running running
VMR_SETUP=sg_fixture
vmr_run SR-T3 worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_EVIDENCE_MODE=receipt-conflict
sr_check SR-T3 conflict
vmr_run SR-T4 worker codex "$SG_READY" on 0 FAKE_EVIDENCE_MODE=finalize_attempt-refuse
sr_check SR-T4 legacy
vmr_run SR-T5 worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CHECK_DISPATCH=pass FAKE_EVIDENCE_MODE=receipt-conflict-finalize-lost
sr_check SR-T5 lost
rm -rf "$TMP_DIR/sr-keep"; cp -a "$PROJECT" "$TMP_DIR/sr-keep"
VMR_SETUP=sr_restore
vmr_run SR-T5-replay worker codex "$SG_READY" on 0 "${SG_STRONG[@]}" FAKE_CLAIM_MODE=finalizing FAKE_EVIDENCE_MODE=receipt-conflict
VMR_SETUP=sg_fixture
sr_check SR-T5-replay lost-replay
# M1-M2 (task-edf2162b): an observe pin whose task's newest attempt record ties at
# generation 7 as verified-local, so strong_landing_task journals the landing strong.
# The finalize keys on that journal, not on the pin. The record is closed, so no
# open-attempt or finalizing scan reads it.
echo '[strong receipt] M1, M1-replay, M2: an observe pin with a strong journal finalizes as a strong landing'
sr_mixed() {
  sg_fixture; mkdir -p "$PROJECT/.moe/attempts"
  printf '%s\n' '{"id":"attempt-tie","taskId":"task-postflight","generation":7,"workerId":"worker-old","phase":"closed","executionPolicySnapshot":{"version":2,"profile":"verified-local","planRevision":1}}' > "$PROJECT/.moe/attempts/attempt-tie.json"
}
SR_MIXED=(FAKE_ATTEMPT_PROFILE=observe MOE_CHECK_DISPATCH_PATH="$SG_FAKE")
VMR_SETUP=sr_mixed
vmr_run SR-M1 worker codex "$SG_READY" on 0 "${SR_MIXED[@]}" FAKE_CHECK_DISPATCH=pass FAKE_EVIDENCE_MODE=receipt-refused
sr_check SR-M1 deferred
rm -rf "$TMP_DIR/sr-keep"; cp -a "$PROJECT" "$TMP_DIR/sr-keep"
VMR_SETUP=sr_restore
vmr_run SR-M1-replay worker codex "$SG_READY" on 0 "${SR_MIXED[@]}" FAKE_CLAIM_MODE=finalizing
VMR_SETUP=sr_mixed
sr_check SR-M1-replay replay
vmr_run SR-M2 worker codex "$SG_READY" on 0 "${SR_MIXED[@]}" FAKE_CHECK_DISPATCH=pass
sr_check SR-M2 pass
VMR_SETUP=sg_fixture
echo "[strong receipt] ok T1, T2, T2-replay, T2-refuse, T2-running, T3, T4, T5, T5-replay, M1, M1-replay, M2"
)

echo "PASS postflight-vm-route.sh"

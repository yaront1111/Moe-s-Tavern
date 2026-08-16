#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/moe-agent.sh"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t moe-postflight)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

if ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP postflight.sh: timeout command is not available"
  exit 0
fi

# Fast flag regressions: no daemon/proxy required.
# Capture --help output before grepping: piping straight into `grep -q` makes
# grep exit at the first match while the wrapper is still writing, which under
# `pipefail` surfaces as SIGPIPE (exit 141) on Windows Git Bash.
help_out="$(MOE_NODE_COMMAND=/bin/echo "$WRAPPER" --loop --help)"
grep -q -- '--loop' <<< "$help_out"
set +e
MOE_NODE_COMMAND=/bin/echo "$WRAPPER" --loop --no-loop >"$TMP_DIR/conflict.out" 2>&1
conflict_code=$?
set -e
if [ "$conflict_code" -ne 2 ]; then
  cat "$TMP_DIR/conflict.out" >&2 || true
  echo "Expected --loop --no-loop to exit 2; got $conflict_code" >&2
  exit 1
fi

NODE_FOR_TEST="${MOE_NODE_COMMAND:-}"
if [ -z "$NODE_FOR_TEST" ]; then
  NODE_FOR_TEST="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_FOR_TEST" ] || ! "$NODE_FOR_TEST" --version >/dev/null 2>&1; then
  echo "SKIP postflight.sh: runnable node is not available in this shell"
  exit 0
fi
NODE_SHIM="$TMP_DIR/node"
cat > "$NODE_SHIM" <<EOF
#!/usr/bin/env bash
exec "$NODE_FOR_TEST" "\$@"
EOF
chmod +x "$NODE_SHIM"
NODE_FOR_TEST="$NODE_SHIM"
# Match the wrapper's own python resolution (find_python: python3, py -3,
# plain python 3.x) instead of hard-requiring python3 — Windows Git Bash
# typically ships `python` only.
if ! command -v python3 >/dev/null 2>&1; then
  case "$(python --version 2>&1)" in
    "Python 3."*) : ;;
    *)
      echo "SKIP postflight.sh: python 3 is not available in this shell"
      exit 0
      ;;
  esac
fi

# write_task_record PROJECT_DIR FILES_MODIFIED_JSON
# Writes the durable task record the post-flight reads to derive its commit
# pathspec. The fake proxy claims `task-postflight`, and the daemon stores a
# task at `.moe/tasks/<taskId>.json` -- the id ALREADY carries the `task-`
# prefix, so the on-disk name is `task-postflight.json` and never
# `task-task-postflight.json`. Getting that resolution wrong is silent: the
# record simply never loads and the hook degrades to whole-tree staging.
write_task_record() {
  local dir="$1" files_json="$2"
  mkdir -p "$dir/.moe/tasks"
  "$NODE_FOR_TEST" -e 'const [d,f]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"task-postflight",title:"Postflight smoke",status:"REVIEW",filesModified:JSON.parse(f)})+"\n");' \
    "$dir/.moe/tasks/task-postflight.json" "$files_json"
}

PROJECT_DIR="$TMP_DIR/project"
HOME_DIR="$TMP_DIR/home"
mkdir -p "$PROJECT_DIR/.moe/messages" "$HOME_DIR"
printf '{"id":"proj-smoke","name":"postflight-smoke","settings":{"autoCommit":false}}\n' > "$PROJECT_DIR/.moe/project.json"
: > "$PROJECT_DIR/.moe/messages/chan-general.jsonl"

FAKE_PROXY="$TMP_DIR/fake-proxy.js"
cat > "$FAKE_PROXY" <<'JS'
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
  case 'claim_next_task': {
    if (process.env.FAKE_CLAIM_MODE === 'resume') {
      // One-task-per-worker guard shape (claimNextTask.ts): the worker already
      // holds an active task from a CLI session that died mid-task.
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: 'REVIEW' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume (REVIEW).' }
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
    ok({
      task: {
        id: ctxTaskId,
        status: process.env.FAKE_TASK_STATUS || 'WORKING',
        reopenCount: 0,
        implementationPlan: [],
        definitionOfDone: []
      },
      project: {}, epic: { id: 'epic-1', title: 'Smoke epic' }, nextAction: { tool: 'moe.start_step' }
    });
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
JS

set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" timeout 20s \
  "$WRAPPER" \
  --project "$PROJECT_DIR" \
  --worker-id worker-postflight \
  --role worker \
  --team Smoke \
  --no-start-daemon \
  --command /bin/true \
  --loop \
  --poll-interval 0 \
  >"$TMP_DIR/wrapper.out" 2>&1
wrapper_code=$?
set -e
if [ "$wrapper_code" -ne 0 ]; then
  cat "$TMP_DIR/wrapper.out" >&2 || true
  echo "Wrapper exited with $wrapper_code" >&2
  exit 1
fi

# Post-flight no longer writes a session-summary file (cross-session memory moved
# to Serena). The post-flight chat message remains the session-ended signal.
MESSAGES_FILE="$PROJECT_DIR/.moe/messages/chan-general.jsonl"
if ! grep -Fq 'worker session ended: task=task-postflight (CLI exit=0)' "$MESSAGES_FILE"; then
  cat "$TMP_DIR/wrapper.out" >&2 || true
  cat "$MESSAGES_FILE" >&2 || true
  echo "Expected post-flight chat message not found" >&2
  exit 1
fi
# The quiet half of the same decision: this run's task resolves cleanly to a
# non-REVIEW status, which is a legitimate no-op. It must NOT be reported as a
# failed lookup -- collapsing those two back together is what hid the defect.
if grep -Fq 'post-flight status lookup failed' "$TMP_DIR/wrapper.out"; then
  cat "$TMP_DIR/wrapper.out" >&2 || true
  echo "A resolved non-REVIEW status must stay a quiet no-op, not warn as a lookup failure" >&2
  exit 1
fi

# --- Resume path: a worker that already holds an active task (its previous CLI
# died mid-task) gets hasNext:false + alreadyAssigned from claim_next_task. The
# wrapper must treat that as a claim and relaunch the CLI with a RESUME prompt
# instead of idle-looping on "No claimable task". ---
FAKE_CLI="$TMP_DIR/fake-cli"
CLI_ARGS_FILE="$TMP_DIR/cli-args.txt"
cat > "$FAKE_CLI" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$CLI_ARGS_FILE"
exit 0
EOF
chmod +x "$FAKE_CLI"

set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout 20s \
  "$WRAPPER" \
  --project "$PROJECT_DIR" \
  --worker-id qa-postflight \
  --role qa \
  --team Smoke \
  --no-start-daemon \
  --command "$FAKE_CLI" \
  --loop \
  --poll-interval 0 \
  >"$TMP_DIR/wrapper-resume.out" 2>&1
resume_code=$?
set -e
if [ "$resume_code" -ne 0 ]; then
  cat "$TMP_DIR/wrapper-resume.out" >&2 || true
  echo "Resume wrapper exited with $resume_code" >&2
  exit 1
fi
if ! grep -Fq 'Pre-flight complete. Resuming: task-resume' "$TMP_DIR/wrapper-resume.out"; then
  cat "$TMP_DIR/wrapper-resume.out" >&2 || true
  echo "Expected resume pre-flight banner not found" >&2
  exit 1
fi
if ! grep -Fq 'qa session ended: task=task-resume (CLI exit=0)' "$MESSAGES_FILE"; then
  cat "$MESSAGES_FILE" >&2 || true
  echo "Expected resume post-flight chat message not found" >&2
  exit 1
fi
if [ ! -f "$CLI_ARGS_FILE" ] || ! grep -Fq 'RESUME: you are workerId qa-postflight' "$CLI_ARGS_FILE"; then
  cat "$TMP_DIR/wrapper-resume.out" >&2 || true
  echo "Expected CLI to be launched with a RESUME prompt" >&2
  exit 1
fi
# QA defaults to one-shot --print mode (ps1 parity): the CLI argv must carry
# --print, and the prompt must carry the one-shot session warning.
if ! grep -Fqx -- '--print' "$CLI_ARGS_FILE"; then
  cat "$CLI_ARGS_FILE" >&2 || true
  echo "Expected worker/qa CLI to be launched with --print by default" >&2
  exit 1
fi
if ! grep -Fq 'CRITICAL (one-shot session)' "$CLI_ARGS_FILE"; then
  cat "$CLI_ARGS_FILE" >&2 || true
  echo "Expected one-shot session warning in the CLI prompt" >&2
  exit 1
fi

# --interactive forces the TUI: no --print in argv.
: > "$CLI_ARGS_FILE"
set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout 20s \
  "$WRAPPER" \
  --project "$PROJECT_DIR" \
  --worker-id qa-postflight \
  --role qa \
  --team Smoke \
  --no-start-daemon \
  --command "$FAKE_CLI" \
  --interactive \
  --no-loop \
  --poll-interval 0 \
  >"$TMP_DIR/wrapper-interactive.out" 2>&1
interactive_code=$?
set -e
if [ "$interactive_code" -ne 0 ]; then
  cat "$TMP_DIR/wrapper-interactive.out" >&2 || true
  echo "Interactive wrapper exited with $interactive_code" >&2
  exit 1
fi
if grep -Fqx -- '--print' "$CLI_ARGS_FILE"; then
  cat "$CLI_ARGS_FILE" >&2 || true
  echo "--interactive must NOT pass --print" >&2
  exit 1
fi

# --- Heartbeat sidecar: the CLI invocation blocks the wrapper with no moe.*
# calls of its own for the CLI's whole runtime, so a long silent step (a
# build, a test run) risks the REVIEW self-heal sweep evicting a still-alive
# session. SLOW_CLI stands in for that -- it sleeps ~5s making zero tool
# calls. With a 1s heartbeat interval the sidecar should ping several times
# DURING that window, and stop promptly once the CLI (and the wrapper) exit
# -- not leak an orphaned background process. ---
SLOW_CLI="$TMP_DIR/slow-cli"
cat > "$SLOW_CLI" <<EOF
#!/usr/bin/env bash
sleep 5
exit 0
EOF
chmod +x "$SLOW_CLI"
HEARTBEAT_LOG="$PROJECT_DIR/.moe/heartbeat.log"

set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" \
  MOE_HEARTBEAT_INTERVAL_SEC=1 MOE_HEARTBEAT_MAX_DURATION_SEC=30 timeout 20s \
  "$WRAPPER" \
  --project "$PROJECT_DIR" \
  --worker-id qa-heartbeat \
  --role qa \
  --team Smoke \
  --no-start-daemon \
  --command "$SLOW_CLI" \
  --no-loop \
  >"$TMP_DIR/wrapper-heartbeat.out" 2>&1
heartbeat_wrapper_code=$?
set -e
if [ "$heartbeat_wrapper_code" -ne 0 ]; then
  cat "$TMP_DIR/wrapper-heartbeat.out" >&2 || true
  echo "Heartbeat wrapper exited with $heartbeat_wrapper_code" >&2
  exit 1
fi
count_at_exit=0
if [ -f "$HEARTBEAT_LOG" ]; then
  count_at_exit=$(wc -l < "$HEARTBEAT_LOG" | tr -d ' ')
fi
if [ "$count_at_exit" -lt 2 ]; then
  cat "$TMP_DIR/wrapper-heartbeat.out" >&2 || true
  echo "Expected the heartbeat sidecar to ping at least twice during a ~5s silent CLI step; got $count_at_exit" >&2
  exit 1
fi
# The wrapper process (and any background subshell it started) has already
# exited by the time the call above returns. If stop_heartbeat_sidecar didn't
# run, the subshell would keep pinging past that point -- confirm it didn't.
sleep 3
count_after_wait=0
if [ -f "$HEARTBEAT_LOG" ]; then
  count_after_wait=$(wc -l < "$HEARTBEAT_LOG" | tr -d ' ')
fi
if [ "$count_after_wait" -ne "$count_at_exit" ]; then
  echo "Heartbeat sidecar kept pinging ($count_after_wait calls) after the wrapper exited ($count_at_exit at exit) - stop_heartbeat_sidecar cleanup failed" >&2
  exit 1
fi

# --- Quality gate (settings.qualityGate): the post-flight runs the configured
# command before auto-commit. Failing gate => no commit, PUSH-BLOCKED chat
# message; passing gate => commit lands; MOE_DISABLE_QUALITY_GATE=1 => gate
# skipped even when the command would fail. Requires git in PATH. ---
if command -v git >/dev/null 2>&1; then
  make_gate_project() {
    # $1 = dir, $2 = qualityGate command (raw string, JSON-escaped here)
    local dir="$1" gate_cmd="$2"
    mkdir -p "$dir/.moe/messages" "$dir/.moe/tasks"
    "$NODE_FOR_TEST" -e 'const [d,g]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"proj-gate",name:"postflight-gate",settings:{qualityGate:g}})+"\n");' \
      "$dir/.moe/project.json" "$gate_cmd"
    # The task record the post-flight reads to derive its commit pathspec. Its
    # FILENAME is `<taskId>.json` and the id already carries the `task-` prefix.
    write_task_record "$dir" '["work.txt"]'
    : > "$dir/.moe/messages/chan-general.jsonl"
    git -C "$dir" init -q
    git -C "$dir" config user.email moe@test.local
    git -C "$dir" config user.name "Moe Test"
    echo seed > "$dir/seed.txt"
    git -C "$dir" add seed.txt >/dev/null
    git -C "$dir" commit -qm init >/dev/null
    # Leave the task's own owned path dirty for the post-flight to commit.
    echo dirty > "$dir/work.txt"
  }

  run_gate_wrapper() {
    # $1 = project dir, $2 = output file, extra env via caller
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS=REVIEW timeout 30s \
      "$WRAPPER" \
      --project "$1" \
      --worker-id worker-gate \
      --role worker \
      --team Smoke \
      --no-start-daemon \
      --command /bin/true \
      --no-loop \
      --poll-interval 0 \
      >"$2" 2>&1
  }

  # Case 1: failing gate blocks the commit and announces PUSH-BLOCKED.
  GATE_FAIL_DIR="$TMP_DIR/gate-fail"
  make_gate_project "$GATE_FAIL_DIR" "exit 3"
  set +e
  run_gate_wrapper "$GATE_FAIL_DIR" "$TMP_DIR/wrapper-gate-fail.out"
  gate_fail_code=$?
  set -e
  if [ "$gate_fail_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-fail.out" >&2 || true
    echo "Gate-fail wrapper exited with $gate_fail_code" >&2
    exit 1
  fi
  if ! grep -Fq 'qualityGate failed (exit 3)' "$TMP_DIR/wrapper-gate-fail.out"; then
    cat "$TMP_DIR/wrapper-gate-fail.out" >&2 || true
    echo "Expected qualityGate failure log not found" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_FAIL_DIR" rev-list --count HEAD)" -ne 1 ]; then
    echo "Failing qualityGate must block the auto-commit (found extra commits)" >&2
    exit 1
  fi
  if ! grep -Fq 'PUSH-BLOCKED: qualityGate failed for task task-postflight' "$GATE_FAIL_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$GATE_FAIL_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    echo "Expected PUSH-BLOCKED chat message not found" >&2
    exit 1
  fi

  # Case 2: passing gate lets the commit land (on the peeled moe/work-* branch).
  GATE_PASS_DIR="$TMP_DIR/gate-pass"
  make_gate_project "$GATE_PASS_DIR" "exit 0"
  set +e
  run_gate_wrapper "$GATE_PASS_DIR" "$TMP_DIR/wrapper-gate-pass.out"
  gate_pass_code=$?
  set -e
  if [ "$gate_pass_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-pass.out" >&2 || true
    echo "Gate-pass wrapper exited with $gate_pass_code" >&2
    exit 1
  fi
  if ! grep -Fq 'qualityGate passed' "$TMP_DIR/wrapper-gate-pass.out"; then
    cat "$TMP_DIR/wrapper-gate-pass.out" >&2 || true
    echo "Expected qualityGate pass log not found" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_PASS_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-pass.out" >&2 || true
    echo "Passing qualityGate should allow the auto-commit (expected 2 commits)" >&2
    exit 1
  fi

  # Case 3: MOE_DISABLE_QUALITY_GATE=1 skips a gate that would fail.
  GATE_SKIP_DIR="$TMP_DIR/gate-skip"
  make_gate_project "$GATE_SKIP_DIR" "exit 7"
  set +e
  MOE_DISABLE_QUALITY_GATE=1 run_gate_wrapper "$GATE_SKIP_DIR" "$TMP_DIR/wrapper-gate-skip.out"
  gate_skip_code=$?
  set -e
  if [ "$gate_skip_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-skip.out" >&2 || true
    echo "Gate-skip wrapper exited with $gate_skip_code" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_SKIP_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-skip.out" >&2 || true
    echo "MOE_DISABLE_QUALITY_GATE=1 should skip the gate and allow the commit" >&2
    exit 1
  fi

  # Case 4: mid-epic task (a sibling with higher order exists) defers the gate
  # under the default scope=epicFinal — a failing gate command must NOT block
  # the commit because it never runs.
  GATE_MID_DIR="$TMP_DIR/gate-midepic"
  make_gate_project "$GATE_MID_DIR" "exit 9"
  set +e
  FAKE_SIBLING_ORDER=99 run_gate_wrapper "$GATE_MID_DIR" "$TMP_DIR/wrapper-gate-midepic.out"
  gate_mid_code=$?
  set -e
  if [ "$gate_mid_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-midepic.out" >&2 || true
    echo "Gate-midepic wrapper exited with $gate_mid_code" >&2
    exit 1
  fi
  if ! grep -Fq 'qualityGate deferred' "$TMP_DIR/wrapper-gate-midepic.out"; then
    cat "$TMP_DIR/wrapper-gate-midepic.out" >&2 || true
    echo "Expected mid-epic qualityGate deferral log not found" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_MID_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-midepic.out" >&2 || true
    echo "Mid-epic task should commit without running the gate (scope=epicFinal)" >&2
    exit 1
  fi

  # Case 5: REGRESSION — the post-flight must not resolve the task's final
  # status through an UNSCOPED list_tasks. The daemon caps that call at
  # DEFAULT_TASK_LIST_LIMIT, so past one page of tasks the just-completed task
  # is absent from the rows, the status comes back empty, and the whole
  # auto-commit block is skipped in total silence (no output, no chat message).
  # The lookup must key on the task id instead, which cannot be paginated away.
  GATE_TRUNC_DIR="$TMP_DIR/gate-truncated"
  make_gate_project "$GATE_TRUNC_DIR" ""
  set +e
  FAKE_LIST_TASKS_TRUNCATED=1 run_gate_wrapper "$GATE_TRUNC_DIR" "$TMP_DIR/wrapper-gate-truncated.out"
  gate_trunc_code=$?
  set -e
  if [ "$gate_trunc_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-truncated.out" >&2 || true
    echo "Gate-truncated wrapper exited with $gate_trunc_code" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_TRUNC_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-truncated.out" >&2 || true
    echo "A truncated list_tasks page must NOT stop the auto-commit: the REVIEW status has to be resolved by exact task-id lookup (expected 2 commits)" >&2
    exit 1
  fi

  # Case 6: a status lookup that fails outright is an ERROR, not a quiet
  # "the task isn't in REVIEW". It must warn on stdout AND escalate to chat --
  # that distinction is the whole reason this failure went unnoticed for a day.
  GATE_LOOKUP_DIR="$TMP_DIR/gate-lookupfail"
  make_gate_project "$GATE_LOOKUP_DIR" ""
  set +e
  FAKE_GET_CONTEXT_FAIL=empty run_gate_wrapper "$GATE_LOOKUP_DIR" "$TMP_DIR/wrapper-gate-lookupfail.out"
  gate_lookup_code=$?
  set -e
  if [ "$gate_lookup_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-lookupfail.out" >&2 || true
    echo "Gate-lookupfail wrapper exited with $gate_lookup_code" >&2
    exit 1
  fi
  if ! grep -Fq 'post-flight status lookup failed for task task-postflight' "$TMP_DIR/wrapper-gate-lookupfail.out"; then
    cat "$TMP_DIR/wrapper-gate-lookupfail.out" >&2 || true
    echo "Expected a [WARN] naming the task when the post-flight status lookup fails" >&2
    exit 1
  fi
  if ! grep -Fq 'PUSH-BLOCKED: post-flight status lookup failed for task task-postflight' "$GATE_LOOKUP_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$GATE_LOOKUP_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    echo "Expected a chat escalation when the post-flight status lookup fails" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_LOOKUP_DIR" rev-list --count HEAD)" -ne 1 ]; then
    echo "An unresolved status must NOT commit (we cannot know the task reached REVIEW)" >&2
    exit 1
  fi

  # Case 7: get_context's real miss behaviour -- getContext.ts falls back to the
  # caller's currentTaskId, so a stale/deleted id answers with a DIFFERENT task.
  # Auto-committing on another task's REVIEW status would be worse than not
  # committing at all, so this must take the loud path too, not the happy one.
  GATE_MISMATCH_DIR="$TMP_DIR/gate-mismatch"
  make_gate_project "$GATE_MISMATCH_DIR" ""
  set +e
  FAKE_GET_CONTEXT_FAIL=mismatch run_gate_wrapper "$GATE_MISMATCH_DIR" "$TMP_DIR/wrapper-gate-mismatch.out"
  gate_mismatch_code=$?
  set -e
  if [ "$gate_mismatch_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-mismatch.out" >&2 || true
    echo "Gate-mismatch wrapper exited with $gate_mismatch_code" >&2
    exit 1
  fi
  if ! grep -Fq 'get_context resolved a different task (task-someone-elses)' "$TMP_DIR/wrapper-gate-mismatch.out"; then
    cat "$TMP_DIR/wrapper-gate-mismatch.out" >&2 || true
    echo "Expected the wrapper to reject a get_context fallback onto a different task" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_MISMATCH_DIR" rev-list --count HEAD)" -ne 1 ]; then
    echo "A get_context fallback onto a different task must NOT auto-commit" >&2
    exit 1
  fi
else
  echo "SKIP qualityGate cases: git not available"
fi

# --- Completion-hook COMMIT SCOPE, scenarios A-D --------------------------
# The post-flight auto-commit must land ONLY the completing task's own paths
# (its task record's `filesModified`). Two distinct leaks were measured in
# production and they are NOT the same bug:
#   * staging scope -- `git add -A` whenever the task record did not load;
#   * commit scope  -- a BARE `git commit -m ...` commits the SHARED INDEX, so
#     a peer's already-staged file rides along no matter what this hook staged.
# Scenario B is the only one that discriminates the second leak: a
# dirty-working-tree fixture stays green under both the broken and fixed
# commit. Every scenario runs against a disposable repo under $TMP_DIR -- a
# post-flight test that commits into a live tree reproduces the defect it is
# supposed to be testing.
if command -v git >/dev/null 2>&1; then
  SCOPE_SCENARIOS_RUN=0

  scope_fail() { # $1 = scenario letter, $2 = message, $3 = wrapper log
    cat "$3" >&2 || true
    echo "SCENARIO $1 FAILED: $2" >&2
    exit 1
  }

  make_scope_project() { # $1 = dir, $2 = filesModified JSON array literal
    local dir="$1" files_json="$2"
    mkdir -p "$dir/.moe/messages"
    "$NODE_FOR_TEST" -e 'const [d]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"proj-scope",name:"postflight-scope",settings:{}})+"\n");' \
      "$dir/.moe/project.json"
    write_task_record "$dir" "$files_json"
    : > "$dir/.moe/messages/chan-general.jsonl"
    git -C "$dir" init -q
    git -C "$dir" config user.email moe@test.local
    git -C "$dir" config user.name "Moe Test"
    echo seed > "$dir/seed.txt"
    git -C "$dir" add seed.txt >/dev/null
    git -C "$dir" commit -qm init >/dev/null
  }

  run_scope_wrapper() { # $1 = project dir, $2 = output file
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS=REVIEW timeout 30s \
      "$WRAPPER" \
      --project "$1" \
      --worker-id worker-scope \
      --role worker \
      --team Smoke \
      --no-start-daemon \
      --command /bin/true \
      --no-loop \
      --poll-interval 0 \
      >"$2" 2>&1
  }

  committed_paths() { # $1 = dir -- space-terminated sorted file list of HEAD
    git -C "$1" show --pretty=format: --name-only HEAD | sed '/^$/d' | sort | tr '\n' ' '
  }

  # Scenario A -- dirty peer. Owned X and Y commit; a peer's MODIFIED tracked
  # file and a peer's UNTRACKED file must both survive the completion untouched.
  echo "[scenario A] dirty peer files are never captured"
  SCOPE_A_DIR="$TMP_DIR/scope-a"
  make_scope_project "$SCOPE_A_DIR" '["owned-a.txt","owned-b.txt"]'
  echo peer-base > "$SCOPE_A_DIR/peer-mod.txt"
  git -C "$SCOPE_A_DIR" add peer-mod.txt >/dev/null
  git -C "$SCOPE_A_DIR" commit -qm peer-base >/dev/null
  echo owned-a    > "$SCOPE_A_DIR/owned-a.txt"
  echo owned-b    > "$SCOPE_A_DIR/owned-b.txt"
  echo peer-dirty > "$SCOPE_A_DIR/peer-mod.txt"
  echo peer-new   > "$SCOPE_A_DIR/peer-untracked.txt"
  set +e
  run_scope_wrapper "$SCOPE_A_DIR" "$TMP_DIR/scope-a.out"
  scope_a_code=$?
  set -e
  [ "$scope_a_code" -eq 0 ] || scope_fail A "wrapper exited with $scope_a_code" "$TMP_DIR/scope-a.out"
  scope_a_files="$(committed_paths "$SCOPE_A_DIR")"
  if [ "$scope_a_files" != "owned-a.txt owned-b.txt " ]; then
    scope_fail A "commit must contain EXACTLY the owned paths; got [$scope_a_files]" "$TMP_DIR/scope-a.out"
  fi
  if ! git -C "$SCOPE_A_DIR" status --porcelain | grep -q '^ M peer-mod\.txt$'; then
    git -C "$SCOPE_A_DIR" status --porcelain >&2 || true
    scope_fail A "peer-mod.txt must still be modified-and-unstaged after the completion" "$TMP_DIR/scope-a.out"
  fi
  if ! git -C "$SCOPE_A_DIR" status --porcelain | grep -q '^?? peer-untracked\.txt$'; then
    git -C "$SCOPE_A_DIR" status --porcelain >&2 || true
    scope_fail A "peer-untracked.txt must still be untracked after the completion" "$TMP_DIR/scope-a.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario A] ok"

  # Scenario B -- pre-staged foreign index. This is the discriminating case: a
  # peer stages Z into the SHARED INDEX before the hook runs. Pathspec STAGING
  # cannot help here; only a pathspec-scoped COMMIT keeps Z out.
  echo "[scenario B] a peer's pre-staged index entry never rides along"
  SCOPE_B_DIR="$TMP_DIR/scope-b"
  make_scope_project "$SCOPE_B_DIR" '["owned-a.txt"]'
  echo owned-a     > "$SCOPE_B_DIR/owned-a.txt"
  echo peer-staged > "$SCOPE_B_DIR/peer-staged.txt"
  git -C "$SCOPE_B_DIR" add peer-staged.txt >/dev/null
  set +e
  run_scope_wrapper "$SCOPE_B_DIR" "$TMP_DIR/scope-b.out"
  scope_b_code=$?
  set -e
  [ "$scope_b_code" -eq 0 ] || scope_fail B "wrapper exited with $scope_b_code" "$TMP_DIR/scope-b.out"
  scope_b_files="$(committed_paths "$SCOPE_B_DIR")"
  if [ "$scope_b_files" != "owned-a.txt " ]; then
    scope_fail B "commit must contain ONLY owned-a.txt; got [$scope_b_files]" "$TMP_DIR/scope-b.out"
  fi
  if git -C "$SCOPE_B_DIR" cat-file -e HEAD:peer-staged.txt 2>/dev/null; then
    scope_fail B "the peer's pre-staged file reached HEAD -- the commit is still index-scoped" "$TMP_DIR/scope-b.out"
  fi
  if ! git -C "$SCOPE_B_DIR" diff --cached --name-only | grep -q '^peer-staged\.txt$'; then
    git -C "$SCOPE_B_DIR" status --porcelain >&2 || true
    scope_fail B "the peer's file must remain STAGED and uncommitted" "$TMP_DIR/scope-b.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario B] ok"

  # Scenario C -- empty filesModified. Fails CLOSED under its own stable code
  # and commits nothing. The dirty peer file is load-bearing: without it a
  # restored `git add -A` would have nothing to sweep and this would pass while
  # testing nothing.
  echo "[scenario C] empty owned-path set refuses with MOE_COMMIT_REFUSED_NO_OWNED_PATHS"
  SCOPE_C_DIR="$TMP_DIR/scope-c"
  make_scope_project "$SCOPE_C_DIR" '[]'
  echo peer-new > "$SCOPE_C_DIR/peer-untracked.txt"
  scope_c_head="$(git -C "$SCOPE_C_DIR" rev-parse HEAD)"
  set +e
  run_scope_wrapper "$SCOPE_C_DIR" "$TMP_DIR/scope-c.out"
  scope_c_code=$?
  set -e
  [ "$scope_c_code" -eq 0 ] || scope_fail C "wrapper exited with $scope_c_code" "$TMP_DIR/scope-c.out"
  if ! grep -Fq 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS' "$TMP_DIR/scope-c.out"; then
    scope_fail C "expected the literal reason code MOE_COMMIT_REFUSED_NO_OWNED_PATHS" "$TMP_DIR/scope-c.out"
  fi
  if grep -Fq 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING' "$TMP_DIR/scope-c.out"; then
    scope_fail C "an empty owned-path set must NOT report the missing-path code -- the two causes are distinct" "$TMP_DIR/scope-c.out"
  fi
  if [ "$(git -C "$SCOPE_C_DIR" rev-parse HEAD)" != "$scope_c_head" ]; then
    scope_fail C "a refusal must commit NOTHING; HEAD moved" "$TMP_DIR/scope-c.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario C] ok"

  # Scenario D -- every declared owned path is absent from disk. Distinct cause,
  # distinct code: collapsing it into C would make a later guard change
  # invisible.
  echo "[scenario D] all owned paths missing refuses with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING"
  SCOPE_D_DIR="$TMP_DIR/scope-d"
  make_scope_project "$SCOPE_D_DIR" '["ghost-owned.txt"]'
  echo peer-new > "$SCOPE_D_DIR/peer-untracked.txt"
  scope_d_head="$(git -C "$SCOPE_D_DIR" rev-parse HEAD)"
  set +e
  run_scope_wrapper "$SCOPE_D_DIR" "$TMP_DIR/scope-d.out"
  scope_d_code=$?
  set -e
  [ "$scope_d_code" -eq 0 ] || scope_fail D "wrapper exited with $scope_d_code" "$TMP_DIR/scope-d.out"
  if ! grep -Fq 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING' "$TMP_DIR/scope-d.out"; then
    scope_fail D "expected the literal reason code MOE_COMMIT_REFUSED_OWNED_PATH_MISSING" "$TMP_DIR/scope-d.out"
  fi
  if grep -Fq 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS' "$TMP_DIR/scope-d.out"; then
    scope_fail D "a declared-but-absent path must NOT report the empty-set code" "$TMP_DIR/scope-d.out"
  fi
  if [ "$(git -C "$SCOPE_D_DIR" rev-parse HEAD)" != "$scope_d_head" ]; then
    scope_fail D "a refusal must commit NOTHING; HEAD moved" "$TMP_DIR/scope-d.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario D] ok"

  # Scenario E -- a GLOB in filesModified. A git pathspec is a glob by default,
  # so an entry of `*` walks straight back out to a whole-tree stage through the
  # very "explicit pathspec" route this fix installs. Measured on a throwaway
  # repo: `git add -- '*'` staged every file; `git add -- ':(literal)*'` matched
  # nothing. This is the only scenario that can catch that escape.
  echo "[scenario E] a glob in filesModified cannot widen the commit"
  SCOPE_E_DIR="$TMP_DIR/scope-e"
  make_scope_project "$SCOPE_E_DIR" '["*"]'
  echo peer-new > "$SCOPE_E_DIR/peer-untracked.txt"
  scope_e_head="$(git -C "$SCOPE_E_DIR" rev-parse HEAD)"
  set +e
  run_scope_wrapper "$SCOPE_E_DIR" "$TMP_DIR/scope-e.out"
  scope_e_code=$?
  set -e
  [ "$scope_e_code" -eq 0 ] || scope_fail E "wrapper exited with $scope_e_code" "$TMP_DIR/scope-e.out"
  if ! grep -Fq 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING' "$TMP_DIR/scope-e.out"; then
    scope_fail E "a glob must match NO literal path and refuse with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING" "$TMP_DIR/scope-e.out"
  fi
  if [ "$(git -C "$SCOPE_E_DIR" rev-parse HEAD)" != "$scope_e_head" ]; then
    scope_fail E "a glob owned path swept the tree into a commit; HEAD moved" "$TMP_DIR/scope-e.out"
  fi
  if ! git -C "$SCOPE_E_DIR" status --porcelain | grep -q '^?? peer-untracked\.txt$'; then
    git -C "$SCOPE_E_DIR" status --porcelain >&2 || true
    scope_fail E "peer-untracked.txt must still be untracked" "$TMP_DIR/scope-e.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario E] ok"

  # A harness that silently generated zero scenarios exits 0 and reads as green.
  echo "commit-scope scenarios run: $SCOPE_SCENARIOS_RUN"
  if [ "$SCOPE_SCENARIOS_RUN" -ne 5 ]; then
    echo "Expected 5 commit-scope scenarios (A-E); ran $SCOPE_SCENARIOS_RUN" >&2
    exit 1
  fi
else
  echo "SKIP commit-scope scenarios: git not available"
fi

echo "PASS postflight.sh"
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
  case 'get_context': ok({ task: { id: args.taskId || 'task-postflight', implementationPlan: [], definitionOfDone: [] }, project: {}, epic: {}, nextAction: { tool: 'moe.start_step' } }); break;
  case 'list_tasks': ok({ tasks: [{ id: 'task-postflight', status: 'WORKING', reopenCount: 0 }] }); break;
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

echo "PASS postflight.sh"
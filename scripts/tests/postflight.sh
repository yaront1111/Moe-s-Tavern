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

# write_task_record PROJECT_DIR FILES_MODIFIED_JSON [STATUS] [PLAN_JSON] [TASK_ID]
# Writes the durable task record the post-flight's attribution reads (via the
# fake get_commit_scope, and via the wrapper's disk fallback when that RPC is
# unavailable) to derive its ASSERTED (filesModified) and PLANNED
# (implementationPlan[*].affectedFiles) tiers. The fake proxy claims
# `task-postflight`, and the daemon stores a task at `.moe/tasks/<taskId>.json`
# -- the id ALREADY carries the `task-` prefix, so the on-disk name is
# `task-postflight.json` and never `task-task-postflight.json`. Getting that
# resolution wrong is silent: the record simply never loads and every
# completion degrades to MOE_COMMIT_REFUSED_NO_OWNED_PATHS.
write_task_record() {
  local dir="$1" files_json="$2" status="${3:-REVIEW}" plan_json="${4:-[]}" task_id="${5:-task-postflight}"
  mkdir -p "$dir/.moe/tasks"
  "$NODE_FOR_TEST" -e 'const [d,f,s,p,id]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id,title:"Postflight smoke",status:s,filesModified:JSON.parse(f),implementationPlan:JSON.parse(p)})+"\n");' \
    "$dir/.moe/tasks/$task_id.json" "$files_json" "$status" "$plan_json" "$task_id"
}

# write_peer_task_record PROJECT_DIR -- a LIVE peer task (task-peer, WORKING,
# held by worker-peer) whose plan names peer-plan.txt. The attribution's PEER
# map comes from every other open task record, so a path this plan declares
# must never be swept into task-postflight's commit.
write_peer_task_record() {
  local dir="$1"
  mkdir -p "$dir/.moe/tasks"
  "$NODE_FOR_TEST" -e 'const [d]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"task-peer",title:"Peer task",status:"WORKING",assignedWorkerId:"worker-peer",filesModified:["peer-plan.txt"],implementationPlan:[{stepId:"s0",title:"peer step",status:"PENDING",affectedFiles:["peer-plan.txt"]}]})+"\n");' \
    "$dir/.moe/tasks/task-peer.json"
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
    } else if (process.env.FAKE_CLAIM_MODE === 'blocked') {
      // The BLOCKED hold: the daemon parked this worker's task via
      // report_blocked; the wrapper must suppress the relaunch and idle --
      // after landing any lingering baseline for it.
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-blocked', title: 'Blocked smoke', status: 'BLOCKED', blockedReason: 'waiting on a peer' },
        nextAction: { tool: 'moe.wait_for_task', reason: 'One task per worker: you already hold task-blocked (BLOCKED).' }
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
    const ctxPayload = {
      task: {
        id: ctxTaskId,
        status: process.env.FAKE_TASK_STATUS || 'WORKING',
        reopenCount: 0,
        implementationPlan: [],
        definitionOfDone: []
      },
      project: {}, epic: { id: 'epic-1', title: 'Smoke epic' }, nextAction: { tool: 'moe.start_step' }
    };
    // FAKE_CTX_IS_EPIC_FINAL=true|false models the newer daemon that computes
    // epic-final board-side; unset = an old daemon that doesn't serve the
    // field. FAKE_CTX_IS_EPIC_FINAL_AT=top places it top-level (beside the
    // epic) instead of on the task projection -- the wrapper accepts both.
    const fakeIef = process.env.FAKE_CTX_IS_EPIC_FINAL;
    if (fakeIef === 'true' || fakeIef === 'false') {
      const iefVal = fakeIef === 'true';
      if (process.env.FAKE_CTX_IS_EPIC_FINAL_AT === 'top') ctxPayload.isEpicFinal = iefVal;
      else ctxPayload.task.isEpicFinal = iefVal;
    }
    ok(ctxPayload);
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
  case 'get_commit_scope': {
    // Mirrors getCommitScope.ts over the on-disk records: ASSERTED =
    // filesModified ∪ COMPLETED steps' (modifiedFiles ?? affectedFiles) ∪
    // declaredFiles ∪ touchedFiles; PLANNED = every step's affectedFiles ∪
    // newFiles ∪ modifiedFiles (∪ inferredPaths) − ASSERTED; PEER = the same
    // union over every other record not DONE/ARCHIVED. Knobs:
    //   FAKE_SCOPE_ASSERTED / FAKE_SCOPE_PLANNED  comma lists, appended
    //   FAKE_SCOPE_PEER_DECLARED                  path:taskId,... appended
    //   FAKE_SCOPE_PEERS_ACTIVE=1                 another worker is active
    //                                             (every other open task is
    //                                             then held by a live peer)
    //   FAKE_SCOPE_ASSIGNED                       assignedWorkerId
    // Pre-flight answers with the record's own status (the FAKE_TASK_STATUS
    // knob models the status the task reaches AFTER the CLI ran).
    const tid = args.taskId || 'task-postflight';
    const tasksDir = path.join(moe, 'tasks');
    const readTask = (id) => { try { return JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')); } catch { return null; } };
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
    const steps = (t) => (Array.isArray(t?.implementationPlan) ? t.implementationPlan : []);
    const tiers = (t) => {
      const asserted = new Set();
      for (const s of steps(t)) if (s && s.status === 'COMPLETED') for (const p of list(s.modifiedFiles || s.affectedFiles)) asserted.add(p);
      for (const p of [...list(t?.filesModified), ...list(t?.declaredFiles), ...list(t?.touchedFiles)]) asserted.add(p);
      const planned = new Set();
      for (const s of steps(t)) for (const p of [...list(s?.affectedFiles), ...list(s?.newFiles), ...list(s?.modifiedFiles)]) if (!asserted.has(p)) planned.add(p);
      for (const p of list(t?.inferredPaths)) if (!asserted.has(p)) planned.add(p);
      return { asserted: [...asserted], planned: [...planned] };
    };
    const csv = (name) => (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const own = readTask(tid);
    const mine = tiers(own || {});
    const asserted = [...new Set([...mine.asserted, ...csv('FAKE_SCOPE_ASSERTED')])];
    const planned = [...new Set([...mine.planned, ...csv('FAKE_SCOPE_PLANNED')])].filter((p) => !asserted.includes(p));
    const peerDeclared = [];
    const peerIds = [];
    let recordFiles = [];
    try { recordFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')).sort(); } catch {}
    for (const f of recordFiles) {
      const t = readTask(f.replace(/\.json$/, ''));
      if (!t || !t.id || t.id === tid || t.status === 'DONE' || t.status === 'ARCHIVED') continue;
      peerIds.push(t.id);
      const pt = tiers(t);
      for (const p of [...pt.asserted, ...pt.planned]) if (!peerDeclared.some((e) => e.path === p)) peerDeclared.push({ path: p, taskId: t.id });
    }
    for (const ent of csv('FAKE_SCOPE_PEER_DECLARED')) {
      const [p, t] = ent.split(':');
      if (p && !peerDeclared.some((e) => e.path === p)) peerDeclared.push({ path: p, taskId: t || 'task-peer' });
    }
    const peersActive = process.env.FAKE_SCOPE_PEERS_ACTIVE === '1';
    const alwaysInclude = [`.moe/tasks/${tid}.json`, '.moe/project.json', ...(peersActive ? [] : peerIds.map((id) => `.moe/tasks/${id}.json`))];
    ok({
      taskId: tid,
      title: own?.title || 'Postflight smoke',
      status: args.phase === 'preflight' ? (own?.status || 'WORKING') : (process.env.FAKE_TASK_STATUS || own?.status || 'WORKING'),
      epicId: 'epic-1',
      reopenCount: 0,
      assignedWorkerId: process.env.FAKE_SCOPE_ASSIGNED || args.workerId || null,
      assigneeAlive: true,
      asserted, planned,
      touchedFiles: list(own?.touchedFiles), inferredPaths: list(own?.inferredPaths), unattributedPaths: list(own?.unattributedPaths),
      peerDeclared,
      livePeerIds: peersActive ? ['worker-peer'] : [],
      activePeerIds: peersActive ? ['worker-peer'] : [],
      peersActive,
      alwaysInclude,
      excludePrefixes: [],
      policy: { autoCommit: true, checkpointCommits: true, checkpointPush: true, commitBoardState: true, commitHooks: false, undeclared: 'solo', contested: 'commit' }
    });
    break;
  }
  case 'record_commit': {
    // The daemon ledger: one JSON line per landing outcome, asserted on by
    // the scope scenarios (kind, paths, inferredPaths, unattributedPaths).
    fs.appendFileSync(path.join(moe, 'record_commit.jsonl'), JSON.stringify(args) + '\n');
    ok({ success: true, taskId: args.taskId, kind: args.kind, outcome: args.outcome, commitCount: 1, filesModified: args.paths || [], addedPaths: args.paths || [] });
    break;
  }
  case 'declare_files': ok({ success: true, taskId: args.taskId, declaredFiles: args.paths || [], addedPaths: args.paths || [] }); break;
  case 'deregister_worker': {
    // The EXIT-trap deregister; scenario W proves it still runs after the
    // teardown rescue.
    fs.appendFileSync(path.join(moe, 'deregister.log'), `${new Date().toISOString()} ${args.workerId} ${args.reason || ''}\n`);
    ok({ success: true });
    break;
  }
  default: ok({ success: true });
}
JS

set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" timeout 60s \
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
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout 60s \
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
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout 60s \
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
  MOE_HEARTBEAT_INTERVAL_SEC=1 MOE_HEARTBEAT_MAX_DURATION_SEC=30 timeout 60s \
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
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS=REVIEW timeout 60s \
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
  # [scenario Q] Gate-failed work goes to a RESCUE REF (refs/moe/rescue/<task>/
  # <ts>), never a branch commit, so code that failed the epic-final gate can't
  # reach origin via a peer's push -- but the bytes are not lost either.
  echo "[scenario Q] gate failure parks the owned paths on a rescue ref"
  gate_fail_rescue="$(git -C "$GATE_FAIL_DIR" for-each-ref --format='%(refname)' 'refs/moe/rescue/task-postflight/' | head -n1)"
  if [ -z "$gate_fail_rescue" ]; then
    cat "$TMP_DIR/wrapper-gate-fail.out" >&2 || true
    echo "A failing qualityGate must park the session's edits on refs/moe/rescue/task-postflight/*" >&2
    exit 1
  fi
  if ! git -C "$GATE_FAIL_DIR" show --pretty=format: --name-only "$gate_fail_rescue" | grep -q '^work\.txt$'; then
    git -C "$GATE_FAIL_DIR" show --stat "$gate_fail_rescue" >&2 || true
    echo "The rescue ref must carry the owned path work.txt" >&2
    exit 1
  fi
  if ! git -C "$GATE_FAIL_DIR" log -1 --pretty=%s "$gate_fail_rescue" | grep -Fq 'rescue(task-postflight): Postflight smoke [reason=gate-failed]'; then
    git -C "$GATE_FAIL_DIR" log -1 --pretty=%s "$gate_fail_rescue" >&2 || true
    echo "Expected the rescue commit subject 'rescue(task-postflight): Postflight smoke [reason=gate-failed]'" >&2
    exit 1
  fi
  if ! grep -Fq 'MOE_RESCUE_REF task=task-postflight' "$TMP_DIR/wrapper-gate-fail.out"; then
    cat "$TMP_DIR/wrapper-gate-fail.out" >&2 || true
    echo "Expected MOE_RESCUE_REF in the wrapper log" >&2
    exit 1
  fi
  if ! grep -Fq 'MOE_RESCUE_REF task=task-postflight' "$GATE_FAIL_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$GATE_FAIL_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    echo "Expected MOE_RESCUE_REF in chat" >&2
    exit 1
  fi
  if ! grep -Fq '"kind":"rescue"' "$GATE_FAIL_DIR/.moe/record_commit.jsonl"; then
    cat "$GATE_FAIL_DIR/.moe/record_commit.jsonl" >&2 || true
    echo "Expected a kind=rescue record_commit entry" >&2
    exit 1
  fi
  # The failed record is sent UNCONDITIONALLY after the rescue (both twins), so
  # task.lastCommitOutcome reads failed/MOE_COMMIT_FAILED_GATE, not committed/rescue.
  gate_fail_last_record="$(tail -n1 "$GATE_FAIL_DIR/.moe/record_commit.jsonl" 2>/dev/null || true)"
  case "$gate_fail_last_record" in
    *'"outcome":"failed"'*MOE_COMMIT_FAILED_GATE*|*MOE_COMMIT_FAILED_GATE*'"outcome":"failed"'*) : ;;
    *)
      cat "$GATE_FAIL_DIR/.moe/record_commit.jsonl" >&2 || true
      echo "The LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_GATE (sent even when the rescue succeeded)" >&2
      exit 1 ;;
  esac
  if [ -n "$(git -C "$GATE_FAIL_DIR" status --porcelain --untracked-files=no)" ] && ! git -C "$GATE_FAIL_DIR" status --porcelain | grep -q 'work\.txt'; then
    echo "The working tree must keep the un-landed edits after a rescue" >&2
    exit 1
  fi
  echo "[scenario Q] ok"

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

  # Case 4b: daemon-provided isEpicFinal. Newer daemons compute epic-final
  # board-side and serve it in get_context; when present the wrapper must
  # PREFER it over the list_tasks fallback (Case 4 above, which runs with the
  # field absent, keeps pinning the fallback for old daemons). Two directions,
  # each one a discriminator against silently using the fallback:
  #   b1: daemon says false (task-level) with NO sibling knob -- the fallback
  #       would compute final=true and run the failing gate; the daemon value
  #       must defer it instead, so the commit lands.
  echo "[case 4b] daemon isEpicFinal is preferred over the list_tasks fallback"
  GATE_DMID_DIR="$TMP_DIR/gate-daemonmid"
  make_gate_project "$GATE_DMID_DIR" "exit 9"
  set +e
  FAKE_CTX_IS_EPIC_FINAL=false run_gate_wrapper "$GATE_DMID_DIR" "$TMP_DIR/wrapper-gate-daemonmid.out"
  gate_dmid_code=$?
  set -e
  if [ "$gate_dmid_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-daemonmid.out" >&2 || true
    echo "Gate-daemonmid wrapper exited with $gate_dmid_code" >&2
    exit 1
  fi
  if ! grep -Fq 'qualityGate deferred' "$TMP_DIR/wrapper-gate-daemonmid.out"; then
    cat "$TMP_DIR/wrapper-gate-daemonmid.out" >&2 || true
    echo "A daemon isEpicFinal=false must defer the gate even when the sibling page would say epic-final" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_DMID_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-daemonmid.out" >&2 || true
    echo "Daemon-deferred gate must not block the commit (expected 2 commits)" >&2
    exit 1
  fi
  #   b2: daemon says true (top-level placement) while the sibling page says
  #       mid-epic -- the fallback would defer; the daemon value must run the
  #       failing gate, which blocks the commit.
  GATE_DFINAL_DIR="$TMP_DIR/gate-daemonfinal"
  make_gate_project "$GATE_DFINAL_DIR" "exit 3"
  set +e
  FAKE_CTX_IS_EPIC_FINAL=true FAKE_CTX_IS_EPIC_FINAL_AT=top FAKE_SIBLING_ORDER=99 \
    run_gate_wrapper "$GATE_DFINAL_DIR" "$TMP_DIR/wrapper-gate-daemonfinal.out"
  gate_dfinal_code=$?
  set -e
  if [ "$gate_dfinal_code" -ne 0 ]; then
    cat "$TMP_DIR/wrapper-gate-daemonfinal.out" >&2 || true
    echo "Gate-daemonfinal wrapper exited with $gate_dfinal_code" >&2
    exit 1
  fi
  if ! grep -Fq 'qualityGate failed (exit 3)' "$TMP_DIR/wrapper-gate-daemonfinal.out"; then
    cat "$TMP_DIR/wrapper-gate-daemonfinal.out" >&2 || true
    echo "A daemon isEpicFinal=true must run the gate even when the sibling page says mid-epic" >&2
    exit 1
  fi
  if [ "$(git -C "$GATE_DFINAL_DIR" rev-list --count HEAD)" -ne 1 ]; then
    cat "$TMP_DIR/wrapper-gate-daemonfinal.out" >&2 || true
    echo "The daemon-final failing gate must block the commit (expected 1 commit)" >&2
    exit 1
  fi
  echo "[case 4b] ok"

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
  # [scenario V] An unresolved status no longer strands the work: the task ID
  # is certain, only its status is not, so the session's edits land as a
  # CHECKPOINT with status=UNKNOWN (never as a completion), and the loud
  # lookup warning + chat escalation above stay.
  echo "[scenario V] status lookup failure lands a status=UNKNOWN checkpoint"
  if [ "$(git -C "$GATE_LOOKUP_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-lookupfail.out" >&2 || true
    echo "An unresolved status must land a status=UNKNOWN checkpoint (expected 2 commits)" >&2
    exit 1
  fi
  gate_lookup_subject="$(git -C "$GATE_LOOKUP_DIR" log -1 --pretty=%s)"
  if [ "$gate_lookup_subject" != "wip(task-postflight): Postflight smoke [status=UNKNOWN role=worker cli-exit=0]" ]; then
    cat "$TMP_DIR/wrapper-gate-lookupfail.out" >&2 || true
    echo "Expected a wip(...) [status=UNKNOWN ...] checkpoint subject; got [$gate_lookup_subject]" >&2
    exit 1
  fi
  if git -C "$GATE_LOOKUP_DIR" log -1 --pretty=%B | grep -q '^Moe-Kind: completion'; then
    echo "An unresolved status must never produce a completion commit" >&2
    exit 1
  fi
  echo "[scenario V] ok"

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
  # Same rule as case 6: the mismatch is a lookup failure, so the edits land
  # as a status=UNKNOWN checkpoint on the REQUESTED task id -- never as the
  # other task's completion.
  if [ "$(git -C "$GATE_MISMATCH_DIR" rev-list --count HEAD)" -ne 2 ]; then
    cat "$TMP_DIR/wrapper-gate-mismatch.out" >&2 || true
    echo "A get_context fallback onto a different task must land a status=UNKNOWN checkpoint (expected 2 commits)" >&2
    exit 1
  fi
  if ! git -C "$GATE_MISMATCH_DIR" log -1 --pretty=%s | grep -Fq 'wip(task-postflight): Postflight smoke [status=UNKNOWN role=worker cli-exit=0]'; then
    git -C "$GATE_MISMATCH_DIR" log -1 --pretty=%s >&2 || true
    echo "Expected a wip(...) [status=UNKNOWN ...] checkpoint on the requested task id" >&2
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

  make_scope_project() { # $1 = dir, $2 = filesModified JSON array literal, [$3 = record status], [$4 = implementationPlan JSON], [$5 = settings JSON object]
    local dir="$1" files_json="$2" status="${3:-REVIEW}" plan_json="${4:-[]}" settings_json="${5:-}"
    if [ -z "$settings_json" ]; then settings_json='{}'; fi
    mkdir -p "$dir/.moe/messages"
    "$NODE_FOR_TEST" -e 'const [d,s]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"proj-scope",name:"postflight-scope",settings:JSON.parse(s)})+"\n");' \
      "$dir/.moe/project.json" "$settings_json"
    write_task_record "$dir" "$files_json" "$status" "$plan_json"
    : > "$dir/.moe/messages/chan-general.jsonl"
    git -C "$dir" init -q
    git -C "$dir" config user.email moe@test.local
    git -C "$dir" config user.name "Moe Test"
    echo seed > "$dir/seed.txt"
    # The task's own record is TRACKED and clean at the seed, as in a real
    # project (.moe/tasks/ is committed; the daemon rewrites records during a
    # session). Only a record the session actually changed is a board-state
    # candidate (scenario P dirties it on purpose); a clean tracked record is
    # invisible to the attribution and keeps A-E's exact-path assertions.
    git -C "$dir" add seed.txt .moe/tasks/task-postflight.json >/dev/null
    git -C "$dir" commit -qm init >/dev/null
  }

  run_scope_wrapper() { # $1 = project dir, $2 = output file, [$3 = command], [$4 = role], [$5 = worker id], [$6.. = extra wrapper args]
    local dir="$1" out="$2" cmd="${3:-/bin/true}" role="${4:-worker}" wid="${5:-worker-scope}"
    shift 2
    if [ $# -gt 0 ]; then shift; fi
    if [ $# -gt 0 ]; then shift; fi
    if [ $# -gt 0 ]; then shift; fi
    # FAKE_TASK_STATUS models the status the task reaches AFTER the CLI ran;
    # callers override it with an env prefix (the old hard-coded REVIEW
    # silently overrode a caller's BLOCKED).
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS="${FAKE_TASK_STATUS:-REVIEW}" timeout 60s \
      "$WRAPPER" \
      --project "$dir" \
      --worker-id "$wid" \
      --role "$role" \
      --team Smoke \
      --no-start-daemon \
      --command "$cmd" \
      --no-loop \
      --poll-interval 0 \
      "$@" \
      >"$out" 2>&1
  }

  # Fake CLIs for the attribution scenarios. The wrapper launches the claude
  # CLI type after `cd "$PROJECT"` and exports MOE_PROJECT_PATH; the scripts
  # still write via MOE_PROJECT_PATH so they cannot land in the harness cwd.
  # FILE_CLI creates session-new.txt (undeclared, measured) and, when
  # FAKE_CLI_EXTRA_FILE is set, that path too (a peer-declared one).
  FILE_CLI="$TMP_DIR/file-cli"
  cat > "$FILE_CLI" <<'EOF'
#!/usr/bin/env bash
echo new > "$MOE_PROJECT_PATH/session-new.txt"
if [ -n "${FAKE_CLI_EXTRA_FILE:-}" ]; then
  echo extra > "$MOE_PROJECT_PATH/$FAKE_CLI_EXTRA_FILE"
fi
exit 0
EOF
  chmod +x "$FILE_CLI"
  # STREAM_CLI emits a synthetic stream-json transcript: a streamed Write
  # tool_use (content_block_start/delta/stop) on a RELATIVE path and a
  # non-streamed assistant message carrying a full tool_use.input with an
  # ABSOLUTE path under the project -- both must be harvested into the TOOL
  # tier -- and writes both files.
  STREAM_CLI="$TMP_DIR/stream-cli"
  cat > "$STREAM_CLI" <<'EOF'
#!/usr/bin/env bash
abs_root="$MOE_PROJECT_PATH"
if command -v cygpath >/dev/null 2>&1; then abs_root="$(cygpath -m "$MOE_PROJECT_PATH")"; fi
echo tool > "$MOE_PROJECT_PATH/tool-written.txt"
echo tool-abs > "$MOE_PROJECT_PATH/tool-written-abs.txt"
printf '%s\n' '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"fake"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Write"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"tool-wr"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"itten.txt\",\"content\":\"tool\"}"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop"}}'
abs_json="$(printf '%s' "$abs_root/tool-written-abs.txt" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Write\",\"input\":{\"file_path\":\"$abs_json\",\"content\":\"tool-abs\"}}]}}"
printf '%s\n' '{"type":"result","num_turns":1,"duration_ms":10,"stop_reason":"end_turn"}'
exit 0
EOF
  chmod +x "$STREAM_CLI"

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

  # ---- Land-on-every-exit scenarios F-X (Q and V live in the gate cases) ----

  # Scenario F -- a BLOCKED exit is no longer a silent no-op: it lands a wip
  # checkpoint of the owned paths on the shared moe/work-* branch, and ONLY
  # those (the dirty peer file is load-bearing, as in C).
  echo "[scenario F] a BLOCKED exit lands a wip checkpoint of owned paths only"
  SCOPE_F_DIR="$TMP_DIR/scope-f"
  make_scope_project "$SCOPE_F_DIR" '["owned-a.txt"]' WORKING
  echo owned-a  > "$SCOPE_F_DIR/owned-a.txt"
  echo peer-new > "$SCOPE_F_DIR/peer-untracked.txt"
  set +e
  FAKE_TASK_STATUS=BLOCKED run_scope_wrapper "$SCOPE_F_DIR" "$TMP_DIR/scope-f.out"
  scope_f_code=$?
  set -e
  [ "$scope_f_code" -eq 0 ] || scope_fail F "wrapper exited with $scope_f_code" "$TMP_DIR/scope-f.out"
  scope_f_branch="$(git -C "$SCOPE_F_DIR" symbolic-ref --short HEAD)"
  case "$scope_f_branch" in
    moe/work-*) : ;;
    *) scope_fail F "checkpoint must land on moe/work-<date>; on [$scope_f_branch]" "$TMP_DIR/scope-f.out" ;;
  esac
  scope_f_subject="$(git -C "$SCOPE_F_DIR" log -1 --pretty=%s)"
  if [ "$scope_f_subject" != "wip(task-postflight): Postflight smoke [status=BLOCKED role=worker cli-exit=0]" ]; then
    scope_fail F "expected the exact wip checkpoint subject; got [$scope_f_subject]" "$TMP_DIR/scope-f.out"
  fi
  scope_f_files="$(committed_paths "$SCOPE_F_DIR")"
  if [ "$scope_f_files" != "owned-a.txt " ]; then
    scope_fail F "checkpoint must contain EXACTLY the owned paths; got [$scope_f_files]" "$TMP_DIR/scope-f.out"
  fi
  if ! git -C "$SCOPE_F_DIR" status --porcelain | grep -q '^?? peer-untracked\.txt$'; then
    scope_fail F "peer-untracked.txt must survive the checkpoint untouched" "$TMP_DIR/scope-f.out"
  fi
  if grep -Eq 'MOE_COMMIT_REFUSED_(NO_OWNED_PATHS|OWNED_PATH_MISSING)' "$TMP_DIR/scope-f.out"; then
    scope_fail F "a checkpoint of declared dirty paths must not refuse" "$TMP_DIR/scope-f.out"
  fi
  if ! grep -Fq '"kind":"checkpoint"' "$SCOPE_F_DIR/.moe/record_commit.jsonl"; then
    cat "$SCOPE_F_DIR/.moe/record_commit.jsonl" >&2 || true
    scope_fail F "record_commit must be told kind=checkpoint" "$TMP_DIR/scope-f.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario F] ok"

  # Scenario G -- measured attribution: a file the session created but never
  # reported rides along when NO other worker is active (attribution.undeclared
  # default 'solo'), marked inferred in the ledger.
  echo "[scenario G] solo session: an undeclared session-created file is committed and marked inferred"
  SCOPE_G_DIR="$TMP_DIR/scope-g"
  make_scope_project "$SCOPE_G_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_G_DIR/owned-a.txt"
  set +e
  run_scope_wrapper "$SCOPE_G_DIR" "$TMP_DIR/scope-g.out" "$FILE_CLI"
  scope_g_code=$?
  set -e
  [ "$scope_g_code" -eq 0 ] || scope_fail G "wrapper exited with $scope_g_code" "$TMP_DIR/scope-g.out"
  scope_g_files="$(committed_paths "$SCOPE_G_DIR")"
  if [ "$scope_g_files" != "owned-a.txt session-new.txt " ]; then
    scope_fail G "expected owned + measured session file; got [$scope_g_files]" "$TMP_DIR/scope-g.out"
  fi
  if ! grep -Fq '"inferredPaths":["session-new.txt"]' "$SCOPE_G_DIR/.moe/record_commit.jsonl"; then
    cat "$SCOPE_G_DIR/.moe/record_commit.jsonl" >&2 || true
    scope_fail G "the measured path must be recorded as inferred, never promoted" "$TMP_DIR/scope-g.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario G] ok"

  # Scenario H -- the hard constraint: a path dirty BEFORE the session that the
  # task never asserted is never committed, even by measured attribution. The
  # baseline TSV under .git/moe/baseline/ is what proves "before".
  echo "[scenario H] pre-session dirty files are never committed; baseline persists and prunes landed paths"
  SCOPE_H_DIR="$TMP_DIR/scope-h"
  make_scope_project "$SCOPE_H_DIR" '["owned-a.txt"]'
  echo base > "$SCOPE_H_DIR/baseline-mod.txt"
  git -C "$SCOPE_H_DIR" add baseline-mod.txt >/dev/null
  git -C "$SCOPE_H_DIR" commit -qm baseline-base >/dev/null
  echo drifted > "$SCOPE_H_DIR/baseline-mod.txt"
  echo debris  > "$SCOPE_H_DIR/baseline-new.txt"
  echo owned-a > "$SCOPE_H_DIR/owned-a.txt"
  set +e
  run_scope_wrapper "$SCOPE_H_DIR" "$TMP_DIR/scope-h.out" "$FILE_CLI"
  scope_h_code=$?
  set -e
  [ "$scope_h_code" -eq 0 ] || scope_fail H "wrapper exited with $scope_h_code" "$TMP_DIR/scope-h.out"
  scope_h_files="$(committed_paths "$SCOPE_H_DIR")"
  if [ "$scope_h_files" != "owned-a.txt session-new.txt " ]; then
    scope_fail H "pre-session dirt must stay out; got [$scope_h_files]" "$TMP_DIR/scope-h.out"
  fi
  if ! git -C "$SCOPE_H_DIR" status --porcelain | grep -q '^ M baseline-mod\.txt$'; then
    scope_fail H "baseline-mod.txt must still be modified-and-unstaged" "$TMP_DIR/scope-h.out"
  fi
  if ! git -C "$SCOPE_H_DIR" status --porcelain | grep -q '^?? baseline-new\.txt$'; then
    scope_fail H "baseline-new.txt must still be untracked" "$TMP_DIR/scope-h.out"
  fi
  if git -C "$SCOPE_H_DIR" cat-file -e HEAD:baseline-new.txt 2>/dev/null; then
    scope_fail H "baseline-new.txt reached HEAD" "$TMP_DIR/scope-h.out"
  fi
  SCOPE_H_BASELINE="$SCOPE_H_DIR/.git/moe/baseline/task-postflight.tsv"
  if [ ! -f "$SCOPE_H_BASELINE" ]; then
    scope_fail H "expected the persisted baseline at .git/moe/baseline/task-postflight.tsv" "$TMP_DIR/scope-h.out"
  fi
  if ! grep -q 'baseline-mod\.txt' "$SCOPE_H_BASELINE"; then
    cat "$SCOPE_H_BASELINE" >&2 || true
    scope_fail H "the baseline must keep carrying the foreign dirty path" "$TMP_DIR/scope-h.out"
  fi
  if grep -q 'owned-a\.txt' "$SCOPE_H_BASELINE"; then
    cat "$SCOPE_H_BASELINE" >&2 || true
    scope_fail H "landed paths must be pruned from the baseline after a successful landing" "$TMP_DIR/scope-h.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario H] ok"

  # Scenario I -- a path another LIVE task's plan names is never swept, even
  # when this session's CLI (mis)creates it: peer declaration wins over
  # measured attribution.
  echo "[scenario I] a live peer's declared path is never committed by this task"
  SCOPE_I_DIR="$TMP_DIR/scope-i"
  make_scope_project "$SCOPE_I_DIR" '["owned-a.txt"]'
  write_peer_task_record "$SCOPE_I_DIR"
  echo owned-a > "$SCOPE_I_DIR/owned-a.txt"
  set +e
  FAKE_CLI_EXTRA_FILE=peer-plan.txt run_scope_wrapper "$SCOPE_I_DIR" "$TMP_DIR/scope-i.out" "$FILE_CLI"
  scope_i_code=$?
  set -e
  [ "$scope_i_code" -eq 0 ] || scope_fail I "wrapper exited with $scope_i_code" "$TMP_DIR/scope-i.out"
  scope_i_files="$(committed_paths "$SCOPE_I_DIR")"
  if [ "$scope_i_files" != "owned-a.txt session-new.txt " ]; then
    scope_fail I "peer-plan.txt must stay out of the commit; got [$scope_i_files]" "$TMP_DIR/scope-i.out"
  fi
  if ! git -C "$SCOPE_I_DIR" status --porcelain | grep -q '^?? peer-plan\.txt$'; then
    scope_fail I "peer-plan.txt must still be untracked" "$TMP_DIR/scope-i.out"
  fi
  if git -C "$SCOPE_I_DIR" cat-file -e HEAD:peer-plan.txt 2>/dev/null; then
    scope_fail I "peer-plan.txt reached HEAD" "$TMP_DIR/scope-i.out"
  fi
  if ! grep -Fq 'MOE_ATTR_PEER_DECLARED(task-peer)' "$TMP_DIR/scope-i.out"; then
    scope_fail I "expected the MOE_ATTR_PEER_DECLARED(task-peer) skip code" "$TMP_DIR/scope-i.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario I] ok"

  # Scenario J -- with another worker ACTIVE, an undeclared session file is
  # NOT committed (could be the peer's in the shared checkout): it is reported
  # as unattributed instead, loudly.
  echo "[scenario J] peers active: an undeclared file stays out and is reported MOE_ATTRIBUTION_UNRESOLVED"
  SCOPE_J_DIR="$TMP_DIR/scope-j"
  make_scope_project "$SCOPE_J_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_J_DIR/owned-a.txt"
  set +e
  FAKE_SCOPE_PEERS_ACTIVE=1 run_scope_wrapper "$SCOPE_J_DIR" "$TMP_DIR/scope-j.out" "$FILE_CLI"
  scope_j_code=$?
  set -e
  [ "$scope_j_code" -eq 0 ] || scope_fail J "wrapper exited with $scope_j_code" "$TMP_DIR/scope-j.out"
  scope_j_files="$(committed_paths "$SCOPE_J_DIR")"
  if [ "$scope_j_files" != "owned-a.txt " ]; then
    scope_fail J "with peers active only asserted paths may land; got [$scope_j_files]" "$TMP_DIR/scope-j.out"
  fi
  if ! git -C "$SCOPE_J_DIR" status --porcelain | grep -q '^?? session-new\.txt$'; then
    scope_fail J "session-new.txt must stay untracked" "$TMP_DIR/scope-j.out"
  fi
  if ! grep -Fq 'MOE_ATTRIBUTION_UNRESOLVED task=task-postflight' "$TMP_DIR/scope-j.out"; then
    scope_fail J "expected the MOE_ATTRIBUTION_UNRESOLVED banner" "$TMP_DIR/scope-j.out"
  fi
  if ! grep -Fq '"unattributedPaths":["session-new.txt"]' "$SCOPE_J_DIR/.moe/record_commit.jsonl"; then
    cat "$SCOPE_J_DIR/.moe/record_commit.jsonl" >&2 || true
    scope_fail J "the unattributed path must reach the ledger" "$TMP_DIR/scope-j.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario J] ok"

  # Scenario K -- the TOOL tier: paths this session's editing tools were seen
  # writing (stream-json harvest; one streamed relative, one non-streamed
  # absolute) are the session's own even with peers active.
  echo "[scenario K] tool-written files are committed even with peers active"
  SCOPE_K_DIR="$TMP_DIR/scope-k"
  make_scope_project "$SCOPE_K_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_K_DIR/owned-a.txt"
  set +e
  FAKE_SCOPE_PEERS_ACTIVE=1 run_scope_wrapper "$SCOPE_K_DIR" "$TMP_DIR/scope-k.out" "$STREAM_CLI"
  scope_k_code=$?
  set -e
  [ "$scope_k_code" -eq 0 ] || scope_fail K "wrapper exited with $scope_k_code" "$TMP_DIR/scope-k.out"
  scope_k_files="$(committed_paths "$SCOPE_K_DIR")"
  if [ "$scope_k_files" != "owned-a.txt tool-written-abs.txt tool-written.txt " ]; then
    scope_fail K "expected owned + both tool-written files; got [$scope_k_files]" "$TMP_DIR/scope-k.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario K] ok"

  # Scenario L -- the two-tier split: an ASSERTED path dirty at baseline and
  # unchanged is still committed (declaration wins -- the b54b5609 stranding),
  # while a merely PLANNED path dirty at baseline and unchanged is skipped as
  # pre-existing (the over-declaration sweep).
  echo "[scenario L] asserted-but-unchanged commits; planned-but-unchanged stays MOE_ATTR_PREEXISTING"
  SCOPE_L_DIR="$TMP_DIR/scope-l"
  make_scope_project "$SCOPE_L_DIR" '["owned-a.txt"]' REVIEW '[{"stepId":"s0","title":"later step","status":"PENDING","affectedFiles":["planned.txt"]}]'
  echo owned-a > "$SCOPE_L_DIR/owned-a.txt"
  echo planned > "$SCOPE_L_DIR/planned.txt"
  set +e
  run_scope_wrapper "$SCOPE_L_DIR" "$TMP_DIR/scope-l.out"
  scope_l_code=$?
  set -e
  [ "$scope_l_code" -eq 0 ] || scope_fail L "wrapper exited with $scope_l_code" "$TMP_DIR/scope-l.out"
  scope_l_files="$(committed_paths "$SCOPE_L_DIR")"
  if [ "$scope_l_files" != "owned-a.txt " ]; then
    scope_fail L "only the asserted path may land; got [$scope_l_files]" "$TMP_DIR/scope-l.out"
  fi
  if ! grep -Fq '[skip] planned.txt MOE_ATTR_PREEXISTING' "$TMP_DIR/scope-l.out"; then
    scope_fail L "expected '[skip] planned.txt MOE_ATTR_PREEXISTING'" "$TMP_DIR/scope-l.out"
  fi
  if ! git -C "$SCOPE_L_DIR" status --porcelain | grep -q '^?? planned\.txt$'; then
    scope_fail L "planned.txt must still be untracked" "$TMP_DIR/scope-l.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario L] ok"

  # Scenario M -- recovery: a lingering baseline (previous session died without
  # landing) is landed as a `... recovered` checkpoint BEFORE the CLI launches,
  # on the resume path AND on the BLOCKED-hold idle path (no CLI at all).
  echo "[scenario M] a lingering baseline is recovered before launch (resume and BLOCKED hold)"
  SCOPE_M_DIR="$TMP_DIR/scope-m"
  make_scope_project "$SCOPE_M_DIR" '["ignored.txt"]'
  write_task_record "$SCOPE_M_DIR" '["owned-a.txt"]' WORKING '[]' task-resume
  echo owned-a > "$SCOPE_M_DIR/owned-a.txt"
  mkdir -p "$SCOPE_M_DIR/.git/moe/baseline"
  # A realistic lingering baseline: the .moe/ records were already dirty when
  # the dead session started (B rows with their current blobs), while
  # owned-a.txt is that session's own unlanded edit. The baselined-UNCHANGED
  # own record must still land (board: own task record always while dirty) --
  # the exact-set assertion below pins that contract, same as the ps1 twin.
  {
    printf '#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head=%s landed=0\n' "$(git -C "$SCOPE_M_DIR" rev-parse HEAD)"
    for scope_m_p in .moe/project.json .moe/messages/chan-general.jsonl .moe/tasks/task-postflight.json .moe/tasks/task-resume.json; do
      printf 'B\t%s\t%s\n' "$(git -C "$SCOPE_M_DIR" hash-object -- "$scope_m_p")" "$scope_m_p"
    done
  } > "$SCOPE_M_DIR/.git/moe/baseline/task-resume.tsv"
  set +e
  FAKE_CLAIM_MODE=resume run_scope_wrapper "$SCOPE_M_DIR" "$TMP_DIR/scope-m.out" /bin/true worker qa-scope-m
  scope_m_code=$?
  set -e
  [ "$scope_m_code" -eq 0 ] || scope_fail M "wrapper exited with $scope_m_code" "$TMP_DIR/scope-m.out"
  if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-resume' "$TMP_DIR/scope-m.out"; then
    scope_fail M "expected MOE_CHECKPOINT_RECOVERED for the resumed task" "$TMP_DIR/scope-m.out"
  fi
  recovered_line="$(grep -Fn 'MOE_CHECKPOINT_RECOVERED task=task-resume' "$TMP_DIR/scope-m.out" | head -n1 | cut -d: -f1)"
  starting_line="$(grep -n 'Starting claude' "$TMP_DIR/scope-m.out" | head -n1 | cut -d: -f1)"
  if [ -n "$starting_line" ] && [ "$recovered_line" -ge "$starting_line" ]; then
    scope_fail M "the recovery landing must happen BEFORE the CLI launch" "$TMP_DIR/scope-m.out"
  fi
  scope_m_subject="$(git -C "$SCOPE_M_DIR" log --pretty=%s --fixed-strings --grep='Moe-Task: task-resume' | head -n1)"
  case "$scope_m_subject" in
    "wip(task-resume): Resume smoke [status="*"] recovered") : ;;
    *) scope_fail M "expected a '... recovered' wip subject for task-resume; got [$scope_m_subject]" "$TMP_DIR/scope-m.out" ;;
  esac
  scope_m_sha="$(git -C "$SCOPE_M_DIR" log --format=%H --fixed-strings --grep='Moe-Task: task-resume' | head -n1)"
  scope_m_files="$(git -C "$SCOPE_M_DIR" show --pretty=format: --name-only "$scope_m_sha" | sed '/^$/d' | sort | tr '\n' ' ')"
  if [ "$scope_m_files" != ".moe/tasks/task-resume.json owned-a.txt " ]; then
    scope_fail M "the recovered checkpoint must carry EXACTLY the own record + owned-a.txt; got [$scope_m_files]" "$TMP_DIR/scope-m.out"
  fi
  # M-b: the BLOCKED-hold suppression path recovers the held task's baseline
  # with NO CLI relaunch burned on it.
  SCOPE_MB_DIR="$TMP_DIR/scope-mb"
  make_scope_project "$SCOPE_MB_DIR" '["ignored.txt"]'
  write_task_record "$SCOPE_MB_DIR" '["owned-a.txt"]' BLOCKED '[]' task-blocked
  echo owned-a > "$SCOPE_MB_DIR/owned-a.txt"
  mkdir -p "$SCOPE_MB_DIR/.git/moe/baseline"
  printf '#moe-baseline v1 task=task-blocked at=2026-01-01T00:00:00Z head= landed=0\n' > "$SCOPE_MB_DIR/.git/moe/baseline/task-blocked.tsv"
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_MB_DIR" "$TMP_DIR/scope-mb.out" /bin/true worker worker-scope-mb
  scope_mb_code=$?
  set -e
  [ "$scope_mb_code" -eq 0 ] || scope_fail M "blocked-hold wrapper exited with $scope_mb_code" "$TMP_DIR/scope-mb.out"
  if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-mb.out"; then
    scope_fail M "the BLOCKED hold must recover the held task's baseline before idling" "$TMP_DIR/scope-mb.out"
  fi
  scope_mb_subject="$(git -C "$SCOPE_MB_DIR" log --pretty=%s --fixed-strings --grep='Moe-Task: task-blocked' | head -n1)"
  case "$scope_mb_subject" in
    "wip(task-blocked): Blocked smoke [status=BLOCKED role=worker cli-exit=0] recovered") : ;;
    *) scope_fail M "expected the exact recovered BLOCKED wip subject; got [$scope_mb_subject]" "$TMP_DIR/scope-mb.out" ;;
  esac
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario M] ok"

  # Scenario N -- scenario B under PLUMBING: the temp-index landing must leave
  # a peer's pre-staged shared-index entry alone AND the index refresh must
  # make `git status` clean for exactly the landed paths.
  echo "[scenario N] plumbing landing preserves a peer's staged entry and refreshes the shared index"
  SCOPE_N_DIR="$TMP_DIR/scope-n"
  make_scope_project "$SCOPE_N_DIR" '["owned-a.txt"]'
  echo owned-a     > "$SCOPE_N_DIR/owned-a.txt"
  echo peer-staged > "$SCOPE_N_DIR/peer-staged.txt"
  git -C "$SCOPE_N_DIR" add peer-staged.txt >/dev/null
  set +e
  run_scope_wrapper "$SCOPE_N_DIR" "$TMP_DIR/scope-n.out"
  scope_n_code=$?
  set -e
  [ "$scope_n_code" -eq 0 ] || scope_fail N "wrapper exited with $scope_n_code" "$TMP_DIR/scope-n.out"
  scope_n_files="$(committed_paths "$SCOPE_N_DIR")"
  if [ "$scope_n_files" != "owned-a.txt " ]; then
    scope_fail N "commit must contain ONLY owned-a.txt; got [$scope_n_files]" "$TMP_DIR/scope-n.out"
  fi
  if ! git -C "$SCOPE_N_DIR" diff --cached --name-only | grep -q '^peer-staged\.txt$'; then
    scope_fail N "the peer's pre-staged entry must survive the plumbing landing" "$TMP_DIR/scope-n.out"
  fi
  if git -C "$SCOPE_N_DIR" status --porcelain | grep -q 'owned-a\.txt'; then
    git -C "$SCOPE_N_DIR" status --porcelain >&2 || true
    scope_fail N "after the index refresh, git status must be clean for the landed path" "$TMP_DIR/scope-n.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario N] ok"

  # Scenario O -- the CAS retry: a peer commits to the shared branch between
  # our commit-tree and update-ref (via the test seam). The landing must
  # rebuild on the new tip: two commits, ours on top, both paths in HEAD.
  echo "[scenario O] update-ref contention rebuilds on the moved tip"
  SCOPE_O_DIR="$TMP_DIR/scope-o"
  make_scope_project "$SCOPE_O_DIR" '["owned-a.txt"]'
  echo owned-a   > "$SCOPE_O_DIR/owned-a.txt"
  echo hook-peer > "$SCOPE_O_DIR/peer-hook.txt"
  set +e
  MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='git add peer-hook.txt && git commit -m peer-race -- peer-hook.txt' \
    run_scope_wrapper "$SCOPE_O_DIR" "$TMP_DIR/scope-o.out"
  scope_o_code=$?
  set -e
  [ "$scope_o_code" -eq 0 ] || scope_fail O "wrapper exited with $scope_o_code" "$TMP_DIR/scope-o.out"
  if [ "$(git -C "$SCOPE_O_DIR" rev-list --count HEAD)" -ne 3 ]; then
    git -C "$SCOPE_O_DIR" log --oneline >&2 || true
    scope_fail O "expected init + peer-race + ours (3 commits)" "$TMP_DIR/scope-o.out"
  fi
  if ! git -C "$SCOPE_O_DIR" log -1 --pretty=%s | grep -Fq 'feat(task-postflight):'; then
    scope_fail O "our completion must be on top of the peer's race commit" "$TMP_DIR/scope-o.out"
  fi
  if ! git -C "$SCOPE_O_DIR" log -2 --pretty=%s | grep -Fq 'peer-race'; then
    scope_fail O "the peer's race commit must be preserved underneath" "$TMP_DIR/scope-o.out"
  fi
  git -C "$SCOPE_O_DIR" cat-file -e HEAD:owned-a.txt 2>/dev/null || scope_fail O "owned-a.txt missing from HEAD" "$TMP_DIR/scope-o.out"
  git -C "$SCOPE_O_DIR" cat-file -e HEAD:peer-hook.txt 2>/dev/null || scope_fail O "peer-hook.txt missing from HEAD" "$TMP_DIR/scope-o.out"
  if ! grep -Fq 'moved while landing task' "$TMP_DIR/scope-o.out"; then
    scope_fail O "expected the CAS-retry log line" "$TMP_DIR/scope-o.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario O] ok"

  # Scenario P -- board state: the task's OWN record (dirtied this session) is
  # committed with the task; a LIVE peer's record is not (commitBoardState
  # default true; the 965c37da sweep must not come back through this door).
  echo "[scenario P] own task record commits with the task; a live peer's record does not"
  SCOPE_P_DIR="$TMP_DIR/scope-p"
  make_scope_project "$SCOPE_P_DIR" '["owned-a.txt"]'
  write_peer_task_record "$SCOPE_P_DIR"
  echo owned-a > "$SCOPE_P_DIR/owned-a.txt"
  # Dirty the own record the way the daemon does mid-session (status flip).
  write_task_record "$SCOPE_P_DIR" '["owned-a.txt"]' WORKING
  set +e
  FAKE_SCOPE_PEERS_ACTIVE=1 run_scope_wrapper "$SCOPE_P_DIR" "$TMP_DIR/scope-p.out"
  scope_p_code=$?
  set -e
  [ "$scope_p_code" -eq 0 ] || scope_fail P "wrapper exited with $scope_p_code" "$TMP_DIR/scope-p.out"
  scope_p_files="$(committed_paths "$SCOPE_P_DIR")"
  if [ "$scope_p_files" != ".moe/tasks/task-postflight.json owned-a.txt " ]; then
    scope_fail P "expected the own record + owned path; got [$scope_p_files]" "$TMP_DIR/scope-p.out"
  fi
  if ! git -C "$SCOPE_P_DIR" status --porcelain | grep -q '^?? \.moe/tasks/task-peer\.json$'; then
    git -C "$SCOPE_P_DIR" status --porcelain >&2 || true
    scope_fail P "the live peer's record must stay untracked" "$TMP_DIR/scope-p.out"
  fi
  if git -C "$SCOPE_P_DIR" cat-file -e HEAD:.moe/tasks/task-peer.json 2>/dev/null; then
    scope_fail P "the live peer's record reached HEAD" "$TMP_DIR/scope-p.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario P] ok"

  # Scenario R -- peel failure (a branch literally named `moe` blocks creating
  # moe/work-<date>): the bytes go to a rescue ref, HEAD and branch stay put,
  # and the wrapper hard-stops (exit 0, loop broken) instead of looping on.
  echo "[scenario R] peel failure parks a rescue ref and stops the loop"
  SCOPE_R_DIR="$TMP_DIR/scope-r"
  make_scope_project "$SCOPE_R_DIR" '["owned-a.txt"]'
  git -C "$SCOPE_R_DIR" branch moe >/dev/null
  echo owned-a > "$SCOPE_R_DIR/owned-a.txt"
  scope_r_head="$(git -C "$SCOPE_R_DIR" rev-parse HEAD)"
  scope_r_branch="$(git -C "$SCOPE_R_DIR" symbolic-ref --short HEAD)"
  set +e
  run_scope_wrapper "$SCOPE_R_DIR" "$TMP_DIR/scope-r.out"
  scope_r_code=$?
  set -e
  [ "$scope_r_code" -eq 0 ] || scope_fail R "wrapper exited with $scope_r_code" "$TMP_DIR/scope-r.out"
  if [ "$(git -C "$SCOPE_R_DIR" rev-parse HEAD)" != "$scope_r_head" ]; then
    scope_fail R "HEAD must not move on a peel failure" "$TMP_DIR/scope-r.out"
  fi
  if [ "$(git -C "$SCOPE_R_DIR" symbolic-ref --short HEAD)" != "$scope_r_branch" ]; then
    scope_fail R "the branch must not change on a peel failure" "$TMP_DIR/scope-r.out"
  fi
  scope_r_rescue="$(git -C "$SCOPE_R_DIR" for-each-ref --format='%(refname)' 'refs/moe/rescue/task-postflight/' | head -n1)"
  [ -n "$scope_r_rescue" ] || scope_fail R "expected a rescue ref for the un-landable work" "$TMP_DIR/scope-r.out"
  if ! git -C "$SCOPE_R_DIR" log -1 --pretty=%s "$scope_r_rescue" | grep -Fq '[reason=peel-failed]'; then
    scope_fail R "expected [reason=peel-failed] on the rescue subject" "$TMP_DIR/scope-r.out"
  fi
  if ! grep -Fq 'MOE_RESCUE_REF task=task-postflight' "$TMP_DIR/scope-r.out"; then
    scope_fail R "expected MOE_RESCUE_REF in the log" "$TMP_DIR/scope-r.out"
  fi
  if ! grep -Fq 'stopping the worker loop' "$TMP_DIR/scope-r.out"; then
    scope_fail R "a peel failure must hard-stop the loop" "$TMP_DIR/scope-r.out"
  fi
  # Ledger parity: the last record is the unconditional failed/PEEL one.
  scope_r_last_record="$(tail -n1 "$SCOPE_R_DIR/.moe/record_commit.jsonl" 2>/dev/null || true)"
  case "$scope_r_last_record" in
    *'"outcome":"failed"'*MOE_COMMIT_FAILED_PEEL*|*MOE_COMMIT_FAILED_PEEL*'"outcome":"failed"'*) : ;;
    *)
      cat "$SCOPE_R_DIR/.moe/record_commit.jsonl" >&2 || true
      scope_fail R "the LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_PEEL" "$TMP_DIR/scope-r.out" ;;
  esac
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario R] ok"

  # Scenario S -- the DONE race (QA approved between CLI exit and the status
  # lookup) is a COMPLETION, not a silent skip and not a wip checkpoint.
  echo "[scenario S] a DONE status lands a completion commit"
  SCOPE_S_DIR="$TMP_DIR/scope-s"
  make_scope_project "$SCOPE_S_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_S_DIR/owned-a.txt"
  set +e
  FAKE_TASK_STATUS=DONE run_scope_wrapper "$SCOPE_S_DIR" "$TMP_DIR/scope-s.out"
  scope_s_code=$?
  set -e
  [ "$scope_s_code" -eq 0 ] || scope_fail S "wrapper exited with $scope_s_code" "$TMP_DIR/scope-s.out"
  scope_s_subject="$(git -C "$SCOPE_S_DIR" log -1 --pretty=%s)"
  if [ "$scope_s_subject" != "feat(task-postflight): Postflight smoke" ]; then
    scope_fail S "expected a feat completion subject; got [$scope_s_subject]" "$TMP_DIR/scope-s.out"
  fi
  if ! git -C "$SCOPE_S_DIR" log -1 --pretty=%B | grep -q '^Moe-Status: DONE$'; then
    scope_fail S "expected the Moe-Status: DONE trailer" "$TMP_DIR/scope-s.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario S] ok"

  # Scenario T -- architect sessions checkpoint too (role=<r> in the subject);
  # completion stays worker-only.
  echo "[scenario T] an architect WORKING exit lands a role=architect checkpoint"
  SCOPE_T_DIR="$TMP_DIR/scope-t"
  make_scope_project "$SCOPE_T_DIR" '["arch-notes.md"]'
  echo notes > "$SCOPE_T_DIR/arch-notes.md"
  set +e
  FAKE_TASK_STATUS=WORKING run_scope_wrapper "$SCOPE_T_DIR" "$TMP_DIR/scope-t.out" /bin/true architect architect-scope
  scope_t_code=$?
  set -e
  [ "$scope_t_code" -eq 0 ] || scope_fail T "wrapper exited with $scope_t_code" "$TMP_DIR/scope-t.out"
  scope_t_subject="$(git -C "$SCOPE_T_DIR" log -1 --pretty=%s)"
  if [ "$scope_t_subject" != "wip(task-postflight): Postflight smoke [status=WORKING role=architect cli-exit=0]" ]; then
    scope_fail T "expected the role=architect wip subject; got [$scope_t_subject]" "$TMP_DIR/scope-t.out"
  fi
  if ! git -C "$SCOPE_T_DIR" log -1 --pretty=%B | grep -q '^Moe-Kind: checkpoint$'; then
    scope_fail T "an architect exit must never be a completion" "$TMP_DIR/scope-t.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario T] ok"

  # Scenario U -- unborn HEAD (fresh init, zero commits): the landing peels the
  # unborn default branch onto moe/work-<date> and commits with NO parent and
  # a create-only update-ref.
  echo "[scenario U] an unborn repo lands a parentless first commit"
  SCOPE_U_DIR="$TMP_DIR/scope-u"
  mkdir -p "$SCOPE_U_DIR/.moe/messages"
  "$NODE_FOR_TEST" -e 'const [d]=process.argv.slice(1);require("fs").writeFileSync(d, JSON.stringify({id:"proj-scope",name:"postflight-scope",settings:{}})+"\n");' \
    "$SCOPE_U_DIR/.moe/project.json"
  write_task_record "$SCOPE_U_DIR" '["owned-a.txt"]'
  : > "$SCOPE_U_DIR/.moe/messages/chan-general.jsonl"
  git -C "$SCOPE_U_DIR" init -q
  git -C "$SCOPE_U_DIR" config user.email moe@test.local
  git -C "$SCOPE_U_DIR" config user.name "Moe Test"
  echo owned-a > "$SCOPE_U_DIR/owned-a.txt"
  set +e
  run_scope_wrapper "$SCOPE_U_DIR" "$TMP_DIR/scope-u.out"
  scope_u_code=$?
  set -e
  [ "$scope_u_code" -eq 0 ] || scope_fail U "wrapper exited with $scope_u_code" "$TMP_DIR/scope-u.out"
  if [ "$(git -C "$SCOPE_U_DIR" rev-list --count HEAD 2>/dev/null)" != "1" ]; then
    scope_fail U "expected exactly one (root) commit" "$TMP_DIR/scope-u.out"
  fi
  if [ -n "$(git -C "$SCOPE_U_DIR" log -1 --pretty=%P)" ]; then
    scope_fail U "the unborn landing must have no parent" "$TMP_DIR/scope-u.out"
  fi
  case "$(git -C "$SCOPE_U_DIR" symbolic-ref --short HEAD)" in
    moe/work-*) : ;;
    *) scope_fail U "the unborn default branch must be peeled onto moe/work-<date>" "$TMP_DIR/scope-u.out" ;;
  esac
  scope_u_files="$(committed_paths "$SCOPE_U_DIR")"
  if [ "$scope_u_files" != ".moe/tasks/task-postflight.json owned-a.txt " ]; then
    scope_fail U "expected the owned path + board record; got [$scope_u_files]" "$TMP_DIR/scope-u.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario U] ok"

  # Scenario W (bash only) -- Ctrl+C mid-CLI: the INT trap's exit path must
  # take a teardown rescue (refs/moe/rescue/<task>/<ts>, HEAD untouched) and
  # STILL deregister. `set -m` puts the backgrounded wrapper in its own
  # process group so a non-interactive harness can deliver SIGINT at all
  # (async jobs otherwise ignore it).
  echo "[scenario W] SIGINT mid-CLI parks a teardown rescue ref and still deregisters"
  SCOPE_W_DIR="$TMP_DIR/scope-w"
  make_scope_project "$SCOPE_W_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_W_DIR/owned-a.txt"
  # The EXIT-trap deregister goes through moe-call.sh, which refuses without
  # $PROJECT/.moe/daemon.json (daemon-not-running guard). The fake proxy never
  # reads it -- its presence is all the guard checks.
  printf '{"port":9876,"projectPath":"%s"}\n' "$SCOPE_W_DIR" > "$SCOPE_W_DIR/.moe/daemon.json"
  scope_w_head="$(git -C "$SCOPE_W_DIR" rev-parse HEAD)"
  set -m
  PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS=REVIEW \
    "$WRAPPER" \
    --project "$SCOPE_W_DIR" \
    --worker-id worker-scope-w \
    --role worker \
    --team Smoke \
    --no-start-daemon \
    --command "$SLOW_CLI" \
    --no-loop \
    --poll-interval 0 \
    >"$TMP_DIR/scope-w.out" 2>&1 &
  scope_w_pid=$!
  set +m
  # Wait for the pre-flight to persist the baseline (it is written just before
  # the CLI spawns), then interrupt the wrapper mid-CLI.
  scope_w_ready=0
  for _ in $(seq 1 120); do
    if [ -f "$SCOPE_W_DIR/.git/moe/baseline/task-postflight.tsv" ]; then scope_w_ready=1; break; fi
    sleep 0.5
  done
  [ "$scope_w_ready" -eq 1 ] || { kill -9 "$scope_w_pid" 2>/dev/null || true; scope_fail W "baseline never appeared; cannot interrupt mid-CLI" "$TMP_DIR/scope-w.out"; }
  sleep 1
  kill -INT "$scope_w_pid" 2>/dev/null || true
  ( sleep 90; kill -9 "$scope_w_pid" 2>/dev/null ) & scope_w_watchdog=$!
  set +e
  wait "$scope_w_pid"
  scope_w_code=$?
  set -e
  kill "$scope_w_watchdog" 2>/dev/null || true
  wait "$scope_w_watchdog" 2>/dev/null || true
  [ "$scope_w_code" -eq 0 ] || scope_fail W "interrupted wrapper exited with $scope_w_code (expected the trap's exit 0)" "$TMP_DIR/scope-w.out"
  if [ "$(git -C "$SCOPE_W_DIR" rev-parse HEAD)" != "$scope_w_head" ]; then
    scope_fail W "a teardown rescue must never move HEAD" "$TMP_DIR/scope-w.out"
  fi
  scope_w_rescue="$(git -C "$SCOPE_W_DIR" for-each-ref --format='%(refname)' 'refs/moe/rescue/task-postflight/' | head -n1)"
  [ -n "$scope_w_rescue" ] || scope_fail W "expected a rescue ref from the teardown" "$TMP_DIR/scope-w.out"
  if ! git -C "$SCOPE_W_DIR" log -1 --pretty=%s "$scope_w_rescue" | grep -Fq '[reason=teardown]'; then
    scope_fail W "expected [reason=teardown] on the rescue subject" "$TMP_DIR/scope-w.out"
  fi
  if ! git -C "$SCOPE_W_DIR" show --pretty=format: --name-only "$scope_w_rescue" | grep -q '^owned-a\.txt$'; then
    scope_fail W "the teardown rescue must carry the owned path" "$TMP_DIR/scope-w.out"
  fi
  if ! grep -q 'worker-scope-w' "$SCOPE_W_DIR/.moe/deregister.log" 2>/dev/null; then
    cat "$SCOPE_W_DIR/.moe/deregister.log" >&2 || true
    scope_fail W "deregister_worker must still be posted after the rescue" "$TMP_DIR/scope-w.out"
  fi
  if [ ! -f "$SCOPE_W_DIR/.git/moe/baseline/task-postflight.tsv" ]; then
    scope_fail W "the baseline must be KEPT (the next pre-flight lands it on the branch)" "$TMP_DIR/scope-w.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario W] ok"

  # Scenario X -- settings.commitHooks=true routes COMPLETIONS through
  # porcelain `git commit -- <specs>` so hooks run; a rejecting pre-commit hook
  # falls back to a rescue ref [reason=commit-failed], HEAD unchanged.
  echo "[scenario X] commitHooks=true + rejecting hook -> rescue [reason=commit-failed]"
  SCOPE_X_DIR="$TMP_DIR/scope-x"
  make_scope_project "$SCOPE_X_DIR" '["owned-a.txt"]' REVIEW '[]' '{"commitHooks":true}'
  mkdir -p "$SCOPE_X_DIR/.git/hooks"
  printf '#!/bin/sh\nexit 1\n' > "$SCOPE_X_DIR/.git/hooks/pre-commit"
  chmod +x "$SCOPE_X_DIR/.git/hooks/pre-commit"
  echo owned-a > "$SCOPE_X_DIR/owned-a.txt"
  scope_x_head="$(git -C "$SCOPE_X_DIR" rev-parse HEAD)"
  set +e
  run_scope_wrapper "$SCOPE_X_DIR" "$TMP_DIR/scope-x.out"
  scope_x_code=$?
  set -e
  [ "$scope_x_code" -eq 0 ] || scope_fail X "wrapper exited with $scope_x_code" "$TMP_DIR/scope-x.out"
  if [ "$(git -C "$SCOPE_X_DIR" rev-parse HEAD)" != "$scope_x_head" ]; then
    scope_fail X "a hook-rejected completion must not move HEAD" "$TMP_DIR/scope-x.out"
  fi
  scope_x_rescue="$(git -C "$SCOPE_X_DIR" for-each-ref --format='%(refname)' 'refs/moe/rescue/task-postflight/' | head -n1)"
  [ -n "$scope_x_rescue" ] || scope_fail X "expected a rescue ref after the hook rejection" "$TMP_DIR/scope-x.out"
  if ! git -C "$SCOPE_X_DIR" log -1 --pretty=%s "$scope_x_rescue" | grep -Fq '[reason=commit-failed]'; then
    git -C "$SCOPE_X_DIR" log -1 --pretty=%s "$scope_x_rescue" >&2 || true
    scope_fail X "expected [reason=commit-failed] on the rescue subject" "$TMP_DIR/scope-x.out"
  fi
  if ! grep -Fq 'MOE_COMMIT_FAILED' "$TMP_DIR/scope-x.out"; then
    scope_fail X "expected MOE_COMMIT_FAILED in the log" "$TMP_DIR/scope-x.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario X] ok"

  # Scenario Y -- the grok CLI (xAI Grok Build). A fake CLI literally named
  # `grok` (detection keys on the command basename) records its argv and
  # copies the --prompt-file it was handed. Pre-flight must write
  # .grok/config.toml ([mcp_servers.moe] + the LITERAL ${MOE_WORKER_ID:-} env,
  # [mcp_servers.serena] iff Serena resolves, NO top-level keys) and re-write it
  # byte-identically; the headless launch carries --prompt-file/--yolo/--cwd
  # with the per-iteration prompt in the file and never the wrapper's claude
  # model fallback; a non-zero CLI exit propagates into the session-ended line;
  # the config never rides into the landing commit (DENY tier); and the role
  # polarity puts an architect on the interactive TUI unless --grok-exec.
  echo "[scenario Y] grok CLI: config writer, headless argv, exit propagation, DENY tier, polarity"
  GROK_CLI="$TMP_DIR/grok"
  GROK_ARGS_FILE="$TMP_DIR/grok-args.txt"
  GROK_PROMPT_COPY="$TMP_DIR/grok-prompt-copy.md"
  cat > "$GROK_CLI" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$GROK_ARGS_FILE"
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--prompt-file" ]; then cp "\$a" "$GROK_PROMPT_COPY" 2>/dev/null || true; fi
  prev="\$a"
done
exit "\${FAKE_GROK_EXIT:-0}"
EOF
  chmod +x "$GROK_CLI"
  FAKE_SERENA="$TMP_DIR/fake-serena"
  SCOPE_Y_DIR="$TMP_DIR/scope-y"
  make_scope_project "$SCOPE_Y_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_Y_DIR/owned-a.txt"
  SCOPE_Y_CFG="$SCOPE_Y_DIR/.grok/config.toml"
  rm -f "$GROK_ARGS_FILE" "$GROK_PROMPT_COPY"
  set +e
  MOE_SERENA_PATH="$FAKE_SERENA" FAKE_GROK_EXIT=7 FAKE_TASK_STATUS=REVIEW \
    run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y.out" "$GROK_CLI" worker worker-scope-y --grok-exec
  scope_y_code=$?
  set -e
  [ "$scope_y_code" -eq 0 ] || scope_fail Y "wrapper exited with $scope_y_code" "$TMP_DIR/scope-y.out"
  # -- config writer --
  [ -f "$SCOPE_Y_CFG" ] || scope_fail Y "expected .grok/config.toml to be written at pre-flight" "$TMP_DIR/scope-y.out"
  if ! grep -Fq 'Grok MCP config written to:' "$TMP_DIR/scope-y.out"; then
    scope_fail Y "expected the 'Grok MCP config written to:' banner" "$TMP_DIR/scope-y.out"
  fi
  for needle in '[mcp_servers.moe]' '[mcp_servers.moe.env]' 'startup_timeout_sec = 120' 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"' '[mcp_servers.serena]' '"--context", "agent"'; do
    if ! grep -Fq -- "$needle" "$SCOPE_Y_CFG"; then
      cat "$SCOPE_Y_CFG" >&2 || true
      scope_fail Y "expected [$needle] in .grok/config.toml" "$TMP_DIR/scope-y.out"
    fi
  done
  # Basename, not the full path: under Git Bash the MSYS layer rewrites the
  # /tmp/... argv into a C:/... path before python quotes it into the TOML.
  if ! grep -Fq -- 'fake-serena' "$SCOPE_Y_CFG"; then
    cat "$SCOPE_Y_CFG" >&2 || true
    scope_fail Y "the serena entry must use MOE_SERENA_PATH" "$TMP_DIR/scope-y.out"
  fi
  # No top-level keys: the first non-comment, non-blank line must open a table.
  scope_y_first="$(grep -vE '^[[:space:]]*(#|$)' "$SCOPE_Y_CFG" | head -n1)"
  case "$scope_y_first" in
    "["*) : ;;
    *) cat "$SCOPE_Y_CFG" >&2 || true; scope_fail Y "grok project config must carry NO top-level keys; first line is [$scope_y_first]" "$TMP_DIR/scope-y.out" ;;
  esac
  if grep -Eq '^(model_reasoning_effort|developer_instructions|project_doc_fallback_filenames|model_instructions_file)' "$SCOPE_Y_CFG"; then
    cat "$SCOPE_Y_CFG" >&2 || true
    scope_fail Y "codex-only top-level keys leaked into .grok/config.toml" "$TMP_DIR/scope-y.out"
  fi
  # -- headless argv + prompt file --
  if ! grep -Fq 'Grok mode: headless (--prompt-file --yolo)' "$TMP_DIR/scope-y.out"; then
    scope_fail Y "expected the 'Grok mode: headless (--prompt-file --yolo)' banner" "$TMP_DIR/scope-y.out"
  fi
  [ -f "$GROK_ARGS_FILE" ] || scope_fail Y "the fake grok CLI was never launched" "$TMP_DIR/scope-y.out"
  for flag in '--prompt-file' '--yolo' '--cwd' '--no-auto-update' '--output-format' 'plain'; do
    if ! grep -Fqx -- "$flag" "$GROK_ARGS_FILE"; then
      cat "$GROK_ARGS_FILE" >&2 || true
      scope_fail Y "expected [$flag] in the headless grok argv" "$TMP_DIR/scope-y.out"
    fi
  done
  if grep -Fqx -- '-m' "$GROK_ARGS_FILE" || grep -Fq 'claude-opus-5' "$GROK_ARGS_FILE"; then
    cat "$GROK_ARGS_FILE" >&2 || true
    scope_fail Y "grok must not receive the wrapper's claude model fallback" "$TMP_DIR/scope-y.out"
  fi
  [ -f "$GROK_PROMPT_COPY" ] || scope_fail Y "the --prompt-file path handed to grok did not exist" "$TMP_DIR/scope-y.out"
  for needle in 'Role: worker' '# Session Context (per-iteration)' 'Claimed task id: task-postflight' 'CRITICAL (one-shot session)'; do
    if ! grep -Fq -- "$needle" "$GROK_PROMPT_COPY"; then
      scope_fail Y "expected [$needle] in the grok prompt file" "$TMP_DIR/scope-y.out"
    fi
  done
  if [ -e "$SCOPE_Y_DIR/AGENTS.md" ] || [ -e "$SCOPE_Y_DIR/grok-prompt.md" ]; then
    scope_fail Y "the grok prompt must never be written into the project root" "$TMP_DIR/scope-y.out"
  fi
  # -- exit propagation + landing (DENY tier keeps the config out) --
  if ! grep -Fq 'worker session ended: task=task-postflight (CLI exit=7)' "$SCOPE_Y_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$SCOPE_Y_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    scope_fail Y "a non-zero grok exit must propagate into the session-ended line (CLI exit=7)" "$TMP_DIR/scope-y.out"
  fi
  scope_y_files="$(committed_paths "$SCOPE_Y_DIR")"
  if [ "$scope_y_files" != "owned-a.txt " ]; then
    scope_fail Y "the completion must contain ONLY the owned path; got [$scope_y_files]" "$TMP_DIR/scope-y.out"
  fi
  if git -C "$SCOPE_Y_DIR" cat-file -e HEAD:.grok/config.toml 2>/dev/null; then
    scope_fail Y ".grok/config.toml reached HEAD -- it must be DENY-tier excluded" "$TMP_DIR/scope-y.out"
  fi
  if ! git -C "$SCOPE_Y_DIR" status --porcelain --untracked-files=all | grep -q '^?? \.grok/config\.toml$'; then
    git -C "$SCOPE_Y_DIR" status --porcelain --untracked-files=all >&2 || true
    scope_fail Y ".grok/config.toml must stay untracked after the landing" "$TMP_DIR/scope-y.out"
  fi
  # -- idempotent re-run: byte-identical config --
  cp "$SCOPE_Y_CFG" "$TMP_DIR/scope-y-cfg-1.toml"
  set +e
  MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=REVIEW \
    run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y2.out" "$GROK_CLI" worker worker-scope-y --grok-exec
  scope_y2_code=$?
  set -e
  [ "$scope_y2_code" -eq 0 ] || scope_fail Y "second wrapper run exited with $scope_y2_code" "$TMP_DIR/scope-y2.out"
  if ! cmp -s "$TMP_DIR/scope-y-cfg-1.toml" "$SCOPE_Y_CFG"; then
    diff "$TMP_DIR/scope-y-cfg-1.toml" "$SCOPE_Y_CFG" >&2 || true
    scope_fail Y "a second run must rewrite .grok/config.toml byte-identically" "$TMP_DIR/scope-y2.out"
  fi
  if [ "$(grep -c '^\[mcp_servers\.moe\]' "$SCOPE_Y_CFG")" -ne 1 ] || [ "$(grep -c '^\[mcp_servers\.serena\]' "$SCOPE_Y_CFG")" -ne 1 ]; then
    cat "$SCOPE_Y_CFG" >&2 || true
    scope_fail Y "the merge must not duplicate the moe/serena tables" "$TMP_DIR/scope-y2.out"
  fi
  # -- serena iff resolvable: without MOE_SERENA_PATH the wrapper falls back to
  # ~/.local/bin/serena then PATH (HOME is the harness home); mirror that.
  if [ -x "$HOME_DIR/.local/bin/serena" ] || command -v serena >/dev/null 2>&1; then
    scope_y_expect_serena=1
  else
    scope_y_expect_serena=0
  fi
  set +e
  FAKE_TASK_STATUS=REVIEW \
    run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y3.out" "$GROK_CLI" worker worker-scope-y --grok-exec
  scope_y3_code=$?
  set -e
  [ "$scope_y3_code" -eq 0 ] || scope_fail Y "third wrapper run exited with $scope_y3_code" "$TMP_DIR/scope-y3.out"
  if [ "$scope_y_expect_serena" -eq 1 ]; then
    if ! grep -Fq '[mcp_servers.serena]' "$SCOPE_Y_CFG" || grep -Fq -- 'fake-serena' "$SCOPE_Y_CFG"; then
      cat "$SCOPE_Y_CFG" >&2 || true
      scope_fail Y "with Serena resolvable the serena table must be refreshed from the resolved binary" "$TMP_DIR/scope-y3.out"
    fi
  else
    if grep -Fq '[mcp_servers.serena' "$SCOPE_Y_CFG"; then
      cat "$SCOPE_Y_CFG" >&2 || true
      scope_fail Y "without Serena the stale serena table must be stripped" "$TMP_DIR/scope-y3.out"
    fi
  fi
  if ! grep -Fq '[mcp_servers.moe]' "$SCOPE_Y_CFG"; then
    scope_fail Y "the moe table must survive the serena-less rewrite" "$TMP_DIR/scope-y3.out"
  fi
  # -- polarity: an architect goes interactive (positional pointer prompt, no
  # --prompt-file), and --grok-exec forces it headless.
  rm -f "$GROK_ARGS_FILE"
  set +e
  FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y4.out" "$GROK_CLI" architect architect-scope-y
  scope_y4_code=$?
  set -e
  [ "$scope_y4_code" -eq 0 ] || scope_fail Y "architect wrapper run exited with $scope_y4_code" "$TMP_DIR/scope-y4.out"
  if ! grep -Fq 'Grok mode: interactive' "$TMP_DIR/scope-y4.out"; then
    scope_fail Y "an architect must default to the interactive grok TUI" "$TMP_DIR/scope-y4.out"
  fi
  if grep -Fqx -- '--prompt-file' "$GROK_ARGS_FILE" || grep -Fqx -- '--yolo' "$GROK_ARGS_FILE"; then
    cat "$GROK_ARGS_FILE" >&2 || true
    scope_fail Y "the interactive TUI must not receive --prompt-file/--yolo" "$TMP_DIR/scope-y4.out"
  fi
  if ! grep -Fqx -- '--cwd' "$GROK_ARGS_FILE" || ! grep -Fq 'Session context (routed mentions, pre-flight data) is in' "$GROK_ARGS_FILE"; then
    cat "$GROK_ARGS_FILE" >&2 || true
    scope_fail Y "the interactive TUI must get --cwd plus a positional pointer prompt" "$TMP_DIR/scope-y4.out"
  fi
  rm -f "$GROK_ARGS_FILE"
  set +e
  FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y5.out" "$GROK_CLI" architect architect-scope-y --grok-exec
  scope_y5_code=$?
  set -e
  [ "$scope_y5_code" -eq 0 ] || scope_fail Y "architect --grok-exec run exited with $scope_y5_code" "$TMP_DIR/scope-y5.out"
  if ! grep -Fq 'Grok mode: headless (--prompt-file --yolo)' "$TMP_DIR/scope-y5.out" || ! grep -Fqx -- '--prompt-file' "$GROK_ARGS_FILE"; then
    cat "$GROK_ARGS_FILE" >&2 || true
    scope_fail Y "--grok-exec must force an architect headless" "$TMP_DIR/scope-y5.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario Y] ok"

  # A harness that silently generated zero scenarios exits 0 and reads as green.
  # (Scenarios Q and V run inside the quality-gate cases above and are guarded
  # by those cases' own fail-fast assertions, not this counter.)
  echo "commit-scope scenarios run: $SCOPE_SCENARIOS_RUN"
  if [ "$SCOPE_SCENARIOS_RUN" -ne 23 ]; then
    echo "Expected 23 commit-scope scenarios (A-P, R-U, W-Y); ran $SCOPE_SCENARIOS_RUN" >&2
    exit 1
  fi
else
  echo "SKIP commit-scope scenarios: git not available"
fi

echo "PASS postflight.sh"
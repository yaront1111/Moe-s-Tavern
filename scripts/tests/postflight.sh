#!/usr/bin/env bash
set -euo pipefail
# Per-wrapper-run timeout (seconds). 60s is enough on a warm developer box; the
# ps1 twin reads the same MOE_POSTFLIGHT_TIMEOUT_SEC so a slow-spawn machine (or a
# box also running the other harness) can widen both without editing either file.
POSTFLIGHT_TIMEOUT_SEC=60
case "${MOE_POSTFLIGHT_TIMEOUT_SEC:-}" in ''|*[!0-9]*) : ;; *) POSTFLIGHT_TIMEOUT_SEC="$MOE_POSTFLIGHT_TIMEOUT_SEC" ;; esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/moe-agent.sh"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t moe-postflight)"
# Background children a scenario spawns as a GENUINE probe target (scenario M2
# needs a real live process id, not a fabricated one). Killed on EXIT so a
# failing case cannot leak a ten-minute sleep onto the box.
LIVE_PIDS=""
cleanup() {
  for _p in $LIVE_PIDS; do kill "$_p" 2>/dev/null || true; done
  rm -rf "$TMP_DIR"
}
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

// Candidate/check/finalize recorder: reject invalid payloads instead of green
// mocks accepting arbitrary calls. This fixture never calls the live daemon.
const assert = require('node:assert/strict');
const rpcLog = path.join(moe, 'evidence-rpcs.jsonl');
const appendRpc = () => fs.appendFileSync(rpcLog, JSON.stringify({tool,args}) + '\n');
function readRows(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function attemptFixture() {
  const id = 'attempt-postflight', generation = 7;
  const taskId = process.env.FAKE_CLAIM_MODE === 'resume' ? 'task-resume' : 'task-postflight';
  ensureDir(path.join(moe, 'attempts'));
  const file = path.join(moe, 'attempts', id + '.json');
  // openAttempt records the runner's pair exactly as the claim sent it.
  // FAKE_ATTEMPT_PHASE=reconciling: a daemon restart parked the attempt before
  // the wrapper pinned it (the window a resume after a restart lands in).
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({
    id, generation, taskId, workerId: args.workerId, runnerId: args.workerId,
    phase: process.env.FAKE_ATTEMPT_PHASE || 'running', workspace: project, startedAt: new Date().toISOString(), lastPhaseAt: new Date().toISOString(),
    ...(args.processStartedAt === undefined ? {} : {processStartedAt: args.processStartedAt, host: args.host})
  }));
  if (process.env.FROZEN_MODE === 'claim-missing' || process.env.FAKE_CLAIM_TOKENS === 'missing') return {};
  return {attemptId: id, generation: process.env.FROZEN_MODE === 'claim-malformed' ? '7' : generation};
}
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
function candidateReply() {
  let payload;
  const a = JSON.parse(fs.readFileSync(path.join(moe,'attempts',args.attemptId+'.json'),'utf8'));
  assert.equal(args.taskId,a.taskId); assert.equal(args.workerId,a.workerId);
  assert.equal(args.generation,a.generation); assert.notEqual(a.phase,'closed');
  assert.ok(safeId(args.id)); assert.ok(sha(args.treeSha)); assert.ok(sha(args.baseRevision));
  assert.match(args.deliveryTarget,/^refs\/heads\/.+/);
  const {generation,workerId,...candidate} = args;
  payload = {success:true,candidate:{...candidate,createdAt:new Date().toISOString()},duplicate:false};
  ensureDir(path.join(moe,'candidates'));
  const file = path.join(moe,'candidates',args.id+'.json');
  if (fs.existsSync(file)) {
    payload.candidate = JSON.parse(fs.readFileSync(file,'utf8')); payload.duplicate = true;
    for (const key of Object.keys(candidate)) assert.deepEqual(payload.candidate[key],candidate[key]);
  } else fs.writeFileSync(file,JSON.stringify(payload.candidate));
  return payload;
}
function checkReply() {
  let payload;
  const c = JSON.parse(fs.readFileSync(path.join(moe,'candidates',args.candidateId+'.json'),'utf8'));
  assert.equal(args.treeSha,c.treeSha); assert.ok(safeId(args.id)); assert.ok(safeId(args.runnerId));
  const tip = require('node:child_process').spawnSync('git',['-C',project,'rev-parse','--verify',c.deliveryTarget],{encoding:'utf8'});
  if(tip.status===0) assert.equal(tip.stdout.trim(),c.baseRevision,'CheckRun must persist before CAS');

  assert.equal(args.source,'runner-observed'); assert.ok(Number.isSafeInteger(args.exitCode));
  assert.ok(typeof args.command === 'string' && args.command.trim() && args.command.length <= 500);
  assert.ok(typeof args.outputTail === 'string' && Buffer.byteLength(args.outputTail,'utf8') <= 16384);
  assert.ok(!args.outputTail.includes('\ufffd'));
  const {workerId,...checkRun} = args;
  payload = {success:true,checkRun:{...checkRun,createdAt:new Date().toISOString()},duplicate:false};
  ensureDir(path.join(moe,'checks'));
  fs.writeFileSync(path.join(moe,'checks',args.id+'.json'),JSON.stringify(payload.checkRun));
  return payload;
}
function finalizeReply() {
  let payload;
  const mode = process.env.FAKE_EVIDENCE_MODE || '';
  const file = path.join(moe,'attempts',args.attemptId+'.json');
  const a = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(args.taskId,a.taskId); assert.equal(args.workerId,a.workerId);
  assert.equal(args.generation,a.generation); assert.ok(safeId(args.runnerId));
  assert.ok(['finalizing','closed'].includes(a.phase));
  assert.ok(['landed','nothing-to-commit','rescued','failed'].includes(args.outcome));
  if (args.outcome === 'landed') {
    assert.ok(sha(args.landedRevision));
    const rows = readRows(rpcLog);
    assert.ok(rows.some(r => r.tool === 'record_commit' && r.args.outcome === 'committed'
      && r.args.kind === 'completion' && r.args.sha === args.landedRevision));
  } else assert.equal(args.landedRevision,undefined);
  a.phase = 'closed'; fs.writeFileSync(file,JSON.stringify(a));
  payload = {success:true,taskId:a.taskId,attemptId:a.id,generation:a.generation,phase:'closed',
    outcome:args.outcome,landedRevision:args.landedRevision || null};
  if (mode === 'finalize-loss' || (mode === 'finalize-loss-once'
    && readRows(rpcLog).filter(r=>r.tool === tool).length === 1)) return null;
  return payload;
}
// receiptStore.ts in miniature: one receipt per candidate, an identical replay
// writes nothing (duplicate), a differing one is DELIVERY_RECEIPT_CONFLICT.
function receiptReply() {
  assert.ok(safeId(args.candidateId));
  assert.ok(typeof args.target === 'string' && args.target && args.target === args.target.trim() && args.target.length <= 255
    && [...args.target].every(ch => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127));
  for (const key of ['targetBefore','targetAfter','landedRevision']) assert.ok(sha(args[key]), key);
  const receipt = {candidateId:args.candidateId,target:args.target,targetBefore:args.targetBefore,
    targetAfter:args.targetAfter,landedRevision:args.landedRevision,pushResult:args.pushResult ?? null};
  if (receipt.pushResult !== null) assert.ok(typeof receipt.pushResult === 'string' && receipt.pushResult.trim() && receipt.pushResult.length <= 2000);
  const file = path.join(moe,'receipts',args.candidateId+'.json');
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file,'utf8'));
    const differing = Object.keys(receipt).filter(key => stored[key] !== receipt[key]);
    if (differing.length) throw Object.assign(new Error('receipt differs in '+differing.join(', ')),{codeName:'DELIVERY_RECEIPT_CONFLICT'});
    return {success:true,receipt:stored,duplicate:true};
  }
  assert.ok(fs.existsSync(path.join(moe,'candidates',args.candidateId+'.json')),'CANDIDATE_NOT_FOUND');
  ensureDir(path.join(moe,'receipts'));
  fs.writeFileSync(file,JSON.stringify({id:'receipt-'+args.candidateId,...receipt}));
  return {success:true,receipt:{id:'receipt-'+args.candidateId,...receipt},duplicate:false};
}
// reattachAttempt.ts in miniature: the attempt id, generation, recorded process
// start time and host must all match exactly (nothing recorded never matches),
// and only a reconciling or already-running attempt returns to running.
// FAKE_REATTACH_REFUSE=1 refuses even a matching identity, as a stranger's.
function reattachReply() {
  for (const key of ['taskId','workerId','runnerId','attemptId','processStartedAt','host'])
    assert.ok(typeof args[key] === 'string' && args[key].trim(), key);
  assert.ok(Number.isSafeInteger(args.generation) && args.generation > 0, 'generation');
  const file = path.join(moe,'attempts',args.attemptId+'.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('Attempt not found: '+args.attemptId),{codeName:'ATTEMPT_NOT_FOUND'});
  const a = JSON.parse(fs.readFileSync(file,'utf8'));
  if (a.taskId !== args.taskId) throw Object.assign(new Error('Attempt '+a.id+' belongs to '+a.taskId),{codeName:'ATTEMPT_ID_TASK_MISMATCH'});
  const field = process.env.FAKE_REATTACH_REFUSE === '1' ? 'processStartedAt'
    : ['generation','processStartedAt','host'].find(key => a[key] === undefined || a[key] !== args[key]);
  if (field) throw Object.assign(new Error('Attempt '+a.id+' does not match the presented identity ('+field+' differs)'),{codeName:'ATTEMPT_IDENTITY_MISMATCH'});
  if (!['reconciling','running'].includes(a.phase)) throw Object.assign(new Error('Attempt '+a.id+' is in phase '+a.phase),{codeName:'ATTEMPT_NOT_REATTACHABLE'});
  a.phase = 'running'; fs.writeFileSync(file,JSON.stringify(a));
  return {success:true,attemptId:a.id,taskId:a.taskId,generation:a.generation,phase:'running'};
}
// Teardown arms hold ONE call until the supervisor has interrupted the wrapper:
// the post-flight landing's get_commit_scope (teardown-scope: no outcome yet), or
// the completion's ledger row once it reached one (teardown-landed: a branch CAS,
// teardown-nothing: nothing to commit). A proxy the interrupt kills never got its
// call through, so a held call is logged only once its hold is over.
function holdForInterrupt() {
  const mode = process.env.FAKE_EVIDENCE_MODE, ready = path.join(moe, 'gate-ready');
  const scope = mode === 'teardown-scope' && tool === 'get_commit_scope' && args.phase === 'postflight';
  const ledger = tool === 'record_commit' && args.kind === 'completion'
    && args.outcome === {'teardown-landed': 'committed', 'teardown-nothing': 'nothing'}[mode];
  if (!(scope || ledger) || fs.existsSync(ready)) return;
  fs.writeFileSync(ready, 'ready');
  for (let i = 0; i < 1200 && !fs.existsSync(ready + '.sent'); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
// receipt-ledger-replay: the FIRST committed completion row is never recorded;
// the supervisor hard-kills the wrapper tree while its landing waits on it (a
// crash between update-ref and record_commit), so no log shows the call.
function holdLedgerForCrash() {
  const held = path.join(moe, 'ledger-held');
  if (process.env.FAKE_EVIDENCE_MODE !== 'receipt-ledger-replay' || tool !== 'record_commit' || args.outcome !== 'committed'
    || args.kind !== 'completion' || fs.existsSync(held)) return;
  fs.writeFileSync(held, 'held');
  for (let i = 0; i < 1200; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.exit(1);
}
function evidenceRpc() {
  appendRpc();
  if (['record_commit','deregister_worker','add_comment'].includes(tool)) return false;
  const refusal = (message, codeName) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,
    error:{code:-32002,message,data:{codeName:codeName || 'FIXTURE_REFUSED'}}}) + '\n');
  const mode = process.env.FAKE_EVIDENCE_MODE || '';
  if (mode === tool + '-refuse') { refusal('fixture persistence refused'); return true; }
  if (mode === tool + '-null') { ok(null); return true; }
  if (mode === tool + '-malformed') { ok({success:true}); return true; }
  if (tool === 'record_delivery_receipt' && mode === 'receipt-refused') { refusal('fixture receipt refused'); return true; }
  if (tool === 'record_delivery_receipt' && mode === 'receipt-conflict') { refusal('fixture receipt conflict', 'DELIVERY_RECEIPT_CONFLICT'); return true; }
  // receipt-replay, receipt-rebase-replay, receipt-foreign-replay: the FIRST
  // receipt is never answered; the supervisor hard-kills the wrapper tree while
  // it waits (acceptance case 6's crash).
  const held = path.join(moe, 'receipt-held');
  if (['receipt-replay','receipt-rebase-replay','receipt-foreign-replay'].includes(mode) && tool === 'record_delivery_receipt' && !fs.existsSync(held)) {
    fs.writeFileSync(held, 'held');
    for (let i = 0; i < 1200; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    process.exit(1);
  }
  try {
    const payload = tool === 'record_candidate' ? candidateReply() : tool === 'record_check_run' ? checkReply()
      : tool === 'record_delivery_receipt' ? receiptReply() : tool === 'reattach_attempt' ? reattachReply() : finalizeReply();
    if (payload !== null) ok(payload);
  } catch(e) { refusal(e.message, e.codeName); }
  return true;
}
holdForInterrupt();
holdLedgerForCrash();
if (['record_candidate','record_check_run','record_delivery_receipt','finalize_attempt','record_commit','deregister_worker','add_comment','reattach_attempt'].includes(tool)) {
  if (evidenceRpc()) process.exit(0);
}
// claimNextTask.ts readProcessIdentity in miniature: the runner's pair is
// both-or-neither, non-blank, bounded (200 / 255) and free of control
// characters, and a refused claim assigns nobody. Every claim is logged with
// the pair it sent.
if (tool === 'claim_next_task') {
  appendRpc();
  const bad = [['processStartedAt', 200], ['host', 255]].find(([key, max]) => args[key] !== undefined && !(typeof args[key] === 'string'
    && args[key].trim() && args[key].length <= max && [...args[key]].every(ch => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)));
  if (bad || (args.processStartedAt === undefined) !== (args.host === undefined)) {
    console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'Invalid '+(bad ? bad[0] : 'runner identity: send processStartedAt and host together'),
      data:{tool:'moe.claim_next_task',codeName:'INVALID_INPUT'}}}));
    process.exit(0);
  }
}
// FAKE_HEARTBEAT_REATTACH mirrors heartbeat.ts's reattach-required answer: `1`
// reads the caller's attempt (attempt-reconciling while a restart has it parked,
// a plain ack otherwise); `other` alternates the two reasons that name no
// attempt. .moe/heartbeat-count counts the pings.
if (tool === 'heartbeat' && process.env.FAKE_HEARTBEAT_REATTACH) {
  const counter = path.join(moe, 'heartbeat-count');
  const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
  fs.writeFileSync(counter, String(n));
  const reattach = (reason, a) => ({ok:false,reattachRequired:true,reason,reattachWith:'moe.reattach_attempt',...(a ? {attemptId:a.id,phase:a.phase} : {})});
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(moe,'attempts','attempt-postflight.json'),'utf8')); } catch {}
  if (process.env.FAKE_HEARTBEAT_REATTACH === 'other') ok(reattach(n % 2 ? 'no-worker-record' : 'no-open-attempt'));
  else ok(a && a.workerId === args.workerId && a.phase === 'reconciling' ? reattach('attempt-reconciling', a) : {ok:true});
  process.exit(0);
}
// FAKE_CLAIM_MODE=finalizing: claimNextTask.ts refuses a seat whose own attempt
// is still finalizing (ATTEMPT_FINALIZING); with none, nothing is claimable.
if (tool === 'claim_next_task' && process.env.FAKE_CLAIM_MODE === 'finalizing') {
  const dir = path.join(moe, 'attempts');
  const open = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return {}; } })
    .find(a => a.workerId === args.workerId && a.phase === 'finalizing');
  if (open) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32002,message:'Attempt '+open.id+' is still finalizing',
    data:{tool:'moe.claim_next_task',codeName:'ATTEMPT_FINALIZING'}}}) + '\n');
  else ok({ hasNext: false });
  process.exit(0);
}
// FAKE_CLAIM_ONCE=1: only the first claim hands out the task. Every later claim
// answers idle and leaves .moe/second-claim, the proof that a --loop wrapper
// went on claiming after its post-flight instead of stopping.
// FAKE_CLAIM_LIMIT=N: the same, but the first N claims hand out the task.
let claimOnceIdle = false;
const claimLimit = process.env.FAKE_CLAIM_ONCE === '1' ? 1 : Number(process.env.FAKE_CLAIM_LIMIT || 0);
if (tool === 'claim_next_task' && claimLimit > 0) {
  const claimCount = path.join(moe, 'claim-count');
  const claimN = Number(fs.existsSync(claimCount) ? fs.readFileSync(claimCount, 'utf8') : 0) + 1;
  fs.writeFileSync(claimCount, String(claimN));
  if (claimN > claimLimit) { claimOnceIdle = true; fs.writeFileSync(path.join(moe, 'second-claim'), String(claimN)); }
}
if (tool === 'claim_next_task' && !claimOnceIdle && !['idle','blocked'].includes(process.env.FAKE_CLAIM_MODE)) attemptFixture();
if (tool === 'get_context' && args.taskId) {
  const countFile = path.join(moe,'context-count');
  const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile,'utf8') : 0) + 1;
  fs.writeFileSync(countFile,String(count));
  const file = path.join(moe,'attempts','attempt-postflight.json');
  if (count > 1 && ['REVIEW','DONE','ARCHIVED'].includes(process.env.FAKE_TASK_STATUS) && fs.existsSync(file)) {
    const a = JSON.parse(fs.readFileSync(file,'utf8'));
    if (a.phase === 'running') { a.phase = 'finalizing'; fs.writeFileSync(file,JSON.stringify(a)); }
  }
}

switch (tool) {
  case 'create_team': ok({ team: { id: 'team-smoke', name: args.name || 'Smoke' } }); break;
  case 'join_team': ok({ success: true }); break;
  case 'chat_channels': ok({ channels: [{ id: 'chan-general', name: 'general', type: 'general' }] }); break;
  case 'chat_join': ok({ success: true }); break;
  case 'chat_read': {
    // FAKE_MENTION=1 models one unread message tagging the caller. The record
    // is also appended to the store the wrapper re-reads bodies from, so the
    // mention passes provenance instead of degrading to a delivery marker.
    if (process.env.FAKE_MENTION === '1' && args.channel === 'chan-general') {
      const msg = { id: 'msg-fake-1', channel: 'chan-general', sender: 'human', content: 'ping', mentions: [args.workerId || 'all'], timestamp: new Date().toISOString() };
      const dir = path.join(moe, 'messages');
      ensureDir(dir);
      fs.appendFileSync(path.join(dir, 'chan-general.jsonl'), JSON.stringify(msg) + '\n');
      ok({ messages: [msg], cursor: null, truncated: 0 });
      break;
    }
    ok({ messages: [], cursor: null, truncated: 0 });
    break;
  }
  case 'get_pending_questions': ok({ count: 0, tasks: [] }); break;
  case 'claim_next_task': {
    if (claimOnceIdle) { ok({ hasNext: false }); break; }
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
    } else if (process.env.FAKE_CLAIM_MODE === 'idle') {
      // Nothing claimable and nothing held: the board state that used to make
      // the wrapper launch a CLI and tell it to claim itself.
      ok({ hasNext: false });
    } else {
      ok({ ...attemptFixture(), hasNext: true, task: { id: 'task-postflight', title: 'Postflight smoke', status: 'WORKING', chatChannel: 'chan-task' } });
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
    if (!args.taskId) {
      const adopted = process.env.FAKE_ADOPTED_TASK_ID;
      ok(adopted ? { task: { id: adopted, status: 'WORKING' }, project: {}, epic: {} } : { project: {}, epic: {} });
      break;
    }
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

FROZEN_SUITE="$TMP_DIR/frozen-candidate.cjs"
cat > "$FROZEN_SUITE" <<'FROZENJS'

const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const [platform,wrapper,proxy,parent,engine]=process.argv.slice(2),win=platform==='ps1';
const root=fs.mkdtempSync(path.join(parent,'frozen gate é '));
// The loop supervisor hard-kills its wrapper, so that wrapper's own exit cleanup
// never runs: point its temp files (sh SECURE_TEMP_DIR, ps1 MCP config and system
// prompt) at a dir this suite owns and deletes, never the shared %TEMP%.
const wrapperTmp=fs.mkdtempSync(path.join(os.tmpdir(),'moe-frozen-wrapper-'));
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const rows=f=>fs.existsSync(f)?read(f).trim().split('\n').filter(Boolean).map(JSON.parse):[];
function git(d,...a){const r=cp.spawnSync('git',['-C',d,...a],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const modes=['dirty-helper','pass','race-fail','race-pass','shared-mutation','tracked-mutation','exit-tail',
'record_candidate-refuse','record_candidate-null','record_candidate-malformed',
'record_check_run-refuse','record_check_run-null','record_check_run-malformed',
'finalize-loss-once','finalize-loss','no-change','disabled','deferred','gate-blank','gate-padded','manual','no-git','sha256-repo','missing-attempt','stale-attempt','workspace-failure','claim-missing','claim-malformed','closed-attempt',
'loop-land-twice',
'nogate-qa-claimed','gate-qa-claimed','checkpoint-reconciling','checkpoint-unpinned','manual-reconciling','manual-unpinned',
'freed-closed','freed-generation-bump','freed-corrupt-sibling','finalizing-acked-continues','unborn','cleanup-retry','hidden-mutation',
'receipt-replay','receipt-cached-check','receipt-same-tree-race','receipt-push','receipt-push-failed','receipt-refused','receipt-conflict',
'receipt-ledger-replay','receipt-rebase-replay','receipt-foreign-replay',
'identity-claim','reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','reattach-none',
...(win?['integrity-batch']:[]),'interrupt-int',...(win?[]:['interrupt-term']),
'teardown-finalizing','teardown-manual','teardown-no-git','teardown-sha256','teardown-no-baseline','teardown-recovered','teardown-scope','teardown-landed','teardown-nothing','teardown-running'];
// Loop modes run --loop: the fake daemon answers the second claim idle, and the
// supervisor stops the wrapper as soon as that claim is seen. freed-* is a
// seat-freeing report_blocked (the task exits BLOCKED): whatever became of the
// pinned attempt -- closed in place by the hand-back, rewritten to a generation
// the seat never pinned, or left running beside a corrupt sibling record --
// nothing is acknowledged and the seat keeps claiming. finalizing-acked-continues
// is the control: one acknowledged finalizing attempt does not stop the loop.
// identity-claim and reattach-refused finalize too: their second claim proves
// the runner identity is one pair per wrapper and a refused reattach stops nothing.
// gate-blank lands under a whitespace-only qualityGate, which is no gate at all,
// so its loop goes on as after any ungated landing.
const loopModes=['nogate-qa-claimed','gate-qa-claimed','checkpoint-reconciling','checkpoint-unpinned','manual-reconciling','manual-unpinned',
  'freed-closed','freed-generation-bump','freed-corrupt-sibling','finalizing-acked-continues','identity-claim','reattach-refused','gate-blank'];
const identityModes=['missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt','gate-qa-claimed'];
// Teardown modes interrupt the wrapper once complete_task has left the attempt
// finalizing: mid-CLI, in the post-flight landing before it reached any outcome
// (teardown-scope), or once it reached one (a branch CAS, or nothing to commit)
// but before its ledger row got out. That exit must acknowledge the attempt
// exactly once, before deregister_worker, with what it actually did to the bytes.
// teardown-running is the control: its attempt is still `running` (no
// complete_task), so the very same exit path must acknowledge NOTHING.
const teardownOutcome={'teardown-finalizing':'rescued','teardown-manual':'nothing-to-commit','teardown-no-git':'nothing-to-commit','teardown-sha256':'nothing-to-commit',
  'teardown-no-baseline':'failed','teardown-recovered':'rescued','teardown-scope':'rescued','teardown-landed':'landed',
  'teardown-nothing':'nothing-to-commit','teardown-running':''};
const teardownRescued=['teardown-finalizing','teardown-recovered','teardown-scope','teardown-running'];
const noFinal=['missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt',
  ...loopModes.filter(m=>!['finalizing-acked-continues','identity-claim','reattach-refused','gate-blank'].includes(m))];
const EMPTY_TREE='4b825dc642cb6eb9a060e54bf8d69288fbee4904',ZERO_OID='0'.repeat(40);
// Hard-kills its wrapper's whole tree (no trap, no graceful exit) once MARKER
// exists, or after LIMIT ms: the loop modes' stop and receipt-replay's crash.
const KILL_ON_MARKER=`
const cp=require('child_process'),fs=require('fs');
const [marker,limit,engine,...args]=process.argv.slice(2);
const child=cp.spawn(engine,args,{stdio:'inherit',detached:process.platform!=='win32',windowsHide:true});
let stopped=false;
const stop=()=>{if(stopped)return;stopped=true;
  if(process.platform==='win32')cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch(e){}}};
const poll=setInterval(()=>{if(fs.existsSync(marker))stop();},100);
const deadline=setTimeout(stop,Number(limit));
child.on('exit',(code,signal)=>{clearInterval(poll);clearTimeout(deadline);
  console.log('[supervisor] marker='+fs.existsSync(marker)+' exit='+code+' signal='+signal);process.exit(0);});
`;
// An interrupted wrapper still has to stop the gate, park a rescue ref,
// acknowledge the attempt and deregister -- several node spawns on a loaded
// box -- so the Windows cancellation bound tracks MOE_POSTFLIGHT_TIMEOUT_SEC
// rather than a fixed 30 s. The outer spawnSync timeout is still the real cap.
const CANCEL_MS=Math.max(30000,(Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-30)*1000);
let count=0;
try {
if(!win){const source=read(wrapper),stop=source.slice(source.indexOf('stop_gate_child() {'),source.indexOf('cleanup_gate_workspace() {'));
  assert.ok(stop.indexOf('kill -KILL')>=0&&stop.indexOf('kill -KILL')<stop.indexOf('if wait "$GATE_PID"'),'explicit shutdown cannot wait forever on TERM-ignoring children');}
for(const mode of modes.filter(m=>!process.env.MOE_FROZEN_TEST_ONLY||process.env.MOE_FROZEN_TEST_ONLY.split(',').includes(m))){
  console.log('[frozen candidate] '+mode);
  if(mode==='integrity-batch'){
    const source=read(wrapper),probe=source.slice(source.indexOf('function Test-MoeGateIntegrity'),source.indexOf('function Stop-MoeGateChild'));
    assert.ok(probe.length>0&&probe.includes('--stdin')&&!/foreach/i.test(probe),'ps1 integrity probe must batch ls-files into one update-index --stdin, not spawn git per tracked file');
    count++;continue;
  }
  const repo=path.join(root,mode),nested=path.join(repo,'nested project é'),owned=path.join(nested,'owned.txt');
  fs.mkdirSync(nested,{recursive:true});
  const gateSource=`
const fs=require('fs'),cp=require('child_process'),path=require('path');
const dir=process.env.FROZEN_FIXTURE,mode=process.env.FROZEN_MODE;
const get=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim();
const persisted=fs.existsSync(path.join(dir,'.moe','candidates'))?
 fs.readdirSync(path.join(dir,'.moe','candidates')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'.moe','candidates',f),'utf8'))):[];
const observation={persisted,pid:process.pid,cwd:process.cwd(),project:process.env.MOE_PROJECT_PATH,tree:get('rev-parse','HEAD^{tree}'),
 helper:fs.existsSync('helper.txt'),peer:fs.existsSync('peer.txt'),denied:fs.existsSync('.codex/dirty.txt'),owned:fs.readFileSync('owned.txt','utf8')};
if(mode.startsWith('interrupt-'))observation.childPid=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).pid;
observation.recordedAt=new Date().toISOString();
fs.appendFileSync(path.join(dir,'.moe','gate-observations.jsonl'),JSON.stringify(observation)+'\\n');
if(mode==='shared-mutation')fs.writeFileSync(path.join(dir,'owned.txt'),'late shared\\n');
fs.writeFileSync('scratch.txt','generated only\\n');
if(mode==='tracked-mutation')fs.writeFileSync('owned.txt','gate changed tracked\\n');
if(mode==='hidden-mutation'){get('update-index','--skip-worktree','owned.txt');get('update-index','--assume-unchanged','gate.cjs');
 fs.writeFileSync('owned.txt','hidden gate change\\n');fs.appendFileSync('gate.cjs','\\n// hidden gate change\\n');}
if(mode==='cleanup-retry')get('worktree','lock','--reason','moe frozen cleanup retry',get('rev-parse','--show-toplevel'));
if(mode==='dirty-helper'&&!fs.existsSync('helper.txt'))process.exit(19);
if(mode==='race-fail'&&fs.existsSync('../break-gate.txt'))process.exit(23);
if(mode.startsWith('interrupt-')){fs.writeFileSync(path.join(dir,'owned.txt'),'late shared\\n');fs.writeFileSync(path.join(dir,'.moe','gate-ready'),'ready');setInterval(()=>{},1000);}
if(mode==='exit-tail'){process.stdout.write('é😀'.repeat(5000)+'TAIL');process.stderr.write('END');process.exit(37);}
`;
  write(path.join(nested,'gate.cjs'),gateSource);write(owned,'base\n');write(path.join(repo,'seed.txt'),'seed\n');
  const settings={qualityGate:'node gate.cjs',qualityGateScope:'everyTask',commitBoardState:false,attribution:{undeclared:'never'}};
  if(mode==='disabled'||mode==='nogate-qa-claimed')settings.qualityGate='';
  if(mode==='deferred')settings.qualityGateScope='epicFinal';
  // Padding is not part of the command: '   ' is no gate, and a padded one runs trimmed.
  if(mode==='gate-blank')settings.qualityGate='   ';
  if(mode==='gate-padded')settings.qualityGate='  node gate.cjs  ';
  if(mode==='manual'||mode.startsWith('manual-')||mode==='teardown-manual')settings.autoCommit=false;
  const ownedPaths=mode==='unborn'?['owned.txt','gate.cjs']:['owned.txt'];
  write(path.join(nested,'.moe','project.json'),JSON.stringify({id:'proj-frozen',name:'Frozen',settings}));
  write(path.join(nested,'.moe','tasks','task-postflight.json'),JSON.stringify({id:'task-postflight',title:'Frozen',
    status:'WORKING',filesModified:ownedPaths,implementationPlan:[{stepId:'s1',status:'COMPLETED',modifiedFiles:ownedPaths}]}));
  const noGit=mode==='no-git'||mode==='teardown-no-git',sha256=mode==='sha256-repo'||mode==='teardown-sha256';
  if(!noGit){
    // A sha256 repository: both wrappers refuse it at their git probe, because
    // Moe's delivery records hold SHA-1 ids only. Creating one needs git 2.29+.
    if(!sha256)git(repo,'init','-q');
    else if(cp.spawnSync('git',['-C',repo,'init','-q','--object-format=sha256']).status!==0){
      console.log('[frozen candidate] '+mode+' skipped: this git cannot create a sha256 repository (git init --object-format=sha256 needs git 2.29+)');continue;}
    git(repo,'config','core.autocrlf','false');git(repo,'config','user.name','Moe Test');git(repo,'config','user.email','moe@test.local');
    if(mode==='unborn')git(repo,'symbolic-ref','HEAD','refs/heads/moe/frozen');
    else{git(repo,'add','--','seed.txt','nested project é/owned.txt','nested project é/gate.cjs');
      git(repo,'commit','-qm','seed');git(repo,'checkout','-qb','moe/frozen');}
    if(mode==='workspace-failure'){
      write(path.join(nested,'.gitattributes'),'gate.cjs filter=fail\n');
      git(repo,'add','--','nested project é/.gitattributes');git(repo,'commit','-qm','filter');
      git(repo,'config','filter.fail.clean','cat');git(repo,'config','filter.fail.smudge','exit 41');git(repo,'config','filter.fail.required','true');
    }
    // A push is attempted only where a remote exists: a reachable bare one, or one
    // whose path does not exist. Every other arm has no remote, so no push.
    if(mode==='receipt-push'){git(root,'init','-q','--bare',mode+'-remote.git');git(repo,'remote','add','origin',path.join(root,mode+'-remote.git'));}
    if(mode==='receipt-push-failed')git(repo,'remote','add','origin',path.join(root,mode+'-missing.git'));
    // A peer's commit is already on the remote branch: the landing's first push is
    // rejected, and its pull --rebase rewrites the landed commit before the re-push.
    if(mode==='receipt-rebase-replay'){const remote=path.join(root,mode+'-remote.git'),peer=path.join(root,mode+'-peer');
      git(root,'init','-q','--bare',mode+'-remote.git');git(repo,'remote','add','origin',remote);git(repo,'push','-q','origin','moe/frozen');
      git(root,'clone','-q','-b','moe/frozen',remote,peer);
      for(const [key,value] of [['user.name','Moe Peer'],['user.email','peer@test.local'],['core.autocrlf','false']])git(peer,'config',key,value);
      write(path.join(peer,'remote-only.txt'),'remote only\n');git(peer,'add','--','remote-only.txt');git(peer,'commit','-qm','peer-remote');
      git(peer,'push','-q','origin','moe/frozen');}
    // The branch CAS fails ONCE with the tip unchanged (git refuses the first
    // prepared update of the target), so the rebuilt tree and base are identical.
    if(mode==='receipt-cached-check'){const hook=path.join(repo,'.git','hooks','reference-transaction');
      write(hook,'#!/bin/sh\n[ "$1" = prepared ] || exit 0\ngrep -q " refs/heads/moe/frozen$" || exit 0\n'+
        'm="$(git rev-parse --git-dir)/moe-cas-refused"\n[ -e "$m" ] && exit 0\n: > "$m"\nexit 1\n');fs.chmodSync(hook,0o755);}
  }
  write(path.join(nested,'helper.txt'),'dirty helper\n');write(path.join(nested,'peer.txt'),'peer bytes\n');
  write(path.join(nested,'.codex','dirty.txt'),'denied bytes\n');
  // A previous session of the task ended without landing: the pre-flight lands
  // this lingering baseline as a recovery checkpoint before the CLI starts.
  const baselineFile=path.join(repo,'.git','moe','baseline','task-postflight.tsv');
  if(mode==='teardown-recovered'){write(owned,'recovered owned\n');
    write(baselineFile,'#moe-baseline v1 task=task-postflight at=2026-01-01T00:00:00Z head='+git(repo,'rev-parse','HEAD')+' landed=0\n');}
  const cliJs=path.join(root,mode+'-cli.cjs');
  write(cliJs,`
const fs=require('fs'),path=require('path'),dir=process.env.MOE_PROJECT_PATH,mode=process.env.FROZEN_MODE;
if(mode==='loop-land-twice'){const n=Number(fs.readFileSync(path.join(dir,'.moe','claim-count'),'utf8'));
 fs.writeFileSync(path.join(dir,'owned.txt'),'frozen owned '+(n===2?1:n)+'\\n');}
else if(mode!=='no-change'&&mode!=='teardown-nothing')fs.writeFileSync(path.join(dir,'owned.txt'),'frozen owned\\n');
const file=path.join(dir,'.moe','attempts','attempt-postflight.json');
const qaClaimed=mode.endsWith('-qa-claimed'),exitOnly=/^(checkpoint|manual|freed)-/.test(mode)||mode==='teardown-running';
// reattach-sidecar/-refused: a daemon restart parks the attempt while this
// session runs, and the session goes on once the wrapper reattached it (or once
// the wait runs out, as under a restart nobody reattached). reattach-preflight
// records the phase the session started on.
const moeFile=f=>path.join(dir,'.moe',f),count=f=>{try{return Number(fs.readFileSync(moeFile(f),'utf8'));}catch(e){return 0;}};
const phase=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8')).phase;}catch(e){return '';}};
const waitFor=(test,ms)=>{for(const end=Date.now()+ms;!test()&&Date.now()<end;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);};
if(mode==='reattach-preflight')fs.writeFileSync(moeFile('cli-saw-phase'),phase());
if((mode==='reattach-sidecar'||mode==='reattach-refused')&&fs.existsSync(file)){
 const a=JSON.parse(fs.readFileSync(file,'utf8'));a.phase='reconciling';fs.writeFileSync(file,JSON.stringify(a));
 // One more ping after the reattach: the sidecar is sequential, so its line is out.
 if(mode==='reattach-sidecar'){waitFor(()=>phase()==='running',60000);const seen=count('heartbeat-count');waitFor(()=>count('heartbeat-count')>seen,30000);}
 else{waitFor(()=>fs.existsSync(moeFile('evidence-rpcs.jsonl'))&&fs.readFileSync(moeFile('evidence-rpcs.jsonl'),'utf8').includes('reattach_attempt'),60000);
  const pings=count('heartbeat-count');waitFor(()=>count('heartbeat-count')>=pings+3,30000);}}
if(mode==='reattach-none')waitFor(()=>count('heartbeat-count')>=3,30000);
if(fs.existsSync(file)){const a=JSON.parse(fs.readFileSync(file,'utf8'));if(!exitOnly)a.phase='finalizing';
if(mode.endsWith('-reconciling')||mode==='reattach-postflight')a.phase='reconciling';
if(mode==='closed-attempt'||mode==='freed-closed'||qaClaimed)a.phase='closed';if(mode==='stale-attempt'||mode==='freed-generation-bump')a.generation++;if(mode==='missing-attempt')fs.unlinkSync(file);else fs.writeFileSync(file,JSON.stringify(a));}
const stamp=new Date().toISOString();
if(qaClaimed)fs.writeFileSync(path.join(dir,'.moe','attempts','attempt-qa.json'),JSON.stringify({id:'attempt-qa',generation:8,taskId:'task-postflight',
 workerId:'qa-frozen',runnerId:'qa-frozen',phase:'running',workspace:dir,startedAt:stamp,lastPhaseAt:stamp}));
if(mode.endsWith('-unpinned')||mode==='freed-corrupt-sibling')fs.writeFileSync(path.join(dir,'.moe','attempts','zzz-broken.json'),'{not json');
if(mode==='teardown-no-baseline')fs.rmSync(${JSON.stringify(baselineFile)},{force:true});
if(/^teardown-(finalizing|manual|no-git|sha256|no-baseline|recovered|running)$/.test(mode)){const ready=path.join(dir,'.moe','gate-ready');fs.writeFileSync(ready,'ready');
 const until=Date.now()+120000,wait=setInterval(()=>{if(fs.existsSync(ready+'.sent')||Date.now()>until)clearInterval(wait);},100);}
`);
  const cli=path.join(root,mode+(win?'.cmd':'.sh'));
  write(cli,win?'@echo off\r\nchcp 65001 >nul\r\nnode "'+cliJs+'"\r\nexit /b %errorlevel%\r\n':
    '#!/usr/bin/env bash\nexec node "'+cliJs.replaceAll('\\','/')+'"\n');fs.chmodSync(cli,0o700);
  const race=path.join(root,mode+'-race.cjs');
  write(race,"const fs=require('fs'),cp=require('child_process');fs.writeFileSync('break-gate.txt','advanced');"+
    "cp.execFileSync('git',['add','--','break-gate.txt']);cp.execFileSync('git',['commit','-qm','peer-race','--','break-gate.txt']);");
  write(path.join(nested,'.moe','daemon.json'),JSON.stringify({port:9876,projectPath:nested}));
  const before=noGit||mode==='unborn'?'':git(repo,'rev-parse','HEAD'),index=path.join(repo,'.git','index');
  const beforeIndex=noGit||!fs.existsSync(index)?null:fs.readFileSync(index);
  const env={...process.env,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    FAKE_TASK_STATUS:'REVIEW',FAKE_SCOPE_PEERS_ACTIVE:'1',FAKE_SCOPE_PEER_DECLARED:'peer.txt:task-peer',
    FROZEN_FIXTURE:nested,FROZEN_MODE:mode,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),
    FAKE_EVIDENCE_MODE:mode,FAKE_CTX_IS_EPIC_FINAL:mode==='deferred'?'false':'true'};
  if(mode.startsWith('race-'))env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';
  // A peer lands an EMPTY commit before the CAS: new base, identical rebuilt tree.
  if(mode==='receipt-same-tree-race'){write(race,"require('child_process').execFileSync('git',['commit','--allow-empty','-qm','peer-empty']);");
    env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';}
  const args=win?['-NoProfile','-File',wrapper,'-Project',nested,'-WorkerId','worker-frozen','-Role','worker',
    '-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']:
    [wrapper,'--project',nested,'--worker-id','worker-frozen','--role','worker','--team','Smoke','--no-start-daemon',
    '--command',cli,'--no-loop','--poll-interval','0'];

  if(/^(checkpoint|manual)-/.test(mode)||mode==='teardown-running')env.FAKE_TASK_STATUS='WORKING';
  if(mode.startsWith('freed-'))env.FAKE_TASK_STATUS='BLOCKED';
  if(mode.endsWith('-unpinned'))env.FAKE_CLAIM_TOKENS='missing';
  // Reattach arms: the sidecar pings every second against the fake heartbeat.
  if(['reattach-sidecar','reattach-refused','reattach-none'].includes(mode)){delete env.MOE_DISABLE_HEARTBEAT;env.MOE_HEARTBEAT_INTERVAL_SEC='1';
    env.FAKE_HEARTBEAT_REATTACH=mode==='reattach-none'?'other':'1';}
  if(mode==='reattach-refused')env.FAKE_REATTACH_REFUSE='1';
  if(mode==='reattach-preflight')env.FAKE_ATTEMPT_PHASE='reconciling';
  if(mode==='finalize-loss'||mode==='loop-land-twice'||loopModes.includes(mode)){
    args[args.indexOf(win?'-NoLoop':'--no-loop')]=win?'-Loop':'--loop';
    args[args.indexOf(win?'-PollInterval':'--poll-interval')+1]='1';
  }
  let runEngine=engine,runArgs=args;
  const secondClaim=path.join(nested,'.moe','second-claim');
  if(loopModes.includes(mode)||mode==='loop-land-twice'){
    if(mode==='loop-land-twice')env.FAKE_CLAIM_LIMIT='3';else env.FAKE_CLAIM_ONCE='1';
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'loop-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,secondClaim,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  const receiptHeld=path.join(nested,'.moe','receipt-held');
  if(mode==='receipt-replay'){
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'receipt-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,receiptHeld,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  // The crash-window arms die the same way: at the held ledger row (window 1) or
  // at the held receipt (windows 2 and 3).
  const ledgerHeld=path.join(nested,'.moe','ledger-held');
  if(['receipt-ledger-replay','receipt-rebase-replay','receipt-foreign-replay'].includes(mode)){
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'receipt-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,mode==='receipt-ledger-replay'?ledgerHeld:receiptHeld,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  if(/^(interrupt|teardown)-/.test(mode)){
    const supervisor=path.join(root,mode+(win?'-supervisor.ps1':'-supervisor.sh'));
    if(win){
      write(path.join(root,'interrupt-args.json'),JSON.stringify(args));
      write(supervisor,`
param([string]$Engine,[string]$ArgsFile,[string]$Ready,[string]$Log,[int]$LimitMs)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$global:OutputEncoding=[Console]::OutputEncoding
$arguments=([IO.File]::ReadAllText($ArgsFile)|ConvertFrom-Json)|ForEach-Object {'"'+$_+'"'}
$p=Start-Process -FilePath $Engine -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
$null=$p.Handle
try {
  $until=[DateTime]::UtcNow.AddSeconds(120)
  while(-not (Test-Path -LiteralPath $Ready)){if($p.HasExited -or [DateTime]::UtcNow -gt $until){throw 'gate readiness failed'};Start-Sleep -Milliseconds 100}
  Add-Type 'using System; using System.Runtime.InteropServices; public static class GateSignal {
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h,bool add);
    [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint code,uint group);
  }'
  [GateSignal]::FreeConsole()|Out-Null
  if(-not [GateSignal]::AttachConsole($p.Id)){throw 'AttachConsole to OWNED wrapper failed'}
  [GateSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)|Out-Null
  if(-not [GateSignal]::GenerateConsoleCtrlEvent(0,0)){throw 'owned Ctrl+C failed'}
  [IO.File]::WriteAllText("$Ready.sent",'sent')
  if(-not $p.WaitForExit($LimitMs)){throw 'gate cancellation failed to finish'}
  Get-Content -LiteralPath $Log
  Get-Content -LiteralPath "$Log.err"
  exit $p.ExitCode
} finally {
  if(Test-Path -LiteralPath $Log){Get-Content -LiteralPath $Log}
  if(Test-Path -LiteralPath "$Log.err"){Get-Content -LiteralPath "$Log.err"}
  if(-not $p.HasExited){& taskkill /T /F /PID $p.Id|Out-Null;$p.WaitForExit(5000)|Out-Null}
}
`);
      runArgs=['-NoProfile','-File',supervisor,engine,path.join(root,'interrupt-args.json'),
        path.join(nested,'.moe','gate-ready'),path.join(root,'interrupt-child.log'),String(CANCEL_MS)];
    }else{
      write(supervisor,`
#!/usr/bin/env bash
set -m
ready="$1"; signal="$2"; shift 2
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' EXIT
for ((i=0;i<1200;i++)); do [ ! -f "$ready" ] || break; sleep 0.1; done
[ -f "$ready" ] || exit 98
kill "-$signal" "$child" || exit 97
: > "$ready.sent"
wait "$child"
rc=$?
trap - EXIT
exit "$rc"
`);
      runArgs=[supervisor,path.join(nested,'.moe','gate-ready'),mode==='interrupt-term'?'TERM':'INT',engine,...args];
    }
  }
  const run=cp.spawnSync(runEngine,runArgs,{env,encoding:'utf8',timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
  const log=(run.stdout||'')+(run.stderr||'');write(path.join(root,mode+'.log'),log);
  assert.equal(run.signal,null,log);assert.ok(run.status!==null,log);
  const rpc=rows(path.join(nested,'.moe','evidence-rpcs.jsonl')),candidates=rpc.filter(r=>r.tool==='record_candidate'),
    checks=rpc.filter(r=>r.tool==='record_check_run'),finals=rpc.filter(r=>r.tool==='finalize_attempt'),
    seen=rows(path.join(nested,'.moe','gate-observations.jsonl'));
  const failed=['dirty-helper','race-fail','tracked-mutation','exit-tail','missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt','workspace-failure','interrupt-int','interrupt-term',
    'gate-qa-claimed','hidden-mutation'].includes(mode)||mode.startsWith('record_');
  const after=noGit?'':git(repo,'rev-parse','HEAD');
  const lastCommit=rpc.filter(r=>r.tool==='record_commit').at(-1);
  const pushBlocked=rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>String(m.content).includes('PUSH-BLOCKED'))||
    rpc.some(r=>r.tool==='add_comment'&&String(r.args.content).includes('PUSH-BLOCKED'));
  if(loopModes.includes(mode))assert.equal(fs.existsSync(secondClaim),true,'the worker loop must go on claiming after this exit\n'+log);
  // Runner identity: every claim carries this wrapper's one pair (two claims in
  // one --loop wrapper carry the same one), and the attempt a claim opened
  // records it. A reattach goes out only for a parked attempt of this seat, with
  // that attempt's id and generation and the pair its claim recorded.
  const claims=rpc.filter(r=>r.tool==='claim_next_task').map(r=>r.args),pair=a=>[a.processStartedAt,a.host];
  assert.ok(claims.length>0,log);
  for(const c of claims){assert.ok(pair(c).every(v=>typeof v==='string'&&v.trim()),'every claim carries the runner identity\n'+log);
    assert.deepEqual(pair(c),pair(claims[0]),'one identity per wrapper process\n'+log);}
  if(mode==='identity-claim'){assert.ok(claims.length>=2,log);
    assert.deepEqual(pair(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json')))),pair(claims[0]),
      'the claim recorded the pair on the attempt it opened\n'+log);}
  const reattaches=rpc.filter(r=>r.tool==='reattach_attempt').map(r=>r.args),said=s=>log.split(s).length-1;
  if(['reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','checkpoint-reconciling','manual-reconciling'].includes(mode)){
    const r=reattaches[0]||{};
    assert.equal(reattaches.length,1,'exactly one reattach for the one parked attempt\n'+log);
    assert.deepEqual([r.taskId,r.workerId,r.attemptId,r.generation,...pair(r)],['task-postflight','worker-frozen','attempt-postflight',7,...pair(claims[0])],log);
    assert.ok(typeof r.runnerId==='string'&&r.runnerId.trim(),log);
    if(mode==='reattach-refused')assert.equal(said('moe.reattach_attempt refused for attempt attempt-postflight (ATTEMPT_IDENTITY_MISMATCH); not retrying it.'),1,
      'a refusal is logged once and not asked again\n'+log);
    else assert.equal(said('attempt attempt-postflight (generation 7) on task task-postflight is running again after a daemon restart.'),1,log);
    if(mode==='reattach-postflight')assert.ok(rpc.findIndex(x=>x.tool==='reattach_attempt')<rpc.findIndex(x=>x.tool==='record_candidate'),
      'the reattach precedes the candidate\n'+log);
    if(mode==='reattach-preflight'){assert.equal(read(path.join(nested,'.moe','cli-saw-phase')),'running','reattached before the CLI launched\n'+log);
      assert.equal(log.includes('Missing/stale attempt identity'),false,log);}
  }else assert.equal(reattaches.length,0,'nothing parked, so nothing to reattach\n'+log);
  if(mode==='reattach-none')for(const reason of ['no-worker-record','no-open-attempt'])
    assert.equal(said('heartbeat asks for reattachment ('+reason+')'),1,'each other reason is logged once\n'+log);
  const journal=path.join(repo,'.git','moe','receipt','task-postflight.json');
  if(mode==='receipt-replay'){
    // Run 1 landed and was hard-killed while its first receipt was held. Run 2 is
    // the same seat, whose claim is refused while that attempt is finalizing: it
    // replays the journaled report and closes the attempt, and never lands again.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const reflog=git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen');
    const second=cp.spawnSync(engine,args,{env:{...env,FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},encoding:'utf8',
      timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
    const log2=log+(second.stdout||'')+(second.stderr||'');write(path.join(root,mode+'.log'),log2);
    assert.equal(second.signal,null,log2);assert.ok(second.status!==null,log2);
    const rpc2=rows(path.join(nested,'.moe','evidence-rpcs.jsonl')),receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt'),
      finals2=rpc2.filter(r=>r.tool==='finalize_attempt'),c=candidates.at(-1).args;
    assert.equal(git(repo,'rev-parse','HEAD'),after,'the replay moves no ref\n'+log2);
    assert.equal(git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen'),reflog,'the replay moves no ref\n'+log2);
    assert.equal(receipts.length,2,log2);assert.deepEqual(receipts[1].args,receipts[0].args,'the replay re-sends the journaled report\n'+log2);
    assert.deepEqual([receipts[0].args.candidateId,receipts[0].args.target,receipts[0].args.targetBefore,receipts[0].args.targetAfter,
      receipts[0].args.landedRevision,receipts[0].args.pushResult],[c.id,c.deliveryTarget,c.baseRevision,after,after,undefined],log2);
    assert.equal(fs.readdirSync(path.join(nested,'.moe','receipts')).length,1,log2);
    assert.equal(finals2.length,1,'only the replay acknowledges the attempt\n'+log2);
    assert.deepEqual([finals2[0].args.attemptId,finals2[0].args.generation,finals2[0].args.outcome,finals2[0].args.landedRevision],
      ['attempt-postflight',7,'landed',after],log2);
    assert.ok(rpc2.indexOf(receipts[1])<rpc2.indexOf(finals2[0]),'the receipt precedes the finalize\n'+log2);
    assert.equal(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase,'closed',log2);
    assert.deepEqual(fs.readdirSync(path.join(nested,'.moe','attempts')),['attempt-postflight.json'],'the replay opens no attempt\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length,candidates.length+checks.length,
      'the replay freezes and gates nothing\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_commit'&&r.args.outcome==='committed').length,1,log2);
    assert.equal(fs.existsSync(journal),false,'a recorded replay deletes its journal\n'+log2);
    count++;continue;
  }
  // The three crash windows receipt-replay does not reach. Run 2 is its
  // claim-refused pre-flight; sid() is a commit's Moe-Session trailer.
  const sid=sha=>(git(repo,'log','-1','--format=%B',sha).split('\n').find(l=>l.startsWith('Moe-Session: '))||'').slice(13).trim();
  const ledgerRows=()=>rows(path.join(nested,'.moe','record_commit.jsonl')).filter(r=>r.outcome==='committed'&&r.kind==='completion');
  const reflogOf=()=>git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen');
  const replay=argv=>{const r=cp.spawnSync(engine,argv,{env:{...env,FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},encoding:'utf8',
      timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
    const log2=log+(r.stdout||'')+(r.stderr||'');write(path.join(root,mode+'.log'),log2);
    assert.equal(r.signal,null,log2);assert.ok(r.status!==null,log2);
    return {log2,rpc2:rows(path.join(nested,'.moe','evidence-rpcs.jsonl'))};};
  // What every replay leaves: no ref moved, nothing frozen or gated again, one
  // committed completion row, one landed finalize of the journal owner's attempt
  // after the last receipt, that attempt closed and the journal gone.
  const replayed=(rpc2,log2,reflog)=>{
    const receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt'),finals2=rpc2.filter(r=>r.tool==='finalize_attempt');
    assert.equal(git(repo,'rev-parse','HEAD'),after,'the replay moves no ref\n'+log2);
    assert.equal(reflogOf(),reflog,'the replay moves no ref\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length,candidates.length+checks.length,
      'the replay freezes and gates nothing\n'+log2);
    assert.equal(ledgerRows().length,1,'exactly one committed completion row\n'+log2);
    assert.equal(finals2.length,1,'the replay closes the attempt once\n'+log2);
    const f=finals2[0].args;
    assert.deepEqual([f.attemptId,f.generation,f.outcome,f.landedRevision,f.workerId],['attempt-postflight',7,'landed',after,'worker-frozen'],log2);
    assert.ok(rpc2.indexOf(receipts.at(-1))<rpc2.indexOf(finals2[0]),'the receipt precedes the finalize\n'+log2);
    assert.equal(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase,'closed',log2);
    assert.deepEqual(fs.readdirSync(path.join(nested,'.moe','attempts')),['attempt-postflight.json'],'the replay opens no attempt\n'+log2);
    assert.equal(fs.existsSync(journal),false,'a recorded replay deletes its journal\n'+log2);
    return receipts;
  };
  if(mode==='receipt-ledger-replay'){
    // Window 1: run 1 moved the ref and was hard-killed inside its committed ledger
    // call, so only the journal knows that row is owed. Run 2 (same seat) records
    // it, then the receipt, then closes the attempt.
    assert.ok(fs.existsSync(ledgerHeld),'run 1 must reach its ledger row\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const j1=JSON.parse(read(journal)),reflog=reflogOf();
    assert.equal(ledgerRows().length,0,'the killed ledger call recorded nothing\n'+log);
    const {log2,rpc2}=replay(args),owed=ledgerRows();
    assert.equal(owed.length,1,'the replay records the owed ledger row once\n'+log2);
    assert.deepEqual([owed[0].taskId,owed[0].sha,owed[0].ref,owed[0].role,owed[0].sessionId,owed[0].status,owed[0].pushed],
      ['task-postflight',after,'refs/heads/moe/frozen','worker',sid(after),'REVIEW',false],log2);
    const receipts=replayed(rpc2,log2,reflog),c=candidates.at(-1).args,
      row=rpc2.find(r=>r.tool==='record_commit'&&r.args.outcome==='committed'&&r.args.kind==='completion');
    assert.equal(receipts.length,1,log2);
    assert.ok(rpc2.indexOf(row)<rpc2.indexOf(receipts[0]),'the owed row precedes the receipt\n'+log2);
    assert.deepEqual([receipts[0].args.candidateId,receipts[0].args.target,receipts[0].args.targetBefore,receipts[0].args.targetAfter,
      receipts[0].args.landedRevision,receipts[0].args.pushResult],[c.id,c.deliveryTarget,c.baseRevision,after,after,undefined],log2);
    assert.deepEqual(j1.ledger,{sessionId:sid(after),role:'worker',status:'REVIEW'},'the journal carries the owed row\n'+log2);
    count++;continue;
  }
  if(mode==='receipt-rebase-replay'){
    // Window 2: the push's pull --rebase rewrote the landed commit, then the crash
    // lost its receipt. The journal names the CAS commit; the branch carries its copy.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    const j1=JSON.parse(read(journal)),C=j1.targetAfter,remote=path.join(root,mode+'-remote.git');
    assert.notEqual(C,after,'the pull --rebase rewrote the landed commit\n'+log);
    assert.equal(cp.spawnSync('git',['-C',repo,'merge-base','--is-ancestor',C,after]).status,1,log);
    assert.equal(git(remote,'rev-parse','refs/heads/moe/frozen'),after,log);assert.equal(sid(C),sid(after),log);
    assert.deepEqual([j1.ledger,j1.pushResult],[undefined,'pushed moe/frozen'],'an acknowledged ledger row leaves the journal\n'+log);
    assert.deepEqual(ledgerRows().map(r=>r.sha),[after],'run 1 recorded the rewritten copy\n'+log);
    const reflog=reflogOf(),{log2,rpc2}=replay(args),receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt');
    assert.equal(git(remote,'rev-parse','refs/heads/moe/frozen'),after,'the replay pushes nothing\n'+log2);
    assert.equal(receipts.length,2,'the rewritten copy counts as landed\n'+log2);
    assert.deepEqual(receipts[1].args,receipts[0].args,'the replay re-sends the journaled report\n'+log2);
    assert.deepEqual([receipts[0].args.targetAfter,receipts[0].args.landedRevision,receipts[0].args.pushResult],[C,C,'pushed moe/frozen'],log2);
    replayed(rpc2,log2,reflog);
    assert.equal(log2.includes('that landing never moved the ref'),false,log2);
    count++;continue;
  }
  if(mode==='receipt-foreign-replay'){
    // Window 3: the owner never comes back. Another seat's pre-flight replays the
    // journal and, git showing the landing, closes the owner's attempt.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const reflog=reflogOf(),{log2,rpc2}=replay(args.map(a=>a==='worker-frozen'?'worker-other':a));
    const receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt');
    assert.equal(rpc2.filter(r=>r.tool==='claim_next_task').at(-1).args.workerId,'worker-other',log2);
    assert.equal(receipts.length,2,log2);
    const {workerId:w0,...r0}=receipts[0].args,{workerId:w1,...r1}=receipts[1].args;
    assert.deepEqual([w0,w1,r1],['worker-frozen','worker-other',r0],'the other seat re-sends the journaled report\n'+log2);
    replayed(rpc2,log2,reflog);
    count++;continue;
  }
  if(mode.startsWith('teardown-')){
    const want=teardownOutcome[mode],commits=rpc.filter(r=>r.tool==='record_commit'),at=r=>rpc.indexOf(r);
    const refs=noGit?[]:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/').split('\n').filter(Boolean);
    const attempt=JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json')));
    const deregisterAt=rpc.findIndex(r=>r.tool==='deregister_worker');
    // Proof the interrupt really cut this session short: a post-flight that ran
    // to its end announces it, and an uninterrupted run could reach the same outcome.
    assert.equal(rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>String(m.content).includes('worker session ended: task=')),
      false,'the interrupt must land before the post-flight announces a normal end\n'+log);
    assert.equal(finals.length,want?1:0,'the interrupted exit acknowledges its finalizing attempt exactly once\n'+log);
    if(want){
      assert.equal(finals[0].args.outcome,want,log);
      assert.equal(attempt.phase,'closed',log);
      assert.ok(deregisterAt>at(finals[0]),'finalize_attempt must precede deregister_worker\n'+log);
    }else assert.equal(attempt.phase,'running','a running attempt is never acknowledged\n'+log);
    if(mode==='teardown-landed'){
      assert.equal(refs.length,0,'a landed commit is never parked again on a rescue ref\n'+log);
      assert.notEqual(after,before,log);assert.equal(finals[0].args.landedRevision,after);
      assert.equal(git(repo,'rev-parse','HEAD^{tree}'),candidates.at(-1)?.args.treeSha,log);
      assert.ok(commits.some(r=>r.args.outcome==='committed'&&r.args.kind==='completion'&&r.args.sha===after),log);
      assert.equal(commits.filter(r=>r.args.outcome!=='committed').length,0,'a landed commit records no failure\n'+log);
      // Interrupted before its receipt: the journal keeps the report for the next pre-flight.
      const j=fs.existsSync(journal)?JSON.parse(read(journal)):{};
      assert.deepEqual([j.candidateId,j.targetAfter,j.landedRevision],[candidates.at(-1)?.args.id,after,after],'an interrupted landing keeps its receipt journal\n'+log);
    }else if(mode==='teardown-nothing'){
      assert.equal(refs.length,0,'a no-change landing is never parked on a rescue ref\n'+log);
      assert.equal(after,before,log);assert.equal(read(owned),'base\n');
      assert.deepEqual(checks.map(r=>r.args.exitCode),[0],'its gate ran once and passed\n'+log);
      assert.equal(commits.filter(r=>r.args.outcome!=='nothing').length,0,'a no-change landing records no failure\n'+log);
    }else{
      assert.equal(candidates.length+checks.length+seen.length,0,'no landing ran, so no candidate and no gate\n'+log);
      if(teardownRescued.includes(mode)){
        assert.equal(refs.length,1,'the teardown parks the unlanded bytes\n'+log);
        assert.equal(git(repo,'show',refs[0]+':nested project é/owned.txt'),'frozen owned');
        const rescue=commits.find(r=>r.args.kind==='rescue');
        assert.ok(rescue&&at(rescue)<(want?at(finals[0]):deregisterAt),'the rescue is recorded before the finalize\n'+log);
      }else{assert.equal(refs.length,0,log);assert.equal(commits.length,0,'this exit reports no git activity\n'+log);}
      if(mode==='teardown-recovered'){assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\).* recovered$/);
        assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'recovered owned');}
      else{assert.equal(after,before,log);if(!noGit)assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    }
    assert.equal(read(path.join(nested,'helper.txt')),'dirty helper\n');assert.equal(read(path.join(nested,'peer.txt')),'peer bytes\n');
    if(!noGit)assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1);
    for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted');
    count++;continue;
  }
  if(mode.startsWith('manual-')||mode.startsWith('checkpoint-')){
    assert.equal(candidates.length+checks.length+finals.length+seen.length,0,log);
    // A parked attempt is reattached before the landing, so the ladder finds it running and says nothing.
    assert.equal(log.includes('[finalize] no finalizing attempt for this seat on task task-postflight'),!mode.endsWith('-reconciling'),log);
    if(mode.startsWith('manual-')){assert.equal(after,before);assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    else{assert.notEqual(after,before,log);assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\)/);
      assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');}
    count++;continue;
  }
  if(mode==='loop-land-twice'){
    // Two landings in one --loop wrapper: claim 1 lands, claim 2 re-presents the
    // bytes claim 1 landed, claim 3 lands. Claim 2's candidate is the unchanged
    // tip and must freeze the tip's real tree: the ps1 twin once froze an empty
    // one there, threw on its commit-tree, and neither landed nor rescued.
    const completions=rpc.filter(r=>r.tool==='record_commit'&&r.args.kind==='completion');
    assert.deepEqual(finals.map(f=>f.args.outcome),['landed','nothing-to-commit','landed'],log);
    for(const f of finals){assert.equal(f.args.attemptId,'attempt-postflight',log);assert.equal(f.args.generation,7,log);}
    assert.equal(fs.existsSync(secondClaim),true,'the worker loop must go on claiming after its third post-flight\n'+log);
    assert.deepEqual(completions.map(r=>r.args.outcome),['committed','nothing','committed'],log);
    assert.equal(completions[1].args.code,'MOE_COMMIT_NOTHING_TO_COMMIT',log);
    assert.equal(candidates.length,3,log);assert.deepEqual(checks.map(r=>r.args.exitCode),[0,0,0],log);
    assert.equal(candidates[1].args.baseRevision,finals[0].args.landedRevision,log);
    assert.equal(candidates[1].args.treeSha,git(repo,'rev-parse',finals[0].args.landedRevision+'^{tree}'),log);
    assert.deepEqual(seen.map(o=>o.owned),['frozen owned 1\n','frozen owned 1\n','frozen owned 3\n'],log);
    const subjects=git(repo,'log','--format=%s',before+'..moe/frozen').split('\n');
    assert.equal(subjects.length,2,log);for(const s of subjects)assert.match(s,/^feat\(task-postflight\): /,log);
    assert.equal(finals[2].args.landedRevision,after,log);assert.equal(git(repo,'rev-parse','HEAD~1'),finals[0].args.landedRevision,log);
    assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned 3',log);
    assert.equal(git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),'',log);
    for(const bad of ['Cannot bind argument','landing failed for task','rescue ref failed'])assert.equal(log.includes(bad),false,bad+'\n'+log);
    assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1,log);
    for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted\n'+log);
    count++;continue;
  }
  if(mode.startsWith('freed-')){
    assert.equal(candidates.length+checks.length+finals.length+seen.length,0,'a seat that holds no finalizing attempt acknowledges nothing\n'+log);
    assert.equal(log.split('[finalize] no finalizing attempt for this seat on task task-postflight').length-1,mode==='freed-generation-bump'?1:0,log);
    assert.equal(log.includes('Attempt identity unavailable'),false,'finalize reads only the pinned attempt record\n'+log);
    assert.equal(git(repo,'rev-list','--count',before+'..HEAD'),'1',log);
    assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\).*\[status=BLOCKED /,log);
    assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');
    count++;continue;
  }
  if(mode==='sha256-repo'){
    // Refused at the git probe, named once per wrapper process, and nothing lands:
    // no candidate, gate, commit or rescue ref, the CLI's bytes stay uncommitted,
    // and the finalize acknowledges nothing-to-commit, exactly as in no-git.
    assert.deepEqual({refused:said('MOE_COMMIT_REFUSED_OBJECT_FORMAT'),named:log.includes('uses the sha256 object format; Moe'),
      head:after===before,rescue:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),
      evidence:candidates.length+checks.length+seen.length,commits:rpc.filter(r=>r.tool==='record_commit').map(r=>r.args.outcome),
      finals:finals.map(f=>f.args.outcome),owned:read(owned),committed:git(repo,'show','HEAD:nested project é/owned.txt')},
      {refused:1,named:true,head:true,rescue:'',evidence:0,commits:[],finals:['nothing-to-commit'],owned:'frozen owned\n',committed:'base'},log);
    count++;continue;
  }
  if(['dirty-helper','race-fail','tracked-mutation','exit-tail','hidden-mutation','record_candidate-refuse'].includes(mode))
    assert.equal(pushBlocked,true,'a real gate or evidence persistence failure stays PUSH-BLOCKED\n'+log);
  if(mode==='dirty-helper'){
    assert.equal(after,before,'dirty helper must not authorize a branch commit\n'+log);
    assert.equal(checks[0]?.args.exitCode,19);
    // Both twins announce a failed gate with the same marked line: the chat line,
    // and the first line of the task comment.
    const line=String.fromCodePoint(0x1f6ab)+' PUSH-BLOCKED: qualityGate failed for task task-postflight: node gate.cjs (exit 19)';
    assert.deepEqual({chat:rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>m.content===line),
      comment:rpc.some(r=>r.tool==='add_comment'&&String(r.args.content).split('\n')[0]===line)},{chat:true,comment:true},log);
  }else if(mode==='race-fail'){
    assert.equal(git(repo,'log','-1','--format=%s'),'peer-race','stale candidate check must not authorize rebuilt tree\n'+log);
    assert.equal(checks.length,2);assert.deepEqual(checks.map(r=>r.args.exitCode),[0,23]);
  }
  if(mode==='manual'||mode==='no-git'){
    assert.equal(candidates.length,0);assert.equal(checks.length,0);assert.equal(finals.length,1,log);
    assert.equal(finals[0].args.outcome,'nothing-to-commit');assert.equal(after,before);count++;continue;
  }
  if(['disabled','deferred','nogate-qa-claimed','gate-blank'].includes(mode)){
    assert.equal(candidates.length,0,'a completion with no gate to run records no candidate\n'+log);assert.equal(pushBlocked,false,log);
    if(mode==='nogate-qa-claimed')assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');
    // A whitespace-only qualityGate lands exactly as an unset one: no check run, no
    // rescue ref, one landed finalize -- that row also proves the rpc log was read.
    if(mode==='gate-blank')assert.deepEqual({checks:checks.length,gateRuns:seen.length,rescue:git(repo,'for-each-ref','refs/moe/rescue/'),
      finals:finals.map(f=>f.args.outcome),landed:after!==before},{checks:0,gateRuns:0,rescue:'',finals:['landed'],landed:true},log);
  }else if(identityModes.includes(mode)){
    assert.equal(after,before);assert.equal(candidates.length+checks.length+seen.length,0,'no current attempt: the gate never runs\n'+log);
    assert.ok(log.includes('qualityGate not run: candidate evidence unavailable'),log);assert.equal(pushBlocked,false,log);
    assert.ok(String(lastCommit?.args.message).includes('candidate evidence unavailable'),log);
    if(mode.startsWith('claim-'))assert.ok(log.includes('has no pinned identity; not acknowledging.'),log);
  }else{
    assert.ok(candidates.length>0,'candidate must be recorded\n'+log);
    for(const c of candidates){assert.equal(c.args.attemptId,'attempt-postflight');assert.equal(c.args.generation,7);
      assert.equal(c.args.deliveryTarget,'refs/heads/moe/frozen');}
  }
  if(mode.startsWith('race-')){
    assert.equal(candidates.length,2);assert.notEqual(candidates[0].args.id,candidates[1].args.id);
    assert.notEqual(candidates[0].args.treeSha,candidates[1].args.treeSha);
    assert.notEqual(candidates[0].args.baseRevision,candidates[1].args.baseRevision);
    if(mode==='race-pass')assert.deepEqual(checks.map(r=>r.args.candidateId),candidates.map(r=>r.args.id),'a moved target reruns the gate on the rebuilt candidate\n'+log);
  }
  // A padded qualityGate still runs, and records the trimmed command: the delivery
  // policy builds its required-check token from the trimmed string.
  if(mode==='gate-padded')assert.deepEqual({gateRuns:seen.length,recorded:checks.map(r=>[r.args.command,r.args.exitCode])},
    {gateRuns:1,recorded:[['node gate.cjs',0]]},log);
  for(const check of checks){
    const ci=rpc.findIndex(r=>r.tool==='record_candidate'&&r.args.id===check.args.candidateId);
    assert.ok(ci>=0&&ci<rpc.indexOf(check));assert.equal(check.args.treeSha,rpc[ci].args.treeSha);
    assert.equal(check.args.source,'runner-observed');assert.equal(check.args.command,'node gate.cjs');
    assert.ok(Buffer.byteLength(check.args.outputTail)<=16384);
  }
  for(const o of seen){
    assert.notEqual(path.resolve(o.cwd),path.resolve(nested));assert.equal(path.basename(o.cwd),'nested project é');
    assert.equal(path.resolve(o.project),path.resolve(o.cwd));assert.equal(o.helper,false);assert.equal(o.peer,false);assert.equal(o.denied,false);
    assert.ok(candidates.some(r=>r.args.treeSha===o.tree));assert.ok(o.persisted.some(c=>c.treeSha===o.tree),'candidate persisted before gate execution');assert.equal(o.owned,mode==='no-change'?'base\n':'frozen owned\n');
  }
  const refs=git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/').split('\n').filter(Boolean);
  if(failed){
    assert.equal(refs.length,1,'failure must rescue frozen bytes\n'+log);
    assert.equal(git(repo,'show',refs[0]+':nested project é/owned.txt'),'frozen owned');
    if(candidates.length)assert.equal(git(repo,'rev-parse',refs[0]+'^{tree}'),candidates.at(-1).args.treeSha,'rescue must preserve the entire frozen tree');
    if(mode!=='race-fail'){assert.equal(after,before);assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    assert.equal(rpc.filter(r=>r.tool==='record_commit').at(-1)?.args.code,'MOE_COMMIT_FAILED_GATE');
  }else{
    if(mode!=='no-change')assert.notEqual(after,before,log);
    if(candidates.length)assert.equal(git(repo,'rev-parse','HEAD^{tree}'),candidates.at(-1).args.treeSha);
    assert.equal(refs.length,0);assert.equal(read(owned),mode==='shared-mutation'?'late shared\n':mode==='no-change'?'base\n':'frozen owned\n');
  }
  if(['disabled','deferred','workspace-failure'].includes(mode))assert.equal(checks.length,0);
  if(mode==='exit-tail'){assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,37);assert.ok(checks[0].args.outputTail.endsWith('TAILEND'));
    let expected=Buffer.from('é😀'.repeat(5000)+'TAILEND').subarray(-16384);
    while(expected.length&&(expected[0]&0xc0)===0x80)expected=expected.subarray(1);
    assert.equal(checks[0].args.outputTail,expected.toString('utf8'));
    assert.ok(rpc.some(r=>r.tool==='add_comment'&&r.args.content.includes('TAILEND')),'failure comment keeps output tail');
    assert.ok(Buffer.byteLength(checks[0].args.outputTail)>16000,'tail bytes='+Buffer.byteLength(checks[0].args.outputTail)+' prefix='+JSON.stringify(checks[0].args.outputTail.slice(0,16)));}
  if(mode==='unborn'){
    assert.equal(candidates.length,1,log);assert.equal(candidates[0].args.baseRevision,EMPTY_TREE,'unborn base is the empty tree object');
    assert.equal(git(repo,'rev-list','--parents','-n','1','HEAD'),after,'unborn landing is a parentless root commit');
    assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0);
  }
  if(mode==='hidden-mutation'){assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0,'integrity refusal keeps the actual exit code');}
  if(mode==='receipt-cached-check'){
    assert.ok(fs.existsSync(path.join(repo,'.git','moe-cas-refused')),'git refused the first CAS\n'+log);
    assert.equal(candidates.length,1,log);assert.equal(checks.length,1,log);
    assert.equal(seen.length,1,'an unchanged tree and base reuse the passed check\n'+log);assert.ok(log.includes('qualityGate result reused'),log);
  }
  if(mode==='receipt-same-tree-race'){
    assert.equal(candidates.length,2,log);assert.equal(candidates[0].args.treeSha,candidates[1].args.treeSha,'the empty peer commit keeps the tree\n'+log);
    assert.notEqual(candidates[0].args.baseRevision,candidates[1].args.baseRevision,log);
    assert.deepEqual(checks.map(r=>r.args.candidateId),candidates.map(r=>r.args.id),'a new base reruns the gate even on the same tree\n'+log);
    assert.equal(log.includes('qualityGate result reused'),false,log);
  }
  const generalChat=rows(path.join(nested,'.moe','messages','chan-general.jsonl')).map(m=>String(m.content));
  if(mode==='receipt-push'){
    assert.equal(git(path.join(root,mode+'-remote.git'),'rev-parse','refs/heads/moe/frozen'),after,'the landing reached the remote\n'+log);
    assert.equal(generalChat.some(m=>m.startsWith('PUSH FAILED')),false,log);
  }
  if(mode==='receipt-push-failed')assert.ok(generalChat.some(m=>m.startsWith('PUSH FAILED for task task-postflight')),log);
  if(mode==='cleanup-retry'){
    assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0);assert.equal(pushBlocked,false,log);
    assert.ok(log.split('Cannot remove owned qualityGate workspace').length>2,'a failed cleanup is reported and retried\n'+log);
    const locked=git(repo,'worktree','list','--porcelain').split('\n\n').filter(b=>/\nlocked/.test(b)).map(b=>b.split('\n')[0].slice('worktree '.length));
    assert.equal(locked.length,1,'the locked gate workspace is still registered\n'+log);
    git(repo,'worktree','unlock',locked[0]);git(repo,'worktree','remove','--force',locked[0]);
    fs.rmSync(path.dirname(locked[0]),{recursive:true,force:true});
  }
  if(mode==='finalize-loss'||mode==='finalize-loss-once'){
    assert.equal(finals.length,mode==='finalize-loss'?3:2,log);
    for(const f of finals)assert.deepEqual(f.args,finals[0].args);
    assert.equal(rpc.filter(r=>r.tool==='record_commit'&&r.args.kind==='completion').length,1);
  }else assert.equal(finals.length,noFinal.includes(mode)?0:1,log);
  for(const f of finals){assert.equal(f.args.attemptId,'attempt-postflight',log);assert.equal(f.args.generation,7,log);}
  if(finals.length){assert.equal(finals[0].args.outcome,failed?'rescued':mode==='no-change'?'nothing-to-commit':'landed');
    if(!failed&&mode!=='no-change')assert.equal(finals[0].args.landedRevision,after);}
  // Delivery receipts: one per landed gated candidate -- after its ledger row,
  // before its finalize, naming that candidate and the CAS base -- none for any
  // other exit. A journal outlives its landing only while the receipt is not
  // recorded (refused); a conflicting receipt already records it. Neither
  // bookkeeping failure touches the landing, its ledger row or its finalize.
  const receipts=rpc.filter(r=>r.tool==='record_delivery_receipt'),refusedReceipt=mode==='receipt-refused';
  assert.deepEqual(fs.existsSync(path.dirname(journal))?fs.readdirSync(path.dirname(journal)):[],refusedReceipt?['task-postflight.json']:[],
    'a journal outlives its landing only while its receipt is unrecorded\n'+log);
  if(!failed&&candidates.length&&after!==before){
    const c=candidates.at(-1).args,r=receipts[0]?.args||{};
    const ledgerAt=rpc.findIndex(x=>x.tool==='record_commit'&&x.args.outcome==='committed'&&x.args.kind==='completion');
    assert.equal(receipts.length,1,'a landed gated candidate records exactly one delivery receipt\n'+log);
    assert.deepEqual([r.candidateId,r.target,r.targetBefore,r.targetAfter,r.landedRevision],
      [c.id,c.deliveryTarget,mode==='unborn'?ZERO_OID:c.baseRevision,after,after],log);
    if(mode==='receipt-push-failed'){assert.match(String(r.pushResult),/^push failed: fatal: .+$/,log);assert.ok(r.pushResult.length<=500,log);}
    else assert.equal(r.pushResult,mode==='receipt-push'?'pushed moe/frozen':undefined,log);
    if(!mode.startsWith('receipt-push'))assert.ok(log.includes('no git remote configured; push skipped'),'no remote, no push attempt\n'+log);
    assert.ok(ledgerAt>=0&&ledgerAt<rpc.indexOf(receipts[0]),'the receipt follows the ledger row\n'+log);
    if(finals.length)assert.ok(rpc.indexOf(receipts[0])<rpc.indexOf(finals[0]),'the receipt precedes the finalize\n'+log);
    assert.equal(fs.existsSync(path.join(nested,'.moe','receipts',c.id+'.json')),!refusedReceipt&&mode!=='receipt-conflict',log);
    if(refusedReceipt){assert.ok(log.includes('delivery receipt not recorded for candidate '+c.id),log);
      assert.deepEqual(JSON.parse(read(journal)),{taskId:'task-postflight',workerId:'worker-frozen',attemptId:'attempt-postflight',generation:7,
        candidateId:c.id,target:c.deliveryTarget,targetBefore:c.baseRevision,targetAfter:after,landedRevision:after,pushResult:null},
        'a refused receipt stays journaled verbatim for the next pre-flight\n'+log);}
    if(mode==='receipt-conflict')assert.ok(log.includes('already has a delivery receipt that differs from this report'),log);
  }else assert.equal(receipts.length,0,'only a landed gated candidate records a delivery receipt\n'+log);
  assert.equal(read(path.join(nested,'helper.txt')),'dirty helper\n');assert.equal(read(path.join(nested,'peer.txt')),'peer bytes\n');
  assert.equal(fs.existsSync(path.join(nested,'scratch.txt')),false);
  if(mode.startsWith('interrupt-')){
    assert.equal(checks.length,1,'started interrupted command must have an observed exit');
    assert.notEqual(checks[0].args.exitCode,0);
    const rescueAt=rpc.findIndex(r=>r.tool==='record_commit'&&r.args.kind==='rescue');
    assert.ok(rescueAt>=0&&rpc.findIndex(r=>r.tool==='deregister_worker')>rescueAt,'rescue before deregister');
    assert.equal(read(owned),'late shared\n');
    for(const o of seen)for(const pid of [o.pid,o.childPid]){
      let alive=true,detail='';try{process.kill(pid,0);}catch(e){alive=false;}
      if(alive&&process.platform==='win32'){
        const ps="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+"';if($p){@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}";
        detail=cp.execFileSync('powershell.exe',['-NoProfile','-Command',ps],{encoding:'utf8'}).trim();
        if(!detail)alive=false;
        else if(Date.parse(JSON.parse(detail).created)>Date.parse(o.recordedAt)){console.log('[cleanup] Windows reused exited gate PID '+pid+' '+detail);alive=false;}
      }
      assert.equal(alive,false,'gate process leaked: '+pid+' '+detail);
    }
  }

  assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1);
  for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted');
  count++;
}
console.log('PASS frozen candidate scenarios: '+count);
}catch(e){console.error('FROZEN FIXTURE '+root);throw e;}
finally{if(!process.env.MOE_KEEP_FROZEN_FIXTURE)for(const d of [root,wrapperTmp])fs.rmSync(d,{recursive:true,force:true,maxRetries:10,retryDelay:200});}

FROZENJS
"$NODE_FOR_TEST" "$FROZEN_SUITE" sh "$WRAPPER" "$FAKE_PROXY" "$TMP_DIR" "$(command -v bash)"
if printenv MOE_FROZEN_TEST_ONLY >/dev/null; then exit 0; fi

set +e
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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
  MOE_HEARTBEAT_INTERVAL_SEC=1 MOE_HEARTBEAT_MAX_DURATION_SEC=30 timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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

# --- Hot reload: the wrapper re-execs itself when its own bytes change on disk
# (twin: the hot-reload arm in postflight.ps1). Two edits to a COPY -- a
# repo-launched seat reloads on every edit of the real file -- must each yield
# exactly one deregister_worker with reason wrapper_restart, then a fresh
# claim_next_task (the daemon re-registers a worker on its claim), and no
# further restart: the relaunched wrapper hashes the new bytes and must not
# thrash. The second restart announcement must come from the edited bytes.
# Until 45633c7 the sh relaunch got NO arguments and died with "Provide
# --project or --project-name": every sh seat, on its first hot reload. ---
echo "[hot reload] a changed wrapper restarts once per edit and re-registers"
RELOAD_DIR="$TMP_DIR/reload"
RELOAD_PROJECT="$RELOAD_DIR/project"
RELOAD_WRAPPER="$RELOAD_DIR/scripts/moe-agent.sh"
mkdir -p "$RELOAD_PROJECT/.moe/messages"
# The whole scripts/ dir: the restart deregisters through the sibling moe-call.sh.
cp -R "$ROOT_DIR/scripts" "$RELOAD_DIR/"
chmod +x "$RELOAD_WRAPPER"
printf '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}\n' > "$RELOAD_PROJECT/.moe/project.json"
: > "$RELOAD_PROJECT/.moe/messages/chan-general.jsonl"
# moe-call.sh refuses to deregister without daemon.json; the fake proxy never reads it.
printf '{"port":9876,"projectPath":"%s"}\n' "$RELOAD_PROJECT" > "$RELOAD_PROJECT/.moe/daemon.json"
# c = claim_next_task, r = a wrapper_restart deregister, x = any other deregister
# (the postflight.ps1 twin maps the same). A line still mid-append is skipped.
cat > "$TMP_DIR/reload-sequence.cjs" <<'JS'
const fs=require('fs'),file=process.argv[2];
const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const rows=text.split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch(e){return [];}});
process.stdout.write(rows.map(r=>r.tool==='claim_next_task'?'c':r.tool!=='deregister_worker'?'':
  r.args&&r.args.reason==='wrapper_restart'?'r':'x').join(''));
JS
reload_seq() { "$NODE_FOR_TEST" "$TMP_DIR/reload-sequence.cjs" "$RELOAD_PROJECT/.moe/evidence-rpcs.jsonl" 2>/dev/null || true; }
PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=idle MOE_DISABLE_HEARTBEAT=1 \
  "$RELOAD_WRAPPER" \
  --project "$RELOAD_PROJECT" \
  --worker-id worker-reload \
  --role worker \
  --no-start-daemon \
  --command /bin/true \
  --loop \
  --poll-interval 1 \
  >"$TMP_DIR/wrapper-reload.out" 2>&1 &
reload_pid=$!
# The EXIT trap kills LIVE_PIDS: an abort below must not leave a looping wrapper.
reload_live_before="$LIVE_PIDS"
LIVE_PIDS="$LIVE_PIDS $reload_pid"
reload_fail() {
  kill -KILL "$reload_pid" 2>/dev/null || true
  cat "$TMP_DIR/wrapper-reload.out" >&2 || true
  cat "$RELOAD_PROJECT/.moe/deregister.log" >&2 2>/dev/null || true
  echo "HOT RELOAD FAILED: $1 (RPC sequence '$(reload_seq)')" >&2
  exit 1
}
# reload_wait EDITS REGEX -- poll until the sequence matches REGEX. Fails at once
# on a deregister with another reason (the hand-over took an exit path), on more
# restarts than edits (thrash), or on a wrapper that is gone.
reload_wait() {
  local edits="$1" want="$2" deadline=$((SECONDS + POSTFLIGHT_TIMEOUT_SEC)) seq restarts
  while [ "$SECONDS" -lt "$deadline" ]; do
    seq="$(reload_seq)"
    restarts="${seq//[!r]/}"
    case "$seq" in *x*) reload_fail "a deregister other than wrapper_restart" ;; esac
    [ "${#restarts}" -le "$edits" ] || reload_fail "a restart with no edit behind it"
    if [[ $seq =~ $want ]]; then return 0; fi
    kill -0 "$reload_pid" 2>/dev/null || reload_fail "the wrapper exited"
    sleep 0.5
  done
  reload_fail "timed out after ${POSTFLIGHT_TIMEOUT_SEC}s waiting for $want"
}
reload_wait 0 '^c'
# Edit 1 rewrites the restart announcement, which the SECOND restart prints from
# the reloaded bytes. The running bash parsed the whole loop already, and the
# restart deregisters before it execs, so the exec reads the finished write.
"$NODE_FOR_TEST" -e 'const fs=require("fs"),f=process.argv[1],a="restarting to load it\"",t=fs.readFileSync(f,"utf8");
if(t.split(a).length!==2)process.exit(3);fs.writeFileSync(f,t.replace(a,"restarting to load it (edit 1 loaded)\""));' "$RELOAD_WRAPPER" \
  || reload_fail "the restart announcement is missing from the wrapper"
reload_wait 1 '^c+rcc'
printf '# reload 2\n' >> "$RELOAD_WRAPPER"
reload_wait 2 '^c+rc{2,}rcc'
reload_final="$(reload_seq)"
kill -KILL "$reload_pid" 2>/dev/null || true
wait "$reload_pid" 2>/dev/null || true
LIVE_PIDS="$reload_live_before"
reload_want='^c+rc{2,}rc{2,}$'
[[ $reload_final =~ $reload_want ]] \
  || reload_fail "expected claims, then exactly two wrapper_restart deregisters each followed by claims"
grep -Fq 'restarting to load it (edit 1 loaded)' "$TMP_DIR/wrapper-reload.out" \
  || reload_fail "the second restart did not run the edited bytes"
echo "[hot reload] ok: 2 restarts, each re-registered, none without an edit"

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
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS=REVIEW timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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
    PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_TASK_STATUS="${FAKE_TASK_STATUS:-REVIEW}" timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
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
  # tool_use (content_block_start/delta/stop) on a RELATIVE path followed by
  # its complete assistant block, plus an ABSOLUTE path under the project.
  # Both real writes have matching successful tool results before entering TOOL.
  STREAM_CLI="$TMP_DIR/stream-cli"
  cat > "$STREAM_CLI" <<'EOF'
#!/usr/bin/env bash
abs_root="$MOE_PROJECT_PATH"
if command -v cygpath >/dev/null 2>&1; then abs_root="$(cygpath -m "$MOE_PROJECT_PATH")"; fi
echo tool > "$MOE_PROJECT_PATH/tool-written.txt"
echo tool-abs > "$MOE_PROJECT_PATH/tool-written-abs.txt"
printf '%s\n' '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"fake"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"write-relative","name":"Write"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"tool-wr"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"itten.txt\",\"content\":\"tool\"}"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop"}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write-relative","name":"Write","input":{"file_path":"tool-written.txt","content":"tool"}}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write-relative","is_error":false,"content":"wrote fixture"}]}}'
abs_json="$(printf '%s' "$abs_root/tool-written-abs.txt" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"write-absolute\",\"name\":\"Write\",\"input\":{\"file_path\":\"$abs_json\",\"content\":\"tool-abs\"}}]}}"
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write-absolute","is_error":false,"content":"wrote fixture"}]}}'
printf '%s\n' '{"type":"result","num_turns":1,"duration_ms":10,"stop_reason":"end_turn"}'
exit 0
EOF
  chmod +x "$STREAM_CLI"
  # SERENA_CLI (scenario K2) writes six files, then streams Serena's current
  # editing tools the way Claude Code reports MCP calls: a complete tool_use,
  # then a successful tool_result whose content is a [{type:text,text}] list
  # (once a plain string). The texts are Serena's own: replace_content 'OK',
  # replace_in_files' applied summary (plain, and inside the diagnostics JSON
  # envelope with a Windows path), a rename_symbol success. refused.txt is
  # named only by calls that changed nothing: a safe_delete_symbol refusal, a
  # replace_in_files dry run and a failed rename. Same transcript as the ps1
  # harness's serena-stream.jsonl.
  SERENA_CLI="$TMP_DIR/serena-cli"
  cat > "$SERENA_CLI" <<'EOF'
#!/usr/bin/env bash
mkdir -p "$MOE_PROJECT_PATH/sub dir"
for f in contested.txt multi-a.txt multi-b.txt rename-decl.txt refused.txt 'sub dir/diag.txt'; do
  echo serena > "$MOE_PROJECT_PATH/$f"
done
cat <<'JSONL'
{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"fake"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-content","name":"mcp__serena__replace_content","input":{"relative_path":"contested.txt","needle":"old","repl":"serena","mode":"literal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-content","is_error":false,"content":[{"type":"text","text":"OK"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-files-text","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-files-text","is_error":false,"content":"Replaced 3 occurrence(s) in 2 file(s):\n  multi-a.txt: 2\n  multi-b.txt: 1"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-files-diag","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal","relative_path":"sub dir"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-files-diag","is_error":false,"content":[{"type":"text","text":"{\"result\": \"Replaced 1 occurrence(s) in 1 file(s):\\n  sub dir\\\\diag.txt: 1\", \"diagnostics[warning-or-higher]\": {\"sub dir\\\\diag.txt\": {}}}"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-rename","name":"mcp__serena__rename_symbol","input":{"name_path":"Foo","relative_path":"rename-decl.txt","new_name":"Bar"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-rename","is_error":false,"content":[{"type":"text","text":"Successfully renamed 'Foo' to 'Bar' (1 changes applied)"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-delete","name":"mcp__serena__safe_delete_symbol","input":{"name_path_pattern":"Baz","relative_path":"refused.txt"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-delete","is_error":false,"content":[{"type":"text","text":"Cannot delete, the symbol Baz is referenced in: {\"multi-a.txt\": [3]}"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-dry-run","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal","dry_run":true}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-dry-run","is_error":false,"content":[{"type":"text","text":"Found 1 occurrence(s) in 1 file(s). DRY RUN - no changes were applied.\n\nrefused.txt (1 occurrence(s)):\n  refused.txt: 1"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-rename-failed","name":"mcp__serena__rename_symbol","input":{"name_path":"Baz","relative_path":"refused.txt","new_name":"Qux"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-rename-failed","is_error":false,"content":[{"type":"text","text":"Error executing tool: ValueError: Renaming symbol 'Baz' to 'Qux' resulted in no changes being applied"}]}]}}
{"type":"result","num_turns":1,"duration_ms":10,"stop_reason":"end_turn"}
JSONL
exit 0
EOF
  chmod +x "$SERENA_CLI"

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

  # Scenario K2 -- Serena's current editing tools are TOOL evidence too. Six
  # asserted paths are also peer-declared (contested): under the default
  # attribution.contested=skip-untouched each lands only with a TOOL witness.
  # replace_content, replace_in_files (both content shapes, the diagnostics
  # envelope, a Windows path with a space) and rename_symbol's declaring file
  # land; refused.txt, named only by calls that changed nothing, stays out.
  echo "[scenario K2] Serena's current editing tools witness contested paths; no-op results do not"
  SCOPE_K2_DIR="$TMP_DIR/scope-k2"
  make_scope_project "$SCOPE_K2_DIR" '["owned-a.txt","contested.txt","multi-a.txt","multi-b.txt","rename-decl.txt","refused.txt","sub dir/diag.txt"]'
  echo owned-a > "$SCOPE_K2_DIR/owned-a.txt"
  set +e
  FAKE_SCOPE_PEERS_ACTIVE=1 FAKE_SCOPE_PEER_DECLARED='contested.txt:task-peer,multi-a.txt:task-peer,multi-b.txt:task-peer,rename-decl.txt:task-peer,refused.txt:task-peer,sub dir/diag.txt:task-peer' \
    run_scope_wrapper "$SCOPE_K2_DIR" "$TMP_DIR/scope-k2.out" "$SERENA_CLI"
  scope_k2_code=$?
  set -e
  [ "$scope_k2_code" -eq 0 ] || scope_fail K2 "wrapper exited with $scope_k2_code" "$TMP_DIR/scope-k2.out"
  scope_k2_files="$(committed_paths "$SCOPE_K2_DIR")"
  if [ "$scope_k2_files" != "contested.txt multi-a.txt multi-b.txt owned-a.txt rename-decl.txt sub dir/diag.txt " ]; then
    scope_fail K2 "expected owned-a.txt + every Serena-witnessed contested path; got [$scope_k2_files]" "$TMP_DIR/scope-k2.out"
  fi
  if ! git -C "$SCOPE_K2_DIR" status --porcelain | grep -q '^?? refused\.txt$'; then
    scope_fail K2 "refused.txt must stay untracked" "$TMP_DIR/scope-k2.out"
  fi
  if ! grep -Fq '[skip] refused.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)' "$TMP_DIR/scope-k2.out"; then
    scope_fail K2 "expected '[skip] refused.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)'" "$TMP_DIR/scope-k2.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario K2] ok"

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

  # Scenario M2 -- the live-session guard on scenario M's recovery predicate.
  # "A baseline that never reached a completed landing" is true for a CRASHED
  # session AND for one that is still running and about to commit: a worker
  # calls complete_task, the task flips to REVIEW, and a QA seat claims it
  # inside the window before the worker's CLI exits and its post-flight
  # commits. The old predicate made that QA pre-flight land the live worker's
  # entire implementation as its own `... recovered` checkpoint -- measured
  # twice on 2026-09-11 (ac6c9dc carried util/enforcement.ts +144 and
  # util/enforcement.test.ts +472; b5925e2 carried delivery/acceptance.test.ts
  # +2184), leaving each worker's feat(...) completion holding only a board
  # record. The live-session marker beside the baseline discriminates the two.
  # Five sub-cases: (a) and (b) are the fix; (c), (d) and (e) are the behaviour
  # that must NOT move and are asserted before AND after it.
  echo "[scenario M2] a live owner's baseline is skipped; a dead one still recovers"

  # The fixtures below must spell the marker exactly as moe-agent.sh writes it,
  # so the case proves the real probe rather than a private harness format.
  live_marker_ns() {
    case "$(uname -s 2>/dev/null)" in
      MINGW*|MSYS*|CYGWIN*) printf 'msys' ;;
      *) printf 'posix' ;;
    esac
  }
  live_marker_host() {
    hostname 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
  }
  live_marker_start() { # $1 = pid -- /proc starttime (field 22), '' when unreadable
    [ -r "/proc/$1/stat" ] || return 0
    sed -n 's/.*) //p' "/proc/$1/stat" 2>/dev/null | awk '{print $20}' | tr -d '[:space:]'
  }
  write_live_marker() { # $1 dir, $2 taskId, $3 pid, $4 start token, [$5 host], [$6 ns]
    local dir="$1" tid="$2" pid="$3" start="$4" host ns
    host="${5:-$(live_marker_host)}"
    ns="${6:-$(live_marker_ns)}"
    mkdir -p "$dir/.git/moe/baseline"
    printf '#moe-live v1 task=%s pid=%s host=%s ns=%s worker=worker-owner session=worker-owner@2026-09-11T10:27:44Z start=%s\n' \
      "$tid" "$pid" "$host" "$ns" "$start" > "$dir/.git/moe/baseline/$tid.live"
  }
  write_lingering_baseline() { # $1 dir, $2 taskId -- the shape scenario M builds inline
    local dir="$1" tid="$2" p
    mkdir -p "$dir/.git/moe/baseline"
    {
      printf '#moe-baseline v1 task=%s at=2026-01-01T00:00:00Z head=%s landed=0\n' "$tid" "$(git -C "$dir" rev-parse HEAD)"
      for p in .moe/project.json .moe/messages/chan-general.jsonl .moe/tasks/task-postflight.json ".moe/tasks/$tid.json"; do
        [ -f "$dir/$p" ] || continue
        printf 'B\t%s\t%s\n' "$(git -C "$dir" hash-object -- "$p")" "$p"
      done
    } > "$dir/.git/moe/baseline/$tid.tsv"
  }
  make_m2_project() { # $1 dir, $2 taskId, $3 record status -- baseline + dirty impl.txt
    local dir="$1" tid="$2" st="$3"
    make_scope_project "$dir" '["ignored.txt"]'
    write_task_record "$dir" '["impl.txt"]' "$st" '[]' "$tid"
    echo impl > "$dir/impl.txt"
    write_lingering_baseline "$dir" "$tid"
  }
  # Subjects of every commit carrying this task, written to a FILE: never pipe
  # a producer into `grep -q` under `set -o pipefail` -- the reader exits at the
  # first match, the writer dies with SIGPIPE, the pipeline status is 141 and
  # the guard silently reads false in exactly the case it exists for.
  m2_subjects() { # $1 dir, $2 taskId, $3 out file
    git -C "$1" log --pretty=%s --fixed-strings --grep="Moe-Task: $2" > "$3" 2>/dev/null || : > "$3"
  }

  # A REAL long-lived child: a fabricated id would pass against a wrapper that
  # never probes at all, or that probes the wrong process table.
  sleep 600 &
  M2_LIVE_PID=$!
  LIVE_PIDS="$LIVE_PIDS $M2_LIVE_PID"
  M2_LIVE_START="$(live_marker_start "$M2_LIVE_PID")"
  M2_HOST="$(live_marker_host)"
  M2_SKIP_LINE="MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=task-resume pid=$M2_LIVE_PID host=$M2_HOST worker=worker-owner reason=live"

  # M2-a: the measured race, on the real claim shape -- a qa seat claiming a
  # task that is already at REVIEW while its worker's CLI is still running.
  SCOPE_M2A_DIR="$TMP_DIR/scope-m2a"
  make_m2_project "$SCOPE_M2A_DIR" task-resume REVIEW
  write_live_marker "$SCOPE_M2A_DIR" task-resume "$M2_LIVE_PID" "$M2_LIVE_START"
  set +e
  FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=REVIEW run_scope_wrapper "$SCOPE_M2A_DIR" "$TMP_DIR/scope-m2a.out" /bin/true qa qa-scope-m2
  scope_m2a_code=$?
  set -e
  [ "$scope_m2a_code" -eq 0 ] || scope_fail M2 "(a) wrapper exited with $scope_m2a_code" "$TMP_DIR/scope-m2a.out"
  if grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-resume' "$TMP_DIR/scope-m2a.out"; then
    scope_fail M2 "(a) the second seat recovered a LIVE owner's baseline" "$TMP_DIR/scope-m2a.out"
  fi
  if ! grep -Fq "$M2_SKIP_LINE" "$TMP_DIR/scope-m2a.out"; then
    scope_fail M2 "(a) expected the exact skip line [$M2_SKIP_LINE]" "$TMP_DIR/scope-m2a.out"
  fi
  m2a_skip_line="$(grep -Fn "$M2_SKIP_LINE" "$TMP_DIR/scope-m2a.out" | head -n1 | cut -d: -f1)"
  m2a_launch_line="$(grep -n 'Starting claude' "$TMP_DIR/scope-m2a.out" | head -n1 | cut -d: -f1)"
  if [ -n "$m2a_launch_line" ] && [ "$m2a_skip_line" -ge "$m2a_launch_line" ]; then
    scope_fail M2 "(a) the skip decision must be taken BEFORE the CLI launch" "$TMP_DIR/scope-m2a.out"
  fi
  # The pre-flight is the only producer of a `... recovered` subject, so its
  # absence IS the fix and its presence IS the defect.
  m2_subjects "$SCOPE_M2A_DIR" task-resume "$TMP_DIR/m2a-subjects.txt"
  if grep -q ' recovered$' "$TMP_DIR/m2a-subjects.txt"; then
    scope_fail M2 "(a) a '... recovered' checkpoint was landed while the owner was alive" "$TMP_DIR/scope-m2a.out"
  fi
  # The owner's claim must survive: a seat that stands down must not stamp its
  # own id over the marker, or the NEXT seat would see a dead owner and steal.
  [ -f "$SCOPE_M2A_DIR/.git/moe/baseline/task-resume.live" ] || scope_fail M2 "(a) the live owner's marker was deleted by the seat that stood down" "$TMP_DIR/scope-m2a.out"
  if ! grep -Fq "pid=$M2_LIVE_PID" "$SCOPE_M2A_DIR/.git/moe/baseline/task-resume.live"; then
    scope_fail M2 "(a) the live owner's marker was overwritten by the seat that stood down" "$TMP_DIR/scope-m2a.out"
  fi

  # M2-b: the same guard on the idle (BLOCKED-hold) path, where the pre-flight
  # is the ONLY git actor -- so the dirty bytes and the baseline are observable
  # directly after the run instead of inferred from commit subjects.
  SCOPE_M2B_DIR="$TMP_DIR/scope-m2b"
  make_m2_project "$SCOPE_M2B_DIR" task-blocked BLOCKED
  write_live_marker "$SCOPE_M2B_DIR" task-blocked "$M2_LIVE_PID" "$M2_LIVE_START"
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M2B_DIR" "$TMP_DIR/scope-m2b.out" /bin/true worker worker-scope-m2b
  scope_m2b_code=$?
  set -e
  [ "$scope_m2b_code" -eq 0 ] || scope_fail M2 "(b) wrapper exited with $scope_m2b_code" "$TMP_DIR/scope-m2b.out"
  if grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-m2b.out"; then
    scope_fail M2 "(b) the idle path recovered a LIVE owner's baseline" "$TMP_DIR/scope-m2b.out"
  fi
  if ! grep -Fq "MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=task-blocked pid=$M2_LIVE_PID host=$M2_HOST worker=worker-owner reason=live" "$TMP_DIR/scope-m2b.out"; then
    scope_fail M2 "(b) expected the named skip line on the idle path" "$TMP_DIR/scope-m2b.out"
  fi
  m2_subjects "$SCOPE_M2B_DIR" task-blocked "$TMP_DIR/m2b-subjects.txt"
  if [ -s "$TMP_DIR/m2b-subjects.txt" ]; then
    cat "$TMP_DIR/m2b-subjects.txt" >&2
    scope_fail M2 "(b) no commit at all may be landed for a live owner's task" "$TMP_DIR/scope-m2b.out"
  fi
  git -C "$SCOPE_M2B_DIR" status --porcelain > "$TMP_DIR/m2b-status.txt" 2>/dev/null || : > "$TMP_DIR/m2b-status.txt"
  if ! grep -q '^?? impl\.txt$' "$TMP_DIR/m2b-status.txt"; then
    cat "$TMP_DIR/m2b-status.txt" >&2
    scope_fail M2 "(b) impl.txt must still be present AND unstaged so the real owner can land it" "$TMP_DIR/scope-m2b.out"
  fi
  [ -f "$SCOPE_M2B_DIR/.git/moe/baseline/task-blocked.tsv" ] || scope_fail M2 "(b) the baseline must be left intact on a skip" "$TMP_DIR/scope-m2b.out"
  if ! grep -Fq ' landed=0' "$SCOPE_M2B_DIR/.git/moe/baseline/task-blocked.tsv"; then
    scope_fail M2 "(b) a skip must not mark the live owner's baseline landed" "$TMP_DIR/scope-m2b.out"
  fi

  # M2-c: THE BEHAVIOUR THAT MUST NOT MOVE. A genuine crash leaves a marker
  # whose process is gone; the 2026-08-28 lost-code path must recover it
  # exactly as before. Spawn and reap a real child so the id is definitively
  # dead rather than merely unlikely.
  sleep 600 &
  M2_DEAD_PID=$!
  M2_DEAD_START="$(live_marker_start "$M2_DEAD_PID")"
  kill "$M2_DEAD_PID" 2>/dev/null || true
  wait "$M2_DEAD_PID" 2>/dev/null || true
  SCOPE_M2C_DIR="$TMP_DIR/scope-m2c"
  make_m2_project "$SCOPE_M2C_DIR" task-blocked BLOCKED
  write_live_marker "$SCOPE_M2C_DIR" task-blocked "$M2_DEAD_PID" "$M2_DEAD_START"
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M2C_DIR" "$TMP_DIR/scope-m2c.out" /bin/true worker worker-scope-m2c
  scope_m2c_code=$?
  set -e
  [ "$scope_m2c_code" -eq 0 ] || scope_fail M2 "(c) wrapper exited with $scope_m2c_code" "$TMP_DIR/scope-m2c.out"
  if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-m2c.out"; then
    scope_fail M2 "(c) a crashed owner's baseline MUST still be recovered" "$TMP_DIR/scope-m2c.out"
  fi
  scope_m2c_sha="$(git -C "$SCOPE_M2C_DIR" log --format=%H --fixed-strings --grep='Moe-Task: task-blocked' | head -n1)"
  [ -n "$scope_m2c_sha" ] || scope_fail M2 "(c) the crash recovery landed no commit" "$TMP_DIR/scope-m2c.out"
  scope_m2c_files="$(git -C "$SCOPE_M2C_DIR" show --pretty=format: --name-only "$scope_m2c_sha" | sed '/^$/d' | sort | tr '\n' ' ')"
  if [ "$scope_m2c_files" != ".moe/tasks/task-blocked.json impl.txt " ]; then
    scope_fail M2 "(c) the crash recovery must carry EXACTLY the own record + impl.txt; got [$scope_m2c_files]" "$TMP_DIR/scope-m2c.out"
  fi
  if [ -f "$SCOPE_M2C_DIR/.git/moe/baseline/task-blocked.live" ]; then
    scope_fail M2 "(c) a stale marker must be deleted once its process is proven gone" "$TMP_DIR/scope-m2c.out"
  fi

  # M2-d: process-id REUSE. A live id whose recorded start token does not match
  # the process now holding it is a recycled id, not the owner -- it must
  # recover, or a long-lived box would suppress crash recovery by coincidence.
  if [ -z "$M2_LIVE_START" ]; then
    echo "[scenario M2] (d) SKIPPED: this platform exposes no process start token, so the probe is identity-only by design"
  else
    SCOPE_M2D_DIR="$TMP_DIR/scope-m2d"
    make_m2_project "$SCOPE_M2D_DIR" task-blocked BLOCKED
    write_live_marker "$SCOPE_M2D_DIR" task-blocked "$M2_LIVE_PID" "${M2_LIVE_START}999"
    set +e
    FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M2D_DIR" "$TMP_DIR/scope-m2d.out" /bin/true worker worker-scope-m2d
    scope_m2d_code=$?
    set -e
    [ "$scope_m2d_code" -eq 0 ] || scope_fail M2 "(d) wrapper exited with $scope_m2d_code" "$TMP_DIR/scope-m2d.out"
    if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-m2d.out"; then
      scope_fail M2 "(d) a recycled process id must NOT be mistaken for the owner" "$TMP_DIR/scope-m2d.out"
    fi
  fi

  # M2-e: BACK-COMPATIBILITY. Every task in flight when this change lands has a
  # baseline and no marker; those must keep recovering exactly as today.
  SCOPE_M2E_DIR="$TMP_DIR/scope-m2e"
  make_m2_project "$SCOPE_M2E_DIR" task-blocked BLOCKED
  if [ -e "$SCOPE_M2E_DIR/.git/moe/baseline/task-blocked.live" ]; then
    echo "fixture error: the no-marker case must have no marker" >&2
    exit 1
  fi
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M2E_DIR" "$TMP_DIR/scope-m2e.out" /bin/true worker worker-scope-m2e
  scope_m2e_code=$?
  set -e
  [ "$scope_m2e_code" -eq 0 ] || scope_fail M2 "(e) wrapper exited with $scope_m2e_code" "$TMP_DIR/scope-m2e.out"
  if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-m2e.out"; then
    scope_fail M2 "(e) a baseline with NO marker must recover exactly as before" "$TMP_DIR/scope-m2e.out"
  fi

  kill "$M2_LIVE_PID" 2>/dev/null || true
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario M2] ok"

  # Scenario M3 -- the baseline's landed flag belongs to the session whose
  # pre-flight took it. On 2026-09-17 (task-49ec8755) QA's exit landing, minutes
  # after a rework claim's pre-flight re-took the shared baseline, rewrote it to
  # landed=1; the rework session then died and the next pre-flight skipped its
  # recovery. A sibling's landing (committed, nothing to commit, or a deliberate
  # no-landing exit) must keep the other session's flag AND session. A session's
  # own landing still sets it, and so does a recovery, or an idle poll would
  # replay the recovery the previous poll landed.
  echo "[scenario M3] a sibling session's landing never marks another session's baseline landed"
  m3_project() { # $1 dir, [$2 settings JSON] -- task-resume planned (not asserted) on impl.txt
    local dir="$1"
    make_scope_project "$dir" '["ignored.txt"]' REVIEW '[]' "${2:-}"
    write_task_record "$dir" '[]' WORKING '[{"stepId":"s1","title":"rework","status":"IN_PROGRESS","affectedFiles":["impl.txt"]}]' task-resume
    git -C "$dir" add .moe/tasks/task-resume.json >/dev/null
    git -C "$dir" commit -qm record >/dev/null
  }
  m3_header() { # $1 dir, $2 taskId, $3 out file -- the baseline's header line
    head -n1 "$1/.git/moe/baseline/$2.tsv" > "$3" 2>/dev/null || : > "$3"
  }
  # SIBLING_CLI plays session A's pre-flight while B's CLI is still running: it
  # re-takes ONLY the header under A's session (every B/U row byte-identical)
  # and leaves B's LIVE marker alone, as a real pre-flight does -- the
  # QA-reject-then-rework shape. SIBLING_TOUCH_RECORD=1 also rewrites the task
  # record the way qa_reject does, so B's checkpoint has a board path to land.
  SIBLING_CLI="$TMP_DIR/sibling-cli"
  cat > "$SIBLING_CLI" <<'EOF'
#!/usr/bin/env bash
bl="$MOE_PROJECT_PATH/.git/moe/baseline/task-resume.tsv"
if [ ! -f "$bl" ]; then
  echo "sibling-cli fixture fault: no baseline at $bl" >&2
  exit 3
fi
head -n1 "$bl" > "$SIBLING_HEADER_OUT"
h="$(sed -n '1s/.* head=\([^ ]*\).*/\1/p' "$bl")"
{
  printf '#moe-baseline v1 task=task-resume at=2026-09-17T17:41:53Z head=%s landed=0 session=worker-a@2026-09-17T17:41:53Z\n' "$h"
  tail -n +2 "$bl"
} > "$bl.sibling" && mv -f "$bl.sibling" "$bl"
if [ "${SIBLING_TOUCH_RECORD:-0}" = "1" ]; then
  node -e 'const fs=require("fs"),f=process.argv[1],t=JSON.parse(fs.readFileSync(f,"utf8"));t.reopenCount=1;fs.writeFileSync(f,JSON.stringify(t)+"\n");' \
    "$MOE_PROJECT_PATH/.moe/tasks/task-resume.json"
fi
exit 0
EOF
  chmod +x "$SIBLING_CLI"

  # M3-a: the measured trigger. B (a qa exit) lands a checkpoint under the
  # baseline A's pre-flight re-took; A edits a planned path AFTER B's landing
  # (before it, B's checkpoint would have committed the edit), then A dies
  # without landing. The next pre-flight (C) must recover A's edit.
  SCOPE_M3A_DIR="$TMP_DIR/scope-m3a"
  m3_project "$SCOPE_M3A_DIR"
  set +e
  FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING SIBLING_TOUCH_RECORD=1 SIBLING_HEADER_OUT="$TMP_DIR/m3a-b-preflight.txt" \
    run_scope_wrapper "$SCOPE_M3A_DIR" "$TMP_DIR/scope-m3a-b.out" "$SIBLING_CLI" qa qa-scope-m3a
  scope_m3a_code=$?
  set -e
  [ "$scope_m3a_code" -eq 0 ] || scope_fail M3 "(a) B's wrapper exited with $scope_m3a_code" "$TMP_DIR/scope-m3a-b.out"
  m2_subjects "$SCOPE_M3A_DIR" task-resume "$TMP_DIR/m3a-b-subjects.txt"
  if [ "$(wc -l < "$TMP_DIR/m3a-b-subjects.txt" | tr -d '[:space:]')" != "1" ]; then
    cat "$TMP_DIR/m3a-b-subjects.txt" >&2
    scope_fail M3 "(a) B must land exactly one task-resume checkpoint" "$TMP_DIR/scope-m3a-b.out"
  fi
  case "$(cat "$TMP_DIR/m3a-b-subjects.txt")" in
    "wip(task-resume): "*"[status=WORKING role=qa cli-exit=0]") : ;;
    *) scope_fail M3 "(a) B's landing must be a role=qa checkpoint, not a recovery; got [$(cat "$TMP_DIR/m3a-b-subjects.txt")]" "$TMP_DIR/scope-m3a-b.out" ;;
  esac
  m3_header "$SCOPE_M3A_DIR" task-resume "$TMP_DIR/m3a-after-b.txt"
  # C is a new claim: the fixture attempt B's claim opened is not C's.
  rm -rf "$SCOPE_M3A_DIR/.moe/attempts"
  echo rework > "$SCOPE_M3A_DIR/impl.txt"
  set +e
  FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING run_scope_wrapper "$SCOPE_M3A_DIR" "$TMP_DIR/scope-m3a-c.out" /bin/true worker worker-scope-m3c
  scope_m3a_code=$?
  set -e
  [ "$scope_m3a_code" -eq 0 ] || scope_fail M3 "(a) C's wrapper exited with $scope_m3a_code" "$TMP_DIR/scope-m3a-c.out"
  if ! grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-resume' "$TMP_DIR/scope-m3a-c.out"; then
    scope_fail M3 "(a) a sibling's landing marked session A's baseline landed, so the next pre-flight never recovered A's edit" "$TMP_DIR/scope-m3a-c.out"
  fi
  git -C "$SCOPE_M3A_DIR" log --format='%H %s' --fixed-strings --grep='Moe-Task: task-resume' > "$TMP_DIR/m3a-log.txt" 2>/dev/null || : > "$TMP_DIR/m3a-log.txt"
  scope_m3a_sha="$(awk '/ recovered$/ { print $1; exit }' "$TMP_DIR/m3a-log.txt")"
  [ -n "$scope_m3a_sha" ] || scope_fail M3 "(a) no '... recovered' checkpoint was landed for A's edit" "$TMP_DIR/scope-m3a-c.out"
  scope_m3a_files="$(git -C "$SCOPE_M3A_DIR" show --pretty=format: --name-only "$scope_m3a_sha" | sed '/^$/d' | sort | tr '\n' ' ')"
  if [ "$scope_m3a_files" != "impl.txt " ]; then
    scope_fail M3 "(a) the recovered checkpoint must carry EXACTLY A's edit impl.txt; got [$scope_m3a_files]" "$TMP_DIR/scope-m3a-c.out"
  fi
  if ! grep -Fq ' landed=0 session=worker-a@2026-09-17T17:41:53Z' "$TMP_DIR/m3a-after-b.txt"; then
    cat "$TMP_DIR/m3a-after-b.txt" >&2
    scope_fail M3 "(a) B's landing must keep session A's landed=0 AND A's session" "$TMP_DIR/scope-m3a-b.out"
  fi
  if ! grep -Eq '^#moe-baseline v1 task=task-resume at=[^ ]+ head=[0-9a-f]* landed=0 session=qa-scope-m3a@[^ ]+$' "$TMP_DIR/m3a-b-preflight.txt"; then
    cat "$TMP_DIR/m3a-b-preflight.txt" >&2
    scope_fail M3 "(a) B's pre-flight must write landed=0 and its own session into the header" "$TMP_DIR/scope-m3a-b.out"
  fi
  m3_header "$SCOPE_M3A_DIR" task-resume "$TMP_DIR/m3a-after-c.txt"
  if ! grep -Eq '^#moe-baseline v1 task=task-resume at=[^ ]+ head=[0-9a-f]* landed=1 session=worker-scope-m3c@[^ ]+$' "$TMP_DIR/m3a-after-c.txt"; then
    cat "$TMP_DIR/m3a-after-c.txt" >&2
    scope_fail M3 "(a) a session's own landing must still mark its own baseline landed" "$TMP_DIR/scope-m3a-c.out"
  fi

  # M3-b: B's landing has nothing to commit.
  SCOPE_M3B_DIR="$TMP_DIR/scope-m3b"
  m3_project "$SCOPE_M3B_DIR"
  set +e
  FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING SIBLING_HEADER_OUT="$TMP_DIR/m3b-b-preflight.txt" \
    run_scope_wrapper "$SCOPE_M3B_DIR" "$TMP_DIR/scope-m3b.out" "$SIBLING_CLI" qa qa-scope-m3b
  scope_m3b_code=$?
  set -e
  [ "$scope_m3b_code" -eq 0 ] || scope_fail M3 "(b) wrapper exited with $scope_m3b_code" "$TMP_DIR/scope-m3b.out"
  grep -Fq 'MOE_COMMIT_NOTHING_TO_COMMIT' "$TMP_DIR/scope-m3b.out" \
    || scope_fail M3 "(b) B's landing must be nothing-to-commit" "$TMP_DIR/scope-m3b.out"
  m2_subjects "$SCOPE_M3B_DIR" task-resume "$TMP_DIR/m3b-subjects.txt"
  if [ -s "$TMP_DIR/m3b-subjects.txt" ]; then
    cat "$TMP_DIR/m3b-subjects.txt" >&2
    scope_fail M3 "(b) a nothing-to-commit landing must land no commit" "$TMP_DIR/scope-m3b.out"
  fi
  m3_header "$SCOPE_M3B_DIR" task-resume "$TMP_DIR/m3b-after-b.txt"
  if ! grep -Fq ' landed=0 session=worker-a@2026-09-17T17:41:53Z' "$TMP_DIR/m3b-after-b.txt"; then
    cat "$TMP_DIR/m3b-after-b.txt" >&2
    scope_fail M3 "(b) a sibling's nothing-to-commit landing marked another session's baseline landed" "$TMP_DIR/scope-m3b.out"
  fi

  # M3-c: B's exit is a deliberate no-landing (checkpointCommits=false).
  SCOPE_M3C_DIR="$TMP_DIR/scope-m3c"
  m3_project "$SCOPE_M3C_DIR" '{"checkpointCommits":false}'
  set +e
  FAKE_CLAIM_MODE=resume FAKE_TASK_STATUS=WORKING SIBLING_HEADER_OUT="$TMP_DIR/m3c-b-preflight.txt" \
    run_scope_wrapper "$SCOPE_M3C_DIR" "$TMP_DIR/scope-m3c.out" "$SIBLING_CLI" qa qa-scope-m3c
  scope_m3c_code=$?
  set -e
  [ "$scope_m3c_code" -eq 0 ] || scope_fail M3 "(c) wrapper exited with $scope_m3c_code" "$TMP_DIR/scope-m3c.out"
  grep -Fq 'no landing for task task-resume' "$TMP_DIR/scope-m3c.out" \
    || scope_fail M3 "(c) B's exit must be the deliberate no-landing branch" "$TMP_DIR/scope-m3c.out"
  m3_header "$SCOPE_M3C_DIR" task-resume "$TMP_DIR/m3c-after-b.txt"
  if ! grep -Fq ' landed=0 session=worker-a@2026-09-17T17:41:53Z' "$TMP_DIR/m3c-after-b.txt"; then
    cat "$TMP_DIR/m3c-after-b.txt" >&2
    scope_fail M3 "(c) a sibling's deliberate no-landing exit marked another session's baseline landed" "$TMP_DIR/scope-m3c.out"
  fi

  # M3-d: the recovery exception. The idle paths recover under a fresh session
  # id on every poll, so a recovery must set the flag itself (keeping the dead
  # session's header session), or every later poll replays it.
  SCOPE_M3D_DIR="$TMP_DIR/scope-m3d"
  make_m2_project "$SCOPE_M3D_DIR" task-blocked BLOCKED
  m3d_bl="$SCOPE_M3D_DIR/.git/moe/baseline/task-blocked.tsv"
  { printf '%s session=worker-dead@2026-09-17T18:59:00Z\n' "$(head -n1 "$m3d_bl")"; tail -n +2 "$m3d_bl"; } > "$m3d_bl.new"
  mv -f "$m3d_bl.new" "$m3d_bl"
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M3D_DIR" "$TMP_DIR/scope-m3d-1.out" /bin/true worker worker-scope-m3d
  scope_m3d_code=$?
  set -e
  [ "$scope_m3d_code" -eq 0 ] || scope_fail M3 "(d) run 1 exited with $scope_m3d_code" "$TMP_DIR/scope-m3d-1.out"
  grep -Fq 'MOE_CHECKPOINT_RECOVERED task=task-blocked' "$TMP_DIR/scope-m3d-1.out" \
    || scope_fail M3 "(d) run 1 must recover the dead session's baseline" "$TMP_DIR/scope-m3d-1.out"
  m3_header "$SCOPE_M3D_DIR" task-blocked "$TMP_DIR/m3d-after-1.txt"
  echo again > "$SCOPE_M3D_DIR/impl.txt"
  set +e
  FAKE_CLAIM_MODE=blocked run_scope_wrapper "$SCOPE_M3D_DIR" "$TMP_DIR/scope-m3d-2.out" /bin/true worker worker-scope-m3d
  scope_m3d_code=$?
  set -e
  [ "$scope_m3d_code" -eq 0 ] || scope_fail M3 "(d) run 2 exited with $scope_m3d_code" "$TMP_DIR/scope-m3d-2.out"
  m2_subjects "$SCOPE_M3D_DIR" task-blocked "$TMP_DIR/m3d-subjects.txt"
  git -C "$SCOPE_M3D_DIR" status --porcelain > "$TMP_DIR/m3d-status.txt" 2>/dev/null || : > "$TMP_DIR/m3d-status.txt"
  if grep -Fq 'MOE_CHECKPOINT_RECOVERED' "$TMP_DIR/scope-m3d-2.out" \
    || [ "$(wc -l < "$TMP_DIR/m3d-subjects.txt" | tr -d '[:space:]')" != "1" ] \
    || ! grep -q '^ M impl\.txt$' "$TMP_DIR/m3d-status.txt"; then
    cat "$TMP_DIR/m3d-subjects.txt" "$TMP_DIR/m3d-status.txt" >&2
    scope_fail M3 "(d) an idle poll replayed the recovery the previous poll already landed" "$TMP_DIR/scope-m3d-2.out"
  fi
  if ! grep -Fq ' landed=1 session=worker-dead@2026-09-17T18:59:00Z' "$TMP_DIR/m3d-after-1.txt"; then
    cat "$TMP_DIR/m3d-after-1.txt" >&2
    scope_fail M3 "(d) a recovery must set landed=1 and keep the dead session's header session" "$TMP_DIR/scope-m3d-1.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario M3] ok"

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

  # Scenario P2 -- only current launch-failure BOARD-only checkpoints defer.
  P2_CHECK="$TMP_DIR/p2-check.cjs"
  cat > "$P2_CHECK" <<'P2JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [action, dir, mode, logFile, round = '1'] = process.argv.slice(2);
const board = '.moe/tasks/task-postflight.json';
const stateFile = path.join(dir, '.git/p2-state.json');
const skipCode = 'MOE_CHECKPOINT_SKIPPED_LAUNCH_FAILURE_BOARD_ONLY';
const read = p => fs.readFileSync(p, 'utf8');
const bytes = p => fs.readFileSync(path.join(dir, p)).toString('base64');
function git(...args) {
  return cp.execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();
}
function rows(file) {
  return fs.existsSync(file) ? read(file).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}
function prepare() {
  git('config', 'core.autocrlf', 'false');
  for (const p of [board, 'seed.txt']) fs.writeFileSync(path.join(dir, p), read(path.join(dir, p)).replace(/\r\n/g, '\n'));
  git('add', board, 'seed.txt');
  git('checkout', '-B', 'main');
  fs.writeFileSync(path.join(dir, 'owned-a.txt'), 'owned-base\n');
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'peer-base\n');
  git('add', 'owned-a.txt', 'peer-plan.txt');
  git('commit', '-qm', 'P2 fixture');
  const remote = dir + '-remote.git';
  cp.execFileSync('git', ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  const before = {head: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', 'HEAD'),
    remote, refs: cp.execFileSync('git', ['--git-dir', remote, 'show-ref'], {encoding: 'utf8'})};
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'foreign-index\n');
  git('add', 'peer-plan.txt');
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'foreign-worktree\n');
  if (mode !== 'empty') fs.appendFileSync(path.join(dir, board), '\n \n');
  if (mode === 'owned') own();
  if (mode === 'deleted') fs.unlinkSync(path.join(dir, 'owned-a.txt'));
  Object.assign(before, {board: bytes(board), foreign: bytes('peer-plan.txt'),
    index: git('rev-parse', ':peer-plan.txt')});
  fs.writeFileSync(stateFile, JSON.stringify(before));
}
function own() { fs.writeFileSync(path.join(dir, 'owned-a.txt'), 'real-owned-change\n'); }
function assertCommon(before, ledger, log) {
  assert.equal(bytes('peer-plan.txt'), before.foreign, 'foreign worktree bytes');
  assert.equal(git('rev-parse', ':peer-plan.txt'), before.index, 'foreign staged bytes');
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/moe/rescue/'), '', 'no rescue refs');
  assert.equal(ledger.filter(r => r.kind === 'rescue' || r.outcome === 'failed').length, 0, 'no rescue/failure ledger');
  assert.doesNotMatch(log, /MOE_CHECKPOINT_RECOVERED/, 'no recovery backdoor');
  assert.equal(fs.existsSync(path.join(dir, '.git/moe/baseline/task-postflight.live')), false, 'live marker removed');
  const rpc = rows(path.join(dir, '.moe/evidence-rpcs.jsonl'));
  assert.match(read(path.join(dir, '.moe/messages/chan-general.jsonl')), /session ended:/, 'postflight summary sent');
  assert.equal(rpc.some(r => r.tool === 'finalize_attempt'), mode === 'completion', 'only worker completion finalizes');
  return rpc;
}
function assertSkip(before, ledger, log, rpc) {
  // Keep the behavioral assertion FIRST: old wrappers must actually commit.
  assert.equal(git('rev-parse', 'HEAD'), before.head, 'P2 BOARD-only failure must leave HEAD unchanged');
  assert.equal(git('symbolic-ref', 'HEAD'), before.branch, 'skip must not peel branch');
  assert.equal(cp.execFileSync('git', ['--git-dir', before.remote, 'show-ref'], {encoding: 'utf8'}), before.refs);
  assert.equal(ledger.filter(r => r.outcome === 'committed').length, 0, 'zero checkpoints/rescues');
  assert.doesNotMatch(read(logFile + '.trace'), /built-in: git .*push(?: |$)/m, 'no push attempt');
  assert.equal(bytes(board), before.board, 'deferred BOARD bytes unchanged');
  if (mode !== 'empty') assert.ok(git('diff', '--name-only', 'HEAD', '--', board), 'BOARD still dirty');
  const expectedCode = mode === 'empty' ? 'MOE_COMMIT_NOTHING_TO_COMMIT' : skipCode;
  const last = ledger.at(-1);
  assert.equal(ledger.length, Number(round), 'exactly one nothing record per invocation');
  assert.equal(last.outcome, 'nothing');
  assert.equal(last.kind, 'checkpoint');
  assert.equal(last.code, expectedCode);
  assert.equal(last.cliExitCode, 1);
  assert.equal(last.sha || '', '');
  assert.equal(last.ref || '', '');
  assert.equal((last.paths || []).length, 0);
  assert.notEqual(last.pushed, true);
  assert.ok(log.includes(expectedCode), 'named code in log');
  if (mode !== 'empty') assert.match(log, /\[skip\]/);
  const messages = read(path.join(dir, '.moe/messages/chan-general.jsonl'));
  assert.ok(messages.includes('outcome=nothing code=' + expectedCode), 'session summary code');
  assert.equal(rpc.filter(r => ['record_candidate', 'record_check_run', 'record_delivery_receipt'].includes(r.tool)).length, 0);
  assert.equal(rpc.filter(r => r.tool === 'finalize_attempt').length, 0, 'QA does not finalize worker attempts');
  const baseline = read(path.join(dir, '.git/moe/baseline/task-postflight.tsv'));
  assert.match(baseline.split('\n')[0], / landed=1 .*session=qa-p2@/);
  if (mode !== 'empty') assert.ok(baseline.includes(board), 'deferred BOARD baseline retained');
}
function assertLanded(before, ledger, log) {
  assert.equal(git('rev-list', '--count', before.head + '..HEAD'), '1', 'exactly one real landing');
  const commits = ledger.filter(r => r.outcome === 'committed');
  assert.equal(commits.length, 1);
  const last = commits[0], completion = mode === 'completion';
  assert.equal(last.kind, completion ? 'completion' : 'checkpoint');
  assert.equal(last.cliExitCode, ['zero', 'later'].includes(mode) ? 0 : 1);
  assert.equal(last.pushed, true);
  assert.equal(last.sha, git('rev-parse', 'HEAD'));
  assert.equal(cp.execFileSync('git', ['--git-dir', before.remote, 'rev-parse', git('symbolic-ref', 'HEAD')], {encoding: 'utf8'}).trim(), last.sha);
  assert.match(read(logFile + '.trace'), /built-in: git .*push(?: |$)/m, 'successful push attempted');
  const want = ['owned', 'deleted', 'later'].includes(mode) ? [board, 'owned-a.txt'] : [board];
  assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), want);
  assert.deepEqual([...last.paths].sort(), want);
  assert.equal(cp.execFileSync('git', ['-C', dir, 'show', 'HEAD:' + board]).toString('base64'), before.board);
  if (['owned', 'later'].includes(mode)) assert.equal(git('show', 'HEAD:owned-a.txt'), 'real-owned-change');
  if (mode === 'deleted') assert.equal(git('ls-tree', 'HEAD', 'owned-a.txt'), '');
  if (!completion) assert.match(git('log', '-1', '--format=%s'), /^wip\(task-postflight\):/);
  assert.doesNotMatch(log, new RegExp(skipCode), 'non-skipped control');
  if (mode === 'later') assert.equal(ledger.filter(r => r.code === skipCode).length, 2, 'two deferred retries');
}
if (action === 'prepare') prepare();
else if (action === 'own') own();
else if (action === 'begin') fs.rmSync(path.join(dir, '.moe/attempts/attempt-postflight.json'), {force: true});
else {
  const before = JSON.parse(read(stateFile));
  const ledger = rows(path.join(dir, '.moe/record_commit.jsonl'));
  const log = read(logFile);
  // Old-code RED proof must name HEAD movement, not a missing marker.
  if (['board', 'retry', 'empty'].includes(mode))
    assert.equal(git('rev-parse', 'HEAD'), before.head, 'P2 BOARD-only failure must leave HEAD unchanged');
  const rpc = assertCommon(before, ledger, log);
  if (['board', 'retry', 'empty'].includes(mode)) assertSkip(before, ledger, log, rpc);
  else assertLanded(before, ledger, log);
  console.log('[scenario P2-' + mode + '-' + round + '] ok');
}
P2JS
  # Subshell restores every fixture override even on an assertion failure.
  (
    for p2_mode in board owned retry zero outside completion empty deleted; do
      p2_dir="$TMP_DIR/scope-p2-$p2_mode"
      make_scope_project "$p2_dir" '["owned-a.txt"]' REVIEW '[]' '{"checkpointPush":true}'
      write_peer_task_record "$p2_dir"
      "$NODE_FOR_TEST" "$P2_CHECK" prepare "$p2_dir" "$p2_mode"
      p2_cli=/bin/false; p2_role=qa; p2_limit=120
      [ "$p2_mode" != zero ] || p2_cli=/bin/true
      [ "$p2_mode" != outside ] || p2_limit=0
      [ "$p2_mode" != completion ] || p2_role=worker
      p2_rounds=1; [ "$p2_mode" != retry ] || p2_rounds=2
      for ((p2_round=1; p2_round<=p2_rounds; p2_round++)); do
        p2_out="$TMP_DIR/p2-$p2_mode-$p2_round.out"
        "$NODE_FOR_TEST" "$P2_CHECK" begin "$p2_dir"
        MOE_LAUNCH_FAIL_SEC="$p2_limit" GIT_TRACE="$p2_out.trace" FAKE_TASK_STATUS=REVIEW FAKE_ATTEMPT_PHASE=finalizing \
          run_scope_wrapper "$p2_dir" "$p2_out" "$p2_cli" "$p2_role" "$p2_role-p2" \
          || scope_fail P2 "wrapper failed" "$p2_out"
        "$NODE_FOR_TEST" "$P2_CHECK" verify "$p2_dir" "$p2_mode" "$p2_out" "$p2_round" \
          || scope_fail P2 "behavior assertion ($p2_mode)" "$p2_out"
      done
      if [ "$p2_mode" = retry ]; then
        "$NODE_FOR_TEST" "$P2_CHECK" own "$p2_dir"
        p2_out="$TMP_DIR/p2-later.out"
        "$NODE_FOR_TEST" "$P2_CHECK" begin "$p2_dir"
        MOE_LAUNCH_FAIL_SEC=120 GIT_TRACE="$p2_out.trace" FAKE_TASK_STATUS=REVIEW FAKE_ATTEMPT_PHASE=finalizing \
          run_scope_wrapper "$p2_dir" "$p2_out" /bin/true qa qa-p2
        "$NODE_FOR_TEST" "$P2_CHECK" verify "$p2_dir" later "$p2_out"
      fi
    done
  )
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario P2] ok (10 invocations)"


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
  # Operator env that would change the TOML the needles below assert
  # (documented MOE_GROK_* knobs, WSL MOE_DAEMON_HOST) is scrubbed for the
  # run; GROK_HOME too, because the wrapper writes grok's trust store under
  # it and the harness must never touch the operator's real store.
  (
    unset MOE_GROK_MODEL MOE_GROK_EFFORT MOE_GROK_MCP_STARTUP_TIMEOUT_SEC MOE_GROK_MCP_TOOL_TIMEOUT_SEC MOE_DAEMON_HOST GROK_HOME
    MOE_SERENA_PATH="$FAKE_SERENA" FAKE_GROK_EXIT=7 FAKE_TASK_STATUS=REVIEW \
      run_scope_wrapper "$SCOPE_Y_DIR" "$TMP_DIR/scope-y.out" "$GROK_CLI" worker worker-scope-y --grok-exec
  )
  scope_y_code=$?
  set -e
  [ "$scope_y_code" -eq 0 ] || scope_fail Y "wrapper exited with $scope_y_code" "$TMP_DIR/scope-y.out"
  # -- config writer --
  [ -f "$SCOPE_Y_CFG" ] || scope_fail Y "expected .grok/config.toml to be written at pre-flight" "$TMP_DIR/scope-y.out"
  if ! grep -Fq 'Grok MCP config written to:' "$TMP_DIR/scope-y.out"; then
    scope_fail Y "expected the 'Grok MCP config written to:' banner" "$TMP_DIR/scope-y.out"
  fi
  # -- folder trust (HOME is the harness home, so this is the harness store) --
  SCOPE_Y_TRUST="$HOME_DIR/.grok/trusted_folders.toml"
  [ -f "$SCOPE_Y_TRUST" ] || scope_fail Y "expected grok trust store $SCOPE_Y_TRUST to be written at pre-flight" "$TMP_DIR/scope-y.out"
  if ! grep -Fq 'Grok folder trust granted:' "$TMP_DIR/scope-y.out"; then
    scope_fail Y "expected the 'Grok folder trust granted:' banner" "$TMP_DIR/scope-y.out"
  fi
  if [ "$(grep -c "^\[folders\.'" "$SCOPE_Y_TRUST")" -ne 1 ] || ! grep -Fq 'trusted = true' "$SCOPE_Y_TRUST"; then
    scope_fail Y "expected exactly one trusted [folders.'…'] table in $SCOPE_Y_TRUST" "$SCOPE_Y_TRUST"
  fi
  for needle in '[mcp_servers.moe]' '[mcp_servers.moe.env]' 'startup_timeout_sec = 120' 'tool_timeout_sec = 120' 'moe_wait_for_task = 720' 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"' 'MOE_TOOL_NAME_STYLE = "underscore"' '[mcp_servers.serena]' '"--context", "agent"'; do
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

  # Scenario Z -- the codex CLI headless launch. A fake CLI literally named
  # `codex` (detection keys on the command basename) records its argv.
  # codex-cli 0.147+ rejects `--full-auto` (`error: unexpected argument
  # '--full-auto' found`, exit 2 before any work -- which the launch-failure
  # backoff then relaunches forever); `codex exec` already runs with
  # approval_policy=never, so the wrapper passes only
  # `--sandbox <MOE_CODEX_SANDBOX|danger-full-access>`. Pins: --codex-exec launches
  # headless `exec -C <project>` with the seat's MOE_WORKER_ID override and
  # never --full-auto; a worker or architect without the flag gets the TUI; --sandbox follows the exec subcommand; MOE_CODEX_SANDBOX
  # reaches argv verbatim; `inherit` drops the flag; an unknown value warns and
  # falls back; a fast non-zero exit propagates and prints the argv hint; the
  # project .codex/config.toml carries the moe table + top-level codex keys and
  # never lands (DENY tier); an architect gets the TUI (no exec).
  echo "[scenario Z] codex CLI: headless exec argv without --full-auto, MOE_CODEX_SANDBOX, exit propagation, DENY tier, polarity"
  CODEX_CLI="$TMP_DIR/codex"
  CODEX_ARGS_FILE="$TMP_DIR/codex-args.txt"
  # Appends (the wrapper may invoke codex more than once per launch: the argv
  # probe, then --version, then the real launch); each run rm -f's the file.
  # FAKE_CODEX_REJECT_ARGV=1 makes every invocation fail the way clap does for
  # a flag the installed CLI no longer accepts.
  cat > "$CODEX_CLI" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$CODEX_ARGS_FILE"
if [ "\${FAKE_CODEX_REJECT_ARGV:-}" = "1" ]; then
  echo "error: unexpected argument '--sandbox' found" >&2
  exit 2
fi
exit "\${FAKE_CODEX_EXIT:-0}"
EOF
  chmod +x "$CODEX_CLI"
  SCOPE_Z_DIR="$TMP_DIR/scope-z"
  make_scope_project "$SCOPE_Z_DIR" '["owned-a.txt"]'
  echo owned-a > "$SCOPE_Z_DIR/owned-a.txt"
  SCOPE_Z_CFG="$SCOPE_Z_DIR/.codex/config.toml"
  rm -f "$CODEX_ARGS_FILE"
  set +e
  # Operator env that would change the argv/TOML the needles below assert is
  # scrubbed for the run.
  (
    unset MOE_CODEX_SANDBOX MOE_CODEX_REASONING_EFFORT MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC MOE_DAEMON_HOST
    MOE_SERENA_PATH="$FAKE_SERENA" FAKE_CODEX_EXIT=5 FAKE_TASK_STATUS=WORKING \
      run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  )
  scope_z_code=$?
  set -e
  [ "$scope_z_code" -eq 0 ] || scope_fail Z "wrapper exited with $scope_z_code" "$TMP_DIR/scope-z.out"
  # -- headless argv --
  [ -f "$CODEX_ARGS_FILE" ] || scope_fail Z "the fake codex CLI was never launched" "$TMP_DIR/scope-z.out"
  if grep -Fqx -- '--full-auto' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "codex 0.147+ rejects --full-auto; it must never be on argv" "$TMP_DIR/scope-z.out"
  fi
  for flag in 'exec' '-C' '--sandbox' 'danger-full-access' '-c' 'mcp_servers.moe.env.MOE_WORKER_ID=worker-scope-z' 'approvals_reviewer=user'; do
    if ! grep -Fqx -- "$flag" "$CODEX_ARGS_FILE"; then
      cat "$CODEX_ARGS_FILE" >&2 || true
      scope_fail Z "expected [$flag] on the headless codex argv" "$TMP_DIR/scope-z.out"
    fi
  done
  # --sandbox is an `exec` option: it must follow the subcommand on argv (a
  # top-level --sandbox before `exec` parses differently).
  scope_z_exec_ln="$(grep -Fnx -- 'exec' "$CODEX_ARGS_FILE" | head -n1 | cut -d: -f1)"
  scope_z_sandbox_ln="$(grep -Fnx -- '--sandbox' "$CODEX_ARGS_FILE" | head -n1 | cut -d: -f1)"
  if [ -z "$scope_z_exec_ln" ] || [ -z "$scope_z_sandbox_ln" ] || [ "$scope_z_sandbox_ln" -le "$scope_z_exec_ln" ]; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "--sandbox must follow the exec subcommand on argv" "$TMP_DIR/scope-z.out"
  fi
  # The banner is what the launch-failure hint tells the operator to re-run by
  # hand, so it must carry the seat override and the reviewer pin too.
  if ! grep -Fq 'Command: ' "$TMP_DIR/scope-z.out" || ! grep -Fq -- '--sandbox danger-full-access' "$TMP_DIR/scope-z.out" \
     || ! grep -Fq -- '-c mcp_servers.moe.env.MOE_WORKER_ID=worker-scope-z' "$TMP_DIR/scope-z.out" || ! grep -Fq -- '-c approvals_reviewer=user exec --json -C' "$TMP_DIR/scope-z.out"; then
    scope_fail Z "expected the Command banner to show the seat override, the reviewer pin and --sandbox danger-full-access" "$TMP_DIR/scope-z.out"
  fi
  if ! grep -Fq 'run the printed Command by hand' "$TMP_DIR/scope-z.out"; then
    scope_fail Z "a fast non-zero exit must print the launch-failure argv hint" "$TMP_DIR/scope-z.out"
  fi
  # -- config writer --
  [ -f "$SCOPE_Z_CFG" ] || scope_fail Z "expected .codex/config.toml to be written at pre-flight" "$TMP_DIR/scope-z.out"
  for needle in '[mcp_servers.moe]' '[mcp_servers.moe.env]' 'startup_timeout_sec = 120' 'model_instructions_file = "agent-instructions.md"' 'model_reasoning_effort = "xhigh"' 'default_tools_approval_mode = "approve"'; do
    if ! grep -Fq -- "$needle" "$SCOPE_Z_CFG"; then
      cat "$SCOPE_Z_CFG" >&2 || true
      scope_fail Z "expected [$needle] in .codex/config.toml" "$TMP_DIR/scope-z.out"
    fi
  done
  # codex 0.148+ rejects un-annotated MCP tools under approval never + a sandbox;
  # the pre-approval must be pinned on BOTH servers (moe and serena).
  if [ "$(grep -Fc -- 'default_tools_approval_mode = "approve"' "$SCOPE_Z_CFG")" -ne 2 ]; then
    cat "$SCOPE_Z_CFG" >&2 || true
    scope_fail Z "default_tools_approval_mode = \"approve\" must be pinned on both the moe and serena servers in .codex/config.toml" "$TMP_DIR/scope-z.out"
  fi
  [ -f "$SCOPE_Z_DIR/.codex/agent-instructions.md" ] || scope_fail Z "expected .codex/agent-instructions.md to be written" "$TMP_DIR/scope-z.out"
  # -- exit propagation + DENY tier --
  if ! grep -Fq 'worker session ended: task=task-postflight (CLI exit=5)' "$SCOPE_Z_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$SCOPE_Z_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    scope_fail Z "a non-zero codex exit must propagate into the session-ended line (CLI exit=5)" "$TMP_DIR/scope-z.out"
  fi
  # Pin the checkpoint itself first (ps1 twin parity): without it a landing that
  # silently produced nothing would leave HEAD at the seed commit and the DENY
  # check below would pass for the wrong reason.
  scope_z_subject="$(git -C "$SCOPE_Z_DIR" log -1 --pretty=%s)"
  if [ "$scope_z_subject" != "wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=5]" ]; then
    scope_fail Z "unexpected checkpoint subject [$scope_z_subject]" "$TMP_DIR/scope-z.out"
  fi
  scope_z_files="$(committed_paths "$SCOPE_Z_DIR")"
  if [ "$scope_z_files" != "owned-a.txt " ]; then
    scope_fail Z "the checkpoint must contain ONLY the owned path; got [$scope_z_files]" "$TMP_DIR/scope-z.out"
  fi
  if git -C "$SCOPE_Z_DIR" cat-file -e HEAD:.codex/config.toml 2>/dev/null; then
    scope_fail Z ".codex/config.toml reached HEAD -- it must be DENY-tier excluded" "$TMP_DIR/scope-z.out"
  fi
  # -- MOE_CODEX_SANDBOX reaches argv verbatim --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  MOE_CODEX_SANDBOX=workspace-write MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z2.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  scope_z2_code=$?
  set -e
  [ "$scope_z2_code" -eq 0 ] || scope_fail Z "second wrapper run exited with $scope_z2_code" "$TMP_DIR/scope-z2.out"
  if ! grep -Fqx -- 'workspace-write' "$CODEX_ARGS_FILE" || grep -Fqx -- 'danger-full-access' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "MOE_CODEX_SANDBOX=workspace-write must reach argv as --sandbox workspace-write" "$TMP_DIR/scope-z2.out"
  fi
  # -- inherit drops the flag --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  MOE_CODEX_SANDBOX=inherit MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z3.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  scope_z3_code=$?
  set -e
  [ "$scope_z3_code" -eq 0 ] || scope_fail Z "inherit wrapper run exited with $scope_z3_code" "$TMP_DIR/scope-z3.out"
  if grep -Fqx -- '--sandbox' "$CODEX_ARGS_FILE" || grep -Fqx -- '--full-auto' "$CODEX_ARGS_FILE" || ! grep -Fqx -- 'exec' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "MOE_CODEX_SANDBOX=inherit must launch exec with no --sandbox flag" "$TMP_DIR/scope-z3.out"
  fi
  # -- an unknown value warns and falls back --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  MOE_CODEX_SANDBOX=yolo MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z4.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  scope_z4_code=$?
  set -e
  [ "$scope_z4_code" -eq 0 ] || scope_fail Z "unknown-sandbox wrapper run exited with $scope_z4_code" "$TMP_DIR/scope-z4.out"
  if ! grep -Fq "MOE_CODEX_SANDBOX='yolo' is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access." "$TMP_DIR/scope-z4.out"; then
    scope_fail Z "an unknown MOE_CODEX_SANDBOX must warn and fall back" "$TMP_DIR/scope-z4.out"
  fi
  if ! grep -Fqx -- 'danger-full-access' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "the fallback sandbox must be danger-full-access" "$TMP_DIR/scope-z4.out"
  fi
  # -- polarity: an architect gets the TUI (no exec subcommand, no --sandbox) --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z5.out" "$CODEX_CLI" architect architect-scope-z
  scope_z5_code=$?
  set -e
  [ "$scope_z5_code" -eq 0 ] || scope_fail Z "architect wrapper run exited with $scope_z5_code" "$TMP_DIR/scope-z5.out"
  if grep -Fqx -- 'exec' "$CODEX_ARGS_FILE" || grep -Fqx -- '--sandbox' "$CODEX_ARGS_FILE" || grep -Fqx -- 'approvals_reviewer=user' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "an architect must default to the interactive codex TUI (no exec / --sandbox / reviewer pin)" "$TMP_DIR/scope-z5.out"
  fi
  if ! grep -Fqx -- '-C' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "the codex TUI launch must still carry -C <project>" "$TMP_DIR/scope-z5.out"
  fi
  # -- polarity: a worker without --codex-exec gets the TUI too (codex is
  # interactive for every role since 2026-09-07; headless is opt-in) --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z5b.out" "$CODEX_CLI" worker worker-scope-z
  scope_z5b_code=$?
  set -e
  [ "$scope_z5b_code" -eq 0 ] || scope_fail Z "worker TUI wrapper run exited with $scope_z5b_code" "$TMP_DIR/scope-z5b.out"
  if grep -Fqx -- 'exec' "$CODEX_ARGS_FILE" || grep -Fqx -- '--sandbox' "$CODEX_ARGS_FILE" || grep -Fqx -- 'approvals_reviewer=user' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "a worker without --codex-exec must get the interactive codex TUI (no exec / --sandbox / reviewer pin)" "$TMP_DIR/scope-z5b.out"
  fi
  # -- argv probe: a CLI that rejects the launch argv (the --full-auto class of
  # break) must stop the seat with MOE_CLI_ARGV_REJECTED + a #general
  # escalation and never launch the prompt, instead of relaunch-looping --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  FAKE_CODEX_REJECT_ARGV=1 MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z6.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  scope_z6_code=$?
  set -e
  [ "$scope_z6_code" -ne 0 ] || scope_fail Z "a rejected argv must make the wrapper exit non-zero (got 0)" "$TMP_DIR/scope-z6.out"
  if ! grep -Fq 'MOE_CLI_ARGV_REJECTED' "$TMP_DIR/scope-z6.out" || ! grep -Fq -- "unexpected argument '--sandbox' found" "$TMP_DIR/scope-z6.out"; then
    scope_fail Z "expected MOE_CLI_ARGV_REJECTED with the CLI's own error line" "$TMP_DIR/scope-z6.out"
  fi
  if grep -Fq '[launch-failure]' "$TMP_DIR/scope-z6.out"; then
    scope_fail Z "a rejected argv must not reach the launch-failure backoff" "$TMP_DIR/scope-z6.out"
  fi
  [ -f "$CODEX_ARGS_FILE" ] || scope_fail Z "the argv probe never ran" "$TMP_DIR/scope-z6.out"
  if ! grep -Fqx -- '--help' "$CODEX_ARGS_FILE" || grep -Fq 'Task task-postflight is claimed' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "the probe must run the real argv plus --help and the prompt must never be launched" "$TMP_DIR/scope-z6.out"
  fi
  if ! grep -Fq 'MOE_CLI_ARGV_REJECTED' "$SCOPE_Z_DIR/.moe/messages/chan-general.jsonl"; then
    cat "$SCOPE_Z_DIR/.moe/messages/chan-general.jsonl" >&2 || true
    scope_fail Z "a rejected argv must be escalated to #general" "$TMP_DIR/scope-z6.out"
  fi
  # -- MOE_DISABLE_ARGV_PROBE=1 skips the probe: the launch proceeds and the
  # rejection surfaces through the ordinary launch-failure path --
  rm -f "$CODEX_ARGS_FILE"
  set +e
  FAKE_CODEX_REJECT_ARGV=1 MOE_DISABLE_ARGV_PROBE=1 MOE_SERENA_PATH="$FAKE_SERENA" FAKE_TASK_STATUS=WORKING \
    run_scope_wrapper "$SCOPE_Z_DIR" "$TMP_DIR/scope-z7.out" "$CODEX_CLI" worker worker-scope-z --codex-exec
  scope_z7_code=$?
  set -e
  [ "$scope_z7_code" -eq 0 ] || scope_fail Z "with the probe disabled the wrapper run exited with $scope_z7_code" "$TMP_DIR/scope-z7.out"
  if grep -Fq 'MOE_CLI_ARGV_REJECTED' "$TMP_DIR/scope-z7.out" || ! grep -Fq '[launch-failure]' "$TMP_DIR/scope-z7.out"; then
    scope_fail Z "MOE_DISABLE_ARGV_PROBE=1 must skip the probe and fall through to the launch-failure path" "$TMP_DIR/scope-z7.out"
  fi
  if grep -Fqx -- '--help' "$CODEX_ARGS_FILE" || ! grep -Fq 'Task task-postflight is claimed' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z "with the probe disabled the real prompt must be launched and no --help probe issued" "$TMP_DIR/scope-z7.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario Z] ok"

  # Scenario Z2 -- the bash Codex launcher must mirror the PowerShell twin's
  # per-seat instructions file. The fake binary captures the model override
  # and copies the file while it is still alive; the wrapper must then remove
  # the file after both headless and interactive launches. TMPDIR is explicit
  # so this also proves the file is not written into the project or a shared
  # role-document path.
  echo "[scenario Z2] bash Codex CLI: per-seat instructions for headless and TUI"
  CODEX_CLI="$TMP_DIR/codex"
  CODEX_ARGS_FILE="$TMP_DIR/codex-args.txt"
  CODEX_PATH_FILE="$TMP_DIR/codex-instructions-path.txt"
  CODEX_INSTRUCTIONS_COPY="$TMP_DIR/codex-instructions-copy.md"
  CODEX_CONTEXT_COPY="$TMP_DIR/codex-context-copy.md"
  CODEX_TMP_DIR="$TMP_DIR/codex-tmp"
  mkdir -p "$CODEX_TMP_DIR"
  cat > "$CODEX_CLI" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$CODEX_ARGS_FILE"
prev=""
for arg in "\$@"; do
  if [[ "\$arg" == model_instructions_file=* ]]; then
    path="\${arg#model_instructions_file=}"
    printf '%s\n' "\$path" > "$CODEX_PATH_FILE"
    if [ -f "\$path" ]; then cp "\$path" "$CODEX_INSTRUCTIONS_COPY"; fi
  fi
  if [[ "\$arg" == 'First read the private session context file at '* ]]; then
    context="\${arg#First read the private session context file at }"
    context="\${context%%. It contains*}"
    cp "\$context" "$CODEX_CONTEXT_COPY"
  fi
  prev="\$arg"
done
exit 0
EOF
  chmod +x "$CODEX_CLI"
  rm -f "$CODEX_ARGS_FILE" "$CODEX_PATH_FILE" "$CODEX_INSTRUCTIONS_COPY"
  set +e
  (
    TMPDIR="$CODEX_TMP_DIR" PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
      "$WRAPPER" \
      --project "$PROJECT_DIR" \
      --worker-id codex-headless \
      --role worker \
      --team Smoke \
      --no-start-daemon \
      --command "$CODEX_CLI" \
      --codex-exec \
      --no-loop \
      --poll-interval 0 \
      >"$TMP_DIR/wrapper-codex-headless.out" 2>&1
  )
  codex_headless_code=$?
  set -e
  [ "$codex_headless_code" -eq 0 ] || scope_fail Z2 "headless Codex wrapper exited with $codex_headless_code" "$TMP_DIR/wrapper-codex-headless.out"
  [ -f "$CODEX_ARGS_FILE" ] || scope_fail Z2 "the fake headless Codex CLI was never launched" "$TMP_DIR/wrapper-codex-headless.out"
  if ! grep -Fq 'model_instructions_file=' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z2 "headless Codex argv is missing model_instructions_file" "$TMP_DIR/wrapper-codex-headless.out"
  fi
  [ -f "$CODEX_PATH_FILE" ] || scope_fail Z2 "headless Codex did not receive an instructions path" "$TMP_DIR/wrapper-codex-headless.out"
  CODEX_HEADLESS_PATH="$(cat "$CODEX_PATH_FILE")"
  case "$CODEX_HEADLESS_PATH" in
    "$CODEX_TMP_DIR"/*) : ;;
    *) echo "received path: $CODEX_HEADLESS_PATH" >&2; scope_fail Z2 "headless instructions path is not under TMPDIR" "$TMP_DIR/wrapper-codex-headless.out" ;;
  esac
  [ -f "$CODEX_INSTRUCTIONS_COPY" ] || scope_fail Z2 "headless Codex could not read its per-seat file" "$TMP_DIR/wrapper-codex-headless.out"
  for needle in 'Role: worker'; do
    if ! grep -Fq -- "$needle" "$CODEX_INSTRUCTIONS_COPY"; then
      scope_fail Z2 "headless instructions file is missing [$needle]" "$TMP_DIR/wrapper-codex-headless.out"
    fi
  done
  grep -Fq 'Claimed task id: task-resume' "$CODEX_CONTEXT_COPY" || scope_fail Z2 'private user context is missing task binding' "$TMP_DIR/wrapper-codex-headless.out"
  if grep -Fq 'Claimed task id:' "$CODEX_INSTRUCTIONS_COPY"; then
    scope_fail Z2 'task context polluted the stable system instructions' "$TMP_DIR/wrapper-codex-headless.out"
  fi
  if [ -e "$CODEX_HEADLESS_PATH" ]; then
    scope_fail Z2 "headless per-seat instructions file was not removed after exit" "$TMP_DIR/wrapper-codex-headless.out"
  fi

  rm -f "$CODEX_ARGS_FILE" "$CODEX_PATH_FILE" "$CODEX_INSTRUCTIONS_COPY"
  set +e
  (
    TMPDIR="$CODEX_TMP_DIR" PATH="$TMP_DIR:$PATH" HOME="$HOME_DIR" MOE_PROXY_PATH="$FAKE_PROXY" FAKE_CLAIM_MODE=resume timeout "${POSTFLIGHT_TIMEOUT_SEC}s" \
      "$WRAPPER" \
      --project "$PROJECT_DIR" \
      --worker-id codex-tui \
      --role worker \
      --team Smoke \
      --no-start-daemon \
      --command "$CODEX_CLI" \
      --interactive \
      --no-loop \
      --poll-interval 0 \
      >"$TMP_DIR/wrapper-codex-tui.out" 2>&1
  )
  codex_tui_code=$?
  set -e
  [ "$codex_tui_code" -eq 0 ] || scope_fail Z2 "interactive Codex wrapper exited with $codex_tui_code" "$TMP_DIR/wrapper-codex-tui.out"
  [ -f "$CODEX_ARGS_FILE" ] || scope_fail Z2 "the fake interactive Codex CLI was never launched" "$TMP_DIR/wrapper-codex-tui.out"
  if ! grep -Fq 'model_instructions_file=' "$CODEX_ARGS_FILE"; then
    cat "$CODEX_ARGS_FILE" >&2 || true
    scope_fail Z2 "interactive Codex argv is missing model_instructions_file" "$TMP_DIR/wrapper-codex-tui.out"
  fi
  [ -f "$CODEX_PATH_FILE" ] || scope_fail Z2 "interactive Codex did not receive an instructions path" "$TMP_DIR/wrapper-codex-tui.out"
  CODEX_TUI_PATH="$(cat "$CODEX_PATH_FILE")"
  case "$CODEX_TUI_PATH" in
    "$CODEX_TMP_DIR"/*) : ;;
    *) echo "received path: $CODEX_TUI_PATH" >&2; scope_fail Z2 "interactive instructions path is not under TMPDIR" "$TMP_DIR/wrapper-codex-tui.out" ;;
  esac
  [ -f "$CODEX_INSTRUCTIONS_COPY" ] || scope_fail Z2 "interactive Codex could not read its per-seat file" "$TMP_DIR/wrapper-codex-tui.out"
  if ! grep -Fq -- 'Claimed task id: task-resume' "$CODEX_CONTEXT_COPY"; then
    scope_fail Z2 "interactive private context file is missing task binding" "$TMP_DIR/wrapper-codex-tui.out"
  fi
  if [ -e "$CODEX_TUI_PATH" ]; then
    scope_fail Z2 "interactive per-seat instructions file was not removed after exit" "$TMP_DIR/wrapper-codex-tui.out"
  fi
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario Z2] ok"

  # Scenario AA -- the reproduction. No claimable task, single-shot run (the
  # harness always passes --no-loop, which is exactly the shape whose fast path
  # used to be gated off): the wrapper must do its own waiting and launch
  # NOTHING rather than hand a CLI a prompt telling it to claim. A CLI that ran
  # here would have edited with no baseline and landed nothing.
  echo "[scenario AA] a taskless single-shot run never launches an unbound CLI"
  SCOPE_AA_DIR="$TMP_DIR/scope-aa"
  make_scope_project "$SCOPE_AA_DIR" '[]'
  set +e
  # The single-shot wait is bounded by MOE_TASKLESS_WAIT_SEC; 5s keeps the
  # scenario inside the harness's per-wrapper timeout instead of idling for the
  # 300s production default.
  FAKE_CLAIM_MODE=idle MOE_TASKLESS_WAIT_SEC=5 run_scope_wrapper "$SCOPE_AA_DIR" "$TMP_DIR/scope-aa.out" "$FILE_CLI" worker worker-scope-aa
  scope_aa_code=$?
  set -e
  FAKE_CLAIM_MODE=""
  [ "$scope_aa_code" -eq 0 ] || scope_fail AA "wrapper exited with $scope_aa_code" "$TMP_DIR/scope-aa.out"
  if [ -f "$SCOPE_AA_DIR/session-new.txt" ]; then
    scope_fail AA "a CLI was launched with no task bound -- it would edit with no baseline and land nothing" "$TMP_DIR/scope-aa.out"
  fi
  grep -Fq 'MOE_TASKLESS_NO_LAUNCH reason=idle' "$TMP_DIR/scope-aa.out" \
    || scope_fail AA "the suppressed launch must be named, not silent" "$TMP_DIR/scope-aa.out"
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario AA] ok"

  # Scenario AB -- the adoption alarm. The one legitimate taskless launch is a
  # chat-only session answering a routed mention; it holds no task and so has no
  # baseline by design. If it nonetheless ends holding one and left the tree
  # dirty, the wrapper must REFUSE under a named code, leave the bytes alone
  # (no invented baseline, no staging) and page #governors.
  echo "[scenario AB] a chat-only session that adopts a task refuses to land, loudly"
  SCOPE_AB_DIR="$TMP_DIR/scope-ab"
  make_scope_project "$SCOPE_AB_DIR" '[]'
  echo peer-base > "$SCOPE_AB_DIR/peer-mod.txt"
  git -C "$SCOPE_AB_DIR" add peer-mod.txt >/dev/null
  git -C "$SCOPE_AB_DIR" commit -qm peer-base >/dev/null
  echo peer-dirty > "$SCOPE_AB_DIR/peer-mod.txt"
  scope_ab_head="$(git -C "$SCOPE_AB_DIR" rev-parse HEAD)"
  set +e
  FAKE_CLAIM_MODE=idle FAKE_MENTION=1 FAKE_ADOPTED_TASK_ID=task-adopted MOE_TASKLESS_WAIT_SEC=5 \
    run_scope_wrapper "$SCOPE_AB_DIR" "$TMP_DIR/scope-ab.out" "$FILE_CLI" worker worker-scope-ab
  scope_ab_code=$?
  set -e
  FAKE_CLAIM_MODE=""; FAKE_MENTION=""; FAKE_ADOPTED_TASK_ID=""
  [ "$scope_ab_code" -eq 0 ] || scope_fail AB "wrapper exited with $scope_ab_code" "$TMP_DIR/scope-ab.out"
  [ -f "$SCOPE_AB_DIR/session-new.txt" ] \
    || scope_fail AB "the chat-only session was never launched, so the adoption path was not exercised" "$TMP_DIR/scope-ab.out"
  grep -Fq 'MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=task-adopted' "$TMP_DIR/scope-ab.out" \
    || scope_fail AB "an adopted task with a dirty tree must refuse under the named code, not exit silently" "$TMP_DIR/scope-ab.out"
  if [ "$(git -C "$SCOPE_AB_DIR" rev-parse HEAD)" != "$scope_ab_head" ]; then
    scope_fail AB "the refusal still moved the branch -- nothing may land without a baseline" "$TMP_DIR/scope-ab.out"
  fi
  if ! git -C "$SCOPE_AB_DIR" status --porcelain | grep -q '^?? session-new\.txt$'; then
    git -C "$SCOPE_AB_DIR" status --porcelain >&2 || true
    scope_fail AB "the adopted session's bytes must stay in the working tree, unstaged" "$TMP_DIR/scope-ab.out"
  fi
  if ! git -C "$SCOPE_AB_DIR" status --porcelain | grep -q '^ M peer-mod\.txt$'; then
    git -C "$SCOPE_AB_DIR" status --porcelain >&2 || true
    scope_fail AB "the peer's dirty file must be untouched by the refusal" "$TMP_DIR/scope-ab.out"
  fi
  grep -Fq 'MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=task-adopted' "$SCOPE_AB_DIR/.moe/messages/chan-general.jsonl" \
    || scope_fail AB "the refusal must page #governors, not just print" "$TMP_DIR/scope-ab.out"
  SCOPE_SCENARIOS_RUN=$((SCOPE_SCENARIOS_RUN + 1))
  echo "[scenario AB] ok"

  # A harness that silently generated zero scenarios exits 0 and reads as green.
  # (Scenarios Q and V run inside the quality-gate cases above and are guarded
  # by those cases' own fail-fast assertions, not this counter.)
  echo "commit-scope scenarios run: $SCOPE_SCENARIOS_RUN"
  if [ "$SCOPE_SCENARIOS_RUN" -ne 31 ]; then
    echo "Expected 31 commit-scope scenarios (A-P, K2, M2, M3, P2, R-U, W-Z, Z2, AA, AB); ran $SCOPE_SCENARIOS_RUN" >&2
    exit 1
  fi
else
  echo "SKIP commit-scope scenarios: git not available"
fi

echo "PASS postflight.sh"

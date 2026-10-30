// Fake daemon+proxy for the postflight smoke tests, shared by
// scripts/tests/postflight.sh and scripts/tests/postflight.ps1: each harness
// copies this file to its temp dir and points the wrapper's MOE_PROXY_PATH (and
// the frozen candidate suite) at the copy. parity-check.{sh,ps1} fail if either
// harness embeds a private copy again -- the two copies once drifted apart.
// One node process per RPC, steered only by FAKE_* env vars (each documented at
// its handler); every handler mirrors the daemon tool it fakes, and none calls a
// live daemon. Side effects land under <project>/.moe: messages/<channel>.jsonl
// (chat_send), heartbeat.log, record_commit.jsonl, deregister.log,
// evidence-rpcs.jsonl, account-rpcs.jsonl and the attempts/, candidates/,
// checks/ and receipts/ records.
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
function readTask(id) {
  // Set-Content -Encoding UTF8 on Windows PowerShell 5.1 writes a BOM, which
  // JSON.parse rejects -- strip it.
  try { return JSON.parse(fs.readFileSync(path.join(moe, 'tasks', `${id}.json`), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function strList(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []; }
// util/attributionTiers.ts collectTaskPathTiers: ASSERTED = COMPLETED steps'
// (modifiedFiles ?? affectedFiles) + filesModified + declaredFiles +
// touchedFiles; PLANNED = every step's affected/new/modified + inferredPaths,
// minus ASSERTED.
function declaredSets(task) {
  const asserted = new Set();
  const planned = new Set();
  for (const s of (Array.isArray(task.implementationPlan) ? task.implementationPlan : [])) {
    if (!s) continue;
    if (s.status === 'COMPLETED') for (const p of strList(s.modifiedFiles || s.affectedFiles)) asserted.add(p);
    for (const p of [...strList(s.affectedFiles), ...strList(s.newFiles), ...strList(s.modifiedFiles)]) planned.add(p);
  }
  for (const p of [...strList(task.filesModified), ...strList(task.declaredFiles), ...strList(task.touchedFiles)]) asserted.add(p);
  for (const p of strList(task.inferredPaths)) planned.add(p);
  for (const p of asserted) planned.delete(p);
  return { asserted: [...asserted], planned: [...planned] };
}
function csv(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

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
  // A FAKE_CLAIM_LIMIT loop claims again after a landing closed the attempt:
  // like openAttempt, that claim persists a running attempt before it answers.
  const reopen = claimLimit > 1 && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).phase === 'closed';
  if (!fs.existsSync(file) || reopen) fs.writeFileSync(file, JSON.stringify({
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
// attempt. FAKE_HEARTBEAT_ATTEMPT names the attempt the seat's current task
// holds (default attempt-postflight). .moe/heartbeat-count counts the pings.
if (tool === 'heartbeat' && process.env.FAKE_HEARTBEAT_REATTACH) {
  const counter = path.join(moe, 'heartbeat-count');
  const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
  fs.writeFileSync(counter, String(n));
  const reattach = (reason, a) => ({ok:false,reattachRequired:true,reason,reattachWith:'moe.reattach_attempt',...(a ? {attemptId:a.id,phase:a.phase} : {})});
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(moe,'attempts',(process.env.FAKE_HEARTBEAT_ATTEMPT || 'attempt-postflight')+'.json'),'utf8')); } catch {}
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
if (tool === 'claim_next_task' && !claimOnceIdle && !['idle','blocked','noteam','noteam-until-joined'].includes(process.env.FAKE_CLAIM_MODE)) attemptFixture();
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
  case 'join_team': {
    // FAKE_JOIN_FULL=1: refused the way teamStore refuses a join to a full team.
    // FAKE_JOIN_FULL_UNTIL=N: only the first N joins are refused, as when a seat
    // frees up (or maxSize is raised) after the wrapper launched. .moe/join-count
    // counts every join; .moe/team-joined marks an accepted one.
    ensureDir(moe);
    const joinCount = path.join(moe, 'join-count');
    const joinN = Number(fs.existsSync(joinCount) ? fs.readFileSync(joinCount, 'utf8') : 0) + 1;
    fs.writeFileSync(joinCount, String(joinN));
    if (process.env.FAKE_JOIN_FULL === '1' || joinN <= Number(process.env.FAKE_JOIN_FULL_UNTIL || 0)) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'Team Smoke is full (max 10 members)',data:{tool:'moe.join_team'}}}) + '\n');
      process.exit(0);
    }
    fs.writeFileSync(path.join(moe, 'team-joined'), String(joinN));
    // The daemon answers with the team; the wrappers accept only a member list naming them.
    ok({ team: { id: args.teamId, name: 'Smoke', memberIds: [args.workerId] } }); break;
  }
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
      // One-task-per-worker guard shape (util/claimEligibility.ts
      // heldTaskRefusal): the worker already holds an active task from a CLI
      // session that died mid-task, reported with the held record's status.
      const status = process.env.FAKE_TASK_STATUS || 'REVIEW';
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume', workerId: args.workerId }, reason: `One task per worker: you already hold task-resume (${status}).` },
        // FAKE_CLAIM_LAUNCH: the per-task tier hint (claimNextTask.ts launch).
        ...(process.env.FAKE_CLAIM_LAUNCH ? { launch: JSON.parse(process.env.FAKE_CLAIM_LAUNCH) } : {})
      });
    } else if (process.env.FAKE_CLAIM_MODE === 'blocked') {
      // The BLOCKED hold (claimEligibility.ts blockedHoldGuidance): the daemon
      // parked this worker's task via report_blocked; the wrapper must suppress
      // the relaunch and idle -- after landing any lingering baseline for it.
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: 'BLOCKED', blockedReason: 'waiting on a peer' },
        nextAction: { tool: 'moe.report_blocked', args: { taskId: 'task-resume', workerId: args.workerId, reason: 'waiting on a peer' }, reason: 'You hold task-resume and it is BLOCKED.' }
      });
    } else if (process.env.FAKE_CLAIM_MODE === 'noteam'
      || (process.env.FAKE_CLAIM_MODE === 'noteam-until-joined' && !fs.existsSync(path.join(moe, 'team-joined')))) {
      // claimNextTask.ts noTeamMembershipRefusal: a SOLO seat whose every
      // candidate sits in an epic+status a live worker already holds.
      // noteam-until-joined: the same until a join is accepted, then idle.
      ok({ hasNext: false, code: 'NO_TEAM_MEMBERSHIP', nextAction: { tool: 'moe.join_team', args: { workerId: args.workerId }, reason: 'Worker belongs to no team.' } });
    } else if (['idle', 'noteam-until-joined'].includes(process.env.FAKE_CLAIM_MODE)) {
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
    // (the resolved epic comes back alongside it instead). Daemons before the
    // explicit-taskId NOT_FOUND fix let an unresolvable taskId fall back to the
    // CALLER's currentTaskId rather than erroring -- so a stale id silently
    // answered with a different task.
    // 'empty'    => daemon answered but carried no task.
    // 'mismatch' => the pre-fix fallback: some OTHER task comes back.
    // get_context with NO taskId is the post-flight adoption probe
    // (getContext.ts falls back to the caller's currentTaskId). Every other
    // caller passes a taskId, so this cannot disturb the other scenarios.
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
    if (process.env.FAKE_SCOPE_FAIL === '1') { ok({}); break; }
    // Mirrors tools/getCommitScope.ts over the on-disk records: ASSERTED and
    // PLANNED are the record's own tiers (declaredSets); PEER is the same union
    // over every other record not DONE/ARCHIVED, visited in id order, the
    // first claimant of a path winning. Knobs:
    //   FAKE_SCOPE_PEER_DECLARED     path:taskId,... appended to PEER (split
    //                                on the last ':'; taskId defaults to
    //                                task-peer)
    //   FAKE_SCOPE_PEERS_ACTIVE=1    another worker is active (every other
    //                                open task is then held by a live peer)
    //   FAKE_SCOPE_PEER_ACTIVE=0|1   every peerDeclared entry's peerActive
    //                                (1 = true); unset omits the field, as a
    //                                daemon from before it does
    //   FAKE_SCOPE_PEER_FIELDS=<JSON object>  merged into every peerDeclared
    //                                entry (e.g. taskIds, editingTaskIds); unset
    //                                serves neither, as a daemon before
    //                                task-f943b687 does. JSON, not CSV: a
    //                                PowerShell variable set to '' is deleted.
    //   FAKE_SCOPE_FAIL=1            answer {} (no taskId): the wrappers take
    //                                their disk-fallback scope
    //   FAKE_SCOPE_DECLARED_FIELD=1  serve `declared` (the record's
    //                                declaredFiles) as the current daemon does;
    //                                unset models a daemon from before the
    //                                field, whose asserted paths all land
    //                                regardless of the baseline
    //   FAKE_SCOPE_ASSIGNEE=<id>|none  who holds the task. Unset or empty: the
    //                                caller (args.workerId, else nobody), as
    //                                before. `none`: unassigned. An empty value
    //                                is the same as unset because PowerShell
    //                                deletes a variable set to '', so the named
    //                                sentinel carries "unassigned" on every engine.
    //                                A caller that is not the assignee joins
    //                                activePeerIds and makes peersActive true,
    //                                as the daemon's orphan rule does.
    //   FAKE_SCOPE_ASSIGNEE_ALIVE=0|1  assigneeAlive. Default true, false for `none`.
    //   FAKE_SCOPE_ASSIGNEE_PROTECTED=0|1  assigneeProtected. Default: true when
    //                                a worker holds the task, false when none does
    //                                (the daemon's answer for a registered owner and
    //                                for an unassigned task). 0 with ALIVE=0 is a
    //                                dead or missing owner; 1 with ALIVE=0 a quiet one.
    //   FAKE_SCOPE_OWNERSHIP_MODE=omit|malformed  unset serves assigneeProtected as
    //                                a boolean. `omit` leaves out that one key, as a
    //                                daemon from before the field does. `malformed`
    //                                serves String(value), so 'false' arrives as a
    //                                string, the coercion trap a wrapper must refuse.
    //   FAKE_SCOPE_FINALIZING=computed|null|malformed  unset leaves out
    //                                finalizingAttempt, as a daemon from before the
    //                                field does. `computed` serves the task's
    //                                finalizing attempt as claimEligibility.ts
    //                                finalizingAttemptsByTask selects it from
    //                                .moe/attempts ({attemptId, workerId,
    //                                generation}, highest generation, else null).
    //                                `null` serves null whatever the records say.
    //                                `malformed` serves the computed value with a
    //                                string generation, or the string 'null'.
    // The ALIVE, PROTECTED, OWNERSHIP_MODE and FINALIZING knobs accept only the
    // values above (empty counts as unset); anything else throws, so a typo cannot
    // pass a scenario.
    // Pre-flight answers with the record's own status (the FAKE_TASK_STATUS
    // knob models the status the task reaches AFTER the CLI ran).
    const knob = (name, allowed) => {
      const value = process.env[name];
      if (value === undefined || value === '') return null;
      if (!allowed.includes(value)) throw new Error(`${name} must be ${allowed.map((a) => JSON.stringify(a)).join(' or ')} (got ${JSON.stringify(value)})`);
      return value;
    };
    const ownerKnob = process.env.FAKE_SCOPE_ASSIGNEE || '';
    const assignedWorkerId = ownerKnob === '' ? (args.workerId || null) : ownerKnob === 'none' ? null : ownerKnob;
    const aliveKnob = knob('FAKE_SCOPE_ASSIGNEE_ALIVE', ['0', '1']);
    const protectedKnob = knob('FAKE_SCOPE_ASSIGNEE_PROTECTED', ['0', '1']);
    const ownershipMode = knob('FAKE_SCOPE_OWNERSHIP_MODE', ['omit', 'malformed']);
    const finalizingMode = knob('FAKE_SCOPE_FINALIZING', ['computed', 'null', 'malformed']);
    const assigneeAlive = aliveKnob === null ? ownerKnob !== 'none' : aliveKnob === '1';
    const assigneeProtected = protectedKnob === null ? assignedWorkerId !== null : protectedKnob === '1';
    const taskId = args.taskId || 'task-postflight';
    const rec = readTask(taskId);
    const { asserted, planned } = rec ? declaredSets(rec) : { asserted: [], planned: [] };
    let finalizingAttempt = null;
    if (finalizingMode !== null) {
      // isHoldingFinalizingAttempt: phase finalizing, non-blank id/workerId,
      // safe-integer generation >= 1; the highest generation wins.
      const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';
      let best = null;
      let attemptFiles = [];
      try { attemptFiles = fs.readdirSync(path.join(moe, 'attempts')).filter((f) => f.endsWith('.json')).sort(); } catch {}
      for (const f of attemptFiles) {
        let a;
        try { a = JSON.parse(fs.readFileSync(path.join(moe, 'attempts', f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
        if (!a || a.phase !== 'finalizing' || a.taskId !== taskId || !nonBlank(a.id) || !nonBlank(a.workerId)
          || !Number.isSafeInteger(a.generation) || a.generation < 1) continue;
        if (!best || a.generation >= best.generation) best = a;
      }
      const named = best && { attemptId: best.id, workerId: best.workerId, generation: best.generation };
      if (finalizingMode === 'computed') finalizingAttempt = named || null;
      if (finalizingMode === 'malformed') finalizingAttempt = named ? { ...named, generation: String(named.generation) } : 'null';
    }
    const peerDeclared = [];
    const peerIds = [];
    const addPeer = (p, id) => { if (p && !peerDeclared.some((e) => e.path === p)) peerDeclared.push({ path: p, taskId: id }); };
    let recordFiles = [];
    try { recordFiles = fs.readdirSync(path.join(moe, 'tasks')).filter((f) => f.endsWith('.json')).sort(); } catch {}
    for (const f of recordFiles) {
      const other = readTask(f.replace(/\.json$/, ''));
      if (!other || !other.id || other.id === taskId || other.status === 'DONE' || other.status === 'ARCHIVED') continue;
      peerIds.push(other.id);
      const sets = declaredSets(other);
      for (const p of [...sets.asserted, ...sets.planned]) addPeer(p, other.id);
    }
    for (const ent of csv(process.env.FAKE_SCOPE_PEER_DECLARED)) {
      const i = ent.lastIndexOf(':');
      addPeer(i < 0 ? ent : ent.slice(0, i), (i < 0 ? '' : ent.slice(i + 1)) || 'task-peer');
    }
    const peerActive = process.env.FAKE_SCOPE_PEER_ACTIVE;
    if (peerActive === '0' || peerActive === '1') for (const e of peerDeclared) e.peerActive = peerActive === '1';
    if (process.env.FAKE_SCOPE_PEER_FIELDS) for (const e of peerDeclared) Object.assign(e, JSON.parse(process.env.FAKE_SCOPE_PEER_FIELDS));
    const livePeers = process.env.FAKE_SCOPE_PEERS_ACTIVE === '1';
    const orphanCaller = Boolean(args.workerId) && args.workerId !== assignedWorkerId;
    const activePeerIds = [...(livePeers ? ['worker-peer'] : []), ...(orphanCaller ? [args.workerId] : [])];
    ok({
      taskId,
      title: rec?.title || 'Postflight smoke',
      status: args.phase === 'preflight' ? (rec?.status || 'WORKING') : (process.env.FAKE_TASK_STATUS || rec?.status || 'WORKING'),
      epicId: 'epic-1',
      reopenCount: rec?.reopenCount || 0,
      assignedWorkerId,
      assigneeAlive,
      ...(ownershipMode === 'omit' ? {} : { assigneeProtected: ownershipMode === 'malformed' ? String(assigneeProtected) : assigneeProtected }),
      ...(finalizingMode === null ? {} : { finalizingAttempt }),
      asserted, planned,
      ...(process.env.FAKE_SCOPE_DECLARED_FIELD === '1' ? { declared: strList(rec?.declaredFiles) } : {}),
      touchedFiles: strList(rec?.touchedFiles), inferredPaths: strList(rec?.inferredPaths), unattributedPaths: strList(rec?.unattributedPaths),
      peerDeclared,
      livePeerIds: livePeers ? ['worker-peer'] : [],
      activePeerIds,
      peersActive: activePeerIds.length > 0,
      // BOARD candidates: own record, project.json and every record not held
      // by a live peer (the daemon also lists epics; no scenario seeds one).
      alwaysInclude: [`.moe/tasks/${taskId}.json`, '.moe/project.json', ...(livePeers ? [] : peerIds.map((id) => `.moe/tasks/${id}.json`))],
      excludePrefixes: [],
      policy: { autoCommit: true, checkpointCommits: true, checkpointPush: true, commitBoardState: true, commitHooks: false, undeclared: 'solo', contested: 'commit' }
    });
    break;
  }
  case 'record_commit': {
    // The daemon ledger: one JSON line per landing outcome, asserted on by
    // the scope scenarios (kind, paths, inferredPaths, unattributedPaths).
    ensureDir(moe);
    fs.appendFileSync(path.join(moe, 'record_commit.jsonl'), JSON.stringify(args) + '\n');
    ok({ success: true, taskId: args.taskId, sha: args.sha, kind: args.kind, outcome: args.outcome, commitCount: 1, filesModified: strList(args.paths), addedPaths: strList(args.paths) });
    break;
  }
  case 'declare_files': ok({ success: true, taskId: args.taskId, declaredFiles: strList(args.paths), addedPaths: strList(args.paths) }); break;
  case 'release_task': {
    // releaseTask.ts in miniature for scenario AH: every call is logged in
    // order with the other RPCs; FAKE_RELEASE_REFUSE=<codeName> refuses it the
    // way the ownership and fencing gates do, before anything is written.
    appendRpc();
    const refuse = process.env.FAKE_RELEASE_REFUSE;
    if (refuse) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32003,message:'['+refuse+'] fixture release refused',
        data:{tool:'moe.release_task',codeName:refuse}}}) + '\n');
      break;
    }
    ok({ success: true, taskId: args.taskId, previousWorkerId: args.workerId, releasedBy: args.workerId, status: 'WORKING', message: `Task ${args.taskId} released from ${args.workerId}` });
    break;
  }
  case 'deregister_worker': {
    // The EXIT-trap deregister; scenario W proves it still runs after the
    // teardown rescue.
    fs.appendFileSync(path.join(moe, 'deregister.log'), `${new Date().toISOString()} ${args.workerId} ${args.reason || ''}\n`);
    ok({ success: true });
    break;
  }
  case 'lease_account':
  case 'report_account_usage': {
    // leaseAccount.ts in miniature, for the [accounts] scenario: no rotation
    // without FAKE_ACCOUNT_HOME; with FAKE_ACCOUNT_WAIT_ONCE the first lease
    // finds every account spent; otherwise the first of acct-1, acct-2 that no
    // report refused or signed out. Every call is logged.
    const log = path.join(moe, 'account-rpcs.jsonl');
    const rows = readRows(log);
    fs.appendFileSync(log, JSON.stringify({ tool, args }) + '\n');
    if (tool === 'report_account_usage') { ok({ recorded: true, blockedUntil: null, peakPercent: null }); break; }
    const home = process.env.FAKE_ACCOUNT_HOME;
    const spent = { rotation: true, accountId: null, retryAt: new Date(Date.now() + 3600000).toISOString(), retryInSec: 3600, switchAtPercent: 90 };
    if (!home) { ok({ rotation: false, reason: null }); break; }
    if (process.env.FAKE_ACCOUNT_WAIT_ONCE && !rows.some(r => r.tool === 'lease_account')) { ok(spent); break; }
    const parked = new Set(rows.filter(r => r.tool === 'report_account_usage' && (r.args.refused === true || r.args.signIn)).map(r => r.args.accountId));
    const id = ['acct-1', 'acct-2'].find(a => !parked.has(a));
    ok(id ? { rotation: true, accountId: id, label: id, configDir: path.join(home, id), peakPercent: id === 'acct-1' ? 12.5 : null, switchAtPercent: 90 } : spent);
    break;
  }
  default: ok({ success: true });
}

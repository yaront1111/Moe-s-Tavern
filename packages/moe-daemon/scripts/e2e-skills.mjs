#!/usr/bin/env node
/**
 * Comprehensive E2E for the skill system.
 * Boots a fresh project, exercises every phase that surfaces a
 * nextAction.recommendedSkill, and verifies the agent-wrapper manifest parser.
 *
 * Run from anywhere:  node packages/moe-daemon/scripts/e2e-skills.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const DAEMON = path.join(REPO, 'packages', 'moe-daemon', 'dist', 'index.js');
const PROXY = path.join(REPO, 'packages', 'moe-proxy', 'dist', 'index.js');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${label}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

function spawnPromise(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

async function callTool(projectDir, name, args) {
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n';
  const r = await spawnPromise(process.execPath, [PROXY], { cwd: projectDir, input: req });
  const lines = r.stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  const wire = JSON.parse(last);
  if (wire.error) throw new Error(`${name}: ${wire.error.message}`);
  return JSON.parse(wire.result.content[0].text);
}

async function waitFor(predicate, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('\n=== Moe skill-system E2E ===\n');

  // ---------- 1. Fresh init scaffolds .moe/skills/ ----------
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-e2e-')).replace(/\\/g, '/');
  console.log(`Test project: ${projectDir}\n`);

  console.log('Phase 1: init scaffolds .moe/skills/');
  // Spawn the supervisor in the background and wait for daemon.json.
  console.log(`  spawn: ${process.execPath} ${DAEMON} init --project ${projectDir}`);
  const supLog = fs.openSync(path.join(os.tmpdir(), 'moe-e2e-supervisor.log'), 'w');
  const sup = spawn(process.execPath, [DAEMON, 'init', '--project', projectDir], { detached: true, stdio: ['ignore', supLog, supLog] });
  sup.unref();
  const ok = await waitFor(() => fs.existsSync(path.join(projectDir, '.moe/daemon.json')), 30000);
  if (!ok) {
    console.error('daemon never started — supervisor log:');
    console.error(fs.readFileSync(path.join(os.tmpdir(), 'moe-e2e-supervisor.log'), 'utf-8').slice(0, 2000));
    process.exit(1);
  }

  const skillsDir = path.join(projectDir, '.moe/skills');
  check('.moe/skills/ exists', fs.existsSync(skillsDir));
  const skillEntries = fs.readdirSync(skillsDir);
  check('all 13 skills present', skillEntries.filter(e => fs.statSync(path.join(skillsDir, e)).isDirectory()).length === 13);
  check('manifest.json present', skillEntries.includes('manifest.json'));
  check('LICENSE-VENDORED.md present', skillEntries.includes('LICENSE-VENDORED.md'));

  const manifest = JSON.parse(fs.readFileSync(path.join(skillsDir, 'manifest.json'), 'utf-8'));
  check('manifest declares 13 skills', manifest.skills?.length === 13);
  check('every skill has SKILL.md on disk', manifest.skills.every(s => fs.existsSync(path.join(skillsDir, s.name, 'SKILL.md'))));

  // ---------- 2. PLANNING task → moe-planning ----------
  console.log('\nPhase 2: nextAction.recommendedSkill per phase');
  const epic = await callTool(projectDir, 'moe.create_epic', { title: 'E2E', description: 'e2e epic' });
  const planTask = await callTool(projectDir, 'moe.create_task', {
    epicId: epic.epic.id, title: 'planning-task', description: 'p', status: 'PLANNING',
  });
  const ctxPlanning = await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id });
  check('PLANNING get_context → moe-planning',
    ctxPlanning.nextAction?.recommendedSkill === 'moe-planning',
    `got: ${ctxPlanning.nextAction?.recommendedSkill}`);

  // ---------- 3. Architect → submit_plan (proper flow, since create_task doesn't take a plan) ----------
  // Architect claims the PLANNING task.
  await callTool(projectDir, 'moe.claim_next_task', {
    workerId: 'e2e-arch', statuses: ['PLANNING'],
  });
  // Fetch context (required before submit_plan per enforcement).
  await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id, workerId: 'e2e-arch' });
  // Submit a 2-step plan.
  await callTool(projectDir, 'moe.submit_plan', {
    taskId: planTask.task.id, workerId: 'e2e-arch',
    steps: [
      { description: 'Write failing test for X', affectedFiles: ['x.test.ts'] },
      { description: 'Implement X', affectedFiles: ['x.ts'] },
    ],
  });
  // Approve the plan (default approvalMode=CONTROL puts it in AWAITING_APPROVAL).
  await callTool(projectDir, 'moe.set_task_status', { taskId: planTask.task.id, status: 'WORKING' });

  // Worker claims it.
  const claimed = await callTool(projectDir, 'moe.claim_next_task', {
    workerId: 'e2e-w', statuses: ['WORKING'],
  });
  check('worker claimed the task', claimed.task?.id === planTask.task.id);
  // Worker fetches context (required before start_step).
  await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id, workerId: 'e2e-w' });

  // Get the actual stepIds the daemon assigned.
  const ctxAfterPlan = await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id, workerId: 'e2e-w' });
  const steps = ctxAfterPlan.task.implementationPlan;
  const s1 = steps[0].stepId;
  const s2 = steps[1].stepId;

  // start_step on s1 (test step) → test-driven-development.
  const ss1 = await callTool(projectDir, 'moe.start_step', { taskId: planTask.task.id, stepId: s1, workerId: 'e2e-w' });
  check('start_step on test step → test-driven-development',
    ss1.nextAction?.recommendedSkill === 'test-driven-development',
    `got: ${ss1.nextAction?.recommendedSkill}`);

  // complete_step s1 → next is start_step on s2 (final) → adversarial-self-review.
  const cs1 = await callTool(projectDir, 'moe.complete_step', { taskId: planTask.task.id, stepId: s1, workerId: 'e2e-w' });
  check('complete_step → adversarial-self-review (next is final step)',
    cs1.nextAction?.recommendedSkill === 'adversarial-self-review',
    `got: ${cs1.nextAction?.recommendedSkill}`);

  // start_step on s2 (final) → adversarial-self-review.
  const ss2 = await callTool(projectDir, 'moe.start_step', { taskId: planTask.task.id, stepId: s2, workerId: 'e2e-w' });
  check('start_step on final step → adversarial-self-review',
    ss2.nextAction?.recommendedSkill === 'adversarial-self-review',
    `got: ${ss2.nextAction?.recommendedSkill}`);

  // complete_step s2 → next is complete_task → verification-before-completion.
  const cs2 = await callTool(projectDir, 'moe.complete_step', { taskId: planTask.task.id, stepId: s2, workerId: 'e2e-w' });
  check('complete_step (final) → verification-before-completion',
    cs2.nextAction?.recommendedSkill === 'verification-before-completion',
    `got: ${cs2.nextAction?.recommendedSkill}`);

  // ---------- 4. complete_task → REVIEW; QA picks up → moe-qa-loop ----------
  const ct = await callTool(projectDir, 'moe.complete_task', { taskId: planTask.task.id, workerId: 'e2e-w' });
  check('complete_task ok', ct.success === true, `status: ${ct.status || ct.task?.status}`);
  const ctxReview = await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id });
  check('REVIEW get_context → moe-qa-loop',
    ctxReview.nextAction?.recommendedSkill === 'moe-qa-loop',
    `got: ${ctxReview.nextAction?.recommendedSkill}`);

  // ---------- 5. qa_reject → reopened task → receiving-code-review ----------
  // QA must claim the task in REVIEW first (asserts ownership before qa_reject).
  await callTool(projectDir, 'moe.claim_next_task', { workerId: 'e2e-qa', statuses: ['REVIEW'] });
  await callTool(projectDir, 'moe.qa_reject', { taskId: planTask.task.id, reason: 'tests are weak', workerId: 'e2e-qa' });
  const ctxReopened = await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id, workerId: 'e2e-w' });
  check('reopened (reopenCount > 0) get_context → receiving-code-review',
    ctxReopened.nextAction?.recommendedSkill === 'receiving-code-review',
    `got: ${ctxReopened.nextAction?.recommendedSkill}`);

  // ---------- 6. report_blocked → systematic-debugging ----------
  // qa_reject cleared assignedWorkerId (the daemon clears the assignee on any
  // status change). Worker must re-claim before report_blocked has a worker
  // to bind nextAction to.
  await callTool(projectDir, 'moe.claim_next_task', { workerId: 'e2e-w', statuses: ['WORKING'] });
  await callTool(projectDir, 'moe.get_context', { taskId: planTask.task.id, workerId: 'e2e-w' });
  const rb = await callTool(projectDir, 'moe.report_blocked', { taskId: planTask.task.id, reason: 'cannot find Y', workerId: 'e2e-w' });
  check('report_blocked → systematic-debugging',
    rb.nextAction?.recommendedSkill === 'systematic-debugging',
    `got: ${rb.nextAction?.recommendedSkill}`);

  // ---------- 6b. memory subsystem still works (.moe/memory + remember/recall) ----------
  console.log('\nPhase 2b: memory subsystem unaffected');
  check('.moe/memory exists', fs.existsSync(path.join(projectDir, '.moe/memory')));
  check('.moe/memory/sessions exists', fs.existsSync(path.join(projectDir, '.moe/memory/sessions')));
  await callTool(projectDir, 'moe.remember', {
    workerId: 'e2e-w', type: 'gotcha',
    content: 'E2E memory check — this entry should round-trip via recall.',
    tags: ['e2e-test'],
  });
  const recall = await callTool(projectDir, 'moe.recall', { workerId: 'e2e-w', query: 'E2E memory check' });
  const memMatched = (recall.memories || []).some(r => /E2E memory check/.test(r.content || ''));
  check('moe.remember → moe.recall round-trips', memMatched, `got ${recall.memories?.length ?? 0} memories`);
  check('.moe/memory/knowledge.jsonl written',
    fs.existsSync(path.join(projectDir, '.moe/memory/knowledge.jsonl')) &&
    fs.statSync(path.join(projectDir, '.moe/memory/knowledge.jsonl')).size > 0);

  // ---------- 7. Agent-wrapper manifest parser ----------
  console.log('\nPhase 3: agent-wrapper manifest parser');
  const parser = `
try {
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'));
  if (!Array.isArray(m.skills)) { process.stderr.write('manifest.skills missing'); process.exit(2); }
  const lines = m.skills.map(s => '- ' + s.name + ' (' + (s.role||'all') + '): ' + (s.description||''));
  process.stdout.write(lines.join('\\n'));
} catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(2); }
`;
  const r = await spawnPromise(process.execPath, ['-e', parser, path.join(skillsDir, 'manifest.json')]);
  check('parser exits 0', r.code === 0);
  const lines = r.stdout.split('\n');
  check('parser emits 13 skill lines', lines.length === 13, `got ${lines.length}`);
  check('every line is "- name (role): description"', lines.every(l => /^- [a-z-]+ \([^)]+\): /.test(l)));

  // ---------- 8. Bad manifest → parser warns ----------
  const tmpBad = path.join(projectDir, '.moe/skills/_bad.json');
  fs.writeFileSync(tmpBad, '{ "version": 1 }'); // no skills array
  const rBad = await spawnPromise(process.execPath, ['-e', parser, tmpBad]);
  check('parser exits non-zero on missing skills array', rBad.code !== 0);
  check('parser writes error to stderr', rBad.stderr.includes('manifest.skills missing'));
  fs.unlinkSync(tmpBad);

  // ---------- 9. Cleanup ----------
  console.log('\nPhase 4: cleanup');
  const stop = await spawnPromise(process.execPath, [DAEMON, 'stop', '--project', projectDir]);
  check('daemon stopped cleanly', stop.code === 0);
  await new Promise(r => setTimeout(r, 1500));
  fs.rmSync(projectDir, { recursive: true, force: true });
  check('test project removed', !fs.existsSync(projectDir));

  // ---------- Summary ----------
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

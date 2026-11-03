#!/usr/bin/env node
// Daemon-free seat CLI for postflight-vm-route.sh and the PS twin. Records only
// a credential hash/name, never its value. FAKE_SEAT_JOB_SLEEP delays a job;
// FAKE_SEAT_EXIT_CODE is the guest's exit; FAKE_SEAT_OUTCOME overrides its result.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const argv = process.argv.slice(2), cmd = argv[0];
const flag = name => argv[argv.indexOf(`--${name}`) + 1];
const project = flag('project'), moe = path.join(project, '.moe');
const hash = value => createHash('sha256').update(value).digest('hex');
const record = extra => fs.appendFileSync(path.join(moe, 'evidence-rpcs.jsonl'),
  JSON.stringify({ tool: 'agent-seat', args: { cmd, argv, env: process.env, ...extra } }) + '\n');
const answer = result => console.log(JSON.stringify(result));
function candidate(checkout, commit, worker) {
  const git = (args, options = {}) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', ...options }).trim();
  const baseTree = git(['rev-parse', `${commit}^{tree}`]);
  const clean = git(['--no-optional-locks', 'status', '--porcelain', '-uall']) === '';
  if (!worker) return { baseTree, tree: baseTree, clean, paths: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-seat-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
  try {
    git(['read-tree', commit], { env });
    const blob = git(['hash-object', '-w', '--stdin'], { input: 'admitted VM job\n' });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},vm-job.txt`], { env });
    return { baseTree, tree: git(['write-tree'], { env }), clean, paths: [{ path: 'vm-job.txt', kind: 'file' }] };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
async function main() {
  if (cmd === 'seat-start') {
    const counter = path.join(moe, 'seat-counter');
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(n));
    const instance = `moe-vm-${n.toString(16).padStart(20, '0')}`;
    const failure = JSON.parse(process.env.FAKE_SEAT_STARTS || '[]')[n - 1];
    if (failure) { record({ instance: null }); answer({ ok: false, code: failure.code }); process.exitCode = failure.exit; return; }
    record({ instance }); answer({ ok: true, instance, executionReady: false });
  } else if (cmd === 'seat-stop') {
    if (process.env.FAKE_SEAT_STOP_FAIL) { record({}); answer({ ok: false, code: 'SEAT_DELETE_FAILED' }); process.exitCode = 1; return; }
    record({}); answer({ ok: true, instance: flag('instance'), vm: 'deleted' });
  } else if (cmd === 'seat-job') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    require('node:assert/strict').deepEqual(Object.keys(credential).sort(), ['name', 'value']);
    const role = flag('role'), commit = flag('commit');
    const result = candidate(flag('checkout'), commit, role === 'worker');
    record({ ...result, stdinName: credential.name, stdinSha256: hash(credential.value) });
    const jobs = fs.readFileSync(path.join(moe, 'evidence-rpcs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .filter(r => r.tool === 'agent-seat' && r.args.cmd === 'seat-job').length;
    const failure = JSON.parse(process.env.FAKE_SEAT_JOBS || '[]')[jobs - 1];
    if (failure) { if (failure.outcome) answer(failure.outcome); else console.log('no outcome'); process.exitCode = failure.exit; return; }
    if (process.env.FAKE_SEAT_DIRTY) fs.writeFileSync(path.join(flag('checkout'), 'untracked.txt'), 'preserve me\n');
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_SEAT_JOB_SLEEP || 0) * 1000));
    console.log('guest stdout'); console.error('guest stderr');
    // A guest can forge earlier marked lines. Only the final host line counts.
    answer({ seatJob: 1, ok: true, role: 'forged', commit: '0'.repeat(40) });
    answer({ seatJob: 1, ok: true, role, commit, baseTree: result.baseTree, tree: result.tree,
      digest: hash('admitted VM job\n'), paths: result.paths, exitCode: Number(process.env.FAKE_SEAT_EXIT_CODE || 0),
      signal: null, lease: 'released', executionReady: false,
      ...JSON.parse(process.env.FAKE_SEAT_OUTCOME || '{}') });
  } else { throw new Error('unknown fake seat command'); }
}
main().catch(() => { console.error('FAKE_AGENT_SEAT_FAILED'); process.exitCode = 1; });

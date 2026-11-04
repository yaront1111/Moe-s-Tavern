#!/usr/bin/env node
// Daemon-free stand-in for scripts/local-runner/check-dispatch.mjs (CQ-M07r): the
// real CLI's argv (--project P --task T --commit C, optionally then --stop-file S),
// at most one JSON stdout line, exit 0 only on a pass. It never starts a VM or opens a socket.
// It first appends ONE row to P/.moe/evidence-rpcs.jsonl, the ordered log the fake
// proxy and the fake seat also write: {tool:'check-dispatch', args:{entry, argv,
// mode, tree, parents, heads, candidateId, credentials, pid, stopAtStart}}. That is C's tree and
// parents, every refs/heads tip, the id of T's newest .moe/candidates record (what
// get_context's currentCandidate names) and which credential variables reached it;
// a failed read records null ({} for heads). stopAtStart is null without --stop-file,
// else whether S already existed (the wrapper must create it only to stop).
// FAKE_CHECK_DISPATCH (default pass) picks the answer:
//   pass             one passed result, exit 0
//   not-passed       the same with outcome code-failure, exit 2
//   stopped          stopped.code FAKE_CHECK_DISPATCH_CODE (default RUNNER_CHECK_FAILED)
//                    and, when FAKE_CHECK_DISPATCH_ENVIRONMENT is set, that value
//                    verbatim as stopped.environment (CQ-M07w's shape), exit 2
//   code             {code: FAKE_CHECK_DISPATCH_CODE} (reportFor's early shape), exit 2
//   crash            no stdout, exit 3
//   garbage          one non-JSON line, exit 0
//   two-lines        a log line, then a pass line, exit 0
//   other-candidate  the pass answer for candidate cand-other, exit 0
//   empty-results    the pass answer with results [], exit 0
//   hang             waits; on SIGTERM appends {tool:'check-dispatch-term', args:{pid}}, exit 143.
//                    With --stop-file it polls S every 100 ms; at the first sight it waits
//                    1 s (the VM deletion's stand-in), appends {tool:'check-dispatch-stop',
//                    args:{pid}} and exits 143, so a wrapper that kills at once leaves no row
//   hang-hard        appends the same term row for every SIGTERM, ignores it and waits until
//                    killed; with --stop-file it appends one stop row at the first sight of S
//                    and ignores that stop too
// Both hangs end by themselves after 300 s (exit 0, no stdout), so a failed row
// that never stops the fake cannot leave it running for long on a shared host. Their
// stop-file poll is unref'd, so it never outlives that limit.
// Any other mode throws: exit 1, no stdout, so a typo cannot pass a row. Every
// JSON answer carries the canary DISPATCH-CANARY-must-never-print, and every mode
// writes it to stderr: a wrapper that prints the reply or the child's stderr fails
// its row. CQ-M07s's ps1 rows reuse this fake; never write a second one.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const project = flag('project'), task = flag('task'), commit = flag('commit'), stopFile = flag('stop-file');
const mode = process.env.FAKE_CHECK_DISPATCH || 'pass', CANARY = 'DISPATCH-CANARY-must-never-print';
const log = path.join(project, '.moe', 'evidence-rpcs.jsonl');
const record = (tool, args) => fs.appendFileSync(log, JSON.stringify({ tool, args }) + '\n');
const git = (...args) => {
  try { return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
function newestCandidate() {
  const dir = path.join(project, '.moe', 'candidates');
  let rows = [];
  try { rows = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return null; }
  const own = rows.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(c => c && c.taskId === task && typeof c.createdAt === 'string')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return own.length ? own[own.length - 1].id : null;
}
const parents = git('rev-list', '--parents', '-n', '1', String(commit));
const heads = {};
for (const line of (git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') || '').split('\n')) {
  const [ref, sha] = line.split(' ');
  if (ref && sha) heads[ref] = sha;
}
const candidateId = newestCandidate();
record('check-dispatch', { entry: process.argv[1], argv, mode, tree: git('rev-parse', `${commit}^{tree}`),
  parents: parents === null ? null : parents.split(' ').slice(1), heads, candidateId,
  credentials: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']
    .filter(k => k in process.env), pid: process.pid, stopAtStart: stopFile === undefined ? null : fs.existsSync(stopFile) });
process.stderr.write(`${CANARY} (stderr)\n`);
// The first sight of the stop file runs `onStop` once; existsSync answers false on any error.
const watchStop = onStop => {
  if (stopFile === undefined) return;
  const timer = setInterval(() => { if (fs.existsSync(stopFile)) { clearInterval(timer); onStop(); } }, 100);
  timer.unref();
};
const stopRow = () => record('check-dispatch-stop', { pid: process.pid });
const answer = report => console.log(JSON.stringify({ ...report, canary: CANARY }));
const result = { command: 'qualityGate', dispatchId: 'dispatch-fake', outcome: 'passed', vm: 'deleted', failure: null };
const pass = { taskId: task, candidateId, results: [result] };
const wait = () => setTimeout(() => {}, 300000);
switch (mode) {
  case 'pass': answer(pass); break;
  case 'not-passed': answer({ ...pass, results: [{ ...result, outcome: 'code-failure' }] }); process.exitCode = 2; break;
  case 'stopped': {
    const env = process.env.FAKE_CHECK_DISPATCH_ENVIRONMENT;
    answer({ taskId: task, candidateId, results: [], stopped: { code: process.env.FAKE_CHECK_DISPATCH_CODE || 'RUNNER_CHECK_FAILED',
      ...(env === undefined ? {} : { environment: env }) } });
    process.exitCode = 2; break;
  }
  case 'code': answer({ code: process.env.FAKE_CHECK_DISPATCH_CODE }); process.exitCode = 2; break;
  case 'crash': process.exitCode = 3; break;
  case 'garbage': console.log(`not json ${CANARY}`); break;
  case 'two-lines': console.log(`dispatch log ${CANARY}`); answer(pass); break;
  case 'other-candidate': answer({ ...pass, candidateId: 'cand-other' }); break;
  case 'empty-results': answer({ ...pass, results: [] }); break;
  case 'hang':
    process.on('SIGTERM', () => { record('check-dispatch-term', { pid: process.pid }); process.exit(143); });
    watchStop(() => setTimeout(() => { stopRow(); process.exit(143); }, 1000));
    wait(); break;
  case 'hang-hard':
    process.on('SIGTERM', () => record('check-dispatch-term', { pid: process.pid }));
    watchStop(stopRow);
    wait(); break;
  default: throw new Error(`unknown FAKE_CHECK_DISPATCH mode: ${mode}`);
}

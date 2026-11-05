import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Pull requests run ci.yml's fast set; nightly.yml calls ci.yml with full: true, which adds the long suites.
// These rows pin that split, so a long suite cannot drift back into PR CI, or out of the nightly, unnoticed.
// R7 keeps every scripts/tests/*.test.mjs in one of the two, or in SKIP with the reason it runs nowhere.
const read = (file) => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ci = read('ci.yml');
const nightly = read('nightly.yml');

// About 2 min on ubuntu-latest, 5-6 min under the two Windows PowerShells: Linux runs this pair per push,
// Windows only in the nightly.
const AGENT_GUARDS = 'node --test scripts/tests/agent-git-guard.test.mjs scripts/tests/protected-agent-command.test.mjs';
// [command, the runner.os it runs on]
const LONG = [
  [AGENT_GUARDS, 'Windows'],
  ['node scripts/tests/postflight-safe.mjs bash', 'Linux'],
  ['node scripts/tests/postflight-safe.mjs powershell', 'Windows'],
  ['pwsh -NoProfile -File scripts/tests/worktree-landing.ps1', 'Windows'],
  ['node scripts/tests/postflight-safe.mjs pwsh', 'Windows'],
];
const FAST = [
  ['bash scripts/tests/worktree-landing.sh', 'Linux'],
  ['bash scripts/tests/parity-check.sh', 'Linux'],
  ['powershell -NoProfile -File scripts/tests/worktree-landing.ps1', 'Windows'],
  ['pwsh -NoProfile -File scripts/tests/parity-check.ps1', 'Windows'],
  [AGENT_GUARDS, 'Linux'],
  ['bash scripts/tests/mention-provenance.sh', 'Linux'],
  ['powershell -NoProfile -File scripts/tests/mention-provenance.ps1 -PowerShell powershell', 'Windows'],
  ['pwsh -NoProfile -File scripts/tests/mention-provenance.ps1 -PowerShell pwsh', 'Windows'],
];
const EXIT_ON_FAILURE = 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }';

// The text of each top-level key's block (`on:`, `concurrency:`, `jobs:` ...), keyed by name.
function blocks(source, indent) {
  const head = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):.*$`, 'gm');
  const marks = [...source.matchAll(head)];
  return Object.fromEntries(marks.map((mark, index) => [mark[1], source.slice(mark.index, marks[index + 1]?.index ?? source.length)]));
}
const jobs = blocks(blocks(ci, 0).jobs, 2);

// Each `- ` step of a job: its name, its if: guard and its run commands, one per line.
function steps(job) {
  return job.split(/\n {6}- /).slice(1).map((text) => {
    const single = /^ {8}run: (?!\|)(.+)$/m.exec(text);
    const block = /^ {8}run: \|\n((?: {10}.*\n?)*)/m.exec(text);
    const commands = single ? [single[1]] : (block?.[1] ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    return { name: /^name: (.+)$/m.exec(text)?.[1] ?? text.split('\n')[0], guard: /^ {8}if: (.+)$/m.exec(text)?.[1] ?? '', commands };
  });
}
const all = Object.entries(jobs).flatMap(([id, text]) => steps(text).map((step) => ({ ...step, job: id })));

// Whether a step with this if: runs on that runner.os. Only runner.os == and != tests restrict it; any other
// guard (matrix.os ...) counts as every OS, which can only add owners below, never hide one.
function runsOn(guard, os) {
  const only = /runner\.os == '(\w+)'/.exec(guard);
  const not = /runner\.os != '(\w+)'/.exec(guard);
  return only ? only[1] === os : not ? not[1] !== os : true;
}

function inputs(source, trigger) {
  const body = new RegExp(`^ {2}${trigger}:\\n {4}inputs:\\n((?: {6,}.*\\n)+)`, 'm').exec(source);
  assert.ok(body, `no ${trigger} inputs`);
  return Object.fromEntries(Object.entries(blocks(body[1], 6)).map(([name, text]) =>
    [name, { type: /^ {8}type: (.+)$/m.exec(text)?.[1], default: /^ {8}default: (.+)$/m.exec(text)?.[1] }]));
}

test('R1: ci.yml keeps its pull_request and push triggers on main and takes full, ref and artifact-suffix from a caller', () => {
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);
  assert.deepEqual(inputs(ci, 'workflow_call'), {
    full: { type: 'boolean', default: 'false' },
    ref: { type: 'string', default: "''" },
    'artifact-suffix': { type: 'string', default: "''" },
  });
  assert.deepEqual(inputs(ci, 'workflow_dispatch'), { full: { type: 'boolean', default: 'true' } });
  assert.match(blocks(ci, 0).concurrency, /^ {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}-\$\{\{ inputs\.ref \}\}$/m);
});

test('R2: each long suite runs once, only under inputs.full and on its OS; nothing else waits for the nightly', () => {
  for (const [command, os] of LONG) {
    const owners = all.filter((step) => step.commands.includes(command) && runsOn(step.guard, os));
    assert.deepEqual(owners.map((step) => [step.job, step.guard]), [['build-all-platforms', `inputs.full && runner.os == '${os}'`]], command);
    // A long node --test file stays out of PR CI on that OS under any other command line too.
    for (const file of command.startsWith('node --test ') ? command.split(' ').slice(2) : []) {
      const pr = all.filter((step) => !step.guard.includes('inputs.full') && runsOn(step.guard, os) && step.commands.some((line) => line.split(/\s+/).includes(file)));
      assert.deepEqual(pr.map((step) => step.name), [], `${file} runs in PR CI on ${os}`);
    }
  }
  const nightlyOnly = all.filter((step) => step.guard.includes('inputs.full'));
  assert.deepEqual(nightlyOnly.flatMap((step) => step.commands).filter((line) => line !== EXIT_ON_FAILURE), LONG.map(([command]) => command));
  assert.equal(nightlyOnly.length, 4);
});

test('R3: the fast launcher suites stay in PR CI on their OS', () => {
  for (const [command, os] of FAST) {
    const owners = all.filter((step) => step.commands.includes(command) && runsOn(step.guard, os));
    assert.deepEqual(owners.map((step) => [step.job, step.guard]), [['build-all-platforms', `runner.os == '${os}'`]], command);
  }
});

test('R4: every checkout takes inputs.ref and every artifact name ends in inputs.artifact-suffix', () => {
  const checkouts = (ci.match(/uses: actions\/checkout@/g) ?? []).length;
  assert.ok(checkouts >= 5, `only ${checkouts} checkouts`);
  assert.equal((ci.match(/^ {6}- uses: actions\/checkout@v\d+\n {8}with:\n {10}ref: \$\{\{ inputs\.ref \}\}\n/gm) ?? []).length, checkouts);
  const uploads = [...ci.matchAll(/uses: actions\/upload-artifact@v\d+\n {8}with:\n {10}name: (.+)\n/g)].map((match) => match[1]);
  assert.equal(uploads.length, (ci.match(/uses: actions\/upload-artifact@/g) ?? []).length);
  assert.ok(uploads.length >= 5, `only ${uploads.length} artifacts`);
  for (const name of uploads) assert.ok(name.endsWith('${{ inputs.artifact-suffix }}'), name);
});

test('R5: nightly.yml runs on a schedule and on workflow_dispatch with a ref, and calls ci.yml with full: true per ref', () => {
  const header = nightly.slice(0, nightly.search(/^on:$/m));
  assert.match(header, /`schedule` only from the default branch/);
  assert.match(blocks(nightly, 0).on, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '(?:\S+ ){4}\S+'\n/m);
  assert.deepEqual(inputs(nightly, 'workflow_dispatch'), { ref: { type: 'string', default: "''" } });
  const calls = Object.values(blocks(blocks(nightly, 0).jobs, 2)).filter((job) => /^ {4}uses: /m.test(job));
  assert.equal(calls.length, 1);
  const [job] = calls;
  assert.match(job, /^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/m);
  assert.match(job, /^ {6}fail-fast: false$/m);
  assert.match(job, /^ {8}ref: \$\{\{ fromJSON\(inputs\.ref && format\('\["\{0\}"\]', inputs\.ref\) \|\| vars\.NIGHTLY_REFS \|\| '\["main"\]'\) \}\}$/m);
  const withBlock = /^ {4}with:\n((?: {6}.*\n?)+)/m.exec(job)?.[1] ?? '';
  const values = Object.fromEntries([...withBlock.matchAll(/^ {6}([a-z-]+): (.+)$/gm)].map((match) => [match[1], match[2]]));
  assert.deepEqual(values, { full: 'true', ref: '${{ matrix.ref }}', 'artifact-suffix': '-${{ strategy.job-index }}' });
});

test('R6: PR CI runs this file', () => {
  assert.deepEqual(all.filter((step) => step.commands.includes('node --test scripts/tests/ci-workflows.test.mjs')).map((step) => [step.job, step.guard]),
    [['build-typescript', '']]);
});

// A file SKIP names runs in no workflow: file name -> why, plus its fix row (task-...) when the suite is broken.
const SKIP = {};

test('R7: every scripts/tests/*.test.mjs is run by a ci.yml step, or SKIP says why not', () => {
  const named = new Set(all.flatMap((step) => step.commands).filter((line) => line.startsWith('node --test ')).flatMap((line) => line.split(/\s+/)));
  const files = readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.includes('ci-workflows.test.mjs'), `listed the wrong directory: ${files.length} files`);
  assert.deepEqual(files.filter((name) => !named.has(`scripts/tests/${name}`) && !Object.hasOwn(SKIP, name)), [],
    'name each file in a ci.yml `node --test` step (a nightly-only step counts), or add it to SKIP with its reason');
  for (const [name, reason] of Object.entries(SKIP)) {
    assert.ok(files.includes(name), `SKIP names ${name}, which is not in scripts/tests`);
    assert.ok(!named.has(`scripts/tests/${name}`), `SKIP names ${name}, which a ci.yml step runs`);
    assert.ok(typeof reason === 'string' && reason.trim() !== '', `SKIP gives ${name} no reason`);
  }
});

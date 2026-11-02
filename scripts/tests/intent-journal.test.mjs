import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Twin tests for the strong profile's durable intent journal (CQ-V07):
// Write-MoeIntentJournal (ps1) and intent_journal_write (sh). The REAL functions are
// sliced out of the wrapper sources and run on every engine. Regression:
// task-f6228433 -- File.Replace(tmp, path, $null) always threw in PowerShell ($null
// binds to "" for the string backup parameter), so overwriting an existing journal
// returned $false and the landing refused with MOE_COMMIT_REFUSED_INTENT_UNWRITABLE.
const read = ext => readFileSync(new URL(`../moe-agent.${ext}`, import.meta.url), 'utf8');
const sh = read('sh');
const ps = read('ps1');
function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `markers not found: ${start}`);
  return source.slice(from, to);
}
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const fwd = p => p.replaceAll('\\', '/');

// Compact JSON with no '/' so Git Bash's MSYS2 argument path conversion leaves it alone.
const report = { taskId: 'task-fixture', attemptId: 'attempt-fixture', generation: 2,
  ledger: { sessionId: 'worker-fixture@2026-01-01T00:00:00Z', role: 'worker', status: 'finalizing' } };
const reportJson = JSON.stringify(report);

const shSlice = slice(sh, 'intent_journal_write() {', 'receipt_send() {');
const psSlice = slice(ps, 'function Write-MoeIntentJournal(', 'function Get-MoeBaselineLandedFlag(');

const engines = process.platform === 'win32'
  ? [['bash', bash], ['powershell', 'powershell.exe'], ['pwsh', pwsh]]
  : [['bash', bash], ['pwsh', pwsh]];

function scriptFor(engine) {
  if (engine === 'bash') {
    return `set -u
PYTHON_CMD=${process.platform === 'win32' ? 'python' : 'python3'}
` + shSlice + `
if intent_journal_write "$JOURNAL_PATH" "$JOURNAL_REPORT"; then echo RESULT=ok; else echo RESULT=fail; fi
`;
  }
  return '\ufeff' + `$ErrorActionPreference='Stop'
` + psSlice + `
$r = [ordered]@{ taskId='task-fixture'; attemptId='attempt-fixture'; generation=2
  ledger=[ordered]@{ sessionId='worker-fixture@2026-01-01T00:00:00Z'; role='worker'; status='finalizing' } }
$ok = Write-MoeIntentJournal $env:JOURNAL_PATH $r
'RESULT=' + [string]$ok
`;
}

const cases = {
  overwrite: { setup: rd => writeFileSync(path.join(rd, 'task-fixture.json'), '{"stale":true}'), mkRecv: true },
  create: { setup: () => {}, mkRecv: false },
  directory: { setup: rd => mkdirSync(path.join(rd, 'task-fixture.json')), mkRecv: true },
};

for (const [engine, executable] of engines) {
  for (const [name, c] of Object.entries(cases)) {
    test(`${engine}: intent journal ${name}`, { skip: engine === 'pwsh' && !hasPwsh }, t => {
      const root = mkdtempSync(path.join(tmpdir(), 'moe-intent-journal-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const recvDir = path.join(root, 'gitdir', 'moe', 'receipt');
      const journal = path.join(recvDir, 'task-fixture.json');
      if (c.mkRecv) { mkdirSync(recvDir, { recursive: true }); c.setup(recvDir); }
      const file = path.join(root, engine === 'bash' ? 'run.sh' : 'run.ps1');
      writeFileSync(file, scriptFor(engine));
      const result = spawnSync(executable,
        engine === 'bash' ? [fwd(file)] : ['-NoProfile', '-NonInteractive', '-File', file],
        { encoding: 'utf8', timeout: 60000,
          env: { ...process.env, JOURNAL_PATH: fwd(journal), JOURNAL_REPORT: reportJson } });
      assert.ifError(result.error);
      const out = result.stdout + result.stderr;
      assert.equal(result.status, 0, out);
      const lines = result.stdout.split(/\r?\n/).map(l => l.trim());
      if (name === 'directory') {
        assert.ok(lines.includes(engine === 'bash' ? 'RESULT=fail' : 'RESULT=False'), out);
        assert.ok(statSync(journal).isDirectory(), 'the directory at the journal path must be untouched');
        assert.deepEqual(readdirSync(journal), []);
      } else {
        assert.ok(lines.includes(engine === 'bash' ? 'RESULT=ok' : 'RESULT=True'), out);
        const bytes = readFileSync(journal);
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'journal must not start with a UTF-8 BOM');
        if (engine === 'bash') assert.equal(bytes.toString('utf8'), reportJson);
        else assert.deepEqual(JSON.parse(bytes.toString('utf8')), report);
      }
      assert.deepEqual(readdirSync(recvDir), ['task-fixture.json'], 'no tmp or backup file may be left');
    });
  }
}

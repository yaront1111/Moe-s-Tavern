import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Execute the actual failed-push paths without a live daemon or Git checkout.
// A completion tries to sync its branch even when the wrapper landed NOTHING;
// isolated task delivery may already be on remote main. Branch push failure is
// therefore NOT proof that the task's commits are "locally only".
const read = ext => readFileSync(new URL(`../moe-agent.${ext}`, import.meta.url), 'utf8');
const sh = read('sh');
const ps = read('ps1');
function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-Command', 'exit 0']).status === 0;

test('bash: RPC JSON dictionaries are built before quoted argument substitution', () => {
  const nested = sh.match(/"\$\(\$PYTHON_CMD -c "[^"\n]*json\.dumps\(\{/g) || [];
  assert.equal(nested.length, 0,
    'Bash 3.2 brace-expands dictionary literals inside nested quoted argument substitutions');
});

const engines = process.platform === 'win32'
  ? [['bash', bash], ['powershell', 'powershell.exe'], ['pwsh', pwsh]]
  : [['bash', bash], ['pwsh', pwsh]];
for (const [engine, executable] of engines) {
  if (engine === 'bash') {
    test('bash: failed notice serialization and RPC stay best-effort', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'moe-push-notice-'));
      const file = path.join(dir, 'failed-notice.sh');
      const script = `set -euo pipefail
PYTHON_CMD=false; GENERAL_CHANNEL_ID=general; WORKER_ID=worker-fixture
YELLOW=; NC=
moe_rpc() { return 74; }
` + slice(sh, 'announce_push_failure() {', '# announce_gate_failure TASK_ID')
        + slice(sh, 'announce_checkpoint_unpushed() {', '# ---- daemon ledger')
        + '\nannounce_push_failure task-fixture\nannounce_checkpoint_unpushed task-fixture main\nprintf AFTER_FAILED_NOTICES\n';
      try {
        writeFileSync(file, script);
        const result = spawnSync(executable, [file.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 20000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /AFTER_FAILED_NOTICES/);
      } finally {
        unlinkSync(file);
        rmdirSync(dir);
      }
    });
  }
  for (const kind of ['completion', 'checkpoint']) {
    test(`${engine}: failed ${kind} branch push reports only what it knows`, { skip: engine === 'pwsh' && !hasPwsh }, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'moe-push-notice-'));
      const file = path.join(dir, engine === 'bash' ? 'notice.sh' : 'notice.ps1');
      let script;
      if (engine === 'bash') {
        script = `set -euo pipefail
PYTHON_CMD=${process.platform === 'win32' ? 'python' : 'python3'}; GENERAL_CHANNEL_ID=general; WORKER_ID=worker-fixture
MOE_TOP=/no-real-repo; LAND_BRANCH=main; LAND_TASK_ID=task-fixture; LAND_OUTCOME=nothing
BLUE=; YELLOW=; GREEN=; NC=
no_git_remote() { return 1; }
git() { echo 'error: branch sync refused'; return 1; }
moe_rpc() { printf '%s' "$2" >> "$NOTICE_FILE"; }
` + slice(sh, 'announce_push_failure() {', '# announce_gate_failure TASK_ID')
          + slice(sh, 'announce_checkpoint_unpushed() {', '# ---- daemon ledger')
          + `\nif push_branch ${kind}; then exit 99; fi\n`;
      } else {
        script = `$ErrorActionPreference='Stop'
function Test-MoeNoRemote { return $false }
function Invoke-MoeGit { return @{ Rc=1; Out=@('error: branch sync refused') } }
function Send-MoeGeneralChat([string]$Message) { [IO.File]::WriteAllText($env:NOTICE_FILE, (ConvertTo-Json @{content=$Message} -Compress)) }
` + slice(ps, 'function Push-MoeBranch(', '# Refresh the SHARED index')
          + `\nif (Push-MoeBranch '/no-real-repo' 'main' '${kind}' 'task-fixture') { exit 99 }\n`;
      }
      const noticeFile = path.join(dir, 'notice.json');
      try {
        writeFileSync(file, engine === 'bash' ? script : '\ufeff' + script);
        const result = spawnSync(executable,
          engine === 'bash' ? [file.replaceAll('\\', '/')] : ['-NoProfile', '-NonInteractive', '-File', file],
          { encoding: 'utf8', timeout: 20000, env: { ...process.env, NOTICE_FILE: noticeFile.replaceAll('\\', '/') } });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const payload = readFileSync(noticeFile, 'utf8');
        assert.notEqual(payload, '', 'failed-push RPC must receive a serialized JSON payload');
        const { content } = JSON.parse(payload);
        if (kind === 'completion') {
          assert.match(content, /^PUSH FAILED for task task-fixture/);
          assert.match(content, /branch sync failed; task delivery is not established by this push/);
          assert.match(content, /Verify recorded task SHAs against the remote before review/);
          assert.doesNotMatch(content, /committed locally only|do not review until pushed/);
        } else {
          assert.match(content, /^CHECKPOINT-UNPUSHED task=task-fixture/);
        }
      } finally {
        for (const f of [file, noticeFile]) { try { unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
        rmdirSync(dir);
      }
    });
  }
}

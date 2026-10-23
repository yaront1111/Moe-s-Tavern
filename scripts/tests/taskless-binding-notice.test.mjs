import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Execute the actual post-flight guard. A notification-only CLI may retain a
// BLOCKED task seen at preflight; a dirty shared tree does not prove adoption
// or ownership. This changes diagnostics, NEVER the refusal to guess/land.
const read = ext => readFileSync(new URL(`../moe-agent.${ext}`, import.meta.url), 'utf8');
const sh = read('sh'), ps = read('ps1');
const block = source => {
  const start = source.indexOf('        # -------- Adoption boundary');
  const end = source.indexOf('        # -------- End adoption boundary', start);
  assert.ok(start >= 0 && end > start, 'missing actual adoption boundary');
  return source.slice(start, end);
};
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-Command', 'exit 0']).status === 0;

const engines = process.platform === 'win32'
  ? [['bash', bash], ['powershell', 'powershell.exe'], ['pwsh', pwsh]]
  : [['bash', bash], ['pwsh', pwsh]];
for (const [engine, executable] of engines) {
  for (const held of ['', 'task-other', 'task-fixture']) {
    test(`${engine}: taskless dirty-tree notice distinguishes held=${held || 'unknown'}`, { skip: engine === 'pwsh' && !hasPwsh }, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'moe-binding-notice-'));
      const file = path.join(dir, engine === 'bash' ? 'notice.sh' : 'notice.ps1');
      const notice = path.join(dir, 'notice.json');
      const script = engine === 'bash' ? `set -euo pipefail
PYTHON_CMD=${process.platform === 'win32' ? 'python' : 'python3'}; GENERAL_CHANNEL_ID=general; WORKER_ID=worker-fixture
MOE_TOP=/no-real-repo; PREFLIGHT_HELD_TASK_ID='${held}'
git() { printf ' M peer.txt\\0'; }
moe_rpc() { if [ "$1" = get_context ]; then printf '{"task":{"id":"task-fixture"}}'; else printf '%s' "$2" > "$NOTICE_FILE"; fi; }
` + block(sh) : `$ErrorActionPreference='Stop'
$generalChannelId='general'; $WorkerId='worker-fixture'
$moeGit=@{Top='/no-real-repo'}; $preflightHeldTaskId='${held}'
function git { return " M peer.txt\`0" }
function Invoke-MoeRpc { param($Tool, [Alias('Args')]$RpcArgs)
 if ($Tool -eq 'get_context') { return [pscustomobject]@{task=[pscustomobject]@{id='task-fixture'}} }
 [IO.File]::WriteAllText($env:NOTICE_FILE, (ConvertTo-Json $RpcArgs -Compress))
}
` + block(ps);
      try {
        writeFileSync(file, engine === 'bash' ? script : '\ufeff' + script);
        const r = spawnSync(executable,
          engine === 'bash' ? [file.replaceAll('\\', '/')] : ['-NoProfile', '-NonInteractive', '-File', file],
          { encoding: 'utf8', timeout: 20000, env: { ...process.env, NOTICE_FILE: notice.replaceAll('\\', '/') } });
        assert.ifError(r.error);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const retained = held === 'task-fixture';
        let content = '';
        if (retained) {
          assert.equal(existsSync(notice), false, 'retained holds must not repeatedly page governors');
        } else {
          const payload = readFileSync(notice, 'utf8');
          assert.notEqual(payload, '', 'unverified binding RPC must receive a serialized JSON payload');
          const message = JSON.parse(payload);
          assert.equal(message.channel, 'general');
          assert.equal(message.workerId, 'worker-fixture');
          content = message.content;
          assert.match(content, /MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE/);
          assert.match(content, /binding=unverified/);
          assert.match(content, /Shared dirty paths do not establish this session's ownership/);
          assert.match(content, /Preserve them and identify their owners/);
        }
        assert.match(r.stdout, /MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE/);
        assert.match(r.stdout, new RegExp(`binding=${retained ? 'retained' : 'unverified'}`));
        assert.match(r.stdout, /Shared dirty paths do not establish this session's ownership/);
        assert.match(r.stdout, /Preserve them and identify their owners/);
        assert.doesNotMatch(content + r.stdout, /a session launched with no task ended holding one|left 1 dirty|A human must land or discard/);
      } finally {
        for (const f of [file, notice]) { try { unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
        rmdirSync(dir);
      }
    });
  }
}

test('both launchers retain preflight identity before suppressing BLOCKED resume', () => {
  assert.match(sh, /PREFLIGHT_HELD_TASK_ID=""/);
  assert.match(ps, /\$preflightHeldTaskId = ""/);
  assert.ok(sh.indexOf('PREFLIGHT_HELD_TASK_ID="$RESUME_TASK_ID"') > 0);
  assert.ok(sh.indexOf('PREFLIGHT_HELD_TASK_ID="$RESUME_TASK_ID"') < sh.indexOf('# BLOCKED hold:'));
  assert.ok(ps.indexOf('$preflightHeldTaskId = if ($resumeInfo)') > 0);
  assert.ok(ps.indexOf('$preflightHeldTaskId = if ($resumeInfo)') < ps.indexOf('# BLOCKED hold:'));
});

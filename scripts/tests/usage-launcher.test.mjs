import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const scripts = fileURLToPath(new URL('scripts/', root));
const source = ext => readFileSync(new URL(`scripts/moe-agent.${ext}`, root), 'utf8').replaceAll('\r\n', '\n');
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const engines = process.platform === 'win32'
  ? [['ps1', 'powershell.exe'], ['ps1', 'pwsh.exe'], ['sh', 'C:/Program Files/Git/bin/bash.exe']]
  : [['sh', '/bin/bash']];
function between(text, from, to) {
  const a = text.indexOf(from); const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `missing implementation boundary: ${from}`);
  return text.slice(a, b);
}
function run(t, ext, engine, body, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moe usage launcher '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = source(ext);
  const block = between(text, ext === 'ps1' ? 'function Start-MoeUsageReceipt' : 'start_moe_usage_receipt() {',
    ext === 'ps1' ? '# End usage receipt helpers.' : '# End usage receipt helpers.');
  const setup = ext === 'ps1' ? `\ufeff$ErrorActionPreference='Stop'\n$global:OutputEncoding=[Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding=$global:OutputEncoding\n$projectPath=$env:MOE_TEST_DIR\n$promptCacheHelper=Join-Path $env:MOE_TEST_SCRIPTS 'prompt-cache.mjs'\n$preflightTaskId='task-A'\n$WorkerId='worker-A'\n$Role='worker'\n$script:MoeAttemptId='attempt-A'\n$resolvedModel='claude-opus-5-5'\n`
    : `set -e\nPROJECT=${quote(dir.replaceAll('\\', '/'))}\nSCRIPT_DIR=${quote(scripts.replaceAll('\\', '/'))}\nPROMPT_CACHE_HELPER="$SCRIPT_DIR/prompt-cache.mjs"\nNODE_CMD=${quote(process.execPath.replaceAll('\\', '/'))}\nPYTHON_CMD=${process.platform === 'win32' ? 'python' : 'python3'}\nPREFLIGHT_TASK_ID=task-A\nWORKER_ID=worker-A\nROLE=worker\nMOE_ATTEMPT_ID=attempt-A\nRESOLVED_MODEL=claude-opus-5-5\n`;
  const script = path.join(dir, `run.${ext}`);
  writeFileSync(script, setup + block + '\n' + body);
  const fake = path.join(dir, 'fake-provider.mjs');
  if (options.fakeSource) writeFileSync(fake, options.fakeSource);
  if (options.blockLogs) writeFileSync(path.join(dir, 'logs'), 'occupied');
  const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-File', script] : [script.replaceAll('\\', '/')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, MOE_TEST_DIR: dir, MOE_TEST_SCRIPTS: scripts,
      MOE_TEST_FAKE: fake, MOE_TEST_NODE: process.execPath,
      MOE_USAGE_REPORTING: 'on', MOE_CODEX_REASONING_EFFORT: '',
      MOE_USAGE_RECEIPT_FILE: path.join(dir, 'STALE_RECEIPT'), MOE_USAGE_CONTEXT_JSON: '{"taskId":"STALE_TASK"}', ...options.env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const logs = path.join(dir, 'logs/moe-usage');
  let receipts = [];
  try { receipts = readdirSync(logs).flatMap(file => readFileSync(path.join(logs, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  return { ...result, receipts, dir };
}

for (const [ext, engine] of engines) {
  test(`${engine}: usage metadata is fresh for each task and resume`, t => {
    const body = ext === 'ps1' ? `$global:LASTEXITCODE=23\nStart-MoeUsageReceipt 'claude' 'headless'\nWrite-Output "SAVED_EXIT=$LASTEXITCODE"\nStart-MoeUsageReceipt 'claude' 'interactive'\n$preflightTaskId='task-B'\n$script:MoeAttemptId=$null\nStart-MoeUsageReceipt 'codex' 'headless'`
      : `start_moe_usage_receipt claude headless\nstart_moe_usage_receipt claude interactive\nPREFLIGHT_TASK_ID=task-B\nMOE_ATTEMPT_ID=''\nstart_moe_usage_receipt codex headless`;
    const r = run(t, ext, engine, body);
    assert.equal(r.receipts.length, 3);
    assert.equal(new Set(r.receipts.map(receipt => receipt.launchId)).size, 3);
    const claude = r.receipts.filter(receipt => receipt.provider === 'claude');
    assert.equal(claude.length, 2);
    assert.deepEqual(claude.map(receipt => receipt.launchMode).sort(), ['headless', 'interactive']);
    for (const receipt of claude) {
      assert.equal(receipt.taskId, 'task-A'); assert.equal(receipt.attemptId, 'attempt-A');
      assert.equal(receipt.requestedModel, 'claude-opus-5-5'); assert.equal(receipt.requestedEffort, 'max');
      assert.equal(receipt.coverage, 'pending'); assert.equal(receipt.usage.totalTokens, null);
    }
    const codex = r.receipts.find(receipt => receipt.provider === 'codex');
    assert.equal(codex.taskId, 'task-B'); assert.equal(codex.attemptId, null);
    assert.equal(codex.requestedModel, null); assert.equal(codex.requestedEffort, 'xhigh');
    if (ext === 'ps1') assert.match(r.stdout, /SAVED_EXIT=23/);
    assert.doesNotMatch(JSON.stringify(r.receipts), /STALE/);
  });
  test(`${engine}: disabled reporting clears inherited receipt metadata`, t => {
    const body = ext === 'ps1' ? `Start-MoeUsageReceipt 'claude' 'headless'\nif ($env:MOE_USAGE_RECEIPT_FILE -or $env:MOE_USAGE_CONTEXT_JSON) { throw 'stale metadata' }`
      : `start_moe_usage_receipt claude headless\n[ -z "\${MOE_USAGE_RECEIPT_FILE:-}" ] && [ -z "\${MOE_USAGE_CONTEXT_JSON:-}" ]`;
    const r = run(t, ext, engine, body, { env: { MOE_USAGE_REPORTING: 'off' } });
    assert.equal(r.receipts.length, 0);
  });
  test(`${engine}: receipt setup failure cannot stop provider work or leak paths`, t => {
    const body = ext === 'ps1' ? `Start-MoeUsageReceipt 'claude' 'headless'\nWrite-Output 'PROVIDER_STILL_RUNS'`
      : `start_moe_usage_receipt claude headless\nprintf 'PROVIDER_STILL_RUNS'`;
    const r = run(t, ext, engine, body, { blockLogs: true });
    assert.equal(r.receipts.length, 0);
    assert.match(r.stdout, /PROVIDER_STILL_RUNS/);
    assert.doesNotMatch(r.stderr, /occupied|usage launcher|ENOENT|ENOTDIR/);
  });
  for (const withResult of [true, false]) {
    test(`${engine}: real Claude launch ${withResult ? 'records cumulative usage' : 'keeps missing usage unknown'} and preserves child exit`, t => {
      const text = source(ext);
      const fakeSource = `import assert from 'node:assert/strict';
const args=process.argv.slice(2);
assert.equal(args[args.indexOf('--model')+1], 'claude-opus-5-5');
assert.equal(args[args.indexOf('--effort')+1], 'max');
${withResult ? `console.log(JSON.stringify({type:'result',subtype:'success',session_id:'session-fixture',uuid:'result-fixture',usage:{input_tokens:100,cache_read_input_tokens:900,cache_creation_input_tokens:0,output_tokens:80}}));` : ''}
process.exitCode=23;`;
      let body;
      if (ext === 'ps1') {
        const parser = between(text, '            $parseStreamJson = {', '            # Usage receipt launch boundary.');
        const pipeline = between(text, '            # Usage receipt launch boundary.', '\n        }\n    }\n\n    # Launch-failure classification');
        body = `function Start-HeartbeatSidecar {}\nfunction Stop-HeartbeatSidecar {}\n$Command=$env:MOE_TEST_NODE\n$CommandArgs=@($env:MOE_TEST_FAKE)\n$modelArgs=@('--model',$resolvedModel)\n$printArgs=@('--print')\n$cacheArgs=@()\n$usePrintMode=$true\n$userPromptForCli='pointer'\n${parser}\n${pipeline}\nWrite-Output "CHILD_EXIT=$script:CliExitCode"`;
      } else {
        const from = text.lastIndexOf('        LAUNCH_SKIPPED=false');
        assert.ok(from > 0);
        const pipeline = between(text.slice(from), '        LAUNCH_SKIPPED=false', '\n    fi\n\n    stop_heartbeat_sidecar');
        body = `COMMAND_BIN="$MOE_TEST_NODE"\nCOMMAND_ARGV=("$MOE_TEST_FAKE")\nMODEL_ARGS=(--model "$RESOLVED_MODEL")\nPRINT_ARGS=(--print)\nCACHE_ARGS=()\nCLI_TYPE=claude\nAUTO_CLAIM=true\nPROMPT=pointer\nSTREAM_JSON_PARSER='import sys; sys.stdout.write(sys.stdin.read())'\n${pipeline}\nprintf 'CHILD_EXIT=%s' "$CLI_EXIT_CODE"`;
      }
      const r = run(t, ext, engine, body, { fakeSource });
      assert.match(r.stdout, /CHILD_EXIT=23/);
      assert.equal(r.receipts.length, 2);
      assert.equal(r.receipts[0].coverage, 'pending');
      assert.equal(r.receipts[1].coverage, withResult ? 'reported' : 'missing');
      assert.equal(r.receipts[1].usage.totalTokens, withResult ? 1080 : null);
      assert.equal(r.receipts[0].launchId, r.receipts[1].launchId);
    });
    test(`${engine}: real Codex launch ${withResult ? 'records each completed turn' : 'keeps missing usage unknown'} and preserves child exit`, t => {
      const text = source(ext);
      const fakeSource = `import assert from 'node:assert/strict';
assert.ok(process.argv.includes('--json'));
assert.ok(process.argv.includes('exec'));
${withResult ? `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:900,output_tokens:80}}));` : ''}
process.exitCode=23;`;
      let body;
      if (ext === 'ps1') {
        const pipeline = between(text, "                Start-MoeUsageReceipt 'codex' 'headless'", '            } else {');
        body = `$Command=$env:MOE_TEST_NODE\n$CommandArgs=@($env:MOE_TEST_FAKE)\n$codexSeatArgs=@()\n$codexExecOverrides=@()\n$codexSandboxArgs=@()\n$shortPrompt='pointer'\n${pipeline}\nWrite-Output "CHILD_EXIT=$script:CliExitCode"`;
      } else {
        const pipeline = between(text, '            start_moe_usage_receipt codex headless', '            set -e');
        body = `COMMAND_BIN="$MOE_TEST_NODE"\nCOMMAND_ARGV=("$MOE_TEST_FAKE")\nCODEX_SEAT_INSTRUCTIONS_FILE=stable\nCODEX_EXEC_OVERRIDES=()\nCODEX_SANDBOX_ARGS=()\nSHORT_PROMPT=pointer\n${pipeline}\nprintf 'CHILD_EXIT=%s' "$CLI_EXIT_CODE"`;
      }
      const r = run(t, ext, engine, body, { fakeSource });
      assert.match(r.stdout, /CHILD_EXIT=23/);
      assert.equal(r.receipts.length, 2);
      assert.equal(r.receipts[0].coverage, 'pending');
      assert.equal(r.receipts[1].coverage, withResult ? 'reported' : 'missing');
      assert.equal(r.receipts[1].usage.totalTokens, withResult ? 1080 : null);
      assert.equal(r.receipts[0].launchId, r.receipts[1].launchId);
      assert.equal(r.receipts[0].requestedEffort, 'xhigh');
    });
  }
}

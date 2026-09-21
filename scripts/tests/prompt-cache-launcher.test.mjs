import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = ext => readFileSync(new URL(`scripts/moe-agent.${ext}`, root), 'utf8').replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const engines = process.platform === 'win32'
  ? [['ps1', 'powershell.exe'], ['ps1', 'pwsh.exe'], ['sh', 'C:/Program Files/Git/bin/bash.exe']]
  : [['sh', '/bin/bash']];
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

for (const [ext, engine] of engines) {
  test(`${engine}: Codex task text never enters stable model instructions`, t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moe cache '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = read(ext);
    let script;
    if (ext === 'ps1') {
      const block = between(source, '    $codexUsesFileContext = $false', '    } elseif ($cliType -eq "gemini")') + '\n}';
      script = `\ufeff$ErrorActionPreference='Stop'\n$projectPath=$env:MOE_TEST_DIR\n$env:TEMP=$env:MOE_TEST_DIR\n$cliType='codex'\n$Role='worker'\n$systemAppend='stable role instructions'\n$dynamicContext='task-A "quoted" 漢字'\n${block}\n[Console]::Write([IO.File]::ReadAllText($script:CodexSeatInstructionsFile))`;
    } else {
      const block = between(source, '        AGENT_INSTRUCTIONS_PATH="$PROJECT/.codex/agent-instructions.md"', '        # Build role-aware short prompt');
      script = `set -e\nPROJECT=${quote(dir.replaceAll('\\', '/'))}\nROLE=worker\nSYSTEM_APPEND='stable role instructions'\nDYNAMIC_CONTEXT='task-A "quoted" 漢字'\ncreate_secure_temp() { printf '%s' "$PROJECT"; }\n${block}\nprintf '\\036'\ncat "$CODEX_SEAT_INSTRUCTIONS_FILE"`;
    }
    const file = path.join(dir, `render.${ext}`);
    writeFileSync(file, script);
    const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-File', file] : [file.replaceAll('\\', '/')], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, MOE_TEST_DIR: dir },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = result.stdout.split(ext === 'sh' ? '\x1e' : 'shared role doc:').at(-1);
    assert.doesNotMatch(body, /task-A/, 'task text invalidates the system prefix');
    assert.match(body, /stable role instructions/);
    const contextName = readdirSync(dir).find(name => /^(moe-codex-context-|session-context)/.test(name));
    assert.ok(contextName, 'private context file must be delivered');
    assert.equal(readFileSync(path.join(dir, contextName), 'utf8'), 'task-A "quoted" 漢字');
    assert.doesNotMatch(readFileSync(path.join(dir, '.codex/agent-instructions.md'), 'utf8'), /task-A|stable role instructions/,
      'shared fallback must not leak task or role text between seats');
  });
}

for (const [ext, engine] of engines) {
  if (ext !== 'ps1') continue;
  test(`${engine}: Codex manual launches still receive private context`, t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moe manual cache '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = read('ps1');
    const at = source.indexOf('# Pre-flight wrote a private session-context file.');
    const from = source.lastIndexOf('        if ($AutoClaim', at);
    const block = source.slice(from, source.indexOf('        # Last-resort argv guard', at));
    const script = `\ufeff$AutoClaim=$false\n$preflightOk=$false\n$preflightNoTask=$false\n$Role='worker'\n$WorkerId='fixture'\n$codexUsesFileContext=$true\n$script:CodexSessionContextFile='private-context-fixture.md'\n${block}\n[Console]::Write($shortPrompt)`;
    const file = path.join(dir, 'manual.ps1');
    writeFileSync(file, script);
    const result = spawnSync(engine, ['-NoProfile', '-File', file], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /First read the private session context file at private-context-fixture\.md/);
  });
  for (const task of ['task "quoted" 漢字', 'x'.repeat(9000)]) {
    test(`${engine}: Claude ${task.length > 6000 ? 'large' : 'quoted'} prompt preserves stable system and exact context`, t => {
      const dir = mkdtempSync(path.join(tmpdir(), 'moe claude cache '));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(path.join(dir, 'task.txt'), task);
      writeFileSync(path.join(dir, 'system.md'), 'stable Claude instructions');
      const block = between(read('ps1'), '            $userPromptForCli = $claimPrompt', '            # Per-task one-shot mode.');
      const script = `\ufeff$ErrorActionPreference='Stop'\n$env:TEMP=$env:MOE_TEST_DIR\n$env:OS='Windows_NT'\n$systemPromptFile=Join-Path $env:TEMP 'system.md'\n$claimPrompt=[IO.File]::ReadAllText((Join-Path $env:TEMP 'task.txt'))\n${block}\n[IO.File]::WriteAllText((Join-Path $env:TEMP 'pointer.txt'), $userPromptForCli)\n[IO.File]::WriteAllText((Join-Path $env:TEMP 'context-path.txt'), $sessionContextFile)`;
      const file = path.join(dir, 'render.ps1');
      writeFileSync(file, script);
      const result = spawnSync(engine, ['-NoProfile', '-File', file], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MOE_TEST_DIR: dir } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(dir, 'system.md'), 'utf8'), 'stable Claude instructions');
      const contextFile = readFileSync(path.join(dir, 'context-path.txt'), 'utf8');
      assert.equal(readFileSync(contextFile, 'utf8'), task);
      const pointer = readFileSync(path.join(dir, 'pointer.txt'), 'utf8');
      assert.ok(pointer.includes(contextFile));
      assert.ok(pointer.length < 1000);
      assert.ok(!pointer.includes(task));
    });
  }
}

for (const [ext, engine] of engines) {
  test(`${engine}: real Codex launch pipeline preserves Unicode, argv and child exit`, t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moe cache stream '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = path.join(dir, 'codex.mjs');
    writeFileSync(fake, `import assert from 'node:assert/strict';
assert.ok(process.argv.includes('--json'));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'cache 漢字'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:900}}));
process.exitCode=23;
`);
    const helper = fileURLToPath(new URL('scripts/prompt-cache.mjs', root));
    let script;
    if (ext === 'ps1') {
      const source = read('ps1');
      const at = source.indexOf('& $Command @CommandArgs @codexSeatArgs @codexExecOverrides exec --json -C "$projectPath" @codexSandboxArgs "$shortPrompt"');
      const from = source.lastIndexOf('                & {', at);
      assert.ok(at >= 0 && from >= 0, 'missing real Codex stream invocation');
      const block = source.slice(from, source.indexOf('            } else {', at));
      const encoding = between(source, '    # Native stream filters', '\n}');
      script = `\ufeff$ErrorActionPreference='Continue'\n${encoding}\n$Command=$env:MOE_TEST_NODE\n$CommandArgs=@($env:MOE_TEST_FAKE)\n$codexSeatArgs=@()\n$codexExecOverrides=@()\n$codexSandboxArgs=@()\n$projectPath=$env:MOE_TEST_DIR\n$shortPrompt='pointer with spaces'\n$promptCacheHelper=$env:MOE_TEST_HELPER\n${block}\n[Console]::Write('CHILD_EXIT=' + $script:CliExitCode)`;
    } else {
      const block = between(read('sh'), '            "$COMMAND_BIN" "${COMMAND_ARGV[@]}" \\\n', '            set -e');
      script = `set +e\nCOMMAND_BIN=${quote(process.execPath.replaceAll('\\', '/'))}\nCOMMAND_ARGV=(${quote(fake.replaceAll('\\', '/'))})\nNODE_CMD="$COMMAND_BIN"\nPROMPT_CACHE_HELPER=${quote(helper.replaceAll('\\', '/'))}\nPROJECT=${quote(dir.replaceAll('\\', '/'))}\nCODEX_SEAT_INSTRUCTIONS_FILE=stable\nWORKER_ID=worker\nCODEX_EXEC_OVERRIDES=()\nCODEX_SANDBOX_ARGS=()\nSHORT_PROMPT='pointer with spaces'\n${block}\nprintf 'CHILD_EXIT=%s' "$CLI_EXIT_CODE"`;
    }
    const file = path.join(dir, `stream.${ext}`);
    writeFileSync(file, script);
    const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-File', file] : [file.replaceAll('\\', '/')], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, MOE_TEST_DIR: dir, MOE_TEST_NODE: process.execPath, MOE_TEST_FAKE: fake, MOE_TEST_HELPER: helper },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /cache 漢字/);
    assert.match(result.stdout, /hit=90.0%/);
    assert.match(result.stdout, /CHILD_EXIT=23/);
  });
}

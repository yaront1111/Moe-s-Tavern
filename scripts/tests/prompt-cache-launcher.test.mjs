import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync } from 'node:fs';
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

// The daemon owns role scoping. Exercise the real launcher projection AND
// injected block, so a shell-side allowlist cannot silently strip fresh fields.
const scopedContext = role => ({
  project: { id: 'project-context', name: 'Context fixture', globalRails: { requiredPatterns: ['reuse'], forbiddenPatterns: [] },
    settings: { consolidationBranch: 'moe/work-context' } },
  epic: { id: 'epic-context', title: 'Preserve contracts', description: 'Shared behavior',
    architectureNotes: 'Reuse the existing service. Preserve the caller contract — שלום 漢字.', epicRails: ['No duplicate helper'] },
  task: { id: 'task-context', title: 'Reuse a shared helper', status: role === 'qa' ? 'REVIEW' : 'WORKING',
    description: 'Update both caller and callee.', definitionOfDone: ['Existing caller still works'], taskRails: [],
    implementationPlan: [{ stepId: 'step-1', description: 'Extend the existing helper', status: 'PENDING',
      affectedFiles: ['src/shared.ts'], newFiles: ['src/new feature.ts'], modifiedFiles: [],
      note: 'Keep this complete: ' + 'detail '.repeat(60) + '"quoted" $literal `text` — שלום 漢字' }],
    verification: { command: 'npm test -- shared', exitCode: 0, outputTail: '1 test passed', source: 'agent-reported' },
    commits: [{ sha: 'a'.repeat(40), treeId: 'b'.repeat(40), kind: 'completion', ref: 'moe/work-context',
      pushed: true, recordedAt: '2026-10-21T18:35:19Z' }],
    landing: { lastCompletion: { sha: 'a'.repeat(40), ref: 'moe/work-context', pushed: true, recordedAt: '2026-10-21T18:35:19Z' } }, declaredPaths: ['src/shared.ts'], dependsOn: ['task-prerequisite'],
    ...(role === 'worker' ? { epicSiblings: [{ id: 'task-prerequisite', status: 'DONE', landed: true }] } : {}),
    comments: [], commentSummary: { total: 0, returned: 0, omitted: 0, truncated: 0 } },
  currentCandidate: { id: 'candidate-context', attemptId: 'attempt-context', taskId: 'task-context',
    baseRevision: 'c'.repeat(40), treeSha: 'b'.repeat(40), deliveryTarget: 'refs/heads/moe/work-context',
    createdAt: '2026-10-21T18:35:19Z' },
  ...(role === 'worker' ? { planningNotes: { codebaseInsights: 'Reuse shared.ts', keyFiles: ['src/shared.ts'] } } : {}),
  omitted: role === 'qa' ? ['task.epicSiblings', 'planningNotes', 'routing'] : ['routing'],
  omittedHint: 'Pass view:"full" only if you need one of these sections.',
  nextAction: { tool: role === 'qa' ? 'moe.qa_approve' : 'moe.start_step', args: { taskId: 'task-context' } },
  futureContextField: { version: 2, note: 'A newer daemon field must reach an older wrapper.' },
});

for (const [ext, engine] of engines) {
  for (const [label, role, context] of [
    ['worker', 'worker', scopedContext('worker')],
    ['QA', 'qa', scopedContext('qa')],
    ['legacy sparse', 'worker', { task: { id: 'task-context', status: 'WORKING' } }],
  ]) {
    test(`${engine}: claimed task context preserves the daemon's ${label} payload`, t => {
      const dir = mkdtempSync(path.join(tmpdir(), 'moe context '));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const fixture = path.join(dir, 'context.json');
      writeFileSync(fixture, JSON.stringify(context));
      const source = read(ext);
      let script;
      if (ext === 'ps1') {
        const project = between(source, '        $ctxJson = if ($preflightContext) {', '        $pendingJson =');
        const inject = between(source, '        $dynamicContext += @"\n# Pre-flight Complete', '        # JIT reminder:');
        script = `\ufeff$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$preflightContext=[IO.File]::ReadAllText($env:MOE_CONTEXT_FIXTURE) | ConvertFrom-Json\n$dynamicContext=''\n$Role='${role}'\n$WorkerId='worker-context'\n$preflightTaskId='task-context'\n$generalCount=0\n$taskCount=0\n$mentionsCount=0\n$memTotal=0\n$memTaskLine='none'\n$memRecentLine='none'\n$pendingJson='{}'\n${project}\n${inject}\n[Console]::Write($dynamicContext)`;
      } else {
        const project = between(source, '                # 5. Fetch context for the claimed task', '                # 6. Read task channel backlog');
        const inject = between(source, '        DYNAMIC_CONTEXT="# Pre-flight Complete', '        # JIT reminder:');
        script = `set -eu\nPYTHON_CMD=${process.platform === 'win32' ? 'python' : 'python3'}\nPREFLIGHT_TASK_ID=task-context\nPREFLIGHT_TASK_CHANNEL=channel-context\nPREFLIGHT_CONTEXT=''\nmoe_rpc() { cat "$MOE_CONTEXT_FIXTURE"; }\nplan_progress_mark() { :; }\nROLE=${role}\nWORKER_ID=worker-context\nPREFLIGHT_GENERAL_COUNT=0\nPREFLIGHT_TASK_COUNT=0\nPREFLIGHT_ROUTED_MENTIONS_COUNT=0\nMEM_TOTAL=0\nMEM_TASK_NAMES=none\nMEM_RECENT_NAMES=none\nPREFLIGHT_PENDING='{}'\n${project}\n${inject}\nprintf '%s' "$DYNAMIC_CONTEXT"`;
      }
      const file = path.join(dir, `context.${ext}`);
      writeFileSync(file, script);
      const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-File', file] : [file.replaceAll('\\', '/')], {
        encoding: 'utf8', timeout: 20000,
        env: { ...process.env, MOE_CONTEXT_FIXTURE: fixture.replaceAll('\\', '/') },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const injected = result.stdout.match(/<claimed_task_context>\s*([\s\S]*?)\s*<\/claimed_task_context>/);
      assert.ok(injected, 'launch must inject the claimed task context');
      assert.deepEqual(JSON.parse(injected[1]), context,
        'launchers must preserve the daemon-scoped payload, including source scope, architecture and review evidence');
    });
  }
}

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
      script = `set -e\nPROJECT=${quote(dir.replaceAll('\\', '/'))}\nROLE=worker\nSYSTEM_APPEND='stable role instructions'\nDYNAMIC_CONTEXT='task-A "quoted" 漢字'\ncreate_secure_temp() { printf '%s' "$PROJECT"; }\ncodex_moe_server_override() { :; }\n${block}\nprintf '\\036'\ncat "$CODEX_SEAT_INSTRUCTIONS_FILE"`;
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

// Per-role auto-compact window and the Moe mods' plugin dirs: the wrapper's
// real env block, run twice (a reload pass) over each inherited env. The
// account-switch mod joins only a TUI seat whose loop relaunches it, and ends
// a taskless session only where that loop also claims for the seat.
const HEADLESS = { interactive: false, loop: true };
const TUI = { interactive: true, loop: true };
const compactCases = [
  // [role, inherited env, window, marker, keeper on, seat, account-switch on, ends-when-idle on, auto-claim]
  ['qa', {}, '500000', '500000', true],
  // 300000 unmarked: the pre-2026-10-09 flat default, inherited by the reload that installs this wrapper
  ['architect', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, '600000', '600000', true],
  // the wrapper's own marked value is re-derived for the role
  ['worker', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000', MOE_COMPACT_WINDOW_DEFAULT: '600000' }, '300000', '300000', true],
  // an operator value wins
  ['qa', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }, '400000', '', true],
  ['governor', { MOE_DISABLE_COMPACTION_KEEPER: '1' }, '600000', '600000', false, TUI, true],
  ['architect', {}, '600000', '600000', true, TUI, true, true],
  // --no-auto-claim: the operator claims, so a taskless session is theirs to end
  ['architect', {}, '600000', '600000', true, TUI, true, false, false],
  // a governor never holds a task, and an inherited flag never reaches it or a headless run
  ['governor', { MOE_SESSION_ENDS_WHEN_IDLE: '1' }, '600000', '600000', true, TUI, true, false],
  ['worker', { MOE_SESSION_ENDS_WHEN_IDLE: '1' }, '300000', '300000', true],
  // --no-loop: an ended session would not come back
  ['architect', {}, '600000', '600000', true, { interactive: true, loop: false }, false],
  ['governor', { MOE_DISABLE_ACCOUNT_SWITCH_MOD: '1' }, '600000', '600000', true, TUI, false],
];
const compactVars = /^(CLAUDE_CODE_AUTO_COMPACT_WINDOW|MOE_COMPACT_WINDOW_DEFAULT|CLAUDE_CODE_PLUGIN_DIRS|MOE_DISABLE_COMPACTION_KEEPER|MOE_DISABLE_ACCOUNT_SWITCH_MOD|MOE_SESSION_ENDS_WHEN_IDLE)$/;

for (const [ext, engine] of engines) {
  for (const [role, inherited, window, marker, keeperOn, seat = HEADLESS, switchOn = false, idleOn = false, autoClaim = true] of compactCases) {
    const kind = `${seat.interactive ? 'tui' : 'headless'}${seat.loop ? '' : ' no-loop'}${autoClaim ? '' : ' no-auto-claim'}`;
    test(`${engine}: ${role} ${kind} compact window over ${JSON.stringify(inherited)}`, t => {
      // Long form: $PSScriptRoot expands an 8.3 TEMP such as C:\Users\RUNNER~1.
      const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'moe compact ')));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(path.join(dir, 'mods', 'moe-compaction-keeper'), { recursive: true });
      mkdirSync(path.join(dir, 'mods', 'moe-account-switch'), { recursive: true });
      let script, keeperDir, switchDir;
      if (ext === 'ps1') {
        const block = between(read('ps1'), '            if (-not $env:CLAUDE_CODE_PROMPT_CACHE_TTL)', '            # Inline stream-json parser.');
        keeperDir = path.join(dir, 'mods', 'moe-compaction-keeper');
        switchDir = path.join(dir, 'mods', 'moe-account-switch');
        script = `$ErrorActionPreference='Stop'\n$Role='${role}'\n$AutoClaim=$${autoClaim}\n$claudeInteractive=$${seat.interactive}\n$loopEnabled=$${seat.loop}\n${block}\n${block}\n[Console]::Write("$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW|$env:MOE_COMPACT_WINDOW_DEFAULT|$env:CLAUDE_CODE_PLUGIN_DIRS|$env:MOE_SESSION_ENDS_WHEN_IDLE")`;
      } else {
        const block = between(read('sh'), '        if [ "$CLI_TYPE" = "claude" ]; then\n            export CLAUDE_CODE_PROMPT_CACHE_TTL', '        # Per-task one-shot mode');
        keeperDir = `${dir.replaceAll('\\', '/')}/mods/moe-compaction-keeper`;
        switchDir = `${dir.replaceAll('\\', '/')}/mods/moe-account-switch`;
        script = `set -eu\nCLI_TYPE=claude\nROLE=${role}\nAUTO_CLAIM=${autoClaim}\nCLAUDE_INTERACTIVE=${seat.interactive}\nLOOP_ENABLED=${seat.loop}\nSCRIPT_DIR=${quote(dir.replaceAll('\\', '/'))}\n${block}\n${block}\nprintf '%s|%s|%s|%s' "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" "\${MOE_COMPACT_WINDOW_DEFAULT:-}" "\${CLAUDE_CODE_PLUGIN_DIRS:-}" "\${MOE_SESSION_ENDS_WHEN_IDLE:-}"`;
      }
      const file = path.join(dir, `compact.${ext}`);
      writeFileSync(file, script);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !compactVars.test(k)));
      const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-File', file] : [file.replaceAll('\\', '/')], {
        encoding: 'utf8', timeout: 20000, env: { ...env, ...inherited, CLAUDE_CODE_PLUGIN_DIRS: 'operator-dir' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const sep = ext === 'ps1' ? path.delimiter : ':';
      assert.equal(result.stdout, `${window}|${marker}|operator-dir${keeperOn ? sep + keeperDir : ''}${switchOn ? sep + switchDir : ''}|${idleOn ? '1' : ''}`);
    });
  }
}

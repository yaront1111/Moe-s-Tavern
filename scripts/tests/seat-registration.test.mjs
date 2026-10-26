import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// An idle seat's worker record can be pruned (stale) or left DEAD (a hot reload
// deregisters, then exec's the same seat). Its next notification-only session
// then could not reply ("Unknown sender") and the mention never left its inbox.
// These run the launchers' REAL pre-flight segments (team re-join, chat reads,
// routed backlog, mention extraction, taskless launch decision, exit) and their
// real RPC helpers against a fake proxy that models the daemon's registration
// rules. No daemon, no project .moe: everything lives in a temp directory.
const read = (ext) => readFileSync(new URL(`../moe-agent.${ext}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const sh = read('sh');
const ps = read('ps1');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const windows = process.platform === 'win32';
const PYTHON = windows ? 'python' : 'python3';
const fwd = (p) => p.replaceAll('\\', '/');
const shq = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const psq = (v) => `'${String(v).replaceAll("'", "''")}'`;

const FAKE_PROXY = String.raw`const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(input.split(/\r?\n/).find((l) => l.trim()));
  const tool = req.params.name.replace(/^moe\./, ''); const args = req.params.arguments || {};
  fs.appendFileSync(process.env.SEAT_RPC_LOG, tool + '\t' + JSON.stringify(args) + '\n');
  const s = JSON.parse(fs.readFileSync(process.env.SEAT_FAKE_STATE, 'utf8'));
  const save = () => fs.writeFileSync(process.env.SEAT_FAKE_STATE, JSON.stringify(s));
  const reply = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...o }) + '\n');
  const ok = (v) => reply({ result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
  const refuse = (message) => reply({ error: { code: -32000, message } });
  const unknownSender = () => refuse('Unknown sender: workerId must be a registered worker or "human"');
  if (tool === 'create_team') {
    const outcome = s.creates.shift() || 'ok'; save();
    if (outcome === 'silent') return;
    return ok(outcome === 'noid' ? { team: {} } : { team: { id: s.teamId, name: args.name, role: args.role || null } });
  }
  if (tool === 'join_team') {
    const outcome = s.joins.shift() || 'ok';
    if (outcome === 'ok') s.record = 'live'; // a join (re-)registers, and revives DEAD
    save();
    if (outcome === 'silent') return;
    if (outcome === 'error') return refuse('Team Workers is full (max 1 members)');
    if (outcome === 'gone') return refuse('Team not found: ' + args.teamId);
    if (outcome === 'isError') return reply({ result: { isError: true, content: [{ type: 'text', text: 'refused' }] } });
    if (outcome === 'malformed') return ok({ success: true });
    if (outcome === 'foreign') return ok({ team: { id: args.teamId, memberIds: ['worker-other'] } });
    if (outcome === 'unlisted') return ok({ team: { id: args.teamId, memberIds: args.workerId + '-2' } });
    return ok({ team: { id: args.teamId, memberIds: [args.workerId] } });
  }
  if (tool === 'chat_channels') return ok({ channels: [{ id: 'chan-general', name: 'general', type: 'general' }] });
  if (tool === 'chat_join') return s.record === 'none' ? unknownSender() : ok({ channel: args.channel });
  if (tool === 'chat_read') { // the cursor persists only for an existing record (workerStore.updateWorkerCursors)
    const messages = s.messages.slice(s.cursor ? s.messages.findIndex((m) => m.id === s.cursor) + 1 : 0);
    if (messages.length && s.record !== 'none') { s.cursor = messages[messages.length - 1].id; save(); }
    return ok({ messages, cursor: s.cursor });
  }
  if (tool === 'chat_send') {
    if (s.record === 'none') return unknownSender();
    s.messages.push({ id: 'msg-' + (s.messages.length + 1), channel: args.channel, sender: args.workerId, content: args.content, mentions: [] });
    save(); return ok({ success: true });
  }
  if (tool === 'chat_wait') return ok({ hasMessage: false, timedOut: true });
  return ok({});
});
`;

const SEGMENTS = {
  sh: {
    funcs: between(sh, '# moe_rpc TOOL ARGS_JSON', '# Candidate evidence is pinned outside the CLI'),
    chat: between(sh, 'echo -e "${BLUE}Pre-flight: joining chat, claiming task, loading context...${NC}"\n', '        # 3. Check pending questions'),
    routed: between(sh, '        ROLE_GROUP_TAG=""\n', '        # -------- Wrapper-side task wait'),
    mentions: between(sh, '        # Filter unread messages for ones routed at THIS worker.', '\n    fi\n    # -------- End pre-flight --------'),
    decide: between(sh, '    MOE_SKIP_LAUNCH=false\n', '    if [ "$MOE_SKIP_LAUNCH" != true ] && { [ "$CLI_TYPE" = claude ]'),
    outcome: between(sh, '    if [ "$MOE_SKIP_LAUNCH" = true ]; then\n', '    elif [ "$CLI_TYPE" = "codex" ]; then') + '    fi\n',
    tail: sh.slice(sh.lastIndexOf('\ndone\n') + 6),
  },
  ps1: {
    funcs: between(ps, 'function Invoke-MoeRpcRaw {', '\nif ($Team) {')
      + between(ps, '# Invoke-MoeRpc TOOL ARGS_HASHTABLE_OR_JSON', '# Immutable claim tokens belong to the runner')
      + between(ps, "$script:MoeMentionFailedMarker = 'MOE_MENTION_DELIVERY_FAILED'", 'function ConvertTo-MoeFencedJson'),
    chat: between(ps, 'Write-Host "Pre-flight: joining chat, claiming task, loading context..." -ForegroundColor Cyan\n', '        $preflightPending = Invoke-MoeRpc'),
    routed: between(ps, '        $roleGroupTag = switch ($Role)', '        # -------- Wrapper-side task wait'),
    mentions: between(ps, '        # Filter unread messages for ones routed at THIS worker. Claude otherwise', '\n    }\n    # -------- End pre-flight --------'),
    decide: between(ps, '    $moeSkipLaunch = $false\n', '    if (-not $moeSkipLaunch -and $cliType -in'),
    outcome: between(ps, '    if ($moeSkipLaunch) {\n', "        if ($cliType -eq 'codex' -and $script:CodexSessionContextFile)") + '    }\n',
    tail: ps.slice(ps.indexOf('if ($script:MoeWrapperRelaunchRequested)')),
  },
};

const TEAMS = { worker: 'Workers', qa: 'QA', architect: 'Architects', governor: 'Governors' };
function shScript(o, f) {
  const s = SEGMENTS.sh;
  const iteration = o.body ?? `printf '@@\\t%s\\n' "$MOE_FIXTURE_ITER" >> "$SEAT_RPC_LOG"
  PREFLIGHT_GENERAL_UNREAD=""; PREFLIGHT_ROUTED_UNREAD=""; PREFLIGHT_TASK_UNREAD=""; PREFLIGHT_HAS_UNREAD_MENTION=false
  PREFLIGHT_ROUTED_MENTIONS_JSON=""; PREFLIGHT_ROUTED_MENTIONS_COUNT=0; PREFLIGHT_NO_TASK=true; PREFLIGHT_OK=false; PREFLIGHT_CLAIM_FAILED=false
${s.chat}
  CLAIM_RESULT='{"hasNext":false}'
${s.routed}${s.mentions}
${s.decide}${s.outcome}
  echo "@@ state registered=$SEAT_REGISTERED joined=$TEAM_JOINED mentions=$PREFLIGHT_ROUTED_MENTIONS_COUNT skip=$MOE_SKIP_LAUNCH"
  if [ "$MOE_SKIP_LAUNCH" != true ]; then
    if moe_rpc chat_send "{\\"channel\\":\\"chan-general\\",\\"workerId\\":\\"$WORKER_ID\\",\\"content\\":\\"on it\\"}" >/dev/null 2>&1; then echo "@@ reply ok"; else echo "@@ reply refused"; fi
  fi
  [ "$LOOP_ENABLED" = true ] || break`;
  return `set -e
ROLE=${o.role}; TEAM=${shq(TEAMS[o.role])}; WORKER_ID=worker-fixture; PROJECT=${shq(fwd(f.project))}
PYTHON_CMD=${PYTHON}; NODE_CMD=${shq(fwd(process.execPath))}; TEAM_PROXY=${shq(fwd(f.proxy))}; PROXY_CMD=''
GREEN=''; YELLOW=''; NC=''; BLUE=''; MAGENTA=''; AUTO_CLAIM=true; CLI_TYPE=claude; LOOP_ENABLED=${o.loop}; FIRST_RUN=true
TEAM_ID=${shq(o.teamId)}; TEAM_JOINED=${o.joined}; TEAM_JOIN_LAST_ERROR=''; TEAM_CONTEXT=''
${s.funcs}
for MOE_FIXTURE_ITER in $(seq 1 ${o.iterations}); do
  IS_FIRST_ITERATION="$FIRST_RUN"; FIRST_RUN=false
  ${iteration}
done
${s.tail}`;
}
function psScript(o, f) {
  const s = SEGMENTS.ps1;
  const iteration = o.body ?? `[IO.File]::AppendAllText($env:SEAT_RPC_LOG, "@@\`t$iter\`n")
    $preflightGeneralUnread = $null; $preflightRoutedUnread = $null; $preflightTaskUnread = $null; $preflightHasUnreadMention = $false
    $preflightRoutedMentions = @(); $preflightNoTask = $true; $preflightOk = $false; $preflightClaimFailed = $false
${s.chat}
    $claim = [pscustomobject]@{ hasNext = $false }
${s.routed}${s.mentions}
${s.decide}${s.outcome}
    Write-Output "@@ state registered=$seatRegistered joined=$teamJoined mentions=$($preflightRoutedMentions.Count) skip=$moeSkipLaunch"
    if (-not $moeSkipLaunch) {
        if ($null -ne (Invoke-MoeRpc -Tool 'chat_send' -Args @{ channel = 'chan-general'; workerId = $WorkerId; content = 'on it' })) { '@@ reply ok' } else { '@@ reply refused' }
    }
    if (-not $loopEnabled) { break }`;
  return `\ufeff$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Role = '${o.role}'; $Team = ${psq(TEAMS[o.role])}; $WorkerId = 'worker-fixture'; $projectPath = ${psq(f.project)}
$proxyScript = ${psq(f.proxy)}; $AutoClaim = $true; $cliType = 'claude'; $loopEnabled = $${o.loop}; $firstRun = $true
$teamId = ${psq(o.teamId)}; $teamJoined = $${o.joined}; $teamJoinLastError = ''; $teamContext = ''
${s.funcs}
for ($iter = 1; $iter -le ${o.iterations}; $iter++) {
    $isFirstIteration = $firstRun; $firstRun = $false
    ${iteration}
}
${s.tail}`;
}

const MENTION = { id: 'msg-1', channel: 'chan-general', sender: 'human', content: '@worker-fixture please confirm the rollout', mentions: ['worker-fixture'], timestamp: '2026-10-26T04:00:00.000Z' };
function runSeat(engine, options) {
  const o = { role: 'worker', record: 'none', joined: true, teamId: 'team-fixture', joins: [], creates: [], iterations: 2, loop: true, status: 0, ...options };
  const dir = mkdtempSync(path.join(tmpdir(), 'moe-seat-'));
  try {
    const f = { project: path.join(dir, 'project'), proxy: path.join(dir, 'fake-proxy.cjs'), state: path.join(dir, 'state.json'), log: path.join(dir, 'rpc.log') };
    mkdirSync(path.join(f.project, '.moe', 'messages'), { recursive: true });
    writeFileSync(path.join(f.project, '.moe', 'messages', 'chan-general.jsonl'), `${JSON.stringify(MENTION)}\n`);
    writeFileSync(f.proxy, FAKE_PROXY);
    writeFileSync(f.log, '');
    writeFileSync(f.state, JSON.stringify({ record: o.record, teamId: 'team-fixture', joins: o.joins, creates: o.creates, cursor: null, messages: [MENTION] }));
    const script = path.join(dir, engine.ext === 'sh' ? 'seat.sh' : 'seat.ps1');
    writeFileSync(script, engine.ext === 'sh' ? shScript(o, f) : psScript(o, f));
    const args = engine.ext === 'sh' ? ['--noprofile', '--norc', fwd(script)] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    const env = { ...process.env, SEAT_RPC_LOG: fwd(f.log), SEAT_FAKE_STATE: fwd(f.state), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
    delete env.MOE_WORKER_ID; delete env.MOE_PROJECT_PATH; delete env.MOE_SESSION_ID;
    const result = spawnSync(engine.exe, args, { encoding: 'utf8', timeout: 120_000, env });
    assert.ifError(result.error);
    const out = result.stdout.replaceAll('\r\n', '\n');
    assert.equal(result.status, o.status, out + result.stderr);
    const rpcs = []; let iter = 0;
    for (const line of readFileSync(f.log, 'utf8').split('\n').filter(Boolean)) {
      const [tool, json] = line.split('\t');
      if (tool === '@@') iter = Number(json); else rpcs.push({ iter, tool, args: JSON.parse(json) });
    }
    const states = [...out.matchAll(/^@@ state registered=(\S*) joined=(\S*) mentions=(\S*) skip=(\S*)$/gm)]
      .map(([, registered, joined, mentions, skip]) => ({ registered: registered.toLowerCase(), joined: joined.toLowerCase(), mentions: Number(mentions), skip: skip.toLowerCase() }));
    return { out, rpcs, states, replies: [...out.matchAll(/^@@ reply (\S+)$/gm)].map((m) => m[1]), fake: JSON.parse(readFileSync(f.state, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const tools = (run, iter) => run.rpcs.filter((r) => iter === undefined || r.iter === iter).map((r) => r.tool);
const count = (text, needle) => text.split(needle).length - 1;

function probe(exe) {
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
const ENGINES = [
  { name: windows ? 'Git Bash' : 'bash', ext: 'sh', exe: windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', skip: false },
  { name: 'PowerShell 5.1', ext: 'ps1', exe: 'powershell.exe', skip: windows ? (!probe('powershell.exe') && 'powershell.exe not found') : `PowerShell 5.1 is Windows-only; not available on ${process.platform}` },
  { name: 'PowerShell 7', ext: 'ps1', exe: windows ? 'pwsh.exe' : 'pwsh' },
];
ENGINES[2].skip = !probe(ENGINES[2].exe) && `${ENGINES[2].exe} is not available on ${process.platform}`;

test('both launchers re-join before any chat call, exactly once per pre-flight, and share the operator strings', () => {
  for (const [label, chat, force, calls] of [
    ['sh', SEGMENTS.sh.chat, 'retry_team_join force', ['moe_rpc chat_join', 'moe_rpc chat_read']],
    ['ps1', SEGMENTS.ps1.chat, 'Invoke-MoeTeamJoinRetry -Force', ['"chat_join"', '"chat_read"']],
  ]) {
    const order = [force, ...calls].map((needle) => chat.indexOf(needle));
    assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `${label}: ${order}`);
    assert.equal(count(label === 'sh' ? sh : ps, force), 1, `${label}: one forced call site`);
  }
  for (const text of ['MOE_SEAT_UNREGISTERED', "this seat's chat stays unread until a pre-flight join succeeds"]) {
    assert.ok(sh.includes(text) && ps.includes(text), text);
  }
});

for (const engine of ENGINES) {
  const t = (name, fn) => test(`${engine.name}: ${name}`, { skip: engine.skip }, fn);
  if (engine.ext === 'ps1') {
    t('moe-agent.ps1 parses', () => {
      const r = spawnSync(engine.exe, ['-NoProfile', '-NonInteractive', '-Command',
        `$e = $null; [void][Management.Automation.Language.Parser]::ParseFile(${psq(fileURLToPathSafe('../moe-agent.ps1'))}, [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    });
  }
  for (const [role, record] of [['worker', 'none'], ['qa', 'none'], ['architect', 'none'], ['worker', 'dead']]) {
    t(`a ${record === 'none' ? 'pruned' : 'DEAD'} idle ${role} seat re-joins, replies as itself and is not re-notified`, () => {
      const run = runSeat(engine, { role, record });
      assert.deepEqual(run.states, [
        { registered: 'true', joined: 'true', mentions: 1, skip: 'false' },
        { registered: 'true', joined: 'true', mentions: 0, skip: 'true' },
      ]);
      assert.deepEqual(run.replies, ['ok']);
      assert.equal(run.fake.record, 'live');
      assert.equal(run.fake.messages.at(-1).sender, 'worker-fixture');
      assert.deepEqual(tools(run, 1).slice(0, 4), ['join_team', 'chat_channels', 'chat_join', 'chat_read']);
      assert.deepEqual(tools(run, 2).slice(0, 3), ['join_team', 'chat_channels', 'chat_read'], 'one join per pre-flight; chat_join once');
      assert.ok(!tools(run).includes('create_team'));
      assert.match(run.out, /MOE_TASKLESS_NO_LAUNCH reason=idle/);
      assert.equal(count(run.out, 'MOE_SEAT_UNREGISTERED') + count(run.out, 'no longer teamless'), 0, 'a healthy re-join logs nothing');
    });
  }
  t('a governor seat re-joins its role-bound team before reading chat', () => {
    const run = runSeat(engine, { role: 'governor', teamId: '', iterations: 1 });
    assert.deepEqual(tools(run).slice(0, 4), ['create_team', 'join_team', 'chat_channels', 'chat_join']);
    assert.deepEqual(run.rpcs[0].args, { name: 'Governors', role: 'governor' });
    assert.deepEqual(run.rpcs[1].args, { teamId: 'team-fixture', workerId: 'worker-fixture' });
    assert.equal(run.states[0].registered, 'true');
    assert.equal(run.fake.record, 'live');
  });
  for (const outcome of ['error', 'isError', 'malformed', 'foreign', 'unlisted', 'silent']) {
    t(`a refused re-join (${outcome}) reads no chat and launches nothing; the next pre-flight recovers`, () => {
      const run = runSeat(engine, { joins: [outcome, 'ok'] });
      assert.deepEqual(run.states, [
        { registered: 'false', joined: 'false', mentions: 0, skip: 'true' },
        { registered: 'true', joined: 'true', mentions: 1, skip: 'false' },
      ]);
      assert.deepEqual(tools(run, 1), ['join_team'], 'one join per pre-flight, then no chat call at all');
      assert.equal(run.fake.cursor, 'msg-1', 'the mention is read only once the seat is registered');
    });
  }
  t('repeated refusals warn once, and the recovery is announced once', () => {
    const run = runSeat(engine, { joins: ['error', 'error', 'ok', 'ok'], iterations: 4 });
    assert.deepEqual(run.states.map((s) => s.registered), ['false', 'false', 'true', 'true']);
    assert.equal(count(run.out, 'MOE_SEAT_UNREGISTERED'), 1, run.out);
    assert.equal(count(run.out, "this seat's chat stays unread until a pre-flight join succeeds"), 1);
    assert.equal(count(run.out, 'no longer teamless'), 1, run.out);
    assert.match(run.out, /MOE_SEAT_UNREGISTERED worker=worker-fixture team=Workers - moe\.join_team: Team Workers is full/);
    assert.match(run.out, /Worker worker-fixture joined team 'Workers' on retry; this seat is no longer teamless\./);
  });
  t('a seat whose team was deleted re-creates it by name on the next pre-flight', () => {
    const run = runSeat(engine, { joins: ['gone', 'ok'] });
    assert.deepEqual(tools(run, 1), ['join_team']);
    assert.deepEqual(tools(run, 2).slice(0, 3), ['create_team', 'join_team', 'chat_channels']);
    assert.deepEqual(run.states.map((s) => s.registered), ['false', 'true']);
  });
  for (const outcome of ['noid', 'silent']) {
    t(`a seat whose team cannot be created (${outcome}) never joins or reads chat`, () => {
      const run = runSeat(engine, { teamId: '', creates: [outcome], iterations: 1 });
      assert.deepEqual(tools(run), ['create_team']);
      assert.deepEqual(run.states, [{ registered: 'false', joined: 'false', mentions: 0, skip: 'true' }]);
    });
  }
  t('a one-shot run that cannot register exits 1 instead of idling', () => {
    const run = runSeat(engine, { joins: ['error'], iterations: 1, loop: false, status: 1 });
    assert.deepEqual(tools(run), ['join_team']);
    assert.match(run.out, /MOE_SEAT_UNREGISTERED worker=worker-fixture team=Workers - this one-shot run ends without a team \(moe\.join_team: Team Workers is full \(max 1 members\)\); exit 1\./);
  });
  t('a one-shot run that registers exits 0', () => {
    const run = runSeat(engine, { iterations: 1, loop: false });
    assert.deepEqual(run.replies, ['ok']);
  });
  t('the cached (unforced) retry of a joined seat calls nothing', () => {
    const body = engine.ext === 'sh'
      ? 'if retry_team_join; then echo "@@ cached ok"; fi; break'
      : "if (Invoke-MoeTeamJoinRetry) { '@@ cached ok' }; break";
    const run = runSeat(engine, { body, iterations: 1 });
    assert.deepEqual(run.rpcs, []);
    assert.match(run.out, /^@@ cached ok$/m);
  });
}

function fileURLToPathSafe(rel) {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), rel);
}

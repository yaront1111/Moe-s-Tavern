import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const source = fileURLToPath(import.meta.url), scripts = path.dirname(path.dirname(source));
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MOE_|FAKE_|GIT_|CLAUDE|CODEX|GUARD_)/i.test(k)));
Object.assign(clean, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const psquote = s => `'${s.replaceAll("'", "''")}'`;
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
function run(cmd, args, cwd, env = clean, input) {
  return spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
}
function git(cwd, args, env = clean) {
  const r = run('git', ['-C', cwd, ...args], cwd, env);
  assert.equal(r.status, 0, `fixture git ${args[0]} failed (${r.status})`);
  return r.stdout.trim();
}
function snapshot(f, env) {
  return [git(f.repo, ['rev-parse', 'HEAD'], env), git(f.repo, ['diff', '--cached'], env),
    git(f.repo, ['diff'], env), git(f.repo, ['ls-files', '--stage'], env), git(f.repo, ['ls-remote', 'origin'], env)];
}
function agent() {
  const f = JSON.parse(process.env.GUARD_FIXTURE), env = process.env;
  if (process.argv.includes('--help') || process.argv.includes('--version')) return;
  if (f.mode === 'non-git') { write(f.result, JSON.stringify({ count: env.GIT_CONFIG_COUNT, stdin: fs.readFileSync(0, 'utf8') })); return; }
  if (f.mode === 'lowercase-count') { write(f.result, JSON.stringify({ count: env.GIT_CONFIG_COUNT, caller: run('git', ['-C', f.repo, 'config', '--get', 'guard.caller'], f.repo, env).stdout.trim() })); return; }
  if (f.mode === 'hold') {
    const hooks = git(f.repo, ['config', '--get', 'core.hooksPath'], env);
    write(f.result, JSON.stringify({ hooks }));
    for (let end = Date.now() + 60000; !fs.existsSync(f.result + '.release') && Date.now() < end;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    return;
  }
  const before = snapshot(f, env), results = [];
  for (const command of ['cd missing-scratch; git commit -am D', 'git commit -m staged-only',
    'git -C sub commit -am subdir', 'git push origin HEAD:refs/heads/agent-write']) {
    const r = run(f.shell, ['-c', command], f.repo, env);
    results.push({ status: r.status, refused: /MOE_AGENT_GIT_REFUSED/.test(r.stderr), wrapper: /the wrapper lands the work/.test(r.stderr) });
  }
  const after = snapshot(f, env), hooks = git(f.repo, ['config', '--get', 'core.hooksPath'], env);
  const secure = win ? run('powershell.exe', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath ${psquote(path.dirname(hooks))}).AreAccessRulesProtected`], f.repo).stdout.trim() === 'True' : (fs.statSync(path.dirname(hooks)).mode & 0o777) === 0o700;
  const scratch = [f.scratch, f.worktree].map(d => run('git', ['-C', d, 'commit', '--allow-empty', '-m', 'scratch'], d, env).status);
  const bypass = run('git', ['-C', f.repo, 'hook', 'run', 'pre-commit'], f.repo, { ...env, MOE_ALLOW_AGENT_GIT_WRITES: '1', GUARD_DENY_ORIGINAL: '1' });
  write(f.result + '.stdin', 'payload\n');
  const forwarded = run('git', ['-C', f.repo, 'hook', 'run', '--to-stdin=' + f.result + '.stdin', 'post-checkout', '--', 'a', 'b', '1'], f.repo, env);
  const bypassWrite = f.mode === 'bypass' ? run('git', ['-C', f.repo, 'commit', '--only', '--allow-empty', '-m', 'human-bypass'], f.repo, { ...env, MOE_ALLOW_AGENT_GIT_WRITES: '1' }).status : null;
  const stillGuarded = run('git', ['-C', f.repo, 'hook', 'run', 'pre-commit'], f.repo, env).status;
  write(f.result, JSON.stringify({ secure, bypassWrite, stillGuarded, caller: git(f.repo, ['config', '--get', 'guard.caller'], env), before, after, results, hooks, scratch, bypass: bypass.status, forwarded: forwarded.status, argv: process.argv.slice(3), count: env.GIT_CONFIG_COUNT }));
  write(path.join(f.repo, 'owned.txt'), 'task edit\n');
  if (f.mode === 'launch-failure') process.exitCode = 23;
}
function fixture(t, cli, hooks, status = 'REVIEW', mode = '') {
  const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'moe-agent-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const f = Object.fromEntries(['repo', 'scratch', 'worktree', 'remote', 'home', 'result', 'hooklog'].map(k => [k, path.join(root, k)]));
  f.mode = mode;
  f.original = path.join(root, "hooks é [x] $;'") + (mode === 'hook-spaces' && !win ? ' ' : ''); f.repo = path.join(root, "control é $;'"); f.gitdir = path.join(root, "git [x] é $;'");
  f.shell = win ? path.join(path.dirname(path.dirname(run('where.exe', ['git'], root).stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe') : 'bash';
  for (const d of [f.repo, f.scratch, f.home]) fs.mkdirSync(d);
  for (const d of [f.repo, f.scratch]) {
    git(d, ['init', '-q', '-b', 'moe/guard', ...(d === f.repo ? ['--separate-git-dir', f.gitdir] : [])]);
    for (const [k, v] of [['user.name', 'Guard Test'], ['user.email', 'guard@test.invalid'], ['core.autocrlf', 'false']]) git(d, ['config', k, v]);
    write(path.join(d, 'owned.txt'), 'base\n'); git(d, ['add', '--', 'owned.txt']); git(d, ['commit', '-qm', 'seed']);
  }
  git(root, ['init', '-q', '--bare', f.remote]); git(f.repo, ['remote', 'add', 'origin', f.remote]);
  for (const name of ['peer.txt', 'human.txt']) write(path.join(f.repo, name), 'base\n');
  git(f.repo, ['add', '--', 'peer.txt', 'human.txt']); git(f.repo, ['commit', '-qm', 'sentinels']);
  git(f.repo, ['push', '-qu', 'origin', 'moe/guard']);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'scratch', f.worktree]); fs.mkdirSync(path.join(f.repo, 'sub'));
  write(path.join(f.original, 'pre-commit'), '#!/bin/sh\n[ "$GUARD_DENY_ORIGINAL" != 1 ] || exit 23\n');
  write(path.join(f.original, 'sibling.txt'), 'resource\n');
  write(path.join(f.original, 'post-checkout'), '#!/bin/sh\ncat "$(dirname "$0")/sibling.txt" > "$GUARD_HOOK_LOG"\nprintf "%s\\n" "$@" >> "$GUARD_HOOK_LOG"\ncat >> "$GUARD_HOOK_LOG"\n');
  for (const name of ['pre-commit', 'post-checkout']) fs.chmodSync(path.join(f.original, name), 0o755);
  git(f.repo, ['config', 'core.hooksPath', f.original]);
  write(path.join(f.repo, 'peer.txt'), 'peer dirty\n'); write(path.join(f.repo, 'human.txt'), 'human staged\n'); git(f.repo, ['add', '--', 'human.txt']);
  write(path.join(f.repo, '.moe', 'project.json'), JSON.stringify({ id: 'proj-guard', name: 'guard', settings: { commitHooks: hooks, commitBoardState: false, attribution: { undeclared: 'never' } } }));
  write(path.join(f.repo, '.moe', 'tasks', 'task-postflight.json'), JSON.stringify({ id: 'task-postflight', title: 'Guard', status: 'WORKING', filesModified: ['owned.txt'], implementationPlan: [] }));
  f.cli = path.join(root, cli + (win ? '.ps1' : ''));
  write(f.cli, win ? `& ${psquote(process.execPath)} ${psquote(source)} cli @args\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} cli "$@"\n`); fs.chmodSync(f.cli, 0o755);
  f.env = { ...clean, HOME: f.home, USERPROFILE: f.home, GUARD_FIXTURE: JSON.stringify(f), GUARD_HOOK_LOG: f.hooklog,
    MOE_PROXY_PATH: path.join(scripts, 'tests', 'postflight-fake-proxy.js'), MOE_NODE_COMMAND: process.execPath,
    MOE_ACCOUNT_ROTATION: 'off', MOE_DISABLE_HEARTBEAT: '1', FAKE_TASK_STATUS: status, FAKE_SCOPE_PEERS_ACTIVE: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: f.original,
    GIT_CONFIG_KEY_1: 'guard.caller', GIT_CONFIG_VALUE_1: 'preserved', GIT_CONFIG_KEY_2: 'unused.key', GIT_CONFIG_VALUE_2: 'unused'  };
  return f;
}
function launch(f, cli, interactive, concurrent = false) {
  const args = win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'moe-agent.ps1'), '-Project', f.repo,
    '-WorkerId', f.worker || 'worker-guard', '-Role', 'worker', '-Team', 'Guard', '-NoStartDaemon', '-NoLoop', '-Command', f.cli]
    : [path.join(scripts, 'moe-agent.sh'), '--project', f.repo, '--worker-id', f.worker || 'worker-guard', '--role', 'worker', '--team', 'Guard', '--no-start-daemon', '--no-loop', '--command', f.cli];
  if (interactive) args.push(win ? '-Interactive' : '--interactive');
  else if (['codex', 'gemini', 'grok'].includes(cli)) args.push(win ? `-${cli[0].toUpperCase() + cli.slice(1)}Exec` : `--${cli}-exec`);
  if (win) {
    const driver = f.cli + '.driver.ps1', keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2'];
    write(driver, '\ufeff$global:MoeWrapperSupervised=$true; try { & ' + args.slice(4).map(a => a.startsWith('-') ? a : psquote(a)).join(' ') +
      ' } finally { @(' + keys.map(k => '$env:' + k).join(',') + ') | ConvertTo-Json | Set-Content -LiteralPath ' + psquote(f.result + '.restored') + ' -Encoding UTF8 }');
    args.splice(4, args.length, driver);
  }
  if (concurrent) return new Promise(resolve => execFile(win ? 'powershell.exe' : 'bash', args, { cwd: f.repo, env: f.env, timeout: 90000, maxBuffer: 1048576 }, e => resolve(e?.code || 0)));
  return run(win ? 'powershell.exe' : 'bash', args, f.repo, f.env, f.mode === 'non-git' ? 'cli stdin\n' : undefined);
}
if (process.argv[2] === 'cli') agent();
else for (const [cli, interactive, hooks, status] of ['custom', 'claude', 'codex', 'gemini', 'grok'].flatMap(cli => [[cli, true, false, 'WORKING'], [cli, false, true, 'REVIEW']]).concat([['custom', false, false, 'REVIEW']])) {
  test(`${win ? 'PS5.1' : 'bash'} ${cli} ${interactive ? 'interactive checkpoint' : `headless ${hooks ? 'hookful' : 'plumbing'} completion`} refuses failed-cd commit and push before wrapper landing`, t => {
    const f = fixture(t, cli, hooks, status), before = snapshot(f), config = fs.readFileSync(path.join(f.gitdir, 'config'));
    const r = launch(f, cli, interactive);
    assert.ok(fs.existsSync(f.result), `CLI did not run: exit=${r.status}; codes=${r.stdout?.match(/MOE_[A-Z_]+/g)}`);
    const observed = JSON.parse(fs.readFileSync(f.result, 'utf8'));
    assert.deepEqual(observed.results, Array(4).fill({ status: 1, refused: true, wrapper: true }));
    assert.deepEqual(observed.before, before); assert.deepEqual(observed.after, before);
    assert.equal(observed.argv.includes(cli === 'codex' ? '--json' : cli === 'grok' ? '--yolo' : '--print'), !interactive);
    assert.equal(observed.secure, true); assert.equal(observed.count, '3'); assert.equal(observed.caller, 'preserved'); assert.equal(observed.stillGuarded, 1);
    if (win) assert.deepEqual(JSON.parse(fs.readFileSync(f.result + '.restored', 'utf8').replace(/^\ufeff/, '')), ['2', 'unused.key', 'unused']);
    assert.equal(r.status, 0); assert.deepEqual(observed.scratch, [0, 0]); assert.equal(observed.bypass, 23);
    assert.equal(observed.forwarded, 0); assert.equal(fs.readFileSync(f.hooklog, 'utf8'), 'resource\na\nb\n1\npayload\n');
    assert.equal(fs.existsSync(observed.hooks), false, 'only the seat temp is cleaned');
    assert.deepEqual(fs.readFileSync(path.join(f.gitdir, 'config')), config);
    assert.match(git(f.repo, ['log', '-1', '--format=%s']), status === 'REVIEW' ? /^fix\(|^feat\(/ : /^wip\(/);
    assert.equal(git(f.repo, ['show', 'HEAD:owned.txt']), 'task edit');
    assert.equal(git(f.repo, ['diff', '--cached']), before[1]); assert.equal(git(f.repo, ['diff']), before[2]);
    git(f.repo, ['commit', '--allow-empty', '-m', 'human outside session']);
  });
}

if (process.argv[2] !== 'cli') {
  for (const mode of ['bypass', 'notification', 'non-git', 'precedence', 'invalid-count', 'hook-directory', 'launch-failure', 'hook-spaces', 'lowercase-count', 'invalid-gitdir', 'broken-gitdir', 'hook-control']) test(`${mode} is explicit and fail-closed`, t => {
    const f = fixture(t, 'custom', false, 'REVIEW', mode);
    if (mode === 'notification') Object.assign(f.env, { FAKE_CLAIM_MODE: 'idle', FAKE_MENTION: '1' });
    if (mode === 'non-git') fs.rmSync(path.join(f.repo, '.git'), { recursive: true, force: true });
    if (mode === 'precedence') f.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=" + f.scratch.replaceAll('\\', '/') + "'";
    if (mode === 'invalid-count') f.env.GIT_CONFIG_COUNT = 'broken';
    if (mode === 'hook-directory') { fs.rmSync(f.original, { recursive: true }); write(f.original, 'not a directory'); }
    if (mode === 'lowercase-count' && win) { f.env.git_config_count = f.env.GIT_CONFIG_COUNT; delete f.env.GIT_CONFIG_COUNT; }
    if (mode === 'hook-control') f.env.GIT_CONFIG_VALUE_0 = f.original + '\r';
    if (mode === 'invalid-gitdir') f.env.GIT_DIR = path.join(f.repo, 'missing-gitdir');
    if (mode === 'broken-gitdir') { fs.rmSync(path.join(f.repo, '.git')); fs.mkdirSync(path.join(f.repo, '.git')); }
    const r = launch(f, 'custom', true);
    if (['precedence', 'invalid-count', 'hook-directory', 'invalid-gitdir', 'broken-gitdir', 'hook-control'].includes(mode)) {
      assert.equal(fs.existsSync(f.result), false); assert.equal(/MOE_AGENT_GIT_GUARD_FAILED/.test(r.stdout + r.stderr), true, 'setup refusal missing'); return;
    }
    if (mode !== 'launch-failure') assert.equal(r.status, 0);
    if (win) assert.deepEqual(JSON.parse(fs.readFileSync(f.result + '.restored', 'utf8').replace(/^\ufeff/, '')), ['2', 'unused.key', 'unused']);
    const o = JSON.parse(fs.readFileSync(f.result, 'utf8'));
    if (mode === 'lowercase-count') assert.deepEqual(o, { count: '3', caller: 'preserved' });
    else if (mode === 'non-git') assert.deepEqual(o, { count: '2', stdin: 'cli stdin\n' });
    else { assert.equal(o.stillGuarded, 1); assert.deepEqual(o.before, o.after); assert.equal(o.bypass, 23); assert.equal(o.forwarded, 0); }
    if (mode === 'bypass') { assert.equal(o.bypassWrite, 0); assert.equal(git(f.repo, ['log', '-2', '--format=%s']).split('\n')[1], 'human-bypass'); }
    if (mode === 'launch-failure') {
      const rows = fs.readFileSync(path.join(f.repo, '.moe', 'record_commit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(rows.some(r => r.cliExitCode === 23)); assert.equal(fs.existsSync(o.hooks), false);
    }
    if (mode === 'notification') assert.deepEqual(o.results.map(r => r.refused), [true, true, true, true]);
  });
  test('concurrent seats keep distinct guard files until their own exit', async t => {
    const f = fixture(t, 'custom', false, 'WORKING', 'hold');
    const other = { ...f, worker: 'worker-guard-2', result: f.result + '-2', cli: path.join(path.dirname(f.cli), 'custom-2' + (win ? '.ps1' : '')) };
    write(other.cli, fs.readFileSync(f.cli)); fs.chmodSync(other.cli, 0o755);
    other.env = { ...f.env, GUARD_FIXTURE: JSON.stringify({ ...other, env: undefined }) };
    const first = launch(f, 'custom', true, true), second = launch(other, 'custom', true, true);
    try {
      for (let end = Date.now() + 30000; (!fs.existsSync(f.result) || !fs.existsSync(other.result)) && Date.now() < end;) await new Promise(r => setTimeout(r, 50));
      const a = JSON.parse(fs.readFileSync(f.result)), b = JSON.parse(fs.readFileSync(other.result));
      assert.notEqual(a.hooks, b.hooks); assert.ok(fs.existsSync(a.hooks) && fs.existsSync(b.hooks));
      write(f.result + '.release', ''); assert.equal(await first, 0);
      assert.equal(fs.existsSync(a.hooks), false); assert.equal(fs.existsSync(b.hooks), true);
    } finally { write(f.result + '.release', ''); write(other.result + '.release', ''); await Promise.all([first, second]); }
  });
}

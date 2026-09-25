import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = value => windows ? value.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`) : value;

function run(t, mode = 'bootstrap') {
    const dir = mkdtempSync(path.join(tmpdir(), 'moe gui runtime '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    const nodeBin = path.join(home, '.local/share/moe/node/current/bin');
    const agentBin = path.join(home, '.local/share/moe/npm/bin');
    for (const folder of [bin, nodeBin, agentBin]) mkdirSync(folder, { recursive: true });
    const executable = (file, body) => writeFileSync(file, '#!/bin/bash\n' + body, { mode: 0o755 });
    executable(path.join(bin, 'dirname'), 'printf "%s\\n" "${1%/*}"\n');
    executable(path.join(agentBin, 'claude'), 'exit 0\n');
    const nodeBody = version => `command -v claude >/dev/null || exit 9\nprintf '${version}\\n'\n`;
    if (mode !== 'path') executable(path.join(nodeBin, 'node'), nodeBody('v24.99.0'));
    if (mode === 'path') executable(path.join(bin, 'node'), nodeBody('v22.99.0'));
    if (mode === 'old-system') executable(path.join(bin, 'node'), nodeBody('v12.99.0'));
    const override = path.join(bin, 'requested-node');
    if (mode === 'override') executable(override, nodeBody('v26.99.0'));

    return spawnSync(bash, ['--noprofile', '--norc', '-c', 'PATH="$MOE_FIXTURE_PATH"; export PATH; exec /bin/bash "$MOE_FIXTURE_SCRIPT" --help'], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOME: shellPath(home), MOE_FIXTURE_PATH: shellPath(bin), MOE_FIXTURE_SCRIPT: shellPath(path.join(root, 'scripts/moe-agent.sh')), MOE_NODE_COMMAND: mode === 'override' ? shellPath(override) : '', MOE_WORKER_ID: '' }
    });
}

for (const [mode, version] of [['bootstrap', 'v24.99.0'], ['path', 'v22.99.0'], ['old-system', 'v24.99.0'], ['override', 'v26.99.0']]) {
    test(`agent wrapper discovers bootstrap CLI bins and honors ${mode} Node selection`, t => {
        const result = run(t, mode);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.stdout.includes(version), result.stdout);
        assert.ok(result.stdout.includes('Moe Agent Wrapper'), 'help should succeed without daemon or project setup');
    });
}

// Branch safety: the REAL ensure_safe_branch / Ensure-MoeSafeBranch, sliced
// from both wrappers (never a copy), run against a throwaway repo. The default
// peel must stay as it is for every project; a consolidationBranch naming the
// default branch keeps a main-direct project on it without a checkout.
const wrapper = name => readFileSync(new URL(`../moe-agent.${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function between(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
    return source.slice(from, to);
}
const shBranch = between(wrapper('sh'), '# ---- branch safety', '# ---- commit messages');
const psSource = wrapper('ps1');
const psFunction = start => between(psSource, start, '\n}\n') + '\n}\n';
const psBranch = psFunction('function Invoke-MoeGit {') + psFunction('function Ensure-MoeSafeBranch(');
const engines = windows
    ? [['bash', bash], ['powershell', 'powershell.exe'], ['pwsh', 'pwsh.exe']]
    : [['bash', bash]];

function git(cwd, ...args) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
}
const head = top => git(top, 'symbolic-ref', '--short', 'HEAD');
const reflogLength = top => git(top, 'reflog').split('\n').length;

function repo(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'moe-branch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const top = path.join(dir, 'work');
    git(dir, 'init', '-q', '-b', 'main', top);
    for (const [key, value] of [['user.email', 'fixture@example.invalid'], ['user.name', 'fixture'], ['commit.gpgsign', 'false']]) git(top, 'config', key, value);
    writeFileSync(path.join(top, 'f'), 'base\n');
    git(top, 'add', 'f');
    git(top, 'commit', '-qm', 'init');
    return top;
}

function ensureSafeBranch(engine, executable, top, consolidationBranch) {
    const repoPath = top.replaceAll('\\', '/');
    const script = engine === 'bash'
        ? `YELLOW=''; NC=''\n${shBranch}\nMOE_TOP='${repoPath}'; CS_CONSOLIDATION_BRANCH='${consolidationBranch}'\nensure_safe_branch; rc=$?\nprintf '\\036%s\\036%s' "$rc" "$MOE_SHARED_BRANCH"\n`
        : `﻿$ErrorActionPreference = 'Stop'\n${psBranch}\n$branch = Ensure-MoeSafeBranch '${repoPath}' @{ consolidationBranch = '${consolidationBranch}' }\n$rc = 1; if ($branch) { $rc = 0 }\n[Console]::Write(([char]30).ToString() + $rc + [char]30 + $branch)\n`;
    const dir = mkdtempSync(path.join(tmpdir(), 'moe-branch-script-'));
    try {
        const file = path.join(dir, engine === 'bash' ? 'branch.sh' : 'branch.ps1');
        writeFileSync(file, script);
        const args = engine === 'bash'
            ? ['--noprofile', '--norc', file.replaceAll('\\', '/')]
            : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
        const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const parts = result.stdout.split('\x1e');
        assert.equal(parts.length, 3, result.stdout);
        return { log: parts[0], rc: Number(parts[1]), branch: parts[2] };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const mainDirect = 'settings.consolidationBranch names the default branch (main-direct project).';
for (const [engine, executable] of engines) {
    test(`${engine}: branch safety peels main onto moe/work-<date> when no consolidationBranch is set`, t => {
        const top = repo(t);
        const r = ensureSafeBranch(engine, executable, top, '');
        assert.equal(r.rc, 0, r.log);
        assert.match(r.branch, /^moe\/work-\d{4}-\d{2}-\d{2}$/);
        assert.equal(head(top), r.branch);
        assert.ok(r.log.includes(`[branch] on main; switching to ${r.branch} so we don't commit to the default branch.`), r.log);
    });

    test(`${engine}: branch safety stays on main without a checkout when consolidationBranch is main`, t => {
        const top = repo(t);
        writeFileSync(path.join(top, 'f'), 'a peer edit in the shared tree\n');
        const before = reflogLength(top);
        const r = ensureSafeBranch(engine, executable, top, 'main');
        assert.equal(r.rc, 0, r.log);
        assert.equal(r.branch, 'main');
        assert.equal(head(top), 'main');
        assert.equal(reflogLength(top), before, 'no checkout may run: ' + git(top, 'reflog', '-1'));
        assert.ok(r.log.includes(`[branch] staying on main: ${mainDirect}`), r.log);
        assert.ok(!r.log.includes('switching to'), r.log);
    });

    test(`${engine}: branch safety checks out main from a detached HEAD without claiming to leave the default branch`, t => {
        const top = repo(t);
        git(top, 'checkout', '-q', '--detach');
        const r = ensureSafeBranch(engine, executable, top, 'main');
        assert.equal(r.rc, 0, r.log);
        assert.equal(r.branch, 'main');
        assert.equal(head(top), 'main');
        assert.ok(r.log.includes(`[branch] on HEAD; checking out main: ${mainDirect}`), r.log);
        assert.ok(!r.log.includes("so we don't commit to the default branch"), r.log);
    });

    test(`${engine}: branch safety refuses and names the target when the checkout fails`, t => {
        const top = repo(t);
        git(top, 'checkout', '-q', '-b', 'side');
        writeFileSync(path.join(top, 'f'), 'side\n');
        git(top, 'commit', '-qam', 'side');
        git(top, 'checkout', '-q', 'main');
        writeFileSync(path.join(top, 'f'), 'a local edit the checkout would overwrite\n');
        const r = ensureSafeBranch(engine, executable, top, 'side');
        assert.notEqual(r.rc, 0, r.log);
        assert.equal(r.branch, '');
        assert.equal(head(top), 'main');
        assert.ok(r.log.includes('[WARN] [branch] failed to switch off main onto side; refusing to commit to the default branch.'), r.log);
    });
}

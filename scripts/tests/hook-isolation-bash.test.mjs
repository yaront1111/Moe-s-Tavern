import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(new URL('../moe-agent.sh', import.meta.url), 'utf8');
const start = source.indexOf('moe_commit_with_hooks() {');
const helper = start < 0 ? '' : source.slice(start, source.indexOf('\n}\n', start) + 3);
const cleanEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull };

for (const mode of ['success', 'reject', 'mutate', 'cas-race', 'conditional-hooks', 'conditional-signing', 'conditional-identity', 'conditional-default-key']) {
    test(`Bash hook isolation ${mode} preserves the validated tree and original index`, t => {
        const scratch = mkdtempSync(join(tmpdir(), 'moe-bash-hooks-'));
        t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));
        const root = join(scratch, 'git');
        const hooks = join(scratch, 'hooks');
        mkdirSync(root); mkdirSync(hooks);
        const git = (args, env = cleanEnvironment) => execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        git(['init', '--quiet', '-b', 'task-branch']);
        git(['config', 'user.name', 'Hook Test']);
        git(['config', 'user.email', 'hook@example.invalid']);
        git(['config', 'commit.gpgsign', 'false']);
        git(['config', 'core.autocrlf', 'false']);
        writeFileSync(join(root, 'a.txt'), 'base\n'); writeFileSync(join(root, 'peer.txt'), 'peer base\n');
        git(['add', '--all']); git(['commit', '--quiet', '-m', 'fixture base']);
        const base = git(['rev-parse', 'HEAD']);
        writeFileSync(join(root, 'peer.txt'), 'peer staged\n'); git(['add', 'peer.txt']);
        const originalIndex = readFileSync(join(root, '.git', 'index'));
        const index = join(scratch, 'private-index');
        const indexEnvironment = { ...cleanEnvironment, GIT_INDEX_FILE: index };
        git(['read-tree', base], indexEnvironment);
        writeFileSync(join(root, 'a.txt'), 'selected snapshot\n'); git(['add', 'a.txt'], indexEnvironment);
        const tree = git(['write-tree'], indexEnvironment);
        const marker = join(scratch, 'hook-ran');
        // A worktree config include must still take effect in the private hook repository.
        git(['config', 'extensions.worktreeConfig', 'true']);
        if (mode !== 'conditional-hooks') git(['config', '--worktree', 'core.hooksPath', hooks.replaceAll('\\', '/')]);
        if (mode.startsWith('conditional-')) {
            const conditional = join(scratch, 'conditional-config');
            const setting = mode === 'conditional-hooks' ? 'core.hooksPath' : mode === 'conditional-signing' ? 'commit.gpgSign'
                : mode === 'conditional-default-key' ? 'gpg.ssh.defaultKeyCommand' : 'user.name';
            if (mode === 'conditional-default-key') git(['config', 'gpg.format', 'ssh']);
            git(['config', '--file', conditional, setting,
                mode === 'conditional-hooks' ? hooks.replaceAll('\\', '/') : mode === 'conditional-signing' ? 'true'
                    : mode === 'conditional-default-key' ? 'false' : 'Conditional Fixture Author']);
            git(['config', `includeIf.gitdir:${root.replaceAll('\\', '/')}/.git.path`, conditional.replaceAll('\\', '/')]);
        }
        const hook = ['#!/bin/sh', ': > "$MOE_HOOK_MARKER"'];
        if (mode === 'reject') hook.push('exit 1');
        if (mode === 'mutate') hook.push('printf "hook mutation\\n" > a.txt', 'git add -- a.txt');
        hook.push('exit 0');
        writeFileSync(join(hooks, 'pre-commit'), hook.join('\n') + '\n', { mode: 0o755 });
        writeFileSync(join(root, 'a.txt'), 'later worktree bytes\n');
        writeFileSync(join(scratch, 'message'), 'fixture hook commit\n');
        const script = `${helper}\ncreate_secure_temp() { mktemp -d "$FIXTURE_SCRATCH/private.XXXXXX"; }
MOE_TOP="$FIXTURE_ROOT"; MOE_GITDIR="$FIXTURE_ROOT/.git"
moe_commit_with_hooks "$FIXTURE_BASE" "$FIXTURE_TREE" "$FIXTURE_INDEX" "$FIXTURE_SCRATCH/message" "$FIXTURE_SCRATCH/hook-error"
printf '%s\\n%s\\n' "$?" "$HOOK_COMMIT_SHA" > "$FIXTURE_SCRATCH/result"
`;
        const scriptPath = join(scratch, 'run.sh'); writeFileSync(scriptPath, script);
        const run = spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', [scriptPath], {
            encoding: 'utf8', windowsHide: true, timeout: 30_000,
            env: { ...cleanEnvironment, FIXTURE_ROOT: root.replaceAll('\\', '/'), FIXTURE_SCRATCH: scratch.replaceAll('\\', '/'),
                FIXTURE_BASE: base, FIXTURE_TREE: tree, FIXTURE_INDEX: index.replaceAll('\\', '/'), MOE_HOOK_MARKER: marker.replaceAll('\\', '/') },
        });
        assert.equal(run.status, 0, run.stderr);
        const [status, sha] = readFileSync(join(scratch, 'result'), 'utf8').trimEnd().split('\n');
        const mismatch = mode === 'conditional-signing' || mode === 'conditional-identity' || mode === 'conditional-default-key';
        assert.equal(existsSync(marker), !mismatch, 'configured hooks run only after signing and identity agree');
        assert.equal(git(['rev-parse', 'HEAD']), base, 'private commit creation cannot publish');
        assert.deepEqual(readFileSync(join(root, '.git', 'index')), originalIndex);
        assert.equal(git(['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
        if (mode === 'reject' || mode === 'mutate' || mismatch) {
            assert.notEqual(status, '0');
            assert.equal(sha ?? '', '');
            if (mismatch) assert.match(readFileSync(join(scratch, 'hook-error'), 'utf8'), /hooked-commit-config-mismatch/);
        } else {
            assert.equal(status, '0');
            assert.match(sha, /^[0-9a-f]{40,64}$/);
            assert.equal(git(['show', '-s', '--format=%P', sha]), base);
            assert.equal(git(['rev-parse', `${sha}^{tree}`]), tree);
            assert.equal(git(['show', `${sha}:a.txt`]), 'selected snapshot');
            if (mode === 'cas-race') {
                const competitor = git(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'competing update']);
                git(['update-ref', 'refs/heads/task-branch', competitor, base]);
                const publish = spawnSync('git', ['-C', root, 'update-ref', 'refs/heads/task-branch', sha, base], {
                    encoding: 'utf8', windowsHide: true, env: cleanEnvironment,
                });
                assert.notEqual(publish.status, 0);
                assert.equal(git(['rev-parse', 'HEAD']), competitor);
            }
        }
    });
}

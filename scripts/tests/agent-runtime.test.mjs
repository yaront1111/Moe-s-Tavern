import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

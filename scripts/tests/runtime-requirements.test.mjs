import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const daemon = JSON.parse(readFileSync(path.join(root, 'packages/moe-daemon/package.json'), 'utf8'));
const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(daemon.engines.node);
assert.ok(minimum, 'runtime checks require an explicit minimum Node version');
const dockerfile = readFileSync(path.join(root, 'packages/moe-daemon/Dockerfile'), 'utf8').replaceAll('\r\n', '\n');
const images = [...dockerfile.matchAll(/^FROM node:(\d+)(?:\.(\d+))?(?:\.(\d+))?[^\s]* AS (\w+)$/gm)];

for (const stage of ['builder', 'production']) {
  test(`Docker ${stage} image satisfies the daemon Node minimum`, () => {
    const image = images.find(match => match[4] === stage);
    assert.ok(image, `missing Node image for ${stage}`);
    const actual = image.slice(1, 4).map(value => Number(value ?? 0));
    const required = minimum.slice(1).map(Number);
    const firstDifference = actual.findIndex((value, index) => value !== required[index]);
    assert.ok(firstDifference === -1 || actual[firstDifference] > required[firstDifference],
      `${image[0]} cannot satisfy Node ${daemon.engines.node}`);
  });
}

const dockerStub = `#!/bin/bash
if [ "$1" = run ]; then
  case "$MOE_DOCKER_SMOKE_MODE" in
    fail) exit 43 ;;
    mismatch) echo not-the-package-version ;;
    match) printf '%s\\n' "$MOE_EXPECTED_DOCKER_VERSION" ;;
  esac
fi
`;

for (const [mode, exitCode] of [['fail', 43], ['mismatch', 1], ['match', 0]]) {
  test(`Docker CI smoke ${mode} has exit ${exitCode}`, t => {
    const workflow = readFileSync(path.join(root, '.github/workflows/docker.yml'), 'utf8').replaceAll('\r\n', '\n');
    const step = workflow.slice(workflow.indexOf('      - name: Test Docker image'));
    assert.match(step, /run: \|\n/);
    const commands = step.split('run: |\n')[1].split('\n')
      .filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), 'moe docker smoke '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), dockerStub, { mode: 0o755 });
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    const result = spawnSync(bash, ['-e', '-c', commands], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        DOCKER_HOST: 'tcp://127.0.0.1:1', MOE_DOCKER_SMOKE_MODE: mode, MOE_EXPECTED_DOCKER_VERSION: daemon.version },
    });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode, result.stdout + result.stderr);
  });
}

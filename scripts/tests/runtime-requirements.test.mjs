import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// docker.yml's whole "Test Docker image" step runs under bash -e, behind shell-function stubs for docker, curl and
// sleep. They are functions, not PATH files, because Git for Windows' bin/bash.exe puts /mingw64/bin and /usr/bin
// ahead of any PATH we pass, so a curl or sleep file would lose to the real curl.exe and sleep.exe. The docker stub
// refuses subcommands it does not model, so a step that grows a docker call fails here by name instead of timing
// out. /health answers only at the address `docker port` reports. Git Bash hands node.exe EXPECTED="$PWD" as `pwd -W`
// (D:/...), so the daemon reports that spelling there and plain pwd elsewhere.
const smokeStubs = `
docker() {
  case "$1" in
    build|logs|rm) ;;
    run)
      if [ "$2" = -d ]; then echo moe-smoke-container; return; fi
      case "$MOE_DOCKER_SMOKE_MODE" in
        fail) return 43 ;;
        mismatch) echo not-the-package-version ;;
        *) echo "$MOE_EXPECTED_DOCKER_VERSION" ;;
      esac ;;
    port) echo 127.0.0.1:49153 ;;
    inspect) if [ "$MOE_DOCKER_SMOKE_MODE" = healthcheck-fails ]; then echo 'exit 3'; else echo 'exit 0'; fi ;;
    exec) shift 2; "$@" ;;
    *) echo "docker stub: unexpected docker $*" >&2; return 97 ;;
  esac
}
curl() {
  case "$*" in *' http://127.0.0.1:49153/health') ;; *) return 7 ;; esac
  [ "$MOE_DOCKER_SMOKE_MODE" != no-health ] || return 7
  local status=healthy project
  project=$(pwd -W 2>/dev/null || pwd)
  case "$MOE_DOCKER_SMOKE_MODE" in
    other-project) project=/elsewhere ;;
    unhealthy) status=starting ;;
  esac
  printf '{"status":"%s","projectPath":"%s"}' "$status" "$project"
}
sleep() { :; }
`;

// [mode, the step's exit code, text its output must contain]
const smokeCases = [
  ['fail', 43, []],
  ['mismatch', 1, ['Expected daemon version', 'got: not-the-package-version']],
  ['match', 0, ['healthy: ', 'image HEALTHCHECK passed']],
  ['no-health', 1, ['Expected a healthy daemon serving', 'got: no answer']],
  ['other-project', 1, ['Expected a healthy daemon serving', '"projectPath":"/elsewhere"']],
  ['unhealthy', 1, ['Expected a healthy daemon serving', '"status":"starting"']],
  ['healthcheck-fails', 3, ['healthy: ']],
];

for (const [mode, exitCode, shows] of smokeCases) {
  test(`Docker CI smoke ${mode} has exit ${exitCode}`, () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/docker.yml'), 'utf8').replaceAll('\r\n', '\n');
    const step = workflow.slice(workflow.indexOf('      - name: Test Docker image'));
    assert.match(step, /run: \|\n/);
    const commands = step.split('run: |\n')[1].split('\n')
      .filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    const result = spawnSync(bash, ['-e', '-c', smokeStubs + commands], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1', MOE_DOCKER_SMOKE_MODE: mode,
        MOE_EXPECTED_DOCKER_VERSION: daemon.version },
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, exitCode, output);
    for (const text of shows) assert.ok(output.includes(text), `missing ${JSON.stringify(text)} in: ${output}`);
    if (mode !== 'match') assert.ok(!output.includes('image HEALTHCHECK passed'), output);
  });
}

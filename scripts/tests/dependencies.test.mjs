// Dependency installation is exercised entirely with fake tools and a temporary HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../install-dependencies.sh', import.meta.url));
const windows = process.platform === 'win32';
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = value => windows ? value.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`) : value;

function fixture(t, ready = ['git', 'python3', 'curl', 'tar', 'node', 'npm', 'claude', 'tmux']) {
  assert.ok(fs.existsSync(helper), 'dependency bootstrap helper is missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe dependency test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['bin', 'ready', 'profile', 'global/bin']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  for (const name of ready) fs.writeFileSync(path.join(dir, 'ready', name), '');
  const stub = `#!/bin/bash
tool="\${0##*/}"
printf '%s %s\\n' "$tool" "$*" >> "$MOE_FIXTURE/log"
case "$tool" in
  uname) if [ "$1" = '-m' ]; then echo "\${MOE_FIXTURE_ARCH:-x86_64}"; else echo "\${MOE_FIXTURE_OS:-Linux}"; fi ;;
  id) echo 0 ;;
  sudo) exec "$@" ;;
  apt-get|dnf|brew)
    [ "$tool" = "\${MOE_FIXTURE_MANAGER:-apt-get}" ] || exit 127
    [ "\${MOE_FIXTURE_FAIL_MANAGER:-0}" = 0 ] || exit 41
    if [ "$1" = '--version' ]; then echo fixture; exit; fi
    if [ "$1" = '--prefix' ]; then echo "$MOE_FIXTURE/brew"; exit; fi
    for dep in git python3 curl tar javac tmux; do touch "$MOE_FIXTURE/ready/$dep"; done
    ;;
  sha256sum|shasum)
    if [ "\${MOE_FIXTURE_BAD_HASH:-0}" = 1 ]; then printf '%064d  archive\\n' 1; else printf '%064d  archive\\n' 0; fi
    ;;
  node)
    [ -f "$MOE_FIXTURE/ready/node" ] || exit 127
    echo "\${MOE_FIXTURE_NODE_VERSION:-v24.99.0}"
    ;;
  npm)
    [ -f "$MOE_FIXTURE/ready/npm" ] || exit 127
    node --version >/dev/null || exit 127
    if [ "$1" = '--version' ]; then echo 11.0.0; exit; fi
    if [ "$1" = 'prefix' ]; then echo "$MOE_FIXTURE/global"; exit; fi
    if [ "$1" = 'config' ]; then echo "$MOE_FIXTURE/global"; exit; fi
    [ "\${MOE_FIXTURE_FAIL_NPM:-0}" = 0 ] || exit 42
    command=''
    prefix=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --prefix) prefix="$2"; shift ;;
        @anthropic-ai/claude-code) command=claude ;;
        @openai/codex) command=codex ;;
        @google/gemini-cli) command=gemini ;;
      esac
      shift
    done
    if [ -n "$command" ]; then
      mkdir -p "$prefix/bin"
      printf '#!/bin/bash\\necho fixture-agent\\n' > "$prefix/bin/$command"
      chmod +x "$prefix/bin/$command"
    fi
    ;;
  curl)
    [ -f "$MOE_FIXTURE/ready/curl" ] || exit 127
    [ "$1" != '--version' ] || { echo fixture; exit; }
    output=''
    while [ "$#" -gt 0 ]; do
      case "$1" in -o|--output) output="$2"; shift ;; esac
      shift
    done
    if [[ "$output" == *SHASUMS256.txt ]]; then
      printf '%064d  node-v24.99.0-%s-%s.tar.gz\\n' 0 "\${MOE_FIXTURE_NODE_OS:-linux}" "\${MOE_FIXTURE_NODE_ARCH:-x64}" > "$output"
    else printf 'fixture archive' > "$output"; fi
    ;;
  tar)
    [ -f "$MOE_FIXTURE/ready/tar" ] || exit 127
    [ "$1" != '--version' ] || { echo fixture; exit; }
    dest=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '-C' ]; then dest="$2"; shift; fi
      shift
    done
    package="$dest/node-v24.99.0-\${MOE_FIXTURE_NODE_OS:-linux}-\${MOE_FIXTURE_NODE_ARCH:-x64}"
    mkdir -p "$package/bin"
    printf '#!/bin/bash\\necho v24.99.0\\n' > "$package/bin/node"
    cp "$MOE_FIXTURE/bin/npm" "$package/bin/npm"
    touch "$MOE_FIXTURE/ready/npm"
    chmod +x "$package/bin/node" "$package/bin/npm"
    ;;
  javac) [ -f "$MOE_FIXTURE/ready/javac" ] || exit 127; echo 'javac 17.0.99' ;;
  git|python3|claude|codex|gemini|tmux)
    [ -f "$MOE_FIXTURE/ready/$tool" ] || exit 127
    echo fixture
    ;;
esac
`;
  for (const name of ['uname', 'id', 'sudo', 'apt-get', 'dnf', 'brew', 'sha256sum', 'shasum', 'node', 'npm', 'curl', 'tar', 'javac', 'git', 'python3', 'claude', 'codex', 'gemini', 'tmux']) {
    fs.writeFileSync(path.join(dir, 'bin', name), stub, { mode: 0o755 });
  }
  return dir;
}

function run(dir, agent = 'claude', plugin = false, extra = {}) {
  const script = path.join(dir, 'run.sh');
  // System JDK discovery is a boundary like apt/brew: constrain it to fake javac.
  // Hosted CI machines may have JDK17 in JAVA_HOME or the helper's absolute paths.
  fs.writeFileSync(script, `#!/bin/bash\nset -e\nexport PATH="$MOE_FIXTURE/bin:$PATH"\nsource "$MOE_HELPER"\nmoe_select_java17() { moe_java17_ready; }\nmoe_install_dependencies "$MOE_AGENT" "$MOE_PLUGIN"\nprintf 'BOOTSTRAP_OK\\n'\n`);
  return spawnSync(bash, [shellPath(script)], {
    encoding: 'utf8', timeout: 45000,
    env: {
      ...process.env, HOME: shellPath(path.join(dir, 'profile')), SHELL: '/bin/bash',
      PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      MOE_FIXTURE: shellPath(dir), MOE_HELPER: shellPath(helper), MOE_AGENT: agent, MOE_PLUGIN: String(plugin),
      ...extra,
    },
  });
}
const log = dir => fs.readFileSync(path.join(dir, 'log'), 'utf8');
const passed = result => assert.equal(result.status, 0, result.stdout + result.stderr);

test('existing compatible tools require no downloads, package installs, or npm config changes', t => {
  const dir = fixture(t);
  passed(run(dir));
  assert.doesNotMatch(log(dir), /apt-get (update|install)|dnf install|brew install|curl --fail|npm install|npm config set/);
});

for (const blocked of ['.local', '.local/share/moe/env.sh', '.profile']) {
  test(`environment persistence stops when ${blocked} cannot be written`, t => {
    const dir = fixture(t);
    const target = path.join(dir, 'profile', blocked);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (blocked === '.local') fs.writeFileSync(target, 'existing file');
    else fs.mkdirSync(target);
    const result = run(dir);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /BOOTSTRAP_OK|New terminals load Moe tools automatically/);
  });
}

for (const [manager, osName] of [['apt-get', 'Linux'], ['dnf', 'Linux'], ['brew', 'Darwin']]) {
  test(`missing native dependencies are installed through ${manager}`, t => {
    const dir = fixture(t, ['node', 'npm', 'claude']);
    passed(run(dir, 'claude', false, { MOE_FIXTURE_MANAGER: manager, MOE_FIXTURE_OS: osName }));
    assert.match(log(dir), new RegExp(`${manager} .*install.*git`));
    assert.match(log(dir), /python3/);
  });
}

test('missing Node and npm install a checksum-verified official Node 24 archive', t => {
  const dir = fixture(t, ['git', 'python3', 'curl', 'tar', 'claude']);
  passed(run(dir));
  const calls = log(dir);
  assert.match(calls, /https:\/\/nodejs.org\/dist\/latest-v24.x\/SHASUMS256.txt/);
  assert.match(calls, /sha256sum|shasum/);
  assert.ok(calls.indexOf('sha256sum ') < calls.indexOf('tar -xzf '));
  assert.equal(fs.existsSync(path.join(dir, 'profile/.local/share/moe/node/current/bin/node')), true);
});

test('old Node is upgraded and a checksum mismatch prevents extraction', t => {
  const dir = fixture(t);
  const result = run(dir, 'claude', false, { MOE_FIXTURE_NODE_VERSION: 'v18.20.0', MOE_FIXTURE_BAD_HASH: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum/i);
  assert.doesNotMatch(log(dir), /tar -xzf/);
});

for (const [agent, pkg] of [['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['gemini', '@google/gemini-cli']]) {
  test(`missing ${agent} installs its official package in a user prefix`, t => {
    const dir = fixture(t, ['git', 'python3', 'curl', 'tar', 'node', 'npm']);
    passed(run(dir, agent));
    assert.match(log(dir), new RegExp(`npm install --global --prefix .* ${pkg.replaceAll('/', '\\/')}`));
    assert.doesNotMatch(log(dir), /npm config set|sudo npm/);
    assert.equal(fs.existsSync(path.join(dir, `profile/.local/share/moe/npm/bin/${agent}`)), true);
  });
}

test('none skips agent installation and profile setup is idempotent', t => {
  const dir = fixture(t);
  passed(run(dir, 'none'));
  passed(run(dir, 'none'));
  assert.doesNotMatch(log(dir), /npm install/);
  const profile = fs.readFileSync(path.join(dir, 'profile/.bashrc'), 'utf8');
  assert.equal((profile.match(/env\.sh/g) || []).length, 2, 'one guarded source line contains the path twice');
});

test('missing package manager fails actionably without a success claim', t => {
  const dir = fixture(t, ['node', 'npm']);
  const result = run(dir, 'none', false, { MOE_FIXTURE_MANAGER: 'none' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package manager|Homebrew/);
  assert.doesNotMatch(result.stdout, /BOOTSTRAP_OK/);
});

test('agent installation failure propagates and never claims ready', t => {
  const dir = fixture(t, ['git', 'python3', 'curl', 'tar', 'node', 'npm']);
  const result = run(dir, 'codex', false, { MOE_FIXTURE_FAIL_NPM: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /BOOTSTRAP_OK/);
});

test('plugin opt-in installs JDK17 while ordinary bootstrap skips Java', t => {
  const dir = fixture(t);
  passed(run(dir, 'none', true));
  assert.match(log(dir), /apt-get .*install.*openjdk-17-jdk/);
});

test('plugin dependency fixtures ignore Java installed outside their fake tool set', t => {
  const dir = fixture(t);
  const unrelatedJava = path.join(dir, 'unrelated-java');
  fs.mkdirSync(path.join(unrelatedJava, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(unrelatedJava, 'bin', 'javac'), '#!/bin/bash\necho "javac 17.0.99"\n', { mode: 0o755 });
  passed(run(dir, 'none', true, { JAVA_HOME: shellPath(unrelatedJava) }));
  assert.match(log(dir), /apt-get .*install.*openjdk-17-jdk/);
});

test('Bash login startup selection is preserved when only .profile exists', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'profile/.profile'), 'export EXISTING_SETTING=keep\n');
  passed(run(dir, 'none'));
  assert.equal(fs.existsSync(path.join(dir, 'profile/.bash_profile')), false, 'creating .bash_profile hides the existing .profile');
  assert.match(fs.readFileSync(path.join(dir, 'profile/.profile'), 'utf8'), /EXISTING_SETTING=keep/);
});

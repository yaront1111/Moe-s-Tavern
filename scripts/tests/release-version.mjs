import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const validator = fileURLToPath(new URL('../verify-release-version.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packages = ['packages/moe-daemon', 'packages/moe-proxy', 'packages/moe-claude-plugin', 'moe-vscode'];
const plugin = 'packages/moe-claude-plugin/.claude-plugin/plugin.json';
const gradle = 'moe-jetbrains/build.gradle.kts';
const iss = 'installer/moe-installer.iss';

const writeJson = (root, file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data));
const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const edit = (file, change) => root => { const data = readJson(root, file); change(data); writeJson(root, file, data); };

// Independent of the guard: one entry per guarded field, with the mutation that sets it to a version.
const fields = [
  ...packages.flatMap(dir => [
    { label: `${dir}/package.json`, set: (root, v) => edit(`${dir}/package.json`, d => { d.version = v; })(root) },
    { label: `${dir}/package-lock.json version`, set: (root, v) => edit(`${dir}/package-lock.json`, d => { d.version = v; })(root) },
    { label: `${dir}/package-lock.json packages[""].version`, set: (root, v) => edit(`${dir}/package-lock.json`, d => { d.packages[''].version = v; })(root) },
  ]),
  { label: plugin, set: (root, v) => edit(plugin, d => { d.version = v; })(root) },
  { label: gradle, set: (root, v) => fs.writeFileSync(path.join(root, gradle), `version = "${v}"\n`) },
  { label: iss, set: (root, v) => fs.writeFileSync(path.join(root, iss), `[Setup]\nAppName=Moe\nAppVersion=${v}\n`) },
];

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-release-version-'));
  try {
    for (const dir of [...packages, 'packages/moe-claude-plugin/.claude-plugin', 'moe-jetbrains', 'installer']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const dir of packages) {
      writeJson(root, `${dir}/package.json`, { name: dir, version: '0.8.0' });
      writeJson(root, `${dir}/package-lock.json`, { name: dir, version: '0.8.0', lockfileVersion: 3, packages: { '': { name: dir, version: '0.8.0' } } });
    }
    writeJson(root, plugin, { name: 'moe', version: '0.8.0' });
    fs.writeFileSync(path.join(root, gradle), 'version = "0.8.0"\n');
    fs.writeFileSync(path.join(root, iss), '[Setup]\nAppName=Moe\nAppVersion=0.8.0\n');
    run(root);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const run = (root, tag = 'v0.8.0') => spawnSync(process.execPath, [validator, tag], { cwd: root, encoding: 'utf8' });

test('matching release tag and packaged versions pass', () => fixture(root => {
  const output = execFileSync(process.execPath, [validator, 'v0.8.0'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /PASS release versions: 0\.8\.0/);
}));

for (const field of fields) {
  test(`rejects mismatched ${field.label} before publication, then passes once restored`, () => fixture(root => {
    field.set(root, '0.6.0');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${field.label}: found 0.6.0, expected 0.8.0`), result.stderr);
    for (const other of fields) {
      if (other !== field) assert.ok(!result.stderr.split('\n').some(line => line.startsWith(`${other.label}:`)), `${other.label} named in ${result.stderr}`);
    }
    field.set(root, '0.8.0');
    const restored = run(root);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /PASS release versions: 0\.8\.0/);
  }));
}

test('reports two mismatches in one run', () => fixture(root => {
  fields[1].set(root, '0.6.0');
  fields.at(-2).set(root, '0.7.0');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`${fields[1].label}: found 0.6.0`));
  assert.ok(result.stderr.includes(`${gradle}: found 0.7.0`));
}));

test('a CRLF installer script still reads', () => fixture(root => {
  fs.writeFileSync(path.join(root, iss), '[Setup]\r\nAppName=Moe\r\nAppVersion=0.8.0\r\n');
  assert.equal(run(root).status, 0);
}));

test('a missing or malformed guarded file gives a one-line verdict, no stack trace', () => fixture(root => {
  fs.rmSync(path.join(root, 'packages/moe-claude-plugin/package-lock.json'));
  fs.writeFileSync(path.join(root, plugin), 'not json');
  writeJson(root, 'moe-vscode/package-lock.json', { version: '0.8.0' });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('packages/moe-claude-plugin/package-lock.json version: unreadable'));
  assert.ok(result.stderr.includes(`${plugin}: unreadable`));
  assert.ok(result.stderr.includes('moe-vscode/package-lock.json packages[""].version: unreadable'));
  assert.ok(!result.stderr.split('\n').some(line => /^\s+at /.test(line)), result.stderr);
}));

test('rejects missing or malformed tags', () => fixture(root => {
  for (const tag of ['', 'latest', 'v0.8']) {
    const result = run(root, tag);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release tag/);
  }
}));

test('the repository itself is in sync with its daemon version', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/moe-daemon/package.json'), 'utf8'));
  const result = run(repoRoot, `v${version}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`PASS release versions: ${version.replace(/\./g, '\\.')}`));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const validator = fileURLToPath(new URL('../verify-release-version.mjs', import.meta.url));
const manifests = ['packages/moe-daemon/package.json', 'packages/moe-proxy/package.json', 'moe-vscode/package.json'];

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-release-version-'));
  try {
    for (const file of manifests) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify({ version: '0.8.0' }));
    }
    fs.mkdirSync(path.join(root, 'moe-jetbrains'));
    fs.writeFileSync(path.join(root, 'moe-jetbrains/build.gradle.kts'), 'version = "0.8.0"\n');
    run(root);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('matching release tag and packaged versions pass', () => fixture(root => {
  const output = execFileSync(process.execPath, [validator, 'v0.8.0'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /PASS release versions: 0\.8\.0/);
}));

for (const file of [...manifests, 'moe-jetbrains/build.gradle.kts']) {
  test(`rejects mismatched ${file} before publication`, () => fixture(root => {
    fs.writeFileSync(path.join(root, file), file.endsWith('.json') ? '{"version":"0.6.0"}' : 'version = "0.6.0"\n');
    const result = spawnSync(process.execPath, [validator, 'v0.8.0'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(file));
    assert.match(result.stderr, /expected 0\.8\.0/);
  }));
}

test('rejects missing or malformed tags', () => fixture(root => {
  for (const tag of ['', 'latest', 'v0.8']) {
    const result = spawnSync(process.execPath, [validator, tag], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release tag/);
  }
}));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const required = ['certified-provider.json', 'multipass.mjs', 'doctor.mjs', 'cli.mjs'];
const excluded = ['sentinel.test.mjs', 'nested/sentinel.spec.mjs', 'nested/tests/data.json',
  'nested/__tests__/data.json', 'nested/fixtures/data.json', 'nested/__fixtures__/data.json'];
const excludedPatterns = ['**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**', '**/fixtures/**', '**/__fixtures__/**'];

function fixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe runner bundle '));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));
  const put = (relative, content = '') => {
    const dest = path.join(scratch, relative);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };
  put('moe-vscode/scripts/bundle-assets.mjs', readFileSync(path.join(root, 'moe-vscode/scripts/bundle-assets.mjs')));
  for (const name of ['moe-daemon', 'moe-proxy']) {
    put(`packages/${name}/dist/index.js`, 'export {};\n');
    put(`packages/${name}/package.json`, '{"type":"module","version":"0.0.0-fixture"}');
    put(`packages/${name}/node_modules/dependency/index.js`);
    put(`packages/${name}/node_modules/.bin/not-production`);
  }
  for (const name of ['moe-agent.ps1', 'moe-agent.sh', 'moe-call.sh', 'prompt-cache.mjs', 'prompt-cache-policy.mjs', 'prompt-cache-usage.mjs',
    'usage-receipt.mjs', 'usage-session.mjs', 'usage-report.mjs', 'analyze-usage.mjs', 'moe-account-lease.mjs']) {
    put(`scripts/${name}`, readFileSync(path.join(root, 'scripts', name)));
  }
  put('scripts/mods/example/runtime.mjs');
  put('scripts/mods/example/runtime.test.ts');
  for (const name of ['architect', 'qa', 'worker']) put(`docs/roles/${name}.md`);
  cpSync(path.join(root, 'scripts/local-runner'), path.join(scratch, 'scripts/local-runner'), { recursive: true });
  put('scripts/local-runner/nested/production.mjs', 'export const copied = true;\n');
  for (const name of excluded) put(`scripts/local-runner/${name}`, 'test-only fixture\n');
  return { scratch, output: path.join(scratch, 'moe-vscode/bundled'), put };
}

function bundle(fixture) {
  return spawnSync(process.execPath, [path.join(fixture.scratch, 'moe-vscode/scripts/bundle-assets.mjs')], {
    cwd: fixture.scratch, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

function requireBundle(fixture) {
  const run = bundle(fixture);
  assert.equal(run.status, 0, `Actual bundler failed: ${run.stdout}${run.stderr}`);
}

test('actual VS Code bundler copies importable provider modules and pinned manifest', async t => {
  const work = fixture(t);
  requireBundle(work);
  for (const name of required) {
    const output = path.join(work.output, 'scripts/local-runner', name);
    assert.ok(existsSync(output), `Missing copied provider asset ${name}`);
    assert.deepEqual(readFileSync(output), readFileSync(path.join(root, 'scripts/local-runner', name)));
  }
  const doctor = await import(pathToFileURL(path.join(work.output, 'scripts/local-runner/doctor.mjs')).href);
  assert.equal((await doctor.loadCertifiedProvider()).images.x64.sha256, '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94');
  const result = await doctor.runDoctor({ host: { platform: 'linux', arch: 'x64' }, run: async (_exe, args) => ({
    stdout: args[0] === 'version' ? '{"multipass":"1.17.0","multipassd":"1.17.0"}' : args[1] === 'local.driver' ? 'qemu' : 'primary', stderr: '',
  }) });
  assert.equal(result.providerReady, true);
  assert.equal(result.executionReady, false);
  const nested = await import(pathToFileURL(path.join(work.output, 'scripts/local-runner/nested/production.mjs')).href);
  assert.equal(nested.copied, true);
});

test('actual bundler excludes root and nested tests/spec fixtures while retaining existing exclusions', t => {
  const work = fixture(t);
  requireBundle(work);
  for (const name of excluded) assert.equal(existsSync(path.join(work.output, 'scripts/local-runner', name)), false, `Leaked test asset ${name}`);
  assert.equal(existsSync(path.join(work.output, 'scripts/mods/example/runtime.test.ts')), false);
  assert.equal(existsSync(path.join(work.output, 'daemon/node_modules/.bin/not-production')), false);
});

test('actual bundler refuses a missing required provider asset', t => {
  const work = fixture(t);
  rmSync(path.join(work.scratch, 'scripts/local-runner/doctor.mjs'));
  const run = bundle(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /local-runner.*doctor\.mjs/);
});

test('actual bundler refuses a directory masquerading as a required module', t => {
  const work = fixture(t);
  const target = path.join(work.scratch, 'scripts/local-runner/doctor.mjs');
  rmSync(target);
  mkdirSync(target);
  const run = bundle(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /local-runner.*doctor\.mjs/);
});

test('Gradle production script copy explicitly includes provider assets and excludes nested tests', () => {
  const source = readFileSync(path.join(root, 'moe-jetbrains/build.gradle.kts'), 'utf8');
  const block = source.match(/from\(repoRoot\.resolve\("scripts"\)\)\s*\{([\s\S]*?)into\("\$pluginContentRoot\/scripts"\)/)?.[1];
  assert.ok(block, 'Missing actual production scripts copy block');
  assert.ok(block.includes('include("local-runner/**")'), 'Gradle must copy the provider directory');
  for (const pattern of excludedPatterns) assert.ok(block.includes(`"local-runner/${pattern}"`), `Missing Gradle exclusion ${pattern}`);
});

test('actual bundled onboarding asset checks refuse each missing provider file', t => {
  const work = fixture(t);
  requireBundle(work);
  const source = readFileSync(path.join(root, 'scripts/tests/onboarding.mjs'), 'utf8');
  const boundary = source.indexOf('const require = createRequire(proxyEntry);');
  assert.ok(boundary > 0, 'Missing onboarding asset-check boundary');
  work.put('scripts/tests/onboarding-assets.mjs', source.slice(0, boundary));
  const check = () => spawnSync(process.execPath, [path.join(work.scratch, 'scripts/tests/onboarding-assets.mjs'), work.output], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  const present = check();
  assert.equal(present.status, 0, present.stdout + present.stderr);
  for (const name of required) {
    const target = path.join(work.output, 'scripts/local-runner', name);
    assert.ok(existsSync(target), `Missing copied provider asset ${name}`);
    renameSync(target, `${target}.saved`);
    try {
      const absent = check();
      assert.notEqual(absent.status, 0, `Onboarding accepted missing ${name}`);
      assert.match(absent.stderr, new RegExp(`Missing bundled local-runner/${name.replaceAll('.', '\\.')}`));
    } finally { renameSync(`${target}.saved`, target); }
  }
});

test('cross-platform CI permanently runs provider and actual bundle regressions', () => {
  const source = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(source, /run: node --test scripts\/tests\/local-runner\.test\.mjs scripts\/tests\/local-runner-bundle\.test\.mjs/);
});

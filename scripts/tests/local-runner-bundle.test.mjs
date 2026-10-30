import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const required = ['certified-provider.json', 'multipass.mjs', 'doctor.mjs', 'cli.mjs', 'vm-control.mjs'];
// CQ-R10d2's agent cache, CQ-R11e1's toolchain cache and CQ-R13d/R13e1's certify modules must ship too. Nothing wires them yet, so onboarding.mjs does not check
// them and they stay out of `required`, which the onboarding refusal row walks.
const shipped = [...required, 'agent-binaries.json', 'agent-cache.mjs', 'toolchain.json', 'toolchain-cache.mjs', 'certify.mjs', 'certify-bridge.mjs'];
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
  // Compiled tests and specs must never ship; production names that merely contain "test" must.
  for (const name of ['packages/moe-proxy/dist/index.test.js', 'packages/moe-proxy/dist/index.test.d.ts',
    'packages/moe-proxy/dist/utils.spec.js', 'packages/moe-daemon/dist/tools/sample.test.js']) put(name, 'export {};\n');
  for (const name of ['packages/moe-proxy/dist/latest.js', 'packages/moe-daemon/dist/tools/attestation.js']) put(name, 'export {};\n');
  for (const name of ['moe-agent.ps1', 'moe-agent.sh', 'moe-call.sh', 'prompt-cache.mjs', 'prompt-cache-policy.mjs', 'prompt-cache-usage.mjs',
    'prompt-cache-witness.mjs', 'usage-receipt.mjs', 'usage-session.mjs', 'usage-report.mjs', 'analyze-usage.mjs', 'moe-account-lease.mjs']) {
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
  for (const name of shipped) {
    const output = path.join(work.output, 'scripts/local-runner', name);
    assert.ok(existsSync(output), `Missing copied provider asset ${name}`);
    assert.deepEqual(readFileSync(output), readFileSync(path.join(root, 'scripts/local-runner', name)));
  }
  const agents = await import(pathToFileURL(path.join(work.output, 'scripts/local-runner/agent-cache.mjs')).href);
  assert.deepEqual(await agents.loadAgentManifest(), JSON.parse(readFileSync(path.join(root, 'scripts/local-runner/agent-binaries.json'), 'utf8')));
  const toolchain = await import(pathToFileURL(path.join(work.output, 'scripts/local-runner/toolchain-cache.mjs')).href);
  assert.deepEqual(await toolchain.loadToolchainManifest(), JSON.parse(readFileSync(path.join(root, 'scripts/local-runner/toolchain.json'), 'utf8')));
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

test('actual bundler ships the codex witness helper that prompt-cache.mjs imports', t => {
  const work = fixture(t);
  requireBundle(work);
  const scripts = path.join(work.output, 'scripts');
  const witness = path.join(scripts, 'prompt-cache-witness.mjs');
  assert.ok(existsSync(witness), 'Missing bundled scripts/prompt-cache-witness.mjs');
  assert.deepEqual(readFileSync(witness), readFileSync(path.join(root, 'scripts/prompt-cache-witness.mjs')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOE_/i.test(key)));
  const codex = () => spawnSync(process.execPath, [path.join(scripts, 'prompt-cache.mjs'), 'codex-stream'], {
    input: '', env, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  const shipped = codex();
  assert.equal(shipped.status, 0, shipped.stdout + shipped.stderr);
  assert.match(shipped.stdout, /usage=unknown/);
  // A bundle without it fails at import on every codex seat (mem:gotcha-clean-snapshot-missing-prompt-cache-helper).
  rmSync(witness);
  const missing = codex();
  assert.notEqual(missing.status, 0, 'codex-stream ran without its witness module');
  assert.match(missing.stderr, /prompt-cache-witness\.mjs/);
  const gradle = readFileSync(path.join(root, 'moe-jetbrains/build.gradle.kts'), 'utf8');
  const block = gradle.match(/from\(repoRoot\.resolve\("scripts"\)\)\s*\{([\s\S]*?)into\("\$pluginContentRoot\/scripts"\)/)?.[1];
  assert.ok(block, 'Missing actual production scripts copy block');
  assert.ok(block.includes('include("prompt-cache*.mjs")'), 'Gradle must ship every prompt-cache*.mjs helper');
});

test('actual bundler excludes root and nested tests/spec fixtures while retaining existing exclusions', t => {
  const work = fixture(t);
  requireBundle(work);
  for (const name of excluded) assert.equal(existsSync(path.join(work.output, 'scripts/local-runner', name)), false, `Leaked test asset ${name}`);
  assert.equal(existsSync(path.join(work.output, 'scripts/mods/example/runtime.test.ts')), false);
  assert.equal(existsSync(path.join(work.output, 'daemon/node_modules/.bin/not-production')), false);
});

test('actual bundler drops compiled tests and specs from both dists', t => {
  const work = fixture(t);
  requireBundle(work);
  for (const name of ['proxy/index.test.js', 'proxy/index.test.d.ts', 'proxy/utils.spec.js', 'daemon/tools/sample.test.js']) {
    assert.equal(existsSync(path.join(work.output, name)), false, `Leaked compiled test ${name}`);
  }
  for (const name of ['proxy/index.js', 'daemon/index.js', 'proxy/latest.js', 'daemon/tools/attestation.js']) {
    assert.ok(existsSync(path.join(work.output, name)), `Dropped production file ${name}`);
  }
});

test('actual bundler refuses a missing required provider asset', t => {
  for (const name of ['doctor.mjs', 'vm-control.mjs']) {
    const work = fixture(t);
    rmSync(path.join(work.scratch, 'scripts/local-runner', name));
    const run = bundle(work);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, new RegExp(`local-runner.*${name.replaceAll('.', '\\.')}`));
  }
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

// Bundles the fixture for real, then returns the packaged-bundle half of onboarding.mjs as a re-runnable check.
function onboardingCheck(work) {
  requireBundle(work);
  const source = readFileSync(path.join(root, 'scripts/tests/onboarding.mjs'), 'utf8');
  const boundary = source.indexOf('const require = createRequire(proxyEntry);');
  assert.ok(boundary > 0, 'Missing onboarding asset-check boundary');
  work.put('scripts/tests/onboarding-assets.mjs', source.slice(0, boundary));
  return () => spawnSync(process.execPath, [path.join(work.scratch, 'scripts/tests/onboarding-assets.mjs'), work.output], {
    encoding: 'utf8', timeout: 40_000, windowsHide: true,
  });
}

test('actual bundled onboarding asset checks refuse each missing provider file', t => {
  const work = fixture(t);
  const check = onboardingCheck(work);
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

test('bundled onboarding loads the packaged vm-control import closure', t => {
  const work = fixture(t);
  const check = onboardingCheck(work);
  const clean = check();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const local = name => path.join(work.output, 'scripts/local-runner', name);
  // lifecycle.mjs is statically imported by vm-control.mjs but is in no required list.
  renameSync(local('lifecycle.mjs'), local('lifecycle.mjs.saved'));
  try {
    const broken = check();
    assert.notEqual(broken.status, 0, 'Onboarding accepted a broken vm-control import closure');
    assert.match(broken.stderr, /vm-control/);
  } finally { renameSync(local('lifecycle.mjs.saved'), local('lifecycle.mjs')); }
  // Right exit code, wrong stdout: the refusal body is checked, not only the status.
  writeFileSync(local('vm-control.mjs'), 'process.stdout.write(\'{"code":"OTHER"}\\n\'); process.exit(2);\n');
  const other = check();
  assert.notEqual(other.status, 0, 'Onboarding accepted a vm-control refusal with the wrong code');
  assert.match(other.stderr, /vm-control/);
});

test('bundled onboarding refuses any test artifact outside node_modules', t => {
  const work = fixture(t);
  const check = onboardingCheck(work);
  // [planted file, the path the scan names]: a flagged test directory is reported once, as the directory.
  for (const [name, flagged] of [['daemon/tools/toolTestHarness.js'], ['proxy/utils.test.js'],
    ['scripts/local-runner/fixtures/data.json', 'scripts/local-runner/fixtures'],
    ['scripts/mods/example/__tests__/x.mjs', 'scripts/mods/example/__tests__']]) {
    const target = path.join(work.output, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'planted\n');
    try {
      const run = check();
      assert.notEqual(run.status, 0, `Onboarding accepted test artifact ${name}`);
      assert.match(run.stderr, /test artifact/);
      assert.ok(run.stderr.includes(flagged ?? name), `Refusal does not name ${flagged ?? name}: ${run.stderr}`);
    } finally { rmSync(flagged ? path.join(work.output, flagged) : target, { recursive: true, force: true }); }
  }
  for (const name of ['daemon/node_modules/dependency/test/a.test.js', 'proxy/node_modules/dep/__tests__/b.js']) {
    mkdirSync(path.dirname(path.join(work.output, name)), { recursive: true });
    writeFileSync(path.join(work.output, name), 'dependency test\n');
  }
  const ignored = check();
  assert.equal(ignored.status, 0, ignored.stdout + ignored.stderr);
});

test('Gradle requires vm-control and drops compiled tests from the daemon and proxy dist copies', () => {
  const source = readFileSync(path.join(root, 'moe-jetbrains/build.gradle.kts'), 'utf8');
  const assets = source.match(/listOf\(([^)]*)\)\.forEach \{ name ->\s*check\(bundledLocalRunnerDir/)?.[1];
  assert.ok(assets, 'Missing requireBundledAssets local-runner list');
  assert.ok(assets.includes('"vm-control.mjs"'), 'requireBundledAssets must name vm-control.mjs');
  for (const dir of ['bundledDaemonDir', 'bundledProxyDir']) {
    const block = source.match(new RegExp(`from\\(${dir}\\) \\{([\\s\\S]*?)\\n\\s*\\}`))?.[1];
    assert.ok(block, `Missing Gradle from(${dir}) block`);
    assert.ok(block.includes('exclude("**/*.test.*", "**/*.spec.*")'), `${dir} copy must exclude compiled tests and specs`);
  }
});

test('daemon build excludes the test-only tool harness', () => {
  const tsconfig = JSON.parse(readFileSync(path.join(root, 'packages/moe-daemon/tsconfig.json'), 'utf8'));
  for (const pattern of ['src/**/*.test.ts', 'src/tools/toolTestHarness.ts']) {
    assert.ok(tsconfig.exclude.includes(pattern), `tsconfig must exclude ${pattern}`);
  }
});

test('cross-platform CI permanently runs provider and actual bundle regressions', () => {
  const source = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(source, /run: node --test scripts\/tests\/local-runner\.test\.mjs scripts\/tests\/local-runner-bundle\.test\.mjs/);
});

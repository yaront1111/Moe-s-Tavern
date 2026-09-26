import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bashSource = readFileSync(new URL('../moe-agent.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const algorithm = bashSource.split('resolve_attribution() {')[1].split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
const psWrapper = fileURLToPath(new URL('../moe-agent.ps1', import.meta.url));
const engines = process.platform === 'win32' ? ['python', 'powershell.exe', 'pwsh.exe'] : ['python3'];
// Fixture Git operations must never inherit a live checkout's index/worktree.
const fixtureEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
};

const powershell = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:MOE_TEST_WRAPPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'wrapper parse failed' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
$script:MoeCaseFoldPaths = ($env:OS -eq 'Windows_NT')
$WorkerId = 'worker-test'
$root = $env:MOE_TEST_ROOT
$scopeJson = Get-Content -Raw -LiteralPath $env:MOE_TEST_SCOPE | ConvertFrom-Json
$scope = @{ Asserted=@($scopeJson.asserted); Planned=@(); PeerDeclared=@{}; PeersActive=$false; ForceNever=$false }
$settings = @{ undeclared=$env:MOE_LAND_UNDECLARED; contested='skip-untouched'; commitBoardState=$false; exclude=@() }
$gitInfo = @{ Top=$root; Rel=$env:MOE_GIT_REL; GitDir=(Join-Path $root '.git') }
$toolWrites = @{}
foreach ($p in @(Get-Content -LiteralPath $env:MOE_TEST_TOOLS)) { $toolWrites[(Get-MoePathKey $p)] = $p }
$selection = Resolve-MoeAttribution -Git $gitInfo -S (Get-MoeDirtySnapshot $root) -B @{} -U @{} -Tool $toolWrites -Scope $scope -Settings $settings -TaskId 'task-usage' -Mode 'completion'
@{ candidates=@($selection.Candidates | ForEach-Object { @{ path=$_.Path; reason=$_.Reason } }); skipped=@($selection.Skipped | ForEach-Object { @{ path=$_.Path; code=$_.Code } }) } | ConvertTo-Json -Depth 5 -Compress
`;

function fixture(t, rel, declared) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'moe-usage-attribution-'));
  t.after(() => {
    assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  });
  const root = path.join(scratch, 'repo');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, env: fixtureEnvironment,
  });
  git('init', '--quiet');
  git('config', 'user.name', 'Usage Test');
  git('config', 'user.email', 'usage@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'README'), 'baseline\n');
  git('add', '--', 'README');
  git('commit', '--quiet', '-m', 'fixture baseline');
  const expected = [`${rel}src/main.ts`, `${rel}logs/app.log`, `${rel}logs/moe-usage-report.txt`];
  const receipts = [`${rel}logs/moe-usage/launch.jsonl`, ...(rel ? ['logs/moe-usage/outer.jsonl'] : [])];
  const files = [...expected, ...receipts];
  for (const name of files) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, name.endsWith('.ts') ? 'export const answer = 42;\n' : '{}\n');
  }
  assert.equal(existsSync(path.join(root, '.gitignore')), false);
  const snapshot = files.map(name => `${git('hash-object', '-w', '--', name).trim()}\t??\t${name}`).join('\n');
  writeFileSync(path.join(scratch, 'snapshot'), snapshot + '\n');
  for (const name of ['baseline', 'unattributed']) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'tools'), declared ? files.join('\n') + '\n' : '');
  const asserted = declared ? files.filter(name => name.startsWith(rel)).map(name => name.slice(rel.length)) : [];
  writeFileSync(path.join(scratch, 'scope.json'), JSON.stringify({ asserted, peersActive: false, peerDeclared: [] }));
  return { scratch, root, git, expected, receipts };
}

function attribute(engine, f, rel, declared) {
  const env = {
    ...fixtureEnvironment, MOE_GIT_TOP: f.root, MOE_GIT_REL: rel,
    MOE_LAND_UNDECLARED: declared ? 'never' : 'solo', MOE_LAND_CONTESTED: 'skip-untouched',
    MOE_LAND_BOARD_STATE: 'false', MOE_LAND_EXCLUDE: '', MOE_LAND_POLICY_OVERRIDE: '',
  };
  if (engine.startsWith('python')) {
    const result = spawnSync(engine, ['-c', algorithm, 'completion', 'task-usage',
      ...['snapshot', 'baseline', 'unattributed', 'tools', 'scope.json'].map(name => path.join(f.scratch, name)), f.scratch],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
    assert.equal(result.status, 0, result.stderr);
    const rows = name => readFileSync(path.join(f.scratch, name), 'utf8').split('\0').filter(Boolean).map(row => row.split('\t'));
    return { candidates: rows('candidates').map(([reason, , path]) => ({ path, reason })),
      skipped: rows('skipped').map(([code, path]) => ({ path, code })) };
  }
  const script = path.join(f.scratch, 'attribution.ps1');
  writeFileSync(script, powershell);
  const result = spawnSync(engine, ['-NoProfile', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...env,
      MOE_TEST_WRAPPER: psWrapper, MOE_TEST_ROOT: f.root,
      MOE_TEST_SCOPE: path.join(f.scratch, 'scope.json'), MOE_TEST_TOOLS: path.join(f.scratch, 'tools') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

for (const engine of engines) {
  for (const rel of ['', 'apps/product/']) {
    for (const declared of [false, true]) {
      test(`${engine}: ${rel ? 'nested' : 'root'} usage receipts cannot land through ${declared ? 'asserted/tool' : 'solo measured'} attribution`, t => {
        const f = fixture(t, rel, declared);
        const result = attribute(engine, f, rel, declared);
        const selected = result.candidates.map(row => row.path).sort();
        assert.deepEqual(selected, [...f.expected].sort());
        assert.deepEqual([...result.skipped].sort((a, b) => a.path.localeCompare(b.path)),
          [...f.receipts].sort().map(path => ({ path, code: 'MOE_ATTR_EXCLUDED' })));
        assert.ok(result.candidates.every(row => row.reason === (declared ? 'ASSERTED' : 'MEASURED')));

        // Commit exactly the selected blobs to prove the candidate tree contains
        // product files and ordinary logs, with every receipt still untracked.
        const index = path.join(f.scratch, 'index');
        const gitIndex = (...args) => execFileSync('git', ['-C', f.root, ...args], {
          encoding: 'utf8', windowsHide: true, env: { ...fixtureEnvironment, GIT_INDEX_FILE: index },
        });
        gitIndex('read-tree', 'HEAD');
        for (const file of selected) gitIndex('update-index', '--add', '--cacheinfo', '100644', f.git('hash-object', '--', file).trim(), file);
        const tree = gitIndex('write-tree').trim();
        const commit = f.git('commit-tree', tree, '-p', 'HEAD', '-m', 'attributed fixture').trim();
        assert.deepEqual(f.git('ls-tree', '-r', '--name-only', commit).trim().split('\n').sort(), ['README', ...f.expected].sort());
        for (const receipt of f.receipts) assert.ok(f.git('ls-files', '--others', '--exclude-standard').split('\n').includes(receipt));
      });
    }
  }
}

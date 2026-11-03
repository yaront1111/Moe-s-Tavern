import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Windows PowerShell 5.1's Get-Content reads a BOM-less file as ANSI, so a
// UTF-8 .moe-agent.json whose serenaProject names a non-ASCII directory became
// mojibake and fell back to the project root ("override not found"). JSON is
// UTF-8 (RFC 8259): the launcher must read it with -Encoding UTF8. These cut
// the REAL Serena-override block out of moe-agent.ps1 and run it.
const ps = readFileSync(fileURLToPath(new URL('../moe-agent.ps1', import.meta.url)), 'utf8')
  .replace(/^﻿/, '')
  .replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const block = between(ps, '\n$serenaProject = $projectPath.ToString()', '\nif ($serenaPath -and ');
const windows = process.platform === 'win32';
const psq = (v) => `'${String(v).replaceAll("'", "''")}'`;

test('the .moe-agent.json read is UTF-8 and literal-path', () => {
  const line = block.split('\n').find((l) => l.includes('Get-Content') && l.includes('$moeAgentConfig'));
  assert.ok(line, 'Get-Content of $moeAgentConfig not found in the Serena block');
  assert.match(line, /-Encoding UTF8/);
  assert.match(line, /-LiteralPath \$moeAgentConfig/);
});

function probe(exe) {
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
const pwsh = windows ? 'pwsh.exe' : 'pwsh';
const ENGINES = [
  { name: 'PowerShell 5.1', exe: 'powershell.exe', skip: windows ? (!probe('powershell.exe') && 'powershell.exe not found') : `PowerShell 5.1 is Windows-only; not available on ${process.platform}` },
  { name: 'PowerShell 7', exe: pwsh, skip: !probe(pwsh) && `${pwsh} is not available on ${process.platform}` },
];
const ROWS = [
  { name: 'BOM-less UTF-8, existing non-ASCII dir', dir: 'serena é ü', bom: false, create: true },
  { name: 'UTF-8 with BOM, existing non-ASCII dir', dir: 'serena é ü', bom: true, create: true },
  { name: 'BOM-less UTF-8, missing non-ASCII dir', dir: 'absent é', bom: false, create: false },
];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^MOE_/i.test(k)));

for (const engine of ENGINES) {
  for (const row of ROWS) {
    test(`${engine.name}: ${row.name}`, { skip: engine.skip }, (t) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'moe-serena-'));
      t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
      const project = path.join(root, 'proj');
      const dir = path.join(root, row.dir);
      mkdirSync(project);
      if (row.create) mkdirSync(dir);
      writeFileSync(path.join(project, '.moe-agent.json'), (row.bom ? '﻿' : '') + JSON.stringify({ serenaProject: dir }));
      const script = path.join(root, 'run.ps1');
      writeFileSync(script, `﻿$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectPath = ${psq(project)}
${block}
Write-Output "SERENA=$serenaProject"
Write-Output "SOURCE=$serenaProjectSource"
`);
      const r = spawnSync(engine.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const out = r.stdout.replaceAll('\r', '');
      const serena = /^SERENA=(.*)$/m.exec(out)?.[1];
      const source = /^SOURCE=(.*)$/m.exec(out)?.[1];
      assert.ok(serena !== undefined, out);
      if (row.create) {
        assert.equal(source, '.moe-agent.json', out);
        assert.equal(realpathSync.native(serena).toLowerCase(), realpathSync.native(dir).toLowerCase(), out);
        assert.ok(!out.includes('[WARN]'), out);
      } else {
        assert.equal(source, 'project root (override not found)', out);
        assert.equal(serena, project, out);
        assert.ok(out.includes(`[WARN] Serena project '${dir}' (from .moe-agent.json) not found; using Moe project root`), out);
      }
    });
  }
}

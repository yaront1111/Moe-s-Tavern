import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/doctor.ps1's Run-Native must pass its argument array through to the
// native tool (task-b2c1c997). A simple PowerShell function whose parameter is
// named like the automatic unbound-arguments variable receives an empty array,
// so `java -version` ran as bare `java` and -Full never sent buildPlugin.
// The production function is taken from the file with the PowerShell parser and
// run in Windows PowerShell 5.1 against recorder .cmd tools, so neither java nor
// Gradle is needed.

const DOCTOR = fileURLToPath(new URL('../doctor.ps1', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";

function runNative(calls) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-doctor-ps1-'));
    try {
        const log = path.join(dir, 'argv.log');
        const recorder = path.join(dir, 'recorder.cmd');
        const exit3 = path.join(dir, 'exit3.cmd');
        fs.writeFileSync(recorder, `@echo off\r\necho argv=[%*]>>"${log}"\r\nexit /b 0\r\n`);
        fs.writeFileSync(exit3, '@echo off\r\nexit /b 3\r\n');
        const lines = [
            "$ErrorActionPreference = 'Stop'",
            '$errors = $null',
            `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(DOCTOR)}, [ref]$null, [ref]$errors)`,
            "if ($errors.Count) { throw ('parse errors: ' + $errors.Count) }",
            "$fn = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Run-Native' }, $true))",
            "if ($fn.Count -ne 1) { throw ('Run-Native definitions: ' + $fn.Count) }",
            '. ([scriptblock]::Create($fn[0].Extent.Text))',
            ...calls.map(([tool, args]) => {
                const exe = tool === 'exit3' ? exit3 : recorder;
                const list = '@(' + args.map(quote).join(', ') + ')';
                return `try { Run-Native ${quote(exe)} ${list}; Write-Output 'RESULT ok' } catch { Write-Output ('RESULT thrown: ' + $_.Exception.Message) }`;
            })
        ];
        const script = path.join(dir, 'probe.ps1');
        fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
        const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 60000 });
        assert.equal(run.status, 0, `powershell exited ${run.status}: ${run.stderr}${run.stdout}`);
        const results = run.stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT ')).map(line => line.slice(7));
        const argv = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : [];
        return { results, argv };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('DP1: Run-Native passes buildPlugin through to the tool (the -Full Gradle build)', windowsOnly, () => {
    const { results, argv } = runNative([['recorder', ['buildPlugin']]]);
    assert.deepEqual({ results, argv }, { results: ['ok'], argv: ['argv=[buildPlugin]'] });
});

test('DP2: Run-Native passes --version through to the tool (the Gradle and java probes)', windowsOnly, () => {
    const { results, argv } = runNative([['recorder', ['--version']]]);
    assert.deepEqual({ results, argv }, { results: ['ok'], argv: ['argv=[--version]'] });
});

test('DP3: a tool that exits 3 makes Run-Native throw "exited with code 3"', windowsOnly, () => {
    const { results } = runNative([['exit3', ['x']]]);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0], /^thrown: .*exited with code 3/);
});

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const engines = new Set(['bash', 'powershell', 'pwsh']);
const failures = new Set(['SPAWN_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT']);

// Output is untrusted fixture material. Return only this closed metadata shape.
export function summarizePostflight(engine, exitCode, output = '', failure = null, sourceLineCount = 0) {
    const validEngine = engines.has(engine);
    output = stripVTControlCharacters(output);
    const lines = output.split(/\r?\n/);
    const scenarios = [...output.matchAll(/^\[scenario ([A-Z])\](?:[ \t]|$)/gmi)];
    const marker = `PASS postflight.${engine === 'bash' ? 'sh' : 'ps1'}`;
    const failureClass = !validEngine ? 'INVALID_ENGINE'
        : failure ? (failures.has(failure) ? failure : 'PROCESS_FAILURE')
        : exitCode !== 0 ? 'HARNESS_FAILURE'
        : lines.some(line => /^SKIP(?:\s|:|$)/i.test(line)) ? 'SKIP_DETECTED'
        : !lines.includes(marker) ? 'PASS_MARKER_MISSING' : 'NONE';
    const failureLines = lines.flatMap(line => /^MOE_POSTFLIGHT_FAILURE_LINE=([1-9]\d*)$/.exec(line)?.slice(1) ?? [])
        .map(Number).filter(line => Number.isSafeInteger(line) && line <= sourceLineCount);
    return {
        engine: validEngine ? engine : 'invalid',
        exit: failureClass === 'NONE' ? 0 : (Number.isInteger(exitCode) && exitCode > 0 ? exitCode : 1),
        lastScenario: scenarios.at(-1)?.[1].toUpperCase() ?? null,
        failureClass,
        failureLine: validEngine && failureClass !== 'NONE' && Number.isSafeInteger(sourceLineCount)
            ? failureLines.at(-1) ?? null : null,
    };
}

function runPostflight(engine) {
    if (!engines.has(engine)) return Promise.resolve(summarizePostflight(engine, null));
    const harness = fileURLToPath(new URL(`./postflight.${engine === 'bash' ? 'sh' : 'ps1'}`, import.meta.url));
    const sourceLineCount = readFileSync(harness, 'utf8').split(/\r?\n/).length;
    const args = engine === 'bash' ? [harness]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness];
    return new Promise(resolveResult => {
        // Never inherit stdout/stderr or write them to artifacts. execFile keeps
        // bounded buffers in memory and kills a timed-out/overlong child.
        execFile(engine, args, {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            windowsHide: true, encoding: 'utf8', timeout: 20 * 60 * 1000,
            maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
            const failure = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'OUTPUT_LIMIT'
                : error?.killed ? 'TIMEOUT'
                : error && typeof error.code === 'string' ? 'SPAWN_FAILED' : null;
            const exit = error ? (typeof error.code === 'number' ? error.code : null) : 0;
            resolveResult(summarizePostflight(engine, exit, `${stdout ?? ''}\n${stderr ?? ''}`, failure, sourceLineCount));
        });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let result;
    try { result = await runPostflight(process.argv[2]); }
    catch { result = summarizePostflight(process.argv[2], null, '', 'SPAWN_FAILED'); }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exit;
}

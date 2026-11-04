import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const engines = new Set(['bash', 'powershell', 'pwsh']);
const failures = new Set(['SPAWN_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT']);
// A skip is the word SKIP at the start of a line, or right after one leading [tag] such as
// "[scenario WT14D]" and an optional "(sub-case)" tag: "[scenario WT14D] SKIP (root ignores mode bits)".
// SKIPPED, a later "skips", and lowercase "skipped:" host-capability notes are not skips.
const SKIP_LINE = /^(?:\[[^\]\r\n]*\][ \t]+(?:\([^)\r\n]*\)[ \t]+)?)?SKIP(?:\s|:|$)/i;
// A harness run that outlives this bound is killed (SIGKILL) and reported as TIMEOUT.
// runPostflight's execFile comment gives the measured runs it is sized from.
export const POSTFLIGHT_TIMEOUT_MS = 180 * 60 * 1000;

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
        : lines.some(line => SKIP_LINE.test(line)) ? 'SKIP_DETECTED'
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

export function runPostflight(engine, run = execFile) {
    if (!engines.has(engine)) return Promise.resolve(summarizePostflight(engine, null));
    const harness = fileURLToPath(new URL(`./postflight.${engine === 'bash' ? 'sh' : 'ps1'}`, import.meta.url));
    const sourceLineCount = readFileSync(harness, 'utf8').split(/\r?\n/).length;
    const args = engine === 'bash' ? [harness]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness];
    return new Promise(resolveResult => {
        // Never inherit stdout/stderr or write them to artifacts. execFile keeps
        // bounded buffers in memory and kills a timed-out/overlong child. Sizing,
        // measured at f38a17d4 (task-5f7f43fa): the full postflight.ps1 took 3200 s
        // under Windows PowerShell 5.1 and 3400 s under pwsh 7 on an idle desktop,
        // and windows-latest runs this work about 1.5-1.6x slower (landing guards
        // 47 s vs 30 s, 45 s vs 28 s), so 80-90 min there; ubuntu-latest's bash run
        // took 2690-2750 s. 180 min keeps the slowest at about half the bound and
        // well inside GitHub's 360-min job default.
        run(engine, args, {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            windowsHide: true, encoding: 'utf8', timeout: POSTFLIGHT_TIMEOUT_MS,
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

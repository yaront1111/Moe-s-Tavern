import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizePostflight } from './postflight-safe.mjs';

test('success requires the exact engine-specific PASS line', () => {
    for (const engine of ['bash', 'powershell', 'pwsh']) {
        const extension = engine === 'bash' ? 'sh' : 'ps1';
        assert.equal(summarizePostflight(engine, 0, `PASS postflight.${extension}\r\n`).exit, 0);
        for (const output of ['', `prefix PASS postflight.${extension}\n`, `PASS postflight.${extension} suffix\n`]) {
            assert.equal(summarizePostflight(engine, 0, output).failureClass, 'PASS_MARKER_MISSING');
            assert.notEqual(summarizePostflight(engine, 0, output).exit, 0);
        }
    }
    assert.equal(summarizePostflight('pwsh', 0, 'PASS postflight.sh\n').failureClass, 'PASS_MARKER_MISSING');
});

test('a PASS line cannot mask a nonzero child exit', () => {
    assert.deepEqual(summarizePostflight('bash', 42, 'PASS postflight.sh\n'), {
        engine: 'bash', exit: 42, lastScenario: null, failureClass: 'HARNESS_FAILURE', failureLine: null,
    });
});

test('summary projects only fixed metadata and the last scenario letter', () => {
    const output = '[scenario Q] ok\n[scenario A] child detail\narbitrary unstructured child output\n';
    const result = summarizePostflight('bash', 1, output);
    assert.deepEqual(result, { engine: 'bash', exit: 1, lastScenario: 'A', failureClass: 'HARNESS_FAILURE', failureLine: null });
    assert.deepEqual(Object.keys(result).sort(), ['engine', 'exit', 'failureClass', 'failureLine', 'lastScenario']);
    assert.equal(JSON.stringify(result).includes('child detail'), false);
    assert.equal(JSON.stringify(result).includes('unstructured'), false);
});

test('SKIP fails even if the harness also prints PASS and exits zero', () => {
    const result = summarizePostflight('powershell', 0, 'SKIP optional cases: unavailable\nPASS postflight.ps1\n');
    assert.equal(result.failureClass, 'SKIP_DETECTED');
    assert.notEqual(result.exit, 0);
});

test('ANSI-wrapped PASS and scenario markers are recognized without exposing formatting', () => {
    const result = summarizePostflight('pwsh', 0, '\u001b[32m[scenario Q] ok\u001b[0m\r\n\u001b[32mPASS postflight.ps1\u001b[0m\r\n');
    assert.deepEqual(result, { engine: 'pwsh', exit: 0, lastScenario: 'Q', failureClass: 'NONE', failureLine: null });
});

test('ANSI-wrapped SKIP still fails despite an exact PASS marker', () => {
    const result = summarizePostflight('pwsh', 0, '\u001b[33mSKIP postflight.ps1: unavailable\u001b[0m\r\nPASS postflight.ps1\r\n');
    assert.equal(result.failureClass, 'SKIP_DETECTED');
    assert.notEqual(result.exit, 0);
});

test('startup, timeout, and output-limit failures always remain nonzero', () => {
    for (const failure of ['SPAWN_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT']) {
        const result = summarizePostflight('bash', null, 'PASS postflight.sh\n', failure);
        assert.equal(result.failureClass, failure);
        assert.notEqual(result.exit, 0);
    }
});

test('invalid engines and unrecognized failure details are not emitted', () => {
    const result = summarizePostflight('unrecognized argument', null, '', 'unstructured error detail');
    assert.deepEqual(result, { engine: 'invalid', exit: 1, lastScenario: null, failureClass: 'INVALID_ENGINE', failureLine: null });
    assert.equal(summarizePostflight('bash', null, '', 'unstructured error detail').failureClass, 'PROCESS_FAILURE');
});

test('the command entrypoint emits one safe summary and fails for an invalid engine', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./postflight-safe.mjs', import.meta.url)), 'invalid'], {
        encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(child.stdout), {
        engine: 'invalid', exit: 1, lastScenario: null, failureClass: 'INVALID_ENGINE', failureLine: null,
    });
});

test('an exact failure marker exposes only a source-bounded line number', () => {
    for (const engine of ['bash', 'powershell', 'pwsh']) {
        const output = 'unstructured failure details\n\u001b[31mMOE_POSTFLIGHT_FAILURE_LINE=17\u001b[0m\r\n';
        const result = summarizePostflight(engine, 1, output, null, 17);
        assert.deepEqual(result, { engine, exit: 1, lastScenario: null, failureClass: 'HARNESS_FAILURE', failureLine: 17 });
    }
});

test('malformed markers and lines outside the actual source bounds are discarded', () => {
    for (const marker of ['0', '-1', '18', '1.5', 'Infinity', '9007199254740993', '17 extra', 'unstructured details']) {
        assert.equal(summarizePostflight('powershell', 1, `MOE_POSTFLIGHT_FAILURE_LINE=${marker}\n`, null, 17).failureLine, null);
    }
    assert.equal(summarizePostflight('powershell', 1, 'prefix MOE_POSTFLIGHT_FAILURE_LINE=17\n', null, 17).failureLine, null);
    assert.equal(summarizePostflight('powershell', 1, 'MOE_POSTFLIGHT_FAILURE_LINE=17\n').failureLine, null);
});

test('failure-line markers cannot change a successful outcome or fabricate a source for invalid engines', () => {
    const marker = 'MOE_POSTFLIGHT_FAILURE_LINE=17\n';
    assert.equal(summarizePostflight('bash', 0, `${marker}PASS postflight.sh\n`, null, 17).failureLine, null);
    assert.equal(summarizePostflight('invalid', 1, marker, null, 17).failureLine, null);
});

test('a SKIP after one leading [tag] fails even with an exact PASS marker and exit zero', () => {
    for (const engine of ['bash', 'powershell', 'pwsh']) {
        const pass = `PASS postflight.${engine === 'bash' ? 'sh' : 'ps1'}`;
        for (const skip of [
            '[scenario WT14D] SKIP (root ignores mode bits)',
            '[scenario WT14D] SKIP (msys: mode bits do not deny an unlink; the ps1 twin denies it with icacls)',
            '\u001b[33m[scenario Q] SKIP: unavailable\u001b[0m',
            '[scenario M2] (d) SKIP: no process start token',
            '[worktree reuse] SKIP',
            '[scenario AB2]\tskip optional variant',
        ]) {
            const result = summarizePostflight(engine, 0, `${skip}\r\n${pass}\r\n`);
            assert.equal(result.failureClass, 'SKIP_DETECTED', skip);
            assert.notEqual(result.exit, 0, skip);
            assert.equal(JSON.stringify(result).includes('mode bits'), false);
        }
    }
});

test('SKIPPED, a later skip word and lowercase skipped notes leave a clean run green', () => {
    for (const line of [
        '[scenario WT14F] at most 5 removals a pass; WORKING, an open attempt and W/.moe are kept; a held lock skips the pass, a 3h-old one is broken',
        '[scenario M2] (d) SKIPPED: this platform exposes no process start token, so the probe is identity-only by design',
        '[scenario AE] skipped: this host cannot create symlinks',
        '[scenario AD] link variant skipped: this host cannot create symlinks',
        '[frozen candidate] sha256-repo skipped: this git cannot create a sha256 repository',
        '[skip] owned.txt (MOE_ATTR_PREEXISTING)',
        'MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=task-resume',
        'MOE_DISABLE_QUALITY_GATE=1 should skip the gate and allow the commit',
    ]) {
        const result = summarizePostflight('bash', 0, `${line}\nPASS postflight.sh\n`);
        assert.equal(result.failureClass, 'NONE', line);
        assert.equal(result.exit, 0, line);
    }
});

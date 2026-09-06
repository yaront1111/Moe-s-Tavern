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
        engine: 'bash', exit: 42, lastScenario: null, failureClass: 'HARNESS_FAILURE',
    });
});

test('summary projects only fixed metadata and the last scenario letter', () => {
    const output = '[scenario Q] ok\n[scenario A] child detail\narbitrary unstructured child output\n';
    const result = summarizePostflight('bash', 1, output);
    assert.deepEqual(result, { engine: 'bash', exit: 1, lastScenario: 'A', failureClass: 'HARNESS_FAILURE' });
    assert.deepEqual(Object.keys(result).sort(), ['engine', 'exit', 'failureClass', 'lastScenario']);
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
    assert.deepEqual(result, { engine: 'pwsh', exit: 0, lastScenario: 'Q', failureClass: 'NONE' });
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
    assert.deepEqual(result, { engine: 'invalid', exit: 1, lastScenario: null, failureClass: 'INVALID_ENGINE' });
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
        engine: 'invalid', exit: 1, lastScenario: null, failureClass: 'INVALID_ENGINE',
    });
});

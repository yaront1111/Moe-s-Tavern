'use strict';

// CQ-I05: the Managed VMs view's contract with CQ-I03a's vm-control.mjs, mirroring JetBrains
// ManagedVmPresentation (CQ-I03). ManagedVm.ts must stay pure: any require from it throws here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const SOURCE = path.join(__dirname, '../src/util/ManagedVm.ts');
const M = (() => {
    const module = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInThisContext(`(function (exports, module, require) {${code}\n})`, { filename: SOURCE })(module.exports, module, name => { throw new Error(`ManagedVm.ts must not require ${name}`); });
    return module.exports;
})();
const [A, B, C, D, E] = ['a'.repeat(20), '0123456789abcdef0123', 'f'.repeat(20), '9'.repeat(20), '1'.repeat(20)].map(s => `moe-vm-${s}`);
const row = (instance, phase = 'owned', more = {}) => ({ instance, phase, state: 'Running', launchTries: 1, taskId: 'task-abc', ...more });
const status = (more = {}) => ({ schema: 'moe-vm-status-v1', provider: { ready: true }, executionReady: false, verified: false, instances: [row(A)], invalid: 0, ...more });
const reconcile = (more = {}) => ({ schema: 'moe-vm-reconcile-v1', reconciled: [], unknown: [], invalid: 0, ...more });
const cleanup = (more = {}) => ({ schema: 'moe-vm-cleanup-v1', deleted: [], preserved: [], errors: [], invalid: 0, ...more });
const line = report => `${JSON.stringify(report)}\n`;
const run = (command, report) => M.decode(command, typeof report === 'string' ? report : line(report), 0, false);
const unreadable = reason => ({ kind: 'unreadable', reason });
const NONE = { refresh: true, reconcile: false, cleanup: false };
const READY = 'VM provider: ready.';
const EXEC_NO = 'Execution: not ready. A ready provider does not make isolated execution ready.';
const VERIFIED_NO = 'Verification: not verified. No isolation or runner evidence is certified.';
const UNKNOWN = code => `Unknown code ${code}: this version of Moe has no description for it.`;
/** An execFile stand-in that records its call and answers `result` asynchronously, as execFile does. */
const fakeExec = (...result) => {
    const calls = [];
    return { calls, impl: (file, args, options, callback) => { calls.push({ file, args, options }); setImmediate(() => callback(...result)); } };
};

test('V1: readiness keeps provider, execution and verification apart; only a literal true counts', () => {
    assert.deepEqual(M.readiness(undefined), ['VM provider: not checked yet.', EXEC_NO, VERIFIED_NO]);
    for (const claim of [false, 'true', 1, {}, [true], null]) {
        assert.deepEqual(M.readiness(run('status', status({ executionReady: claim, verified: claim }))), [READY, EXEC_NO, VERIFIED_NO]);
    }
    assert.deepEqual(M.readiness(run('status', status({ executionReady: true, verified: true }))),
        [READY, 'Execution: the runner reports it ready.', 'Verification: the runner reports it verified.']);
    assert.equal(M.readiness(run('status', status({ provider: { ready: 'true', code: 'PROVIDER_NOT_FOUND' } })))[0],
        'VM provider: not ready. Multipass was not found. Install Multipass and make sure it is on PATH.');
    assert.equal(M.readiness(run('status', status({ provider: { ready: false } })))[0], 'VM provider: not ready. No reason was given; run the local-runner doctor.');
});

test('V1: rows are the owned instances in report order, never collision or deleted', () => {
    const first = row(B, 'launching', { state: 'Absent', launchTries: 2, taskId: 'task-x9' });
    assert.deepEqual(M.rows(run('status', status({ instances: [first, row(A, 'reserved'), row(C, 'collision'), row(D, 'deleted')] }))), [first, row(A, 'reserved')]);
    assert.deepEqual(M.rows(undefined), []);
});

test('V1: a foreign or repeated VM name anywhere makes the whole report unreadable', () => {
    for (const name of ['moe-vm-' + 'A'.repeat(20), 'moe-vm-' + 'a'.repeat(19), `${A}0`, `${A}\n`, 'my-vm']) {
        assert.deepEqual(run('status', status({ instances: [row(B), row(name)] })), unreadable('not-owned'), name);
    }
    assert.deepEqual(run('status', status({ instances: [row(A), row(A, 'failed')] })), unreadable('not-owned'));
    assert.deepEqual(run('cleanup', cleanup({ deleted: [A], preserved: [{ instance: A, reason: 'attempt-active' }] })), unreadable('not-owned'));
    assert.deepEqual(run('reconcile', reconcile({ unknown: ['vm-1'] })), unreadable('not-owned'));
});

test('V1: anything but one strict report line for the invoked command is malformed or refused', () => {
    const bad = ['', '\n', 'not json\n', `${line(status())}${line(status())}`, `${JSON.stringify(status())} x\n`, `${JSON.stringify(status())}\r\n`,
        "{'schema':'moe-vm-status-v1'}\n", status({ schema: 'moe-vm-status-v2' }), status({ schema: 'moe-vm-cleanup-v1' }), status({ invalid: -1 }),
        status({ invalid: 1.5 }), status({ invalid: '0' }), status({ provider: { ready: true, code: 'lower' } }), status({ provider: null }),
        status({ instances: [row(A, 'adopted')] }), status({ instances: [row(A, 'owned', { state: 'Gone' })] }), status({ instances: [7] }),
        status({ instances: [row(A, 'owned', { taskId: 'task-a b' })] }), status({ instances: [row(A, 'owned', { launchTries: '1' })] }),
        status({ instances: [row(7)] }), { schema: 'moe-vm-cleanup-v1', code: 'LEDGER_UNREADABLE' }, { code: 'not a code' }, [status()]];
    for (const report of bad) { assert.deepEqual(run('status', report), unreadable('malformed'), JSON.stringify(report)); }
    assert.deepEqual(run('status', { code: 'VM_CONTROL_FAILED' }), { kind: 'refused', code: 'VM_CONTROL_FAILED' });
    assert.deepEqual(run('status', { schema: 'moe-vm-status-v1', code: 'LEDGER_UNREADABLE', instances: [] }), { kind: 'refused', code: 'LEDGER_UNREADABLE' });
    assert.deepEqual(M.decode('status', line(status()), 0, true), unreadable('timed-out'));
    assert.deepEqual(M.decode('status', line(status()), 3, false), unreadable('failed'));
    assert.deepEqual(M.decode('status', `${'x'.repeat(65536)}\n`, 0, false), unreadable('too-large'));
});

test('V2: the strong profile is blocked whatever the report claims', () => {
    for (const report of [undefined, run('status', status()), run('status', status({ executionReady: true, verified: true })), run('status', 'x')]) {
        assert.equal(M.strongProfile(report), 'Strong profile (verified-local) is unavailable: protected isolation, trusted runner evidence '
            + 'and revision-bound delivery are not certified. Moe keeps the current execution profile.');
    }
});

test('V2: actions are refresh, reconcile and cleanup only; cleanup needs a ready provider and a launched row', () => {
    for (const phase of ['launching', 'owned', 'absent', 'failed']) {
        assert.deepEqual(M.actions(run('status', status({ instances: [row(A, phase)] })), false), { refresh: true, reconcile: true, cleanup: true }, phase);
    }
    assert.deepEqual(M.actions(run('status', status()), true), { refresh: false, reconcile: false, cleanup: false });
    assert.deepEqual(M.actions(run('status', status({ instances: [row(A, 'reserved'), row(B, 'collision'), row(C, 'deleted')] })), false), { ...NONE, reconcile: true });
    for (const report of [undefined, run('status', status({ provider: { ready: false } })), run('status', 'x'), run('status', { code: 'VM_CONTROL_FAILED' }), run('cleanup', cleanup())]) {
        assert.deepEqual(M.actions(report, false), NONE);
    }
});

test('V3: runVmControl runs node on the script with the verb and --project only, no shell or instance', async () => {
    for (const [command, timeout, report] of [['status', 120000, status()], ['reconcile', 120000, reconcile()], ['cleanup', 1200000, cleanup()]]) {
        const { calls, impl } = fakeExec(null, line(report), 'stderr noise');
        assert.equal((await M.runVmControl(impl, 'C:\\Program Files\\node.exe', 'D:\\a b\\vm-control.mjs', command, 'D:\\my project')).kind, command === 'status' ? 'status' : 'outcome');
        assert.deepEqual(calls, [{ file: 'C:\\Program Files\\node.exe', args: ['D:\\a b\\vm-control.mjs', command, '--project', 'D:\\my project'], options: { timeout, maxBuffer: 65537, windowsHide: true } }]);
    }
    const [controller, { calls, impl }] = [new AbortController(), fakeExec(null, line(status()), '')];
    await M.runVmControl(impl, 'node', 's', 'status', '/p', controller.signal);
    assert.equal(calls[0].options.signal, controller.signal);
});

test('V3: every failed run resolves unreadable with a fixed reason and never rejects', async () => {
    const error = more => Object.assign(new Error('boom /secret/path'), more);
    for (const [result, reason] of [
        [[error({ code: 'ENOENT' }), '', ''], 'node-missing'], [[error({ killed: true, signal: 'SIGTERM', code: null }), line(status()), ''], 'timed-out'],
        [[error({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'x'.repeat(65537), ''], 'too-large'], [[error({ code: 0 }), line(status()), ''], 'failed'],
        [[error({ code: 2 }), line(status()), 'secret'], 'failed'], [[error({ name: 'AbortError', code: 'ABORT_ERR' }), '', ''], 'cancelled'],
        [[null, 'not json\n', ''], 'malformed'], [[null, line(status({ schema: 'moe-vm-reconcile-v1' })), ''], 'malformed']]) {
        const report = await M.runVmControl(fakeExec(...result).impl, 'node', 's', 'status', '/p');
        assert.deepEqual(report, unreadable(reason), reason);
        assert.equal(M.notes(report).join(' ').includes('secret'), false);
    }
    assert.deepEqual(await M.runVmControl(() => { throw new Error('spawn EINVAL'); }, 'node', 's', 'status', '/p'), unreadable('failed'));
});

test('V4: reports render fixed texts from validated tokens only', () => {
    const preserved = [{ instance: B, reason: 'job-lease-held' }, { instance: C, reason: 'constructor' }];
    const errors = [{ instance: D, code: 'PROVIDER_TIMEOUT' }, { instance: E, code: 'NEW_CODE' }];
    assert.deepEqual(M.notes(run('cleanup', cleanup({ deleted: [A], preserved, errors, invalid: 2 }))), [`${A}: deleted.`, `${B}: kept. Its job lease is still held.`,
        `${C}: kept. ${UNKNOWN('constructor')}`, `${D}: not deleted. Multipass did not answer in time; check that its service is running.`,
        `${E}: not deleted. ${UNKNOWN('NEW_CODE')}`, '2 ledger record(s) could not be read and were left untouched.']);
    assert.deepEqual(M.notes(run('reconcile', reconcile({ reconciled: [{ instance: A, from: 'launching', to: 'absent' }], unknown: [B] }))),
        [`${A}: recorded phase launching corrected to absent.`, `${B}: state unknown, record left as is.`]);
    assert.deepEqual(M.notes(run('cleanup', cleanup())), ['Nothing changed.']);
    assert.deepEqual(M.notes(run('status', { code: 'LEDGER_UNREADABLE' })), ['The owned VM ledger could not be read, so nothing was listed or changed.']);
    assert.deepEqual(M.notes(run('cleanup', cleanup({ preserved: [{ instance: B, reason: 'Run rm -rf now' }] }))), ['The VM report could not be read, so nothing from it is shown.']);
    assert.deepEqual(M.notes(undefined), []);
});

'use strict';

// CQ-I06b: the VM rows of the shared client verdict corpus, run through CQ-I05's ManagedVm.ts. JetBrains
// ClientVerdictCorpusTest runs the same bytes through ManagedVmPresentation. A row the two clients disagree on
// is fixed or filed, never given an expectation of this client's.
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
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-verdicts.json'), 'utf8'));
if (!Array.isArray(CORPUS.vm) || CORPUS.vm.length === 0) { throw new Error('client-verdicts.json has no vm rows'); }

/** Names only: maps each report kind onto the corpus vocabulary and never changes an outcome. */
const verdictOf = report => (report.kind === 'status' ? 'status' : report.kind === 'outcome' ? 'report'
    : report.kind === 'refused' ? `refused:${report.code}` : `unreadable:${report.reason}`);
const READY_LINES = ['VM provider: ready.', 'Execution: the runner reports it ready.', 'Verification: the runner reports it verified.'];
const BLOCKED = 'Strong profile (verified-local) is unavailable: protected isolation, trusted runner evidence '
    + 'and revision-bound delivery are not certified. Moe keeps the current execution profile.';

for (const row of CORPUS.vm) {
    test(`${row.id}: ${row.verdict}`, () => {
        assert.ok(Object.hasOwn(M.TIMEOUT_MS, row.command), `unknown command ${row.command}`);
        const stdout = row.oversize === undefined ? row.stdout : 'x'.repeat(row.oversize);
        const report = M.decode(row.command, stdout, row.exit, row.timedOut);
        const actions = M.actions(report, row.running);
        assert.deepEqual({
            verdict: verdictOf(report),
            readiness: M.readiness(report).map((line, i) => line === READY_LINES[i]),
            rows: M.rows(report).length,
            actions: [actions.refresh, actions.reconcile, actions.cleanup],
            strongProfile: M.strongProfile(report)
        }, { verdict: row.verdict, readiness: row.readiness, rows: row.rows, actions: row.actions, strongProfile: BLOCKED });
    });
}

'use strict';

// The settings panel's read-only landing policy is the VS Code copy of JetBrains'
// MoeSettingsDialog.effectivePolicyRows. Both clients replay ONE held-out corpus, landed by
// VSC-5 (task-0f2cc6eb): raw wire settings in, display rows out. This file only reads it: a
// row VS Code cannot meet because JetBrains is wrong is filed against JetBrains, never edited here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const CORPUS_PATH = path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-settings-policy.json');
const BUNDLE_PATH = path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties');
const PANEL_PATH = path.join(__dirname, '../src/panels/SettingsPanel.ts');
const BUNDLE_KEYS = ['moe.label.landingPolicy', 'moe.settings.landingPolicyHint', 'moe.settings.enableAgentTeams', 'moe.settings.enableAgentTeamsHint'];

function readText(file, what) {
    try { return fs.readFileSync(file, 'utf8'); } catch (error) { assert.fail(`cannot read the ${what} at ${file}: ${error.message}`); }
}

function readCorpus() {
    try { return JSON.parse(readText(CORPUS_PATH, 'settings policy corpus')); } catch (error) {
        assert.fail(`the settings policy corpus at ${CORPUS_PATH} is not usable: ${error.message}`);
    }
}

const PANEL_JS = ts.transpileModule(readText(PANEL_PATH, 'settings panel'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

/** A fresh SettingsPanel module (its currentPanel is static); a require outside {vscode} throws. */
function loadPanel(vscode) {
    const module = { exports: {} };
    const require = name => {
        if (name !== 'vscode') { throw new Error(`unexpected require from SettingsPanel.ts: ${name}`); }
        return vscode;
    };
    vm.runInContext(PANEL_JS, vm.createContext({ exports: module.exports, module, require, console }), { filename: PANEL_PATH });
    return module.exports;
}

const plain = value => JSON.parse(JSON.stringify(value)); // out of the vm realm, so deepStrictEqual works
const rowsOf = settings => plain(loadPanel({}).effectivePolicyRows(settings));
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');

/** The HTML the real panel emits for `settings` (a null project means "no snapshot yet"). */
function renderHtml(settings) {
    let html = '';
    const vscode = {
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        window: {
            createWebviewPanel: () => ({
                webview: { cspSource: 'unit-test', asWebviewUri: uri => uri, set html(value) { html = value; }, onDidReceiveMessage() {} },
                onDidDispose() {}, reveal() {}, dispose() {}
            })
        }
    };
    loadPanel(vscode).SettingsPanel.createOrShow('ext', {}, { project: { settings } });
    return html;
}

test('C1: every corpus row yields the exact label, value, detail and order; all failing ids are reported at once', () => {
    const { rows } = readCorpus();
    assert.ok(Array.isArray(rows) && rows.length > 0, `no rows in ${CORPUS_PATH}`);
    const failures = [];
    for (const { id, settings, expect } of rows) {
        try {
            const got = rowsOf(settings);
            if (JSON.stringify(got) !== JSON.stringify(expect)) {
                failures.push(`${id}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}`);
            }
        } catch (error) { failures.push(`${id}: threw ${error && error.message}`); }
    }
    assert.deepStrictEqual(failures, []);
});

test('C2: the rendered policy section is read-only, in order, and escaped', () => {
    const hostile = { qualityGate: '<img src=x onerror=alert(1)>', consolidationBranch: 'a&b' };
    for (const [name, settings] of [['null settings', null], ['hostile settings', hostile]]) {
        const html = renderHtml(settings);
        const start = html.indexOf('<section id="landingPolicy">');
        assert.ok(start >= 0, `${name}: no landingPolicy section`);
        const section = html.slice(start, html.indexOf('</section>', start));
        assert.doesNotMatch(section, /<(?:input|select|textarea|button)\b/, `${name}: a form control inside the policy`);
        const shown = section.split('<div class="policy-row">').slice(1).map(chunk => {
            const part = cls => { const m = new RegExp(`class="policy-${cls}">(.*?)</(?:span|div)>`).exec(chunk); return m ? decode(m[1]) : ''; };
            return { label: part('label'), value: part('value'), detail: part('detail') };
        });
        assert.deepStrictEqual(shown, rowsOf(settings), `${name}: rendered rows differ from effectivePolicyRows`);
        for (const raw of ['<img', '<YYYY-MM-DD>', 'a&b', '<id>']) { assert.ok(!section.includes(raw), `${name}: unescaped ${raw}`); }
    }
    const section = renderHtml(hostile).split('<section id="landingPolicy">')[1];
    assert.ok(section.includes('&lt;img src=x onerror=alert(1)&gt;') && section.includes('a&amp;b'), 'hostile values are entity-escaped');
});

test('C3: the shared strings equal MoeBundle.properties with its <html>/<small> tags stripped', () => {
    const expected = {};
    for (const key of BUNDLE_KEYS) {
        const found = new RegExp(`^${key.replace(/\./g, '\\.')}=(.*?)\\r?$`, 'm').exec(readText(BUNDLE_PATH, 'MoeBundle.properties'));
        assert.ok(found, `${key} is missing from ${BUNDLE_PATH}`);
        // A .properties backslash is an escape this parser does not decode.
        assert.ok(!found[1].includes('\\'), `${key} uses a properties escape; teach this parser before trusting the comparison`);
        expected[key] = found[1].replace(/<\/?(?:html|small)>/g, '');
    }
    assert.deepStrictEqual(plain(loadPanel({}).SETTINGS_BUNDLE_TEXT), expected);
});

test('C4: each landing boolean is read on its own key and only by its exact value, never cross-wired', () => {
    const base = rowsOf(null);
    const changedBy = settings => rowsOf(settings).filter((row, i) => JSON.stringify(row) !== JSON.stringify(base[i])).map(row => row.label);
    const wrongTypes = [0, 1, '', 'false', 'true', 'off', null, {}, []];
    const cases = [['autoCommit', false, 'Auto-commit'], ['checkpointCommits', false, 'Checkpoint commits'],
        ['checkpointPush', false, 'Push checkpoints'], ['commitBoardState', false, 'Commit board state'], ['commitHooks', true, 'Commit hooks']];
    for (const [key, value, label] of cases) {
        assert.deepStrictEqual(changedBy({ [key]: value }), [label], `${key}: ${value} must change exactly the ${label} row`);
        // The daemon tests `!== false` / `=== true`: no other JSON value, truthy or falsy, may move the row.
        for (const wrong of wrongTypes) { assert.deepStrictEqual(changedBy({ [key]: wrong }), [], `${key}: ${JSON.stringify(wrong)} is not the boolean ${value}`); }
    }
});

test('C5: effectivePolicyRows never throws and falls back to the defaults for any JSON shape', () => {
    const base = JSON.stringify(rowsOf(null));
    const shapes = [undefined, 0, 'x', true, [], [{ autoCommit: false }], { attribution: null, taskSizing: null },
        { attribution: [], taskSizing: 'x' }, { taskSizing: { warnSteps: null, maxSteps: {}, warnDistinctFiles: [], maxDistinctFiles: true } },
        { qualityGate: {}, consolidationBranch: [], qualityGateScope: 7 }];
    for (const shape of shapes) { assert.equal(JSON.stringify(rowsOf(shape)), base, JSON.stringify(shape)); }
});

'use strict';

// The Accounts presentation is the VS Code copy of JetBrains' AccountPresentation and MoeJson.parseAccountRotation.
// Both clients replay ONE held-out corpus (VSC-7, task-93729f32): wire JSON in; rows, chips and action flags out,
// text as { key, args }. This file only reads it: a row that JetBrains gets wrong is filed there, never edited here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const corpusPath = path.join(__dirname, '../../moe-jetbrains/src/test/resources/client-accounts.json');
const bundlePath = path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties');
const sourcePath = path.join(__dirname, '../src/util/AccountPresentation.ts');

function readText(file, what) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`cannot read the ${what} at ${file}: ${error.message}`);
    }
}

function readCorpus() {
    const text = readText(corpusPath, 'accounts corpus');
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`the accounts corpus at ${corpusPath} is not valid JSON: ${error.message}`);
    }
}

// AccountPresentation.ts must stay pure: a require of any name throws, so it needs no import at all.
// runInThisContext keeps its objects in this realm, so deepStrictEqual compares them with the corpus.
function loadPort() {
    const module = { exports: {} };
    const code = ts.transpileModule(readText(sourcePath, 'AccountPresentation.ts'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    vm.runInThisContext(`(function (exports, module, require) {${code}\n})`, { filename: sourcePath })(
        module.exports, module, name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });
    return module.exports;
}

function bundleValues() {
    const values = new Map();
    for (const m of readText(bundlePath, 'MoeBundle.properties').matchAll(/^(moe\.accounts\.[A-Za-z.]+)=(.*?)\r?$/gm)) values.set(m[1], m[2]);
    return values;
}

/** A bundle value the way MessageFormat shows it: each {n} replaced by its argument. */
const substitute = (template, args) => template.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));

/** Every { key, args } text the corpus expects, found by walking the rows with a JSON replacer. */
function textsOf(corpus) {
    const texts = [];
    JSON.stringify(corpus.rows, (_, v) => { if (v && typeof v.key === 'string' && Array.isArray(v.args)) texts.push(v); return v; });
    return texts;
}

test('the port is pure: no vscode reference in the source and no require at load time', () => {
    assert.doesNotMatch(readText(sourcePath, 'AccountPresentation.ts'), /\bvscode\b/);
    assert.equal(typeof loadPort().rows, 'function');
});

test('every rotation row renders through the port', () => {
    const corpus = readCorpus();
    assert.equal(corpus.version, 1);
    assert.ok(corpus.rows.length >= 12, `expected at least 12 rotation rows, got ${corpus.rows.length}`);
    const AP = loadPort();
    const now = Date.parse(corpus.now);
    assert.ok(!Number.isNaN(now), `the corpus now ${corpus.now} is not a date`);
    const failures = [];
    for (const row of corpus.rows) {
        try {
            const rotation = AP.parseAccountRotation(row.rotation);
            assert.equal(rotation === null, row.rotation === null, 'parseAccountRotation: null only for a null payload');
            assert.deepStrictEqual(AP.rows(rotation, now, corpus.zone), row.expectRows, 'rows');
            assert.deepStrictEqual(AP.chips(rotation, now, corpus.zone), row.expectChips, 'chips');
            assert.deepStrictEqual(AP.actions(rotation, row.selectedId, row.connected), row.expectActions, 'actions');
        } catch (error) {
            failures.push(`${row.id}: ${error.message}`);
        }
    }
    assert.deepStrictEqual(failures, []);
});

test('every label case follows the daemon rule', () => {
    const corpus = readCorpus();
    assert.ok(corpus.labels.length >= 8, `expected at least 8 label cases, got ${corpus.labels.length}`);
    const AP = loadPort();
    const failures = corpus.labels
        .filter(label => AP.isValidLabel(label.input) !== label.valid)
        .map(label => `${label.id}: ${JSON.stringify(label.input)} should be ${label.valid ? 'valid' : 'invalid'}`);
    assert.deepStrictEqual(failures, []);
});

test('the resolver speaks MoeBundle English', () => {
    const corpus = readCorpus();
    const AP = loadPort();
    const bundle = bundleValues();
    const failures = [];
    const texts = textsOf(corpus);
    assert.ok(texts.length > 0, 'no { key, args } text found in the corpus');
    for (const text of texts) {
        const template = bundle.get(text.key);
        if (template === undefined) failures.push(`${text.key}: not in ${bundlePath}`);
        else if (AP.resolveAccountText(text) !== substitute(template, text.args)) failures.push(`${text.key}: ${JSON.stringify(AP.resolveAccountText(text))} is not ${JSON.stringify(substitute(template, text.args))}`);
    }
    // Every template the port holds, so keys that later rows add stay pinned to the bundle.
    for (const [key, value] of Object.entries(AP.ACCOUNT_TEXT)) {
        if (bundle.get(key) !== value) failures.push(`ACCOUNT_TEXT ${key}: ${JSON.stringify(value)} is not ${JSON.stringify(bundle.get(key))}`);
        // A plain {n} substitution equals Java MessageFormat only while no value has a single quote.
        if (value.includes("'")) failures.push(`ACCOUNT_TEXT ${key}: a single quote would change MessageFormat output`);
    }
    for (const text of texts) if (!Object.hasOwn(AP.ACCOUNT_TEXT, text.key)) failures.push(`${text.key}: used by the corpus but missing from ACCOUNT_TEXT`);
    assert.deepStrictEqual(failures, []);
});

// The corpus does not pin these MoeJson rules or the never-throws promise; the port still owes them.
test('parseAccountRotation and the formatters take any payload without throwing', () => {
    const AP = loadPort();
    const rot = (more, accounts = []) => ({ registryFile: 'f', accounts, ...more });
    for (const bad of [undefined, null, 7, 'x', [], {}, { registryFile: ' ' }, { registryFile: 3 }]) assert.equal(AP.parseAccountRotation(bad), null);
    for (const at of [0, 101, 90.5, '75', null, NaN]) assert.equal(AP.parseAccountRotation(rot({ switchAtPercent: at })).switchAtPercent, 90);
    assert.equal(AP.parseAccountRotation(rot({ switchAtPercent: 75 })).switchAtPercent, 75);
    const windows = JSON.parse('{"__proto__":{"percent":5},"x":3}');
    const parsed = AP.parseAccountRotation(rot({ cli: { node: 'n' } }, [3, null, { id: ' ' }, { id: 'a', label: ' ', signIn: 'weird', windows, seats: ['s', 1] }, { id: 'a', label: 'dup' }]));
    assert.equal(parsed.cli, null);
    assert.deepStrictEqual(parsed.accounts.map(a => [a.id, a.label, a.signIn, a.seats]), [['a', 'a', 'signed_out', ['s']]]);
    assert.deepStrictEqual([...parsed.accounts[0].windows.keys()], ['__proto__']);
    assert.equal(AP.actions(AP.parseAccountRotation(rot({}, Array.from({ length: 33 }, (_, i) => ({ id: `a${i}` })))), null, true).add, false);
    const row = (account, now = Date.parse('2026-10-20T12:00:00Z'), zone = 'UTC') => AP.rows(AP.parseAccountRotation(rot({}, [{ id: 'a', signIn: 'subscription', ...account }])), now, zone)[0];
    const spent = '2026-10-20T14:05:00Z';
    assert.equal(row({ blockedUntil: spent }, NaN, 'No/Zone').status.args[0], spent); // an unusable now shows the time as sent
    assert.equal(row({ blockedUntil: spent }, undefined, 'No/Zone').status.args[0], '14:05'); // an unknown zone reads as UTC
    assert.equal(row({ blockedUntil: '2026-11-20T14:05:00Z' }).status.args[0], '11-20 14:05');
    assert.equal(row({ signIn: 'signed_out', blockedUntil: spent }).status.key, 'moe.accounts.status.signInNeeded');
    assert.deepStrictEqual(row({ windows: { five_hour: { percent: -5 } } }).fiveHour.args, [0]);
    // The first of equal weekly windows wins, and a window without a percent ranks below every percent.
    const weekly = { seven_day: { percent: 5 }, seven_day_opus: { percent: 5, resetsAt: spent }, seven_day_x: { percent: null } };
    assert.deepStrictEqual(row({ windows: weekly }).weekly, { key: 'moe.accounts.usage.percent', args: [5] });
    assert.equal(row({ windows: { seven_day: { percent: null }, seven_day_x: { percent: 0 } } }).weekly.key, 'moe.accounts.usage.percent');
    assert.equal(AP.resolveAccountText({ key: 'constructor', args: [] }), 'constructor');
    assert.equal(AP.resolveAccountText({ key: 'moe.accounts.chip.spent', args: ['$&'] }), '$& spent until {1}');
    assert.equal(AP.isValidLabel(7), false);
});

'use strict';

// moe-vscode/scripts/bundle-assets.mjs ships only the lockfiles' production packages and refuses a dist that imports a
// package it did not ship. moe-jetbrains/build.gradle.kts applies the same rule (task-864103f3), so both IDE bundles
// ship one node_modules set. Every row runs a COPY of the script inside a temp fixture repo, so nothing here can touch
// the real moe-vscode/bundled, even with a script that starts bundling as soon as it is imported.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '../scripts/bundle-assets.mjs');

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const manifestOf = name => JSON.stringify({ name, version: '1.0.0' });

// npm lockfile v3 shapes. Production: a, its nested c, scoped @s/g, devOptional e and optional f.
// Dev-only: b, its nested d, and @types/x.
const DAEMON_LOCK = {
    name: 'moe-daemon', lockfileVersion: 3, requires: true,
    packages: {
        '': { name: 'moe-daemon', dependencies: { a: '^1' }, devDependencies: { b: '^1' } },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/a/node_modules/c': { version: '2.0.0' },
        'node_modules/@s/g': { version: '1.0.0' },
        'node_modules/b': { version: '1.0.0', dev: true },
        'node_modules/b/node_modules/d': { version: '1.0.0', dev: true },
        'node_modules/@types/x': { version: '1.0.0', dev: true },
        'node_modules/e': { version: '1.0.0', devOptional: true },
        'node_modules/f': { version: '1.0.0', optional: true }
    }
};
const PROXY_LOCK = {
    name: 'moe-proxy', lockfileVersion: 3, requires: true,
    packages: {
        '': { name: 'moe-proxy', dependencies: { p: '^1' }, devDependencies: { q: '^1' } },
        'node_modules/p': { version: '1.0.0' },
        'node_modules/q': { version: '1.0.0', dev: true }
    }
};

/** A temp repo laid out as the script expects, holding a copy of the script under moe-vscode/scripts. */
function fixtureRepo(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-bundle-assets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'moe-vscode/scripts/bundle-assets.mjs');
    write(script, fs.readFileSync(SCRIPT, 'utf8'));
    write(path.join(root, 'scripts/bundle-manifest.json'), JSON.stringify({ copies: [{ from: 'docs', into: 'docs', files: ['readme.md'] }] }));
    write(path.join(root, 'docs/readme.md'), 'docs\n');
    const daemon = path.join(root, 'packages/moe-daemon');
    write(path.join(daemon, 'package.json'), JSON.stringify({ name: 'moe-daemon', version: '0.0.0', type: 'module' }));
    write(path.join(daemon, 'package-lock.json'), JSON.stringify(DAEMON_LOCK));
    write(path.join(daemon, 'dist/index.js'), "import fs from 'fs';\nimport { a } from 'a';\nimport '@s/g/register.js';\nexport * from './lib/x.js';\n");
    // Text that only looks like an import, in the shapes the real dist has (skillFiles.js, architectureRules.js).
    write(path.join(daemon, 'dist/lib/x.js'), "import path from 'node:path';\nexport const doc = \"run it from 'profile show'\";\n" +
        "export const isFrom = (t) => t.value === 'from' && t.next !== '(';\n");
    // Compiled tests never ship, so their dev-only imports never reach the scan.
    write(path.join(daemon, 'dist/index.test.js'), "import { test } from 'b';\n");
    for (const dir of ['a', 'a/node_modules/c', '@s/g', 'b', 'b/node_modules/d', '@types/x', 'e', 'f']) {
        write(path.join(daemon, 'node_modules', dir, 'package.json'), manifestOf(dir));
    }
    write(path.join(daemon, 'node_modules/a/index.js'), 'export const a = 1;\n');
    // On disk but not a lockfile package: none of it ships.
    write(path.join(daemon, 'node_modules/a/node_modules/stray/package.json'), manifestOf('stray'));
    write(path.join(daemon, 'node_modules/.bin/b'), '#!/bin/sh\n');
    write(path.join(daemon, 'node_modules/.package-lock.json'), '{}');
    write(path.join(daemon, 'node_modules/.vite/vitest/results.json'), '{}');
    const proxy = path.join(root, 'packages/moe-proxy');
    write(path.join(proxy, 'package.json'), JSON.stringify({ name: 'moe-proxy', version: '0.0.0', type: 'module' }));
    write(path.join(proxy, 'package-lock.json'), JSON.stringify(PROXY_LOCK));
    write(path.join(proxy, 'dist/index.js'), "import WebSocket from 'p';\n");
    for (const dir of ['p', 'q']) { write(path.join(proxy, 'node_modules', dir, 'package.json'), manifestOf(dir)); }
    return { script, daemon, bundled: path.join(root, 'moe-vscode/bundled') };
}

/** Run the copy the way `npm run bundle` does. */
const bundle = repo => spawnSync(process.execPath, [repo.script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

/** Every file under dir as sorted forward-slash relative paths; [] when dir is absent. */
function filesUnder(dir) {
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'))
        .sort();
}

test('B1: run directly, it ships exactly the lockfiles\' production packages beside the non-test dist', t => {
    const repo = fixtureRepo(t);
    const run = bundle(repo);
    assert.equal(run.status, 0, run.stderr);
    assert.deepStrictEqual(filesUnder(path.join(repo.bundled, 'daemon/node_modules')), ['@s/g/package.json', 'a/index.js',
        'a/node_modules/c/package.json', 'a/package.json', 'e/package.json', 'f/package.json']);
    assert.deepStrictEqual(filesUnder(path.join(repo.bundled, 'proxy/node_modules')), ['p/package.json']);
    assert.deepStrictEqual(filesUnder(path.join(repo.bundled, 'daemon')).filter(file => !file.startsWith('node_modules/')),
        ['index.js', 'lib/x.js', 'package.json']);
    assert.ok(fs.existsSync(path.join(repo.bundled, 'docs/readme.md')), 'the manifest copies still run');
});

test('B2: a dist file importing a package that did not ship stops the bundle, naming the specifier, file and line', t => {
    for (const source of ["const m = await import('b');\n", "\nimport d from 'b/lib/d.js';\n", "const x = require('@types/x');\n"]) {
        const repo = fixtureRepo(t);
        write(path.join(repo.daemon, 'dist/late.js'), source);
        const run = bundle(repo);
        const specifier = source.match(/'([^']+)'/)[1];
        const line = source.startsWith('\n') ? 2 : 1;
        assert.equal(run.status, 1, `${source}${run.stdout}`);
        assert.ok(run.stderr.includes(`'${specifier}' (late.js:${line})`), run.stderr);
        assert.deepStrictEqual(filesUnder(repo.bundled), [], 'checked before anything is copied');
    }
});

test('B3: an unusable lockfile stops the bundle naming the file, before anything is copied', t => {
    const withPackages = packages => JSON.stringify({ ...DAEMON_LOCK, packages: { ...DAEMON_LOCK.packages, ...packages } });
    const cases = {
        missing: lock => fs.rmSync(lock),
        unparseable: lock => fs.writeFileSync(lock, '{ "lockfileVersion": 3,'),
        'no packages map': lock => fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0' } } })),
        'a key outside node_modules': lock => fs.writeFileSync(lock, withPackages({ 'node_modules/../evil': { version: '1.0.0' } })),
        'a linked production package': lock => fs.writeFileSync(lock, withPackages({ 'node_modules/l': { resolved: '../l', link: true } })),
        'an entry that is not an object': lock => fs.writeFileSync(lock, withPackages({ 'node_modules/z': '1.0.0' }))
    };
    for (const [label, breakLock] of Object.entries(cases)) {
        const repo = fixtureRepo(t);
        breakLock(path.join(repo.daemon, 'package-lock.json'));
        const run = bundle(repo);
        assert.equal(run.status, 1, `${label}: ${run.stdout}`);
        assert.match(run.stderr, /moe-daemon[\\/]package-lock\.json/, `${label}: ${run.stderr}`);
        assert.deepStrictEqual(filesUnder(repo.bundled), [], `${label}: nothing copied, no whole-tree fallback`);
    }
});

test('B4: a production entry that is not installed stops the bundle naming it, optional ones included', t => {
    // A bundle is cross-platform, so an optional package missing on the build host fails too.
    for (const [name, remove] of [['@s/g', '@s/g'], ['f', 'f'], ['e', 'e/package.json']]) {
        const repo = fixtureRepo(t);
        fs.rmSync(path.join(repo.daemon, 'node_modules', remove), { recursive: true });
        const run = bundle(repo);
        assert.equal(run.status, 1, `${name}: ${run.stdout}`);
        assert.ok(run.stderr.includes(`(run npm ci in packages/moe-daemon): ${name}`), `${name}: ${run.stderr}`);
        assert.deepStrictEqual(filesUnder(repo.bundled), [], `${name}: checked before anything is copied`);
    }
});

test('B5: importing the script runs no bundle, and its helpers apply the rule and the scan', async t => {
    const repo = fixtureRepo(t);
    const { productionPackages, bareImports } = await import(pathToFileURL(repo.script).href);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(repo.bundled), false, 'an import must not bundle');
    assert.deepStrictEqual(await productionPackages(path.join(repo.daemon, 'package-lock.json')), ['@s/g', 'a', 'a/node_modules/c', 'e', 'f']);
    const source = [
        "import fs from 'fs';", 'import path from "node:path";', "import { x } from './x.js';", "export * from '../y.js';",
        "import json from '/abs/file.js';", "import a, { b } from 'a';", "export { g } from '@s/g/sub/index.js';",
        "import 'side-effect';", "const m = await import('dyn');", 'const r = require("req/deep");',
        "const s = \"t.value === 'from' && !isPunct(next, '(')\";", "export const doc = \"run it from 'profile show'\";",
        "export const s2 = `x from 'y'`;", 'import {', '    c,', '    d', "} from 'multi';"
    ].join('\n');
    // Source order, each with its specifier's own line (a multi-line import reports the line of 'multi').
    assert.deepStrictEqual(bareImports(source).map(found => `${found.specifier}:${found.line}`),
        ['a:6', '@s/g/sub/index.js:7', 'side-effect:8', 'dyn:9', 'req/deep:10', 'multi:17']);
});

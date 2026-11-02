const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// task-98c81a27: the RF02 persistent downgrade pin for VS Code (JetBrains RuntimeSelectionPolicy.profile, ProtectedStateStore).
// A RESTART is a fresh vm load against the same store root: the session pin resets, the owner-only record survives.
const clientSource = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/MoeDaemonClient.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const POSIX = process.platform !== 'win32';
const KEEP = 'Keep Protected';
const ALLOW = 'Allow Downgrade';
const VERIFIED = JSON.stringify({ settings: { executionProfile: 'verified-local' } });
const LEGACY = JSON.stringify({ settings: { executionProfile: 'legacy' } });
const OMITTED = JSON.stringify({ settings: {} });
const settle = () => new Promise(resolve => setImmediate(resolve));
const record = (project, profile) => JSON.stringify({ version: 1, project, profile });

/** One extension-host session. Each downgrade prompt resolves to `choice`; a function choice may throw or reject. */
function session(root, choice) {
    const [logs, asks] = [[], []];
    const window = {
        createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
        showWarningMessage: (message, options, ...items) => {
            asks.push({ message, modal: options?.modal, items: [...items] });
            return typeof choice === 'function' ? choice() : Promise.resolve(choice);
        }
    };
    const module = { exports: {} };
    vm.runInContext(clientSource, vm.createContext({
        exports: module.exports, module, process, Buffer, console, setTimeout, clearTimeout,
        require: name => name === 'vscode' ? { EventEmitter: class { event = () => ({ dispose() {} }); }, window } : require(name)
    }), { filename: 'MoeDaemonClient.ts' });
    const api = module.exports;
    if (root !== undefined) { api.useProtectedStateRoot(root); }
    return { api, asks, logs };
}

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-pin-'))));
    return made[made.length - 1];
}

function declare(dir, text) {
    fs.mkdirSync(path.join(dir, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moe', 'project.json'), text);
}

const project = text => { const dir = tempDir(); if (text !== undefined) { declare(dir, text); } return dir; };
/** A store root outside every project; it does not exist until the first write. */
const storeRoot = () => path.join(tempDir(), 'protected-state');
const keyOf = dir => session().api.projectStateKey(dir);
const recordFile = (root, dir) => path.join(root, session().api.protectedStateName('profile', keyOf(dir)));
const tree = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort();

/** Session 1 reads verified-local and persists the protected record; returns its file. */
function confirmProtected(root, dir) {
    const s1 = session(root);
    assert.equal(s1.api.runtimeProfile(dir), 'protected');
    assert.deepEqual(s1.asks, []);
    return recordFile(root, dir);
}

/** Test-side FNV-1a 64 over UTF-8, checked against the published vectors below. */
function fnv1a64(text) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(text, 'utf8')) { hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn; }
    return hash.toString(16).padStart(16, '0');
}

test('P1: a verified-local read persists exactly one owner-only protected record, named only by kind and key', () => {
    assert.equal(fnv1a64(''), 'cbf29ce484222325');
    assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
    const [root, dir] = [storeRoot(), project(VERIFIED)];
    const file = confirmProtected(root, dir);
    const { api } = session();
    const key = api.projectStateKey(dir);
    assert.equal(key, api.comparablePath(fs.realpathSync.native(dir), api.defaultFoldCase));
    const name = api.protectedStateName('profile', key);
    assert.equal(name, `${fnv1a64(`profile:${key}`)}.json`);
    assert.notEqual(api.protectedStateName('spawn', key), name);
    assert.deepEqual(fs.readdirSync(root), [name]);
    assert.equal(fs.readFileSync(file, 'utf8'), record(key, 'protected'));
    if (POSIX) {
        assert.equal(fs.statSync(root).mode & 0o777, 0o700);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

const FLIPS = [
    ['legacy', dir => declare(dir, LEGACY)],
    ['no executionProfile', dir => declare(dir, OMITTED)],
    ['no project.json', dir => fs.rmSync(path.join(dir, '.moe', 'project.json'))]
];
for (const [label, flip] of FLIPS) {
    test(`P2 (${label}): a confirmed protected project stays protected and asks once per session`, async () => {
        const [root, dir] = [storeRoot(), project(VERIFIED)];
        const file = confirmProtected(root, dir);
        flip(dir);
        const s2 = session(root);
        for (let i = 0; i < 3; i += 1) { assert.equal(s2.api.runtimeProfile(dir), 'protected'); }
        assert.equal(s2.asks.length, 1);
        const [ask] = s2.asks;
        assert.equal(ask.modal, true);
        assert.deepEqual(ask.items, [KEEP, ALLOW]);
        assert.ok(ask.message.startsWith(`${path.basename(dir)} now declares the legacy execution profile, but it was confirmed protected.`), ask.message);
        assert.match(ask.message, /An allowed downgrade takes effect after you restart VS Code\.$/);
        await settle();
        assert.equal(fs.readFileSync(file, 'utf8'), record(keyOf(dir), 'protected'));
    });
}

const REFUSALS = [
    ['Keep Protected', KEEP],
    ['a dismissal', undefined],
    ['another label', 'Allow downgrade'],
    ['a rejected prompt', () => Promise.reject(new Error('host gone'))],
    ['a throwing prompt', () => { throw new Error('no window'); }]
];
for (const [label, choice] of REFUSALS) {
    test(`P3/P4 (${label}): the record stays protected untouched and the next session asks again`, async () => {
        const [root, dir] = [storeRoot(), project(VERIFIED)];
        const file = confirmProtected(root, dir);
        declare(dir, LEGACY);
        const before = fs.statSync(file).ino;
        const s2 = session(root, choice);
        assert.equal(s2.api.runtimeProfile(dir), 'protected');
        await settle();
        assert.equal(s2.api.runtimeProfile(dir), 'protected');
        assert.equal(fs.readFileSync(file, 'utf8'), record(keyOf(dir), 'protected'));
        assert.equal(fs.statSync(file).ino, before, 'no write at all');
        assert.ok(s2.logs.some(line => line.includes('Moe keeps the protected profile')), s2.logs.join('\n'));
        const s3 = session(root, choice);
        assert.equal(s3.api.runtimeProfile(dir), 'protected');
        assert.equal(s3.asks.length, 1);
    });
}

test('P5: Allow Downgrade records legacy, effective only after a restart; verified-local again re-protects', async () => {
    const [root, dir] = [storeRoot(), project(VERIFIED)];
    const file = confirmProtected(root, dir);
    declare(dir, LEGACY);
    const s2 = session(root, ALLOW);
    assert.equal(s2.api.runtimeProfile(dir), 'protected');
    await settle();
    assert.equal(s2.api.runtimeProfile(dir), 'protected', 'the session that allowed it stays protected');
    assert.equal(s2.asks.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), record(keyOf(dir), 'legacy'));
    assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
    if (POSIX) { assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
    const s3 = session(root, ALLOW);
    assert.equal(s3.api.runtimeProfile(dir), 'legacy');
    assert.deepEqual(s3.asks, []);
    declare(dir, VERIFIED);
    assert.equal(s3.api.runtimeProfile(dir), 'protected');
    assert.equal(fs.readFileSync(file, 'utf8'), record(keyOf(dir), 'protected'));
});

/** An owner-only legacy record for `key` at dir/name: valid in every way but where it sits. */
function recordIn(dir, key, name) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), record(key, 'legacy'), { mode: 0o600 });
    return path.join(dir, name);
}

// Each plants a record a lax reader would take as legacy, then breaks one rule. SECRET must never reach a log.
const UNTRUSTED = [
    ['malformed JSON', key => 'SECRET not json'],
    ['an extra field', key => JSON.stringify({ version: 1, project: key, profile: 'legacy', note: 'SECRET' })],
    ['a missing field', key => JSON.stringify({ version: 1, project: key })],
    ['version 2', key => JSON.stringify({ version: 2, project: key, profile: 'legacy' })],
    ["another project's key", key => record(`${key}/SECRET`, 'legacy')],
    ['profile observe', key => record(key, 'observe')],
    ['a JSON array', key => '[]'],
    ['a byte order mark', key => `﻿${record(key, 'legacy')}`],
    ['a record larger than 64 KiB', key => record(key, 'legacy') + ' '.repeat(64 * 1024) + 'SECRET'],
    ['a record that is a directory', (key, root, file) => fs.mkdirSync(file)],
    ['a root that is a regular file', (key, root) => { fs.rmSync(root, { recursive: true }); fs.writeFileSync(root, 'SECRET'); }]
];
if (POSIX) {
    UNTRUSTED.push(
        ['a 0644 record', (key, root, file) => fs.chmodSync(recordIn(root, key, path.basename(file)), 0o644)],
        ['a 0755 root', (key, root, file) => fs.chmodSync(path.dirname(recordIn(root, key, path.basename(file))), 0o755)],
        ['a symlinked record', (key, root, file) => fs.symlinkSync(recordIn(tempDir(), key, path.basename(file)), file)],
        ['a symlinked root', (key, root, file) => {
            const real = path.dirname(recordIn(path.join(tempDir(), 'real-root'), key, path.basename(file)));
            fs.rmSync(root, { recursive: true });
            fs.symlinkSync(real, root);
        }]
    );
}
for (const [label, plant] of UNTRUSTED) {
    test(`P6 (${label}): an untrusted record reads as protected and asks`, async () => {
        const [root, dir] = [storeRoot(), project(LEGACY)];
        fs.mkdirSync(root, { mode: 0o700 });
        const file = recordFile(root, dir);
        const text = plant(keyOf(dir), root, file);
        if (typeof text === 'string') { fs.writeFileSync(file, text, { mode: 0o600 }); }
        const s = session(root);
        assert.equal(s.api.runtimeProfile(dir), 'protected');
        assert.equal(s.asks.length, 1);
        await settle();
        assert.ok(s.logs.some(line => line.includes('distrusts the persisted profile')), s.logs.join('\n'));
        assert.ok(!s.logs.some(line => line.includes('SECRET')), s.logs.join('\n'));
    });
}

test('P7: a store root inside the project persists nothing, yet the session stays protected', () => {
    const dir = project(VERIFIED);
    for (const root of [path.join(dir, 'state'), path.join(dir, '.moe', 'protected-state'), dir]) {
        const before = tree(dir);
        const s = session(root);
        assert.equal(s.api.runtimeProfile(dir), 'protected');
        assert.deepEqual(tree(dir), before, root);
        declare(dir, LEGACY);
        assert.equal(s.api.runtimeProfile(dir), 'protected');
        assert.deepEqual(s.asks, []);
        assert.equal(s.api.writeProtectedState(s.api.protectedStateName('profile', keyOf(dir)), '{}', dir), false);
        assert.deepEqual(tree(dir), before, root);
        declare(dir, VERIFIED);
    }
});

test('P8: a legacy project with no record never prompts and writes nothing', async () => {
    for (const text of [LEGACY, OMITTED, undefined]) {
        const [root, dir] = [storeRoot(), project(text)];
        const s = session(root, ALLOW);
        assert.equal(s.api.runtimeProfile(dir), 'legacy');
        assert.equal(s.api.runtimeProfile(dir), 'legacy');
        await settle();
        assert.deepEqual(s.asks, []);
        assert.equal(fs.existsSync(root), false);
    }
});

test('P9: with no store root the pin lasts only the session, nothing prompts and nothing persists', () => {
    const [root, dir] = [storeRoot(), project(VERIFIED)];
    confirmProtected(root, dir);
    const s1 = session();
    assert.equal(s1.api.runtimeProfile(dir), 'protected');
    declare(dir, LEGACY);
    assert.equal(s1.api.runtimeProfile(dir), 'protected');
    const s2 = session(root);
    s2.api.useProtectedStateRoot(undefined);
    assert.equal(s2.api.runtimeProfile(dir), 'legacy', 'a record is not read without a configured root');
    const name = s2.api.protectedStateName('profile', keyOf(dir));
    assert.equal(s2.api.readProtectedState(name), undefined);
    assert.equal(s2.api.writeProtectedState(name, '{}', dir), false);
    assert.deepEqual([...s1.asks, ...s2.asks], []);
});

// protected-runtime.test.cjs P2 already proves an untrusted declaration never pins.
test('P10: an untrusted declaration answers protected with no prompt and no write', () => {
    for (const text of ['{', JSON.stringify({ settings: { executionProfile: 'bogus' } })]) {
        const [root, dir] = [storeRoot(), project(VERIFIED)];
        const file = confirmProtected(root, dir);
        const before = fs.statSync(file).ino;
        declare(dir, text);
        const s = session(root);
        assert.equal(s.api.runtimeProfile(dir), 'protected');
        assert.deepEqual(s.asks, []);
        assert.equal(fs.statSync(file).ino, before);
        const [freshRoot, fresh] = [storeRoot(), project(text)];
        assert.equal(session(freshRoot).api.runtimeProfile(fresh), 'protected');
        assert.equal(fs.existsSync(freshRoot), false);
    }
});

test('S1: the store round-trips one kind, refuses names that are not its own, and keeps no temp file on a failed write', () => {
    const [root, dir] = [storeRoot(), project(LEGACY)];
    const { api } = session(root);
    const name = api.protectedStateName('spawn', keyOf(dir));
    assert.equal(api.readProtectedState(name), undefined);
    assert.equal(api.writeProtectedState(name, 'spawn record', dir), true);
    assert.equal(api.readProtectedState(name), 'spawn record');
    for (const bad of ['../escape.json', 'ABCDEF0123456789.json', `${'0'.repeat(64)}.json`, '0123456789abcdef']) {
        assert.throws(() => api.readProtectedState(bad), /name/);
        assert.equal(api.writeProtectedState(bad, 'x', dir), false);
    }
    assert.equal(api.writeProtectedState(name, 'x'.repeat(64 * 1024 + 1), dir), false);
    const blocked = api.protectedStateName('profile', keyOf(dir));
    fs.mkdirSync(path.join(root, blocked));
    assert.equal(api.writeProtectedState(blocked, 'x', dir), false);
    assert.deepEqual(fs.readdirSync(root).sort(), [blocked, name].sort());
    assert.equal(api.readProtectedState(name), 'spawn record');
});

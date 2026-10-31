const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// The 64 KiB cap is a contract shared with the daemon, proxy, Claude-plugin and JetBrains readers.
const CAP = 65536;

const clientPath = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const extensionPath = path.join(__dirname, '../src/extension.ts');
const compiled = ts.transpileModule(fs.readFileSync(clientPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

// Guarded fs: the two throws are safety stops so a wrong implementation fails fast
// instead of pulling the multi-GiB fixture into memory.
function load(readSyncOverride) {
    const stats = { wholeFileReads: 0, opened: [], closed: [], bytesRead: 0 };
    const guarded = {
        ...fs,
        readFileSync: (file, ...rest) => {
            if (String(file).endsWith('daemon.json')) {
                stats.wholeFileReads++;
                throw new Error('whole-file read');
            }
            return fs.readFileSync(file, ...rest);
        },
        openSync: (...args) => { const fd = fs.openSync(...args); stats.opened.push(fd); return fd; },
        readSync: (...args) => {
            if (readSyncOverride) { return readSyncOverride(...args); }
            const n = fs.readSync(...args);
            stats.bytesRead += n;
            if (stats.bytesRead > 1024 * 1024) { throw new Error('unbounded read'); }
            return n;
        },
        closeSync: fd => { stats.closed.push(fd); return fs.closeSync(fd); }
    };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); },
        window: { createOutputChannel: () => ({ appendLine() {} }) }
    };
    const module = { exports: {} };
    const context = vm.createContext({
        exports: module.exports, module, process, console, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'fs' ? guarded : require(name)
    });
    vm.runInContext(compiled, context, { filename: clientPath });
    return { readDaemonJsonText: module.exports.readDaemonJsonText, stats };
}

function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-daemon-json-cap-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function paddedFixture(file, info, bytes) {
    const text = JSON.stringify(info).padEnd(bytes, ' ');
    assert.equal(Buffer.byteLength(text), bytes);
    fs.writeFileSync(file, text);
}

const info = { port: 9876, pid: 4242, projectPath: '/tmp/project' };

test('readDaemonJsonText accepts a valid 65536-byte daemon.json', () => withTempDir(dir => {
    const file = path.join(dir, 'daemon.json');
    paddedFixture(file, info, CAP);
    const { readDaemonJsonText, stats } = load();
    const text = readDaemonJsonText(file);
    assert.deepEqual(JSON.parse(text), info);
    assert.equal(stats.bytesRead, CAP);
    assert.equal(stats.opened.length, 1);
    assert.deepEqual(stats.closed, stats.opened);
}));

test('readDaemonJsonText refuses a valid 65537-byte daemon.json', () => withTempDir(dir => {
    const file = path.join(dir, 'daemon.json');
    paddedFixture(file, info, CAP + 1);
    const { readDaemonJsonText, stats } = load();
    assert.throws(() => readDaemonJsonText(file), /larger than 64 KiB/);
    assert.deepEqual(stats.closed, stats.opened);
}));

test('readDaemonJsonText refuses a sparse 3 GiB daemon.json promptly', () => withTempDir(dir => {
    const file = path.join(dir, 'daemon.json');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 3 * 1024 ** 3);
    fs.closeSync(fd);
    const { readDaemonJsonText, stats } = load();
    const started = Date.now();
    assert.throws(() => readDaemonJsonText(file), /larger than 64 KiB/);
    assert.ok(Date.now() - started < 2000, 'must not scan the whole file');
    assert.equal(stats.wholeFileReads, 0);
    assert.equal(stats.bytesRead, CAP + 1, 'reads exactly cap + 1 bytes, no size pre-check');
    assert.equal(stats.opened.length, 1);
    assert.deepEqual(stats.closed, stats.opened);
}));

test('readDaemonJsonText propagates a read error and still closes the descriptor', () => withTempDir(dir => {
    const file = path.join(dir, 'daemon.json');
    paddedFixture(file, info, 100);
    const { readDaemonJsonText, stats } = load(() => { throw Object.assign(new Error('boom'), { code: 'EIO' }); });
    assert.throws(() => readDaemonJsonText(file), error => error.code === 'EIO');
    assert.equal(stats.opened.length, 1);
    assert.deepEqual(stats.closed, stats.opened);
}));

test('no daemon.json read bypasses the helper', () => {
    const client = fs.readFileSync(clientPath, 'utf8');
    const extension = fs.readFileSync(extensionPath, 'utf8');
    assert.doesNotMatch(client, /readFileSync\([^)]*daemon/i);
    assert.doesNotMatch(extension, /readFileSync\([^)]*daemon/i);
    assert.match(extension, /import \{[^}]*readDaemonJsonText[^}]*\} from '\.\/services\/MoeDaemonClient'/);
});

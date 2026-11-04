const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

function fixture(projectPath) {
    const logs = [], warnings = [], spawns = [];
    const module = { exports: {} };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: projectPath } }],
            getConfiguration: () => ({ get: (key, fallback) => key === 'daemon.port' ? 0 : key === 'autoConnect' ? false : fallback }) },
        window: { createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
            showWarningMessage: m => { warnings.push(m); return Promise.resolve(); }, showErrorMessage: () => Promise.resolve() }
    };
    vm.runInNewContext(compiled, { module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
            spawn: (...args) => { spawns.push(args); const c = new EventEmitter(); c.unref = () => {}; queueMicrotask(() => c.emit('spawn')); return c; }
        } : require(name) }, { filename: sourcePath });
    const client = new module.exports.MoeDaemonClient('plugin');
    client.resolveBundledDaemonPath = () => 'bundled-daemon.js';
    client.waitForDaemonInfo = async () => {};
    return { ...module.exports, client, logs, warnings, spawns };
}

function layout(t, withLink) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-symlink-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, 'real', 'proj'), other = path.join(root, 'other');
    fs.mkdirSync(path.join(real, '.moe'), { recursive: true });
    fs.mkdirSync(other);
    const out = { real, other, file: path.join(real, '.moe', 'daemon.json') };
    if (!withLink) return out;
    try { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (err) { if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip(`symlink refused: ${err.code}`); return undefined; } throw err; }
    return { ...out, viaLink: path.join(root, 'link', 'proj') };
}

async function daemon(t, healthPath, rootPath = healthPath) {
    let ws = 0;
    const httpServer = http.createServer((_, res) => res.end(JSON.stringify({ projectPath: healthPath })));
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', socket => { ws++; socket.send(JSON.stringify({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p', name: 'p', rootPath, settings: {} }, epics: [], tasks: [], workers: [], proposals: [], teams: [] } })); });
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
    t.after(async () => { for (const c of wss.clients) c.terminate(); await new Promise(r => wss.close(r)); httpServer.closeAllConnections(); await new Promise(r => httpServer.close(r)); });
    return { port: httpServer.address().port, ws: () => ws };
}

const record = (port, projectPath) => JSON.stringify({ port, pid: process.pid, startedAt: '2026-11-04T08:00:00.000Z', projectPath });
async function until(predicate) { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); return predicate(); }

test('H1 link and real spellings are one project in both directions', t => {
    const l = layout(t, true); if (!l) return;
    const f = fixture(l.real);
    assert.equal(f.pathsMatch(l.viaLink, l.real), false);
    assert.equal(f.isSameProject(l.viaLink, l.real), true);
    assert.equal(f.isSameProject(l.real, l.viaLink), true);
});
test('H2 distinct existing folders stay apart', t => {
    const l = layout(t, false);
    assert.equal(fixture(l.real).isSameProject(l.real, l.other), false);
});
test('H3 unresolvable paths fall back to the spelling rule', t => {
    const l = layout(t, true); if (!l) return;
    const f = fixture(l.real);
    assert.equal(f.isSameProject(path.join(path.dirname(l.viaLink), 'missing'), path.join(path.dirname(l.real), 'missing')), false);
    assert.equal(f.isSameProject('D:\\x\\y', '/mnt/d/x/y'), true);
});
test('H4 a relative spelling is never resolved', t => {
    const l = layout(t, true); if (!l) return;
    const rel = path.relative(process.cwd(), l.viaLink);
    if (path.isAbsolute(rel)) { t.skip('no relative spelling across drives'); return; }
    assert.equal(fixture(l.real).isSameProject(rel, l.real), false);
});
test('H5 a doubled-separator spelling is never resolved', t => {
    const l = layout(t, false);
    const doubled = process.platform === 'win32' ? `\\\\?\\${l.real}` : `/${l.real}`;
    assert.equal(fixture(l.real).isSameProject(doubled, l.real), false);
});
for (const [name, workspace, served] of [['L1 a workspace opened through a link', 'viaLink', 'real'], ['L2 a daemon started through a link', 'real', 'viaLink']]) {
    test(`${name} keeps and connects to its live daemon`, async t => {
        const l = layout(t, true); if (!l) return;
        const live = await daemon(t, l[served]);
        const text = record(live.port, l[served]);
        fs.writeFileSync(l.file, text);
        const f = fixture(l[workspace]);
        t.after(() => f.client.disconnect());
        const outcome = await f.client.connect().then(() => 'connected', error => error.message);
        assert.equal(outcome, 'connected');
        assert.equal(await f.client.waitForState(2000), true, 'STATE_SNAPSHOT accepted');
        assert.deepEqual(f.spawns.length, 0);
        assert.equal(fs.existsSync(l.file) && fs.readFileSync(l.file, 'utf8'), text);
        assert.equal(live.ws(), 1);
        assert.equal(f.client.connectionState, 'connected');
        assert.deepEqual(f.logs.filter(line => /Stale daemon\.json|project mismatch/.test(line)), []);
    });
}
test('M1 ensureDaemonRunning: daemon.json naming another folder is replaced', async t => {
    const l = layout(t, false);
    fs.writeFileSync(l.file, record(9, l.other));
    const f = fixture(l.real);
    t.after(() => f.client.disconnect());
    await assert.rejects(f.client.connect(), /Daemon not running/);
    assert.deepEqual(f.spawns.map(a => Array.from(a[1])), [['bundled-daemon.js', 'start', '--project', l.real]]);
    assert.equal(fs.existsSync(l.file), false);
    assert.ok(f.logs.some(line => line.includes(`Stale daemon.json: expected project ${l.real}, found ${l.other}`)));
});
test('M2 getDaemonInfo: daemon.json naming another folder is not adopted', async t => {
    const l = layout(t, false);
    const text = record(9, l.other);
    fs.writeFileSync(l.file, text);
    const f = fixture(l.real);
    assert.equal(await f.client.getDaemonInfo(false), undefined);
    assert.equal(fs.readFileSync(l.file, 'utf8'), text);
    assert.equal(await f.client.getDaemonInfo(), undefined);
    assert.equal(fs.existsSync(l.file), false);
});
test('M3 /health naming another folder is refused with the warning', async t => {
    const l = layout(t, false);
    const foreign = await daemon(t, l.other);
    fs.writeFileSync(l.file, record(foreign.port, l.real));
    const f = fixture(l.real);
    t.after(() => f.client.disconnect());
    await assert.rejects(f.client.connect());
    assert.equal(foreign.ws(), 0);
    assert.ok(f.warnings.some(m => m.includes(`serves ${l.other}, not this workspace (${l.real}). Starting this project's daemon`)));
    assert.deepEqual(f.spawns.map(a => Array.from(a[1])), [['bundled-daemon.js', 'start', '--project', l.real]]);
});
test('M4 STATE_SNAPSHOT naming another folder disconnects', async t => {
    const l = layout(t, false);
    const live = await daemon(t, l.real, l.other);
    fs.writeFileSync(l.file, record(live.port, l.real));
    const f = fixture(l.real);
    t.after(() => f.client.disconnect());
    await f.client.connect();
    assert.equal(await until(() => f.logs.some(line => line.includes(`STATE_SNAPSHOT project mismatch: expected ${l.real}, got ${l.other}`))), true);
    assert.equal(fs.existsSync(l.file), false);
    assert.equal(f.client.isStateReady, false);
    assert.equal(f.client.connectionState, 'disconnected');
});
function closedPort() {
    return new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
test('L3 a link to a live off-loopback daemon is refused, not respawned', async t => {
    const l = layout(t, true); if (!l) return;
    const text = JSON.stringify({ port: await closedPort(), pid: process.pid, startedAt: '2026-11-04T08:00:00.000Z', projectPath: l.real, bindHost: '::1' });
    fs.writeFileSync(l.file, text);
    const f = fixture(l.viaLink);
    t.after(() => f.client.disconnect());
    const outcome = await f.client.connect().then(() => 'connected', error => error.message);
    assert.ok(outcome.includes('listens on ::1'), outcome);
    assert.equal(f.spawns.length, 0);
    assert.equal(fs.existsSync(l.file) && fs.readFileSync(l.file, 'utf8'), text);
});
test('M5 offLoopbackBindRefusal: daemon.json naming another folder keeps today\'s path', t => {
    const l = layout(t, false);
    const f = fixture(l.real), win = process.platform === 'win32';
    assert.equal(f.offLoopbackBindRefusal({ bindHost: '::1', pid: process.pid, projectPath: l.other }, l.real, win), null);
    assert.equal(typeof f.offLoopbackBindRefusal({ bindHost: '::1', pid: process.pid, projectPath: l.real }, l.real, win), 'string');
});

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

function fixture(projectPath = '/home/project', configPort = 0, platform = process.platform) {
    const logs = [], warnings = [], errors = [], spawns = [];
    const module = { exports: {} };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: projectPath } }],
            getConfiguration: () => ({ get: (key, fallback) => key === 'daemon.port' ? configPort
                : key === 'autoConnect' ? false : fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
            showWarningMessage: message => { warnings.push(message); return Promise.resolve(); },
            showErrorMessage: message => { errors.push(message); return Promise.resolve(); }
        }
    };
    vm.runInNewContext(compiled, {
        module, exports: module.exports, process: { ...process, platform }, Buffer, console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
            spawn: (...args) => {
                spawns.push(args);
                const child = new EventEmitter();
                child.unref = () => {};
                queueMicrotask(() => child.emit('spawn'));
                return child;
            }
        } : name === 'path' && platform === 'win32' ? path.win32 : require(name)
    }, { filename: sourcePath });
    const client = new module.exports.MoeDaemonClient('plugin');
    client.resolveBundledDaemonPath = () => 'bundled-daemon.js';
    client.waitForDaemonInfo = async () => {};
    return { ...module.exports, client, logs, warnings, errors, spawns };
}

async function server(t, handler) {
    const httpServer = http.createServer(handler);
    const wss = new WebSocketServer({ server: httpServer });
    let connections = 0;
    wss.on('connection', () => { connections++; });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
    });
    return { port: httpServer.address().port, connections: () => connections };
}

const spellings = ['D:\\x\\y', 'd:/x/y/', 'D:\\x\\.\\y', '/mnt/d/x/y'];
for (const platform of ['linux', 'win32']) {
    test(`A path keys follow the transport contract on ${platform}`, () => {
        const f = fixture(undefined, 0, platform);
        for (const a of spellings) for (const b of spellings) {
            assert.equal(f.comparableProjectPath(a), 'd:/x/y');
            assert.equal(f.pathsMatch(a, b), true);
        }
        assert.equal(f.pathsMatch('/home/a', '/home/b'), false);
        assert.equal(f.pathsMatch('/home/OtherProject', '/home/otherproject'), false);
        assert.equal(f.pathsMatch('\\\\srv\\share\\p', '//SRV/SHARE/P/'), true);
        assert.equal(f.pathsMatch('\\\\wsl$\\Ubuntu\\home\\A', '/home/A'), true);
        assert.equal(f.pathsMatch('//wsl.localhost/Ubuntu/home/A', '/home/A'), true);
        assert.equal(f.pathsMatch('/home/a\\b', '/home/a/b'), false);
        for (const value of [...spellings, '\\\\srv\\share', '/']) assert.equal(f.isAbsoluteAnyOs(value), true);
        for (const value of ['.', '', 'D:x', '\\x']) assert.equal(f.isAbsoluteAnyOs(value), false);
    });
}

for (const served of spellings) {
    test(`B same: ${served}`, async t => {
        const s = await server(t, (_, res) => res.end(JSON.stringify({ projectPath: served })));
        assert.equal((await fixture().probeDaemonIdentity('127.0.0.1', s.port, 'D:/x/y')).kind, 'same');
    });
}
for (const status of [200, 503]) {
    test(`B foreign: HTTP ${status}`, async t => {
        const served = '/home/other';
        const s = await server(t, (_, res) => { res.writeHead(status); res.end(JSON.stringify({ projectPath: served })); });
        const result = await fixture().probeDaemonIdentity('127.0.0.1', s.port, '/home/project');
        assert.equal(result.kind, 'foreign');
        assert.equal(result.projectPath, served);
    });
}
const unknownBodies = ['{"projectPath":"."}', 'not JSON', '[]', '{}', '{"projectPath":42}',
    '{"projectPath":""}', '{"projectPath":null}', JSON.stringify({ projectPath: '/' + 'x'.repeat(65536) })];
for (const [i, body] of unknownBodies.entries()) {
    test(`B unknown body ${i}`, async t => {
        const s = await server(t, (_, res) => res.end(body));
        assert.equal((await fixture().probeDaemonIdentity('127.0.0.1', s.port, '/home/project')).kind, 'unknown');
    });
}
for (const status of [426, 500]) {
    test(`B unknown HTTP ${status}`, async t => {
        const s = await server(t, (_, res) => { res.writeHead(status); res.end('{"projectPath":"/other"}'); });
        assert.equal((await fixture().probeDaemonIdentity('127.0.0.1', s.port, '/home/project')).kind, 'unknown');
    });
}
test('B unknown refused connection or invalid endpoint never rejects', async () => {
    const s = http.createServer();
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    const port = s.address().port;
    await new Promise(resolve => s.close(resolve));
    const f = fixture();
    assert.equal((await f.probeDaemonIdentity('127.0.0.1', port, '/home/project')).kind, 'unknown');
    assert.equal((await f.probeDaemonIdentity('bad host', -1, '/home/project')).kind, 'unknown');
});
for (const trickle of [false, true]) {
    test(`B overall deadline closes a ${trickle ? 'trickling' : 'silent'} socket`, async t => {
        let closed = false;
        const s = await server(t, (req, res) => {
            const timer = trickle ? setInterval(() => res.write(' '), 20) : undefined;
            req.on('close', () => { closed = true; clearInterval(timer); });
        });
        const start = Date.now();
        assert.equal((await fixture().probeDaemonIdentity('127.0.0.1', s.port, '/home/project', { timeoutMs: 150 })).kind, 'unknown');
        assert.ok(Date.now() - start < 1000);
        for (let i = 0; i < 30 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(closed, true, 'probe must destroy its socket');
    });
}

function metadata(t) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-identity-'));
    fs.mkdirSync(path.join(project, '.moe'));
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    return { project, file: path.join(project, '.moe', 'daemon.json') };
}
const original = { pid: 1234, port: 9876, startedAt: '2026-10-30T00:00:00Z' };
for (const changed of [undefined, 'pid', 'port', 'startedAt', 'missing', 'unparseable', 'oversize']) {
    test(`C guarded removal: ${changed ?? 'unchanged'}`, t => {
        const { file } = metadata(t);
        const current = { ...original, [changed]: 'replacement' };
        const text = changed === 'unparseable' ? '{' : changed === 'oversize' ? ' '.repeat(65537) : JSON.stringify(current);
        if (changed !== 'missing') fs.writeFileSync(file, text);
        assert.doesNotThrow(() => fixture().removeDaemonJsonIfUnchanged(file, original));
        assert.equal(fs.existsSync(file), changed !== undefined && changed !== 'missing');
        if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8'), text);
    });
}

for (const mode of ['foreign', 'same', 'configured', 'unknown', 'second-foreign', 'replaced', 'recovered']) {
    test(`D connect: ${mode}`, async t => {
        const { project, file } = metadata(t);
        let health = 0;
        const s = await server(t, (req, res) => {
            assert.equal(req.url, '/health');
            health++;
            if (mode === 'replaced') fs.writeFileSync(file, JSON.stringify({ ...original, pid: 9999, projectPath: '/replacement' }));
            res.end(JSON.stringify(mode === 'unknown' ? {} : { projectPath: mode === 'same' ? project : '/foreign/project' }));
        });
        const text = JSON.stringify({ ...original, projectPath: project, port: s.port });
        fs.writeFileSync(file, text);
        const f = fixture(project, mode === 'configured' ? s.port : 0);
        t.after(() => f.client.disconnect());
        if (mode === 'second-foreign') f.client.waitForDaemonInfo = async () => fs.writeFileSync(file, text);
        if (mode === 'recovered') {
            const replacement = await server(t, (_, res) => res.end(JSON.stringify({ projectPath: project })));
            f.client.waitForDaemonInfo = async () => fs.writeFileSync(file, JSON.stringify({ ...original, port: replacement.port }));
            await Promise.all([f.client.connect(), f.client.connect()]);
            assert.equal(s.connections(), 0);
            assert.equal(replacement.connections(), 1);
            assert.equal(f.spawns.length, 1);
            return;
        }
        if (mode === 'same' || mode === 'unknown') {
            await f.client.connect();
            assert.equal(s.connections(), 1);
            assert.equal(fs.readFileSync(file, 'utf8'), text);
            assert.equal(f.spawns.length, 0);
            return;
        }
        const outcome = await f.client.connect().then(() => undefined, error => error);
        assert.equal(s.connections(), 0, 'foreign daemon must never see /ws');
        assert.ok(outcome, 'failed recovery or configured foreign endpoint must reject');
        assert.equal(f.client.connectionState, 'disconnected');
        assert.equal(f.client.connectInProgress, false);
        assert.equal(f.client.pingInterval, undefined);
        if (mode === 'configured') {
            assert.equal(fs.readFileSync(file, 'utf8'), text);
            assert.equal(f.spawns.length, 0);
            assert.ok(f.errors.some(message => message.includes('/foreign/project') && message.includes(project)));
        } else {
            assert.equal(f.spawns.length, 1);
            assert.deepEqual(Array.from(f.spawns[0][1]), ['bundled-daemon.js', 'start', '--project', project]);
            assert.ok(f.warnings.some(message => message.includes('/foreign/project') && message.includes(project)));
            assert.ok(f.logs.some(message => message.includes('/foreign/project')));
            assert.equal(fs.existsSync(file), mode === 'second-foreign' || mode === 'replaced');
            if (mode === 'replaced') assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 9999);
        }
        assert.equal(health, mode === 'second-foreign' ? 2 : 1, 'recovery must not loop');
    });
}

// E: Cancellation before /ws opens, including foreign-daemon recovery.
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function until(predicate, label) {
    for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), label);
}

function settled(promise) {
    return promise.then(() => 'resolved', error => error);
}

function assertIdle(f) {
    assert.equal(f.client.connectionState, 'disconnected');
    assert.equal(f.client.connectInProgress, false);
    assert.equal(f.client.pingInterval, undefined);
    assert.equal(f.client.ws, undefined);
}

function cancel(f, how) {
    if (how === 'dispose') f.client.dispose();
    else f.client.disconnect();
}

async function startupGated(t) {
    const { project, file } = metadata(t);
    let health = 0;
    const s = await server(t, (_, res) => { health++; res.end(JSON.stringify({ projectPath: project })); });
    const f = fixture(project);
    t.after(() => f.client.disconnect());
    const gate = deferred();
    f.client.waitForDaemonInfo = async () => {
        await gate.promise;
        fs.writeFileSync(file, JSON.stringify({ ...original, projectPath: project, port: s.port }));
    };
    return { f, s, file, gate, health: () => health };
}

for (const how of ['disconnect', 'dispose']) {
    test(`E ${how} during daemon startup opens nothing`, async t => {
        const { f, s, gate, health } = await startupGated(t);
        const attempt = f.client.connect();
        await until(() => f.spawns.length === 1, 'startup spawned');
        cancel(f, how);
        gate.resolve();
        assert.equal(await settled(attempt), 'resolved');
        assert.equal(health(), 0, 'cancelled startup must not probe');
        assert.equal(s.connections(), 0);
        assertIdle(f);
    });

    test(`E ${how} during the identity probe opens nothing`, async t => {
        const { project, file } = metadata(t);
        const arrived = deferred();
        let respond;
        const s = await server(t, (_, res) => {
            respond = () => res.end(JSON.stringify({ projectPath: project }));
            arrived.resolve();
        });
        const text = JSON.stringify({ ...original, projectPath: project, port: s.port });
        fs.writeFileSync(file, text);
        const f = fixture(project);
        t.after(() => f.client.disconnect());
        const attempt = f.client.connect();
        await arrived.promise;
        cancel(f, how);
        respond();
        assert.equal(await settled(attempt), 'resolved');
        assert.equal(s.connections(), 0);
        assert.equal(f.spawns.length, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), text);
        assertIdle(f);
    });
}

for (const endpoint of ['metadata', 'configured']) {
    test(`E disconnect during a foreign ${endpoint} probe acts on nothing`, async t => {
        const { project, file } = metadata(t);
        const arrived = deferred();
        let respond;
        const s = await server(t, (_, res) => {
            respond = () => res.end(JSON.stringify({ projectPath: '/foreign/project' }));
            arrived.resolve();
        });
        const text = JSON.stringify({ ...original, projectPath: project, port: s.port });
        fs.writeFileSync(file, text);
        const f = fixture(project, endpoint === 'configured' ? s.port : 0);
        t.after(() => f.client.disconnect());
        const attempt = f.client.connect();
        await arrived.promise;
        f.client.disconnect();
        respond();
        assert.equal(await settled(attempt), 'resolved');
        assert.equal(s.connections(), 0);
        assert.equal(f.spawns.length, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), text);
        assert.deepEqual(f.warnings, []);
        assert.deepEqual(f.errors, []);
        assertIdle(f);
    });
}

for (const phase of ['respawn', 'reprobe']) {
    test(`E disconnect during foreign recovery ${phase} opens nothing`, async t => {
        const { project, file } = metadata(t);
        const s = await server(t, (_, res) => res.end(JSON.stringify({ projectPath: '/foreign/project' })));
        const arrived = deferred(), gate = deferred();
        let health = 0, respond;
        const r = await server(t, (_, res) => {
            health++;
            respond = () => res.end(JSON.stringify({ projectPath: '/foreign/project' }));
            if (phase === 'respawn') res.end(JSON.stringify({ projectPath: project }));
            arrived.resolve();
        });
        fs.writeFileSync(file, JSON.stringify({ ...original, projectPath: project, port: s.port }));
        const f = fixture(project);
        t.after(() => f.client.disconnect());
        f.client.waitForDaemonInfo = async () => {
            if (phase === 'respawn') await gate.promise;
            fs.writeFileSync(file, JSON.stringify({ ...original, projectPath: project, port: r.port }));
        };
        const attempt = f.client.connect();
        if (phase === 'respawn') {
            await until(() => f.spawns.length === 1, 'recovery spawned');
            f.client.disconnect();
            gate.resolve();
        } else {
            await arrived.promise;
            f.client.disconnect();
            respond();
        }
        assert.equal(await settled(attempt), 'resolved');
        if (phase === 'respawn') assert.equal(health, 0, 'cancelled recovery must not reprobe');
        assert.equal(s.connections(), 0);
        assert.equal(r.connections(), 0);
        assertIdle(f);
    });
}

test('E connect after disconnect re-arms the pending attempt (moe.reconnect)', async t => {
    const { f, s, gate } = await startupGated(t);
    const first = f.client.connect();
    await until(() => f.spawns.length === 1, 'startup spawned');
    f.client.disconnect();
    const second = f.client.connect();
    gate.resolve();
    assert.equal(await settled(first), 'resolved');
    assert.equal(await settled(second), 'resolved');
    assert.equal(s.connections(), 1);
    assert.equal(f.client.connectionState, 'connected');
    assert.notEqual(f.client.pingInterval, undefined);
});

test('E dispose is terminal: a later connect() opens nothing', async t => {
    const { f, s, file, gate, health } = await startupGated(t);
    const first = f.client.connect();
    await until(() => f.spawns.length === 1, 'startup spawned');
    f.client.dispose();
    const second = f.client.connect();
    gate.resolve();
    assert.equal(await settled(first), 'resolved');
    assert.equal(await settled(second), 'resolved');
    fs.unlinkSync(file);
    assert.equal(await settled(f.client.connect()), 'resolved');
    assert.deepEqual([health(), f.spawns.length, s.connections()], [0, 1, 0]);
    assertIdle(f);
});

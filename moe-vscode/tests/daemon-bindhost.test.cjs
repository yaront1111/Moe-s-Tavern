// task-c203c09a: a live same-project daemon bound off loopback is refused before any spawn or removal.
// VS Code dials 127.0.0.1 only, so such a daemon is out of reach, not stale (twin of JetBrains offLoopbackBindRefusal).
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

// The daemon-identity fixture plus an options bag: the endpoint settings and autoConnect (the reconnect timer needs it on).
function fixture({ configPort = 0, configHost, autoConnect = true } = {}, projectPath = '/home/project') {
    const logs = [], warnings = [], errors = [], spawns = [], f = {};
    const module = { exports: {} };
    const settings = { 'daemon.port': configPort, 'daemon.host': configHost, autoConnect };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: projectPath } }],
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
            showWarningMessage: message => { warnings.push(message); return Promise.resolve(); },
            showErrorMessage: message => { errors.push(message); return Promise.resolve(); }
        }
    };
    vm.runInNewContext(compiled, {
        module, exports: module.exports, process: { ...process }, Buffer, console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
            spawn: (...args) => {
                spawns.push(args);
                const child = new EventEmitter();
                child.unref = () => {};
                queueMicrotask(() => child.emit('spawn'));
                return child;
            }
        } : require(name)
    }, { filename: sourcePath });
    const client = new module.exports.MoeDaemonClient('plugin');
    client.resolveBundledDaemonPath = () => 'bundled-daemon.js';
    client.waitForDaemonInfo = async () => {};
    return Object.assign(f, module.exports, { client, logs, warnings, errors, spawns });
}

function metadata(t) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-bindhost-'));
    fs.mkdirSync(path.join(project, '.moe'));
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    return { project, file: path.join(project, '.moe', 'daemon.json') };
}

const record = (project, port, bindHost, extra = {}) =>
    ({ port, pid: process.pid, startedAt: '2026-11-04T00:00:00Z', projectPath: project, bindHost, ...extra });

// A server that counts /health requests and /ws upgrades; an IPv6 loopback that is missing skips the row.
async function listen(t, host, port, onHealth) {
    const seen = { health: 0, ws: 0 };
    const httpServer = http.createServer((req, res) => { seen.health++; onHealth(req, res); });
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.on('upgrade', () => { seen.ws++; });
    wss.on('error', () => {}); // ws re-emits the server's listen error; the caller reads it below
    const opened = await new Promise(resolve => {
        httpServer.once('error', error => resolve(error));
        httpServer.listen(port, host, () => resolve(undefined));
    });
    if (opened) { httpServer.close(); wss.close(); return { error: opened }; }
    t.after(async () => {
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
    });
    return { port: httpServer.address().port, seen };
}

const NO_V6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
const json = body => (_, res) => res.end(JSON.stringify(body));

// A same-project daemon on [::1]:P; withOther also puts another project's daemon on 127.0.0.1:P (a port the daemon's loopback-only check allowed).
async function bindScenario(t, project, withOther) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const v6 = await listen(t, '::1', 0, json({ projectPath: project }));
        if (v6.error) { if (NO_V6.has(v6.error.code)) { t.skip('no IPv6 loopback'); return undefined; } throw v6.error; }
        if (!withOther) return { v6 };
        const v4 = await listen(t, '127.0.0.1', v6.port, json({ projectPath: '/other/project' }));
        if (!v4.error) return { v6, v4 };
        if (v4.error.code !== 'EADDRINUSE') throw v4.error;
    }
    throw new Error('no port free on both ::1 and 127.0.0.1');
}

function nothingServed() {
    return new Promise(resolve => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// The refusal contract: one error naming the host, nothing spawned, daemon.json untouched, no retry.
async function assertRefused(f, file, text, shown, servers = []) {
    const outcome = await f.client.connect().then(() => undefined, error => error);
    assert.ok(outcome && typeof outcome.message === 'string', 'connect() must reject');
    assert.deepEqual(f.spawns, []);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'daemon.json must be byte-identical');
    assert.equal(f.warnings.length + f.errors.length, 1, 'exactly one message');
    assert.equal(f.errors.length, 1);
    assert.equal(outcome.message, f.errors[0]);
    assert.ok(f.errors[0].includes(shown), `message must name ${shown}: ${f.errors[0]}`);
    assert.equal(f.client.manualDisconnect, true);
    f.client.scheduleReconnect();
    assert.equal(f.client.reconnectTimeout, undefined, 'a refusal is not retried');
    assert.equal(f.client.connectionState, 'disconnected');
    assert.equal(f.client.connectInProgress, false);
    for (const server of servers) assert.deepEqual(server.seen, { health: 0, ws: 0 }, 'the server must see no request');
}

async function refusedRow(t, bindHost, scenario) {
    const { project, file } = metadata(t);
    const servers = scenario ? await bindScenario(t, project, scenario === 'collision') : {};
    if (scenario && !servers) return undefined;
    const port = servers.v6 ? servers.v6.port : await nothingServed();
    const text = JSON.stringify(record(project, port, bindHost));
    fs.writeFileSync(file, text);
    const f = fixture({}, project);
    t.after(() => f.client.disconnect());
    return { f, file, text, servers: [servers.v6, servers.v4].filter(Boolean) };
}

test('B1 same-project ::1 daemon, nothing on 127.0.0.1: refused before any spawn', async t => {
    const row = await refusedRow(t, '::1', 'v6');
    if (!row) return;
    await assertRefused(row.f, row.file, row.text, '::1', row.servers);
});

test('B2 same-project ::1 daemon while another project answers on 127.0.0.1:P: no probe, no removal', async t => {
    const row = await refusedRow(t, '::1', 'collision');
    if (!row) return;
    assert.equal(row.servers.length, 2);
    await assertRefused(row.f, row.file, row.text, '::1', row.servers);
});

test('B3 LAN literal bindHost is refused and named, with nothing dialed', async t => {
    const row = await refusedRow(t, '192.0.2.10');
    await assertRefused(row.f, row.file, row.text, '192.0.2.10');
});

test('B4 repository link markup in bindHost still refuses but is never shown', async t => {
    const hostile = '[x](command:workbench.action.reloadWindow)';
    const row = await refusedRow(t, hostile);
    await assertRefused(row.f, row.file, row.text, 'an address other than 127.0.0.1');
    for (const line of [...row.f.errors, ...row.f.warnings, ...row.f.logs]) {
        assert.equal(line.includes(']('), false, line);
        assert.equal(line.includes('command:'), false, line);
        assert.equal(line.includes('reloadWindow'), false, line);
    }
});

test('B5 helper: null for every record that keeps today\'s path', () => {
    const f = fixture();
    const ws = '/home/project';
    const live = { bindHost: '::1', pid: process.pid, projectPath: ws };
    const keeps = (value, workspace = ws, windows = false) => assert.equal(f.offLoopbackBindRefusal(value, workspace, windows), null, JSON.stringify(value));
    for (const bindHost of [undefined, '', '   ', 42, null, '127.0.0.1', '0.0.0.0', '::', 'wsl']) keeps({ ...live, bindHost });
    // 2**31 and 1e300 are integers process.kill rejects with a non-ESRCH error, which must not read as alive.
    for (const pid of [2147483646, 0, -1, 1.5, '123', null, undefined, Number.NaN, 2 ** 31, 1e300]) keeps({ ...live, pid });
    keeps({ ...live, projectPath: 42 });
    keeps({ ...live, projectPath: '/home/other' });
    keeps({ ...live, projectPath: 'D:\\x\\y' }, '/mnt/d/x/y', false);
    keeps({ ...live, projectPath: '/mnt/d/x/y' }, 'D:\\x\\y', true);
    for (const value of [null, undefined, [], 'text', 7]) keeps(value);
});

test('B5 helper: a message naming the host for a live same-project off-loopback record', () => {
    const f = fixture();
    const ws = '/home/project';
    for (const bindHost of ['::1', '192.0.2.10', 'fe80::1%eth0']) {
        for (const projectPath of [ws, '', undefined]) {
            const message = f.offLoopbackBindRefusal({ bindHost, pid: process.pid, projectPath }, ws, false);
            assert.equal(typeof message, 'string');
            assert.ok(message.includes(bindHost), message);
            assert.ok(message.includes(String(process.pid)), message);
            assert.equal(message.includes(ws), false, 'projectPath is never shown');
        }
    }
    const unsafe = f.offLoopbackBindRefusal({ bindHost: 'a b', pid: process.pid }, ws, false);
    assert.equal(typeof unsafe, 'string');
    assert.equal(unsafe.includes('a b'), false);
    assert.ok(unsafe.includes('an address other than 127.0.0.1'), unsafe);
});

test('B5 helper: a live pid owned by another user (EPERM) still counts as alive', { skip: process.platform === 'win32' }, () => {
    const message = fixture().offLoopbackBindRefusal({ bindHost: '::1', pid: 1 }, '/home/project', false);
    assert.equal(typeof message, 'string');
});

test('B5 helper: isOtherSideOfWsl follows the JetBrains rules', () => {
    const f = fixture();
    for (const [projectPath, windows, expected] of [
        ['D:\\x\\y', false, true], ['d:/x/y', false, true], ['\\\\srv\\share', false, true], ['//srv/share', false, true],
        ['/home/a', false, false], ['/mnt/d/x', false, false], ['//', false, false],
        ['/mnt/d/x/y', true, true], ['/home/a', true, true], ['//srv/share', true, false], ['\\\\srv\\share', true, false],
        ['D:\\x\\y', true, false], ['', true, false], ['', false, false]
    ]) assert.equal(f.isOtherSideOfWsl(projectPath, windows), expected, `${projectPath} windows=${windows}`);
});

// B6: today's path is kept for each of these: no refusal message, and the same spawns and connection as before.
test('B6 a configured port keeps today\'s path even when daemon.json names a live ::1 daemon', async t => {
    const { project, file } = metadata(t);
    const configured = await listen(t, '127.0.0.1', 0, json({ projectPath: project }));
    const text = JSON.stringify(record(project, 1, '::1'));
    fs.writeFileSync(file, text);
    const f = fixture({ configPort: configured.port }, project);
    t.after(() => f.client.disconnect());
    await f.client.connect();
    assert.deepEqual(f.spawns, []);
    assert.deepEqual([f.errors, f.warnings], [[], []]);
    assert.equal(configured.seen.ws, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('B6 a configured host keeps today\'s path', async t => {
    const { project, file } = metadata(t);
    const v6 = await bindScenario(t, project, false);
    if (!v6) return;
    fs.writeFileSync(file, JSON.stringify(record(project, v6.v6.port, '::1')));
    const f = fixture({ configHost: '[::1]' }, project);
    t.after(() => f.client.disconnect());
    await f.client.connect();
    assert.deepEqual([f.errors, f.warnings], [[], []]);
    assert.equal(v6.v6.seen.ws, 1);
});

test('B6 a missing daemon.json starts the daemon once, as before', async t => {
    const { project } = metadata(t);
    const f = fixture({}, project);
    t.after(() => f.client.disconnect());
    await f.client.connect().then(() => undefined, () => undefined);
    assert.equal(f.spawns.length, 1);
    assert.deepEqual(Array.from(f.spawns[0][1]), ['bundled-daemon.js', 'start', '--project', project]);
    assert.deepEqual(f.errors, []);
    assert.equal(f.client.manualDisconnect, false);
});

for (const kind of ['unparseable', 'oversized']) {
    test(`B6 an ${kind} daemon.json keeps today's path`, async t => {
        const { project, file } = metadata(t);
        const text = kind === 'unparseable' ? '{ "bindHost": "::1", ' : JSON.stringify(record(project, 1, '::1', { pad: ' '.repeat(65537) }));
        fs.writeFileSync(file, text);
        const f = fixture({}, project);
        t.after(() => f.client.disconnect());
        await f.client.connect().then(() => undefined, () => undefined);
        assert.equal(f.spawns.length, 1, 'the existing startup path still runs');
        assert.deepEqual(f.errors, []);
        assert.equal(f.client.manualDisconnect, false);
    });
}

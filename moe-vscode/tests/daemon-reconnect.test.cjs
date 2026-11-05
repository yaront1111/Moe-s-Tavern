'use strict';

// How the client finds its daemon again. DAEMON_SHUTTING_DOWN (sent on every shutdown, crashes included) starts a wait for
// the supervised restart: a bounded backoff (5 s, 10 s, 20 s, then 30 s) that re-reads daemon.json on every attempt and
// never starts a daemon, removes its metadata or warns about a foreign one (R1-R3). A first connect that finds no daemon
// is retried like a dropped socket (R4, audit V3), within the same budget (R5); a daemon that shut down and stays down
// spends that budget too, then gets a warning rather than a failure (R5b). Moe: Reconnect waits out an attempt still
// in flight and reports a connection only when it has one (R6, audit V8). The fixture is daemon-identity.test.cjs's (tests
// share no helper module), with a fake setTimeout that holds the reconnect timer until a test fires it, and sees its delay.
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

/** A client for `project`; its reconnect timers wait in `timers` until a test fires them. */
function fixture(project, settings = {}) {
    const logs = [], warnings = [], errors = [], spawns = [], timers = [];
    const config = { autoConnect: true, 'daemon.autoStart': false, ...settings };
    const module = { exports: {} };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: project } }],
            getConfiguration: () => ({ get: (key, fallback) => key in config ? config[key] : fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
            showWarningMessage: message => { warnings.push(message); return Promise.resolve(); },
            showErrorMessage: (...args) => { errors.push(args); return Promise.resolve(); }
        }
    };
    // The reconnect timer is the only one whose callback calls openConnection(); every other timer runs for real.
    const hold = (fn, ms, ...args) => {
        if (!String(fn).includes('openConnection')) return setTimeout(fn, ms, ...args);
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return timer;
    };
    const cancel = handle => { if (timers.includes(handle)) handle.cancelled = true; else clearTimeout(handle); };
    vm.runInNewContext(compiled, {
        module, exports: module.exports, process, Buffer, console,
        setTimeout: hold, clearTimeout: cancel, setInterval, clearInterval,
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
    return { client, logs, warnings, errors, spawns, timers };
}

/** A daemon stand-in serving `projectPath` on /health and accepting /ws (`verifyClient` may hold the handshake). */
async function daemon(t, projectPath, verifyClient) {
    const httpServer = http.createServer((_, res) => res.end(JSON.stringify({ projectPath })));
    const wss = new WebSocketServer({ server: httpServer, ...(verifyClient && { verifyClient }) });
    const sockets = [], connections = new Set();
    wss.on('connection', ws => sockets.push(ws));
    // Every TCP connection, upgraded ones included: a handshake the client abandoned while it was held stays half-open.
    httpServer.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    let closed;
    const close = () => closed ??= (async () => {
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        for (const socket of connections) socket.destroy();
        await new Promise(resolve => httpServer.close(resolve));
    })();
    t.after(close);
    return { port: httpServer.address().port, sockets, close };
}

function project(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-reconnect-'));
    fs.mkdirSync(path.join(dir, '.moe'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, file: path.join(dir, '.moe', 'daemon.json') };
}

/** Point daemon.json at `port`, as a (re)started daemon does; returns the text written. */
function point(p, port) {
    const text = JSON.stringify({ pid: process.pid, port, projectPath: p.dir, startedAt: new Date().toISOString() });
    fs.writeFileSync(p.file, text);
    return text;
}

async function until(predicate, label) {
    const deadline = Date.now() + 20000; // a refused localhost connect takes about 2 s on Windows
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), label);
}

/** Fire the newest held reconnect; wait until it queued the next one, or until the client is connected. */
async function fire(f, outcome = 'queued') {
    const timer = f.timers.at(-1), count = f.timers.length;
    assert.equal(timer.cancelled, false, 'the reconnect to fire was cancelled');
    timer.fn();
    if (outcome === 'connected') await until(() => f.client.connectionState === 'connected', 'the reconnect connected');
    else await until(() => f.timers.length === count + 1, 'the failed attempt queued the next reconnect');
}

/** Connect to `server`, then have it announce its shutdown; returns once the wait for its restart has begun. */
async function shutDown(f, server) {
    await f.client.connect();
    assert.equal(f.client.connectionState, 'connected');
    server.sockets[0].send(JSON.stringify({ type: 'DAEMON_SHUTTING_DOWN' }));
    await until(() => f.timers.length === 1, 'DAEMON_SHUTTING_DOWN queued a reconnect');
    assert.equal(f.client.connectionState, 'disconnected');
}

test('R1 after DAEMON_SHUTTING_DOWN the client follows daemon.json to the restarted daemon with backoff, starting and removing nothing', async t => {
    const p = project(t);
    const a = await daemon(t, p.dir);
    const crashed = point(p, a.port);
    // daemon.autoStart on: a connect would start a daemon when daemon.json is missing; this wait must not.
    const f = fixture(p.dir, { 'daemon.autoStart': true });
    t.after(() => f.client.dispose());
    await shutDown(f, a);
    await a.close();

    await fire(f); // a crash left daemon.json naming the dead port: refused, left alone, read again next time
    assert.equal(fs.readFileSync(p.file, 'utf8'), crashed);
    fs.rmSync(p.file); // the supervisor is restarting it: no metadata yet
    await fire(f);
    const b = await daemon(t, p.dir);
    const restarted = point(p, b.port); // back, on another port
    await fire(f, 'connected');

    assert.deepEqual(f.timers.map(timer => timer.ms), [5000, 10000, 20000]);
    assert.equal(b.sockets.length, 1);
    assert.deepEqual([f.spawns.length, f.warnings, f.errors], [0, [], []]);
    assert.equal(fs.readFileSync(p.file, 'utf8'), restarted);
    assert.equal(f.client.awaitingDaemonRestart, false, 'an open socket ends the wait');
});

test('R2 while it waits, a daemon.json naming a daemon that serves another project is passed over without a word', async t => {
    const p = project(t);
    const a = await daemon(t, p.dir);
    point(p, a.port);
    const f = fixture(p.dir, { 'daemon.autoStart': true });
    t.after(() => f.client.dispose());
    await shutDown(f, a);
    await a.close();

    const foreign = await daemon(t, '/foreign/project');
    const text = point(p, foreign.port);
    await fire(f);
    assert.deepEqual([foreign.sockets.length, f.spawns.length, f.warnings, f.errors], [0, 0, [], []]);
    assert.equal(fs.readFileSync(p.file, 'utf8'), text, 'its daemon.json is left alone');
    assert.ok(f.logs.some(line => line.includes('/foreign/project')), 'the log says why it did not connect');

    const b = await daemon(t, p.dir);
    point(p, b.port);
    await fire(f, 'connected');
    assert.equal(b.sockets.length, 1);
});

for (const how of ['disconnect', 'dispose']) {
    test(`R3 ${how} during the wait cancels the queued reconnect and queues none`, async t => {
        const p = project(t);
        const a = await daemon(t, p.dir);
        point(p, a.port);
        const f = fixture(p.dir);
        t.after(() => f.client.dispose());
        await shutDown(f, a);
        if (how === 'dispose') f.client.dispose(); else f.client.disconnect();
        await a.close();
        assert.deepEqual(f.timers.map(timer => timer.cancelled), [true]);
        assert.equal(f.client.connectionState, 'disconnected');
    });
}

test('R4 a first connect that finds no daemon is retried while moe.autoConnect is on (audit V3)', async t => {
    const p = project(t);
    const f = fixture(p.dir);
    t.after(() => f.client.dispose());
    await assert.rejects(f.client.connect(), /Daemon not running/);
    assert.deepEqual(f.timers.map(timer => timer.ms), [5000]);
    const s = await daemon(t, p.dir); // started later, by moe-agent.sh for one
    point(p, s.port);
    await fire(f, 'connected');
    assert.equal(s.sockets.length, 1);

    const off = fixture(project(t).dir, { autoConnect: false });
    t.after(() => off.client.dispose());
    await assert.rejects(off.client.connect(), /Daemon not running/);
    assert.deepEqual(off.timers, [], 'moe.autoConnect off: no retry');
});

test('R5 retries back off 5 s, 10 s, 20 s, then 30 s, and the eleventh failure asks once', async t => {
    const p = project(t);
    const f = fixture(p.dir);
    t.after(() => f.client.dispose());
    await assert.rejects(f.client.connect(), /Daemon not running/);
    while (f.timers.length < 10) await fire(f);
    assert.deepEqual(f.errors, []);
    f.timers.at(-1).fn();
    await until(() => f.errors.length > 0, 'the spent budget asks the user');
    await new Promise(resolve => setTimeout(resolve, 50)); // the failed attempt's own catch has run too
    assert.deepEqual(f.timers.map(timer => timer.ms), [5000, 10000, 20000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
    assert.deepEqual(f.errors, [['Moe daemon connection failed after 10 retries.', 'Reconnect']], 'asked once');
});

test('R5b a daemon that shut down and stays down spends the same budget, then says so once as a warning, not a failure', async t => {
    const p = project(t);
    const a = await daemon(t, p.dir);
    point(p, a.port);
    const f = fixture(p.dir, { 'daemon.autoStart': true });
    t.after(() => f.client.dispose());
    await shutDown(f, a);
    await a.close(); // stopped on purpose: nothing restarts it
    while (f.timers.length < 10) await fire(f);
    f.timers.at(-1).fn();
    await until(() => f.warnings.length > 0, 'the spent budget tells the user');
    await new Promise(resolve => setTimeout(resolve, 50)); // the failed attempt's own catch has run too
    assert.deepEqual(f.timers.map(timer => timer.ms), [5000, 10000, 20000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
    assert.deepEqual([f.warnings, f.errors, f.spawns.length], [['The Moe daemon shut down and did not come back.'], [], 0]);
});

test('R6 Moe: Reconnect during a handshake waits the attempt out and reports a connection only once it has one (audit V8)', async t => {
    const p = project(t);
    const held = [];
    const s = await daemon(t, p.dir, (_info, done) => held.push(done));
    point(p, s.port);
    const f = fixture(p.dir);
    t.after(() => f.client.dispose());
    const first = f.client.connect().then(() => 'resolved', error => error.message);
    await until(() => held.length === 1, 'the first handshake is held');
    assert.equal(f.client.connectionState, 'connecting');

    let answer;
    const reconnected = f.client.reconnect().then(value => { answer = value; });
    assert.equal(await first, 'WebSocket closed before connection opened');
    await until(() => held.length === 2, 'reconnect() opened its own handshake');
    assert.equal(answer, undefined, 'no answer while its handshake is held');
    held[1](true);
    await reconnected;
    assert.equal(answer, true);
    assert.equal(f.client.connectionState, 'connected');
    assert.equal(s.sockets.length, 1);
    assert.deepEqual(f.timers, [], 'nothing left to retry');
});

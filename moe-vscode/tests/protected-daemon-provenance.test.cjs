const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/MoeDaemonClient.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const ENV = 'MOE_SPAWN_PROOF_KEY', HEX = /^[0-9a-f]{64}$/;
const key = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const proof = (k, challenge) => crypto.createHmac('sha256', Buffer.from(k, 'hex')).update(challenge, 'ascii').digest('hex');
const refusal = pid => `Protected execution profile: the running Moe daemon${pid ? ` (pid ${pid})` : ''} was not started by this VS Code from the installed Moe runtime. Stop it, then reconnect.`;
const plain = value => JSON.parse(JSON.stringify(value));
const write = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

function fixture(t, legacy = false) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-provenance-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project'), extension = path.join(root, 'extension');
    const daemon = write(path.join(extension, 'bundled', 'daemon', 'index.js'));
    const node = write(path.join(root, 'node-bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    write(path.join(project, '.moe', 'project.json'), JSON.stringify({ settings: { executionProfile: legacy ? 'legacy' : 'verified-local' } }));
    const f = { project, extension, daemon, node, store: path.join(root, 'state'), spawns: [], sockets: [], errors: [], warnings: [], logs: [],
        alive: new Set([4242]), env: { HOME: root, MOE_NODE_COMMAND: node }, config: {}, stopCode: 0, probes: [] };
    f.metadata = path.join(project, '.moe', 'daemon.json');
    f.info = pid => write(f.metadata, JSON.stringify({ pid, port: 9876, projectPath: project }));
    f.info(4242);
    f.record = () => ({ version: 1, project: f.api.projectStateKey(project), key, daemon: f.api.projectStateKey(daemon) });
    f.recordPath = () => path.join(f.store, f.api.protectedStateName('spawn', f.api.projectStateKey(project)));
    f.save = record => assert.equal(f.api.writeProtectedState(path.basename(f.recordPath()), typeof record === 'string' ? record : JSON.stringify(record), project), true);
    f.load = () => loadClient(t, f);
    f.load();
    return f;
}

function loadClient(t, f) {
    const vscode = { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: f.project } }], getConfiguration: () => ({ get: (k, v) => f.config[k] ?? v }) },
        window: { createOutputChannel: () => ({ appendLine: line => f.logs.push(line) }), showErrorMessage: m => f.errors.push(m),
            showWarningMessage: (...args) => { f.warnings.push(args); return f.choice; } } };
    class StubWebSocket extends EventEmitter {
        constructor(url) { super(); f.sockets.push(url); setImmediate(() => this.emit('open')); }
        close() {} terminate() {} send() {}
    }
    const spawn = (...args) => {
        f.spawns.push(args);
        const child = new EventEmitter(); child.unref = () => {}; child.kill = () => { f.killed = true; };
        setImmediate(() => {
            if (!args[1].includes('stop')) { f.daemonKey = args[2].env[ENV]; f.info(4243); child.emit('spawn'); return; }
            if (f.stopHang) return;
            if (f.stopError) { child.emit('error', Object.assign(new Error('missing stop'), { code: 'ENOENT' })); return; }
            if (f.stopCode === 0 && !f.keepAlive) { f.alive.clear(); fs.rmSync(f.metadata, { force: true }); }
            f.afterStop?.(); child.emit('exit', f.stopCode);
        });
        return child;
    };
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, process: { ...process, env: f.env, kill: (...args) => f.kill(...args) }, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'ws' ? StubWebSocket : name === 'child_process' ? { spawn } : require(name) });
    f.api = module.exports; f.api.useProtectedStateRoot(f.store);
    const client = f.client = new f.api.MoeDaemonClient(f.extension);
    t.after(() => client.dispose());
    client.waitForDaemonInfo = client.ensureDaemonRunning = async () => {};
    client.getVerifiedDaemonInfo = () => client.getDaemonInfo(false);
    client.handleSocketOpen = () => {};
    client.probeSpawnProof = async (_info, _project, challenge) => { f.probes.push(challenge); return f.daemonKey ? proof(f.daemonKey, challenge) : undefined; };
    client.isPidAlive = pid => f.alive.has(pid);
    client.replaceStopTimeoutMs = client.replaceExitTimeoutMs = 25; client.replacePollMs = 2;
    return client;
}

async function admit(f) {
    assert.equal(typeof f.client.protectedAdmissionRefusal, 'function');
    return f.client.protectedAdmissionRefusal(await f.client.getDaemonInfo(false), f.project);
}
async function refusedConnect(f, pid = 4242) {
    await assert.rejects(f.client.connect(), { message: refusal(pid) });
    assert.deepEqual(f.errors, [refusal(pid)]); assert.deepEqual(f.sockets, []);
}

test('(1) verified in session: fresh key, exact owner-only record and no secret logging', async t => {
    const f = fixture(t); f.env[ENV] = 'inherited';
    await Promise.all([f.client.startDaemon('start', f.project), f.client.startDaemon('start', f.project)]);
    assert.match(f.spawns[0][2].env[ENV], HEX); assert.equal(f.spawns.length, 1);
    assert.equal(f.env[ENV], 'inherited'); assert.equal(f.api.SPAWN_PROOF_ENV, ENV);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath())), { ...f.record(), key: f.daemonKey });
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.recordPath()).mode & 0o777, 0o600);
    assert.equal(await admit(f), null); await f.client.connect(); assert.equal(f.sockets.length, 1);
    assert.equal(f.logs.join().includes(f.daemonKey), false);
    assert.equal(new Set(f.probes).size, f.probes.length); f.probes.forEach(c => assert.match(c, HEX));
});
test('(2) verified after a restart uses the persisted record', async t => {
    const f = fixture(t); await f.client.startDaemon('start', f.project); f.load();
    assert.equal(await admit(f), null);
});
test('(3) unverified, no record: fixed refusal, no socket or stop', async t => {
    const f = fixture(t); await refusedConnect(f); assert.deepEqual(f.spawns, []); assert.deepEqual(f.probes, []);
});
for (const invalid of ['mismatched proof', 'installed path', 'JSON', 'extra field', 'version', 'project', 'key', 'oversize']) {
    test(`(4) stale or untrusted record: ${invalid}`, async t => {
        const f = fixture(t), record = f.record(); f.daemonKey = key;
        if (invalid === 'mismatched proof') f.daemonKey = 'ff'.repeat(32);
        if (invalid === 'installed path') record.daemon += '-old';
        if (invalid === 'extra field') record.extra = true;
        if (invalid === 'version') record.version = 2;
        if (invalid === 'project') record.project += '-other';
        if (invalid === 'key') record.key = 'secret-not-hex';
        f.save(invalid === 'JSON' ? '{secret-not-json' : record);
        if (invalid === 'oversize') fs.writeFileSync(f.recordPath(), 'x'.repeat(65537));
        await refusedConnect(f);
        if (invalid !== 'mismatched proof') assert.deepEqual(f.probes, []);
        assert.equal(f.logs.join().includes(record.key), false); assert.equal(f.logs.join().includes('secret-not-json'), false);
    });
}
for (const kind of ['mode', 'symlink']) test(`(4) untrusted POSIX ${kind}`, { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t); f.save(f.record()); f.daemonKey = key;
    if (kind === 'mode') fs.chmodSync(f.recordPath(), 0o644);
    else { fs.renameSync(f.recordPath(), f.recordPath() + '.target'); fs.symlinkSync(f.recordPath() + '.target', f.recordPath()); }
    await refusedConnect(f); assert.deepEqual(f.probes, []);
});
test('(5) HMAC uses decoded key bytes and ASCII challenge: daemon known-answer vector', async t => {
    const f = fixture(t); assert.equal(typeof f.api.spawnProofHmac, 'function');
    assert.equal(await f.api.spawnProofHmac(key, 'ab'.repeat(32)), '583630234f7e60ecfa2a6ae2e98ee37876e3ff6344457723cb4b42fcf77f7fc0');
});
test('(6) declined modal has only an explicit Stop and Replace action', async t => {
    const f = fixture(t); await refusedConnect(f);
    assert.equal(f.warnings.length, 1);
    const [message, options, ...actions] = f.warnings[0];
    assert.equal(message, refusal(4242)); assert.equal(options.modal, true); assert.match(options.detail, /installed Moe CLI/);
    assert.deepEqual(actions, ['Stop and Replace']); assert.deepEqual(f.spawns, []);
});
test('(7) replace succeeds: installed stop without key, fresh spawn and re-admission', async t => {
    const f = fixture(t); f.save(f.record()); f.daemonKey = 'ff'.repeat(32); f.env[ENV] = key; f.choice = 'Stop and Replace';
    await f.client.connect(); assert.equal(f.spawns.length, 2);
    const [stop, start] = f.spawns;
    assert.deepEqual(plain(stop), [f.node, [f.daemon, 'stop', '--project', f.project], {
        cwd: path.dirname(f.daemon), env: { HOME: f.env.HOME, MOE_NODE_COMMAND: f.node, PATH: path.dirname(f.node) }, stdio: 'ignore', windowsHide: true
    }]);
    assert.match(start[2].env[ENV], HEX); assert.notEqual(start[2].env[ENV], key); assert.notEqual(start[2].env[ENV], 'ff'.repeat(32));
    assert.equal(JSON.parse(fs.readFileSync(f.recordPath())).key, start[2].env[ENV]);
    assert.equal(f.sockets.length, 1); assert.deepEqual(f.errors, []);
});
for (const mode of ['nonzero', 'hang', 'ENOENT', 'alive', 'new pid', 'unreadable', 'oversize']) {
    test(`(8) replace fails closed: ${mode}`, async t => {
        const f = fixture(t); f.choice = 'Stop and Replace';
        if (mode === 'nonzero') f.stopCode = 1;
        if (mode === 'hang') f.stopHang = true;
        if (mode === 'ENOENT') f.stopError = true;
        if (mode === 'alive') f.keepAlive = true;
        f.afterStop = () => {
            if (mode === 'new pid') { f.alive.add(4244); f.info(4244); }
            if (mode === 'unreadable') fs.mkdirSync(f.metadata);
            if (mode === 'oversize') write(f.metadata, 'x'.repeat(65537));
        };
        await refusedConnect(f); assert.equal(f.spawns.length, 1); assert.equal(f.spawns[0][1][1], 'stop');
        assert.equal(!!f.killed, mode === 'hang');
    });
}
test('(9) LEGACY has no key, spawn record or proof probe', async t => {
    const f = fixture(t, true); await f.client.startDaemon('start', f.project); await f.client.connect();
    assert.equal(f.spawns[0][2].env[ENV], undefined); assert.equal(fs.existsSync(f.recordPath()), false);
    assert.deepEqual(f.probes, []); assert.equal(f.sockets.length, 1); assert.deepEqual(f.warnings, []);
});
test('(10) configured workspace endpoint is refused without a replace offer', async t => {
    const f = fixture(t); f.config = { 'daemon.port': 2345, 'daemon.host': 'remote.invalid' };
    await refusedConnect(f, null); assert.deepEqual(f.warnings, []); assert.deepEqual(f.spawns, []);
});
test('(11) inside-project store is session-only; a planted record cannot admit after restart', async t => {
    const f = fixture(t); f.store = path.join(f.project, 'state'); f.api.useProtectedStateRoot(f.store);
    await f.client.startDaemon('start', f.project); assert.equal(fs.existsSync(f.store), false); assert.equal(await admit(f), null);
    fs.mkdirSync(f.store, { mode: 0o700 }); fs.writeFileSync(f.recordPath(), JSON.stringify({ ...f.record(), key: f.daemonKey }), { mode: 0o600 });
    f.load(); assert.equal(await admit(f), refusal(4243)); assert.deepEqual(f.sockets, []);
});
test('two windows: newer stored record remains a fallback to an older session record', async t => {
    const f = fixture(t); await f.client.startDaemon('start', f.project); const first = f.client;
    f.load(); await f.client.startDaemon('start', f.project); f.client = first;
    assert.equal(await admit(f), null);
});
for (const stage of ['proof', 'modal', 'stop']) test(`cancel during ${stage} never opens a socket or starts a replacement`, async t => {
    const f = fixture(t); f.choice = 'Stop and Replace';
    if (stage === 'proof') { f.save(f.record()); f.client.probeSpawnProof = async () => { f.client.disconnect(); return proof(key, 'ab'.repeat(32)); }; }
    if (stage === 'modal') f.choice = { then(resolve) { f.client.disconnect(); resolve('Stop and Replace'); } };
    if (stage === 'stop') f.afterStop = () => f.client.disconnect();
    await Promise.all([f.client.connect(), f.client.connect()]);
    assert.deepEqual(f.sockets, []); assert.deepEqual(f.errors, []); assert.equal(f.spawns.length, stage === 'stop' ? 1 : 0);
});
for (const value of [undefined, 'bad', 'ff'.repeat(32), new Error('probe timeout')]) test(`invalid proof ${String(value)} refuses`, async t => {
    const f = fixture(t); f.save(f.record()); f.client.probeSpawnProof = async () => { if (value instanceof Error) throw value; return value; };
    await refusedConnect(f);
});
test('challenge HTTP probe retains only a string proof and legacy results stay identical', async t => {
    const f = fixture(t), requests = []; let responseProof = 'ff'.repeat(32), served = f.project;
    const server = http.createServer((req, res) => { requests.push(req.url); res.end(JSON.stringify({ projectPath: served, spawnProof: responseProof })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const probe = options => f.api.probeDaemonIdentity('127.0.0.1', server.address().port, f.project, options);
    const challenge = 'ab'.repeat(32);
    assert.deepEqual(plain(await probe()), { kind: 'same' });
    assert.deepEqual(plain(await probe({ challenge })), { kind: 'same', spawnProof: responseProof });
    assert.deepEqual(requests, ['/health', `/health?challenge=${challenge}`]);
    responseProof = 7; assert.deepEqual(plain(await probe({ challenge })), { kind: 'same' });
    served = path.dirname(f.project);
    const actualProbe = Object.getPrototypeOf(f.client).probeSpawnProof;
    assert.equal(typeof actualProbe, 'function');
    assert.equal(await actualProbe.call(f.client, { host: '127.0.0.1', port: server.address().port }, f.project, challenge), undefined);
});
test('metadata clearance requires absence or a readable regular record naming a dead pid', t => {
    const f = fixture(t), cleared = () => f.client.replacementMetadataCleared(f.project);
    assert.equal(typeof f.client.replacementMetadataCleared, 'function'); assert.equal(cleared(), false);
    f.alive.clear(); assert.equal(cleared(), true);
    for (const text of ['{', 'null', '{"pid":0}', '{"pid":"4242"}']) { write(f.metadata, text); assert.equal(cleared(), false); }
    fs.rmSync(f.metadata); assert.equal(cleared(), true);
    if (process.platform !== 'win32') { fs.symlinkSync(f.metadata + '.absent', f.metadata); assert.equal(cleared(), false); }
});
test('liveness only treats ESRCH as dead and never sends a stopping signal', t => {
    const f = fixture(t), alive = Object.getPrototypeOf(f.client).isPidAlive;
    assert.equal(typeof alive, 'function');
    for (const code of [undefined, 'ESRCH', 'EPERM', 'EINVAL']) {
        f.kill = (pid, signal) => { assert.equal(pid, 4242); assert.equal(signal, 0); if (code) throw { code }; };
        assert.equal(alive.call(f.client, 4242), code !== 'ESRCH');
    }
});
test('a workspace removed after identity probing cannot bypass protected admission', async t => {
    const f = fixture(t); f.client.getWorkspacePath = () => undefined;
    await assert.rejects(f.client.connect()); assert.deepEqual(f.sockets, []);
});
test('replacement must verify the fresh daemon rather than trusting its spawn', async t => {
    const f = fixture(t); f.choice = 'Stop and Replace'; f.client.probeSpawnProof = async () => undefined;
    await refusedConnect(f); assert.equal(f.spawns.length, 2);
});
for (const pid of [undefined, 0, -1, '4242']) test(`no replacement offer for invalid pid ${pid}`, async t => {
    const f = fixture(t); f.info(pid); f.choice = 'Stop and Replace';
    await assert.rejects(f.client.connect()); assert.deepEqual(f.sockets, []); assert.deepEqual(f.spawns, []); assert.deepEqual(f.warnings, []);
});
test('HTTP proof timeout refuses instead of adopting an unresponsive peer', async t => {
    const f = fixture(t), server = http.createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    assert.deepEqual(plain(await f.api.probeDaemonIdentity('127.0.0.1', server.address().port, f.project,
        { challenge: 'ab'.repeat(32), timeoutMs: 10 })), { kind: 'unknown' });
});

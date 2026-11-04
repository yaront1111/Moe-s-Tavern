'use strict';

// task-d4c4a758: the Managed VMs view must run vm-control.mjs as JetBrains ManagedVmPanel.execute does. Under the protected
// profile (verified-local, a session pin or a fail-closed project.json) that is the installed-and-validated node with the
// extension-host env minus NODE_OPTIONS/NODE_PATH and a PATH filtered by protectedPathEntries (nothing added, nothing deduped,
// every other variable kept, MOE_RUNNER_STATE_DIR included). Legacy and observe keep the old call: no env key at all.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const SRC = path.join(__dirname, '../src');
const real = fs.realpathSync.native;
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };
const compile = relative => ts.transpileModule(fs.readFileSync(path.join(SRC, relative), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const CODE = { client: compile('services/MoeDaemonClient.ts'), vm: compile('util/ManagedVm.ts'), provider: compile('providers/ManagedVmTreeProvider.ts') };
/** Same realm as the test (not vm.runInNewContext), so deepStrictEqual sees plain Object prototypes and keeps the AbortSignal. */
function load(code, filename, requireImpl, processImpl) {
    const module = { exports: {} };
    vm.runInThisContext(`(function (exports, module, require, process) {${code}\n})`, { filename })(module.exports, module, requireImpl, processImpl);
    return module.exports;
}
const REPORT = `${JSON.stringify({ schema: 'moe-vm-status-v1', provider: { ready: true }, executionReady: false, verified: false, instances: [], invalid: 0 })}\n`;
const TIMEOUT = 120000, MAX_BUFFER = 65537;

/** `profile` undefined writes no project.json. Fresh module instances per fixture, so the session pin cannot leak between tests. */
function fixture(t, profile) {
    const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-d4c4-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const [project, extension, home, outside, state] = ['project', 'extension', 'home', 'outside', 'state'].map(p => path.join(root, p));
    for (const dir of [project, extension, home, outside, state]) { fs.mkdirSync(dir); }
    if (profile !== undefined) { fs.writeFileSync(write(path.join(project, '.moe', 'project.json')), JSON.stringify({ settings: { executionProfile: profile } })); }
    const script = write(path.join(extension, 'bundled', 'scripts', 'local-runner', 'vm-control.mjs'));
    const node = write(path.join(root, 'node-bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    const env = { HOME: home, MOE_NODE_COMMAND: node, MOE_RUNNER_STATE_DIR: state, NODE_OPTIONS: '--require=bad', NODE_PATH: project,
        PATH: ['rel/bin', path.join(project, 'bin'), outside].join(path.delimiter) };
    const f = { project, extension, home, outside, state, script, node, env, calls: [], runtimeCalls: 0, logs: [] };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        window: { createOutputChannel: () => ({ appendLine: line => f.logs.push(line) }), showErrorMessage: () => undefined },
        workspace: { workspaceFolders: [{ uri: { fsPath: project } }], getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
    };
    const childProcess = { execFile: (file, args, options, callback) => { f.calls.push({ file, args, options }); setImmediate(() => callback(null, REPORT)); } };
    const proc = { ...process, env };
    const modules = {};
    const requireImpl = name => name === 'vscode' ? vscode : name === 'child_process' ? childProcess
        : name === '../services/MoeDaemonClient' ? modules.client : name === '../util/ManagedVm' ? modules.vm : require(name);
    modules.client = load(CODE.client, path.join(SRC, 'services/MoeDaemonClient.ts'), requireImpl, proc);
    modules.vm = load(CODE.vm, path.join(SRC, 'util/ManagedVm.ts'), name => { throw new Error(`ManagedVm.ts must not require ${name}`); }, proc);
    const providerApi = load(CODE.provider, path.join(SRC, 'providers/ManagedVmTreeProvider.ts'), requireImpl, proc);
    const client = { onStateChanged: () => ({ dispose() {} }), resolveDaemonRuntime: () => { f.runtimeCalls++; return { node: 'legacy-node', env: {} }; } };
    f.api = modules.client;
    f.provider = new providerApi.ManagedVmTreeProvider(extension, client);
    return f;
}

const args = f => [f.script, 'status', '--project', f.project];

for (const profile of ['verified-local', 'bogus']) {
    test(`R1 protected read (${profile}) runs the installed node with the scrubbed env and nothing added`, async t => {
        const f = fixture(t, profile), before = { ...f.env };
        const signal = new AbortController().signal;
        const report = await f.provider.execute('status', signal);
        assert.equal(report.kind, 'status');
        assert.deepEqual(f.calls, [{ file: real(f.node), args: args(f), options: { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true, signal,
            env: { HOME: f.home, MOE_NODE_COMMAND: f.node, MOE_RUNNER_STATE_DIR: f.state, PATH: f.outside } } }]);
        assert.notEqual(f.calls[0].options.env, f.env);
        assert.equal(f.runtimeCalls, 0);
        assert.deepEqual(f.env, before);
    });
}

for (const profile of [undefined, 'legacy', 'observe']) {
    test(`R2 ${profile ?? 'absent project.json'} keeps today's call: resolveDaemonRuntime node and no env key`, async t => {
        const f = fixture(t, profile), before = { ...f.env };
        const signal = new AbortController().signal;
        const report = await f.provider.execute('status', signal);
        assert.equal(report.kind, 'status');
        assert.deepEqual(f.calls, [{ file: 'legacy-node', args: args(f), options: { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true, signal } }]);
        assert.equal(Object.hasOwn(f.calls[0].options, 'env'), false);
        assert.equal(f.runtimeCalls, 1);
        assert.deepEqual(f.env, before);
    });
}

for (const inside of [true, false]) {
    test(`R3 protected read with a refused node (${inside ? 'inside the project' : 'bare name'}) is node-missing: no process, no legacy fallback`, async t => {
        const f = fixture(t, 'verified-local');
        f.env.MOE_NODE_COMMAND = inside ? write(path.join(f.project, 'node')) : 'node';
        const report = await f.provider.execute('status', new AbortController().signal);
        assert.deepEqual(report, { kind: 'unreadable', reason: 'node-missing' });
        assert.deepEqual(f.calls, []);
        assert.equal(f.runtimeCalls, 0);
    });
}

for (const windows of [false, true]) {
    test(`R4 protectedVmControlRuntime: node, scrub only, nothing added or deduplicated (windows=${windows})`, t => {
        const f = fixture(t, 'verified-local');
        assert.equal(typeof f.api.protectedVmControlRuntime, 'function');
        for (const dir of ['node/current/bin', 'npm/bin']) { fs.mkdirSync(path.join(f.home, '.local', 'share', 'moe', dir), { recursive: true }); }
        const base = { HOME: f.home, MOE_NODE_COMMAND: f.node, MOE_RUNNER_STATE_DIR: f.state };
        const env = windows ? { ...base, Path: f.project, PATH: f.env.PATH, node_options: 'bad', Node_Path: 'bad' }
            : { ...base, NODE_OPTIONS: 'bad', NODE_PATH: f.project, PATH: [f.env.PATH, f.outside].join(path.delimiter) };
        const before = { ...env };
        const result = f.api.protectedVmControlRuntime(f.project, env, windows, f.home);
        // windows=false: no dirname(node), no bootstrap dirs, the repeated entry stays. windows=true: one PATH key, every NODE_* spelling gone.
        assert.deepEqual(result, { node: real(f.node), env: { ...base, PATH: windows ? f.outside : [f.outside, f.outside].join(path.delimiter) } });
        assert.deepEqual(env, before);
    });
}

test('R4 helper edge cases: absent PATH, Windows key spelling, POSIX exact names, refused node', t => {
    const f = fixture(t, 'verified-local'), helper = f.api.protectedVmControlRuntime;
    const base = { HOME: f.home, MOE_NODE_COMMAND: f.node, MOE_RUNNER_STATE_DIR: f.state };
    for (const windows of [false, true]) {
        assert.deepEqual(helper(f.project, { ...base, NODE_OPTIONS: 'bad' }, windows, f.home), { node: real(f.node), env: base });
    }
    // Only the first PATH-like key survives on Windows, under its own spelling.
    assert.deepEqual(helper(f.project, { ...base, Path: [f.project, f.outside].join(path.delimiter) }, true, f.home), { node: real(f.node), env: { ...base, Path: f.outside } });
    // POSIX names are case sensitive: only the exact NODE_OPTIONS and NODE_PATH are scrubbed.
    assert.deepEqual(helper(f.project, { ...base, node_options: 'kept', NODE_OPTIONS: 'bad' }, false, f.home), { node: real(f.node), env: { ...base, node_options: 'kept' } });
    assert.equal(helper(f.project, { ...base, MOE_NODE_COMMAND: write(path.join(f.project, 'node')) }, false, f.home), undefined);
    assert.equal(helper(f.project, { ...base, MOE_NODE_COMMAND: 'node' }, true, f.home), undefined);
});

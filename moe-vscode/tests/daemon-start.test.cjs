const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

function fixture({ env, platform, files = [], directories = [] } = {}) {
    const child = new EventEmitter();
    let unrefs = 0;
    child.unref = () => { unrefs++; };
    const logs = [];
    const errors = [];
    const spawns = [];
    const fakeFiles = new Set(files);
    const fakeDirectories = new Set(directories);
    const simulatedFs = env ? {
        ...fs,
        existsSync: file => fakeFiles.has(file) || fakeDirectories.has(file),
        statSync: file => {
            if (!fakeFiles.has(file) && !fakeDirectories.has(file)) { throw new Error('ENOENT'); }
            return { isFile: () => fakeFiles.has(file), isDirectory: () => fakeDirectories.has(file) };
        },
        accessSync: file => { if (!fakeFiles.has(file)) { throw new Error('EACCES'); } }
    } : fs;
    const module = { exports: {} };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); },
        window: {
            createOutputChannel: () => ({ appendLine: line => logs.push(line) }),
            showErrorMessage: message => { errors.push(message); return Promise.resolve(undefined); }
        }
    };
    const context = vm.createContext({
        exports: module.exports, module, process: env ? { ...process, env, platform } : process,
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode
            : name === 'child_process' ? { spawn: (...args) => { spawns.push(args); return child; } }
            : name === 'fs' ? simulatedFs
            : name === 'path' && platform === 'linux' ? path.posix
            : require(name)
    });
    vm.runInContext(compiled, context, { filename: sourcePath });
    const client = new module.exports.MoeDaemonClient('plugin');
    client.resolveBundledDaemonPath = () => 'bundled-daemon.js';
    let polls = 0;
    client.waitForDaemonInfo = async () => { polls++; };
    return { client, child, logs, errors, spawns, polls: () => polls, unrefs: () => unrefs };
}

test('missing Node reports an actionable error without escaping the startup handler', async () => {
    const f = fixture();
    const startup = f.client.startDaemon('start', 'project');
    const failure = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    let escaped;
    try { f.child.emit('error', failure); } catch (error) { escaped = error; }
    await startup;

    assert.equal(escaped, undefined, 'the child-process error must be handled');
    assert.equal(f.polls(), 0, 'a failed launch must not wait for daemon readiness');
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /Node\.js/);
    assert.match(f.errors[0], /MOE_NODE_COMMAND/);
    assert.equal(f.logs.some(line => line.includes('Started Moe daemon')), false);
});

test('other spawn failures are surfaced without claiming the daemon started', async () => {
    const f = fixture();
    const startup = f.client.startDaemon('start', 'project');
    const failure = Object.assign(new Error('spawn node EACCES'), { code: 'EACCES' });
    let escaped;
    try { f.child.emit('error', failure); } catch (error) { escaped = error; }
    await startup;

    assert.equal(escaped, undefined);
    assert.equal(f.polls(), 0);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /EACCES/);
    assert.equal(f.logs.some(line => line.includes('Started Moe daemon')), false);
});

test('successful spawn waits for daemon readiness and detaches the process', async () => {
    const f = fixture();
    const startup = f.client.startDaemon('start', 'project');
    f.child.emit('spawn');
    await startup;

    assert.equal(f.polls(), 1);
    assert.equal(f.unrefs(), 1);
    assert.deepEqual(f.errors, []);
    assert.equal(f.logs.filter(line => line.includes('Started Moe daemon')).length, 1);
});

test('Linux GUI launch finds installer Node and passes helper command directories to the daemon', async () => {
    const nodeDir = '/home/dev/.local/share/moe/node/current/bin';
    const npmDir = '/home/dev/.local/share/moe/npm/bin';
    const f = fixture({
        env: { HOME: '/home/dev', PATH: '/usr/bin:/bin' }, platform: 'linux',
        files: [`${nodeDir}/node`], directories: [nodeDir, npmDir]
    });
    const startup = f.client.startDaemon('start', 'project');
    f.child.emit('spawn');
    await startup;

    assert.equal(f.spawns[0][0], `${nodeDir}/node`);
    assert.equal(f.spawns[0][2].env.PATH, `${nodeDir}:/usr/bin:/bin:${npmDir}`);
});

test('managed Node takes priority over an obsolete system Node in the GUI PATH', async () => {
    const nodeDir = '/home/dev/.local/share/moe/node/current/bin';
    const npmDir = '/home/dev/.local/share/moe/npm/bin';
    const f = fixture({
        env: { HOME: '/home/dev', PATH: '/old/system/bin:/usr/bin' }, platform: 'linux',
        files: ['/old/system/bin/node', `${nodeDir}/node`], directories: [nodeDir, npmDir]
    });
    const startup = f.client.startDaemon('start', 'project');
    f.child.emit('spawn');
    await startup;

    assert.equal(f.spawns[0][0], `${nodeDir}/node`);
    assert.equal(f.spawns[0][2].env?.PATH, `${nodeDir}:/old/system/bin:/usr/bin:${npmDir}`);
});

test('PATH-selected Node is preserved when no helper-managed Node is installed', async () => {
    const npmDir = '/home/dev/.local/share/moe/npm/bin';
    const f = fixture({
        env: { HOME: '/home/dev', PATH: '/my/node/bin:/usr/bin' }, platform: 'linux',
        files: ['/my/node/bin/node'], directories: [npmDir]
    });
    const startup = f.client.startDaemon('start', 'project');
    f.child.emit('spawn');
    await startup;

    assert.equal(f.spawns[0][0], 'node');
    assert.equal(f.spawns[0][2].env?.PATH, `/my/node/bin:/usr/bin:${npmDir}`);
});

test('explicit Node override is preserved and helper PATH entries are not duplicated', async () => {
    const nodeDir = '/home/dev/.local/share/moe/node/current/bin';
    const npmDir = '/home/dev/.local/share/moe/npm/bin';
    const originalPath = `/usr/bin:${nodeDir}:${npmDir}`;
    const env = { HOME: '/home/dev', PATH: originalPath, MOE_NODE_COMMAND: '/custom/node' };
    const f = fixture({ env, platform: 'linux', files: [`${nodeDir}/node`], directories: [nodeDir, npmDir] });
    const startup = f.client.startDaemon('start', 'project');
    f.child.emit('spawn');
    await startup;

    assert.equal(f.spawns[0][0], '/custom/node');
    assert.equal(f.spawns[0][2].env?.PATH, originalPath);
    assert.equal(env.PATH, originalPath, 'VS Code host environment must remain unchanged');
});

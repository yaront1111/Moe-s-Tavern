const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/MoeDaemonClient.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const real = fs.realpathSync.native;
const plain = value => JSON.parse(JSON.stringify(value));
const refusal = reason => `Protected execution profile: ${reason}. Project and PATH copies of the Moe daemon are not used.`;
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };

function fixture(t, protectedProfile = true, fsApi = fs) {
    const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-rf06b-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const [project, extension, home, outside] = ['project', 'extension', 'home', 'outside'].map(p => path.join(root, p));
    for (const dir of [project, extension, home, outside]) { fs.mkdirSync(dir); }
    if (protectedProfile) {
        fs.writeFileSync(write(path.join(project, '.moe', 'project.json')), '{"settings":{"executionProfile":"verified-local"}}');
    }
    const daemon = write(path.join(extension, 'bundled', 'daemon', 'index.js'));
    const node = write(path.join(root, 'node-bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    const env = { HOME: home, MOE_NODE_COMMAND: node, NODE_OPTIONS: '--require=bad', NODE_PATH: project,
        PATH: ['rel/bin', path.join(project, 'bin'), outside].join(path.delimiter) };
    const [spawns, errors, logs] = [[], [], []];
    const f = { project, extension, home, outside, daemon, node, env, spawns, errors, logs, polls: 0, unrefs: 0 };
    const vscode = {
        EventEmitter: class { event = () => ({ dispose() {} }); },
        window: { createOutputChannel: () => ({ appendLine: line => logs.push(line) }), showErrorMessage: m => errors.push(m) },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
    };
    const spawn = (...args) => {
        spawns.push(args);
        const child = new EventEmitter();
        child.unref = () => { f.unrefs++; };
        setImmediate(() => f.failure ? child.emit('error', f.failure) : child.emit('spawn'));
        return child;
    };
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, process: { ...process, env }, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : name === 'child_process' ? { spawn } : name === 'fs' ? fsApi : require(name) });
    f.api = module.exports;
    f.client = new f.api.MoeDaemonClient(extension);
    f.client.waitForDaemonInfo = async () => { f.polls++; };
    f.client.resolveGlobalConfigDaemonPath = f.client.resolveDaemonRuntime = () => { throw new Error('consulted'); };
    return f;
}

test('D1 protected init uses installed real paths, start, installed cwd and a sanitized environment copy', async t => {
    const f = fixture(t), before = { ...f.env };
    await Promise.all([f.client.startDaemon('init', f.project), f.client.startDaemon('init', f.project)]);
    assert.deepEqual(plain(f.spawns), [[real(f.node), [real(f.daemon), 'start', '--project', f.project], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(real(f.daemon)),
        env: { HOME: f.home, MOE_NODE_COMMAND: f.node, PATH: [path.dirname(real(f.node)), f.outside].join(path.delimiter) }
    }]]);
    assert.deepEqual(f.env, before);
    assert.deepEqual(f.errors, []);
    assert.equal(f.polls, 1); assert.equal(f.unrefs, 1); assert.equal(f.client.startInProgress, false);
});

test('D2 missing installed daemon refuses before any legacy lookup', async t => {
    const f = fixture(t);
    fs.unlinkSync(f.daemon); f.env.MOE_NODE_COMMAND = 'node';
    await f.client.startDaemon('start', f.project);
    assert.deepEqual(f.errors, [refusal('installed daemon/index.js not found')]);
    assert.deepEqual(f.spawns, []);
});

for (const inside of [false, true]) {
    test(`D3 ${inside ? 'project node' : 'bare node'} refuses without falling back`, async t => {
        const f = fixture(t);
        f.env.MOE_NODE_COMMAND = inside ? write(path.join(f.project, 'node')) : 'node';
        await f.client.startDaemon('start', f.project);
        assert.deepEqual(f.spawns, []);
        assert.deepEqual(f.errors, [refusal(`node executable ${inside ? 'resolves inside the project' : 'is not an absolute path'}`)]);
    });
}

test('D4 protected PATH lookup skips relative/project entries and finds the first outside file', async t => {
    const f = fixture(t), name = path.basename(f.node);
    write(path.join(f.project, 'bin', name)); delete f.env.MOE_NODE_COMMAND;
    f.env.PATH = [path.join(f.project, 'bin'), 'relbin', f.outside, path.dirname(f.node)].join(path.delimiter);
    await f.client.startDaemon('start', f.project);
    assert.equal(f.spawns[0]?.[0], real(f.node)); assert.deepEqual(f.errors, []);
});

test('D5 Windows env candidates, explicit override precedence and no candidate refusal', t => {
    const f = fixture(t), api = f.api;
    assert.equal(typeof api.protectedNodeCandidate, 'function');
    const candidate = write(path.join(f.outside, 'nodejs', 'node.exe'));
    assert.equal(api.protectedNodeCandidate({ ProgramFiles: f.outside }, f.home, true, f.project), candidate);
    assert.equal(api.protectedNodeCandidate({ MOE_NODE_COMMAND: ' "node" ', ProgramFiles: f.outside }, f.home, true, f.project), 'node');
    assert.equal(api.protectedNodeCandidate({}, f.home, true, f.project), undefined);
    assert.deepEqual(plain(api.protectedDaemonCommand(f.project, path.join(f.extension, 'bundled'), undefined)),
        { refused: 'node executable not found' });
});

for (const windows of [false, true]) {
    test(`D6 environment filtering, duplicates, bootstrap paths and host preservation (windows=${windows})`, t => {
        const f = fixture(t), api = f.api;
        assert.equal(typeof api.protectedDaemonEnvironment, 'function');
        const bootstrap = path.join(f.home, '.local', 'share', 'moe', 'npm', 'bin'); fs.mkdirSync(bootstrap, { recursive: true });
        const env = windows ? { Path: f.project, PATH: f.env.PATH, node_options: 'bad', Node_Path: 'bad' } : f.env;
        env.PATH += path.delimiter + [f.outside, path.dirname(f.node)].join(path.delimiter);
        const before = { ...env };
        const result = api.protectedDaemonEnvironment(env, f.project, f.node, windows, f.home);
        assert.deepEqual(Object.keys(result).filter(k => k.toUpperCase() === 'PATH'), ['PATH']);
        assert.equal(Object.keys(result).some(k => ['NODE_OPTIONS', 'NODE_PATH'].includes(k.toUpperCase())), false);
        assert.equal(result.PATH, [path.dirname(f.node), f.outside, ...(windows ? [] : [bootstrap])].join(path.delimiter));
        assert.deepEqual(env, before);
    });
}

test('D7 legacy keeps the runtime resolver and exact spawn options', async t => {
    const f = fixture(t, false);
    let calls = 0;
    f.client.resolveDaemonRuntime = () => { calls++; return { node: 'node', env: f.env }; };
    await f.client.startDaemon('start', f.project);
    assert.equal(calls, 1);
    assert.deepEqual(plain(f.spawns), [['node', [f.daemon, 'start', '--project', f.project],
        { detached: true, stdio: 'ignore', windowsHide: true, env: f.env }]]);
    assert.deepEqual(f.errors, []);
});

test('executable selection rejects absent, relative, unresolved and non-file candidates in order', t => {
    const f = fixture(t), api = f.api;
    assert.equal(typeof api.installedExecutable, 'function');
    for (const [candidate, project, reason] of [[undefined, f.project, 'node executable not found'],
        ['node', f.project, 'node executable is not an absolute path'],
        [f.node, path.join(f.project, 'absent'), 'the project directory cannot be resolved'],
        [path.join(f.outside, 'absent'), f.project, 'node executable not found'],
        [f.outside, f.project, 'node executable is not a regular file']]) {
        assert.deepEqual(plain(api.installedExecutable(candidate, project)), { rejected: reason });
    }
    assert.deepEqual(plain(api.installedExecutable(f.node, f.project)), { accepted: real(f.node) });
    const quoted = `rel|"${f.project}"| "${f.outside}" |${f.outside}'|${f.outside}"|'${f.outside}|"${f.outside}`;
    assert.deepEqual([...api.protectedPathEntries(quoted, f.project, '|')], [f.outside]);
    assert.equal(api.isOutsideProject(path.join(f.project, 'absent'), f.project), false);
    assert.equal(api.isOutsideProject(path.join(f.outside, 'absent'), f.project), true);
});

test('Windows paths qualify only drive-qualified or UNC; rooted and drive-relative ones follow the current drive', t => {
    const { isFullyQualified } = fixture(t).api;
    for (const [p, expected] of [['\\x', false], ['/x', false], ['C:x', false], ['\\\\', false], ['C:\\x', true], ['c:/x', true],
        ['\\\\srv\\sh', true], ['//srv/sh', true], ['\\\\?\\C:\\x', true]]) { assert.equal(isFullyQualified(p, true), expected, p); }
    assert.deepEqual([isFullyQualified('/x', false), isFullyQualified('x', false)], [true, false]);
});

test('Windows rooted PATH and node spellings are refused on any host drive', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
    const f = fixture(t), api = f.api, device = `\\\\?\\${f.outside}`;
    // QA repro: host cwd on D:, temp project on C:; rooted spellings resolved against D: and passed.
    const rooted = [f.project, f.outside].flatMap(p => [p.slice(2), p.slice(2).replace(/\\/g, '/')]);
    for (const entry of rooted) { assert.equal(api.isOutsideProject(entry, f.project), false, entry); }
    assert.deepEqual(plain(api.installedExecutable(f.node.slice(2), f.project)), { rejected: 'node executable is not an absolute path' });
    const env = api.protectedDaemonEnvironment({ PATH: [...rooted, f.outside, device].join(';') }, f.project, f.node, true, undefined);
    assert.equal(env.PATH, [path.dirname(f.node), f.outside, device].join(';'));
});

test('Windows alias predicate rejects segment-ending dots/spaces and UNC forms only on Windows', t => {
    const { isWindowsAlias } = fixture(t).api;
    assert.equal(typeof isWindowsAlias, 'function');
    for (const p of ['C:\\p.', 'C:\\p.\\', 'C:\\p.\\bin', 'C:\\p. ', 'C:\\p .', '//?/C:/p.', '//?/C:/p./bin',
        'C:\\PROJEC~1.', '\\\\?\\C:\\p.', 'C:\\p \\bin', '\\\\srv\\sh', '//srv/sh', '\\\\?\\UNC\\srv\\sh', '\\\\localhost\\C$\\x']) {
        assert.equal(isWindowsAlias(p, true), true, p); assert.equal(isWindowsAlias(p, false), false, p);
    }
    for (const p of ['C:\\p', 'C:\\p\\', 'C:\\', 'C:\\Program Files\\nodejs\\', 'C:\\Python3.11\\Scripts', '\\\\?\\C:\\x']) {
        assert.equal(isWindowsAlias(p, true), false, p);
    }
    for (const p of ['/tmp/p.', '/tmp/p./bin', '/tmp/a /b', '//srv/sh']) { assert.equal(isWindowsAlias(p, false), false, p); }
});

test('Windows aliases cannot run project executables through the protected PATH', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
    const f = fixture(t), api = f.api, p = f.project, SystemRoot = process.env.SystemRoot;
    t.after(() => assert.equal(fs.existsSync(path.dirname(p)), false, 'fixture removes literal trailing-dot folder too'));
    for (const dir of [p, path.join(p, 'bin')]) {
        fs.copyFileSync(path.join(SystemRoot, 'System32', 'whoami.exe'), write(path.join(dir, 'moe-rf06b-alias.exe')));
    }
    const device = '//?/' + p.replace(/\\/g, '/');
    const aliases = [p + '.', p + '.\\', p + '.\\bin', p + '. ', p + ' .', device + '.', device + './bin',
        '\\\\localhost\\' + p[0] + '$' + p.slice(2), '\\\\127.0.0.1\\' + p[0] + '$' + p.slice(2)];
    for (const alias of aliases) { assert.equal(api.isOutsideProject(alias, p), false, alias); }
    const env = api.protectedDaemonEnvironment({ PATH: [...aliases, f.outside].join(';'), SystemRoot }, p, f.node, true, undefined);
    assert.equal(env.PATH, [path.dirname(f.node), f.outside].join(';'));
    const spawn = env => require('node:child_process').spawnSync('moe-rf06b-alias', { cwd: f.outside, env });
    assert.equal(spawn({ PATH: p + '.', SystemRoot }).status, 0, 'control: raw trailing-dot PATH runs the project executable');
    assert.equal(spawn(env).error?.code, 'ENOENT');
    assert.deepEqual(plain(api.installedExecutable(write(path.join(p + '.', 'node.exe')), p)),
        { rejected: 'node executable is not a plain local Windows path' });
});

for (const code of ['ENOENT', 'EACCES']) {
    test(`protected async ${code} resets the guard and does not poll readiness`, async t => {
        const f = fixture(t); f.failure = Object.assign(new Error(code), { code });
        await f.client.startDaemon('start', f.project);
        assert.equal(f.spawns.length, 1); assert.equal(f.polls, 0); assert.equal(f.unrefs, 0);
        assert.equal(f.client.startInProgress, false);
        assert.equal(f.errors.length, 1); assert.match(f.errors[0], code === 'ENOENT' ? /MOE_NODE_COMMAND/ : /EACCES/);
    });
}

test('node discovery orders managed, PATH and all POSIX fallbacks including name-max nvm', t => {
    const fixed = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'], available = new Set(fixed);
    const f = fixture(t, true, { ...fs, statSync: p => {
        if (!fixed.includes(p)) { return fs.statSync(p); }
        if (available.has(p)) { return { isFile: () => true }; }
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    } });
    const candidate = env => f.api.protectedNodeCandidate(env, f.home, false, f.project);
    const managed = write(path.join(f.home, '.local/share/moe/node/current/bin/node')); fs.chmodSync(managed, 0o755);
    const onPath = write(path.join(f.outside, 'node')), env = { PATH: f.outside };
    assert.equal(candidate({ ...env, MOE_NODE_COMMAND: 'node' }), 'node');
    assert.equal(candidate(env), managed);
    if (process.platform !== 'win32') {
        fs.chmodSync(managed, 0o644); assert.equal(candidate(env), onPath);
    }
    fs.unlinkSync(managed);
    assert.equal(candidate(env), onPath);
    const current = write(path.join(f.home, '.nvm/current/bin/node'));
    write(path.join(f.home, '.nvm/versions/node/v20/bin/node'));
    const latest = write(path.join(f.home, '.nvm/versions/node/v9/bin/node'));
    for (const expected of [fixed[0], fixed[1], current, latest, fixed[2]]) {
        assert.equal(candidate({}), expected);
        if (fixed.includes(expected)) { available.delete(expected); } else { fs.unlinkSync(expected); }
    }
    assert.equal(candidate({}), undefined);
});

test('Windows discovery uses every fallback in order and validates the first even if it is a directory', t => {
    const f = fixture(t), candidate = env => f.api.protectedNodeCandidate(env, f.home, true, f.project);
    const env = { ProgramFiles: f.outside, 'ProgramFiles(x86)': f.home, LOCALAPPDATA: f.extension, APPDATA: f.project };
    const files = [path.join(f.outside, 'nodejs/node.exe'), path.join(f.home, 'nodejs/node.exe'),
        path.join(f.extension, 'Programs/nodejs/node.exe'), path.join(f.extension, 'nvm/current/node.exe'), path.join(f.project, 'nvm/node.exe')];
    files.forEach(write);
    assert.equal(candidate({ ...env, Path: path.dirname(f.node), PATH: f.outside }), files[0]);
    fs.unlinkSync(files[0]); fs.mkdirSync(files[0]);
    assert.equal(candidate(env), files[0]);
    assert.deepEqual(plain(f.api.installedExecutable(candidate(env), f.project)), { rejected: 'node executable is not a regular file' });
    fs.rmdirSync(files[0]); write(files[0]);
    for (const file of files) { assert.equal(candidate(env), file); fs.unlinkSync(file); }
    assert.equal(candidate(env), undefined);
});

test('realpath errors are refusals; folded containment is segment-aware', t => {
    const f = fixture(t, true, { ...fs, realpathSync: { native: p => {
        if (p.endsWith('denied')) { throw Object.assign(new Error(p), { code: 'EACCES' }); }
        return real(p);
    } } });
    assert.deepEqual(plain(f.api.installedExecutable(path.join(f.outside, 'denied'), f.project)), { rejected: 'node executable cannot be resolved' });
    assert.equal(f.api.isOutsideProject(path.join(f.outside, 'denied'), f.project), false);
    assert.equal(f.api.isOutsideProject(`${f.outside}\0invalid`, f.project), false);
    assert.equal(f.api.isOutsideProject(f.project.toUpperCase(), f.project, true), false);
    assert.equal(f.api.isOutsideProject(`${f.project}-sibling`, f.project, true), true);
});

test('name-max nvm directory discovery follows directory links like JetBrains', t => {
    const f = fixture(t, true, { ...fs, statSync: p => {
        if (['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].includes(p)) { throw new Error('absent'); }
        return fs.statSync(p);
    } });
    const target = path.join(f.home, '.nvm/versions/node/v20'); write(path.join(target, 'bin/node'));
    const link = path.join(path.dirname(target), 'v99');
    try { fs.symlinkSync(target, link, 'junction'); } catch (err) {
        if (err.code !== 'EPERM') { throw err; } t.skip('symlink privilege unavailable'); return;
    }
    assert.equal(f.api.protectedNodeCandidate({}, f.home, false, f.project), path.join(link, 'bin/node'));
});

test('symlinked PATH directories and first node files cannot enter the project', async t => {
    const f = fixture(t), link = path.join(f.outside, 'project-link');
    try { fs.symlinkSync(f.project, link, 'junction'); } catch (err) {
        if (err.code !== 'EPERM') { throw err; } t.skip('symlink privilege unavailable'); return;
    }
    assert.equal(f.api.isOutsideProject(link, f.project), false);
    const target = write(path.join(f.project, path.basename(f.node))); fs.unlinkSync(f.node);
    try { fs.symlinkSync(target, f.node); } catch (err) {
        if (err.code !== 'EPERM') { throw err; } t.skip('symlink privilege unavailable'); return;
    }
    assert.deepEqual(plain(f.api.installedExecutable(f.node, f.project)), { rejected: 'node executable resolves inside the project' });
    delete f.env.MOE_NODE_COMMAND;
    f.env.PATH = [path.dirname(f.node), f.outside].join(path.delimiter); write(path.join(f.outside, path.basename(f.node)));
    await f.client.startDaemon('start', f.project);
    assert.deepEqual(f.spawns, []);
    assert.deepEqual(f.errors, [refusal('node executable resolves inside the project')]);
});

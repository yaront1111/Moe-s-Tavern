const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// CQ-RF06, mirroring JetBrains RuntimeSelectionPolicy. vm-realm values are spread or JSON-compared (cross-realm
// prototypes); real paths use realpathSync.native (macOS tmpdir symlink, Windows 8.3 short names).
const transpile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const clientSource = transpile('services/MoeDaemonClient.ts');
const launcherSource = transpile('util/AgentLauncher.ts');
const WIN = process.platform === 'win32';
const WRAPPER = WIN ? 'scripts/moe-agent.ps1' : 'scripts/moe-agent.sh';
const RUNTIME_FILES = ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js'];
const FAILS_CLOSED = 'Moe runtime selection fails closed to the protected profile: ';

function run(source, filename, vscode, deps = {}) {
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({
        exports: module.exports, module, process, Buffer, console, setTimeout, clearTimeout,
        require: name => name === 'vscode' ? vscode : deps[name] || require(name)
    }), { filename });
    return module.exports;
}

// A fresh module per call, so a session pin never leaks between tests.
function loadClient() {
    const logs = [];
    const exports = run(clientSource, 'MoeDaemonClient.ts', {
        EventEmitter: class { event = () => ({ dispose() {} }); },
        window: { createOutputChannel: () => ({ appendLine: line => logs.push(line) }) }
    });
    // The reasons of the fail-closed lines logged so far.
    const failClosed = () => logs.filter(line => line.includes(FAILS_CLOSED))
        .map(line => line.slice(line.indexOf(FAILS_CLOSED) + FAILS_CLOSED.length));
    return { exports, failClosed };
}

function loadLauncher(projectPath) {
    const [terminals, errors] = [[], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const window = { createTerminal, showErrorMessage: message => { errors.push(message); } };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: projectPath } }] }, window };
    const launcher = run(launcherSource, 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient().exports });
    return { launcher, terminals, errors };
}

const installedEnv = root => ({ MOE_DAEMON_PATH: path.join(root, 'daemon', 'index.js'),
    MOE_PROXY_PATH: path.join(root, 'proxy', 'index.js'), MOE_RUNTIME_PROTECTED: '1' });

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-rf06-'))));
    return made[made.length - 1];
}

function write(file, text = '// installed') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

/** A project dir; `projectJson` undefined writes no .moe/project.json; `decoys` adds scripts/moe-agent.*. */
function project(projectJson, decoys = false) {
    const dir = tempDir();
    if (projectJson !== undefined) { write(path.join(dir, '.moe', 'project.json'), projectJson); }
    if (decoys) { RUNTIME_FILES.slice(0, 2).forEach(file => write(path.join(dir, file), '# decoy')); }
    return dir;
}

/** An extension dir whose bundled/ holds `files`. */
function extension(files = RUNTIME_FILES) {
    const dir = tempDir();
    files.forEach(file => write(path.join(dir, 'bundled', file)));
    return dir;
}

function symlinkOrSkip(t, target, link) {
    try { fs.symlinkSync(target, link); return true; } catch (error) { if (error.code !== 'EPERM') { throw error; } }
    t.skip('creating symlinks needs a privilege here');
    return false;
}

const declare = value => JSON.stringify({ settings: { executionProfile: value } });
const NOT_A_PROFILE = 'executionProfile is not legacy, observe or verified-local';

// [row, project.json text, profile, fail-closed reasons]; a null reason is a JSON.parse SyntaxError,
// whose text varies by Node version.
for (const [name, text, profile, reasons] of [
    ['no project.json', undefined, 'legacy', []],
    ['an empty object', '{}', 'legacy', []],
    ['empty settings', '{"settings":{}}', 'legacy', []],
    ['executionProfile legacy', declare('legacy'), 'legacy', []],
    ['executionProfile observe', declare('observe'), 'legacy', []],
    ['a valid file of exactly 1 MiB', '{}' + ' '.repeat(1048574), 'legacy', []],
    ['executionProfile verified-local', declare('verified-local'), 'protected', []],
    ['executionProfile strong', declare('strong'), 'protected', [NOT_A_PROFILE]],
    ['a numeric executionProfile', declare(123), 'protected', [NOT_A_PROFILE]],
    ['a null executionProfile', declare(null), 'protected', [NOT_A_PROFILE]],
    ['null settings', '{"settings":null}', 'protected', ['settings is not a JSON object']],
    ['array settings', '{"settings":[]}', 'protected', ['settings is not a JSON object']],
    ['an array root', '[]', 'protected', ['project.json is not a JSON object']],
    ['a truncated document', '{', 'protected', [null]],
    ['a byte order mark', '\uFEFF{}', 'protected', ['project.json starts with a byte order mark']],
    ['content after the document', '{} {}', 'protected', [null]],
    ['a valid object padded past 1 MiB', '{}' + ' '.repeat(1048575), 'protected', ['project.json is larger than 1 MiB']]
]) {
    test(`P1 ${name} reads ${profile}`, () => {
        const { exports, failClosed } = loadClient();
        assert.equal(exports.runtimeProfile(project(text)), profile);
        const logged = failClosed();
        assert.deepEqual(logged.map((reason, i) => reasons[i] === null ? null : reason), reasons);
    });
}

test('P1 an lstat failure other than ENOENT (.moe is a file) fails closed', { skip: WIN && 'Windows reports ENOENT here' }, () => {
    const dir = project();
    write(path.join(dir, '.moe'), '');
    assert.equal(loadClient().exports.runtimeProfile(dir), 'protected');
});

test('P1 a project.json directory or dangling symlink fails closed to protected', t => {
    const { exports, failClosed } = loadClient();
    const asDirectory = project();
    fs.mkdirSync(path.join(asDirectory, '.moe', 'project.json'), { recursive: true });
    assert.equal(exports.runtimeProfile(asDirectory), 'protected');
    assert.deepEqual(failClosed(), ['project.json is not a regular file']);
    const dangling = project();
    fs.mkdirSync(path.join(dangling, '.moe'));
    if (!symlinkOrSkip(t, path.join(dangling, 'nowhere.json'), path.join(dangling, '.moe', 'project.json'))) { return; }
    assert.equal(exports.runtimeProfile(dangling), 'protected');
});

test('P2 an explicit verified-local read pins the project for the session; an untrusted read never pins', () => {
    const { exports } = loadClient();
    assert.equal(exports.runtimeProfile(''), 'legacy', 'a blank basePath reads legacy');
    const [pinned, untrusted] = [project(declare('verified-local')), project(declare('strong'))];
    assert.equal(exports.runtimeProfile(pinned), 'protected');
    assert.equal(exports.runtimeProfile(untrusted), 'protected');
    for (const dir of [pinned, untrusted]) { write(path.join(dir, '.moe', 'project.json'), declare('legacy')); }
    assert.equal(exports.runtimeProfile(pinned), 'protected');
    assert.equal(exports.runtimeProfile(pinned + path.sep), 'protected');
    assert.equal(exports.runtimeProfile(untrusted), 'legacy');
    assert.equal(loadClient().exports.runtimeProfile(pinned), 'legacy', 'the pin lives only in this module instance');
});

test('P3 comparablePath and isWithin', () => {
    const { comparablePath, isWithin } = loadClient().exports;
    assert.equal(comparablePath('\\\\?\\C:\\Moe\\', true), 'c:/moe');
    assert.equal(comparablePath('\\\\?\\UNC\\srv\\share\\x', false), '//srv/share/x');
    assert.equal(comparablePath('\\\\.\\C:\\Moe', false), 'C:/Moe');
    assert.equal(comparablePath('C:\\', false), 'C:/');
    assert.equal(comparablePath('/', false), '/');
    assert.deepEqual([isWithin('/a/b', '/a'), isWithin('/ab', '/a'), isWithin('/a', '/a'), isWithin('C:/x', 'C:/')],
        [true, false, true, true]);
});

test('P4 installedArtifact accepts only a real regular file inside the root and outside the project', () => {
    const { exports } = loadClient();
    const dir = project();
    const select = (root, relative, basePath = dir) => ({ ...exports.installedArtifact(root, relative, basePath) });
    const root = path.join(extension(['daemon/index.js']), 'bundled');
    assert.deepEqual(select(root, 'daemon/index.js'), { accepted: path.join(root, 'daemon', 'index.js') });
    assert.deepEqual(select(root, 'proxy/index.js'), { rejected: 'installed proxy/index.js not found' });
    const directoryRoot = tempDir();
    fs.mkdirSync(path.join(directoryRoot, 'daemon', 'index.js'), { recursive: true });
    assert.deepEqual(select(directoryRoot, 'daemon/index.js'), { rejected: 'installed daemon/index.js is not a regular file' });
    const insideProject = path.join(dir, 'bundled');
    write(path.join(insideProject, 'daemon', 'index.js'));
    assert.deepEqual(select(insideProject, 'daemon/index.js'), { rejected: 'installed daemon/index.js resolves inside the project' });
    assert.deepEqual(select(path.join(root, 'missing'), 'daemon/index.js'), { rejected: 'installed Moe runtime not found' });
    assert.deepEqual(select(root, 'daemon/index.js', path.join(dir, 'missing')), { rejected: 'the project directory cannot be resolved' });
});

test('P4 a symlink inside the root that resolves outside it is refused', t => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'daemon'));
    if (!symlinkOrSkip(t, write(path.join(tempDir(), 'index.js')), path.join(root, 'daemon', 'index.js'))) { return; }
    assert.deepEqual({ ...loadClient().exports.installedArtifact(root, 'daemon/index.js', project()) },
        { rejected: 'installed daemon/index.js resolves outside the installed Moe runtime' });
});

test('selectProtectedAgentRuntime takes only the platform wrapper and sets the marker after every artifact', () => {
    const dir = project();
    const root = path.join(extension(['scripts/moe-agent.sh', 'daemon/index.js', 'proxy/index.js']), 'bundled');
    const { launcher } = loadLauncher(dir);
    assert.equal(launcher.PROTECTED_RUNTIME_MARKER, 'MOE_RUNTIME_PROTECTED');
    assert.equal(JSON.stringify(launcher.selectProtectedAgentRuntime(dir, root, false)),
        JSON.stringify({ scriptPath: path.join(root, 'scripts', 'moe-agent.sh'), envOverrides: installedEnv(root) }));
    assert.equal(JSON.stringify(launcher.selectProtectedAgentRuntime(dir, root, true)),
        JSON.stringify({ refused: 'installed scripts/moe-agent.ps1 not found' }));
});

const shQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const psQuote = value => `'${value.replace(/'/g, "''")}'`;

/** The single command sent to the single terminal, -EncodedCommand decoded and the random worker id fixed. */
function launchedCommand(f, projectPath) {
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.terminals.map(terminal => [terminal.options.cwd, terminal.texts.length]), [[projectPath, 1]]);
    return f.terminals[0].texts[0]
        .replace(/-EncodedCommand (\S+)$/, (_, b64) => `-EncodedCommand [${Buffer.from(b64, 'base64').toString('utf16le')}]`)
        .replace(/worker-[0-9a-f]{8}/, 'worker-ID');
}

function expectedCommand(env, wrapper, projectPath) {
    const entries = Object.entries(env);
    if (WIN) {
        return entries.map(([key, value]) => `$env:${key}=${psQuote(value)}; `).join('') +
            `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand [& ${psQuote(wrapper)} -Role worker ` +
            `-Project ${psQuote(projectPath)} -WorkerId 'worker-ID' -Command 'claude']`;
    }
    return entries.map(([key, value]) => `${key}=${shQuote(value)} `).join('') +
        `bash ${shQuote(wrapper)} --role worker --project ${shQuote(projectPath)} --worker-id 'worker-ID' --command 'claude'`;
}

test('L1 a protected launch uses only the installed wrapper, daemon and proxy, plus the marker', async () => {
    const dir = project(declare('verified-local'), true);
    const ext = extension();
    const f = loadLauncher(dir);
    const readiness = async () => ({ answered: { profile: 'verified-local', ready: true, missingCapabilities: [], evaluatedAt: null } });
    await f.launcher.launchAgent('worker', 'claude', ext, { readiness });
    const bundled = path.join(ext, 'bundled');
    assert.equal(launchedCommand(f, dir), expectedCommand(installedEnv(bundled), path.join(bundled, WRAPPER), dir));
});

for (const [row, missing] of [['L2', 'proxy/index.js'], ['L3', WRAPPER]]) {
    test(`${row} a missing installed ${missing} refuses with no terminal`, () => {
        const f = loadLauncher(project(declare('verified-local'), true));
        f.launcher.launchAgent('worker', 'claude', extension(RUNTIME_FILES.filter(file => file !== missing)));
        assert.deepEqual(f.errors, [`Protected execution profile: installed ${missing} not found. ` +
            'Agents only use the wrapper, daemon and proxy installed with the Moe extension.']);
        assert.equal(f.terminals.length, 0);
    });
}

test('L4 a legacy launch keeps the project script first and carries no marker', () => {
    const dir = project(undefined, true);
    const f = loadLauncher(dir);
    f.launcher.launchAgent('worker', 'claude', extension());
    assert.equal(launchedCommand(f, dir), expectedCommand({}, path.join(dir, WRAPPER), dir));
});

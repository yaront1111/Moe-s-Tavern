'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');
const ts = require('typescript');

// task-2f4b224f: PowerShell's tokenizer reads U+2018, U+2019, U+201A and U+201B as single quotes too, so psQuote must
// double each of them as well as the ASCII ', or a value such as D:\Bob’s work ends its quoted word early and the rest
// runs as script. -EncodedCommand protects only the outer framing: the decoded script still needs a correct psQuote.
// The launcher harness is copied from agent-launcher-controls.test.cjs and the provider loader from
// accounts-actions.test.cjs: tests share no helper module.
const src = file => path.join(__dirname, '../src', file);
const transpile = file => ts.transpileModule(fs.readFileSync(src(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

function run(source, filename, vscode, deps = {}, globals = {}) {
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({
        exports: module.exports, module, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === 'vscode' ? vscode : deps[name] || require(name), ...globals
    }), { filename });
    return module.exports;
}

class Emitter {
    constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose() {} }; }; }
    fire(value) { this.listeners.slice().forEach(listener => listener(value)); }
    dispose() { this.listeners = []; }
}

function StubWebSocket() { throw new Error('these tests never open a real socket'); }
StubWebSocket.OPEN = 1;

const clientVscode = {
    EventEmitter: Emitter,
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: () => Promise.resolve(undefined) },
    workspace: { getConfiguration: () => ({ get: () => false }) }
};

const loadClient = () => run(transpile('services/MoeDaemonClient.ts'), 'MoeDaemonClient.ts', clientVscode, { ws: StubWebSocket });

const made = [];
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } });

function tempDir() {
    made.push(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-psq-'))));
    return made[made.length - 1];
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** An extension dir whose bundled/ holds the installed wrapper, daemon and proxy; `name` is its own directory name. */
function extension(name) {
    const dir = path.join(tempDir(), name);
    for (const file of ['scripts/moe-agent.sh', 'scripts/moe-agent.ps1', 'daemon/index.js', 'proxy/index.js']) {
        write(path.join(dir, 'bundled', file), '// installed');
    }
    return dir;
}

/** The launcher over a fake terminal API, on Windows whatever the host is. */
function loadWindowsLauncher(dir) {
    const [terminals, errors, warnings] = [[], [], []];
    const createTerminal = options => {
        const terminal = { options, texts: [], sendText: text => terminal.texts.push(text), show() {} };
        terminals.push(terminal);
        return terminal;
    };
    const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
        window: { createTerminal, showErrorMessage: message => { errors.push(message); }, showWarningMessage: message => { warnings.push(message); } } };
    // Error is this realm's, so `err instanceof Error` in the launcher recognises the Errors it throws.
    const launcher = run(transpile('util/AgentLauncher.ts'), 'AgentLauncher.ts', vscode, { '../services/MoeDaemonClient': loadClient() },
        { process: Object.create(process, { platform: { value: 'win32' } }), Error });
    return { launcher, terminals, errors, warnings };
}

/** A module with a closed require map, as accounts-actions.test.cjs loads the provider. */
function load(file, requireFn) {
    const module = { exports: {} };
    vm.runInThisContext(`(function (exports, module, require) {${transpile(file)}\n})`, { filename: src(file) })(module.exports, module, requireFn);
    return module.exports;
}

const loadProvider = () => {
    const presentation = load('util/AccountPresentation.ts', name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });
    return load('providers/AccountsTreeProvider.ts', name => {
        if (name === 'vscode') return {};
        if (name === '../util/AccountPresentation') return presentation;
        throw new Error(`AccountsTreeProvider.ts must not require ${name}`);
    });
};

// U+0027, U+2018, U+2019, U+201A and U+201B: PowerShell's CharExtensions.IsSingleQuote.
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const isQuote = c => c !== undefined && PS_SINGLE_QUOTES.includes(c);

/**
 * The words PowerShell's tokenizer reads from `script`. Any single-quote character opens or closes a quoted word, and a
 * doubled pair inside one reads as its second character. A bare word ends at a space or a single-quote character.
 */
function psWords(script) {
    const words = [];
    let i = 0;
    while (i < script.length) {
        if (script[i] === ' ') { i++; continue; }
        let word = '';
        if (isQuote(script[i])) {
            for (i++; ; ) {
                assert.ok(i < script.length, `unterminated quote in: ${script}`);
                const quote = isQuote(script[i]);
                if (quote && !isQuote(script[i + 1])) { i++; break; }
                word += script[quote ? i + 1 : i];
                i += quote ? 2 : 1;
            }
        } else {
            while (i < script.length && script[i] !== ' ' && !isQuote(script[i])) { word += script[i++]; }
        }
        words.push(word);
    }
    return words;
}

const decodeLast = words => {
    assert.match(words[words.length - 1], /^[A-Za-z0-9+/]+=*$/, 'the last word is the -EncodedCommand base64');
    return Buffer.from(words[words.length - 1], 'base64').toString('utf16le');
};

test('V1 the PowerShell launch line doubles every single-quote character, so a project dir named Bob’s work arrives intact', async () => {
    const ext = extension("ext '\u2018\u2019\u201a\u201b x");
    const dir = path.join(tempDir(), 'Bob\u2019s work');
    fs.mkdirSync(dir);
    const team = "Bob\u2019s \u2018team\u2019 \u201ax\u201b 'y'";
    const f = loadWindowsLauncher(dir);
    const launched = [];
    await f.launcher.launchAgent('architect', 'claude', ext, { teamName: team, onLaunched: id => launched.push(id) });
    assert.deepEqual([f.terminals.length, launched.length, f.errors, f.warnings], [1, 1, [], []]);
    assert.equal(f.terminals[0].texts.length, 1);
    const line = f.terminals[0].texts[0];
    const bundled = (...parts) => path.join(ext, 'bundled', ...parts);
    const outer = psWords(line);
    assert.deepEqual(outer.slice(0, -1), ['$env:MOE_DAEMON_PATH=', bundled('daemon', 'index.js'), ';', '$env:MOE_PROXY_PATH=',
        bundled('proxy', 'index.js'), ';', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'], line);
    const script = decodeLast(outer);
    assert.deepEqual(psWords(script), ['&', bundled('scripts', 'moe-agent.ps1'), '-Role', 'architect', '-Project', dir,
        '-WorkerId', launched[0], '-Command', 'claude', '-Team', team], script);
    assert.ok(script.includes(`-Project '${dir.replace(/\u2019/g, '\u2019\u2019')}'`), script);
    assert.ok(script.includes('Bob\u2019\u2019s work\''), script);
});

test('V2 accountsCommandLine doubles every PowerShell single-quote character in each word of the encoded script', () => {
    const q = PS_SINGLE_QUOTES;
    const cli = { node: `C:/${q} node/node.exe`, script: `C:/moe ${q}/cli.js` };
    const file = `C:/Users/${q}/claude-accounts.json`;
    const args = ['login', `acct ${q} 1`];
    const line = loadProvider().accountsCommandLine(cli, file, args, true);
    const words = psWords(line);
    assert.deepEqual(words.slice(0, -1), ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'], line);
    const script = decodeLast(words);
    assert.deepEqual(psWords(script), ['&', cli.node, cli.script, '--accounts-file', file, ...args], script);
});
